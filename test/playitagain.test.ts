import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayItAgainMarketplace, clampCount, totalFound } from '../src/marketplaces/playitagain/index.js';
import { currencyOf, descriptiveFieldLines, pageData, productJsonLd, productPath, resultCount, summaryListing } from '../src/marketplaces/playitagain/parse.js';
import { matchesFilters, searchUrl } from '../src/marketplaces/playitagain/query.js';
import { registerMarketplace } from '../src/marketplaces/index.js';
import { researchFetch } from '../src/tools/deep-research.js';
import type { Product, SearchPage } from '../src/marketplaces/playitagain/wire.js';
import type { Listing } from '../src/types.js';

type FixtureName = 'search' | 'product' | 'variant-product' | 'canadian-product';

function fixture(name: FixtureName): string {
  return readFileSync(new URL(`./fixtures/playitagain/${name}.html`, import.meta.url), 'utf8');
}

const products = (): Product[] => pageData<SearchPage>(fixture('search'))!.searchProducts!;
const catcher = (): Product => products()[0];
const canadianMask = (): Product => products()[1];

const CATCHER_PATH = '/locations/leominster-ma/product/S000152950/Bauer-SUPREME-Jr';
const CATCHER_NAME = 'Used Bauer SUPREME Junior Goalie Catcher Black 11722-S000152950';
const MASK_PATH = '/locations/whitby-on/product/CCM-AXIS-F5-GOALIE-MASK/GHH-CCM-AXIS-F5-GOALIE-MASK-SR-WHT';

function productAt(n: number): Product {
  return { ...catcher(), id: n, url: `/locations/boston-ma/product/S${n}/Bat` };
}

