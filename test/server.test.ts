import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing, ListingDetails, SearchParams, SearchResult } from '../src/types.js';

type SearchImpl = (params: SearchParams) => Promise<SearchResult> | SearchResult;
type DetailsImpl = (id: string) => Promise<ListingDetails> | ListingDetails;

const h = vi.hoisted(() => {
  const searchCalls: Array<{ marketplace: string; params: any }> = [];
  const detailCalls: Array<{ marketplace: string; id: string }> = [];
  const resizeCalls: Array<[string, number]> = [];
  const impl: Record<string, { search?: (p: any) => any; details?: (id: string) => any }> = {};

  const entry = (name: string, displayName: string, requiresAuth: boolean, withDetails: boolean) => {
    const mp: any = {
      name,
      displayName,
      requiresAuth,
      async search(params: any) {
        searchCalls.push({ marketplace: name, params });
        const fn = impl[name]?.search;
        if (!fn) return { marketplace: name, success: true, listings: [] };
        return fn(params);
      },
      async healthCheck() {
        return true;
      },
    };
    if (withDetails) {
      mp.getListingDetails = async (id: string) => {
        detailCalls.push({ marketplace: name, id });
        const fn = impl[name]?.details;
        if (!fn) throw new Error(`no details stub registered for ${name}`);
        return fn(id);
      };
    }
    return mp;
  };

  const registry = new Map<string, any>([
    ['facebook', entry('facebook', 'Facebook Marketplace', false, true)],
    ['ebay', entry('ebay', 'eBay', true, true)],
    ['depop', entry('depop', 'Depop', false, true)],
    ['poshmark', entry('poshmark', 'Poshmark', false, true)],
    ['craigslist', entry('craigslist', 'Craigslist', false, false)],
  ]);

  return {
    searchCalls,
    detailCalls,
    resizeCalls,
    impl,
    registry,
    reset() {
      searchCalls.length = 0;
      detailCalls.length = 0;
      resizeCalls.length = 0;
      for (const key of Object.keys(impl)) delete impl[key];
    },
  };
});

const link = vi.hoisted(() => ({ clientTransport: null as any }));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  return {
    StdioServerTransport: class {
      constructor() {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        link.clientTransport = clientSide;
        return serverSide as any;
      }
    },
  };
});

vi.mock('../src/marketplaces/index.js', () => ({
  initializeMarketplaces: () => {},
  registerMarketplace: () => {},
  getMarketplace: (name: string) => h.registry.get(name),
  getAllMarketplaces: () => [...h.registry.values()],
  listMarketplaceNames: () => [...h.registry.keys()],
  resizeEbayImageUrl: (url: string, px: number) => {
    h.resizeCalls.push([url, px]);
    return `${url}#${px}`;
  },
  FacebookMarketplace: class {},
  EbayMarketplace: class {},
  DepopMarketplace: class {},
  PoshmarkMarketplace: class {},
  BaseMarketplace: class {},
}));

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = { content: Block[]; isError?: boolean };

let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

const textOf = (res: ToolResult) =>
  res.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const jsonOf = (res: ToolResult) => JSON.parse(textOf(res));

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 'l1',
  title: 'Blue Chair',
  price: '$50',
  priceNumeric: 50,
  url: 'https://example.com/l1',
  marketplace: 'facebook',
  scrapedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const ok = (marketplace: string, listings: Listing[]): SearchResult => ({
  marketplace,
  success: true,
  listings,
});

const details = (over: Partial<ListingDetails> = {}): ListingDetails => ({
  id: 'l1',
  images: [],
  url: 'https://example.com/l1',
  ...over,
});

const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x42];
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString('base64');
const jpegResponse = () =>
  new Response(new Uint8Array(JPEG_BYTES), { status: 200, headers: { 'content-type': 'image/jpeg' } });

beforeAll(async () => {
  await import('../src/index.js');
  await new Promise((resolve) => setImmediate(resolve));
  client = new Client({ name: 'server-test', version: '1.0.0' });
  await client.connect(link.clientTransport);
});

beforeEach(() => {
  h.reset();
});

describe('initialize', () => {
  it('reports the server identity', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    expect(client.getServerVersion()).toEqual({ name: 'secondhand-mcp', version: pkg.version });
  });

  it('advertises tool capability', () => {
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('sends usage instructions to the client', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('"City, ST"');
    expect(instructions).toContain('near me');
    expect(instructions).toContain('read-only');
    expect(instructions.split('\n\n').length).toBeGreaterThan(3);
  });
});

