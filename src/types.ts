/**
 * Shared types for the Secondhand MCP server
 */

export interface Listing {
  id: string;
  title: string;
  price: string;
  priceNumeric?: number;
  currency?: string;
  location?: string;
  description?: string;
  url: string;
  images?: string[];
  seller?: string;
  condition?: string;
  /** The cheapest way to get it shipped: an amount, free, or calculated at checkout. */
  shipping?: string;
  /** Price plus `shipping`, before any sales tax, when shipping is a known amount. */
  total?: string;
  marketplace: string;
  scrapedAt: string;
}

export interface ShippingChoice {
  service?: string;
  cost: string;
}

export const CONDITIONS = ['new', 'like_new', 'excellent', 'good', 'fair', 'used', 'any'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const SORTS = ['relevance', 'newest', 'most_popular', 'price_low_to_high', 'price_high_to_low'] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchParams {
  query: string;
  location?: string;
  maxPrice?: number;
  minPrice?: number;
  radius?: number; // in miles
  condition?: Condition;
  limit?: number;
  offset?: number; // starting result offset for pagination (eBay, Geartrade)
  showSold?: boolean;
  sort?: Sort;
  category?: string;
  brand?: string;
  department?: string;
  sizes?: string[];
  colors?: string[];
}

export interface SearchResult {
  marketplace: string;
  success: boolean;
  listings: Listing[];
  error?: string;
  totalFound?: number;
  note?: string;
}

export type ListingAvailability = 'available' | 'pending' | 'sold' | 'unavailable';

/** A part of a listing that a marketplace failed to return this time. */
export type ListingPart = 'photos' | 'description';

export interface ListingDetails {
  id: string;
  description?: string;
  images: string[];
  location?: string;
  locationCoords?: { latitude: number; longitude: number };
  seller?: string;
  brand?: string;
  deliveryTypes?: string[];
  isShippingOffered?: boolean;
  shipping?: string;
  shippingOptions?: ShippingChoice[];
  url: string;
  title?: string;
  price?: string;
  priceNumeric?: number;
  /** What the listing asked before its price was reduced. */
  originalPrice?: string;
  condition?: string;
  /** When the listing went up, as an ISO timestamp. */
  listedAt?: string;
  availability?: ListingAvailability;
  unavailable?: ListingPart[];
}

export interface MarketplaceConfig {
  enabled: boolean;
  requiresAuth?: boolean;
  authToken?: string;
}

export interface LocationCoordinates {
  latitude: number;
  longitude: number;
  name: string;
}
