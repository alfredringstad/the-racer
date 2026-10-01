// Generates placeholder PNGs (tileset, car sprite, pixel font) into public/assets.
// Existing files are left alone so hand-made art isn't clobbered; pass --force to overwrite.
//
//   npm run gen-placeholders [-- --force]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Img } from './lib/png';
import { PALETTE as P } from '../src/game/palette';
import { E, N, S, T, TILE_SIZE, TILESET_COLUMNS, TILESET_ROWS, W } from '../src/game/tiles';
import { FONT, GLYPHS } from '../src/game/font';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

/** Cheap deterministic per-pixel hash so textures look "random" but are stable. */
const hash = (x: number, y: number, seed: number) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

function drawTileset(): Img {
  const S16 = TILE_SIZE;
  const img = new Img(TILESET_COLUMNS * S16, TILESET_ROWS * S16);
  const at = (id: number) => ({ x: (id % TILESET_COLUMNS) * S16, y: Math.floor(id / TILESET_COLUMNS) * S16 });

  const grass = (ox: number, oy: number, seed: number) => {
    img.rect(ox, oy, S16, S16, P.grass);
    for (let y = 0; y < S16; y++)
      for (let x = 0; x < S16; x++) {
        const r = hash(x, y, seed);
        if (r < 0.06) img.set(ox + x, oy + y, P.grassDark);
        else if (r < 0.1) img.set(ox + x, oy + y, P.grassLight);
      }
    // two little tufts
    img.pattern(ox + 3, oy + 4, ['#.#', '.#.'], { '#': P.grassDark });
    img.pattern(ox + 10, oy + 11, ['#.#', '.#.'], { '#': P.grassDark });
  };

  // --- row 0 ---
  let o = at(T.GRASS);
  grass(o.x, o.y, 1);

  o = at(T.GRASS_FLOWERS);
  grass(o.x, o.y, 2);
  img.pattern(o.x + 4, o.y + 9, ['.w.', 'wyw', '.w.'], { w: P.uiText, y: P.lane });
  img.pattern(o.x + 10, o.y + 3, ['.w.', 'wyw', '.w.'], { w: P.roofLight, y: P.lane });

  o = at(T.PAVING);
  img.rect(o.x, o.y, S16, S16, P.paving);
  for (let i = 0; i < S16; i++) {
    img.set(o.x + i, o.y + 7, P.pavingDark);
    img.set(o.x + i, o.y + 15, P.pavingDark);
    img.set(o.x + 7, o.y + (i % 8), P.pavingDark); // staggered slabs
    img.set(o.x + 15, o.y + 8 + (i % 8), P.pavingDark);
  }

  const water = (ox: number, oy: number) => {
    img.rect(ox, oy, S16, S16, P.water);
    img.pattern(ox + 2, oy + 4, ['.##.', '#..#'], { '#': P.waterLight });
    img.pattern(ox + 9, oy + 11, ['.##.', '#..#'], { '#': P.waterLight });
  };
  o = at(T.WATER);
  water(o.x, o.y);

  o = at(T.WATER_SHORE);
  water(o.x, o.y);
  img.rect(o.x, o.y, S16, 2, P.pavingDark); // stone quay edge
  img.rect(o.x, o.y + 2, S16, 2, P.waterDark); // its shadow on the water

  o = at(T.ROOF);
  img.rect(o.x, o.y, S16, S16, P.roof);
  for (let y = 3; y < S16; y += 4) img.rect(o.x, o.y + y, S16, 1, P.roofDark);
  for (let y = 0; y < S16; y += 4)
    for (let x = (y / 4) % 2 ? 2 : 0; x < S16; x += 4) img.set(o.x + x, o.y + y, P.roofLight);

  o = at(T.WALL);
  img.rect(o.x, o.y, S16, S16, P.wall);
  img.rect(o.x, o.y, S16, 3, P.roofDark); // eave
  img.rect(o.x, o.y + 3, S16, 1, P.shadow);
  for (const wx of [2, 9]) {
    img.rect(o.x + wx, o.y + 6, 5, 6, P.wallDark);
    img.rect(o.x + wx + 1, o.y + 7, 3, 4, P.window);
    img.set(o.x + wx + 1, o.y + 7, P.carGlass);
  }
  img.rect(o.x, o.y + 15, S16, 1, P.wallDark);

  o = at(T.TREE);
  for (let y = 0; y < S16; y++)
    for (let x = 0; x < S16; x++) {
      const dx = x - 7.5,
        dy = y - 7;
      const d = Math.hypot(dx, dy);
      if (d < 6.5) {
        const shade = dx + dy > 3 ? P.treeDark : dx + dy < -5 ? P.treeLight : P.tree;
        img.set(o.x + x, o.y + y, d > 5.6 ? P.treeDark : shade);
      }
    }
  img.rect(o.x + 7, o.y + 13, 2, 2, P.trunk);

  // --- road rows ---
  const road = (base: number, cobble: boolean) => {
    for (let mask = 0; mask < 16; mask++) {
      const { x: ox, y: oy } = at(base + mask);
      if (cobble) {
        img.rect(ox, oy, S16, S16, P.cobble);
        for (let y = 0; y < S16; y += 4)
          for (let x = (y / 4) % 2 ? 2 : 0; x <= S16; x += 4) {
            if (x > 0) img.rect(ox + x - 1, oy + y, 1, 4, P.cobbleDark);
            if (x >= S16) continue;
            img.set(ox + x, oy + y + 1, P.cobbleLight);
          }
        for (let y = 3; y < S16; y += 4) img.rect(ox, oy + y, S16, 1, P.cobbleDark);
      } else {
        img.rect(ox, oy, S16, S16, P.asphalt);
        for (let y = 0; y < S16; y++)
          for (let x = 0; x < S16; x++) if (hash(x, y, 7 + mask) < 0.07) img.set(ox + x, oy + y, P.asphaltDark);
      }
      // Curbs on every side that has no road neighbour: 2px curb + 1px gutter shadow.
      const curb = (side: number) => {
        for (let i = 0; i < S16; i++) {
          const pts: Array<[number, number, number]> =
            side === N ? [[i, 0, P.curb], [i, 1, P.curb], [i, 2, P.shadow]]
            : side === S ? [[i, 15, P.curb], [i, 14, P.curb], [i, 13, P.asphaltDark]]
            : side === W ? [[0, i, P.curb], [1, i, P.curb], [2, i, P.asphaltDark]]
            : [[15, i, P.curb], [14, i, P.curb], [13, i, P.asphaltDark]];
          for (const [x, y, c] of pts) img.set(ox + x, oy + y, c);
        }
      };
      for (const side of [N, E, S, W]) if (!(mask & side)) curb(side);
      // Re-draw curb corners so overlapping curbs look tidy.
      for (const [sx, sy, a, b] of [
        [0, 0, N, W],
        [14, 0, N, E],
        [0, 14, S, W],
        [14, 14, S, E],
      ] as const)
        if (!(mask & a) && !(mask & b)) img.rect(ox + sx, oy + sy, 2, 2, P.curb);
    }
  };
  road(T.ROAD_ASPHALT, false);
  road(T.ROAD_COBBLE, true);
  return img;
}

