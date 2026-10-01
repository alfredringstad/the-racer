import Phaser from 'phaser';
import type { DriveInput } from './input';
import type { SurfaceParams } from './surfaces';
import { LAMP_RADIUS, type TrackMap } from './TrackMap';
import { surfacesFor, type VehicleSpec, type VehicleSurfaces } from './vehicles';

const SPRITE_ANGLE_STEPS = 32; // sprite rotation snaps to this many directions for a crisp retro look

export class Car {
  x: number;
  y: number;
  heading: number; // radians, 0 = east
  vx = 0;
  vy = 0;
  surface: SurfaceParams;
  /** Lateral speed this frame (px/s), for skid marks/HUD. */
  slip = 0;
  /** Impact speed of a collision this frame, 0 if none. */
  impact = 0;
  /** Seconds left lying on the ground after a fall (bike). */
  down = 0;
  /** Why we fell, for the HUD. */
  downReason = '';
  /** Set by the scene: returns the rail direction if a move crosses a tram rail. */
  railCrossed?: (x0: number, y0: number, x1: number, y1: number) => { x: number; y: number } | undefined;

  readonly sprite: Phaser.GameObjects.Image;
  readonly shadow: Phaser.GameObjects.Image;
  private readonly surfaces: VehicleSurfaces;
  /** Collision probe points in vehicle space (x forward, y right): corners and edge midpoints. */
  private readonly probes: ReadonlyArray<[number, number]>;

  constructor(
    scene: Phaser.Scene,
    private readonly map: TrackMap,
    readonly spec: VehicleSpec,
    x: number,
    y: number,
    headingDeg: number,
  ) {
    this.x = x;
    this.y = y;
    this.heading = Phaser.Math.DegToRad(headingDeg);
    this.surfaces = surfacesFor(spec);
    this.surface = this.surfaces.plain.asphalt;
    const l = spec.halfLength;
    const w = spec.halfWidth;
    this.probes = [[l, -w], [l, w], [-l, -w], [-l, w], [l, 0], [-l, 0], [0, -w], [0, w]];
    const scale = spec.spriteScale ?? 1;
    this.shadow = scene.add.image(x, y, spec.sprite).setScale(scale).setTintMode(Phaser.TintModes.FILL).setTint(0x2b2a3a).setAlpha(0.35).setDepth(9);
    this.sprite = scene.add.image(x, y, spec.sprite).setScale(scale).setDepth(10);
    this.syncSprite(0);
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }

  /** Signed speed along the car's heading. */
  get forwardSpeed() {
    return this.vx * Math.cos(this.heading) + this.vy * Math.sin(this.heading);
  }

