import Phaser from 'phaser';
import { surfaceOfTileId, TILE_SIZE, type Surface } from './tiles';
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
  private readonly chunks = new Map<string, { map: Phaser.Tilemaps.Tilemap; overlay?: Phaser.GameObjects.Image }>();
  /** 1 where tram rails cross the tile (set by TramNetwork). */
  railTiles?: Uint8Array;
  /** Optional extra layer drawn per chunk (e.g. tram rails): returns an image using texture `key`, or nothing. */
  chunkOverlay?: (key: string, x: number, y: number, w: number, h: number) => Phaser.GameObjects.Image | undefined;

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

  private destroyChunk(key: string, chunk: { map: Phaser.Tilemaps.Tilemap; overlay?: Phaser.GameObjects.Image }) {
    chunk.map.destroy();
    if (chunk.overlay) {
      const tex = chunk.overlay.texture.key;
      chunk.overlay.destroy();
      this.scene.textures.remove(tex);
    }
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
    const overlay = this.chunkOverlay?.(`chunk-overlay-${cx}-${cy}`, cx * CHUNK_PX, cy * CHUNK_PX, w * TILE_SIZE, h * TILE_SIZE);
    this.chunks.set(`${cx},${cy}`, { map, overlay });
  }
}
