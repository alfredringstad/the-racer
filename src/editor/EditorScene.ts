import Phaser from 'phaser';
import { TrackMap, type TiledMap } from '../game/TrackMap';
import { RoadMarkings } from '../game/RoadMarkings';
import { TramNetwork } from '../game/TramNetwork';
import { Terrain, type HeightFile } from '../game/Terrain';
import { SIGN_H, SIGN_KINDS, SIGN_W, SPEED_LIMITS, signFrame, type SignKind } from '../game/signs';
import { EDIT_REASONS, applyEdits, mapGeo, newEditId, propOf, type Edit, type EditLayer, type EditReason } from './edits';

type Obj = TiledMap['layers'][number]['objects'] extends (infer O)[] | undefined ? O : never;

/** Something on the map the editor can select. */
interface Pick {
  layer: EditLayer;
  obj: Obj;
  key: string;
}

const ZOOMS = [0.5, 1, 2, 3, 4];
const DEFAULT_REASON: Record<Edit['op'], EditReason> = { remove: 'not-real', move: 'wrong-position', add: 'missing', set: 'wrong-type' };
const PICK_RADIUS = 8; // screen px
const LAYERS: EditLayer[] = ['lights', 'signs', 'markings'];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Map editor: pan/zoom over the generated map, select lamps, signs and markings, and record corrections
 * (remove / move / add / set) with a reason. The preview is the last built map plus this session's edits.
 */
export class EditorScene extends Phaser.Scene {
  /** The map as last built by fetch-map (already includes all edits saved before this session). */
  private base!: TiledMap;
  private height?: HeightFile;
  /** base + saved + pending edits, rebuilt after every change. */
  private view!: TiledMap;
  private saved: Edit[] = [];
  private pending: Edit[] = [];
  private track?: TrackMap;
  private highlight!: Phaser.GameObjects.Graphics;
  private selected?: Pick;
  private visible = new Set<EditLayer>(LAYERS);
  /** Reason picked explicitly in the panel for the next edit; otherwise each operation has a default. */
  private reasonOverride?: EditReason;
  private zoomIndex = 1;
  private drag?: { kind: 'pan'; x: number; y: number; sx: number; sy: number } | { kind: 'move'; start: Phaser.Math.Vector2; now: Phaser.Math.Vector2 };

  constructor() {
    super('Editor');
  }

  preload() {
    this.load.image('tiles', 'assets/tiles/tiles.png');
    this.load.image('street-lamp', 'assets/sprites/street-lamp.png');
    this.load.spritesheet('signs', 'assets/sprites/signs.png', { frameWidth: SIGN_W, frameHeight: SIGN_H });
  }

  async create() {
    (window as unknown as { editor: EditorScene }).editor = this; // for poking at from the devtools console
    this.highlight = this.add.graphics().setDepth(1000);
    this.setupPanel();
    this.setupInput();
    await this.loadMap();
    const spawn = this.track!.spawn();
    this.cameras.main.centerOn(spawn.x, spawn.y);
  }

  // ---------------------------------------------------------------------------------------------
  // Model

