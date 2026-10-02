// Pedestrian sprite sheets: small Pokémon-style adults and kids in a few looks, and dogs.
// Each has three facings and a walk cycle (layout in src/game/people-sheet.ts).

import { Img } from './png';
import { PALETTE as P } from '../../src/game/palette';
import { ADULTS, DOGS, FACINGS, KIDS, WALK_FRAMES, type Facing, type SheetSpec } from '../../src/game/people-sheet';

type Frames = Record<Facing, string[][]>;

const darken = (c: number, k = 0.72) =>
  (Math.round(((c >> 16) & 0xff) * k) << 16) | (Math.round(((c >> 8) & 0xff) * k) << 8) | Math.round((c & 0xff) * k);

/** Builds a sheet from per-facing frames, recoloured per variant. */
function sheet(spec: SheetSpec, frames: Frames, colors: (v: number) => Record<string, number>): Img {
  const img = new Img(spec.w * FACINGS.length * WALK_FRAMES, spec.h * spec.variants);
  for (let v = 0; v < spec.variants; v++) {
    const c = colors(v);
    FACINGS.forEach((facing, fi) => {
      for (let f = 0; f < WALK_FRAMES; f++) img.pattern((fi * WALK_FRAMES + f) * spec.w, v * spec.h, frames[facing][f], c);
    });
  }
  return img;
}

/** Head rows + [standing, left step, right step] body rows, per facing. */
const person = (head: Record<Facing, string[]>, body: Frames): Frames => ({
  down: body.down.map((b) => [...head.down, ...b]),
  up: body.up.map((b) => [...head.up, ...b]),
  side: body.side.map((b) => [...head.side, ...b]),
});

// h hair, s skin, k ink (eyes, shoes), c shirt, d shirt shade (arms), p trousers.
const ADULT_FRAMES = person(
  {
    down: ['..hhhh..', '.hhhhhh.', '.hssssh.', '.skssks.', '..ssss..'],
    up: ['..hhhh..', '.hhhhhh.', '.hhhhhh.', '.hhhhhh.', '..hhhh..'],
    side: ['..hhhh..', '.hhhhhh.', '.hhhsss.', '.hhssks.', '...sss..'],
  },
  {
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
  },
);

// Kids: same style, shorter (big head, short body).
const KID_FRAMES = person(
  {
    down: ['..hhhh..', '.hhhhhh.', '.skssks.', '..ssss..'],
    up: ['..hhhh..', '.hhhhhh.', '.hhhhhh.', '..hhhh..'],
    side: ['..hhhh..', '.hhhhhh.', '.hhssks.', '...sss..'],
  },
  {
    down: [
      ['.dccccd.', '.sccccs.', '..pppp..', '..p..p..', '..k..k..'],
      ['.dccccd.', '.scccc..', '..pppp..', '..p..p..', '..k.....'],
      ['.dccccd.', '..ccccs.', '..pppp..', '..p..p..', '.....k..'],
    ],
    up: [
      ['.dccccd.', '.sccccs.', '..pppp..', '..p..p..', '..k..k..'],
      ['.dccccd.', '..ccccs.', '..pppp..', '..p..p..', '.....k..'],
      ['.dccccd.', '.scccc..', '..pppp..', '..p..p..', '..k.....'],
    ],
    side: [
      ['..cccc..', '..cscc..', '..pppp..', '...pp...', '...kk...'],
      ['..cccc..', '..ccsc..', '..pppp..', '..p..p..', '.k....k.'],
      ['..cccc..', '..sccc..', '..pppp..', '...pp...', '...kk...'],
    ],
  },
);

// Dogs: f fur, d darker fur (ears, paws, tail), k nose/eyes, c collar. 10×8, side view faces right.
const DOG_FRAMES: Frames = {
  down: [
    ['..........', '..d....d..', '..dffffd..', '..fkffkf..', '...fkkf...', '...cccc...', '..ffffff..', '..d.dd.d..'],
    ['..........', '..d....d..', '..dffffd..', '..fkffkf..', '...fkkf...', '...cccc...', '..ffffff..', '..d....d..'],
    ['..........', '..d....d..', '..dffffd..', '..fkffkf..', '...fkkf...', '...cccc...', '..ffffff..', '....dd....'],
  ],
  up: [
    ['....d.....', '..d.d..d..', '..dffffd..', '..ffffff..', '...ffff...', '...cccc...', '..ffffff..', '..d.dd.d..'],
    ['.....d....', '..d..d.d..', '..dffffd..', '..ffffff..', '...ffff...', '...cccc...', '..ffffff..', '..d....d..'],
    ['...d......', '..dd...d..', '..dffffd..', '..ffffff..', '...ffff...', '...cccc...', '..ffffff..', '....dd....'],
  ],
  side: [
    ['..........', '.......dd.', '......fffk', 'd.....fkf.', '.dffffcf..', '.ffffff...', '.ff..ff...', '.dd..dd...'],
    ['..........', '.......dd.', 'd.....fffk', '.d....fkf.', '.dffffcf..', '.ffffff...', 'f.f..f.f..', 'd.d..d.d..'],
    ['..........', '.......dd.', '......fffk', 'd.....fkf.', '.dffffcf..', '.ffffff...', '.ff..ff...', '.dd..dd...'],
  ],
};

const HAIR = [P.ink, P.trunk, P.gold, P.stone, P.brick, P.woodDark];
const SKIN = [P.skinLight, P.skinMid, P.skinDark];
const SHIRTS = [P.awningRed, P.awningBlue, P.awningGreen, P.gold, P.copper, P.busBody, P.stained, P.uiText, P.carBody];
const TROUSERS = [P.signBlue, P.shadow, P.wood, P.ink, P.stoneDark];
const KID_SHIRTS = [P.gold, P.awningRed, P.copperLight, P.stained, P.busBody, P.awningBlue, P.carBody, P.awningGreen];
const KID_TROUSERS = [P.signBlue, P.awningBlue, P.shadow, P.wood];
/** [fur, darker fur]: golden, black, white with brown, grey. */
const DOG_COATS: [number, number][] = [
  [P.gold, P.tramYellowDark],
  [P.shadow, P.ink],
  [P.uiText, P.trunk],
  [P.stone, P.stoneDark],
];

/** Adults: neighbouring variants differ in everything. */
export function drawPeople(): Img {
  return sheet(ADULTS, ADULT_FRAMES, (v) => {
    const shirt = SHIRTS[(v * 4) % SHIRTS.length];
    return { h: HAIR[(v * 5 + 1) % HAIR.length], s: SKIN[v % SKIN.length], k: P.ink, c: shirt, d: darken(shirt), p: TROUSERS[(v * 3 + 2) % TROUSERS.length] };
  });
}

export function drawKids(): Img {
  return sheet(KIDS, KID_FRAMES, (v) => {
    const shirt = KID_SHIRTS[v % KID_SHIRTS.length];
    return { h: HAIR[(v * 5 + 2) % HAIR.length], s: SKIN[(v + 1) % SKIN.length], k: P.ink, c: shirt, d: darken(shirt), p: KID_TROUSERS[(v * 3) % KID_TROUSERS.length] };
  });
}

export function drawDogs(): Img {
  return sheet(DOGS, DOG_FRAMES, (v) => {
    const [f, d] = DOG_COATS[v % DOG_COATS.length];
    return { f, d, k: P.ink, c: v % 2 ? P.awningBlue : P.awningRed };
  });
}
