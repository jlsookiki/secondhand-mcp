/**
 * Poshmark Marketplace implementation
 *
 * Reads Poshmark's own JSON API (`/vm-rest/posts`), the same data its web app
 * loads, over plain HTTP. No browser and no authentication needed.
 */

import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types.js';

const MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 48;

const POSHMARK_BASE = 'https://poshmark.com';
const SEARCH_API = `${POSHMARK_BASE}/vm-rest/posts`;
const LISTING_URL = `${POSHMARK_BASE}/listing/`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_HEADERS = { 'user-agent': USER_AGENT, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9' };

const CONDITION_CODES: Record<string, string> = {
  new: 'nwt',
  like_new: 'uln',
  good: 'ug',
  fair: 'uf',
};

const CONDITION_NAMES: Record<string, string> = {
  nwt: 'New with tags',
  not_nwt: 'New without tags',
  ret: 'New',
  uln: 'Like new',
  ug: 'Good',
  uf: 'Fair',
};

/** Price sorts are missing on purpose: Poshmark's price-sorted index ignores relevance and leads with placeholder posts
 *  ($3 closet promotions, $50,000 wanted posts), so price order is applied here over a relevance-ranked page. */
const SERVER_SORTS: Record<string, string> = {
  relevance: 'relevance',
  newest: 'added_desc',
  most_popular: 'like_count',
};

/** The search API's request. Its department filter answers any named department with a server error, so it is always All. */
export interface PoshmarkSearchRequest {
  query: string;
  count: string;
  sort_by?: string;
  filters: {
    department: 'All';
    inventory_status: ['available'];
    brand?: string[];
    category_v2?: string;
    size?: string[];
    color?: string[];
    condition?: string[];
  };
}

interface PoshmarkMoney {
  val?: string;
  currency_symbol?: string;
}

interface PoshmarkPicture {
  url_large?: string;
  url?: string;
}

/** The fields this adapter reads from a post, in search results and from the single-post endpoint. */
export interface PoshmarkPost {
  id: string;
  title?: string;
  price_amount?: PoshmarkMoney;
  picture_url?: string;
  creator_username?: string;
  condition?: string;
  description?: string;
  pictures?: PoshmarkPicture[];
  cover_shot?: PoshmarkPicture;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPost(value: unknown): value is PoshmarkPost {
  return isRecord(value) && typeof value.id === 'string';
}

type SearchFilters = Pick<SearchParams, 'sort' | 'condition' | 'category' | 'brand' | 'department' | 'sizes' | 'colors'>;
type PriceShaping = Pick<SearchParams, 'sort' | 'minPrice' | 'maxPrice'>;

export function sortsByPrice(sort: SearchParams['sort']): boolean {
  return sort === 'price_low_to_high' || sort === 'price_high_to_low';
}

/** Price bounds and price order are applied after the fetch, so either asks for a full page to cut and order. */
export function requestCount(limit: number, shaping: PriceShaping): number {
  if (shaping.minPrice != null || shaping.maxPrice != null || sortsByPrice(shaping.sort)) return PAGE_SIZE;
  return Math.min(Math.max(limit, 1), PAGE_SIZE);
}

/** The department leads the query instead, which Poshmark's search ranks on as its web app's department filter would. */
export function searchQuery(query: string, department: string | undefined): string {
  const named = department?.trim();
  return named ? `${named} ${query}` : query;
}

export function buildSearchRequest(query: string, count: number, filters: SearchFilters): PoshmarkSearchRequest {
  const request: PoshmarkSearchRequest = {
    query: searchQuery(query, filters.department),
    count: String(count),
    filters: { department: 'All', inventory_status: ['available'] },
  };
  const sort = filters.sort ? SERVER_SORTS[filters.sort] : undefined;
  if (sort) request.sort_by = sort;
  const condition = filters.condition ? CONDITION_CODES[filters.condition] : undefined;
  if (condition) request.filters.condition = [condition];
  if (filters.brand) request.filters.brand = [filters.brand];
  if (filters.category) request.filters.category_v2 = filters.category;
  if (filters.sizes?.length) request.filters.size = filters.sizes;
  if (filters.colors?.length) request.filters.color = filters.colors;
  return request;
}

export function searchUrl(request: PoshmarkSearchRequest): string {
  return `${SEARCH_API}?request=${encodeURIComponent(JSON.stringify(request))}&summarize=true`;
}

/** Poshmark's canonical listing path: apostrophes dropped, every other run of punctuation a hyphen, the id last. */
export function listingUrl(post: Pick<PoshmarkPost, 'id' | 'title'>): string {
  const slug = (post.title ?? '')
    .replace(/['’]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefix = slug ? `${slug}-` : '';
  return `${LISTING_URL}${prefix}${post.id}`;
}

interface Price {
  text: string;
  numeric?: number;
  currency: string;
}

export function priceOf(money: PoshmarkMoney | undefined): Price {
  const numeric = money?.val !== undefined ? Number(money.val) : NaN;
  const currency = money?.currency_symbol || '$';
  if (!Number.isFinite(numeric)) return { text: 'Price not listed', currency };
  const amount = Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  return { text: `${currency}${amount}`, numeric, currency };
}

export function toListing(post: PoshmarkPost): Listing {
  const price = priceOf(post.price_amount);
  const condition = post.condition ? CONDITION_NAMES[post.condition] : undefined;
  return {
    id: post.id,
    title: post.title || post.id,
    price: price.text,
    priceNumeric: price.numeric,
    currency: price.currency,
    url: listingUrl(post),
    images: post.picture_url ? [post.picture_url] : undefined,
    seller: post.creator_username || undefined,
    ...(condition && { condition }),
    marketplace: 'poshmark',
    scrapedAt: new Date().toISOString(),
  };
}

export function toListingDetails(post: PoshmarkPost): ListingDetails {
  const images = (Array.isArray(post.pictures) ? post.pictures : [])
    .filter(isRecord)
    .map((p) => p.url_large || p.url)
    .filter((u): u is string => typeof u === 'string' && u !== '');
  const cover = post.cover_shot?.url_large || post.picture_url;
  if (images.length === 0 && cover) images.push(cover);
  return {
    id: post.id,
    description: post.description || undefined,
    images,
    seller: post.creator_username || undefined,
    isShippingOffered: true,
    url: listingUrl(post),
  };
}

/** Unpriced listings stay in, since the bound cannot rule them out. */
export function withinPriceBounds(listings: Listing[], minPrice?: number, maxPrice?: number): Listing[] {
  return listings.filter((l) => {
    if (l.priceNumeric == null) return true;
    if (minPrice != null && l.priceNumeric < minPrice) return false;
    if (maxPrice != null && l.priceNumeric > maxPrice) return false;
    return true;
  });
}

/** Orders listings by price for a price sort, unpriced ones last; any other sort keeps Poshmark's order. */
export function sortedByPrice(listings: Listing[], sort: SearchParams['sort']): Listing[] {
  if (sort === 'price_low_to_high') return [...listings].sort((a, b) => (a.priceNumeric ?? Infinity) - (b.priceNumeric ?? Infinity));
  if (sort === 'price_high_to_low') return [...listings].sort((a, b) => (b.priceNumeric ?? -Infinity) - (a.priceNumeric ?? -Infinity));
  return listings;
}

/** A listing is addressed by its 24-character id, which also ends every listing slug. */
export function postIdFrom(listingId: string): string {
  return listingId.match(/([a-f0-9]{24})(?:[/?#].*)?$/i)?.[1] ?? listingId;
}

/** The posts in a search reply, or null when the reply is not one: an error envelope or a changed shape is a failed attempt, not an empty search. */
export function postsFrom(body: unknown): PoshmarkPost[] | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  return body.data.filter(isPost);
}

export type PostReply = { kind: 'post'; post: PoshmarkPost } | { kind: 'not_found' };

/** What a single-post reply says, or null when it is neither a post nor a not-found. The endpoint answers with the post
 *  itself, not under `data` like a search, and a gone listing is HTTP 200 with a NotFoundError envelope. */
export function postReply(body: unknown): PostReply | null {
  if (!isRecord(body)) return null;
  const post = body.data ?? body;
  if (isPost(post)) return { kind: 'post', post };
  const { error } = body;
  if (isRecord(error) && (error.errorType === 'NotFoundError' || error.statusCode === 404)) return { kind: 'not_found' };
  return null;
}

/** Reads a single-post reply as listing details; a listing Poshmark no longer has is an error, not a retry. */
export function detailsFromReply(postId: string, reply: PostReply): ListingDetails {
  if (reply.kind === 'not_found') throw new Error(`Poshmark has no listing ${postId}; it may have been sold or removed`);
  return toListingDetails(reply.post);
}

/** A second attempt covers a dropped connection or a one-off challenge page; `read` returning null marks a reply unusable. */
async function getJson<T>(url: string, read: (body: unknown) => T | null): Promise<T> {
  let lastError = 'no attempt made';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      const text = await res.text();
      if (res.status === 200) {
        const value = read(JSON.parse(text));
        if (value !== null) return value;
        lastError = 'unexpected response shape';
      } else {
        lastError = `status=${res.status}`;
      }
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    console.log(`[poshmark] Attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastError})`);
  }
  throw new Error(`All ${MAX_ATTEMPTS} attempts failed. Last: ${lastError}`);
}

export class PoshmarkMarketplace extends BaseMarketplace {
  readonly name = 'poshmark';
  readonly displayName = 'Poshmark';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, sort, limit = PAGE_SIZE } = params;
    try {
      const count = requestCount(limit, params);
      const posts = await getJson(searchUrl(buildSearchRequest(query, count, params)), postsFrom);
      const bounded = withinPriceBounds(posts.map(toListing), minPrice, maxPrice);
      const listings = sortedByPrice(bounded, sort).slice(0, limit);
      return { marketplace: this.name, success: true, listings, totalFound: listings.length };
    } catch (error) {
      return this.createError(`Poshmark search failed: ${error}`);
    }
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    const postId = postIdFrom(listingId);
    const reply = await getJson(`${SEARCH_API}/${encodeURIComponent(postId)}`, postReply);
    return detailsFromReply(postId, reply);
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.search({ query: 'test', limit: 1 });
    return result.success;
  }
}
