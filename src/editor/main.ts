import Phaser from 'phaser';
import { EditorScene } from './EditorScene';

// Map editor: a dev-only page (editor.html) that reuses the game's map renderer to record corrections.
new Phaser.Game({
  type: Phaser.WEBGL,
  parent: 'map',
  pixelArt: true,
  backgroundColor: '#2b2a3a',
  scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
  scene: [EditorScene],
  input: { mouse: { preventDefaultWheel: true } },
});

// Right-drag pans the map; don't open the browser's context menu.
document.getElementById('map')!.addEventListener('contextmenu', (e) => e.preventDefault());
