import { SearchParams } from '../../types.js';

export const SITE = 'https://geartrade.com';

/** Geartrade's theme shows a fixed number of results per search page. */
export const PAGE_SIZE = 16;

const SORT_KEYS: Partial<Record<NonNullable<SearchParams['sort']>, string>> = {
  relevance: 'relevance',
  price_low_to_high: 'price-ascending',
  price_high_to_low: 'price-descending',
};

const CONDITIONS: Partial<Record<NonNullable<SearchParams['condition']>, string[]>> = {
  new: ['New'],
  excellent: ['Excellent'],
  good: ['Good'],
  fair: ['Fair'],
  used: ['Excellent', 'Good', 'Fair'],
};

export function storefrontConditions(condition: SearchParams['condition']): string[] {
  return (condition && CONDITIONS[condition]) ?? [];
}

/** Filters Geartrade has no equivalent for are left out, the same way the other marketplaces ignore them. */
export function searchUrl(params: SearchParams, page: number): URL {
  const url = new URL('/search', SITE);
  const query = url.searchParams;
  query.set('q', params.query);
  query.set('type', 'product');
  query.set('sort_by', (params.sort && SORT_KEYS[params.sort]) ?? SORT_KEYS.relevance!);
  query.set('page', String(page));
  if (params.minPrice !== undefined) query.set('filter.v.price.gte', String(params.minPrice));
  if (params.maxPrice !== undefined) query.set('filter.v.price.lte', String(params.maxPrice));
  if (params.brand) query.set('filter.p.m.global.Brand', params.brand);
  if (params.category) query.set('filter.p.product_type', params.category);
  for (const size of params.sizes ?? []) query.append('filter.v.option.size', size);
  for (const condition of storefrontConditions(params.condition)) query.append('filter.v.m.global.Condition', condition);
  return url;
}
