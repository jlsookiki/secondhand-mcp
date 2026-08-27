import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseMarketplace } from '../src/marketplaces/base.js';
import type { Marketplace } from '../src/marketplaces/base.js';
import type { SearchParams, SearchResult } from '../src/types.js';

type Registry = typeof import('../src/marketplaces/index.js');

interface RegistryEnv {
  chrome?: string | null;
  marketplaces?: string;
  ebayCreds?: boolean;
}

async function loadRegistry({
  chrome = '/usr/bin/chromium',
  marketplaces,
  ebayCreds = true,
}: RegistryEnv = {}): Promise<Registry> {
  vi.stubEnv('MARKETPLACES', marketplaces as string);
  vi.stubEnv('EBAY_CLIENT_ID', (ebayCreds ? 'id' : undefined) as string);
  vi.stubEnv('EBAY_CLIENT_SECRET', (ebayCreds ? 'secret' : undefined) as string);
  vi.stubEnv('EBAY_MARKETPLACE_ID', undefined);
  vi.resetModules();
  // depop.ts fails to link unless every browser.js export is present.
  vi.doMock('../src/browser.js', () => ({
    findChrome: () => chrome,
    getBrowser: async () => {
      throw new Error('no browser in tests');
    },
    newPage: async () => {
      throw new Error('no browser in tests');
    },
    closeBrowser: async () => {},
    rotateBrowser: async () => {},
    withBrowserLock: async (fn: () => Promise<unknown>) => fn(),
  }));
  return import('../src/marketplaces/index.js');
}

function stub(name: string): Marketplace {
  return {
    name,
    displayName: `stub:${name}`,
    requiresAuth: false,
    search: async () => ({ marketplace: name, success: true, listings: [] }),
    healthCheck: async () => true,
  };
}

class TestMarketplace extends BaseMarketplace {
  readonly name = 'test';
  readonly displayName = 'Test Marketplace';
  readonly requiresAuth = false;

  async search(_params: SearchParams): Promise<SearchResult> {
    return this.createError('not implemented');
  }

  price(input: string) {
    return this.parsePrice(input);
  }

  error(message: string): SearchResult {
    return this.createError(message);
  }
}

let warnings: string[];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
});

