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
import { overpass, type LatLon, type OsmElement, type OsmNode, type OverpassResponse, type OsmWay } from './lib/overpass';
import { buildingStyle, hasOutdoorSeating, POI_QUERY, poiFacade } from './lib/buildings';
import { buildMarkings, type Marking } from './lib/markings';
import { buildTramRoutes } from './lib/tram-routes';
import { dominantGridAngle, Projection, relationRings, type Vec } from './lib/geo';
import { fillRings, Grid, samplePolyline, samplePolylineWithDir, strokeLine } from './lib/raster';
import { Img } from './lib/png';
import { DIAG_INDEX, DIAG_MASKS, E, N, S, T, TILE_COUNT, TILE_SIZE, TILESET_COLUMNS, TILESET_ROWS, W, lowerWallId, roofId, surfaceOfTileId, tileName, upperWallId, BUILDING_STYLES, FACADES, type BuildingStyle, type Facade } from '../src/game/tiles';
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
/** How far (metres) from a shop/restaurant node we look for a visible facade to put its storefront on. */
const STOREFRONT_SEARCH_M = 18;
/** Storefronts span this many facade tiles (centre ± this). */
const STOREFRONT_HALF_TILES = 1;
/** Width (metres) of the deck laid under tram tracks that cross water on their own bridge. */
const TRAM_BRIDGE_M = 6.75;
/** Tram stop signs go on open ground within this distance (metres) of the stop node. */
const STOP_SIGN_SEARCH_M = 9;
/** Generated street lamps: spacing along a street (alternating sides) and minimum gap between any two lamps. */
const LAMP_SPACING_M = 24;
const LAMP_MIN_GAP_M = 11;
/** How far outside the drawn road edge a generated lamp stands, in metres. */
const LAMP_CURB_OFFSET_M = 0.9;
/** Spacing of trees along natural=tree_row, in metres. */
const TREE_ROW_SPACING_M = 7;

