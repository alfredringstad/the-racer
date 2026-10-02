import Phaser from 'phaser';
import { FONT } from './font';
import { PALETTE } from './palette';
import { CYCLIST_FRAMES, CYCLISTS } from './people-sheet';
import type { Crowd, CrowdHazard } from './People';
import { prop, type TiledMap } from './TrackMap';
import type { TramTraffic } from './Trams';

/** How many cyclists are kept around the camera by day and at night. */
const DAY_COUNT = 9;
const NIGHT_COUNT = 3;
const ACTIVE_RADIUS = 460;
const DESPAWN_RADIUS = 620;

// Riding (px/s; ~50 px/s is about 25 km/h on the HUD). Each rider is one of these types.
const RIDER_TYPES: readonly { share: number; min: number; max: number }[] = [
  { share: 0.3, min: 26, max: 36 }, // leisurely
  { share: 0.5, min: 40, max: 52 }, // commuter
  { share: 0.2, min: 60, max: 72 }, // fast roadie
];
const ACCEL = 35;
/** Overtaking: how far (px) towards the middle of the road a rider swings out to pass. */
const PASS_SHIFT = 12;
/** px/s sideways while swinging out and back in. */
const PASS_SWING = 18;
/** Only pass someone at least this much (px/s) slower than you'd like to go. */
const PASS_MARGIN = 6;
/** How far ahead (px) the passing lane must be clear of oncoming riders, the player and trams. */
const PASS_CLEAR = 70;
/** Pull back in once this far (px) ahead of the rider you passed; give up after this many seconds. */
const PASS_DONE = 12;
const PASS_GIVE_UP = 6;
/** How far from the kerb (px) cyclists ride, on the right-hand side of the road. */
const KERB_GAP = 10;
/** Riders ease onto their line at up to this multiple of their speed, which rounds off corners. */
const STEER = 1.4;
/** How far ahead (px) a cyclist looks for things to brake for. */
const LOOKAHEAD = 34;
const DOWN_TIME = 1.6;
const BELL_COOLDOWN = 3;
const SPRITE_ANGLE_STEPS = 32;
/** px of road per pedalling frame. */
const PEDAL_PX = 6;

/** Share of riders who ignore one-way streets. */
const REBEL_SHARE = 0.1;

/** Streets cyclists don't ride on. */
const NO_BIKES = new Set(['pedestrian', 'footway', 'steps', 'path']);

type Pt = { x: number; y: number };

interface Street {
  pts: Pt[];
  /** Half the road width (px). */
  half: number;
  /** 1: one-way in drawing order, -1: one-way against it, 0: both ways (or bikes exempt). */
  oneway: number;
}

/** A point on the network: street index and vertex index. */
type Node = { s: number; i: number };

interface Cyclist {
  street: number;
  /** Riding from vertex `from` towards vertex `to` (adjacent), `t` px along that segment. */
  from: number;
  to: number;
  t: number;
  /** Actual position, which follows the lane point with a little lag (rounded corners). */
  x: number;
  y: number;
  heading: number;
  v: number;
  cruise: number;
  /** Ignores one-way streets. */
  rebel: boolean;
  /** The rider being overtaken, and how far (px) we've swung out towards the middle of the road. */
  passing?: Cyclist;
  passTime: number;
  shift: number;
  down: number;
  bell: number;
  pedal: number;
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
}

/** Where night lighting should put a cyclist's lamps. */
export interface BikeLights {
  x: number;
  y: number;
  angle: number;
}

const key = (p: Pt) => `${Math.round(p.x)},${Math.round(p.y)}`;

/**
 * NPC cyclists riding the street network on the right-hand side of the road. They turn onto
 * connecting streets at junctions, brake for the player, trams, other cyclists and people on
 * zebra crossings (ringing their bell at the player), and fall off if the player clips them.
 */
