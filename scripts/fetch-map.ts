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
import { E, N, S, T, TILE_COUNT, TILE_SIZE, TILESET_COLUMNS, TILESET_ROWS, W, surfaceOfTileId } from '../src/game/tiles';
import { PALETTE } from '../src/game/palette';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = resolve(ROOT, 'data/osm-cache.json');
const MAP_FILE = resolve(ROOT, 'public/assets/maps/norrkoping.json');
const PREVIEW_FILE = resolve(ROOT, 'data/map-preview.png');

/** Metres per 16px tile. */
const METRES_PER_TILE = 4.5;
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

/** Drivable road width in tiles, by highway=* value. Anything missing isn't rasterized. */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 3,
  trunk: 3,
  primary: 3,
  secondary: 3,
  tertiary: 3,
  motorway_link: 2,
  trunk_link: 2,
  primary_link: 2,
  secondary_link: 2,
  tertiary_link: 2,
  residential: 2,
  unclassified: 2,
  living_street: 2,
  pedestrian: 2,
};

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
  const trees = new Grid<boolean>(cols, rows, false);
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
      if (width >= 3 && kind === 'asphalt') mainRoad.set(c, r, true);
    });
  }

  // Trees: mapped single trees and tree rows, only on open (non-road) ground.
  const plant = ([x, y]: Vec) => {
    const c = Math.floor(x);
    const r = Math.floor(y);
    const g = ground.get(c, r);
    if (g === 'grass' || g === 'paving') trees.set(c, r, true);
  };
  for (const el of els) {
    if (el.type === 'node' && tag(el, 'natural') === 'tree') plant(toTile(el));
    if (el.type === 'way' && tag(el, 'natural') === 'tree_row') samplePolyline(el.geometry.map(toTile), 2).forEach(plant);
  }
  // Sprinkle a few extra trees into parks so lawns don't look bare.
  for (let r = 1; r < rows - 1; r++)
    for (let c = 1; c < cols - 1; c++) {
      if (ground.get(c, r) !== 'grass' || hash(c, r, 3) > 0.06) continue;
      const allGrass = [[0, -1], [1, 0], [0, 1], [-1, 0]].every(([dc, dr]) => ground.get(c + dc, r + dr) === 'grass');
      if (allGrass) trees.set(c, r, true);
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
        id = (g === 'asphalt' ? T.ROAD_ASPHALT : T.ROAD_COBBLE) + mask;
      } else if (g === 'building') id = ground.get(c, r + 1) === 'building' ? T.ROOF : T.WALL;
      else if (g === 'water') id = ground.get(c, r - 1) === 'water' || r === 0 ? T.WATER : T.WATER_SHORE;
      else if (g === 'grass') id = hash(c, r, 1) < 0.08 ? T.GRASS_FLOWERS : T.GRASS;
      else id = T.PAVING;
      groundIds[i] = id;
      if (trees.get(c, r)) decorIds[i] = T.TREE;
    }

  // 4. Spawn: on a straight stretch of main road, as close to the centre as possible.
  const spawn = findSpawn(ground, mainRoad, cols, rows);

  const counts: Record<string, number> = {};
  for (const g of ground.cells) counts[g] = (counts[g] ?? 0) + 1;
  console.log('Tile mix:', Object.entries(counts).map(([k, v]) => `${k} ${((100 * v) / ground.cells.length).toFixed(1)}%`).join(', '));

  return { cols, rows, groundIds, decorIds, spawn, rotation, origin, minU, maxV, tileToLatLon, ground, trees };
}

function findSpawn(ground: Grid<Ground>, mainRoad: Grid<boolean>, cols: number, rows: number) {
  const road = (c: number, r: number) => isRoad(ground.get(c, r));
  const run = (c: number, r: number, dc: number, dr: number) => {
    let n = 0;
    while (n < 20 && road(c + dc * (n + 1), r + dr * (n + 1))) n++;
    return n;
  };
  let best: { c: number; r: number; d: number; heading: number } | undefined;
  for (let r = 2; r < rows - 2; r++)
    for (let c = 2; c < cols - 2; c++) {
      if (!mainRoad.get(c, r)) continue;
      // Middle of the carriageway: road on both sides, and a long straight run along one axis.
      const [e, w, s, n] = [run(c, r, 1, 0), run(c, r, -1, 0), run(c, r, 0, 1), run(c, r, 0, -1)];
      const horizontal = e >= 8 && w >= 8 && n >= 1 && s >= 1 && n + s <= 3;
      const vertical = n >= 8 && s >= 8 && e >= 1 && w >= 1 && e + w <= 3;
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
    if (surface) tiles.push({ id, properties: [{ name: 'surface', type: 'string', value: surface }] });
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
    nextlayerid: 4,
    nextobjectid: 2,
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