const COBBLE_SURFACES = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones', 'stone', 'cobblestone:flattened']);
const GREEN = {
  leisure: new Set(['park', 'garden', 'playground', 'pitch', 'dog_park']),
  landuse: new Set(['grass', 'meadow', 'recreation_ground', 'village_green', 'cemetery', 'forest', 'flowerbed', 'religious']),
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
  node["natural"="tree"];${POI_QUERY}
  node["highway"="street_lamp"];
  node["highway"~"^(crossing|traffic_signals|stop|give_way)$"];
  way["railway"="tram"];
  way["railway"="platform"];
  node["railway"="tram_stop"];
  relation["route"="tram"];
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

type Ground = 'paving' | 'grass' | 'water' | 'building' | 'asphalt' | 'cobble' | 'platform';
/** Tram/bus-only streets are highway=service but are real streets in the city centre. */
const isTransitStreet = (w: OsmElement) =>
  w.tags?.highway === 'service' && (!!w.tags.embedded_rails || ['yes', 'designated'].includes(w.tags.bus ?? '') || w.tags.psv === 'designated');
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
  // Remember the water before roads and decks are painted over it: those spans are bridges a boat can pass under.
  const wasWater = new Grid<boolean>(cols, rows, false);
  ground.cells.forEach((g, i) => (wasWater.cells[i] = g === 'water'));
  for (const el of els) {
    if (underground(el)) continue;
    if (tag(el, 'amenity') === 'parking') fillArea(el, 'asphalt');
    if (tag(el, 'place') === 'square' || (tag(el, 'highway') === 'pedestrian' && tag(el, 'area') === 'yes'))
      fillArea(el, COBBLE_SURFACES.has(tag(el, 'surface') ?? 'sett') ? 'cobble' : 'asphalt');
  }
  // Buildings: remember which building owns each tile so styles apply per building.
  const buildingAt = new Grid<number>(cols, rows, -1);
  const buildings: { el: OsmElement; style: BuildingStyle; cells: Vec[] }[] = [];
  for (const el of els) {
    if (!tag(el, 'building') || ['roof', 'carport'].includes(tag(el, 'building')!) || underground(el)) continue;
    const rings = ringsOf(el);
    if (!rings.length) continue;
    const b = { el, style: 'residential' as BuildingStyle, cells: [] as Vec[] };
    fillRings(ground, rings, (c, r) => {
      ground.set(c, r, 'building');
      buildingAt.set(c, r, buildings.length);
      b.cells.push([c, r]);
    });
    buildings.push(b);
  }
  // Points of interest: nodes, plus buildings that are themselves tagged as a shop/restaurant.
  const pois: { tags: Record<string, string>; at: Vec }[] = els
    .filter((e): e is OsmNode => e.type === 'node' && !!(e.tags?.amenity || e.tags?.shop))
    .map((n) => ({ tags: n.tags!, at: toTile(n) }));
  const worship = new Set<number>();
  for (const p of pois) if (p.tags.amenity === 'place_of_worship') worship.add(buildingAt.get(Math.floor(p.at[0]), Math.floor(p.at[1])) ?? -1);
  buildings.forEach((b, id) => {
    b.style = buildingStyle(b.el.tags, worship.has(id));
    if (b.cells.length && poiFacade(b.el.tags)) {
      const cx = b.cells.reduce((a, [c]) => a + c, 0) / b.cells.length;
      const cy = b.cells.reduce((a, [, r]) => a + r, 0) / b.cells.length;
      pois.push({ tags: b.el.tags!, at: [cx + 0.5, cy + 0.5] });
    }
  });

  // Roads: wide first, so narrower streets that share tiles keep their own surface.
  const roads = els
    .filter((e): e is OsmWay => e.type === 'way')
    .filter((w) => {
      const hw = isTransitStreet(w) ? 'residential' : w.tags?.highway;
      return !!hw && hw in ROAD_WIDTH && w.tags?.area !== 'yes' && !w.tags?.tunnel && w.tags?.covered !== 'yes';
    })
    .map((w) => (isTransitStreet(w) ? { ...w, tags: { ...w.tags, highway: 'residential' } } : w))
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

  // Trams: tracks (drawn by the game from the 'tram' object layer), bridge decks, platforms.
  const tramTracks = els.filter((e): e is OsmWay => e.type === 'way' && tag(e, 'railway') === 'tram' && !tag(e, 'tunnel'));
  for (const w of tramTracks)
    if (tag(w, 'bridge'))
      strokeLine(ground, w.geometry.map(toTile), Math.round(TRAM_BRIDGE_M / METRES_PER_TILE), (c, r) => {
        if (ground.get(c, r) === 'water') ground.set(c, r, 'paving');
      });
  for (const el of els) {
    const isPlatform = tag(el, 'railway') === 'platform' || tag(el, 'highway') === 'platform' || tag(el, 'public_transport') === 'platform';
    if (!isPlatform || el.type === 'node') continue;
    const rings = ringsOf(el);
    if (rings.length) fillRings(ground, rings, (c, r) => ground.get(c, r) !== 'building' && ground.set(c, r, 'platform'));
    else if (el.type === 'way') strokeLine(ground, el.geometry.map(toTile), 1, (c, r) => ground.get(c, r) !== 'building' && ground.set(c, r, 'platform'));
  }
  // Which tram lines use each track, from the route relations.
  const linesOfWay = new Map<number, Set<string>>();
  for (const el of els)
    if (el.type === 'relation' && tag(el, 'route') === 'tram' && tag(el, 'ref'))
      for (const m of el.members)
        if (m.type === 'way') {
          if (!linesOfWay.has(m.ref)) linesOfWay.set(m.ref, new Set());
          linesOfWay.get(m.ref)!.add(tag(el, 'ref')!);
        }
  const tramStops = els.filter((e): e is OsmNode => e.type === 'node' && tag(e, 'railway') === 'tram_stop' && !!tag(e, 'name'));

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

  // Storefronts: each shop/restaurant gets an awning on the nearest street-level facade we can see
  // (south-facing, 3/4 view). If there isn't one nearby, food & drink places get outdoor tables instead.
  const facadeAt = new Grid<Facade | undefined>(cols, rows, undefined);
  const extraDecor = new Grid<number | undefined>(cols, rows, undefined);
  const isStreetFacade = (c: number, r: number) => ground.get(c, r) === 'building' && ground.get(c, r + 1) !== 'building' && r + 1 < rows;
  const searchTiles = Math.round(STOREFRONT_SEARCH_M / METRES_PER_TILE);
  let storefronts = 0;
  let tables = 0;
  for (const poi of pois) {
    const facade = poiFacade(poi.tags);
    if (!facade) continue;
    const pc = Math.floor(poi.at[0]);
    const pr = Math.floor(poi.at[1]);
    const home = ground.get(pc, pr) === 'building' ? buildingAt.get(pc, pr) : -1;
    let best: { c: number; r: number; score: number } | undefined;
    for (let dr = -searchTiles; dr <= searchTiles; dr++)
      for (let dc = -searchTiles; dc <= searchTiles; dc++) {
        const c = pc + dc;
        const r = pr + dr;
        if (!isStreetFacade(c, r) || facadeAt.get(c, r)) continue;
        const score = Math.hypot(dc, dr) + (buildingAt.get(c, r) === home ? 0 : 4);
        if (score <= searchTiles && (!best || score < best.score)) best = { c, r, score };
      }
    if (best) {
      const owner = buildingAt.get(best.c, best.r);
      for (let dc = -STOREFRONT_HALF_TILES; dc <= STOREFRONT_HALF_TILES; dc++) {
        const c = best.c + dc;
        if (isStreetFacade(c, best.r) && buildingAt.get(c, best.r) === owner && !facadeAt.get(c, best.r)) facadeAt.set(c, best.r, facade);
      }
      storefronts++;
    } else if (hasOutdoorSeating(facade)) {
      let spot: Vec | undefined;
      for (let d = 0; d <= 4 && !spot; d++)
        for (let dr = -d; dr <= d && !spot; dr++)
          for (let dc = -d; dc <= d && !spot; dc++)
            if (ground.get(pc + dc, pr + dr) === 'paving' && !trees.get(pc + dc, pr + dr) && !extraDecor.get(pc + dc, pr + dr)) spot = [pc + dc, pr + dr];
      if (spot) {
        extraDecor.set(spot[0], spot[1], T.CAFE_TABLES);
        tables++;
      }
    }
  }
  // Steeples: on the roof tile nearest each church's centre.
  let churches = 0;
  buildings.forEach((b, id) => {
    if (b.style !== 'church' || !b.cells.length) return;
    const cx = b.cells.reduce((a, [c]) => a + c, 0) / b.cells.length;
    const cy = b.cells.reduce((a, [, r]) => a + r, 0) / b.cells.length;
    const roof = b.cells
      .filter(([c, r]) => buildingAt.get(c, r) === id && ground.get(c, r) === 'building' && ground.get(c, r + 2) === 'building')
      .sort((a, z) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(z[0] - cx, z[1] - cy))[0];
    if (roof) {
      extraDecor.set(roof[0], roof[1], T.STEEPLE);
      churches++;
    }
  });
  // Tram stop signs: next to each stop node, on the nearest platform/sidewalk tile.
  const signRadius = Math.round(STOP_SIGN_SEARCH_M / METRES_PER_TILE);
  let signs = 0;
  for (const stop of tramStops) {
    const [sx, sy] = toTile(stop);
    let spot: Vec | undefined;
    let bestD = Infinity;
    for (let dr = -signRadius; dr <= signRadius; dr++)
      for (let dc = -signRadius; dc <= signRadius; dc++) {
        const c = Math.floor(sx) + dc;
        const r = Math.floor(sy) + dr;
        const g = ground.get(c, r);
        const d = Math.hypot(c + 0.5 - sx, r + 0.5 - sy) - (g === 'platform' ? 2 : 0); // prefer platforms
        if ((g === 'platform' || g === 'paving') && !trees.get(c, r) && extraDecor.get(c, r) === undefined && d < bestD) {
          spot = [c, r];
          bestD = d;
        }
      }
    if (spot) {
      extraDecor.set(spot[0], spot[1], T.STOP_SIGN);
      signs++;
    }
  }
  console.log(`Tram: ${tramTracks.length} track ways, ${tramStops.length} stop nodes, ${signs} stop signs`);

  const styleCounts: Record<string, number> = {};
  for (const b of buildings) styleCounts[b.style] = (styleCounts[b.style] ?? 0) + 1;
  console.log('Buildings:', Object.entries(styleCounts).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log(`Storefronts: ${storefronts}, outdoor seating: ${tables}, steeples: ${churches}`);

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
        const style = buildings[buildingAt.get(c, r)!]?.style ?? 'residential';
        if (ground.get(c, r + 1) !== 'building') id = lowerWallId(facadeAt.get(c, r) ?? style);
        else if (ground.get(c, r + 2) !== 'building') id = upperWallId(style);
        else id = roofId(style);
      }
      else if (g === 'platform') {
        const plat = (dc: number, dr: number) => ground.get(c + dc, r + dr) === 'platform';
        id = T.PLATFORM + ((plat(0, -1) ? N : 0) | (plat(1, 0) ? E : 0) | (plat(0, 1) ? S : 0) | (plat(-1, 0) ? W : 0));
      } else if (g === 'water') id = ground.get(c, r - 1) === 'water' || r === 0 ? T.WATER : T.WATER_SHORE;
      else if (g === 'grass') id = hash(c, r, 1) < 0.08 ? T.GRASS_FLOWERS : T.GRASS;
      else id = T.PAVING;
      groundIds[i] = id;
      const tree = trees.get(c, r);
      if (tree) decorIds[i] = TREE_TILE[tree];
      else if (extraDecor.get(c, r) !== undefined) decorIds[i] = extraDecor.get(c, r)!;
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

  const tram = {
    tracks: tramTracks
      .map((w) => ({
        id: w.id,
        service: tag(w, 'service') ?? '',
        bridge: !!tag(w, 'bridge'),
        lines: [...(linesOfWay.get(w.id) ?? [])].sort().join(','),
        points: w.geometry.map((p) => px(toTile(p))),
      }))
      .filter((t) => t.points.some(inside)),
    stops: tramStops.map((n) => ({ id: n.id, name: tag(n, 'name')!, ...px(toTile(n)) })).filter(inside),
  };

  // 6. Street lamps: the (few) mapped ones, then generated ones along every street not tagged lit=no.
  const lamps: { x: number; y: number; source: 'osm' | 'generated' }[] = [];
  const lampGrid = new Map<string, { x: number; y: number }[]>();
  const gapPx = (LAMP_MIN_GAP_M / METRES_PER_TILE) * TILE_SIZE;
  const lampKey = (x: number, y: number) => `${Math.floor(x / gapPx)},${Math.floor(y / gapPx)}`;
  const tooClose = (x: number, y: number) => {
    const [gx, gy] = lampKey(x, y).split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const l of lampGrid.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(l.x - x, l.y - y) < gapPx) return true;
    return false;
  };
  const addLamp = (x: number, y: number, source: 'osm' | 'generated') => {
    lamps.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, source });
    const k = lampKey(x, y);
    if (!lampGrid.has(k)) lampGrid.set(k, []);
    lampGrid.get(k)!.push({ x, y });
  };
  for (const el of els)
    if (el.type === 'node' && tag(el, 'highway') === 'street_lamp') {
      const p = px(toTile(el));
      if (inside(p)) addLamp(p.x, p.y, 'osm');
    }
  const lampSpot = (x: number, y: number) => {
    const c = Math.floor(x / TILE_SIZE);
    const r = Math.floor(y / TILE_SIZE);
    const g = ground.get(c, r);
    return (g === 'paving' || g === 'grass' || g === 'platform') && !trees.get(c, r) && extraDecor.get(c, r) === undefined;
  };
  for (const w of roads) {
    if (w.tags?.lit === 'no') continue;
    const line = w.geometry.map(toTile);
    const halfPx = (ROAD_WIDTH[w.tags!.highway] / 2) * TILE_SIZE + (LAMP_CURB_OFFSET_M / METRES_PER_TILE) * TILE_SIZE;
    const step = LAMP_SPACING_M / METRES_PER_TILE / 2; // half spacing: lamps alternate sides
    samplePolylineWithDir(line, step).forEach(([x, y, dx, dy], i) => {
      if (i === 0) return; // skip the very start (usually a junction)
      const side = i % 2 ? 1 : -1;
      const lx = x * TILE_SIZE - dy * halfPx * side;
      const ly = y * TILE_SIZE + dx * halfPx * side;
      if (inside({ x: lx, y: ly }) && lampSpot(lx, ly) && !tooClose(lx, ly)) addLamp(lx, ly, 'generated');
    });
  }
  console.log(`Street lamps: ${lamps.filter((l) => l.source === 'osm').length} mapped, ${lamps.filter((l) => l.source === 'generated').length} generated`);

  // Bridges: tiles that were water and are now something you can drive on, as horizontal runs.
  const bridges: { c: number; r: number; w: number }[] = [];
  const overWater = (c: number, r: number) => !!wasWater.get(c, r) && ground.get(c, r) !== 'water' && ground.get(c, r) !== 'building';
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!overWater(c, r) || overWater(c - 1, r)) continue;
      let w = 1;
      while (overWater(c + w, r)) w++;
      bridges.push({ c, r, w });
    }
  console.log(`Bridges: ${bridges.length} tile runs over water`);

  // 7. Road markings, inferred from road tags plus crossing/signal/give-way nodes.
  const specialNodes = new Map<number, Record<string, string>>();
  for (const el of els) if (el.type === 'node' && el.tags?.highway) specialNodes.set(el.id, el.tags);
  const markingRoads = roads
    .filter((w) => w.nodes?.length === w.geometry.length)
    .map((w) => ({ id: w.id, nodes: w.nodes!, points: w.geometry.map((p) => px(toTile(p))), tags: w.tags!, widthPx: ROAD_WIDTH[w.tags!.highway] * TILE_SIZE }));
  // Road as drawn, pixel-exact: diagonal-cut edge tiles are road only on their road side.
  const roadPixel = (x: number, y: number) => {
    const c = Math.floor(x / TILE_SIZE);
    const r = Math.floor(y / TILE_SIZE);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    const id = groundIds[r * cols + c];
    if (id >= T.ROAD_ASPHALT_DIAG && id < T.ROAD_COBBLE_DIAG + 4) {
      const mask = DIAG_MASKS[(id - T.ROAD_ASPHALT_DIAG) % 4];
      const lx = x - c * TILE_SIZE;
      const ly = y - r * TILE_SIZE;
      return mask === (N | E) ? lx > ly : mask === (S | W) ? ly > lx : mask === (E | S) ? lx + ly > TILE_SIZE : lx + ly < TILE_SIZE;
    }
    return isRoad(ground.get(c, r));
  };
  const markings = buildMarkings(markingRoads, specialNodes, METRES_PER_TILE / TILE_SIZE, roadPixel).filter((mk) =>
    mk.kind === 'arrow' ? inside(mk) : mk.points.some(inside),
  );
  const markingCounts: Record<string, number> = {};
  for (const mk of markings) markingCounts[mk.kind] = (markingCounts[mk.kind] ?? 0) + 1;
  console.log('Road markings:', Object.entries(markingCounts).map(([k, v]) => `${k} ${v}`).join(', '));

  // 8. Tram routes: each direction of each line as one path with its stops, for NPC trams.
  const tramRoutes = buildTramRoutes(els, (p) => px(toTile(p)), inside);
  console.log(`Tram routes: ${tramRoutes.map((r) => `${r.line} (${r.stops.length} stops)`).join(', ')}`);

  return { cols, rows, groundIds, decorIds, spawn, rotation, origin, minU, maxV, tileToLatLon, ground, trees, streets: named, tram, lamps, bridges, markings, tramRoutes };
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
    nextlayerid: 10,
    nextobjectid: m.streets.length + m.tram.tracks.length + m.tram.stops.length + m.lamps.length + m.bridges.length + m.markings.length + m.tramRoutes.length + 2,
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
      {
        // Tram tracks (one polyline per track centreline) and stops; the game draws the rails.
        id: 5,
        name: 'tram',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects: [
          ...m.tram.tracks.map((t, i) => {
            const [o] = t.points;
            return {
              id: m.streets.length + 2 + i,
              name: t.lines ? `Linje ${t.lines}` : t.service || 'track',
              type: 'track',
              x: o.x,
              y: o.y,
              width: 0,
              height: 0,
              rotation: 0,
              visible: true,
              polyline: t.points.map((p) => ({ x: Math.round((p.x - o.x) * 10) / 10, y: Math.round((p.y - o.y) * 10) / 10 })),
              properties: [
                { name: 'osmId', type: 'int', value: t.id },
                { name: 'lines', type: 'string', value: t.lines },
                { name: 'service', type: 'string', value: t.service },
                { name: 'bridge', type: 'bool', value: t.bridge },
              ],
            };
          }),
          ...m.tram.stops.map((st, i) => ({
            id: m.streets.length + m.tram.tracks.length + 2 + i,
            name: st.name,
            type: 'stop',
            x: st.x,
            y: st.y,
            width: 0,
            height: 0,
            point: true,
            rotation: 0,
            visible: true,
            properties: [{ name: 'osmId', type: 'int', value: st.id }],
          })),
        ],
      },
      {
        // Street lamps as points at the foot of the post; 'source' is osm or generated.
        id: 6,
        name: 'lights',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects: m.lamps.map((l, i) => ({
          id: m.streets.length + m.tram.tracks.length + m.tram.stops.length + 2 + i,
          name: '',
          type: 'street_lamp',
          x: l.x,
          y: l.y,
          width: 0,
          height: 0,
          point: true,
          rotation: 0,
          visible: true,
          properties: [{ name: 'source', type: 'string', value: l.source }],
        })),
      },
      {
        // Spans over water (bridges, tram decks) as rectangles: drivable on top, a boat passes underneath.
        id: 7,
        name: 'bridges',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: false,
        x: 0,
        y: 0,
        objects: m.bridges.map((b, i) => ({
          id: m.streets.length + m.tram.tracks.length + m.tram.stops.length + m.lamps.length + 2 + i,
          name: '',
          type: 'bridge',
          x: b.c * TILE_SIZE,
          y: b.r * TILE_SIZE,
          width: b.w * TILE_SIZE,
          height: TILE_SIZE,
          rotation: 0,
          visible: true,
        })),
      },
      {
        // Painted road markings; the game draws them. Lines/stop lines/give-way rows/zebras are polylines,
        // turn arrows are points (rotation = direction of travel, 0 = east).
        id: 8,
        name: 'markings',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects: m.markings.map((mk, i) =>
          markingObject(mk, m.streets.length + m.tram.tracks.length + m.tram.stops.length + m.lamps.length + m.bridges.length + 2 + i),
        ),
      },
      {
        // One polyline per direction of each tram line, with its stops as distances (px) along it.
        id: 9,
        name: 'tramRoutes',
        type: 'objectgroup',
        draworder: 'topdown',
        opacity: 1,
        visible: false,
        x: 0,
        y: 0,
        objects: m.tramRoutes.map((r, i) => ({
          id: m.streets.length + m.tram.tracks.length + m.tram.stops.length + m.lamps.length + m.bridges.length + m.markings.length + 2 + i,
          name: r.name,
          type: 'route',
          x: r.path[0].x,
          y: r.path[0].y,
          width: 0,
          height: 0,
          rotation: 0,
          visible: true,
          polyline: r.path.map((p) => ({ x: Math.round((p.x - r.path[0].x) * 10) / 10, y: Math.round((p.y - r.path[0].y) * 10) / 10 })),
          properties: [
            { name: 'line', type: 'string', value: r.line },
            { name: 'osmId', type: 'int', value: r.osmId },
            { name: 'stops', type: 'string', value: JSON.stringify(r.stops) },
          ],
        })),
      },
    ],
  };
}

