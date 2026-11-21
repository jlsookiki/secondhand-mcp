/**
 * Geartrade marketplace implementation
 *
 * Reads Geartrade's public Shopify storefront. No credentials or browser needed.
 * Prices are USD asking prices before shipping and tax.
 */

import { BaseMarketplace } from '../base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../../types.js';
import { Card, cardListing, listingRefFrom, productDetails, productFrom, productListings, searchPage } from './parse.js';
import { PAGE_SIZE, SITE, searchUrl, storefrontConditions } from './query.js';
import { Product } from './wire.js';

const MAX_PAGES = 3;
const MAX_RESULTS = PAGE_SIZE * MAX_PAGES;
const PRODUCT_REQUESTS_AT_ONCE = 3;
const REQUEST_TIMEOUT_MS = 15_000;
export const SEARCH_DEADLINE_MS = 45_000;

export class GeartradeMarketplace extends BaseMarketplace {
  readonly name = 'geartrade';
  readonly displayName = 'Geartrade';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const { start, end } = resultWindow(params);
    if (start >= end) return { marketplace: this.name, success: true, listings: [] };

    const deadline = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    const gathered: Listing[] = [];
    const seen = new Set<string>();

    // A card can become several listings or none, so the start position is only known by reading from page 1.
    try {
      for (let page = 1; page <= MAX_PAGES && gathered.length < end; page++) {
        const { cards, hasNextPage } = searchPage(await this.get(searchUrl(params, page), deadline, 'text/html'));
        const fresh = unseenCards(cards, seen);
        await this.collect(fresh, params, end, deadline, gathered);
        if (!hasNextPage || fresh.length === 0) break;
      }
    } catch (error) {
      if (gathered.length === 0) return this.createError(`Geartrade search failed: ${error}`);
      return { marketplace: this.name, success: true, listings: gathered.slice(start, end), note: `Later results failed: ${error}` };
    }

    return { marketplace: this.name, success: true, listings: gathered.slice(start, end) };
  }

  async getListingDetails(input: string): Promise<ListingDetails> {
    const ref = listingRefFrom(input);
    if (!ref) throw new Error('Geartrade listing IDs are a product handle, optionally followed by :variantId');

    const product = await this.product(ref.handle);
    if (product.handle !== ref.handle) throw new Error(`Geartrade listing ${ref.handle} not found`);
    return productDetails(product, ref);
  }

  /** Requests product data only for multi-variant cards, and only until `gathered` holds `end` listings. */
  private async collect(cards: Card[], params: SearchParams, end: number, deadline: AbortSignal, gathered: Listing[]): Promise<void> {
    const conditions = storefrontConditions(params.condition);
    const condition = conditions.length === 1 ? conditions[0] : undefined;

    let next = 0;
    while (next < cards.length && gathered.length < end) {
      const batch = cards.slice(next, next + Math.min(PRODUCT_REQUESTS_AT_ONCE, end - gathered.length));
      next += batch.length;
      const found = await Promise.all(batch.map((card) => this.cardListings(card, params, condition, deadline)));
      gathered.push(...found.flat());
    }
  }

  private async cardListings(card: Card, params: SearchParams, condition: string | undefined, deadline: AbortSignal): Promise<Listing[]> {
    if (card.variants.length > 1) return this.variantListings(card, params, deadline);
    const listing = cardListing(card, condition);
    return listing ? [listing] : [];
  }

  /** One product that fails to load costs only its own listings, unless the whole search has run out of time. */
  private async variantListings(card: Card, params: SearchParams, deadline: AbortSignal): Promise<Listing[]> {
    try {
      return productListings(await this.product(card.handle, deadline), card.handle, params);
    } catch (error) {
      if (deadline.aborted) throw error;
      return [];
    }
  }

  private async product(handle: string, deadline?: AbortSignal): Promise<Product> {
    return productFrom(await this.get(new URL(`/products/${handle}.js`, SITE), deadline, 'application/json'));
  }

  private async get(url: URL, deadline: AbortSignal | undefined, accept: string): Promise<string> {
    const timeouts = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(deadline ? [deadline] : [])];
    const response = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.any(timeouts) });
    if (!response.ok) throw new Error(`Geartrade returned ${response.status}`);
    return response.text();
  }
}

/** The listing positions a search returns, bounded by how far the page limit lets the adapter read. */
export function resultWindow(params: Pick<SearchParams, 'offset' | 'limit'>): { start: number; end: number } {
  const start = Math.max(params.offset ?? 0, 0);
  const end = Math.min(start + (params.limit ?? 20), MAX_RESULTS);
  return { start, end };
}

function unseenCards(cards: Card[], seen: Set<string>): Card[] {
  const fresh = cards.filter((card) => !seen.has(card.handle));
  for (const card of fresh) seen.add(card.handle);
  return fresh;
}
