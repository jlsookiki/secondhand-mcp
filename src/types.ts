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
  url: string;
  imageUrl?: string;
  seller?: string;
  condition?: string;
  marketplace: string;
  scrapedAt: string;
}

export interface SearchParams {
  query: string;
  location?: string;
  maxPrice?: number;
  minPrice?: number;
  radius?: number; // in miles
  condition?: 'new' | 'like_new' | 'good' | 'fair' | 'any';
  limit?: number;
}

export interface SearchResult {
  marketplace: string;
  success: boolean;
  listings: Listing[];
  error?: string;
  totalFound?: number;
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
