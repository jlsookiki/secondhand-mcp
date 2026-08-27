#!/usr/bin/env node

/**
 * Secondhand MCP Server
 * 
 * An MCP server for searching secondary marketplaces like
 * Facebook Marketplace, eBay, Craigslist, and more.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { SearchParams, SearchResult, Listing, ListingDetails } from './types.js';
import {
  initializeMarketplaces,
  getMarketplace,
  getAllMarketplaces,
  listMarketplaceNames,
  resizeEbayImageUrl,
} from './marketplaces/index.js';

// Initialize marketplaces
initializeMarketplaces();

const { version: VERSION } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

// Image handling shared by get_listing_details.
const IMAGE_SIZE_PX = { thumb: 400, standard: 800, full: 1600 } as const;
// A real browser UA + Referer — eBay's CDN serves placeholder/blocked responses
// to bare server-side fetches, which is why inline base64 came back blank.
const IMAGE_FETCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Magic-byte sniff so we never base64 an HTML error page or 1x1 placeholder as an image. */
function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true; // WEBP (RIFF....WEBP)
  return false;
}

// Define available tools
const tools: Tool[] = [
  {
    name: 'search_marketplace',
    description: `Search for items on secondary marketplaces. Supports: ${listMarketplaceNames().join(', ')}. Returns listing ID, title, price, location, and photo count. Facebook: location-based search, no auth. eBay: keyword search with condition filter, requires API keys. Depop: keyword search with filters for sort, condition, category, brands, sizes, colors (requires Chrome). Poshmark: keyword search with filters for sort, condition, sizes, colors (requires Chrome). Use get_listing_details with a listing ID for full description, all photos, seller info, and shipping options.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "stroller", "iPhone 14", "vintage couch")'
        },
        marketplace: {
          type: 'string',
          description: `Marketplace to search. Options: ${listMarketplaceNames().join(', ')}, or "all" to search all marketplaces`,
          default: 'facebook'
        },
        location: {
          type: 'string',
          description: 'City and state for Facebook Marketplace searches, as "City, ST" — e.g. "Austin, TX", "Portland, OR". Resolve neighborhoods, ZIP codes, metro areas and "near me" to a city and state before calling; a bare city name is ambiguous and may return the wrong state. Non-US: pass city and country. Facebook only — other marketplaces ignore it.',
          default: 'san francisco'
        },
        maxPrice: {
          type: 'number',
          description: 'Maximum price filter (optional)'
        },
        minPrice: {
          type: 'number',
          description: 'Minimum price filter (optional)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20). eBay paginates automatically to fetch more than 200 (eBay caps offset + limit at 10,000).',
          default: 20
        },
        offset: {
          type: 'number',
          description: 'Starting result offset for pagination (default: 0). eBay only; other marketplaces ignore it.',
          default: 0
        },
        showSold: {
          type: 'boolean',
          description: 'Include sold/unavailable items in results (default: false)',
          default: false
        },
        includeImages: {
          type: 'boolean',
          description: 'Include full image URLs in results (default: false). Use get_listing_details for full photos.',
          default: false
        },
        sort: {
          type: 'string',
          description: 'Sort order (Depop, Poshmark). Options: relevance, newest, most_popular, price_low_to_high, price_high_to_low',
          default: 'relevance'
        },
        condition: {
          type: 'string',
          description: 'Item condition filter. eBay: new, like_new, good, fair. Depop: new, like_new, excellent, good, fair, used. Poshmark: new (NWT), like_new (NWOT), good, fair. Use "any" for no filter.',
        },
        category: {
          type: 'string',
          description: 'Product category. Depop: tops, bottoms, dresses, coats-jackets, footwear, accessories, bags, jewellery, activewear, swimwear. Poshmark: use underscore-separated names like Jackets_&_Coats, Dresses, Shoes, Accessories, etc.',
        },
        brand: {
          type: 'string',
          description: 'Filter by brand (Poshmark only). e.g. "Nike", "Levi\'s", "Gucci"',
        },
        department: {
          type: 'string',
          description: 'Filter by department (Poshmark only). Options: Women, Men, Kids',
        },
        sizes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by sizes (Depop, Poshmark). Example: ["S", "M", "L"] or ["US 9", "US 10"]',
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by colors (Depop, Poshmark). Options: black, white, red, blue, green, yellow, orange, pink, purple, brown, grey, cream, multi, silver, gold',
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_listing_details',
    description: 'Get full details for a specific listing using an ID from search results: description, all photos, location, seller info, and shipping. Photos: by default (imageMode:"urls") you get direct full-resolution CDN image URLs to fetch yourself — most reliable, since some CDNs block server-side fetches. Set imageMode:"inline" (or includeImages:true) to have the server fetch the photos and return them as base64 image blocks inline. Use imageSize to trade resolution for payload and maxImages to cap the count.',
    inputSchema: {
      type: 'object',
      properties: {
        listingId: {
          type: 'string',
          description: 'The listing ID (from search results or a marketplace URL)'
        },
        marketplace: {
          type: 'string',
          description: 'Which marketplace the listing is from (default: facebook)',
          default: 'facebook'
        },
        imageMode: {
          type: 'string',
          enum: ['urls', 'inline'],
          description: 'How photos are returned. "urls" (default): direct full-resolution CDN image URLs for you to fetch yourself — most reliable, bypasses CDN blocking of server-side fetches, defaults to full resolution. "inline": server fetches every photo and returns them as base64 image blocks in this one call; if the server fetch is blocked it automatically falls back to returning the URLs.',
          default: 'urls'
        },
        includeImages: {
          type: 'boolean',
          description: 'Deprecated alias for imageMode:"inline". If true and imageMode is unset, photos are fetched server-side and returned inline as base64.',
          default: false
        },
        imageSize: {
          type: 'string',
          enum: ['thumb', 'standard', 'full'],
          description: 'Resolution for eBay images: thumb (~400px), standard (~800px), full (~1600px). Defaults to full for imageMode "urls" and standard for "inline". Non-eBay images are returned as-is.',
        },
        maxImages: {
          type: 'number',
          description: 'Cap the number of photos returned (default: all). Use to keep the response small for listings with many photos.'
        }
      },
      required: ['listingId']
    }
  },
  {
    name: 'list_marketplaces',
    description: 'List all available marketplaces and their status',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // `search` and `fetch` follow the ChatGPT Deep Research tool contract:
  // exact names, a single string argument each, JSON result shapes
  // { results: [{ id, title, text, url }] } and { id, title, text, url, metadata }.
  // https://developers.openai.com/api/docs/guides/deep-research
  {
    name: 'search',
    description: 'Search all available secondhand marketplaces at once (deep research). Returns results whose IDs (marketplace:listingId) can be passed to the fetch tool for full listing details.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch',
    description: 'Fetch full listing details for a result ID returned by the search tool. ID format: marketplace:listingId (e.g., "facebook:12345" or "ebay:v1|123|456").',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Result ID from the search tool (format: marketplace:listingId)'
        }
      },
      required: ['id']
    }
  }
];

// Create server
/** Sent to the client at initialize, alongside the per-tool descriptions. */
const INSTRUCTIONS = `Secondhand MCP searches live listings on Facebook Marketplace, eBay, Depop and Poshmark.

Locations: Facebook Marketplace searches are local, so pass a US city and state as "City, ST" — for example "Austin, TX" or "Portland, OR". Do not pass a bare city name: there are 20 Springfields and several Portlands, and the wrong one returns listings from the wrong state. Before calling, translate whatever the user said into a city and state:
- "near me" or "around here" — use the location they gave you earlier in the conversation; ask if you do not have one.
- a neighborhood, borough or landmark ("Capitol Hill", "the Mission") — use its city and state.
- a ZIP code — use the city and state it belongs to.
- a metro area ("the Bay Area", "DFW") — pick its principal city.
- somewhere outside the US — pass the city and country as written; those resolve differently.

Empty results usually mean the search was too narrow, not that nothing exists. Before telling the user there is nothing available, try the obvious widening: drop qualifiers from the query down to the item itself, remove price bounds, or search the nearest larger city. Say which of these you tried.

Filters are not universal — each parameter says which marketplaces apply it. Where one does not apply it is ignored, so do not describe results as filtered by something that marketplace never applied; put those words in the query instead.

Results are read-only. Nothing here can message a seller, make an offer, or buy anything, so do not tell the user an item has been purchased or reserved.`;

const server = new Server(
  {
    name: 'secondhand-mcp',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: INSTRUCTIONS,
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'search_marketplace': {
      const params = args as {
        query: string;
        marketplace?: string;
        location?: string;
        maxPrice?: number;
        minPrice?: number;
        limit?: number;
        offset?: number;
        showSold?: boolean;
        includeImages?: boolean;
        sort?: string;
        condition?: string;
        category?: string;
        brand?: string;
        department?: string;
        sizes?: string[];
        colors?: string[];
      };

      if (!params.query) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter: query' }],
          isError: true,
        };
      }

      const searchParams: SearchParams = {
        query: params.query,
        location: params.location || 'san francisco',
        maxPrice: params.maxPrice,
        minPrice: params.minPrice,
        limit: params.limit || 20,
        offset: params.offset || 0,
        showSold: params.showSold || false,
        sort: params.sort as SearchParams['sort'],
        condition: params.condition as SearchParams['condition'],
        category: params.category,
        brand: params.brand,
        department: params.department,
        sizes: params.sizes,
        colors: params.colors,
      };

      const marketplaceName = params.marketplace || 'facebook';
      
      if (marketplaceName === 'all') {
        // Search all marketplaces
        const results: SearchResult[] = [];
        for (const mp of getAllMarketplaces()) {
          try {
            const result = await mp.search(searchParams);
            results.push(result);
          } catch (error) {
            results.push({
              marketplace: mp.name,
              success: false,
              listings: [],
              error: String(error)
            });
          }
        }
        
        return {
          content: [
            {
              type: 'text',
              text: formatMultipleResults(results, searchParams, params.includeImages || false)
            }
          ]
        };
      } else {
        // Search specific marketplace
        const marketplace = getMarketplace(marketplaceName);
        if (!marketplace) {
          return {
            content: [
              {
                type: 'text',
                text: `Unknown marketplace: ${marketplaceName}. Available: ${listMarketplaceNames().join(', ')}`
              }
            ],
            isError: true
          };
        }

        try {
          const result = await marketplace.search(searchParams);
          return {
            content: [
              {
                type: 'text',
                text: formatSingleResult(result, searchParams, params.includeImages || false)
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Error searching ${marketplace.displayName}: ${error}`
              }
            ],
            isError: true
          };
        }
      }
    }

    case 'get_listing_details': {
      const { listingId, marketplace: mpName, imageMode, includeImages, imageSize, maxImages } = args as {
        listingId: string;
        marketplace?: string;
        imageMode?: 'urls' | 'inline';
        includeImages?: boolean;
        imageSize?: 'thumb' | 'standard' | 'full';
        maxImages?: number;
      };

      if (!listingId) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter: listingId' }],
          isError: true,
        };
      }

      const targetMp = mpName || 'facebook';
      const marketplace = getMarketplace(targetMp) as
        | { getListingDetails?: (id: string) => Promise<ListingDetails> }
        | undefined;
      if (!marketplace?.getListingDetails) {
        return {
          content: [{
            type: 'text',
            text: `Unknown marketplace or listing details unsupported: ${targetMp}. Available: ${listMarketplaceNames().join(', ')}`,
          }],
          isError: true,
        };
      }

      try {
        const details = await marketplace.getListingDetails(listingId);

        const total = details.images.length;
        const mode: 'urls' | 'inline' = imageMode ?? (includeImages ? 'inline' : 'urls');

        // No photos on the listing — nothing image-specific to do.
        if (total === 0) {
          return { content: [{ type: 'text', text: formatListingDetails(details) }] };
        }

        // URL mode defaults to full res (client fetches directly, no payload cost
        // to us); inline mode defaults to standard to keep the base64 reasonable.
        const sizeKey = imageSize ?? (mode === 'urls' ? 'full' : 'standard');
        const sizePx = IMAGE_SIZE_PX[sizeKey];
        const urls = details.images
          .slice(0, maxImages ?? total)
          .map((url) => resizeEbayImageUrl(url, sizePx));

        const renderUrls = () => {
          const numbered = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
          const markdown = urls.map((u, i) => `![Photo ${i + 1}](${u})`).join('\n');
          return `\n\n🖼️ Photos (${urls.length}${urls.length < total ? ` of ${total}` : ''}, ${sizeKey}) — full-resolution CDN URLs, fetch directly:\n${numbered}\n\n${markdown}`;
        };

        // ── URL mode: hand back direct CDN URLs, no server-side fetch ──
        if (mode === 'urls') {
          const { images: _u, ...detailsBase } = details;
          return {
            content: [{
              type: 'text',
              text: formatListingDetails({ ...detailsBase, images: [] }) + renderUrls(),
            }],
          };
        }

        // ── Inline mode: fetch server-side (hardened), return base64 ──
        const fetched: Array<{ url: string; ok: boolean; data?: string; mimeType?: string }> = [];
        for (let i = 0; i < urls.length; i += 5) {
          const batch = urls.slice(i, i + 5);
          const settled = await Promise.allSettled(
            batch.map(async (url) => {
              const res = await fetch(url, {
                headers: {
                  'User-Agent': IMAGE_FETCH_UA,
                  Referer: 'https://www.ebay.com/',
                  Accept: 'image/avif,image/webp,image/png,image/*,*/*',
                },
                signal: AbortSignal.timeout(10_000),
              });
              if (!res.ok) return { url, ok: false };
              const mimeType = res.headers.get('content-type') || '';
              const buffer = Buffer.from(await res.arrayBuffer());
              if (!mimeType.startsWith('image/') || !looksLikeImage(buffer)) return { url, ok: false };
              return { url, ok: true, data: buffer.toString('base64'), mimeType };
            }),
          );
          for (const s of settled) {
            fetched.push(s.status === 'fulfilled' ? s.value : { url: '', ok: false });
          }
        }

        const okImages = fetched.filter((r) => r.ok);
        const failedImages = fetched.filter((r) => !r.ok && r.url);

        // Every server-side fetch failed (e.g. CDN blocking) — degrade to URL mode
        // so the caller still gets usable links instead of blank blocks.
        if (okImages.length === 0) {
          const { images: _f, ...detailsBase } = details;
          return {
            content: [{
              type: 'text',
              text:
                formatListingDetails({ ...detailsBase, images: [] }) +
                '\n\n⚠️ Server-side image fetch failed for all photos (the CDN likely blocks datacenter requests).' +
                renderUrls(),
            }],
          };
        }

        const contentBlocks: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [];
        const { images: _i, ...detailsBase } = details;
        const failNote = failedImages.length
          ? `\n\n⚠️ ${failedImages.length} photo(s) could not be fetched server-side — fetch these directly:\n` +
            failedImages.map((r, i) => `${i + 1}. ${r.url}`).join('\n')
          : '';
        contentBlocks.push({
          type: 'text',
          text:
            formatListingDetails({ ...detailsBase, images: [] }) +
            `\n\n🖼️ ${okImages.length} of ${total} photo(s) inline (${sizeKey})` + failNote,
        });
        for (const r of okImages) {
          contentBlocks.push({ type: 'image', data: r.data!, mimeType: r.mimeType! });
        }
        return { content: contentBlocks };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error fetching listing details: ${error}` }],
          isError: true,
        };
      }
    }

    case 'list_marketplaces': {
      const marketplaces = getAllMarketplaces();
      const info = marketplaces.map(mp => ({
        name: mp.name,
        displayName: mp.displayName,
        requiresAuth: mp.requiresAuth
      }));

      return {
        content: [
          {
            type: 'text',
            text: `Available Marketplaces:\n\n${info.map(m =>
              `• ${m.displayName} (${m.name}) - ${m.requiresAuth ? 'Requires auth' : 'No auth required'}`
            ).join('\n')}`
          }
        ]
      };
    }

    case 'search': {
      const { query } = args as { query: string };
      if (!query) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter: query' }],
          isError: true,
        };
      }

      const searchParams: SearchParams = { query, location: 'san francisco' };
      const results: Array<{ id: string; title: string; text: string; url: string }> = [];
      const errors: string[] = [];

      const settled = await Promise.allSettled(
        getAllMarketplaces().map(mp => mp.search(searchParams))
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          for (const listing of outcome.value.listings) {
            const parts = [listing.price];
            if (listing.condition) parts.push(listing.condition);
            if (listing.location) parts.push(listing.location);
            parts.push(`on ${listing.marketplace}`);
            if (listing.description) parts.push(listing.description);
            results.push({
              id: `${outcome.value.marketplace}:${listing.id}`,
              title: listing.title,
              text: parts.join(' · '),
              url: listing.url,
            });
          }
        } else {
          errors.push(String(outcome.reason));
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(errors.length ? { results, errors } : { results })
        }]
      };
    }

    case 'fetch': {
      const { id } = args as { id: string };
      const colonIdx = id ? id.indexOf(':') : -1;
      if (colonIdx === -1) {
        return {
          content: [{ type: 'text', text: 'id must be in format marketplace:listingId' }],
          isError: true,
        };
      }

      const marketplaceName = id.slice(0, colonIdx);
      const listingId = id.slice(colonIdx + 1);
      const mp = getMarketplace(marketplaceName) as { getListingDetails?: (id: string) => Promise<ListingDetails> } | undefined;
      if (!mp?.getListingDetails) {
        return {
          content: [{ type: 'text', text: `Unknown marketplace or listing details unsupported: ${marketplaceName}. Available: ${listMarketplaceNames().join(', ')}` }],
          isError: true,
        };
      }

      try {
        const details = await mp.getListingDetails(listingId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id,
              title: details.description?.split('\n')[0]?.slice(0, 120) || `Listing ${listingId} on ${marketplaceName}`,
              text: details.description || '',
              url: details.url,
              metadata: {
                marketplace: marketplaceName,
                location: details.location,
                seller: details.seller,
                images: details.images,
                deliveryTypes: details.deliveryTypes,
                isShippingOffered: details.isShippingOffered,
              },
            })
          }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error fetching listing details: ${error}` }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      };
  }
});

