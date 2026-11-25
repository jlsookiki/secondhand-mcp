/**
 * eBay Marketplace implementation
 *
 * Uses eBay's official Browse API for searching and retrieving listings.
 * Requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.
 * Docs: https://developer.ebay.com/api-docs/buy/browse/overview.html
 */

import { BaseMarketplace } from '../base.js';
import { SearchParams, SearchResult, Listing, ListingDetails, OptionFilter } from '../../types.js';
import { EbayToken } from './auth.js';
import { marketplaceCurrency } from './currency.js';
import { searchFilter } from './filters.js';
import { answersFromGroup, groupPath, listsAllOptions, lookupPath, parseEbayItemRef } from './items.js';
import { groupDetails, itemDetails, summaryListing } from './parse.js';
import { BrowseErrorResponse, Item, ItemGroupResponse, ItemSummary, SearchResponse } from './wire.js';

export { currencySymbol } from './currency.js';
export { resizeEbayImageUrl } from './images.js';

const BROWSE_API_URL = 'https://api.ebay.com/buy/browse/v1';

// eBay Browse API pagination limits: max 200 items per request, and
// offset + limit may not exceed 10,000.
const EBAY_PAGE_SIZE = 200;
const EBAY_MAX_OFFSET = 10_000;

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

  readonly marketplaceId: string;
  private readonly token: EbayToken | undefined;

  constructor(credentials?: EbayCredentials) {
    super();
    const clientId = credentials?.clientId ?? process.env.EBAY_CLIENT_ID;
    const clientSecret = credentials?.clientSecret ?? process.env.EBAY_CLIENT_SECRET;
    this.token = clientId && clientSecret ? new EbayToken(clientId, clientSecret) : undefined;
    this.marketplaceId = credentials?.marketplaceId ?? process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US';
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, limit = 20, offset = 0 } = params;

    if (!this.token) {
      return this.createError(
        'eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.'
      );
    }

    try {
      const token = await this.token.get();
      const filter = searchFilter(params, marketplaceCurrency(this.marketplaceId));

      // eBay's Browse API returns at most 200 items per request and caps
      // offset + limit at 10,000, so fetch successive pages until we've
      // collected `limit` listings (or run out of results).
      const target = Math.max(0, limit);
      const listings: Listing[] = [];
      let total = 0;
      let currentOffset = Math.max(0, offset);

      while (listings.length < target && currentOffset < EBAY_MAX_OFFSET) {
        const pageLimit = Math.min(target - listings.length, EBAY_PAGE_SIZE, EBAY_MAX_OFFSET - currentOffset);
        if (pageLimit <= 0) break;

        const response = await this.browse(`/item_summary/search?${pageQuery(query, pageLimit, currentOffset, filter)}`, token);

        if (!response.ok) {
          // If earlier pages succeeded, return what we have rather than failing.
          if (listings.length > 0) break;
          return this.createError(await searchFailure(response));
        }

        const data = (await response.json()) as SearchResponse;
        total = data.total ?? total;
        const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
        if (items.length === 0) break;

        collectListings(items, target, listings);
        currentOffset += items.length;

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

  /** `optionFilter` narrows a multi-variation listing to the options named; single items ignore it. */
  async getListingDetails(itemId: string, optionFilter?: OptionFilter): Promise<ListingDetails> {
    if (!this.token) {
      throw new Error('eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET environment variables.');
    }
    const token = await this.token.get();
    const ref = parseEbayItemRef(itemId);
    const reply = await this.read(lookupPath(ref), token);

    if (reply.ok) {
      const item = reply.body as Item;
      if (listsAllOptions(ref, item)) {
        // The option already answered, so a listing that cannot be read only loses the other options.
        const groupId = item.primaryItemGroup?.itemGroupId ?? ref.legacyId;
        const withOptions = await this.group(groupId, token, optionFilter, item).catch(() => undefined);
        if (withOptions) return withOptions;
      }
      return itemDetails(item);
    }

    if (ref.kind === 'opaque' || !answersFromGroup(ref, reply.errorIds)) throw lookupError(reply);
    return this.group(ref.legacyId, token, optionFilter);
  }

  private async group(groupId: string, token: string, filter?: OptionFilter, chosen?: Item): Promise<ListingDetails> {
    const reply = await this.read(groupPath(groupId), token);
    if (!reply.ok) throw lookupError(reply);
    const group = reply.body as ItemGroupResponse | null;
    if (!Array.isArray(group?.items) || group.items.length === 0) throw lookupError(reply);
    return groupDetails(group, { groupId, filter, chosen });
  }

  /** A Browse reply whose error ids say why a lookup failed; a body that is not JSON reads as none. */
  private async read(path: string, token: string): Promise<BrowseReply> {
    const response = await this.browse(path, token);
    const text = await response.text();
    const body = parseJson(text);
    if (response.ok && body === null) throw new Error('eBay API returned a body that is not JSON');
    return { ok: response.ok, status: response.status, body, errorIds: errorIds(body) };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.token) return false;
    try {
      await this.token.get();
      return true;
    } catch {
      return false;
    }
  }

  private browse(path: string, token: string): Promise<Response> {
    return fetch(`${BROWSE_API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
      },
    });
  }
}

interface BrowseReply {
  ok: boolean;
  status: number;
  body: unknown;
  errorIds: number[];
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorIds(body: unknown): number[] {
  const errors = (body as BrowseErrorResponse | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => Number(error?.errorId)).filter(Number.isFinite);
}

function lookupError(reply: BrowseReply): Error {
  const ids = reply.errorIds.length > 0 ? ` (${reply.errorIds.join(', ')})` : '';
  return new Error(`eBay API returned ${reply.status}${ids}`);
}

function pageQuery(query: string, limit: number, offset: number, filter: string | undefined): string {
  const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
  if (filter) params.set('filter', filter);
  return params.toString();
}

async function searchFailure(response: Response): Promise<string> {
  const body = await response.text();
  const hint =
    response.status === 401 || response.status === 403 ? '. Check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.' : '';
  return `eBay API returned ${response.status}: ${body}${hint}`;
}

function collectListings(items: ItemSummary[], target: number, listings: Listing[]): void {
  for (const item of items) {
    if (listings.length >= target) break;
    try {
      listings.push(summaryListing(item));
    } catch {
      continue;
    }
  }
}
