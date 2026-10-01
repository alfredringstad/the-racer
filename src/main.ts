import Phaser from 'phaser';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 192,
  height: 144,
  pixelArt: true,
  backgroundColor: '#e0f0d0',
  scale: { mode: Phaser.Scale.NONE, zoom: 4 },
  scene: { create() { this.add.text(8, 8, 'hello', { fontSize: '8px', color: '#203020' }); } },
});
