#!/usr/bin/env node

/**
 * Secondhand MCP Server
 * 
 * An MCP server for searching secondary marketplaces like
 * Facebook Marketplace, eBay, Craigslist, and more.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { SearchParams, SearchResult, Listing, ListingDetails } from './types';
import {
  initializeMarketplaces,
  getMarketplace,
  getAllMarketplaces,
  listMarketplaceNames,
  FacebookMarketplace,
  EbayMarketplace,
  DepopMarketplace,
} from './marketplaces';

// Initialize marketplaces
initializeMarketplaces();

// Define available tools
const tools: Tool[] = [
  {
    name: 'search_marketplace',
    description: `Search for items on secondary marketplaces. Supports: ${listMarketplaceNames().join(', ')}. Returns listing ID, title, price, location, and photo count. Facebook: location-based search, no auth. eBay: keyword search with condition filter, requires API keys. Depop: keyword search with filters for sort, condition, category, brands, sizes, colors (requires Chrome). Use get_listing_details with a listing ID for full description, all photos, seller info, and shipping options.`,
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
          description: 'City or area to search (e.g., "san francisco", "nyc", "los angeles")',
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
          description: 'Maximum number of results to return (default: 20)',
          default: 20
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
          description: 'Sort order (Depop only). Options: relevance, newest, most_popular, price_low_to_high, price_high_to_low',
          default: 'relevance'
        },
        condition: {
          type: 'string',
          description: 'Item condition filter. eBay: new, like_new, good, fair. Depop: new, like_new, excellent, good, fair, used. Use "any" for no filter.',
        },
        category: {
          type: 'string',
          description: 'Product category (Depop only). Options: tops, bottoms, dresses, coats-jackets, footwear, accessories, bags, jewellery, activewear, swimwear',
        },
        sizes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by sizes (Depop only). Example: ["S", "M", "L"] or ["US 9", "US 10"]',
        },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by colors (Depop only). Options: black, white, red, blue, green, yellow, orange, pink, purple, brown, grey, cream, multi, silver, gold',
        }
      },
      required: ['query']
    }
  },
  {
    name: 'get_listing_details',
    description: 'Get full details for a specific listing using an ID from search results. Facebook returns: description, all photos, location, seller name, delivery types, shipping availability. eBay returns: description, all photos, location (city/state/country), seller username, shipping service options. Depop returns: description, all photos, seller username, shipping availability.',
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
  }
];

// Create server
const server = new Server(
  {
    name: 'secondhand-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
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
        showSold?: boolean;
        includeImages?: boolean;
        sort?: string;
        condition?: string;
        category?: string;
        sizes?: string[];
        colors?: string[];
      };

      const searchParams: SearchParams = {
        query: params.query,
        location: params.location || 'san francisco',
        maxPrice: params.maxPrice,
        minPrice: params.minPrice,
        limit: params.limit || 20,
        showSold: params.showSold || false,
        sort: params.sort as SearchParams['sort'],
        condition: params.condition as SearchParams['condition'],
        category: params.category,
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
      const { listingId, marketplace: mpName } = args as {
        listingId: string;
        marketplace?: string;
      };

      if (!listingId) {
        return {
          content: [{ type: 'text', text: 'Missing required parameter: listingId' }],
          isError: true,
        };
      }

      try {
        const targetMp = mpName || 'facebook';
        let details: ListingDetails;

        if (targetMp === 'ebay') {
          const ebay = getMarketplace('ebay') as EbayMarketplace;
          details = await ebay.getListingDetails(listingId);
        } else if (targetMp === 'depop') {
          const depop = getMarketplace('depop') as DepopMarketplace;
          details = await depop.getListingDetails(listingId);
        } else {
          const fb = getMarketplace('facebook') as FacebookMarketplace;
          details = await fb.getListingDetails(listingId);
        }

        return {
          content: [{ type: 'text', text: formatListingDetails(details) }],
        };
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