  update(input: DriveInput, dtMs: number, time: number) {
    const dt = Math.min(dtMs / 1000, 1 / 30);
    if (this.down > 0) {
      this.down -= dt;
      input = { throttle: false, brake: false, steer: 0, handbrake: false };
    }
    const v = this.spec;
    this.surface = (this.map.onRailsAt(this.x, this.y) ? this.surfaces.railed : this.surfaces.plain)[this.map.surfaceAt(this.x, this.y)];
    const s = this.surface;

    const fx = Math.cos(this.heading);
    const fy = Math.sin(this.heading);
    // right-hand vector (y is down on screen, so this is clockwise of forward)
    const rx = -fy;
    const ry = fx;
    let vF = this.vx * fx + this.vy * fy;
    let vL = this.vx * rx + this.vy * ry;

    // Longitudinal
    const engine = v.engine * s.accel * (1 - v.engineFade * Phaser.Math.Clamp(vF / s.maxSpeed, 0, 1));
    if (input.throttle) vF += (vF < -1 ? v.brake : engine) * dt;
    if (input.brake) vF -= (vF > 1 ? v.brake : v.reverseAccel * s.accel) * dt;
    if (input.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), v.brake * 0.35 * dt);
    if (!input.throttle && !input.brake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), v.rolling * dt);
    vF -= vF * s.drag * dt;
    // Soft speed caps so driving onto grass bleeds speed instead of stopping dead.
    if (vF > s.maxSpeed) vF += (s.maxSpeed - vF) * Math.min(1, 2.5 * dt);
    if (vF < -v.reverseMax) vF += (-v.reverseMax - vF) * Math.min(1, 4 * dt);

    // Lateral: grip bleeds off sideways velocity; low grip → drift.
    const grip = s.grip * v.grip * (input.handbrake ? v.handbrakeGrip : 1);
    if (this.down > 0) vF *= Math.exp(-5 * dt); // sliding along on your side
    vL *= Math.exp(-grip * dt);
    this.slip = vL;

    // Steering: needs some speed, slightly less authority at top speed, reversed when backing up.
    const authority = Math.min(1, Math.abs(vF) / v.turnFullSpeed) * (1 - 0.3 * Math.min(1, Math.abs(vF) / 190));
    const turn = input.steer * v.turnRate * authority * Math.sign(vF) * (input.handbrake ? 1.35 : 1) * dt;
    if (turn !== 0 && !this.collides(this.x, this.y, this.heading + turn)) this.heading += turn;

    this.vx = fx * vF + rx * vL;
    this.vy = fy * vF + ry * vL;

    // Move per axis so we can slide along walls.
    this.impact = 0;
    const x0 = this.x;
    const y0 = this.y;
    const nx = this.x + this.vx * dt;
    if (this.collides(nx, this.y, this.heading)) {
      this.impact = Math.max(this.impact, Math.abs(this.vx));
      this.vx *= -v.bounce;
      this.vy *= 0.85;
    } else this.x = nx;
    const ny = this.y + this.vy * dt;
    if (this.collides(this.x, ny, this.heading)) {
      this.impact = Math.max(this.impact, Math.abs(this.vy));
      this.vy *= -v.bounce;
      this.vx *= 0.85;
    } else this.y = ny;

    if (v.crashImpact && this.impact > v.crashImpact) this.fall('CRASH!');
    if (v.railTrap && this.down <= 0 && this.speed > v.railTrap.minSpeed) {
      const rail = this.railCrossed?.(x0, y0, this.x, this.y);
      if (rail) {
        // Angle between travel direction and the rail, 0..90°.
        const cos = Math.abs(this.vx * rail.x + this.vy * rail.y) / this.speed;
        const deg = Phaser.Math.RadToDeg(Math.acos(Math.min(1, cos)));
        if (deg >= v.railTrap.minDeg && deg <= v.railTrap.maxDeg) this.fall('TRAM RAIL!');
      }
    }

    this.syncSprite(time);
  }

  private fall(reason: string) {
    if (this.down > 0) return;
    this.down = this.spec.downTime ?? 1;
    this.downReason = reason;
  }

  private collides(x: number, y: number, heading: number) {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    for (const [px, py] of this.probes) if (this.map.isSolidAt(x + px * c - py * s, y + px * s + py * c)) return true;
    // Lamp posts: thin round obstacles, tested against the vehicle's rotated box.
    for (const o of this.map.obstaclesNear(x, y)) {
      const dx = o.x - x;
      const dy = o.y - y;
      if (Math.abs(dx * c + dy * s) < this.spec.halfLength + LAMP_RADIUS && Math.abs(-dx * s + dy * c) < this.spec.halfWidth + LAMP_RADIUS) return true;
    }
    return false;
  }

  private syncSprite(time: number) {
    const step = (Math.PI * 2) / SPRITE_ANGLE_STEPS;
    // Lying on the ground: knocked a quarter-turn askew and blinking.
    const angle = Math.round(this.heading / step) * step + (this.down > 0 ? Math.PI / 2 : 0);
    this.sprite.setAlpha(this.down > 0 && Math.floor(time / 100) % 2 ? 0.4 : 1);
    // Rumble on rough surfaces, scaled by speed.
    const amp = this.surface.rumble * Math.min(1, this.speed / 60);
    const jx = amp ? Math.round(Math.sin(time * 0.07) * amp) : 0;
    const jy = amp ? Math.round(Math.cos(time * 0.091) * amp) : 0;
    this.sprite.setPosition(this.x + jx, this.y + jy).setRotation(angle);
    this.shadow.setPosition(this.x + 1, this.y + 2).setRotation(angle);
  }
}