describe('tools/list', () => {
  it('exposes exactly the five documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'search_marketplace',
      'get_listing_details',
      'list_marketplaces',
      'search',
      'fetch',
    ]);
  });

  it('declares every required argument in its own properties block', async () => {
    const { tools } = await client.listTools();
    const required = Object.fromEntries(
      tools.map((t) => [t.name, (t.inputSchema as { required?: string[] }).required ?? []]),
    );
    expect(required).toEqual({
      search_marketplace: ['query'],
      get_listing_details: ['listingId'],
      list_marketplaces: [],
      search: ['query'],
      fetch: ['id'],
    });
    for (const tool of tools) {
      const schema = tool.inputSchema as { type: string; properties?: Record<string, unknown> };
      expect(schema.type).toBe('object');
      expect(tool.description ?? '').not.toBe('');
      expect(Object.keys(schema.properties ?? {})).toEqual(
        expect.arrayContaining(required[tool.name]),
      );
    }
  });

  it('derives the marketplace list in search_marketplace from the registry', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'search_marketplace')!;
    const names = [...h.registry.keys()].join(', ');
    expect(tool.description).toContain(names);
    expect((tool.inputSchema.properties as any).marketplace.description).toContain(`${names}, or "all"`);
  });

  it('documents search_marketplace defaults matching the handler fallbacks', async () => {
    const { tools } = await client.listTools();
    const props = tools.find((t) => t.name === 'search_marketplace')!.inputSchema.properties as Record<string, any>;
    expect(props.marketplace.default).toBe('facebook');
    expect(props.location.default).toBe('san francisco');
    expect(props.limit.default).toBe(20);
    expect(props.offset.default).toBe(0);
    expect(props.showSold.default).toBe(false);
    expect(props.includeImages.default).toBe(false);
    expect(props.sizes).toEqual({ type: 'array', items: { type: 'string' }, description: expect.any(String) });
    expect(tools.find((t) => t.name === 'search_marketplace')!.inputSchema.required).toEqual(['query']);
  });

  it('constrains the get_listing_details image options', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_listing_details')!;
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(tool.inputSchema.required).toEqual(['listingId']);
    expect(props.imageMode.enum).toEqual(['urls', 'inline']);
    expect(props.imageMode.default).toBe('urls');
    expect(props.imageSize.enum).toEqual(['thumb', 'standard', 'full']);
    expect(props.maxImages.type).toBe('number');
  });

  it('keeps search and fetch to the single-string deep-research contract', async () => {
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'search')!;
    const fetchTool = tools.find((t) => t.name === 'fetch')!;
    expect(Object.keys(search.inputSchema.properties as object)).toEqual(['query']);
    expect(search.inputSchema.required).toEqual(['query']);
    expect(Object.keys(fetchTool.inputSchema.properties as object)).toEqual(['id']);
    expect(fetchTool.inputSchema.required).toEqual(['id']);
    expect(fetchTool.description).toContain('marketplace:listingId');
  });

  it('takes no arguments for list_marketplaces', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'list_marketplaces')!;
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool.inputSchema.required).toBeUndefined();
  });
});

