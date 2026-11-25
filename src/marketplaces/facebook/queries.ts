import { LocationCoordinates } from '../../types.js';

export const LOCATION_DOC_ID = '5585904654783609';
export const SEARCH_DOC_ID = '27517490627932547';
export const DETAIL_PHOTOS_DOC_ID = '10059604367394414';
export const DETAIL_INFO_DOC_ID = '26090240497332612';

export const DEFAULT_RADIUS_MILES = 25;
const MAX_RADIUS_MILES = 500;
const KM_PER_MILE = 1.609;
const CENTS_PER_DOLLAR = 100;
export const API_PAGE_SIZE = 24;

// Max price value Facebook uses as "no upper limit", in cents like every
// price bound the search variables take.
const MAX_PRICE_SENTINEL = 214748364700;

export interface PriceBounds {
  minPrice?: number;
  maxPrice?: number;
}

export function cents(dollars: number): number {
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

// Facebook reads both the search page's `radius` and the variables'
// `filter_radius_km` as kilometres.
export function radiusKm(radiusMiles: number): number {
  return Math.round(radiusMiles * KM_PER_MILE);
}

export function clampRadius(radiusMiles: number | undefined): number {
  if (!radiusMiles || radiusMiles <= 0) return DEFAULT_RADIUS_MILES;
  return Math.min(radiusMiles, MAX_RADIUS_MILES);
}

export function locationVariables(query: string): string {
  return JSON.stringify({
    params: {
      caller: 'MARKETPLACE',
      page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
      query,
    },
  });
}

// Facebook's own client sends every field below; leaving the newer ones
// out makes the query return data-less story stubs.
export function searchVariables(
  query: string,
  coords: LocationCoordinates,
  limit: number,
  { minPrice, maxPrice }: PriceBounds,
  radiusMiles: number = DEFAULT_RADIUS_MILES
): string {
  return JSON.stringify({
    buyLocation: { latitude: coords.latitude, longitude: coords.longitude },
    contextual_data: null,
    count: Math.min(limit, API_PAGE_SIZE),
    cursor: null,
    params: {
      bqf: {
        callsite: 'COMMERCE_MKTPLACE_WWW',
        query,
      },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: true,
        commerce_search_and_rp_available: true,
        commerce_search_and_rp_category_id: [],
        commerce_search_and_rp_condition: null,
        commerce_search_and_rp_ctime_days: null,
        filter_location_latitude: coords.latitude,
        filter_location_longitude: coords.longitude,
        filter_price_lower_bound: minPrice == null ? 0 : cents(minPrice),
        filter_price_upper_bound: maxPrice == null ? MAX_PRICE_SENTINEL : cents(maxPrice),
        filter_radius_km: radiusKm(radiusMiles),
      },
      custom_request_params: {
        browse_context: null,
        contextual_filters: [],
        referral_code: null,
        referral_ui_component: null,
        saved_search_strid: null,
        search_vertical: 'C2C',
        seo_url: null,
        serp_landing_settings: { virtual_category_id: '' },
        surface: 'SEARCH',
        virtual_contextual_filters: [],
      },
    },
    savedSearchID: null,
    savedSearchQuery: query,
    scale: 2,
    shouldDeferNonCritical: false,
    shouldIncludePopularSearches: false,
    topicPageParams: { location_id: null, url: null },
    __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: true,
  });
}

export function searchPageUrl(
  pageId: string,
  query: string,
  { minPrice, maxPrice }: PriceBounds,
  radiusMiles: number
): string {
  const search = new URLSearchParams({ query });
  // The page takes its price bounds in dollars, unlike the search variables.
  if (minPrice != null) search.set('minPrice', String(minPrice));
  if (maxPrice != null) search.set('maxPrice', String(maxPrice));
  search.set('radius', String(radiusKm(radiusMiles)));
  return `https://www.facebook.com/marketplace/${pageId}/search?${search.toString()}`;
}

export function detailPhotosVariables(listingId: string): string {
  return JSON.stringify({ targetId: listingId });
}

export function detailInfoVariables(listingId: string): string {
  return JSON.stringify({
    targetId: listingId,
    scale: 2,
    feedbackSource: 56,
    feedLocation: 'MARKETPLACE_MEGAMALL',
    referralCode: 'marketplace_top_picks',
    enableJobEmployerActionBar: false,
    enableJobSeekerActionBar: false,
    useDefaultActor: false,
    __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
    __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
    __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: false,
    __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
    __relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider: false,
  });
}
