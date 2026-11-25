/** A listing number may name one item or a whole multi-variation group. */
export type EbayItemRef =
  | { kind: 'variation'; itemId: string; legacyId: string }
  | { kind: 'listing'; legacyId: string }
  | { kind: 'opaque'; itemId: string };

const RESTFUL_ID = /^v1\|(\d+)(?:\|(\d+))?$/;
const LEGACY_ID = /^\d+$/;
const NO_VARIATION = '0';

/** Search results carry `v1|<number>|<option>`; listing links show the bare number. */
export function parseEbayItemRef(raw: string): EbayItemRef {
  const value = raw.trim();
  if (LEGACY_ID.test(value)) return { kind: 'listing', legacyId: value };

  const restful = value.match(RESTFUL_ID);
  if (restful) return itemRef(restful[1], restful[2]);

  return { kind: 'opaque', itemId: value };
}

function itemRef(legacyId: string, variationId: string | undefined): EbayItemRef {
  if (!variationId || variationId === NO_VARIATION) return { kind: 'listing', legacyId };
  return { kind: 'variation', itemId: `v1|${legacyId}|${variationId}`, legacyId };
}

/** The option a Browse item id names, if it names one. */
export function variationOf(itemId: string): string | undefined {
  const variation = itemId.match(RESTFUL_ID)?.[2];
  return variation && variation !== NO_VARIATION ? variation : undefined;
}

/** The listing page for a Browse item id, opened on the option it names. */
export function itemPageUrl(itemId: string): string {
  const legacyId = itemId.match(RESTFUL_ID)?.[1] ?? itemId;
  const variation = variationOf(itemId);
  const selected = variation ? `?var=${variation}` : '';
  return `https://www.ebay.com/itm/${legacyId}${selected}`;
}

/** Browse errorIds: an item id that names nothing, and a listing number that names a whole group. */
const ITEM_NOT_FOUND = 11001;
const LEGACY_ID_IS_GROUP = 11006;

/** A listing number eBay calls a group, or an option gone while the listing still sells others. */
export function answersFromGroup(ref: EbayItemRef, errorIds: number[]): boolean {
  if (ref.kind === 'listing') return errorIds.includes(LEGACY_ID_IS_GROUP);
  if (ref.kind === 'variation') return errorIds.includes(ITEM_NOT_FOUND);
  return false;
}

/** An option that answered on its own still belongs to a listing whose other options the shopper may want. */
export function listsAllOptions(
  ref: EbayItemRef,
  item: { primaryItemGroup?: unknown } | null
): ref is Extract<EbayItemRef, { kind: 'variation' }> {
  return ref.kind === 'variation' && Boolean(item?.primaryItemGroup);
}

/** Single items are looked up by number; options and unrecognised ids by their Browse id. */
export function lookupPath(ref: EbayItemRef): string {
  if (ref.kind === 'listing') return `/item/get_item_by_legacy_id?legacy_item_id=${ref.legacyId}`;
  return `/item/${encodeURIComponent(ref.itemId)}`;
}

export function groupPath(groupId: string): string {
  return `/item/get_items_by_item_group?item_group_id=${encodeURIComponent(groupId)}`;
}
