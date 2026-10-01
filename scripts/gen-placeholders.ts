// Generates placeholder PNGs (tileset, vehicle sprites, pixel font) into public/assets.
// Existing files are left alone so hand-made art isn't clobbered; pass --force to overwrite.
//
//   npm run gen-placeholders [-- --force]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Img } from './lib/png';
import { PALETTE as P } from '../src/game/palette';
import {
  BUILDING_STYLES,
  DIAG_INDEX,
  DIAG_MASKS,
  E,
  FACADES,
  N,
  S,
  T,
  TILE_SIZE,
  TILESET_COLUMNS,
  TILESET_ROWS,
  W,
  lowerWallId,
  roofId,
  upperWallId,
  type BuildingStyle,
  type Facade,
} from '../src/game/tiles';
import { FONT, GLYPHS } from '../src/game/font';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const S16 = TILE_SIZE;

/** Cheap deterministic per-pixel hash so textures look "random" but are stable. */
const hash = (x: number, y: number, seed: number) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

/** Drawing context for one tile: coordinates are tile-local and clipped to the tile. */
class TileCtx {
  constructor(
    private img: Img,
    readonly ox: number,
    readonly oy: number,
  ) {}
  px(x: number, y: number, c: number) {
    if (x >= 0 && y >= 0 && x < S16 && y < S16) this.img.set(this.ox + x, this.oy + y, c);
  }
  rect(x: number, y: number, w: number, h: number, c: number) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.px(xx, yy, c);
  }
  pattern(x: number, y: number, rows: string[], colors: Record<string, number>) {
    rows.forEach((row, yy) => [...row].forEach((ch, xx) => colors[ch] !== undefined && this.px(x + xx, y + yy, colors[ch])));
  }
  /** Run `draw`, then restore every pixel where `keep(x, y)` is false (cheap masking). */
  masked(keep: (x: number, y: number) => boolean, draw: () => void) {
    const idx = (x: number, y: number) => ((this.oy + y) * this.img.width + this.ox + x) * 4;
    const saved = new Map<number, Uint8Array>();
    for (let y = 0; y < S16; y++) for (let x = 0; x < S16; x++) if (!keep(x, y)) saved.set(idx(x, y), this.img.data.slice(idx(x, y), idx(x, y) + 4));
    draw();
    for (const [i, rgba] of saved) this.img.data.set(rgba, i);
  }
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

function grass(t: TileCtx, seed: number) {
  t.rect(0, 0, S16, S16, P.grass);
  for (let y = 0; y < S16; y++)
    for (let x = 0; x < S16; x++) {
      const r = hash(x, y, seed);
      if (r < 0.06) t.px(x, y, P.grassDark);
      else if (r < 0.1) t.px(x, y, P.grassLight);
    }
  t.pattern(3, 4, ['#.#', '.#.'], { '#': P.grassDark });
  t.pattern(10, 11, ['#.#', '.#.'], { '#': P.grassDark });
}

function paving(t: TileCtx) {
  t.rect(0, 0, S16, S16, P.paving);
  for (let i = 0; i < S16; i++) {
    t.px(i, 7, P.pavingDark);
    t.px(i, 15, P.pavingDark);
    t.px(7, i % 8, P.pavingDark);
    t.px(15, 8 + (i % 8), P.pavingDark);
  }
}

function water(t: TileCtx) {
  t.rect(0, 0, S16, S16, P.water);
  t.pattern(2, 4, ['.##.', '#..#'], { '#': P.waterLight });
  t.pattern(9, 11, ['.##.', '#..#'], { '#': P.waterLight });
}

function roadBase(t: TileCtx, cobble: boolean, seed: number) {
  if (cobble) {
    t.rect(0, 0, S16, S16, P.cobble);
    for (let y = 0; y < S16; y += 4)
      for (let x = (y / 4) % 2 ? 2 : 0; x <= S16; x += 4) {
        if (x > 0) t.rect(x - 1, y, 1, 4, P.cobbleDark);
        t.px(x, y + 1, P.cobbleLight);
      }
    for (let y = 3; y < S16; y += 4) t.rect(0, y, S16, 1, P.cobbleDark);
  } else {
    t.rect(0, 0, S16, S16, P.asphalt);
    for (let y = 0; y < S16; y++) for (let x = 0; x < S16; x++) if (hash(x, y, seed) < 0.07) t.px(x, y, P.asphaltDark);
  }
}

