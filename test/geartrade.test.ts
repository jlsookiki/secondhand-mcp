import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeartradeMarketplace, resultWindow } from '../src/marketplaces/geartrade/index.js';
import { cardListing, conditionOf, listingRefFrom, productListings, searchPage } from '../src/marketplaces/geartrade/parse.js';
import { searchUrl } from '../src/marketplaces/geartrade/query.js';
import type { Product } from '../src/marketplaces/geartrade/wire.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/geartrade/${name}`, import.meta.url), 'utf8');
const searchHtml = fixture('search.html');
const skis = (): Product => JSON.parse(fixture('product.json'));
const jacket = (): Product => JSON.parse(fixture('product-variants.json'));

const SKIS = 'faction-dancer-2-skis-blue-w-strive-11-gw-binding-2026-18-1676979';
const JACKET = 'dynafit-tigard-polartec-hooded-jacket-mens-1045872';

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const lastPage = searchHtml.replace(/<a class="pagination__arrow[^>]*><\/a>/, '');

let fetchMock: ReturnType<typeof vi.fn>;
let geartrade: GeartradeMarketplace;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  geartrade = new GeartradeMarketplace();
});

/** Answers every request with a fresh Response: search pages from `pages`, product data from the fixtures. */
function serve(pages: (page: number) => Response) {
  fetchMock.mockImplementation((url: URL) => {
    if (url.pathname === '/search') return Promise.resolve(pages(Number(url.searchParams.get('page'))));
    if (url.pathname.startsWith(`/products/${JACKET}`)) return Promise.resolve(json(jacket()));
    if (url.pathname === `/products/${SKIS}.js`) return Promise.resolve(json(skis()));
    return Promise.resolve(json({}, 404));
  });
}

/** Three pages, each with its own single-variant skis and multi-variant jacket. */
const distinctPages = (page: number) => {
  const markup = page < 3 ? searchHtml : lastPage;
  return html(markup.replaceAll(SKIS, `${SKIS}-${page}`).replaceAll(JACKET, `${JACKET}-${page}`));
};

const requested = () => fetchMock.mock.calls.map(([url]) => {
  const { pathname, searchParams } = url as URL;
  return pathname === '/search' ? `search page ${searchParams.get('page')}` : pathname;
});

describe('searchUrl', () => {
  it('maps supported filters onto storefront parameters', () => {
    const url = searchUrl(
      { query: 'skis', minPrice: 100, maxPrice: 500, brand: 'Faction', category: 'Alpine Skis w/ Bindings', sizes: ['182cm'], condition: 'good', sort: 'price_low_to_high' },
      2
    );
    expect(url.origin + url.pathname).toBe('https://geartrade.com/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'skis', type: 'product', sort_by: 'price-ascending', page: '2',
      'filter.v.price.gte': '100', 'filter.v.price.lte': '500',
      'filter.p.m.global.Brand': 'Faction', 'filter.p.product_type': 'Alpine Skis w/ Bindings',
      'filter.v.option.size': '182cm', 'filter.v.m.global.Condition': 'Good',
    });
  });

  it('asks for every used grade when the condition is used', () => {
    expect(searchUrl({ query: 'skis', condition: 'used' }, 1).searchParams.getAll('filter.v.m.global.Condition')).toEqual(['Excellent', 'Good', 'Fair']);
  });

  it('ignores filters Geartrade cannot apply', () => {
    const url = searchUrl({ query: 'skis', condition: 'like_new', sort: 'newest', department: 'Women', colors: ['red'], location: 'Denver, CO' }, 1);
    expect([...url.searchParams.keys()].sort()).toEqual(['page', 'q', 'sort_by', 'type']);
    expect(url.searchParams.get('sort_by')).toBe('relevance');
  });
});

describe('resultWindow', () => {
  it.each([
    [{}, { start: 0, end: 20 }],
    [{ offset: 10, limit: 10 }, { start: 10, end: 20 }],
    [{ offset: 40, limit: 20 }, { start: 40, end: 48 }],
    [{ offset: 60, limit: 5 }, { start: 60, end: 48 }],
    [{ offset: -3, limit: 5 }, { start: 0, end: 5 }],
  ])('maps %o to listing positions %o', (params, window) => {
    expect(resultWindow(params)).toEqual(window);
  });
});

describe('listingRefFrom', () => {
  it.each([
    [SKIS, { handle: SKIS, variantId: undefined }],
    [`${SKIS}:54029224509745`, { handle: SKIS, variantId: '54029224509745' }],
  ])('reads %s', (input, ref) => {
    expect(listingRefFrom(input)).toEqual(ref);
  });

  it.each(['https://geartrade.com/products/skis', '../secret', 'skis/../x', 'Skis', 'skis:0', 'skis:', '-skis', 'skis:12:34'])('rejects %s', (input) => {
    expect(listingRefFrom(input)).toBeUndefined();
  });
});

