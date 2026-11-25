import { Listing, ListingAvailability, ListingDetails, ListingPart, SearchParams, SearchResult } from '../types.js';

const ALL_MARKETPLACES_PER_SOURCE = 10;

export function formatSingleResult(result: SearchResult, params: SearchParams, includeImages: boolean): string {
  if (!result.success) {
    return `❌ ${result.marketplace}: ${result.error}`;
  }

  if (result.listings.length === 0) {
    return `No listings found for "${params.query}" in ${params.location}` + (result.note ? `\n\n${result.note}` : '');
  }

  const lines = [
    `🔍 Found ${result.listings.length} listings for "${params.query}" on ${result.marketplace}`,
    `📍 Location: ${params.location}`,
    ...(result.note ? [result.note] : []),
    '',
  ];

  for (const listing of cheapestFirst(result.listings)) {
    lines.push(`**${listing.price}** - ${listing.title}`);
    if (listing.location) {
      lines.push(`   📍 ${listing.location}`);
    }
    lines.push(...listingFooter(listing, includeImages, '   '));
    lines.push('');
  }

  return lines.join('\n');
}

export function formatMultipleResults(results: SearchResult[], params: SearchParams, includeImages: boolean): string {
  const lines = [
    `🔍 Search results for "${params.query}" across all marketplaces`,
    `📍 Location: ${params.location}`,
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.marketplace}`);

    if (!result.success) {
      lines.push(`❌ Error: ${result.error}`);
    } else if (result.listings.length === 0) {
      lines.push('No listings found');
    } else {
      lines.push(`Found ${result.listings.length} listings:`);
      for (const listing of cheapestFirst(result.listings).slice(0, ALL_MARKETPLACES_PER_SOURCE)) {
        lines.push(`  • **${listing.price}** - ${listing.title}`);
        lines.push(...listingFooter(listing, includeImages, '    '));
      }
    }

    if (result.success && result.note) lines.push(result.note);
    lines.push('');
  }

  return lines.join('\n');
}

/** Listings without a numeric price (free, trade) sort first. */
function cheapestFirst(listings: Listing[]): Listing[] {
  return [...listings].sort((a, b) => (a.priceNumeric || 0) - (b.priceNumeric || 0));
}

function listingFooter(listing: Listing, includeImages: boolean, indent: string): string[] {
  const lines: string[] = [];
  const shipping = shippingLine(listing);
  if (shipping) lines.push(indent + shipping);
  const photos = photoLine(listing.images, includeImages);
  if (photos) lines.push(indent + photos);
  lines.push(`${indent}🆔 ${listing.id}`);
  lines.push(`${indent}🔗 ${listing.url}`);
  return lines;
}

/** A search result's cheapest shipping and, when that is a known amount, what it costs delivered. */
export function shippingLine(listing: Pick<Listing, 'shipping' | 'total'>): string | undefined {
  if (!listing.shipping) return undefined;
  const total = listing.total ? ` (${listing.total} delivered)` : '';
  return `📦 Shipping: ${listing.shipping}${total}`;
}

function photoLine(images: string[] | undefined, includeImages: boolean): string | undefined {
  if (!images?.length) return undefined;
  if (includeImages) return `🖼️ Images: ${images.join(' , ')}`;
  return `📷 ${images.length} photo${images.length > 1 ? 's' : ''}`;
}

const UNAVAILABLE_NOTES: Record<ListingPart, string> = {
  photos: "Photos couldn't be loaded right now; asking again may bring them back.",
  description: "The description, location and seller couldn't be loaded right now; asking again may bring them back.",
};

const AVAILABILITY_TEXT: Record<ListingAvailability, string> = {
  available: '✅ Still for sale',
  pending: '⏳ Sale pending',
  sold: '🚫 Marked sold',
  unavailable: '🚫 No longer listed',
};

const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;

/** The listing's own facts (price, condition, age, whether it is still for sale), one line each. */
export function factLines(details: ListingDetails): string[] {
  const lines: string[] = [];
  if (details.price) lines.push(`💰 ${priceText(details.price, details.originalPrice)}`);
  if (details.condition) lines.push(`✨ Condition: ${details.condition}`);
  if (details.listedAt) lines.push(`📅 Listed ${details.listedAt.slice(0, ISO_DATE_LENGTH)}`);
  if (details.availability) lines.push(AVAILABILITY_TEXT[details.availability]);
  return lines;
}

function priceText(price: string, originalPrice: string | undefined): string {
  return originalPrice ? `${price} (was ${originalPrice})` : price;
}

/** The cheapest shipping and what each service costs, or just whether it ships when the marketplace gives no costs. */
export function detailShippingLines(details: ListingDetails): string[] {
  if (!details.shipping) return details.isShippingOffered ? ['📦 Shipping available'] : [];
  const services = (details.shippingOptions ?? []).map(
    (option) => `   ${option.service ?? 'Shipping'}: ${option.cost}`
  );
  return [`📦 Shipping: ${details.shipping}`, ...services];
}

export function formatListingDetails(details: ListingDetails): string {
  const lines = [
    `📋 Listing Details`,
    ...(details.title ? [`**${details.title}**`] : []),
    `🔗 ${details.url}`,
    '',
  ];

  const facts = factLines(details);
  if (facts.length > 0) {
    lines.push(...facts);
    lines.push('');
  }

  if (details.description) {
    lines.push(`**Description:** ${details.description}`);
    lines.push('');
  }

  if (details.location) {
    lines.push(`📍 ${details.location}`);
  }

  if (details.seller) {
    lines.push(`👤 Seller: ${details.seller}`);
  }

  if (details.brand) {
    lines.push(`🏷️ Brand: ${details.brand}`);
  }

  if (details.deliveryTypes && details.deliveryTypes.length > 0) {
    lines.push(`🚚 Delivery: ${details.deliveryTypes.join(', ')}`);
  }

  lines.push(...detailShippingLines(details));

  for (const part of details.unavailable ?? []) {
    lines.push(`⚠️ ${UNAVAILABLE_NOTES[part]}`);
  }

  if (details.images.length > 0) {
    lines.push('');
    lines.push(`🖼️ Photos (${details.images.length}):`);
    for (const img of details.images) {
      lines.push(`   ${img}`);
    }
  }

  return lines.join('\n');
}
