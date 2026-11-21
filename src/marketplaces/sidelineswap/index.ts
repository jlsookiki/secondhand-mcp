/**
 * SidelineSwap marketplace implementation
 *
 * Reads the JSON endpoints behind SidelineSwap's storefront. No credentials or browser needed.
 * Prices are USD asking prices before shipping and tax.
 */

import { BaseMarketplace } from '../base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../../types.js';
import { itemDetails, itemId, listingIdFrom, summaryListing } from './parse.js';
import { PAGE_SIZE, searchQuery } from './query.js';
import { Item, ItemResponse, Paging, SearchResponse } from './wire.js';

const API_URL = 'https://api.sidelineswap.com';
const MAX_PAGES = 10;
const MAX_RESULTS = PAGE_SIZE * MAX_PAGES;
const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_DEADLINE_MS = 45_000;

export class SidelineSwapMarketplace extends BaseMarketplace {
  readonly name = 'sidelineswap';
  readonly displayName = 'SidelineSwap';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const limit = Math.min(params.limit ?? 20, MAX_RESULTS);
    const offset = params.offset ?? 0;
    const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
    const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    const listings: Listing[] = [];
    const seen = new Set<string>();
    let totalFound: number | undefined;

    try {
      for (let page = firstPage; page < firstPage + MAX_PAGES && listings.length < limit; page++) {
        const response = await this.get<SearchResponse>('/v2/facet_items', searchQuery(params, page), deadline);
        if (!Array.isArray(response.data)) throw new Error('SidelineSwap returned an unexpected search response');

        totalFound ??= exactTotal(response.meta?.paging);
        const rows = page === firstPage ? response.data.slice(offset % PAGE_SIZE) : response.data;
        const fresh = unseenListings(rows, seen);
        listings.push(...fresh.slice(0, limit - listings.length));

        if (!response.meta?.paging?.has_next_page || fresh.length === 0) break;
      }
    } catch (error) {
      if (listings.length === 0) return this.createError(`SidelineSwap search failed: ${error}`);
      return { marketplace: this.name, success: true, listings, totalFound, note: `Later pages failed: ${error}` };
    }

    return { marketplace: this.name, success: true, listings, totalFound };
  }

  async getListingDetails(input: string): Promise<ListingDetails> {
    const id = listingIdFrom(input);
    if (!id) throw new Error('SidelineSwap listing IDs are numbers; a sidelineswap.com/gear/ URL also works');

    const { data } = await this.get<ItemResponse>(`/v1/items/${id}`);
    if (!data || itemId(data) !== id) throw new Error(`SidelineSwap listing ${id} not found`);
    return itemDetails(data, id);
  }

  private async get<T>(path: string, query?: URLSearchParams, deadline?: AbortSignal): Promise<T> {
    const url = new URL(path, API_URL);
    if (query) url.search = query.toString();
    const timeouts = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(deadline ? [deadline] : [])];
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any(timeouts) });
    if (!response.ok) throw new Error(`SidelineSwap returned ${response.status}`);
    return (await response.json()) as T;
  }
}

/** SidelineSwap caps its count on broad queries; a capped count is left out rather than reported as the total. */
export function exactTotal(paging: Paging | undefined): number | undefined {
  return paging?.total_count_truncated === false ? paging.total_count : undefined;
}

function unseenListings(rows: Item[], seen: Set<string>): Listing[] {
  const listings: Listing[] = [];
  for (const row of rows) {
    const listing = row ? summaryListing(row) : undefined;
    if (!listing || seen.has(listing.id)) continue;
    seen.add(listing.id);
    listings.push(listing);
  }
  return listings;
}
