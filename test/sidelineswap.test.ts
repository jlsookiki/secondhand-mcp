import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidelineSwapMarketplace } from '../src/marketplaces/sidelineswap.js';
import type { SearchParams } from '../src/types.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/sidelineswap-${name}.json`, import.meta.url), 'utf8'));
const sample = () => fixture('search').data[2];
const page = (rows: unknown[], number = 1, next = false) => ({ data: rows, meta: { paging: { page: number, page_size: 50, has_next_page: next, total_count: rows.length, total_count_truncated: false } } });
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
let fetchMock: ReturnType<typeof vi.fn>;
let mp: SidelineSwapMarketplace;
beforeEach(() => {
  fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); mp = new SidelineSwapMarketplace();
});

describe('SidelineSwap search', () => {
  it('reads a captured storefront fixture, uses USD, and applies verified server filters', async () => {
    fetchMock.mockResolvedValue(response(fixture('search')));
    const result = await mp.search({ query: 'bauer 950', minPrice: 100, maxPrice: 500, condition: 'used', category: '110030', sort: 'price_low_to_high' });
    expect(result.success).toBe(true);
    expect(result.listings.map(l => l.priceNumeric)).toEqual([107, 200, 270]);
    expect(result.listings[2]).toMatchObject({ id: '12475475', price: 'USD 270.00', currency: 'USD', condition: 'Used', seller: 'fixture_seller', description: 'Availability: available' });
    expect(result.listings[2].url).toContain('/12475475-');
    expect(result.listings[2].images).toHaveLength(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v2/facet_items?');
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(url.searchParams.get('min_price')).toBe('100');
    expect(url.searchParams.get('max_price')).toBe('500');
    expect(url.searchParams.get('condition[]')).toBe('17');
    expect(url.searchParams.get('category[]')).toBe('110030');
    expect(url.searchParams.get('sort')).toBe('price_asc');
    expect(url.searchParams.getAll('state[]')).toEqual(['available']);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([['relevance', 'relevancy_desc'], ['newest', 'newest'], ['price_high_to_low', 'price_desc']] as const)('maps %s to its storefront sort', async (sort, wire) => {
    fetchMock.mockResolvedValue(response(page([])));
    await mp.search({ query: 'bat', sort, condition: 'new', showSold: true });
    const url = fetchMock.mock.calls[0][0];
    expect(url.searchParams.get('sort')).toBe(wire);
    expect(url.searchParams.get('condition[]')).toBe('31');
    expect(url.searchParams.getAll('state[]')).toEqual(['available', 'sold']);
  });
  it('treats a valid empty response as zero results, without an invented count', async () => {
    fetchMock.mockResolvedValue(response(page([])));
    expect(await mp.search({ query: 'no-such-product' })).toMatchObject({ success: true, listings: [], totalFound: 0 });
  });
  it('starts at the requested offset, deduplicates pages, and fills the requested limit', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...sample(), id: 1000 + i }));
    fetchMock.mockResolvedValueOnce(response(page(rows, 2, true))).mockResolvedValueOnce(response(page([{ ...sample(), id: 1049 }, { ...sample(), id: 1050 }, { ...sample(), id: 1051 }], 3)));
    const result = await mp.search({ query: 'catcher gear', offset: 99, limit: 2 });
    expect(result.listings.map(l => l.id)).toEqual(['1049', '1050']);
    expect(fetchMock.mock.calls.map(c => c[0].searchParams.get('page'))).toEqual(['2', '3']);
  });
  it('caps requests and explicitly reports incomplete coverage', async () => {
    for (let i = 1; i <= 10; i++) fetchMock.mockResolvedValueOnce(response(page([{ ...sample(), id: 1000 + i }], i, true)));
    const result = await mp.search({ query: 'bat', limit: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(result.listings).toHaveLength(10);
    expect(result.note).toContain('10-page');
  });
  it('reports a subsequent-page HTTP failure while preserving inspected rows', async () => {
    fetchMock.mockResolvedValueOnce(response(page([sample()], 1, true))).mockResolvedValueOnce(new Response('', { status: 429 }));
    const result = await mp.search({ query: 'mask', limit: 3 });
    expect(result.listings).toHaveLength(1);
    expect(result.note).toContain('Incomplete SidelineSwap search');
    expect(result.note).toContain('429');
  });
  it('enforces a shared overall deadline and reports partial coverage on abort', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms =>
      ms === 45_000 ? deadline.signal : new AbortController().signal);
    try {
      fetchMock.mockResolvedValueOnce(response(page([sample()], 1, true)))
        .mockImplementationOnce((_url, options) => {
          deadline.abort(new DOMException('Search deadline exceeded', 'TimeoutError'));
          expect(options.signal.aborted).toBe(true);
          return Promise.reject(options.signal.reason);
        });
      const result = await mp.search({ query: 'mask', limit: 3 });
      expect(timeout).toHaveBeenCalledWith(45_000);
      expect(result.listings).toHaveLength(1);
      expect(result.note).toContain('Incomplete SidelineSwap search');
      expect(result.note).toContain('Search deadline exceeded');
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { timeout.mockRestore(); }
  });
  it('detects a repeated page rather than looping or claiming completeness', async () => {
    fetchMock.mockResolvedValueOnce(response(page([sample()], 1, true))).mockResolvedValueOnce(response(page([sample()], 2, true)));
    const result = await mp.search({ query: 'mask', limit: 3 });
    expect(result.note).toContain('repeated a page');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { data: 'changed' }, { data: [], meta: { paging: { page: 1, page_size: 20, has_next_page: false } } }, page([], 2), page([], 1, true), page([{}])])('rejects changed response shape or inconsistent pagination', async (payload) => {
    fetchMock.mockResolvedValue(response(payload));
    expect(await mp.search({ query: 'bat' })).toMatchObject({ success: false, listings: [] });
  });
  it.each([403, 404, 500])('reports HTTP %s failures', async status => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    expect((await mp.search({ query: 'mask' })).error).toContain(`HTTP ${status}`);
  });
  it('reports invalid JSON and network failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>blocked</html>')).mockRejectedValueOnce(new Error('network unavailable'));
    expect((await mp.search({ query: 'mask' })).success).toBe(false);
    expect((await mp.search({ query: 'mask' })).error).toContain('network unavailable');
  });
  it('skips malformed rows, unavailable items, wrong conditions, and unknown/out-of-bound prices', async () => {
    const rows = [null, {}, { ...sample(), state: 'sold' }, { ...sample(), id: 2, price: null }, { ...sample(), id: 3, price: 99 }, { ...sample(), id: 4, price: 501 }, { ...sample(), id: 5, condition_detail: { slug: 'new' } }, sample()];
    fetchMock.mockResolvedValue(response(page(rows)));
    const result = await mp.search({ query: 'mask', condition: 'used', minPrice: 100, maxPrice: 500 });
    expect(result.listings).toHaveLength(1);
    expect(result.note).toContain('7 malformed or nonmatching');
  });
  it('does not fabricate prices, sellers, conditions or photos for sparse valid items', async () => {
    fetchMock.mockResolvedValue(response(page([{ id: 12, name: 'Catcher chest protector', state: 'available' }])));
    const result = await mp.search({ query: 'catcher' });
    expect(result.listings[0]).toMatchObject({ id: '12', title: 'Catcher chest protector', price: 'Price not listed', url: 'https://sidelineswap.com/gear/12', images: [] });
    expect(result.listings[0].currency).toBeUndefined();
  });
  it('allows sold listings only when requested and omits a truncated count', async () => {
    const payload = page([{ ...sample(), state: 'sold' }, { ...sample(), id: 2, state: 'removed' }]);
    payload.meta.paging.total_count_truncated = true;
    fetchMock.mockResolvedValue(response(payload));
    const result = await mp.search({ query: 'mask', showSold: true, condition: 'any' });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].title).toContain('[Sold]');
    expect(result.totalFound).toBeUndefined();
    expect(result.note).toContain('truncated');
  });
  it.each([
    { limit: -1 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }, { offset: 5001 }, { offset: 1.5 },
    { minPrice: -1 }, { maxPrice: Infinity }, { minPrice: 200, maxPrice: 100 },
    { condition: 'good' }, { sort: 'most_popular' }, { category: 'goalie masks' },
    { brand: 'Bauer' }, { sizes: ['Medium'] }, { colors: ['white'] }, { department: 'Men' },
  ] as Partial<SearchParams>[])('rejects unsupported filters or invalid bounds before any request', async params => {
    expect((await mp.search({ query: 'mask', ...params })).success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not request inventory for zero limit', async () => {
    expect(await mp.search({ query: 'mask', limit: 0 })).toMatchObject({ success: true, listings: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('SidelineSwap details', () => {
  it('reads actual availability, attributes, description and photos from a sold-listing fixture', async () => {
    fetchMock.mockResolvedValue(response(fixture('details')));
    const result = await mp.getListingDetails('12549997');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.sidelineswap.com/v1/items/12549997');
    expect(result.images).toHaveLength(3);
    expect(result.description).toContain('Availability: sold');
    expect(result.description).toContain(`Current asking price: USD ${Number(fixture('details').data.price).toFixed(2)}`);
    expect(result.description).toContain('Size: Medium');
    expect(result.description).toContain('Age Group: Senior');
    expect(result.description).toContain('Model: Bauer 950 Goalie Mask');
    expect(result.description).toContain(fixture('details').data.description);
    expect(result.unavailable).toBeUndefined();
    expect(result.isShippingOffered).toBeUndefined();
    expect(result.description).not.toContain('2016');
  });
  it.each(['https://sidelineswap.com/gear/hockey/goalie/goalie-masks/12549997-bauer-mask', 'https://sidelineswap.com/gear/12549997/'])('accepts canonical URLs %s', async url => {
    fetchMock.mockResolvedValue(response(fixture('details')));
    expect((await mp.getListingDetails(url)).id).toBe('12549997');
  });
  it.each(['https://evil.test/gear/12549997', 'https://sidelineswap.com.evil.test/gear/12549997', 'http://sidelineswap.com/gear/12549997', '../secret', 'abc', '0', 'https://sidelineswap.com/shop/hockey/l30'])('rejects wrong IDs/hosts without making a request', async input => {
    await expect(mp.getListingDetails(input)).rejects.toThrow('numeric ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{}, { data: null }, { data: { id: 99, name: 'Wrong item' } }, { data: { id: 12549997 } }])('rejects absent or mismatched listings', async payload => {
    fetchMock.mockResolvedValue(response(payload));
    await expect(mp.getListingDetails('12549997')).rejects.toThrow('unexpected response');
  });
  it('marks missing seller description/photos and keeps known attributes', async () => {
    fetchMock.mockResolvedValue(response({ data: { id: 12, name: 'Bat', state: 'available', details: [{ name: 'Length', values: [{ name: '32 inches' }] }, { name: 'Missing', values: [{}] }, null], model: { name: 'CAT9' } } }));
    const result = await mp.getListingDetails('12');
    expect(result.unavailable).toEqual(['description', 'photos']);
    expect(result.description).toBe('Current asking price: not listed\nAvailability: available\nLength: 32 inches\nModel: CAT9');
  });
  it('sanitizes malformed photo URLs and deduplicates the primary image', async () => {
    fetchMock.mockResolvedValue(response({ data: { id: 12, name: 'Bat', price: '99.5', url: 'javascript:bad', images: [null, {}, { large_url: 'javascript:bad' }, { edge_url: 'https://images.sidelineswap.com/a' }, { small_url: 'https://images.sidelineswap.com/b' }, { thumb_url: 'https://images.sidelineswap.com/c' }, { large_url: 'invalid' }], primary_image: { large_url: 'https://images.sidelineswap.com/a' } } }));
    const result = await mp.getListingDetails('12');
    expect(result.images).toEqual(['https://images.sidelineswap.com/a', 'https://images.sidelineswap.com/b', 'https://images.sidelineswap.com/c']);
    expect(result.description).toBe('Current asking price: USD 99.50 (shipping, fees and tax excluded)');
    expect(result.url).toBe('https://sidelineswap.com/gear/12');
  });
  it('propagates removal/block errors instead of returning fictional details', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(mp.getListingDetails('12')).rejects.toThrow('HTTP 404');
  });
  it('rechecks the current asking price when a listing changes after search', async () => {
    fetchMock.mockResolvedValueOnce(response(page([sample()])));
    const result = await mp.search({ query: 'mask' });
    const before = result.listings[0].priceNumeric!;
    fetchMock.mockResolvedValueOnce(response({ data: { ...sample(), price: before + 50 } }));
    const details = await mp.getListingDetails(result.listings[0].id);
    expect(details.description).toContain(`USD ${(before + 50).toFixed(2)}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('SidelineSwap healthCheck', () => {
  it('probes live search through the same parser', async () => {
    fetchMock.mockResolvedValue(response(page([])));
    expect(await mp.healthCheck()).toBe(true);
  });
  it('returns false when the API is blocked', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));
    expect(await mp.healthCheck()).toBe(false);
  });
});
