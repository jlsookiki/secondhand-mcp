import { describe, expect, it } from 'vitest';
import allCities from 'all-the-cities';
import { lookupUsCity } from '../src/marketplaces/us-cities.js';

function resolvedName(query: string): string | null {
  return lookupUsCity(query)?.name ?? null;
}

describe('lookupUsCity', () => {
  it.each([
    ['austin', 'Austin, TX'],
    ['portland', 'Portland, OR'],
    ['brooklyn', 'Brooklyn, NY'],
    ['springfield', 'Springfield, MO'],
    ['columbus', 'Columbus, OH'],
    ['kansas city', 'Kansas City, MO'],
    ['phoenix', 'Phoenix, AZ'],
    ['sacramento', 'Sacramento, CA'],
    ['boston', 'Boston, MA'],
    ['atlanta', 'Atlanta, GA'],
    ['oakland', 'Oakland, CA'],
    ['charlotte', 'Charlotte, NC'],
    ['san antonio', 'San Antonio, TX'],
    ['san diego', 'San Diego, CA'],
  ])('picks the most prominent city for the bare name %j', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['Austin, TX', 'Austin, TX'],
    ['austin texas', 'Austin, TX'],
    ['Kansas City, MO', 'Kansas City, MO'],
    ['kansas city, kansas', 'Kansas City, KS'],
    ['Portland, ME', 'Portland, ME'],
    ['Springfield, IL', 'Springfield, IL'],
    ['Columbus, GA', 'Columbus, GA'],
    ['Charlotte, NC', 'Charlotte, NC'],
    ['Boise, ID', 'Boise, ID'],
    ['new york, ny', 'New York City, NY'],
  ])('honours the state in %j', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['Charlotte, North Carolina', 'Charlotte, NC'],
    ['Newark, New Jersey', 'Newark, NJ'],
    ['Albuquerque, New Mexico', 'Albuquerque, NM'],
  ])('accepts the multi-word state name in %j', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['nyc', 'New York City, NY'],
    ['sf', 'San Francisco, CA'],
    ['la', 'Los Angeles, CA'],
    ['philly', 'Philadelphia, PA'],
    ['vegas', 'Las Vegas, NV'],
    ['dc', 'Washington, D.C.'],
  ])('expands the alias %j', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['  AUSTIN,   tx ', 'Austin, TX'],
    ['St. Louis', 'St. Louis, MO'],
  ])('normalises case, whitespace and punctuation in %j', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([['Austin, ME'], ['zzzznotacity']])(
    'returns null rather than guessing for %j',
    (query) => {
      expect(resolvedName(query)).toBeNull();
    }
  );

  it.each([['toronto'], ['london'], ['paris'], ['berlin'], ['manchester'], ['vancouver']])(
    'does not answer the famous non-US name %j with a small US namesake',
    (query) => {
      expect(resolvedName(query)).toBeNull();
    }
  );

  it.each([
    ['toronto, oh', 'Toronto, OH'],
    ['paris, tx', 'Paris, TX'],
    ['london, ky', 'London, KY'],
  ])('still answers %j once a state is given', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it('round-trips the 200 largest US cities through "City, ST"', () => {
    const largest = allCities
      .filter((c) => c.country === 'US')
      .sort((a, b) => b.population - a.population)
      .slice(0, 200);

    const misses = largest.filter((c) => {
      const r = lookupUsCity(`${c.name}, ${c.adminCode}`);
      return (
        !r ||
        Math.abs(r.latitude - c.loc.coordinates[1]) >= 0.5 ||
        Math.abs(r.longitude - c.loc.coordinates[0]) >= 0.5
      );
    });

    expect(misses.map((c) => `${c.name}, ${c.adminCode}`)).toEqual([]);
  });
});
