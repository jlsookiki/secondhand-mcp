import { describe, expect, it } from 'vitest';
import { cheapestShipping, deliveredTotal, optionQuote, shippedOptions } from '../src/marketplaces/ebay/shipping.js';
import { quoteText } from '../src/marketplaces/ebay/parse.js';
import type { BrowseShippingOption } from '../src/marketplaces/ebay/wire.js';

const fixed = (value: string, over: BrowseShippingOption = {}): BrowseShippingOption => ({
  shippingCostType: 'FIXED',
  shippingCost: { value, currency: 'USD' },
  ...over,
});
const calculated: BrowseShippingOption = { shippingCostType: 'CALCULATED', shippingCost: { value: '12.40', currency: 'USD' } };
const pickup: BrowseShippingOption = { type: 'PICKUP', shippingCostType: 'FIXED', shippingCost: { value: '0.00', currency: 'USD' } };

describe('cheapestShipping', () => {
  it('says nothing when the listing does not ship', () => {
    expect(cheapestShipping(undefined)).toBeUndefined();
    expect(cheapestShipping([])).toBeUndefined();
    expect(cheapestShipping([pickup])).toBeUndefined();
  });

  it('takes the cheapest flat rate, and never counts local pickup as free shipping', () => {
    expect(cheapestShipping([fixed('8.95'), fixed('5.25'), pickup])).toEqual({
      kind: 'fixed',
      cost: { value: '5.25', currency: 'USD' },
      amount: 5.25,
    });
    expect(cheapestShipping([fixed('0.00'), fixed('9.00')])).toMatchObject({ kind: 'fixed', amount: 0 });
  });

  it('is calculated when a calculated option might undercut the cheapest flat rate, but free always wins', () => {
    expect(cheapestShipping([calculated, fixed('7.00')])).toEqual({ kind: 'calculated' });
    expect(cheapestShipping([calculated, fixed('0.00')])).toMatchObject({ kind: 'fixed', amount: 0 });
    expect(cheapestShipping([calculated])).toEqual({ kind: 'calculated' });
  });
});

describe('optionQuote', () => {
  it('treats an unknown cost type or an unreadable amount as calculated, never a number', () => {
    expect(optionQuote({ shippingServiceCode: 'Standard' })).toEqual({ kind: 'calculated' });
    expect(optionQuote({ shippingCostType: 'FIXED' })).toEqual({ kind: 'calculated' });
    expect(optionQuote({ shippingCostType: 'SOMETHING_NEW', shippingCost: { value: '3.00' } })).toEqual({ kind: 'calculated' });
    expect(optionQuote(fixed('n/a'))).toEqual({ kind: 'calculated' });
  });
});

describe('deliveredTotal', () => {
  const flat = (value: string, currency = 'USD') => ({ kind: 'fixed' as const, cost: { value, currency }, amount: Number(value) });

  it('adds a known shipping amount in the item’s own currency, to the cent', () => {
    expect(deliveredTotal({ amount: 179.99, currency: 'USD' }, flat('8.95'))).toBe(188.94);
    expect(deliveredTotal({ amount: 0.1, currency: 'usd' }, flat('0.2'))).toBe(0.3);
    expect(deliveredTotal({ amount: 25, currency: 'USD' }, flat('0.00'))).toBe(25);
  });

  it('gives no total when shipping is calculated, missing, or in another currency', () => {
    expect(deliveredTotal({ amount: 25, currency: 'USD' }, { kind: 'calculated' })).toBeUndefined();
    expect(deliveredTotal({ amount: 25, currency: 'USD' }, undefined)).toBeUndefined();
    expect(deliveredTotal({ amount: 25, currency: 'USD' }, flat('5.00', 'AUD'))).toBeUndefined();
    expect(deliveredTotal({ amount: 25 }, flat('5.00'))).toBeUndefined();
    expect(deliveredTotal(undefined, flat('5.00'))).toBeUndefined();
  });
});

describe('shippedOptions', () => {
  it('lists every shipping service with its quote and leaves pickup out', () => {
    expect(
      shippedOptions([fixed('5.25', { shippingServiceCode: 'USPS Ground Advantage' }), { ...calculated, shippingServiceCode: 'UPS Ground' }, pickup])
    ).toEqual([
      { service: 'USPS Ground Advantage', quote: { kind: 'fixed', cost: { value: '5.25', currency: 'USD' }, amount: 5.25 } },
      { service: 'UPS Ground', quote: { kind: 'calculated' } },
    ]);
  });
});

describe('quoteText', () => {
  it('writes a quote as an amount in its currency, Free, or Calculated at checkout', () => {
    expect(quoteText({ kind: 'fixed', cost: { value: '6.50', currency: 'GBP' }, amount: 6.5 })).toBe('£6.50');
    expect(quoteText({ kind: 'fixed', cost: { value: '6.50' }, amount: 6.5 })).toBe('6.50');
    expect(quoteText({ kind: 'fixed', cost: { value: '0.00', currency: 'USD' }, amount: 0 })).toBe('Free');
    expect(quoteText({ kind: 'calculated' })).toBe('Calculated at checkout');
  });
});
