/** Public, read-only SidelineSwap endpoints used by its web storefront.
 * These are not a documented developer API; changes/blocks are reported as
 * errors, never replaced with synthetic inventory. Prices are USD asking prices.
 */
import { BaseMarketplace } from './base.js';
import { Listing, ListingDetails, SearchParams, SearchResult } from '../types.js';

const API = 'https://api.sidelineswap.com';
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const SORTS: Record<string, string> = {
  relevance: 'relevancy_desc', newest: 'newest',
  price_low_to_high: 'price_asc', price_high_to_low: 'price_desc',
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const amount = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};
const integer = (value: unknown): number | undefined => {
  const number = amount(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
};

function listingId(value: unknown): string | undefined {
  if ((typeof value === 'string' || typeof value === 'number') && /^[1-9]\d*$/.test(String(value))) return String(value);
  return undefined;
}
function itemUrl(value: unknown, id: string): string {
  const candidate = text(value);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'sidelineswap.com' &&
          new RegExp(`/gear/.*/${id}(?:-|$)`).test(url.pathname)) return url.toString();
    } catch { /* use the site's ID route */ }
  }
  return `https://sidelineswap.com/gear/${id}`;
}
function photos(item: RecordValue): string[] {
  const entries = Array.isArray(item.images) ? item.images : [];
  const primary = record(item.primary_image);
  const urls = [...entries, ...(primary ? [primary] : [])].flatMap((entry) => {
    const image = record(entry);
    const url = text(image?.large_url) ?? text(image?.edge_url) ?? text(image?.small_url) ?? text(image?.thumb_url);
    if (!url) return [];
    try { return new URL(url).protocol === 'https:' ? [url] : []; } catch { return []; }
  });
  return [...new Set(urls)];
}
/** Preserve structured seller facts without treating listing creation as manufacture date. */
function attributes(item: RecordValue): string[] {
  const lines: string[] = [];
  const state = text(item.state);
  if (state) lines.push(`Availability: ${state}`);
  if (Array.isArray(item.details)) {
    for (const entry of item.details) {
      const detail = record(entry);
      const name = text(detail?.name);
      const values = Array.isArray(detail?.values) ? detail.values.flatMap(value => {
        const label = text(record(value)?.name);
        return label ? [label] : [];
      }) : [];
      if (name && values.length) lines.push(`${name}: ${values.join(', ')}`);
    }
  }
  const model = text(record(item.model)?.display_name) ?? text(record(item.model)?.name);
  if (model) lines.push(`Model: ${model}`);
  return lines;
}

export class SidelineSwapMarketplace extends BaseMarketplace {
  readonly name = 'sidelineswap';
  readonly displayName = 'SidelineSwap';
  readonly requiresAuth = false;

