// Road markings inferred from OSM road tags (OSM doesn't map paint itself):
//   - centre lines on two-way roads, lane dividers from lanes=*, bike lanes from cycleway=lane
//   - stop lines at traffic signals / stop signs, "shark teeth" at give-way signs
//   - zebra crossings at marked highway=crossing nodes
//   - turn arrows from turn:lanes before junctions
// Lines stop short of junctions and crossings. Swedish conventions: white paint, traffic on the right.
// Everything here is in map pixels; `mPerPx` converts real-world sizes.

import { offsetPolyline, pointAlong, slicePolyline, type Pt } from '../../src/game/polyline';

export interface MarkingRoad {
  id: number;
  nodes: number[];
  points: Pt[]; // px, same length as nodes
  tags: Record<string, string>;
  widthPx: number;
}

export type Marking =
  | { kind: 'line'; points: Pt[]; dash: number; gap: number; style: 'centre' | 'lane' | 'bike' }
  | { kind: 'stop'; points: [Pt, Pt]; width: number }
  | { kind: 'giveway'; points: [Pt, Pt]; towards: Pt } // teeth point towards `towards` (approaching traffic)
  | { kind: 'zebra'; points: [Pt, Pt]; depth: number } // a→b spans the road; stripes run along the road
  | { kind: 'arrow'; x: number; y: number; angle: number; turn: string };

const NO_PAINT_HIGHWAYS = new Set(['pedestrian', 'living_street', 'service', 'track']);
const MAJOR = new Set(['primary', 'secondary', 'tertiary', 'trunk', 'motorway']);
const COBBLE = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones', 'stone']);
const MARKED_CROSSINGS = new Set(['marked', 'zebra', 'traffic_signals', 'uncontrolled']);

