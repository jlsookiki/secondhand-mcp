import { describe, expect, it } from 'vitest';
import { factLines, formatListingDetails } from '../src/tools/format.js';
import { registerMarketplace } from '../src/marketplaces/index.js';
import { researchFetch } from '../src/tools/deep-research.js';
import type { ListingDetails } from '../src/types.js';

const details = (over: Partial<ListingDetails> = {}): ListingDetails => ({
  id: '9182736',
  images: [],
  url: 'https://www.facebook.com/marketplace/item/9182736',
  ...over,
});

describe('factLines', () => {
  it('writes price, the price before a drop, condition, listing date and availability', () => {
    const facts = factLines(
      details({
        price: '$400',
        originalPrice: '$500',
        condition: 'Used - like new',
        listedAt: '2026-09-21T14:13:20.000Z',
        availability: 'available',
      })
    );

    expect(facts).toEqual(['💰 $400 (was $500)', '✨ Condition: Used - like new', '📅 Listed 2026-09-21', '✅ Still for sale']);
  });

  it.each([
    ['pending', '⏳ Sale pending'],
    ['sold', '🚫 Marked sold'],
    ['unavailable', '🚫 No longer listed'],
  ] as const)('says a %s listing is %s', (availability, line) => {
    expect(factLines(details({ availability }))).toEqual([line]);
  });

  it('writes a price without a drop on its own', () => {
    expect(factLines(details({ price: '$400' }))).toEqual(['💰 $400']);
  });

  it('writes nothing when the listing carries no facts', () => {
    expect(factLines(details())).toEqual([]);
  });
});

describe('formatListingDetails facts', () => {
  it('names the listing and lists its facts ahead of the description', () => {
    const text = formatListingDetails(
      details({ title: 'Trek road bike', price: '$400', availability: 'sold', description: 'Barely ridden.' })
    );

    expect(text.split('\n')).toEqual([
      '📋 Listing Details',
      '**Trek road bike**',
      '🔗 https://www.facebook.com/marketplace/item/9182736',
      '',
      '💰 $400',
      '🚫 Marked sold',
      '',
      '**Description:** Barely ridden.',
      '',
    ]);
  });

  it('adds no facts block when there are none', () => {
    expect(formatListingDetails(details()).split('\n')).toEqual([
      '📋 Listing Details',
      '🔗 https://www.facebook.com/marketplace/item/9182736',
      '',
    ]);
  });
});

describe('research fetch facts', () => {
  const fetchFrom = async (listing: ListingDetails) => {
    registerMarketplace({
      name: 'factsmarket',
      displayName: 'Facts market',
      requiresAuth: false,
      search: async () => ({ marketplace: 'factsmarket', success: true, listings: [] }),
      healthCheck: async () => true,
      getListingDetails: async () => listing,
    } as never);
    const reply = await researchFetch({ id: `factsmarket:${listing.id}` });
    return JSON.parse((reply.content[0] as { text: string }).text);
  };

  it('titles the document with the listing title and carries its facts as metadata', async () => {
    const document = await fetchFrom(
      details({
        title: 'Trek road bike',
        description: 'Barely ridden.',
        price: '$400',
        originalPrice: '$500',
        condition: 'Used - like new',
        listedAt: '2026-09-21T14:13:20.000Z',
        availability: 'available',
      })
    );

    expect(document.title).toBe('Trek road bike');
    expect(document.metadata).toMatchObject({
      price: '$400',
      originalPrice: '$500',
      condition: 'Used - like new',
      listedAt: '2026-09-21T14:13:20.000Z',
      availability: 'available',
    });
  });

  it('falls back to the description for a title when the listing has none', async () => {
    expect((await fetchFrom(details({ description: 'Barely ridden.\nGarage kept.' }))).title).toBe('Barely ridden.');
  });
});
