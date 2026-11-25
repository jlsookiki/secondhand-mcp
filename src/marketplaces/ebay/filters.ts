import { SearchParams } from '../../types.js';

// eBay gives some condition IDs a different meaning per category: in trading
// cards 2750 is Graded and 4000 Ungraded, in clothing 3000 is Pre-owned - Good.
// Only new against pre-owned holds everywhere, so every used grade takes the
// whole pre-owned set. Refurbished (2000-2500) and for-parts (7000) are left out.
const NEW_IDS = [1000, 1500, 1750];
const PRE_OWNED_IDS = [2750, 2990, 3000, 3010, 4000, 5000, 6000];

const CONDITION_IDS = new Map<string, number[]>([
  ['new', NEW_IDS],
  ['like_new', PRE_OWNED_IDS],
  ['excellent', PRE_OWNED_IDS],
  ['good', PRE_OWNED_IDS],
  ['fair', PRE_OWNED_IDS],
  ['used', PRE_OWNED_IDS],
]);

/**
 * The Browse filter for a condition. It uses `conditionIds` because the
 * `conditions` filter takes only NEW, USED and UNSPECIFIED, and its USED
 * includes refurbished and for-parts items.
 */
export function conditionFilter(condition: SearchParams['condition']): string | undefined {
  const ids = condition ? CONDITION_IDS.get(condition) : undefined;
  if (!ids) return undefined;
  return `conditionIds:{${ids.join('|')}}`;
}

/** The Browse `filter` parameter for a search, or undefined when it has none. */
export function searchFilter(
  { minPrice, maxPrice, condition }: Pick<SearchParams, 'minPrice' | 'maxPrice' | 'condition'>,
  currency: string
): string | undefined {
  const filters: string[] = [];
  if (minPrice != null || maxPrice != null) {
    // Browse silently drops a price filter that arrives without a currency,
    // returning unfiltered results rather than an error.
    filters.push(`price:[${minPrice ?? ''}..${maxPrice ?? ''}]`, `priceCurrency:${currency}`);
  }
  const conditions = conditionFilter(condition);
  if (conditions) filters.push(conditions);
  return filters.length > 0 ? filters.join(',') : undefined;
}
