import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeartradeMarketplace } from '../src/marketplaces/geartrade.js';
import { registerMarketplace } from '../src/marketplaces/index.js';
import { searchMarketplace } from '../src/tools/search-marketplace.js';
import { listingDetails } from '../src/tools/listing-details.js';
import { researchFetch } from '../src/tools/deep-research.js';

const html = readFileSync(new URL('./fixtures/geartrade/search.html', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/geartrade/product.json', import.meta.url), 'utf8'));
const handle = fixture.handle;
const empty = '<title>Search: 0 results found for &quot;absent&quot;</title><div data-page-type="search" data-currency="USD"></div>';
let fetchMock: ReturnType<typeof vi.fn>;
let mp: GeartradeMarketplace;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => new Response(url.includes('.js') ? JSON.stringify(fixture) : html));
  vi.stubGlobal('fetch', fetchMock);
  mp = new GeartradeMarketplace();
});
afterEach(() => vi.unstubAllGlobals());

describe('Geartrade search', () => {
  it('parses a captured full search result and cents, not predictive suggestions or hidden prices', async () => {
    const result = await mp.search({ query: 'skis', limit: 1 });
    expect(result.success).toBe(true);
    expect(result.listings[0]).toMatchObject({
      id: `${handle}:54029224509745`, price: 'USD 646.14', priceNumeric: 646.14,
      currency: 'USD', condition: 'New', marketplace: 'geartrade',
      url: `https://geartrade.com/products/${handle}?variant=54029224509745`,
    });
    expect(result.listings[0].description).toContain('In stock');
    expect(result.listings[0].images.every(u => u.startsWith('https://'))).toBe(true);
    expect(result.note).toContain('more storefront results may remain');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/search?');
    expect(fetchMock.mock.calls[0][0]).not.toContain('suggest');
  });

  it('sends native filters and rechecks requested-size stock and price on each variant', async () => {
    const product = structuredClone(fixture);
    product.description = '<p>These skis are in Good condition.</p>';
    product.variants = [
      { ...product.variants[0], id: 1, options: ['M', 'Blue'], title: 'M / Blue', price: 19999, available: false },
      { ...product.variants[0], id: 2, options: ['L', 'Blue'], title: 'L / Blue', price: 10000 },
      { ...product.variants[0], id: 3, options: ['M', 'Blue'], title: 'M / Blue', price: 20001 },
      { ...product.variants[0], id: 4, options: ['M', 'Blue'], title: 'M / Blue', price: 19999 },
    ];
    fetchMock.mockImplementation(async (url: string) => new Response(url.includes('.js') ? JSON.stringify(product) : html));
    const result = await mp.search({ query: 'skis & boots', limit: 1, minPrice: 100, maxPrice: 200,
      brand: 'Faction', sizes: ['M'], category: 'Alpine Skis w/ Bindings', condition: 'used', sort: 'price_low_to_high' });
    expect(result.listings.map(l => l.id)).toEqual([`${handle}:4`]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe('skis & boots');
    expect(url.searchParams.get('filter.v.price.gte')).toBe('100');
    expect(url.searchParams.get('filter.v.price.lte')).toBe('200');
    expect(url.searchParams.get('filter.p.m.global.Brand')).toBe('Faction');
    expect(url.searchParams.getAll('filter.v.option.size')).toEqual(['M']);
    expect(url.searchParams.getAll('filter.v.m.global.Condition')).toEqual(['Good', 'Excellent', 'Fair']);
    expect(url.searchParams.get('sort_by')).toBe('price-ascending');
  });

  it('never infers condition when the listing omits its explicit condition statement', async () => {
    const product = { ...fixture, description: '<p>Excellent powder conditions for these New skis!</p>' };
    fetchMock.mockImplementation(async (url: string) => new Response(url.includes('.js') ? JSON.stringify(product) : html.replace(/<a class="pagination__arrow[^>]+>/, '')));
    const result = await mp.search({ query: 'skis', condition: 'new' });
    expect(result.success).toBe(true);
    expect(result.listings).toEqual([]);
  });

  it('excludes unavailable products and exposes stock explicitly when showSold is true', async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(url.includes('.js') ? JSON.stringify({ ...fixture, available: false }) : html));
    expect((await mp.search({ query: 'skis' })).listings).toEqual([]);
    const result = await mp.search({ query: 'skis', showSold: true, limit: 1 });
    expect(result.listings[0].description).toContain('Unavailable');
    expect(result.note).toContain('unavailable does not establish a completed sale');
  });

  it('paginates, deduplicates products, applies result offset and reports the last page', async () => {
    const secondHandle = 'another-ski';
    const second = html.replaceAll(handle, secondHandle).replace(/<a class="pagination__arrow[^>]+>/, '');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/${secondHandle}.js`)) return new Response(JSON.stringify({ ...fixture, handle: secondHandle }));
      if (url.includes('.js')) return new Response(JSON.stringify(fixture));
      return new Response(new URL(url).searchParams.get('page') === '1' ? html : second);
    });
    const result = await mp.search({ query: 'skis', offset: 1, limit: 1 });
    expect(result.listings[0].id).toBe(`${secondHandle}:54029224509745`);
    expect(result.note).toContain('2 search page(s), 2 product(s)');
    expect(result.note).toContain('more storefront results may remain');
  });

  it('stops after three pages without claiming an exhaustive inventory', async () => {
    const result = await mp.search({ query: 'skis', limit: 50 });
    expect(result.listings).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(c => c[0].includes('/search?'))).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(c => c[0].includes('.js'))).toHaveLength(1);
    expect(result.note).toContain('more storefront results may remain');
    expect(result.totalFound).toBeUndefined();
  });

  it('recognizes an actual empty result', async () => {
    fetchMock.mockResolvedValue(new Response(empty));
    expect(await mp.search({ query: 'absent' })).toMatchObject({ success: true, listings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ query: 'x', colors: ['blue'] }, 'colors'], [{ query: 'x', department: 'Men' }, 'department'],
    [{ query: 'x', sort: 'newest' as const }, 'sort'], [{ query: 'x', condition: 'like_new' as const }, 'condition'],
    [{ query: 'x', limit: 51 }, 'limit'], [{ query: 'x', offset: -1 }, 'offset'], [{ query: 'x', offset: 48 }, 'offset'],
    [{ query: 'x', minPrice: 20, maxPrice: 10 }, 'minPrice'], [{ query: '' }, 'query'],
  ])('rejects unsupported/invalid arguments without a request: %j', async (params, error) => {
    expect(await mp.search(params)).toMatchObject({ success: false, listings: [], error: expect.stringContaining(error) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['<html>access denied</html>', 'missing'],
    ['<div data-page-type="search" data-currency="USD"><product-card>changed</product-card></div>', 'markup changed'],
    ['<div data-page-type="search" data-currency="USD">no cards</div>', 'no parsable'],
  ])('reports parser/access failures instead of successful empty results', async (body, error) => {
    fetchMock.mockResolvedValue(new Response(body));
    expect(await mp.search({ query: 'skis' })).toMatchObject({ success: false, listings: [], error: expect.stringContaining(error) });
  });

  it('reports HTTP and malformed JSON failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    expect((await mp.search({ query: 'skis' })).error).toContain('HTTP 429');
    fetchMock.mockResolvedValueOnce(new Response(html)).mockResolvedValueOnce(new Response('{}'));
    expect((await mp.search({ query: 'skis' })).error).toContain('product data changed');
  });

  it('rejects currency changes rather than labeling foreign amounts as USD', async () => {
    fetchMock.mockResolvedValueOnce(new Response(html.replace('data-currency="USD"', 'data-currency="CAD"')));
    expect((await mp.search({ query: 'skis' })).error).toContain('not USD');
  });

  it('rechecks exact category and brand when the storefront returns an unrelated product', async () => {
    expect((await mp.search({ query: 'skis', brand: 'Other Brand' })).listings).toEqual([]);
    expect((await mp.search({ query: 'skis', category: 'Other Product Type' })).listings).toEqual([]);
  });

  it('sorts across products and variants before taking the limit', async () => {
    const card = html.match(/<product-card\b[\s\S]*?<\/product-card>/)![0];
    const page = `<div data-page-type="search" data-currency="USD">${card}${card.replaceAll(handle, 'second-product')}</div>`;
    const first = structuredClone(fixture);
    first.variants = [{ ...first.variants[0], id: 1, price: 1000 }, { ...first.variants[0], id: 2, price: 100000 }];
    const second = { ...fixture, handle: 'second-product', variants: [{ ...fixture.variants[0], id: 3, price: 2000 }] };
    fetchMock.mockImplementation(async (url: string) => new Response(url.includes('.js')
      ? JSON.stringify(url.includes('second-product') ? second : first) : page));
    const low = await mp.search({ query: 'skis', sort: 'price_low_to_high', limit: 2 });
    expect(low.success).toBe(true);
    expect(low.listings.map(l => l.priceNumeric)).toEqual([10, 20]);
    const high = await mp.search({ query: 'skis', sort: 'price_high_to_low', limit: 1 });
    expect(high.listings.map(l => l.priceNumeric)).toEqual([1000]);
    expect(low.listings[0].title).toContain(first.variants[0].title);
  });

  it('allows limit zero without any request', async () => {
    expect(await mp.search({ query: 'skis', limit: 0 })).toMatchObject({ success: true, listings: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Geartrade details and health', () => {
  it('fetches exact variant, full photos, source description, price and stock', async () => {
    const details = await mp.getListingDetails(`${handle}:54029224509745`);
    expect(details.description).toContain('USD 646.14; In stock');
    expect(details.description).toContain('PRODUCT CONDITION');
    expect(details.images).toHaveLength(fixture.images.length);
    expect(details.isShippingOffered).toBeUndefined();
    expect(details.description).toContain('Requires shipping: yes');
    expect(details.seller).toBeUndefined(); // Shopify vendor is not the individual seller.
    expect(details.unavailable).toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('.js'), expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/json' }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/products/'), expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'text/html' }),
    }));
  });

  it('permits a handle without variant to inspect all source variants', async () => {
    expect((await mp.getListingDetails(handle)).url).toBe(`https://geartrade.com/products/${handle}`);
  });

  it.each(['https://example.com/a', '../admin', 'ski?x=1', 'ski:abc'])('rejects unsafe IDs %s without fetching', async id => {
    await expect(mp.getListingDetails(id)).rejects.toThrow('listingId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports removed products and variants', async () => {
    await expect(mp.getListingDetails(`${handle}:123`)).rejects.toThrow('no longer exists');
    fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    await expect(mp.getListingDetails(handle)).rejects.toThrow('HTTP 404');
  });

  it('marks missing photos while retaining the remaining source data', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...fixture, images: [] })));
    expect((await mp.getListingDetails(handle)).unavailable).toEqual(['photos']);
  });

  it('marks missing source description while retaining price and stock', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...fixture, description: '' })));
    const details = await mp.getListingDetails(handle);
    expect(details.unavailable).toEqual(['description']);
    expect(details.description).toContain('646.14');
  });

  it('verifies detail-page currency instead of assuming the product JSON amounts are USD', async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(url.includes('.js')
      ? JSON.stringify(fixture) : '<div data-currency="CAD"></div>'));
    await expect(mp.getListingDetails(handle)).rejects.toThrow('not USD');
  });

  it('checks real storefront markup and returns false for inaccessible pages', async () => {
    expect(await mp.healthCheck()).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response('blocked', { status: 403 }));
    expect(await mp.healthCheck()).toBe(false);
  });
});

describe('Geartrade MCP routing', () => {
  beforeEach(() => registerMarketplace(mp));

  it('searches with normal MCP arguments, including default location, and displays coverage', async () => {
    const result = await searchMarketplace({ marketplace: 'geartrade', query: 'skis', limit: '1' });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('646.14') });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Bounded to 3 pages') });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Location and radius are not applied') });
  });

  it('routes variant details and deep-research fetch IDs without losing their variant', async () => {
    const id = `${handle}:54029224509745`;
    const details = await listingDetails({ marketplace: 'geartrade', listingId: id, maxImages: 0 });
    expect(details.content[0]).toMatchObject({ text: expect.stringContaining('646.14; In stock') });
    const fetched = await researchFetch({ id: `geartrade:${id}` });
    expect(fetched.content[0]).toMatchObject({ text: expect.stringContaining('?variant=54029224509745') });
  });
});
