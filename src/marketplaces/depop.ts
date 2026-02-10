/**
 * Depop Marketplace implementation
 *
 * Uses a headless browser to bypass Cloudflare TLS fingerprinting,
 * then calls the Depop web API directly from within the browser context.
 * This gives us clean JSON without any DOM scraping.
 * No Depop authentication required.
 */

import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types.js';
import { newPage } from '../browser.js';

const DEPOP_HOME = 'https://www.depop.com/';
const SEARCH_API = 'https://webapi.depop.com/api/v2/search/products/';
const EXTENDED_API = 'https://webapi.depop.com/api/v1/product/by-slug/';
const PRODUCT_URL = 'https://www.depop.com/products/';

// Map user-friendly condition names to Depop API values
const CONDITION_MAP: Record<string, string> = {
  new: 'brand_new',
  like_new: 'used_like_new',
  excellent: 'used_excellent',
  good: 'used_good',
  fair: 'used_fair',
};

export class DepopMarketplace extends BaseMarketplace {
  readonly name = 'depop';
  readonly displayName = 'Depop';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, limit = 24, sort, condition, category, sizes, colors } = params;

    let page;
    try {
      page = await newPage();

      // Navigate to Depop first to establish Cloudflare cookies/session
      await page.goto(DEPOP_HOME, { waitUntil: 'networkidle2', timeout: 30000 });

      // Build API URL
      const apiUrl = new URL(SEARCH_API);
      apiUrl.searchParams.set('what', query);
      apiUrl.searchParams.set('itemsPerPage', String(limit));
      apiUrl.searchParams.set('country', 'us');
      apiUrl.searchParams.set('currency', 'USD');
      apiUrl.searchParams.set('sort', sort || 'relevance');
      if (minPrice != null) apiUrl.searchParams.set('priceMin', String(minPrice));
      if (maxPrice != null) apiUrl.searchParams.set('priceMax', String(maxPrice));
      if (condition && condition !== 'any') {
        const depopCondition = CONDITION_MAP[condition];
        if (depopCondition) apiUrl.searchParams.set('conditions', depopCondition);
      }
      if (category) apiUrl.searchParams.set('groups', category);
      if (sizes) for (const s of sizes) apiUrl.searchParams.append('sizes', s);
      if (colors) for (const c of colors) apiUrl.searchParams.append('colours', c);

      // Call the API from within the browser context
      const apiResponse: { error: string | null; data: any } = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, {
            headers: {
              'accept': 'application/json',
            },
          });
          if (!res.ok) return { error: `HTTP ${res.status}`, data: null };
          const data = await res.json();
          return { error: null, data };
        } catch (e: any) {
          return { error: e.message || String(e), data: null };
        }
      }, apiUrl.toString());

      if (apiResponse.error || !apiResponse.data) {
        return this.createError(`Depop API error: ${apiResponse.error}`);
      }

      const data = apiResponse.data;
      const products: any[] = data.products || [];
      const listings: Listing[] = [];

      for (const product of products) {
        if (listings.length >= limit) break;

        const slug = product.slug;
        if (!slug) continue;

        const priceAmount = product.price?.priceAmount;
        const currency = product.price?.currencyName === 'GBP' ? '£' : '$';
        const priceStr = priceAmount != null ? `${currency}${priceAmount}` : 'Price not listed';
        const priceNumeric = priceAmount != null ? parseFloat(priceAmount) : undefined;

        // Get best available preview image (values are direct URL strings)
        const preview = product.preview;
        const images: string[] = [];
        if (preview) {
          const imgUrl = preview['480'] || preview['320'] || preview['640'];
          if (imgUrl) images.push(imgUrl);
        }

        listings.push({
          id: slug,
          title: this.humanizeSlug(slug),
          price: priceStr,
          priceNumeric,
          currency,
          url: `${PRODUCT_URL}${slug}`,
          images: images.length > 0 ? images : undefined,
          marketplace: this.name,
          scrapedAt: new Date().toISOString(),
        });
      }

      return {
        marketplace: this.name,
        success: true,
        listings,
        totalFound: data.meta?.resultCount ?? listings.length,
      };
    } catch (error) {
      return this.createError(`Depop search failed: ${error}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async getListingDetails(slug: string): Promise<ListingDetails> {
    let page;
    try {
      page = await newPage();

      // Navigate to product page — JSON-LD has description + images
      await page.goto(`${PRODUCT_URL}${slug}/`, { waitUntil: 'networkidle2', timeout: 30000 });

      // Extract JSON-LD structured data (description, images, price, condition)
      const jsonLd: any = await page.evaluate(`
        (() => {
          const el = document.querySelector('script[type="application/ld+json"]');
          if (!el) return null;
          try { return JSON.parse(el.textContent || ''); } catch { return null; }
        })()
      `);

      // Call extended API for seller/shipping details
      const extended: any = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url);
          if (res.ok) return await res.json();
          return null;
        } catch { return null; }
      }, `${EXTENDED_API}${slug}/extended/?lang=en&force_fee_calculation=true`);

      // Extract seller username from meta description ("... - Sold by @username")
      const seller: string | undefined = await page.evaluate(`
        (() => {
          const meta = document.querySelector('meta[name="description"]');
          const content = meta ? meta.getAttribute('content') || '' : '';
          const match = content.match(/Sold by @(\\w+)/);
          return match ? match[1] : undefined;
        })()
      `) as string | undefined;

      const images: string[] = jsonLd?.image || [];
      const hasShipping = extended?.pricing?.national_shipping_cost != null
        || extended?.has_free_shipping === true;

      return {
        id: slug,
        description: jsonLd?.description ?? undefined,
        images,
        seller,
        isShippingOffered: hasShipping,
        url: `${PRODUCT_URL}${slug}`,
      };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.search({ query: 'test', limit: 1 });
      return result.success;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private humanizeSlug(slug: string): string {
    const parts = slug.split('-');
    if (parts.length <= 2) return slug.replace(/-/g, ' ');
    // Remove first part (username) and last part (random suffix)
    const titleParts = parts.slice(1, -1);
    return titleParts
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
