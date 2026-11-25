import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PoshmarkMarketplace,
  buildSearchRequest,
  detailsFromReply,
  listingUrl,
  postIdFrom,
  postReply,
  postsFrom,
  priceOf,
  requestCount,
  searchQuery,
  toListing,
  toListingDetails,
  withinPriceBounds,
  type PoshmarkPost,
} from '../src/marketplaces/poshmark.js';
import type { Listing } from '../src/types.js';

const ID = '6ad3f9b54941b5539c7121d0';
const UNFILTERED = { department: 'All', inventory_status: ['available'] };

const post = (over: Partial<PoshmarkPost> = {}): PoshmarkPost => ({
  id: ID,
  title: 'Levi’s Blue Women\'s Skinny Jeans - 10',
  price_amount: { val: '19.0', currency_symbol: '$' },
  picture_url: 'https://di2ponv0v5otw.cloudfront.net/posts/m_1.jpg',
  creator_username: 'closetresaleco',
  condition: 'ug',
  ...over,
});

type Answer = () => Response | Error;

const json = (body: unknown, status = 200): Answer => () => new Response(JSON.stringify(body), { status });
const text = (body: string, status: number): Answer => () => new Response(body, { status });
const failure = (message: string): Answer => () => new Error(message);

/** Each call gets a fresh Response from the next answer; the last answer repeats. */
function stubFetch(...answers: Answer[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(String(url));
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    const answer = next();
    if (answer instanceof Error) throw answer;
    return answer;
  }));
  return urls;
}

const requestOf = (url: string) => JSON.parse(new URL(url).searchParams.get('request')!);
const priced = (...prices: Array<number | undefined>): Listing[] =>
  prices.map((p, i) => toListing(post({ id: String(i), price_amount: p === undefined ? undefined : { val: String(p) } })));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('search request', () => {
  it('asks for available listings across departments', () => {
    expect(buildSearchRequest('levis', 48, {})).toEqual({ query: 'levis', count: '48', filters: UNFILTERED });
  });

  it('asks for the limit, at most a page, and a full page whenever price bounds will cut it', () => {
    expect(requestCount(10, false)).toBe(10);
    expect(requestCount(100, false)).toBe(48);
    expect(requestCount(0, false)).toBe(1);
    expect(requestCount(10, true)).toBe(48);
  });

  it.each([
    ['new', 'nwt'],
    ['like_new', 'uln'],
    ['good', 'ug'],
    ['fair', 'uf'],
  ] as const)('sends condition %s as Poshmark code %s', (condition, code) => {
    expect(buildSearchRequest('x', 48, { condition }).filters.condition).toEqual([code]);
  });

  it.each([
    ['relevance', 'relevance'],
    ['newest', 'added_desc'],
    ['price_low_to_high', 'price_asc'],
    ['price_high_to_low', 'price_desc'],
    ['most_popular', 'like_count'],
  ] as const)('sends sort %s as %s', (sort, sortBy) => {
    expect(buildSearchRequest('x', 48, { sort }).sort_by).toBe(sortBy);
  });

  it('leaves condition, sort and the other filters out when not asked for or not ones Poshmark has', () => {
    const request = buildSearchRequest('x', 48, { condition: 'any', sizes: [], colors: [] });
    expect(request).toEqual({ query: 'x', count: '48', filters: UNFILTERED });
    expect(buildSearchRequest('x', 48, { condition: 'excellent' }).filters).toEqual(UNFILTERED);
  });

  it('passes brand, category, sizes and colours the way the API reads them', () => {
    const request = buildSearchRequest('x', 48, {
      brand: "Levi's", category: 'Jackets_&_Coats', sizes: ['30', '32'], colors: ['Black'],
    });
    expect(request.filters).toEqual({
      ...UNFILTERED, brand: ["Levi's"], category_v2: 'Jackets_&_Coats', size: ['30', '32'], color: ['Black'],
    });
  });

  it('puts the department at the front of the query and keeps the department filter on All', () => {
    expect(searchQuery('jeans', 'Men')).toBe('Men jeans');
    expect(searchQuery('jeans', '  Kids ')).toBe('Kids jeans');
    expect(searchQuery('jeans', '')).toBe('jeans');
    expect(searchQuery('jeans', undefined)).toBe('jeans');
    const request = buildSearchRequest('jeans', 48, { department: 'Men' });
    expect(request.query).toBe('Men jeans');
    expect(request.filters.department).toBe('All');
  });
});

