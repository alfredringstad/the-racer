import Phaser from 'phaser';
import type { Car } from './Car';
import type { TrackMap } from './TrackMap';

// Colours of the night. The light map is multiplied over the world: white = untouched,
// AMBIENT = full night. Lights are added on top of the ambient before multiplying.
const AMBIENT = 0x3a4374;
const LAMP_LIGHT = 0xffd9a0;
const LAMP_GLOW = 0xffc870;
const SHOP_LIGHT = 0xffcf8a;
const WINDOW_LIGHT = 0xffe0a8;
const HEADLIGHT = 0xfff4d6;
const TAIL_LIGHT = 0xff3a2e;
// Boat navigation lights: red to port (left), green to starboard (right), white all-round at the stern.
const PORT_LIGHT = 0xff3a2e;
const STARBOARD_LIGHT = 0x3aff7a;
const STERN_LIGHT = 0xfff4d6;
const FLOODLIGHT = 0xe8f4ff;
/** Boat floodlight: one long, narrow beam that swings into turns. */
const FLOOD_SCALE_X = 1.9;
const FLOOD_SCALE_Y = 0.8;
const FLOOD_INTENSITY = 0.75;
/** Radians of swing per rad/s of turning, and the most it swings either way. */
const FLOOD_LEAD = 0.35;
const FLOOD_MAX_SWING = 0.4;

// Brightness knobs. Scales are relative to the light PNGs in public/assets/lights/.
const LAMP_SCALE = 1.3; // round.png is 128px across → ~166px pool
const LAMP_INTENSITY = 1;
const HEADLIGHT_SCALE_X = 1.5; // cone.png is 112px long → ~168px beam
const HEADLIGHT_SCALE_Y = 1.35;
/** Each of the two beams points this far outward from straight ahead (degrees). */
const HEADLIGHT_TOE_OUT = 9;
/** Brightness per beam; the two overlap in the middle. */
const HEADLIGHT_INTENSITY = 0.7;
/** Faint light around the vehicle itself so it never disappears in the dark. */
const VEHICLE_AURA = 0.35;

/** Extra light-map border so camera movement within a frame never shows an unlit edge. */
const MARGIN = 48;
/** How far beyond the view lights are still stamped (their radius). */
const REACH = 96;
/** Seconds for a full dusk/dawn transition. */
const TRANSITION_S = 2.2;

/** What the lighting needs to know about an NPC tram. */
export interface TramLights {
  front: { x: number; y: number; angle: number };
  sections: { x: number; y: number }[];
  alpha: number;
}

/**
 * Day/night lighting. Two screen-sized DynamicTextures follow the camera:
 * - `lightmap`: ambient colour + additive light shapes, MULTIPLY-blended over the world
 * - `glowmap`: black + additive bright spots (lamp heads, bulbs), ADD-blended on top
 * Both are redrawn every frame from lights near the camera.
 */
