// `search` and `fetch` follow the ChatGPT Deep Research tool contract.
// https://developers.openai.com/api/docs/guides/deep-research

import { getAllMarketplaces } from '../marketplaces/index.js';
import { Listing, SearchParams } from '../types.js';
import { stringArg } from './arguments.js';
import { detailsSource, unsupportedDetails } from './listing-details.js';
import { ToolResult, errorResult, textResult } from './results.js';

interface ResearchResult {
  id: string;
  title: string;
  text: string;
  url: string;
}

const TITLE_MAX_CHARS = 120;

export async function researchSearch(args: unknown): Promise<ToolResult> {
  const query = stringArg(args, 'query');
  if (!query) return errorResult('Missing required parameter: query');

  const searchParams: SearchParams = { query, location: 'san francisco' };
  const results: ResearchResult[] = [];
  const errors: string[] = [];

  const settled = await Promise.allSettled(getAllMarketplaces().map((mp) => mp.search(searchParams)));
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      errors.push(String(outcome.reason));
      continue;
    }
    for (const listing of outcome.value.listings) {
      results.push(researchResult(outcome.value.marketplace, listing));
    }
  }

  return textResult(JSON.stringify(errors.length ? { results, errors } : { results }));
}

function researchResult(marketplace: string, listing: Listing): ResearchResult {
  const parts = [listing.price];
  if (listing.condition) parts.push(listing.condition);
  if (listing.location) parts.push(listing.location);
  parts.push(`on ${listing.marketplace}`);
  if (listing.description) parts.push(listing.description);
  return {
    id: `${marketplace}:${listing.id}`,
    title: listing.title,
    text: parts.join(' · '),
    url: listing.url,
  };
}

export async function researchFetch(args: unknown): Promise<ToolResult> {
  const id = stringArg(args, 'id') ?? '';
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) return errorResult('id must be in format marketplace:listingId');

  const marketplaceName = id.slice(0, colonIdx);
  const listingId = id.slice(colonIdx + 1);
  const source = detailsSource(marketplaceName);
  if (!source) return unsupportedDetails(marketplaceName);

  try {
    const details = await source.getListingDetails(listingId);
    return textResult(
      JSON.stringify({
        id,
        title:
          details.title ||
          details.description?.split('\n')[0]?.slice(0, TITLE_MAX_CHARS) ||
          `Listing ${listingId} on ${marketplaceName}`,
        text: details.description || '',
        url: details.url,
        metadata: {
          marketplace: marketplaceName,
          price: details.price,
          originalPrice: details.originalPrice,
          condition: details.condition,
          listedAt: details.listedAt,
          availability: details.availability,
          location: details.location,
          seller: details.seller,
          brand: details.brand,
          images: details.images,
          deliveryTypes: details.deliveryTypes,
          isShippingOffered: details.isShippingOffered,
          shipping: details.shipping,
          shippingOptions: details.shippingOptions,
          unavailable: details.unavailable,
          optionAxes: details.optionAxes,
          optionValues: details.optionValues,
          priceRange: details.priceRange,
          options: details.options,
          optionCount: details.optionCount,
        },
      })
    );
  } catch (error) {
    return errorResult(`Error fetching listing details: ${error}`);
  }
}
