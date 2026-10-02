import Phaser from 'phaser';
import { Car } from '../game/Car';
import { Controls } from '../game/input';
import { TrackMap, type TiledMap } from '../game/TrackMap';
import { FONT, fontSafe } from '../game/font';
import { PALETTE } from '../game/palette';
import { TILE_SIZE } from '../game/tiles';
import { StreetIndex } from '../game/StreetIndex';
import { TramNetwork } from '../game/TramNetwork';
import { RoadMarkings } from '../game/RoadMarkings';
import { NightLighting } from '../game/Lighting';
import { VEHICLES, vehicleById } from '../game/vehicles';
import { Waterway } from '../game/water';
import { TramTraffic } from '../game/Trams';

const SKID_POOL = 600;
const SKID_SLIP = 22; // px/s of sideways speed before tyres leave marks
/** Tram lines that run as NPC traffic. */
const NPC_TRAM_LINES = ['2', '3'];
const WAKE_SPEED = 15; // px/s through the water before a boat leaves a wake
const LOOKAHEAD = 0.35; // seconds of velocity the camera leads by
const STREET_LOOKUP_MS = 120;
const STOP_RADIUS = 72; // px from a tram stop node at which the sign shows the stop instead

type SignKind = 'street' | 'stop';
const SIGN_STYLE: Record<SignKind, { bg: number; text: number }> = {
  street: { bg: PALETTE.signBlue, text: PALETTE.uiText }, // Swedish street sign
  stop: { bg: PALETTE.gold, text: PALETTE.ink }, // tram stop
};

export class RaceScene extends Phaser.Scene {
  private track!: TrackMap;
  private car!: Car;
  private controls!: Controls;
  private hudSpeed!: Phaser.GameObjects.BitmapText;
  private hudSurface!: Phaser.GameObjects.BitmapText;
  private skids: Phaser.GameObjects.Image[] = [];
  private skidIndex = 0;
  private look = new Phaser.Math.Vector2();
  private streets!: StreetIndex;
  private sign!: Phaser.GameObjects.Container;
  private signText!: Phaser.GameObjects.BitmapText;
  private signBg!: Phaser.GameObjects.Image;
  private signBorder!: Phaser.GameObjects.Image;
  private tram!: TramNetwork;
  private streetName: string | undefined;
  private nextStreetLookup = 0;
  private lighting!: NightLighting;
  private wasDown = false;
  private trams!: TramTraffic;

  constructor() {
    super('Race');
  }

  create() {
    const mapData = this.cache.json.get('norrkoping') as TiledMap;
    this.track = new TrackMap(this, mapData);
    this.streets = new StreetIndex(mapData);
    this.tram = new TramNetwork(mapData, this.track.metresPerTile, (x, y) => this.track.surfaceAt(x, y));
    this.track.railTiles = this.tram.railTiles;
    const markings = new RoadMarkings(mapData);
    this.track.chunkDecorators.push((key, x, y, w, h) => {
      const paint = markings.drawChunk(this, key, x, y, w, h);
      return paint && { objects: [paint], textures: [key] };
    });
    this.track.chunkDecorators.push((key, x, y, w, h) => {
      const rails = this.tram.drawChunk(this, key, x, y, w, h);
      return rails && { objects: [rails], textures: [key] };
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.track.destroy());
    this.streetName = undefined;
    this.skids = [];
    this.skidIndex = 0;
    this.look.set(0, 0);
    const vehicle = vehicleById(this.registry.get('vehicle'));
    const water = new Waterway(mapData, this.track);
    let spawn = this.track.spawn();
    if (vehicle.onWater) spawn = water.spawnNear(spawn.x, spawn.y) ?? spawn;
    this.car = new Car(this, this.track, vehicle, spawn.x, spawn.y, spawn.heading);
    this.car.railCrossed = (x0, y0, x1, y1) => this.tram.railCrossed(x0, y0, x1, y1);
    this.car.water = water;
    this.trams = new TramTraffic(this, mapData, NPC_TRAM_LINES);
    this.car.obstacleAt = (x, y) => this.trams.solidAt(x, y);
    this.controls = new Controls(this);

    for (let i = 0; i < SKID_POOL; i++)
      this.skids.push(this.add.image(-10, -10, 'px').setTint(PALETTE.ink).setAlpha(0.3).setDepth(5).setVisible(false));

    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.track.widthPx, this.track.heightPx);
    cam.setRoundPixels(true);
    cam.startFollow(this.car, true, 0.12, 0.12);
    cam.centerOn(spawn.x, spawn.y);
    this.track.updateChunks(cam.worldView);
    cam.setBackgroundColor(PALETTE.ink);

    // Night mode persists across restarts; ?night in the URL starts at night.
    const night = (this.registry.get('night') as boolean | undefined) ?? new URLSearchParams(location.search).has('night');
    this.lighting = new NightLighting(this, this.track, night);

    this.createHud();

    this.input.keyboard!.on('keydown-C', () => {
      this.scene.pause();
      this.scene.launch('Credits');
    });
    this.input.keyboard!.on('keydown-R', () => this.scene.restart());
    this.input.keyboard!.on('keydown-N', () => {
      this.lighting.toggle();
      this.registry.set('night', this.lighting.isNight);
    });
    this.input.keyboard!.on('keydown-V', () => {
      const i = VEHICLES.indexOf(this.car.spec);
      this.registry.set('vehicle', VEHICLES[(i + 1) % VEHICLES.length].id);
      this.scene.restart();
    });
  }

