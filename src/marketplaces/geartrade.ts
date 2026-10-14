/** Geartrade's public Shopify storefront. Search pages, not predictive suggestions. */
import { convert } from 'html-to-text';
import { BaseMarketplace } from './base.js';
import type { Listing, ListingDetails, SearchParams, SearchResult } from '../types.js';

const BASE = 'https://geartrade.com';
const MAX_PAGES = 3;
const MAX_PRODUCTS = 48;
const MAX_LIMIT = 50;
const USED_CONDITIONS = ['Good', 'Excellent', 'Fair'];
const SORT: Record<string, string> = {
  relevance: 'relevance', price_low_to_high: 'price-ascending', price_high_to_low: 'price-descending',
};

interface Variant {
  id: number;
  title: string;
  options: string[];
  price: number; // Shopify .js prices are integer cents, unlike suggestion JSON.
  available: boolean;
  requires_shipping: boolean;
}
interface Product {
  id: number;
  handle: string;
  title: string;
  description: string;
  available: boolean;
  images: string[];
  tags: string[];
  type: string;
  options: { name: string; values: string[] }[];
  variants: Variant[];
}

function plain(html: string): string {
  return convert(html, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] }).trim();
}
function imageUrl(value: string): string {
  const url = new URL(value, BASE);
  if (url.protocol !== 'https:') throw new Error('Geartrade returned an invalid image URL');
  return url.toString();
}
function condition(product: Product): string | undefined {
  // Only the explicit item condition statement, never infer from the title or marketing copy.
  return plain(product.description).match(/\b(?:is|are) in (New|Good|Excellent|Fair|Sample|UnNew With Tags) condition\b/i)?.[1];
}
function validateProduct(value: unknown, handle: string): Product {
  const p = value as Partial<Product> | null;
  if (!p || p.handle !== handle || typeof p.title !== 'string' || typeof p.description !== 'string'
    || typeof p.type !== 'string' || typeof p.available !== 'boolean' || !Array.isArray(p.images) || !p.images.every(i => typeof i === 'string')
    || !Array.isArray(p.tags) || !p.tags.every(t => typeof t === 'string')
    || !Array.isArray(p.options) || !p.options.every(o => o && typeof o.name === 'string')
    || !Array.isArray(p.variants) || !p.variants.length || !p.variants.every(v =>
      v && Number.isSafeInteger(v.id) && typeof v.title === 'string' && Array.isArray(v.options)
      && v.options.every(o => typeof o === 'string') && Number.isSafeInteger(v.price) && v.price >= 0
      && typeof v.available === 'boolean' && typeof v.requires_shipping === 'boolean')) {
    throw new Error(`Geartrade product data changed or is invalid: ${handle}`);
  }
  return p as Product;
}

export class GeartradeMarketplace extends BaseMarketplace {
  readonly name = 'geartrade';
  readonly displayName = 'Geartrade';
  readonly requiresAuth = false;