describe('search_marketplace arguments', () => {
  it('applies the documented defaults before calling the marketplace', async () => {
    h.impl.facebook = { search: () => ok('facebook', []) };
    await call('search_marketplace', { query: 'chair' });
    expect(h.searchCalls).toEqual([
      {
        marketplace: 'facebook',
        params: { query: 'chair', location: 'san francisco', limit: 20, offset: 0, showSold: false },
      },
    ]);
  });

  it('forwards every supplied filter untouched', async () => {
    h.impl.depop = { search: () => ok('depop', []) };
    await call('search_marketplace', {
      query: 'levis',
      marketplace: 'depop',
      location: 'Austin, TX',
      minPrice: 10,
      maxPrice: 90,
      limit: 5,
      offset: 40,
      showSold: true,
      sort: 'newest',
      condition: 'like_new',
      category: 'bottoms',
      brand: "Levi's",
      department: 'Men',
      sizes: ['M', 'L'],
      colors: ['blue'],
    });
    expect(h.searchCalls[0]).toEqual({
      marketplace: 'depop',
      params: {
        query: 'levis',
        location: 'Austin, TX',
        minPrice: 10,
        maxPrice: 90,
        limit: 5,
        offset: 40,
        showSold: true,
        sort: 'newest',
        condition: 'like_new',
        category: 'bottoms',
        brand: "Levi's",
        department: 'Men',
        sizes: ['M', 'L'],
        colors: ['blue'],
      },
    });
  });

  it('turns limit 0 into the default 20 while keeping offset 0', async () => {
    h.impl.facebook = { search: () => ok('facebook', []) };
    await call('search_marketplace', { query: 'chair', limit: 0, offset: 0 });
    expect(h.searchCalls[0].params.limit).toBe(20);
    expect(h.searchCalls[0].params.offset).toBe(0);
  });

  it('rejects a missing query instead of searching for undefined', async () => {
    h.impl.facebook = { search: () => ok('facebook', []) };
    const res = await call('search_marketplace', {});
    expect(h.searchCalls).toEqual([]);
    expect(res.isError).toBe(true);
  });

  it('reports an unknown marketplace with the available names', async () => {
    const res = await call('search_marketplace', { query: 'chair', marketplace: 'etsy' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'Unknown marketplace: etsy. Available: facebook, ebay, depop, poshmark, craigslist',
    );
    expect(h.searchCalls).toEqual([]);
  });
});

describe('search_marketplace results', () => {
  it('sorts listings by numeric price and shows photo counts', async () => {
    h.impl.facebook = {
      search: () =>
        ok('facebook', [
          listing({ id: 'b', title: 'Pricey', price: '$300', priceNumeric: 300, images: ['x', 'y'] }),
          listing({ id: 'a', title: 'Cheap', price: '$20', priceNumeric: 20, location: 'Oakland, CA', images: ['z'] }),
        ]),
    };
    const text = textOf(await call('search_marketplace', { query: 'chair', location: 'Oakland, CA' }));
    expect(text).toContain('🔍 Found 2 listings for "chair" on facebook');
    expect(text).toContain('📍 Location: Oakland, CA');
    expect(text.indexOf('Cheap')).toBeLessThan(text.indexOf('Pricey'));
    expect(text).toContain('   🆔 a');
    expect(text).toContain('📷 1 photo\n');
    expect(text).toContain('📷 2 photos');
    expect(text).not.toContain('🖼️ Images');
  });

  it('prints image URLs only when includeImages is set', async () => {
    h.impl.facebook = { search: () => ok('facebook', [listing({ images: ['https://cdn/1.jpg'] })]) };
    const text = textOf(await call('search_marketplace', { query: 'chair', includeImages: true }));
    expect(text).toContain('🖼️ Images: https://cdn/1.jpg');
    expect(text).not.toContain('📷 1 photo');
  });

  it('says nothing was found rather than printing an empty list', async () => {
    h.impl.facebook = { search: () => ok('facebook', []) };
    const res = await call('search_marketplace', { query: 'unobtainium', location: 'Reno, NV' });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('No listings found for "unobtainium" in Reno, NV');
  });

  it('renders a marketplace-reported failure without flagging a tool error', async () => {
    h.impl.ebay = { search: () => ({ marketplace: 'ebay', success: false, listings: [], error: 'rate limited' }) };
    const res = await call('search_marketplace', { query: 'chair', marketplace: 'ebay' });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('❌ ebay: rate limited');
  });

  it('returns an error result when the marketplace throws', async () => {
    h.impl.ebay = {
      search: () => {
        throw new Error('boom');
      },
    };
    const res = await call('search_marketplace', { query: 'chair', marketplace: 'ebay' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Error searching eBay: Error: boom');
  });

  it('fans out to every marketplace for "all" and isolates one failure', async () => {
    h.impl.facebook = { search: () => ok('facebook', [listing({ title: 'Chair A' })]) };
    h.impl.ebay = {
      search: () => {
        throw new Error('no creds');
      },
    };
    const res = await call('search_marketplace', { query: 'chair', marketplace: 'all' });
    expect(h.searchCalls.map((c) => c.marketplace)).toEqual([
      'facebook',
      'ebay',
      'depop',
      'poshmark',
      'craigslist',
    ]);
    const text = textOf(res);
    expect(res.isError).toBeUndefined();
    expect(text).toContain('## facebook');
    expect(text).toContain('Found 1 listings:');
    expect(text).toContain('## ebay');
    expect(text).toContain('❌ Error: Error: no creds');
    expect(text).toContain('## depop\nNo listings found');
  });

  it('caps each marketplace at its ten cheapest listings in "all" mode', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      listing({ id: `id${i}`, title: `Item ${i}`, price: `$${100 - i}`, priceNumeric: 100 - i }),
    );
    h.impl.facebook = { search: () => ok('facebook', many) };
    const text = textOf(await call('search_marketplace', { query: 'chair', marketplace: 'all' }));
    expect(text).toContain('Found 12 listings:');
    expect(text).toContain('🆔 id11');
    expect(text).not.toContain('🆔 id1\n');
    expect(text).not.toContain('🆔 id0');
  });
});

describe('get_listing_details', () => {
  it('rejects a missing listingId', async () => {
    const res = await call('get_listing_details', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Missing required parameter: listingId');
    expect(h.detailCalls).toEqual([]);
  });

  it.each(['ebay', 'depop', 'poshmark', 'facebook'])('routes %s ids to that marketplace', async (name) => {
    h.impl[name] = { details: () => details({ url: `https://${name}/1` }) };
    await call('get_listing_details', { listingId: '1', marketplace: name });
    expect(h.detailCalls).toEqual([{ marketplace: name, id: '1' }]);
  });

  it('defaults to facebook when no marketplace is given', async () => {
    h.impl.facebook = { details: () => details() };
    await call('get_listing_details', { listingId: 'abc' });
    expect(h.detailCalls).toEqual([{ marketplace: 'facebook', id: 'abc' }]);
  });

  it('rejects an unknown marketplace instead of answering from facebook', async () => {
    h.impl.facebook = { details: () => details({ url: 'https://facebook/1' }) };
    const res = await call('get_listing_details', { listingId: '1', marketplace: 'etsy' });
    expect(h.detailCalls).toEqual([]);
    expect(res.isError).toBe(true);
  });

  it('renders the listing body without image fetching by default', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    h.impl.ebay = {
      details: () =>
        details({
          description: 'Solid oak desk',
          location: 'Austin, TX',
          seller: 'woodshop',
          deliveryTypes: ['pickup', 'shipping'],
          isShippingOffered: true,
          images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
          url: 'https://ebay/1',
        }),
    };
    const text = textOf(await call('get_listing_details', { listingId: '1', marketplace: 'ebay' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain('🔗 https://ebay/1');
    expect(text).toContain('**Description:** Solid oak desk');
    expect(text).toContain('👤 Seller: woodshop');
    expect(text).toContain('🚚 Delivery: pickup, shipping');
    expect(text).toContain('📦 Shipping available');
    expect(text).toContain('🖼️ Photos (2, full) — full-resolution CDN URLs');
    expect(text).toContain('1. https://cdn/1.jpg#1600');
    expect(text).toContain('![Photo 2](https://cdn/2.jpg#1600)');
  });

  it.each([
    ['thumb', 400],
    ['standard', 800],
    ['full', 1600],
  ] as const)('asks the resizer for %s at %ipx', async (imageSize, px) => {
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg'] }) };
    const text = textOf(
      await call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageSize }),
    );
    expect(h.resizeCalls).toEqual([['https://cdn/1.jpg', px]]);
    expect(text).toContain(`(1, ${imageSize})`);
  });

  it.each([
    ['urls', 1600],
    ['inline', 800],
  ] as const)('defaults %s mode to %ipx when no imageSize is given', async (imageMode, px) => {
    vi.stubGlobal('fetch', vi.fn(async () => jpegResponse()));
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg'] }) };
    await call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode });
    expect(h.resizeCalls).toEqual([['https://cdn/1.jpg', px]]);
  });

  it('caps photos with maxImages and reports the total', async () => {
    h.impl.ebay = { details: () => details({ images: ['a', 'b', 'c', 'd'] }) };
    const text = textOf(await call('get_listing_details', { listingId: '1', marketplace: 'ebay', maxImages: 2 }));
    expect(text).toContain('🖼️ Photos (2 of 4, full)');
    expect(text).toContain('2. b#1600');
    expect(text).not.toContain('c#1600');
  });

  it('omits the photo section entirely when there are no images', async () => {
    h.impl.facebook = { details: () => details({ description: 'no pics' }) };
    const text = textOf(await call('get_listing_details', { listingId: '1' }));
    expect(text).not.toContain('🖼️');
    expect(text).toContain('**Description:** no pics');
  });

  it('returns base64 image blocks for the deprecated includeImages alias', async () => {
    const fetchMock = vi.fn(async () => jpegResponse());
    vi.stubGlobal('fetch', fetchMock);
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] }) };

    const res = await call('get_listing_details', { listingId: '1', marketplace: 'ebay', includeImages: true });

    expect(fetchMock.mock.calls.map((c: any[]) => c[0])).toEqual(['https://cdn/1.jpg#800', 'https://cdn/2.jpg#800']);
    const init = (fetchMock.mock.calls[0] as any[])[1];
    expect(init.headers['User-Agent']).toContain('Mozilla/5.0');
    expect(init.headers.Referer).toBe('https://www.ebay.com/');
    expect(res.content.filter((c) => c.type === 'image')).toEqual([
      { type: 'image', data: JPEG_B64, mimeType: 'image/jpeg' },
      { type: 'image', data: JPEG_B64, mimeType: 'image/jpeg' },
    ]);
    expect(textOf(res)).toContain('🖼️ 2 of 2 photo(s) inline (standard)');
  });

  it('lets an explicit imageMode override includeImages', async () => {
    const fetchMock = vi.fn(async () => jpegResponse());
    vi.stubGlobal('fetch', fetchMock);
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg'] }) };
    const res = await call('get_listing_details', {
      listingId: '1',
      marketplace: 'ebay',
      includeImages: true,
      imageMode: 'urls',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.content.every((c) => c.type === 'text')).toBe(true);
  });

  it('lists the photos it could not fetch alongside the ones it could', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('https://cdn/2')
        ? new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } })
        : jpegResponse(),
    );
    vi.stubGlobal('fetch', fetchMock);
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] }) };

    const res = await call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode: 'inline' });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(1);
    const text = textOf(res);
    expect(text).toContain('🖼️ 1 of 2 photo(s) inline (standard)');
    expect(text).toContain('1 photo(s) could not be fetched server-side');
    expect(text).toContain('https://cdn/2.jpg#800');
  });

  it('rejects a non-image body served with an image content-type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html><html>nope</html>', {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
      ),
    );
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg'] }) };
    const res = await call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode: 'inline' });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(textOf(res)).toContain('Server-side image fetch failed for all photos');
  });

  it('falls back to URLs when every inline fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] }) };
    const res = await call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode: 'inline' });
    const text = textOf(res);
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(text).toContain('⚠️ Server-side image fetch failed for all photos');
    expect(text).toContain('1. https://cdn/1.jpg#800');
    expect(text).toContain('2. https://cdn/2.jpg#800');
  });

  it('returns an error result when the marketplace throws', async () => {
    h.impl.facebook = {
      details: () => {
        throw new Error('gone');
      },
    };
    const res = await call('get_listing_details', { listingId: '1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Error fetching listing details: Error: gone');
  });
});

