import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacebookMarketplace } from '../src/marketplaces/facebook.js';
import type { SearchParams } from '../src/types.js';

// facebook.ts builds a ProxyAgent from SMARTPROXY_URL at module evaluation.
vi.mock('undici', () => ({ ProxyAgent: class {} }));

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const LOCATION_DOC_ID = '5585904654783609';
const SEARCH_DOC_ID = '7111939778879383';
const ATTEMPT_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 15_000;
const SEARCH_CACHE_TTL_MS = 90_000;

interface GraphQLRequest {
  url: string;
  docId: string;
  variables: any;
}

function stubFetch(handler: (req: GraphQLRequest) => Response | Promise<Response>) {
  const calls: GraphQLRequest[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    const req: GraphQLRequest = {
      url: String(input),
      docId: body.get('doc_id') ?? '',
      variables: JSON.parse(body.get('variables') ?? 'null'),
    };
    calls.push(req);
    return handler(req);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const locationEdge = (subtitle: string, address: string, latitude: number, longitude: number) => ({
  node: { subtitle, single_line_address: address, location: { latitude, longitude } },
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

const item = (over: Record<string, unknown> = {}) => ({
  id: '1',
  marketplace_listing_title: 'Trek 520',
  listing_price: { formatted_amount: '$100' },
  ...over,
});

const BASE: SearchParams = { query: 'bike', location: 'san francisco' };
const search = (over: Partial<SearchParams> = {}) =>
  new FacebookMarketplace().search({ ...BASE, ...over });

describe('location resolution', () => {
  it('resolves a US city offline, without touching the network', async () => {
    const { mock } = stubFetch(() => json({}));

    const coords = await new FacebookMarketplace().getLocation('san francisco');

    expect(coords?.name).toBe('San Francisco, CA');
    expect(coords?.latitude).toBeCloseTo(37.77, 1);
    expect(coords?.longitude).toBeCloseTo(-122.42, 1);
    expect(mock).not.toHaveBeenCalled();
  });

  it('spends a US search on the listings request alone', async () => {
    const { mock, calls } = stubFetch(() => json(searchBody([item()])));

    const result = await search({ location: 'austin, tx' });

    expect(result.success).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ url: GRAPHQL_URL, docId: SEARCH_DOC_ID });
    const browse = calls[0].variables.params.browse_request_params;
    expect(browse.filter_location_latitude).toBeCloseTo(30.27, 1);
    expect(browse.filter_location_longitude).toBeCloseTo(-97.74, 1);
  });

  it('falls through to the GraphQL lookup for a non-US city', async () => {
    const { mock, calls } = stubFetch(() =>
      json(locationBody([locationEdge('City · Ontario', 'Toronto, Ontario', 43.7, -79.42)]))
    );

    const coords = await new FacebookMarketplace().getLocation('toronto');

    expect(coords).toEqual({ latitude: 43.7, longitude: -79.42, name: 'Toronto, Ontario' });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ url: GRAPHQL_URL, docId: LOCATION_DOC_ID });
    expect(calls[0].variables.params.query).toBe('toronto');
    expect(calls[0].variables.params.page_category).toContain('CITY');
  });

  it('prefers the City result over a higher-ranked venue', async () => {
    stubFetch(() =>
      json(
        locationBody([
          locationEdge('Sports Venue · South Africa', 'Toronto Sports Club', -29.7, 31.02),
          locationEdge('City · Ontario', 'Toronto, Ontario', 43.7, -79.42),
        ])
      )
    );

    const coords = await new FacebookMarketplace().getLocation('toronto');

    expect(coords).toEqual({ latitude: 43.7, longitude: -79.42, name: 'Toronto, Ontario' });
  });

  it('falls back to the top result when nothing carries the City subtitle', async () => {
    stubFetch(() =>
      json(
        locationBody([
          locationEdge('Street · Lisbon', 'Rua Toronto, Lisboa', 38.72, -9.14),
          locationEdge('Neighborhood · Ontario', 'Old Toronto', 43.65, -79.38),
        ])
      )
    );

    const coords = await new FacebookMarketplace().getLocation('toronto');

    expect(coords?.latitude).toBe(38.72);
    expect(coords?.longitude).toBe(-9.14);
  });

  it('retries with the bare city name when the full query finds nothing', async () => {
    const { calls } = stubFetch(({ variables }) =>
      json(
        variables.params.query === 'old toronto'
          ? locationBody([locationEdge('City · Ontario', 'Old Toronto, Ontario', 43.65, -79.38)])
          : locationBody([])
      )
    );

    const coords = await new FacebookMarketplace().getLocation('old toronto, ontario');

    expect(calls.map((c) => c.variables.params.query)).toEqual([
      'old toronto, ontario',
      'old toronto',
    ]);
    expect(coords?.latitude).toBe(43.65);
  });

  it('reuses a resolved city instead of looking it up twice', async () => {
    const { mock } = stubFetch(() =>
      json(locationBody([locationEdge('City · Ontario', 'Toronto, Ontario', 43.7, -79.42)]))
    );
    const facebook = new FacebookMarketplace();

    await facebook.getLocation('toronto');
    await facebook.getLocation('toronto');

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('reports an unresolvable location without searching', async () => {
    const { calls } = stubFetch(() => json(locationBody([])));

    const result = await search({ location: 'atlantis' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('atlantis');
    expect(result.listings).toEqual([]);
    expect(calls.map((c) => c.docId)).toEqual([LOCATION_DOC_ID]);
  });
});

describe('search requests and parsing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps a listing onto the public shape', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
    stubFetch(() =>
      json(
        searchBody([
          item({
            id: '9182736',
            marketplace_listing_title: 'Trek 520 Touring Bike',
            listing_price: { formatted_amount: '$1,234.56' },
            primary_listing_photo: { image: { uri: 'https://scontent.fb.com/bike.jpg' } },
            location: { reverse_geocode: { city_page: { display_name: 'Oakland, CA' } } },
            marketplace_listing_seller: { name: 'Ada L.' },
          }),
        ])
      )
    );

    const result = await search();

    expect(result.listings).toEqual([
      {
        id: '9182736',
        title: 'Trek 520 Touring Bike',
        price: '$1,234.56',
        priceNumeric: 1234.56,
        currency: '$',
        location: 'Oakland, CA',
        url: 'https://www.facebook.com/marketplace/item/9182736',
        images: ['https://scontent.fb.com/bike.jpg'],
        seller: 'Ada L.',
        marketplace: 'facebook',
        scrapedAt: '2026-08-26T12:00:00.000Z',
      },
    ]);
    expect(result.totalFound).toBe(1);
  });

  it.each([
    ['$100', 100, '$'],
    ['$1,234.56', 1234.56, '$'],
    ['$0', 0, '$'],
    ['€45', 45, '€'],
    ['£20.50', 20.5, '£'],
  ])('reads %s as %d', async (formatted, numeric, currency) => {
    stubFetch(() => json(searchBody([item({ listing_price: { formatted_amount: formatted } })])));

    const [listing] = (await search()).listings;

    expect(listing.price).toBe(formatted);
    expect(listing.priceNumeric).toBe(numeric);
    expect(listing.currency).toBe(currency);
  });

  it('leaves priceNumeric unset when the amount is missing', async () => {
    stubFetch(() => json(searchBody([item({ listing_price: null })])));

    const [listing] = (await search()).listings;

    expect(listing.price).toBe('Price not listed');
    expect(listing.priceNumeric).toBeUndefined();
    expect(listing.currency).toBe('$');
  });

  it('leaves priceNumeric unset for a free listing', async () => {
    stubFetch(() => json(searchBody([item({ listing_price: { formatted_amount: 'Free' } })])));

    const [listing] = (await search()).listings;

    expect(listing.price).toBe('Free');
    expect(listing.priceNumeric).toBeUndefined();
  });

  it('falls back to placeholder text for an untitled listing', async () => {
    stubFetch(() => json(searchBody([item({ marketplace_listing_title: null })])));

    const [listing] = (await search()).listings;

    expect(listing.title).toBe('Untitled Listing');
    expect(listing.images).toBeUndefined();
  });

  it('drops sold, pending, hidden and dead listings by default', async () => {
    stubFetch(() =>
      json(
        searchBody([
          item({ id: 'sold', is_sold: true }),
          item({ id: 'dead', is_live: false }),
          item({ id: 'pending', is_pending: true }),
          item({ id: 'hidden', is_hidden: true }),
          item({ id: 'titled-sold', marketplace_listing_title: '[SOLD] Trek 520' }),
          item({ id: 'dashed-sold', marketplace_listing_title: 'sold - Trek 520' }),
          item({ id: 'live' }),
        ])
      )
    );

    const result = await search();

    expect(result.listings.map((l) => l.id)).toEqual(['live']);
    expect(result.totalFound).toBe(1);
  });

  it('keeps sold listings when showSold is set', async () => {
    stubFetch(() =>
      json(
        searchBody([
          item({ id: 'sold', is_sold: true }),
          item({ id: 'titled-sold', marketplace_listing_title: '[SOLD] Trek 520' }),
          item({ id: 'live' }),
        ])
      )
    );

    const result = await search({ showSold: true });

    expect(result.listings.map((l) => l.id)).toEqual(['sold', 'titled-sold', 'live']);
  });

  it('keeps a title that only mentions sold mid-sentence', async () => {
    stubFetch(() =>
      json(searchBody([item({ marketplace_listing_title: 'Trek 520 - not sold yet' })]))
    );

    expect((await search()).listings).toHaveLength(1);
  });

  it('skips feed units that are not listing stories', async () => {
    const { data } = searchBody([item({ id: 'real' })]);
    data.marketplace_search.feed_units.edges.unshift(
      { node: { __typename: 'MarketplaceFeedAdStoryObject', listing: item({ id: 'ad' }) } } as any,
      { node: { __typename: 'MarketplaceFeedListingStoryObject', listing: null } } as any,
      {} as any
    );
    stubFetch(() => json({ data }));

    const result = await search();

    expect(result.listings.map((l) => l.id)).toEqual(['real']);
  });

  it('honours the requested limit and caps what it asks Facebook for', async () => {
    const { calls } = stubFetch(() =>
      json(searchBody(Array.from({ length: 30 }, (_, i) => item({ id: String(i) }))))
    );

    const result = await search({ limit: 50 });

    expect(calls[0].variables.count).toBe(24);
    expect(result.listings).toHaveLength(30);
  });

  it('stops parsing at the limit', async () => {
    stubFetch(() =>
      json(searchBody(Array.from({ length: 10 }, (_, i) => item({ id: String(i) }))))
    );

    const result = await search({ limit: 3 });

    expect(result.listings.map((l) => l.id)).toEqual(['0', '1', '2']);
    expect(result.totalFound).toBe(3);
  });

  it('passes the price bounds through, with a sentinel for an open upper bound', async () => {
    const { calls } = stubFetch(() => json(searchBody([])));

    await search({ minPrice: 25 });

    const browse = calls[0].variables.params.browse_request_params;
    expect(browse.filter_price_lower_bound).toBe(25);
    expect(browse.filter_price_upper_bound).toBe(214748364700);
    expect(calls[0].variables.params.bqf.query).toBe('bike');
  });

  it('flags a payload whose shape it does not recognise', async () => {
    stubFetch(() => json({ data: {} }));

    const result = await search();

    expect(result.success).toBe(false);
    expect(result.error).toContain('doc_id');
  });
});

describe('retries and the time budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const useDeterministicBackoff = () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  };

  it('backs off before retrying a retryable status', async () => {
    useDeterministicBackoff();
    let attempts = 0;
    const { mock } = stubFetch(() =>
      ++attempts === 1 ? new Response(null, { status: 503 }) : json(searchBody([item()]))
    );

    const pending = search();
    await vi.advanceTimersByTimeAsync(999);
    expect(mock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.listings).toHaveLength(1);
  });

  it('gives up after three attempts and reports the status', async () => {
    useDeterministicBackoff();
    const { mock } = stubFetch(() => new Response(null, { status: 429 }));

    const pending = search();
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS);
    const result = await pending;

    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
  });

  it('does not retry a status outside the retryable set', async () => {
    useDeterministicBackoff();
    const { mock } = stubFetch(() => new Response(null, { status: 404 }));

    const pending = search();
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS);
    const result = await pending;

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.error).toContain('404');
  });

  it('fails fast on a GraphQL error body', async () => {
    useDeterministicBackoff();
    const { mock } = stubFetch(() => json({ errors: [{ message: 'Please try again later' }] }));

    const pending = search();
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS);
    const result = await pending;

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Facebook GraphQL error: Please try again later');
  });

  it('skips the retry when the backoff alone would outlast the budget', async () => {
    useDeterministicBackoff();
    const { mock } = stubFetch(async () => {
      await delay(TOTAL_BUDGET_MS - 500);
      return new Response(null, { status: 503 });
    });

    const pending = search();
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS * 4);
    const result = await pending;

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  // FAILS: the deadline only gates the sleep, so a second attempt started at
  // 9s still runs its full 8s timeout and lands 2s past TOTAL_BUDGET_MS.
  it('keeps the whole request inside the total time budget', async () => {
    useDeterministicBackoff();
    const { mock } = stubFetch(async () => {
      await delay(ATTEMPT_TIMEOUT_MS);
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    });

    const startedAt = Date.now();
    let elapsed = -1;
    const pending = search().then((r) => {
      elapsed = Date.now() - startedAt;
      return r;
    });
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS * 4);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(mock.mock.calls.length).toBeGreaterThan(1);
    expect(elapsed).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
  });
});

