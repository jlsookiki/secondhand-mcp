/**
 * Offline US city lookup.
 *
 * Facebook's location search ranks by check-ins, so bare city names land on
 * whatever is popular rather than what was asked for: "phoenix" returns a
 * venue in South Africa, "sacramento" a street in Portugal. Resolving US
 * cities from GeoNames data instead is deterministic, and picking the most
 * populous match is the disambiguation Facebook is missing.
 *
 * Data: geonames.org, CC BY 4.0, via the all-the-cities package.
 */

import allCities from 'all-the-cities';
import { LocationCoordinates } from '../types.js';

const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

/**
 * Shorthand people type that is not a place name in any dataset. Values are
 * GeoNames names, so they resolve through the same index as anything else.
 */
const CITY_ALIASES: Record<string, string> = {
  nyc: 'new york city', 'new york': 'new york city', 'ny city': 'new york city',
  sf: 'san francisco', 'the city': 'san francisco',
  la: 'los angeles', lax: 'los angeles',
  dc: 'washington dc', philly: 'philadelphia', vegas: 'las vegas',
  nola: 'new orleans', atl: 'atlanta', chi: 'chicago',
  'the bay': 'san francisco', 'bay area': 'san francisco',
};

interface CityRecord {
  name: string;
  state: string;
  latitude: number;
  longitude: number;
  population: number;
}

let index: Map<string, CityRecord> | null = null;
/** Largest population anywhere carrying each name, US or not. */
let worldMax: Map<string, number> | null = null;

function buildIndex(): Map<string, CityRecord> {
  const idx = new Map<string, CityRecord>();
  const world = new Map<string, number>();

  for (const c of allCities) {
    const worldKey = keyify(c.name);
    if ((world.get(worldKey) ?? 0) < c.population) world.set(worldKey, c.population);
    if (c.country !== 'US') continue;
    const rec: CityRecord = {
      name: c.name,
      state: c.adminCode,
      latitude: c.loc.coordinates[1],
      longitude: c.loc.coordinates[0],
      population: c.population,
    };
    const name = keyify(c.name);

    // Most populous wins both the bare name and the name+state key, which is
    // what makes "portland" Oregon and "springfield" Missouri.
    for (const key of [name, `${name}|${String(c.adminCode).toLowerCase()}`]) {
      const cur = idx.get(key);
      if (!cur || rec.population > cur.population) idx.set(key, rec);
    }
  }

  worldMax = world;
  return idx;
}

function normalize(query: string): string {
  return query.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

/** GeoNames carries punctuation ("St. Louis", "Washington, D.C.") that nobody
 *  types consistently, so keys and queries are flattened the same way. */
function keyify(value: string): string {
  return normalize(value).replace(/,/g, '').replace(/\s+/g, ' ').trim();
}

/** Split "austin, tx" / "austin texas" into city and two-letter state. */
function splitCityState(q: string): { city: string; state?: string } {
  const comma = q.lastIndexOf(',');
  if (comma > 0) {
    const tail = q.slice(comma + 1).trim();
    const code = tail.length === 2 ? tail.toUpperCase() : STATE_CODES[tail];
    if (code) return { city: q.slice(0, comma).trim(), state: code };
  }

  // No comma: peel the longest trailing state name, then a bare code.
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (q.endsWith(` ${name}`)) {
      return { city: q.slice(0, q.length - name.length - 1).trim(), state: code };
    }
  }
  const m = q.match(/^(.+?)\s+([a-z]{2})$/);
  if (m && Object.values(STATE_CODES).includes(m[2].toUpperCase())) {
    return { city: m[1].trim(), state: m[2].toUpperCase() };
  }

  return { city: q };
}

export function lookupUsCity(query: string): LocationCoordinates | null {
  if (!index) index = buildIndex();

  const q = normalize(query);
  const { city, state } = splitCityState(q);
  const name = keyify(CITY_ALIASES[keyify(city)] ?? city);

  const hit =
    (state && index.get(`${name}|${state.toLowerCase()}`)) ||
    // "washington dc" parses as city "washington" + state DC, but GeoNames
    // calls it "Washington, D.C." — retry the whole query as one name.
    (state && index.get(keyify(CITY_ALIASES[keyify(q)] ?? q))) ||
    (!state ? index.get(name) : undefined);
  if (!hit) return null;

  // Bare "toronto" means Ontario, not the town of 5,000 in Ohio. Without a
  // state, only answer when the US city is the largest of that name anywhere.
  if (!state && (worldMax?.get(keyify(hit.name)) ?? 0) > hit.population) return null;

  // A state was named but that city does not exist there; better to let the
  // caller fall through than to answer with a city in the wrong state.
  if (state && hit.state !== state) return null;

  // "Washington, D.C." already carries its state; don't render it twice.
  const carriesState = keyify(hit.name).endsWith(` ${keyify(hit.state)}`);

  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    name: carriesState ? hit.name : `${hit.name}, ${hit.state}`,
  };
}
