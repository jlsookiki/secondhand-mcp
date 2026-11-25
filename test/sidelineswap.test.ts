import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEADLINE_MS, SidelineSwapMarketplace, combinedTotal, exactTotal, soldOffset, wireObject } from '../src/marketplaces/sidelineswap/index.js';
import { listingIdFrom } from '../src/marketplaces/sidelineswap/parse.js';
import { searchQuery } from '../src/marketplaces/sidelineswap/query.js';
import type { Item } from '../src/marketplaces/sidelineswap/wire.js';

function fixture(name: 'search' | 'details') {
  return JSON.parse(readFileSync(new URL(`./fixtures/sidelineswap-${name}.json`, import.meta.url), 'utf8'));
}

const mask = (): Item => fixture('search').data[2];

function page(rows: unknown[], number = 1, hasNext = false) {
  return { data: rows, meta: { paging: { page: number, has_next_page: hasNext, total_count: rows.length, total_count_truncated: false } } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let sidelineswap: SidelineSwapMarketplace;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  sidelineswap = new SidelineSwapMarketplace();
});

/** Hands the test the search deadline so it can expire it at a chosen moment; per-request timeouts stay real. */
function controlDeadline(): AbortController {
  const deadline = new AbortController();
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === SEARCH_DEADLINE_MS ? deadline.signal : realTimeout(ms)));
  return deadline;
}

function expire(deadline: AbortController) {
  deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
}

function pendingUntilAborted(init: RequestInit | undefined): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  });
}

const requestedPages = () => fetchMock.mock.calls.map(([url]) => (url as URL).searchParams.get('page'));

describe('searchQuery', () => {
  it('maps supported filters onto storefront parameters', () => {
    const query = searchQuery(
      { query: 'bauer 950', minPrice: 100, maxPrice: 500, condition: 'used', category: '110030', sort: 'price_low_to_high' },
      2,
      'available'
    );
    expect(Object.fromEntries(query)).toMatchObject({
      q: 'bauer 950', page: '2', page_size: '50', sort: 'price_asc', min_price: '100', max_price: '500',
      'condition[]': '17', 'category[]': '110030',
    });
    expect(query.getAll('state[]')).toEqual(['available']);
  });

  it('asks for one listing state at a time', () => {
    expect(searchQuery({ query: 'bat', showSold: true }, 1, 'sold').getAll('state[]')).toEqual(['sold']);
  });

  it('ignores filters SidelineSwap cannot apply', () => {
    const query = searchQuery(
      { query: 'bat', condition: 'like_new', sort: 'most_popular', category: 'Bats', brand: 'Easton', sizes: ['32'], colors: ['red'] },
      1,
      'available'
    );
    expect([...query.keys()].sort()).toEqual(['page', 'page_size', 'q', 'sort', 'state[]']);
    expect(query.get('sort')).toBe('relevancy_desc');
  });
});

describe('exactTotal', () => {
  it('reports the count only when SidelineSwap has not capped it', () => {
    expect(exactTotal({ total_count: 7, total_count_truncated: false })).toBe(7);
    expect(exactTotal({ total_count: 10_000, total_count_truncated: true })).toBeUndefined();
    expect(exactTotal(undefined)).toBeUndefined();
  });
});

describe('wireObject', () => {
  it('accepts only JSON objects', () => {
    expect(wireObject({ data: [] })).toEqual({ data: [] });
    expect(wireObject(null)).toBeUndefined();
    expect(wireObject([])).toBeUndefined();
    expect(wireObject('changed')).toBeUndefined();
  });
});

describe('soldOffset', () => {
  it('starts sold items where the offset passes the available ones', () => {
    expect(soldOffset(10, 53)).toBe(0);
    expect(soldOffset(60, 53)).toBe(7);
  });
});

describe('combinedTotal', () => {
  it('adds the two totals only when both are exact', () => {
    expect(combinedTotal(53, 400)).toBe(453);
    expect(combinedTotal(53, undefined)).toBeUndefined();
    expect(combinedTotal(undefined, 400)).toBeUndefined();
  });
});

describe('listingIdFrom', () => {
  it.each([
    ['12549997', '12549997'],
    ['https://sidelineswap.com/gear/hockey/goalie/goalie-masks/12549997-bauer-mask', '12549997'],
    ['https://sidelineswap.com/gear/12549997/', '12549997'],
  ])('reads %s', (input, id) => {
    expect(listingIdFrom(input)).toBe(id);
  });

  it.each(['https://evil.test/gear/12549997', 'http://sidelineswap.com/gear/12549997', '../secret', 'abc', '0'])(
    'rejects %s',
    (input) => {
      expect(listingIdFrom(input)).toBeUndefined();
    }
  );
});

