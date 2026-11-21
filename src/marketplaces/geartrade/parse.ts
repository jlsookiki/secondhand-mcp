import { convert } from 'html-to-text';
import { Listing, ListingDetails, ListingPart, SearchParams } from '../../types.js';
import { SITE } from './query.js';
import { MetaVariant, Product, SearchMeta, Variant } from './wire.js';

const LISTING_ID = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?::([1-9]\d*))?$/;
const SEARCH_PAGE_MARKER = 'data-page-type="search"';
const PAGE_CURRENCY = /data-currency="([A-Z]{3})"/;
const META = /var meta = (\{.*\});$/m;
const CARD = /<product-card\b[\s\S]*?<\/product-card>/g;
const CARD_HANDLE = /href="\/products\/([a-z0-9-]+)/;
const CARD_TITLE = /class="card__title[^"]*">\s*<a\b[^>]*>([\s\S]*?)<\/a>/;
const CARD_IMAGE = /\ssrc="([^"]+)"/;
const NEXT_PAGE = /class="[^"]*pagination__arrow--next[^"]*"[^>]*href=/;
const CONDITION_STATEMENT = /\b(?:is|are) in (New|Good|Excellent|Fair|Sample|UnNew With Tags) condition\b/i;
const CENTS_PER_DOLLAR = 100;

export interface ListingRef {
  handle: string;
  variantId?: string;
}

/** A search result card joined with the variants the page's analytics object lists for it. */
export interface Card {
  handle: string;
  title: string;
  image?: string;
  variants: MetaVariant[];
}

export interface SearchPage {
  cards: Card[];
  hasNextPage: boolean;
}

export function listingRefFrom(input: string): ListingRef | undefined {
  const match = input.match(LISTING_ID);
  if (!match) return undefined;
  return { handle: match[1], variantId: match[2] };
}

export function searchPage(html: string): SearchPage {
  if (!html.includes(SEARCH_PAGE_MARKER)) throw new Error('Geartrade returned an unexpected search page');
  const currency = html.match(PAGE_CURRENCY)?.[1];
  if (currency !== 'USD') throw new Error(`Geartrade showed prices in ${currency ?? 'an unknown currency'}, not USD`);

  const variantsByHandle = new Map<string, MetaVariant[]>();
  for (const product of searchMeta(html).products ?? []) {
    if (product?.handle && Array.isArray(product.variants)) variantsByHandle.set(product.handle, product.variants);
  }

  const cards: Card[] = [];
  for (const [markup] of html.matchAll(CARD)) {
    const card = parseCard(markup, variantsByHandle);
    if (card) cards.push(card);
  }
  return { cards, hasNextPage: NEXT_PAGE.test(html) };
}

/** A card with one variant is complete as it stands; one with several needs its product data for variant availability. */
export function cardListing(card: Card, condition: string | undefined): Listing | undefined {
  const [variant] = card.variants;
  const id = variantId(variant);
  const price = dollars(variant?.price);
  if (!id || price === undefined) return undefined;

  return {
    id: `${card.handle}:${id}`,
    title: card.title,
    price: usd(price),
    priceNumeric: price,
    currency: 'USD',
    url: variantUrl(card.handle, id),
    images: card.image ? [card.image] : [],
    condition,
    marketplace: 'geartrade',
    scrapedAt: new Date().toISOString(),
  };
}

export function productListings(product: Product, handle: string, params: SearchParams): Listing[] {
  const title = product.title?.trim();
  if (!title || product.available === false) return [];

  const images = photos(product);
  const condition = conditionOf(product);
  const sizeIndex = optionIndex(product, 'size');
  const listings: Listing[] = [];
  for (const variant of product.variants ?? []) {
    const id = variantId(variant);
    const price = dollars(variant?.price);
    if (!id || price === undefined || !variant.available) continue;
    if (!withinPrice(price, params) || !hasSize(variant, sizeIndex, params.sizes)) continue;
    listings.push({
      id: `${handle}:${id}`,
      title: variant.title ? `${title} (${variant.title})` : title,
      price: usd(price),
      priceNumeric: price,
      currency: 'USD',
      url: variantUrl(handle, id),
      images,
      condition,
      marketplace: 'geartrade',
      scrapedAt: new Date().toISOString(),
    });
  }
  return listings;
}

export function productDetails(product: Product, ref: ListingRef): ListingDetails {
  const variants = (product.variants ?? []).filter((variant) => !ref.variantId || variantId(variant) === ref.variantId);
  if (!variants.length) throw new Error(`Geartrade listing ${ref.handle}:${ref.variantId} no longer exists`);

  const images = photos(product);
  const description = product.description ? plainText(product.description) : '';
  const condition = conditionOf(product);
  const facts = [...(condition ? [`Condition: ${condition}`] : []), ...variants.map((variant) => variantLine(product, variant))];
  const unavailable: ListingPart[] = [
    ...(description ? [] : ['description' as const]),
    ...(images.length ? [] : ['photos' as const]),
  ];
  return {
    id: ref.variantId ? `${ref.handle}:${ref.variantId}` : ref.handle,
    url: ref.variantId ? variantUrl(ref.handle, ref.variantId) : `${SITE}/products/${ref.handle}`,
    images,
    description: [...facts, ...(description ? ['', description] : [])].join('\n'),
    ...(unavailable.length && { unavailable }),
  };
}

/** Geartrade states each item's grade in a fixed sentence of its description. */
export function conditionOf(product: Product): string | undefined {
  return product.description ? plainText(product.description).match(CONDITION_STATEMENT)?.[1] : undefined;
}

function searchMeta(html: string): SearchMeta {
  const json = html.match(META)?.[1];
  if (!json) throw new Error('Geartrade search page is missing its product data');
  return JSON.parse(json) as SearchMeta;
}

function parseCard(markup: string, variantsByHandle: Map<string, MetaVariant[]>): Card | undefined {
  const handle = markup.match(CARD_HANDLE)?.[1];
  const title = plainText(markup.match(CARD_TITLE)?.[1] ?? '');
  const variants = handle ? variantsByHandle.get(handle) : undefined;
  if (!handle || !title || !variants?.length) return undefined;
  return { handle, title, image: httpsUrl(markup.match(CARD_IMAGE)?.[1]), variants };
}

function variantLine(product: Product, variant: Variant): string {
  const price = dollars(variant.price);
  const status = product.available !== false && variant.available ? 'available' : 'unavailable';
  return `${variant.title ?? 'Item'}: ${price === undefined ? 'price not listed' : usd(price)}, ${status}`;
}

function variantId(variant: { id?: number } | undefined): string | undefined {
  return Number.isSafeInteger(variant?.id) && variant!.id! > 0 ? String(variant!.id) : undefined;
}

function dollars(cents: number | undefined): number | undefined {
  return Number.isSafeInteger(cents) && cents! >= 0 ? cents! / CENTS_PER_DOLLAR : undefined;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function variantUrl(handle: string, id: string): string {
  return `${SITE}/products/${handle}?variant=${id}`;
}

function withinPrice(price: number, params: SearchParams): boolean {
  if (params.minPrice !== undefined && price < params.minPrice) return false;
  return params.maxPrice === undefined || price <= params.maxPrice;
}

function hasSize(variant: Variant, sizeIndex: number, sizes: string[] | undefined): boolean {
  if (!sizes?.length || sizeIndex < 0) return true;
  const size = variant.options?.[sizeIndex]?.toLowerCase();
  return sizes.some((wanted) => wanted.toLowerCase() === size);
}

function optionIndex(product: Product, name: string): number {
  return (product.options ?? []).findIndex((option) => option?.name?.toLowerCase() === name);
}

function photos(product: Product): string[] {
  const urls = (product.images ?? []).map(httpsUrl).filter((url): url is string => url !== undefined);
  return [...new Set(urls)];
}

function httpsUrl(src: string | undefined): string | undefined {
  if (!src || !URL.canParse(src, SITE)) return undefined;
  const url = new URL(src, SITE);
  return url.protocol === 'https:' ? url.href : undefined;
}

function plainText(html: string): string {
  return convert(html, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] }).trim();
}