// Format results for display
function formatSingleResult(result: SearchResult, params: SearchParams, includeImages: boolean): string {
  if (!result.success) {
    return `❌ ${result.marketplace}: ${result.error}`;
  }

  if (result.listings.length === 0) {
    return `No listings found for "${params.query}" in ${params.location}`;
  }

  const lines = [
    `🔍 Found ${result.listings.length} listings for "${params.query}" on ${result.marketplace}`,
    `📍 Location: ${params.location}`,
    ''
  ];

  // Sort by price
  const sorted = [...result.listings].sort((a, b) => 
    (a.priceNumeric || 0) - (b.priceNumeric || 0)
  );

  for (const listing of sorted) {
    lines.push(`**${listing.price}** - ${listing.title}`);
    if (listing.location) {
      lines.push(`   📍 ${listing.location}`);
    }
    lines.push(`   🆔 ${listing.id}`);
    if (listing.images && listing.images.length > 0) {
      if (includeImages) {
        lines.push(`   🖼️ Images: ${listing.images.join(' , ')}`);
      } else {
        lines.push(`   📷 ${listing.images.length} photo${listing.images.length > 1 ? 's' : ''}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatMultipleResults(results: SearchResult[], params: SearchParams, includeImages: boolean): string {
  const lines = [
    `🔍 Search results for "${params.query}" across all marketplaces`,
    `📍 Location: ${params.location}`,
    ''
  ];

  for (const result of results) {
    lines.push(`## ${result.marketplace}`);
    
    if (!result.success) {
      lines.push(`❌ Error: ${result.error}`);
    } else if (result.listings.length === 0) {
      lines.push('No listings found');
    } else {
      lines.push(`Found ${result.listings.length} listings:`);
      
      const sorted = [...result.listings].sort((a, b) => 
        (a.priceNumeric || 0) - (b.priceNumeric || 0)
      ).slice(0, 10); // Top 10 per marketplace

      for (const listing of sorted) {
        lines.push(`  • **${listing.price}** - ${listing.title}`);
        if (listing.images && listing.images.length > 0) {
          if (includeImages) {
            lines.push(`    🖼️ Images: ${listing.images.join(' , ')}`);
          } else {
            lines.push(`    📷 ${listing.images.length} photo${listing.images.length > 1 ? 's' : ''}`);
          }
        }
        lines.push(`    🆔 ${listing.id}`);
      }
    }
    
    lines.push('');
  }

  return lines.join('\n');
}

function formatListingDetails(details: ListingDetails): string {
  const lines = [
    `📋 Listing Details`,
    `🔗 ${details.url}`,
    '',
  ];

  if (details.description) {
    lines.push(`**Description:** ${details.description}`);
    lines.push('');
  }

  if (details.location) {
    lines.push(`📍 ${details.location}`);
  }

  if (details.seller) {
    lines.push(`👤 Seller: ${details.seller}`);
  }

  if (details.deliveryTypes && details.deliveryTypes.length > 0) {
    lines.push(`🚚 Delivery: ${details.deliveryTypes.join(', ')}`);
  }

  if (details.isShippingOffered) {
    lines.push(`📦 Shipping available`);
  }

  if (details.images.length > 0) {
    lines.push('');
    lines.push(`🖼️ Photos (${details.images.length}):`);
    for (const img of details.images) {
      lines.push(`   ${img}`);
    }
  }

  return lines.join('\n');
}

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Secondhand MCP server started');
}

// Clean shutdown
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
