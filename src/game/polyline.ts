// Small polyline/raster helpers shared by the map generator (scripts/) and the game: offsetting
// lines sideways, walking them by distance, slicing them, and pixel-crisp (non-antialiased)
// drawing of lines and polygons through a `plot(x, y)` callback.

export type Pt = { x: number; y: number };
export type Plot = (x: number, y: number) => void;

export function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** Offsets a polyline sideways by `d` (positive = right of travel, with y pointing down), with mitred joins. */
export function offsetPolyline(pts: Pt[], d: number): Pt[] {
  if (d === 0 || pts.length < 2) return pts.map((p) => ({ ...p }));
  const normal = (a: Pt, b: Pt) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  };
  return pts.map((p, i) => {
    const n1 = normal(pts[Math.max(0, i - 1)], pts[Math.max(1, i)]);
    const n2 = normal(pts[Math.min(i, pts.length - 2)], pts[Math.min(i + 1, pts.length - 1)]);
    let mx = n1.x + n2.x;
    let my = n1.y + n2.y;
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const scale = Math.min(2, 1 / Math.max(0.5, mx * n1.x + my * n1.y)); // clamp very sharp corners
    return { x: p.x + mx * d * scale, y: p.y + my * d * scale };
  });
}

/** Position and unit direction `dist` along the polyline (clamped to its ends). */
export function pointAlong(pts: Pt[], dist: number): { x: number; y: number; dx: number; dy: number } {
  let rest = Math.max(0, dist);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    if (rest <= len || i === pts.length - 1) {
      const t = Math.min(1, rest / len);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
    }
    rest -= len;
  }
  const p = pts[0] ?? { x: 0, y: 0 };
  return { x: p.x, y: p.y, dx: 1, dy: 0 };
}

/** The part of the polyline between distances `from` and `to` along it. */
export function slicePolyline(pts: Pt[], from: number, to: number): Pt[] {
  const out: Pt[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const s0 = acc;
    const s1 = acc + len;
    acc = s1;
    if (s1 < from || s0 > to || !len) continue;
    const lerp = (s: number) => ({ x: a.x + ((b.x - a.x) * (s - s0)) / len, y: a.y + ((b.y - a.y) * (s - s0)) / len });
    if (!out.length) out.push(lerp(Math.max(from, s0)));
    out.push(lerp(Math.min(to, s1)));
  }
  return out;
}

/** Calls `fn` every `step` along a polyline with the unit direction, starting `phase` in. */
export function walkPolyline(pts: Pt[], step: number, fn: (x: number, y: number, dx: number, dy: number) => void, phase = 0) {
  let carry = phase;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    let d = carry;
    for (; d < len; d += step) fn(a.x + dx * d, a.y + dy * d, dx, dy);
    carry = d - len;
  }
}

/** Bresenham between rounded endpoints: gap-free 1px lines. */
export function drawLine(ax: number, ay: number, bx: number, by: number, plot: Plot) {
  let x = Math.round(ax);
  let y = Math.round(ay);
  const x1 = Math.round(bx);
  const y1 = Math.round(by);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

export function drawPolyline(pts: Pt[], plot: Plot) {
  for (let i = 1; i < pts.length; i++) drawLine(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, plot);
}

/** Dashed polyline: `dash` on, `gap` off, measured along the line (gap 0 = solid). */
export function drawDashed(pts: Pt[], dash: number, gap: number, plot: Plot) {
  if (gap <= 0) return drawPolyline(pts, plot);
  const total = polylineLength(pts);
  for (let s = 0; s < total; s += dash + gap) drawPolyline(slicePolyline(pts, s, Math.min(total, s + dash)), plot);
}

/** Even-odd scanline fill sampled at pixel centres: crisp, no antialiasing. */
export function fillPolygon(poly: Pt[], plot: Plot) {
  if (poly.length < 3) return;
  const ys = poly.map((p) => p.y);
  const y0 = Math.floor(Math.min(...ys));
  const y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > cy !== b.y > cy) xs.push(a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) plot(x, y);
  }
}

/** A straight band from `a` to `b`, `width` thick, as a fillable quad. */
export function thickSegment(a: Pt, b: Pt, width: number): Pt[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * (width / 2);
  const ny = ((b.x - a.x) / len) * (width / 2);
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}
