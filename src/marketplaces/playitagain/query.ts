import { Listing, SearchParams } from '../../types.js';
import { SITE } from './parse.js';

const SORT_KEYS: Partial<Record<NonNullable<SearchParams['sort']>, string>> = {
  relevance: 'relevance',
  newest: 'newest',
  price_low_to_high: 'priceasc',
  price_high_to_low: 'pricedesc',
};

const CONDITIONS = new Set<SearchParams['condition']>(['new', 'used']);

/** Filters the storefront has no equivalent for are left out, the same way the other marketplaces ignore them. */
export function searchUrl(params: SearchParams, page: number): URL {
  const url = new URL('/search.php', SITE);
  url.searchParams.set('search_query', params.query);
  url.searchParams.set('section', 'product');
  url.searchParams.set('page', String(page));
  url.searchParams.set('sort', (params.sort && SORT_KEYS[params.sort]) ?? SORT_KEYS.relevance!);
  return url;
}

/** Price and condition aren't search parameters on the storefront, so they are checked on each listing instead. */
export function matchesFilters(listing: Listing, params: SearchParams): boolean {
  if (CONDITIONS.has(params.condition) && listing.condition?.toLowerCase() !== params.condition) return false;
  if (params.minPrice === undefined && params.maxPrice === undefined) return true;
  // Bounds carry no currency, so Canadian listings are never compared against them.
  if (listing.currency !== 'USD' || listing.priceNumeric === undefined) return false;
  return listing.priceNumeric >= (params.minPrice ?? 0) && listing.priceNumeric <= (params.maxPrice ?? Infinity);
}

export function hasListingFilters(params: SearchParams): boolean {
  return CONDITIONS.has(params.condition) || params.minPrice !== undefined || params.maxPrice !== undefined;
}
