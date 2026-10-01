import type { Surface } from './tiles';
import { SURFACES, withRails, type SurfaceParams } from './surfaces';

/** Everything that makes one vehicle drive differently from another (px, seconds). */
export interface VehicleSpec {
  id: string;
  /** Shown in the HUD. */
  name: string;
  /** Texture key. */
  sprite: string;
  /** Engine force at standstill (px/s²), before the surface's accel multiplier. */
  engine: number;
  /** Fraction of engine force gone at the surface's top speed. 0 = flat, higher = punchy low-end torque. */
  engineFade: number;
  brake: number;
  reverseAccel: number;
  reverseMax: number;
  /** Coasting deceleration (px/s²). */
  rolling: number;
  /** rad/s at full steer. */
  turnRate: number;
  /** px/s at which steering reaches full authority. */
  turnFullSpeed: number;
  /** Multiplies surface grip. Below 1 = heavier, keeps sliding through corners. */
  grip: number;
  /** Grip multiplier while handbraking. */
  handbrakeGrip: number;
  /** Velocity kept (and reversed) on wall hit. */
  bounce: number;
  /** Collision box half-extents in vehicle space (x forward, y right). */
  halfLength: number;
  halfWidth: number;
  /** Where skid marks are dropped, [x forward, y right]. */
  skidWheels: ReadonlyArray<[number, number]>;
  /** Grip multiplier on tram rails. */
  railGrip: number;
  /** Per-surface overrides, e.g. a bike that's at home on the sidewalk. */
  surfaces?: Partial<Record<Surface, Partial<SurfaceParams>>>;
  /** Wall impact speed (px/s) that knocks the rider off. Unset = can't fall. */
  crashImpact?: number;
  /** Crossing tram rails at a shallow angle (degrees) above minSpeed catches the wheel in the groove. */
  railTrap?: { minDeg: number; maxDeg: number; minSpeed: number };
  /** Seconds spent getting back up after a fall. */
  downTime?: number;
}

export const CAR: VehicleSpec = {
  id: 'car',
  name: 'HATCHBACK',
  sprite: 'car',
  engine: 165,
  engineFade: 0,
  brake: 340,
  reverseAccel: 90,
  reverseMax: 50,
  rolling: 12,
  turnRate: 3.0,
  turnFullSpeed: 35,
  grip: 1,
  handbrakeGrip: 0.22,
  bounce: 0.3,
  halfLength: 5.5,
  halfWidth: 3.5,
  skidWheels: [[-4, -3.5], [-4, 3.5]],
  railGrip: 0.7,
};

/**
 * Electric car: instant torque that tapers off, regen braking when you lift off, and
 * the battery's weight means less grip, so it slides wide and thuds into walls.
 */
export const EV: VehicleSpec = {
  ...CAR,
  id: 'ev',
  name: 'ELECTRIC CAR',
  sprite: 'ev',
  engine: 260,
  engineFade: 0.6,
  brake: 290,
  reverseAccel: 130,
  reverseMax: 60,
  rolling: 45,
  turnRate: 2.7,
  grip: 0.72,
  handbrakeGrip: 0.2,
  bounce: 0.15,
};

/**
 * Bicycle: slow on open road but nimble, narrow and at home on the sidewalk. Cobbles
 * rattle, and tram rails crossed at a shallow angle catch the front wheel.
 */
export const BIKE: VehicleSpec = {
  id: 'bike',
  name: 'BICYCLE',
  sprite: 'bike',
  engine: 150,
  engineFade: 0.75,
  brake: 300,
  reverseAccel: 25,
  reverseMax: 12, // walking it backwards
  rolling: 16,
  turnRate: 4.2,
  turnFullSpeed: 18,
  grip: 1.5,
  handbrakeGrip: 0.3,
  bounce: 0.2,
  halfLength: 5.5,
  halfWidth: 1.5,
  skidWheels: [[-4, 0]],
  railGrip: 0.5,
  surfaces: {
    asphalt: { maxSpeed: 120 },
    paving: { maxSpeed: 112, accel: 0.95, drag: 0.4 },
    cobble: { maxSpeed: 80, accel: 0.7, drag: 0.9, rumble: 1 },
    grass: { maxSpeed: 45, accel: 0.45, drag: 2.2 },
  },
  crashImpact: 70,
  railTrap: { minDeg: 6, maxDeg: 28, minSpeed: 30 },
  downTime: 1.2,
};

export const VEHICLES: readonly VehicleSpec[] = [CAR, EV, BIKE];

export function vehicleById(id: unknown): VehicleSpec {
  return VEHICLES.find((v) => v.id === id) ?? CAR;
}

export interface VehicleSurfaces {
  plain: Record<Surface, SurfaceParams>;
  railed: Record<Surface, SurfaceParams>;
}

const surfaceCache = new Map<VehicleSpec, VehicleSurfaces>();

/** Surface table with the vehicle's overrides applied, plus the same with tram rails set in. */
export function surfacesFor(spec: VehicleSpec): VehicleSurfaces {
  let t = surfaceCache.get(spec);
  if (!t) {
    const plain = {} as Record<Surface, SurfaceParams>;
    const railed = {} as Record<Surface, SurfaceParams>;
    for (const k of Object.keys(SURFACES) as Surface[]) {
      plain[k] = { ...SURFACES[k], ...spec.surfaces?.[k] };
      railed[k] = withRails(plain[k], spec.railGrip);
    }
    surfaceCache.set(spec, (t = { plain, railed }));
  }
  return t;
}
