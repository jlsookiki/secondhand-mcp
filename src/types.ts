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
  marketplace: string;
  scrapedAt: string;
  /** Sold in several options that may be priced differently; `price` is one of them. */
  hasOptions?: boolean;
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

/** The options a shopper wants to see, by aspect name; any listed value matches: { Size: ['M', 'L'] }. */
export type OptionFilter = Record<string, string[]>;

/** One option of a listing sold in several variations. */
export interface ListingOption {
  id: string;
  /** What sets this option apart, e.g. { Size: 'M', Color: 'Black' }. */
  aspects: Record<string, string>;
  price?: string;
  priceNumeric?: number;
  available: boolean;
  url: string;
}

/** A part of a listing that a marketplace failed to return this time. */
export type ListingPart = 'photos' | 'description' | 'options';

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
  url: string;
  unavailable?: ListingPart[];
  /** What a multi-variation listing's options differ by, e.g. ['Size', 'Color']. */
  optionAxes?: string[];
  /** Every value each axis takes across all options. */
  optionValues?: Record<string, string[]>;
  /** Cheapest and dearest option, present only when their prices differ. */
  priceRange?: { low: string; high: string; lowNumeric?: number; highNumeric?: number };
  /** A few options, available first; with `optionFilter`, the options that match it. */
  options?: ListingOption[];
  optionCount?: number;
  /** The choice these options were narrowed to, and how many matched it; alone, a choice made for a listing sold as one item. */
  optionFilter?: OptionFilter;
  matchingOptions?: number;
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
