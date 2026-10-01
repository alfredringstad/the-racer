import Phaser from 'phaser';
import { lowerWallId, surfaceOfTileId, TILE_SIZE, upperWallId, type Surface } from './tiles';
import { PointIndex } from './PointIndex';
import { SURFACES } from './surfaces';

const SURFACE_LIST = Object.keys(SURFACES) as Surface[];
/** Chunk edge in tiles. Only chunks near the camera exist as Phaser tilemaps. */
const CHUNK = 32;
const CHUNK_PX = CHUNK * TILE_SIZE;

// The subset of the Tiled JSON format we read.
interface TiledProperty {
  name: string;
  type: string;
  value: unknown;
}
interface TiledObject {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  point?: boolean;
  polyline?: { x: number; y: number }[];
  polygon?: { x: number; y: number }[];
  properties?: TiledProperty[];
}
interface TiledLayer {
  name: string;
  type: 'tilelayer' | 'objectgroup';
  data?: number[];
  objects?: TiledObject[];
}
export interface TiledMap {
  width: number;
  height: number;
  properties?: TiledProperty[];
  tilesets: { firstgid: number; tiles?: { id: number; properties?: TiledProperty[] }[] }[];
  layers: TiledLayer[];
}

export interface Lamp {
  x: number; // foot of the post
  y: number;
  seed: number; // 0–1, staggers switch-on time
}

export interface Glow {
  x: number;
  y: number;
  kind: 'window' | 'shop';
  seed: number;
}

/** Collision radius of a lamp post, px. */
export const LAMP_RADIUS = 1.5;

interface Chunk {
  map: Phaser.Tilemaps.Tilemap;
  objects: Phaser.GameObjects.GameObject[];
  textures: string[];
}

export interface ChunkExtras {
  objects: Phaser.GameObjects.GameObject[];
  textures?: string[];
}

export const prop = <T>(props: TiledProperty[] | undefined, name: string) =>
  props?.find((p) => p.name === name)?.value as T | undefined;

/**
 * The Tiled map, rendered in chunks around the camera (a single Phaser tilemap of
 * ~650×650 tiles × 2 layers would be ~850k Tile objects), plus a flat per-tile
 * surface lookup. Surfaces come from the tileset's `surface` tile property
 * (editable in Tiled), falling back to the built-in tile table. A decor tile with a
 * solid surface (trees, steeples) overrides the ground below it.
 */
export class TrackMap {
  readonly width: number;
  readonly height: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly metresPerTile: number;
  private readonly ground: number[];
  private readonly decor: number[];
  private readonly firstgid: number;
  private readonly surfaces: Uint8Array;
  private readonly chunks = new Map<string, Chunk>();
  /** 1 where tram rails cross the tile (set by TramNetwork). */
  railTiles?: Uint8Array;
  /** Extra things built with each chunk (e.g. tram rails). `key` is unique per chunk, for texture names. */
  readonly chunkDecorators: Array<(key: string, x: number, y: number, w: number, h: number) => ChunkExtras | undefined> = [];
  readonly lamps: PointIndex<Lamp>;
  readonly glows: PointIndex<Glow>;
  /** Lamp sprites that currently exist (in loaded chunks). */
  readonly lampSprites = new Set<Phaser.GameObjects.Image>();

  constructor(
    private readonly scene: Phaser.Scene,
    readonly data: TiledMap,
  ) {
    this.width = data.width;
    this.height = data.height;
    this.widthPx = this.width * TILE_SIZE;
    this.heightPx = this.height * TILE_SIZE;
    this.metresPerTile = prop<number>(data.properties, 'metresPerTile') ?? 2.25;
    this.ground = this.layer('ground').data!;
    this.decor = this.layer('decor').data ?? [];

    const tileset = data.tilesets[0];
    this.firstgid = tileset.firstgid;
    const surfaceByGid = new Map<number, Surface>();
    for (const t of tileset.tiles ?? []) {
      const s = prop<Surface>(t.properties, 'surface');
      if (s) surfaceByGid.set(t.id + tileset.firstgid, s);
    }
    const surfaceOfGid = (gid: number) => (gid > 0 ? (surfaceByGid.get(gid) ?? surfaceOfTileId(gid - this.firstgid)) : undefined);

    this.surfaces = new Uint8Array(this.width * this.height);
    for (let i = 0; i < this.surfaces.length; i++) {
      let s = surfaceOfGid(this.ground[i]) ?? 'paving';
      const d = surfaceOfGid(this.decor[i]);
      if (d && SURFACES[d].solid) s = d;
      this.surfaces[i] = SURFACE_LIST.indexOf(s);
    }

    const lamps = (data.layers.find((l) => l.name === 'lights')?.objects ?? [])
      .filter((o) => o.type === 'street_lamp')
      .map((o) => ({ x: o.x, y: o.y, seed: hash01(o.x, o.y) }));
    this.lamps = new PointIndex(lamps);

    // Night glows: every storefront, and some upper-floor windows.
    const shopGids = new Set(['restaurant', 'cafe', 'bar', 'shop'].map((f) => lowerWallId(f as 'shop') + this.firstgid));
    const windowGids = new Set((['residential', 'civic', 'commercial', 'industrial'] as const).map((st) => upperWallId(st) + this.firstgid));
    const glows: Glow[] = [];
    for (let i = 0; i < this.ground.length; i++) {
      const c = i % this.width;
      const r = Math.floor(i / this.width);
      const seed = hash01(c, r);
      if (shopGids.has(this.ground[i])) glows.push({ x: c * TILE_SIZE + 8, y: r * TILE_SIZE + 11, kind: 'shop', seed });
      else if (windowGids.has(this.ground[i]) && seed < 0.4) glows.push({ x: c * TILE_SIZE + 8, y: r * TILE_SIZE + 9, kind: 'window', seed });
    }
    this.glows = new PointIndex(glows);
  }

