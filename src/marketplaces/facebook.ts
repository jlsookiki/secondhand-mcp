/**
 * Facebook Marketplace implementation
 *
 * Uses Facebook's internal GraphQL API to search Marketplace listings.
 * Works without login. No browser automation required.
 *
 * Based on the approach from kyleronayne/marketplace-api.
 * doc_id values may need updating if Facebook changes their frontend.
 */

import { ProxyAgent } from 'undici';
import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails, LocationCoordinates } from '../types.js';

// GraphQL endpoint and operation identifiers
const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const LOCATION_DOC_ID = '5585904654783609';
const SEARCH_DOC_ID = '7111939778879383';
const DETAIL_PHOTOS_DOC_ID = '10059604367394414';
const DETAIL_INFO_DOC_ID = '26090240497332612';

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 15000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SEARCH_CACHE_TTL_MS = 90_000;
const SEARCH_CACHE_MAX = 200;

/** Facebook's own search mishandles common shorthand: "nyc" returns a town in
 *  Ukraine and "austin" returns a Chicago neighborhood. */
const SEED_LOCATIONS: Record<string, LocationCoordinates> = {
  'san francisco': { latitude: 37.7749, longitude: -122.4194, name: 'San Francisco, CA' },
  'sf': { latitude: 37.7749, longitude: -122.4194, name: 'San Francisco, CA' },
  'new york': { latitude: 40.7128, longitude: -74.006, name: 'New York, NY' },
  'new york city': { latitude: 40.7128, longitude: -74.006, name: 'New York, NY' },
  'nyc': { latitude: 40.7128, longitude: -74.006, name: 'New York, NY' },
  'los angeles': { latitude: 34.0522, longitude: -118.2437, name: 'Los Angeles, CA' },
  'la': { latitude: 34.0522, longitude: -118.2437, name: 'Los Angeles, CA' },
  'chicago': { latitude: 41.8781, longitude: -87.6298, name: 'Chicago, IL' },
  'houston': { latitude: 29.7604, longitude: -95.3698, name: 'Houston, TX' },
  'phoenix': { latitude: 33.4484, longitude: -112.074, name: 'Phoenix, AZ' },
  'philadelphia': { latitude: 39.9526, longitude: -75.1652, name: 'Philadelphia, PA' },
  'san antonio': { latitude: 29.4241, longitude: -98.4936, name: 'San Antonio, TX' },
  'san diego': { latitude: 32.7157, longitude: -117.1611, name: 'San Diego, CA' },
  'dallas': { latitude: 32.7767, longitude: -96.797, name: 'Dallas, TX' },
  'austin': { latitude: 30.2672, longitude: -97.7431, name: 'Austin, TX' },
  'seattle': { latitude: 47.6062, longitude: -122.3321, name: 'Seattle, WA' },
  'denver': { latitude: 39.7392, longitude: -104.9903, name: 'Denver, CO' },
  'boston': { latitude: 42.3601, longitude: -71.0589, name: 'Boston, MA' },
  'miami': { latitude: 25.7617, longitude: -80.1918, name: 'Miami, FL' },
  'atlanta': { latitude: 33.749, longitude: -84.388, name: 'Atlanta, GA' },
  'portland': { latitude: 45.5152, longitude: -122.6784, name: 'Portland, OR' },
  'las vegas': { latitude: 36.1699, longitude: -115.1398, name: 'Las Vegas, NV' },
  'detroit': { latitude: 42.3314, longitude: -83.0458, name: 'Detroit, MI' },
  'minneapolis': { latitude: 44.9778, longitude: -93.265, name: 'Minneapolis, MN' },
  'washington': { latitude: 38.9072, longitude: -77.0369, name: 'Washington, DC' },
  'washington dc': { latitude: 38.9072, longitude: -77.0369, name: 'Washington, DC' },
  'dc': { latitude: 38.9072, longitude: -77.0369, name: 'Washington, DC' },
  'nashville': { latitude: 36.1627, longitude: -86.7816, name: 'Nashville, TN' },
  'charlotte': { latitude: 35.2271, longitude: -80.8431, name: 'Charlotte, NC' },
  'sacramento': { latitude: 38.5816, longitude: -121.4944, name: 'Sacramento, CA' },
  'oakland': { latitude: 37.8044, longitude: -122.2712, name: 'Oakland, CA' },
  'san jose': { latitude: 37.3382, longitude: -121.8863, name: 'San Jose, CA' },
  'brooklyn': { latitude: 40.6782, longitude: -73.9442, name: 'Brooklyn, NY' },
};

const US_STATES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi',
  mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
  nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
  nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee',
  tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington',
  wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
};

const GRAPHQL_HEADERS: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Max price value Facebook uses as "no upper limit"
const MAX_PRICE_SENTINEL = 214748364700;