export function buildMarkings(roads: MarkingRoad[], specialNodes: Map<number, Record<string, string>>, mPerPx: number): Marking[] {
  const m = (metres: number) => metres / mPerPx;
  const out: Marking[] = [];

  // Junctions: nodes used by more than one road (or twice by the same one), with the widest road there.
  const uses = new Map<number, number>();
  const widest = new Map<number, number>();
  for (const r of roads)
    for (const n of r.nodes) {
      uses.set(n, (uses.get(n) ?? 0) + 1);
      widest.set(n, Math.max(widest.get(n) ?? 0, r.widthPx));
    }
  const isJunction = (n: number) => (uses.get(n) ?? 0) > 1;
  const isCrossing = (n: number) => specialNodes.get(n)?.highway === 'crossing';

  for (const raw of roads) {
    if (raw.points.length < 2) continue;
    // Normalise oneway=-1 so "forward" is always along the point order.
    const reversed = raw.tags.oneway === '-1';
    const road = reversed ? { ...raw, nodes: [...raw.nodes].reverse(), points: [...raw.points].reverse() } : raw;
    const t = road.tags;
    const oneway = t.oneway === 'yes' || t.oneway === '-1' || t.junction === 'roundabout' || t.junction === 'circular';
    const half = road.widthPx / 2;
    const cobbled = COBBLE.has(t.surface ?? '') || t.highway === 'pedestrian' || t.highway === 'living_street';
    const painted = !cobbled && !NO_PAINT_HIGHWAYS.has(t.highway) && t.lane_markings !== 'no' && road.widthPx >= m(6);
    const lanes = Math.max(1, Number.parseInt(t.lanes ?? '', 10) || (oneway ? 1 : 2));
    const fwdLanes = oneway ? lanes : Math.max(1, Number.parseInt(t['lanes:forward'] ?? '', 10) || Math.ceil(lanes / 2));
    const bwdLanes = oneway ? 0 : Math.max(1, lanes - fwdLanes);

    // Distance along the road of every node.
    const dist: number[] = [0];
    for (let i = 1; i < road.points.length; i++)
      dist.push(dist[i - 1] + Math.hypot(road.points[i].x - road.points[i - 1].x, road.points[i].y - road.points[i - 1].y));
    const total = dist[dist.length - 1];

    // --- Longitudinal lines, cut into pieces between junctions/crossings and trimmed back from them.
    const offsets: { d: number; dash: number; gap: number; style: 'centre' | 'lane' | 'bike' }[] = [];
    if (painted) {
      if (!oneway && (lanes >= 2 || MAJOR.has(t.highway))) offsets.push({ d: 0, dash: m(3), gap: m(6), style: 'centre' });
      const laneDash = { dash: m(3), gap: m(9) };
      if (oneway) for (let k = 1; k < lanes; k++) offsets.push({ d: -half + (k * road.widthPx) / lanes, ...laneDash, style: 'lane' });
      else {
        for (let k = 1; k < fwdLanes; k++) offsets.push({ d: (k * half) / fwdLanes, ...laneDash, style: 'lane' });
        for (let k = 1; k < bwdLanes; k++) offsets.push({ d: -(k * half) / bwdLanes, ...laneDash, style: 'lane' });
      }
    }
    if (!cobbled) {
      const bike = (side: 'left' | 'right') =>
        t[`cycleway:${side}`] === 'lane' || t['cycleway:both'] === 'lane' || (t.cycleway === 'lane' && (side === 'right' || !oneway));
      const inset = Math.min(m(1.6), half * 0.4);
      if (bike('right')) offsets.push({ d: half - inset, dash: m(1), gap: m(1), style: 'bike' });
      if (bike('left')) offsets.push({ d: -(half - inset), dash: m(1), gap: m(1), style: 'bike' });
    }
    if (offsets.length) {
      const cuts = [0];
      for (let i = 1; i < road.nodes.length - 1; i++) if (isJunction(road.nodes[i]) || isCrossing(road.nodes[i])) cuts.push(i);
      cuts.push(road.nodes.length - 1);
      const clearance = (i: number) => {
        const n = road.nodes[i];
        if (isJunction(n)) return (widest.get(n) ?? road.widthPx) / 2 + m(1.5);
        if (isCrossing(n)) return m(3);
        return 0;
      };
      for (let k = 1; k < cuts.length; k++) {
        const s0 = dist[cuts[k - 1]] + clearance(cuts[k - 1]);
        const s1 = dist[cuts[k]] - clearance(cuts[k]);
        if (s1 - s0 < m(4)) continue;
        const piece = slicePolyline(road.points, s0, s1);
        for (const o of offsets) out.push({ kind: 'line', points: offsetPolyline(piece, o.d), dash: o.dash, gap: o.gap, style: o.style });
      }
    }

    // A transverse line across [from, to] (offsets from the centreline) at distance s along the road.
    const across = (s: number, from: number, to: number): [Pt, Pt] => {
      const p = pointAlong(road.points, s);
      const nx = -p.dy;
      const ny = p.dx;
      return [
        { x: p.x + nx * from, y: p.y + ny * from },
        { x: p.x + nx * to, y: p.y + ny * to },
      ];
    };

    // --- Stop lines and give-way teeth.
    road.nodes.forEach((n, i) => {
      const tags = specialNodes.get(n);
      const kind = tags?.highway;
      if (kind !== 'traffic_signals' && kind !== 'stop' && kind !== 'give_way') return;
      const dir = tags!['traffic_signals:direction'] ?? tags!.direction;
      // Which side of the road gets the line: approaching traffic. At a junction node, each approach
      // gets its own line set back from the junction.
      const lines: { s: number; from: number; to: number; travel: 1 | -1 }[] = [];
      const back = (widest.get(n) ?? road.widthPx) / 2 + m(1);
      if (isJunction(n)) {
        if (i > 0 && dist[i] - back > 0) lines.push({ s: dist[i] - back, from: oneway ? -half : 0, to: half, travel: 1 });
        if (!oneway && i < road.nodes.length - 1 && dist[i] + back < total) lines.push({ s: dist[i] + back, from: -half, to: 0, travel: -1 });
      } else if (dir === 'backward' && !oneway) lines.push({ s: dist[i], from: -half, to: 0, travel: -1 });
      else if (dir === 'forward' || oneway) lines.push({ s: dist[i], from: oneway ? -half : 0, to: half, travel: 1 });
      else lines.push({ s: dist[i], from: -half, to: half, travel: 1 });
      for (const l of lines) {
        const pts = across(l.s, l.from + 1, l.to - 1);
        if (kind === 'give_way') {
          const p = pointAlong(road.points, l.s);
          out.push({ kind: 'giveway', points: pts, towards: { x: -p.dx * l.travel, y: -p.dy * l.travel } });
        } else out.push({ kind: 'stop', points: pts, width: Math.max(2, Math.round(m(0.4))) });
      }
    });

    // --- Zebra crossings.
    road.nodes.forEach((n, i) => {
      const tags = specialNodes.get(n);
      if (tags?.highway !== 'crossing') return;
      const marked = MARKED_CROSSINGS.has(tags.crossing ?? '') || ['yes', 'zebra'].includes(tags['crossing:markings'] ?? '') || tags.crossing_ref === 'zebra';
      const unmarked = ['unmarked', 'informal', 'no'].includes(tags.crossing ?? '') || tags['crossing:markings'] === 'no';
      if (!marked || unmarked) return;
      out.push({ kind: 'zebra', points: across(dist[i], -half + 1, half - 1), depth: m(3) });
    });

    // --- Turn arrows from turn:lanes, a little before the junction the lanes lead to.
    const arrows = (value: string | undefined, travel: 1 | -1, laneCentres: number[]) => {
      if (!value || !painted) return;
      const turns = value.split('|');
      if (turns.length !== laneCentres.length) return;
      // Travel forward → junction at the end; backward → junction at the start.
      const endNode = travel === 1 ? road.nodes[road.nodes.length - 1] : road.nodes[0];
      if (!isJunction(endNode) || total < m(20)) return;
      const back = (widest.get(endNode) ?? road.widthPx) / 2 + m(9);
      const s = travel === 1 ? total - back : back;
      const p = pointAlong(road.points, s);
      turns.forEach((turn, k) => {
        if (!turn || turn === 'none') return;
        const off = laneCentres[k];
        out.push({ kind: 'arrow', x: p.x - p.dy * off, y: p.y + p.dx * off, angle: Math.atan2(p.dy * travel, p.dx * travel), turn });
      });
    };
    // Lanes are listed left to right as seen by the driver.
    if (oneway) arrows(t['turn:lanes'], 1, Array.from({ length: lanes }, (_, k) => -half + ((k + 0.5) * road.widthPx) / lanes));
    else {
      arrows(t['turn:lanes:forward'], 1, Array.from({ length: fwdLanes }, (_, k) => ((k + 0.5) * half) / fwdLanes));
      arrows(t['turn:lanes:backward'], -1, Array.from({ length: bwdLanes }, (_, k) => -((k + 0.5) * half) / bwdLanes));
    }
  }
  return out;
}

