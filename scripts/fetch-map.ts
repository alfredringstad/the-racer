// Builds the game map of central Norrköping from OpenStreetMap data.
//
//   npm run fetch-map               # use data/osm-cache.json if present, else query Overpass
//   npm run fetch-map -- --refresh  # re-query Overpass and overwrite the cache
//
// Pipeline: Overpass (boundary streets → frame, then all features in the frame) →
// project to metres → rotate so the street grid is axis-aligned → rasterize to a
// tile grid → autotile → write a Tiled-compatible JSON map (+ a small preview PNG).
//
// Map data © OpenStreetMap contributors, available under the ODbL.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpass, type LatLon, type OsmElement, type OverpassResponse, type OsmWay } from './lib/overpass';
import { dominantGridAngle, Projection, relationRings, type Vec } from './lib/geo';
import { fillRings, Grid, samplePolyline, strokeLine } from './lib/raster';
import { Img } from './lib/png';
import { DIAG_INDEX, E, N, S, T, TILE_COUNT, TILE_SIZE, TILESET_COLUMNS, TILESET_ROWS, W, lowerWallId, roofId, surfaceOfTileId, tileName, upperWallId } from '../src/game/tiles';
import { PALETTE } from '../src/game/palette';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = resolve(ROOT, 'data/osm-cache.json');
const MAP_FILE = resolve(ROOT, 'public/assets/maps/norrkoping.json');
const PREVIEW_FILE = resolve(ROOT, 'data/map-preview.png');

/** Metres per 16px tile. The car sprite is 16px, so this also sets how big streets feel. */
const METRES_PER_TILE = 2.25;
/** Extra space around the four boundary streets, in metres. */
const MARGIN_M = 30;

/** Rough search area used only to find the four boundary streets. */
const SEARCH_BBOX = { s: 58.575, w: 16.15, n: 58.605, e: 16.22 };
const BOUNDARY = {
  west: 'Kungsgatan',
  south: 'Södra Promenaden',
  east: 'Östra Promenaden',
  north: 'Norra Promenaden',
};

/** Drivable road width in metres, by highway=* value (wider than reality). Anything missing isn't rasterized. */
const ROAD_WIDTH_M: Record<string, number> = {
  motorway: 11.25,
  trunk: 11.25,
  primary: 11.25,
  secondary: 11.25,
  tertiary: 11.25,
  motorway_link: 9,
  trunk_link: 9,
  primary_link: 9,
  secondary_link: 9,
  tertiary_link: 9,
  residential: 9,
  unclassified: 9,
  living_street: 9,
  pedestrian: 9,
};
const ROAD_WIDTH: Record<string, number> = Object.fromEntries(
  Object.entries(ROAD_WIDTH_M).map(([k, m]) => [k, Math.max(2, Math.round(m / METRES_PER_TILE))]),
);
/** Main roads (spawn candidates) are at least this many tiles wide. */
const MAIN_ROAD_TILES = ROAD_WIDTH.secondary;
/** Spacing of trees along natural=tree_row, in metres. */
const TREE_ROW_SPACING_M = 7;