function road(t: TileCtx, mask: number, cobble: boolean) {
  roadBase(t, cobble, 7 + mask);
  // Curbs on every side without a road neighbour: 2px curb + 1px gutter shadow.
  for (const side of [N, E, S, W]) {
    if (mask & side) continue;
    for (let i = 0; i < S16; i++) {
      const pts: Array<[number, number, number]> =
        side === N ? [[i, 0, P.curb], [i, 1, P.curb], [i, 2, P.shadow]]
        : side === S ? [[i, 15, P.curb], [i, 14, P.curb], [i, 13, P.asphaltDark]]
        : side === W ? [[0, i, P.curb], [1, i, P.curb], [2, i, P.asphaltDark]]
        : [[15, i, P.curb], [14, i, P.curb], [13, i, P.asphaltDark]];
      for (const [x, y, c] of pts) t.px(x, y, c);
    }
  }
  for (const [sx, sy, a, b] of [[0, 0, N, W], [14, 0, N, E], [0, 14, S, W], [14, 14, S, E]] as const)
    if (!(mask & a) && !(mask & b)) t.rect(sx, sy, 2, 2, P.curb);
}

/**
 * Outer corner cut along the diagonal: road in the triangle towards the two road
 * neighbours, sidewalk in the other. Chained, these give smooth 45° road edges.
 */
