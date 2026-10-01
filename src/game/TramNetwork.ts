import Phaser from 'phaser';
import { PALETTE, hex } from './palette';
import type { TiledMap } from './TrackMap';
import { TILE_SIZE, type Surface } from './tiles';

/** Standard gauge, in metres. */
const GAUGE_M = 1.435;
/** Sleeper spacing and overhang beyond the rails, in px (only drawn off-street). */
const SLEEPER_SPACING = 5;
const SLEEPER_OVERHANG = 3;

type Pt = { x: number; y: number };

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

  constructor(
    map: TiledMap,
    metresPerTile: number,
    private readonly surfaceAt: (x: number, y: number) => Surface,
  ) {
    this.halfGauge = (GAUGE_M / (metresPerTile / TILE_SIZE)) / 2;
    this.railTiles = new Uint8Array(map.width * map.height);
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
        walk(rail, 2, (x, y) => {
          const c = Math.floor(x / TILE_SIZE);
          const r = Math.floor(y / TILE_SIZE);
          if (c >= 0 && r >= 0 && c < map.width && r < map.height) this.railTiles[r * map.width + c] = 1;
        });
    }
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

/** Offsets a polyline sideways by `d` px (positive = right of travel, y down), with mitred joins. */
function offset(pts: Pt[], d: number): Pt[] {
  const normal = (a: Pt, b: Pt) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  };
  return pts.map((p, i) => {
    const n1 = normal(pts[Math.max(0, i - 1)], pts[Math.max(1, i)]);
    const n2 = normal(pts[Math.min(i, pts.length - 2)], pts[Math.min(i + 1, pts.length - 1)]);
    let mx = n1.x + n2.x;
    let my = n1.y + n2.y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const scale = Math.min(2, 1 / Math.max(0.5, mx * n1.x + my * n1.y)); // clamp very sharp corners
    return { x: p.x + mx * d * scale, y: p.y + my * d * scale };
  });
}

/** Calls `fn` every `step` px along a polyline with the unit direction. */
function walk(pts: Pt[], step: number, fn: (x: number, y: number, dx: number, dy: number) => void) {
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    let d = carry;
    for (; d < len; d += step) fn(a.x + dx * d, a.y + dy * d, dx, dy);
    carry = d - len;
  }
}

function polyline(pts: Pt[], plot: (x: number, y: number) => void) {
  for (let i = 1; i < pts.length; i++) line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, plot);
}

/** Bresenham between rounded endpoints: gap-free 1px lines. */
function line(ax: number, ay: number, bx: number, by: number, plot: (x: number, y: number) => void) {
  let x = Math.round(ax);
  let y = Math.round(ay);
  const x1 = Math.round(bx);
  const y1 = Math.round(by);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
