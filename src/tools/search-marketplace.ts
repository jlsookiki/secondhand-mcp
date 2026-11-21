import { getAllMarketplaces, getMarketplace, listMarketplaceNames } from '../marketplaces/index.js';
import { CONDITIONS, Condition, SORTS, SearchParams, SearchResult, Sort } from '../types.js';
import { booleanArg, choiceArg, countArg, numberArg, stringArg, stringListArg } from './arguments.js';
import { formatMultipleResults, formatSingleResult } from './format.js';
import { ToolResult, errorResult, textResult } from './results.js';

interface SearchMarketplaceArgs {
  query?: string;
  marketplace?: string;
  location?: string;
  radiusMiles?: number;
  maxPrice?: number;
  minPrice?: number;
  limit?: number;
  offset?: number;
  showSold?: boolean;
  includeImages?: boolean;
  sort?: Sort;
  condition?: Condition;
  category?: string;
  brand?: string;
  department?: string;
  sizes?: string[];
  colors?: string[];
}

export async function searchMarketplace(args: unknown): Promise<ToolResult> {
  const params = readArgs(args);
  if (!params.query) return errorResult('Missing required parameter: query');

  const searchParams = toSearchParams({ ...params, query: params.query });
  const includeImages = params.includeImages || false;
  const marketplaceName = params.marketplace || 'facebook';

  if (marketplaceName === 'all') {
    const results = await searchEveryMarketplace(searchParams);
    return textResult(formatMultipleResults(results, searchParams, includeImages));
  }

  const marketplace = getMarketplace(marketplaceName);
  if (!marketplace) {
    return errorResult(`Unknown marketplace: ${marketplaceName}. Available: ${listMarketplaceNames().join(', ')}`);
  }

  try {
    const result = await marketplace.search(searchParams);
    return textResult(formatSingleResult(result, searchParams, includeImages));
  } catch (error) {
    return errorResult(`Error searching ${marketplace.displayName}: ${error}`);
  }
}

function readArgs(args: unknown): SearchMarketplaceArgs {
  return {
    query: stringArg(args, 'query'),
    marketplace: stringArg(args, 'marketplace'),
    location: stringArg(args, 'location'),
    radiusMiles: numberArg(args, 'radiusMiles'),
    maxPrice: numberArg(args, 'maxPrice'),
    minPrice: numberArg(args, 'minPrice'),
    limit: countArg(args, 'limit'),
    offset: countArg(args, 'offset'),
    showSold: booleanArg(args, 'showSold'),
    includeImages: booleanArg(args, 'includeImages'),
    sort: choiceArg(args, 'sort', SORTS),
    condition: choiceArg(args, 'condition', CONDITIONS),
    category: stringArg(args, 'category'),
    brand: stringArg(args, 'brand'),
    department: stringArg(args, 'department'),
    sizes: stringListArg(args, 'sizes'),
    colors: stringListArg(args, 'colors'),
  };
}

function toSearchParams(params: SearchMarketplaceArgs & { query: string }): SearchParams {
  return {
    query: params.query,
    location: params.location || 'san francisco',
    radius: params.radiusMiles,
    maxPrice: params.maxPrice,
    minPrice: params.minPrice,
    limit: params.limit || 20,
    offset: params.offset || 0,
    showSold: params.showSold || false,
    sort: params.sort,
    condition: params.condition,
    category: params.category,
    brand: params.brand,
    department: params.department,
    sizes: params.sizes,
    colors: params.colors,
  };
}

async function searchEveryMarketplace(searchParams: SearchParams): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  for (const mp of getAllMarketplaces()) {
    try {
      results.push(await mp.search(searchParams));
    } catch (error) {
      results.push({ marketplace: mp.name, success: false, listings: [], error: String(error) });
    }
  }
  return results;
}
