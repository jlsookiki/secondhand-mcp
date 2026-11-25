import { parsePrice } from '../base.js';
import { Listing, ListingDetails, ListingOption, OptionFilter } from '../../types.js';
import { currencySymbol } from './currency.js';
import { descriptionText } from './description.js';
import { toFullResImageUrl } from './images.js';
import { itemPageUrl } from './items.js';
import {
  aspectsNamed,
  availableFirst,
  describedOption,
  isAvailable,
  optionValues,
  priceSpread,
  selectOptions,
  varyingAspectNames,
} from './options.js';
import { BrowseLocation, BrowsePrice, Item, ItemGroupResponse, ItemSummary } from './wire.js';

// 50 groups sampled in late September 2026 held a median of 25 options and up
// to 250. A few options plus every axis value answers most questions; naming
// the options wanted brings back up to the larger cap.
const SHOWN_OPTIONS = 10;
const MAX_OPTIONS = 30;

interface PriceText {
  text: string;
  numeric?: number;
}

/** Browse gives amount and currency as separate fields, so only the amount needs parsing. */
export function browsePrice(price: BrowsePrice | undefined): PriceText | undefined {
  if (!price) return undefined;
  const symbol = price.currency ? currencySymbol(price.currency) : '';
  return { text: `${symbol}${price.value}`, numeric: parsePrice(String(price.value))?.numeric };
}

export function summaryListing(item: ItemSummary): Listing {
  const currency = item.price?.currency ? currencySymbol(item.price.currency) : undefined;
  const price = browsePrice(item.price);

  // Only the primary image for search results; the full set comes with details.
  const image = item.image?.imageUrl ? toFullResImageUrl(item.image.imageUrl) : undefined;

  return {
    id: item.itemId,
    title: item.title || 'Untitled Listing',
    price: price?.text ?? 'Price not listed',
    priceNumeric: price?.numeric,
    currency: currency ?? '$',
    condition: item.condition,
    location: placeText(item.itemLocation, ['city', 'stateOrProvince']),
    url: item.itemWebUrl || itemPageUrl(item.itemId),
    images: image ? [image] : undefined,
    seller: item.seller?.username,
    marketplace: 'ebay',
    scrapedAt: new Date().toISOString(),
    ...(item.itemGroupHref && { hasOptions: true }),
  };
}

export function itemDetails(item: Item): ListingDetails {
  const additional = Array.isArray(item.additionalImages) ? item.additionalImages : [];
  const images = [item.image, ...additional].flatMap((image) =>
    image?.imageUrl ? [toFullResImageUrl(image.imageUrl)] : []
  );

  return {
    id: item.itemId,
    description: itemDescription(item),
    images,
    location: placeText(item.itemLocation, ['city', 'stateOrProvince', 'country']),
    seller: item.seller?.username ?? undefined,
    deliveryTypes: item.shippingOptions?.map((s) => s.shippingServiceCode) ?? undefined,
    isShippingOffered: Array.isArray(item.shippingOptions) && item.shippingOptions.length > 0,
    url: item.itemWebUrl ?? itemPageUrl(item.itemId),
  };
}

export interface GroupRequest {
  groupId: string;
  filter?: OptionFilter;
  /** The option the shopper asked about, which the answer describes and links unless their filter picks another. */
  chosen?: Item;
}

/** A multi-variation listing: one option described in full, plus what every option differs by and costs. */
export function groupDetails(group: ItemGroupResponse, { groupId, filter, chosen }: GroupRequest): ListingDetails {
  const items = Array.isArray(group.items) ? group.items : [];
  const ordered = availableFirst(items);
  const axes = varyingAspectNames(items);
  const selection = selectOptions(ordered, filter, { shown: SHOWN_OPTIONS, max: MAX_OPTIONS });
  const described = describedOption(chosen, selection, ordered);
  const shown = described.option;
  const sharedDescription = group.commonDescriptions?.[0]?.description;
  const linkedId = described.linksOption ? shown.itemId : `v1|${groupId}|0`;

  return {
    ...itemDetails({ ...shown, description: shown.description ?? sharedDescription }),
    url: described.linksOption && shown.itemWebUrl ? shown.itemWebUrl : itemPageUrl(linkedId),
    optionAxes: axes,
    optionValues: optionValues(items, axes),
    priceRange: priceRange(items),
    options: selection.listed.map((item) => listingOption(item, axes)),
    optionCount: items.length,
    optionFilter: filter,
    matchingOptions: selection.matching,
  };
}

function priceRange(items: Item[]): ListingDetails['priceRange'] {
  const spread = priceSpread(items);
  if (!spread) return undefined;
  const low = browsePrice(spread.low.price)!;
  const high = browsePrice(spread.high.price)!;
  return { low: low.text, high: high.text, lowNumeric: low.numeric, highNumeric: high.numeric };
}

function listingOption(item: Item, axes: string[]): ListingOption {
  const price = browsePrice(item.price);
  return {
    id: item.itemId,
    aspects: aspectsNamed(item, axes),
    price: price?.text,
    priceNumeric: price?.numeric,
    available: isAvailable(item),
    url: item.itemWebUrl ?? itemPageUrl(item.itemId),
  };
}

function itemDescription(item: Item): string | undefined {
  const text = item.description ? descriptionText(item.description) : '';
  return text || item.shortDescription || undefined;
}

function placeText(location: BrowseLocation | undefined, parts: Array<keyof BrowseLocation>): string | undefined {
  return parts.map((part) => location?.[part]).filter(Boolean).join(', ') || undefined;
}
