/**
 * Base interface for all marketplace implementations
 */

import { SearchParams, SearchResult, LocationCoordinates } from '../types';

export interface Marketplace {
  /** Unique identifier for this marketplace */
  readonly name: string;
  
  /** Human-readable display name */
  readonly displayName: string;
  
  /** Whether this marketplace requires authentication */
  readonly requiresAuth: boolean;
  
  /** Search for listings */
  search(params: SearchParams): Promise<SearchResult>;
  
  /** Get location coordinates for a city/area (if supported) */
  getLocation?(query: string): Promise<LocationCoordinates | null>;
  
  /** Check if the marketplace is accessible */
  healthCheck(): Promise<boolean>;
}

export abstract class BaseMarketplace implements Marketplace {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly requiresAuth: boolean;
  
  abstract search(params: SearchParams): Promise<SearchResult>;
  
  async healthCheck(): Promise<boolean> {
    return true;
  }
  
  protected parsePrice(priceStr: string): { numeric: number; currency: string } | null {
    // Handle common price formats: $50, $1,234.56, €50, £50
    const match = priceStr.match(/([£€$])?[\s]*([\d,]+(?:\.\d{2})?)/);
    if (!match) return null;
    
    const currency = match[1] || '$';
    const numeric = parseFloat(match[2].replace(/,/g, ''));
    
    return { numeric, currency };
  }
  
  protected createError(message: string): SearchResult {
    return {
      marketplace: this.name,
      success: false,
      listings: [],
      error: message
    };
  }
}