function roadDiag(t: TileCtx, mask: number, cobble: boolean) {
  // Distance from the diagonal in px, > 0 on the road side.
  const side = (x: number, y: number) => {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const d =
      mask === (N | E) ? cx - cy // road in the top-right
      : mask === (S | W) ? cy - cx // bottom-left
      : mask === (E | S) ? cx + cy - S16 // bottom-right
      : S16 - cx - cy; // W|N: top-left
    return d / Math.SQRT2;
  };
  paving(t);
  t.masked((x, y) => side(x, y) > 0, () => roadBase(t, cobble, 40 + mask));
  for (let y = 0; y < S16; y++)
    for (let x = 0; x < S16; x++) {
      const d = side(x, y);
      if (d > -0.4 && d <= 1.6) t.px(x, y, P.curb);
      else if (d > 1.6 && d <= 2.4) t.px(x, y, P.asphaltDark);
    }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

function roof(t: TileCtx, style: BuildingStyle) {
  switch (style) {
    case 'residential':
      t.rect(0, 0, S16, S16, P.roof);
      for (let y = 3; y < S16; y += 4) t.rect(0, y, S16, 1, P.roofDark);
      for (let y = 0; y < S16; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < S16; x += 4) t.px(x, y, P.roofLight);
      break;
    case 'church': // standing-seam copper
      t.rect(0, 0, S16, S16, P.copper);
      for (let x = 1; x < S16; x += 4) t.rect(x, 0, 1, S16, P.copperLight);
      for (let x = 3; x < S16; x += 4) t.rect(x, 0, 1, S16, P.copperDark);
      break;
    case 'civic': // slate shingles
      t.rect(0, 0, S16, S16, P.slate);
      for (let y = 0; y < S16; y += 4) {
        t.rect(0, y + 3, S16, 1, P.slateDark);
        for (let x = (y / 4) % 2 ? 0 : 4; x < S16; x += 8) t.rect(x, y, 1, 3, P.slateDark);
        for (let x = (y / 4) % 2 ? 1 : 5; x < S16; x += 8) t.px(x, y, P.slateLight);
      }
      break;
    case 'industrial': // sawtooth roof
      for (let y = 0; y < S16; y++) t.rect(0, y, S16, 1, [P.tinLight, P.tin, P.tin, P.tin, P.tin, P.tinDark, P.tinDark, P.ink][y % 8]);
      break;
    case 'commercial': // flat gravel roof
      t.rect(0, 0, S16, S16, P.flat);
      for (let y = 0; y < S16; y++) for (let x = 0; x < S16; x++) if (hash(x, y, 91) < 0.12) t.px(x, y, P.flatDark);
      break;
  }
}

/** Upper facade: eave at the top, windows below. */
function wallUpper(t: TileCtx, style: BuildingStyle) {
  const eave = { residential: P.roofDark, church: P.copperDark, civic: P.slateDark, industrial: P.tinDark, commercial: P.flatDark }[style];
  const body = { residential: P.wall, church: P.stone, civic: P.stone, industrial: P.brick, commercial: P.window }[style];
  t.rect(0, 0, S16, S16, body);
  if (style === 'industrial') {
    for (let y = 4; y < S16; y += 3) t.rect(0, y, S16, 1, P.brickDark);
    for (let y = 4; y < S16; y += 3) for (let x = (y % 2) * 2; x < S16; x += 4) t.px(x, y + 1, P.brickDark);
    t.rect(3, 7, 3, 5, P.window);
    t.rect(10, 7, 3, 5, P.window);
  } else if (style === 'commercial') {
    for (let x = 0; x < S16; x += 4) t.rect(x, 3, 1, S16 - 3, P.flatDark);
    t.rect(0, 9, S16, 1, P.flatDark);
    t.px(2, 5, P.carGlass);
    t.px(6, 5, P.carGlass);
    t.px(10, 11, P.carGlass);
  } else if (style === 'church') {
    // tall arched stained-glass window
    t.pattern(5, 5, ['.##.', '#ss#', '#ss#', '#ss#', '#ss#', '#ss#', '#ss#', '####'], { '#': P.stoneDark, s: P.stained });
    t.px(6, 7, P.gold);
    t.rect(0, 15, S16, 1, P.stoneDark);
  } else if (style === 'civic') {
    for (const x of [1, 6, 11]) t.rect(x, 4, 2, 12, P.paving); // pilasters
    for (const x of [1, 6, 11]) t.rect(x + 1, 4, 1, 12, P.stoneDark);
    for (const x of [3, 8, 13]) t.rect(x, 7, 2, 5, P.window);
  } else {
    for (const wx of [2, 9]) {
      t.rect(wx, 6, 5, 6, P.wallDark);
      t.rect(wx + 1, 7, 3, 4, P.window);
      t.px(wx + 1, 7, P.carGlass);
    }
  }
  t.rect(0, 0, S16, 3, eave);
  t.rect(0, 3, S16, 1, P.shadow);
}

function awning(t: TileCtx, a: number, b: number) {
  for (let x = 0; x < S16; x++) t.rect(x, 0, 1, 5, Math.floor(x / 2) % 2 ? b : a);
  for (let x = 0; x < S16; x += 2) t.px(x, 5, Math.floor(x / 2) % 2 ? b : a); // scalloped edge
  t.rect(0, 6, S16, 1, P.shadow);
}

/** Lower facade: street level, where doors and storefronts go. */
function wallLower(t: TileCtx, facade: Facade) {
  switch (facade) {
    case 'residential':
      t.rect(0, 0, S16, S16, P.wall);
      t.rect(2, 3, 5, 6, P.wallDark);
      t.rect(3, 4, 3, 4, P.window);
      t.rect(10, 6, 4, 10, P.woodDark);
      t.rect(11, 7, 2, 9, P.wood);
      t.px(12, 11, P.gold);
      break;
    case 'church':
      t.rect(0, 0, S16, S16, P.stone);
      t.pattern(4, 3, ['..####..', '.#wwww#.', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '#wwwwww#', '########'], { '#': P.stoneDark, w: P.wood });
      t.rect(7, 5, 1, 10, P.woodDark);
      t.px(6, 10, P.gold);
      t.px(9, 10, P.gold);
      break;
    case 'civic':
      t.rect(0, 0, S16, S16, P.stone);
      for (const x of [1, 6, 11]) t.rect(x, 0, 2, 12, P.paving);
      for (const x of [1, 6, 11]) t.rect(x + 1, 0, 1, 12, P.stoneDark);
      t.rect(3, 4, 3, 8, P.woodDark);
      t.rect(8, 4, 3, 8, P.woodDark);
      t.rect(0, 12, S16, 2, P.pavingDark); // steps
      t.rect(0, 14, S16, 2, P.paving);
      break;
    case 'industrial':
      t.rect(0, 0, S16, S16, P.brick);
      for (let y = 1; y < S16; y += 3) t.rect(0, y, S16, 1, P.brickDark);
      t.rect(3, 4, 10, 12, P.tinDark); // loading gate
      for (let y = 5; y < S16; y += 2) t.rect(3, y, 10, 1, P.tin);
      break;
    case 'commercial':
      t.rect(0, 0, S16, S16, P.flatDark);
      t.rect(1, 2, 14, 13, P.window);
      for (const x of [5, 10]) t.rect(x, 2, 1, 13, P.flatDark);
      for (const x of [2, 7, 12]) t.px(x, 3, P.carGlass);
      break;
    case 'restaurant':
      t.rect(0, 0, S16, S16, P.wall);
      t.rect(1, 8, 9, 7, P.window);
      t.px(3, 11, P.lamp);
      t.px(7, 12, P.lamp);
      t.rect(11, 8, 4, 8, P.wood);
      awning(t, P.awningRed, P.uiText);
      break;
    case 'cafe':
      t.rect(0, 0, S16, S16, P.wall);
      t.rect(1, 8, 14, 6, P.window);
      t.pattern(4, 10, ['w.w', 'c.c'], { w: P.uiText, c: P.wood }); // cups in the window
      t.pattern(10, 10, ['w', 'c'], { w: P.uiText, c: P.wood });
      awning(t, P.awningGreen, P.paving);
      break;
    case 'bar':
      t.rect(0, 0, S16, S16, P.woodDark);
      for (let y = 1; y < S16; y += 3) t.rect(0, y, S16, 1, P.wood);
      t.rect(2, 5, 6, 6, P.ink);
      t.rect(3, 6, 4, 4, P.lamp);
      t.rect(10, 4, 4, 12, P.ink);
      t.rect(11, 1, 2, 2, P.lamp); // lantern
      break;
    case 'shop':
      t.rect(0, 0, S16, S16, P.wall);
      t.rect(1, 8, 14, 7, P.window);
      t.pattern(2, 11, ['r.g.y.b', 'r.g.y.b'], { r: P.awningRed, g: P.grassLight, y: P.gold, b: P.carGlass });
      awning(t, P.awningBlue, P.uiText);
      break;
  }
}

// ---------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------

function smallTree(t: TileCtx) {
  for (let y = 0; y < S16; y++)
    for (let x = 0; x < S16; x++) {
      const dx = x - 7.5;
      const dy = y - 7;
      const d = Math.hypot(dx, dy);
      if (d < 6.5) t.px(x, y, d > 5.6 ? P.treeDark : dx + dy > 3 ? P.treeDark : dx + dy < -5 ? P.treeLight : P.tree);
    }
  t.rect(7, 13, 2, 2, P.trunk);
}

/** A 32×32 canopy split over four tiles; `qx`, `qy` pick the quarter. */
function bigTree(t: TileCtx, qx: number, qy: number) {
  for (let y = 0; y < S16; y++)
    for (let x = 0; x < S16; x++) {
      const gx = qx * S16 + x - 15.5;
      const gy = qy * S16 + y - 14.5;
      const d = Math.hypot(gx, gy);
      const r = 13 + Math.sin(Math.atan2(gy, gx) * 5) * 1.2; // lumpy outline
      if (d >= r) continue;
      const shade = gx + gy > 8 ? P.treeDark : gx + gy < -10 ? P.treeLight : P.tree;
      t.px(x, y, d > r - 1.2 ? P.treeDark : hash(qx * 16 + x, qy * 16 + y, 5) < 0.08 ? P.treeLight : shade);
    }
}

function cafeTables(t: TileCtx) {
  for (const [cx, cy] of [[4, 4], [11, 10]] as const) {
    for (let y = -3; y <= 3; y++)
      for (let x = -3; x <= 3; x++) {
        if (Math.hypot(x, y) >= 3.6) continue;
        const segment = Math.floor(((Math.atan2(y, x) + Math.PI) / (Math.PI * 2)) * 6);
        t.px(cx + x, cy + y, segment % 2 ? P.awningRed : P.uiText); // striped parasol
      }
    t.px(cx, cy, P.ink);
    t.px(cx + 4, cy + 2, P.wood); // chairs
    t.px(cx - 4, cy - 2, P.wood);
  }
}

function steeple(t: TileCtx) {
  // Four-sided spire seen from above, with a gold cross on top.
  for (let y = 0; y < S16; y++)
    for (let x = 0; x < S16; x++) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      if (Math.abs(dx) + Math.abs(dy) > 8) continue;
      t.px(x, y, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? P.copperDark : P.copperLight) : dy > 0 ? P.copperDark : P.copper);
    }
  t.pattern(6, 5, ['.#.', '###', '.#.', '.#.'], { '#': P.gold });
}

