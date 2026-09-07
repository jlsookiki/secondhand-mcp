/**
 * Facebook Marketplace implementation
 *
 * Uses Facebook's internal GraphQL API to search Marketplace listings.
 * Works without login. No browser automation required.
 *
 * Non-browser callers are sometimes handed a gated version of the search
 * API (a single edge with a next-page cursor, or story stubs with no listing
 * inside). The logged-out HTML search page still carries a full first page
 * of results, so that is the fallback.
 *
 * Based on the approach from kyleronayne/marketplace-api.
 * doc_id values may need updating if Facebook changes their frontend.
 */

import { ProxyAgent } from 'undici';
import { BaseMarketplace } from './base.js';
import { lookupUsCity } from './us-cities.js';
import { SearchParams, SearchResult, Listing, ListingDetails, LocationCoordinates } from '../types.js';

// GraphQL endpoint and operation identifiers
const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const LOCATION_DOC_ID = '5585904654783609';
const SEARCH_DOC_ID = '27517490627932547';
const DETAIL_PHOTOS_DOC_ID = '10059604367394414';
const DETAIL_INFO_DOC_ID = '26090240497332612';

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 15000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SEARCH_CACHE_TTL_MS = 90_000;
const SEARCH_CACHE_MAX = 200;
const CITY_PAGE_CACHE_MAX = 200;

export const DEFAULT_RADIUS_MILES = 25;
const MAX_RADIUS_MILES = 500;
const KM_PER_MILE = 1.609;
const API_PAGE_SIZE = 24;
const MIN_TRUSTED_LISTINGS = 5;

const GRAPHQL_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// The search page only renders results for browser-shaped requests.
const SEARCH_PAGE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Max price value Facebook uses as "no upper limit"
const MAX_PRICE_SENTINEL = 214748364700;

// Residential proxy for Facebook requests (avoids datacenter IP rate limits)
const proxyAgent = process.env.SMARTPROXY_URL
  ? new ProxyAgent(process.env.SMARTPROXY_URL)
  : undefined;

interface FeedUnitsReading {
  listings: Listing[];
  malformed: boolean;
  hasNextPage: boolean;
}

export class FacebookMarketplace extends BaseMarketplace {
  readonly name = 'facebook';
  readonly displayName = 'Facebook Marketplace';
  readonly requiresAuth = false;

