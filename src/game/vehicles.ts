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
  /**
   * Visual side-to-side sway (bikes): rocks while pedalling, once per `cycleM` metres travelled,
   * plus a slow balance wobble at walking pace. `amplitude` is in sprite pixels (scaled like the sprite).
   */
  sway?: { amplitude: number; cycleM: number };
  /** This vehicle's own scale, overriding VEHICLE_SCALE (e.g. to make it true to life). */
  scale?: number;
  /** Final sprite scale, filled in by `scaled()`; leave unset in the specs below. */
  spriteScale?: number;
  /** Where skid marks are dropped, [x forward, y right]. */
  skidWheels: ReadonlyArray<[number, number]>;
  /** Fraction of speed lost per axle when mounting a curb (40% of that when dropping off one). Default 0.05. */
  curbLoss?: number;
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
  /** Hard top speed in km/h (as shown in the HUD), on every surface. */
  governorKmh?: number;
  /**
   * Small wheels: going faster than `speed` (px/s) on a surface with at least `minRumble` fills a
   * wobble meter over `seconds` and throws the rider off when full. Hitting a curb faster than
   * `curbSpeed` does it at once.
   */
  roughFall?: { minRumble: number; speed: number; seconds: number; curbSpeed: number };
  /** Boat: moves only on water (and under bridges); land is solid. Physics act relative to the water. */
  onWater?: boolean;
  /** River current at mid-channel (px/s) that carries a boat downstream. */
  current?: number;
  /** Leaves a white wake instead of skid marks. */
  wake?: boolean;
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
  halfLength: 6.5,
  halfWidth: 4.5,
  skidWheels: [[-5, -4.5], [-5, 4.5]],
};

/**
 * Bicycle: slow on open road but nimble, narrow and at home on the sidewalk. Cobbles
 * rattle, and tram rails crossed at a shallow angle catch the front wheel.
 */
export const BIKE: VehicleSpec = {
  id: 'bike',
  name: 'BICYCLE',
  sprite: 'bike',
  // A touch over real size for readability: the sprite is drawn 15 px long;
  // 15 × 1.0 × 0.140625 m/px ≈ 2.1 m (a real bicycle is ~1.75 m).
  scale: 1.0,
  sway: { amplitude: 0.55, cycleM: 4.6 }, // ~90 rpm at 25 km/h = one sway per crank revolution
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
  curbLoss: 0.12, // small wheels, you feel every curb
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

/**
 * Folkabuss (VW Type 2): long and boxy with a wheezy air-cooled engine. Slow to get going,
 * low top speed, heavy steering, and a tall soft body that rattles over cobbles.
 */
export const BUS: VehicleSpec = {
  ...CAR,
  id: 'bus',
  name: 'FOLKABUSS',
  sprite: 'bus',
  engine: 105,
  engineFade: 0.2,
  brake: 230,
  reverseAccel: 70,
  reverseMax: 40,
  rolling: 14,
  turnRate: 2.3,
  turnFullSpeed: 40,
  grip: 0.85,
  handbrakeGrip: 0.3,
  bounce: 0.25,
  curbLoss: 0.03, // heavy, big wheels
  halfLength: 8.5,
  halfWidth: 4.5,
  skidWheels: [[-5, -4.5], [-5, 4.5]],
  surfaces: {
    asphalt: { maxSpeed: 145 },
    cobble: { maxSpeed: 120, rumble: 0.9 },
    paving: { maxSpeed: 100, rumble: 0.5 },
  },
};

/**
 * EPA-traktor: a car converted to a tractor so teenagers can drive it, governed to 30 km/h.
 * Pulls hard up to the limiter and then that's it. Boxy, a bit wobbly, and the slow-vehicle
 * triangle on the back.
 */
export const EPA: VehicleSpec = {
  ...CAR,
  id: 'epa',
  name: 'EPA-TRAKTOR',
  sprite: 'epa',
  engine: 230,
  governorKmh: 30,
  reverseMax: 30,
  turnRate: 2.6,
  grip: 0.8,
  handbrakeGrip: 0.25,
  halfLength: 6.5,
  halfWidth: 3.5,
  skidWheels: [[-5, -3.5], [-5, 3.5]],
};

/**
 * Electric kick scooter: tiny, instant pull, turns on the spot. Its small wheels hate cobbles,
 * grass and curbs, and it falls over at the slightest excuse.
 */
export const SCOOTER: VehicleSpec = {
  id: 'scooter',
  name: 'E-SCOOTER',
  sprite: 'scooter',
  scale: 1.0, // real size, like the bike
  engine: 260,
  engineFade: 0.5,
  brake: 260,
  reverseAccel: 25,
  reverseMax: 12,
  rolling: 22,
  turnRate: 5.0,
  turnFullSpeed: 10,
  grip: 1.6,
  handbrakeGrip: 0.35,
  bounce: 0.2,
  curbLoss: 0.2,
  halfLength: 5,
  halfWidth: 1.5,
  skidWheels: [[-4, 0]],
  railGrip: 0.45,
  surfaces: {
    asphalt: { maxSpeed: 100 },
    paving: { maxSpeed: 100, accel: 1, drag: 0.4 },
    cobble: { maxSpeed: 55, accel: 0.6, drag: 1.2, rumble: 1.5 },
    grass: { maxSpeed: 30, accel: 0.3, drag: 3, rumble: 1.2 },
  },
  crashImpact: 50,
  railTrap: { minDeg: 4, maxDeg: 35, minSpeed: 20 },
  roughFall: { minRumble: 1, speed: 40, seconds: 0.6, curbSpeed: 70 },
  downTime: 1.4,
};

/**
 * Motorboat on Motala ström: no brakes (only reverse thrust), a lazy rudder that needs water
 * flowing past it, and the current carries you downstream whenever you ease off.
 */
export const BOAT: VehicleSpec = {
  id: 'boat',
  name: 'MOTORBOAT',
  sprite: 'boat',
  onWater: true,
  current: 24,
  wake: true,
  engine: 90,
  engineFade: 0.3,
  brake: 70, // reverse thrust
  reverseAccel: 50,
  reverseMax: 35,
  rolling: 6,
  turnRate: 1.9,
  turnFullSpeed: 25,
  grip: 1,
  handbrakeGrip: 0.6,
  bounce: 0.45, // fenders
  halfLength: 6,
  halfWidth: 3,
  skidWheels: [],
  railGrip: 1,
  surfaces: {
    water: { solid: false, grip: 1.4, drag: 0.45, accel: 1, maxSpeed: 110, rumble: 0, label: 'MOTALA STRÖM' },
  },
};

/**
 * Draws every vehicle this much bigger, together with everything tied to its size (hitbox,
 * skid wheels, light positions). At 1 the 16px hatchback is about half real size (1 px = 0.14 m).
 * Specs above stay in unscaled sprite pixels.
 */
export const VEHICLE_SCALE = 1.5;

function scaled(v: VehicleSpec): VehicleSpec {
  const k = v.scale ?? VEHICLE_SCALE;
  return {
    ...v,
    spriteScale: k,
    halfLength: v.halfLength * k,
    halfWidth: v.halfWidth * k,
    skidWheels: v.skidWheels.map(([x, y]) => [x * k, y * k] as [number, number]),
    sway: v.sway && { ...v.sway, amplitude: v.sway.amplitude * k },
  };
}

export const VEHICLES: readonly VehicleSpec[] = [CAR, EV, BUS, EPA, BIKE, SCOOTER, BOAT].map(scaled);

export function vehicleById(id: unknown): VehicleSpec {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
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
