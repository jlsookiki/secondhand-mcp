/** The parts of eBay Browse API responses this adapter reads. */

export interface BrowsePrice {
  value?: string;
  currency?: string;
}

export interface BrowseImage {
  imageUrl?: string;
}

export interface BrowseLocation {
  city?: string;
  stateOrProvince?: string;
  country?: string;
}

/** One entry of a listing's `shippingOptions`, in a search summary or a full item. */
export interface BrowseShippingOption {
  type?: string;
  shippingCostType?: string;
  shippingCost?: BrowsePrice;
  shippingServiceCode?: string;
}

export interface ItemSummary {
  itemId: string;
  title?: string;
  price?: BrowsePrice;
  condition?: string;
  image?: BrowseImage;
  itemLocation?: BrowseLocation;
  itemWebUrl?: string;
  seller?: { username?: string };
  /** Present on a row that is one option of a multi-variation listing. */
  itemGroupHref?: string;
  shippingOptions?: BrowseShippingOption[];
}

export interface SearchResponse {
  total?: number;
  itemSummaries?: ItemSummary[];
}

export interface BrowseAspect {
  name: string;
  value: string;
}

export interface BrowseAvailability {
  estimatedAvailabilityStatus?: string;
}

export interface Item {
  itemId: string;
  price?: BrowsePrice;
  description?: string;
  shortDescription?: string;
  image?: BrowseImage;
  additionalImages?: BrowseImage[];
  itemLocation?: BrowseLocation;
  seller?: { username?: string };
  shippingOptions?: BrowseShippingOption[];
  itemWebUrl?: string;
  localizedAspects?: BrowseAspect[];
  estimatedAvailabilities?: BrowseAvailability[];
  /** Set when this item is one option of a multi-variation listing. */
  primaryItemGroup?: { itemGroupId?: string };
}

export interface ItemGroupResponse {
  items?: Item[];
  /** A description every option shares, moved out of the items themselves. */
  commonDescriptions?: Array<{ description?: string }>;
}

export interface BrowseErrorResponse {
  errors?: Array<{ errorId?: number | string }>;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
}
