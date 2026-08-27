import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Page } from 'puppeteer-core';
import type { SearchParams } from '../src/types.js';

vi.mock('../src/browser.js', () => ({
  findChrome: vi.fn(),
  getBrowser: vi.fn(),
  newPage: vi.fn(),
  closeBrowser: vi.fn(),
  rotateBrowser: vi.fn(),
  withBrowserLock: vi.fn(),
}));

import { newPage, rotateBrowser, withBrowserLock } from '../src/browser.js';
import { DepopMarketplace } from '../src/marketplaces/depop.js';
import { PoshmarkMarketplace } from '../src/marketplaces/poshmark.js';

/** A node answers querySelector only for the selector strings it was built with. */
class El {
  parentElement: El | null = null;
  innerText: string;
  textContent: string;
  readonly kids: El[] = [];

  constructor(readonly sel: string[], readonly attrs: Record<string, string> = {}, text = '') {
    this.innerText = text;
    this.textContent = text;
  }

  get content(): string {
    return this.attrs.content ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  append(...kids: El[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.kids.push(k);
    }
    return this;
  }

  descendants(): El[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]);
  }

  querySelector(s: string): El | null {
    return this.descendants().find((n) => n.sel.includes(s)) ?? null;
  }

  querySelectorAll(s: string): El[] {
    return this.descendants().filter((n) => n.sel.includes(s));
  }

  closest(s: string): El | null {
    let n: El | null = this;
    while (n && !n.sel.includes(s)) n = n.parentElement;
    return n;
  }
}

const el = (sel: string | string[], attrs: Record<string, string> = {}, text = ''): El =>
  new El(Array.isArray(sel) ? sel : [sel], attrs, text);

interface PageOpts {
  status?: number;
  title?: string;
  roots?: El[];
  raw?: unknown;
  gotoError?: string;
}

function fakePage(opts: PageOpts = {}) {
  const page = {
    gotos: [] as string[],
    closes: 0,
    goto: vi.fn(async (url: string) => {
      page.gotos.push(url);
      if (opts.gotoError) throw new Error(opts.gotoError);
      return { status: () => opts.status ?? 200 };
    }),
    title: vi.fn(async () => opts.title ?? 'Search results'),
    waitForSelector: vi.fn(async () => null),
    evaluate: vi.fn(async (fn: () => unknown) => {
      if (opts.raw !== undefined) return opts.raw;
      const flat = (opts.roots ?? []).flatMap((r) => [r, ...r.descendants()]);
      vi.stubGlobal('document', {
        querySelectorAll: (s: string) => flat.filter((n) => n.sel.includes(s)),
        querySelector: (s: string) => flat.find((n) => n.sel.includes(s)) ?? null,
      });
      return fn();
    }),
    close: vi.fn(async () => {
      page.closes++;
    }),
  };
  return page;
}

type FakePage = ReturnType<typeof fakePage>;

function use(...pages: FakePage[]): void {
  const m = vi.mocked(newPage);
  for (const p of pages.slice(0, -1)) m.mockResolvedValueOnce(p as unknown as Page);
  m.mockResolvedValue(pages[pages.length - 1] as unknown as Page);
}

const HEX = '6512ab34cd56ef7890123456';
const HEX2 = 'aa11bb22cc33dd44ee55ff66';

function poshTile(
  href: string,
  opts: { alt?: string; src?: string; text?: string } = {},
): El {
  const img = el('img', {
    ...(opts.alt === undefined ? {} : { alt: opts.alt }),
    ...(opts.src === undefined ? {} : { src: opts.src }),
  });
  const a = el('a[href*="/listing/"]', { href }).append(img);
  return el('div', {}, opts.text ?? '').append(a);
}

function depopTile(
  href: string,
  opts: { alt?: string; src?: string; srcset?: string; text?: string; label?: string } = {},
): El {
  const img = el('img', {
    ...(opts.alt === undefined ? {} : { alt: opts.alt }),
    ...(opts.src === undefined ? {} : { src: opts.src }),
    ...(opts.srcset === undefined ? {} : { srcset: opts.srcset }),
  });
  const a = el('a[href*="/products/"]', {
    href,
    ...(opts.label === undefined ? {} : { 'aria-label': opts.label }),
  }).append(img);
  return el('li', {}, opts.text ?? '').append(a);
}

