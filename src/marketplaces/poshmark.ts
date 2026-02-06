/**
 * Poshmark Marketplace implementation
 *
 * Uses a headless browser to bypass anti-scraping measures,
 * then intercepts Poshmark's internal API responses for clean JSON data.
 * Falls back to DOM extraction if API interception fails.
 * No authentication required for public search.
 */

import { BaseMarketplace } from './base';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types';
import { newPage } from '../browser';
import type { Page } from 'puppeteer-core';

const POSHMARK_BASE = 'https://poshmark.com';
const SEARCH_URL = `${POSHMARK_BASE}/search`;
const LISTING_URL = `${POSHMARK_BASE}/listing/`;

// Poshmark's internal REST API path fragment for response interception
const VM_REST_PATTERN = '/vm-rest/';

// Map SearchParams condition values to Poshmark's condition identifiers
const CONDITION_MAP: Record<string, string> = {
  new: 'nwt',        // New With Tags
  like_new: 'nwot',  // New Without Tags
  good: 'good',
  fair: 'fair',
};

// Map SearchParams sort values to Poshmark URL sort_by values
const SORT_MAP: Record<string, string> = {
  relevance: 'relevance',
  newest: 'added_desc',
  price_low_to_high: 'price_asc',
  price_high_to_low: 'price_desc',
  most_popular: 'like_count',
};