function searchPage(rows: unknown[], perPage = 12, total = rows.length): string {
  const data = { template: 'pages/search', searchProducts: rows, searchProductsPerPage: perPage, searchResultsCount: `${total} results for 'x'` };
  return `<script>window.stencilBootstrap("search", ${JSON.stringify(JSON.stringify(data))});</script>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let playitagain: PlayItAgainMarketplace;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  playitagain = new PlayItAgainMarketplace();
});

const requestedPages = () => fetchMock.mock.calls.map(([url]) => (url as URL).searchParams.get('page'));

describe('searchUrl', () => {
  it('maps the query, page and sort onto the storefront search', () => {
    const url = searchUrl({ query: 'goalie mask', sort: 'price_low_to_high' }, 3);
    expect(url.origin + url.pathname).toBe('https://playitagainsports.com/search.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search_query: 'goalie mask', section: 'product', page: '3', sort: 'priceasc',
    });
  });

  it('ignores filters the storefront cannot apply', () => {
    const url = searchUrl(
      { query: 'bat', sort: 'most_popular', department: 'Men', radius: 10, showSold: true, brand: 'Easton', sizes: ['32'], category: 'Bats' },
      1
    );
    expect([...url.searchParams.keys()].sort()).toEqual(['page', 'search_query', 'section', 'sort']);
    expect(url.searchParams.get('sort')).toBe('relevance');
  });
});

describe('matchesFilters', () => {
  const listing = (overrides: Partial<Listing>): Listing => ({
    id: '/x', title: 'Bat', price: '$30.00', url: 'https://playitagainsports.com/x', marketplace: 'playitagain', scrapedAt: '',
    priceNumeric: 30, currency: 'USD', condition: 'Used', ...overrides,
  });

  it('keeps US listings inside the price bounds', () => {
    expect(matchesFilters(listing({}), { query: 'bat', minPrice: 30, maxPrice: 30 })).toBe(true);
    expect(matchesFilters(listing({}), { query: 'bat', maxPrice: 29.99 })).toBe(false);
    expect(matchesFilters(listing({}), { query: 'bat', minPrice: 30.01 })).toBe(false);
  });

  it('leaves Canadian and unpriced listings out once a price bound is set', () => {
    expect(matchesFilters(listing({ currency: 'CAD' }), { query: 'bat', maxPrice: 100 })).toBe(false);
    expect(matchesFilters(listing({ currency: undefined, priceNumeric: undefined }), { query: 'bat', minPrice: 0 })).toBe(false);
    expect(matchesFilters(listing({ currency: 'CAD' }), { query: 'bat' })).toBe(true);
  });

  it('matches new and used against the listed condition', () => {
    expect(matchesFilters(listing({}), { query: 'bat', condition: 'used' })).toBe(true);
    expect(matchesFilters(listing({}), { query: 'bat', condition: 'new' })).toBe(false);
    expect(matchesFilters(listing({ condition: undefined }), { query: 'bat', condition: 'used' })).toBe(false);
  });

  it('ignores condition grades the storefront does not use', () => {
    expect(matchesFilters(listing({ condition: 'New' }), { query: 'bat', condition: 'like_new' })).toBe(true);
    expect(matchesFilters(listing({}), { query: 'bat', condition: 'any' })).toBe(true);
  });
});

describe('currencyOf', () => {
  it('reads the currency from the Country field', () => {
    expect(currencyOf([{ name: 'Country', value: 'US' }])?.code).toBe('USD');
    expect(currencyOf([{ name: 'Country', value: 'CA' }])?.code).toBe('CAD');
    expect(currencyOf([{ name: 'Country', value: 'MX' }])).toBeUndefined();
    expect(currencyOf(undefined)).toBeUndefined();
  });
});

describe('descriptiveFieldLines', () => {
  it('keeps descriptive fields in a fixed order and drops store bookkeeping', () => {
    const lines = descriptiveFieldLines([
      { name: 'Color', value: 'Black' },
      { name: 'Shipping', value: '48' },
      { name: 'Country', value: 'US' },
      { name: 'Discounted Price', value: 'No' },
      { name: 'Standard Shipping', value: 'Yes' },
      { name: 'Condition', value: 'Used' },
      { name: 'Product Brand', value: 'Bauer' },
    ]);
    expect(lines).toEqual(['Condition: Used', 'Product Brand: Bauer', 'Color: Black']);
  });

  it('merges repeated fields and drops empty or None values', () => {
    const lines = descriptiveFieldLines([
      { name: 'Color', value: 'White' },
      { name: 'Color', value: 'White And Black' },
      { name: 'Color', value: 'White' },
      { name: 'Product Line', value: 'None' },
      { name: 'Size', value: ' ' },
    ]);
    expect(lines).toEqual(['Color: White / White And Black']);
  });
});

describe('productPath', () => {
  it.each([
    [CATCHER_PATH, CATCHER_PATH],
    [`https://playitagainsports.com${CATCHER_PATH}?sku=1#top`, CATCHER_PATH],
  ])('reads %s', (input, path) => {
    expect(productPath(input)).toBe(path);
  });

  it.each([`https://evil.test${CATCHER_PATH}`, `http://playitagainsports.com${CATCHER_PATH}`, '3843758', '../secret', '/locations/x/product/'])(
    'rejects %s',
    (input) => {
      expect(productPath(input)).toBeUndefined();
    }
  );
});

describe('pageData', () => {
  it('returns nothing for a page without embedded data or with broken JSON', () => {
    expect(pageData('<html><title>Blocked</title></html>')).toBeUndefined();
    expect(pageData('<script>window.stencilBootstrap("search", "{not json");</script>')).toBeUndefined();
  });
});

