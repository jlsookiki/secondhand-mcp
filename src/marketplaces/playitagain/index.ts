/**
 * Play It Again Sports marketplace implementation
 *
 * Reads the product data embedded in playitagainsports.com's public search and product pages.
 * No credentials or browser needed. Prices are in the store's own currency (USD or CAD), before shipping and tax.
 */

import { BaseMarketplace } from '../base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../../types.js';
import { isInStock, pageData, productDetails, productPath, resultCount, SITE, summaryListing } from './parse.js';
import { hasListingFilters, matchesFilters, searchUrl } from './query.js';
import { isProduct, isSearchPage } from './wire.js';

const STOREFRONT_PAGE_SIZE = 12;
const MAX_PAGES = 10;
const MAX_RESULTS = STOREFRONT_PAGE_SIZE * MAX_PAGES;
const DEFAULT_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 20_000;
export const SEARCH_DEADLINE_MS = 45_000;
const STOREFRONT_COUNT_CAP = 10_000;

export class PlayItAgainMarketplace extends BaseMarketplace {
  readonly name = 'playitagain';
  readonly displayName = 'Play It Again Sports';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const limit = clampCount(params.limit ?? DEFAULT_LIMIT);
    const offset = clampCount(params.offset ?? 0);
    const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    const matches: Listing[] = [];
    const seen = new Set<string>();
    let count: number | undefined;

    try {
      for (let page = 1; page <= MAX_PAGES && matches.length < offset + limit; page++) {
        const data = pageData(await this.get(searchUrl(params, page), deadline));
        if (!isSearchPage(data)) {
          throw new Error('Play It Again Sports returned an unexpected search page');
        }

        count ??= resultCount(data.searchResultsCount);
        const seenBefore = seen.size;
        const fresh = unseenListings(data.searchProducts, seen);
        matches.push(...fresh.filter((listing) => matchesFilters(listing, params)));

        const lastPage = data.searchProducts.length < (data.searchProductsPerPage ?? STOREFRONT_PAGE_SIZE);
        if (lastPage || seen.size === seenBefore) break;
      }
    } catch (error) {
      const listings = matches.slice(offset, offset + limit);
      if (listings.length === 0) return this.createError(`Play It Again Sports search failed: ${error}`);
      return { marketplace: this.name, success: true, listings, note: `Later pages failed: ${error}` };
    }

    const listings = matches.slice(offset, offset + limit);
    return { marketplace: this.name, success: true, listings, totalFound: totalFound(count, params) };
  }

  async getListingDetails(input: string): Promise<ListingDetails> {
    const path = productPath(input);
    if (!path) {
      throw new Error('Play It Again Sports listing IDs are product paths from search; a playitagainsports.com product URL also works');
    }

    const details = productDetails(await this.get(new URL(path, SITE)), path);
    if (!details) throw new Error(`Play It Again Sports listing ${path} not found`);
    return details;
  }

  private async get(url: URL, deadline?: AbortSignal): Promise<string> {
    const timeouts = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(deadline ? [deadline] : [])];
    const response = await fetch(url, { headers: { Accept: 'text/html' }, signal: AbortSignal.any(timeouts) });
    if (!response.ok) throw new Error(`Play It Again Sports returned ${response.status}`);
    return response.text();
  }
}

export function clampCount(value: number): number {
  return Math.min(Math.max(value, 0), MAX_RESULTS);
}

/** The storefront counts the whole query and stops counting at 10,000, so only an uncapped, unfiltered count is the total. */
export function totalFound(count: number | undefined, params: SearchParams): number | undefined {
  if (count === undefined || count >= STOREFRONT_COUNT_CAP || hasListingFilters(params)) return undefined;
  return count;
}

function unseenListings(rows: unknown[], seen: Set<string>): Listing[] {
  const listings: Listing[] = [];
  for (const row of rows) {
    if (!isProduct(row)) continue;
    const listing = summaryListing(row);
    if (!listing || seen.has(listing.id)) continue;
    seen.add(listing.id);
    if (isInStock(row)) listings.push(listing);
  }
  return listings;
}
