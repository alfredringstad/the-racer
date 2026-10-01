import Phaser from 'phaser';
import { PALETTE, hex } from './palette';
import { prop, type TiledMap } from './TrackMap';
import { drawDashed, fillPolygon, thickSegment, type Plot, type Pt } from './polyline';

type Mark =
  | { kind: 'line'; points: Pt[]; dash: number; gap: number; style: string }
  | { kind: 'stop'; points: Pt[]; width: number }
  | { kind: 'giveway'; points: Pt[]; towards: Pt }
  | { kind: 'zebra'; points: Pt[]; depth: number }
  | { kind: 'arrow'; at: Pt; angle: number; turn: string };

/** Paint is slightly see-through so the road texture shows through like worn paint. */
const PAINT_ALPHA = 0.85;
const ZEBRA_STRIPE = 4; // px stripe and gap (≈ 0.55 m)
const TOOTH_SPACING = 7;

/**
 * Painted road markings from the map's `markings` object layer, drawn as crisp pixels into a
 * canvas per map chunk (like the tram rails), so they follow diagonal and curved roads.
 */
export class RoadMarkings {
  private readonly marks: { mark: Mark; bounds: Phaser.Geom.Rectangle }[] = [];

  constructor(map: TiledMap) {
    for (const o of map.layers.find((l) => l.name === 'markings')?.objects ?? []) {
      const pts = (o.polyline ?? []).map((p) => ({ x: o.x + p.x, y: o.y + p.y }));
      let mark: Mark | undefined;
      if (o.type === 'line' && pts.length > 1)
        mark = { kind: 'line', points: pts, dash: prop<number>(o.properties, 'dash') ?? 0, gap: prop<number>(o.properties, 'gap') ?? 0, style: prop<string>(o.properties, 'style') ?? 'lane' };
      else if (o.type === 'stop' && pts.length > 1) mark = { kind: 'stop', points: pts, width: prop<number>(o.properties, 'width') ?? 3 };
      else if (o.type === 'giveway' && pts.length > 1)
        mark = { kind: 'giveway', points: pts, towards: { x: prop<number>(o.properties, 'towardsX') ?? 0, y: prop<number>(o.properties, 'towardsY') ?? -1 } };
      else if (o.type === 'zebra' && pts.length > 1) mark = { kind: 'zebra', points: pts, depth: prop<number>(o.properties, 'depth') ?? 20 };
      else if (o.type === 'arrow')
        mark = { kind: 'arrow', at: { x: o.x, y: o.y }, angle: Phaser.Math.DegToRad((o as { rotation?: number }).rotation ?? 0), turn: prop<string>(o.properties, 'turn') ?? 'through' };
      if (!mark) continue;
      const all = mark.kind === 'arrow' ? [mark.at] : mark.points;
      const pad = mark.kind === 'arrow' ? 20 : mark.kind === 'zebra' ? mark.depth : 6;
      const xs = all.map((p) => p.x);
      const ys = all.map((p) => p.y);
      const bounds = new Phaser.Geom.Rectangle(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2);
      this.marks.push({ mark, bounds });
    }
  }

  get count() {
    return this.marks.length;
  }

  /** Draws the markings crossing a chunk into a canvas texture; undefined if there are none. */
  drawChunk(scene: Phaser.Scene, key: string, x0: number, y0: number, w: number, h: number): Phaser.GameObjects.Image | undefined {
    const area = new Phaser.Geom.Rectangle(x0, y0, w, h);
    const marks = this.marks.filter((m) => Phaser.Geom.Intersects.RectangleToRectangle(m.bounds, area)).map((m) => m.mark);
    if (!marks.length) return undefined;
    const tex = scene.textures.createCanvas(key, w, h)!;
    const ctx = tex.context;
    ctx.globalAlpha = PAINT_ALPHA;
    ctx.fillStyle = hex(PALETTE.paint);
    // Each pixel painted at most once, so overlapping shapes don't build up alpha.
    const painted = new Uint8Array(w * h);
    const plot: Plot = (x, y) => {
      const px = Math.round(x - x0);
      const py = Math.round(y - y0);
      if (px < 0 || py < 0 || px >= w || py >= h || painted[py * w + px]) return;
      painted[py * w + px] = 1;
      ctx.fillRect(px, py, 1, 1);
    };
    for (const m of marks) drawMark(m, plot);
    tex.refresh();
    return scene.add.image(x0, y0, key).setOrigin(0).setDepth(0.5);
  }
}