const COBBLE_SURFACES = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones', 'stone', 'cobblestone:flattened']);
const GREEN = {
  leisure: new Set(['park', 'garden', 'playground', 'pitch', 'dog_park']),
  landuse: new Set(['grass', 'meadow', 'recreation_ground', 'village_green', 'cemetery', 'forest', 'flowerbed']),
  natural: new Set(['wood', 'scrub', 'grassland', 'heath']),
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Cache {
  fetchedAt: string;
  attribution: string;
  streets: OverpassResponse;
  features: OverpassResponse;
  featuresBbox: { s: number; w: number; n: number; e: number };
}

const bboxStr = (b: { s: number; w: number; n: number; e: number }) =>
  [b.s, b.w, b.n, b.e].map((x) => x.toFixed(5)).join(',');

function streetsQuery() {
  const names = Object.values(BOUNDARY).join('|');
  return `[out:json][timeout:90];way["highway"]["name"~"^(${names})$",i](${bboxStr(SEARCH_BBOX)});out geom;`;
}

function featuresQuery(b: Cache['featuresBbox']) {
  return `[out:json][timeout:180][bbox:${bboxStr(b)}];
(
  way["highway"];
  way["building"]; relation["building"];
  way["natural"="water"]; relation["natural"="water"];
  way["waterway"="riverbank"]; relation["waterway"="riverbank"];
  way["leisure"]; relation["leisure"~"^(park|garden)$"];
  way["landuse"]; relation["landuse"~"^(grass|recreation_ground)$"];
  way["natural"~"^(wood|scrub|grassland|heath|tree_row)$"];
  way["amenity"="parking"];
  way["place"="square"];
  node["natural"="tree"];
);
out geom;`;
}

/** Geographic bbox of the four boundary streets, restricted to the bits that actually frame the area. */
function boundaryPoints(streets: OverpassResponse) {
  const by: Record<keyof typeof BOUNDARY, LatLon[][]> = { west: [], south: [], east: [], north: [] };
  for (const el of streets.elements) {
    if (el.type !== 'way') continue;
    const name = el.tags?.name?.toLowerCase();
    for (const [side, street] of Object.entries(BOUNDARY) as [keyof typeof BOUNDARY, string][])
      if (name === street.toLowerCase()) by[side].push(el.geometry);
  }
  for (const [side, lines] of Object.entries(by))
    if (!lines.length) throw new Error(`Boundary street for ${side} (${BOUNDARY[side as keyof typeof BOUNDARY]}) not found`);
  return by;
}

async function loadData(refresh: boolean): Promise<Cache> {
  if (!refresh && existsSync(CACHE_FILE)) {
    console.log(`Using cached OSM data from ${CACHE_FILE}`);
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  }
  console.log('Querying Overpass for boundary streets…');
  const streets = await overpass(streetsQuery());
  const b = boundaryPoints(streets);
  // Generous geographic box around the frame; the exact (rotated) frame is computed later.
  const west = Math.min(...b.west.flat().map((p) => p.lon));
  const east = Math.max(...b.east.flat().map((p) => p.lon));
  const south = Math.min(...b.south.flat().filter((p) => p.lon > west && p.lon < east).map((p) => p.lat));
  const north = Math.max(...b.west.flat().map((p) => p.lat), ...b.east.flat().map((p) => p.lat));
  // Pad enough to cover the frame after it's rotated to the street grid (~15°) plus margin.
  const padLat = 0.004; // ~450 m
  const padLon = 0.007; // ~400 m
  const featuresBbox = { s: south - padLat, w: west - padLon, n: north + padLat, e: east + padLon };
  console.log(`Querying Overpass for features in ${bboxStr(featuresBbox)}…`);
  const features = await overpass(featuresQuery(featuresBbox));
  const cache: Cache = {
    fetchedAt: new Date().toISOString(),
    attribution: 'Map data © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright',
    streets,
    features,
    featuresBbox,
  };
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`Cached ${features.elements.length} elements → ${CACHE_FILE}`);
  return cache;
}

// ---------------------------------------------------------------------------
// Rasterize
// ---------------------------------------------------------------------------

type Ground = 'paving' | 'grass' | 'water' | 'building' | 'asphalt' | 'cobble';
type TreePart = 'small' | 'TL' | 'TR' | 'BL' | 'BR';
interface StreetShape {
  name: string;
  kind: 'street' | 'square';
  highway: string;
  widthPx: number;
  points: { x: number; y: number }[];
}
const TREE_TILE: Record<TreePart, number> = { small: T.TREE_SMALL, TL: T.TREE_TL, TR: T.TREE_TR, BL: T.TREE_BL, BR: T.TREE_BR };
const isRoad = (g: Ground | undefined) => g === 'asphalt' || g === 'cobble';

