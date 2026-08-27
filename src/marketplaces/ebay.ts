/**
 * eBay Marketplace implementation
 *
 * Uses eBay's official Browse API for searching and retrieving listings.
 * Requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.
 * Docs: https://developer.ebay.com/api-docs/buy/browse/overview.html
 */

import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types.js';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const BROWSE_API_URL = 'https://api.ebay.com/buy/browse/v1';
const OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';

// eBay Browse API pagination limits: max 200 items per request, and
// offset + limit may not exceed 10,000.
const EBAY_PAGE_SIZE = 200;
const EBAY_MAX_OFFSET = 10_000;

// The Browse API `conditions` filter only accepts NEW, USED and UNSPECIFIED;
// finer grades are reachable only through the numeric `conditionIds` filter.
const MARKETPLACE_CURRENCY: Record<string, string> = {
  EBAY_US: 'USD', EBAY_GB: 'GBP', EBAY_DE: 'EUR', EBAY_FR: 'EUR', EBAY_IT: 'EUR',
  EBAY_ES: 'EUR', EBAY_NL: 'EUR', EBAY_IE: 'EUR', EBAY_AT: 'EUR', EBAY_BE: 'EUR',
  EBAY_CA: 'CAD', EBAY_AU: 'AUD', EBAY_CH: 'CHF', EBAY_PL: 'PLN', EBAY_HK: 'HKD',
  EBAY_SG: 'SGD', EBAY_MY: 'MYR', EBAY_PH: 'PHP', EBAY_TW: 'TWD',
};

const CONDITION_MAP: Record<string, string> = {
  new: 'NEW',
  like_new: 'LIKE_NEW',
  excellent: 'USED',
  good: 'GOOD',
  fair: 'FAIR',
  used: 'USED',
};

/**
 * eBay's Browse API returns image URLs at a small default size (e.g. s-l225 /
 * s-l500). The same CDN object is available at other sizes by rewriting the
 * `s-l<N>` size token (max dimension in px) and dropping any `/thumbs/` path
 * segment. Non-eBay URLs, or shapes we don't recognize, pass through unchanged.
 */
export function resizeEbayImageUrl(url: string, maxPx: number): string {
  if (!url || !url.includes('ebayimg.com')) return url;
  return url
    .replace('/thumbs/images/', '/images/')
    .replace(/\/s-l\d+\.(jpg|jpeg|png|webp)/i, `/s-l${maxPx}.$1`);
}

/** 1600px is the largest size eBay reliably hosts for every image. */
function toFullResImageUrl(url: string): string {
  return resizeEbayImageUrl(url, 1600);
}

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
  /** eBay marketplace ID, e.g. 'EBAY_US', 'EBAY_DE', 'EBAY_GB'. Defaults to 'EBAY_US'. */
  marketplaceId?: string;
}

export class EbayMarketplace extends BaseMarketplace {
  readonly name = 'ebay';
  readonly displayName = 'eBay';
  readonly requiresAuth = true;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly _clientId: string | undefined;
  private readonly _clientSecret: string | undefined;
  private readonly _marketplaceId: string;

  constructor(credentials?: EbayCredentials) {
    super();
    this._clientId = credentials?.clientId ?? process.env.EBAY_CLIENT_ID;
    this._clientSecret = credentials?.clientSecret ?? process.env.EBAY_CLIENT_SECRET;
    this._marketplaceId =
      credentials?.marketplaceId ?? process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US';
  }

  private get clientId(): string | undefined {
    return this._clientId;
  }

  private get clientSecret(): string | undefined {
    return this._clientSecret;
  }

  get marketplaceId(): string {
    return this._marketplaceId;
  }

  private marketplaceCurrency(): string {
    return MARKETPLACE_CURRENCY[this._marketplaceId] ?? 'USD';
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, condition, limit = 20, offset = 0 } = params;

    if (!this.clientId || !this.clientSecret) {
      return this.createError(
        'eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.'
      );
    }