function drawMark(m: Mark, plot: Plot) {
  switch (m.kind) {
    case 'line':
      drawDashed(m.points, m.dash, m.gap, plot);
      break;
    case 'stop':
      fillPolygon(thickSegment(m.points[0], m.points[1], m.width), plot);
      break;
    case 'giveway': {
      // Row of triangles ("shark teeth") pointing at the traffic that has to give way.
      const [a, b] = m.points;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      for (let s = TOOTH_SPACING / 2; s < len - 2; s += TOOTH_SPACING) {
        const c = { x: a.x + ux * s, y: a.y + uy * s };
        fillPolygon(
          [
            { x: c.x - ux * 2.5, y: c.y - uy * 2.5 },
            { x: c.x + ux * 2.5, y: c.y + uy * 2.5 },
            { x: c.x + m.towards.x * 5, y: c.y + m.towards.y * 5 },
          ],
          plot,
        );
      }
      break;
    }
    case 'zebra': {
      // Stripes run along the road (perpendicular to a→b), repeated across its width.
      const [a, b] = m.points;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const nx = -uy * (m.depth / 2);
      const ny = ux * (m.depth / 2);
      for (let s = 1; s + ZEBRA_STRIPE <= len; s += ZEBRA_STRIPE * 2) {
        const p = { x: a.x + ux * s, y: a.y + uy * s };
        const q = { x: p.x + ux * ZEBRA_STRIPE, y: p.y + uy * ZEBRA_STRIPE };
        fillPolygon(
          [
            { x: p.x + nx, y: p.y + ny },
            { x: q.x + nx, y: q.y + ny },
            { x: q.x - nx, y: q.y - ny },
            { x: p.x - nx, y: p.y - ny },
          ],
          plot,
        );
      }
      break;
    }
    case 'arrow':
      drawArrow(m.at, m.angle, m.turn, plot);
      break;
  }
}

/** Branch directions in arrow space (x = direction of travel, y = to the driver's right). */
const BRANCH: Record<string, Pt> = {
  through: { x: 1, y: 0 },
  left: { x: 0.25, y: -1 },
  right: { x: 0.25, y: 1 },
  slight_left: { x: 1, y: -0.55 },
  slight_right: { x: 1, y: 0.55 },
  sharp_left: { x: -0.4, y: -1 },
  sharp_right: { x: -0.4, y: 1 },
};

/** Lane arrow: a stem with one branch + arrowhead per turn in `turn` (e.g. "through;right"). */
function drawArrow(at: Pt, angle: number, turn: string, plot: Plot) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const world = (x: number, y: number): Pt => ({ x: at.x + x * c - y * s, y: at.y + x * s + y * c });
  const band = (ax: number, ay: number, bx: number, by: number) => fillPolygon(thickSegment(world(ax, ay), world(bx, by), 2), plot);
  const STEM = 14;
  band(-STEM, 0, 0, 0);
  for (const token of turn.split(';')) {
    const dir = BRANCH[token];
    if (!dir) continue;
    const len = Math.hypot(dir.x, dir.y);
    const ux = dir.x / len;
    const uy = dir.y / len;
    const reach = dir.x === 1 && dir.y === 0 ? 4 : 7;
    const tx = ux * reach;
    const ty = uy * reach;
    band(0, 0, tx, ty);
    // Arrowhead: a triangle 7 px long, 9 px wide at its base.
    fillPolygon([world(tx - uy * 4.5, ty + ux * 4.5), world(tx + ux * 7, ty + uy * 7), world(tx + uy * 4.5, ty - ux * 4.5)], plot);
  }
}