  /** Lamp posts close enough to matter for collision at (x, y). */
  obstaclesNear(x: number, y: number, r = 16): Lamp[] {
    return this.lamps.query(x - r, y - r, x + r, y + r);
  }

  layer(name: string): TiledLayer {
    const l = this.data.layers.find((l) => l.name === name);
    if (!l) throw new Error(`Map has no layer "${name}"`);
    return l;
  }

  surfaceAt(x: number, y: number): Surface {
    const c = Math.floor(x / TILE_SIZE);
    const r = Math.floor(y / TILE_SIZE);
    if (c < 0 || r < 0 || c >= this.width || r >= this.height) return 'building';
    return SURFACE_LIST[this.surfaces[r * this.width + c]];
  }

  onRailsAt(x: number, y: number) {
    const c = Math.floor(x / TILE_SIZE);
    const r = Math.floor(y / TILE_SIZE);
    return !!this.railTiles && c >= 0 && r >= 0 && c < this.width && r < this.height && this.railTiles[r * this.width + c] === 1;
  }

  isSolidAt(x: number, y: number) {
    return SURFACES[this.surfaceAt(x, y)].solid;
  }

  spawn(): { x: number; y: number; heading: number } {
    const obj = this.layer('objects').objects?.find((o) => o.name === 'spawn');
    return { x: obj?.x ?? this.widthPx / 2, y: obj?.y ?? this.heightPx / 2, heading: prop<number>(obj?.properties, 'heading') ?? 0 };
  }

  /** Create chunks that overlap the camera (plus a margin) and drop ones that are far away. */
  updateChunks(view: Phaser.Geom.Rectangle) {
    const margin = CHUNK_PX / 2;
    const c0 = Math.max(0, Math.floor((view.x - margin) / CHUNK_PX));
    const c1 = Math.min(Math.ceil(this.width / CHUNK) - 1, Math.floor((view.right + margin) / CHUNK_PX));
    const r0 = Math.max(0, Math.floor((view.y - margin) / CHUNK_PX));
    const r1 = Math.min(Math.ceil(this.height / CHUNK) - 1, Math.floor((view.bottom + margin) / CHUNK_PX));
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) if (!this.chunks.has(`${cx},${cy}`)) this.buildChunk(cx, cy);
    for (const [key, chunk] of this.chunks) {
      const [cx, cy] = key.split(',').map(Number);
      if (cx < c0 - 1 || cx > c1 + 1 || cy < r0 - 1 || cy > r1 + 1) this.destroyChunk(key, chunk);
    }
  }

  /** Removes every chunk (call before the scene restarts so overlay textures are freed). */
  destroy() {
    for (const [key, chunk] of this.chunks) this.destroyChunk(key, chunk);
  }

  private destroyChunk(key: string, chunk: Chunk) {
    chunk.map.destroy();
    for (const o of chunk.objects) {
      this.lampSprites.delete(o as Phaser.GameObjects.Image);
      o.destroy();
    }
    for (const t of chunk.textures) this.scene.textures.remove(t);
    this.chunks.delete(key);
  }

  private buildChunk(cx: number, cy: number) {
    const w = Math.min(CHUNK, this.width - cx * CHUNK);
    const h = Math.min(CHUNK, this.height - cy * CHUNK);
    const map = this.scene.make.tilemap({ tileWidth: TILE_SIZE, tileHeight: TILE_SIZE, width: w, height: h });
    const tileset = map.addTilesetImage('tiles', 'tiles', TILE_SIZE, TILE_SIZE, 0, 0, this.firstgid)!;
    const ground = map.createBlankLayer('ground', tileset, cx * CHUNK_PX, cy * CHUNK_PX, w, h)!;
    const decor = map.createBlankLayer('decor', tileset, cx * CHUNK_PX, cy * CHUNK_PX, w, h)!.setDepth(20);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        const i = (cy * CHUNK + r) * this.width + cx * CHUNK + c;
        if (this.ground[i] > 0) ground.putTileAt(this.ground[i], c, r);
        if (this.decor[i] > 0) decor.putTileAt(this.decor[i], c, r);
      }
    const chunk: Chunk = { map, objects: [], textures: [] };
    const [x0, y0] = [cx * CHUNK_PX, cy * CHUNK_PX];
    for (const lamp of this.lamps.query(x0, y0, x0 + w * TILE_SIZE, y0 + h * TILE_SIZE)) {
      // Foot of the post (row 21 of the 24px sprite) sits on the map point. Snapped to whole pixels:
      // at a fractional position the post flips by 1px against the tiles as the camera scrolls.
      const sprite = this.scene.add.image(Math.round(lamp.x), Math.round(lamp.y), 'street-lamp').setOrigin(0.5, 21 / 24).setDepth(11);
      this.lampSprites.add(sprite);
      chunk.objects.push(sprite);
    }
    this.chunkDecorators.forEach((decorate, i) => {
      const extras = decorate(`chunk-${i}-${cx}-${cy}`, x0, y0, w * TILE_SIZE, h * TILE_SIZE);
      if (extras) {
        chunk.objects.push(...extras.objects);
        chunk.textures.push(...(extras.textures ?? []));
      }
    });
    this.chunks.set(`${cx},${cy}`, chunk);
  }
}

function hash01(x: number, y: number) {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
