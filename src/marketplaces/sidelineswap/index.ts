/**
 * SidelineSwap marketplace implementation
 *
 * Reads the JSON endpoints behind SidelineSwap's storefront. No credentials or browser needed.
 * Prices are USD asking prices before shipping and tax.
 */

import { BaseMarketplace } from '../base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../../types.js';
import { itemDetails, itemId, listingIdFrom, summaryListing } from './parse.js';
import { ListingState, PAGE_SIZE, searchQuery } from './query.js';
import { Item, ItemResponse, Paging, SearchResponse } from './wire.js';

const API_URL = 'https://api.sidelineswap.com';
const MAX_PAGES = 10;
const MAX_RESULTS = PAGE_SIZE * MAX_PAGES;
const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_DEADLINE_MS = 45_000;

interface StateResults {
  listings: Listing[];
  totalFound?: number;
  failure?: unknown;
}

export class SidelineSwapMarketplace extends BaseMarketplace {
  readonly name = 'sidelineswap';
  readonly displayName = 'SidelineSwap';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const limit = Math.min(params.limit ?? 20, MAX_RESULTS);
    const offset = params.offset ?? 0;
    const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    const seen = new Set<string>();

    const available = await this.searchState(params, 'available', offset, limit, deadline, seen);
    const wantsSold = params.showSold && available.failure === undefined && available.listings.length < limit;
    const sold = wantsSold && available.totalFound !== undefined
      ? await this.searchState(params, 'sold', soldOffset(offset, available.totalFound), limit - available.listings.length, deadline, seen)
      : undefined;

    const listings = [...available.listings, ...(sold?.listings ?? [])];
    const failure = available.failure ?? sold?.failure;
    const totalFound = params.showSold ? combinedTotal(available.totalFound, sold?.totalFound) : available.totalFound;

    if (failure !== undefined && listings.length === 0) return this.createError(`SidelineSwap search failed: ${failure}`);
    if (failure !== undefined) return { marketplace: this.name, success: true, listings, totalFound, note: `Later pages failed: ${failure}` };
    return { marketplace: this.name, success: true, listings, totalFound };
  }

  /** SidelineSwap ranks sold items ahead of available ones when both are asked for together, so each state is its own search. */
  private async searchState(
    params: SearchParams,
    state: ListingState,
    offset: number,
    limit: number,
    deadline: AbortSignal,
    seen: Set<string>
  ): Promise<StateResults> {
    const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
    const listings: Listing[] = [];
    let totalFound: number | undefined;

    try {
      for (let page = firstPage; page < firstPage + MAX_PAGES && listings.length < limit; page++) {
        const response = wireObject<SearchResponse>(await this.get('/v2/facet_items', searchQuery(params, page, state), deadline));
        if (!response || !Array.isArray(response.data)) throw new Error('SidelineSwap returned an unexpected search response');

        totalFound ??= exactTotal(response.meta?.paging);
        const rows = page === firstPage ? response.data.slice(offset % PAGE_SIZE) : response.data;
        const fresh = unseenListings(rows, seen);
        listings.push(...fresh.slice(0, limit - listings.length));

        if (!response.meta?.paging?.has_next_page || fresh.length === 0) break;
      }
    } catch (failure) {
      return { listings, totalFound, failure };
    }

    return { listings, totalFound };
  }

  async getListingDetails(input: string): Promise<ListingDetails> {
    const id = listingIdFrom(input);
    if (!id) throw new Error('SidelineSwap listing IDs are numbers; a sidelineswap.com/gear/ URL also works');

    const data = wireObject<ItemResponse>(await this.get(`/v1/items/${id}`))?.data;
    if (!data || itemId(data) !== id) throw new Error(`SidelineSwap listing ${id} not found`);
    return itemDetails(data, id);
  }

  private async get(path: string, query?: URLSearchParams, deadline?: AbortSignal): Promise<unknown> {
    const url = new URL(path, API_URL);
    if (query) url.search = query.toString();
    const timeouts = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(deadline ? [deadline] : [])];
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any(timeouts) });
    if (!response.ok) throw new Error(`SidelineSwap returned ${response.status}`);
    return response.json();
  }
}

/** SidelineSwap caps its count on broad queries; a capped count is left out rather than reported as the total. */
export function exactTotal(paging: Paging | undefined): number | undefined {
  return paging?.total_count_truncated === false ? paging.total_count : undefined;
}

/** Every wire field is optional, so any JSON object fits the wire types; null, arrays and primitives do not. */
export function wireObject<T extends object>(body: unknown): T | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as T) : undefined;
}

/** Sold items follow every available one, so an offset past the available items continues into the sold ones. */
export function soldOffset(offset: number, availableTotal: number): number {
  return Math.max(0, offset - availableTotal);
}

export function combinedTotal(available: number | undefined, sold: number | undefined): number | undefined {
  return available !== undefined && sold !== undefined ? available + sold : undefined;
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