  // Cache location lookups to avoid repeat requests for the same city
  private locationCache: Map<string, LocationCoordinates> = new Map();
  private cityPageIdCache: Map<string, string | null> = new Map();
  private searchCache: Map<string, { at: number; result: SearchResult }> = new Map();

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, location = 'san francisco', maxPrice, minPrice, limit = API_PAGE_SIZE } = params;
    const showSold = params.showSold ?? false;
    const radiusMiles = clampRadius(params.radius);

    const cacheKey = JSON.stringify([query, location, maxPrice, minPrice, limit, showSold, radiusMiles]);
    const hit = this.searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
      return hit.result;
    }

    try {
      const coords = await this.resolveLocation(location);
      if (!coords) {
        return this.createError(
          `Could not find location "${location}". Try a major city name like "san francisco", "nyc", or "chicago".`
        );
      }

      const response = await this.fetchGraphQL(
        SEARCH_DOC_ID,
        this.searchVariables(query, coords, limit, minPrice, maxPrice, radiusMiles)
      );
      const graph = this.readFeedUnits(response.data?.marketplace_search?.feed_units, limit, showSold);

      let result: SearchResult | null = null;
      if (this.isGatedVersion(graph, limit)) {
        const page = await this.searchViaPage(location, query, limit, minPrice, maxPrice, showSold, radiusMiles);
        if (page && page.listings.length > graph.listings.length) {
          result = page;
        } else if (!page && graph.malformed && graph.listings.length === 0) {
          return this.createError(
            'Unexpected response structure from Facebook, and the search page could not be read either. The GraphQL doc_id may need updating.'
          );
        }
      }

      result ??= {
        marketplace: this.name,
        success: true,
        listings: graph.listings,
        totalFound: graph.listings.length,
      };

      this.remember(cacheKey, result);
      return result;
    } catch (error) {
      return this.createError(`Facebook Marketplace search failed: ${error}`);
    }
  }

  async getLocation(query: string): Promise<LocationCoordinates | null> {
    return this.resolveLocation(query);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const coords = await this.resolveLocation('new york');
      return coords !== null;
    } catch {
      return false;
    }
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    // Fetch photos and detail info in parallel
    const photosVars = JSON.stringify({ targetId: listingId });
    const infoVars = JSON.stringify({
      targetId: listingId,
      scale: 2,
      feedbackSource: 56,
      feedLocation: 'MARKETPLACE_MEGAMALL',
      referralCode: 'marketplace_top_picks',
      enableJobEmployerActionBar: false,
      enableJobSeekerActionBar: false,
      useDefaultActor: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
      __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
      __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: false,
      __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
      __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
      __relay_internal__pv__IsWorkUserrelayprovider: false,
      __relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider: false,
    });

    const [photosRes, infoRes] = await Promise.all([
      this.fetchGraphQL(DETAIL_PHOTOS_DOC_ID, photosVars),
      this.fetchGraphQL(DETAIL_INFO_DOC_ID, infoVars),
    ]);

    const photosTarget = photosRes?.data?.viewer?.marketplace_product_details_page?.target;
    const infoTarget = infoRes?.data?.viewer?.marketplace_product_details_page?.target;

    const images: string[] = [];
    if (Array.isArray(photosTarget?.listing_photos)) {
      for (const photo of photosTarget.listing_photos) {
        const uri = photo?.image?.uri;
        if (uri) images.push(uri);
      }
    }

    return {
      id: listingId,
      description: infoTarget?.redacted_description?.text ?? undefined,
      images,
      location: infoTarget?.location_text?.text ?? undefined,
      locationCoords: infoTarget?.location ?? undefined,
      seller: infoTarget?.marketplace_listing_seller?.name ?? undefined,
      deliveryTypes: infoTarget?.delivery_types ?? undefined,
      isShippingOffered: infoTarget?.is_shipping_offered ?? undefined,
      url: `https://www.facebook.com/marketplace/item/${listingId}`,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private readFeedUnits(feedUnits: any, limit: number, showSold: boolean): FeedUnitsReading {
    if (!feedUnits?.edges) {
      console.error('[facebook] unexpected graphql response structure');
      return { listings: [], malformed: true, hasNextPage: false };
    }
    const edges: any[] = feedUnits.edges;
    return {
      listings: this.parseListings(edges, limit, showSold),
      malformed: edges.some((edge) => edge?.node && !edge.node.listing),
      hasNextPage: feedUnits.page_info?.has_next_page === true,
    };
  }

  private isGatedVersion(graph: FeedUnitsReading, limit: number): boolean {
    const thin = graph.listings.length < Math.min(limit, MIN_TRUSTED_LISTINGS);
    return thin && (graph.malformed || graph.hasNextPage);
  }

  private remember(cacheKey: string, result: SearchResult): void {
    this.searchCache.set(cacheKey, { at: Date.now(), result });
    if (this.searchCache.size > SEARCH_CACHE_MAX) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest !== undefined) this.searchCache.delete(oldest);
    }
  }

  // Facebook's own client sends every field below; leaving the newer ones
  // out makes the query return data-less story stubs.
  private searchVariables(
    query: string,
    coords: LocationCoordinates,
    limit: number,
    minPrice?: number,
    maxPrice?: number,
    radiusMiles: number = DEFAULT_RADIUS_MILES
  ): string {
    return JSON.stringify({
      buyLocation: { latitude: coords.latitude, longitude: coords.longitude },
      contextual_data: null,
      count: Math.min(limit, API_PAGE_SIZE),
      cursor: null,
      params: {
        bqf: {
          callsite: 'COMMERCE_MKTPLACE_WWW',
          query,
        },
        browse_request_params: {
          commerce_enable_local_pickup: true,
          commerce_enable_shipping: true,
          commerce_search_and_rp_available: true,
          commerce_search_and_rp_category_id: [],
          commerce_search_and_rp_condition: null,
          commerce_search_and_rp_ctime_days: null,
          filter_location_latitude: coords.latitude,
          filter_location_longitude: coords.longitude,
          filter_price_lower_bound: minPrice ?? 0,
          filter_price_upper_bound: maxPrice ?? MAX_PRICE_SENTINEL,
          filter_radius_km: Math.round(radiusMiles * KM_PER_MILE),
        },
        custom_request_params: {
          browse_context: null,
          contextual_filters: [],
          referral_code: null,
          referral_ui_component: null,
          saved_search_strid: null,
          search_vertical: 'C2C',
          seo_url: null,
          serp_landing_settings: { virtual_category_id: '' },
          surface: 'SEARCH',
          virtual_contextual_filters: [],
        },
      },
      savedSearchID: null,
      savedSearchQuery: query,
      scale: 2,
      shouldDeferNonCritical: false,
      shouldIncludePopularSearches: false,
      topicPageParams: { location_id: null, url: null },
      __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: true,
    });
  }

  private async searchViaPage(
    location: string,
    query: string,
    limit: number,
    minPrice: number | undefined,
    maxPrice: number | undefined,
    showSold: boolean,
    radiusMiles: number
  ): Promise<SearchResult | null> {
    try {
      const pageId = await this.resolveCityPageId(location);
      if (!pageId) return null;
      const html = await this.fetchSearchPage(pageId, query, minPrice, maxPrice, radiusMiles);
      const edges = this.extractFeedUnitEdges(html);
      if (!edges) {
        console.error('[facebook] search page had no marketplace_search payload');
        return null;
      }
      const listings = this.parseListings(edges, limit, showSold);
      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: listings.length,
      };
    } catch (err: any) {
      console.error('[facebook] search page fallback failed:', err?.message ?? err);
      return null;
    }
  }

  private async resolveCityPageId(location: string): Promise<string | null> {
    const key = location.toLowerCase().trim();
    if (this.cityPageIdCache.has(key)) return this.cityPageIdCache.get(key)!;

    let pageId: string | null = null;
    for (const candidate of this.locationCandidates(location)) {
      pageId = await this.lookupCityPageId(candidate);
      if (pageId) break;
    }

    if (this.cityPageIdCache.size > CITY_PAGE_CACHE_MAX) {
      const oldest = this.cityPageIdCache.keys().next().value;
      if (oldest !== undefined) this.cityPageIdCache.delete(oldest);
    }
    this.cityPageIdCache.set(key, pageId);
    return pageId;
  }

  private async lookupCityPageId(query: string): Promise<string | null> {
    const variables = JSON.stringify({
      params: {
        caller: 'MARKETPLACE',
        page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
        query,
      },
    });
    try {
      const response = await this.fetchGraphQL(LOCATION_DOC_ID, variables);
      const edges = response?.data?.city_street_search?.street_results?.edges ?? [];
      const places = edges.map((e: any) => e?.node).filter((n: any) => n?.page?.id);
      const city = places.find((n: any) => n?.subtitle?.split(' ·')[0] === 'City') ?? places[0];
      return city?.page?.id ?? null;
    } catch {
      return null;
    }
  }

  private async fetchSearchPage(
    pageId: string,
    query: string,
    minPrice: number | undefined,
    maxPrice: number | undefined,
    radiusMiles: number
  ): Promise<string> {
    const search = new URLSearchParams({ query });
    if (minPrice != null) search.set('minPrice', String(minPrice));
    if (maxPrice != null) search.set('maxPrice', String(maxPrice));
    search.set('radius', String(Math.round(radiusMiles)));
    const url = `https://www.facebook.com/marketplace/${pageId}/search?${search.toString()}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(url, {
          headers: SEARCH_PAGE_HEADERS,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
          // @ts-ignore — dispatcher is a Node.js/undici-specific fetch option
          dispatcher: proxyAgent,
        });
        if (!response.ok) throw new Error(`Facebook page returned status ${response.status}`);
        const html = await response.text();
        // A blocked or login-walled page is a 200 without the search payload.
        if (!html.includes('marketplace_search')) {
          throw new Error('Facebook served the search page without results');
        }
        return html;
      } catch (err) {
        lastError = err;
        if (!isTransientNetworkError(err)) throw err;
      }
    }
    throw lastError;
  }

  // The page embeds several feed_units payloads (preloader shells, module
  // manifests) besides the real one, in an order that varies by variant.
  private extractFeedUnitEdges(html: string): any[] | null {
    let best: any[] | null = null;
    let bestListings = -1;
    for (
      let anchor = html.indexOf('"feed_units"');
      anchor !== -1;
      anchor = html.indexOf('"feed_units"', anchor + 1)
    ) {
      const edgesAt = html.indexOf('"edges":', anchor);
      if (edgesAt === -1 || edgesAt > anchor + 200) continue;
      const edges = extractJsonArray(html, html.indexOf('[', edgesAt));
      if (!edges) continue;
      const withListing = edges.filter((e: any) => e?.node?.listing).length;
      if (withListing > bestListings) {
        best = edges;
        bestListings = withListing;
      }
    }
    return best;
  }

  /**
   * Facebook's city search is literal, and a "City, ST" query does not just
   * miss — "kansas city, mo" returns Mound City, Kansas. Spelling the state
   * out is the only form that reliably lands, so it goes first; the bare
   * city name is a last resort because "austin" is Austin, Illinois.
   */
  private locationCandidates(query: string): string[] {
    const base = query.toLowerCase().trim();
    const out: string[] = [];

    if (!out.includes(base)) out.push(base);

    const bareCity = base.split(',')[0].trim();
    if (bareCity && !out.includes(bareCity)) out.push(bareCity);

    return out;
  }

  private async resolveLocation(query: string): Promise<LocationCoordinates | null> {
    const local = lookupUsCity(query);
    if (local) return local;

    const primaryKey = query.toLowerCase().trim();

    for (const candidate of this.locationCandidates(query)) {
      const coords = await this.resolveLocationExact(candidate);
      if (coords) {
        if (candidate !== primaryKey) this.locationCache.set(primaryKey, coords);
        return coords;
      }
    }
    return null;
  }

  private async resolveLocationExact(cacheKey: string): Promise<LocationCoordinates | null> {
    if (this.locationCache.has(cacheKey)) {
      return this.locationCache.get(cacheKey)!;
    }

    const variables = JSON.stringify({
      params: {
        caller: 'MARKETPLACE',
        page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
        query: cacheKey,
      },
    });

    try {
      const response = await this.fetchGraphQL(LOCATION_DOC_ID, variables);

      const edges = response?.data?.city_street_search?.street_results?.edges;
      if (!edges || edges.length === 0) {
        return null;
      }

      // Results are ranked by check-ins, so "phoenix" leads with a venue in
      // South Africa and "sacramento" with a street in Portugal. Only real
      // places carry the bare "City" subtitle.
      const cityEdge = edges.find(
        (e: any) => e.node?.subtitle?.split(' ·')[0] === 'City',
      );
      const node = (cityEdge ?? edges[0]).node;
      const name =
        node.subtitle?.split(' ·')[0] === 'City'
          ? node.single_line_address
          : node.subtitle?.split(' ·')[0] || node.single_line_address;

      const coords: LocationCoordinates = {
        latitude: node.location.latitude,
        longitude: node.location.longitude,
        name,
      };

      this.locationCache.set(cacheKey, coords);
      return coords;
    } catch {
      return null;
    }
  }

  private parseListings(edges: any[], limit: number, showSold: boolean): Listing[] {
    const listings: Listing[] = [];

    for (const edge of edges) {
      if (listings.length >= limit) break;

      try {
        // The wrapper's __typename varies between API versions; the listing
        // object is the contract.
        const listing = edge?.node?.listing;
        if (!listing) continue;

        // Filter out sold/unavailable listings unless showSold is true
        if (!showSold) {
          if (listing.is_sold === true) continue;
          if (listing.is_live === false) continue;
          if (listing.is_pending === true) continue;
          if (listing.is_hidden === true) continue;

          // Heuristic: sellers sometimes mark sold items in the title
          const title = (listing.marketplace_listing_title || '').toUpperCase();
          if (title.startsWith('[SOLD]') || title.startsWith('SOLD -') || title === 'SOLD') {
            continue;
          }
        }

        const price = listing.listing_price?.formatted_amount || 'Price not listed';
        const parsed = this.parsePrice(price);

        const imageUri = listing.primary_listing_photo?.image?.uri;

        listings.push({
          id: listing.id,
          title: listing.marketplace_listing_title || 'Untitled Listing',
          price,
          priceNumeric: parsed?.numeric,
          currency: parsed?.currency || '$',
          location: listingLocation(listing),
          url: `https://www.facebook.com/marketplace/item/${listing.id}`,
          images: imageUri ? [imageUri] : undefined,
          seller: listing.marketplace_listing_seller?.name,
          marketplace: this.name,
          scrapedAt: new Date().toISOString(),
        });
      } catch {
        // Skip unparseable listings
        continue;
      }
    }

    return listings;
  }

  private async fetchGraphQL(docId: string, variables: string): Promise<any> {
    const body = new URLSearchParams({
      variables,
      doc_id: docId,
    });

    const deadline = Date.now() + TOTAL_BUDGET_MS;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      let expiry: ReturnType<typeof setTimeout> | undefined;

      try {
        const running = this.attemptGraphQL(body, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
        // A transport that is slow to honour its abort would otherwise carry an
        // attempt past the deadline; losing this race is what caps elapsed time.
        running.catch(() => {});
        const expired = new Promise<never>((_, reject) => {
          expiry = setTimeout(
            () =>
              reject(
                Object.assign(new Error('Facebook request exceeded its time budget'), {
                  name: 'TimeoutError',
                })
              ),
            remaining
          );
        });

        return await Promise.race([running, expired]);
      } catch (err: any) {
        if (err?.fatal) throw err;
        lastError = err;

        const backoff = 1000 * 2 ** (attempt - 1) * (0.5 + Math.random());
        if (attempt === MAX_ATTEMPTS || Date.now() + backoff >= deadline) break;
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        clearTimeout(expiry);
      }
    }

    throw lastError ?? new Error('Facebook request failed');
  }

  private async attemptGraphQL(body: URLSearchParams, timeoutMs: number): Promise<any> {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: GRAPHQL_HEADERS,
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
      // @ts-ignore — dispatcher is a Node.js/undici-specific fetch option
      dispatcher: proxyAgent,
    });

    if (RETRYABLE_STATUS.has(response.status)) {
      throw new Error(`Facebook API returned status ${response.status}`);
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Facebook API returned status ${response.status}`), {
        fatal: true,
      });
    }

    const json = (await response.json()) as any;

    if (json.errors?.length) {
      throw Object.assign(new Error(`Facebook GraphQL error: ${json.errors[0].message}`), {
        fatal: true,
      });
    }

    return json;
  }
}

function clampRadius(radiusMiles: number | undefined): number {
  if (!radiusMiles || radiusMiles <= 0) return DEFAULT_RADIUS_MILES;
  return Math.min(radiusMiles, MAX_RADIUS_MILES);
}

function isTransientNetworkError(err: any): boolean {
  return err?.name === 'TimeoutError' || /fetch failed|aborted|socket|ECONN/i.test(err?.message ?? '');
}

function listingLocation(listing: any): string | undefined {
  const geo = listing.location?.reverse_geocode;
  if (geo?.city_page?.display_name) return geo.city_page.display_name;
  if (geo?.city) return [geo.city, geo.state].filter(Boolean).join(', ');
  return undefined;
}

// Balanced-bracket scan; string-aware because listing titles contain brackets.
function extractJsonArray(html: string, start: number): any[] | null {
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
