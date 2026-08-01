/**
 * Depop Marketplace implementation
 *
 * Depop's public JSON API (webapi.depop.com) now returns 403 to server-side
 * requests, so we scrape Depop's server-rendered search results page instead.
 * A headless browser (through a residential proxy, with IP rotation on block)
 * loads the page; results are extracted from the rendered DOM.
 *
 * Selectors intentionally key off stable things — the /products/<slug> href,
 * the <img>, and a price regex — NOT Depop's hashed CSS-module class names,
 * which change on every deploy.
 */

import { BaseMarketplace } from './base.js';
import { SearchParams, SearchResult, Listing, ListingDetails } from '../types.js';
import { newPage, rotateBrowser, withBrowserLock } from '../browser.js';
import { Page } from 'puppeteer-core';

const MAX_RETRIES = 8;
const NAV_TIMEOUT = 20000;

const SEARCH_PAGE = 'https://www.depop.com/search/';
const PRODUCT_URL = 'https://www.depop.com/products/';

export class DepopMarketplace extends BaseMarketplace {
  readonly name = 'depop';
  readonly displayName = 'Depop';
  readonly requiresAuth = false;

  /**
   * Navigate to a Depop URL with automatic IP rotation on proxy-auth (407),
   * Cloudflare challenge, or timeout. Each retry restarts the browser with a
   * new session ID → a different residential IP from the pool.
   */
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

      console.log(`[depop] Attempt ${attempt + 1}/${MAX_RETRIES}: blocked (${lastError}). Rotating IP...`);
      if (page) await page.close().catch(() => {});
    }

    throw new Error(`All ${MAX_RETRIES} proxy attempts failed. Last: ${lastError}`);
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, maxPrice, minPrice, limit = 24, sort } = params;

    return withBrowserLock(async () => {
      let page: Page | undefined;
      try {
        const url = new URL(SEARCH_PAGE);
        url.searchParams.set('q', query);

        page = await this.navigateWithRetry(url.toString());
        // SSR content is in the initial HTML, but wait briefly in case of hydration.
        await page.waitForSelector('a[href*="/products/"]', { timeout: 8000 }).catch(() => {});

        const raw: Array<{ slug: string; label: string; img: string; prices: string[] }> =
          await page.evaluate(() => {
            const seen = new Set<string>();
            const out: any[] = [];
            document.querySelectorAll('a[href*="/products/"]').forEach((a) => {
              const href = a.getAttribute('href') || '';
              const m = href.match(/\/products\/([^/?#]+)/);
              if (!m) return;
              const slug = m[1];
              if (seen.has(slug)) return;
              seen.add(slug);
              const card = (a as HTMLElement).closest('li') || a.parentElement;
              const img = a.querySelector('img') || (card && card.querySelector('img'));
              const txt = ((card && (card as HTMLElement).innerText) || '').replace(/\s+/g, ' ').trim();
              const prices = txt.match(/[£$€]\s?\d[\d.,]*/g) || [];
              out.push({
                slug,
                label: a.getAttribute('aria-label') || (img && img.getAttribute('alt')) || '',
                img: (img && (img.getAttribute('src') || (img.getAttribute('srcset') || '').split(' ')[0])) || '',
                prices,
              });
            });
            return out;
          });

        let listings: Listing[] = raw.map((r) => {
          // Current price is the last money match ("was £X now £Y" → Y).
          const priceStr = r.prices.length ? r.prices[r.prices.length - 1].replace(/\s/g, '') : 'Price not listed';
          const parsed = this.parsePrice(priceStr);
          return {
            id: r.slug,
            title: this.humanizeSlug(r.slug),
            price: priceStr,
            priceNumeric: parsed?.numeric,
            currency: parsed?.currency || '$',
            url: `${PRODUCT_URL}${r.slug}`,
            images: r.img ? [r.img] : undefined,
            marketplace: this.name,
            scrapedAt: new Date().toISOString(),
          };
        });

        // Depop's search page isn't price-filtered/sortable via URL reliably, so
        // apply price bounds and price sort client-side over the rendered page.
        if (minPrice != null) listings = listings.filter((l) => l.priceNumeric == null || l.priceNumeric >= minPrice);
        if (maxPrice != null) listings = listings.filter((l) => l.priceNumeric == null || l.priceNumeric <= maxPrice);
        if (sort === 'price_low_to_high') listings.sort((a, b) => (a.priceNumeric ?? Infinity) - (b.priceNumeric ?? Infinity));
        if (sort === 'price_high_to_low') listings.sort((a, b) => (b.priceNumeric ?? -Infinity) - (a.priceNumeric ?? -Infinity));

        listings = listings.slice(0, limit);

        return {
          marketplace: this.name,
          success: true,
          listings,
          totalFound: listings.length,
          ...(listings.length === 0 && {
            note: 'No Depop listings parsed. The page may have been blocked or its markup changed.',
          }),
        };
      } catch (error) {
        return this.createError(`Depop search failed: ${error}`);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    });
  }

  async getListingDetails(slug: string): Promise<ListingDetails> {
    return withBrowserLock(async () => {
      let page: Page | undefined;
      try {
        page = await this.navigateWithRetry(`${PRODUCT_URL}${slug}/`);

        const data: { description?: string; images: string[]; seller?: string } = await page.evaluate(() => {
          const meta = (sel: string) =>
            (document.querySelector(sel) as HTMLMetaElement | null)?.content || undefined;

          // Product images: og:image tags carry the full-size photos.
          const images: string[] = [];
          document.querySelectorAll('meta[property="og:image"]').forEach((m) => {
            const c = (m as HTMLMetaElement).content;
            if (c && !images.includes(c)) images.push(c);
          });
          if (images.length === 0) {
            document.querySelectorAll('img[src*="media-photos.depop.com"]').forEach((im) => {
              const s = im.getAttribute('src');
              if (s && !images.includes(s)) images.push(s);
            });
          }

          let description = meta('meta[name="description"]') || meta('meta[property="og:description"]');

          // JSON-LD Product schema, if present, is the richest source.
          let seller: string | undefined;
          document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
            try {
              const j = JSON.parse(s.textContent || '');
              const node = Array.isArray(j) ? j.find((x) => x['@type'] === 'Product') : j;
              if (node && node['@type'] === 'Product') {
                if (node.description) description = node.description;
                if (node.brand?.name) seller = node.brand.name;
              }
            } catch { /* ignore */ }
          });

          return { description, images, seller };
        });

        return {
          id: slug,
          description: data.description,
          images: data.images,
          seller: data.seller ?? slug.split('-')[0],
          isShippingOffered: true,
          url: `${PRODUCT_URL}${slug}`,
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

  private humanizeSlug(slug: string): string {
    const parts = slug.split('-');
    if (parts.length <= 2) return slug.replace(/-/g, ' ');
    // Drop the leading username and the trailing random suffix.
    const titleParts = parts.slice(1, -1);
    return titleParts
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
