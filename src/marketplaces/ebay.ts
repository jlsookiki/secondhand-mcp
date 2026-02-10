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

const CONDITION_MAP: Record<string, string> = {
  new: 'NEW',
  like_new: 'LIKE_NEW',
  good: 'GOOD',
  fair: 'FAIR',
};

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
}

export class EbayMarketplace extends BaseMarketplace {
  readonly name = 'ebay';
  readonly displayName = 'eBay';
  readonly requiresAuth = true;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private readonly _clientId: string | undefined;
  private readonly _clientSecret: string | undefined;

  constructor(credentials?: EbayCredentials) {
    super();
    this._clientId = credentials?.clientId ?? process.env.EBAY_CLIENT_ID;
    this._clientSecret = credentials?.clientSecret ?? process.env.EBAY_CLIENT_SECRET;
  }

  private get clientId(): string | undefined {
    return this._clientId;
  }

  private get clientSecret(): string | undefined {
    return this._clientSecret;
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, condition, limit = 20 } = params;

    if (!this.clientId || !this.clientSecret) {
      return this.createError(
        'eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.'
      );
    }

    try {
      const token = await this.getToken();

      // Build query parameters
      const searchParams = new URLSearchParams({
        q: query,
        limit: String(Math.min(limit, 200)),
      });

      // Build filters
      const filters: string[] = [];
      if (minPrice != null || maxPrice != null) {
        const min = minPrice ?? '';
        const max = maxPrice ?? '';
        filters.push(`price:[${min}..${max}]`);
      }
      if (condition && condition !== 'any') {
        const ebayCondition = CONDITION_MAP[condition];
        if (ebayCondition) {
          filters.push(`conditions:{${ebayCondition}}`);
        }
      }
      if (filters.length > 0) {
        searchParams.set('filter', filters.join(','));
      }

      const response = await fetch(
        `${BROWSE_API_URL}/item_summary/search?${searchParams.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
        }
      );

      if (!response.ok) {
        const errBody = await response.text();
        return this.createError(`eBay API returned ${response.status}: ${errBody}`);
      }

      const data = (await response.json()) as any;
      const items = data.itemSummaries ?? [];
      const listings = this.parseListings(items, limit);

      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: data.total ?? listings.length,
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

    const response = await fetch(`${BROWSE_API_URL}/item/${encodeURIComponent(itemId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });

    if (!response.ok) {
      throw new Error(`eBay API returned ${response.status}`);
    }

    const item = (await response.json()) as any;

    const images: string[] = [];
    if (item.image?.imageUrl) {
      images.push(item.image.imageUrl);
    }
    if (Array.isArray(item.additionalImages)) {
      for (const img of item.additionalImages) {
        if (img.imageUrl) images.push(img.imageUrl);
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

  private parseListings(items: any[], limit: number): Listing[] {
    const listings: Listing[] = [];

    for (const item of items) {
      if (listings.length >= limit) break;

      try {
        const priceStr = item.price
          ? `${item.price.currency === 'USD' ? '$' : item.price.currency}${item.price.value}`
          : 'Price not listed';
        const parsed = this.parsePrice(priceStr);

        // Only grab primary image for search results; full set via getListingDetails
        const images: string[] = [];
        if (item.image?.imageUrl) images.push(item.image.imageUrl);

        const location = item.itemLocation;
        const locationText = [location?.city, location?.stateOrProvince]
          .filter(Boolean)
          .join(', ');

        listings.push({
          id: item.itemId,
          title: item.title || 'Untitled Listing',
          price: priceStr,
          priceNumeric: parsed?.numeric,
          currency: parsed?.currency || '$',
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

    return listings;
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
