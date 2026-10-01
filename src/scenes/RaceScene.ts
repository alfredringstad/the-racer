import Phaser from 'phaser';
import { Car } from '../game/Car';
import { Controls } from '../game/input';
import { TrackMap, type TiledMap } from '../game/TrackMap';
import { FONT, fontSafe } from '../game/font';
import { PALETTE } from '../game/palette';
import { TILE_SIZE } from '../game/tiles';
import { StreetIndex } from '../game/StreetIndex';
import { TramNetwork } from '../game/TramNetwork';
import { vehicleById } from '../game/vehicles';

const SKID_POOL = 600;
const SKID_SLIP = 22; // px/s of sideways speed before tyres leave marks
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

  constructor() {
    super('Race');
  }

  create() {
    const mapData = this.cache.json.get('norrkoping') as TiledMap;
    this.track = new TrackMap(this, mapData);
    this.streets = new StreetIndex(mapData);
    this.tram = new TramNetwork(mapData, this.track.metresPerTile, (x, y) => this.track.surfaceAt(x, y));
    this.track.railTiles = this.tram.railTiles;
    this.track.chunkOverlay = (key, x, y, w, h) => this.tram.drawChunk(this, key, x, y, w, h);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.track.destroy());
    this.streetName = undefined;
    this.skids = [];
    this.skidIndex = 0;
    this.look.set(0, 0);
    const spawn = this.track.spawn();
    this.car = new Car(this, this.track, vehicleById(this.registry.get('vehicle')), spawn.x, spawn.y, spawn.heading);
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

    this.createHud();

    this.input.keyboard!.on('keydown-C', () => {
      this.scene.pause();
      this.scene.launch('Credits');
    });
    this.input.keyboard!.on('keydown-R', () => this.scene.restart());
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

    const hint = this.text(0, 24, 'ARROWS/WASD DRIVE\nSPACE HANDBRAKE\nR RESET  C CREDITS');
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
    car.update(input, delta, time);
    this.track.updateChunks(this.cameras.main.worldView);

    // Camera leads the car a little in the direction of travel.
    const k = 1 - Math.exp(-delta / 250);
    this.look.x += (car.vx * LOOKAHEAD - this.look.x) * k;
    this.look.y += (car.vy * LOOKAHEAD - this.look.y) * k;
    this.cameras.main.setFollowOffset(-this.look.x, -this.look.y);
    if (car.impact > 45) this.cameras.main.shake(120, Math.min(0.02, car.impact / 6000));

    if (Math.abs(car.slip) > SKID_SLIP || (input.handbrake && car.speed > 30)) this.dropSkids();

    const kmh = Math.abs(car.forwardSpeed) * (this.track.metresPerTile / TILE_SIZE) * 3.6;
    this.hudSpeed.setText(String(Math.round(kmh)).padStart(3, '0') + ' KM/H');
    this.hudSurface.setText(car.surface.label);

    if (time >= this.nextStreetLookup) {
      this.nextStreetLookup = time + STREET_LOOKUP_MS;
      const stop = this.tram.stopNear(car.x, car.y, STOP_RADIUS);
      const street = this.streets.at(car.x, car.y);
      if (stop) this.setStreet(stop.name, 'stop');
      else this.setStreet(street);
    }
  }

  /** Dark pixels under the rear wheels, recycled from a fixed pool. */
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
