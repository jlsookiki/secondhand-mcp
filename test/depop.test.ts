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
import { DepopMarketplace, cardPrice, depopSeller } from '../src/marketplaces/depop.js';

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

const depopSearch = async (params: SearchParams, opts: PageOpts) => {
  const page = fakePage(opts);
  use(page);
  const result = await new DepopMarketplace().search(params);
  return { result, page };
};

beforeEach(() => {
  // restoreMocks only touches vi.spyOn spies, so the factory mocks need a manual reset.
  vi.resetAllMocks();
  (withBrowserLock as unknown as Mock).mockImplementation((fn: () => Promise<unknown>) => fn());
  vi.mocked(rotateBrowser).mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

describe('cardPrice', () => {
  it.each([
    ['Levi\'s 30" $63.70 +$10.00 shipping', '$63.70'],
    ['Levi\'s 34" $68.95 $38.24 +$10.00 shipping', '$38.24'],
    ['Levi\'s 28" £26.95 £13.82', '£13.82'],
    ['Levi\'s 28" $17.50', '$17.50'],
    ['Levi\'s £26.95 +£3.50', '£26.95'],
    ['Free shipping', undefined],
  ])('reads %s as %s', (text, price) => {
    expect(cardPrice(text)).toBe(price);
  });
});

describe('depopSeller', () => {
  it('prefers the description, then the photo caption, then the slug', () => {
    expect(depopSeller('Jeans - Sold by @ppthriftss', 'item listed by other', 'prthriftss-jeans')).toBe('ppthriftss');
    expect(depopSeller('Jeans', 'item listed by ppthriftss image 2', 'prthriftss-jeans')).toBe('ppthriftss');
    expect(depopSeller(undefined, undefined, 'prthriftss-jeans')).toBe('prthriftss');
  });
});

describe('Depop card prices with shipping', () => {
  it('reports the item price, not the shipping cost, and filters on it', async () => {
    const { result } = await depopSearch(
      { query: 'x', maxPrice: 50 },
      {
        roots: [
          depopTile('/products/mesmeriser-levis-501-7877/', { text: 'Levi\'s 30" $63.70 +$10.00 shipping' }),
          depopTile('/products/looseunitvntg-carhartt-cf94/', { text: 'Carhartt $68.95 $38.24 +$10.00 shipping' }),
        ],
      },
    );
    expect(result.listings.map((l) => [l.id, l.price])).toEqual([['looseunitvntg-carhartt-cf94', '$38.24']]);
  });
});

describe('Depop result filtering and sorting', () => {
  const item = (slug: string, price?: string) => ({
    slug,
    label: '',
    img: '',
    text: price ?? '',
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

  it('reports the JSON-LD brand as the brand, not the seller', async () => {
    const page = fakePage({
      roots: [
        el('meta[name="description"]', { content: 'Nike jacket - Sold by @jacketqueen' }),
        el(
          'script[type="application/ld+json"]',
          {},
          JSON.stringify({ '@type': 'Product', brand: { name: 'Nike' } }),
        ),
      ],
    });
    use(page);
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.seller).toBe('jacketqueen');
    expect(details.brand).toBe('Nike');
  });

  it('reads the seller from the photo caption when the description has no seller', async () => {
    use(fakePage({ roots: [el('img[alt^="item listed by "]', { alt: 'item listed by jacketqueen image 2' })] }));
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.seller).toBe('jacketqueen');
  });

  it('falls back to the slug username when neither the description nor a photo caption names the seller', async () => {
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

describe('Depop navigation edge cases', () => {
  it('counts a navigation with no response object as a blocked attempt', async () => {
    const page = fakePage();
    vi.mocked(page.goto).mockResolvedValue(null as never);
    use(page);
    const result = await new DepopMarketplace().search({ query: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('status=0');
    expect(newPage).toHaveBeenCalledTimes(8);
  });

  it('stringifies a rejection that carries no message', async () => {
    vi.mocked(newPage).mockRejectedValue('proxy exploded');
    const result = await new DepopMarketplace().search({ query: 'x' });
    expect(result.error).toBe(
      'Depop search failed: Error: All 8 proxy attempts failed. Last: proxy exploded',
    );
  });
});

describe('Depop listing extraction fallbacks', () => {
  it('skips an anchor with no href and still returns the real tile', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      {
        roots: [
          el('li', {}, '£5').append(el('a[href*="/products/"]')),
          depopTile('/products/u-blue-coat/', { text: '£10' }),
        ],
      },
    );
    expect(result.listings.map((l) => l.id)).toEqual(['u-blue-coat']);
  });

  it('handles an anchor with no surrounding card', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [el('a[href*="/products/"]', { href: '/products/u-lone-tee/' })] },
    );
    expect(result.listings[0]).toMatchObject({
      id: 'u-lone-tee',
      title: 'Lone Tee',
      price: 'Price not listed',
    });
    expect(result.listings[0].images).toBeUndefined();
  });

  it('reads the price and image off the parent element when the card is not a list item', async () => {
    const a = el('a[href*="/products/"]', { href: '/products/u-grey-hoodie/' });
    const sibling = el('img', { src: 'https://media-photos.depop.com/side.jpg' });
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [el('div', {}, '£18').append(a, sibling)] },
    );
    expect(result.listings[0]).toMatchObject({
      price: '£18',
      priceNumeric: 18,
      images: ['https://media-photos.depop.com/side.jpg'],
    });
  });

  it('falls back to the image alt text for the title when there is no aria-label', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      {
        roots: [
          depopTile('/products/sneakerplug-nike-airmax90white/', {
            alt: 'Nike Air Max 90 White',
            text: '£120',
          }),
        ],
      },
    );
    expect(result.listings[0].title).toBe('Nike Air Max 90 White');
  });
});

