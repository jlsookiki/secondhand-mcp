import { expect, it, vi } from 'vitest';
import { registerMarketplace } from '../src/marketplaces/index.js';
import { searchMarketplace } from '../src/tools/search-marketplace.js';

it('passes an explicit zero limit to an adapter instead of requesting twenty listings', async () => {
  const search = vi.fn(async () => ({ marketplace: 'zero-limit-test', success: true, listings: [] }));
  registerMarketplace({ name: 'zero-limit-test', displayName: 'Test', requiresAuth: false,
    search, healthCheck: async () => true });
  await searchMarketplace({ marketplace: 'zero-limit-test', query: 'skis', limit: '0' });
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 0 }));
});
