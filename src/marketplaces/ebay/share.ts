import { EbayLookupRef, shareLinkTarget } from './items.js';

// Share-link redirects timed in late September 2026 took 0.14–0.94 s; four times the slowest is a broken link.
const SHARE_LINK_TIMEOUT_MS = 4_000;

/**
 * The listing an ebay.us or ebay.io link sends its shopper to. One request,
 * whose redirect is read and never followed; `url` must already be the
 * rebuilt https://ebay.us|io/<code> that parseEbayItemRef returns.
 */
export async function followShareLink(url: string): Promise<EbayLookupRef> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(SHARE_LINK_TIMEOUT_MS) });
  await response.body?.cancel();
  const target = shareLinkTarget(response.status, response.headers.get('location'));
  if (!target) throw new Error(`eBay share link did not resolve (${response.status})`);
  return target;
}
