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
import { PoshmarkMarketplace } from '../src/marketplaces/poshmark.js';

/** A node answers querySelector only for the selector strings it was built with. */
class Node {
  parentElement: Node | null = null;
  innerText: string;
  /** Null models the DOM's nullable textContent, which the scraper guards against. */
  textContent: string | null;
  readonly kids: Node[] = [];

  constructor(
    readonly sel: string[],
    readonly attrs: Record<string, string> = {},
    text: string | null = '',
  ) {
    this.innerText = text ?? '';
    this.textContent = text;
  }

  get content(): string {
    return this.attrs.content ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  append(...kids: Node[]): this {
    for (const k of kids) {
      k.parentElement = this;
      this.kids.push(k);
    }
    return this;
  }

  descendants(): Node[] {
    return this.kids.flatMap((k) => [k, ...k.descendants()]);
  }

  querySelector(s: string): Node | null {
    return this.descendants().find((n) => n.sel.includes(s)) ?? null;
  }

  querySelectorAll(s: string): Node[] {
    return this.descendants().filter((n) => n.sel.includes(s));
  }
}

const node = (
  sel: string | string[],
  attrs: Record<string, string> = {},
  text: string | null = '',
): Node => new Node(Array.isArray(sel) ? sel : [sel], attrs, text);

interface PageOpts {
  roots?: Node[];
  nullResponse?: boolean;
  gotoThrows?: unknown;
}

function fakePage(opts: PageOpts = {}) {
  const page = {
    gotos: [] as string[],
    closes: 0,
    goto: vi.fn(async (url: string) => {
      page.gotos.push(url);
      if ('gotoThrows' in opts) throw opts.gotoThrows;
      return opts.nullResponse ? null : { status: () => 200 };
    }),
    title: vi.fn(async () => 'Search results'),
    waitForSelector: vi.fn(async () => null),
    evaluate: vi.fn(async (fn: () => unknown) => {
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

const use = (page: FakePage): void => {
  vi.mocked(newPage).mockResolvedValue(page as unknown as Page);
};

const HEX = '6512ab34cd56ef7890123456';

const tile = (href: string | null, text: string): Node => {
  const img = node('img', { alt: 'A coat', src: 'https://cdn/t.jpg' });
  const anchor = node('a[href*="/listing/"]', href === null ? {} : { href }).append(img);
  return node('div', {}, text).append(anchor);
};

beforeEach(() => {
  vi.resetAllMocks();
  (withBrowserLock as unknown as Mock).mockImplementation((fn: () => Promise<unknown>) => fn());
  vi.mocked(rotateBrowser).mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('Poshmark navigation edge cases', () => {
  it('treats a missing navigation response as status 0 and retries', async () => {
    const page = fakePage({ nullResponse: true });
    use(page);

    const result = await new PoshmarkMarketplace().search({ query: 'x' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('status=0');
    expect(page.gotos).toHaveLength(8);
  });

  it('stringifies a thrown value that carries no message', async () => {
    use(fakePage({ gotoThrows: 'socket hang up' }));

    const result = await new PoshmarkMarketplace().search({ query: 'x' });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Poshmark search failed: Error: All 8 proxy attempts failed. Last: socket hang up',
    );
  });
});

describe('Poshmark listing extraction edge cases', () => {
  it('skips an anchor with no href attribute and keeps the rest', async () => {
    use(
      fakePage({
        roots: [tile(null, '$40'), tile(`/listing/red-coat-${HEX}`, '$25 $60')],
      }),
    );

    const result = await new PoshmarkMarketplace().search({ query: 'coat' });

    expect(result.success).toBe(true);
    expect(result.listings.map((l) => l.id)).toEqual([HEX]);
    expect(result.listings[0].price).toBe('$25');
  });
});

describe('Poshmark search URL edge cases', () => {
  it('omits sort_by when the sort value is not one Poshmark understands', async () => {
    const page = fakePage({ roots: [] });
    use(page);

    await new PoshmarkMarketplace().search({
      query: 'x',
      sort: 'price_ascending' as SearchParams['sort'],
    });

    const url = new URL(page.gotos[0]);
    expect(url.searchParams.has('sort_by')).toBe(false);
    expect(url.searchParams.get('query')).toBe('x');
  });
});

describe('Poshmark health check', () => {
  it('asks for a single listing and reports the search outcome', async () => {
    const page = fakePage({ roots: [tile(`/listing/red-coat-${HEX}`, '$25')] });
    use(page);

    expect(await new PoshmarkMarketplace().healthCheck()).toBe(true);
    const url = new URL(page.gotos[0]);
    expect(url.searchParams.get('query')).toBe('test');
  });

  it('reports unhealthy when the search cannot reach a usable page', async () => {
    use(fakePage({ gotoThrows: new Error('proxy 407') }));

    expect(await new PoshmarkMarketplace().healthCheck()).toBe(false);
  });

  it('reports unhealthy when the browser lock itself rejects', async () => {
    (withBrowserLock as unknown as Mock).mockRejectedValue(new Error('no chrome'));

    expect(await new PoshmarkMarketplace().healthCheck()).toBe(false);
  });
});

describe('Poshmark JSON-LD shapes', () => {
  const ld = (payload: unknown, text?: string | null): Node =>
    node(
      'script[type="application/ld+json"]',
      {},
      text === undefined ? JSON.stringify(payload) : text,
    );

  it('reads a bare Product object that is not wrapped in an array', async () => {
    use(
      fakePage({
        roots: [
          ld({ '@type': 'Product', description: 'Bare node', image: 'https://cdn/solo.jpg' }),
          node('meta[name="description"]', { content: 'Meta blurb' }),
        ],
      }),
    );

    const details = await new PoshmarkMarketplace().getListingDetails('x');

    expect(details.description).toBe('Bare node');
    expect(details.images).toEqual(['https://cdn/solo.jpg']);
  });

  it('keeps an earlier description when a later Product node omits one', async () => {
    use(
      fakePage({
        roots: [
          ld([{ '@type': 'Product', description: 'First', image: ['https://cdn/1.jpg'] }]),
          ld([{ '@type': 'Product' }]),
          node('meta[name="description"]', { content: 'Meta blurb' }),
          node('meta[property="og:image"]', { content: 'https://cdn/og.jpg' }),
        ],
      }),
    );

    const details = await new PoshmarkMarketplace().getListingDetails('x');

    expect(details.description).toBe('First');
    expect(details.images).toEqual(['https://cdn/1.jpg', 'https://cdn/og.jpg']);
  });

  it('drops blank and repeated entries from the Product image list', async () => {
    use(
      fakePage({
        roots: [
          ld({
            '@type': 'Product',
            description: 'Dupes',
            image: ['https://cdn/1.jpg', '', 'https://cdn/1.jpg', 'https://cdn/2.jpg'],
          }),
        ],
      }),
    );

    const details = await new PoshmarkMarketplace().getListingDetails('x');

    expect(details.images).toEqual(['https://cdn/1.jpg', 'https://cdn/2.jpg']);
  });

  it('ignores a JSON-LD script with no text content', async () => {
    use(
      fakePage({
        roots: [ld(null, null), node('meta[name="description"]', { content: 'Meta blurb' })],
      }),
    );

    const details = await new PoshmarkMarketplace().getListingDetails('x');

    expect(details.description).toBe('Meta blurb');
    expect(details.images).toEqual([]);
  });
});