function buildMap(cache: Cache) {
  const { streets, features } = cache;
  const fb = cache.featuresBbox;
  const origin = { lat: (fb.s + fb.n) / 2, lon: (fb.w + fb.e) / 2 };

  // 1. Grid orientation from every car road in the area.
  const flat = new Projection(origin);
  const roadLines = features.elements
    .filter((e): e is OsmWay => e.type === 'way' && !!e.tags?.highway && e.tags.highway in ROAD_WIDTH)
    .map((w) => w.geometry.map((p) => flat.metres(p)));
  const rotation = dominantGridAngle(roadLines);
  const proj = new Projection(origin, rotation);
  console.log(`Street grid rotation: ${rotation.toFixed(2)}°`);

  // 2. Frame from the four boundary streets in rotated space.
  const b = boundaryPoints(streets);
  const pts = (lines: LatLon[][]) => lines.flat().map((p) => proj.project(p));
  const westU = Math.min(...pts(b.west).map(([u]) => u));
  const eastPts = pts(b.east);
  const eastU = Math.max(...eastPts.map(([u]) => u));
  const southV = Math.min(...pts(b.south).filter(([u]) => u >= westU && u <= eastU).map(([, v]) => v));
  // Norra Promenaden keeps going north-east past the end of Östra Promenaden; only count
  // the part west of where Östra ends so the frame doesn't balloon.
  const eastTop = eastPts.reduce((a, p) => (p[1] > a[1] ? p : a));
  const northV = Math.max(...pts(b.north).filter(([u]) => u >= westU && u <= eastTop[0]).map(([, v]) => v));

  const minU = westU - MARGIN_M;
  const maxU = eastU + MARGIN_M;
  const minV = southV - MARGIN_M;
  const maxV = northV + MARGIN_M;
  const cols = Math.ceil((maxU - minU) / METRES_PER_TILE);
  const rows = Math.ceil((maxV - minV) / METRES_PER_TILE);
  console.log(`Frame: ${(maxU - minU).toFixed(0)} × ${(maxV - minV).toFixed(0)} m → ${cols} × ${rows} tiles`);

  for (const [u, v] of [[minU, minV], [minU, maxV], [maxU, minV], [maxU, maxV]] as Vec[]) {
    const { lat, lon } = proj.unproject([u, v]);
    if (lat < fb.s || lat > fb.n || lon < fb.w || lon > fb.e)
      console.warn(`WARNING: frame corner ${lat.toFixed(5)},${lon.toFixed(5)} is outside the fetched area — run with --refresh after widening the padding`);
  }

  const toTile = (p: LatLon): Vec => {
    const [u, v] = proj.project(p);
    return [(u - minU) / METRES_PER_TILE, (maxV - v) / METRES_PER_TILE];
  };
  const tileToLatLon = (c: number, r: number) => proj.unproject([minU + c * METRES_PER_TILE, maxV - r * METRES_PER_TILE]);

  const ground = new Grid<Ground>(cols, rows, 'paving');
  const trees = new Grid<TreePart | undefined>(cols, rows, undefined);
  /** Tiles stroked from a main road way (not parking lots or squares) — spawn candidates. */
  const mainRoad = new Grid<boolean>(cols, rows, false);

  // Polygons of an element: closed ways, or joined multipolygon rings.
  const ringsOf = (el: OsmElement): Vec[][] => {
    if (el.type === 'way') {
      const g = el.geometry;
      const closed = g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
      return closed ? [g.map(toTile)] : [];
    }
    if (el.type === 'relation') return relationRings(el).map((r) => r.map(toTile));
    return [];
  };
  const fillArea = (el: OsmElement, kind: Ground) => {
    const rings = ringsOf(el);
    if (rings.length) fillRings(ground, rings, (c, r) => ground.set(c, r, kind));
  };

  const els = features.elements;
  const tag = (el: OsmElement, k: string) => el.tags?.[k];
  const underground = (el: OsmElement) =>
    tag(el, 'location') === 'underground' || Number(tag(el, 'layer') ?? 0) < 0 || tag(el, 'parking') === 'underground';

  // Paint order: later passes win.
  for (const el of els) {
    const green =
      GREEN.leisure.has(tag(el, 'leisure') ?? '') || GREEN.landuse.has(tag(el, 'landuse') ?? '') || GREEN.natural.has(tag(el, 'natural') ?? '');
    if (green && tag(el, 'natural') !== 'tree_row') fillArea(el, 'grass');
  }
  for (const el of els)
    if (tag(el, 'natural') === 'water' || tag(el, 'waterway') === 'riverbank') fillArea(el, 'water');
  for (const el of els) {
    if (underground(el)) continue;
    if (tag(el, 'amenity') === 'parking') fillArea(el, 'asphalt');
    if (tag(el, 'place') === 'square' || (tag(el, 'highway') === 'pedestrian' && tag(el, 'area') === 'yes'))
      fillArea(el, COBBLE_SURFACES.has(tag(el, 'surface') ?? 'sett') ? 'cobble' : 'asphalt');
  }
  for (const el of els)
    if (tag(el, 'building') && !['roof', 'carport'].includes(tag(el, 'building')!) && !underground(el)) fillArea(el, 'building');

  // Roads: wide first, so narrower streets that share tiles keep their own surface.
  const roads = els
    .filter((e): e is OsmWay => e.type === 'way')
    .filter((w) => {
      const hw = w.tags?.highway;
      return !!hw && hw in ROAD_WIDTH && w.tags?.area !== 'yes' && !w.tags?.tunnel && w.tags?.covered !== 'yes';
    })
    .sort((a, b) => ROAD_WIDTH[b.tags!.highway] - ROAD_WIDTH[a.tags!.highway]);
  for (const w of roads) {
    const t = w.tags!;
    const surface = t.surface ?? (t.highway === 'pedestrian' || t.highway === 'living_street' ? 'sett' : 'asphalt');
    const kind: Ground = COBBLE_SURFACES.has(surface) ? 'cobble' : 'asphalt';
    const width = ROAD_WIDTH[t.highway];
    strokeLine(ground, w.geometry.map(toTile), width, (c, r) => {
      ground.set(c, r, kind);
      if (width >= MAIN_ROAD_TILES && kind === 'asphalt') mainRoad.set(c, r, true);
    });
  }

  // Trees: mapped single trees and tree rows, only on open (non-road) ground.
  // Big 2×2 trees where there's room, a small one otherwise.
  const open = (c: number, r: number) => {
    const g = ground.get(c, r);
    return (g === 'grass' || g === 'paving') && !trees.get(c, r);
  };
  const plant = ([x, y]: Vec) => {
    // The 2×2 tree is centred on the tile corner nearest the point.
    const c = Math.round(x) - 1;
    const r = Math.round(y) - 1;
    if (open(c, r) && open(c + 1, r) && open(c, r + 1) && open(c + 1, r + 1)) {
      trees.set(c, r, 'TL');
      trees.set(c + 1, r, 'TR');
      trees.set(c, r + 1, 'BL');
      trees.set(c + 1, r + 1, 'BR');
    } else if (open(Math.floor(x), Math.floor(y))) trees.set(Math.floor(x), Math.floor(y), 'small');
  };
  for (const el of els) {
    if (el.type === 'node' && tag(el, 'natural') === 'tree') plant(toTile(el));
    if (el.type === 'way' && tag(el, 'natural') === 'tree_row')
      samplePolyline(el.geometry.map(toTile), TREE_ROW_SPACING_M / METRES_PER_TILE).forEach(plant);
  }
  // Sprinkle a few extra trees into parks so lawns don't look bare.
  for (let r = 2; r < rows - 2; r++)
    for (let c = 2; c < cols - 2; c++) {
      if (hash(c, r, 3) > 0.012) continue;
      let lawn = true;
      for (let dr = -1; dr <= 2 && lawn; dr++)
        for (let dc = -1; dc <= 2 && lawn; dc++) lawn = ground.get(c + dc, r + dr) === 'grass' && !trees.get(c + dc, r + dr);
      if (lawn) plant([c + 1, r + 1]);
    }

  // 3. Autotile → tileset ids.
  const groundIds = new Array<number>(cols * rows);
  const decorIds = new Array<number>(cols * rows).fill(-1);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const g = ground.get(c, r)!;
      const i = r * cols + c;
      let id: number;
      if (isRoad(g)) {
        // Off-map counts as road so streets run off the edge without a curb.
        const road = (dc: number, dr: number) => !ground.inBounds(c + dc, r + dr) || isRoad(ground.get(c + dc, r + dr));
        const mask = (road(0, -1) ? N : 0) | (road(1, 0) ? E : 0) | (road(0, 1) ? S : 0) | (road(-1, 0) ? W : 0);
        const diag = DIAG_INDEX[mask];
        id =
          diag !== undefined
            ? (g === 'asphalt' ? T.ROAD_ASPHALT_DIAG : T.ROAD_COBBLE_DIAG) + diag
            : (g === 'asphalt' ? T.ROAD_ASPHALT : T.ROAD_COBBLE) + mask;
      } else if (g === 'building') {
        // 3/4 view: the two southernmost rows of a building are its facade.
        if (ground.get(c, r + 1) !== 'building') id = lowerWallId('residential');
        else if (ground.get(c, r + 2) !== 'building') id = upperWallId('residential');
        else id = roofId('residential');
      }
      else if (g === 'water') id = ground.get(c, r - 1) === 'water' || r === 0 ? T.WATER : T.WATER_SHORE;
      else if (g === 'grass') id = hash(c, r, 1) < 0.08 ? T.GRASS_FLOWERS : T.GRASS;
      else id = T.PAVING;
      groundIds[i] = id;
      const tree = trees.get(c, r);
      if (tree) decorIds[i] = TREE_TILE[tree];
    }

  // 4. Spawn: on a straight stretch of main road, as close to the centre as possible.
  const spawn = findSpawn(ground, mainRoad, cols, rows);

  const counts: Record<string, number> = {};
  for (const g of ground.cells) counts[g] = (counts[g] ?? 0) + 1;
  console.log('Tile mix:', Object.entries(counts).map(([k, v]) => `${k} ${((100 * v) / ground.cells.length).toFixed(1)}%`).join(', '));

  // 5. Street names: named roads as polylines, named squares as polygons (pixel coords).
  const px = ([x, y]: Vec) => ({ x: Math.round(x * TILE_SIZE * 10) / 10, y: Math.round(y * TILE_SIZE * 10) / 10 });
  const streetShapes: StreetShape[] = [];
  for (const w of roads) {
    const name = w.tags?.name;
    if (!name) continue;
    streetShapes.push({ name, kind: 'street', highway: w.tags!.highway, widthPx: ROAD_WIDTH[w.tags!.highway] * TILE_SIZE, points: w.geometry.map((p) => px(toTile(p))) });
  }
  for (const el of els) {
    const name = tag(el, 'name');
    if (!name || !(tag(el, 'place') === 'square' || (tag(el, 'highway') === 'pedestrian' && tag(el, 'area') === 'yes'))) continue;
    for (const ring of ringsOf(el)) streetShapes.push({ name, kind: 'square', highway: tag(el, 'highway') ?? 'square', widthPx: 0, points: ring.slice(0, -1).map(px) });
  }

  const inside = ({ x, y }: { x: number; y: number }) => x >= 0 && y >= 0 && x <= cols * TILE_SIZE && y <= rows * TILE_SIZE;
  const named = streetShapes.filter((st) => st.points.some(inside));

  return { cols, rows, groundIds, decorIds, spawn, rotation, origin, minU, maxV, tileToLatLon, ground, trees, streets: named };
}

