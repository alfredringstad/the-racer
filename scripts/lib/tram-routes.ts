// Tram routes from OSM route=tram relations: each direction of each line becomes one continuous
// path (pixel coords, clipped to the map) with its stops as distances along that path.

import type { LatLon, OsmElement, OsmNode, OsmRelation, OsmWay } from './overpass';

export interface TramRoute {
  osmId: number;
  line: string;
  name: string;
  path: { x: number; y: number }[];
  stops: { name: string; d: number }[];
}

type Pt = { x: number; y: number };

/** A stop node counts as on the route if it's within this many px of the path. */
const STOP_SNAP_PX = 24;

const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;

/**
 * Chains a relation's way members in order, flipping each way so it continues from the previous
 * one. A gap (a way outside the fetched area) starts a new piece.
 */
function chain(ways: OsmWay[]): LatLon[][] {
  const pieces: LatLon[][] = [];
  let cur: LatLon[] = [];
  ways.forEach((w, i) => {
    let g = w.geometry;
    if (!cur.length) {
      // Orient the first way of a piece towards the next one.
      const next = ways[i + 1]?.geometry;
      if (next && (same(g[0], next[0]) || same(g[0], next[next.length - 1]))) g = [...g].reverse();
      cur = [...g];
      return;
    }
    const end = cur[cur.length - 1];
    if (same(g[0], end)) cur.push(...g.slice(1));
    else if (same(g[g.length - 1], end)) cur.push(...[...g].reverse().slice(1));
    else {
      pieces.push(cur);
      cur = [...g];
    }
  });
  if (cur.length) pieces.push(cur);
  return pieces;
}

const segLen = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Longest run of consecutive points inside the map. */
function clip(path: Pt[], inside: (p: Pt) => boolean): Pt[] {
  let best: Pt[] = [];
  let run: Pt[] = [];
  for (const p of [...path, undefined]) {
    if (p && inside(p)) run.push(p);
    else {
      const len = run.slice(1).reduce((s, q, i) => s + segLen(run[i], q), 0);
      const bestLen = best.slice(1).reduce((s, q, i) => s + segLen(best[i], q), 0);
      if (len > bestLen) best = run;
      run = [];
    }
  }
  return best;
}

/** Distance along `path` of the point nearest to `p`, and how far away that point is. */
function project(path: Pt[], p: Pt): { d: number; off: number } {
  let best = { d: 0, off: Infinity };
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = segLen(a, b);
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len))) : 0;
    const off = Math.hypot(a.x + (b.x - a.x) * t - p.x, a.y + (b.y - a.y) * t - p.y);
    if (off < best.off) best = { d: acc + len * t, off };
    acc += len;
  }
  return best;
}

export function buildTramRoutes(els: OsmElement[], toPx: (p: LatLon) => Pt, inside: (p: Pt) => boolean): TramRoute[] {
  const ways = new Map<number, OsmWay>();
  const nodes = new Map<number, OsmNode>();
  for (const e of els) {
    if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'node') nodes.set(e.id, e);
  }
  const routes: TramRoute[] = [];
  const relations = els.filter((e): e is OsmRelation => e.type === 'relation' && e.tags?.route === 'tram' && !!e.tags.ref);
  for (const rel of relations.sort((a, b) => a.id - b.id)) {
    const members = rel.members.filter((m) => m.type === 'way' && (m.role === '' || m.role === 'forward'));
    const pieces = chain(members.map((m) => ways.get(m.ref)).filter((w): w is OsmWay => !!w && w.geometry.length > 1));
    // Pixel paths, rounded to 0.1 px so the output stays stable; keep the longest stretch on the map.
    const path = pieces
      .map((piece) => clip(piece.map(toPx).map(({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })), inside))
      .reduce((a, b) => (b.length > a.length ? b : a), [] as Pt[]);
    if (path.length < 2) continue;
    const stops = rel.members
      .filter((m) => m.type === 'node' && m.role.startsWith('stop'))
      .map((m) => nodes.get(m.ref))
      .filter((n): n is OsmNode => !!n?.tags?.name)
      .map((n) => ({ name: n.tags!.name, ...project(path, toPx(n)) }))
      .filter((s) => s.off <= STOP_SNAP_PX)
      .map((s) => ({ name: s.name, d: Math.round(s.d * 10) / 10 }))
      .sort((a, b) => a.d - b.d);
    routes.push({ osmId: rel.id, line: rel.tags!.ref, name: rel.tags!.name ?? `Linje ${rel.tags!.ref}`, path, stops });
  }
  return routes;
}
