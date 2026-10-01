// Tile index contract shared by the map generator (scripts/) and the game (src/).
// Indices are 0-based tileset ids; Tiled GIDs are id + 1 (firstgid = 1).
//
// Tileset layout (16 columns, 16x16 px tiles):
//   row 0 : ground + decor (see T below; big trees are 2×2: TL TR / BL BR)
//   row 1 : asphalt road autotiles, id = ROAD_ASPHALT + mask
//   row 2 : cobblestone road autotiles, id = ROAD_COBBLE + mask
//   row 3 : diagonal road edges, id = ROAD_*_DIAG + DIAG_INDEX[mask] (asphalt 48–51, cobble 52–55)
//   row 4 : roofs (64 + style) and upper facades (72 + style)
//   row 5 : lower facades / storefronts (80 + facade)
//   row 6 : tram/bus platforms, id = PLATFORM + mask (yellow tactile edge where the mask bit is unset)
// Road mask is a 4-bit neighbour mask: N=1, E=2, S=4, W=8 (bit set = road continues that way).

export const TILE_SIZE = 16;
export const TILESET_COLUMNS = 16;
export const TILESET_ROWS = 7;

export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

export const T = {
  GRASS: 0,
  GRASS_FLOWERS: 1,
  PAVING: 2,
  WATER: 3,
  WATER_SHORE: 4, // water with land to the north
  TREE_SMALL: 5, // decor
  CAFE_TABLES: 6, // decor, not solid
  STEEPLE: 7, // decor on church roofs
  TREE_TL: 8, // decor, 2×2 tree
  TREE_TR: 9,
  TREE_BL: 10,
  TREE_BR: 11,
  STOP_SIGN: 12, // decor, tram stop sign; not solid
  ROAD_ASPHALT: 16,
  ROAD_COBBLE: 32,
  ROAD_ASPHALT_DIAG: 48,
  ROAD_COBBLE_DIAG: 52,
  ROOF: 64,
  WALL_UPPER: 72,
  WALL_LOWER: 80,
  PLATFORM: 96,
} as const;

/** Outer-corner road masks get a diagonal curb instead of a square corner. */
export const DIAG_INDEX: Partial<Record<number, number>> = { [N | E]: 0, [E | S]: 1, [S | W]: 2, [W | N]: 3 };
export const DIAG_MASKS = [N | E, E | S, S | W, W | N] as const;

/** Whole-building styles: pick the roof and upper facade. */
export const BUILDING_STYLES = ['residential', 'church', 'civic', 'industrial', 'commercial'] as const;
export type BuildingStyle = (typeof BUILDING_STYLES)[number];

/** Ground-floor facades: one per building style plus storefronts placed from POIs. */
export const FACADES = [...BUILDING_STYLES, 'restaurant', 'cafe', 'bar', 'shop'] as const;
export type Facade = (typeof FACADES)[number];

export const roofId = (s: BuildingStyle) => T.ROOF + BUILDING_STYLES.indexOf(s);
export const upperWallId = (s: BuildingStyle) => T.WALL_UPPER + BUILDING_STYLES.indexOf(s);
export const lowerWallId = (f: Facade) => T.WALL_LOWER + FACADES.indexOf(f);

export type Surface = 'grass' | 'paving' | 'asphalt' | 'cobble' | 'water' | 'building' | 'tree';

const inRange = (id: number, start: number, count: number) => id >= start && id < start + count;

export function surfaceOfTileId(id: number): Surface | undefined {
  if (inRange(id, T.ROAD_ASPHALT, 16) || inRange(id, T.ROAD_ASPHALT_DIAG, 4)) return 'asphalt';
  if (inRange(id, T.ROAD_COBBLE, 16) || inRange(id, T.ROAD_COBBLE_DIAG, 4)) return 'cobble';
  if (inRange(id, T.ROOF, BUILDING_STYLES.length) || inRange(id, T.WALL_UPPER, BUILDING_STYLES.length)) return 'building';
  if (inRange(id, T.WALL_LOWER, FACADES.length)) return 'building';
  if (inRange(id, T.PLATFORM, 16)) return 'paving';
  switch (id) {
    case T.GRASS:
    case T.GRASS_FLOWERS:
      return 'grass';
    case T.PAVING:
      return 'paving';
    case T.WATER:
    case T.WATER_SHORE:
      return 'water';
    case T.STEEPLE:
      return 'building';
    case T.TREE_SMALL:
    case T.TREE_TL:
    case T.TREE_TR:
    case T.TREE_BL:
    case T.TREE_BR:
      return 'tree';
  }
  return undefined; // e.g. CAFE_TABLES: decor that doesn't change the ground
}

/** Human-readable tile name, written into the Tiled tileset to make hand-editing easier. */
export function tileName(id: number): string | undefined {
  const named = Object.entries(T).find(([, v]) => v === id)?.[0];
  if (inRange(id, T.ROAD_ASPHALT, 16)) return `road-asphalt-${id - T.ROAD_ASPHALT}`;
  if (inRange(id, T.ROAD_COBBLE, 16)) return `road-cobble-${id - T.ROAD_COBBLE}`;
  if (inRange(id, T.ROAD_ASPHALT_DIAG, 4)) return `road-asphalt-diag-${DIAG_MASKS[id - T.ROAD_ASPHALT_DIAG]}`;
  if (inRange(id, T.ROAD_COBBLE_DIAG, 4)) return `road-cobble-diag-${DIAG_MASKS[id - T.ROAD_COBBLE_DIAG]}`;
  if (inRange(id, T.ROOF, BUILDING_STYLES.length)) return `roof-${BUILDING_STYLES[id - T.ROOF]}`;
  if (inRange(id, T.WALL_UPPER, BUILDING_STYLES.length)) return `wall-upper-${BUILDING_STYLES[id - T.WALL_UPPER]}`;
  if (inRange(id, T.WALL_LOWER, FACADES.length)) return `wall-lower-${FACADES[id - T.WALL_LOWER]}`;
  if (inRange(id, T.PLATFORM, 16)) return `platform-${id - T.PLATFORM}`;
  return named?.toLowerCase().replace(/_/g, '-');
}

export const TILE_COUNT = TILESET_COLUMNS * TILESET_ROWS;