describe('list_marketplaces', () => {
  it('reports each registered marketplace and its auth requirement', async () => {
    const text = textOf(await call('list_marketplaces', {}));
    expect(text).toContain('• Facebook Marketplace (facebook) - No auth required');
    expect(text).toContain('• eBay (ebay) - Requires auth');
    expect(text.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(h.registry.size);
  });
});

describe('search (deep research)', () => {
  it('rejects a missing query', async () => {
    const res = await call('search', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Missing required parameter: query');
    expect(h.searchCalls).toEqual([]);
  });

  it('searches every marketplace with only a query and the hardcoded location', async () => {
    await call('search', { query: 'chair' });
    expect(h.searchCalls.map((c) => c.params)).toEqual(
      Array.from({ length: h.registry.size }, () => ({ query: 'chair', location: 'san francisco' })),
    );
  });

  it('returns prefixed ids and a summary line per listing', async () => {
    h.impl.ebay = {
      search: () =>
        ok('ebay', [
          listing({
            id: '99',
            title: 'Blue Chair',
            price: '$50',
            condition: 'Used',
            location: 'Oakland, CA',
            marketplace: 'ebay',
            url: 'https://ebay/99',
          }),
        ]),
    };
    const body = jsonOf(await call('search', { query: 'chair' }));
    expect(body).toEqual({
      results: [
        {
          id: 'ebay:99',
          title: 'Blue Chair',
          text: '$50 · Used · Oakland, CA · on ebay',
          url: 'https://ebay/99',
        },
      ],
    });
  });

  it.each([
    ['neither a condition nor a location', {}, '$50 · on facebook'],
    ['a location but no condition', { location: 'Oakland, CA' }, '$50 · Oakland, CA · on facebook'],
    ['a description', { description: 'barely used' }, '$50 · on facebook · barely used'],
  ] as const)('summarises a listing with %s', async (_label, over, text) => {
    h.impl.facebook = { search: () => ok('facebook', [listing({ id: '99', ...over })]) };
    const body = jsonOf(await call('search', { query: 'chair' }));
    expect(body.results.map((r: any) => r.text)).toEqual([text]);
  });

  it('keeps successful results and reports rejected marketplaces separately', async () => {
    h.impl.ebay = { search: () => ok('ebay', [listing({ id: '7', marketplace: 'ebay' })]) };
    h.impl.depop = {
      search: () => {
        throw new Error('chrome missing');
      },
    };
    const body = jsonOf(await call('search', { query: 'chair' }));
    expect(body.results.map((r: any) => r.id)).toEqual(['ebay:7']);
    expect(body.errors).toEqual(['Error: chrome missing']);
  });
});

describe('fetch (deep research)', () => {
  it.each([
    ['no colon', 'facebook12345'],
    ['empty string', ''],
  ])('rejects a malformed id with %s', async (_label, id) => {
    const res = await call('fetch', { id });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('id must be in format marketplace:listingId');
    expect(h.detailCalls).toEqual([]);
  });

  it('splits on the first colon so listing ids may contain colons', async () => {
    h.impl.ebay = { details: () => details({ url: 'https://ebay/x' }) };
    await call('fetch', { id: 'ebay:v1|123:456' });
    expect(h.detailCalls).toEqual([{ marketplace: 'ebay', id: 'v1|123:456' }]);
  });

  it('rejects an unknown marketplace prefix', async () => {
    const res = await call('fetch', { id: 'etsy:1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'Unknown marketplace or listing details unsupported: etsy. Available: facebook, ebay, depop, poshmark, craigslist',
    );
  });

  it('rejects a marketplace that cannot fetch details', async () => {
    const res = await call('fetch', { id: 'craigslist:1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('listing details unsupported: craigslist');
  });

  it('returns the deep-research document shape', async () => {
    h.impl.facebook = {
      details: () =>
        details({
          description: 'Blue chair, good condition\nPickup only',
          location: 'Oakland, CA',
          seller: 'jane',
          images: ['https://cdn/1.jpg'],
          deliveryTypes: ['pickup'],
          isShippingOffered: false,
          url: 'https://fb/99',
        }),
    };
    const body = jsonOf(await call('fetch', { id: 'facebook:99' }));
    expect(body).toEqual({
      id: 'facebook:99',
      title: 'Blue chair, good condition',
      text: 'Blue chair, good condition\nPickup only',
      url: 'https://fb/99',
      metadata: {
        marketplace: 'facebook',
        location: 'Oakland, CA',
        seller: 'jane',
        images: ['https://cdn/1.jpg'],
        deliveryTypes: ['pickup'],
        isShippingOffered: false,
      },
    });
  });

  it('truncates a long first line into the title', async () => {
    const first = 'x'.repeat(200);
    h.impl.ebay = { details: () => details({ description: `${first}\nmore` }) };
    const body = jsonOf(await call('fetch', { id: 'ebay:1' }));
    expect(body.title).toBe('x'.repeat(120));
    expect(body.text).toBe(`${first}\nmore`);
  });

  it('synthesises a title when the listing has no description', async () => {
    h.impl.ebay = { details: () => details({ url: 'https://ebay/1' }) };
    const body = jsonOf(await call('fetch', { id: 'ebay:1' }));
    expect(body.title).toBe('Listing 1 on ebay');
    expect(body.text).toBe('');
  });

  it('returns an error result when the marketplace throws', async () => {
    h.impl.ebay = {
      details: () => {
        throw new Error('404');
      },
    };
    const res = await call('fetch', { id: 'ebay:1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Error fetching listing details: Error: 404');
  });
});

describe('unknown tool', () => {
  it('reports the name it was asked for', async () => {
    const res = await call('teleport', {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('Unknown tool: teleport');
  });
});

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49];
const GIF_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00];
const WEBP_BYTES = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
];
const RIFF_WAVE_BYTES = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
];
const SHORT_JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00];

const bodyResponse = (bytes: number[], init: ResponseInit = {}) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' }, ...init });

const inlineOne = async (bytes: number[], init?: ResponseInit) => {
  vi.stubGlobal('fetch', vi.fn(async () => bodyResponse(bytes, init)));
  h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg'] }) };
  return call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode: 'inline' });
};

describe('inline image magic-byte sniffing', () => {
  it('accepts a PNG body', async () => {
    const res = await inlineOne(PNG_BYTES);
    expect(res.content.filter((c) => c.type === 'image')).toEqual([
      { type: 'image', data: Buffer.from(PNG_BYTES).toString('base64'), mimeType: 'image/png' },
    ]);
    expect(textOf(res)).toContain('🖼️ 1 of 1 photo(s) inline (standard)');
  });

  it('accepts a GIF body', async () => {
    const res = await inlineOne(GIF_BYTES, { headers: { 'content-type': 'image/gif' } });
    expect(res.content.filter((c) => c.type === 'image')).toEqual([
      { type: 'image', data: Buffer.from(GIF_BYTES).toString('base64'), mimeType: 'image/gif' },
    ]);
  });

  it('accepts a RIFF container whose form type is WEBP', async () => {
    const res = await inlineOne(WEBP_BYTES, { headers: { 'content-type': 'image/webp' } });
    expect(res.content.filter((c) => c.type === 'image')).toEqual([
      { type: 'image', data: Buffer.from(WEBP_BYTES).toString('base64'), mimeType: 'image/webp' },
    ]);
  });

  it('rejects a RIFF container that is not WEBP', async () => {
    const res = await inlineOne(RIFF_WAVE_BYTES, { headers: { 'content-type': 'image/webp' } });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(textOf(res)).toContain('⚠️ Server-side image fetch failed for all photos');
  });

  it('rejects a body one byte short of a PNG signature', async () => {
    const res = await inlineOne([0x89, 0x50, 0x4e, 0x48, ...PNG_BYTES.slice(4)]);
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(textOf(res)).toContain('⚠️ Server-side image fetch failed for all photos');
  });

  it('rejects a truncated body even when its first bytes are a valid signature', async () => {
    expect(SHORT_JPEG_BYTES).toHaveLength(11);
    const res = await inlineOne(SHORT_JPEG_BYTES, { headers: { 'content-type': 'image/jpeg' } });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(textOf(res)).toContain('⚠️ Server-side image fetch failed for all photos');
  });

  it('rejects image bytes served without a content-type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(PNG_BYTES), { status: 200 })));
    h.impl.ebay = { details: () => details({ images: ['https://cdn/1.jpg'] }) };
    const res = await call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode: 'inline' });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(textOf(res)).toContain('⚠️ Server-side image fetch failed for all photos');
  });

  it('rejects an error response before reading its body', async () => {
    const res = await inlineOne(PNG_BYTES, { status: 502 });
    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(textOf(res)).toContain('⚠️ Server-side image fetch failed for all photos');
    expect(textOf(res)).toContain('1. https://cdn/1.jpg#800');
  });
});