export class CyclistTraffic {
  readonly riders: Cyclist[] = [];
  private readonly streets: Street[] = [];
  /** Other streets' vertices at the same point, keyed by street:vertex. */
  private readonly links = new Map<string, Node[]>();
  private seed = 7;
  private filled = false;

  constructor(
    private readonly scene: Phaser.Scene,
    map: TiledMap,
    private readonly crowd?: Crowd,
    private readonly trams?: TramTraffic,
  ) {
    for (const o of map.layers.find((l) => l.name === 'streets')?.objects ?? []) {
      if (o.type !== 'street' || !o.polyline || o.polyline.length < 2) continue;
      if (NO_BIKES.has(prop<string>(o.properties, 'highway') ?? '')) continue;
      // Bikes allowed both ways ("utom cykel") count as two-way for cyclists.
      const oneway = prop<boolean>(o.properties, 'bikeBothWays') ? 0 : (prop<number>(o.properties, 'oneway') ?? 0);
      this.streets.push({ pts: o.polyline.map((p) => ({ x: o.x + p.x, y: o.y + p.y })), half: (prop<number>(o.properties, 'widthPx') ?? 64) / 2, oneway });
    }
    // Junctions: streets meeting at the same vertex (OSM ways share their junction nodes).
    const at = new Map<string, Node[]>();
    this.streets.forEach((st, s) => st.pts.forEach((p, i) => at.set(key(p), [...(at.get(key(p)) ?? []), { s, i }])));
    for (const nodes of at.values()) if (nodes.length > 1) for (const n of nodes) this.links.set(`${n.s}:${n.i}`, nodes.filter((m) => m.s !== n.s));
  }

  private rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** The point a rider aims for: on the centreline, shifted to the right-hand side of the road. */
  private lanePoint(c: Cyclist): Pt & { dx: number; dy: number } {
    const st = this.streets[c.street];
    const a = st.pts[c.from];
    const b = st.pts[c.to];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    const off = Math.max(4, st.half - KERB_GAP) - c.shift;
    // Right of travel on screen (y down) is (-dy, dx).
    return { x: a.x + dx * c.t - dy * off, y: a.y + dy * c.t + dx * off, dx, dy };
  }

  private segLen(c: Cyclist) {
    const st = this.streets[c.street];
    return Math.hypot(st.pts[c.to].x - st.pts[c.from].x, st.pts[c.to].y - st.pts[c.from].y);
  }

  /** May a law-abiding cyclist ride street `s` from vertex `from` to `to`? */
  private allowed(s: number, from: number, to: number) {
    const ow = this.streets[s].oneway;
    return ow === 0 || Math.sign(to - from) === ow;
  }

  /** At the end of a segment: carry on along the street, or turn onto another one at a junction. */
  private nextSegment(c: Cyclist) {
    const st = this.streets[c.street];
    const ahead = c.to + (c.to - c.from);
    const options: { s: number; from: number; to: number }[] = [];
    if (ahead >= 0 && ahead < st.pts.length) options.push({ s: c.street, from: c.to, to: ahead });
    for (const n of this.links.get(`${c.street}:${c.to}`) ?? []) {
      const len = this.streets[n.s].pts.length;
      if (n.i + 1 < len) options.push({ s: n.s, from: n.i, to: n.i + 1 });
      if (n.i - 1 >= 0) options.push({ s: n.s, from: n.i, to: n.i - 1 });
    }
    // Don't double straight back on the street we came along, unless it's a dead end.
    const dir = this.lanePoint(c);
    const fwd = options.filter((o) => {
      const p = this.streets[o.s].pts;
      const dx = p[o.to].x - p[o.from].x;
      const dy = p[o.to].y - p[o.from].y;
      return (dx * dir.dx + dy * dir.dy) / (Math.hypot(dx, dy) || 1) > -0.7;
    });
    // Most riders keep to one-way streets; a dead end that's one-way the other way forces a turn back.
    const legal = c.rebel ? fwd : fwd.filter((o) => this.allowed(o.s, o.from, o.to));
    const pick = legal.length ? legal : fwd.length && c.rebel ? fwd : [{ s: c.street, from: c.to, to: c.from }];
    // Mostly carry straight on; sometimes turn.
    const straight = pick.find((o) => o.s === c.street);
    const o = straight && this.rand() < 0.55 ? straight : pick[Math.floor(this.rand() * pick.length)];
    c.street = o.s;
    c.from = o.from;
    c.to = o.to;
    c.t = 0;
  }

