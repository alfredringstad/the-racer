# The Racer — CLAUDE.md

2D top-down arcade racing game set in central Norrköping, Sweden. Runs in the browser.

## Stack
- **Phaser 4** (v4.2.x) + **Vite** + **TypeScript** (strict). Scripts run with `tsx`.
- `pixelArt: true`, internal resolution **384×288**, `Scale.NONE` + `MAX_ZOOM` (integer zoom, recomputed on resize).
- Cosy Game Boy / Pokémon-style palette, defined once in `src/game/palette.ts`. Reuse it rather than adding
  one-off colours.
- Phaser ships LLM-oriented docs in `node_modules/phaser/skills/*/SKILL.md` (v4 migration, tilemaps, etc.).
  Check them before relying on v3 knowledge.

## Layout
```
scripts/fetch-map.ts        OSM (Overpass) → rotated tile grid → Tiled JSON + data/map-preview.png
scripts/gen-placeholders.ts Writes placeholder PNGs (tileset, car, font) if missing; --force overwrites
scripts/lib/                overpass client, projection/rotation + multipolygon rings, rasterizer, PNG encoder,
                            buildings.ts (OSM tags → building style / storefront; tweak classification here)
data/osm-cache.json         Cached Overpass responses (committed, so builds work offline)
public/assets/maps/         Generated norrkoping.json. Don't hand-edit; regenerate it.
public/assets/{tiles,sprites,fonts}/  Placeholder art, meant to be replaced in Aseprite
src/main.ts                 Phaser config; exposes window.game in dev
src/scenes/                 Boot (load + RetroFont), Race (gameplay + HUD), Credits (overlay)
src/game/                   Car physics, TrackMap (chunked rendering), StreetIndex, surfaces, tiles (index
                            contract), palette, font, input
```

## Map pipeline
- Data comes only from **OpenStreetMap via Overpass**. Never use Google Maps (its ToS forbid deriving data). ODbL attribution
  ("© OpenStreetMap contributors") must stay in the HUD corner, the credits scene, index.html and README.
- The frame is derived from the boundary streets: Kungsgatan (W), Södra Promenaden (S), Östra Promenaden (E) and
  Norra Promenaden (N; only the part west of where Östra ends). OSM names are capitalised "Promenaden". Motala ström
  runs diagonally through the northern half of the frame.
- The world is **rotated by the dominant street-grid angle (~15.1°)** so streets are axis-aligned. Projection
  parameters are stored as map properties (`originLat/Lon`, `gridRotationDeg`, `frameMinU/MaxV`, `metresPerTile`),
  so lat/lon → tile conversions can be reproduced later (see `scripts/lib/geo.ts`).
- 16 px tile = 2.25 m (`METRES_PER_TILE`). Road widths are set in metres (`ROAD_WIDTH_M`): 5 tiles for
  primary–tertiary roads, 4 for residential/living/pedestrian streets.
  Paint order: paving (default) → green → water → parking/squares → buildings → roads (roads win, which gives bridges).
- Road outer corners (mask N|E, E|S, S|W, W|N) use diagonal-cut tiles, which turns staircases into 45° curbs.
- Buildings are drawn in 3/4 view: the bottom row is the street-level facade, the row above is the upper facade, and the rest is roof.
  Style comes from `scripts/lib/buildings.ts`. POI nodes put storefront facades on the nearest south-facing facade
  (`STOREFRONT_SEARCH_M`) or outdoor tables. Churches get a steeple decor tile.
- Trams: `railway=tram` ways go into the `tram` object layer as polylines (props `lines`, `service`, `bridge`,
  `osmId`) and `railway=tram_stop` nodes as points. Platforms (`railway/highway/public_transport=platform`) are a
  ground kind with their own autotile row. Stop-sign decor goes on the nearest platform or sidewalk. Tracks with
  `bridge=yes` get a paving deck over water. `highway=service` streets with rails or bus lanes are drawn as residential streets.
- The `streets` object layer holds named roads (polylines with `widthPx`) and squares (polygons). `StreetIndex` uses
  it for the HUD street sign.
- Overpass mirrors sometimes return 504 or an HTML "too busy" page. The client falls back across mirrors.
- Output must stay deterministic: the same cache gives the same JSON.

## Rendering
`TrackMap` parses the Tiled JSON itself (loaded with `load.json`, not `tilemapTiledJSON`) and builds small
32×32-tile Phaser tilemaps around the camera on demand. A single ~650×650 tilemap would be ~850k `Tile` objects.

`TramNetwork` draws rails per chunk into a CanvasTexture with Bresenham lines (offset ±gauge/2 from the
centreline, mitred), via `TrackMap.chunkOverlay`. `TrackMap.destroy()` frees those textures and runs on scene
shutdown. Restarting without it fails on duplicate texture keys. `railTiles` reduces grip (`withRails`).

## Tile indices are a contract
`src/game/tiles.ts` is imported by both the generator scripts and the game. Road tile id = base + 4-bit mask
(N=1, E=2, S=4, W=8). Tileset tiles carry a `surface` property, and `TrackMap` reads it first (so Tiled edits work)
and falls back to `surfaceOfTileId`.

## Gameplay conventions
- Hand-rolled physics, no Arcade/Matter. In `Car.ts` velocity is split into forward and lateral parts, and the lateral
  part decays by `exp(-grip·dt)`. Speeds are px/s (≈ km/h).
- Collision: 8 probe points on the car's rotated 11×7 box are tested against `TrackMap.isSolidAt`. Movement is
  resolved per axis (slides along walls). Rotation is rejected if it would overlap.
- Sprite rotation snaps to 32 directions for a crisp retro look. Physics heading is continuous.

## Phaser 4 gotchas found so far
- `RetroFont.Parse` returns the whole cache entry `{data, texture, frame}`, despite its typings. Pass it straight to
  `cache.bitmapFont.add`.
- `TilemapGPULayer` (`createLayer(..., true)`) rendered as a flat colour covering everything in 4.2.1. Use normal
  `TilemapLayer`s (culling keeps them cheap).
- A hidden browser tab pauses the game loop. When testing headlessly, call `game.step(t, dt)` manually.

## Commands
- `npm run dev`, `npm run build`, `npm run typecheck`
- `npm run fetch-map` (`-- --refresh` re-queries Overpass), `npm run gen-placeholders` (`-- --force`)

## Working style
- Small steps, commit as you go.
- Don't add physics engines or heavy deps without a reason.
