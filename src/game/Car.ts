import Phaser from 'phaser';
import type { DriveInput } from './input';
import { SURFACES, type SurfaceParams } from './surfaces';
import type { TrackMap } from './TrackMap';

// Tuning (px, seconds).
const ENGINE = 165; // px/s² at accel multiplier 1
const BRAKE = 340;
const REVERSE_ACCEL = 90;
const REVERSE_MAX = 50;
const ROLLING = 12; // px/s² coasting deceleration
const TURN_RATE = 3.0; // rad/s at full steer
const TURN_FULL_SPEED = 35; // px/s at which steering reaches full authority
const HANDBRAKE_GRIP = 0.22; // grip multiplier while handbraking
const BOUNCE = 0.3; // velocity kept (and reversed) on wall hit
const SPRITE_ANGLE_STEPS = 32; // sprite rotation snaps to this many directions for a crisp retro look

// Collision probe points in car-local space (x forward, y right). Sprite body is 12×8.
const PROBES: ReadonlyArray<[number, number]> = [
  [5.5, -3.5], [5.5, 3.5], [-5.5, -3.5], [-5.5, 3.5], [5.5, 0], [-5.5, 0], [0, -3.5], [0, 3.5],
];

export class Car {
  x: number;
  y: number;
  heading: number; // radians, 0 = east
  vx = 0;
  vy = 0;
  surface: SurfaceParams = SURFACES.asphalt;
  /** Lateral speed this frame (px/s), for skid marks/HUD. */
  slip = 0;
  /** Impact speed of a collision this frame, 0 if none. */
  impact = 0;

  readonly sprite: Phaser.GameObjects.Image;
  readonly shadow: Phaser.GameObjects.Image;

  constructor(
    scene: Phaser.Scene,
    private readonly map: TrackMap,
    x: number,
    y: number,
    headingDeg: number,
  ) {
    this.x = x;
    this.y = y;
    this.heading = Phaser.Math.DegToRad(headingDeg);
    this.shadow = scene.add.image(x, y, 'car').setTintMode(Phaser.TintModes.FILL).setTint(0x2b2a3a).setAlpha(0.35).setDepth(9);
    this.sprite = scene.add.image(x, y, 'car').setDepth(10);
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
    this.surface = SURFACES[this.map.surfaceAt(this.x, this.y)];
    const s = this.surface;

    const fx = Math.cos(this.heading);
    const fy = Math.sin(this.heading);
    // right-hand vector (y is down on screen, so this is clockwise of forward)
    const rx = -fy;
    const ry = fx;
    let vF = this.vx * fx + this.vy * fy;
    let vL = this.vx * rx + this.vy * ry;

    // Longitudinal
    if (input.throttle) vF += (vF < -1 ? BRAKE : ENGINE * s.accel) * dt;
    if (input.brake) vF -= (vF > 1 ? BRAKE : REVERSE_ACCEL * s.accel) * dt;
    if (input.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), BRAKE * 0.35 * dt);
    if (!input.throttle && !input.brake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), ROLLING * dt);
    vF -= vF * s.drag * dt;
    // Soft speed caps so driving onto grass bleeds speed instead of stopping dead.
    if (vF > s.maxSpeed) vF += (s.maxSpeed - vF) * Math.min(1, 2.5 * dt);
    if (vF < -REVERSE_MAX) vF += (-REVERSE_MAX - vF) * Math.min(1, 4 * dt);

    // Lateral: grip bleeds off sideways velocity; low grip → drift.
    const grip = s.grip * (input.handbrake ? HANDBRAKE_GRIP : 1);
    vL *= Math.exp(-grip * dt);
    this.slip = vL;

    // Steering: needs some speed, slightly less authority at top speed, reversed when backing up.
    const authority = Math.min(1, Math.abs(vF) / TURN_FULL_SPEED) * (1 - 0.3 * Math.min(1, Math.abs(vF) / 190));
    const turn = input.steer * TURN_RATE * authority * Math.sign(vF) * (input.handbrake ? 1.35 : 1) * dt;
    if (turn !== 0 && !this.collides(this.x, this.y, this.heading + turn)) this.heading += turn;

    this.vx = fx * vF + rx * vL;
    this.vy = fy * vF + ry * vL;

    // Move per axis so we can slide along walls.
    this.impact = 0;
    const nx = this.x + this.vx * dt;
    if (this.collides(nx, this.y, this.heading)) {
      this.impact = Math.max(this.impact, Math.abs(this.vx));
      this.vx *= -BOUNCE;
      this.vy *= 0.85;
    } else this.x = nx;
    const ny = this.y + this.vy * dt;
    if (this.collides(this.x, ny, this.heading)) {
      this.impact = Math.max(this.impact, Math.abs(this.vy));
      this.vy *= -BOUNCE;
      this.vx *= 0.85;
    } else this.y = ny;

    this.syncSprite(time);
  }

  private collides(x: number, y: number, heading: number) {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    for (const [px, py] of PROBES) if (this.map.isSolidAt(x + px * c - py * s, y + px * s + py * c)) return true;
    return false;
  }

  private syncSprite(time: number) {
    const step = (Math.PI * 2) / SPRITE_ANGLE_STEPS;
    const angle = Math.round(this.heading / step) * step;
    // Rumble on rough surfaces, scaled by speed.
    const amp = this.surface.rumble * Math.min(1, this.speed / 60);
    const jx = amp ? Math.round(Math.sin(time * 0.07) * amp) : 0;
    const jy = amp ? Math.round(Math.cos(time * 0.091) * amp) : 0;
    this.sprite.setPosition(this.x + jx, this.y + jy).setRotation(angle);
    this.shadow.setPosition(this.x + 1, this.y + 2).setRotation(angle);
  }
}
