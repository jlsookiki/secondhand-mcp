import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EbayMarketplace, resizeEbayImageUrl } from '../src/marketplaces/ebay.js';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_PATH = '/buy/browse/v1/item_summary/search';
const ITEM_PATH = '/buy/browse/v1/item/';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

interface Routes {
  token?: (n: number) => Response;
  search?: (n: number) => Response;
  item?: (n: number) => Response;
}

let calls: Call[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function install(routes: Routes = {}): void {
  const counts = { token: 0, search: 0, item: 0 };
  const token = routes.token ?? (() => json({ access_token: 'tok-1', expires_in: 7200 }));
  const search = routes.search ?? (() => json({ total: 0, itemSummaries: [] }));
  const item = routes.item ?? (() => json({ itemId: 'v1|1|0', itemWebUrl: 'https://x/1' }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith(TOKEN_URL)) return token(counts.token++);
      if (url.includes(SEARCH_PATH)) return search(counts.search++);
      if (url.includes(ITEM_PATH)) return item(counts.item++);
      throw new Error(`unrouted fetch: ${url}`);
    })
  );
}

function market(over: Partial<{ clientId: string; clientSecret: string; marketplaceId: string }> = {}) {
  return new EbayMarketplace({ clientId: 'cid', clientSecret: 'csec', ...over });
}

function callsTo(fragment: string): Call[] {
  return calls.filter((c) => c.url.includes(fragment));
}

function header(call: Call, name: string): string | null {
  return new Headers(call.init?.headers).get(name);
}

function query(call: Call, name: string): string | null {
  return new URL(call.url).searchParams.get(name);
}

function summary(i: number, over: Record<string, unknown> = {}) {
  return {
    itemId: `v1|${i}|0`,
    title: `Item ${i}`,
    price: { value: '10.00', currency: 'USD' },
    itemWebUrl: `https://www.ebay.com/itm/${i}`,
    ...over,
  };
}

beforeEach(() => {
  calls = [];
  // Unset, a developer's shell value would decide the marketplace id under test.
  vi.stubEnv('EBAY_MARKETPLACE_ID', undefined);
});