  private text(x: number, y: number, s: string, color: number = PALETTE.uiText) {
    return this.add.bitmapText(x, y, FONT.key, fontSafe(s)).setTint(color).setScrollFactor(0).setDepth(100);
  }

  private createHud() {
    const { width, height } = this.scale;
    this.add.image(0, 0, 'px').setOrigin(0).setDisplaySize(56, 17).setTint(PALETTE.uiBg).setAlpha(0.75).setScrollFactor(0).setDepth(99);
    this.hudSpeed = this.text(3, 2, '000 KM/H', PALETTE.uiAccent);
    this.hudSurface = this.text(3, 9, '');

    const credit = this.text(2, height - 8, '(C) OPENSTREETMAP CONTRIBUTORS').setAlpha(0.7);
    this.add.image(0, height - 9, 'px').setOrigin(0).setDisplaySize(credit.width + 4, 9).setTint(PALETTE.uiBg).setAlpha(0.5).setScrollFactor(0).setDepth(99);

    const hint = this.text(0, 24, `${this.car.spec.name}\n\nARROWS/WASD DRIVE\nSPACE HANDBRAKE\nV VEHICLE  N NIGHT\nR RESET  C CREDITS`);
    hint.setX(Math.round((width - hint.width) / 2)).setCenterAlign();
    const box = this.add.image(hint.x - 4, hint.y - 3, 'px').setOrigin(0).setDisplaySize(hint.width + 8, hint.height + 5)
      .setTint(PALETTE.uiBg).setAlpha(0.8).setScrollFactor(0).setDepth(99);
    this.time.delayedCall(5000, () => this.tweens.add({ targets: [hint, box], alpha: 0, duration: 600 }));

    // Street sign, top right: white text on blue with a white rim, like a Swedish street sign.
    this.signBorder = this.add.image(0, 0, 'px').setOrigin(0).setTint(PALETTE.uiText);
    this.signBg = this.add.image(1, 1, 'px').setOrigin(0).setTint(PALETTE.signBlue);
    this.signText = this.add.bitmapText(4, 3, FONT.key, '').setTint(PALETTE.uiText);
    this.sign = this.add.container(0, -20, [this.signBorder, this.signBg, this.signText]).setScrollFactor(0).setDepth(100);
  }

  private setStreet(name: string | undefined, kind: SignKind = 'street') {
    const id = name && `${kind}:${name}`;
    if (id === this.streetName) return;
    this.streetName = id;
    const { width } = this.scale;
    this.tweens.killTweensOf(this.sign);
    const show = () => {
      if (!name) return;
      this.signText.setText(fontSafe(name)).setTint(SIGN_STYLE[kind].text);
      this.signBg.setTint(SIGN_STYLE[kind].bg);
      const w = this.signText.width + 8;
      const h = FONT.cellHeight + 5;
      this.signBorder.setDisplaySize(w, h);
      this.signBg.setDisplaySize(w - 2, h - 2);
      this.sign.setPosition(width - w - 3, -h - 2);
      this.tweens.add({ targets: this.sign, y: 3, duration: 180, ease: 'Back.Out' });
    };
    // Slide the old sign out, then the new one in.
    if (this.sign.y > -10) this.tweens.add({ targets: this.sign, y: -20, duration: 120, ease: 'Quad.In', onComplete: show });
    else show();
  }