export class PoshmarkMarketplace extends BaseMarketplace {
  readonly name = 'poshmark';
  readonly displayName = 'Poshmark';
  readonly requiresAuth = false;

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, limit = 48, sort, condition, sizes, colors } = params;

    let page: Page | undefined;
    try {
      page = await newPage();

      // Prepare to intercept vm-rest API responses
      let apiData: any = null;
      page.on('response', async (response) => {
        try {
          const url = response.url();
          if (url.includes(VM_REST_PATTERN) && response.status() === 200) {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('application/json')) {
              apiData = await response.json();
            }
          }
        } catch { /* ignore parse failures */ }
      });

      // Build search URL with filters
      const searchUrl = this.buildSearchUrl(query, {
        sort, condition, minPrice, maxPrice, sizes, colors,
      });

      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Small buffer for late API responses
      if (!apiData) {
        await new Promise(r => setTimeout(r, 2000));
      }

      // Strategy 1: Parse intercepted API data
      if (apiData?.data && Array.isArray(apiData.data)) {
        return this.parseApiResponse(apiData, limit);
      }

      // Strategy 2: Fall back to DOM extraction
      return await this.parseDomResults(page, limit);

    } catch (error) {
      return this.createError(`Poshmark search failed: ${error}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    let page: Page | undefined;
    try {
      page = await newPage();
      await page.goto(`${LISTING_URL}${listingId}`, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Extract JSON-LD structured data (Product schema)
      const jsonLd: any = await page.evaluate(`
        (() => {
          const el = document.querySelector('script[type="application/ld+json"]');
          if (!el) return null;
          try { return JSON.parse(el.textContent || ''); } catch { return null; }
        })()
      `);

      // Extract additional details from DOM
      const domData: any = await page.evaluate(`
        (() => {
          const descEl = document.querySelector('[data-test="listing-description"]')
            || document.querySelector('.listing__description');
          const description = descEl ? descEl.textContent.trim() : undefined;

          const images = [];
          document.querySelectorAll('[data-test="listing-image"] img, .listing__slideshow img, .slideshow img').forEach(function(img) {
            const src = img.getAttribute('src');
            if (src && !src.includes('placeholder')) images.push(src);
          });

          const sellerEl = document.querySelector('[data-test="listing-seller-name"]')
            || document.querySelector('.listing__seller-name')
            || document.querySelector('.closet-header__name a');
          const seller = sellerEl ? sellerEl.textContent.trim() : undefined;

          return { description: description, images: images, seller: seller };
        })()
      `);

      // Merge JSON-LD and DOM data
      const images: string[] = jsonLd?.image
        ? (Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image])
        : domData.images || [];

      return {
        id: listingId,
        description: jsonLd?.description ?? domData.description ?? undefined,
        images,
        seller: domData.seller ?? undefined,
        isShippingOffered: true, // Poshmark always includes shipping
        url: `${LISTING_URL}${listingId}`,
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

  private buildSearchUrl(query: string, filters: {
    sort?: string; condition?: string; minPrice?: number;
    maxPrice?: number; sizes?: string[]; colors?: string[];
  }): string {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', query);
    url.searchParams.set('type', 'listings');
    url.searchParams.set('src', 'dir');

    if (filters.sort) {
      const poshSort = SORT_MAP[filters.sort];
      if (poshSort) url.searchParams.set('sort_by', poshSort);
    }

    if (filters.condition && filters.condition !== 'any') {
      const poshCondition = CONDITION_MAP[filters.condition];
      if (poshCondition) url.searchParams.set('condition', poshCondition);
    }

    if (filters.minPrice != null || filters.maxPrice != null) {
      const min = filters.minPrice ?? 0;
      const max = filters.maxPrice ?? '';
      url.searchParams.append('price[]', `${min}-${max}`);
    }

    if (filters.sizes) {
      for (const s of filters.sizes) url.searchParams.append('size[]', s);
    }
    if (filters.colors) {
      for (const c of filters.colors) url.searchParams.append('color[]', c);
    }

    return url.toString();
  }

  private parseApiResponse(apiData: any, limit: number): SearchResult {
    const items: any[] = apiData.data || [];
    const listings: Listing[] = [];

    for (const item of items) {
      if (listings.length >= limit) break;
      try {
        const id = item.id || item.post_id;
        if (!id) continue;

        const priceAmount = item.price_amount?.val
          ?? item.original_price_amount?.val
          ?? item.price;
        const priceStr = priceAmount != null ? `$${priceAmount}` : 'Price not listed';
        const priceNumeric = priceAmount != null ? parseFloat(String(priceAmount)) : undefined;

        const images: string[] = [];
        if (item.picture_url) images.push(item.picture_url);
        if (Array.isArray(item.pictures)) {
          for (const pic of item.pictures) {
            const picUrl = typeof pic === 'string' ? pic : pic?.url;
            if (picUrl && !images.includes(picUrl)) images.push(picUrl);
          }
        }

        listings.push({
          id: String(id),
          title: item.title || 'Untitled Listing',
          price: priceStr,
          priceNumeric,
          currency: '$',
          url: `${LISTING_URL}${item.title_slug || id}`,
          images: images.length > 0 ? images : undefined,
          seller: item.creator_username,
          condition: item.condition,
          marketplace: this.name,
          scrapedAt: new Date().toISOString(),
        });
      } catch {
        continue;
      }
    }

    return {
      marketplace: this.name,
      success: true,
      listings,
      totalFound: apiData.total_count ?? listings.length,
    };
  }

  private async parseDomResults(page: Page, limit: number): Promise<SearchResult> {
    // Wait for listing cards to render
    try {
      await page.waitForSelector('.card', { timeout: 10000 });
    } catch {
      return this.createError('Poshmark: No listings found or page failed to load');
    }

    const rawListings = await page.evaluate(`
      (() => {
        var cards = document.querySelectorAll('.card');
        var results = [];

        cards.forEach(function(card) {
          try {
            // Covershot link has the listing href and image
            var covershot = card.querySelector('a.tile__covershot');
            if (!covershot) return;
            var href = covershot.getAttribute('href') || '';
            if (href.indexOf('/listing/') === -1) return;

            // Image from picture > img
            var imgEl = covershot.querySelector('img');
            var imgSrc = imgEl ? (imgEl.getAttribute('src') || '') : '';
            var imgAlt = imgEl ? (imgEl.getAttribute('alt') || '') : '';

            // Title from .tile__title link
            var titleEl = card.querySelector('a.tile__title');
            var title = titleEl ? titleEl.textContent.trim() : imgAlt;

            // Price from .fw--bold span
            var priceEl = card.querySelector('.fw--bold');
            var price = priceEl ? priceEl.textContent.trim() : '';

            // Size from .tile__details__pipe__size
            var sizeEl = card.querySelector('.tile__details__pipe__size');
            var size = sizeEl ? sizeEl.textContent.trim() : '';

            // Brand from .tile__details__pipe__brand
            var brandEl = card.querySelector('.tile__details__pipe__brand');
            var brand = brandEl ? brandEl.textContent.trim() : '';

            // Seller from data attribute on covershot link
            var listerId = covershot.getAttribute('data-et-prop-lister_id') || '';

            results.push({
              href: href,
              title: title,
              price: price,
              imgSrc: imgSrc,
              brand: brand,
              size: size,
              seller: ''
            });
          } catch(e) { /* skip */ }
        });
        return results;
      })()
    `);

    const listings: Listing[] = [];
    for (const raw of (rawListings as any[])) {
      if (listings.length >= limit) break;
      if (!raw.href || !raw.href.includes('/listing/')) continue;

      // Extract listing slug from URL: /listing/Title-Slug-hexid
      const slug = raw.href.replace(/^.*\/listing\//, '').replace(/\/$/, '');
      if (!slug) continue;

      const parsed = this.parsePrice(raw.price);

      // Build title from available data
      let title = raw.title;
      if (!title && raw.brand) {
        title = [raw.brand, raw.size].filter(Boolean).join(' - ');
      }
      if (!title) {
        title = this.humanizeSlug(slug);
      }

      listings.push({
        id: slug,
        title,
        price: raw.price || 'Price not listed',
        priceNumeric: parsed?.numeric,
        currency: parsed?.currency || '$',
        url: `${POSHMARK_BASE}${raw.href.startsWith('/') ? '' : '/'}${raw.href}`,
        images: raw.imgSrc ? [raw.imgSrc] : undefined,
        seller: raw.seller || undefined,
        marketplace: this.name,
        scrapedAt: new Date().toISOString(),
      });
    }

    return {
      marketplace: this.name,
      success: true,
      listings,
      totalFound: listings.length,
    };
  }

  private humanizeSlug(slug: string): string {
    const parts = slug.split('-');
    // Remove trailing hex ID if present (Poshmark uses 24-char hex IDs)
    if (parts.length > 1 && /^[a-f0-9]{24}$/i.test(parts[parts.length - 1])) {
      parts.pop();
    }
    return parts
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
