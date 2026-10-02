// Pedestrian sprite sheet: small Pokémon-style people in a few looks, three facings and a walk cycle.

import { Img } from './png';
import { PALETTE as P } from '../../src/game/palette';
import { FACINGS, PERSON_H, PERSON_VARIANTS, PERSON_W, WALK_FRAMES, type Facing } from '../../src/game/people-sheet';

// h hair, s skin, k ink (eyes, shoes), c shirt, d shirt shade (arms), p trousers.
const HEAD: Record<Facing, string[]> = {
  down: ['..hhhh..', '.hhhhhh.', '.hssssh.', '.skssks.', '..ssss..'],
  up: ['..hhhh..', '.hhhhhh.', '.hhhhhh.', '.hhhhhh.', '..hhhh..'],
  side: ['..hhhh..', '.hhhhhh.', '.hhhsss.', '.hhssks.', '...sss..'],
};
const BODY: Record<Facing, string[][]> = {
  // [standing, left step, right step], rows 5–11
  down: [
    ['..cccc..', '.dccccd.', '.dccccd.', '.sccccs.', '..pppp..', '..p..p..', '..k..k..'],
    ['..cccc..', '.dccccd.', '.dccccd.', '.scccc..', '..pppp..', '..p..p..', '..k.....'],
    ['..cccc..', '.dccccd.', '.dccccd.', '..ccccs.', '..pppp..', '..p..p..', '.....k..'],
  ],
  up: [
    ['..cccc..', '.dccccd.', '.dccccd.', '.sccccs.', '..pppp..', '..p..p..', '..k..k..'],
    ['..cccc..', '.dccccd.', '.dccccd.', '..ccccs.', '..pppp..', '..p..p..', '.....k..'],
    ['..cccc..', '.dccccd.', '.dccccd.', '.scccc..', '..pppp..', '..p..p..', '..k.....'],
  ],
  side: [
    ['..cccc..', '..cccc..', '..cdcc..', '..cscc..', '..pppp..', '...pp...', '...kk...'],
    ['..cccc..', '..cccc..', '..ccdc..', '..ccsc..', '..pppp..', '..p..p..', '.k....k.'],
    ['..cccc..', '..cccc..', '..dccc..', '..sccc..', '..pppp..', '...pp...', '...kk...'],
  ],
};

const darken = (c: number, k = 0.72) =>
  (Math.round(((c >> 16) & 0xff) * k) << 16) | (Math.round(((c >> 8) & 0xff) * k) << 8) | Math.round((c & 0xff) * k);

const HAIR = [P.ink, P.trunk, P.gold, P.stone, P.brick, P.woodDark];
const SKIN = [P.skinLight, P.skinMid, P.skinDark];
const SHIRTS = [P.awningRed, P.awningBlue, P.awningGreen, P.gold, P.copper, P.busBody, P.stained, P.uiText, P.carBody];
const TROUSERS = [P.signBlue, P.shadow, P.wood, P.ink, P.stoneDark];

/** Sheet: one row per variant, columns are facing × frame (see src/game/people-sheet.ts). */
export function drawPeople(): Img {
  const img = new Img(PERSON_W * FACINGS.length * WALK_FRAMES, PERSON_H * PERSON_VARIANTS);
  for (let v = 0; v < PERSON_VARIANTS; v++) {
    // Spread the looks so neighbouring variants differ in everything.
    const shirt = SHIRTS[(v * 4) % SHIRTS.length];
    const colors = {
      h: HAIR[(v * 5 + 1) % HAIR.length],
      s: SKIN[v % SKIN.length],
      k: P.ink,
      c: shirt,
      d: darken(shirt),
      p: TROUSERS[(v * 3 + 2) % TROUSERS.length],
    };
    FACINGS.forEach((facing, fi) => {
      for (let f = 0; f < WALK_FRAMES; f++)
        img.pattern((fi * WALK_FRAMES + f) * PERSON_W, v * PERSON_H, [...HEAD[facing], ...BODY[facing][f]], colors);
    });
  }
  return img;
}
