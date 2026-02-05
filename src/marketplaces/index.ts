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

// All known marketplace constructors
const allMarketplaces: Record<string, () => Marketplace> = {
  facebook: () => new FacebookMarketplace(),
  ebay: () => new EbayMarketplace(),
};

// Register marketplaces based on MARKETPLACES env var (comma-separated).
// If not set, all marketplaces are enabled by default.
export function initializeMarketplaces(): void {
  const envList = process.env.MARKETPLACES?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const enabled = envList ?? Object.keys(allMarketplaces);

  for (const name of enabled) {
    const factory = allMarketplaces[name];
    if (!factory) {
      console.error(`Unknown marketplace "${name}" in MARKETPLACES — skipping`);
      continue;
    }
    if (name === 'ebay' && (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET)) {
      console.error('eBay marketplace enabled but EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set — skipping');
      continue;
    }
    registerMarketplace(factory());
  }
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

export function listMarketplaceNames(): string[] {
  return Array.from(marketplaces.keys());
}
