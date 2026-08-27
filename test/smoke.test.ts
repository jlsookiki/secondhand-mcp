import { describe, expect, it, vi } from 'vitest';
import { EbayMarketplace, resizeEbayImageUrl } from '../src/marketplaces/ebay.js';

describe('runner smoke', () => {
  it('resolves a TypeScript ESM import from src/', () => {
    expect(resizeEbayImageUrl('https://i.ebayimg.com/thumbs/images/g/abc/s-l225.jpg', 1600)).toBe(
      'https://i.ebayimg.com/images/g/abc/s-l1600.jpg'
    );
  });

  it('routes src/ network calls through a stubbed global fetch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/oauth2/token')
        ? { access_token: 'test-token', expires_in: 7200 }
        : { total: 1, itemSummaries: [{ itemId: 'v1|1|0', title: 'Test Item' }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new EbayMarketplace({ clientId: 'id', clientSecret: 'secret' }).search({
      query: 'test',
      limit: 1,
    });

    expect(result.success).toBe(true);
    expect(result.listings.map((l) => l.title)).toEqual(['Test Item']);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.ebay.com/identity/v1/oauth2/token',
      'https://api.ebay.com/buy/browse/v1/item_summary/search?q=test&limit=1&offset=0',
    ]);
  });
});
