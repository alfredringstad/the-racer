// Tile index contract shared by the map generator (scripts/) and the game (src/).
// Indices are 0-based tileset ids; Tiled GIDs are id + 1 (firstgid = 1).
//
// Tileset layout (16 columns, 16x16 px tiles):
//   row 0  : misc ground + decor (see T below)
//   row 1  : asphalt road autotiles, id = ROAD_ASPHALT + mask
//   row 2  : cobblestone road autotiles, id = ROAD_COBBLE + mask
// Road mask is a 4-bit neighbour mask: N=1, E=2, S=4, W=8 (bit set = road continues that way).

export const TILE_SIZE = 16;
export const TILESET_COLUMNS = 16;
export const TILESET_ROWS = 3;

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
  ROOF: 5,
  WALL: 6, // building facade, drawn where the tile south of a building isn't building
  TREE: 7, // decor layer
  ROAD_ASPHALT: 16,
  ROAD_COBBLE: 32,
} as const;

export type Surface = 'grass' | 'paving' | 'asphalt' | 'cobble' | 'water' | 'building' | 'tree';

export function surfaceOfTileId(id: number): Surface | undefined {
  if (id >= T.ROAD_ASPHALT && id < T.ROAD_ASPHALT + 16) return 'asphalt';
  if (id >= T.ROAD_COBBLE && id < T.ROAD_COBBLE + 16) return 'cobble';
  switch (id) {
    case T.GRASS:
    case T.GRASS_FLOWERS:
      return 'grass';
    case T.PAVING:
      return 'paving';
    case T.WATER:
    case T.WATER_SHORE:
      return 'water';
    case T.ROOF:
    case T.WALL:
      return 'building';
    case T.TREE:
      return 'tree';
  }
  return undefined;
}

export const TILE_COUNT = TILESET_COLUMNS * TILESET_ROWS;