describe('search result cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves an identical repeat query without a second request', async () => {
    const { mock } = stubFetch(() => json(searchBody([item()])));
    const facebook = new FacebookMarketplace();

    const first = await facebook.search(BASE);
    const second = await facebook.search(BASE);

    expect(mock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.listings.map((l) => l.id)).toEqual(['1']);
  });

  it('refetches when any search parameter differs', async () => {
    const { mock } = stubFetch(() => json(searchBody([item()])));
    const facebook = new FacebookMarketplace();

    await facebook.search(BASE);
    await facebook.search({ ...BASE, maxPrice: 50 });
    await facebook.search({ ...BASE, showSold: true });
    await facebook.search({ ...BASE, location: 'oakland' });

    expect(mock).toHaveBeenCalledTimes(4);
  });

  it('keeps the cache to one instance', async () => {
    const { mock } = stubFetch(() => json(searchBody([item()])));

    await new FacebookMarketplace().search(BASE);
    await new FacebookMarketplace().search(BASE);

    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('refetches once the cached entry ages out', async () => {
    vi.useFakeTimers();
    const { mock } = stubFetch(() => json(searchBody([item()])));
    const facebook = new FacebookMarketplace();

    await facebook.search(BASE);
    await vi.advanceTimersByTimeAsync(SEARCH_CACHE_TTL_MS - 1_000);
    await facebook.search(BASE);
    expect(mock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_001);
    await facebook.search(BASE);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed search', async () => {
    let failing = true;
    const { mock } = stubFetch(() =>
      failing ? json({ errors: [{ message: 'Rate limited' }] }) : json(searchBody([item()]))
    );
    const facebook = new FacebookMarketplace();

    expect((await facebook.search(BASE)).success).toBe(false);
    failing = false;
    expect((await facebook.search(BASE)).success).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('FacebookMarketplace.healthCheck', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is healthy when a known location resolves', async () => {
    const { mock } = stubFetch(() => json({}));
    await expect(new FacebookMarketplace().healthCheck()).resolves.toBe(true);
    // new york is in the offline table, so health never depends on Facebook.
    expect(mock).not.toHaveBeenCalled();
  });

  it('reports unhealthy rather than throwing when lookup blows up', async () => {
    stubFetch(() => { throw new Error('proxy exploded'); });
    const fb = new FacebookMarketplace();
    vi.spyOn(fb as any, 'resolveLocation').mockRejectedValue(new Error('proxy exploded'));
    await expect(fb.healthCheck()).resolves.toBe(false);
  });

  it('reports unhealthy when the location cannot be resolved at all', async () => {
    const fb = new FacebookMarketplace();
    vi.spyOn(fb as any, 'resolveLocation').mockResolvedValue(null);
    await expect(fb.healthCheck()).resolves.toBe(false);
  });
});

describe('FacebookMarketplace search cache eviction', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('evicts the oldest entry once the cache is full', async () => {
    stubFetch(() => json(searchBody([item()])));
    const fb = new FacebookMarketplace();
    const cache = (fb as any).searchCache as Map<string, unknown>;

    for (let i = 0; i <= 200; i++) {
      await fb.search({ ...BASE, query: `bike ${i}` });
    }

    expect(cache.size).toBeLessThanOrEqual(200);
    expect([...cache.keys()].some((k) => k.includes('"bike 0"'))).toBe(false);
    expect([...cache.keys()].some((k) => k.includes('"bike 200"'))).toBe(true);
  });
});

describe('FacebookMarketplace resilience', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('skips a listing that cannot be parsed instead of failing the search', async () => {
    // A numeric title survives `|| ''` and then throws on .toUpperCase().
    const malformed = { id: '2', marketplace_listing_title: 12345 };
    stubFetch(() => json(searchBody([item(), malformed, item({ id: '3' })])));

    const result = await new FacebookMarketplace().search(BASE);

    expect(result.success).toBe(true);
    expect(result.listings.map((l) => l.id)).toEqual(['1', '3']);
  });

  it('returns no coordinates when the location lookup itself throws', async () => {
    stubFetch(() => { throw new Error('socket hung up'); });
    // Non-US so it does not short-circuit on the offline table.
    const coords = await new FacebookMarketplace().getLocation('reykjavik iceland');
    expect(coords).toBeNull();
  });
});
