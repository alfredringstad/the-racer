import Phaser from 'phaser';
import type { TramLights } from './Lighting';
import { prop, type TiledMap } from './TrackMap';

/** Articulated tram: sections drawn along the track so it bends through curves. Lengths in px. */
const SECTIONS = 3;
const SECTION_LEN = 56;
const SECTION_GAP = 2;
const TRAM_LEN = SECTIONS * SECTION_LEN + (SECTIONS - 1) * SECTION_GAP;
const TRAM_HALF_WIDTH = 7;

// Driving (px/s, px/s²). ~80 px/s is about 40 km/h on the HUD.
const MAX_SPEED = 80;
const ACCEL = 28;
const SERVICE_DECEL = 40;
const EMERGENCY_DECEL = 140;
/** Seconds at each stop (varies per stop between these). */
const DWELL_MIN = 7;
const DWELL_MAX = 13;
/** Gap kept to whatever is ahead on the track (px). */
const SAFETY_GAP = 18;
/** Something within this many px of the track centreline counts as on the track. */
const TRACK_CLEARANCE = 13;
/** Seconds between trams on each route, and how many are already out on a route at the start. */
const HEADWAY = 80;
const INITIAL_PER_ROUTE = 2;
const FADE_PX = 120;

type Pt = { x: number; y: number };

class RoutePath {
  readonly cum: number[] = [0];
  readonly length: number;

