import Phaser from 'phaser';
import { FONT } from '../game/font';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {
    this.load.image('tiles', 'assets/tiles/tiles.png');
    this.load.image('car', 'assets/sprites/car.png');
    this.load.image(FONT.key, FONT.path);
    // Parsed by TrackMap itself (chunked rendering), so it's loaded as plain JSON.
    this.load.json('norrkoping', 'assets/maps/norrkoping.json');
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