describe('listing shape', () => {
  it('builds Poshmark\'s canonical listing URL from the title and id', () => {
    expect(listingUrl({ id: ID, title: 'Women’s Levi\'s 550 Relaxed Shorts Size 6' }))
      .toBe(`https://poshmark.com/listing/Womens-Levis-550-Relaxed-Shorts-Size-6-${ID}`);
    expect(listingUrl({ id: ID, title: '--Hi!--' })).toBe(`https://poshmark.com/listing/Hi-${ID}`);
    expect(listingUrl({ id: ID, title: '' })).toBe(`https://poshmark.com/listing/${ID}`);
    expect(listingUrl({ id: ID })).toBe(`https://poshmark.com/listing/${ID}`);
  });

  it('prints whole prices without cents, keeps cents otherwise, and says when there is no price', () => {
    expect(priceOf({ val: '19.0', currency_symbol: '$' })).toEqual({ text: '$19', numeric: 19, currency: '$' });
    expect(priceOf({ val: '19.5', currency_symbol: '£' })).toEqual({ text: '£19.50', numeric: 19.5, currency: '£' });
    expect(priceOf({ val: '7' })).toEqual({ text: '$7', numeric: 7, currency: '$' });
    expect(priceOf({ val: 'n/a' })).toEqual({ text: 'Price not listed', currency: '$' });
    expect(priceOf(undefined)).toEqual({ text: 'Price not listed', currency: '$' });
  });

  it('maps a search post to a listing', () => {
    expect(toListing(post())).toMatchObject({
      id: ID,
      title: 'Levi’s Blue Women\'s Skinny Jeans - 10',
      price: '$19',
      priceNumeric: 19,
      currency: '$',
      url: `https://poshmark.com/listing/Levis-Blue-Womens-Skinny-Jeans-10-${ID}`,
      images: ['https://di2ponv0v5otw.cloudfront.net/posts/m_1.jpg'],
      seller: 'closetresaleco',
      condition: 'Good',
      marketplace: 'poshmark',
    });
  });

  it.each([
    ['nwt', 'New with tags'],
    ['ret', 'New'],
    ['uln', 'Like new'],
    ['uf', 'Fair'],
  ])('names condition code %s as %s', (code, name) => {
    expect(toListing(post({ condition: code })).condition).toBe(name);
  });

  it('falls back to the id for a missing title and leaves out what the post does not have', () => {
    const bare = toListing(post({ price_amount: undefined, condition: 'zz', picture_url: undefined, title: undefined, creator_username: '' }));
    expect(bare).toMatchObject({ price: 'Price not listed', priceNumeric: undefined, title: ID, images: undefined, seller: undefined });
    expect(bare).not.toHaveProperty('condition');
    expect(toListing(post({ condition: undefined }))).not.toHaveProperty('condition');
  });

  it('maps a single post to listing details with every photo, falling back to the cover photo', () => {
    const details = toListingDetails(post({
      description: 'High-rise, light wash.',
      pictures: [{ url_large: 'https://cdn/l_1.jpg', url: 'https://cdn/1.jpg' }, { url: 'https://cdn/2.jpg' }, {}],
    }));
    expect(details).toEqual({
      id: ID,
      description: 'High-rise, light wash.',
      images: ['https://cdn/l_1.jpg', 'https://cdn/2.jpg'],
      seller: 'closetresaleco',
      isShippingOffered: true,
      url: `https://poshmark.com/listing/Levis-Blue-Womens-Skinny-Jeans-10-${ID}`,
    });
    expect(toListingDetails(post({ pictures: [], cover_shot: { url_large: 'https://cdn/cover.jpg' } })).images)
      .toEqual(['https://cdn/cover.jpg']);
    expect(toListingDetails(post({ pictures: undefined })).images)
      .toEqual(['https://di2ponv0v5otw.cloudfront.net/posts/m_1.jpg']);
    expect(toListingDetails(post({ pictures: undefined, picture_url: undefined })).images).toEqual([]);
    expect(toListingDetails(post({ creator_username: '', description: '' }))).toMatchObject({ seller: undefined, description: undefined });
  });

  it('reads the post id off the end of a listing slug or URL', () => {
    expect(postIdFrom(`Levis-Blue-Jeans-${ID}`)).toBe(ID);
    expect(postIdFrom(`https://poshmark.com/listing/Levis-${ID}?src=x`)).toBe(ID);
    expect(postIdFrom(ID)).toBe(ID);
    expect(postIdFrom('not-an-id')).toBe('not-an-id');
  });
});

