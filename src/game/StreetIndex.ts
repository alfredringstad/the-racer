import { prop, type TiledMap } from './TrackMap';

interface Segment {
  name: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  halfWidth: number;
}

interface Square {
  name: string;
  points: { x: number; y: number }[];
}

const CELL = 128;
/** How far outside a road's drawn width still counts as being on it (sidewalk, curbs). */
const SLACK = 12;
/** Another street must be this much closer before we switch to it (stops flicker at junctions). */
const HYSTERESIS = 10;

/**
 * Answers "which street am I on?" from the `streets` object layer: polylines for
 * roads (with their drawn width) and polygons for named squares.
 */
export class StreetIndex {
  private readonly buckets = new Map<string, Segment[]>();
  private readonly squares: Square[] = [];
  private current: string | undefined;

  constructor(map: TiledMap) {
    const objects = map.layers.find((l) => l.name === 'streets')?.objects ?? [];
    for (const o of objects) {
      if (o.polyline) {
        const halfWidth = (prop<number>(o.properties, 'widthPx') ?? 64) / 2;
        for (let i = 1; i < o.polyline.length; i++) {
          const a = o.polyline[i - 1];
          const b = o.polyline[i];
          this.add({ name: o.name, ax: o.x + a.x, ay: o.y + a.y, bx: o.x + b.x, by: o.y + b.y, halfWidth });
        }
      } else if (o.polygon) {
        this.squares.push({ name: o.name, points: o.polygon.map((p) => ({ x: o.x + p.x, y: o.y + p.y })) });
      }
    }
  }

  private add(seg: Segment) {
    const pad = seg.halfWidth + SLACK;
    const c0 = Math.floor((Math.min(seg.ax, seg.bx) - pad) / CELL);
    const c1 = Math.floor((Math.max(seg.ax, seg.bx) + pad) / CELL);
    const r0 = Math.floor((Math.min(seg.ay, seg.by) - pad) / CELL);
    const r1 = Math.floor((Math.max(seg.ay, seg.by) + pad) / CELL);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const key = `${c},${r}`;
        let list = this.buckets.get(key);
        if (!list) this.buckets.set(key, (list = []));
        list.push(seg);
      }
  }

  /** Name of the street (or square) at this position, or undefined if off-road. */
  at(x: number, y: number): string | undefined {
    // Distance beyond each street's edge; <= 0 means on the carriageway.
    const best = new Map<string, number>();
    for (const s of this.buckets.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? []) {
      const d = distToSegment(x, y, s) - s.halfWidth;
      if (d <= SLACK && d < (best.get(s.name) ?? Infinity)) best.set(s.name, d);
    }
    let name: string | undefined;
    let dist = Infinity;
    for (const [n, d] of best)
      if (d < dist) {
        name = n;
        dist = d;
      }
    // Stick with the current street unless the new one is clearly closer.
    const cur = this.current === undefined ? undefined : best.get(this.current);
    if (cur !== undefined && name !== this.current && cur - dist < HYSTERESIS) name = this.current;
    if (!name) name = this.squares.find((sq) => inPolygon(x, y, sq.points))?.name;
    this.current = name;
    return name;
  }
}

function distToSegment(x: number, y: number, s: Segment) {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
  return Math.hypot(x - s.ax - t * dx, y - s.ay - t * dy);
}

function inPolygon(x: number, y: number, pts: { x: number; y: number }[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
