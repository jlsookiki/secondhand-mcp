import { convert } from 'html-to-text';
import { Listing, ListingDetails } from '../../types.js';
import { Field, Price, Product, ProductJsonLd, ProductPage } from './wire.js';

export const SITE = 'https://playitagainsports.com';

const PRODUCT_PATH = /^\/locations\/[^/]+\/product\/[^/]+\/[^/]+\/?$/;
const PAGE_DATA = /window\.stencilBootstrap\(\s*"[^"\n]+"\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/;
const JSON_LD = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const EMPTY_DESCRIPTION = /"description"\s*:\s*(?=[,}])/;
const GALLERY_PHOTO = /data-image-gallery-new-image-url=["']([^"']+)["']/g;
const PHOTO_SIZE = /\/stencil\/[^/]+\//;
const PHOTO_SIZE_PLACEHOLDER = '{:size}';
const FULL_SIZE = '1280x1280';
const DELIVERY_FIELDS = ['Pick Up in Store', 'Standard Shipping', 'Local Delivery'];
const DESCRIPTIVE_FIELDS = ['Condition', 'Product Brand', 'Model', 'Product Line', 'Size', 'Color', 'Style', 'Key Feature', 'Age / Gender', 'Gender'];
const NO_VALUE = 'None';

interface Currency {
  code: string;
  symbol: string;
}

const CURRENCY_BY_COUNTRY: Record<string, Currency> = {
  US: { code: 'USD', symbol: '$' },
  CA: { code: 'CAD', symbol: 'C$' },
};

export function productPath(input: string): string | undefined {
  const url = URL.canParse(input, SITE) ? new URL(input, SITE) : undefined;
  if (url?.origin !== SITE) return undefined;
  return PRODUCT_PATH.test(url.pathname) ? url.pathname : undefined;
}

/** Reads the JSON the storefront embeds as a string literal, without running any of the page's scripts. */
export function pageData<T>(html: string): T | undefined {
  const literal = html.match(PAGE_DATA)?.[1];
  if (!literal) return undefined;
  const data = parseJson(literal);
  const decoded = typeof data === 'string' ? parseJson(data) : undefined;
  return decoded && typeof decoded === 'object' ? (decoded as T) : undefined;
}

/** Canadian stores report their prices as USD in the page data, so the currency comes from the product's Country field. */
export function currencyOf(fields: Field[] | undefined): Currency | undefined {
  return CURRENCY_BY_COUNTRY[fieldValue(fields, 'Country')];
}

export function summaryListing(product: Product): Listing | undefined {
  const id = product.url ? productPath(product.url) : undefined;
  const title = product.name?.trim();
  if (!id || !title) return undefined;

  const price = priceOf(product.price);
  const currency = currencyOf(product.custom_fields);
  const priced = price !== undefined && currency !== undefined;
  const store = product.brand?.name;
  return {
    id,
    title,
    price: priced ? `${product.has_options ? 'from ' : ''}${money(price, currency)}` : 'Price not listed',
    ...(priced && { priceNumeric: price, currency: currency.code }),
    url: `${SITE}${id}`,
    images: searchPhotos(product),
    description: product.summary?.trim() || undefined,
    location: store,
    seller: store,
    condition: fieldValue(product.custom_fields, 'Condition') || undefined,
    marketplace: 'playitagain',
    scrapedAt: new Date().toISOString(),
  };
}

export function isInStock(product: Product): boolean {
  return product.stock_level !== 0 && !/out of stock|sold out/i.test(product.availability ?? '');
}

export function resultCount(summary: string | undefined): number | undefined {
  const count = summary?.match(/^([\d,]+) results? for /)?.[1];
  return count === undefined ? undefined : Number(count.replaceAll(',', ''));
}

