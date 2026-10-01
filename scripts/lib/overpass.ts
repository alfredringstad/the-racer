// Tiny Overpass API client with mirror fallback. Overpass sometimes answers
// "too busy" with an HTML/XML page and HTTP 200, so we validate the body too.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OsmWay {
  type: 'way';
  id: number;
  geometry: LatLon[];
  tags?: Record<string, string>;
}

export interface OsmRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: LatLon[];
}

export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmRelationMember[];
  tags?: Record<string, string>;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements: OsmElement[];
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const USER_AGENT = 'the-racer-map-fetch/0.1 (hobby game; https://www.openstreetmap.org/copyright)';

export async function overpass(query: string): Promise<OverpassResponse> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(200_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!text.trimStart().startsWith('{')) throw new Error(`non-JSON response: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
        const json = JSON.parse(text) as OverpassResponse & { remark?: string };
        if (json.remark?.includes('error')) throw new Error(json.remark);
        return json;
      } catch (e) {
        const msg = `${url}: ${(e as Error).message}`;
        console.warn(`  overpass failed — ${msg}`);
        errors.push(msg);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`All Overpass endpoints failed:\n${errors.join('\n')}`);
}