function markingObject(mk: Marking, id: number) {
  const base = { id, name: '', type: mk.kind, width: 0, height: 0, rotation: 0, visible: true };
  const r = (v: number) => Math.round(v * 10) / 10;
  if (mk.kind === 'arrow')
    return {
      ...base,
      x: r(mk.x),
      y: r(mk.y),
      point: true,
      rotation: r((mk.angle * 180) / Math.PI),
      properties: [{ name: 'turn', type: 'string', value: mk.turn }],
    };
  const [o] = mk.points;
  const props =
    mk.kind === 'line'
      ? [
          { name: 'style', type: 'string', value: mk.style },
          { name: 'dash', type: 'float', value: r(mk.dash) },
          { name: 'gap', type: 'float', value: r(mk.gap) },
        ]
      : mk.kind === 'stop'
        ? [{ name: 'width', type: 'float', value: mk.width }]
        : mk.kind === 'zebra'
          ? [{ name: 'depth', type: 'float', value: r(mk.depth) }]
          : [
              { name: 'towardsX', type: 'float', value: r(mk.towards.x) },
              { name: 'towardsY', type: 'float', value: r(mk.towards.y) },
            ];
  return { ...base, x: r(o.x), y: r(o.y), polyline: mk.points.map((p) => ({ x: r(p.x - o.x), y: r(p.y - o.y) })), properties: props };
}

