import { ListingDetails, ListingPart } from '../../types.js';
import { parsePrice } from '../base.js';
import { fieldOf, listingAvailability } from './parse.js';
import { DETAIL_INFO_DOC_ID, DETAIL_PHOTOS_DOC_ID, detailInfoVariables, detailPhotosVariables } from './queries.js';
import { fetchGraphQL } from './transport.js';
import { DetailData, DetailTarget, GraphQLResponse } from './wire.js';

export async function getListingDetails(listingId: string): Promise<ListingDetails> {
  const [photos, info] = await Promise.allSettled([
    fetchGraphQL<DetailData>(DETAIL_PHOTOS_DOC_ID, detailPhotosVariables(listingId)),
    fetchGraphQL<DetailData>(DETAIL_INFO_DOC_ID, detailInfoVariables(listingId)),
  ]);

  const photosTarget = detailsTarget(photos, 'photos');
  const infoTarget = detailsTarget(info, 'info');
  if (!photosTarget && !infoTarget) throw noListing(listingId, photos, info);

  const unavailable: ListingPart[] = [];
  if (!photosTarget) unavailable.push('photos');
  if (!infoTarget) unavailable.push('description');

  return {
    id: listingId,
    description: infoTarget?.redacted_description?.text ?? undefined,
    images: photoUris(photosTarget),
    location: infoTarget?.location_text?.text ?? undefined,
    locationCoords: infoTarget?.location ?? undefined,
    seller: infoTarget?.marketplace_listing_seller?.name ?? undefined,
    deliveryTypes: infoTarget?.delivery_types ?? undefined,
    isShippingOffered: infoTarget?.is_shipping_offered ?? undefined,
    url: `https://www.facebook.com/marketplace/item/${listingId}`,
    ...listingFacts(infoTarget),
    unavailable: unavailable.length > 0 ? unavailable : undefined,
  };
}

function noListing(listingId: string, ...parts: PromiseSettledResult<unknown>[]): unknown {
  const failed = parts.find((part) => part.status === 'rejected');
  if (failed?.status === 'rejected') return failed.reason;
  return new Error(`Facebook returned no listing ${listingId}; it may have been removed`);
}

/** One request's share of the listing; a failed one leaves its fields empty. */
function detailsTarget(
  settled: PromiseSettledResult<GraphQLResponse<DetailData>>,
  part: string
): DetailTarget | undefined {
  if (settled.status === 'rejected') {
    console.error(`[facebook] listing ${part} request failed:`, settled.reason?.message ?? settled.reason);
    return undefined;
  }
  return settled.value.data?.viewer?.marketplace_product_details_page?.target ?? undefined;
}

function photoUris(photosTarget: DetailTarget | undefined): string[] {
  const photos = photosTarget?.listing_photos;
  if (!Array.isArray(photos)) return [];
  return photos.flatMap((photo) => (photo?.image?.uri ? [photo.image.uri] : []));
}

export type ListingFacts = Pick<
  ListingDetails,
  'title' | 'price' | 'priceNumeric' | 'originalPrice' | 'condition' | 'listedAt' | 'availability'
>;

const MS_PER_SECOND = 1000;

/** What the info call says about a listing beyond its description; a field it leaves out, or sends in a shape we do not expect, stays out. */
export function listingFacts(info: unknown): ListingFacts {
  const title = textOf(fieldOf(info, 'marketplace_listing_title'));
  const price = priceText(fieldOf(info, 'listing_price'));
  const priceNumeric = price ? parsePrice(price)?.numeric : undefined;
  const original = priceText(fieldOf(info, 'strikethrough_price'));
  const originalNumeric = original ? parsePrice(original)?.numeric : undefined;
  const condition = conditionOf(fieldOf(info, 'attribute_data'));
  const created = fieldOf(info, 'creation_time');
  const availability = listingAvailability(info);
  return {
    ...(title && { title }),
    ...(price && { price }),
    ...(priceNumeric !== undefined && { priceNumeric }),
    ...(original && originalNumeric !== priceNumeric && { originalPrice: original }),
    ...(condition && { condition }),
    ...(typeof created === 'number' && { listedAt: new Date(created * MS_PER_SECOND).toISOString() }),
    ...(availability && { availability }),
  };
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function priceText(price: unknown): string | undefined {
  const formatted = textOf(fieldOf(price, 'formatted_amount'));
  if (formatted) return formatted;
  const amount = textOf(fieldOf(price, 'amount'));
  if (!amount) return undefined;
  return [amount, textOf(fieldOf(price, 'currency'))].filter(Boolean).join(' ');
}

function conditionOf(attributes: unknown): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  const entry = attributes.find((a) => textOf(fieldOf(a, 'attribute_name'))?.toLowerCase() === 'condition');
  return textOf(fieldOf(entry, 'label')) ?? textOf(fieldOf(entry, 'value'));
}
