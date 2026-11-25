import { isEbayLink } from '../marketplaces/ebay/items.js';

const DEFAULT_MARKETPLACE = 'facebook';

export type ListingRef = { listingId: string; marketplace: string } | { error: string };

/**
 * The listing an id names and the marketplace to ask. The deep-research
 * `search` tool returns ids prefixed ("ebay:123") and shoppers paste eBay
 * links; either one settles the marketplace, even over the argument, which
 * assistants often fill with the schema's default.
 */
export function resolveListingRef(rawId: string, rawMarketplace: string | undefined, marketplaces: string[]): ListingRef {
  const value = rawId.trim();
  const prefix = value.match(new RegExp(`^(${marketplaces.join('|')}):`, 'i'));
  const listingId = prefix ? value.slice(prefix[0].length).trim() : value;
  if (!listingId) return { error: 'Missing required parameter: listingId' };

  const named = prefix ? prefix[1].toLowerCase() : marketplaceOfLink(listingId);
  const given = rawMarketplace?.trim().toLowerCase() || undefined;
  return { listingId, marketplace: named ?? given ?? DEFAULT_MARKETPLACE };
}

/** The marketplace a pasted link names, when the link alone settles it. */
export function marketplaceOfLink(value: string): string | undefined {
  return isEbayLink(value) ? 'ebay' : undefined;
}
