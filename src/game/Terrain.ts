import Phaser from 'phaser';
import { TILE_SIZE, type Surface } from './tiles';

/** public/assets/maps/norrkoping-height.json, written by scripts/fetch-height.ts. */
export interface HeightFile {
  width: number;
  height: number;
  metresPerTile: number;
  unit: 'dm';
  minM: number;
  maxM: number;
  data: string; // base64 Int16, decimetres, row-major
}

/** Box-blur radius (tiles) applied before slopes are taken; ~11 m smooths out the facets under buildings. */
const SMOOTH_RADIUS = 2;
/** Hillshade: light comes from the north-west (screen up-left), like the sprites' shadows. */
const LIGHT = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
/** How strongly slope turns into shade. Real city slopes are gentle, so this exaggerates. */
const SHADE_GAIN = 1.6;
const MAX_SHADOW_ALPHA = 0.22;
const MAX_HIGHLIGHT_ALPHA = 0.12;
/** Surfaces that get no hillshade (roofs would show the interpolated ground under the building). */
const UNSHADED = new Set<Surface>(['building', 'water', 'tree']);

/**
 * Ground heights from Lantmäteriet's 1 m model, resampled to the map grid. Provides slopes for vehicle
 * physics and draws a subtle hillshade over each map chunk.
 */
export class Terrain {
  readonly width: number;
  readonly height: number;
  private readonly metresPerTile: number;
  private readonly heights: Float32Array; // metres, smoothed
  /** Rise per metre towards +x (screen right) and +y (screen down), per tile. */
  private readonly gx: Float32Array;
  private readonly gy: Float32Array;

  /**
   * @param bridges  tiles that are bridge decks over water. The ground model measures the water below, so
   *                 their heights are rebuilt by smoothly interpolating between the banks.
   * @param water    water tiles. Smoothing and slopes ignore them, so a quay stays a wall rather than turning
   *                 the road beside it into a ramp down to the river.
   */
  constructor(file: HeightFile, bridges?: Uint8Array, water?: Uint8Array) {
    this.width = file.width;
    this.height = file.height;
    this.metresPerTile = file.metresPerTile;
    const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
    const dm = new Int16Array(bytes.buffer);
    const raw = Float32Array.from(dm, (v) => v / 10);
    if (bridges) spanBridges(raw, bridges, this.width, this.height);
    const land = new Float32Array(raw.length).fill(1);
    if (water) water.forEach((wv, i) => wv && (!bridges || !bridges[i]) && (land[i] = 0));
    this.heights = boxBlur(boxBlur(raw, land, this.width, this.height, SMOOTH_RADIUS), land, this.width, this.height, SMOOTH_RADIUS);

    // Central differences over ±2 tiles (≈ 9 m baseline), one-sided where the far sample would be water.
    this.gx = new Float32Array(raw.length);
    this.gy = new Float32Array(raw.length);
    const W = this.width;
    const H = this.height;
    const isLand = (c: number, r: number) => c >= 0 && r >= 0 && c < W && r < H && land[r * W + c] > 0;
    const slope = (c: number, r: number, dc: number, dr: number) => {
      const a = isLand(c + 2 * dc, r + 2 * dr) ? 2 : isLand(c + dc, r + dr) ? 1 : 0;
      const b = isLand(c - 2 * dc, r - 2 * dr) ? 2 : isLand(c - dc, r - dr) ? 1 : 0;
      if (a + b === 0) return 0;
      return (this.heights[(r + a * dr) * W + c + a * dc] - this.heights[(r - b * dr) * W + c - b * dc]) / ((a + b) * this.metresPerTile);
    };
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        if (!land[r * W + c]) continue; // flat water
        this.gx[r * W + c] = slope(c, r, 1, 0);
        this.gy[r * W + c] = slope(c, r, 0, 1);
      }
  }

  /** Bilinear sample of a per-tile field at a map pixel position. */
  private sample(field: Float32Array, x: number, y: number): number {
    const fx = Phaser.Math.Clamp(x / TILE_SIZE - 0.5, 0, this.width - 1);
    const fy = Phaser.Math.Clamp(y / TILE_SIZE - 0.5, 0, this.height - 1);
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const c1 = Math.min(c0 + 1, this.width - 1);
    const r1 = Math.min(r0 + 1, this.height - 1);
    const tx = fx - c0;
    const ty = fy - r0;
    const top = field[r0 * this.width + c0] * (1 - tx) + field[r0 * this.width + c1] * tx;
    const bottom = field[r1 * this.width + c0] * (1 - tx) + field[r1 * this.width + c1] * tx;
    return top * (1 - ty) + bottom * ty;
  }

  /** Metres above sea level at a map pixel. */
  heightAt(x: number, y: number): number {
    return this.sample(this.heights, x, y);
  }

  /** Slope at a map pixel: rise per metre travelled towards +x / +y. */
  gradientAt(x: number, y: number): { x: number; y: number } {
    return { x: this.sample(this.gx, x, y), y: this.sample(this.gy, x, y) };
  }

  /** Hillshade for a chunk: a canvas with dark (shadowed) and light (lit) pixels, or nothing on flat ground. */
  drawChunk(scene: Phaser.Scene, key: string, x0: number, y0: number, w: number, h: number, surfaceAt: (x: number, y: number) => Surface) {
    const tex = scene.textures.createCanvas(key, w, h)!;
    const ctx = tex.context;
    const img = ctx.createImageData(w, h);
    let any = false;
    // Surface per tile, so the per-pixel loop only needs a lookup.
    const tilesW = Math.ceil(w / TILE_SIZE);
    const shaded = new Uint8Array(tilesW * Math.ceil(h / TILE_SIZE));
    for (let ty = 0; ty < Math.ceil(h / TILE_SIZE); ty++)
      for (let tx = 0; tx < tilesW; tx++)
        shaded[ty * tilesW + tx] = UNSHADED.has(surfaceAt(x0 + tx * TILE_SIZE + 8, y0 + ty * TILE_SIZE + 8)) ? 0 : 1;
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        if (!shaded[Math.floor(py / TILE_SIZE) * tilesW + Math.floor(px / TILE_SIZE)]) continue;
        const g = this.gradientAt(x0 + px + 0.5, y0 + py + 0.5);
        // Ground rising away from the light faces it: lit. Rising towards the light: in shadow.
        const s = -(g.x * LIGHT.x + g.y * LIGHT.y) * SHADE_GAIN;
        const alpha = s > 0 ? Math.min(MAX_HIGHLIGHT_ALPHA, s * 0.6) : Math.min(MAX_SHADOW_ALPHA, -s);
        if (alpha < 0.01) continue;
        const i = (py * w + px) * 4;
        const v = s > 0 ? 255 : 0;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = s > 0 ? 235 : 40; // warm highlights, slightly blue shadows
        img.data[i + 3] = Math.round(alpha * 255);
        any = true;
      }
    if (!any) {
      scene.textures.remove(key);
      return undefined;
    }
    ctx.putImageData(img, 0, 0);
    tex.refresh();
    return scene.add.image(x0, y0, key).setOrigin(0).setDepth(0.75);
  }
}

