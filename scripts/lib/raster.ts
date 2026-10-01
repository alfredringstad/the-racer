// Grid rasterization primitives. Coordinates are in tile units (float), with
// tile (c, r) covering [c, c+1) x [r, r+1); a tile is "inside" a shape when its
// centre (c + 0.5, r + 0.5) is.

import type { Vec } from './geo';

export class Grid<T> {
  readonly cells: T[];
  constructor(
    readonly width: number,
    readonly height: number,
    fill: T,
  ) {
    this.cells = new Array(width * height).fill(fill);
  }
  inBounds(c: number, r: number) {
    return c >= 0 && r >= 0 && c < this.width && r < this.height;
  }
  get(c: number, r: number): T | undefined {
    return this.inBounds(c, r) ? this.cells[r * this.width + c] : undefined;
  }
  set(c: number, r: number, v: T) {
    if (this.inBounds(c, r)) this.cells[r * this.width + c] = v;
  }
}

/** Even-odd scanline fill of one or more rings (holes work when inner rings are included). */
export function fillRings<T>(grid: Grid<T>, rings: Vec[][], paint: (c: number, r: number) => void) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings)
    for (const [, y] of ring) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  const r0 = Math.max(0, Math.floor(minY - 0.5));
  const r1 = Math.min(grid.height - 1, Math.ceil(maxY));
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    const xs: number[] = [];
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(grid.width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) paint(c, r);
    }
  }
}

/**
 * Marks every tile whose centre is closer than `width / 2` to the polyline.
 * With an integer width this yields exactly `width` tiles across an axis-aligned line.
 */
export function strokeLine<T>(grid: Grid<T>, line: Vec[], width: number, paint: (c: number, r: number) => void) {
  const hw = width / 2;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw));
    const c1 = Math.min(grid.width - 1, Math.ceil(Math.max(ax, bx) + hw));
    const r0 = Math.max(0, Math.floor(Math.min(ay, by) - hw));
    const r1 = Math.min(grid.height - 1, Math.ceil(Math.max(ay, by) + hw));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const px = c + 0.5 - ax;
        const py = r + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        if (Math.hypot(px - t * dx, py - t * dy) < hw) paint(c, r);
      }
  }
}

/** Points spaced `step` apart along a polyline (tile units). */
export function samplePolyline(line: Vec[], step: number): Vec[] {
  const out: Vec[] = [];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const len = Math.hypot(bx - ax, by - ay);
    for (let d = carry; d < len; d += step) out.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
    carry = (carry - len) % step;
    if (carry < 0) carry += step;
  }
  return out;
}
