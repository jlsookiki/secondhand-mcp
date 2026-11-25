import { isEbayLink } from '../marketplaces/ebay/items.js';

const DEFAULT_MARKETPLACE = 'facebook';

export type ListingRef = { listingId: string; marketplace: string } | { error: string };

/**
 * The listing an id names and the marketplace to ask. The deep-research
 * `search` tool returns ids prefixed ("ebay:123") and shoppers paste eBay
 * links, and either one names the marketplace without the argument.
 */
export function resolveListingRef(rawId: string, rawMarketplace: string | undefined, marketplaces: string[]): ListingRef {
  const value = rawId.trim();
  const prefix = value.match(new RegExp(`^(${marketplaces.join('|')}):`, 'i'));
  const listingId = prefix ? value.slice(prefix[0].length).trim() : value;
  if (!listingId) return { error: 'Missing required parameter: listingId' };

  const named = prefix ? prefix[1].toLowerCase() : marketplaceOfLink(listingId);
  const given = rawMarketplace?.trim().toLowerCase() || undefined;
  // Ids are plain digits on several marketplaces, so a lookup under the wrong
  // one can succeed and answer about a different listing.
  if (named && given && named !== given) {
    return { error: `This id belongs to ${named}, but marketplace says ${given}. Pass the id on its own, or the marketplace it came from.` };
  }
  return { listingId, marketplace: given ?? named ?? DEFAULT_MARKETPLACE };
}

/** The marketplace a pasted link names, when the link alone settles it. */
export function marketplaceOfLink(value: string): string | undefined {
  return isEbayLink(value) ? 'ebay' : undefined;
}