/** Raised platform: concrete slabs with a yellow tactile strip along open edges. */
function platform(t: TileCtx, mask: number) {
  t.rect(0, 0, S16, S16, P.concrete);
  for (let i = 0; i < S16; i += 8) {
    t.rect(i, 0, 1, S16, P.concreteDark);
    t.rect(0, i, S16, 1, P.concreteDark);
  }
  const edge = (side: number, x: number, y: number, w: number, h: number) => {
    if (mask & side) return;
    t.rect(x, y, w, h, P.gold);
    for (let i = 0; i < S16; i += 2) t.px(w === S16 ? i : x + (side === W ? 0 : 1), h === S16 ? i : y + (side === N ? 0 : 1), P.lane);
  };
  edge(N, 0, 1, S16, 2);
  edge(S, 0, 13, S16, 2);
  edge(W, 1, 0, 2, S16);
  edge(E, 13, 0, 2, S16);
  // curb drop shadow on the south side so platforms read as raised
  if (!(mask & S)) t.rect(0, 15, S16, 1, P.shadow);
}

function stopSign(t: TileCtx) {
  // Pole with a round yellow sign and a green tram glyph; small shadow at the foot.
  t.rect(7, 6, 2, 9, P.railDark);
  t.rect(6, 15, 4, 1, P.shadow);
  t.pattern(4, 0, ['.####.', '######', '##gg##', '#gggg#', '##gg##', '.####.', '..##..'], { '#': P.gold, g: P.awningGreen });
}