const poshSearch = async (params: SearchParams, opts: PageOpts) => {
  const page = fakePage(opts);
  use(page);
  const result = await new PoshmarkMarketplace().search(params);
  return { result, page };
};

const depopSearch = async (params: SearchParams, opts: PageOpts) => {
  const page = fakePage(opts);
  use(page);
  const result = await new DepopMarketplace().search(params);
  return { result, page };
};

const poshUrl = async (params: SearchParams) => {
  const { page } = await poshSearch(params, { raw: [] });
  return new URL(page.gotos[0]);
};

beforeEach(() => {
  // restoreMocks only touches vi.spyOn spies, so the factory mocks need a manual reset.
  vi.resetAllMocks();
  (withBrowserLock as unknown as Mock).mockImplementation((fn: () => Promise<unknown>) => fn());
  vi.mocked(rotateBrowser).mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('Poshmark search URL', () => {
  it('sets only query, type and src for an unfiltered search', async () => {
    const u = await poshUrl({ query: "levi's 501" });
    expect(u.origin + u.pathname).toBe('https://poshmark.com/search');
    expect([...u.searchParams.entries()]).toEqual([
      ['query', "levi's 501"],
      ['type', 'listings'],
      ['src', 'dir'],
    ]);
  });

  it.each([
    ['relevance', 'relevance'],
    ['newest', 'added_desc'],
    ['price_low_to_high', 'price_asc'],
    ['price_high_to_low', 'price_desc'],
    ['most_popular', 'like_count'],
  ] as const)('maps sort %s to sort_by=%s', async (sort, expected) => {
    const u = await poshUrl({ query: 'x', sort });
    expect(u.searchParams.get('sort_by')).toBe(expected);
  });

  it.each([
    ['new', 'nwt'],
    ['like_new', 'nwot'],
    ['good', 'good'],
    ['fair', 'fair'],
  ] as const)('maps condition %s to condition=%s', async (condition, expected) => {
    const u = await poshUrl({ query: 'x', condition });
    expect(u.searchParams.get('condition')).toBe(expected);
  });

  it.each(['any', 'used', 'excellent'] as const)(
    'sends no condition param for %s',
    async (condition) => {
      const u = await poshUrl({ query: 'x', condition });
      expect(u.searchParams.has('condition')).toBe(false);
    },
  );

  it('repeats bracketed params once per size and colour', async () => {
    const u = await poshUrl({ query: 'x', sizes: ['XS', 'S', 'M'], colors: ['Blue', 'Red'] });
    expect(u.searchParams.getAll('size[]')).toEqual(['XS', 'S', 'M']);
    expect(u.searchParams.getAll('color[]')).toEqual(['Blue', 'Red']);
    expect(u.toString()).toContain('size%5B%5D=XS');
  });

  it('builds every supported filter in one URL and omits price bounds', async () => {
    const u = await poshUrl({
      query: 'denim jacket',
      sort: 'price_low_to_high',
      condition: 'like_new',
      minPrice: 10,
      maxPrice: 90,
      category: 'Jackets_Coats',
      brand: "Levi's",
      department: 'Women',
      sizes: ['S', 'M'],
      colors: ['Blue'],
    });
    expect([...u.searchParams.entries()]).toEqual([
      ['query', 'denim jacket'],
      ['type', 'listings'],
      ['src', 'dir'],
      ['sort_by', 'price_asc'],
      ['condition', 'nwot'],
      ['department', 'Women'],
      ['brand[]', "Levi's"],
      ['category_v2', 'Jackets_Coats'],
      ['size[]', 'S'],
      ['size[]', 'M'],
      ['color[]', 'Blue'],
    ]);
  });

  it('leaves empty size and colour arrays out of the URL', async () => {
    const u = await poshUrl({ query: 'x', sizes: [], colors: [] });
    expect(u.searchParams.has('size[]')).toBe(false);
    expect(u.searchParams.has('color[]')).toBe(false);
  });
});

describe('Poshmark listing extraction', () => {
  it('shapes a tile into a listing', async () => {
    const { result } = await poshSearch(
      { query: 'jacket' },
      {
        roots: [
          poshTile(`/listing/vintage-levis-jacket-${HEX}`, {
            alt: 'Vintage Levis Jacket',
            src: 'https://img.poshmark.com/1.jpg',
            text: 'Vintage Levis Jacket $45 $120 Size M',
          }),
        ],
      },
    );
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      id: HEX,
      title: 'Vintage Levis Jacket',
      price: '$45',
      priceNumeric: 45,
      currency: '$',
      url: `https://poshmark.com/listing/vintage-levis-jacket-${HEX}`,
      images: ['https://img.poshmark.com/1.jpg'],
      marketplace: 'poshmark',
    });
    expect(Number.isNaN(Date.parse(result.listings[0].scrapedAt))).toBe(false);
  });

  it('takes the first price on the tile as the current price', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      { roots: [poshTile(`/listing/a-${HEX}`, { text: '$1,250 $2,000 Free shipping' })] },
    );
    expect(result.listings[0].price).toBe('$1,250');
    expect(result.listings[0].priceNumeric).toBe(1250);
  });

  it('strips the space in "$ 45"', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      { roots: [poshTile(`/listing/a-${HEX}`, { text: 'Nice coat $ 45' })] },
    );
    expect(result.listings[0].price).toBe('$45');
    expect(result.listings[0].priceNumeric).toBe(45);
  });

  it('humanises the slug when the image has no alt text', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      { roots: [poshTile(`/listing/vintage-levis-denim-jacket-${HEX}`, { text: '$20' })] },
    );
    expect(result.listings[0].title).toBe('Vintage Levis Denim Jacket');
  });

  it('falls back to the whole slug as id when there is no 24-hex suffix', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      { roots: [poshTile('/listing/plain-slug', { text: '$20' })] },
    );
    expect(result.listings[0].id).toBe('plain-slug');
    expect(result.listings[0].url).toBe('https://poshmark.com/listing/plain-slug');
  });

  it('de-duplicates two anchors pointing at the same listing', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      {
        roots: [
          poshTile(`/listing/coat-${HEX}`, { text: '$30' }),
          poshTile(`/listing/coat-${HEX}?src=grid`, { text: '$30' }),
        ],
      },
    );
    expect(result.listings).toHaveLength(1);
  });

  it('reports no price when the tile shows none', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      { roots: [poshTile(`/listing/a-${HEX}`, { text: 'Sold out' })] },
    );
    expect(result.listings[0]).toMatchObject({ price: 'Price not listed', currency: '$' });
    expect(result.listings[0].priceNumeric).toBeUndefined();
  });

  it('omits images when the tile has no img src', async () => {
    const { result } = await poshSearch(
      { query: 'x' },
      { roots: [poshTile(`/listing/a-${HEX}`, { text: '$5' })] },
    );
    expect(result.listings[0].images).toBeUndefined();
  });

  it('ignores anchors whose href has no slug segment', async () => {
    const a = el('a[href*="/listing/"]', { href: '/listing/' });
    const { result } = await poshSearch({ query: 'x' }, { roots: [el('div', {}, '$9').append(a)] });
    expect(result.listings).toEqual([]);
  });

  it('borrows a sibling price when the tile itself has none', async () => {
    const a1 = el('a[href*="/listing/"]', { href: `/listing/one-${HEX}` });
    const a2 = el('a[href*="/listing/"]', { href: `/listing/two-${HEX2}` });
    const grid = el('div', {}, '$10 $20').append(a1, a2);
    const { result } = await poshSearch({ query: 'x' }, { roots: [grid] });
    expect(result.listings.map((l) => l.price)).toEqual(['$10', '$10']);
  });
});

