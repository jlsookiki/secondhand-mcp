/**
 * Geartrade marketplace implementation
 *
 * Reads Geartrade's public Shopify storefront. No credentials or browser needed.
 * Prices are USD asking prices before shipping and tax.
 */

import { BaseMarketplace } from '../base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../../types.js';
import { Card, cardListing, listingRefFrom, productDetails, productListings, searchPage } from './parse.js';
import { PAGE_SIZE, SITE, searchUrl, storefrontConditions } from './query.js';
import { Product } from './wire.js';

const MAX_PAGES = 3;
const MAX_RESULTS = PAGE_SIZE * MAX_PAGES;
const PRODUCT_REQUESTS_AT_ONCE = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_DEADLINE_MS = 45_000;

export class GeartradeMarketplace extends BaseMarketplace {
  readonly name = 'geartrade';
  readonly displayName = 'Geartrade';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const limit = Math.min(params.limit ?? 20, MAX_RESULTS);
    const offset = Math.max(params.offset ?? 0, 0);
    const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
    const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    const listings: Listing[] = [];
    const seen = new Set<string>();

    try {
      for (let page = firstPage; page < firstPage + MAX_PAGES && listings.length < limit; page++) {
        const { cards, hasNextPage } = searchPage(await this.get(searchUrl(params, page), deadline, 'text/html'));
        const rows = page === firstPage ? cards.slice(offset % PAGE_SIZE) : cards;
        const fresh = unseenCards(rows, seen);
        listings.push(...(await this.listingsFrom(fresh, params, limit - listings.length, deadline)));
        if (!hasNextPage || fresh.length === 0) break;
      }
    } catch (error) {
      if (listings.length === 0) return this.createError(`Geartrade search failed: ${error}`);
      return { marketplace: this.name, success: true, listings, note: `Later results failed: ${error}` };
    }

    return { marketplace: this.name, success: true, listings };
  }

  async getListingDetails(input: string): Promise<ListingDetails> {
    const ref = listingRefFrom(input);
    if (!ref) throw new Error('Geartrade listing IDs are a product handle, optionally followed by :variantId');

    const product = await this.product(ref.handle);
    if (product.handle !== ref.handle) throw new Error(`Geartrade listing ${ref.handle} not found`);
    return productDetails(product, ref);
  }

  /** Requests product data only for multi-variant cards, and only until `wanted` listings are found. */
  private async listingsFrom(cards: Card[], params: SearchParams, wanted: number, deadline: AbortSignal): Promise<Listing[]> {
    const conditions = storefrontConditions(params.condition);
    const condition = conditions.length === 1 ? conditions[0] : undefined;
    const listings: Listing[] = [];

    let next = 0;
    while (next < cards.length && listings.length < wanted) {
      const batch = cards.slice(next, next + Math.min(PRODUCT_REQUESTS_AT_ONCE, wanted - listings.length));
      next += batch.length;
      const found = await Promise.all(batch.map((card) => this.cardListings(card, params, condition, deadline)));
      listings.push(...found.flat());
    }
    return listings.slice(0, wanted);
  }

  private async cardListings(card: Card, params: SearchParams, condition: string | undefined, deadline: AbortSignal): Promise<Listing[]> {
    if (card.variants.length > 1) return productListings(await this.product(card.handle, deadline), card.handle, params);
    const listing = cardListing(card, condition);
    return listing ? [listing] : [];
  }

  private async product(handle: string, deadline?: AbortSignal): Promise<Product> {
    return JSON.parse(await this.get(new URL(`/products/${handle}.js`, SITE), deadline, 'application/json')) as Product;
  }

  private async get(url: URL, deadline: AbortSignal | undefined, accept: string): Promise<string> {
    const timeouts = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(deadline ? [deadline] : [])];
    const response = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.any(timeouts) });
    if (!response.ok) throw new Error(`Geartrade returned ${response.status}`);
    return response.text();
  }
}

function unseenCards(cards: Card[], seen: Set<string>): Card[] {
  const fresh = cards.filter((card) => !seen.has(card.handle));
  for (const card of fresh) seen.add(card.handle);
  return fresh;
}
