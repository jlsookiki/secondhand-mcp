import { Listing, ListingDetails, ListingPart, SearchParams, SearchResult } from '../types.js';

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
  const photos = photoLine(listing.images, includeImages);
  if (photos) lines.push(indent + photos);
  lines.push(`${indent}🆔 ${listing.id}`);
  lines.push(`${indent}🔗 ${listing.url}`);
  return lines;
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

export function formatListingDetails(details: ListingDetails): string {
  const lines = [
    `📋 Listing Details`,
    `🔗 ${details.url}`,
    '',
  ];

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

  if (details.deliveryTypes && details.deliveryTypes.length > 0) {
    lines.push(`🚚 Delivery: ${details.deliveryTypes.join(', ')}`);
  }

  if (details.isShippingOffered) {
    lines.push(`📦 Shipping available`);
  }

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
