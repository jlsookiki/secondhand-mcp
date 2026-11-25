import { describe, expect, it } from 'vitest';
import { cents, radiusKm, searchPageUrl } from '../src/marketplaces/facebook/queries.js';

describe('cents', () => {
  it('turns dollars into whole cents', () => {
    expect(cents(25)).toBe(2500);
    expect(cents(19.99)).toBe(1999);
    expect(cents(0)).toBe(0);
  });
});

describe('radiusKm', () => {
  it('turns miles into whole kilometres', () => {
    expect(radiusKm(25)).toBe(40);
    expect(radiusKm(10)).toBe(16);
    expect(radiusKm(0)).toBe(0);
  });
});

describe('searchPageUrl', () => {
  it('names the radius in kilometres', () => {
    expect(searchPageUrl('123', 'bike', {}, 10)).toContain('radius=16');
  });

  it('keeps the price bounds in dollars', () => {
    const url = new URL(searchPageUrl('123', 'bike', { minPrice: 50, maxPrice: 300 }, 25));

    expect(url.searchParams.get('minPrice')).toBe('50');
    expect(url.searchParams.get('maxPrice')).toBe('300');
  });
});
