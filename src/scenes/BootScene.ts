import Phaser from 'phaser';
import { FONT } from '../game/font';
import { SIGN_H, SIGN_W } from '../game/signs';
import { VEHICLES } from '../game/vehicles';
import { SHEETS } from '../game/people-sheet';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    this.load.image('tiles', 'assets/tiles/tiles.png');
    for (const v of VEHICLES) this.load.image(v.sprite, `assets/sprites/${v.sprite}.png`);
    this.load.image(FONT.key, FONT.path);
    this.load.image('street-lamp', 'assets/sprites/street-lamp.png');
    this.load.spritesheet('signs', 'assets/sprites/signs.png', { frameWidth: SIGN_W, frameHeight: SIGN_H });
    for (const k of ['tram-cab', 'tram-mid']) this.load.image(k, `assets/sprites/${k}.png`);
    for (const s of SHEETS) this.load.spritesheet(s.key, `assets/sprites/${s.key}.png`, { frameWidth: s.w, frameHeight: s.h });
    for (const l of ['round', 'small', 'cone']) this.load.image(`light-${l}`, `assets/lights/${l}.png`);
    // Parsed by TrackMap itself (chunked rendering), so it's loaded as plain JSON.
    this.load.json('norrkoping', 'assets/maps/norrkoping.json');
    this.load.json('norrkoping-height', 'assets/maps/norrkoping-height.json');
  }

  create() {
    const config = {
      image: FONT.key,
      width: FONT.cellWidth,
      height: FONT.cellHeight,
      chars: FONT.chars,
      charsPerRow: FONT.charsPerRow,
      spacing: { x: 0, y: 0 },
      offset: { x: 0, y: 0 },
      lineSpacing: 1,
    } as unknown as Phaser.Types.GameObjects.BitmapText.RetroFontConfig;
    // Despite its typings, Parse returns the whole cache entry ({ data, texture, frame }), not just the data.
    this.cache.bitmapFont.add(FONT.key, Phaser.GameObjects.RetroFont.Parse(this, config));

    // 1×1 white pixel for skid marks and UI boxes.
    const px = this.textures.createCanvas('px', 1, 1)!;
    px.context.fillStyle = '#fff';
    px.context.fillRect(0, 0, 1, 1);
    px.refresh();

    this.scene.start('Race');
  }
}