    try {
      const token = await this.getToken();

      // Build filters once; reused across every page request
      const filters: string[] = [];
      if (minPrice != null || maxPrice != null) {
        const min = minPrice ?? '';
        const max = maxPrice ?? '';
        // Browse silently drops a price filter that arrives without a currency,
        // returning unfiltered results rather than an error.
        filters.push(`price:[${min}..${max}]`, `priceCurrency:${this.marketplaceCurrency()}`);
      }
      if (condition && condition !== 'any') {
        const ebayCondition = CONDITION_MAP[condition];
        if (ebayCondition) {
          filters.push(`conditions:{${ebayCondition}}`);
        }
      }
      const filterParam = filters.length > 0 ? filters.join(',') : undefined;

      // eBay's Browse API returns at most 200 items per request and caps
      // offset + limit at 10,000, so fetch successive pages until we've
      // collected `limit` listings (or run out of results).
      const target = Math.max(0, limit);
      const listings: Listing[] = [];
      let total = 0;
      let currentOffset = Math.max(0, offset);

      while (listings.length < target && currentOffset < EBAY_MAX_OFFSET) {
        const remaining = target - listings.length;
        const pageLimit = Math.min(remaining, EBAY_PAGE_SIZE, EBAY_MAX_OFFSET - currentOffset);
        if (pageLimit <= 0) break;

        const searchParams = new URLSearchParams({
          q: query,
          limit: String(pageLimit),
          offset: String(currentOffset),
        });
        if (filterParam) {
          searchParams.set('filter', filterParam);
        }

        const response = await fetch(
          `${BROWSE_API_URL}/item_summary/search?${searchParams.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-EBAY-C-MARKETPLACE-ID': this._marketplaceId,
            },
          }
        );

        if (!response.ok) {
          // If earlier pages succeeded, return what we have rather than failing.
          if (listings.length > 0) break;
          const errBody = await response.text();
          return this.createError(`eBay API returned ${response.status}: ${errBody}`);
        }

        const data = (await response.json()) as any;
        total = data.total ?? total;
        const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
        if (items.length === 0) break; // no more results available

        this.parseListings(items, target, listings);
        currentOffset += items.length;

        // Reached the end of the result set reported by eBay.
        if (total && currentOffset >= total) break;
      }

      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: total || listings.length,
        ...(listings.length === 0 && {
          note: 'No eBay listings found for this query. eBay searches nationally (not location-based). Try broadening your search terms.',
        }),
      };
    } catch (error) {
      return this.createError(`eBay search failed: ${error}`);
    }
  }

  async getListingDetails(itemId: string): Promise<ListingDetails> {
    const token = await this.getToken();

    // Listing URLs show a bare number; the Browse API wants "v1|123456|0".
    const apiItemId = /^\d+$/.test(itemId) ? `v1|${itemId}|0` : itemId;

    const response = await fetch(`${BROWSE_API_URL}/item/${encodeURIComponent(apiItemId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': this._marketplaceId,
      },
    });

    if (!response.ok) {
      throw new Error(`eBay API returned ${response.status}`);
    }

    const item = (await response.json()) as any;

    const images: string[] = [];
    if (item.image?.imageUrl) {
      images.push(toFullResImageUrl(item.image.imageUrl));
    }
    if (Array.isArray(item.additionalImages)) {
      for (const img of item.additionalImages) {
        if (img.imageUrl) images.push(toFullResImageUrl(img.imageUrl));
      }
    }

    const location = item.itemLocation;
    const locationText = [location?.city, location?.stateOrProvince, location?.country]
      .filter(Boolean)
      .join(', ');

    return {
      id: item.itemId,
      description: item.description ?? item.shortDescription ?? undefined,
      images,
      location: locationText || undefined,
      seller: item.seller?.username ?? undefined,
      deliveryTypes: item.shippingOptions?.map((s: any) => s.shippingServiceCode) ?? undefined,
      isShippingOffered: Array.isArray(item.shippingOptions) && item.shippingOptions.length > 0,
      url: item.itemWebUrl ?? `https://www.ebay.com/itm/${itemId}`,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.clientId || !this.clientSecret) return false;
    try {
      await this.getToken();
      return true;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private parseListings(items: any[], target: number, listings: Listing[]): void {
    for (const item of items) {
      if (listings.length >= target) break;

      try {
        // Browse gives amount and currency as separate fields, so only the
        // amount needs parsing; the currency is already known.
        const currency = item.price?.currency === 'USD' ? '$' : item.price?.currency;
        const priceStr = item.price ? `${currency}${item.price.value}` : 'Price not listed';
        const parsed = item.price ? this.parsePrice(String(item.price.value)) : null;

        // Only grab primary image for search results; full set via getListingDetails
        const images: string[] = [];
        if (item.image?.imageUrl) images.push(toFullResImageUrl(item.image.imageUrl));

        const location = item.itemLocation;
        const locationText = [location?.city, location?.stateOrProvince]
          .filter(Boolean)
          .join(', ');

        listings.push({
          id: item.itemId,
          title: item.title || 'Untitled Listing',
          price: priceStr,
          priceNumeric: parsed?.numeric,
          currency: currency ?? '$',
          condition: item.condition,
          location: locationText || undefined,
          url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
          images: images.length > 0 ? images : undefined,
          seller: item.seller?.username,
          marketplace: this.name,
          scrapedAt: new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }
  }

  private async getToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
    });

    if (!response.ok) {
      throw new Error(`eBay OAuth failed with status ${response.status}`);
    }

    const data = (await response.json()) as any;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.accessToken!;
  }
}
