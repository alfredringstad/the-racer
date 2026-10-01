import type { TiledMap, TrackMap } from './TrackMap';
import { TILE_SIZE } from './tiles';

/** Motala ström flows east through Norrköping into Bråviken, so the current is oriented east. */
const DOWNSTREAM_X = 1;
/** Tiles sampled around a point to find which way the channel runs. */
const FLOW_RADIUS = 10;
/** Tiles from the bank over which the current builds up to full strength. */
const SHORE_RAMP = 3;
/** Tiles of open water a boat needs on every side of its spawn point. */
const SPAWN_CLEARANCE = 4;

type Vec = { x: number; y: number };

/**
 * Where a boat can go: water tiles, plus bridge spans from the map's `bridges` layer (roads
 * and tram decks painted over water). Also estimates the river current from the shape of the
 * water around a point, since the map has the riverbanks but no centreline.
 */
export class Waterway {
  private readonly bridge: Uint8Array;

  constructor(
    map: TiledMap,
    private readonly track: TrackMap,
  ) {
    this.bridge = new Uint8Array(track.width * track.height);
    for (const o of map.layers.find((l) => l.name === 'bridges')?.objects ?? []) {
      const r = Math.round(o.y / TILE_SIZE);
      const c0 = Math.round(o.x / TILE_SIZE);
      const w = Math.round((o.width ?? 0) / TILE_SIZE);
      for (let c = c0; c < c0 + w; c++) if (this.inBounds(c, r)) this.bridge[r * track.width + c] = 1;
    }
  }

  private inBounds(c: number, r: number) {
    return c >= 0 && r >= 0 && c < this.track.width && r < this.track.height;
  }

  private waterTile(c: number, r: number) {
    if (!this.inBounds(c, r)) return false;
    return this.bridge[r * this.track.width + c] === 1 || this.track.surfaceAt(c * TILE_SIZE + 1, r * TILE_SIZE + 1) === 'water';
  }

  isWater(x: number, y: number) {
    return this.waterTile(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE));
  }

  /**
   * Current at (x, y) as a direction scaled 0..1: along the channel's main axis (the principal
   * axis of nearby water tiles), weaker in open water with no clear channel and near the banks.
   */
  flowAt(x: number, y: number): Vec {
    const c0 = Math.floor(x / TILE_SIZE);
    const r0 = Math.floor(y / TILE_SIZE);
    if (!this.waterTile(c0, r0)) return { x: 0, y: 0 };
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let dr = -FLOW_RADIUS; dr <= FLOW_RADIUS; dr++)
      for (let dc = -FLOW_RADIUS; dc <= FLOW_RADIUS; dc++) {
        if (!this.waterTile(c0 + dc, r0 + dr)) continue;
        n++;
        sx += dc;
        sy += dr;
        sxx += dc * dc;
        syy += dr * dr;
        sxy += dc * dr;
      }
    const mx = sx / n, my = sy / n;
    const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
    // Eigenvalues of the covariance: how elongated (channel-like) the water around us is.
    const tr = cxx + cyy;
    const gap = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy);
    const channel = tr > 0 ? (2 * gap) / tr : 0;
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    let dx = Math.cos(angle), dy = Math.sin(angle);
    if (dx * DOWNSTREAM_X < 0) [dx, dy] = [-dx, -dy];

    let shore = SHORE_RAMP;
    for (let d = 1; d < SHORE_RAMP && shore === SHORE_RAMP; d++)
      for (let k = -d; k <= d; k++)
        if (!this.waterTile(c0 + k, r0 - d) || !this.waterTile(c0 + k, r0 + d) || !this.waterTile(c0 - d, r0 + k) || !this.waterTile(c0 + d, r0 + k)) {
          shore = d;
          break;
        }
    const strength = (0.4 + 0.6 * channel) * (shore / SHORE_RAMP);
    return { x: dx * strength, y: dy * strength };
  }

  /** Nearest point to (x, y) with open water all around, facing downstream. */
  spawnNear(x: number, y: number): { x: number; y: number; heading: number } | undefined {
    const c0 = Math.floor(x / TILE_SIZE);
    const r0 = Math.floor(y / TILE_SIZE);
    const open = (c: number, r: number) => {
      for (let dr = -SPAWN_CLEARANCE; dr <= SPAWN_CLEARANCE; dr++)
        for (let dc = -SPAWN_CLEARANCE; dc <= SPAWN_CLEARANCE; dc++) if (!this.waterTile(c + dc, r + dr)) return false;
      return true;
    };
    const maxR = Math.max(this.track.width, this.track.height);
    for (let d = 0; d < maxR; d++)
      for (let k = -d; k <= d; k++)
        for (const [c, r] of [[c0 + k, r0 - d], [c0 + k, r0 + d], [c0 - d, r0 + k], [c0 + d, r0 + k]]) {
          if (!open(c, r)) continue;
          const px = (c + 0.5) * TILE_SIZE;
          const py = (r + 0.5) * TILE_SIZE;
          const f = this.flowAt(px, py);
          return { x: px, y: py, heading: Math.round((Math.atan2(f.y, f.x) * 180) / Math.PI) };
        }
    return undefined;
  }
}