  private async loadMap() {
    const bust = `?t=${Date.now()}`;
    this.base = await (await fetch(`assets/maps/norrkoping.json${bust}`)).json();
    this.height = await fetch(`assets/maps/norrkoping-height.json${bust}`).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined);
    this.saved = [];
    this.pending = [];
    this.refresh();
  }

  /** Re-applies this session's edits to a copy of the base map and rebuilds the visible world. */
  private refresh() {
    this.view = structuredClone(this.base);
    applyEdits(this.view, [...this.saved, ...this.pending]);
    const centre = this.cameras.main.midPoint.clone();
    // Hide layers that are switched off by emptying them in the copy the renderer sees.
    const shown = structuredClone(this.view);
    for (const l of shown.layers) if (LAYERS.includes(l.name as EditLayer) && !this.visible.has(l.name as EditLayer)) l.objects = [];
    this.track?.destroy();
    this.track = new TrackMap(this, shown);
    const markings = new RoadMarkings(shown);
    const tram = new TramNetwork(shown, this.track.metresPerTile, (x, y) => this.track!.surfaceAt(x, y));
    const terrain = this.height && this.height.width === this.track.width ? new Terrain(this.height) : undefined;
    if (terrain)
      this.track.chunkDecorators.push((key, x, y, w, h) => {
        const img = terrain.drawChunk(this, key, x, y, w, h, (px, py) => this.track!.surfaceAt(px, py));
        return img && { objects: [img], textures: [key] };
      });
    this.track.chunkDecorators.push((key, x, y, w, h) => {
      const img = markings.drawChunk(this, key, x, y, w, h);
      return img && { objects: [img], textures: [key] };
    });
    this.track.chunkDecorators.push((key, x, y, w, h) => {
      const img = tram.drawChunk(this, key, x, y, w, h);
      return img && { objects: [img], textures: [key] };
    });
    const cam = this.cameras.main;
    cam.setBounds(-256, -256, this.track.widthPx + 512, this.track.heightPx + 512);
    if (centre.x || centre.y) cam.centerOn(centre.x, centre.y);
    // Keep the selection pointing at the (possibly moved) object in the new view.
    if (this.selected) {
      const obj = this.objects(this.selected.layer).find((o) => propOf<string>(o, 'key') === this.selected!.key);
      this.selected = obj ? { ...this.selected, obj } : undefined;
    }
    this.renderPanel();
  }

  private objects(layer: EditLayer): Obj[] {
    return this.view.layers.find((l) => l.name === layer)?.objects ?? [];
  }

  /** The reason the next edit of this kind gets: the panel's explicit pick, or the operation's default. */
  private reasonFor(op: Edit['op']): EditReason {
    return this.reasonOverride ?? DEFAULT_REASON[op];
  }

  private record(edit: Omit<Edit, 'id' | 'at' | 'reason' | 'note'>) {
    const note = ($('note') as HTMLInputElement).value.trim();
    this.pending.push({ id: newEditId(), at: new Date().toISOString(), reason: this.reasonFor(edit.op), ...(note ? { note } : {}), ...edit });
    this.resetReason();
    this.refresh();
  }

  /** An explicit reason and note apply to one edit only. */
  private resetReason() {
    this.reasonOverride = undefined;
    ($('note') as HTMLInputElement).value = '';
  }

  private sourceOf(p: Pick): Edit['source'] {
    const osm = propOf<string>(p.obj, 'osm');
    return { rule: propOf<string>(p.obj, 'rule'), osm: osm ? osm.split(' ') : [], type: p.obj.type };
  }

  private removeSelected() {
    const p = this.selected;
    if (!p) return;
    this.selected = undefined;
    this.record({ op: 'remove', layer: p.layer, target: p.key, source: this.sourceOf(p) });
  }

  private moveSelected(dx: number, dy: number) {
    const p = this.selected;
    if (!p || (!dx && !dy)) return;
    const geo = mapGeo(this.view);
    this.record({
      op: 'move',
      layer: p.layer,
      target: p.key,
      from: geo.toLatLon(p.obj.x, p.obj.y),
      to: geo.toLatLon(p.obj.x + dx, p.obj.y + dy),
      source: this.sourceOf(p),
    });
  }

  private addObject(layer: EditLayer, type: string, x: number, y: number, props: Record<string, string | number | boolean>) {
    const id = newEditId();
    const note = ($('note') as HTMLInputElement).value.trim();
    this.pending.push({ id, at: new Date().toISOString(), op: 'add', layer, add: { type, at: mapGeo(this.view).toLatLon(x, y), props }, reason: this.reasonFor('add'), ...(note ? { note } : {}) });
    this.resetReason();
    this.refresh();
    const obj = this.objects(layer).find((o) => propOf<string>(o, 'key') === `edit:${id}`);
    if (obj) this.select({ layer, obj, key: `edit:${id}` });
  }

  // ---------------------------------------------------------------------------------------------
  // Picking

  private pick(x: number, y: number): Pick | undefined {
    const r = PICK_RADIUS / this.cameras.main.zoom;
    let best: Pick | undefined;
    let bestD = r;
    for (const layer of LAYERS) {
      if (!this.visible.has(layer)) continue;
      for (const obj of this.objects(layer)) {
        const key = propOf<string>(obj, 'key');
        if (!key) continue;
        let d: number;
        if (obj.polyline && obj.polyline.length > 1) {
          d = Infinity;
          for (let i = 1; i < obj.polyline.length; i++) {
            const a = obj.polyline[i - 1];
            const b = obj.polyline[i];
            d = Math.min(d, distToSegment(x, y, obj.x + a.x, obj.y + a.y, obj.x + b.x, obj.y + b.y));
          }
        } else {
          // Lamps and signs: the post stands at the point, the sprite reaches ~20px up from it.
          const tall = layer === 'lights' || layer === 'signs';
          d = tall ? distToSegment(x, y, obj.x, obj.y, obj.x, obj.y - 18) : Math.hypot(x - obj.x, y - obj.y);
        }
        if (d < bestD) [best, bestD] = [{ layer, obj, key }, d];
      }
    }
    return best;
  }

  private select(p: Pick | undefined) {
    this.selected = p;
    this.renderPanel();
  }

  private drawHighlight() {
    const g = this.highlight.clear();
    const p = this.selected;
    if (!p) return;
    const z = this.cameras.main.zoom;
    const dx = this.drag?.kind === 'move' ? this.drag.now.x - this.drag.start.x : 0;
    const dy = this.drag?.kind === 'move' ? this.drag.now.y - this.drag.start.y : 0;
    g.lineStyle(2 / z, 0xf2d16b, 1);
    if (p.obj.polyline && p.obj.polyline.length > 1) {
      g.beginPath();
      p.obj.polyline.forEach((q, i) => (i ? g.lineTo(p.obj.x + q.x + dx, p.obj.y + q.y + dy) : g.moveTo(p.obj.x + q.x + dx, p.obj.y + q.y + dy)));
      g.strokePath();
      g.strokeCircle(p.obj.x + dx, p.obj.y + dy, 3 / z);
    } else {
      g.strokeCircle(p.obj.x + dx, p.obj.y + dy, 5 / z);
      if (p.layer !== 'markings') g.strokeRect(p.obj.x + dx - 7, p.obj.y + dy - 21, 14, 23);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Input

  private setupInput() {
    const cam = this.cameras.main;
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      const world = cam.getWorldPoint(ptr.x, ptr.y);
      if (ptr.leftButtonDown()) {
        const hit = this.pick(world.x, world.y);
        if (hit && this.selected && hit.key === this.selected.key) {
          this.drag = { kind: 'move', start: world.clone(), now: world.clone() };
          return;
        }
        this.select(hit);
        if (hit) {
          this.drag = { kind: 'move', start: world.clone(), now: world.clone() };
          return;
        }
      }
      this.drag = { kind: 'pan', x: ptr.x, y: ptr.y, sx: cam.scrollX, sy: cam.scrollY };
    });
    this.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      const world = cam.getWorldPoint(ptr.x, ptr.y);
      if (this.drag?.kind === 'pan') cam.setScroll(this.drag.sx - (ptr.x - this.drag.x) / cam.zoom, this.drag.sy - (ptr.y - this.drag.y) / cam.zoom);
      else if (this.drag?.kind === 'move') this.drag.now.set(world.x, world.y);
      const ll = this.track ? mapGeo(this.view).toLatLon(world.x, world.y) : undefined;
      $('status').textContent = `${Math.round(world.x)}, ${Math.round(world.y)} px  ·  ${ll ? `${ll.lat.toFixed(6)}, ${ll.lon.toFixed(6)}` : ''}  ·  zoom ${cam.zoom}×`;
    });
    this.input.on('pointerup', () => {
      const d = this.drag;
      this.drag = undefined;
      if (d?.kind === 'move') {
        const dx = Math.round(d.now.x - d.start.x);
        const dy = Math.round(d.now.y - d.start.y);
        if (Math.hypot(dx, dy) >= 1) this.moveSelected(dx, dy);
      }
    });
    this.input.on('wheel', (ptr: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
      const before = cam.getWorldPoint(ptr.x, ptr.y);
      this.zoomIndex = Phaser.Math.Clamp(this.zoomIndex + (dy > 0 ? -1 : 1), 0, ZOOMS.length - 1);
      cam.setZoom(ZOOMS[this.zoomIndex]);
      cam.preRender();
      const after = cam.getWorldPoint(ptr.x, ptr.y);
      cam.setScroll(cam.scrollX + before.x - after.x, cam.scrollY + before.y - after.y);
    });

    const kb = this.input.keyboard!;
    kb.on('keydown', (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === 'INPUT') return;
      const world = cam.getWorldPoint(this.input.activePointer.x, this.input.activePointer.y);
      if (ev.key === 'Delete' || ev.key === 'Backspace') this.removeSelected();
      else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') this.undo();
      else if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
        ev.preventDefault();
        void this.save();
      } else if (ev.key === 'l') this.addObject('lights', 'street_lamp', world.x, world.y, { source: 'edit' });
      else if (ev.key === 'k') this.addSign(world.x, world.y);
      else if (ev.key === 'Escape') this.select(undefined);
    });
  }

  update(_time: number, delta: number) {
    const cam = this.cameras.main;
    const keys = this.input.keyboard!.createCursorKeys();
    const pan = (600 * delta) / 1000 / cam.zoom;
    if (keys.left.isDown) cam.scrollX -= pan;
    if (keys.right.isDown) cam.scrollX += pan;
    if (keys.up.isDown) cam.scrollY -= pan;
    if (keys.down.isDown) cam.scrollY += pan;
    this.track?.updateChunks(cam.worldView);
    this.drawHighlight();
  }

  // ---------------------------------------------------------------------------------------------
  // Panel

  private setupPanel() {
    $('reasons').addEventListener('change', (e) => {
      this.reasonOverride = (e.target as HTMLInputElement).value as EditReason;
      this.renderPanel();
    });
    for (const box of document.querySelectorAll<HTMLInputElement>('[data-layer]'))
      box.addEventListener('change', () => {
        const layer = box.dataset.layer as EditLayer;
        if (box.checked) this.visible.add(layer);
        else this.visible.delete(layer);
        if (this.selected?.layer === layer && !box.checked) this.selected = undefined;
        this.refresh();
      });
    const signs = $('add-sign') as HTMLSelectElement;
    signs.innerHTML =
      SPEED_LIMITS.map((v) => `<option value="speed:${v}">Speed limit ${v}</option>`).join('') +
      SIGN_KINDS.map((k) => `<option value="${k}">${k.replace('_', ' ')}</option>`).join('');
    signs.value = 'speed:30';
    window.addEventListener('beforeunload', (e) => {
      if (this.pending.length) e.preventDefault(); // unsaved edits: let the browser ask
    });
    $('undo').addEventListener('click', () => this.undo());
    $('save').addEventListener('click', () => void this.save());
    $('rebuild').addEventListener('click', () => void this.rebuild());
  }

  private addSign(x: number, y: number) {
    const [kind, v] = ($('add-sign') as HTMLSelectElement).value.split(':') as [SignKind, string | undefined];
    const value = v ? Number(v) : undefined;
    this.addObject('signs', kind, x, y, { frame: signFrame(kind, value)!, facing: 0, ...(value !== undefined ? { value } : {}) });
  }

  private renderPanel() {
    // Reason radios: the explicit pick, or the default for what you'd most likely do next with the selection.
    const shown = this.reasonOverride ?? (this.selected ? DEFAULT_REASON.remove : DEFAULT_REASON.add);
    $('reasons').innerHTML =
      Object.entries(EDIT_REASONS)
        .map(([k, label]) => `<label><input type="radio" name="reason" value="${k}" ${k === shown ? 'checked' : ''}/> ${label}</label>`)
        .join('') +
      `<div class="muted" style="margin-top:4px">${this.reasonOverride ? 'Applies to the next edit only.' : 'Default per action: remove → doesn’t exist, move → wrong position, add → missing, change → wrong value.'}</div>`;
    const p = this.selected;
    const el = $('selected');
    if (!p) {
      el.className = 'muted';
      el.textContent = 'Click a lamp, sign or marking.';
    } else {
      el.className = '';
      const osm = (propOf<string>(p.obj, 'osm') ?? '').split(' ').filter(Boolean);
      const props = (p.obj.properties ?? []).filter((q) => !['key', 'rule', 'osm', 'frame'].includes(q.name));
      el.innerHTML = `<dl class="kv">
        <dt>Type</dt><dd>${p.obj.type} <span class="muted">(${p.layer})</span></dd>
        <dt>Key</dt><dd>${p.key}</dd>
        <dt>Rule</dt><dd>${propOf<string>(p.obj, 'rule') ?? ''}</dd>
        <dt>OSM</dt><dd>${osm.map((r) => `<a href="https://www.openstreetmap.org/${r}" target="_blank" rel="noopener">${r}</a>`).join(' ') || '<span class="muted">none</span>'}</dd>
        ${props.map((q) => `<dt>${q.name}</dt><dd>${String(q.value)}</dd>`).join('')}
      </dl>
      <div class="row" style="margin-top:8px">
        <button id="sel-remove">Remove</button>
        ${p.obj.type === 'speed' ? `<select id="sel-speed">${SPEED_LIMITS.map((v) => `<option ${v === propOf<number>(p.obj, 'value') ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
      </div>`;
      $('sel-remove').addEventListener('click', () => this.removeSelected());
      document.getElementById('sel-speed')?.addEventListener('change', (e) => {
        const value = Number((e.target as HTMLSelectElement).value);
        this.record({ op: 'set', layer: p.layer, target: p.key, set: { value, frame: signFrame('speed', value)! }, source: this.sourceOf(p) });
      });
    }
    const short = (e: Edit) => `${e.target ?? e.add?.type ?? ''}`.replace(/^(\w+):/, '');
    $('edits').innerHTML = [...this.saved.map((e) => ({ e, saved: true })), ...this.pending.map((e) => ({ e, saved: false }))]
      .reverse()
      .map(({ e, saved }) => `<li class="${saved ? 'saved' : ''}"><span class="op">${e.op}</span> ${e.layer} · ${short(e)}<br><span class="muted">${EDIT_REASONS[e.reason]}${e.note ? ` — ${e.note}` : ''}${saved ? ' · saved' : ''}</span></li>`)
      .join('');
    ($('save') as HTMLButtonElement).disabled = !this.pending.length;
    ($('save') as HTMLButtonElement).textContent = this.pending.length ? `Save (${this.pending.length})` : 'Saved';
    ($('undo') as HTMLButtonElement).disabled = !this.pending.length;
  }

  private undo() {
    if (!this.pending.pop()) return;
    this.refresh();
  }

  private async save() {
    if (!this.pending.length) return;
    const res = await fetch('/__editor/edits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.pending) });
    if (!res.ok) {
      $('log').textContent = `Save failed: ${await res.text()}`;
      return;
    }
    this.saved.push(...this.pending);
    this.pending = [];
    $('log').textContent = 'Saved to data/edits/log.jsonl.';
    this.renderPanel();
  }

  private async rebuild() {
    if (this.pending.length) await this.save();
    $('log').textContent = 'Rebuilding the map (fetch-map)…';
    ($('rebuild') as HTMLButtonElement).disabled = true;
    try {
      const res = await fetch('/__editor/rebuild', { method: 'POST' });
      const out = (await res.json()) as { ok: boolean; output: string };
      $('log').textContent = out.output.split('\n').filter((l) => /Edits|orphaned|Wrote|rror/.test(l)).join('\n') || out.output;
      if (out.ok) await this.loadMap();
    } finally {
      ($('rebuild') as HTMLButtonElement).disabled = false;
    }
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
