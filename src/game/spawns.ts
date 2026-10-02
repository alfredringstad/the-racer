import { prop, type TiledMap } from './TrackMap';

/**
 * Starting places at well-known spots in central Norrköping. Each is a clear stretch of street
 * near the landmark, in the right-hand lane and facing the legal way on one-way streets.
 * Positions are lat/lon so they survive the map being regenerated; `headingDeg` is in the game's
 * rotated street grid (0 = east along the grid, 90 = south).
 */
export interface StartPlace {
  name: string;
  lat: number;
  lon: number;
  headingDeg: number;
}

export const START_PLACES: readonly StartPlace[] = [
  { name: 'RESECENTRUM', lat: 58.595958, lon: 16.182695, headingDeg: 180 }, // Norra Promenaden, by the station
  { name: 'RÅDHUSET', lat: 58.592197, lon: 16.18615, headingDeg: 0 }, // Nya Rådstugugatan, by the city hall
  { name: 'GAMLA TORGET', lat: 58.588379, lon: 16.185907, headingDeg: -178 }, // the old market square by Motala ström
  { name: 'INDUSTRILANDSKAPET', lat: 58.587857, lon: 16.181171, headingDeg: -107 }, // Kvarngatan at Holmentorget
  { name: 'KRISTINAPLATSEN', lat: 58.584103, lon: 16.190271, headingDeg: 90 }, // by Norrköpings konstmuseum
];

/**
 * lat/lon → map pixels, using the projection stored in the map's properties. Same maths as
 * Projection in scripts/lib/geo.ts (equirectangular around the origin, rotated onto the grid).
 */
export function latLonToPx(map: TiledMap, lat: number, lon: number): { x: number; y: number } {
  const p = (n: string) => prop<number>(map.properties, n) ?? 0;
  const lat0 = p('originLat');
  const phi = (lat0 * Math.PI) / 180;
  const ky = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const mx = (lon - p('originLon')) * kx;
  const my = (lat - lat0) * ky;
  const a = (-p('gridRotationDeg') * Math.PI) / 180;
  const u = mx * Math.cos(a) - my * Math.sin(a);
  const v = mx * Math.sin(a) + my * Math.cos(a);
  const mpt = p('metresPerTile') || 2.25;
  return { x: ((u - p('frameMinU')) / mpt) * 16, y: ((p('frameMaxV') - v) / mpt) * 16 };
}
