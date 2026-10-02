import Phaser from 'phaser';
import { FONT } from './font';
import { PALETTE } from './palette';
import { ADULTS, DOGS, KIDS, sheetFrame, type Facing, type SheetSpec } from './people-sheet';
import { prop, type TiledMap, type TrackMap } from './TrackMap';
import type { TramTraffic } from './Trams';
import type { Surface } from './tiles';

/** How many people are kept around the camera, and where they live. */
const TARGET_COUNT = 40;
/** At full night: fewer people out, about one waiting per tram stop. */
const NIGHT_COUNT = 14;
const NIGHT_WAITERS_PER_STOP = 1;
/** At night new arrivals turn up near street lamps (within this many px of one). */
const NIGHT_LAMP_RADIUS = 24;
const ACTIVE_RADIUS = 420;
const DESPAWN_RADIUS = 560;
const WAITERS_PER_STOP = 3;
/** Seconds before an emptied tram stop gets new people waiting (out of sight). */
const STOP_REFILL = 25;
/** Passers-by within this many px of a stop that isn't full may stop and wait (chance per second). */
const JOIN_STOP_RADIUS = 28;
const JOIN_STOP_CHANCE = 0.25;

// Walking (px/s; ~10 px/s is a stroll of about 1.4 m/s).
const WALK_MIN = 8;
const WALK_MAX = 12;
const BOARD_SPEED = 16;
const DODGE_SPEED = 60;
const DODGE_TIME = 0.3;
const DOWN_TIME = 1.8;
/** px walked per animation step. */
const STEP_PX = 4;

// Who's out: share of new arrivals walking a dog, bringing kids, or kids out on their own.
const DOG_CHANCE = 0.18;
const FAMILY_CHANCE = 0.14;
const KID_GANG_CHANCE = 0.05;
/** Kids on their own run about. */
const KID_RUN_MIN = 15;
const KID_RUN_MAX = 20;
/** How far (px) a dog can be from its owner before the leash pulls it along. */
const LEASH = 14;
/** Followers can go this much faster than their leader to keep up. */
const FOLLOW_CATCHUP = 1.8;
/** Dogs bark at vehicles passing this close (px), at most this often (s). */
const BARK_RADIUS = 50;
const BARK_COOLDOWN = 4;

/** People are happy on these (platforms count as paving); roads only at zebra crossings. */
const WALKABLE = new Set<Surface>(['paving', 'cobble', 'grass']);

type Pt = { x: number; y: number };
type State = 'walk' | 'idle' | 'wait' | 'board' | 'dodge' | 'down' | 'cross' | 'follow' | 'sniff';
type Kind = 'adult' | 'kid' | 'dog';

interface Person {
  x: number;
  y: number;
  dir: Pt;
  speed: number;
  state: State;
  timer: number;
  turnTimer: number;
  variant: number;
  phase: number;
  /** Sliding (dodging or knocked over). */
  vx: number;
  vy: number;
  stop?: number;
  kind: Kind;
  sheet: SheetSpec;
  /** Who a kid or dog is with; they walk beside them (hand in hand, or on the leash). */
  leader?: Person;
  /** Which side of the leader (±1), and how many places out (for siblings). */
  side: number;
  slot: number;
  /** Following and actually moving this frame (for the walk animation). */
  moving: boolean;
  bark: number;
  /** Set when removed, so followers know whether their leader boarded a tram or just left. */
  gone?: 'boarded' | 'removed';
  sprite: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
}

interface Zebra {
  a: Pt;
  b: Pt;
  half: number;
}

/** Anything the crowd should get out of the way of: the player's vehicle. */
export interface CrowdHazard {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  speed: number;
  spec: { halfLength: number; halfWidth: number; onWater?: boolean };
}

