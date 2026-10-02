// Road signs placed from OSM data, on the right-hand side of the road for the traffic they're meant for:
//   - speed limit signs after junctions where maxspeed changes
//   - give way / stop signs at highway=give_way / highway=stop nodes
//   - one-way signs at the start of one-way streets, no-entry signs at their far end
//   - pedestrian crossing signs before marked zebra crossings
// Positions are map pixels. `spotOk` says whether a sign post can stand at a point (sidewalk, not
// blocked by trees, lamps or other signs); if not, nearby spots along the road are tried.

import { pointAlong, type Pt } from '../../src/game/polyline';
import { signFrame, type SignKind } from '../../src/game/signs';
import type { MarkingRoad } from './markings';

export interface Sign {
  /** Stable id for map-editor corrections (see Provenance in markings.ts). */
  key: string;
  /** Generator logic that placed it, e.g. sign.speed.change. */
  rule: string;
  /** OSM elements it was derived from. */
  osm: string[];
  kind: SignKind;
  x: number;
  y: number;
  /** Speed limit for kind 'speed'. */
  value?: number;
  /** Direction of travel of the traffic the sign is for (radians, 0 = east). */
  facing: number;
}

const MARKED_CROSSINGS = new Set(['marked', 'zebra', 'traffic_signals', 'uncontrolled']);
const NO_SIGN_HIGHWAYS = new Set(['pedestrian', 'service', 'track']);

export function buildSigns(
  roads: MarkingRoad[],
  specialNodes: Map<number, Record<string, string>>,
  mPerPx: number,
  spotOk: (x: number, y: number) => boolean,
): Sign[] {
  const m = (metres: number) => metres / mPerPx;
  const signs: Sign[] = [];
  const taken: Pt[] = [];
  const free = (x: number, y: number) => spotOk(x, y) && taken.every((p) => Math.hypot(p.x - x, p.y - y) > m(1.5));

  /**
   * Puts a sign beside `road`, `s` px along it, on the right of travel direction `travel` (1 = along the
   * point order, -1 = against it). Slides along the road and outwards to find a free spot.
   */
  const place = (road: MarkingRoad, s: number, travel: 1 | -1, kind: SignKind, value: number | undefined, anchor: string, rule: string) => {
    if (signFrame(kind, value) === undefined) return;
    for (const along of [0, m(2), -m(2), m(4), -m(4), m(6)])
      for (const out of [m(1.2), m(2), m(0.6)]) {
        const p = pointAlong(road.points, s + along * travel);
        const dx = p.dx * travel;
        const dy = p.dy * travel;
        const side = road.widthPx / 2 + out;
        const x = p.x - dy * side; // right of travel (y down)
        const y = p.y + dx * side;
        if (!free(x, y)) continue;
        taken.push({ x, y });
        const osm = [`way/${road.id}`, ...(anchor.startsWith('node/') ? [anchor] : [])];
        signs.push({
          key: `${kind}:way/${road.id}:${anchor}:${travel === 1 ? 'fwd' : 'bwd'}`,
          rule,
          osm,
          kind,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          value,
          facing: Math.atan2(dy, dx),
        });
        return;
      }
  };

  // Shared preprocessing: oneway=-1 reversed, distances along each road.
  const prepared = roads.map((raw) => {
    const reversed = raw.tags.oneway === '-1';
    const road = reversed ? { ...raw, nodes: [...raw.nodes].reverse(), points: [...raw.points].reverse() } : raw;
    const t = road.tags;
    const oneway = t.oneway === 'yes' || t.oneway === '-1';
    const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
    const dist = [0];
    for (let i = 1; i < road.points.length; i++)
      dist.push(dist[i - 1] + Math.hypot(road.points[i].x - road.points[i - 1].x, road.points[i].y - road.points[i - 1].y));
    const speed = Number.parseInt(t.maxspeed ?? '', 10);
    return { road, oneway: oneway || roundabout, roundabout, dist, total: dist[dist.length - 1], speed: Number.isFinite(speed) ? speed : undefined };
  });

  // Which roads meet at each node.
  const at = new Map<number, typeof prepared>();
  for (const p of prepared) for (const n of p.road.nodes) at.set(n, [...(at.get(n) ?? []), p]);
  const junctions = new Set<number>();
  for (const [n, list] of at) if (list.length > 1) junctions.add(n); // includes a road meeting itself (listed twice)
  const isJunction = (n: number) => junctions.has(n);
  const widestAt = (n: number) => Math.max(...(at.get(n) ?? []).map((p) => p.road.widthPx));

  for (const p of prepared) {
    const { road, oneway, dist, total } = p;
    if (NO_SIGN_HIGHWAYS.has(road.tags.highway) || total < m(12)) continue;
    const first = road.nodes[0];
    const last = road.nodes[road.nodes.length - 1];
    const startS = isJunction(first) ? widestAt(first) / 2 + m(3) : m(3);
    const endS = total - (isJunction(last) ? widestAt(last) / 2 + m(3) : m(3));

    // Speed limit: entering this road from a junction where some other road has a different limit.
    if (p.speed !== undefined) {
      const differs = (n: number) => (at.get(n) ?? []).some((q) => q !== p && q.speed !== undefined && q.speed !== p.speed);
      if (differs(first)) place(road, startS, 1, 'speed', p.speed, `node/${first}`, 'sign.speed.change');
      if (!oneway && differs(last)) place(road, endS, -1, 'speed', p.speed, `node/${last}`, 'sign.speed.change');
    }

    // One-way streets: "one way" where you enter, "no entry" facing anyone about to go in the wrong end.
    if (oneway && !p.roundabout) {
      if (isJunction(first)) place(road, startS, 1, 'oneway', undefined, `node/${first}`, 'sign.oneway.entry');
      if (isJunction(last)) place(road, endS, -1, 'no_entry', undefined, `node/${last}`, 'sign.no_entry.exit');
    }

    road.nodes.forEach((n, i) => {
      const tags = specialNodes.get(n);
      const kind = tags?.highway;
      // Give way / stop: for traffic heading into the junction (or past the node in its stated direction).
      if (kind === 'give_way' || kind === 'stop') {
        const dir = tags!.direction ?? tags!['traffic_signals:direction'];
        const back = m(2);
        if (isJunction(n)) {
          if (i > 0) place(road, dist[i] - widestAt(n) / 2 - back, 1, kind, undefined, `node/${n}`, `sign.${kind}.junction`);
          if (!oneway && i < road.nodes.length - 1) place(road, dist[i] + widestAt(n) / 2 + back, -1, kind, undefined, `node/${n}`, `sign.${kind}.junction`);
        } else if (dir === 'backward' && !oneway) place(road, dist[i] + back, -1, kind, undefined, `node/${n}`, `sign.${kind}.node`);
        else place(road, dist[i] - back, 1, kind, undefined, `node/${n}`, `sign.${kind}.node`);
      }
      // Pedestrian crossing signs before marked zebras, for each direction of traffic.
      if (kind === 'crossing') {
        const marked = MARKED_CROSSINGS.has(tags!.crossing ?? '') || ['yes', 'zebra'].includes(tags!['crossing:markings'] ?? '');
        const unmarked = ['unmarked', 'informal', 'no'].includes(tags!.crossing ?? '') || tags!['crossing:markings'] === 'no';
        if (!marked || unmarked) return;
        place(road, dist[i] - m(2.5), 1, 'crossing', undefined, `node/${n}`, 'sign.crossing.zebra');
        if (!oneway) place(road, dist[i] + m(2.5), -1, 'crossing', undefined, `node/${n}`, 'sign.crossing.zebra');
      }
    });
  }
  return signs;
}