function drawCar(): Img {
  // Facing east (rotation 0 in Phaser). 16x16 with transparent margin.
  const img = new Img(16, 16);
  img.pattern(0, 0, [
    '................',
    '................',
    '................',
    '...tt.....tt....',
    '..kkkkkkkkkkkk..',
    '..kbbbbbbbbbbyk.',
    '..kbdgbbbbggbbk.',
    '..kbdgbbbbggbbk.',
    '..kbdgbbbbggbbk.',
    '..kbdgbbbbggbbk.',
    '..kbbbbbbbbbbyk.',
    '..kkkkkkkkkkkk..',
    '...tt.....tt....',
    '................',
    '................',
    '................',
  ], { k: P.ink, b: P.carBody, d: P.carDark, g: P.carGlass, y: P.lane, t: P.tyre });
  return img;
}

function drawFont(): Img {
  const rows = Math.ceil(FONT.chars.length / FONT.charsPerRow);
  const img = new Img(FONT.charsPerRow * FONT.cellWidth, rows * FONT.cellHeight);
  [...FONT.chars].forEach((ch, i) => {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`No glyph for ${ch}`);
    const x = (i % FONT.charsPerRow) * FONT.cellWidth;
    const y = Math.floor(i / FONT.charsPerRow) * FONT.cellHeight + (FONT.cellHeight - g.length);
    img.pattern(x, y, g, { '#': 0xffffff }); // white so it can be tinted in-game
  });
  return img;
}

const outputs: Array<[string, () => Img]> = [
  ['public/assets/tiles/tiles.png', drawTileset],
  ['public/assets/sprites/car.png', drawCar],
  ['public/' + FONT.path, drawFont],
];

for (const [rel, draw] of outputs) {
  const file = resolve(ROOT, rel);
  if (existsSync(file) && !force) {
    console.log(`skip  ${rel} (exists; --force to overwrite)`);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, draw().toPNG());
  console.log(`wrote ${rel}`);
}