  private spawn(cx: number, cy: number, minR: number, maxR: number) {
    // Street points in the ring around the camera (not random streets across the whole map,
    // which would rarely land near it).
    const near: Node[] = [];
    this.streets.forEach((st, s) =>
      st.pts.forEach((p, i) => {
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (i + 1 < st.pts.length && d >= minR && d <= maxR) near.push({ s, i });
      }),
    );
    for (let k = 0; k < 4 && near.length; k++) {
      const { s, i } = near[Math.floor(this.rand() * near.length)];
      const rebel = this.rand() < REBEL_SHARE;
      const ow = this.streets[s].oneway;
      const forward = ow === 0 || rebel ? this.rand() < 0.5 : ow > 0;
      const v = Math.floor(this.rand() * CYCLISTS.variants);
      const c: Cyclist = {
        street: s,
        from: forward ? i : i + 1,
        to: forward ? i + 1 : i,
        t: 0,
        x: 0,
        y: 0,
        heading: 0,
        v: 0,
        cruise: this.cruiseSpeed(),
        passTime: 0,
        rebel,
        shift: 0,
        down: 0,
        bell: 0,
        pedal: 0,
        shadow: this.scene.add.image(0, 0, CYCLISTS.key, v * CYCLIST_FRAMES).setTintMode(Phaser.TintModes.FILL).setTint(PALETTE.ink).setAlpha(0.3).setDepth(9),
        sprite: this.scene.add.image(0, 0, CYCLISTS.key, v * CYCLIST_FRAMES).setDepth(9.5),
      };
      c.sprite.setData('variant', v);
      const lp = this.lanePoint(c);
      c.x = lp.x;
      c.y = lp.y;
      c.heading = Math.atan2(lp.dy, lp.dx);
      c.v = c.cruise;
      this.riders.push(c);
      return;
    }
  }

  private cruiseSpeed() {
    let r = this.rand();
    const type = RIDER_TYPES.find((t) => (r -= t.share) < 0) ?? RIDER_TYPES[1];
    return type.min + this.rand() * (type.max - type.min);
  }

  private remove(i: number) {
    this.riders[i].sprite.destroy();
    this.riders[i].shadow.destroy();
    this.riders.splice(i, 1);
  }

  private say(c: Cyclist, text: string) {
    const t = this.scene.add.bitmapText(Math.round(c.x), Math.round(c.y) - 8, FONT.key, text).setOrigin(0.5, 1).setTint(PALETTE.ink).setDepth(12);
    this.scene.tweens.add({ targets: t, y: t.y - 6, alpha: 0, delay: 350, duration: 650, onComplete: () => t.destroy() });
  }

