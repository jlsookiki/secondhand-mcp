/**
 * Poshmark Marketplace implementation
 *
 * Scrapes Poshmark's server-rendered search results. The previous scraper
 * waited for `.card` elements which no longer exist in Poshmark's markup;
 * results now render as `/listing/<slug>` tiles. Selectors key off the stable
 * /listing/ href, the <img>, and a price regex rather than styled class names.
 * No authentication required for public search.
 */

import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types.js';
import { newPage, rotateBrowser, withBrowserLock } from '../browser.js';
import type { Page } from 'puppeteer-core';

const MAX_RETRIES = 8;
const NAV_TIMEOUT = 20000;

const POSHMARK_BASE = 'https://poshmark.com';
const SEARCH_URL = `${POSHMARK_BASE}/search`;
const LISTING_URL = `${POSHMARK_BASE}/listing/`;

const CONDITION_MAP: Record<string, string> = {
  new: 'nwt',
  like_new: 'nwot',
  good: 'good',
  fair: 'fair',
};

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

  private async navigateWithRetry(url: string): Promise<Page> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) await rotateBrowser();

      let page: Page | undefined;
      try {
        page = await newPage();
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        const status = resp?.status() ?? 0;
        const title = await page.title();

        if (status === 200 && !title.includes('Just a moment') && !title.includes('Forbidden')) {
          return page;
        }
        lastError = `status=${status}, title="${title}"`;
      } catch (err: any) {
        lastError = err.message || String(err);
      }

      console.log(`[poshmark] Attempt ${attempt + 1}/${MAX_RETRIES}: blocked (${lastError}). Rotating IP...`);
      if (page) await page.close().catch(() => {});
    }

    throw new Error(`All ${MAX_RETRIES} proxy attempts failed. Last: ${lastError}`);
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, limit = 48, sort, condition, category, brand, department, sizes, colors } = params;

    return withBrowserLock(async () => {
      let page: Page | undefined;
      try {
        const searchUrl = this.buildSearchUrl(query, {
          sort, condition, minPrice, maxPrice, category, brand, department, sizes, colors,
        });

        page = await this.navigateWithRetry(searchUrl);
        await page.waitForSelector('a[href*="/listing/"]', { timeout: 8000 }).catch(() => {});

        const raw: Array<{ id: string; slug: string; title: string; img: string; prices: string[] }> =
          await page.evaluate(() => {
            const seen = new Set<string>();
            const out: any[] = [];
            document.querySelectorAll('a[href*="/listing/"]').forEach((a) => {
              const href = a.getAttribute('href') || '';
              const m = href.match(/\/listing\/([^/?#]+)/);
              if (!m) return;
              const slug = m[1];
              const idm = slug.match(/([a-f0-9]{24})$/i);
              const id = idm ? idm[1] : slug;
              if (seen.has(id)) return;
              seen.add(id);

              // Climb to the nearest ancestor whose text includes a price.
              let box: HTMLElement | null = a as HTMLElement;
              let hops = 0;
              while (box && hops < 5 && !/[$]\s?\d/.test(box.innerText || '')) {
                box = box.parentElement;
                hops++;
              }
              const txt = ((box && box.innerText) || '').replace(/\s+/g, ' ').trim();
              const img = a.querySelector('img') || (box && box.querySelector('img'));
              out.push({
                id,
                slug,
                title: (img && img.getAttribute('alt')) || '',
                img: (img && img.getAttribute('src')) || '',
                prices: (txt.match(/[$]\s?\d[\d.,]*/g) || []).slice(0, 3),
              });
            });
            return out;
          });

        let listings: Listing[] = raw.map((r) => {
          // Poshmark shows "<current> <original>"; the first match is the current price.
          const priceStr = r.prices.length ? r.prices[0].replace(/\s/g, '') : 'Price not listed';
          const parsed = this.parsePrice(priceStr);
          return {
            id: r.id,
            title: r.title || this.humanizeSlug(r.slug),
            price: priceStr,
            priceNumeric: parsed?.numeric,
            currency: parsed?.currency || '$',
            url: `${LISTING_URL}${r.slug}`,
            images: r.img ? [r.img] : undefined,
            marketplace: this.name,
            scrapedAt: new Date().toISOString(),
          };
        });

        // Price bounds enforced client-side (URL price filter is unreliable).
        if (minPrice != null) listings = listings.filter((l) => l.priceNumeric == null || l.priceNumeric >= minPrice);
        if (maxPrice != null) listings = listings.filter((l) => l.priceNumeric == null || l.priceNumeric <= maxPrice);

        listings = listings.slice(0, limit);

        return {
          marketplace: this.name,
          success: true,
          listings,
          totalFound: listings.length,
          ...(listings.length === 0 && {
            note: 'No Poshmark listings parsed. The page may have been blocked or its markup changed.',
          }),
        };
      } catch (error) {
        return this.createError(`Poshmark search failed: ${error}`);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    });
  }

  async getListingDetails(listingId: string): Promise<ListingDetails> {
    return withBrowserLock(async () => {
      let page: Page | undefined;
      try {
        page = await this.navigateWithRetry(`${LISTING_URL}${listingId}`);

        const data: { description?: string; images: string[]; seller?: string } = await page.evaluate(() => {
          let description: string | undefined;
          const images: string[] = [];
          let seller: string | undefined;

          // JSON-LD Product schema is the cleanest source when present.
          document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
            try {
              const j = JSON.parse(s.textContent || '');
              const node = Array.isArray(j) ? j.find((x) => x['@type'] === 'Product') : j;
              if (node && node['@type'] === 'Product') {
                if (node.description) description = node.description;
                const imgs = node.image ? (Array.isArray(node.image) ? node.image : [node.image]) : [];
                for (const im of imgs) if (im && !images.includes(im)) images.push(im);
              }
            } catch { /* ignore */ }
          });

          // og:image fallback / supplement.
          document.querySelectorAll('meta[property="og:image"]').forEach((m) => {
            const c = (m as HTMLMetaElement).content;
            if (c && !images.includes(c)) images.push(c);
          });
          // Cloudfront post images in the DOM as a last resort.
          if (images.length === 0) {
            document.querySelectorAll('img[src*="cloudfront.net/posts"]').forEach((im) => {
              const s = im.getAttribute('src');
              if (s && !images.includes(s)) images.push(s);
            });
          }

          if (!description) {
            description = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || undefined;
          }

          const sellerEl = document.querySelector('a[href^="/closet/"]');
          if (sellerEl) seller = sellerEl.textContent?.trim() || sellerEl.getAttribute('href')?.replace('/closet/', '');

          return { description, images, seller };
        });

        return {
          id: listingId,
          description: data.description,
          images: data.images,
          seller: data.seller,
          isShippingOffered: true,
          url: `${LISTING_URL}${listingId}`,
        };
      } finally {
        if (page) await page.close().catch(() => {});
      }
    });
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
    maxPrice?: number; category?: string; brand?: string;
    department?: string; sizes?: string[]; colors?: string[];
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
    if (filters.department) url.searchParams.set('department', filters.department);
    if (filters.brand) url.searchParams.append('brand[]', filters.brand);
    if (filters.category) url.searchParams.set('category_v2', filters.category);
    if (filters.sizes) for (const s of filters.sizes) url.searchParams.append('size[]', s);
    if (filters.colors) for (const c of filters.colors) url.searchParams.append('color[]', c);

    return url.toString();
  }

  private humanizeSlug(slug: string): string {
    const parts = slug.split('-');
    if (parts.length > 1 && /^[a-f0-9]{24}$/i.test(parts[parts.length - 1])) {
      parts.pop();
    }
    return parts
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