export class NightLighting {
  /** 0 = day, 1 = night. */
  night = 0;
  private target = 0;
  /** Floodlight angle relative to the boat's heading, and last frame's heading to measure turning. */
  private floodSwing = 0;
  private lastHeading?: number;
  private readonly lightmap: Phaser.Textures.DynamicTexture;
  private readonly glowmap: Phaser.Textures.DynamicTexture;
  private readonly lightImage: Phaser.GameObjects.Image;
  private readonly glowImage: Phaser.GameObjects.Image;
  private readonly w: number;
  private readonly h: number;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly track: TrackMap,
    startAtNight: boolean,
  ) {
    this.w = scene.scale.width + MARGIN * 2;
    this.h = scene.scale.height + MARGIN * 2;
    for (const key of ['lightmap', 'glowmap']) if (scene.textures.exists(key)) scene.textures.remove(key);
    this.lightmap = scene.textures.addDynamicTexture('lightmap', this.w, this.h)!;
    this.glowmap = scene.textures.addDynamicTexture('glowmap', this.w, this.h)!;
    this.lightImage = scene.add.image(0, 0, 'lightmap').setOrigin(0).setDepth(90).setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.glowImage = scene.add.image(0, 0, 'glowmap').setOrigin(0).setDepth(91).setBlendMode(Phaser.BlendModes.ADD);
    this.night = this.target = startAtNight ? 1 : 0;
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.textures.remove('lightmap');
      scene.textures.remove('glowmap');
    });
  }

  get isNight() {
    return this.target === 1;
  }

  toggle() {
    this.target = this.target ? 0 : 1;
  }

  update(dtMs: number, car: Car, braking: boolean, trams: readonly TramLights[] = []) {
    const step = dtMs / 1000 / TRANSITION_S;
    this.night = this.target > this.night ? Math.min(this.target, this.night + step) : Math.max(this.target, this.night - step);
    const visible = this.night > 0.001;
    this.lightImage.setVisible(visible);
    this.glowImage.setVisible(visible);
    if (!visible) return;

    // Anchor both maps in world space at last frame's camera position (minus a margin): the
    // camera's scroll for this frame isn't final yet, and world-anchored maps can't drift.
    const view = this.scene.cameras.main.worldView;
    const ox = Math.round(view.x) - MARGIN;
    const oy = Math.round(view.y) - MARGIN;
    this.lightImage.setPosition(ox, oy);
    this.glowImage.setPosition(ox, oy);

    const n = this.night;
    const ambient = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.ValueToColor(0xffffff),
      Phaser.Display.Color.ValueToColor(AMBIENT),
      1,
      n,
    );
    const lm = this.lightmap;
    const gm = this.glowmap;
    lm.clear().fill(Phaser.Display.Color.GetColor(ambient.r, ambient.g, ambient.b));
    gm.clear().fill(0x000000);
    const ADD = Phaser.BlendModes.ADD;
    const stamp = (dt: Phaser.Textures.DynamicTexture, key: string, x: number, y: number, tint: number, alpha: number, extra: Phaser.Types.Textures.StampConfig = {}) =>
      dt.stamp(key, undefined, Math.round(x - ox), Math.round(y - oy), { tint, alpha, blendMode: ADD, ...extra });

    const x0 = ox - REACH;
    const y0 = oy - REACH;
    const x1 = ox + this.w + REACH;
    const y1 = oy + this.h + REACH;

    // Street lamps switch on one by one as it gets dark.
    for (const lamp of this.track.lamps.query(x0, y0, x1, y1)) {
      const on = n > 0.3 + lamp.seed * 0.4 ? 1 : 0;
      if (!on) continue;
      stamp(lm, 'light-round', lamp.x, lamp.y - 4, LAMP_LIGHT, LAMP_INTENSITY * n, { scale: LAMP_SCALE });
      stamp(gm, 'light-small', lamp.x, lamp.y - 20, LAMP_GLOW, 0.55 * n);
    }
    // Shop windows and some flats.
    for (const g of this.track.glows.query(x0, y0, x1, y1)) {
      if (g.kind === 'shop') {
        if (n < 0.25 + g.seed * 0.2) continue;
        stamp(lm, 'light-small', g.x, g.y + 6, SHOP_LIGHT, 0.9 * n, { scale: 1.6 });
        stamp(gm, 'light-small', g.x, g.y, SHOP_LIGHT, 0.25 * n);
      } else {
        if (n < 0.45 + g.seed * 0.5) continue;
        stamp(lm, 'light-small', g.x, g.y, WINDOW_LIGHT, 0.75 * n, { scale: 0.8 });
      }
    }

    // Trams: headlight beam ahead and lit windows along every section.
    for (const t of trams) {
      if (t.front.x < x0 || t.front.x > x1 || t.front.y < y0 || t.front.y > y1) {
        if (!t.sections.some((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)) continue;
      }
      stamp(lm, 'light-cone', t.front.x, t.front.y, HEADLIGHT, HEADLIGHT_INTENSITY * n * t.alpha, {
        originX: 0,
        originY: 0.5,
        rotation: t.front.angle,
        scaleX: HEADLIGHT_SCALE_X,
        scaleY: HEADLIGHT_SCALE_Y,
      });
      for (const p of t.sections) stamp(lm, 'light-small', p.x, p.y, WINDOW_LIGHT, 0.6 * n * t.alpha, { scale: 2.4 });
    }

    // Vehicle: headlight beam ahead, tail lights behind (brighter when braking). Boats get lanterns.
    const c = Math.cos(car.heading);
    const s = Math.sin(car.heading);
    const front = car.spec.halfLength - 1;
    const back = -car.spec.halfLength;
    if (car.spec.lights === 'boat') {
      this.boatLights(stamp, car, c, s, front, back, n, dtMs / 1000);
      lm.render();
      gm.render();
      return;
    }
    // Two beams, one from each headlight, angled slightly outwards.
    const lampOffset = car.spec.halfWidth - 1;
    for (const side of [-1, 1])
      stamp(lm, 'light-cone', car.x + c * front - s * side * lampOffset, car.y + s * front + c * side * lampOffset, HEADLIGHT, HEADLIGHT_INTENSITY * n, {
        originX: 0,
        originY: 0.5,
        rotation: car.heading + side * Phaser.Math.DegToRad(HEADLIGHT_TOE_OUT),
        scaleX: HEADLIGHT_SCALE_X,
        scaleY: HEADLIGHT_SCALE_Y,
      });
    stamp(lm, 'light-small', car.x, car.y, HEADLIGHT, VEHICLE_AURA * n, { scale: 1.5 });
    for (const side of [-1, 1]) {
      const sx = -s * side * (car.spec.halfWidth - 1);
      const sy = c * side * (car.spec.halfWidth - 1);
      stamp(gm, 'light-small', car.x + c * front + sx, car.y + s * front + sy, HEADLIGHT, 0.6 * n, { scale: 0.35 });
      stamp(gm, 'light-small', car.x + c * back + sx, car.y + s * back + sy, TAIL_LIGHT, (braking ? 0.9 : 0.45) * n, { scale: braking ? 0.6 : 0.4 });
      stamp(lm, 'light-small', car.x + c * (back - 4) + sx, car.y + s * (back - 4) + sy, TAIL_LIGHT, (braking ? 0.7 : 0.3) * n);
    }

    lm.render();
    gm.render();
  }

  /**
   * Navigation lanterns: red to port and green to starboard at the bow, a white all-round light
   * on the stern, each with a shimmer on the water. Plus a floodlight that leads into turns.
   */
  private boatLights(
    stamp: (dt: Phaser.Textures.DynamicTexture, key: string, x: number, y: number, tint: number, alpha: number, extra?: Phaser.Types.Textures.StampConfig) => void,
    car: Car,
    c: number,
    s: number,
    front: number,
    back: number,
    n: number,
    dt: number,
  ) {
    const lm = this.lightmap;
    const gm = this.glowmap;
    // Faded while passing under a bridge, like the boat itself.
    const k = car.underBridge ? 0.35 : 1;
    const bow = front - 2;
    const off = car.spec.halfWidth - 1;
    for (const [side, tint] of [[-1, PORT_LIGHT], [1, STARBOARD_LIGHT]] as const) {
      const x = car.x + c * bow - s * side * off;
      const y = car.y + s * bow + c * side * off;
      stamp(gm, 'light-small', x, y, tint, 0.8 * n * k, { scale: 0.4 });
      // Reflection spreading out on the water to that side.
      stamp(lm, 'light-small', x - s * side * 6, y + c * side * 6, tint, 0.45 * n * k, { scale: 1.1 });
    }
    // Floodlight from the windscreen, leading into turns.
    const turnRate = this.lastHeading === undefined || dt <= 0 ? 0 : Phaser.Math.Angle.Wrap(car.heading - this.lastHeading) / dt;
    this.lastHeading = car.heading;
    const swing = Phaser.Math.Clamp(turnRate * FLOOD_LEAD, -FLOOD_MAX_SWING, FLOOD_MAX_SWING);
    this.floodSwing += (swing - this.floodSwing) * (1 - Math.exp(-4 * dt));
    stamp(lm, 'light-cone', car.x + c, car.y + s, FLOODLIGHT, FLOOD_INTENSITY * n * k, {
      originX: 0,
      originY: 0.5,
      rotation: car.heading + this.floodSwing,
      scaleX: FLOOD_SCALE_X,
      scaleY: FLOOD_SCALE_Y,
    });
    stamp(gm, 'light-small', car.x + c, car.y + s, FLOODLIGHT, 0.5 * n * k, { scale: 0.3 });

    const sx = car.x + c * (back + 1);
    const sy = car.y + s * (back + 1);
    stamp(gm, 'light-small', sx, sy, STERN_LIGHT, 0.85 * n * k, { scale: 0.45 });
    stamp(lm, 'light-small', sx, sy, STERN_LIGHT, 0.55 * n * k, { scale: 2.2 });
  }
}