  private async request(path: string, params?: URLSearchParams, deadline?: AbortSignal): Promise<unknown> {
    const url = new URL(path, API);
    if (params) url.search = params.toString();
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: deadline ? AbortSignal.any([deadline, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`SidelineSwap HTTP ${response.status}`);
    return response.json();
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const listings: Listing[] = [];
    const notes: string[] = ['Prices are USD asking prices, excluding shipping, fees and tax. Location/radius filters do not apply to SidelineSwap.'];
    let totalFound: number | undefined;
    try {
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > PAGE_SIZE * MAX_PAGES) {
        throw new Error('limit must be a whole number from 0 to 500');
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5_000) {
        throw new Error('offset must be a whole number from 0 to 5000');
      }
      for (const bound of [params.minPrice, params.maxPrice]) {
        if (bound !== undefined && (!Number.isFinite(bound) || bound < 0)) throw new Error('price bounds must be finite and nonnegative');
      }
      if (params.minPrice !== undefined && params.maxPrice !== undefined && params.minPrice > params.maxPrice) {
        throw new Error('minPrice cannot exceed maxPrice');
      }
      if (params.condition && !['any', 'new', 'used'].includes(params.condition)) {
        throw new Error('SidelineSwap condition supports only new, used, or any');
      }
      if (params.sort && !SORTS[params.sort]) throw new Error('SidelineSwap does not support most_popular sort');
      if (params.category && !/^[1-9]\d*$/.test(params.category)) {
        throw new Error('SidelineSwap category must be a numeric category ID, e.g. 110030 for goalie masks');
      }
      const unsupported = ['brand', 'department', 'sizes', 'colors']
        .filter(key => params[key as keyof SearchParams] !== undefined);
      if (unsupported.length) throw new Error(`SidelineSwap does not support these filters: ${unsupported.join(', ')}. Add descriptive terms to query instead.`);
      if (limit === 0) return { marketplace: this.name, success: true, listings, ...(notes.length ? { note: notes.join(' ') } : {}) };

      const query = new URLSearchParams({ q: params.query, page_size: String(PAGE_SIZE), sort: SORTS[params.sort ?? 'relevance'] });
      query.append('state[]', 'available');
      if (params.showSold) query.append('state[]', 'sold');
      if (params.minPrice !== undefined) query.set('min_price', String(params.minPrice));
      if (params.maxPrice !== undefined) query.set('max_price', String(params.maxPrice));
      if (params.condition === 'new') query.append('condition[]', '31');
      if (params.condition === 'used') query.append('condition[]', '17');
      if (params.category) query.append('category[]', params.category);

      const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
      const deadline = AbortSignal.timeout(45_000);
      const seen = new Set<string>();
      const returned = new Set<string>();
      let hasNext = false;
      let skipped = 0;
      let pages = 0;
      for (; pages < MAX_PAGES && listings.length < limit; pages++) {
        const page = firstPage + pages;
        query.set('page', String(page));
        const payload = record(await this.request('/v2/facet_items', query, deadline));
        const paging = record(record(payload?.meta)?.paging);
        if (!Array.isArray(payload?.data) || !paging || integer(paging.page) !== page || integer(paging.page_size) !== PAGE_SIZE || typeof paging.has_next_page !== 'boolean') {
          throw new Error('Unexpected SidelineSwap search response or pagination; storefront API may have changed');
        }
        const data = payload.data;
        hasNext = paging.has_next_page;
        if (hasNext && data.length === 0) throw new Error('SidelineSwap returned an empty page with has_next_page=true');
        if (pages === 0) {
          if (paging.total_count_truncated === false) totalFound = integer(paging.total_count);
          if (paging.total_count_truncated === true) notes.push('SidelineSwap truncated its result count; totalFound is omitted.');
        }
        let added = 0;
        for (const raw of data.slice(pages === 0 ? offset % PAGE_SIZE : 0)) {
          const item = record(raw);
          const id = listingId(item?.id);
          const title = text(item?.name);
          if (!item || !id || !title) { skipped++; continue; }
          if (!seen.has(id)) { seen.add(id); added++; }
          if (returned.has(id)) continue;
          const priceNumeric = amount(item.price);
          const condition = text(record(item.condition_detail)?.slug);
          // Defend against stale/incorrect server-side facets without admitting
          // unknown prices into a price-constrained shortlist.
          if ((!params.showSold && item.state !== 'available') ||
              (params.showSold && !['available', 'sold'].includes(String(item.state))) ||
              (params.minPrice !== undefined && (priceNumeric === undefined || priceNumeric < params.minPrice)) ||
              (params.maxPrice !== undefined && (priceNumeric === undefined || priceNumeric > params.maxPrice)) ||
              (params.condition && params.condition !== 'any' && condition !== params.condition)) {
            skipped++; continue;
          }
          returned.add(id);
          listings.push({
            id, title: item.state === 'sold' ? `${title} [Sold]` : title, price: priceNumeric === undefined ? 'Price not listed' : `USD ${priceNumeric.toFixed(2)}`,
            ...(priceNumeric === undefined ? {} : { priceNumeric, currency: 'USD' }),
            url: itemUrl(item.url, id), images: photos(item),
            seller: text(record(item.seller)?.username), condition: text(record(item.condition_detail)?.name),
            description: text(item.state) ? `Availability: ${item.state}` : undefined,
            marketplace: this.name, scrapedAt: new Date().toISOString(),
          });
          if (listings.length === limit) break;
        }
        if (data.length > 0 && !data.some(raw => listingId(record(raw)?.id) && text(record(raw)?.name))) {
          throw new Error('SidelineSwap returned no recognizable listings; storefront API may have changed');
        }
        if (hasNext && pages > 0 && added === 0) throw new Error('SidelineSwap repeated a page; search is incomplete');
        if (!hasNext) break;
      }
      if (hasNext && listings.length < limit && pages === MAX_PAGES) notes.push('Incomplete: reached the 10-page request bound; use a narrower query or another offset.');
      if (skipped) notes.push(`${skipped} malformed or nonmatching listing(s) skipped; totalFound is the storefront count before defensive filtering.`);
      return { marketplace: this.name, success: true, listings, totalFound, ...(notes.length ? { note: notes.join(' ') } : {}) };
    } catch (error) {
      // A later-page failure is explicit, retaining useful verified earlier rows.
      if (listings.length) return { marketplace: this.name, success: true, listings, totalFound, note: [...notes, `Incomplete SidelineSwap search: ${error}`].join(' ') };
      return this.createError(`SidelineSwap search failed: ${error}`);
    }
  }

  async getListingDetails(input: string): Promise<ListingDetails> {
    let id = listingId(input);
    if (!id) {
      try {
        const url = new URL(input);
        if (url.protocol === 'https:' && url.hostname === 'sidelineswap.com') {
          id = listingId(url.pathname.match(/^\/gear\/(?:.*\/)?([1-9]\d*)(?:-[^/]*)?\/?$/)?.[1]);
        }
      } catch { /* rejected below */ }
    }
    if (!id) throw new Error('SidelineSwap listingId must be a numeric ID or a sidelineswap.com/gear listing URL');
    const payload = record(await this.request(`/v1/items/${id}`));
    const item = record(payload?.data);
    if (!item || listingId(item.id) !== id || !text(item.name)) throw new Error('SidelineSwap listing not found or unexpected response');
    const images = photos(item);
    const description = text(item.description);
    const fields = attributes(item);
    const currentPrice = amount(item.price);
    fields.unshift(currentPrice === undefined
      ? 'Current asking price: not listed'
      : `Current asking price: USD ${currentPrice.toFixed(2)} (shipping, fees and tax excluded)`);
    return {
      id, url: itemUrl(item.url, id), images, seller: text(record(item.seller)?.username),
      description: [...fields, ...(description ? [`\nSeller description:\n${description}`] : [])].join('\n') || undefined,
      ...(!description || !images.length ? { unavailable: [
        ...(!description ? ['description' as const] : []), ...(!images.length ? ['photos' as const] : []),
      ] } : {}),
    };
  }

  async healthCheck(): Promise<boolean> {
    return (await this.search({ query: 'hockey', limit: 1 })).success;
  }
}
