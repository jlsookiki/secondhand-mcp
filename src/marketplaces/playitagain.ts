/** Public, server-rendered Play It Again Sports inventory. No login or browser required. */
import { convert } from 'html-to-text';
import { BaseMarketplace } from './base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../types.js';

const BASE = 'https://playitagainsports.com';
const MAX_PAGES = 10;
const MAX_LIMIT = 120;
const SORT: Record<string, string> = {
  relevance: 'relevance', newest: 'newest', price_low_to_high: 'priceasc', price_high_to_low: 'pricedesc',
};
type Field = { name: string; value: string };
type Money = { value: number; formatted: string; currency: string };
type Price = { without_tax?: Money; price_range?: { min?: { without_tax?: Money }; max?: { without_tax?: Money } } };
type Product = {
  id: number; sku: string; name: string; url: string; summary?: string;
  brand?: { name?: string }; category?: string[]; custom_fields?: Field[];
  images?: { data: string }[]; image?: { data: string };
  price?: Price;
  stock_level?: number | null; availability?: string; has_options?: boolean;
};
type Context = {
  template?: string; searchProducts?: Product[]; searchResultsCount?: string;
  searchProductsPerPage?: number; productId?: number; productUrl?: string;
  productSku?: string; customFields?: Field[]; isInStock?: boolean;
  productPrice?: Price;
};

function text(value: unknown): string {
  return typeof value === 'string' ? convert(value, { wordwrap: false }).trim() : '';
}
function field(fields: Field[] | undefined, name: string): string {
  return fields?.find(f => f.name === name)?.value ?? '';
}
function nativeCurrency(fields: Field[] | undefined): string | undefined {
  const country = field(fields, 'Country');
  return country === 'CA' ? 'CAD' : country === 'US' ? 'USD' : undefined;
}
function normalize(value: string): string { return value.trim().toLowerCase(); }

