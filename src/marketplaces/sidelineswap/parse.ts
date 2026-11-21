import { Listing, ListingDetails } from '../../types.js';
import { Image, Item } from './wire.js';

const SITE = 'https://sidelineswap.com';
const LISTING_ID = /^[1-9]\d*$/;
const GEAR_PATH = /^\/gear\/(?:.*\/)?([1-9]\d*)(?:-[^/]*)?\/?$/;

export function listingIdFrom(input: string): string | undefined {
  if (LISTING_ID.test(input)) return input;
  const url = URL.canParse(input) ? new URL(input) : undefined;
  if (url?.origin !== SITE) return undefined;
  return url.pathname.match(GEAR_PATH)?.[1];
}

export function summaryListing(item: Item): Listing | undefined {
  const id = itemId(item);
  const title = item.name?.trim();
  if (!id || !title) return undefined;

  const price = priceOf(item);
  return {
    id,
    title: item.state === 'sold' ? `${title} [Sold]` : title,
    price: price === undefined ? 'Price not listed' : usd(price),
    ...(price !== undefined && { priceNumeric: price, currency: 'USD' }),
    url: listingUrl(item, id),
    images: photos(item),
    seller: item.seller?.username,
    condition: item.condition_detail?.name,
    marketplace: 'sidelineswap',
    scrapedAt: new Date().toISOString(),
  };
}

export function itemDetails(item: Item, id: string): ListingDetails {
  const sellerDescription = item.description?.trim();
  const facts = [askingPrice(item), ...attributes(item)];
  return {
    id,
    url: listingUrl(item, id),
    images: photos(item),
    seller: item.seller?.username,
    description: [...facts, ...(sellerDescription ? ['', sellerDescription] : [])].join('\n'),
  };
}

export function itemId(item: Item): string | undefined {
  const id = String(item.id ?? '');
  return LISTING_ID.test(id) ? id : undefined;
}

function priceOf(item: Item): number | undefined {
  if (item.price === null || item.price === undefined || item.price === '') return undefined;
  const price = Number(item.price);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function askingPrice(item: Item): string {
  const price = priceOf(item);
  return `Price: ${price === undefined ? 'not listed' : usd(price)}`;
}

function listingUrl(item: Item, id: string): string {
  const url = item.url && URL.canParse(item.url) ? new URL(item.url) : undefined;
  return url?.origin === SITE && listingIdFrom(url.href) === id ? url.href : `${SITE}/gear/${id}`;
}

function photos(item: Item): string[] {
  const images = [...(item.images ?? []), ...(item.primary_image ? [item.primary_image] : [])];
  return [...new Set(images.map(largestPhoto).filter((url): url is string => url !== undefined))];
}

function largestPhoto(image: Image | null): string | undefined {
  const url = image?.large_url ?? image?.edge_url ?? image?.small_url ?? image?.thumb_url;
  return url?.startsWith('https://') ? url : undefined;
}

function attributes(item: Item): string[] {
  const lines = item.state ? [`Status: ${item.state}`] : [];
  for (const detail of item.details ?? []) {
    const values = (detail?.values ?? []).map((value) => value?.name).filter(Boolean);
    if (detail?.name && values.length) lines.push(`${detail.name}: ${values.join(', ')}`);
  }
  const model = item.model?.display_name ?? item.model?.name;
  if (model) lines.push(`Model: ${model}`);
  return lines;
}