  /** Distance to the nearest thing ahead worth braking for (Infinity if clear), and whether it's the player. */
  private clearance(c: Cyclist, player: CrowdHazard): { d: number; player: boolean; rider?: Cyclist } {
    const fx = Math.cos(c.heading);
    const fy = Math.sin(c.heading);
    const pc = Math.cos(player.heading);
    const ps = Math.sin(player.heading);
    for (let d = 6; d <= LOOKAHEAD; d += 4) {
      const x = c.x + fx * d;
      const y = c.y + fy * d;
      const rx = x - player.x;
      const ry = y - player.y;
      if (!player.spec.onWater && Math.abs(rx * pc + ry * ps) < player.spec.halfLength + 3 && Math.abs(-rx * ps + ry * pc) < player.spec.halfWidth + 3)
        return { d, player: true };
      if (this.trams?.solidAt(x, y, 3)) return { d, player: false };
      // Queue behind riders going the same way; riders crossing our path just weave past
      // (waiting for each other at junctions would deadlock).
      const rider = this.riders.find((o) => o !== c && Math.cos(o.heading - c.heading) > 0.5 && Math.hypot(o.x - x, o.y - y) < 5);
      if (rider) return { d, player: false, rider };
      if (this.crowd?.people.some((p) => (p.state === 'cross' || p.state === 'down') && Math.hypot(p.x - x, p.y - 3 - y) < 6)) return { d, player: false };
    }
    return { d: Infinity, player: false };
  }

  update(dtMs: number, view: Phaser.Geom.Rectangle, player: CrowdHazard, night = 0): number {
    const dt = Math.min(dtMs / 1000, 1 / 20);
    const cx = view.centerX;
    const cy = view.centerY;
    const offscreen = Math.hypot(view.width, view.height) / 2 + 16;
    const target = Math.round(DAY_COUNT + (NIGHT_COUNT - DAY_COUNT) * night);
    const first = !this.filled && view.contains(player.x, player.y);
    if (first) this.filled = true;
    if (!this.filled) return 0;
    for (let n = 0; n < (first ? target : 1) && this.riders.length < target; n++) this.spawn(cx, cy, first ? 0 : offscreen, ACTIVE_RADIUS);

    let bumps = 0;
    for (let i = this.riders.length - 1; i >= 0; i--) {
      const c = this.riders[i];
      const far = Math.hypot(c.x - cx, c.y - cy) > DESPAWN_RADIUS || (this.riders.length > target + 1 && Math.hypot(c.x - cx, c.y - cy) > offscreen);
      if (far && !view.contains(c.x, c.y)) {
        this.remove(i);
        continue;
      }
      if (this.ride(c, dt, player)) bumps++;
      this.draw(c);
    }
    return bumps;
  }

  /** Advances one cyclist. Returns true if the player knocked them off this frame. */
  private ride(c: Cyclist, dt: number, player: CrowdHazard): boolean {
    c.bell -= dt;
    if (c.down > 0) {
      c.down -= dt;
      c.v = 0;
      return false;
    }
    // Clipped by the player: off the bike for a moment.
    const pc = Math.cos(player.heading);
    const ps = Math.sin(player.heading);
    const rx = c.x - player.x;
    const ry = c.y - player.y;
    if (!player.spec.onWater && player.speed > 10 && Math.abs(rx * pc + ry * ps) < player.spec.halfLength + 3 && Math.abs(-rx * ps + ry * pc) < player.spec.halfWidth + 3) {
      c.down = DOWN_TIME;
      c.x += player.vx * 0.08;
      c.y += player.vy * 0.08;
      this.say(c, 'AJ!');
      return true;
    }

    const ahead = this.clearance(c, player);
    if (ahead.player && c.bell <= 0) {
      c.bell = BELL_COOLDOWN;
      this.say(c, 'PLING!');
    }
    this.overtake(c, ahead.rider, player, dt);
    // Slow to a stop a few px short of whatever is ahead.
    const vMax = Math.min(c.cruise, Math.max(0, ahead.d - 8) * 3);
    c.v = c.v < vMax ? Math.min(vMax, c.v + ACCEL * dt) : vMax;

    c.t += c.v * dt;
    for (let n = 0; n < 4 && c.t >= this.segLen(c); n++) {
      c.t -= this.segLen(c);
      this.nextSegment(c);
    }
    // Ease towards the lane point, so corners get rounded off instead of jumping.
    const lp = this.lanePoint(c);
    const dx = lp.x - c.x;
    const dy = lp.y - c.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.min(dist, Math.max(c.v, 6) * STEER * dt);
    if (dist > 0.01) {
      c.x += (dx / dist) * step;
      c.y += (dy / dist) * step;
    }
    if (dist > 40) {
      c.x = lp.x;
      c.y = lp.y;
    }
    if (step > 0.05) c.heading = Math.atan2(dy, dx);
    c.pedal += step;
    return false;
  }

