// Cosy GBC/Pokémon-ish palette. Everything placeholder-drawn uses these colours,
// so swapping a value here and re-running `npm run gen-placeholders -- --force`
// recolours the whole game.
export const PALETTE = {
  ink: 0x2b2a3a,
  shadow: 0x4a4658,

  asphalt: 0x6b6d7a,
  asphaltDark: 0x5a5b68,
  curb: 0xd9d2bf,
  lane: 0xf2d16b,

  cobble: 0xa8957d,
  cobbleDark: 0x857360,
  cobbleLight: 0xc2b098,

  paving: 0xe2d8bf,
  pavingDark: 0xcabfa4,

  grass: 0x8cc068,
  grassDark: 0x6fa352,
  grassLight: 0xa9d784,

  tree: 0x3f7d4a,
  treeDark: 0x2d5c3a,
  treeLight: 0x5c9e5a,
  trunk: 0x7a5136,

  water: 0x5aa6c8,
  waterLight: 0x8ccbe0,
  waterDark: 0x3f86a8,

  roof: 0xc8604d,
  roofDark: 0xa54a3c,
  roofLight: 0xe07e66,
  wall: 0xefe3c8,
  wallDark: 0xd2c3a3,
  window: 0x4a6a8a,

  carBody: 0xe04a4a,
  carDark: 0xa8323a,
  carGlass: 0x9fd3e8,
  tyre: 0x2b2a3a,

  uiBg: 0x2b2a3a,
  uiText: 0xf4ecd8,
  uiAccent: 0xf2d16b,

  sky: 0xe0f0d0,
} as const;

export type PaletteKey = keyof typeof PALETTE;

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
