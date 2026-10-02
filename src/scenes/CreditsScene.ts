import Phaser from 'phaser';
import { FONT, fontSafe } from '../game/font';
import { PALETTE } from '../game/palette';

const LINES: Array<[string, number]> = [
  ['THE RACER', PALETTE.uiAccent],
  ['NORRKÖPING', PALETTE.uiAccent],
  ['', 0],
  ['MAP DATA', PALETTE.grassLight],
  ['(C) OPENSTREETMAP', PALETTE.uiText],
  ['CONTRIBUTORS', PALETTE.uiText],
  ['AVAILABLE UNDER THE', PALETTE.uiText],
  ['OPEN DATABASE LICENSE', PALETTE.uiText],
  ['(ODBL)', PALETTE.uiText],
  ['OPENSTREETMAP.ORG/COPYRIGHT', PALETTE.waterLight],
  ['', 0],
  ['HEIGHT DATA', PALETTE.grassLight],
  ['(C) LANTMÄTERIET, CC BY 4.0', PALETTE.uiText],
  ['', 0],
  ['ENGINE: PHASER 4', PALETTE.uiText],
  ['', 0],
  ['C / ESC TO CLOSE', PALETTE.roofLight],
];

export class CreditsScene extends Phaser.Scene {
  constructor() {
    super('Credits');
  }

  create() {
    const { width, height } = this.scale;
    this.add.image(0, 0, 'px').setOrigin(0).setDisplaySize(width, height).setTint(PALETTE.uiBg).setAlpha(0.92);
    const lineH = FONT.cellHeight + 2;
    let y = Math.round((height - LINES.length * lineH) / 2);
    for (const [line, color] of LINES) {
      if (line) {
        const t = this.add.bitmapText(0, y, FONT.key, fontSafe(line)).setTint(color);
        t.setX(Math.round((width - t.width) / 2));
      }
      y += lineH;
    }
    const close = () => {
      this.scene.stop();
      this.scene.resume('Race');
    };
    this.input.keyboard!.once('keydown-C', close);
    this.input.keyboard!.once('keydown-ESC', close);
  }
}
