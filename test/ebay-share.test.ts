import { afterEach, describe, expect, it, vi } from 'vitest';
import { followShareLink } from '../src/marketplaces/ebay/share.js';

afterEach(() => vi.unstubAllGlobals());

describe('followShareLink', () => {
  it('reads where the link redirects without following it', async () => {
    const cancel = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => ({
      status: 301,
      headers: new Headers({ location: 'https://www.ebay.co.uk/itm/405972270309?var=&media=COPY' }),
      body: { cancel },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const target = await followShareLink('https://ebay.io/m/j83XnV');

    expect(target).toEqual({ kind: 'listing', legacyId: '405972270309' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ebay.io/m/j83XnV',
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) })
    );
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    ['a page', () => new Response('<html></html>', { status: 200 })],
    ['a redirect off eBay', () => new Response(null, { status: 301, headers: { location: 'https://evil.example/itm/1' } })],
  ])('refuses a link that answers with %s', async (_label, answer) => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    await expect(followShareLink('https://ebay.us/m/abc123')).rejects.toThrow(/^eBay share link did not resolve \(\d+\)$/);
  });

  it('passes on a link that cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    await expect(followShareLink('https://ebay.us/m/abc123')).rejects.toThrow('timeout');
  });
});