describe('initializeMarketplaces', () => {
  it('registers every known marketplace when MARKETPLACES is unset', async () => {
    const registry = await loadRegistry();
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual(['facebook', 'ebay', 'depop', 'poshmark']);
    expect(registry.getAllMarketplaces().map((m) => m.displayName)).toEqual([
      'Facebook Marketplace',
      'eBay',
      'Depop',
      'Poshmark',
    ]);
    expect(registry.getAllMarketplaces().map((m) => m.requiresAuth)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(warnings).toEqual([]);
  });

  it('takes its order from MARKETPLACES, trimming and lower-casing entries', async () => {
    const registry = await loadRegistry({ marketplaces: ' POSHMARK ,\tDepop' });
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual(['poshmark', 'depop']);
  });

  it('skips ebay when only one of the two credentials is present', async () => {
    const registry = await loadRegistry({ marketplaces: 'ebay,facebook', ebayCreds: false });
    vi.stubEnv('EBAY_CLIENT_ID', 'id');
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual(['facebook']);
    expect(registry.getMarketplace('ebay')).toBeUndefined();
    expect(warnings.join('\n')).toContain('EBAY_CLIENT_ID');
  });

  it('registers ebay from environment credentials alone', async () => {
    const registry = await loadRegistry({ marketplaces: 'ebay' });
    registry.initializeMarketplaces();

    const ebay = registry.getMarketplace('ebay');
    expect(ebay).toBeInstanceOf(registry.EbayMarketplace);
    expect((ebay as InstanceType<Registry['EbayMarketplace']>).marketplaceId).toBe('EBAY_US');
  });

  it('skips the browser-backed marketplaces when Chrome is not found', async () => {
    const registry = await loadRegistry({ chrome: null });
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual(['facebook', 'ebay']);
    expect(warnings.filter((w) => w.includes('Chrome/Chromium not found'))).toHaveLength(2);
  });

  it('skips an unknown name and still registers the rest', async () => {
    const registry = await loadRegistry({ marketplaces: 'etsy,facebook' });
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual(['facebook']);
    expect(warnings.join('\n')).toContain('"etsy"');
  });

  it('registers nothing when MARKETPLACES is set but empty', async () => {
    const registry = await loadRegistry({ marketplaces: '  ,  ' });
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual([]);
    expect(registry.getAllMarketplaces()).toEqual([]);
  });

  it('adds to the previous registration instead of replacing it when called twice', async () => {
    const registry = await loadRegistry({ marketplaces: 'facebook' });
    registry.initializeMarketplaces();
    vi.stubEnv('MARKETPLACES', 'depop');
    registry.initializeMarketplaces();

    expect(registry.listMarketplaceNames()).toEqual(['facebook', 'depop']);
  });
});

describe('getMarketplace', () => {
  it('returns the same instance that getAllMarketplaces exposes', async () => {
    const registry = await loadRegistry();
    registry.initializeMarketplaces();

    const [first] = registry.getAllMarketplaces();
    expect(registry.getMarketplace('facebook')).toBe(first);
  });

  it('returns undefined for a marketplace that exists but was not enabled', async () => {
    const registry = await loadRegistry({ marketplaces: 'facebook' });
    registry.initializeMarketplaces();

    expect(registry.getMarketplace('depop')).toBeUndefined();
    expect(registry.getMarketplace('etsy')).toBeUndefined();
  });

  it('matches names case-sensitively even though MARKETPLACES parsing does not', async () => {
    const registry = await loadRegistry({ marketplaces: 'EBAY' });
    registry.initializeMarketplaces();

    expect(registry.getMarketplace('ebay')?.name).toBe('ebay');
    expect(registry.getMarketplace('EBAY')).toBeUndefined();
    expect(registry.getMarketplace('eBay')).toBeUndefined();
  });
});

describe('registerMarketplace', () => {
  it('replaces a duplicate name in place, keeping the registry size and order', async () => {
    const registry = await loadRegistry();
    registry.initializeMarketplaces();
    const replacement = stub('ebay');
    registry.registerMarketplace(replacement);

    expect(registry.listMarketplaceNames()).toEqual(['facebook', 'ebay', 'depop', 'poshmark']);
    expect(registry.getMarketplace('ebay')).toBe(replacement);
    expect(registry.getAllMarketplaces()[1]).toBe(replacement);
  });

  it('appends an unknown name', async () => {
    const registry = await loadRegistry({ marketplaces: 'facebook' });
    registry.initializeMarketplaces();
    registry.registerMarketplace(stub('mercari'));

    expect(registry.listMarketplaceNames()).toEqual(['facebook', 'mercari']);
    expect(registry.getMarketplace('mercari')?.displayName).toBe('stub:mercari');
  });

  it('keeps listMarketplaceNames aligned with getAllMarketplaces', async () => {
    const registry = await loadRegistry();
    registry.initializeMarketplaces();
    registry.registerMarketplace(stub('mercari'));
    registry.registerMarketplace(stub('facebook'));

    expect(registry.listMarketplaceNames()).toEqual(
      registry.getAllMarketplaces().map((m) => m.name)
    );
  });

  it('hands out a snapshot array that callers cannot mutate the registry through', async () => {
    const registry = await loadRegistry({ marketplaces: 'facebook,depop' });
    registry.initializeMarketplaces();

    registry.getAllMarketplaces().pop();
    expect(registry.listMarketplaceNames()).toEqual(['facebook', 'depop']);
  });
});

describe('BaseMarketplace.createError', () => {
  it('reports failure tagged with the subclass name', () => {
    expect(new TestMarketplace().error('boom')).toEqual({
      marketplace: 'test',
      success: false,
      listings: [],
      error: 'boom',
    });
  });

  it('gives each error its own listings array', () => {
    const mp = new TestMarketplace();
    const first = mp.error('a');
    first.listings.push({
      id: '1',
      title: 't',
      price: '$1',
      url: 'u',
      marketplace: 'test',
      scrapedAt: 'now',
    });

    expect(mp.error('b').listings).toEqual([]);
  });

  it('shapes a real marketplace failure without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = await loadRegistry({ ebayCreds: false });

    const result = await new registry.EbayMarketplace().search({ query: 'stroller' });

    expect(result.marketplace).toBe('ebay');
    expect(result.success).toBe(false);
    expect(result.listings).toEqual([]);
    expect(result.error).toContain('EBAY_CLIENT_SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('BaseMarketplace.healthCheck', () => {
  it('defaults to healthy', async () => {
    await expect(new TestMarketplace().healthCheck()).resolves.toBe(true);
  });
});

describe('BaseMarketplace.parsePrice', () => {
  it.each([
    ['$50', 50, '$'],
    ['$1,234.56', 1234.56, '$'],
    ['£25.00', 25, '£'],
    ['€899', 899, '€'],
    ['$ 40', 40, '$'],
    ['50', 50, '$'],
    ['was £80 now £30', 80, '£'],
  ])('parses %s', (input, numeric, currency) => {
    expect(new TestMarketplace().price(input)).toEqual({ numeric, currency });
  });

  it.each(['Price not listed', 'Free', 'Make an offer', ''])(
    'returns null for %s',
    (input) => {
      expect(new TestMarketplace().price(input)).toBeNull();
    }
  );

  it('reads a comma-decimal price as a decimal, not thousands', () => {
    expect(new TestMarketplace().price('€25,00')).toEqual({ numeric: 25, currency: '€' });
  });

  it('still reads repeated comma groups as thousands', () => {
    expect(new TestMarketplace().price('$1,234,567')).toEqual({ numeric: 1234567, currency: '$' });
  });

  it('keeps the cents of a single-decimal price', () => {
    expect(new TestMarketplace().price('$12.5')).toEqual({ numeric: 12.5, currency: '$' });
  });

  it('reports the currency of an ISO-code-prefixed price', () => {
    expect(new TestMarketplace().price('EUR45.00')?.currency).toBe('EUR');
    expect(new TestMarketplace().price('GBP12.99')?.currency).toBe('GBP');
  });
});