describe('inline image batching', () => {
  const pngFor = (n: number) => [...PNG_BYTES.slice(0, 12), n];

  it('fetches five at a time and returns the images in listing order', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://cdn/${i}.jpg`);
    const seen: string[] = [];
    let release!: () => void;
    const firstBatchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        if (seen.length <= 5) await firstBatchGate;
        return bodyResponse(pngFor(urls.indexOf(url.replace('#800', ''))));
      }),
    );
    h.impl.ebay = { details: () => details({ images: urls }) };

    const pending = call('get_listing_details', { listingId: '1', marketplace: 'ebay', imageMode: 'inline' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const midflight = [...seen];
    release();
    const res = await pending;

    expect(midflight).toEqual(urls.slice(0, 5).map((u) => `${u}#800`));
    expect(seen).toHaveLength(7);
    expect(res.content.filter((c) => c.type === 'image').map((c) => c.data)).toEqual(
      urls.map((_, i) => Buffer.from(pngFor(i)).toString('base64')),
    );
    expect(textOf(res)).toContain('🖼️ 7 of 7 photo(s) inline (standard)');
  });
});

describe('single-marketplace result formatting', () => {
  it('prints no photo line at all for a listing without images', async () => {
    h.impl.facebook = { search: () => ok('facebook', [listing({ images: undefined })]) };
    const text = textOf(await call('search_marketplace', { query: 'chair' }));
    expect(text).toContain('🆔 l1');
    expect(text).not.toContain('📷');
    expect(text).not.toContain('🖼️');
  });

  it('prints no photo line for a listing whose image array is empty', async () => {
    h.impl.facebook = { search: () => ok('facebook', [listing({ images: [] })]) };
    const text = textOf(await call('search_marketplace', { query: 'chair' }));
    expect(text).toContain('🆔 l1');
    expect(text).not.toContain('📷');
  });

  it('sorts a listing with no numeric price ahead of every priced one', async () => {
    h.impl.facebook = {
      search: () =>
        ok('facebook', [
          listing({ id: 'free', title: 'Free', price: 'Free', priceNumeric: undefined }),
          listing({ id: 'mid', title: 'Mid', priceNumeric: 40 }),
          listing({ id: 'top', title: 'Top', priceNumeric: 90 }),
          listing({ id: 'swap', title: 'Swap', price: 'Trade', priceNumeric: undefined }),
        ]),
    };
    const text = textOf(await call('search_marketplace', { query: 'chair' }));
    const order = ['Free', 'Swap', 'Mid', 'Top'].map((t) => text.indexOf(t));
    expect(Math.max(order[0], order[1])).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});

describe('all-marketplace result formatting', () => {
  it('pluralises the photo count and omits the line when a listing has none', async () => {
    h.impl.facebook = {
      search: () =>
        ok('facebook', [
          listing({ id: 'one', title: 'One Pic', priceNumeric: 10, images: ['a'] }),
          listing({ id: 'two', title: 'Two Pics', priceNumeric: 20, images: ['a', 'b'] }),
          listing({ id: 'none', title: 'No Pics', priceNumeric: 30 }),
          listing({ id: 'empty', title: 'Empty Album', priceNumeric: 40, images: [] }),
        ]),
    };
    const text = textOf(await call('search_marketplace', { query: 'chair', marketplace: 'all' }));
    expect(text).toContain('    📷 1 photo\n    🆔 one');
    expect(text).toContain('    📷 2 photos\n    🆔 two');
    expect(text).toContain('No Pics\n    🆔 none');
    expect(text).toContain('Empty Album\n    🆔 empty');
    expect(text).not.toContain('🖼️ Images');
  });

  it('prints image URLs instead of counts when includeImages is set', async () => {
    h.impl.facebook = {
      search: () => ok('facebook', [listing({ images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] })]),
    };
    const text = textOf(await call('search_marketplace', { query: 'chair', marketplace: 'all', includeImages: true }));
    expect(text).toContain('    🖼️ Images: https://cdn/1.jpg , https://cdn/2.jpg');
    expect(text).not.toContain('📷');
  });

  it('sorts a listing with no numeric price ahead of every priced one', async () => {
    h.impl.facebook = {
      search: () =>
        ok('facebook', [
          listing({ id: 'free', title: 'Free', price: 'Free', priceNumeric: undefined }),
          listing({ id: 'mid', title: 'Mid', priceNumeric: 40 }),
          listing({ id: 'top', title: 'Top', priceNumeric: 90 }),
          listing({ id: 'swap', title: 'Swap', price: 'Trade', priceNumeric: undefined }),
        ]),
    };
    const text = textOf(await call('search_marketplace', { query: 'chair', marketplace: 'all' }));
    const order = ['Free', 'Swap', 'Mid', 'Top'].map((t) => text.indexOf(t));
    expect(Math.max(order[0], order[1])).toBeLessThan(order[2]);
    expect(order[2]).toBeLessThan(order[3]);
    expect(order.every((i) => i >= 0)).toBe(true);
  });
});