/** One pixel per tile, coloured by what's drawn there — a quick sanity check of the whole map. */
function preview(m: ReturnType<typeof buildMap>): Img {
  const roofColour: Record<BuildingStyle, number> = {
    residential: PALETTE.roof,
    church: PALETTE.copper,
    civic: PALETTE.slate,
    industrial: PALETTE.tin,
    commercial: PALETTE.flat,
  };
  const storefront: Partial<Record<Facade, number>> = {
    restaurant: PALETTE.awningRed,
    cafe: PALETTE.awningGreen,
    bar: PALETTE.woodDark,
    shop: PALETTE.awningBlue,
  };
  const colourOf = (id: number): number => {
    if (id >= T.ROOF && id < T.ROOF + BUILDING_STYLES.length) return roofColour[BUILDING_STYLES[id - T.ROOF]];
    if (id >= T.WALL_UPPER && id < T.WALL_UPPER + BUILDING_STYLES.length) return roofColour[BUILDING_STYLES[id - T.WALL_UPPER]];
    if (id >= T.WALL_LOWER && id < T.WALL_LOWER + FACADES.length) {
      const f = FACADES[id - T.WALL_LOWER];
      return storefront[f] ?? roofColour[f as BuildingStyle];
    }
    const s = surfaceOfTileId(id);
    if (id >= T.PLATFORM && id < T.PLATFORM + 16) return PALETTE.gold;
    return s === 'asphalt' ? PALETTE.asphalt : s === 'cobble' ? PALETTE.cobble : s === 'grass' ? PALETTE.grass : s === 'water' ? PALETTE.water : PALETTE.paving;
  };
  const img = new Img(m.cols, m.rows);
  for (let i = 0; i < m.cols * m.rows; i++) {
    const d = m.decorIds[i];
    const colour =
      d === T.STEEPLE ? PALETTE.gold : d === T.CAFE_TABLES ? PALETTE.awningRed : d >= 0 ? PALETTE.tree : colourOf(m.groundIds[i]);
    img.set(i % m.cols, Math.floor(i / m.cols), colour);
  }
  for (const l of m.lamps) img.set(Math.floor(l.x / TILE_SIZE), Math.floor(l.y / TILE_SIZE), PALETTE.lamp);
  for (const t of m.tram.tracks)
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1];
      const b = t.points[i];
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4);
      for (let k = 0; k <= steps; k++)
        img.set(Math.floor((a.x + ((b.x - a.x) * k) / steps) / TILE_SIZE), Math.floor((a.y + ((b.y - a.y) * k) / steps) / TILE_SIZE), PALETTE.ink);
    }
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