describe('price bounds', () => {
  it('keeps listings inside both bounds, inclusive', () => {
    expect(withinPriceBounds(priced(5, 10, 20, 28, 30), 10, 28).map((l) => l.priceNumeric)).toEqual([10, 20, 28]);
  });

  it('applies a lone bound and keeps unpriced listings', () => {
    expect(withinPriceBounds(priced(5, undefined, 30), 10).map((l) => l.priceNumeric)).toEqual([undefined, 30]);
    expect(withinPriceBounds(priced(5, undefined, 30), undefined, 10).map((l) => l.priceNumeric)).toEqual([5, undefined]);
    expect(withinPriceBounds(priced(5, 30))).toHaveLength(2);
  });
});

describe('replies', () => {
  it('reads posts with an id out of a search reply, and anything else as no reply at all', () => {
    expect(postsFrom({ data: [post(), { title: 'no id' }, null] })).toEqual([post()]);
    expect(postsFrom({ data: [] })).toEqual([]);
    expect(postsFrom({ error: { code: 'internal' } })).toBeNull();
    expect(postsFrom(null)).toBeNull();
  });

  it('reads a single-post reply as the post, a not-found, or nothing usable', () => {
    expect(postReply(post())).toEqual({ kind: 'post', post: post() });
    expect(postReply({ data: post() })).toEqual({ kind: 'post', post: post() });
    expect(postReply({ error: { errorType: 'NotFoundError' } })).toEqual({ kind: 'not_found' });
    expect(postReply({ error: { statusCode: 404 } })).toEqual({ kind: 'not_found' });
    expect(postReply({ error: { statusCode: 500 } })).toBeNull();
    expect(postReply({})).toBeNull();
    expect(postReply(null)).toBeNull();
  });

  it('turns a post into details and a not-found into an error naming the listing', () => {
    expect(detailsFromReply(ID, { kind: 'post', post: post() }).id).toBe(ID);
    expect(() => detailsFromReply(ID, { kind: 'not_found' })).toThrow(`Poshmark has no listing ${ID}`);
  });
});

