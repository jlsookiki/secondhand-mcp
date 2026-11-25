/** A listing number may name one item or a whole multi-variation group. */
export type EbayLookupRef =
  | { kind: 'variation'; itemId: string; legacyId: string }
  | { kind: 'listing'; legacyId: string }
  | { kind: 'opaque'; itemId: string };

/** A link from eBay's Share button, which names its listing only through a redirect. */
export type EbayItemRef = EbayLookupRef | { kind: 'share'; url: string };

const RESTFUL_ID = /^v1\|(\d+)(?:\|(\d+))?$/;
const TRIMMED_ID = /^(\d+)\|(\d+)$/;
const LEGACY_ID = /^\d+$/;
const ITEM_URL = /\/itm\/(?:[^/?#]*\/)?(\d+)/;
// eBay's Share button hands out codes on two domains that do not share codes.
const SHARE_LINK = /^(?:https?:\/\/)?ebay\.(us|io)\/((?:m\/)?[A-Za-z0-9]{4,16})\/?(?:[?#].*)?$/i;
const EBAY_HOST = /(?:^|\.)ebay\.(?:com|co\.uk|com\.au|ca|de|fr|it|es|ie|at|ch|nl|be|pl|com\.hk|com\.sg|com\.my|ph|us|io)$/i;
const NO_VARIATION = '0';

/** Assistants pass back search ids, with or without their `v1|`, bare listing numbers, or a listing or Share link. */
export function parseEbayItemRef(raw: string): EbayItemRef {
  const value = raw.trim();
  if (LEGACY_ID.test(value)) return { kind: 'listing', legacyId: value };

  // The code is rebuilt into a fixed https://ebay.us or ebay.io URL, so nothing else the caller wrote is ever requested.
  const share = value.match(SHARE_LINK);
  if (share) return { kind: 'share', url: `https://ebay.${share[1].toLowerCase()}/${share[2]}` };

  const restful = value.match(RESTFUL_ID) ?? value.match(TRIMMED_ID);
  if (restful) return itemRef(restful[1], restful[2]);

  const link = value.match(ITEM_URL);
  if (link) return itemRef(link[1], urlVariation(value));

  return { kind: 'opaque', itemId: value };
}

function urlVariation(link: string): string | undefined {
  const query = link.split('?')[1]?.split('#')[0];
  const variation = new URLSearchParams(query ?? '').get('var');
  return variation && LEGACY_ID.test(variation) ? variation : undefined;
}

function itemRef(legacyId: string, variationId: string | undefined): EbayLookupRef {
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
export function answersFromGroup(ref: EbayLookupRef, errorIds: number[]): boolean {
  if (ref.kind === 'listing') return errorIds.includes(LEGACY_ID_IS_GROUP);
  if (ref.kind === 'variation') return errorIds.includes(ITEM_NOT_FOUND);
  return false;
}

/** An option that answered on its own still belongs to a listing whose other options the shopper may want. */
export function listsAllOptions(
  ref: EbayLookupRef,
  item: { primaryItemGroup?: unknown } | null
): ref is Extract<EbayLookupRef, { kind: 'variation' }> {
  return ref.kind === 'variation' && Boolean(item?.primaryItemGroup);
}

/** Single items are looked up by number; options and unrecognised ids by their Browse id. */
export function lookupPath(ref: EbayLookupRef): string {
  if (ref.kind === 'listing') return `/item/get_item_by_legacy_id?legacy_item_id=${ref.legacyId}`;
  return `/item/${encodeURIComponent(ref.itemId)}`;
}

export function groupPath(groupId: string): string {
  return `/item/get_items_by_item_group?item_group_id=${encodeURIComponent(groupId)}`;
}

function hostOf(link: string): string | undefined {
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).hostname;
  } catch {
    return undefined;
  }
}

/** A link on an eBay site names its marketplace as surely as an "ebay:" prefix does. */
export function isEbayLink(value: string): boolean {
  const host = hostOf(value.trim());
  return !!host && EBAY_HOST.test(host);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Where a Share link sends its shopper, if that is an eBay listing; the target is parsed, never fetched. */
export function shareLinkTarget(status: number, location: string | null): EbayLookupRef | undefined {
  if (!REDIRECT_STATUSES.has(status) || !location) return undefined;
  const host = hostOf(location);
  if (!host || !EBAY_HOST.test(host)) return undefined;
  const target = parseEbayItemRef(location);
  return target.kind === 'listing' || target.kind === 'variation' ? target : undefined;
}
