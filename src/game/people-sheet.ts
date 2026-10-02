// Layout of the pedestrian sprite sheet, shared by the generator (scripts/lib/people.ts) and the game.
// One row per look (hair/skin/clothes); columns are facing × walk frame. Side frames face right;
// the game mirrors them for left.

export const PERSON_W = 8;
export const PERSON_H = 12;
export const PERSON_VARIANTS = 12;

export type Facing = 'down' | 'up' | 'side';
export const FACINGS: readonly Facing[] = ['down', 'up', 'side'];
/** Frames per facing: standing, left step, right step. */
export const WALK_FRAMES = 3;

export const personFrame = (variant: number, facing: Facing, frame: number) =>
  variant * FACINGS.length * WALK_FRAMES + FACINGS.indexOf(facing) * WALK_FRAMES + frame;