  constructor(
    readonly line: string,
    readonly name: string,
    readonly pts: Pt[],
    readonly stops: { name: string; d: number }[],
  ) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    this.length = this.cum[this.cum.length - 1];
  }

  /** Point at distance `d` along the path (clamped, extrapolated a little past the ends). */
  at(d: number): Pt {
    const pts = this.pts;
    let i = 1;
    if (d >= this.length) i = pts.length - 1;
    else if (d > 0) {
      let lo = 1;
      let hi = pts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.cum[mid] < d) lo = mid + 1;
        else hi = mid;
      }
      i = lo;
    }
    const a = pts[i - 1];
    const b = pts[i];
    const seg = this.cum[i] - this.cum[i - 1] || 1;
    const t = (d - this.cum[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
}

/** Oriented box of one tram section, for collision. */
interface Box {
  x: number;
  y: number;
  c: number;
  s: number;
}

class Tram {
  /** Distance of the front along the route. */
  d: number;
  v = 0;
  dwell = 0;
  nextStop = 0;
  /** Braking because something is on the track ahead (true when it's the player). */
  blockedByPlayer = false;
  boxes: Box[] = [];
  readonly sprites: Phaser.GameObjects.Image[] = [];
  readonly shadows: Phaser.GameObjects.Image[] = [];

  constructor(
    scene: Phaser.Scene,
    readonly route: RoutePath,
    d: number,
    readonly seed: number,
  ) {
    this.d = d;
    this.nextStop = route.stops.findIndex((s) => this.stopTarget(s.d) > d);
    if (this.nextStop < 0) this.nextStop = route.stops.length;
    for (let i = 0; i < SECTIONS; i++) {
      const key = i === 0 || i === SECTIONS - 1 ? 'tram-cab' : 'tram-mid';
      this.shadows.push(scene.add.image(0, 0, key).setTintMode(Phaser.TintModes.FILL).setTint(0x2b2a3a).setAlpha(0.35).setDepth(9));
      this.sprites.push(scene.add.image(0, 0, key).setDepth(10.5));
    }
    this.place();
  }

  /** Front position that puts the middle of the tram at a stop. */
  stopTarget(stopD: number) {
    return Math.min(this.route.length + TRAM_LEN, stopD + TRAM_LEN / 2);
  }

  get rear() {
    return this.d - TRAM_LEN;
  }

  /** Positions every section between its front and back points on the track, so the tram bends. */
  place() {
    const r = this.route;
    // Fade in at the start of the route and out at the end (they're at the map edge).
    const alpha = Phaser.Math.Clamp(Math.min(this.d / FADE_PX, (r.length + TRAM_LEN - this.d) / FADE_PX), 0, 1);
    this.boxes = [];
    for (let i = 0; i < SECTIONS; i++) {
      const front = this.d - i * (SECTION_LEN + SECTION_GAP);
      const a = r.at(front);
      const b = r.at(front - SECTION_LEN);
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;
      const angle = Math.atan2(a.y - b.y, a.x - b.x);
      // The last section is a cab facing backwards.
      const rot = i === SECTIONS - 1 ? angle + Math.PI : angle;
      this.sprites[i].setPosition(Math.round(x), Math.round(y)).setRotation(rot).setAlpha(alpha);
      this.shadows[i].setPosition(Math.round(x) + 1, Math.round(y) + 2).setRotation(rot).setAlpha(0.35 * alpha);
      this.boxes.push({ x, y, c: Math.cos(angle), s: Math.sin(angle) });
    }
  }

  contains(x: number, y: number, pad = 0) {
    for (const b of this.boxes) {
      const dx = x - b.x;
      const dy = y - b.y;
      if (Math.abs(dx * b.c + dy * b.s) <= SECTION_LEN / 2 + pad && Math.abs(-dx * b.s + dy * b.c) <= TRAM_HALF_WIDTH + pad) return true;
    }
    return false;
  }

  /** Headlight position and heading plus section centres, for night lighting. */
  get lights(): TramLights {
    const b = this.boxes[0];
    return {
      front: { x: b.x + b.c * (SECTION_LEN / 2), y: b.y + b.s * (SECTION_LEN / 2), angle: Math.atan2(b.s, b.c) },
      sections: this.boxes,
      alpha: this.sprites[0].alpha,
    };
  }

  destroy() {
    for (const o of [...this.sprites, ...this.shadows]) o.destroy();
  }
}

/** Something on the road the trams should look out for (the player). */
export interface TrackObstacle {
  x: number;
  y: number;
}

/**
 * NPC trams running the map's `tramRoutes`: they enter at the edge of the map, stop at every
 * stop on their line, brake for anything on the track ahead and leave at the other edge.
 */
export class TramTraffic {
  readonly trams: Tram[] = [];
  private readonly routes: RoutePath[];
  private readonly spawnTimers: number[];
  private serial = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    map: TiledMap,
    lines: readonly string[],
  ) {
    this.routes = (map.layers.find((l) => l.name === 'tramRoutes')?.objects ?? [])
      .filter((o) => o.type === 'route' && o.polyline && lines.includes(prop<string>(o.properties, 'line') ?? ''))
      .map((o) => {
        const stops = JSON.parse(prop<string>(o.properties, 'stops') ?? '[]') as { name: string; d: number }[];
        return new RoutePath(prop<string>(o.properties, 'line')!, o.name, o.polyline!.map((p) => ({ x: o.x + p.x, y: o.y + p.y })), stops);
      });
    // Start with trams already spread out along each route, then keep a steady headway.
    this.spawnTimers = this.routes.map((r, i) => {
      for (let k = 0; k < INITIAL_PER_ROUTE; k++) this.spawn(r, ((k + 0.35 + i * 0.13) / INITIAL_PER_ROUTE) * r.length);
      return HEADWAY * (0.3 + 0.2 * i);
    });
  }

  private spawn(route: RoutePath, d: number) {
    this.trams.push(new Tram(this.scene, route, d, this.serial++));
  }

  /** True if (x, y) is inside a tram (with `pad` px extra). */
  solidAt(x: number, y: number, pad = 0) {
    return this.trams.some((t) => t.contains(x, y, pad));
  }

  /** A tram is braking because the player is on the track ahead. */
  get bell() {
    return this.trams.some((t) => t.blockedByPlayer && t.v > 0.5);
  }

  update(dtMs: number, player: TrackObstacle) {
    const dt = Math.min(dtMs / 1000, 1 / 20);
    this.routes.forEach((r, i) => {
      this.spawnTimers[i] -= dt;
      if (this.spawnTimers[i] > 0) return;
      // Only launch when the start of the route is clear.
      const start = r.at(TRAM_LEN / 2);
      if (this.trams.some((t) => t.contains(start.x, start.y, TRAM_LEN / 2))) return;
      this.spawn(r, 0);
      this.spawnTimers[i] = HEADWAY;
    });
    for (const t of this.trams) this.drive(t, dt, player);
    for (let i = this.trams.length - 1; i >= 0; i--)
      if (this.trams[i].rear > this.trams[i].route.length) {
        this.trams[i].destroy();
        this.trams.splice(i, 1);
      }
  }

  private drive(t: Tram, dt: number, player: TrackObstacle) {
    const r = t.route;
    if (t.dwell > 0) {
      t.dwell -= dt;
      t.place();
      return;
    }

    // How far can we go: next stop, end of the line, or the first thing on the track ahead.
    let limit = Infinity;
    const stop = r.stops[t.nextStop];
    if (stop) limit = t.stopTarget(stop.d) - t.d;
    const look = (t.v * t.v) / (2 * SERVICE_DECEL) + SAFETY_GAP + 40;
    t.blockedByPlayer = false;
    for (let ahead = 4; ahead < look; ahead += 6) {
      const p = r.at(t.d + ahead);
      const isPlayer = Math.hypot(p.x - player.x, p.y - player.y) < TRACK_CLEARANCE;
      if (isPlayer || this.trams.some((o) => o !== t && o.contains(p.x, p.y, 4))) {
        const free = ahead - SAFETY_GAP;
        if (free < limit) {
          limit = free;
          t.blockedByPlayer = isPlayer;
        }
        break;
      }
    }

    // Plan to stop with normal braking; brake harder (up to an emergency stop) only when
    // something appears too close for that, like a car pulling onto the track.
    const room = Math.max(0, limit);
    const vMax = Math.min(MAX_SPEED, Math.sqrt(2 * SERVICE_DECEL * room));
    if (t.v < vMax) t.v = Math.min(vMax, t.v + ACCEL * dt);
    else {
      const needed = (t.v * t.v) / (2 * Math.max(room, 1));
      t.v = Math.max(0, t.v - Phaser.Math.Clamp(needed, SERVICE_DECEL, EMERGENCY_DECEL) * dt);
    }
    t.d += Math.min(t.v * dt, Math.max(0, limit));

    if (stop && t.stopTarget(stop.d) - t.d < 0.5 && t.v < 2) {
      t.v = 0;
      t.d = t.stopTarget(stop.d);
      t.nextStop++;
      // Stable per tram and stop, so a replay looks the same.
      const h = Math.abs(Math.sin(t.seed * 12.9898 + t.nextStop * 78.233)) % 1;
      t.dwell = DWELL_MIN + (DWELL_MAX - DWELL_MIN) * h;
    }
    t.place();
  }

  destroy() {
    for (const t of this.trams) t.destroy();
    this.trams.length = 0;
  }
}