function findSpawn(ground: Grid<Ground>, mainRoad: Grid<boolean>, cols: number, rows: number) {
  const road = (c: number, r: number) => isRoad(ground.get(c, r));
  const run = (c: number, r: number, dc: number, dr: number) => {
    let n = 0;
    while (n < 30 && road(c + dc * (n + 1), r + dr * (n + 1))) n++;
    return n;
  };
  let best: { c: number; r: number; d: number; heading: number } | undefined;
  for (let r = 2; r < rows - 2; r++)
    for (let c = 2; c < cols - 2; c++) {
      if (!mainRoad.get(c, r)) continue;
      // Middle of the carriageway: road on both sides, and a long straight run along one axis.
      const [e, w, s, n] = [run(c, r, 1, 0), run(c, r, -1, 0), run(c, r, 0, 1), run(c, r, 0, -1)];
      const half = Math.floor(MAIN_ROAD_TILES / 2);
      const horizontal = e >= 16 && w >= 16 && n >= half && s >= half && n + s < MAIN_ROAD_TILES;
      const vertical = n >= 16 && s >= 16 && e >= half && w >= half && e + w < MAIN_ROAD_TILES;
      if (!horizontal && !vertical) continue;
      const d = Math.hypot(c - cols / 2, r - rows / 2);
      if (!best || d < best.d) best = { c, r, d, heading: horizontal ? 0 : -90 };
    }
  if (!best) throw new Error('No spawn point found');
  return { x: (best.c + 0.5) * TILE_SIZE, y: (best.r + 0.5) * TILE_SIZE, heading: best.heading };
}

