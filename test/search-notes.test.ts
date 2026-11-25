import { describe, expect, it } from 'vitest';
import { formatSingleResult, formatMultipleResults } from '../src/tools/format.js';
import type { SearchResult } from '../src/types.js';

const params = { query: 'mask', location: 'Boston' };
const listing = { id: '1', title: 'Mask', price: 'USD 10', url: 'https://example.com/1', marketplace: 'test', scrapedAt: '2026-10-14' };
const result: SearchResult = { marketplace: 'test', success: true, listings: [listing], note: 'Inspected 1 page; more results remain.' };

describe('search coverage notes', () => {
  it('retains notes in single-marketplace search output', () => {
    expect(formatSingleResult(result, params, false)).toContain(result.note);
  });
  it('retains notes when filtering leaves no listings', () => {
    expect(formatSingleResult({ ...result, listings: [] }, params, false)).toContain(result.note);
  });
  it('retains notes for populated and empty sources in multi-marketplace output', () => {
    const empty = { ...result, marketplace: 'empty', listings: [], note: 'A bounded search, not complete inventory.' };
    const formatted = formatMultipleResults([result, empty], params, false);
    expect(formatted).toContain(result.note);
    expect(formatted).toContain(empty.note);
  });
});
