import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { RaceScene } from './scenes/RaceScene';
import { CreditsScene } from './scenes/CreditsScene';
import { TitleScene } from './scenes/TitleScene';
import { PALETTE, hex } from './game/palette';

// 2× a slightly-wider-than-Game-Boy 192×144, scaled up by whole multiples.
export const GAME_WIDTH = 384;
export const GAME_HEIGHT = 288;

const game = new Phaser.Game({
  type: Phaser.WEBGL,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  pixelArt: true,
  backgroundColor: hex(PALETTE.ink),
  scale: {
    mode: Phaser.Scale.NONE,
    zoom: Phaser.Scale.MAX_ZOOM, // largest integer multiple that fits
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, RaceScene, TitleScene, CreditsScene],
});

// Keep the integer zoom in sync with the window.
window.addEventListener('resize', () => game.scale.setMaxZoom());

// Handy for poking at state from the devtools console.
if (import.meta.env.DEV) (window as unknown as { game: Phaser.Game }).game = game;
