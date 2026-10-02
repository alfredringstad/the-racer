// Analyses the map-editor correction log to suggest generator changes or upstream data fixes.
//
//   npm run analyze-edits
//
// For every generator rule: how many features it produced and how often you corrected them (by op and
// reason). For rules with enough corrections: which OSM tags are over-represented among the corrected
// features compared with everything the rule produced — a hint for a better rule or better source data.
// Corrections to features copied straight from OSM (rule *.osm) are listed as upstream candidates.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_REASONS, parseEditLog, type Edit } from '../src/editor/edits';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = resolve(ROOT, 'data/edits/log.jsonl');
const MAP = resolve(ROOT, 'public/assets/maps/norrkoping.json');
const CACHE = resolve(ROOT, 'data/osm-cache.json');
/** Minimum corrections for a rule before tag patterns are worth looking at. */
const MIN_FOR_PATTERNS = 5;
/** How unusual a tag value's share among corrections must be to be reported (z-score; 1.64 ≈ one-sided 95%). */
const MIN_Z = 1.64;
/** Tags that say something about how a road is drawn; others are noise for this purpose. */
const INTERESTING_TAGS = ['highway', 'lanes', 'oneway', 'surface', 'lane_markings', 'maxspeed', 'lit', 'cycleway', 'cycleway:right', 'cycleway:left', 'junction', 'bus', 'embedded_rails', 'width', 'crossing', 'crossing:markings'];

type Tags = Record<string, string>;
interface Feature {
  layer: string;
  rule: string;
  osm: string[];
}

function main() {
  if (!existsSync(LOG)) {
    console.log('No edits yet (data/edits/log.jsonl). Make some corrections in the map editor (npm run editor) first.');
    return;
  }
  const edits = parseEditLog(readFileSync(LOG, 'utf8'));
  const map = JSON.parse(readFileSync(MAP, 'utf8'));
  const cache = JSON.parse(readFileSync(CACHE, 'utf8'));

  // OSM tags by "way/123" / "node/456".
  const tagsOf = new Map<string, Tags>();
  for (const el of cache.features.elements) if (el.tags) tagsOf.set(`${el.type}/${el.id}`, el.tags);

  // Everything each rule produced: features still in the map plus the ones removed by edits.
  const prop = (o: { properties?: { name: string; value: unknown }[] }, n: string) => o.properties?.find((p) => p.name === n)?.value as string | undefined;
  const produced = new Map<string, Feature[]>();
  for (const layer of ['lights', 'signs', 'markings'])
    for (const o of map.layers.find((l: { name: string }) => l.name === layer)?.objects ?? []) {
      const rule = prop(o, 'rule');
      if (!rule || rule === 'edit.add') continue;
      produced.set(rule, [...(produced.get(rule) ?? []), { layer, rule, osm: (prop(o, 'osm') ?? '').split(' ').filter(Boolean) }]);
    }
  for (const e of edits)
    if (e.op === 'remove' && e.source?.rule)
      produced.set(e.source.rule, [...(produced.get(e.source.rule) ?? []), { layer: e.layer, rule: e.source.rule, osm: e.source.osm ?? [] }]);

  console.log(`# Map edit analysis\n\n${edits.length} edits in data/edits/log.jsonl\n`);

  // Corrections per rule.
  const byRule = new Map<string, Edit[]>();
  for (const e of edits) {
    const rule = e.op === 'add' ? `(added: ${e.layer} ${e.add?.type})` : (e.source?.rule ?? '(unknown rule)');
    byRule.set(rule, [...(byRule.get(rule) ?? []), e]);
  }
  console.log('## Corrections per generator rule\n');
  console.log('| Rule | Generated | Corrected | Rate | Ops | Reasons |');
  console.log('|---|---:|---:|---:|---|---|');
  const rows = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [rule, list] of rows) {
    const gen = produced.get(rule)?.length;
    const count = (f: (e: Edit) => string) => Object.entries(list.reduce<Record<string, number>>((m, e) => ((m[f(e)] = (m[f(e)] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`| ${rule} | ${gen ?? '—'} | ${list.length} | ${gen ? `${Math.round((list.length / gen) * 100)}%` : '—'} | ${count((e) => e.op)} | ${count((e) => e.reason)} |`);
  }

  // Tag patterns: compare corrected features' road tags with all features of the same rule.
  console.log(`\n## Tag patterns (rules with ≥ ${MIN_FOR_PATTERNS} corrections)\n`);
  let anyPattern = false;
  for (const [rule, list] of rows) {
    const all = produced.get(rule);
    if (list.length < MIN_FOR_PATTERNS || !all) continue;
    const roadTags = (osm: string[]) => tagsOf.get(osm.find((r) => r.startsWith('way/')) ?? '') ?? {};
    const freq = (feats: Tags[]) => {
      const m = new Map<string, number>();
      for (const t of feats) for (const k of INTERESTING_TAGS) m.set(`${k}=${t[k] ?? '(none)'}`, (m.get(`${k}=${t[k] ?? '(none)'}`) ?? 0) + 1);
      return m;
    };
    const corrected = freq(list.map((e) => roadTags(e.source?.osm ?? [])));
    const overall = freq(all.map((f) => roadTags(f.osm)));
    // How surprising is each tag value's share among the corrections, given its share among everything
    // the rule produced? z-score of a proportion; > MIN_Z ≈ unlikely to be chance (one-sided 95%).
    const lifts = [...corrected.entries()]
      .map(([tv, n]) => {
        const share = n / list.length;
        const base = Math.min(0.999, Math.max(0.001, (overall.get(tv) ?? 0) / all.length));
        return { tv, share, base, z: (share - base) / Math.sqrt((base * (1 - base)) / list.length) };
      })
      .filter((x) => x.z >= MIN_Z && x.share >= 0.3)
      .sort((a, b) => b.z - a.z)
      .slice(0, 5);
    if (!lifts.length) continue;
    anyPattern = true;
    console.log(`**${rule}** (${list.length} corrections of ${all.length}):`);
    for (const l of lifts) console.log(`- \`${l.tv}\` on ${Math.round(l.share * 100)}% of corrected vs ${Math.round(l.base * 100)}% of all (z = ${l.z.toFixed(1)})`);
    console.log('');
  }
  if (!anyPattern) console.log('No strong patterns yet — more corrections make this more useful.\n');

  // Upstream candidates: features that came straight from OSM objects.
  const upstream = edits.filter((e) => e.source?.rule?.endsWith('.osm'));
  console.log('## Possible OpenStreetMap data issues\n');
  if (!upstream.length) console.log('None: no corrections to features mapped directly in OSM.\n');
  for (const e of upstream)
    console.log(`- ${e.op} ${e.layer} (${EDIT_REASONS[e.reason]})${e.note ? ` — ${e.note}` : ''}: ${(e.source?.osm ?? []).map((r) => `https://www.openstreetmap.org/${r}`).join(' ')}`);

  // Notes are often the most useful part.
  const notes = edits.filter((e) => e.note);
  if (notes.length) {
    console.log('\n## Notes\n');
    for (const e of notes) console.log(`- ${e.op} ${e.target ?? e.add?.type ?? ''}: ${e.note}`);
  }
}

main();