describe('searchPage', () => {
  it('joins each card with its variants from the page analytics object', () => {
    const { cards, hasNextPage } = searchPage(searchHtml);
    expect(hasNextPage).toBe(true);
    expect(cards.map((card) => [card.handle, card.variants.length])).toEqual([[SKIS, 1], [JACKET, 3]]);
    expect(cards[1].title).toBe("Dynafit Dynafit Tigard Polartec Hooded Jacket - Men's");
    expect(cards[0].image).toMatch(/^https:\/\/geartrade\.com\/cdn\/shop\/files\/36413b6f/);
  });

  it('skips a card the analytics object does not list', () => {
    const page = searchHtml.replace(`"handle":"${JACKET}"`, '"handle":"other"');
    expect(searchPage(page).cards.map((card) => card.handle)).toEqual([SKIS]);
  });

  it('reads an empty results page', () => {
    const empty = '<div data-page-type="search" data-currency="USD"></div>\n  var meta = {"page":{}};\n';
    expect(searchPage(empty)).toEqual({ cards: [], hasNextPage: false });
  });

  it.each([
    ['a page that is not a search page', '<html>Access denied</html>', 'unexpected search page'],
    ['prices in another currency', searchHtml.replace('data-currency="USD"', 'data-currency="CAD"'), 'prices in CAD'],
    ['a page without product data', searchHtml.replace('var meta =', 'var other ='), 'missing its product data'],
  ])('rejects %s', (_label, page, message) => {
    expect(() => searchPage(page)).toThrow(message);
  });
});

describe('cardListing', () => {
  it('turns a single-variant card into a USD listing', () => {
    const [card] = searchPage(searchHtml).cards;
    expect(cardListing(card, 'Good')).toMatchObject({
      id: `${SKIS}:54029224509745`,
      title: 'Faction Dancer 2 Skis (Blue) w/ Strive 11 GW Binding 2026 - 182cm',
      price: '$646.14', priceNumeric: 646.14, currency: 'USD', condition: 'Good',
      url: `https://geartrade.com/products/${SKIS}?variant=54029224509745`,
    });
  });

  it('skips a card whose variant has no usable id or price', () => {
    const [card] = searchPage(searchHtml).cards;
    expect(cardListing({ ...card, variants: [{ id: 1, price: 12.5 }] }, undefined)).toBeUndefined();
    expect(cardListing({ ...card, variants: [{ price: 100 }] }, undefined)).toBeUndefined();
  });
});