/** Decode JSON string literals, never evaluate the site's scripts. Fail closed on markup changes. */
function context(html: string): Context {
  const literal = html.match(/window\.stencilBootstrap\(\s*"[^"\n]+"\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/)?.[1];
  if (!literal) throw new Error('Missing storefront data; the response may be blocked or the page format changed');
  try {
    const result: unknown = JSON.parse(JSON.parse(literal));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Context;
  } catch { throw new Error('Invalid storefront JSON'); }
}

function productUrl(value: string): URL {
  const url = new URL(value, BASE);
  if (url.username || url.password || url.origin !== BASE || !/^\/locations\/[^/]+\/product\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error('Expected a Play It Again Sports product URL or product path from search');
  }
  url.search = ''; url.hash = '';
  return url;
}

async function fetchPage(url: URL, deadline?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal: deadline ? AbortSignal.any([deadline, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: 'error',
    headers: { Accept: 'text/html', 'User-Agent': 'secondhand-mcp (public inventory search)' },
  });
  if (!response.ok) throw new Error(`Storefront HTTP ${response.status}`);
  const html = await response.text();
  if (!html || /<title[^>]*>\s*(?:Just a moment|Access Denied|Forbidden)/i.test(html)) {
    throw new Error('Storefront access blocked');
  }
  return html;
}

function validateProduct(p: Product): void {
  if (!p || !Number.isInteger(p.id) || typeof p.name !== 'string' || !p.name.trim()
    || typeof p.url !== 'string' || !Array.isArray(p.custom_fields)
    || p.custom_fields.some(f => !f || typeof f.name !== 'string' || typeof f.value !== 'string')
    || !p.price?.without_tax || typeof p.price.without_tax.value !== 'number'
    || !Number.isFinite(p.price.without_tax.value) || p.price.without_tax.value < 0) {
    throw new Error('Invalid product data; refusing incomplete search results');
  }
  productUrl(p.url);
  if (!nativeCurrency(p.custom_fields)) throw new Error('Unknown product country/currency');
}

function matches(p: Product, params: SearchParams): boolean {
  const f = (name: string) => normalize(field(p.custom_fields, name));
  const amount = p.price!.without_tax!.value;
  // SearchParams has no currency selector: dollar bounds refer to USD, never compare CAD as USD.
  if ((params.minPrice != null || params.maxPrice != null) && nativeCurrency(p.custom_fields) !== 'USD') return false;
  if (params.minPrice != null && amount < params.minPrice) return false;
  if (params.maxPrice != null && amount > params.maxPrice) return false;
  if (params.condition && params.condition !== 'any' && f('Condition') !== params.condition) return false;
  if (params.brand && f('Product Brand') !== normalize(params.brand)) return false;
  if (params.sizes?.length && !params.sizes.some(s => normalize(s) === f('Size'))) return false;
  if (params.colors?.length && !params.colors.some(c => normalize(c) === f('Color'))) return false;
  if (params.category && !p.category?.some(c => normalize(c) === normalize(params.category!))) return false;
  return p.stock_level !== 0 && !/out of stock|sold out/i.test(p.availability ?? '');
}

function images(p: Product): string[] {
  return [...new Set([...(p.images ?? []), ...(p.image ? [p.image] : [])]
    .map(i => i?.data?.replace('{:size}', '1280x1280')).filter((i): i is string => !!i && /^https:\/\//.test(i)))];
}

export class PlayItAgainMarketplace extends BaseMarketplace {
  readonly name = 'playitagain';
  readonly displayName = 'Play It Again Sports';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    try {
      if (!params.query?.trim()) throw new Error('A nonempty query is required');
      if (params.condition && !['any', 'new', 'used'].includes(params.condition)) throw new Error('Only new, used, or any condition is supported');
      if (params.department || params.radius != null || params.showSold) throw new Error('Department, radius, and sold-inventory searches are unsupported');
      if (params.sort && !SORT[params.sort]) throw new Error(`Unsupported sort: ${params.sort}`);
      const limit = params.limit ?? 20, offset = params.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT || !Number.isInteger(offset) || offset < 0 || offset > MAX_LIMIT) {
        throw new Error(`limit and offset must be integers from 0 to ${MAX_LIMIT}`);
      }
      for (const bound of [params.minPrice, params.maxPrice]) if (bound != null && (!Number.isFinite(bound) || bound < 0)) throw new Error('Price bounds must be nonnegative finite numbers');
      if (params.minPrice != null && params.maxPrice != null && params.minPrice > params.maxPrice) throw new Error('minPrice must not exceed maxPrice');
      if (limit === 0) return { marketplace: this.name, success: true, listings: [] };
      const deadline = AbortSignal.timeout(45_000);
      const listings: Listing[] = [], seen = new Set<number>();
      let pages = 0, total: number | undefined, exhausted = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = new URL('/search.php', BASE);
        url.searchParams.set('search_query', params.query); url.searchParams.set('section', 'product');
        url.searchParams.set('page', String(page)); url.searchParams.set('sort', SORT[params.sort ?? 'relevance']);
        const html = await fetchPage(url, deadline), data = context(html);
        if (data.template !== 'pages/search' || !Array.isArray(data.searchProducts)
          || !Number.isInteger(data.searchProductsPerPage) || data.searchProductsPerPage! < 1) throw new Error('Invalid search page data');
        const count = data.searchResultsCount?.match(/^([\d,]+) results? for /)?.[1];
        if (!count) throw new Error('Missing search result count');
        total = Number(count.replace(/,/g, '')); pages++;
        if (data.searchProducts.length === 0 && total !== 0) throw new Error('Empty search data with a nonzero result count');
        let newProducts = 0;
        for (const p of data.searchProducts) {
          validateProduct(p);
          if (seen.has(p.id)) continue;
          seen.add(p.id); newProducts++;
          if (!matches(p, params)) continue;
          const url = productUrl(p.url).href, currency = nativeCurrency(p.custom_fields)!;
          listings.push({ id: new URL(url).pathname, title: text(p.name), price: `${currency} ${p.price!.without_tax!.value.toFixed(2)}${p.has_options ? ' (from; select options)' : ''}`,
            priceNumeric: p.price!.without_tax!.value, currency, url, images: images(p),
            description: [text(p.summary), p.has_options ? 'Selectable options: verify the desired size and final price on the product page.' : ''].filter(Boolean).join('\n') || undefined, location: p.brand?.name, seller: p.brand?.name,
            condition: field(p.custom_fields, 'Condition') || undefined,
            marketplace: this.name, scrapedAt: new Date().toISOString() });
        }
        exhausted = page * data.searchProductsPerPage! >= total || data.searchProducts.length === 0;
        if (page > 1 && data.searchProducts.length > 0 && newProducts === 0) throw new Error('Pagination repeated a page; refusing to claim complete results');
        if (listings.length >= offset + limit || exhausted) break;
      }
      return { marketplace: this.name, success: true, listings: listings.slice(offset, offset + limit), totalFound: total,
        note: `Searched ${pages} page(s), inspected ${seen.size} unique listings${!exhausted ? '; additional inventory may remain' : ''}. Filters apply to inspected listings; totalFound is the unfiltered query count. Prices are store-native USD/CAD, without conversion, shipping or tax.${params.minPrice != null || params.maxPrice != null ? ' Price bounds are USD-only; Canadian listings were excluded.' : ''} Price sorting uses nominal amounts, not exchange rates. Location is not a geographic filter. Online inventory only; confirm availability on each product page.` };
    } catch (error) { return this.createError(`Play It Again Sports search failed: ${error}`); }
  }

  async getListingDetails(id: string): Promise<ListingDetails> {
    const url = productUrl(id);
    const html = await fetchPage(url), data = context(html);
    if (data.template !== 'pages/product' || !Number.isInteger(data.productId) || data.productUrl == null
      || productUrl(data.productUrl).pathname !== url.pathname || typeof data.isInStock !== 'boolean') throw new Error('Missing or mismatched product data');
    if (!data.isInStock) throw new Error('Product is out of stock; availability must be rechecked before purchase');
    const nodes = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
      .flatMap(m => { try { // The storefront emits invalid JSON-LD when an optional description is empty.
        // Repair only that known missing value; never evaluate scripts or invent a description.
        const value = JSON.parse(m[1].replace(/"description"\s*:\s*(?=[,}])/, '"description": null')); return Array.isArray(value) ? value : [value]; } catch { return []; } });
    const product = nodes.find(n => n?.['@type'] === 'Product' && typeof n.url === 'string' && productUrl(n.url).pathname === url.pathname);
    if (!product) throw new Error('Missing product JSON-LD');
    const hasOptions = /name=["']attribute\[\d+\]["']/.test(html) || !!data.productPrice?.price_range;
    if (!Array.isArray(data.customFields) || data.customFields.some(f => !f || typeof f.name !== 'string' || typeof f.value !== 'string') || !nativeCurrency(data.customFields)) throw new Error('Missing product fields or country/currency');
    const currency = nativeCurrency(data.customFields)!;
    const price = data.productPrice?.without_tax?.value;
    const maximum = data.productPrice?.price_range?.max?.without_tax?.value;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0
      || (maximum != null && (!Number.isFinite(maximum) || maximum < price))) throw new Error('Missing or invalid current product price');
    const priceText = `${currency} ${price.toFixed(2)}${maximum != null && maximum !== price ? `–${maximum.toFixed(2)} (options vary)` : ''}`;
    const description = [text(product.description) || 'Seller description: not provided.',
      ...(hasOptions ? ['Selectable options: verify the desired size and final price on the product page.'] : []), ...((data.customFields ?? []).map(f => `${f.name}: ${text(f.value)}`)),
      `SKU: ${data.productSku ?? 'not listed'}`, `Current price: ${priceText} (before shipping and tax)`, `Availability: In stock (at time of fetch)`,
      `Price currency: ${nativeCurrency(data.customFields) ?? 'unknown'} (store-native; no conversion)`].filter(Boolean).join('\n');
    const photos = [...new Set([
      ...(Array.isArray(product.image) ? product.image : [product.image]),
      ...[...html.matchAll(/data-image-gallery-new-image-url=["']([^"']+)["']/g)].map(m => m[1].replace(/&amp;/g, '&')),
    ].filter((v): v is string => typeof v === 'string' && /^https:\/\//.test(v)).map(v => v.replace(/\/stencil\/[^/]+\//, '/stencil/1280x1280/')))];
    const shipping = field(data.customFields, 'Standard Shipping');
    const deliveryTypes = ['Pick Up in Store', 'Standard Shipping', 'Local Delivery'].filter(k => field(data.customFields, k) === 'Yes');
    return { id: url.pathname, url: url.href, description, images: photos,
      seller: typeof product.brand?.name === 'string' ? product.brand.name : undefined,
      location: typeof product.brand?.name === 'string' ? product.brand.name : undefined,
      deliveryTypes, isShippingOffered: shipping === 'Yes' ? true : shipping === 'No' ? false : undefined,
      ...(photos.length === 0 ? { unavailable: ['photos' as const] } : {}) };
  }

  async healthCheck(): Promise<boolean> { return (await this.search({ query: 'baseball bat', limit: 1 })).success; }
}
