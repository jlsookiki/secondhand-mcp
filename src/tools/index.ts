import { researchFetch, researchSearch } from './deep-research.js';
import { listMarketplaces } from './list-marketplaces.js';
import { listingDetails } from './listing-details.js';
import { ArgumentError } from './arguments.js';
import { ToolResult, errorResult } from './results.js';
import { searchMarketplace } from './search-marketplace.js';

export { toolDefinitions } from './definitions.js';
export { INSTRUCTIONS } from './instructions.js';

const HANDLERS: Record<string, (args: unknown) => Promise<ToolResult>> = {
  search_marketplace: searchMarketplace,
  get_listing_details: listingDetails,
  list_marketplaces: listMarketplaces,
  search: researchSearch,
  fetch: researchFetch,
};

export async function callTool(name: string, args: unknown): Promise<ToolResult> {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) return errorResult(`Unknown tool: ${name}`);
  try {
    return await handler(args);
  } catch (error) {
    if (error instanceof ArgumentError) return errorResult(error.message);
    throw error;
  }
}
