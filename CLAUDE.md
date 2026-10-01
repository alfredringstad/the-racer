# The Racer — CLAUDE.md

2D top-down arcade racing game set in central Norrköping, Sweden. Runs in the browser.

## Stack
- **Phaser 4** (v4.2.x) + **Vite** + **TypeScript** (strict).
- `pixelArt: true`, internal resolution **192×144**, scaled by integer zoom (computed from the window size).
- Cosy Game Boy / Pokémon-style palette — defined once in `src/game/palette.ts`. Reuse it; don't invent new colours ad hoc.

## Layout
```
scripts/fetch-map.ts     Node script: Overpass → raster tile grid → Tiled JSON
scripts/lib/             Pure helpers for the script (projection, rasterizing, autotiling)
data/osm-cache.json      Cached Overpass response (committed; makes the game work offline)
public/assets/maps/      Generated Tiled map (norrkoping.json) — do not hand-edit, regenerate
public/assets/tiles/     Tileset PNG(s) — placeholder, meant to be replaced in Aseprite
src/main.ts              Phaser game config + boot
src/scenes/              Boot (placeholder texture generation), Race, Credits
src/game/                Gameplay code: Car physics, tile definitions, palette, input
```

## Map pipeline
- Data: **OpenStreetMap via Overpass API** only. Never Google Maps (ToS forbids deriving data). ODbL attribution
  ("© OpenStreetMap contributors") must stay in the in-game credits and README.
- Area: the central grid bounded by Kungsgatan (W), Södra promenaden (S), Östra promenaden (E), Norra promenaden (N),
  plus a slice of Motala ström north of Norra promenaden. The bbox is derived from those street geometries in the
  cache; constants live at the top of `scripts/fetch-map.ts`.
- `npm run fetch-map` uses `data/osm-cache.json` if present; `npm run fetch-map -- --refresh` re-queries Overpass.
- Tiles are 16×16 px ≈ 4.5 m. Roads are rasterized wider than reality so they're drivable, then autotiled using a
  4-bit neighbour mask (N=1, E=2, S=4, W=8) → straights, corners, T-junctions, crossings, dead-ends.
- Output is Tiled-compatible JSON (orthogonal, CSV-less plain `data` arrays) with layers `ground` and `collision`
  (object-free; collision is derived from tile properties). Tile properties: `surface` (asphalt/cobble/grass/water/
  building/sidewalk) — the game reads grip & solidity from `src/game/tiles.ts` keyed by tile index.

## Tile indices are a contract
`src/game/tiles.ts` and `scripts/lib/tiles.ts` must agree on tile index ↔ meaning. The placeholder tileset is
generated at runtime in `BootScene` **and** written to `public/assets/tiles/tiles.png` by the fetch script so that
Tiled can open the map. If you replace the tileset, keep the index layout (or update both tile tables).

## Gameplay conventions
- Car physics is hand-rolled (no Arcade/Matter bodies): velocity is split into forward and lateral components;
  lateral is damped by grip (low grip → more drift). See `src/game/Car.ts`.
- Collision: sample tile solidity at a few points around the car; on hit, push back and reflect/dampen velocity.
- Grip/drag per surface: asphalt > cobblestone > grass. Sidewalks are drivable but slower.

## Commands
- `npm run dev` — Vite dev server
- `npm run fetch-map` — regenerate map from cache (or `-- --refresh` to hit Overpass)
- `npm run typecheck` / `npm run build`

## Working style
- Small steps, commit as you go. Keep the generated map deterministic (same cache → same JSON).
- Don't add physics engines or heavy deps without a reason.
