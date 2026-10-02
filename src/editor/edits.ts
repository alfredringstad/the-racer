// Map-editor corrections: the edit model and how edits are applied to the generated map.
//
// Edits are stored one per line in data/edits/log.jsonl and re-applied by scripts/fetch-map.ts after every
// rebuild. They are written to be analysed as well as replayed: each edit names the generated feature it
// corrects by its stable `key`, snapshots that feature's provenance (`rule`, `osm` ids), records a reason,
// and stores positions as lat/lon so it survives changes to the tile size or map frame.
//
// This module is shared by the generator (Node) and the editor (browser): no Node or Phaser imports.

import { Projection } from '../../scripts/lib/geo';

export type EditLayer = 'lights' | 'signs' | 'markings';
export type EditOp = 'remove' | 'move' | 'add' | 'set';

/** Why a correction was made. This is what makes the log analysable. */
export const EDIT_REASONS = {
  'not-real': "Doesn't exist in reality",
  'wrong-position': 'Wrong position',
  'wrong-type': 'Wrong type or value',
  missing: 'Missing in the generated map',
  'looks-bad': 'Exists, but looks bad in the game',
  other: 'Other (see note)',
} as const;
export type EditReason = keyof typeof EDIT_REASONS;

export interface LatLon {
  lat: number;
  lon: number;
}

type PropValue = string | number | boolean;

export interface Edit {
  id: string;
  /** ISO timestamp. */
  at: string;
  op: EditOp;
  layer: EditLayer;
  /** Key of the feature being corrected (remove/move/set). Added features get the key `edit:<id>`. */
  target?: string;
  /** move: an anchor point on the feature before and after (the whole feature is shifted by the difference). */
  from?: LatLon;
  to?: LatLon;
  /** add: Tiled object type (e.g. street_lamp, speed, line), position, and properties. */
  add?: { type: string; at: LatLon; props: Record<string, PropValue> };
  /** set: properties to change on the target. */
  set?: Record<string, PropValue>;
  reason: EditReason;
  note?: string;
  /** Provenance of the target when the edit was made: survives even if the feature is regenerated differently. */
  source?: { rule?: string; osm?: string[]; type?: string };
}

// The subset of the Tiled JSON this module touches.
interface TiledProp {
  name: string;
  type: string;
  value: unknown;
}
interface TiledObj {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  point?: boolean;
  polyline?: { x: number; y: number }[];
  properties?: TiledProp[];
  width?: number;
  height?: number;
  rotation?: number;
  visible?: boolean;
}
interface TiledMapLike {
  nextobjectid?: number;
  properties?: TiledProp[];
  layers: { name: string; objects?: TiledObj[] }[];
}

export const propOf = <T>(o: { properties?: TiledProp[] }, name: string) => o.properties?.find((p) => p.name === name)?.value as T | undefined;

function setProp(o: TiledObj, name: string, value: PropValue) {
  o.properties ??= [];
  const type = typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : typeof value === 'boolean' ? 'bool' : 'string';
  const existing = o.properties.find((p) => p.name === name);
  if (existing) Object.assign(existing, { type, value });
  else o.properties.push({ name, type, value });
}

/** Map pixels ↔ lat/lon, from the projection parameters fetch-map stores in the map's properties. */
export function mapGeo(map: TiledMapLike) {
  const p = (name: string) => map.properties?.find((x) => x.name === name)?.value as number;
  const proj = new Projection({ lat: p('originLat'), lon: p('originLon') }, p('gridRotationDeg'));
  const mpt = p('metresPerTile');
  const minU = p('frameMinU');
  const maxV = p('frameMaxV');
  const TILE = 16;
  return {
    toLatLon(x: number, y: number): LatLon {
      const ll = proj.unproject([minU + (x / TILE) * mpt, maxV - (y / TILE) * mpt]);
      return { lat: Math.round(ll.lat * 1e7) / 1e7, lon: Math.round(ll.lon * 1e7) / 1e7 };
    },
    toPx(ll: LatLon): { x: number; y: number } {
      const [u, v] = proj.project(ll);
      return { x: ((u - minU) / mpt) * TILE, y: ((maxV - v) / mpt) * TILE };
    },
  };
}

export interface ApplyReport {
  applied: Edit[];
  /** Edits whose target no longer exists: usually the OSM data or a generator rule changed. */
  orphaned: Edit[];
}

/** Applies edits in order to a generated Tiled map (mutating it). */
export function applyEdits(map: TiledMapLike, edits: Edit[]): ApplyReport {
  const geo = mapGeo(map);
  const report: ApplyReport = { applied: [], orphaned: [] };
  let nextId = map.nextobjectid ?? 1;
  for (const e of edits) {
    const layer = map.layers.find((l) => l.name === e.layer);
    if (!layer?.objects) {
      report.orphaned.push(e);
      continue;
    }
    if (e.op === 'add') {
      if (!e.add) continue;
      const at = geo.toPx(e.add.at);
      const obj: TiledObj = { id: nextId++, name: '', type: e.add.type, x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10, width: 0, height: 0, point: true, rotation: 0, visible: true, properties: [] };
      for (const [k, v] of Object.entries(e.add.props)) setProp(obj, k, v);
      setProp(obj, 'key', `edit:${e.id}`);
      setProp(obj, 'rule', 'edit.add');
      setProp(obj, 'osm', '');
      layer.objects.push(obj);
      report.applied.push(e);
      continue;
    }
    const i = layer.objects.findIndex((o) => propOf<string>(o, 'key') === e.target);
    if (i < 0) {
      report.orphaned.push(e);
      continue;
    }
    const obj = layer.objects[i];
    if (e.op === 'remove') layer.objects.splice(i, 1);
    else if (e.op === 'move' && e.from && e.to) {
      const a = geo.toPx(e.from);
      const b = geo.toPx(e.to);
      obj.x = Math.round((obj.x + b.x - a.x) * 10) / 10;
      obj.y = Math.round((obj.y + b.y - a.y) * 10) / 10;
    } else if (e.op === 'set' && e.set) for (const [k, v] of Object.entries(e.set)) setProp(obj, k, v);
    report.applied.push(e);
  }
  map.nextobjectid = nextId;
  return report;
}

export function parseEditLog(text: string): Edit[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => JSON.parse(l) as Edit);
}

export function newEditId(): string {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${t}-${Math.random().toString(36).slice(2, 7)}`;
}