describe('resizeEbayImageUrl', () => {
  it.each([
    ['https://i.ebayimg.com/images/g/abc/s-l225.jpg', 1600, 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg'],
    ['https://i.ebayimg.com/images/g/abc/s-l500.jpg', 140, 'https://i.ebayimg.com/images/g/abc/s-l140.jpg'],
    [
      'https://i.ebayimg.com/thumbs/images/g/abc/s-l225.jpg',
      1600,
      'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
    ],
    ['https://i.ebayimg.com/images/g/abc/s-l64.webp', 800, 'https://i.ebayimg.com/images/g/abc/s-l800.webp'],
    ['https://i.ebayimg.com/images/g/abc/s-l225.PNG', 960, 'https://i.ebayimg.com/images/g/abc/s-l960.PNG'],
    [
      'https://i.ebayimg.com/images/g/abc/s-l500.jpg?set_id=8800005007',
      1600,
      'https://i.ebayimg.com/images/g/abc/s-l1600.jpg?set_id=8800005007',
    ],
  ])('rewrites %s to %i px', (url, px, expected) => {
    expect(resizeEbayImageUrl(url as string, px as number)).toBe(expected);
  });

  it('leaves a URL already at the requested size byte-identical', () => {
    const url = 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg';
    expect(resizeEbayImageUrl(url, 1600)).toBe(url);
  });

  it('is idempotent', () => {
    const once = resizeEbayImageUrl('https://i.ebayimg.com/thumbs/images/g/abc/s-l225.jpg', 1600);
    expect(resizeEbayImageUrl(once, 1600)).toBe(once);
  });

  it.each([
    'https://cdn.shopify.com/images/g/abc/s-l225.jpg',
    'https://example.com/thumbs/images/g/abc/s-l225.jpg',
    'https://i.ebayimg.example.net/s-l225.jpg',
  ])('passes non-eBay URL %s through untouched', (url) => {
    expect(resizeEbayImageUrl(url, 1600)).toBe(url);
  });

  it.each([
    ['', ''],
    ['not a url at all', 'not a url at all'],
    ['https://i.ebayimg.com/images/g/abc/s-l.jpg', 'https://i.ebayimg.com/images/g/abc/s-l.jpg'],
    ['https://i.ebayimg.com/images/g/abc/s-l225', 'https://i.ebayimg.com/images/g/abc/s-l225'],
    ['https://i.ebayimg.com/images/g/abc/s-l225.gif', 'https://i.ebayimg.com/images/g/abc/s-l225.gif'],
    ['https://i.ebayimg.com/00/s/MTIwMFgxNjAw/z/$_57.JPG', 'https://i.ebayimg.com/00/s/MTIwMFgxNjAw/z/$_57.JPG'],
  ])('returns malformed input %s unchanged', (url, expected) => {
    expect(resizeEbayImageUrl(url, 1600)).toBe(expected);
  });
});

describe('EbayMarketplace auth token', () => {
  it('posts client_credentials with basic auth built from the credentials', async () => {
    install();
    await market({ clientId: 'my-id', clientSecret: 'my-secret' }).search({ query: 'lamp' });

    const [call] = callsTo(TOKEN_URL);
    expect(call.url).toBe(TOKEN_URL);
    expect(call.init?.method).toBe('POST');
    expect(header(call, 'authorization')).toBe(
      `Basic ${Buffer.from('my-id:my-secret').toString('base64')}`
    );
    expect(header(call, 'content-type')).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(String(call.init?.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('https://api.ebay.com/oauth/api_scope');
  });

  it('reuses a cached token across searches instead of re-authenticating', async () => {
    install({ token: (n) => json({ access_token: `tok-${n}`, expires_in: 7200 }) });
    const ebay = market();

    await ebay.search({ query: 'a' });
    await ebay.search({ query: 'b' });

    expect(callsTo(TOKEN_URL)).toHaveLength(1);
    expect(callsTo(SEARCH_PATH).map((c) => header(c, 'authorization'))).toEqual([
      'Bearer tok-0',
      'Bearer tok-0',
    ]);
  });

  it('re-authenticates once the cached token is within 60s of expiry', async () => {
    install({ token: (n) => json({ access_token: `tok-${n}`, expires_in: 7200 }) });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const ebay = market();

    await ebay.search({ query: 'a' });
    now.mockReturnValue(1_000_000 + 7_200_000 - 59_000);
    await ebay.search({ query: 'b' });

    expect(callsTo(TOKEN_URL)).toHaveLength(2);
    expect(header(callsTo(SEARCH_PATH)[1], 'authorization')).toBe('Bearer tok-1');
  });

  it('does not share a cached token between instances', async () => {
    install();
    await market().search({ query: 'a' });
    await market().search({ query: 'b' });

    expect(callsTo(TOKEN_URL)).toHaveLength(2);
  });

  it('reports an OAuth failure as a search error without hitting the browse API', async () => {
    install({ token: () => json({ error: 'invalid_client' }, 401) });

    const result = await market().search({ query: 'lamp' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(callsTo(SEARCH_PATH)).toHaveLength(0);
  });
});

describe('EbayMarketplace.search request', () => {
  it('sends the query, paging and marketplace headers', async () => {
    install();
    await market({ marketplaceId: 'EBAY_GB' }).search({ query: 'vintage lamp', limit: 5, offset: 40 });

    const [call] = callsTo(SEARCH_PATH);
    expect(new URL(call.url).origin + new URL(call.url).pathname).toBe(
      'https://api.ebay.com/buy/browse/v1/item_summary/search'
    );
    expect(query(call, 'q')).toBe('vintage lamp');
    expect(query(call, 'limit')).toBe('5');
    expect(query(call, 'offset')).toBe('40');
    expect(header(call, 'authorization')).toBe('Bearer tok-1');
    expect(header(call, 'X-EBAY-C-MARKETPLACE-ID')).toBe('EBAY_GB');
  });

  it('defaults the marketplace to EBAY_US', async () => {
    install();
    await market().search({ query: 'lamp' });

    expect(header(callsTo(SEARCH_PATH)[0], 'X-EBAY-C-MARKETPLACE-ID')).toBe('EBAY_US');
  });

  it('defaults to a limit of 20', async () => {
    install();
    await market().search({ query: 'lamp' });

    expect(query(callsTo(SEARCH_PATH)[0], 'limit')).toBe('20');
  });

  it('omits the filter parameter when nothing is filtered', async () => {
    install();
    await market().search({ query: 'lamp' });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBeNull();
  });

  it.each([
    ['new', 'NEW'],
    ['like_new', 'LIKE_NEW'],
    ['good', 'GOOD'],
    ['fair', 'FAIR'],
    ['excellent', 'USED'],
  ] as const)('maps condition %s to the eBay conditions filter', async (condition, mapped) => {
    install();
    await market().search({ query: 'lamp', condition });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBe(`conditions:{${mapped}}`);
  });

  it('sends no condition filter for "any"', async () => {
    install();
    await market().search({ query: 'lamp', condition: 'any' });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBeNull();
  });

  it.each([
    [{ minPrice: 10, maxPrice: 50 }, 'price:[10..50],priceCurrency:USD'],
    [{ minPrice: 10 }, 'price:[10..],priceCurrency:USD'],
    [{ maxPrice: 50 }, 'price:[..50],priceCurrency:USD'],
    [{ minPrice: 0, maxPrice: 0 }, 'price:[0..0],priceCurrency:USD'],
  ])('builds the price filter %o', async (prices, expected) => {
    install();
    await market().search({ query: 'lamp', ...prices });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBe(expected);
  });

  it('joins the price and condition filters with a comma', async () => {
    install();
    await market().search({ query: 'lamp', minPrice: 5, maxPrice: 20, condition: 'new' });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBe(
      'price:[5..20],priceCurrency:USD,conditions:{NEW}'
    );
  });

  it('applies a filter for the "used" condition', async () => {
    install();
    await market().search({ query: 'lamp', condition: 'used' });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBe('conditions:{USED}');
  });

  it('sends priceCurrency alongside a price filter', async () => {
    install();
    await market().search({ query: 'lamp', minPrice: 10, maxPrice: 50 });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBe('price:[10..50],priceCurrency:USD');
  });

  it.each([
    ['EBAY_GB', 'GBP'],
    ['EBAY_DE', 'EUR'],
  ])('takes the priceCurrency for %s from the marketplace', async (marketplaceId, currency) => {
    install();
    await market({ marketplaceId }).search({ query: 'lamp', maxPrice: 50 });

    expect(query(callsTo(SEARCH_PATH)[0], 'filter')).toBe(`price:[..50],priceCurrency:${currency}`);
  });

  it('makes no request at all when credentials are missing', async () => {
    install();
    const result = await new EbayMarketplace({ clientId: '', clientSecret: '' }).search({
      query: 'lamp',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('EBAY_CLIENT_ID');
    expect(calls).toHaveLength(0);
  });
});

describe('EbayMarketplace.search results', () => {
  it('maps an item summary onto a listing', async () => {
    install({
      search: () =>
        json({
          total: 1,
          itemSummaries: [
            {
              itemId: 'v1|123|0',
              title: 'Mid-century lamp',
              price: { value: '1,234.56', currency: 'USD' },
              condition: 'Used',
              itemLocation: { city: 'Austin', stateOrProvince: 'TX', country: 'US' },
              itemWebUrl: 'https://www.ebay.com/itm/123',
              image: { imageUrl: 'https://i.ebayimg.com/thumbs/images/g/abc/s-l225.jpg' },
              seller: { username: 'lampking' },
            },
          ],
        }),
    });

    const result = await market().search({ query: 'lamp', limit: 1 });

    expect(result.success).toBe(true);
    expect(result.totalFound).toBe(1);
    expect(result.note).toBeUndefined();
    expect(result.listings[0]).toMatchObject({
      id: 'v1|123|0',
      title: 'Mid-century lamp',
      price: '$1,234.56',
      priceNumeric: 1234.56,
      currency: '$',
      condition: 'Used',
      location: 'Austin, TX',
      url: 'https://www.ebay.com/itm/123',
      images: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'],
      seller: 'lampking',
      marketplace: 'ebay',
    });
  });

  it('falls back for a summary missing title, price, image and url', async () => {
    install({ search: () => json({ total: 1, itemSummaries: [{ itemId: 'v1|9|0' }] }) });

    const [listing] = (await market().search({ query: 'lamp', limit: 1 })).listings;

    expect(listing.title).toBe('Untitled Listing');
    expect(listing.price).toBe('Price not listed');
    expect(listing.priceNumeric).toBeUndefined();
    expect(listing.images).toBeUndefined();
    expect(listing.location).toBeUndefined();
    expect(listing.url).toBe('https://www.ebay.com/itm/v1|9|0');
  });

  it('reports the currency of a non-USD listing', async () => {
    install({
      search: () =>
        json({
          total: 1,
          itemSummaries: [summary(1, { price: { value: '25.50', currency: 'EUR' } })],
        }),
    });

    const [listing] = (await market({ marketplaceId: 'EBAY_DE' }).search({ query: 'lamp', limit: 1 }))
      .listings;

    expect(listing.price).toBe('EUR25.50');
    expect(listing.currency).toBe('EUR');
  });

  it('adds a note when nothing matched', async () => {
    install({ search: () => json({ total: 0, itemSummaries: [] }) });

    const result = await market().search({ query: 'nonexistent' });

    expect(result.listings).toEqual([]);
    expect(result.totalFound).toBe(0);
    expect(result.note).toContain('No eBay listings found');
  });

  it('never returns more listings than the requested limit', async () => {
    install({
      search: () => json({ total: 10, itemSummaries: [summary(1), summary(2), summary(3)] }),
    });

    const result = await market().search({ query: 'lamp', limit: 2 });

    expect(result.listings.map((l) => l.title)).toEqual(['Item 1', 'Item 2']);
    expect(result.totalFound).toBe(10);
  });
});

describe('EbayMarketplace.search pagination', () => {
  it('pages in 200-item requests until the limit is filled', async () => {
    const page = (start: number, count: number) => ({
      total: 1000,
      itemSummaries: Array.from({ length: count }, (_, i) => summary(start + i)),
    });
    install({ search: (n) => json(n === 0 ? page(0, 200) : page(200, 50)) });

    const result = await market().search({ query: 'lamp', limit: 250 });

    const pages = callsTo(SEARCH_PATH).map((c) => [query(c, 'limit'), query(c, 'offset')]);
    expect(pages).toEqual([
      ['200', '0'],
      ['50', '200'],
    ]);
    expect(result.listings).toHaveLength(250);
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it('reuses the same filter on every page', async () => {
    install({
      search: (n) =>
        json({
          total: 1000,
          itemSummaries: Array.from({ length: n === 0 ? 200 : 10 }, (_, i) => summary(i)),
        }),
    });

    await market().search({ query: 'lamp', limit: 210, condition: 'new', maxPrice: 50 });

    expect(callsTo(SEARCH_PATH).map((c) => query(c, 'filter'))).toEqual([
      'price:[..50],priceCurrency:USD,conditions:{NEW}',
      'price:[..50],priceCurrency:USD,conditions:{NEW}',
    ]);
  });

  it('stops paging when the result set is exhausted', async () => {
    install({ search: () => json({ total: 3, itemSummaries: [summary(1), summary(2), summary(3)] }) });

    const result = await market().search({ query: 'lamp', limit: 250 });

    expect(callsTo(SEARCH_PATH)).toHaveLength(1);
    expect(result.listings).toHaveLength(3);
  });

  it('stops paging when a page comes back empty even though total claims more', async () => {
    install({
      search: (n) => json(n === 0 ? { total: 9999, itemSummaries: [summary(1)] } : { total: 9999, itemSummaries: [] }),
    });

    const result = await market().search({ query: 'lamp', limit: 400 });

    expect(callsTo(SEARCH_PATH)).toHaveLength(2);
    expect(result.listings).toHaveLength(1);
  });

  it('clamps the page limit so offset + limit never exceeds 10,000', async () => {
    install({ search: () => json({ total: 50_000, itemSummaries: [summary(1)] }) });

    await market().search({ query: 'lamp', limit: 200, offset: 9_950 });

    expect(query(callsTo(SEARCH_PATH)[0], 'limit')).toBe('50');
  });

  it('treats a negative offset as 0', async () => {
    install();
    await market().search({ query: 'lamp', offset: -10 });

    expect(query(callsTo(SEARCH_PATH)[0], 'offset')).toBe('0');
  });
});

describe('EbayMarketplace.search failures', () => {
  it('surfaces the status and body of a failed first page', async () => {
    install({ search: () => new Response('rate limit exceeded', { status: 429 }) });

    const result = await market().search({ query: 'lamp' });

    expect(result.success).toBe(false);
    expect(result.marketplace).toBe('ebay');
    expect(result.listings).toEqual([]);
    expect(result.error).toBe('eBay API returned 429: rate limit exceeded');
  });

  it('returns the listings already collected when a later page fails', async () => {
    install({
      search: (n) =>
        n === 0
          ? json({
              total: 1000,
              itemSummaries: Array.from({ length: 200 }, (_, i) => summary(i)),
            })
          : new Response('boom', { status: 500 }),
    });

    const result = await market().search({ query: 'lamp', limit: 250 });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.listings).toHaveLength(200);
  });

  it('reports a non-JSON body as a search error rather than throwing', async () => {
    install({ search: () => new Response('<html>oops</html>', { status: 200 }) });

    const result = await market().search({ query: 'lamp' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^eBay search failed:/);
  });

  it('skips an unparseable item instead of failing the whole search', async () => {
    // A numeric imageUrl reaches the URL rewriter and throws there.
    install({
      search: () =>
        json({
          total: 3,
          itemSummaries: [
            { itemId: 'v1|1|0', title: 'Good', price: { value: '10.00', currency: 'USD' } },
            { itemId: 'v1|2|0', title: 'Bad', image: { imageUrl: 12345 } },
            { itemId: 'v1|3|0', title: 'Also good', price: { value: '20.00', currency: 'USD' } },
          ],
        }),
    });

    const result = await market().search({ query: 'lamp' });

    expect(result.success).toBe(true);
    expect(result.listings.map((l) => l.id)).toEqual(['v1|1|0', 'v1|3|0']);
  });

  it('does not fabricate listings when itemSummaries is not an array', async () => {
    install({ search: () => json({ total: 5, itemSummaries: 'nope' }) });

    const result = await market().search({ query: 'lamp' });

    expect(result.listings).toEqual([]);
  });

  it('reports a network-level failure as a search error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const result = await market().search({ query: 'lamp' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('fetch failed');
  });
});

describe('EbayMarketplace.getListingDetails', () => {
  it('wraps a bare numeric id as v1|<id>|0 and percent-encodes the pipes', async () => {
    install();
    await market().getListingDetails('123456');

    expect(callsTo(ITEM_PATH)[0].url).toBe(
      'https://api.ebay.com/buy/browse/v1/item/v1%7C123456%7C0'
    );
  });

  it.each(['v1|123456|0', 'v1|123456|123'])('leaves an already-wrapped id %s alone', async (id) => {
    install();
    await market().getListingDetails(id);

    expect(decodeURIComponent(callsTo(ITEM_PATH)[0].url.split('/item/')[1])).toBe(id);
  });

  it('sends the bearer token and marketplace header', async () => {
    install({ token: () => json({ access_token: 'tok-abc', expires_in: 7200 }) });
    await market({ marketplaceId: 'EBAY_DE' }).getListingDetails('123456');

    const [call] = callsTo(ITEM_PATH);
    expect(header(call, 'authorization')).toBe('Bearer tok-abc');
    expect(header(call, 'X-EBAY-C-MARKETPLACE-ID')).toBe('EBAY_DE');
  });

  it('maps a full item payload', async () => {
    install({
      item: () =>
        json({
          itemId: 'v1|123456|0',
          description: '<p>Full description</p>',
          shortDescription: 'short',
          image: { imageUrl: 'https://i.ebayimg.com/thumbs/images/g/abc/s-l225.jpg' },
          additionalImages: [
            { imageUrl: 'https://i.ebayimg.com/images/g/def/s-l500.jpg' },
            { notAnImage: true },
          ],
          itemLocation: { city: 'Berlin', stateOrProvince: 'BE', country: 'DE' },
          seller: { username: 'lampking' },
          shippingOptions: [{ shippingServiceCode: 'Standard' }, { shippingServiceCode: 'Expedited' }],
          itemWebUrl: 'https://www.ebay.de/itm/123456',
        }),
    });

    const details = await market().getListingDetails('123456');

    expect(details).toEqual({
      id: 'v1|123456|0',
      description: '<p>Full description</p>',
      images: [
        'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
        'https://i.ebayimg.com/images/g/def/s-l1600.jpg',
      ],
      location: 'Berlin, BE, DE',
      seller: 'lampking',
      deliveryTypes: ['Standard', 'Expedited'],
      isShippingOffered: true,
      url: 'https://www.ebay.de/itm/123456',
    });
  });

  it('falls back to shortDescription and reports no shipping', async () => {
    install({
      item: () => json({ itemId: 'v1|1|0', shortDescription: 'short', itemWebUrl: 'https://x/1' }),
    });

    const details = await market().getListingDetails('1');

    expect(details.description).toBe('short');
    expect(details.images).toEqual([]);
    expect(details.location).toBeUndefined();
    expect(details.seller).toBeUndefined();
    expect(details.deliveryTypes).toBeUndefined();
    expect(details.isShippingOffered).toBe(false);
  });

  it('builds a usable itm URL from the original id when itemWebUrl is missing', async () => {
    install({ item: () => json({ itemId: 'v1|123456|0' }) });

    const details = await market().getListingDetails('123456');

    expect(details.url).toBe('https://www.ebay.com/itm/123456');
  });

  it('rejects on a non-ok response', async () => {
    install({ item: () => new Response('not found', { status: 404 }) });

    await expect(market().getListingDetails('123456')).rejects.toThrow('eBay API returned 404');
  });

  it('rejects on a non-JSON body', async () => {
    install({ item: () => new Response('<html>oops</html>', { status: 200 }) });

    await expect(market().getListingDetails('123456')).rejects.toThrow();
  });

  it('rejects when the token request fails', async () => {
    install({ token: () => new Response('nope', { status: 401 }) });

    await expect(market().getListingDetails('123456')).rejects.toThrow('eBay OAuth failed');
    expect(callsTo(ITEM_PATH)).toHaveLength(0);
  });
});

describe('EbayMarketplace.healthCheck', () => {
  it('is false without credentials and issues no request', async () => {
    install();
    await expect(new EbayMarketplace({ clientId: '', clientSecret: '' }).healthCheck()).resolves.toBe(
      false
    );
    expect(calls).toHaveLength(0);
  });

  it('is true when the token request succeeds', async () => {
    install();
    await expect(market().healthCheck()).resolves.toBe(true);
  });

  it('is false when the token request fails', async () => {
    install({ token: () => new Response('nope', { status: 500 }) });
    await expect(market().healthCheck()).resolves.toBe(false);
  });
});
