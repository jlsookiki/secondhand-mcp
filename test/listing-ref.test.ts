import { describe, expect, it } from 'vitest';
import { marketplaceOfLink, resolveListingRef } from '../src/tools/listing-ref.js';

const NAMES = ['facebook', 'ebay', 'depop'];

describe('resolveListingRef', () => {
  it.each([
    [['123', undefined], { listingId: '123', marketplace: 'facebook' }],
    [['123', 'ebay'], { listingId: '123', marketplace: 'ebay' }],
    [[' 123 ', ' EBAY '], { listingId: '123', marketplace: 'ebay' }],
    [['ebay:555', undefined], { listingId: '555', marketplace: 'ebay' }],
    [['EBAY:555', 'ebay'], { listingId: '555', marketplace: 'ebay' }],
    [['ebay:v1|555|0', undefined], { listingId: 'v1|555|0', marketplace: 'ebay' }],
    [['https://www.ebay.com/itm/555?var=12', undefined], { listingId: 'https://www.ebay.com/itm/555?var=12', marketplace: 'ebay' }],
    [['https://ebay.us/m/m2KbLr', undefined], { listingId: 'https://ebay.us/m/m2KbLr', marketplace: 'ebay' }],
    [['https://ebay.us/m/m2KbLr', 'ebay'], { listingId: 'https://ebay.us/m/m2KbLr', marketplace: 'ebay' }],
    [['etsy:9', undefined], { listingId: 'etsy:9', marketplace: 'facebook' }],
    [['etsy:9', 'depop'], { listingId: 'etsy:9', marketplace: 'depop' }],
  ] as const)('reads %j as %j', ([id, marketplace], ref) => {
    expect(resolveListingRef(id, marketplace, NAMES)).toEqual(ref);
  });

  it.each([
    [['ebay:555', 'facebook'], { listingId: '555', marketplace: 'ebay' }],
    [['https://www.ebay.com/itm/555', 'facebook'], { listingId: 'https://www.ebay.com/itm/555', marketplace: 'ebay' }],
    [['https://ebay.us/m/m2KbLr', 'facebook'], { listingId: 'https://ebay.us/m/m2KbLr', marketplace: 'ebay' }],
    [['depop:abc', 'ebay'], { listingId: 'abc', marketplace: 'depop' }],
  ] as const)('lets %j open where the id itself says: %j', ([id, marketplace], ref) => {
    expect(resolveListingRef(id, marketplace, NAMES)).toEqual(ref);
  });

  it('refuses a prefix with no id after it', () => {
    expect(resolveListingRef('ebay: ', undefined, NAMES)).toEqual({ error: 'Missing required parameter: listingId' });
  });
});

describe('marketplaceOfLink', () => {
  it.each([
    ['https://www.ebay.de/itm/1', 'ebay'],
    ['ebay.io/m/j83XnV', 'ebay'],
    ['https://www.facebook.com/marketplace/item/1', undefined],
    ['123', undefined],
  ])('%s names %s', (value, marketplace) => {
    expect(marketplaceOfLink(value)).toBe(marketplace);
  });
});
