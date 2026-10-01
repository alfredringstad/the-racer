// Projection helpers: lat/lon → local metres (equirectangular around a centre
// point; plenty accurate for ~2 km) → rotated "grid" metres → tile coordinates.

import type { LatLon, OsmRelation } from './overpass';

export type Vec = [number, number];

export class Projection {
  private readonly kx: number;
  private readonly ky: number;
  private readonly cos: number;
  private readonly sin: number;

  /**
   * @param origin  centre of projection
   * @param rotationDeg  rotate the world clockwise by this much so that streets at this
   *                     bearing (CCW from east) become axis-aligned
   */
  constructor(
    readonly origin: LatLon,
    readonly rotationDeg = 0,
  ) {
    const phi = (origin.lat * Math.PI) / 180;
    this.ky = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    this.kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
    const a = (-rotationDeg * Math.PI) / 180;
    this.cos = Math.cos(a);
    this.sin = Math.sin(a);
  }

  /** Local metres, x east / y north, unrotated. */
  metres(p: LatLon): Vec {
    return [(p.lon - this.origin.lon) * this.kx, (p.lat - this.origin.lat) * this.ky];
  }

  /** Rotated metres: u ≈ along-grid "east", v ≈ along-grid "north". */
  project(p: LatLon): Vec {
    const [x, y] = this.metres(p);
    return [x * this.cos - y * this.sin, x * this.sin + y * this.cos];
  }

  unproject([u, v]: Vec): LatLon {
    // inverse rotation (rotate by +angle)
    const x = u * this.cos + v * this.sin;
    const y = -u * this.sin + v * this.cos;
    return { lat: this.origin.lat + y / this.ky, lon: this.origin.lon + x / this.kx };
  }
}

/**
 * Dominant street-grid orientation in degrees, in (-45, 45]. Histogram of segment
 * bearings modulo 90°, weighted by length; returns a weighted mean around the peak.
 */
export function dominantGridAngle(polylines: Vec[][]): number {
  const bins = new Float64Array(90);
  for (const line of polylines)
    for (let i = 1; i < line.length; i++) {
      const dx = line[i][0] - line[i - 1][0];
      const dy = line[i][1] - line[i - 1][1];
      const len = Math.hypot(dx, dy);
      const a = (((Math.atan2(dy, dx) * 180) / Math.PI) % 90 + 90) % 90;
      bins[Math.floor(a) % 90] += len;
    }
  let best = -1;
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += bins[(i + k + 90) % 90];
    if (s > best) [best, peak] = [s, i];
  }
  let sum = 0;
  let wsum = 0;
  for (let k = -3; k <= 3; k++) {
    const w = bins[(peak + k + 90) % 90];
    sum += (peak + k + 0.5) * w;
    wsum += w;
  }
  const angle = sum / wsum;
  return angle > 45 ? angle - 90 : angle;
}

/** Joins a relation's member ways into closed rings (outer and inner alike). */
export function relationRings(rel: OsmRelation): LatLon[][] {
  const pieces = rel.members
    .filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1 && (m.role === 'outer' || m.role === 'inner' || m.role === ''))
    .map((m) => [...m.geometry!]);
  const same = (a: LatLon, b: LatLon) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
  const rings: LatLon[][] = [];
  while (pieces.length) {
    const ring = pieces.pop()!;
    let grown = true;
    while (!same(ring[0], ring[ring.length - 1]) && grown) {
      grown = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (same(p[0], end)) ring.push(...p.slice(1));
        else if (same(p[p.length - 1], end)) ring.push(...p.reverse().slice(1));
        else continue;
        pieces.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}