describe('search', () => {
  it('queries the posts API with the built request and returns its listings', async () => {
    const urls = stubFetch(json({ data: [post(), post({ id: 'b'.repeat(24) })] }));
    const result = await new PoshmarkMarketplace().search({ query: 'levis', condition: 'like_new', limit: 10 });
    const url = new URL(urls[0]);
    expect(url.origin + url.pathname).toBe('https://poshmark.com/vm-rest/posts');
    expect(url.searchParams.get('summarize')).toBe('true');
    expect(requestOf(urls[0])).toMatchObject({ query: 'levis', count: '10', filters: { condition: ['uln'] } });
    expect(result).toMatchObject({ marketplace: 'poshmark', success: true, totalFound: 2 });
    expect(result.listings.map((l) => l.id)).toEqual([ID, 'b'.repeat(24)]);
  });

  it('defaults to a full page', async () => {
    const urls = stubFetch(json({ data: [] }));
    await new PoshmarkMarketplace().search({ query: 'x' });
    expect(requestOf(urls[0]).count).toBe('48');
  });

  it('applies price bounds before the limit', async () => {
    stubFetch(json({ data: [
      post({ id: 'a'.repeat(24), price_amount: { val: '5' } }),
      post({ id: 'b'.repeat(24), price_amount: { val: '20' } }),
      post({ id: 'c'.repeat(24), price_amount: { val: '30' } }),
      post({ id: 'd'.repeat(24), price_amount: { val: '25' } }),
    ] }));
    const result = await new PoshmarkMarketplace().search({ query: 'x', minPrice: 10, maxPrice: 28, limit: 1 });
    expect(result.listings.map((l) => l.priceNumeric)).toEqual([20]);
    expect(result.totalFound).toBe(1);
  });

  it('asks for a full page when price bounds will cut it, so a bounded search is not left short', async () => {
    const page = Array.from({ length: 48 }, (_, i) => post({ id: i.toString(16).padStart(24, '0'), price_amount: { val: String(i + 1) } }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json({ data: page.slice(0, Number(requestOf(url).count)) })()));
    const result = await new PoshmarkMarketplace().search({ query: 'x', sort: 'price_low_to_high', minPrice: 40, limit: 5 });
    expect(result.listings.map((l) => l.priceNumeric)).toEqual([40, 41, 42, 43, 44]);
  });

  it('treats a reply without a data array as a failed attempt, but an empty one as no results', async () => {
    const urls = stubFetch(json({ error: { code: 'internal' } }));
    expect(await new PoshmarkMarketplace().search({ query: 'x' })).toEqual({
      marketplace: 'poshmark',
      success: false,
      listings: [],
      error: 'Poshmark search failed: Error: All 2 attempts failed. Last: unexpected response shape',
    });
    expect(urls).toHaveLength(2);
    stubFetch(json({ data: [] }));
    expect(await new PoshmarkMarketplace().search({ query: 'x' })).toMatchObject({ success: true, listings: [], totalFound: 0 });
  });

  it('asks again after a challenge page answered with a 200', async () => {
    const urls = stubFetch(text('<html>Just a moment...</html>', 200), json({ data: [post()] }));
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(urls).toHaveLength(2);
    expect(result.success).toBe(true);
  });

  it('asks again after a refusal and serves the second answer', async () => {
    const urls = stubFetch(text('blocked', 403), json({ data: [post()] }));
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(urls).toHaveLength(2);
    expect(result.listings).toHaveLength(1);
  });

  it('reports the last error after both attempts fail', async () => {
    const urls = stubFetch(failure('socket hang up'), text('nope', 500));
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(urls).toHaveLength(2);
    expect(result).toMatchObject({ success: false, error: 'Poshmark search failed: Error: All 2 attempts failed. Last: status=500' });
  });

  it('reports a thrown network error as it was', async () => {
    stubFetch(failure('socket hang up'));
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(result.error).toBe('Poshmark search failed: Error: All 2 attempts failed. Last: socket hang up');
  });

  it('reports a thrown value that is not an Error by its text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'offline';
    }));
    const result = await new PoshmarkMarketplace().search({ query: 'x' });
    expect(result.error).toBe('Poshmark search failed: Error: All 2 attempts failed. Last: offline');
  });
});

describe('listing details', () => {
  it('reads the single-post endpoint by the id at the end of the slug', async () => {
    const urls = stubFetch(json(post({ description: 'Light wash.' })));
    const details = await new PoshmarkMarketplace().getListingDetails(`Levis-Blue-Jeans-${ID}`);
    expect(urls).toEqual([`https://poshmark.com/vm-rest/posts/${ID}`]);
    expect(details).toMatchObject({ id: ID, description: 'Light wash.' });
  });

  it('says a listing Poshmark no longer has is gone after the first reply', async () => {
    const urls = stubFetch(json({ error: { errorType: 'NotFoundError', statusCode: 404 }, meta: { api_url: `/posts/${ID}` } }));
    await expect(new PoshmarkMarketplace().getListingDetails(ID)).rejects.toThrow(`Poshmark has no listing ${ID}`);
    expect(urls).toHaveLength(1);
  });

  it('throws when Poshmark answers without a listing or keeps refusing', async () => {
    stubFetch(json({}));
    await expect(new PoshmarkMarketplace().getListingDetails(ID)).rejects.toThrow('Last: unexpected response shape');
    stubFetch(text('blocked', 403));
    await expect(new PoshmarkMarketplace().getListingDetails(ID)).rejects.toThrow('All 2 attempts failed. Last: status=403');
  });
});

describe('health check', () => {
  it('is healthy when a one-listing search succeeds and unhealthy when it fails', async () => {
    const urls = stubFetch(json({ data: [post()] }));
    expect(await new PoshmarkMarketplace().healthCheck()).toBe(true);
    expect(requestOf(urls[0])).toMatchObject({ query: 'test', count: '1' });
    stubFetch(text('blocked', 403));
    expect(await new PoshmarkMarketplace().healthCheck()).toBe(false);
  });
});
