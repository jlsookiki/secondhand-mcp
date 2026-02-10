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

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, location = 'san francisco', maxPrice, minPrice, limit = 24 } = params;

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

      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: listings.length,
      };
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

  private async resolveLocation(query: string): Promise<LocationCoordinates | null> {
    const cacheKey = query.toLowerCase().trim();

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

    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: GRAPHQL_HEADERS,
      body: body.toString(),
      // @ts-ignore — dispatcher is a Node.js/undici-specific fetch option
      dispatcher: proxyAgent,
    });

    if (!response.ok) {
      throw new Error(`Facebook API returned status ${response.status}`);
    }

    const json = (await response.json()) as any;

    if (json.errors?.length) {
      throw new Error(`Facebook GraphQL error: ${json.errors[0].message}`);
    }

    return json;
  }
}
