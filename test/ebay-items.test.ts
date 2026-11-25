import { describe, expect, it } from 'vitest';
import {
  answersFromGroup,
  isEbayLink,
  itemPageUrl,
  listsAllOptions,
  lookupPath,
  parseEbayItemRef,
  shareLinkTarget,
  variationOf,
  type EbayLookupRef,
} from '../src/marketplaces/ebay/items.js';

describe('parseEbayItemRef', () => {
  it.each([
    ['123456', { kind: 'listing', legacyId: '123456' }],
    ['  123456 ', { kind: 'listing', legacyId: '123456' }],
    ['v1|123456|0', { kind: 'listing', legacyId: '123456' }],
    ['v1|123456', { kind: 'listing', legacyId: '123456' }],
    ['v1|123456|789', { kind: 'variation', itemId: 'v1|123456|789', legacyId: '123456' }],
    ['https://www.ebay.com/itm/123456', { kind: 'listing', legacyId: '123456' }],
    ['https://www.ebay.co.uk/itm/Blue-Lamp-Shade/123456?hash=abc', { kind: 'listing', legacyId: '123456' }],
    ['https://www.ebay.com/itm/123456?var=789', { kind: 'variation', itemId: 'v1|123456|789', legacyId: '123456' }],
    ['https://www.ebay.com/itm/123456?mkevt=1&var=789#tabs', { kind: 'variation', itemId: 'v1|123456|789', legacyId: '123456' }],
    ['https://www.ebay.com/itm/123456?var=0', { kind: 'listing', legacyId: '123456' }],
    ['https://www.ebay.com/itm/123456?var=abc', { kind: 'listing', legacyId: '123456' }],
    ['https://ebay.us/m/m2KbLr', { kind: 'share', url: 'https://ebay.us/m/m2KbLr' }],
    ['ebay.us/m/m2KbLr', { kind: 'share', url: 'https://ebay.us/m/m2KbLr' }],
    ['http://EBAY.US/QNKrx1/', { kind: 'share', url: 'https://ebay.us/QNKrx1' }],
    ['https://ebay.io/m/j83XnV', { kind: 'share', url: 'https://ebay.io/m/j83XnV' }],
    ['https://ebay.to/m/j83XnV', { kind: 'opaque', itemId: 'https://ebay.to/m/j83XnV' }],
    ['https://ebay.us/m/m2KbLr?_trkparms=x', { kind: 'share', url: 'https://ebay.us/m/m2KbLr' }],
    ['https://ebay.us/m/../../evil', { kind: 'opaque', itemId: 'https://ebay.us/m/../../evil' }],
    ['https://ebay.us.evil.com/m/abc123', { kind: 'opaque', itemId: 'https://ebay.us.evil.com/m/abc123' }],
    ['https://evil.example/ebay.us/m/abc123', { kind: 'opaque', itemId: 'https://evil.example/ebay.us/m/abc123' }],
    ['960039748485|0', { kind: 'listing', legacyId: '960039748485' }],
    [' 123456|789 ', { kind: 'variation', itemId: 'v1|123456|789', legacyId: '123456' }],
    ['123456|', { kind: 'opaque', itemId: '123456|' }],
    ['|123456|0', { kind: 'opaque', itemId: '|123456|0' }],
    ['1|2|3', { kind: 'opaque', itemId: '1|2|3' }],
    ['v1|abc|1', { kind: 'opaque', itemId: 'v1|abc|1' }],
    ['something-else', { kind: 'opaque', itemId: 'something-else' }],
  ])('%j is %j', (raw, ref) => {
    expect(parseEbayItemRef(raw)).toEqual(ref);
  });
});

describe('variationOf', () => {
  it.each([
    ['v1|1|77', '77'],
    ['v1|1|0', undefined],
    ['v1|1', undefined],
    ['123', undefined],
  ])('%j names option %j', (itemId, variation) => {
    expect(variationOf(itemId)).toBe(variation);
  });
});

