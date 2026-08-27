import { describe, expect, it } from 'vitest';
import { lookupUsCity } from '../src/marketplaces/us-cities.js';

function resolvedName(query: string): string | null {
  return lookupUsCity(query)?.name ?? null;
}

function coords(query: string): [number, number] {
  const hit = lookupUsCity(query);
  if (!hit) throw new Error(`expected ${query} to resolve`);
  return [hit.latitude, hit.longitude];
}

describe('bare ambiguous names', () => {
  it.each([
    ['austin', 'Austin, TX'],
    ['portland', 'Portland, OR'],
    ['springfield', 'Springfield, MO'],
    ['columbus', 'Columbus, OH'],
    ['brooklyn', 'Brooklyn, NY'],
    ['phoenix', 'Phoenix, AZ'],
    ['kansas city', 'Kansas City, MO'],
  ])('%j resolves to the most populous US city of that name: %s', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it('returns the Oregon coordinates for a bare "portland", not the Maine ones', () => {
    expect(coords('portland')).toEqual(coords('portland, or'));
    expect(coords('portland')).not.toEqual(coords('portland, me'));
  });

  it('returns coordinates matching the named city', () => {
    const [lat, lon] = coords('austin');
    expect(lat).toBeCloseTo(30.267, 2);
    expect(lon).toBeCloseTo(-97.743, 2);
  });
});

describe('explicit state', () => {
  it.each([
    ['Austin, TX', 'Austin, TX'],
    ['Portland, ME', 'Portland, ME'],
    ['Springfield, IL', 'Springfield, IL'],
    ['Columbus, GA', 'Columbus, GA'],
    ['Boise, ID', 'Boise, ID'],
  ])('%j picks the city in that state', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['austin, texas', 'Austin, TX'],
    ['austin texas', 'Austin, TX'],
    ['portland maine', 'Portland, ME'],
    ['kansas city, kansas', 'Kansas City, KS'],
    ['columbus ohio', 'Columbus, OH'],
    ['juneau alaska', 'Juneau, AK'],
  ])('%j accepts the state spelled out, with or without a comma', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['Charlotte, North Carolina', 'Charlotte, NC'],
    ['Albuquerque, New Mexico', 'Albuquerque, NM'],
    ['Newark, New Jersey', 'Newark, NJ'],
    ['salt lake city, utah', 'Salt Lake City, UT'],
    ['springfield massachusetts', 'Springfield, MA'],
    ['new york, new york', 'New York City, NY'],
  ])('%j accepts a multi-word state name', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it('returns different coordinates for same-named cities in different states', () => {
    expect(coords('springfield, il')).not.toEqual(coords('springfield, mo'));
    expect(coords('columbus, ga')).not.toEqual(coords('columbus, oh'));
  });

  // Iteration over the state table is insertion-ordered, so " virginia" matches
  // before " west virginia" and the city becomes "charleston west".
  it('resolves a West Virginia city given the state without a comma', () => {
    expect(resolvedName('charleston west virginia')).toBe('Charleston, WV');
    expect(resolvedName('wheeling west virginia')).toBe('Wheeling, WV');
  });
});

describe('aliases', () => {
  it.each([
    ['nyc', 'New York City, NY'],
    ['ny city', 'New York City, NY'],
    ['new york', 'New York City, NY'],
    ['sf', 'San Francisco, CA'],
    ['the city', 'San Francisco, CA'],
    ['the bay', 'San Francisco, CA'],
    ['bay area', 'San Francisco, CA'],
    ['la', 'Los Angeles, CA'],
    ['lax', 'Los Angeles, CA'],
    ['dc', 'Washington, D.C.'],
    ['philly', 'Philadelphia, PA'],
    ['vegas', 'Las Vegas, NV'],
    ['nola', 'New Orleans, LA'],
    ['atl', 'Atlanta, GA'],
    ['chi', 'Chicago, IL'],
  ])('%j expands to %s', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['nyc, ny', 'New York City, NY'],
    ['philly, pa', 'Philadelphia, PA'],
    ['vegas nevada', 'Las Vegas, NV'],
    ['  SF  ', 'San Francisco, CA'],
  ])('%j expands even with a state or surrounding whitespace', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([['nyc, tx'], ['vegas, ca'], ['dc, tx']])(
    'refuses %j because the expansion is not in that state',
    (query) => {
      expect(resolvedName(query)).toBeNull();
    }
  );
});

describe('punctuation and casing', () => {
  it.each([
    ['St. Louis', 'St. Louis, MO'],
    ['st louis', 'St. Louis, MO'],
    ['st. louis, missouri', 'St. Louis, MO'],
    ["coeur d'alene", "Coeur d'Alene, ID"],
    ['winston-salem', 'Winston-Salem, NC'],
  ])('%j survives the punctuation', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it.each([
    ['Washington, D.C.'],
    ['washington d.c.'],
    ['washington dc'],
    ['washington, dc'],
    ['WASHINGTON D.C.'],
  ])('%j resolves to the single "Washington, D.C." name, unduplicated', (query) => {
    expect(resolvedName(query)).toBe('Washington, D.C.');
  });

  // Every other state accepts its full name; DC only matches its abbreviation.
  it('accepts the District of Columbia spelled out', () => {
    expect(resolvedName('washington, district of columbia')).toBe('Washington, D.C.');
  });

  it.each([['  AUSTIN,   tx '], ['austin,TX'], ['AUSTIN, TEXAS'], ['aUsTiN']])(
    'ignores case and stray whitespace in %j',
    (query) => {
      expect(lookupUsCity(query)).toEqual(lookupUsCity('austin, tx'));
    }
  );
});

describe('refusals', () => {
  it.each([
    ['Austin, ME'],
    ['austin, california'],
    ['brooklyn, tx'],
    ['phoenix, me'],
    ['philadelphia, nv'],
  ])('returns null for %j rather than answering with the wrong state', (query) => {
    expect(resolvedName(query)).toBeNull();
  });

  it.each([['zzzznotacity'], [''], ['   '], ['!!!'], ['12345'], [','], ['austin, zz']])(
    'returns null for the unusable input %j',
    (query) => {
      expect(resolvedName(query)).toBeNull();
    }
  );
});

describe('famous non-US names', () => {
  it.each([['toronto'], ['london'], ['paris'], ['berlin'], ['moscow'], ['dublin']])(
    'refuses bare %j so a small US namesake cannot answer for it',
    (query) => {
      expect(resolvedName(query)).toBeNull();
    }
  );

  it.each([
    ['toronto, oh', 'Toronto, OH'],
    ['toronto ohio', 'Toronto, OH'],
    ['london, ky', 'London, KY'],
    ['paris, tx', 'Paris, TX'],
    ['berlin, nh', 'Berlin, NH'],
  ])('answers %j once the state pins it down', (query, expected) => {
    expect(resolvedName(query)).toBe(expected);
  });

  it('suppresses bare "birmingham" even though the US city has 212k people', () => {
    expect(resolvedName('birmingham')).toBeNull();
    expect(resolvedName('birmingham, al')).toBe('Birmingham, AL');
  });
});
