import { describe, expect, it } from 'vitest';
import {
  answersFromGroup,
  itemPageUrl,
  listsAllOptions,
  lookupPath,
  parseEbayItemRef,
  variationOf,
  type EbayItemRef,
} from '../src/marketplaces/ebay/items.js';

describe('parseEbayItemRef', () => {
  it.each([
    ['123456', { kind: 'listing', legacyId: '123456' }],
    ['  123456 ', { kind: 'listing', legacyId: '123456' }],
    ['v1|123456|0', { kind: 'listing', legacyId: '123456' }],
    ['v1|123456', { kind: 'listing', legacyId: '123456' }],
    ['v1|123456|789', { kind: 'variation', itemId: 'v1|123456|789', legacyId: '123456' }],
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
  const listing: EbayItemRef = { kind: 'listing', legacyId: '1' };
  const variation: EbayItemRef = { kind: 'variation', itemId: 'v1|1|2', legacyId: '1' };
  const opaque: EbayItemRef = { kind: 'opaque', itemId: 'abc' };

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
  const variation: EbayItemRef = { kind: 'variation', itemId: 'v1|1|2', legacyId: '1' };
  const listing: EbayItemRef = { kind: 'listing', legacyId: '1' };
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
