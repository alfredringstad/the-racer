import Phaser from 'phaser';
import { surfaceOfTileId, TILE_SIZE, type Surface } from './tiles';
import { SURFACES } from './surfaces';

const SURFACE_LIST = Object.keys(SURFACES) as Surface[];

/**
 * The Tiled map plus a flat per-tile surface lookup. Surfaces come from the tileset's
 * `surface` tile property (editable in Tiled), falling back to the built-in tile table.
 * A tile on the `decor` layer with a solid surface (trees) overrides the ground.
 */
export class TrackMap {
  readonly map: Phaser.Tilemaps.Tilemap;
  readonly widthPx: number;
  readonly heightPx: number;
  private readonly surfaces: Uint8Array;

  constructor(scene: Phaser.Scene, key: string) {
    this.map = scene.make.tilemap({ key });
    const tileset = this.map.addTilesetImage('tiles', 'tiles')!;
    // Plain (CPU) layers: camera culling means only ~14×11 tiles are drawn per frame.
    // (TilemapGPULayer rendered as a flat colour with this tileset in Phaser 4.2.1.)
    this.map.createLayer('ground', tileset, 0, 0);
    this.map.createLayer('decor', tileset, 0, 0)?.setDepth(20);
    this.widthPx = this.map.widthInPixels;
    this.heightPx = this.map.heightInPixels;

    const surfaceOfGid = (gid: number): Surface | undefined => {
      if (gid <= 0) return undefined;
      const props = tileset.getTileProperties(gid) as { surface?: Surface } | null | undefined;
      return props?.surface ?? surfaceOfTileId(gid - tileset.firstgid);
    };

    const { width, height } = this.map;
    this.surfaces = new Uint8Array(width * height);
    const ground = this.map.getLayer('ground')!.data;
    const decor = this.map.getLayer('decor')?.data;
    for (let r = 0; r < height; r++)
      for (let c = 0; c < width; c++) {
        let s = surfaceOfGid(ground[r][c].index) ?? 'paving';
        const d = decor && surfaceOfGid(decor[r][c].index);
        if (d && SURFACES[d].solid) s = d;
        this.surfaces[r * width + c] = SURFACE_LIST.indexOf(s);
      }
  }

  surfaceAt(x: number, y: number): Surface {
    const c = Math.floor(x / TILE_SIZE);
    const r = Math.floor(y / TILE_SIZE);
    if (c < 0 || r < 0 || c >= this.map.width || r >= this.map.height) return 'building';
    return SURFACE_LIST[this.surfaces[r * this.map.width + c]];
  }

  isSolidAt(x: number, y: number) {
    return SURFACES[this.surfaceAt(x, y)].solid;
  }

  spawn(): { x: number; y: number; heading: number } {
    const obj = this.map.findObject('objects', (o) => o.name === 'spawn');
    const heading = (obj?.properties as Array<{ name: string; value: number }> | undefined)?.find((p) => p.name === 'heading')?.value ?? 0;
    return { x: obj?.x ?? this.widthPx / 2, y: obj?.y ?? this.heightPx / 2, heading };
  }

  property<T = unknown>(name: string): T | undefined {
    const props = this.map.properties as Array<{ name: string; value: T }> | undefined;
    return Array.isArray(props) ? props.find((p) => p.name === name)?.value : undefined;
  }
}
