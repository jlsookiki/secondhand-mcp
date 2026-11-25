#!/usr/bin/env node

/**
 * Secondhand MCP Server
 *
 * An MCP server for searching secondhand marketplaces: Facebook Marketplace,
 * eBay, Depop and Poshmark.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { initializeMarketplaces } from './marketplaces/index.js';
import { INSTRUCTIONS, callTool, toolDefinitions } from './tools/index.js';

initializeMarketplaces();

const { version: VERSION } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

const server = new Server(
  { name: 'secondhand-mcp', version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Secondhand MCP server started');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