export function productDetails(html: string, path: string): ListingDetails | undefined {
  const page = pageData<ProductPage>(html);
  if (page?.template !== 'pages/product' || !page.productUrl || productPath(page.productUrl) !== path) return undefined;

  const product = productJsonLd(html, path);
  const fields = page.customFields ?? [];
  const store = product?.brand?.name;
  const sellerDescription = plainText(product?.description);
  const images = galleryPhotos(html, product);
  const name = product?.name?.trim();
  const facts = [...(name ? [name] : []), askingPrice(page.productPrice, currencyOf(fields)), ...stockStatus(page), ...descriptiveFieldLines(fields)];
  const shipping = fieldValue(fields, 'Standard Shipping');
  return {
    id: path,
    url: `${SITE}${path}`,
    images,
    seller: store,
    location: store,
    description: [...facts, ...(sellerDescription ? ['', sellerDescription] : [])].join('\n'),
    deliveryTypes: DELIVERY_FIELDS.filter((name) => fieldValue(fields, name) === 'Yes'),
    ...(shipping && { isShippingOffered: shipping === 'Yes' }),
  };
}

export function productJsonLd(html: string, path: string): ProductJsonLd | undefined {
  for (const [, body] of html.matchAll(JSON_LD)) {
    // The storefront leaves the value out entirely when a product has no description.
    const parsed = parseJson(body.replace(EMPTY_DESCRIPTION, '"description": null'));
    const nodes = (Array.isArray(parsed) ? parsed : [parsed]) as (ProductJsonLd | null)[];
    const product = nodes.find((node) => node?.['@type'] === 'Product' && node.url && productPath(node.url) === path);
    if (product) return product;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fieldValue(fields: Field[] | undefined, name: string): string {
  return fields?.find((field) => field?.name === name)?.value?.trim() ?? '';
}

function priceOf(price: Price | undefined): number | undefined {
  const amount = price?.without_tax?.value;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function money(amount: number, currency: Currency): string {
  return `${currency.symbol}${amount.toFixed(2)}`;
}

function askingPrice(price: Price | undefined, currency: Currency | undefined): string {
  const low = priceOf(price);
  if (low === undefined || !currency) return 'Price: not listed';
  const high = priceOf(price?.price_range?.max);
  const range = high !== undefined && high > low ? `–${money(high, currency)}` : '';
  return `Price: ${money(low, currency)}${range}`;
}

function stockStatus(page: ProductPage): string[] {
  if (page.isInStock === undefined) return [];
  return [`Status: ${page.isInStock ? 'in stock' : 'out of stock'}`];
}

/** The storefront also carries bookkeeping fields (Country, Shipping, Discounted Price, delivery flags) that mean nothing to a shopper. */
export function descriptiveFieldLines(fields: Field[]): string[] {
  return DESCRIPTIVE_FIELDS.flatMap((name) => {
    const values = fields
      .filter((field) => field?.name === name)
      .map((field) => field.value?.trim())
      .filter((value): value is string => !!value && value !== NO_VALUE);
    return values.length ? [`${name}: ${[...new Set(values)].join(' / ')}`] : [];
  });
}

function plainText(html: string | null | undefined): string {
  return html ? convert(html, { wordwrap: false }).trim() : '';
}

function searchPhotos(product: Product): string[] {
  const images = [...(product.images ?? []), ...(product.image ? [product.image] : [])];
  const urls = images.map((image) => image?.data?.replace(PHOTO_SIZE_PLACEHOLDER, FULL_SIZE));
  return uniqueHttps(urls);
}

function galleryPhotos(html: string, product: ProductJsonLd | undefined): string[] {
  const listed = [product?.image ?? []].flat();
  const gallery = [...html.matchAll(GALLERY_PHOTO)].map(([, url]) => url.replaceAll('&amp;', '&'));
  const urls = [...listed, ...gallery].filter((url) => typeof url === 'string');
  return uniqueHttps(urls.map((url) => url.replace(PHOTO_SIZE, `/stencil/${FULL_SIZE}/`)));
}

function uniqueHttps(urls: (string | undefined)[]): string[] {
  return [...new Set(urls.filter((url): url is string => typeof url === 'string' && url.startsWith('https://')))];
}