describe('resultCount and totalFound', () => {
  it('reads the storefront count', () => {
    expect(resultCount("1,063 results for 'bat'")).toBe(1063);
    expect(resultCount("1 result for 'bat'")).toBe(1);
    expect(resultCount(undefined)).toBeUndefined();
  });

  it('reports the count only when no listing was filtered out locally', () => {
    expect(totalFound(63, { query: 'bat' })).toBe(63);
    expect(totalFound(63, { query: 'bat', condition: 'like_new' })).toBe(63);
    expect(totalFound(63, { query: 'bat', condition: 'used' })).toBeUndefined();
    expect(totalFound(63, { query: 'bat', maxPrice: 50 })).toBeUndefined();
  });

  it('leaves out a count the storefront has capped', () => {
    expect(totalFound(9_999, { query: 'bat' })).toBe(9_999);
    expect(totalFound(10_000, { query: 'bat' })).toBeUndefined();
  });
});

describe('clampCount', () => {
  it('keeps limit and offset between zero and the ten-page budget', () => {
    expect(clampCount(-5)).toBe(0);
    expect(clampCount(30)).toBe(30);
    expect(clampCount(10_000)).toBe(120);
  });
});

describe('summaryListing', () => {
  it('turns a storefront product into a listing priced in the store currency', () => {
    expect(summaryListing(catcher())).toMatchObject({
      id: CATCHER_PATH, url: `https://playitagainsports.com${CATCHER_PATH}`,
      price: '$39.99', priceNumeric: 39.99, currency: 'USD', condition: 'Used', seller: 'MA - Leominster', location: 'MA - Leominster',
    });
    expect(summaryListing(canadianMask())).toMatchObject({ price: 'C$14.99', priceNumeric: 14.99, currency: 'CAD' });
  });

  it('uses full-size photos', () => {
    const images = summaryListing(catcher())!.images!;
    expect(images).toHaveLength(4);
    expect(images.every((url) => url.includes('/stencil/1280x1280/'))).toBe(true);
  });

  it('marks a starting price when the product has options', () => {
    expect(summaryListing({ ...catcher(), has_options: true })!.price).toBe('from $39.99');
  });

  it('leaves out price fields without a known currency or price', () => {
    const noCountry = summaryListing({ ...catcher(), custom_fields: [] })!;
    expect(noCountry.price).toBe('Price not listed');
    expect(noCountry.priceNumeric).toBeUndefined();
    expect(summaryListing({ ...catcher(), price: undefined })!.currency).toBeUndefined();
  });

  it('skips a product without a name or product path', () => {
    expect(summaryListing({ ...catcher(), name: ' ' })).toBeUndefined();
    expect(summaryListing({ ...catcher(), url: 'https://evil.test/locations/a/product/b/c' })).toBeUndefined();
    expect(summaryListing({ ...catcher(), url: undefined })).toBeUndefined();
  });
});