  private async request(url: string, deadline?: AbortSignal): Promise<Response> {
    const response = await fetch(url, {
      headers: { Accept: url.endsWith('.js') ? 'application/json' : 'text/html', 'User-Agent': 'secondhand-mcp' },
      signal: deadline ? AbortSignal.any([deadline, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Geartrade HTTP ${response.status}`);
    return response;
  }

  private async product(handle: string, deadline?: AbortSignal): Promise<Product> {
    return validateProduct(await (await this.request(`${BASE}/products/${handle}.js`, deadline)).json(), handle);
  }

  async search(params: SearchParams): Promise<SearchResult> {
    try {
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      if (!params.query.trim()) throw new Error('query must not be blank');
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) throw new Error(`limit must be 0–${MAX_LIMIT}`);
      if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_PRODUCTS) throw new Error(`offset must be 0–${MAX_PRODUCTS - 1} within the bounded scan`);
      for (const field of ['department', 'colors'] as const) {
        if (params[field] !== undefined) throw new Error(`Geartrade does not support ${field}; omit that filter`);
      }
      if (params.sort && !SORT[params.sort]) throw new Error(`Geartrade does not support sort ${params.sort}`);
      if (params.condition && !['any', 'new', 'used', 'good', 'excellent', 'fair'].includes(params.condition)) {
        throw new Error(`Geartrade does not support condition ${params.condition}`);
      }
      for (const price of [params.minPrice, params.maxPrice]) {
        if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error('price bounds must be nonnegative');
      }
      if (params.minPrice !== undefined && params.maxPrice !== undefined && params.minPrice > params.maxPrice) {
        throw new Error('minPrice must not exceed maxPrice');
      }
      if (limit === 0) return { marketplace: this.name, success: true, listings: [] };

      const url = new URL('/search', BASE);
      url.searchParams.set('q', params.query);
      url.searchParams.set('type', 'product');
      url.searchParams.set('sort_by', SORT[params.sort ?? 'relevance']);
      if (params.minPrice !== undefined) url.searchParams.set('filter.v.price.gte', String(params.minPrice));
      if (params.maxPrice !== undefined) url.searchParams.set('filter.v.price.lte', String(params.maxPrice));
      if (params.brand) url.searchParams.set('filter.p.m.global.Brand', params.brand);
      if (params.category) url.searchParams.set('filter.p.product_type', params.category);
      for (const size of params.sizes ?? []) url.searchParams.append('filter.v.option.size', size);
      const conditions = params.condition === 'used' ? USED_CONDITIONS
        : params.condition && params.condition !== 'any' ? [params.condition[0].toUpperCase() + params.condition.slice(1)] : [];
      for (const value of conditions) url.searchParams.append('filter.v.m.global.Condition', value);

      const priceSort = params.sort === 'price_low_to_high' || params.sort === 'price_high_to_low';
      const deadline = AbortSignal.timeout(45_000);
      const listings: Listing[] = [];
      const seen = new Set<string>();
      let more = false;
      let pages = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        url.searchParams.set('page', String(page));
        const html = await (await this.request(url.toString(), deadline)).text();
        // A missing marker is an access/parser failure, not an empty search.
        if (!html.includes('data-page-type="search"')) throw new Error('Geartrade search page missing; blocked or changed markup');
        if (!html.includes('data-currency="USD"')) throw new Error('Geartrade storefront currency is missing or is not USD');
        const cards = [...html.matchAll(/<product-card\b[\s\S]*?<\/product-card>/g)];
        const handles = cards.map(c => c[0].match(/href="\/products\/([a-z0-9-]+)(?:\?[^\"]*)?"/)?.[1]);
        if (handles.some(h => !h)) throw new Error('Geartrade product card markup changed');
        if (!cards.length && !/Search:\s*0 results found/.test(html)) {
          throw new Error('Geartrade search returned no parsable product cards');
        }
        pages++;
        const fresh = [...new Set(handles as string[])].filter(h => !seen.has(h)).slice(0, MAX_PRODUCTS - seen.size);
        batches: for (let start = 0; start < fresh.length;) {
          // A modest three-request batch keeps latency down without fetching a whole catalog.
          const batch = fresh.slice(start, start + (priceSort ? 3 : Math.min(3, offset + limit - listings.length)));
          const products = await Promise.all(batch.map(h => this.product(h, deadline)));
          start += batch.length;
          batch.forEach(h => seen.add(h));
          for (const [index, product] of products.entries()) {
            const handle = batch[index];
            if (params.brand && !product.tags.some(t => t.toLowerCase() === `brand:${params.brand!.toLowerCase()}`)) continue;
            if (params.category && product.type.toLowerCase() !== params.category.toLowerCase()) continue;
            const itemCondition = condition(product);
            // Recheck prices and stock on the exact variant; search pages can be stale.
            if (conditions.length && !conditions.some(c => c.toLowerCase() === itemCondition?.toLowerCase())) continue;
            const sizeIndex = product.options.findIndex(o => o.name.toLowerCase() === 'size');
            for (const variant of product.variants) {
              if (!params.showSold && (!product.available || !variant.available)) continue;
              if (params.sizes?.length && (sizeIndex < 0 || !params.sizes.some(s => s.toLowerCase() === variant.options[sizeIndex]?.toLowerCase()))) continue;
              const price = variant.price / 100;
              if ((params.minPrice !== undefined && price < params.minPrice) || (params.maxPrice !== undefined && price > params.maxPrice)) continue;
              const variantUrl = `${BASE}/products/${handle}?variant=${variant.id}`;
              listings.push({
                id: `${handle}:${variant.id}`,
                title: `${product.title}${product.variants.length > 1 ? ` (${variant.title})` : ''}${!product.available || !variant.available ? ' [Unavailable]' : ''}`,
                price: `USD ${price.toFixed(2)}`, priceNumeric: price, currency: 'USD', url: variantUrl,
                images: product.images.map(imageUrl), condition: itemCondition,
                description: [plain(product.description), `Variant: ${variant.title}`, `Availability: ${variant.available && product.available ? 'In stock' : 'Unavailable'}`].filter(Boolean).join('\n\n'),
                marketplace: this.name, scrapedAt: new Date().toISOString(),
              });
            }
            if (!priceSort && listings.length >= offset + limit) break batches;
          }
        }
        more = (!priceSort && listings.length >= offset + limit) || seen.size >= MAX_PRODUCTS || /class="[^\"]*pagination__arrow--next[^\"]*"[^>]*href=/.test(html);
        if (!more || (!priceSort && listings.length >= offset + limit) || seen.size >= MAX_PRODUCTS) break;
      }
      if (params.sort === 'price_low_to_high') listings.sort((a, b) => a.priceNumeric! - b.priceNumeric!);
      if (params.sort === 'price_high_to_low') listings.sort((a, b) => b.priceNumeric! - a.priceNumeric!);
      return {
        marketplace: this.name, success: true, listings: listings.slice(offset, offset + limit),
        note: `Checked ${pages} search page(s), ${seen.size} product(s); ${more ? 'more storefront results may remain' : 'reached the last search page'}. Bounded to ${MAX_PAGES} pages/${MAX_PRODUCTS} products per call. Location and radius are not applied. Prices are USD asking prices; shipping and tax excluded. Storefront keyword matching can return loosely related items; inspect relevance. Unavailable variants are excluded unless showSold is true; unavailable does not establish a completed sale.${params.condition === 'used' ? ' Used includes Good, Excellent and Fair only.' : ''}`,
      };
    } catch (error) {
      return this.createError(`Geartrade search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    // Only handles and optional variant IDs; never accept arbitrary URLs/paths.
    const match = listingId.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)(?::([0-9]+))?$/);
    if (!match) throw new Error('Geartrade listingId must be a product handle optionally followed by :variantId');
    const [, handle, variantId] = match;
    const product = await this.product(handle);
    const variants = variantId ? product.variants.filter(v => String(v.id) === variantId) : product.variants;
    if (!variants.length) throw new Error('Geartrade variant no longer exists');
    const page = await (await this.request(`${BASE}/products/${handle}`)).text();
    if (!page.includes('data-currency="USD"')) throw new Error('Geartrade storefront currency is missing or is not USD');
    const images = product.images.map(imageUrl);
    const description = [
      product.title, plain(product.description),
      ...variants.map(v => `Variant: ${v.title}; USD ${(v.price / 100).toFixed(2)}; ${product.available && v.available ? 'In stock' : 'Unavailable'}; Requires shipping: ${v.requires_shipping ? 'yes' : 'no'}`),
      'Prices exclude shipping and tax. Unavailable does not establish a completed sale.',
    ].filter(Boolean).join('\n\n');
    const unavailable: ('photos' | 'description')[] = [];
    if (!images.length) unavailable.push('photos');
    if (!product.description.trim()) unavailable.push('description');
    return {
      id: listingId, url: `${BASE}/products/${handle}${variantId ? `?variant=${variantId}` : ''}`,
      description, images,
      unavailable: unavailable.length ? unavailable : undefined,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const html = await (await this.request(`${BASE}/search?q=skis&type=product`)).text();
      return html.includes('data-page-type="search"') && /<product-card\b/.test(html);
    } catch { return false; }
  }
}
