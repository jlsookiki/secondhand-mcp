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

import { SearchParams, SearchResult, Listing } from './types';
import {
  initializeMarketplaces,
  getMarketplace,
  getAllMarketplaces,
  listMarketplaceNames,
} from './marketplaces';

// Initialize marketplaces
initializeMarketplaces();

// Define available tools
const tools: Tool[] = [
  {
    name: 'search_marketplace',
    description: `Search for items on secondary marketplaces. Supports: ${listMarketplaceNames().join(', ')}. Returns listings with prices, titles, locations, and URLs.`,
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
        }
      },
      required: ['query']
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
      };

      const searchParams: SearchParams = {
        query: params.query,
        location: params.location || 'san francisco',
        maxPrice: params.maxPrice,
        minPrice: params.minPrice,
        limit: params.limit || 20,
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
              text: formatMultipleResults(results, searchParams)
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
                text: formatSingleResult(result, searchParams)
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
function formatSingleResult(result: SearchResult, params: SearchParams): string {
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
    lines.push(`   🔗 ${listing.url}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatMultipleResults(results: SearchResult[], params: SearchParams): string {
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
      }
    }
    
    lines.push('');
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
