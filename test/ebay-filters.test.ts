import { describe, expect, it } from 'vitest';
import { conditionFilter, searchFilter } from '../src/marketplaces/ebay/filters.js';
import type { SearchParams } from '../src/types.js';

describe('conditionFilter', () => {
  it.each([
    ['new', 'conditionIds:{1000|1500|1750}'],
    ['like_new', 'conditionIds:{2750|2990|3000|3010|4000|5000|6000}'],
    ['excellent', 'conditionIds:{2750|2990|3000|3010|4000|5000|6000}'],
    ['good', 'conditionIds:{2750|2990|3000|3010|4000|5000|6000}'],
    ['fair', 'conditionIds:{2750|2990|3000|3010|4000|5000|6000}'],
    ['used', 'conditionIds:{2750|2990|3000|3010|4000|5000|6000}'],
  ] as const)('names %s by its eBay condition IDs', (condition, filter) => {
    expect(conditionFilter(condition)).toBe(filter);
  });

  it('sends no condition filter for "any" or no condition', () => {
    expect(conditionFilter('any')).toBeUndefined();
    expect(conditionFilter(undefined)).toBeUndefined();
  });

  it('sends no condition filter for a word it does not know', () => {
    expect(conditionFilter('toString' as SearchParams['condition'])).toBeUndefined();
  });
});

describe('searchFilter', () => {
  it('follows the price filter with the condition filter', () => {
    expect(searchFilter({ maxPrice: 50, condition: 'good' }, 'USD')).toBe(
      'price:[..50],priceCurrency:USD,conditionIds:{2750|2990|3000|3010|4000|5000|6000}'
    );
  });
});
