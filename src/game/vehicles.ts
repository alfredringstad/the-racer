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

export const VEHICLES: readonly VehicleSpec[] = [CAR];

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
