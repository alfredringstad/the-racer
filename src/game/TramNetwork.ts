import Phaser from 'phaser';
import { PALETTE, hex } from './palette';
import type { TiledMap } from './TrackMap';
import { drawLine as line, drawPolyline as polyline, offsetPolyline as offset, walkPolyline as walk } from './polyline';
import { TILE_SIZE, type Surface } from './tiles';

/** Standard gauge, in metres. */
const GAUGE_M = 1.435;
/** Sleeper spacing and overhang beyond the rails, in px (only drawn off-street). */
const SLEEPER_SPACING = 5;
const SLEEPER_OVERHANG = 3;

type Pt = { x: number; y: number };
type Seg = { a: Pt; b: Pt };

interface Track {
  centre: Pt[];
  rails: [Pt[], Pt[]];
  bounds: Phaser.Geom.Rectangle;
}

export interface TramStop {
  name: string;
  x: number;
  y: number;
}

/**
 * Tram tracks and stops from the map's `tram` object layer. Rails are drawn as crisp
 * 1px pixel lines (any angle) into a canvas per map chunk, so they follow the real
 * track geometry instead of a tile grid.
 */
export class TramNetwork {
  readonly tracks: Track[] = [];
  readonly stops: TramStop[] = [];
  /** 1 where a rail passes through the tile. */
  readonly railTiles: Uint8Array;
  private readonly halfGauge: number;
  /** Rail segments passing through each tile, for exact crossing tests. */
  private readonly railSegs = new Map<number, Seg[]>();
  private readonly width: number;
  private readonly height: number;

  constructor(
    map: TiledMap,
    metresPerTile: number,
    private readonly surfaceAt: (x: number, y: number) => Surface,
  ) {
    this.halfGauge = (GAUGE_M / (metresPerTile / TILE_SIZE)) / 2;
    this.railTiles = new Uint8Array(map.width * map.height);
    this.width = map.width;
    this.height = map.height;
    const objects = map.layers.find((l) => l.name === 'tram')?.objects ?? [];
    for (const o of objects) {
      if (o.type === 'stop') this.stops.push({ name: o.name, x: o.x, y: o.y });
      if (o.type !== 'track' || !o.polyline || o.polyline.length < 2) continue;
      const centre = o.polyline.map((p) => ({ x: o.x + p.x, y: o.y + p.y }));
      const rails: [Pt[], Pt[]] = [offset(centre, -this.halfGauge), offset(centre, this.halfGauge)];
      const xs = centre.map((p) => p.x);
      const ys = centre.map((p) => p.y);
      const pad = this.halfGauge + SLEEPER_OVERHANG + 2;
      const bounds = new Phaser.Geom.Rectangle(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2);
      this.tracks.push({ centre, rails, bounds });
      for (const rail of rails)
        for (let i = 1; i < rail.length; i++) {
          const seg = { a: rail[i - 1], b: rail[i] };
          walk([seg.a, seg.b], 2, (x, y) => {
            const c = Math.floor(x / TILE_SIZE);
            const r = Math.floor(y / TILE_SIZE);
            if (c < 0 || r < 0 || c >= map.width || r >= map.height) return;
            const k = r * map.width + c;
            this.railTiles[k] = 1;
            const list = this.railSegs.get(k);
            if (!list) this.railSegs.set(k, [seg]);
            else if (list[list.length - 1] !== seg) list.push(seg);
          });
        }
    }
  }

  /**
   * If the move from (x0, y0) to (x1, y1) crosses a rail, returns the rail's unit direction.
   * Moves are a few px per frame, so only the tiles around the start point are searched.
   */
  railCrossed(x0: number, y0: number, x1: number, y1: number): Pt | undefined {
    const c0 = Math.floor(x0 / TILE_SIZE);
    const r0 = Math.floor(y0 / TILE_SIZE);
    for (let r = r0 - 1; r <= r0 + 1; r++)
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        if (c < 0 || r < 0 || c >= this.width || r >= this.height) continue;
        for (const { a, b } of this.railSegs.get(r * this.width + c) ?? []) {
          if (!segmentsIntersect(x0, y0, x1, y1, a.x, a.y, b.x, b.y)) continue;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        }
      }
    return undefined;
  }

  /** Nearest stop within `radius` px. */
  stopNear(x: number, y: number, radius: number): TramStop | undefined {
    let best: TramStop | undefined;
    let bestD = radius;
    for (const s of this.stops) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) [best, bestD] = [s, d];
    }
    return best;
  }

  /**
   * Draws all rails crossing a chunk into a canvas texture and returns an image placed
   * over the chunk, or undefined if no track passes through it.
   */
  drawChunk(scene: Phaser.Scene, key: string, x0: number, y0: number, w: number, h: number): Phaser.GameObjects.Image | undefined {
    const area = new Phaser.Geom.Rectangle(x0, y0, w, h);
    const tracks = this.tracks.filter((t) => Phaser.Geom.Intersects.RectangleToRectangle(t.bounds, area));
    if (!tracks.length) return undefined;
    const tex = scene.textures.createCanvas(key, w, h)!;
    const ctx = tex.context;
    const plot = (colour: number) => {
      ctx.fillStyle = hex(colour);
      return (x: number, y: number) => {
        const px = Math.round(x - x0);
        const py = Math.round(y - y0);
        if (px >= 0 && py >= 0 && px < w && py < h) ctx.fillRect(px, py, 1, 1);
      };
    };

    // Sleepers where the track isn't set into a street.
    const sleeper = plot(PALETTE.sleeper);
    for (const t of tracks)
      walk(t.centre, SLEEPER_SPACING, (x, y, dx, dy) => {
        const s = this.surfaceAt(x, y);
        if (s === 'asphalt' || s === 'cobble') return;
        const len = this.halfGauge + SLEEPER_OVERHANG;
        line(x - dy * len, y + dx * len, x + dy * len, y - dx * len, sleeper);
      });
    // Rails: dark groove/shadow one pixel down, bright steel on top.
    const shadow = plot(PALETTE.railDark);
    for (const t of tracks) for (const rail of t.rails) polyline(rail, (x, y) => shadow(x, y + 1));
    const steel = plot(PALETTE.rail);
    for (const t of tracks) for (const rail of t.rails) polyline(rail, steel);

    tex.refresh();
    return scene.add.image(x0, y0, key).setOrigin(0).setDepth(1);
  }
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
