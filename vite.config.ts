import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: Number(process.env.PORT) || 5173 },
  // Phaser alone is ~1.6 MB minified; one chunk is fine for this game.
  build: { chunkSizeWarningLimit: 2000 },
});