describe('Play It Again Sports search', () => {
  it('turns a captured search page into listings', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('search'))));
    const result = await playitagain.search({ query: 'bauer 950', limit: 12 });

    expect(result).toMatchObject({ success: true, totalFound: 63 });
    expect(result.listings).toHaveLength(12);
    expect(result.listings.slice(0, 2).map((l) => l.price)).toEqual(['$39.99', 'C$14.99']);
    expect(result.note).toBeUndefined();
  });

  it('filters by condition and a dollar price bound', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('search'))));
    const result = await playitagain.search({ query: 'bauer 950', condition: 'used', maxPrice: 30 });

    expect(result.listings.map((l) => l.priceNumeric)).toEqual([29.99, 19.99, 24.99]);
    expect(result.listings.every((l) => l.currency === 'USD' && l.condition === 'Used')).toBe(true);
    expect(result.totalFound).toBeUndefined();
  });

  it('succeeds with filters it cannot apply', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('search'))));
    const result = await playitagain.search({ query: 'bauer 950', department: 'Men', radius: 5, showSold: true, sort: 'most_popular', limit: 1 });
    expect(result.success).toBe(true);
    expect(result.listings).toHaveLength(1);
  });

  it('skips malformed and out-of-stock products', async () => {
    const rows = [null, {}, { ...catcher(), url: 'not a product' }, { ...productAt(1), stock_level: 0 }, { ...productAt(2), availability: 'Sold Out' }, productAt(3)];
    fetchMock.mockImplementation(() => Promise.resolve(html(searchPage(rows))));
    const result = await playitagain.search({ query: 'bat' });
    expect(result.listings.map((l) => l.id)).toEqual(['/locations/boston-ma/product/S3/Bat']);
  });

  it('applies the offset to matching listings and pages until the limit is filled', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(html(searchPage([productAt(1), productAt(2)], 2, 4))))
      .mockImplementationOnce(() => Promise.resolve(html(searchPage([productAt(2), productAt(3)], 2, 4))));

    const result = await playitagain.search({ query: 'bat', offset: 1, limit: 2 });

    expect(result.listings.map((l) => l.id)).toEqual(['/locations/boston-ma/product/S2/Bat', '/locations/boston-ma/product/S3/Bat']);
    expect(requestedPages()).toEqual(['1', '2']);
  });

  it('stops after a short page', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(searchPage([productAt(1)], 12))));
    await playitagain.search({ query: 'bat' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops when a page brings nothing new', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(searchPage([productAt(1)], 1))));
    const result = await playitagain.search({ query: 'bat', limit: 5 });
    expect(result.listings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests at most ten pages', async () => {
    fetchMock.mockImplementation((url: URL) => {
      const number = Number(url.searchParams.get('page'));
      return Promise.resolve(html(searchPage([productAt(number)], 1)));
    });
    const result = await playitagain.search({ query: 'bat', limit: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(result.listings).toHaveLength(10);
  });

  it('keeps earlier pages when a later page fails', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(html(searchPage([productAt(1)], 1))))
      .mockImplementationOnce(() => Promise.resolve(html('', 429)));
    const result = await playitagain.search({ query: 'bat', limit: 3 });
    expect(result).toMatchObject({ success: true, note: 'Later pages failed: Error: Play It Again Sports returned 429' });
    expect(result.listings).toHaveLength(1);
  });

  it.each([
    ['an HTTP error', () => html('', 403), 'Play It Again Sports returned 403'],
    ['a page without embedded data', () => html('<title>Just a moment</title>'), 'unexpected search page'],
    ['a product page instead of search', () => html(fixture('product')), 'unexpected search page'],
  ])('reports %s', async (_label, reply, message) => {
    fetchMock.mockImplementation(() => Promise.resolve(reply()));
    const result = await playitagain.search({ query: 'bat' });
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
  });
});

describe('productJsonLd', () => {
  it('reads a product whose description the storefront left empty', () => {
    const product = productJsonLd(fixture('variant-product'), '/locations/whitby-on/product/CCM-AXIS-F5-GOALIE-MASK/GHH-CCM-AXIS-F5-GOALIE-MASK-SR-WHT');
    expect(product).toMatchObject({ '@type': 'Product', description: null });
  });

  it('ignores a product block for a different path', () => {
    expect(productJsonLd(fixture('product'), '/locations/a/product/b/c')).toBeUndefined();
  });
});

