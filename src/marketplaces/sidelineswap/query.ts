import { SearchParams } from '../../types.js';

export const PAGE_SIZE = 50;

const SORT_KEYS: Partial<Record<NonNullable<SearchParams['sort']>, string>> = {
  relevance: 'relevancy_desc',
  newest: 'newest',
  price_low_to_high: 'price_asc',
  price_high_to_low: 'price_desc',
};

const CONDITION_IDS: Partial<Record<NonNullable<SearchParams['condition']>, string>> = {
  new: '31',
  used: '17',
};

export type ListingState = 'available' | 'sold';

const CATEGORY_ID = /^[1-9]\d*$/;

/** Filters SidelineSwap has no equivalent for are left out, the same way the other marketplaces ignore them. */
export function searchQuery(params: SearchParams, page: number, state: ListingState): URLSearchParams {
  const query = new URLSearchParams({
    q: params.query,
    page_size: String(PAGE_SIZE),
    page: String(page),
    sort: (params.sort && SORT_KEYS[params.sort]) ?? SORT_KEYS.relevance!,
  });
  query.append('state[]', state);
  if (params.minPrice !== undefined) query.set('min_price', String(params.minPrice));
  if (params.maxPrice !== undefined) query.set('max_price', String(params.maxPrice));
  const conditionId = params.condition && CONDITION_IDS[params.condition];
  if (conditionId) query.append('condition[]', conditionId);
  if (params.category && CATEGORY_ID.test(params.category)) query.append('category[]', params.category);
  return query;
}