describe('productListings', () => {
  it('lists only available variants, with the variant in the title', () => {
    const listings = productListings(jacket(), JACKET, { query: 'jacket' });
    expect(listings.map((l) => [l.title, l.price])).toEqual([
      ["Dynafit Dynafit Tigard Polartec Hooded Jacket - Men's (S / Blueberry Burgundy)", '$66.57'],
      ["Dynafit Dynafit Tigard Polartec Hooded Jacket - Men's (XS / Olive Night)", '$66.57'],
    ]);
    expect(listings[0]).toMatchObject({ id: `${JACKET}:51396454285617`, condition: 'New', images: [expect.stringMatching(/^https:\/\/cdn\.shopify\.com\//)] });
  });

  it('keeps only the variants inside the requested sizes and price range', () => {
    expect(productListings(jacket(), JACKET, { query: 'jacket', sizes: ['xs'] }).map((l) => l.id)).toEqual([`${JACKET}:51396455432497`]);
    expect(productListings(jacket(), JACKET, { query: 'jacket', maxPrice: 60 })).toEqual([]);
  });

  it('lists nothing for a product that is no longer available', () => {
    expect(productListings({ ...jacket(), available: false }, JACKET, { query: 'jacket' })).toEqual([]);
  });
});

describe('conditionOf', () => {
  it('reads the grade from the condition sentence', () => {
    expect(conditionOf(skis())).toBe('New');
    expect(conditionOf({ description: '<p>This jacket is in Good condition.</p>' })).toBe('Good');
    expect(conditionOf({ description: '<p>Great in all conditions.</p>' })).toBeUndefined();
  });
});

describe('Geartrade search', () => {
  it('needs product data only for the multi-variant card', async () => {
    serve(() => html(lastPage));
    const result = await geartrade.search({ query: 'skis' });

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    expect(result.listings.map((l) => l.id)).toEqual([`${SKIS}:54029224509745`, `${JACKET}:51396454285617`, `${JACKET}:51396455432497`]);
    expect(requested()).toEqual(['search page 1', `/products/${JACKET}.js`]);
  });

  it('stops requesting product data once the limit is filled', async () => {
    serve(() => html(lastPage));
    const result = await geartrade.search({ query: 'skis', limit: 1 });
    expect(result.listings).toHaveLength(1);
    expect(requested()).toEqual(['search page 1']);
  });

  it('trusts the storefront condition filter rather than rechecking descriptions', async () => {
    serve(() => html(lastPage));
    const result = await geartrade.search({ query: 'skis', condition: 'good' });
    expect(result.listings.map((l) => l.condition)).toEqual(['Good', 'New', 'New']);
  });

  it('leaves a single-variant condition blank when several grades were asked for', async () => {
    serve(() => html(lastPage));
    const result = await geartrade.search({ query: 'skis', condition: 'used', limit: 1 });
    expect(result.listings[0].condition).toBeUndefined();
  });

  it('succeeds with filters it cannot apply', async () => {
    serve(() => html(lastPage));
    const result = await geartrade.search({ query: 'skis', colors: ['red'], department: 'Women', sort: 'most_popular', condition: 'like_new' });
    expect(result.success).toBe(true);
    expect(result.listings).toHaveLength(3);
  });

  it.each([1, 2, 3, 4])('pages by listings, so limit %i then the same offset equals twice the limit', async (n) => {
    serve(distinctPages);
    const first = await geartrade.search({ query: 'skis', limit: n });
    const next = await geartrade.search({ query: 'skis', offset: n, limit: n });
    const both = await geartrade.search({ query: 'skis', limit: 2 * n });

    const paged = [...first.listings, ...next.listings].map((l) => l.id);
    expect(paged).toEqual(both.listings.map((l) => l.id));
    expect(new Set(paged).size).toBe(2 * n);
  });

  it('returns nothing past the pages it reads', async () => {
    serve(distinctPages);
    const result = await geartrade.search({ query: 'skis', offset: 500, limit: 5 });
    expect(result).toMatchObject({ success: true, listings: [] });
    expect(requested()).toEqual([]);
  });

  it('requests at most three search pages', async () => {
    serve((page) => html(searchHtml.replaceAll(SKIS, `${SKIS}-${page}`)));
    const result = await geartrade.search({ query: 'skis', limit: 500 });
    expect(requested().filter((r) => r.startsWith('search'))).toEqual(['search page 1', 'search page 2', 'search page 3']);
    expect(result.listings.map((l) => l.id.split(':')[0])).toEqual([`${SKIS}-1`, JACKET, JACKET, `${SKIS}-2`, `${SKIS}-3`]);
  });

  it('stops when a page brings nothing new', async () => {
    serve(() => html(searchHtml));
    const result = await geartrade.search({ query: 'skis' });
    expect(requested()).toEqual(['search page 1', `/products/${JACKET}.js`, 'search page 2']);
    expect(result.listings).toHaveLength(3);
  });

  it('keeps earlier results when a later page fails', async () => {
    serve((page) => (page === 1 ? html(searchHtml) : html('', 429)));
    const result = await geartrade.search({ query: 'skis' });
    expect(result).toMatchObject({ success: true, note: 'Later results failed: Error: Geartrade returned 429' });
    expect(result.listings).toHaveLength(3);
  });

  it.each([
    ['an HTTP error', () => html('', 403), 'Geartrade returned 403'],
    ['a block page', () => html('<html>Access denied</html>'), 'unexpected search page'],
  ])('reports %s', async (_label, reply, message) => {
    serve(reply);
    const result = await geartrade.search({ query: 'skis' });
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
  });
});

describe('Geartrade details', () => {
  it('lists condition, the variant price and status, and the description in one request', async () => {
    serve(() => html(''));
    const details = await geartrade.getListingDetails(`${SKIS}:54029224509745`);

    expect(requested()).toEqual([`/products/${SKIS}.js`]);
    expect(details).toMatchObject({ id: `${SKIS}:54029224509745`, url: `https://geartrade.com/products/${SKIS}?variant=54029224509745` });
    expect(details.images).toHaveLength(2);
    expect(details.description).toMatch(/^Condition: New\n182cm \/ Blue: \$646\.14, available\n\nFaction Skis designed/);
    expect(details.unavailable).toBeUndefined();
  });

  it('lists every variant for a bare handle', async () => {
    serve(() => html(''));
    const details = await geartrade.getListingDetails(JACKET);
    expect(details.description).toContain('M / Blueberry Burgundy: $78.07, unavailable\nS / Blueberry Burgundy: $66.57, available');
    expect(details.url).toBe(`https://geartrade.com/products/${JACKET}`);
  });

  it('flags a missing description and photos', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ ...skis(), description: '', images: ['http://insecure.test/a.jpg'] })));
    const details = await geartrade.getListingDetails(SKIS);
    expect(details.unavailable).toEqual(['description', 'photos']);
    expect(details.images).toEqual([]);
  });

  it('rejects an unrecognised id without a request', async () => {
    await expect(geartrade.getListingDetails('https://evil.test/products/x')).rejects.toThrow('product handle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a variant that no longer exists', async () => {
    serve(() => html(''));
    await expect(geartrade.getListingDetails(`${SKIS}:999`)).rejects.toThrow('no longer exists');
  });

  it('treats a reply for another product as not found', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(jacket())));
    await expect(geartrade.getListingDetails(SKIS)).rejects.toThrow('not found');
  });

  it('passes on HTTP errors', async () => {
    serve(() => html(''));
    await expect(geartrade.getListingDetails('missing-item')).rejects.toThrow('Geartrade returned 404');
  });
});
