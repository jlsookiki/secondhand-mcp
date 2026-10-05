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

import { BaseMarketplace } from '../base.js';
import { Listing, SearchParams, SearchResult, ListingDetails, LocationCoordinates } from '../../types.js';
import { getListingDetails } from './details.js';
import { LocationLookupError, LocationResolver } from './locations.js';
import { extractFeedUnitEdges, pageAnswered, parseListings, readFeedUnits } from './parse.js';
import {
  API_PAGE_SIZE,
  PriceBounds,
  SEARCH_DOC_ID,
  clampRadius,
  searchPageUrl,
  searchVariables,
} from './queries.js';
import { GraphAnswer, chooseAnswer, needsSearchPage } from './route.js';
import { RefusalError, fetchGraphQL, fetchSearchPage } from './transport.js';
import { SearchData } from './wire.js';

export { DEFAULT_RADIUS_MILES } from './queries.js';

const SEARCH_CACHE_TTL_MS = 90_000;
const SEARCH_CACHE_MAX = 200;

export class FacebookMarketplace extends BaseMarketplace {
  readonly name = 'facebook';
  readonly displayName = 'Facebook Marketplace';
  readonly requiresAuth = false;

  private locations = new LocationResolver();
  private searchCache: Map<string, { at: number; result: SearchResult }> = new Map();

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, location = 'san francisco', maxPrice, minPrice, limit = API_PAGE_SIZE } = params;
    const showSold = params.showSold ?? false;
    const radiusMiles = clampRadius(params.radius);
    const prices: PriceBounds = { minPrice, maxPrice };

    const cacheKey = JSON.stringify([query, location, maxPrice, minPrice, limit, showSold, radiusMiles]);
    const hit = this.searchCache.get(cacheKey);
    if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
      return hit.result;
    }

    try {
      const coords = await this.locations.coordinates(location);
      if (!coords) {
        return this.createError(
          `Could not find location "${location}". Try a major city name like "san francisco", "nyc", or "chicago".`
        );
      }

      const graph = await searchGraphQL(query, coords, limit, prices, radiusMiles, showSold);
      const page = needsSearchPage(graph, limit)
        ? await this.searchViaPage(location, coords, query, limit, prices, showSold, radiusMiles)
        : null;

      const answer = chooseAnswer(graph, page);
      if (answer.kind === 'unreadable') {
        return this.createError(
          'Unexpected response structure from Facebook, and the search page could not be read either. The GraphQL doc_id may need updating.'
        );
      }
      if (answer.kind === 'failed') throw answer.error;

      const result = this.found(answer.listings);
      this.remember(cacheKey, result);
      return result;
    } catch (error) {
      if (error instanceof LocationLookupError) return this.createError(error.message);
      return this.createError(`Facebook Marketplace search failed: ${error}`);
    }
  }

  async getLocation(query: string): Promise<LocationCoordinates | null> {
    return this.locations.coordinates(query);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const coords = await this.locations.coordinates('new york');
      return coords !== null;
    } catch {
      return false;
    }
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    return getListingDetails(listingId);
  }

  private found(listings: Listing[]): SearchResult {
    return {
      marketplace: this.name,
      success: true,
      listings,
      totalFound: listings.length,
    };
  }

  private remember(cacheKey: string, result: SearchResult): void {
    this.searchCache.set(cacheKey, { at: Date.now(), result });
    if (this.searchCache.size > SEARCH_CACHE_MAX) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest !== undefined) this.searchCache.delete(oldest);
    }
  }

  private async searchViaPage(
    location: string,
    coords: LocationCoordinates,
    query: string,
    limit: number,
    prices: PriceBounds,
    showSold: boolean,
    radiusMiles: number
  ): Promise<Listing[] | null> {
    try {
      const pageId = await this.locations.cityPageId(location, coords);
      if (!pageId) return null;
      const html = await fetchSearchPage(searchPageUrl(pageId, query, prices, radiusMiles));
      const edges = extractFeedUnitEdges(html);
      if (!edges || !pageAnswered(edges)) {
        console.error('[facebook] search page had no results payload');
        return null;
      }
      return parseListings(edges, limit, showSold);
    } catch (err) {
      console.error('[facebook] search page fallback failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

async function searchGraphQL(
  query: string,
  coords: LocationCoordinates,
  limit: number,
  prices: PriceBounds,
  radiusMiles: number,
  showSold: boolean
): Promise<GraphAnswer> {
  try {
    const response = await fetchGraphQL<SearchData>(
      SEARCH_DOC_ID,
      searchVariables(query, coords, limit, prices, radiusMiles)
    );
    return {
      kind: 'read',
      reading: readFeedUnits(response.data?.marketplace_search?.feed_units, limit, showSold),
    };
  } catch (error) {
    if (!(error instanceof RefusalError)) throw error;
    console.error('[facebook] graphql search refused:', error.message);
    return { kind: 'failed', error };
  }
}