  /**
   * Stuck behind a slower rider: swing out towards the middle of the road when the way is clear,
   * pass, and pull back in once ahead. The lane shift is eased, so it reads as a smooth swerve.
   */
  private overtake(c: Cyclist, blocker: Cyclist | undefined, player: CrowdHazard, dt: number) {
    if (c.passing) {
      const o = c.passing;
      c.passTime += dt;
      // Done once they're behind us (or gone, or it's taking far too long).
      const along = (o.x - c.x) * Math.cos(c.heading) + (o.y - c.y) * Math.sin(c.heading);
      if (!this.riders.includes(o) || along < -PASS_DONE || c.passTime > PASS_GIVE_UP) c.passing = undefined;
    } else if (blocker && blocker.down <= 0 && Math.min(blocker.v, blocker.cruise) < c.cruise - PASS_MARGIN && this.passingLaneClear(c, player)) {
      c.passing = blocker;
      c.passTime = 0;
      if (c.bell <= 0 && this.rand() < 0.5) {
        c.bell = BELL_COOLDOWN;
        this.say(c, 'PLING!');
      }
    }
    const want = c.passing ? PASS_SHIFT : 0;
    c.shift += Phaser.Math.Clamp(want - c.shift, -PASS_SWING * dt, PASS_SWING * dt);
  }

  /** Is the line PASS_SHIFT px further out clear ahead: no oncoming riders, player or trams? */
  private passingLaneClear(c: Cyclist, player: CrowdHazard): boolean {
    const fx = Math.cos(c.heading);
    const fy = Math.sin(c.heading);
    // Towards the middle of the road is to the left of travel: (fy, -fx) on screen.
    const lx = fy * PASS_SHIFT;
    const ly = -fx * PASS_SHIFT;
    const pc = Math.cos(player.heading);
    const ps = Math.sin(player.heading);
    for (let d = 0; d <= PASS_CLEAR; d += 6) {
      const x = c.x + lx + fx * d;
      const y = c.y + ly + fy * d;
      const rx = x - player.x;
      const ry = y - player.y;
      if (!player.spec.onWater && Math.abs(rx * pc + ry * ps) < player.spec.halfLength + 4 && Math.abs(-rx * ps + ry * pc) < player.spec.halfWidth + 4) return false;
      if (this.trams?.solidAt(x, y, 4)) return false;
      if (this.riders.some((o) => o !== c && o !== c.passing && Math.hypot(o.x - x, o.y - y) < 8)) return false;
    }
    return true;
  }

  private draw(c: Cyclist) {
    const stepA = (Math.PI * 2) / SPRITE_ANGLE_STEPS;
    const angle = Math.round(c.heading / stepA) * stepA + (c.down > 0 ? Math.PI / 2 : 0);
    const frame = (c.sprite.getData('variant') as number) * CYCLIST_FRAMES + (c.v > 1 ? Math.floor(c.pedal / PEDAL_PX) % CYCLIST_FRAMES : 0);
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    c.sprite.setFrame(frame).setPosition(x, y).setRotation(angle);
    c.shadow.setFrame(frame).setPosition(x + 1, y + 2).setRotation(angle);
  }

  /** Lamp positions for night lighting. */
  get lights(): BikeLights[] {
    return this.riders.filter((c) => c.down <= 0).map((c) => ({ x: c.x, y: c.y, angle: c.heading }));
  }

  destroy() {
    for (let i = this.riders.length - 1; i >= 0; i--) this.remove(i);
  }
}