const DIRS: readonly Pt[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

/**
 * Pedestrians: a crowd kept alive around the camera. They stroll the sidewalks, squares and
 * parks, cross roads at zebra crossings, wait at tram stops and board trams that stop there,
 * and jump out of the way of the player (or get knocked over and complain).
 */
export class Crowd {
  readonly people: Person[] = [];
  private readonly zebras: Zebra[] = [];
  private readonly stops: (Pt & { refill: number })[] = [];
  /** Trams already handled at their current stop (people got off). */
  private readonly unloaded = new WeakSet<object>();
  private seed = 1;
  private readonly leashes: Phaser.GameObjects.Graphics;
  /** The first fill puts people in view too; it waits until the camera has found the player. */
  private filled = false;
  /** 0 = day, 1 = night (from the lighting). */
  private night = 0;
  /** Running totals, for the curious (and tests). */
  readonly stats = { boarded: 0, alighted: 0, bumped: 0 };

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly track: TrackMap,
    map: TiledMap,
    private readonly trams?: TramTraffic,
  ) {
    for (const o of map.layers.find((l) => l.name === 'markings')?.objects ?? []) {
      if (o.type !== 'zebra' || !o.polyline || o.polyline.length < 2) continue;
      const [p, q] = [o.polyline[0], o.polyline[o.polyline.length - 1]];
      this.zebras.push({ a: { x: o.x + p.x, y: o.y + p.y }, b: { x: o.x + q.x, y: o.y + q.y }, half: (prop<number>(o.properties, 'depth') ?? 20) / 2 });
    }
    for (const o of map.layers.find((l) => l.name === 'tram')?.objects ?? []) if (o.type === 'stop') this.stops.push({ x: o.x, y: o.y, refill: 0 });
    this.leashes = scene.add.graphics().setDepth(8.2);
  }

  private rand() {
    // Small deterministic PRNG so a session looks the same each run.
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** The zebra crossing at (x, y), if any. */
  private zebraAt(x: number, y: number): Zebra | undefined {
    for (const z of this.zebras) {
      const dx = z.b.x - z.a.x;
      const dy = z.b.y - z.a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = ((x - z.a.x) * dx + (y - z.a.y) * dy) / len2;
      if (t < -0.05 || t > 1.05) continue;
      if (Math.hypot(z.a.x + dx * t - x, z.a.y + dy * t - y) <= z.half) return z;
    }
    return undefined;
  }

  private walkable(x: number, y: number) {
    if (this.track.isSolidAt(x, y)) return false;
    if (this.track.obstaclesNear(x, y, 6).some((o) => Math.hypot(o.x - x, o.y - y) < 3)) return false;
    const s = this.track.surfaceAt(x, y);
    if (s === 'grass' && this.night > 0.5) return false; // parks are empty at night
    return WALKABLE.has(s) || !!this.zebraAt(x, y);
  }

  private add(x: number, y: number, state: State, dir: Pt, stop?: number, sheet: SheetSpec = ADULTS, leader?: Person, slot = 1) {
    const variant = Math.floor(this.rand() * sheet.variants);
    const kind: Kind = sheet === DOGS ? 'dog' : sheet === KIDS ? 'kid' : 'adult';
    const shadow = this.scene.add.image(x, y, 'px').setDisplaySize(kind === 'adult' ? 6 : 5, 2).setTint(PALETTE.ink).setAlpha(0.25).setDepth(7.9);
    const sprite = this.scene.add.image(x, y, sheet.key, sheetFrame(variant, 'down', 0)).setOrigin(0.5, 1);
    const p: Person = {
      x,
      y,
      dir,
      speed: WALK_MIN + this.rand() * (WALK_MAX - WALK_MIN),
      state,
      timer: 1 + this.rand() * 3,
      turnTimer: 2 + this.rand() * 4,
      variant,
      phase: this.rand() * 8,
      vx: 0,
      vy: 0,
      stop,
      kind,
      sheet,
      leader,
      side: this.rand() < 0.5 ? -1 : 1,
      slot,
      moving: false,
      bark: 0,
      sprite,
      shadow,
    };
    this.people.push(p);
    this.draw(p);
    return p;
  }

  /**
   * Someone arriving, sometimes with company: a dog on a leash, a kid or two holding hands, or
   * two kids running about on their own. Returns the leader.
   */
  private addGroup(x: number, y: number, state: State, dir: Pt, stop?: number): Person {
    // Kids are home at night; dogs still get their evening walk.
    const n = this.night;
    const gang = KID_GANG_CHANCE * (1 - n);
    const dog = DOG_CHANCE * (1 - 0.3 * n);
    const family = FAMILY_CHANCE * (1 - 0.95 * n);
    const r = this.rand();
    if (r < gang && state === 'walk') {
      const a = this.add(x, y, 'walk', dir, undefined, KIDS);
      a.speed = KID_RUN_MIN + this.rand() * (KID_RUN_MAX - KID_RUN_MIN);
      const b = this.add(x, y, 'follow', dir, undefined, KIDS, a);
      b.side = -a.side;
      return a;
    }
    const p = this.add(x, y, state, dir, stop);
    if (r < gang + dog) this.add(x, y, 'follow', dir, undefined, DOGS, p);
    else if (r < gang + dog + family) {
      p.speed = WALK_MIN; // strolling at kid pace
      const n = this.rand() < 0.35 ? 2 : 1;
      for (let k = 1; k <= n; k++) this.add(x, y, 'follow', dir, undefined, KIDS, p, k).side = 1;
    }
    return p;
  }

  private remove(i: number) {
    const p = this.people[i];
    p.gone ??= 'removed';
    p.sprite.destroy();
    p.shadow.destroy();
    this.people.splice(i, 1);
  }

  private say(p: Person, text: string) {
    const t = this.scene.add.bitmapText(Math.round(p.x), Math.round(p.y) - 14, FONT.key, text).setOrigin(0.5, 1).setTint(PALETTE.ink).setDepth(12);
    this.scene.tweens.add({ targets: t, y: t.y - 6, alpha: 0, delay: 350, duration: 650, onComplete: () => t.destroy() });
  }

  /** Random walkable spot in a ring around (cx, cy), outside `minR`. At night, close to a street lamp. */
  private spot(cx: number, cy: number, minR: number, maxR: number): Pt | undefined {
    const lamps = this.rand() < this.night ? this.track.lamps.query(cx - maxR, cy - maxR, cx + maxR, cy + maxR) : [];
    for (let i = 0; i < 12; i++) {
      const a = this.rand() * Math.PI * 2;
      let r = minR + this.rand() * (maxR - minR);
      let [ox, oy] = [cx, cy];
      if (lamps.length) {
        const l = lamps[Math.floor(this.rand() * lamps.length)];
        if (Math.hypot(l.x - cx, l.y - cy) < minR) continue;
        [ox, oy] = [l.x, l.y];
        r = this.rand() * NIGHT_LAMP_RADIUS;
      }
      const x = Math.round(ox + Math.cos(a) * r);
      const y = Math.round(oy + Math.sin(a) * r);
      const s = this.track.surfaceAt(x, y);
      if (!this.walkable(x, y) || this.zebraAt(x, y)) continue;
      if (s === 'grass' && this.rand() > 0.3) continue; // mostly on sidewalks and squares
      return { x, y };
    }
    return undefined;
  }

  private openDirs(p: Person, ahead = 8) {
    return DIRS.filter((d) => this.walkable(p.x + d.x * ahead, p.y + d.y * ahead));
  }

  update(dtMs: number, view: Phaser.Geom.Rectangle, hazard: CrowdHazard, night = 0): number {
    const dt = Math.min(dtMs / 1000, 1 / 20);
    this.night = night;
    const target = Math.round(TARGET_COUNT + (NIGHT_COUNT - TARGET_COUNT) * night);
    const cx = view.centerX;
    const cy = view.centerY;
    const offscreen = Math.hypot(view.width, view.height) / 2 + 12;

    // Keep the crowd topped up just out of sight (in view too, the first time).
    const first = !this.filled && view.contains(hazard.x, hazard.y);
    if (first) this.filled = true;
    if (!this.filled) return 0;
    for (let n = 0; n < (first ? target : 2) && this.people.length < target; n++) {
      const s = this.spot(cx, cy, first ? 0 : offscreen, ACTIVE_RADIUS);
      if (s) this.addGroup(s.x, s.y, 'walk', DIRS[Math.floor(this.rand() * 4)]);
    }
    if (this.people.length > target + 2) this.sendHome(view, offscreen, false);
    else if (night > 0.6) this.sendHome(view, offscreen, true); // past bedtime
    this.fillStops(dt, cx, cy, view, first);
    this.unloadTrams(cx, cy);

    let bumps = 0;
    for (let i = this.people.length - 1; i >= 0; i--) {
      const p = this.people[i];
      if (Math.hypot(p.x - cx, p.y - cy) > DESPAWN_RADIUS && !view.contains(p.x, p.y)) {
        this.remove(i);
        continue;
      }
      if (!hazard.spec.onWater && this.react(p, hazard)) bumps++;
      if (p.kind === 'dog') this.barkAt(p, hazard, dt);
      if (this.move(p, dt)) this.remove(i);
      else this.draw(p);
    }
    this.drawLeashes();
    return bumps;
  }

  private get waitersPerStop() {
    return Math.round(WAITERS_PER_STOP + (NIGHT_WAITERS_PER_STOP - WAITERS_PER_STOP) * this.night);
  }

  /**
   * Too many people out for the time of day: one group out of sight goes home (it's removed).
   * Kids go first as it gets dark; with `kidsOnly`, only groups with kids go.
   */
  private sendHome(view: Phaser.Geom.Rectangle, offscreen: number, kidsOnly: boolean) {
    const cx = view.centerX;
    const cy = view.centerY;
    const hidden = (p: Person) => !view.contains(p.x, p.y) && Math.hypot(p.x - cx, p.y - cy) > offscreen;
    const leaders = this.people.filter((p) => !p.leader && p.state !== 'board' && hidden(p) && this.people.every((f) => f.leader !== p || hidden(f)));
    if (!leaders.length) return;
    const withKids = (p: Person) => p.kind === 'kid' || this.people.some((f) => f.leader === p && f.kind === 'kid');
    const pick = (this.night > 0.3 && leaders.find(withKids)) || (kidsOnly ? undefined : leaders[Math.floor(this.rand() * leaders.length)]);
    if (!pick) return;
    for (let i = this.people.length - 1; i >= 0; i--) if (this.people[i] === pick || this.people[i].leader === pick) this.remove(i);
  }

  /** People waiting at tram stops near the camera; refilled out of sight after a tram has been. */
  private fillStops(dt: number, cx: number, cy: number, view: Phaser.Geom.Rectangle, first: boolean) {
    this.stops.forEach((s, i) => {
      s.refill = Math.max(0, s.refill - dt);
      if (s.refill > 0 || Math.hypot(s.x - cx, s.y - cy) > ACTIVE_RADIUS || (!first && view.contains(s.x, s.y))) return;
      let waiting = this.people.filter((p) => p.stop === i).length;
      for (let k = 0; k < 8 && waiting < this.waitersPerStop; k++) {
        const a = this.rand() * Math.PI * 2;
        const r = 6 + this.rand() * 14;
        const x = Math.round(s.x + Math.cos(a) * r);
        const y = Math.round(s.y + Math.sin(a) * r);
        if (!this.walkable(x, y) || this.zebraAt(x, y)) continue;
        const p = this.addGroup(x, y, 'wait', DIRS[Math.floor(this.rand() * 4)], i);
        p.timer = 2 + this.rand() * 6;
        waiting++;
      }
    });
  }

  /** When a tram pulls in at a stop, a few people get off and walk away; waiters head for the doors. */
  private unloadTrams(cx: number, cy: number) {
    for (const t of this.trams?.trams ?? []) {
      if (t.dwell <= 0) {
        this.unloaded.delete(t);
        continue;
      }
      if (this.unloaded.has(t) || Math.hypot(t.boxes[1].x - cx, t.boxes[1].y - cy) > ACTIVE_RADIUS) continue;
      this.unloaded.add(t);
      const n = Math.floor(this.rand() * 4);
      for (let k = 0; k < n; k++) {
        const b = t.boxes[Math.floor(this.rand() * t.boxes.length)];
        for (const side of this.rand() < 0.5 ? [1, -1] : [-1, 1]) {
          const along = (this.rand() - 0.5) * 30;
          const x = Math.round(b.x + b.c * along - b.s * side * 12);
          const y = Math.round(b.y + b.s * along + b.c * side * 12);
          if (!this.walkable(x, y)) continue;
          const away = Math.abs(b.s) > Math.abs(b.c) ? { x: -Math.sign(b.s * side) || 1, y: 0 } : { x: 0, y: Math.sign(b.c * side) || 1 };
          const p = this.addGroup(x, y, 'walk', away);
          p.turnTimer = 3;
          this.stats.alighted++;
          break;
        }
      }
      // Everyone waiting at this stop goes for the tram.
      for (const p of this.people)
        if (p.state === 'wait' && t.contains(p.x, p.y, 60)) {
          p.state = 'board';
          if (p.stop !== undefined) this.stops[p.stop].refill = STOP_REFILL;
        }
    }
  }

  /** Dodge out of the way of the player's vehicle, or get knocked over by it. Returns true on a bump. */
  private react(p: Person, h: CrowdHazard): boolean {
    if (p.state === 'down' || h.speed < 8) return false;
    const c = Math.cos(h.heading);
    const s = Math.sin(h.heading);
    const rx = p.x - h.x;
    const ry = p.y - 3 - h.y;
    const along = rx * c + ry * s;
    const lat = -rx * s + ry * c;
    if (Math.abs(along) < h.spec.halfLength + 2 && Math.abs(lat) < h.spec.halfWidth + 2) {
      p.state = 'down';
      p.timer = DOWN_TIME;
      p.vx = h.vx * 0.7;
      p.vy = h.vy * 0.7;
      this.say(p, 'OJ!');
      this.stats.bumped++;
      return true;
    }
    if (p.state === 'dodge' || h.speed < 25) return false;
    // In the vehicle's path within about half a second: jump to the nearer side.
    if (along > 0 && along < h.speed * 0.5 + h.spec.halfLength + 6 && Math.abs(lat) < h.spec.halfWidth + 6) {
      const side = lat === 0 ? (this.rand() < 0.5 ? -1 : 1) : Math.sign(lat);
      p.state = 'dodge';
      p.timer = DODGE_TIME;
      p.vx = -s * side * DODGE_SPEED;
      p.vy = c * side * DODGE_SPEED;
      this.say(p, '!');
    }
    return false;
  }

  /** Advances one person. Returns true when they're gone (boarded a tram). */
  private move(p: Person, dt: number): boolean {
    p.timer -= dt;
    switch (p.state) {
      case 'dodge':
      case 'down': {
        const k = p.state === 'down' ? Math.exp(-4 * dt) : 1;
        p.vx *= k;
        p.vy *= k;
        const nx = p.x + p.vx * dt;
        const ny = p.y + p.vy * dt;
        if (!this.track.isSolidAt(nx, ny)) {
          p.x = nx;
          p.y = ny;
        }
        if (p.timer <= 0 && p.leader && !p.leader.gone) {
          p.state = 'follow';
          p.vx = p.vy = 0;
        } else if (p.timer <= 0) {
          p.state = p.stop !== undefined && p.state === 'dodge' ? 'wait' : 'idle';
          p.timer = p.state === 'idle' ? 0.6 : 3;
          p.vx = p.vy = 0;
          if (p.stop !== undefined && p.state === 'idle') p.stop = undefined;
        }
        return false;
      }
      case 'wait':
        // Shuffle around a little while waiting.
        if (p.timer <= 0) {
          p.timer = 3 + this.rand() * 6;
          p.dir = DIRS[Math.floor(this.rand() * 4)];
        }
        return false;
      case 'board': {
        const tram = this.trams?.trams.find((t) => t.dwell > 0 && t.contains(p.x, p.y, 70));
        if (!tram) {
          p.state = p.leader && !p.leader.gone ? 'follow' : p.stop !== undefined ? 'wait' : 'idle';
          return false;
        }
        // Head for the nearest door, i.e. the closest point on the nearest section.
        const b = tram.boxes.reduce((a, q) => (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? q : a));
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        p.dir = { x: dx / d, y: dy / d };
        p.x += p.dir.x * BOARD_SPEED * dt;
        p.y += p.dir.y * BOARD_SPEED * dt;
        p.phase += BOARD_SPEED * dt;
        if (!tram.contains(p.x, p.y, 1)) return false;
        this.stats.boarded++;
        p.gone = 'boarded';
        return true;
      }
      case 'cross': {
        // On a zebra: keep going straight across until back on the sidewalk.
        p.x += p.dir.x * p.speed * dt;
        p.y += p.dir.y * p.speed * dt;
        p.phase += p.speed * dt;
        if (!this.zebraAt(p.x, p.y)) {
          p.state = 'walk';
          p.dir = Math.abs(p.dir.x) > Math.abs(p.dir.y) ? { x: Math.sign(p.dir.x), y: 0 } : { x: 0, y: Math.sign(p.dir.y) };
          if (!this.walkable(p.x + p.dir.x * 4, p.y + p.dir.y * 4)) p.state = 'idle';
        }
        return false;
      }
      case 'follow':
        return this.follow(p, dt);
      case 'sniff': {
        // Nose down until the timer runs out or the leash goes taut.
        const L = p.leader;
        p.moving = false;
        if (!L || L.gone || p.timer <= 0 || Math.hypot(L.x - p.x, L.y - p.y) > LEASH) p.state = 'follow';
        return false;
      }
      case 'idle':
        if (p.timer <= 0) {
          const open = this.openDirs(p);
          p.state = open.length ? 'walk' : 'idle';
          p.timer = 1;
          if (open.length) p.dir = open[Math.floor(this.rand() * open.length)];
        }
        return false;
      case 'walk': {
        p.turnTimer -= dt;
        if (p.turnTimer <= 0) {
          p.turnTimer = p.kind === 'kid' ? 0.8 + this.rand() * 2 : 2 + this.rand() * 5;
          const r = this.rand();
          if (r < (p.kind === 'kid' ? 0.04 : 0.12)) {
            p.state = 'idle';
            p.timer = 1 + this.rand() * 3;
            return false;
          }
          if (r < 0.5) {
            const side = this.openDirs(p, 14).filter((d) => d.x !== p.dir.x && d.y !== p.dir.y);
            if (side.length) p.dir = side[Math.floor(this.rand() * side.length)];
          }
        }
        const nx = p.x + p.dir.x * p.speed * dt;
        const ny = p.y + p.dir.y * p.speed * dt;
        if (!this.walkable(nx + p.dir.x * 3, ny + p.dir.y * 3)) {
          // Blocked: turn, preferring not to go straight back.
          const open = this.openDirs(p, 6);
          const turns = open.filter((d) => d.x !== -p.dir.x || d.y !== -p.dir.y);
          const pick = turns.length ? turns : open;
          if (pick.length) p.dir = pick[Math.floor(this.rand() * pick.length)];
          else {
            p.state = 'idle';
            p.timer = 1;
          }
          return false;
        }
        p.x = nx;
        p.y = ny;
        p.phase += p.speed * dt;
        // Walking past a tram stop that isn't full: sometimes stop and wait for a tram.
        if (p.stop === undefined && this.rand() < JOIN_STOP_CHANCE * dt) {
          const i = this.stops.findIndex((s) => Math.hypot(s.x - p.x, s.y - p.y) < JOIN_STOP_RADIUS);
          if (i >= 0 && this.people.filter((q) => q.stop === i).length < this.waitersPerStop) {
            p.state = 'wait';
            p.stop = i;
            p.timer = 2 + this.rand() * 4;
            return false;
          }
        }
        // Stepping onto a zebra: cross along it to the far side.
        const z = this.zebraAt(p.x + p.dir.x * 4, p.y + p.dir.y * 4);
        if (z && this.track.surfaceAt(p.x + p.dir.x * 6, p.y + p.dir.y * 6) !== 'paving') {
          const zx = z.b.x - z.a.x;
          const zy = z.b.y - z.a.y;
          const len = Math.hypot(zx, zy) || 1;
          const sgn = zx * p.dir.x + zy * p.dir.y >= 0 ? 1 : -1;
          if (Math.abs(zx * p.dir.x + zy * p.dir.y) / len > 0.5) {
            p.state = 'cross';
            p.dir = { x: (zx / len) * sgn, y: (zy / len) * sgn };
          }
        }
        return false;
      }
    }
  }

  /** Kids walk hand in hand beside their leader; dogs trot a little ahead on the leash and stop to sniff. */
  private follow(p: Person, dt: number): boolean {
    const L = p.leader;
    if (!L || L.gone) {
      // The leader boarded: follow them on. Otherwise carry on alone (kids) or wander off (dogs).
      if (L?.gone === 'boarded') p.state = 'board';
      else {
        p.leader = undefined;
        p.state = 'walk';
        p.turnTimer = 1;
      }
      return false;
    }
    if (L.state === 'board') {
      p.state = 'board';
      return false;
    }
    const d = L.dir;
    const sx = -d.y * p.side;
    const sy = d.x * p.side;
    let tx = p.kind === 'dog' ? L.x + d.x * 7 + sx * 4 : L.x + sx * 5 * p.slot;
    let ty = p.kind === 'dog' ? L.y + d.y * 7 + sy * 4 : L.y + sy * 5 * p.slot;
    // No room beside them (a wall, a lamp post): fall in behind instead.
    if (!this.walkable(tx, ty)) {
      tx = L.x - d.x * 6 * p.slot;
      ty = L.y - d.y * 6 * p.slot;
    }
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 60) {
      // Got separated (e.g. after a fall): catch up at once.
      p.x = tx;
      p.y = ty;
    } else if (dist > 0.5) {
      const step = Math.min(dist, Math.max(L.speed, 8) * FOLLOW_CATCHUP * dt);
      const nx = p.x + (dx / dist) * step;
      const ny = p.y + (dy / dist) * step;
      // Squeeze past whatever is in the way rather than getting left behind.
      if (!this.track.isSolidAt(nx, ny) || Math.hypot(L.x - p.x, L.y - p.y) > 12) {
        p.x = nx;
        p.y = ny;
      }
      p.phase += step;
    }
    p.moving = dist > 1;
    p.dir = dist > 2 ? (Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) }) : d;
    if (p.kind === 'dog' && p.timer <= 0 && this.rand() < 0.2 * dt) {
      p.state = 'sniff';
      p.timer = 0.8 + this.rand() * 1.6;
    }
    return false;
  }

  private barkAt(p: Person, h: CrowdHazard, dt: number) {
    p.bark -= dt;
    if (p.bark > 0 || p.state === 'down' || h.spec.onWater || h.speed < 15) return;
    if (Math.hypot(h.x - p.x, h.y - p.y) > BARK_RADIUS) return;
    p.bark = BARK_COOLDOWN;
    this.say(p, 'VOFF!');
  }

  /** Pixel leashes from each owner's hand to their dog's collar. */
  private drawLeashes() {
    const g = this.leashes.clear().fillStyle(PALETTE.ink, 0.9);
    for (const p of this.people) {
      const L = p.leader;
      if (p.kind !== 'dog' || !L || L.gone || p.state === 'board') continue;
      const hx = Math.round(L.x - L.dir.y * p.side * 3);
      const hy = Math.round(L.y - 4);
      const cx = Math.round(p.x + (Math.abs(p.dir.x) > 0 ? p.dir.x * 3 : 0));
      const cy = Math.round(p.y - 4);
      // Bresenham, one pixel at a time for a crisp line.
      let x = hx;
      let y = hy;
      const dx = Math.abs(cx - hx);
      const dy = -Math.abs(cy - hy);
      const stepX = hx < cx ? 1 : -1;
      const stepY = hy < cy ? 1 : -1;
      let err = dx + dy;
      for (let n = 0; n < 64; n++) {
        g.fillRect(x, y, 1, 1);
        if (x === cx && y === cy) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x += stepX;
        }
        if (e2 <= dx) {
          err += dx;
          y += stepY;
        }
      }
    }
  }

  private draw(p: Person) {
    const facing: Facing = Math.abs(p.dir.x) > Math.abs(p.dir.y) ? 'side' : p.dir.y < 0 ? 'up' : 'down';
    const moving = p.state === 'walk' || p.state === 'board' || p.state === 'cross' || (p.state === 'follow' && p.moving);
    const frame = moving ? 1 + (Math.floor(p.phase / STEP_PX) % 2) : 0;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    p.sprite
      .setFrame(sheetFrame(p.variant, facing, frame))
      .setFlipX(facing === 'side' && p.dir.x < 0)
      .setPosition(x, y)
      .setRotation(p.state === 'down' ? Math.PI / 2 : 0)
      .setDepth(8 + y / 100000);
    p.shadow.setPosition(x, y);
  }

  destroy() {
    for (let i = this.people.length - 1; i >= 0; i--) this.remove(i);
    this.leashes.destroy();
  }
}