/**
 * Replaces heights under bridge tiles with a smooth surface between the surrounding (non-bridge) ground,
 * by repeated neighbour averaging (a discrete Laplace solve with the banks as fixed edges).
 */
function spanBridges(h: Float32Array, bridge: Uint8Array, w: number, ht: number) {
  // Grow the mask by one tile so the bridge ramps start on solid ground, not mid-water.
  const mask = new Uint8Array(bridge.length);
  for (let r = 0; r < ht; r++)
    for (let c = 0; c < w; c++) {
      if (!bridge[r * w + c]) continue;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < ht && cc < w) mask[rr * w + cc] = 1;
        }
    }
  const cells: number[] = [];
  mask.forEach((m, i) => m && cells.push(i));
  if (!cells.length) return;
  // Start from the mean of the bank cells next to the masked area, then relax.
  let bankSum = 0;
  let bankN = 0;
  for (const i of cells)
    for (const j of [i - 1, i + 1, i - w, i + w])
      if (j >= 0 && j < h.length && !mask[j]) {
        bankSum += h[j];
        bankN++;
      }
  const start = bankN ? bankSum / bankN : 0;
  for (const i of cells) h[i] = start;
  for (let iter = 0; iter < 1500; iter++)
    for (const i of cells) {
      const c = i % w;
      let sum = 0;
      let n = 0;
      if (c > 0) (sum += h[i - 1]), n++;
      if (c < w - 1) (sum += h[i + 1]), n++;
      if (i >= w) (sum += h[i - w]), n++;
      if (i < h.length - w) (sum += h[i + w]), n++;
      h[i] = sum / n;
    }
}

/** Separable box blur weighted by `weight` (0 = ignore that cell; cells with no weight keep their value). */
function boxBlur(src: Float32Array, weight: Float32Array, w: number, h: number, r: number): Float32Array {
  const pass = (input: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!weight[i]) {
          out[i] = input[i];
          continue;
        }
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x;
          const yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          sum += input[j] * weight[j];
          n += weight[j];
        }
        out[i] = n ? sum / n : input[i];
      }
    return out;
  };
  return pass(pass(src, true), false);
}
