import Phaser from 'phaser';
import { FONT, fontSafe } from '../game/font';
import { PALETTE } from '../game/palette';
import { GAME_TAGLINE, GAME_TITLE } from '../game/title';

/**
 * Title screen, drawn over the race scene running in attract mode (camera gliding along a tram line,
 * trams and people going about their day). Enter, Space or a click/tap starts the race.
 */
export class TitleScene extends Phaser.Scene {
  private starting = false;

  constructor() {
    super('Title');
  }

  create() {
    this.starting = false;
    const { width, height } = this.scale;

    // Title: everything but the last word on a smaller line, the last word big.
    const words = GAME_TITLE.trim().split(/\s+/);
    const big = words.pop() ?? '';
    const small = words.join(' ');
    const title = this.add.container(0, 0);
    let y = 34;
    if (small) {
      title.add(this.outlined(small, 3, PALETTE.uiText, y));
      y += FONT.cellHeight * 3 + 8; // room for the big line's Å/Ä/Ö dots
    }
    title.add(this.outlined(big, 6, PALETTE.uiAccent, y));
    y += FONT.cellHeight * 6;
    if (GAME_TAGLINE) {
      title.add(this.outlined(GAME_TAGLINE, 1, PALETTE.uiText, y + 6));
      y += 14;
    }
    // A soft band behind the title so it reads over any part of the map.
    const band = this.add.image(0, 22, 'px').setOrigin(0).setDisplaySize(width, y - 8).setTint(PALETTE.uiBg).setAlpha(0.45);
    this.children.sendToBack(band);
    this.tweens.add({ targets: title, y: 2, duration: 1600, ease: 'Sine.InOut', yoyo: true, repeat: -1 });

    const prompt = this.outlined('PRESS ENTER', 2, PALETTE.uiText, height - 64);
    this.time.addEvent({ delay: 550, loop: true, callback: () => prompt.setVisible(!prompt.visible) });

    const credit = this.add
      .bitmapText(0, height - 10, FONT.key, fontSafe('(C) OPENSTREETMAP CONTRIBUTORS   HEIGHTS (C) LANTMÄTERIET'))
      .setTint(PALETTE.uiText)
      .setAlpha(0.8);
    credit.setX(Math.round((width - credit.width) / 2));
    this.add.image(0, height - 12, 'px').setOrigin(0).setDisplaySize(width, 12).setTint(PALETTE.uiBg).setAlpha(0.6);
    this.children.bringToTop(credit);

    this.cameras.main.fadeIn(600, 0x2b, 0x2a, 0x3a);
    this.input.keyboard!.on('keydown-ENTER', () => this.start());
    this.input.keyboard!.on('keydown-SPACE', () => this.start());
    this.input.on('pointerdown', () => this.start());
  }

  /** Pixel-font text scaled by a whole number, with a one-font-pixel dark outline, centred horizontally. */
  private outlined(text: string, scale: number, colour: number, y: number): Phaser.GameObjects.Container {
    const str = fontSafe(text);
    const c = this.add.container(0, 0);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1], [1, 2], [0, 2]])
      c.add(this.add.bitmapText(dx * scale, y + dy * scale, FONT.key, str).setScale(scale).setTint(PALETTE.ink));
    const main = this.add.bitmapText(0, y, FONT.key, str).setScale(scale).setTint(colour);
    c.add(main);
    c.setX(Math.round((this.scale.width - main.width) / 2));
    return c;
  }

  private start() {
    if (this.starting) return;
    this.starting = true;
    const race = this.scene.get('Race');
    this.cameras.main.fadeOut(350, 0x2b, 0x2a, 0x3a);
    race.cameras.main.fadeOut(350, 0x2b, 0x2a, 0x3a);
    race.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.stop();
      race.scene.restart({ attract: false, fadeIn: true });
    });
  }
}