// ---------------------------------------------------------------------------

function drawTileset(): Img {
  const img = new Img(TILESET_COLUMNS * S16, TILESET_ROWS * S16);
  const at = (id: number) => new TileCtx(img, (id % TILESET_COLUMNS) * S16, Math.floor(id / TILESET_COLUMNS) * S16);

  grass(at(T.GRASS), 1);
  const flowers = at(T.GRASS_FLOWERS);
  grass(flowers, 2);
  flowers.pattern(4, 9, ['.w.', 'wyw', '.w.'], { w: P.uiText, y: P.lane });
  flowers.pattern(10, 3, ['.w.', 'wyw', '.w.'], { w: P.roofLight, y: P.lane });
  paving(at(T.PAVING));
  water(at(T.WATER));
  const shore = at(T.WATER_SHORE);
  water(shore);
  shore.rect(0, 0, S16, 2, P.pavingDark); // stone quay edge
  shore.rect(0, 2, S16, 2, P.waterDark);
  smallTree(at(T.TREE_SMALL));
  cafeTables(at(T.CAFE_TABLES));
  steeple(at(T.STEEPLE));
  bigTree(at(T.TREE_TL), 0, 0);
  bigTree(at(T.TREE_TR), 1, 0);
  bigTree(at(T.TREE_BL), 0, 1);
  bigTree(at(T.TREE_BR), 1, 1);
  stopSign(at(T.STOP_SIGN));
  for (let mask = 0; mask < 16; mask++) platform(at(T.PLATFORM + mask), mask);

  for (let mask = 0; mask < 16; mask++) {
    road(at(T.ROAD_ASPHALT + mask), mask, false);
    road(at(T.ROAD_COBBLE + mask), mask, true);
  }
  for (const mask of DIAG_MASKS) {
    roadDiag(at(T.ROAD_ASPHALT_DIAG + DIAG_INDEX[mask]!), mask, false);
    roadDiag(at(T.ROAD_COBBLE_DIAG + DIAG_INDEX[mask]!), mask, true);
  }
  for (const s of BUILDING_STYLES) {
    roof(at(roofId(s)), s);
    wallUpper(at(upperWallId(s)), s);
  }
  for (const f of FACADES) wallLower(at(lowerWallId(f)), f);
  return img;
}

function drawCar(): Img {
  return car({ b: P.carBody, d: P.carDark, y: P.lane }, 'gbbbbgg');
}

/** Copper-green with a long panoramic glass roof and cool white headlights. */
function drawEv(): Img {
  return car({ b: P.copper, d: P.copperDark, y: P.uiText }, 'ggggggg');
}

/** Rider seen from above, facing east: helmet, shoulders, arms to the handlebar, wheels fore and aft. */
function drawBike(): Img {
  const img = new Img(16, 16);
  img.pattern(0, 0, [
    '................',
    '................',
    '................',
    '................',
    '................',
    '....kkkk........',
    '...kbbbbkssk....',
    '.tttkbbhhkfftttt',
    '.tttkbbhhkfftttt',
    '...kbbbbkssk....',
    '....kkkk........',
    '................',
    '................',
    '................',
    '................',
    '................',
  ], { k: P.ink, b: P.awningBlue, h: P.gold, s: P.lamp, f: P.carBody, t: P.tyre });
  return img;
}

/** Facing east (rotation 0 in Phaser). 16x16 with transparent margin. `roof` is columns 5-11 of the cabin rows. */
function car(colors: { b: number; d: number; y: number }, roof: string): Img {
  const img = new Img(16, 16);
  const cabin = `..kbd${roof}bk.`;
  img.pattern(0, 0, [
    '................',
    '................',
    '................',
    '...tt.....tt....',
    '..kkkkkkkkkkkk..',
    '..kbbbbbbbbbbyk.',
    cabin,
    cabin,
    cabin,
    cabin,
    '..kbbbbbbbbbbyk.',
    '..kkkkkkkkkkkk..',
    '...tt.....tt....',
    '................',
    '................',
    '................',
  ], { k: P.ink, g: P.carGlass, t: P.tyre, ...colors });
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
  ['public/assets/sprites/bike.png', drawBike],
  ['public/assets/sprites/ev.png', drawEv],
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
