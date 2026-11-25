import { SearchParams } from '../../types.js';

const NEW = 1000;
const NEW_OTHER = 1500;
const NEW_WITH_DEFECTS = 1750;
const LIKE_NEW = 2750;
const PRE_OWNED_EXCELLENT = 2990;
const USED_EXCELLENT = 3000;
const PRE_OWNED_FAIR = 3010;
const USED_VERY_GOOD = 4000;
const USED_GOOD = 5000;
const USED_ACCEPTABLE = 6000;

// A pre-owned grade is a floor: asking for "good" also takes better grades.
// Many categories file every used item under USED_EXCELLENT alone, so each
// pre-owned floor keeps it; clothing grades with the PRE_OWNED IDs instead.
// Refurbished and for-parts items are never matched.
const NEW_GRADES = [NEW, NEW_OTHER, NEW_WITH_DEFECTS];
const LIKE_NEW_OR_BETTER = [LIKE_NEW];
const EXCELLENT_OR_BETTER = [...LIKE_NEW_OR_BETTER, PRE_OWNED_EXCELLENT, USED_EXCELLENT];
const GOOD_OR_BETTER = [...EXCELLENT_OR_BETTER, USED_VERY_GOOD, USED_GOOD];
const ANY_PRE_OWNED = [...GOOD_OR_BETTER, PRE_OWNED_FAIR, USED_ACCEPTABLE];

const CONDITION_IDS = new Map<string, number[]>([
  ['new', NEW_GRADES],
  ['like_new', LIKE_NEW_OR_BETTER],
  ['excellent', EXCELLENT_OR_BETTER],
  ['good', GOOD_OR_BETTER],
  ['fair', ANY_PRE_OWNED],
  ['used', ANY_PRE_OWNED],
]);

/**
 * The Browse filter for a condition. It uses `conditionIds` because the
 * `conditions` filter takes only NEW, USED and UNSPECIFIED and silently
 * ignores finer grades.
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
