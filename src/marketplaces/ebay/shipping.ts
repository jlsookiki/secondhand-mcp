import { BrowsePrice, BrowseShippingOption } from './wire.js';

const FIXED_COST = 'FIXED';
const PICKUP = 'PICKUP';
const CENTS_PER_UNIT = 100;

/** What shipping costs. eBay prices calculated shipping for a buyer location
 *  this server never sends, so that figure is eBay's guess and stays unsaid. */
export type ShippingQuote = { kind: 'fixed'; cost: BrowsePrice; amount: number } | { kind: 'calculated' };

type FixedQuote = Extract<ShippingQuote, { kind: 'fixed' }>;

function shipped(options: BrowseShippingOption[] | undefined): BrowseShippingOption[] {
  // Local pickup arrives as a $0 option; it is not free shipping.
  return Array.isArray(options) ? options.filter((option) => option.type !== PICKUP) : [];
}

export function optionQuote(option: BrowseShippingOption): ShippingQuote {
  const cost = option.shippingCost;
  const amount = Number(cost?.value);
  if (option.shippingCostType !== FIXED_COST || !cost || !Number.isFinite(amount)) return { kind: 'calculated' };
  return { kind: 'fixed', cost, amount };
}

/** The cheapest flat rate, unless a calculated option might undercut it; nothing when the listing does not ship. */
export function cheapestShipping(options: BrowseShippingOption[] | undefined): ShippingQuote | undefined {
  const quotes = shipped(options).map(optionQuote);
  if (quotes.length === 0) return undefined;
  const fixed = quotes.filter((quote): quote is FixedQuote => quote.kind === 'fixed');
  if (fixed.length === 0) return { kind: 'calculated' };
  const lowest = fixed.reduce((low, quote) => (quote.amount < low.amount ? quote : low));
  const undercuttable = lowest.amount > 0 && fixed.length < quotes.length;
  return undercuttable ? { kind: 'calculated' } : lowest;
}

/** What the item costs delivered, before any sales tax: only when shipping is a
 *  known amount in the item's own currency. */
export function deliveredTotal(
  item: { amount: number; currency?: string } | undefined,
  shipping: ShippingQuote | undefined
): number | undefined {
  if (!item || shipping?.kind !== 'fixed') return undefined;
  const itemCurrency = item.currency?.toUpperCase();
  if (!itemCurrency || itemCurrency !== shipping.cost.currency?.toUpperCase()) return undefined;
  return Math.round((item.amount + shipping.amount) * CENTS_PER_UNIT) / CENTS_PER_UNIT;
}

export function shippedOptions(options: BrowseShippingOption[] | undefined): Array<{ service?: string; quote: ShippingQuote }> {
  return shipped(options).map((option) => ({ service: option.shippingServiceCode, quote: optionQuote(option) }));
}