describe('Depop slug titles', () => {
  it('drops a trailing hex id from the title', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile(`/products/thriftstore-vintage-nike-jacket-${HEX}/`, { text: '£45' })] },
    );
    expect(result.listings[0].title).toBe('Vintage Nike Jacket');
    expect(result.listings[0].id).toBe(`thriftstore-vintage-nike-jacket-${HEX}`);
  });

  it('drops a trailing numeric id from the title', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/thriftstore-red-silk-dress-4820913/', { text: '£45' })] },
    );
    expect(result.listings[0].title).toBe('Red Silk Dress');
  });

  it('keeps a short trailing number that is not an id', async () => {
    const { result } = await depopSearch(
      { query: 'x' },
      { roots: [depopTile('/products/thriftstore-air-max-90/', { text: '£45' })] },
    );
    expect(result.listings[0].title).toBe('Air Max 90');
  });
});

describe('Depop listing details fallbacks', () => {
  const slug = 'thriftstore-vintage-nike-jacket';

  it('ignores a JSON-LD block that is not a Product', async () => {
    use(
      fakePage({
        roots: [
          el('meta[name="description"]', { content: 'meta blurb' }),
          el(
            'script[type="application/ld+json"]',
            {},
            JSON.stringify({ '@type': 'WebSite', description: 'site blurb', brand: { name: 'Depop' } }),
          ),
        ],
      }),
    );
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.description).toBe('meta blurb');
    expect(details.seller).toBe('thriftstore');
  });

  it('ignores an empty JSON-LD block', async () => {
    use(
      fakePage({
        roots: [
          el('meta[name="description"]', { content: 'meta blurb' }),
          el('script[type="application/ld+json"]'),
        ],
      }),
    );
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.description).toBe('meta blurb');
  });

  it('keeps the slug username as the seller for a Product with no brand', async () => {
    use(
      fakePage({
        roots: [
          el('meta[name="description"]', { content: 'meta blurb' }),
          el(
            'script[type="application/ld+json"]',
            {},
            JSON.stringify({ '@type': 'Product', description: 'ld blurb' }),
          ),
        ],
      }),
    );
    const details = await new DepopMarketplace().getListingDetails(slug);
    expect(details.description).toBe('ld blurb');
    expect(details.seller).toBe('thriftstore');
  });

  it('propagates a navigation failure instead of returning details', async () => {
    vi.mocked(newPage).mockRejectedValue(new Error('Navigation timeout'));
    await expect(new DepopMarketplace().getListingDetails(slug)).rejects.toThrow(
      'All 8 proxy attempts failed. Last: Navigation timeout',
    );
  });
});

describe('Depop health check', () => {
  it('is healthy when a one-result search succeeds', async () => {
    use(fakePage({ roots: [depopTile('/products/u-blue-coat/', { text: '£10' })] }));
    await expect(new DepopMarketplace().healthCheck()).resolves.toBe(true);
  });

  it('is unhealthy when the search reports a failure', async () => {
    vi.mocked(newPage).mockRejectedValue(new Error('Navigation timeout'));
    await expect(new DepopMarketplace().healthCheck()).resolves.toBe(false);
  });

  it('is unhealthy when the browser lock itself throws', async () => {
    (withBrowserLock as unknown as Mock).mockRejectedValue(new Error('no browser'));
    await expect(new DepopMarketplace().healthCheck()).resolves.toBe(false);
  });
});
