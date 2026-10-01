import type { Surface } from './tiles';

export interface SurfaceParams {
  /** Can't be driven into. */
  solid: boolean;
  /** Lateral velocity damping rate (1/s). Lower = more drift. */
  grip: number;
  /** Longitudinal drag (1/s). */
  drag: number;
  /** Engine force multiplier. */
  accel: number;
  /** Top speed on this surface in px/s. */
  maxSpeed: number;
  /** Visual rumble amplitude in px. */
  rumble: number;
  label: string;
}

const SOLID: SurfaceParams = { solid: true, grip: 0, drag: 0, accel: 0, maxSpeed: 0, rumble: 0, label: '' };

/** Tram rails: a bit less grip and a rattle, on top of whatever surface they're set into. */
export function withRails(s: SurfaceParams): SurfaceParams {
  return RAILED.get(s) ?? RAILED.set(s, { ...s, grip: s.grip * 0.7, rumble: Math.max(s.rumble, 0.5), label: 'TRAM RAILS' }).get(s)!;
}
const RAILED = new Map<SurfaceParams, SurfaceParams>();

export const SURFACES: Record<Surface, SurfaceParams> = {
  asphalt: { solid: false, grip: 11, drag: 0.35, accel: 1.0, maxSpeed: 190, rumble: 0, label: 'ASPHALT' },
  cobble: { solid: false, grip: 6.5, drag: 0.6, accel: 0.85, maxSpeed: 150, rumble: 0.5, label: 'COBBLESTONE' },
  paving: { solid: false, grip: 8, drag: 1.0, accel: 0.75, maxSpeed: 120, rumble: 0.25, label: 'SIDEWALK' },
  grass: { solid: false, grip: 3, drag: 1.6, accel: 0.55, maxSpeed: 85, rumble: 0.6, label: 'GRASS' },
  water: { ...SOLID, label: 'WATER' },
  building: { ...SOLID, label: 'BUILDING' },
  tree: { ...SOLID, label: 'TREE' },
};