describe('Poshmark result filtering', () => {
  const priced = (n: number, id: string) => ({ id, slug: id, title: id, img: '', prices: [`$${n}`] });

  it('drops listings outside the price bounds', async () => {
    const { result } = await poshSearch(
      { query: 'x', minPrice: 20, maxPrice: 100 },
      { raw: [priced(10, 'a'), priced(45, 'b'), priced(120, 'c'), priced(100, 'd')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['b', 'd']);
  });

  it('keeps unpriced listings inside a maxPrice search', async () => {
    const { result } = await poshSearch(
      { query: 'x', maxPrice: 20 },
      { raw: [{ id: 'a', slug: 'a', title: 'a', img: '', prices: [] }, priced(999, 'b')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['a']);
  });

  it('defaults to 48 results and honours an explicit limit', async () => {
    const raw = Array.from({ length: 60 }, (_, i) => priced(i + 1, `id${i}`));
    const { result } = await poshSearch({ query: 'x' }, { raw });
    expect(result.listings).toHaveLength(48);
    expect(result.totalFound).toBe(48);

    const limited = await poshSearch({ query: 'x', limit: 3 }, { raw });
    expect(limited.result.listings.map((l) => l.id)).toEqual(['id0', 'id1', 'id2']);
  });

  it('succeeds with a note when nothing parses', async () => {
    const { result } = await poshSearch({ query: 'x' }, { raw: [] });
    expect(result).toEqual({
      marketplace: 'poshmark',
      success: true,
      listings: [],
      totalFound: 0,
      note: 'No Poshmark listings parsed. The page may have been blocked or its markup changed.',
    });
  });
});

describe('Poshmark navigation failures', () => {
  it('retries eight times then reports the last error', async () => {
    vi.mocked(newPage).mockRejectedValue(new Error('proxy 407'));
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(result.success).toBe(false);
    expect(result.listings).toEqual([]);
    expect(result.error).toBe(
      'Poshmark search failed: Error: All 8 proxy attempts failed. Last: proxy 407',
    );
    expect(newPage).toHaveBeenCalledTimes(8);
    expect(rotateBrowser).toHaveBeenCalledTimes(7);
  });

  it('retries a Cloudflare interstitial and closes each blocked page', async () => {
    const blocked = fakePage({ title: 'Just a moment...' });
    use(blocked);
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(result.success).toBe(false);
    expect(blocked.gotos).toHaveLength(8);
    expect(blocked.closes).toBe(8);
  });

  it.each([403, 429, 0])('retries on HTTP status %i', async (status) => {
    const page = fakePage({ status });
    use(page);
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`status=${status}`);
  });

  it('recovers on the attempt after a block and rotates once', async () => {
    const blocked = fakePage({ title: 'Forbidden' });
    const ok = fakePage({ roots: [poshTile(`/listing/a-${HEX}`, { text: '$12' })] });
    use(blocked, ok);
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(result.success).toBe(true);
    expect(result.listings).toHaveLength(1);
    expect(rotateBrowser).toHaveBeenCalledTimes(1);
    expect(blocked.closes).toBe(1);
  });

  it('opens and closes the page inside the browser lock on the happy path', async () => {
    const trace: string[] = [];
    (withBrowserLock as unknown as Mock).mockImplementation(async (fn: () => Promise<unknown>) => {
      trace.push('acquire');
      try {
        return await fn();
      } finally {
        trace.push('release');
      }
    });
    const page = fakePage({ raw: [] });
    page.close.mockImplementation(async () => {
      page.closes++;
      trace.push('close');
    });
    vi.mocked(newPage).mockImplementation(async () => {
      trace.push('newPage');
      return page as unknown as Page;
    });

    const result = await new PoshmarkMarketplace().search({ query: 'x' });

    expect(result.success).toBe(true);
    expect(trace).toEqual(['acquire', 'newPage', 'close', 'release']);
  });
});

describe('withBrowserLock', () => {
  const realLock = async () =>
    (await vi.importActual<typeof import('../src/browser.js')>('../src/browser.js')).withBrowserLock;

  it('serialises overlapping scrapes instead of interleaving them', async () => {
    const lock = await realLock();
    const trace: string[] = [];
    const scrape = (id: string) =>
      lock(async () => {
        trace.push(`${id}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        trace.push(`${id}:end`);
        return id;
      });

    const results = await Promise.all([scrape('a'), scrape('b'), scrape('c')]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(trace).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('releases the lock when the scrape it wraps throws', async () => {
    const lock = await realLock();

    await expect(
      lock(async () => {
        throw new Error('blocked');
      }),
    ).rejects.toThrow('blocked');
    await expect(lock(async () => 'next')).resolves.toBe('next');
  });
});

describe('Poshmark listing details', () => {
  it('prefers JSON-LD and supplements it with og:image', async () => {
    const page = fakePage({
      roots: [
        el(
          'script[type="application/ld+json"]',
          {},
          JSON.stringify([
            { '@type': 'BreadcrumbList' },
            {
              '@type': 'Product',
              description: 'Worn twice',
              image: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
            },
          ]),
        ),
        el('meta[property="og:image"]', { content: 'https://cdn/1.jpg' }),
        el('meta[property="og:image"]', { content: 'https://cdn/3.jpg' }),
        el('meta[name="description"]', { content: 'ignored when JSON-LD wins' }),
        el('a[href^="/closet/"]', { href: '/closet/thriftqueen' }, 'thriftqueen'),
      ],
    });
    use(page);
    const details = await new PoshmarkMarketplace().getListingDetails(`coat-${HEX}`);
    expect(page.gotos[0]).toBe(`https://poshmark.com/listing/coat-${HEX}`);
    expect(details).toEqual({
      id: `coat-${HEX}`,
      description: 'Worn twice',
      images: ['https://cdn/1.jpg', 'https://cdn/2.jpg', 'https://cdn/3.jpg'],
      seller: 'thriftqueen',
      isShippingOffered: true,
      url: `https://poshmark.com/listing/coat-${HEX}`,
    });
  });

  it('falls back to the meta description and cloudfront images', async () => {
    const page = fakePage({
      roots: [
        el('meta[name="description"]', { content: 'Meta blurb' }),
        el('img[src*="cloudfront.net/posts"]', { src: 'https://d.cloudfront.net/posts/1.jpg' }),
        el('img[src*="cloudfront.net/posts"]', { src: 'https://d.cloudfront.net/posts/1.jpg' }),
      ],
    });
    use(page);
    const details = await new PoshmarkMarketplace().getListingDetails('x');
    expect(details.description).toBe('Meta blurb');
    expect(details.images).toEqual(['https://d.cloudfront.net/posts/1.jpg']);
  });

  it('skips the cloudfront fallback when og:image already yielded images', async () => {
    const page = fakePage({
      roots: [
        el('meta[property="og:image"]', { content: 'https://cdn/og.jpg' }),
        el('img[src*="cloudfront.net/posts"]', { src: 'https://d.cloudfront.net/posts/1.jpg' }),
      ],
    });
    use(page);
    const details = await new PoshmarkMarketplace().getListingDetails('x');
    expect(details.images).toEqual(['https://cdn/og.jpg']);
  });

  it('reads the seller from the closet href when the anchor has no text', async () => {
    const page = fakePage({ roots: [el('a[href^="/closet/"]', { href: '/closet/bargainbin' }, '  ')] });
    use(page);
    const details = await new PoshmarkMarketplace().getListingDetails('x');
    expect(details.seller).toBe('bargainbin');
  });

  it('ignores malformed JSON-LD', async () => {
    const page = fakePage({
      roots: [
        el('script[type="application/ld+json"]', {}, '{ not json'),
        el('meta[name="description"]', { content: 'Meta blurb' }),
      ],
    });
    use(page);
    const details = await new PoshmarkMarketplace().getListingDetails('x');
    expect(details.description).toBe('Meta blurb');
  });

  it('returns an empty shape for a page with nothing on it', async () => {
    use(fakePage({ roots: [] }));
    const details = await new PoshmarkMarketplace().getListingDetails('x');
    expect(details.images).toEqual([]);
    expect(details.description).toBeUndefined();
    expect(details.seller).toBeUndefined();
  });

  it('rejects rather than returning an error shape when every attempt is blocked', async () => {
    use(fakePage({ status: 403 }));
    await expect(new PoshmarkMarketplace().getListingDetails('x')).rejects.toThrow(
      /All 8 proxy attempts failed/,
    );
  });
});

describe('Depop search URL', () => {
  it('sends only the query and keeps every filter client-side', async () => {
    const { page } = await depopSearch(
      {
        query: 'nike jacket',
        minPrice: 5,
        maxPrice: 50,
        sort: 'price_low_to_high',
        brand: 'Nike',
        category: 'jackets',
        sizes: ['M'],
        colors: ['Blue'],
        condition: 'good',
      },
      { raw: [] },
    );
    const u = new URL(page.gotos[0]);
    expect(u.origin + u.pathname).toBe('https://www.depop.com/search/');
    expect([...u.searchParams.entries()]).toEqual([['q', 'nike jacket']]);
  });
});

describe('Depop listing extraction', () => {
  it('shapes a tile into a listing', async () => {
    const { result } = await depopSearch(
      { query: 'jacket' },
      {
        roots: [
          depopTile('/products/thriftstore-vintage-nike-jacket/', {
            src: 'https://media-photos.depop.com/1.jpg',
            text: 'thriftstore £45 Size M',
          }),
        ],
      },
    );
    expect(result.listings[0]).toMatchObject({
      id: 'thriftstore-vintage-nike-jacket',
      price: '£45',
      priceNumeric: 45,
      currency: '£',
      url: 'https://www.depop.com/products/thriftstore-vintage-nike-jacket',
      images: ['https://media-photos.depop.com/1.jpg'],
      marketplace: 'depop',
    });
  });

  it('takes the last price on the card as the current price', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/u-red-silk-dress/', { text: 'was £40 now £22.50' })] },
    );
    expect(result.listings[0].price).toBe('£22.50');
    expect(result.listings[0].priceNumeric).toBe(22.5);
  });

  it('keeps a euro price in its own currency', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/u-leather-bag/', { text: '€ 89,00' })] },
    );
    expect(result.listings[0].price).toBe('€89,00');
    expect(result.listings[0].currency).toBe('€');
    expect(result.listings[0].priceNumeric).toBe(89);
  });

  it('falls back to the first srcset url when there is no src', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      {
        roots: [
          depopTile('/products/u-blue-coat/', {
            srcset: 'https://media-photos.depop.com/small.jpg 1x, https://media-photos.depop.com/big.jpg 2x',
            text: '£10',
          }),
        ],
      },
    );
    expect(result.listings[0].images).toEqual(['https://media-photos.depop.com/small.jpg']);
  });

  it('de-duplicates two anchors pointing at the same product', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      {
        roots: [
          depopTile('/products/u-blue-coat/', { text: '£10' }),
          depopTile('/products/u-blue-coat/?ref=grid', { text: '£10' }),
        ],
      },
    );
    expect(result.listings).toHaveLength(1);
  });

  it('reports no price when the card shows none', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/u-blue-coat/', { text: 'Sold' })] },
    );
    expect(result.listings[0]).toMatchObject({ price: 'Price not listed', currency: '$' });
    expect(result.listings[0].priceNumeric).toBeUndefined();
  });

  it('turns a two-part slug into spaced words without capitalising', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/red-dress/', { text: '£10' })] },
    );
    expect(result.listings[0].title).toBe('red dress');
  });

  it('keeps the final slug word in the title', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/thriftstore-vintage-nike-jacket/', { text: '£45' })] },
    );
    expect(result.listings[0].title).toBe('Vintage Nike Jacket');
  });

  it('prefers the anchor aria-label over the slug for the title', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      {
        roots: [
          depopTile('/products/sneakerplug-nike-airmax90white/', {
            label: 'Nike Air Max 90 White UK 10',
            text: '£120',
          }),
        ],
      },
    );
    expect(result.listings[0].title).toBe('Nike Air Max 90 White UK 10');
  });
});

