// Maps OSM tags to building styles and storefront facades. This is the place to
// tweak when a building or shop is drawn the wrong way.

import type { BuildingStyle, Facade } from '../../src/game/tiles';

type Tags = Record<string, string> | undefined;

const CHURCH_BUILDINGS = new Set(['church', 'chapel', 'cathedral', 'basilica', 'religious', 'mosque', 'synagogue', 'temple']);
const CIVIC_BUILDINGS = new Set([
  'civic', 'public', 'government', 'townhall', 'school', 'university', 'college', 'library', 'museum', 'theatre',
  'hospital', 'train_station', 'transportation', 'fire_station', 'kindergarten', 'courthouse', 'concert_hall',
]);
const CIVIC_AMENITIES = new Set([
  'townhall', 'library', 'theatre', 'cinema', 'arts_centre', 'school', 'university', 'college', 'hospital', 'police',
  'fire_station', 'courthouse', 'concert_hall', 'conference_centre',
]);
const INDUSTRIAL_BUILDINGS = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'service', 'hangar', 'storage_tank', 'boathouse']);
const COMMERCIAL_BUILDINGS = new Set(['commercial', 'retail', 'office', 'supermarket', 'kiosk', 'hotel', 'mall', 'department_store', 'parking']);

/** Style for a whole building, from the building's own tags (and whether it contains a place of worship). */
export function buildingStyle(tags: Tags, containsPlaceOfWorship: boolean): BuildingStyle {
  const b = tags?.building ?? 'yes';
  const amenity = tags?.amenity ?? '';
  if (CHURCH_BUILDINGS.has(b) || amenity === 'place_of_worship' || containsPlaceOfWorship) return 'church';
  if (CIVIC_BUILDINGS.has(b) || CIVIC_AMENITIES.has(amenity) || ['museum', 'gallery'].includes(tags?.tourism ?? '')) return 'civic';
  if (INDUSTRIAL_BUILDINGS.has(b)) return 'industrial';
  if (COMMERCIAL_BUILDINGS.has(b) || (tags?.shop && tags.shop !== 'vacant') || tags?.tourism === 'hotel') return 'commercial';
  return 'residential';
}

/** Storefront for a point of interest, or undefined if it doesn't get one. */
export function poiFacade(tags: Tags): Facade | undefined {
  const amenity = tags?.amenity ?? '';
  if (['restaurant', 'fast_food', 'food_court', 'ice_cream'].includes(amenity)) return 'restaurant';
  if (amenity === 'cafe') return 'cafe';
  if (['bar', 'pub', 'biergarten', 'nightclub'].includes(amenity)) return 'bar';
  if (tags?.shop && tags.shop !== 'vacant') return 'shop';
  return undefined;
}

/** POIs that get outdoor tables when there's no visible facade to hang an awning on. */
export const hasOutdoorSeating = (f: Facade | undefined) => f === 'restaurant' || f === 'cafe' || f === 'bar';

/** Overpass clauses for the POI nodes we care about. */
export const POI_QUERY = `
  node["amenity"~"^(restaurant|fast_food|food_court|ice_cream|cafe|bar|pub|biergarten|nightclub|place_of_worship)$"];
  node["shop"];`;