// Residential proxy for Facebook requests (avoids datacenter IP rate limits)
const proxyAgent = process.env.SMARTPROXY_URL
  ? new ProxyAgent(process.env.SMARTPROXY_URL)
  : undefined;

export class FacebookMarketplace extends BaseMarketplace {
  readonly name = 'facebook';
  readonly displayName = 'Facebook Marketplace';
  readonly requiresAuth = false;

  // Cache location lookups to avoid repeat requests for the same city
  private locationCache: Map<string, LocationCoordinates> = new Map();
  private searchCache: Map<string, { at: number; result: SearchResult }> = new Map();

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, location = 'san francisco', maxPrice, minPrice, limit = 24 } = params;

    const cacheKey = JSON.stringify([query, location, maxPrice, minPrice, limit, params.showSold]);
    const hit = this.searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
      return hit.result;
    }

    try {
      // Step 1: Resolve location to coordinates
      const coords = await this.resolveLocation(location);
      if (!coords) {
        return this.createError(
          `Could not find location "${location}". Try a major city name like "san francisco", "nyc", or "chicago".`
        );
      }

      // Step 2: Search listings
      const variables = JSON.stringify({
        count: Math.min(limit, 24),
        params: {
          bqf: {
            callsite: 'COMMERCE_MKTPLACE_WWW',
            query,
          },
          browse_request_params: {
            commerce_enable_local_pickup: true,
            commerce_enable_shipping: true,
            commerce_search_and_rp_available: true,
            commerce_search_and_rp_condition: null,
            commerce_search_and_rp_ctime_days: null,
            filter_location_latitude: coords.latitude,
            filter_location_longitude: coords.longitude,
            filter_price_lower_bound: minPrice ?? 0,
            filter_price_upper_bound: maxPrice ?? MAX_PRICE_SENTINEL,
            filter_radius_km: 16,
          },
          custom_request_params: {
            surface: 'SEARCH',
          },
        },
      });

      const response = await this.fetchGraphQL(SEARCH_DOC_ID, variables);

      if (!response.data?.marketplace_search?.feed_units?.edges) {
        return this.createError(
          'Unexpected response structure from Facebook. The GraphQL doc_id may need updating.'
        );
      }

      const edges = response.data.marketplace_search.feed_units.edges;
      const listings = this.parseListings(edges, limit, params.showSold ?? false);

      const result: SearchResult = {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: listings.length,
      };

      this.searchCache.set(cacheKey, { at: Date.now(), result });
      if (this.searchCache.size > SEARCH_CACHE_MAX) {
        const oldest = this.searchCache.keys().next().value;
        if (oldest !== undefined) this.searchCache.delete(oldest);
      }

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

  /**
   * Facebook's city search is literal, and a "City, ST" query does not just
   * miss — "kansas city, mo" returns Mound City, Kansas. Spelling the state
   * out is the only form that reliably lands, so it goes first; the bare
   * city name is a last resort because "austin" is Austin, Illinois.
   */
  private locationCandidates(query: string): string[] {
    const base = query.toLowerCase().trim();
    const out: string[] = [];

    const match = base.match(/^(.+?),?\s+([a-z]{2})$/);
    const state = match && US_STATES[match[2]];
    if (match && state) out.push(`${match[1].trim()} ${state}`);

    if (!out.includes(base)) out.push(base);

    const bareCity = base.split(',')[0].trim();
    if (bareCity && !out.includes(bareCity)) out.push(bareCity);

    return out;
  }

  private async resolveLocation(query: string): Promise<LocationCoordinates | null> {
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
    if (SEED_LOCATIONS[cacheKey]) {
      return SEED_LOCATIONS[cacheKey];
    }

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

      const node = edges[0].node;
      const name =
        node.subtitle?.split(' \u00b7')[0] === 'City'
          ? node.single_line_address
          : node.subtitle?.split(' \u00b7')[0] || node.single_line_address;

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
        const node = edge?.node;
        if (!node || node.__typename !== 'MarketplaceFeedListingStoryObject') {
          continue;
        }

        const listing = node.listing;
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
          location: listing.location?.reverse_geocode?.city_page?.display_name,
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
      try {
        const response = await fetch(GRAPHQL_URL, {
          method: 'POST',
          headers: GRAPHQL_HEADERS,
          body: body.toString(),
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
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
      } catch (err: any) {
        if (err?.fatal) throw err;
        lastError = err;

        const backoff = 1000 * 2 ** (attempt - 1) * (0.5 + Math.random());
        if (attempt === MAX_ATTEMPTS || Date.now() + backoff >= deadline) break;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    throw lastError ?? new Error('Facebook request failed');
  }
}
