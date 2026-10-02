// Layout of the pedestrian sprite sheets (adults, kids, dogs), shared by the generator
// (scripts/lib/people.ts) and the game. One row per look; columns are facing × walk frame.
// Side frames face right; the game mirrors them for left.

export interface SheetSpec {
  key: string;
  w: number;
  h: number;
  variants: number;
}

export const ADULTS: SheetSpec = { key: 'people', w: 8, h: 12, variants: 12 };
export const KIDS: SheetSpec = { key: 'kids', w: 8, h: 9, variants: 8 };
export const DOGS: SheetSpec = { key: 'dogs', w: 10, h: 8, variants: 4 };
/** NPC cyclists, top-down like the player's bike and facing east; columns are two pedalling frames. */
export const CYCLISTS: SheetSpec = { key: 'cyclists', w: 16, h: 16, variants: 6 };
export const CYCLIST_FRAMES = 2;
export const SHEETS: readonly SheetSpec[] = [ADULTS, KIDS, DOGS, CYCLISTS];

export type Facing = 'down' | 'up' | 'side';
export const FACINGS: readonly Facing[] = ['down', 'up', 'side'];
/** Frames per facing: standing, left step, right step. */
export const WALK_FRAMES = 3;

export const sheetFrame = (variant: number, facing: Facing, frame: number) =>
  variant * FACINGS.length * WALK_FRAMES + FACINGS.indexOf(facing) * WALK_FRAMES + frame;
