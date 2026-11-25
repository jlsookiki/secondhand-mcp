import { Listing, ListingAvailability, ListingDetails, ListingOption, ListingPart, SearchParams, SearchResult } from '../types.js';

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
  if (listing.hasOptions) lines.push(`${indent}🎛️ ${PRICE_IS_FOR_ONE_OPTION}`);
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

const PRICE_IS_FOR_ONE_OPTION =
  'Sold in several options that can be priced differently; this price is for one of them. Open the listing with get_listing_details before quoting the price of a particular option.';

const UNAVAILABLE_NOTES: Record<ListingPart, string> = {
  photos: "Photos couldn't be loaded right now; asking again may bring them back.",
  description: "The price, condition, description, location and seller couldn't be loaded right now; asking again may bring them back.",
  options: "This listing's other options couldn't be loaded right now; asking again may bring them back.",
};

const AVAILABILITY_TEXT: Record<ListingAvailability, string> = {
  available: '✅ Still for sale',
  pending: '⏳ Sale pending',
  sold: '🚫 Marked sold',
  unavailable: '🚫 No longer listed',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

/**
 * How long ago a listing went up, by elapsed time rather than calendar date: a UTC date reads as
 * tomorrow for a US shopper whose seller listed it in the evening.
 */
export function listingAge(listedAt: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(listedAt)) / MS_PER_DAY));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < DAYS_PER_WEEK) return `${days} days ago`;
  if (days < DAYS_PER_MONTH) return unitsAgo(Math.floor(days / DAYS_PER_WEEK), 'week');
  return unitsAgo(Math.floor(days / DAYS_PER_MONTH), 'month');
}

function unitsAgo(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/** The listing's own facts (price, condition, age, whether it is still for sale), one line each. */
export function factLines(details: ListingDetails, now: Date): string[] {
  const lines: string[] = [];
  if (details.price) lines.push(`💰 ${priceText(details.price, details.originalPrice)}`);
  if (details.condition) lines.push(`✨ Condition: ${details.condition}`);
  if (details.listedAt) lines.push(`📅 Listed ${listingAge(details.listedAt, now)}`);
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

export function formatListingDetails(details: ListingDetails, now = new Date()): string {
  const lines = [
    `📋 Listing Details`,
    ...(details.title ? [`**${details.title}**`] : []),
    `🔗 ${details.url}`,
    '',
  ];

  const facts = factLines(details, now);
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

  if (details.optionCount !== undefined) {
    lines.push('');
    lines.push(...optionLines(details));
  } else {
    const note = optionsNote(details);
    if (note) lines.push(`ℹ️ ${note}`);
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

function optionLines(details: ListingDetails): string[] {
  const axes = details.optionAxes?.length ? `, differing by ${details.optionAxes.join(', ')}` : '';
  const lines = [`🎛️ Options (${details.optionCount} in all${axes}):`];
  for (const [axis, values] of Object.entries(details.optionValues ?? {})) {
    lines.push(`   ${axis}: ${values.join(', ')}`);
  }
  if (details.priceRange) {
    lines.push(`   Prices from ${details.priceRange.low} to ${details.priceRange.high}`);
  }
  for (const option of details.options ?? []) {
    lines.push(`   • ${optionLine(option)}`);
  }
  const note = optionsNote(details);
  if (note) lines.push(`ℹ️ ${note}`);
  return lines;
}

function optionLine(option: ListingOption): string {
  const aspects = Object.entries(option.aspects).map(([axis, value]) => `${axis} ${value}`);
  const parts = [aspects.join(', ') || 'Option', option.price ?? 'Price not listed'];
  if (!option.available) parts.push('sold out');
  parts.push(`🆔 ${option.id}`, `🔗 ${option.url}`);
  return parts.join(' · ');
}

const NO_OPTION_MATCHES =
  "No option of this listing matches that choice. Check it against the values listed above: if the shopper's choice is there under a slightly different name, look again using that name; if it is not there, tell the shopper which values the listing does come in.";

const SOLD_AS_ONE_ITEM =
  'This listing is sold as one item, so the options choice does not apply; check its description for the size, colour or other details.';

/** What the assistant is told about options it was not shown, if anything. */
export function optionsNote(details: ListingDetails): string | undefined {
  if (details.optionCount === undefined) return details.optionFilter ? SOLD_AS_ONE_ITEM : undefined;
  const shown = details.options?.length ?? 0;
  if (details.optionFilter) {
    if (!details.matchingOptions) return NO_OPTION_MATCHES;
    if (details.matchingOptions > shown) {
      return `${details.matchingOptions} options match and ${shown} are shown. Narrow the options choice to see the rest.`;
    }
    return undefined;
  }
  if (details.optionCount <= shown) return undefined;
  const axis = details.optionAxes?.[0];
  if (!axis) return `This listing has ${details.optionCount} options and ${shown} are shown.`;
  return `This listing has ${details.optionCount} options and ${shown} are shown; the values above are every value they come in. To show the ones the shopper wants, look the listing up again with options set to their choice, for example {"${axis}": ["<value>"]}.`;
}