  update(time: number, delta: number) {
    const car = this.car;
    const input = this.controls.read();
    this.trams.update(delta, car);
    car.update(input, delta, time);
    this.track.updateChunks(this.cameras.main.worldView);

    // Camera leads the car a little in the direction of travel.
    const k = 1 - Math.exp(-delta / 250);
    this.look.x += (car.vx * LOOKAHEAD - this.look.x) * k;
    this.look.y += (car.vy * LOOKAHEAD - this.look.y) * k;
    this.cameras.main.setFollowOffset(-this.look.x, -this.look.y);
    if (car.down > 0 && !this.wasDown) this.cameras.main.shake(200, 0.012);
    this.wasDown = car.down > 0;
    if (car.impact > 45) this.cameras.main.shake(120, Math.min(0.02, car.impact / 6000));
    else if (car.bump > 20) this.cameras.main.shake(70, Math.min(0.005, car.bump / 40000));

    // Lamp posts draw over the car when it's behind (north of) them, under it otherwise.
    for (const pole of this.track.poleSprites) pole.setDepth(pole.y > car.y ? 11 : 9.5);
    this.lighting.update(delta, car, input.brake && car.forwardSpeed > 5, this.trams.trams.map((t) => t.lights));

    if (car.spec.wake) {
      if (Math.abs(car.forwardSpeed) > WAKE_SPEED && !car.underBridge) this.dropWake();
    } else if (Math.abs(car.slip) > SKID_SLIP || (input.handbrake && car.speed > 30)) this.dropSkids();

    const kmh = Math.abs(car.forwardSpeed) * (this.track.metresPerTile / TILE_SIZE) * 3.6;
    this.hudSpeed.setText(String(Math.round(kmh)).padStart(3, '0') + ' KM/H');
    this.hudSurface.setText(
      car.down > 0 ? car.downReason : car.wobble > 0.35 ? 'WOBBLY!' : this.trams.bell ? 'DING DING!' : car.surface.label,
    );

    if (time >= this.nextStreetLookup) {
      this.nextStreetLookup = time + STREET_LOOKUP_MS;
      const stop = this.tram.stopNear(car.x, car.y, STOP_RADIUS);
      const street = this.streets.at(car.x, car.y);
      if (stop) this.setStreet(stop.name, 'stop');
      else this.setStreet(street);
    }
  }

  /** Dark pixels under the rear wheels, recycled from a fixed pool. */
  /** Light pixels fanning out behind a boat's stern, from the same recycled pool as skid marks. */
  private dropWake() {
    const { heading, x, y, spec } = this.car;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const back = -spec.halfLength;
    for (const side of [-1, 1]) {
      const spread = side * spec.halfWidth * (0.3 + Math.random() * 0.5);
      const skid = this.skids[this.skidIndex];
      this.skidIndex = (this.skidIndex + 1) % SKID_POOL;
      skid.setPosition(Math.round(x + back * c - spread * s), Math.round(y + back * s + spread * c)).setTint(PALETTE.waterLight).setAlpha(0.8).setVisible(true);
      this.tweens.killTweensOf(skid);
      this.tweens.add({ targets: skid, alpha: 0, duration: 1500 });
    }
  }

  private dropSkids() {
    const c = Math.cos(this.car.heading);
    const s = Math.sin(this.car.heading);
    for (const [wx, wy] of this.car.spec.skidWheels) {
      const skid = this.skids[this.skidIndex];
      this.skidIndex = (this.skidIndex + 1) % SKID_POOL;
      skid.setPosition(Math.round(this.car.x + wx * c - wy * s), Math.round(this.car.y + wx * s + wy * c)).setVisible(true);
    }
  }
}
