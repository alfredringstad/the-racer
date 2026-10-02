// Road sign contract shared by the map generator (scripts/) and the game: sign kinds and their
// frame in public/assets/sprites/signs.png (one row of SIGN_W × SIGN_H frames, front-facing,
// post at the bottom). Swedish designs.

export const SIGN_W = 14;
export const SIGN_H = 24;
/** Row of the post's foot within a frame; the sign's map point sits here. */
export const SIGN_FOOT_ROW = 21;

/** Speed limits that have their own sign frame (km/h). */
export const SPEED_LIMITS = [5, 10, 20, 30, 40, 50, 60, 70, 80] as const;

export const SIGN_KINDS = ['give_way', 'stop', 'oneway', 'no_entry', 'crossing'] as const;
export type SignKind = (typeof SIGN_KINDS)[number] | 'speed';

/** Frame index for a sign; speed signs use their limit. Undefined if there's no frame for it. */
export function signFrame(kind: SignKind, value?: number): number | undefined {
  if (kind === 'speed') {
    const i = SPEED_LIMITS.indexOf(value as (typeof SPEED_LIMITS)[number]);
    return i < 0 ? undefined : i;
  }
  return SPEED_LIMITS.length + SIGN_KINDS.indexOf(kind);
}

export const SIGN_FRAME_COUNT = SPEED_LIMITS.length + SIGN_KINDS.length;
