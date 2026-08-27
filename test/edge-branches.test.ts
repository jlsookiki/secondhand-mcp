import { describe, expect, it, vi } from 'vitest';
import { FacebookMarketplace } from '../src/marketplaces/facebook.js';
import { EbayMarketplace } from '../src/marketplaces/ebay.js';
import { getBrowser } from '../src/browser.js';

vi.mock('undici', () => ({
  ProxyAgent: class {
    constructor(public proxyUrl: string) {}
  },
}));

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const locationBody = (edges: unknown[]) => ({
  data: { city_street_search: { street_results: { edges } } },
});

const searchBody = (listings: unknown[]) => ({
  data: {
    marketplace_search: {
      feed_units: {
        edges: listings.map((listing) => ({
          node: { __typename: 'MarketplaceFeedListingStoryObject', listing },
        })),
      },
    },
  },
});

/** facebook.ts builds its dispatcher at module evaluation, so the env var has
 *  to be in place before the import. */
async function loadFacebook(smartproxyUrl?: string) {
  vi.stubEnv('SMARTPROXY_URL', smartproxyUrl);
  vi.resetModules();
  return (await import('../src/marketplaces/facebook.js')).FacebookMarketplace;
}

describe('facebook proxy dispatcher', () => {
  it('dispatches through a proxy built from SMARTPROXY_URL', async () => {
    const Facebook = await loadFacebook('http://user:pass@proxy.test:7000');
    const { calls } = stubFetch(() =>
      json(
        locationBody([
          {
            node: {
              subtitle: 'City · Ontario',
              single_line_address: 'Toronto, Ontario',
              location: { latitude: 43.7, longitude: -79.42 },
            },
          },
        ])
      )
    );

    await new Facebook().getLocation('toronto');

    const dispatcher = (calls[0].init as any).dispatcher;
    expect(dispatcher?.proxyUrl).toBe('http://user:pass@proxy.test:7000');
  });

  it('dispatches direct when SMARTPROXY_URL is unset', async () => {
    const Facebook = await loadFacebook(undefined);
    const { calls } = stubFetch(() => json(locationBody([])));

    await new Facebook().getLocation('toronto');

    expect((calls[0].init as any).dispatcher).toBeUndefined();
  });
});

describe('facebook search cache', () => {
  it('evicts the oldest search once it is full and keeps the newest', async () => {
    const facebook = new FacebookMarketplace();
    const { mock } = stubFetch(() => json(searchBody([{ id: '1', marketplace_listing_title: 'Trek' }])));

    for (let i = 0; i <= 200; i++) {
      await facebook.search({ query: `q${i}`, location: 'austin, tx' });
    }
    expect(mock).toHaveBeenCalledTimes(201);

    await facebook.search({ query: 'q200', location: 'austin, tx' });
    expect(mock).toHaveBeenCalledTimes(201);

    await facebook.search({ query: 'q0', location: 'austin, tx' });
    expect(mock).toHaveBeenCalledTimes(202);
  });
});

describe('facebook location naming', () => {
  it('falls back to the address when the top result has no subtitle', async () => {
    stubFetch(() =>
      json(
        locationBody([
          {
            node: {
              single_line_address: 'Rua Toronto, Lisboa',
              location: { latitude: 38.72, longitude: -9.14 },
            },
          },
        ])
      )
    );

    const coords = await new FacebookMarketplace().getLocation('toronto');

    expect(coords).toEqual({ latitude: 38.72, longitude: -9.14, name: 'Rua Toronto, Lisboa' });
  });
});

describe('facebook retry exhaustion', () => {
  it('names the failure when every attempt rejects with no error value', async () => {
    vi.useFakeTimers();
    try {
      const { mock } = stubFetch(() => Promise.reject(undefined));

      const pending = new FacebookMarketplace().search({ query: 'bike', location: 'austin, tx' });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;

      expect(mock).toHaveBeenCalledTimes(3);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Facebook request failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ebay filters', () => {
  const tokenBody = json({ access_token: 'tok-1', expires_in: 7200 });

  function stubEbay(pages: unknown[]) {
    let page = 0;
    return stubFetch(({ url }) =>
      url.includes('/identity/v1/oauth2/token')
        ? tokenBody.clone()
        : json(pages[Math.min(page++, pages.length - 1)])
    );
  }

  const searchCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/item_summary/search'));
  const filterOf = (call: Call) => new URL(call.url).searchParams.get('filter');

  const market = (marketplaceId?: string) =>
    new EbayMarketplace({ clientId: 'cid', clientSecret: 'csec', marketplaceId });

  it('prices a marketplace it has no currency for in USD', async () => {
    const { calls } = stubEbay([{ total: 0, itemSummaries: [] }]);

    const result = await market('EBAY_JP').search({ query: 'lens', minPrice: 10 });

    expect(result.success).toBe(true);
    expect(filterOf(searchCalls(calls)[0])).toBe('price:[10..],priceCurrency:USD');
  });

  it('sends no condition filter for a condition eBay cannot express', async () => {
    const { calls } = stubEbay([{ total: 0, itemSummaries: [] }]);

    const result = await market().search({ query: 'lens', condition: 'refurbished' as any });

    expect(result.success).toBe(true);
    expect(searchCalls(calls)).toHaveLength(1);
    expect(filterOf(searchCalls(calls)[0])).toBeNull();
  });

  it('keeps the total from an earlier page when a later page omits it', async () => {
    const summary = (i: number) => ({
      itemId: `v1|${i}|0`,
      title: `Item ${i}`,
      price: { value: '10.00', currency: 'USD' },
      itemWebUrl: `https://www.ebay.com/itm/${i}`,
    });
    const { calls } = stubEbay([
      { total: 5, itemSummaries: [summary(1), summary(2), summary(3)] },
      { itemSummaries: [summary(4), summary(5)] },
      { total: 5, itemSummaries: [summary(6)] },
    ]);

    const result = await market().search({ query: 'lens', limit: 20 });

    expect(result.totalFound).toBe(5);
    expect(result.listings).toHaveLength(5);
    expect(searchCalls(calls)).toHaveLength(2);
  });
});

describe('getBrowser', () => {
  it('reports an empty candidate list on a platform it knows no paths for', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true });
    vi.stubEnv('PUPPETEER_EXECUTABLE_PATH', undefined);
    try {
      await expect(getBrowser()).rejects.toThrow(/Chrome\/Chromium not found[\s\S]*Checked: $/);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });
});
