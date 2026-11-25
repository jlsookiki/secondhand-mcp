import { parsePrice } from '../base.js';
import { Listing, ListingDetails } from '../../types.js';
import { currencySymbol } from './currency.js';
import { descriptionText } from './description.js';
import { toFullResImageUrl } from './images.js';
import { ShippingQuote, cheapestShipping, deliveredTotal, shippedOptions } from './shipping.js';
import { BrowseLocation, BrowsePrice, Item, ItemSummary } from './wire.js';

const SHIPPING_FREE = 'Free';
const SHIPPING_CALCULATED = 'Calculated at checkout';
const CENT_DECIMALS = 2;

export function summaryListing(item: ItemSummary): Listing {
  // Browse gives amount and currency as separate fields, so only the
  // amount needs parsing; the currency is already known.
  const currency = item.price?.currency ? currencySymbol(item.price.currency) : undefined;
  const price = item.price ? `${currency}${item.price.value}` : 'Price not listed';
  const parsed = item.price ? parsePrice(String(item.price.value)) : null;

  // Only the primary image for search results; the full set comes with details.
  const image = item.image?.imageUrl ? toFullResImageUrl(item.image.imageUrl) : undefined;
  const shipping = cheapestShipping(item.shippingOptions);

  return {
    id: item.itemId,
    title: item.title || 'Untitled Listing',
    price,
    priceNumeric: parsed?.numeric,
    currency: currency ?? '$',
    condition: item.condition,
    location: placeText(item.itemLocation, ['city', 'stateOrProvince']),
    url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
    images: image ? [image] : undefined,
    seller: item.seller?.username,
    shipping: shipping && quoteText(shipping),
    total: totalText(parsed?.numeric, item.price?.currency, shipping),
    marketplace: 'ebay',
    scrapedAt: new Date().toISOString(),
  };
}

export function itemDetails(item: Item, requestedId: string): ListingDetails {
  const additional = Array.isArray(item.additionalImages) ? item.additionalImages : [];
  const images = [item.image, ...additional].flatMap((image) =>
    image?.imageUrl ? [toFullResImageUrl(image.imageUrl)] : []
  );
  const shipped = shippedOptions(item.shippingOptions);
  const cheapest = cheapestShipping(item.shippingOptions);

  return {
    id: item.itemId,
    description: itemDescription(item),
    images,
    location: placeText(item.itemLocation, ['city', 'stateOrProvince', 'country']),
    seller: item.seller?.username ?? undefined,
    deliveryTypes: item.shippingOptions?.flatMap((s) => (s.shippingServiceCode ? [s.shippingServiceCode] : [])) ?? undefined,
    isShippingOffered: shipped.length > 0,
    shipping: cheapest && quoteText(cheapest),
    shippingOptions: shipped.length > 0 ? shipped.map(({ service, quote }) => ({ service, cost: quoteText(quote) })) : undefined,
    url: item.itemWebUrl ?? `https://www.ebay.com/itm/${requestedId}`,
  };
}

function itemDescription(item: Item): string | undefined {
  const text = item.description ? descriptionText(item.description) : '';
  return text || item.shortDescription || undefined;
}

function placeText(location: BrowseLocation | undefined, parts: Array<keyof BrowseLocation>): string | undefined {
  return parts.map((part) => location?.[part]).filter(Boolean).join(', ') || undefined;
}

export function quoteText(quote: ShippingQuote): string {
  if (quote.kind === 'calculated') return SHIPPING_CALCULATED;
  if (quote.amount === 0) return SHIPPING_FREE;
  return amountText(quote.cost);
}

function totalText(
  amount: number | undefined,
  currency: string | undefined,
  shipping: ShippingQuote | undefined
): string | undefined {
  if (amount === undefined) return undefined;
  const total = deliveredTotal({ amount, currency }, shipping);
  if (total === undefined) return undefined;
  return amountText({ value: total.toFixed(CENT_DECIMALS), currency });
}

function amountText(price: BrowsePrice): string {
  const symbol = price.currency ? currencySymbol(price.currency) : '';
  return `${symbol}${price.value}`;
}
