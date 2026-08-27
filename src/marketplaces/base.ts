/**
 * Base interface for all marketplace implementations
 */

import { SearchParams, SearchResult, LocationCoordinates } from '../types.js';

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

const CURRENCY_CODES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK',
  'PLN', 'NZD', 'MXN', 'HKD', 'SGD', 'MYR', 'PHP', 'TWD',
];

const PRICE_PATTERN = new RegExp(
  `(?:\\b(${CURRENCY_CODES.join('|')})|([£€$]))?\\s*(\\d[\\d.,]*)`
);

/**
 * Rightmost separator wins when both appear ("1,234.56", "1.234,56"). With only
 * one kind, three-digit runs mean grouping ("1,234,567") and anything else is a
 * decimal ("89,00").
 */
function parseAmount(raw: string): number {
  const digits = raw.replace(/[.,]+$/, '');
  const sepIndex = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
  if (sepIndex === -1) return parseFloat(digits);

  const separator = digits[sepIndex];
  const plain = digits.replace(/[.,]/g, '');

  if (!digits.includes(separator === ',' ? '.' : ',')) {
    const parts = digits.split(separator);
    const grouped = parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3;
    if (grouped) return parseFloat(plain);
  }

  const decimals = digits.length - sepIndex - 1;
  return parseFloat(`${plain.slice(0, plain.length - decimals)}.${plain.slice(plain.length - decimals)}`);
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
    const match = priceStr.match(PRICE_PATTERN);
    if (!match) return null;

    const currency = match[1] ?? match[2] ?? '$';
    const numeric = parseAmount(match[3]);

    return Number.isNaN(numeric) ? null : { numeric, currency };
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
