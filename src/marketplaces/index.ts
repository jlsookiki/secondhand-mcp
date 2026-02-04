/**
 * Marketplace registry - central place to register and access all marketplace implementations
 */

import { Marketplace } from './base';
import { FacebookMarketplace } from './facebook';
import { EbayMarketplace } from './ebay';

export { Marketplace, BaseMarketplace } from './base';
export { FacebookMarketplace } from './facebook';
export { EbayMarketplace } from './ebay';

// Registry of all available marketplaces
const marketplaces: Map<string, Marketplace> = new Map();

// Register default marketplaces
export function initializeMarketplaces(): void {
  registerMarketplace(new FacebookMarketplace());
  registerMarketplace(new EbayMarketplace());
  // Add more marketplaces here as they're implemented:
  // registerMarketplace(new CraigslistMarketplace());
  // registerMarketplace(new OfferUpMarketplace());
  // registerMarketplace(new MercariMarketplace());
}

export function registerMarketplace(marketplace: Marketplace): void {
  marketplaces.set(marketplace.name, marketplace);
}

export function getMarketplace(name: string): Marketplace | undefined {
  return marketplaces.get(name);
}

export function getAllMarketplaces(): Marketplace[] {
  return Array.from(marketplaces.values());
}

export function getEnabledMarketplaces(): Marketplace[] {
  // For now, return all. Later can add enabled/disabled state.
  return getAllMarketplaces();
}

export function listMarketplaceNames(): string[] {
  return Array.from(marketplaces.keys());
}