describe('itemPageUrl', () => {
  it.each([
    ['v1|123|0', 'https://www.ebay.com/itm/123'],
    ['v1|123|77', 'https://www.ebay.com/itm/123?var=77'],
    ['123', 'https://www.ebay.com/itm/123'],
  ])('opens %j at %s', (itemId, url) => {
    expect(itemPageUrl(itemId)).toBe(url);
  });
});

describe('answersFromGroup', () => {
  const listing: EbayLookupRef = { kind: 'listing', legacyId: '1' };
  const variation: EbayLookupRef = { kind: 'variation', itemId: 'v1|1|2', legacyId: '1' };
  const opaque: EbayLookupRef = { kind: 'opaque', itemId: 'abc' };

  it.each([
    [listing, [11006], true],
    [listing, [11003], false],
    [listing, [11001], false],
    [variation, [11001], true],
    [variation, [11006], false],
    [variation, [11004], false],
    [opaque, [11001], false],
    [listing, [], false],
  ] as const)('%j with errors %j answers from the group: %s', (ref, errorIds, fromGroup) => {
    expect(answersFromGroup(ref, [...errorIds])).toBe(fromGroup);
  });
});

describe('listsAllOptions', () => {
  const variation: EbayLookupRef = { kind: 'variation', itemId: 'v1|1|2', legacyId: '1' };
  const listing: EbayLookupRef = { kind: 'listing', legacyId: '1' };
  const grouped = { primaryItemGroup: { itemGroupId: '1' } };

  it.each([
    [variation, grouped, true],
    [variation, {}, false],
    [variation, null, false],
    [listing, grouped, false],
  ] as const)('%j of %j lists every option: %s', (ref, item, all) => {
    expect(listsAllOptions(ref, item)).toBe(all);
  });
});

describe('lookupPath', () => {
  it.each([
    [{ kind: 'listing', legacyId: '1' }, '/item/get_item_by_legacy_id?legacy_item_id=1'],
    [{ kind: 'variation', itemId: 'v1|1|2', legacyId: '1' }, '/item/v1%7C1%7C2'],
    [{ kind: 'opaque', itemId: 'a/b' }, '/item/a%2Fb'],
  ] as const)('looks %j up at %s', (ref, path) => {
    expect(lookupPath(ref)).toBe(path);
  });
});

describe('isEbayLink', () => {
  it.each([
    ['https://ebay.us/m/m2KbLr', true],
    ['https://ebay.io/m/j83XnV', true],
    ['ebay.us/m/m2KbLr', true],
    ['https://www.ebay.com/itm/123', true],
    ['https://www.ebay.co.uk/itm/123', true],
    ['m.ebay.com/itm/123', true],
    ['https://notebay.com/itm/123', false],
    ['https://ebay.com.evil.net/itm/123', false],
    ['123456', false],
    ['v1|123|0', false],
    ['https://www.facebook.com/marketplace/item/1', false],
  ])('%s is an eBay link: %s', (value, isLink) => {
    expect(isEbayLink(value)).toBe(isLink);
  });
});

describe('shareLinkTarget', () => {
  const location = 'https://www.ebay.com/itm/156788667537?mkcid=16&mkevt=1&var=&media=COPY';

  it.each([
    [301, location, { kind: 'listing', legacyId: '156788667537' }],
    [302, 'https://www.ebay.co.uk/itm/405972270309?var=77', { kind: 'variation', itemId: 'v1|405972270309|77', legacyId: '405972270309' }],
    [200, location, undefined],
    [404, null, undefined],
    [301, null, undefined],
    [301, 'https://evil.example/itm/156788667537', undefined],
    [301, 'https://ebay.us/m/another', undefined],
    [301, 'https://www.ebay.com/sch/i.html?_nkw=lamp', undefined],
    [301, 'not a url', undefined],
  ] as const)('a %s to %j names %j', (status, target, ref) => {
    expect(shareLinkTarget(status, target)).toEqual(ref);
  });
});