describe('SidelineSwap search', () => {
  it('turns storefront items into USD listings', async () => {
    fetchMock.mockResolvedValue(json(fixture('search')));
    const result = await sidelineswap.search({ query: 'bauer 950' });

    expect(result).toMatchObject({ success: true, totalFound: 7 });
    expect(result.listings.map((l) => l.priceNumeric)).toEqual([107, 200, 270]);
    expect(result.listings[2]).toMatchObject({
      id: '12475475', price: '$270.00', currency: 'USD', condition: 'Used', seller: 'fixture_seller',
      url: 'https://sidelineswap.com/gear/hockey/goalie/goalie-masks/12475475-bauer-senior-medium-950-goalie-mask-used',
    });
    expect(result.listings[2].images).toHaveLength(1);
  });

  it('marks sold listings in the title', async () => {
    fetchMock.mockResolvedValue(json(page([{ ...mask(), state: 'sold' }])));
    const [listing] = (await sidelineswap.search({ query: 'mask', showSold: true })).listings;
    expect(listing.title).toMatch(/\[Sold\]$/);
  });

  it('lists available items before sold ones when sold are included', async () => {
    const available = [{ ...mask(), id: 1 }, { ...mask(), id: 2 }];
    const sold = [{ ...mask(), id: 3, state: 'sold' }, { ...mask(), id: 4, state: 'sold' }, { ...mask(), id: 5, state: 'sold' }];
    fetchMock.mockImplementation((url: URL) => {
      const states = url.searchParams.getAll('state[]');
      return Promise.resolve(json(page(states.includes('available') && !states.includes('sold') ? available : sold)));
    });

    const result = await sidelineswap.search({ query: 'bauer 950', showSold: true, limit: 4 });

    expect(result.listings.map((l) => l.id)).toEqual(['1', '2', '3', '4']);
    expect(result.totalFound).toBe(5);
  });

  it('continues into sold items past the end of the available ones', async () => {
    const available = [{ ...mask(), id: 1 }, { ...mask(), id: 2 }];
    const sold = [{ ...mask(), id: 3, state: 'sold' }, { ...mask(), id: 4, state: 'sold' }, { ...mask(), id: 5, state: 'sold' }];
    fetchMock.mockImplementation((url: URL) => {
      const states = url.searchParams.getAll('state[]');
      return Promise.resolve(json(page(states.includes('available') && !states.includes('sold') ? available : sold)));
    });

    const result = await sidelineswap.search({ query: 'bauer 950', showSold: true, offset: 3, limit: 4 });

    expect(result.listings.map((l) => l.id)).toEqual(['4', '5']);
  });

  it('leaves out price fields when an item has no price', async () => {
    fetchMock.mockResolvedValue(json(page([{ id: 12, name: 'Catcher chest protector' }])));
    const [listing] = (await sidelineswap.search({ query: 'catcher' })).listings;
    expect(listing).toMatchObject({ price: 'Price not listed', url: 'https://sidelineswap.com/gear/12', images: [] });
    expect(listing.priceNumeric).toBeUndefined();
  });

  it('skips rows without an id or name', async () => {
    fetchMock.mockResolvedValue(json(page([null, {}, { id: 5 }, mask()])));
    expect((await sidelineswap.search({ query: 'mask' })).listings.map((l) => l.id)).toEqual(['12475475']);
  });

  it('starts at the offset and pages until the limit is filled', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...mask(), id: 1000 + i }));
    fetchMock
      .mockResolvedValueOnce(json(page(rows, 2, true)))
      .mockResolvedValueOnce(json(page([{ ...mask(), id: 1050 }, { ...mask(), id: 1051 }], 3)));

    const result = await sidelineswap.search({ query: 'catcher gear', offset: 99, limit: 2 });

    expect(result.listings.map((l) => l.id)).toEqual(['1049', '1050']);
    expect(requestedPages()).toEqual(['2', '3']);
  });

  it('stops when a page brings nothing new', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(page([mask()], 1, true))));
    const result = await sidelineswap.search({ query: 'mask', limit: 5 });
    expect(result.note).toBeUndefined();
    expect(result.listings).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests at most ten pages', async () => {
    fetchMock.mockImplementation((url: URL) => {
      const number = Number(url.searchParams.get('page'));
      return Promise.resolve(json(page([{ ...mask(), id: number }], number, true)));
    });
    const result = await sidelineswap.search({ query: 'bat', limit: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(result.listings).toHaveLength(10);
  });

  it('keeps earlier pages when a later page fails', async () => {
    fetchMock.mockResolvedValueOnce(json(page([mask()], 1, true))).mockResolvedValueOnce(json({}, 429));
    const result = await sidelineswap.search({ query: 'mask', limit: 3 });
    expect(result).toMatchObject({ success: true, note: 'Later pages failed: Error: SidelineSwap returned 429' });
    expect(result.listings).toHaveLength(1);
  });

  it('keeps the first page when the search deadline passes during a later page', async () => {
    const deadline = controlDeadline();
    fetchMock
      .mockResolvedValueOnce(json(page([mask()], 1, true)))
      .mockImplementationOnce((_url: URL, init?: RequestInit) => pendingUntilAborted(init));

    const searching = sidelineswap.search({ query: 'mask', limit: 3 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expire(deadline);
    const result = await searching;

    expect(result.success).toBe(true);
    expect(result.listings.map((l) => l.id)).toEqual(['12475475']);
    expect(result.note).toMatch(/^Later pages failed/);
  });

  it('fails when the search deadline passes before the first page arrives', async () => {
    const deadline = controlDeadline();
    fetchMock.mockImplementationOnce((_url: URL, init?: RequestInit) => pendingUntilAborted(init));

    const searching = sidelineswap.search({ query: 'mask' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expire(deadline);
    const result = await searching;

    expect(result.success).toBe(false);
    expect(result.error).toContain('SidelineSwap search failed');
  });

  it.each([
    ['an HTTP error', () => json({}, 403), 'SidelineSwap returned 403'],
    ['a changed response', () => json({ data: 'changed' }), 'unexpected search response'],
    ['an empty body', () => json(null), 'unexpected search response'],
    ['an HTML block page', () => new Response('<html>blocked</html>'), 'SidelineSwap search failed'],
  ])('reports %s', async (_label, reply, message) => {
    fetchMock.mockResolvedValue(reply());
    const result = await sidelineswap.search({ query: 'mask' });
    expect(result.success).toBe(false);
    expect(result.error).toContain(message);
  });
});

describe('SidelineSwap details', () => {
  it('lists price, status, attributes, model and the seller description', async () => {
    const item = fixture('details').data;
    fetchMock.mockResolvedValue(json(fixture('details')));

    const details = await sidelineswap.getListingDetails('12549997');

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.sidelineswap.com/v1/items/12549997');
    expect(details.images).toHaveLength(3);
    expect(details.description).toContain(`Price: $${item.price.toFixed(2)}`);
    expect(details.description).toContain('Status: sold');
    expect(details.description).toContain('Size: Medium');
    expect(details.description).toContain('Model: Bauer 950 Goalie Mask');
    expect(details.description).toContain(item.description);
    expect(details.unavailable).toBeUndefined();
  });

  it('opens the description with the listing name, which research fetch shows as the title', async () => {
    const item = fixture('details').data;
    fetchMock.mockResolvedValue(json(fixture('details')));
    const details = await sidelineswap.getListingDetails('12549997');
    expect(details.description?.split('\n')[0]).toBe(item.name);
  });

  it('starts with the price when the listing has no name', async () => {
    fetchMock.mockResolvedValue(json({ data: { id: 12, price: 40 } }));
    const details = await sidelineswap.getListingDetails('12');
    expect(details.description).toBe('Price: $40.00');
  });

  it('accepts a listing URL', async () => {
    fetchMock.mockResolvedValue(json(fixture('details')));
    const details = await sidelineswap.getListingDetails('https://sidelineswap.com/gear/hockey/goalie/goalie-masks/12549997-x');
    expect(details.id).toBe('12549997');
  });

  it('rejects an unrecognised id without a request', async () => {
    await expect(sidelineswap.getListingDetails('https://evil.test/gear/1')).rejects.toThrow('listing IDs are numbers');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not report a listing without a description or photos as failing to load', async () => {
    fetchMock.mockResolvedValue(json({ data: { id: 12, name: 'Bat', state: 'available', details: [{ name: 'Length', values: [{ name: '32 inches' }] }, { name: 'Empty', values: [{}] }] } }));
    const details = await sidelineswap.getListingDetails('12');
    expect(details.unavailable).toBeUndefined();
    expect(details.images).toEqual([]);
    expect(details.description).toBe('Bat\nPrice: not listed\nStatus: available\nLength: 32 inches');
  });

  it('keeps https photos once each, largest size first', async () => {
    fetchMock.mockResolvedValue(json({ data: {
      id: 12, name: 'Bat', url: 'javascript:bad',
      images: [null, {}, { large_url: 'javascript:bad' }, { edge_url: 'https://images.sidelineswap.com/a' }, { small_url: 'https://images.sidelineswap.com/b' }],
      primary_image: { large_url: 'https://images.sidelineswap.com/a' },
    } }));
    const details = await sidelineswap.getListingDetails('12');
    expect(details.images).toEqual(['https://images.sidelineswap.com/a', 'https://images.sidelineswap.com/b']);
    expect(details.url).toBe('https://sidelineswap.com/gear/12');
  });

  it.each([{}, null, 'changed', [], { data: null }, { data: { id: 99, name: 'Wrong item' } }])('treats a mismatched reply as not found', async (body) => {
    fetchMock.mockResolvedValue(json(body));
    await expect(sidelineswap.getListingDetails('12549997')).rejects.toThrow('not found');
  });

  it('passes on HTTP errors', async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    await expect(sidelineswap.getListingDetails('12')).rejects.toThrow('SidelineSwap returned 404');
  });
});
