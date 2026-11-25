import { getMarketplace, listMarketplaceNames, resizeEbayImageUrl } from '../marketplaces/index.js';
import { ListingDetails, OptionFilter } from '../types.js';
import { booleanArg, choiceArg, countArg, optionFilterArg, stringArg } from './arguments.js';
import { formatListingDetails } from './format.js';
import { FetchedImage, IMAGE_SIZE_PX, ImageSize, fetchImages } from './images.js';
import { ToolContent, ToolResult, errorResult, textResult } from './results.js';

const IMAGE_MODES = ['urls', 'inline'] as const;
type ImageMode = (typeof IMAGE_MODES)[number];
const IMAGE_SIZES = Object.keys(IMAGE_SIZE_PX) as ImageSize[];

interface ListingDetailsArgs {
  listingId?: string;
  marketplace?: string;
  imageMode?: ImageMode;
  includeImages?: boolean;
  imageSize?: ImageSize;
  maxImages?: number;
  options?: OptionFilter;
}

interface DetailsSource {
  /** Only eBay sells one listing in several options; other marketplaces ignore the filter. */
  getListingDetails: (id: string, optionFilter?: OptionFilter) => Promise<ListingDetails>;
}

/** The marketplace by name, when it can fetch a single listing. */
export function detailsSource(name: string): DetailsSource | undefined {
  const marketplace = getMarketplace(name) as Partial<DetailsSource> | undefined;
  return marketplace?.getListingDetails ? (marketplace as DetailsSource) : undefined;
}

export function unsupportedDetails(name: string): ToolResult {
  return errorResult(
    `Unknown marketplace or listing details unsupported: ${name}. Available: ${listMarketplaceNames().join(', ')}`
  );
}

export async function listingDetails(args: unknown): Promise<ToolResult> {
  const { listingId, marketplace, imageMode, includeImages, imageSize, maxImages, options } = readArgs(args);
  if (!listingId) return errorResult('Missing required parameter: listingId');

  const targetMp = marketplace || 'facebook';
  const source = detailsSource(targetMp);
  if (!source) return unsupportedDetails(targetMp);

  try {
    const details = await source.getListingDetails(listingId, options);
    if (details.images.length === 0) return textResult(formatListingDetails(details));
    if (maxImages === 0) return textResult(withoutPhotos(details) + photosLeftOutText(details.images.length));

    const mode: ImageMode = imageMode ?? (includeImages ? 'inline' : 'urls');
    // URL mode defaults to full res (client fetches directly, no payload cost
    // to us); inline mode defaults to standard to keep the base64 reasonable.
    const size = imageSize ?? (mode === 'urls' ? 'full' : 'standard');
    const photos = photoSelection(details, size, maxImages);

    return mode === 'urls' ? urlsReply(details, photos) : await inlineReply(details, photos);
  } catch (error) {
    return errorResult(`Error fetching listing details: ${error}`);
  }
}

function readArgs(args: unknown): ListingDetailsArgs {
  return {
    listingId: stringArg(args, 'listingId'),
    marketplace: stringArg(args, 'marketplace'),
    imageMode: choiceArg(args, 'imageMode', IMAGE_MODES),
    includeImages: booleanArg(args, 'includeImages'),
    imageSize: choiceArg(args, 'imageSize', IMAGE_SIZES),
    maxImages: countArg(args, 'maxImages'),
    options: optionFilterArg(args, 'options'),
  };
}

interface PhotoSelection {
  urls: string[];
  total: number;
  size: ImageSize;
}

function photoSelection(details: ListingDetails, size: ImageSize, maxImages: number | undefined): PhotoSelection {
  const total = details.images.length;
  const urls = details.images
    .slice(0, maxImages ?? total)
    .map((url) => resizeEbayImageUrl(url, IMAGE_SIZE_PX[size]));
  return { urls, total, size };
}

function withoutPhotos(details: ListingDetails): string {
  return formatListingDetails({ ...details, images: [] });
}

function photoUrlsText({ urls, total, size }: PhotoSelection): string {
  const numbered = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
  const markdown = urls.map((u, i) => `![Photo ${i + 1}](${u})`).join('\n');
  const count = `${urls.length}${urls.length < total ? ` of ${total}` : ''}`;
  return `\n\n🖼️ Photos (${count}, ${size}) — full-resolution CDN URLs, fetch directly:\n${numbered}\n\n${markdown}`;
}

function photosLeftOutText(total: number): string {
  return `\n\n📷 ${total} photo${total > 1 ? 's' : ''}, not included (maxImages is 0)`;
}

function urlsReply(details: ListingDetails, photos: PhotoSelection): ToolResult {
  return textResult(withoutPhotos(details) + photoUrlsText(photos));
}

async function inlineReply(details: ListingDetails, photos: PhotoSelection): Promise<ToolResult> {
  const fetched = await fetchImages(photos.urls);
  const okImages = fetched.filter((r) => r.ok);

  // Every server-side fetch failed (e.g. CDN blocking) — degrade to URL mode
  // so the caller still gets usable links instead of blank blocks.
  if (okImages.length === 0) {
    return textResult(
      withoutPhotos(details) +
        "\n\n⚠️ Server-side image fetch failed for all photos, so they're listed as links to open directly." +
        photoUrlsText(photos)
    );
  }

  const summary = `\n\n🖼️ ${okImages.length} of ${photos.total} photo(s) inline (${photos.size})`;
  const content: ToolContent[] = [
    { type: 'text', text: withoutPhotos(details) + summary + failedPhotosNote(fetched) },
    ...okImages.map((r): ToolContent => ({ type: 'image', data: r.data!, mimeType: r.mimeType! })),
  ];
  return { content };
}

function failedPhotosNote(fetched: FetchedImage[]): string {
  const failed = fetched.filter((r) => !r.ok);
  if (failed.length === 0) return '';
  return (
    `\n\n⚠️ ${failed.length} photo(s) could not be fetched server-side — fetch these directly:\n` +
    failed.map((r, i) => `${i + 1}. ${r.url}`).join('\n')
  );
}