describe('Play It Again Sports details', () => {
  it('lists price, stock, product fields, store, delivery and full-size photos', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('product'))));

    const details = await playitagain.getListingDetails(CATCHER_PATH);

    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://playitagainsports.com${CATCHER_PATH}`);
    expect(details).toMatchObject({
      id: CATCHER_PATH, seller: 'MA - Leominster', location: 'MA - Leominster',
      deliveryTypes: ['Pick Up in Store', 'Standard Shipping'], isShippingOffered: true,
    });
    expect(details.description).toContain('Price: $39.99');
    expect(details.description).toContain('Status: in stock');
    expect(details.description).toContain('Condition: Used');
    expect(details.description).toContain('Used Bauer SUPREME Junior Goalie Catcher Black');
    expect(details.images).toHaveLength(4);
    expect(details.images.every((url) => url.includes('/stencil/1280x1280/'))).toBe(true);
    expect(details.unavailable).toBeUndefined();
  });

  it('prices a Canadian store in CAD', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('canadian-product'))));
    const details = await playitagain.getListingDetails('/locations/Saskatoon-SK/product/S000044873/Bauer-Hockey-Wire-Mask');
    expect(details.description).toContain('Price: C$14.99');
  });

  it('shows the price range of a product with options', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('variant-product'))));
    const details = await playitagain.getListingDetails(
      'https://playitagainsports.com/locations/whitby-on/product/CCM-AXIS-F5-GOALIE-MASK/GHH-CCM-AXIS-F5-GOALIE-MASK-SR-WHT'
    );
    expect(details.description).toContain('Price: C$239.99–C$249.99');
    expect(details.isShippingOffered).toBe(false);
  });

  it('treats a product without a seller description as fully loaded', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('variant-product'))));
    const details = await playitagain.getListingDetails(
      '/locations/whitby-on/product/CCM-AXIS-F5-GOALIE-MASK/GHH-CCM-AXIS-F5-GOALIE-MASK-SR-WHT'
    );
    expect(details.unavailable).toBeUndefined();
    expect(details.description).not.toContain('\n\n');
  });

  it('treats a product without photos as fully loaded', async () => {
    const page = fixture('product').replaceAll('data-image-gallery-new-image-url', 'data-removed').replace(/"image"\s*:\s*(\[[^\]]*\]|"[^"]*")/g, '"image": []');
    fetchMock.mockImplementation(() => Promise.resolve(html(page)));
    const details = await playitagain.getListingDetails(CATCHER_PATH);
    expect(details.images).toEqual([]);
    expect(details.unavailable).toBeUndefined();
  });

  it('lists only descriptive product fields', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('variant-product'))));
    const details = await playitagain.getListingDetails(MASK_PATH);
    const lines = details.description!.split('\n');
    expect(lines).toEqual(expect.arrayContaining(['Condition: New', 'Product Brand: CCM', 'Size: One Size', 'Color: White / White And Black']));
    for (const internal of ['Shipping:', 'Country:', 'Discounted Price:', 'Pick Up in Store:', 'Standard Shipping:', 'Local Delivery:', 'Product Line:']) {
      expect(lines.some((line) => line.startsWith(internal))).toBe(false);
    }
  });

  it('names the product on the first line', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('product'))));
    const details = await playitagain.getListingDetails(CATCHER_PATH);
    expect(details.description!.split('\n').slice(0, 2)).toEqual([CATCHER_NAME, 'Price: $39.99']);
  });

  it('names a product that has no seller description', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('variant-product'))));
    const details = await playitagain.getListingDetails(MASK_PATH);
    expect(details.description!.split('\n')[0]).toBe('New CCM CCM AXIS F5 GOALIE MASK Senior Goalie Helmet/Mask 11891-CCM-AXIS-F5-GOALIE-MASK');
  });

  it('gives the research fetch the product name as its title', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html(fixture('product'))));
    registerMarketplace(playitagain);
    const reply = await researchFetch({ id: `playitagain:${CATCHER_PATH}` });
    const document = JSON.parse((reply.content[0] as { text: string }).text);
    expect(document.title).toBe(CATCHER_NAME);
  });

  it('rejects an unrecognised id without a request', async () => {
    await expect(playitagain.getListingDetails('3843758')).rejects.toThrow('listing IDs are product paths');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a different product', () => html(fixture('canadian-product'))],
    ['a page without embedded data', () => html('<html></html>')],
  ])('treats %s as not found', async (_label, reply) => {
    fetchMock.mockImplementation(() => Promise.resolve(reply()));
    await expect(playitagain.getListingDetails(CATCHER_PATH)).rejects.toThrow('not found');
  });

  it('passes on HTTP errors', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(html('', 404)));
    await expect(playitagain.getListingDetails(CATCHER_PATH)).rejects.toThrow('Play It Again Sports returned 404');
  });
});