function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function toTiled(m: ReturnType<typeof buildMap>, cache: Cache) {
  const gid = (id: number) => (id < 0 ? 0 : id + 1);
  const tiles = [];
  for (let id = 0; id < TILE_COUNT; id++) {
    const surface = surfaceOfTileId(id);
    const name = tileName(id);
    const properties = [];
    if (name) properties.push({ name: 'name', type: 'string', value: name });
    if (surface) properties.push({ name: 'surface', type: 'string', value: surface });
    if (properties.length) tiles.push({ id, properties });
  }
  const layer = (id: number, name: string, data: number[]) => ({
    id,
    name,
    type: 'tilelayer',
    x: 0,
    y: 0,
    width: m.cols,
    height: m.rows,
    opacity: 1,
    visible: true,
    data: data.map(gid),
  });
  const nw = m.tileToLatLon(0, 0);
  return {
    type: 'map',
    version: '1.10',
    tiledversion: '1.11.0',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    compressionlevel: -1,
    width: m.cols,
    height: m.rows,
    tilewidth: TILE_SIZE,
    tileheight: TILE_SIZE,
    nextlayerid: 5,
    nextobjectid: m.streets.length + 2,
    properties: [
      { name: 'attribution', type: 'string', value: cache.attribution },
      { name: 'osmTimestamp', type: 'string', value: cache.features.osm3s?.timestamp_osm_base ?? cache.fetchedAt },
      { name: 'metresPerTile', type: 'float', value: METRES_PER_TILE },
      { name: 'gridRotationDeg', type: 'float', value: Number(m.rotation.toFixed(4)) },
      { name: 'originLat', type: 'float', value: m.origin.lat },
      { name: 'originLon', type: 'float', value: m.origin.lon },
      { name: 'frameMinU', type: 'float', value: Number(m.minU.toFixed(3)) },
      { name: 'frameMaxV', type: 'float', value: Number(m.maxV.toFixed(3)) },
      { name: 'nwCornerLatLon', type: 'string', value: `${nw.lat.toFixed(6)},${nw.lon.toFixed(6)}` },
    ],
    tilesets: [
      {
        firstgid: 1,
        name: 'tiles',
        image: '../tiles/tiles.png',
        imagewidth: TILESET_COLUMNS * TILE_SIZE,
        imageheight: TILESET_ROWS * TILE_SIZE,
        tilewidth: TILE_SIZE,
        tileheight: TILE_SIZE,
        columns: TILESET_COLUMNS,
        tilecount: TILE_COUNT,
        margin: 0,
        spacing: 0,
        tiles,
      },
    ],
    layers: [
      layer(1, 'ground', m.groundIds),
      layer(2, 'decor', m.decorIds),
      {
        id: 3,
        name: 'objects',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects: [
          {
            id: 1,
            name: 'spawn',
            type: 'spawn',
            x: m.spawn.x,
            y: m.spawn.y,
            width: 0,
            height: 0,
            point: true,
            rotation: 0,
            visible: true,
            properties: [{ name: 'heading', type: 'float', value: m.spawn.heading }],
          },
        ],
      },
      {
        id: 4,
        name: 'streets',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects: m.streets.map((st, i) => {
          const [o] = st.points;
          const rel = st.points.map((p) => ({ x: Math.round((p.x - o.x) * 10) / 10, y: Math.round((p.y - o.y) * 10) / 10 }));
          return {
            id: i + 2,
            name: st.name,
            type: st.kind,
            x: o.x,
            y: o.y,
            width: 0,
            height: 0,
            rotation: 0,
            visible: true,
            ...(st.kind === 'street' ? { polyline: rel } : { polygon: rel }),
            properties: [
              { name: 'highway', type: 'string', value: st.highway },
              { name: 'widthPx', type: 'float', value: st.widthPx },
            ],
          };
        }),
      },
    ],
  };
}

function preview(m: ReturnType<typeof buildMap>): Img {
  const colour: Record<Ground, number> = {
    paving: PALETTE.paving,
    grass: PALETTE.grass,
    water: PALETTE.water,
    building: PALETTE.roof,
    asphalt: PALETTE.asphalt,
    cobble: PALETTE.cobble,
  };
  const img = new Img(m.cols, m.rows);
  for (let r = 0; r < m.rows; r++)
    for (let c = 0; c < m.cols; c++) img.set(c, r, m.trees.get(c, r) ? PALETTE.tree : colour[m.ground.get(c, r)!]);
  return img;
}

async function main() {
  const cache = await loadData(process.argv.includes('--refresh'));
  const m = buildMap(cache);
  mkdirSync(dirname(MAP_FILE), { recursive: true });
  writeFileSync(MAP_FILE, JSON.stringify(toTiled(m, cache)));
  writeFileSync(PREVIEW_FILE, preview(m).toPNG());
  console.log(`Spawn at (${m.spawn.x}, ${m.spawn.y}) heading ${m.spawn.heading}°`);
  console.log(`Wrote ${MAP_FILE}\nWrote ${PREVIEW_FILE} (1 px per tile)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
