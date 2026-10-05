import { lookupUsCity, stateNameForCode } from '../us-cities.js';
import { LocationCoordinates } from '../../types.js';
import { LOCATION_DOC_ID, locationVariables } from './queries.js';
import { fetchGraphQL } from './transport.js';
import { Coordinates, LocationSearchData, PlaceNode } from './wire.js';

const CITY_PAGE_CACHE_MAX = 200;
const CITY_PAGE_MAX_MILES = 50;
const EARTH_RADIUS_MILES = 3958.8;

export class LocationResolver {
  private coordsCache: Map<string, LocationCoordinates> = new Map();
  private cityPageIdCache: Map<string, string> = new Map();

  async coordinates(query: string): Promise<LocationCoordinates | null> {
    const local = lookupUsCity(query);
    if (local) return local;

    const primaryKey = query.toLowerCase().trim();

    for (const candidate of lookupCandidates(query)) {
      const coords = await this.coordinatesExact(candidate);
      if (coords) {
        if (candidate !== primaryKey) this.coordsCache.set(primaryKey, coords);
        return coords;
      }
    }
    return null;
  }

  /** The Marketplace city page for a location, only ever one near `near`. */
  async cityPageId(location: string, near: LocationCoordinates): Promise<string | null> {
    const key = location.toLowerCase().trim();
    const cached = this.cityPageIdCache.get(key);
    if (cached) return cached;

    for (const candidate of lookupCandidates(location)) {
      const pageId = await nearbyCityPageId(candidate, near);
      if (pageId) {
        this.rememberCityPage(key, pageId);
        return pageId;
      }
    }
    return null;
  }

  private rememberCityPage(key: string, pageId: string): void {
    this.cityPageIdCache.set(key, pageId);
    if (this.cityPageIdCache.size > CITY_PAGE_CACHE_MAX) {
      const oldest = this.cityPageIdCache.keys().next().value;
      if (oldest !== undefined) this.cityPageIdCache.delete(oldest);
    }
  }

  private async coordinatesExact(cacheKey: string): Promise<LocationCoordinates | null> {
    const cached = this.coordsCache.get(cacheKey);
    if (cached) return cached;

    const coords = placeCoordinates(await lookUp(cacheKey));
    if (coords) this.coordsCache.set(cacheKey, coords);
    return coords;
  }
}

/** Facebook's places for a query. A lookup that fails is an error, never "no such place". */
async function lookUp(query: string): Promise<PlaceNode[]> {
  try {
    return await placesMatching(query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Looking up "${query}" on Facebook failed: ${reason}`, { cause: error });
  }
}

// Results are ranked by check-ins, so "phoenix" leads with a venue in South
// Africa and "sacramento" with a street in Portugal. Only real places carry
// the bare "City" subtitle.
function placeCoordinates(places: PlaceNode[]): LocationCoordinates | null {
  const node = places.find(isCity) ?? places[0];
  if (!node?.location) return null;
  const name = isCity(node) ? node.single_line_address : subtitleKind(node) || node.single_line_address;
  return { latitude: node.location.latitude, longitude: node.location.longitude, name: name ?? '' };
}

// Place names repeat across states, so "montclair" alone ranks Montclair,
// California above Montclair, New Jersey. A page far from the coordinates we
// already resolved is a different town, and searching it serves its listings.
async function nearbyCityPageId(query: string, near: LocationCoordinates): Promise<string | null> {
  try {
    const nearby = (await placesMatching(query))
      .flatMap((node) => {
        const pageId = node.page?.id;
        return pageId && node.location
          ? [{ node, pageId, miles: milesBetween(near, node.location) }]
          : [];
      })
      .filter(({ miles }) => miles <= CITY_PAGE_MAX_MILES)
      .sort((a, b) => a.miles - b.miles);
    const city = nearby.find(({ node }) => isCity(node)) ?? nearby[0];
    return city?.pageId ?? null;
  } catch {
    return null;
  }
}

async function placesMatching(query: string): Promise<PlaceNode[]> {
  const response = await fetchGraphQL<LocationSearchData>(LOCATION_DOC_ID, locationVariables(query));
  const edges = response.data?.city_street_search?.street_results?.edges ?? [];
  return edges.flatMap((edge) => (edge?.node ? [edge.node] : []));
}

/**
 * Facebook's city search is literal, and a "City, ST" query does not just
 * miss — "kansas city, mo" returns Mound City, Kansas. Spelling the state
 * out is the only form that reliably lands, so it replaces the code; the
 * bare city name is a last resort because "austin" is Austin, Illinois.
 */
export function lookupCandidates(query: string): string[] {
  const typed = query.toLowerCase().trim();
  const parts = typed.split(',').map((part) => part.trim());
  const city = parts[0];
  const state = parts.length > 1 ? stateNameForCode(parts[parts.length - 1]) : undefined;
  const preferred = state ? `${city}, ${state}` : typed;
  return [...new Set([preferred, city].filter(Boolean))];
}

function subtitleKind(node: PlaceNode): string | undefined {
  return node.subtitle?.split(' ·')[0];
}

function isCity(node: PlaceNode): boolean {
  return subtitleKind(node) === 'City';
}

function milesBetween(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(h));
}
