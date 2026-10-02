// Samples Lantmäteriet's 1 m ground model ("Markhöjdmodell Nedladdning, grid 1+") onto the map's tile
// grid and writes public/assets/maps/norrkoping-height.json (committed, so the game works offline) plus a shaded preview.
//
//   npm run fetch-height
//
// The tile search is public, but the height files need a Geotorget account that has ordered the
// (free) product. Put the account's login in .env.local (git-ignored) or the environment:
//   LANTMATERIET_USER=...
//   LANTMATERIET_PASSWORD=...
//
// Height data © Lantmäteriet, CC BY 4.0. Heights are metres above sea level (RH 2000).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl, type GeoTIFFImage } from 'geotiff';
import proj4 from 'proj4';
import { Projection } from './lib/geo';
import { Img } from './lib/png';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_FILE = resolve(ROOT, 'public/assets/maps/norrkoping.json');
const OUT_FILE = resolve(ROOT, 'public/assets/maps/norrkoping-height.json');
const PREVIEW_FILE = resolve(ROOT, 'data/height-preview.png');
const STAC_SEARCH = 'https://api.lantmateriet.se/stac-hojd/v1/search';
const ATTRIBUTION = 'Height data © Lantmäteriet, CC BY 4.0';

// SWEREF 99 TM (EPSG:3006), the plane coordinates of Lantmäteriet's height grid.
proj4.defs('SWEREF99TM', '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const toSweref = proj4('WGS84', 'SWEREF99TM');

/** Minimal .env.local reader (doesn't override variables that are already set). */
function loadEnvLocal() {
  const file = resolve(ROOT, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

interface MapInfo {
  width: number;
  height: number;
  metresPerTile: number;
  proj: Projection;
  minU: number;
  maxV: number;
}

function readMap(): MapInfo {
  const map = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
  const prop = (name: string) => map.properties.find((p: { name: string }) => p.name === name)?.value as number;
  return {
    width: map.width,
    height: map.height,
    metresPerTile: prop('metresPerTile'),
    proj: new Projection({ lat: prop('originLat'), lon: prop('originLon') }, prop('gridRotationDeg')),
    minU: prop('frameMinU'),
    maxV: prop('frameMaxV'),
  };
}

/** SWEREF 99 TM coordinates (easting, northing) of a point in tile units. */
function tileToSweref(m: MapInfo, c: number, r: number): [number, number] {
  const { lat, lon } = m.proj.unproject([m.minU + c * m.metresPerTile, m.maxV - r * m.metresPerTile]);
  return toSweref.forward([lon, lat]) as [number, number];
}

interface StacItem {
  id: string;
  collection: string;
  properties: { created?: string; 'proj:bbox'?: [number, number, number, number] };
  assets: Record<string, { href: string; type?: string }>;
}

/** 1 m grid tiles covering the map, newest version per tile (public search, no login needed). */
async function findTiles(m: MapInfo): Promise<StacItem[]> {
  const corners = [
    [0, 0],
    [m.width, 0],
    [0, m.height],
    [m.width, m.height],
  ].map(([c, r]) => m.proj.unproject([m.minU + c * m.metresPerTile, m.maxV - r * m.metresPerTile]));
  const bbox = [
    Math.min(...corners.map((p) => p.lon)),
    Math.min(...corners.map((p) => p.lat)),
    Math.max(...corners.map((p) => p.lon)),
    Math.max(...corners.map((p) => p.lat)),
  ];
  const items: StacItem[] = [];
  let url: string | undefined = `${STAC_SEARCH}?bbox=${bbox.join(',')}&limit=100`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`STAC search failed: HTTP ${res.status}`);
    const page = (await res.json()) as { features: StacItem[]; links?: { rel: string; href: string }[] };
    items.push(...page.features);
    url = page.links?.find((l) => l.rel === 'next')?.href;
  }
  // The 1 m grid lives in the mhm-* collections, in 2.5 km tiles under /grid1m/.
  const grid = items.filter((it) => it.collection.startsWith('mhm-') && it.assets.data?.href.includes('/grid1m/'));
  const newest = new Map<string, StacItem>();
  for (const it of grid) {
    const key = String(it.properties['proj:bbox']);
    const prev = newest.get(key);
    if (!prev || (it.properties.created ?? '') > (prev.properties.created ?? '')) newest.set(key, it);
  }
  return [...newest.values()];
}

interface Window {
  data: Float32Array | Float64Array | Int16Array;
  x0: number; // easting of the window's left pixel edge
  y0: number; // northing of its top pixel edge
  width: number;
  height: number;
  res: number;
  nodata: number | null;
}

async function main() {
  loadEnvLocal();
  const m = readMap();
  console.log(`Map: ${m.width} × ${m.height} tiles at ${m.metresPerTile} m`);

  const tiles = await findTiles(m);
  console.log(`Height tiles covering the map: ${tiles.map((t) => t.id).join(', ')}`);

  const user = process.env.LANTMATERIET_USER;
  const password = process.env.LANTMATERIET_PASSWORD;
  if (!user || !password) {
    console.error(
      '\nNo Lantmäteriet login found. The tile search above is public, but the height files need a\n' +
        'Geotorget account that has ordered "Markhöjdmodell Nedladdning, grid 1+" (free).\n' +
        'Add LANTMATERIET_USER and LANTMATERIET_PASSWORD to .env.local (git-ignored) and run again.',
    );
    process.exit(2);
  }
  const headers = { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };

  // SWEREF bounds of everything we'll sample (+ a few metres for the averaging kernel).
  const pts: [number, number][] = [];
  for (const [c, r] of [
    [0, 0],
    [m.width, 0],
    [0, m.height],
    [m.width, m.height],
  ])
    pts.push(tileToSweref(m, c, r));
  const need = {
    minE: Math.min(...pts.map((p) => p[0])) - 5,
    maxE: Math.max(...pts.map((p) => p[0])) + 5,
    minN: Math.min(...pts.map((p) => p[1])) - 5,
    maxN: Math.max(...pts.map((p) => p[1])) + 5,
  };

  // Read just the part of each tile we need (Cloud-Optimized GeoTIFF: ranged requests).
  const windows: Window[] = [];
  for (const tile of tiles) {
    const tiff = await fromUrl(tile.assets.data.href, { headers }).catch((e: Error) => {
      if (/401|403/.test(e.message)) throw new Error(`Login rejected by Lantmäteriet for ${tile.id} (check the credentials and that the product is ordered)`);
      throw e;
    });
    const image: GeoTIFFImage = await tiff.getImage();
    const [bx0, by0, bx1, by1] = image.getBoundingBox();
    const res = image.getResolution()[0];
    const ex0 = Math.max(bx0, need.minE);
    const ex1 = Math.min(bx1, need.maxE);
    const ny0 = Math.max(by0, need.minN);
    const ny1 = Math.min(by1, need.maxN);
    if (ex0 >= ex1 || ny0 >= ny1) continue;
    const px0 = Math.floor((ex0 - bx0) / res);
    const px1 = Math.ceil((ex1 - bx0) / res);
    const py0 = Math.floor((by1 - ny1) / res);
    const py1 = Math.ceil((by1 - ny0) / res);
    const [data] = (await image.readRasters({ window: [px0, py0, px1, py1], samples: [0] })) as unknown as [Window['data']];
    windows.push({ data, x0: bx0 + px0 * res, y0: by1 - py0 * res, width: px1 - px0, height: py1 - py0, res, nodata: image.getGDALNoData() });
    console.log(`  ${tile.id}: read ${px1 - px0} × ${py1 - py0} px`);
  }
  if (!windows.length) throw new Error('No height data overlaps the map');

  const at = (e: number, n: number): number | undefined => {
    for (const w of windows) {
      const x = Math.floor((e - w.x0) / w.res);
      const y = Math.floor((w.y0 - n) / w.res);
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      const v = w.data[y * w.width + x];
      if (w.nodata !== null && v === w.nodata) return undefined;
      return v;
    }
    return undefined;
  };

  // Each map tile: the mean of the 1 m cells within its footprint (a 3×3 m kernel at the centre).
  const heights = new Float32Array(m.width * m.height);
  let missing = 0;
  for (let r = 0; r < m.height; r++)
    for (let c = 0; c < m.width; c++) {
      const [e, n] = tileToSweref(m, c + 0.5, r + 0.5);
      let sum = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = at(e + dx, n + dy);
          if (v !== undefined) {
            sum += v;
            k++;
          }
        }
      heights[r * m.width + c] = k ? sum / k : Number.NaN;
      if (!k) missing++;
    }
  // Fill any gaps from the nearest known neighbour along the row.
  for (let i = 0; i < heights.length; i++) if (Number.isNaN(heights[i])) heights[i] = heights[i - 1] ?? 0;

  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  console.log(`Heights: ${min.toFixed(1)}–${max.toFixed(1)} m${missing ? ` (${missing} tiles without data, filled)` : ''}`);

  // Decimetres in an Int16 array, base64 — compact enough to commit (~1 MB).
  const dm = new Int16Array(heights.length);
  heights.forEach((h, i) => (dm[i] = Math.round(h * 10)));
  writeFileSync(
    OUT_FILE,
    JSON.stringify({
      attribution: ATTRIBUTION,
      source: 'Lantmäteriet Markhöjdmodell Nedladdning, grid 1+ (RH 2000)',
      tiles: tiles.map((t) => t.id),
      width: m.width,
      height: m.height,
      metresPerTile: m.metresPerTile,
      unit: 'dm',
      minM: Math.round(min * 10) / 10,
      maxM: Math.round(max * 10) / 10,
      data: Buffer.from(dm.buffer).toString('base64'),
    }),
  );
  writePreview(heights, m, min, max);
  console.log(`Wrote ${OUT_FILE}\nWrote ${PREVIEW_FILE}`);
}

/** Hypsometric tint (green lowlands → tan heights) with a hillshade from the north-west. */
function writePreview(h: Float32Array, m: MapInfo, min: number, max: number) {
  const img = new Img(m.width, m.height);
  const at = (c: number, r: number) => h[Math.min(m.height - 1, Math.max(0, r)) * m.width + Math.min(m.width - 1, Math.max(0, c))];
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  for (let r = 0; r < m.height; r++)
    for (let c = 0; c < m.width; c++) {
      const dzdx = (at(c + 1, r) - at(c - 1, r)) / (2 * m.metresPerTile);
      const dzdy = (at(c, r + 1) - at(c, r - 1)) / (2 * m.metresPerTile);
      const shade = Math.max(0.35, Math.min(1.25, 1 - (dzdx - dzdy) * 2.5)); // light from the NW, exaggerated
      const t = (at(c, r) - min) / (max - min || 1);
      const rgb = [lerp(0x4f, 0xe8, t), lerp(0x8f, 0xd8, t), lerp(0x5a, 0xa8, t)].map((v) => Math.max(0, Math.min(255, Math.round(v * shade))));
      img.set(c, r, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
    }
  writeFileSync(PREVIEW_FILE, img.toPNG());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
