import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EDITS_FILE = resolve(ROOT, 'data/edits/log.jsonl');

/**
 * Dev-server API for the map editor (editor.html):
 *   GET  /__editor/edits    the edit log (JSONL)
 *   POST /__editor/edits    append edits (JSON array) to data/edits/log.jsonl
 *   POST /__editor/rebuild  run scripts/fetch-map.ts so the map includes all edits
 * Only exists in `npm run dev`; the built game has no editor.
 */
function mapEditorApi(): Plugin {
  const body = (req: import('node:http').IncomingMessage) =>
    new Promise<string>((ok, fail) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => ok(data));
      req.on('error', fail);
    });
  return {
    name: 'map-editor-api',
    configureServer(server) {
      server.middlewares.use('/__editor/edits', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') {
          res.setHeader('content-type', 'text/plain');
          return res.end(existsSync(EDITS_FILE) ? readFileSync(EDITS_FILE, 'utf8') : '');
        }
        if (req.method !== 'POST') return void ((res.statusCode = 405), res.end('{}'));
        try {
          const edits = JSON.parse(await body(req)) as { id?: string; op?: string; layer?: string }[];
          if (!Array.isArray(edits) || edits.some((e) => !e.id || !e.op || !e.layer)) throw new Error('expected an array of edits');
          mkdirSync(dirname(EDITS_FILE), { recursive: true });
          appendFileSync(EDITS_FILE, edits.map((e) => JSON.stringify(e) + '\n').join(''));
          res.end(JSON.stringify({ saved: edits.length }));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      server.middlewares.use('/__editor/rebuild', (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method !== 'POST') return void ((res.statusCode = 405), res.end('{}'));
        execFile('npx', ['tsx', 'scripts/fetch-map.ts'], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          res.statusCode = err ? 500 : 200;
          res.end(JSON.stringify({ ok: !err, output: `${stdout}${stderr}` }));
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  server: {
    port: Number(process.env.PORT) || 5173,
    // The editor rebuilds the map; don't let the regenerated map JSON trigger reloads of open pages.
    watch: { ignored: ['**/public/assets/maps/**', '**/data/**'] },
  },
  plugins: [mapEditorApi()],
  build: {
    // Phaser alone is ~1.6 MB minified; one chunk is fine for this game.
    chunkSizeWarningLimit: 2000,
    // Only the game is built; the editor (editor.html) needs the dev server's API and stays dev-only.
  },
});