describe('Depop result filtering and sorting', () => {
  const item = (slug: string, price?: string) => ({
    slug,
    label: '',
    img: '',
    prices: price ? [price] : [],
  });

  it('drops listings outside the price bounds', async () => {
    const { result } = await depopSearch(
      { query: 'x', minPrice: 20, maxPrice: 100 },
      { raw: [item('u-a-1', '£10'), item('u-b-1', '£45'), item('u-c-1', '£120')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['u-b-1']);
  });

  it('sorts ascending and pushes unpriced listings last', async () => {
    const { result } = await depopSearch(
      { query: 'x', sort: 'price_low_to_high' },
      { raw: [item('u-a-1', '£30'), item('u-b-1'), item('u-c-1', '£10')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['u-c-1', 'u-a-1', 'u-b-1']);
  });

  it('sorts descending and pushes unpriced listings last', async () => {
    const { result } = await depopSearch(
      { query: 'x', sort: 'price_high_to_low' },
      { raw: [item('u-a-1', '£30'), item('u-b-1'), item('u-c-1', '£10')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['u-a-1', 'u-c-1', 'u-b-1']);
  });

  it('leaves page order alone for non-price sorts', async () => {
    const { result } = await depopSearch(
      { query: 'x', sort: 'newest' },
      { raw: [item('u-a-1', '£30'), item('u-c-1', '£10')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['u-a-1', 'u-c-1']);
  });

  it('sorts before applying the limit', async () => {
    const { result } = await depopSearch(
      { query: 'x', sort: 'price_low_to_high', limit: 1 },
      { raw: [item('u-a-1', '£30'), item('u-c-1', '£10')] },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['u-c-1']);
  });

  it('defaults to 24 results', async () => {
    const raw = Array.from({ length: 40 }, (_, i) => item(`u-item${i}-1`, `£${i + 1}`));
    const { result } = await depopSearch({ query: 'x' }, { raw });
    expect(result.listings).toHaveLength(24);
    expect(result.totalFound).toBe(24);
  });

  it('succeeds with a note when nothing parses', async () => {
    const { result } = await depopSearch({ query: 'x' }, { raw: [] });
    expect(result).toEqual({
      marketplace: 'depop',
      success: true,
      listings: [],
      totalFound: 0,
      note: 'No Depop listings parsed. The page may have been blocked or its markup changed.',
    });
  });
});

describe('Depop navigation failures', () => {
  it('retries eight times then reports the last error', async () => {
    vi.mocked(newPage).mockRejectedValue(new Error('Navigation timeout'));
    const result = await new DepopMarketplace().search({ query: 'x' });
    expect(result).toEqual({
      marketplace: 'depop',
      success: false,
      listings: [],
      error: 'Depop search failed: Error: All 8 proxy attempts failed. Last: Navigation timeout',
    });
    expect(newPage).toHaveBeenCalledTimes(8);
    expect(rotateBrowser).toHaveBeenCalledTimes(7);
  });

  it('recovers on the attempt after a block', async () => {
    const blocked = fakePage({ title: 'Just a moment...' });
    const ok = fakePage({ roots: [depopTile('/products/u-blue-coat/', { text: '£12' })] });
    use(blocked, ok);
    const result = await new DepopMarketplace().search({ query: 'x' });
    expect(result.success).toBe(true);
    expect(result.listings).toHaveLength(1);
    expect(rotateBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('Depop listing details', () => {
  const slug = 'thriftstore-vintage-nike-jacket';

  it('collects unique og:images and lets JSON-LD win the description', async () => {
    const page = fakePage({
      roots: [
        el('meta[property="og:image"]', { content: 'https://p/1.jpg' }),
        el('meta[property="og:image"]', { content: 'https://p/1.jpg' }),
        el('meta[property="og:image"]', { content: 'https://p/2.jpg' }),
        el('meta[name="description"]', { content: 'meta blurb' }),
        el(
          'script[type="application/ld+json"]',
          {},
          JSON.stringify([
            { '@type': 'BreadcrumbList' },
            { '@type': 'Product', description: 'ld blurb', brand: { name: 'Nike' } },
          ]),
        ),
      ],
    });
    use(page);
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(page.gotos[0]).toBe(`https://www.depop.com/products/${slug}/`);
    expect(details.url).toBe(`https://www.depop.com/products/${slug}`);
    expect(details.images).toEqual(['https://p/1.jpg', 'https://p/2.jpg']);
    expect(details.description).toBe('ld blurb');
    expect(details.isShippingOffered).toBe(true);
  });

  it('reports the JSON-LD brand as the seller', async () => {
    const page = fakePage({
      roots: [
        el(
          'script[type="application/ld+json"]',
          {},
          JSON.stringify({ '@type': 'Product', brand: { name: 'Nike' } }),
        ),
      ],
    });
    use(page);
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.seller).toBe('Nike');
  });

  it('falls back to the slug username when there is no JSON-LD brand', async () => {
    use(fakePage({ roots: [el('meta[name="description"]', { content: 'blurb' })] }));
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.seller).toBe('thriftstore');
    expect(details.description).toBe('blurb');
  });

  it('uses og:description when there is no meta description', async () => {
    use(fakePage({ roots: [el('meta[property="og:description"]', { content: 'og blurb' })] }));
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.description).toBe('og blurb');
  });

  it('falls back to in-page depop media photos', async () => {
    use(
      fakePage({
        roots: [
          el('img[src*="media-photos.depop.com"]', { src: 'https://media-photos.depop.com/a.jpg' }),
          el('img[src*="media-photos.depop.com"]', { src: 'https://media-photos.depop.com/a.jpg' }),
          el('img[src*="media-photos.depop.com"]', { src: 'https://media-photos.depop.com/b.jpg' }),
        ],
      }),
    );
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.images).toEqual([
      'https://media-photos.depop.com/a.jpg',
      'https://media-photos.depop.com/b.jpg',
    ]);
  });
});
