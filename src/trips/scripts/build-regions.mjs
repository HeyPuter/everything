// Builds public/data/regions/<CC>.json (one TopoJSON per atlas country) and index.json from Natural Earth 10m
// admin-1 GeoJSON. Shared borders become shared arcs before simplification, so neighbouring regions never gap.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { distinctOutput } from './data-io.mjs';
import { countryCode } from '../src/lib/atlas/countries.js';

export const GRID = 1000; // coordinates are stored in 0.001° steps (about 110 m)
export const TOLERANCE = 20; // Douglas–Peucker tolerance in grid steps (about one pixel at zoom 5)
const ISO = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
// Antarctica has no real subdivisions in the dataset.
const SKIP = new Set(['AQ']);
// Natural Earth marks subdivisions without an ISO 3166-2 code with `XX-X<n>~`.
const PSEUDO = /^([A-Z]{2}-X[0-9]{1,2})~?$/;
const BORDERS = 'Natural Earth default (de facto) point of view, the same as countries-50m. Each region is filed under the country Natural Earth assigns it to (iso_a2); areas Natural Earth leaves without a country code are omitted. No app-specific adjustments.';

/** `{code, iso}` for a Natural Earth feature, or null when it has no usable code. */
export function regionCode(properties) {
  const value = String(properties?.iso_3166_2 ?? '');
  const pseudo = PSEUDO.exec(value);
  if (pseudo) return { code: pseudo[1], iso: false };
  return ISO.test(value) ? { code: value, iso: true } : null;
}

const key = ([x, y]) => (x + 180 * GRID) * 200 * GRID + (y + 90 * GRID);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

function cleanRing(ring) {
  const out = [];
  for (const [lng, lat] of ring) {
    const point = [Math.round(lng * GRID), Math.round(lat * GRID)];
    if (!out.length || !same(out.at(-1), point)) out.push(point);
  }
  while (out.length > 1 && same(out[0], out.at(-1))) out.pop();
  return out.length >= 3 ? out : null;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return sum / 2;
}

function douglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const limit = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first]; const [bx, by] = points[last];
    const dx = bx - ax; const dy = by - ay; const length = dx * dx + dy * dy;
    let worst = -1; let index = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let d;
      if (!length) d = (px - ax) ** 2 + (py - ay) ** 2;
      else { const cross = (px - ax) * dy - (py - ay) * dx; d = (cross * cross) / length; }
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > limit) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplifies one arc with its endpoints fixed; a closed arc keeps at least a triangle. */
export function simplifyArc(points, tolerance = TOLERANCE) {
  if (points.length <= 3 || !same(points[0], points.at(-1))) return douglasPeucker(points, tolerance);
  let far = 1; let best = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const out = [...douglasPeucker(points.slice(0, far + 1), tolerance), ...douglasPeucker(points.slice(far), tolerance).slice(1)];
  if (out.length >= 4) return out;
  // Too small to survive the tolerance: keep the start, the far point and the point farthest from that line.
  const [ax, ay] = points[0]; const [bx, by] = points[far];
  let third = -1; best = -1;
  for (let i = 1; i < points.length - 1; i++) {
    if (i === far) continue;
    const d = Math.abs((points[i][0] - ax) * (by - ay) - (points[i][1] - ay) * (bx - ax));
    if (d > best) { best = d; third = i; }
  }
  if (third < 0) return out;
  return [0, far, third].sort((a, b) => a - b).map((i) => points[i]).concat([points[0]]);
}

/**
 * One country's regions as a quantized, delta-encoded TopoJSON with the object `regions`.
 * `regions`: `[{code, name, local, iso, polygons: [[[lng, lat]…]…]}]`.
 */
export function buildTopology(regions, { tolerance = TOLERANCE } = {}) {
  const shapes = regions.map((region) => ({ ...region, polygons: region.polygons.map((polygon) => polygon.map(cleanRing)).filter((polygon) => polygon[0]).map((polygon) => polygon.filter(Boolean)) }));
  const rings = shapes.flatMap((shape) => shape.polygons.flat());
  // A point is a junction where it is reached from different neighbours (where borders meet or diverge).
  const neighbours = new Map();
  const junctions = new Set();
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const k = key(ring[i]); const a = key(ring[(i + n - 1) % n]); const b = key(ring[(i + 1) % n]);
      const seen = neighbours.get(k);
      if (!seen) neighbours.set(k, [a, b]);
      else if (!((seen[0] === a && seen[1] === b) || (seen[0] === b && seen[1] === a))) junctions.add(k);
    }
  }
  const arcs = []; const index = new Map();
  const register = (points) => {
    const forward = points.map(key).join(',');
    if (index.has(forward)) return index.get(forward);
    const backward = points.map(key).reverse().join(',');
    if (index.has(backward)) return ~index.get(backward);
    arcs.push(points); index.set(forward, arcs.length - 1);
    return arcs.length - 1;
  };
  const cut = (ring) => {
    const n = ring.length;
    const at = [];
    for (let i = 0; i < n; i++) if (junctions.has(key(ring[i]))) at.push(i);
    if (!at.length) {
      // Closed arc: start at the smallest point so a ring shared by two regions (an enclave) dedupes.
      let start = 0;
      for (let i = 1; i < n; i++) if (key(ring[i]) < key(ring[start])) start = i;
      const rotated = [...ring.slice(start), ...ring.slice(0, start)];
      return [register([...rotated, rotated[0]])];
    }
    const rotated = [...ring.slice(at[0]), ...ring.slice(0, at[0]), ring[at[0]]];
    const cuts = at.map((i) => i - at[0]).concat(n);
    return cuts.slice(0, -1).map((from, j) => register(rotated.slice(from, cuts[j + 1] + 1)));
  };
  // Islands too small to see at the tolerance are dropped, unless they are all a region has.
  const minArea = 4 * tolerance * tolerance;
  const islet = (polygon) => Math.abs(ringArea(polygon[0])) < minArea && polygon[0].every((point) => !junctions.has(key(point)));
  const geometries = shapes.map((shape) => {
    const kept = shape.polygons.filter((polygon) => !islet(polygon));
    const largest = shape.polygons.slice().sort((a, b) => Math.abs(ringArea(b[0])) - Math.abs(ringArea(a[0])))[0];
    const polygons = (kept.length ? kept : largest ? [largest] : []).map((polygon) => polygon.map(cut));
    const properties = { name: shape.name };
    if (shape.local && shape.local !== shape.name) properties.local = shape.local;
    if (!shape.iso) properties.iso = false;
    return polygons.length === 1 ? { type: 'Polygon', id: shape.code, arcs: polygons[0], properties } : { type: 'MultiPolygon', id: shape.code, arcs: polygons, properties };
  }).filter((geometry) => geometry.arcs.length);
  const encoded = arcs.map((arc) => {
    let x = 0; let y = 0;
    return simplifyArc(arc, tolerance).map(([px, py]) => { const delta = [px - x, py - y]; x = px; y = py; return delta; });
  });
  return { type: 'Topology', transform: { scale: [1 / GRID, 1 / GRID], translate: [0, 0] }, arcs: encoded, objects: { regions: { type: 'GeometryCollection', geometries } } };
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null);

/** Groups Natural Earth features into `Map<cc, region[]>`, merging features that share an ISO code. */
export function groupRegions(collection) {
  const countries = new Map();
  const skipped = [];
  for (const feature of collection?.features ?? []) {
    const p = feature.properties ?? {};
    const cc = countryCode(p.iso_a2);
    const id = regionCode(p);
    const geometry = feature.geometry;
    const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
    if (!cc || SKIP.has(cc) || !id || !polygons) { skipped.push(`${p.iso_a2} ${p.iso_3166_2} ${p.name}`); continue; }
    const regions = countries.get(cc) ?? new Map();
    const name = text(p.name_en) ?? text(p.name) ?? text(p.gn_name) ?? id.code;
    const entry = regions.get(id.code);
    if (entry) {
      entry.polygons.push(...polygons);
      entry.parts.push({ name, local: text(p.name), region: text(p.region), area: Number(p.area_sqkm) || 0 });
    } else {
      regions.set(id.code, { code: id.code, iso: id.iso, polygons: [...polygons], parts: [{ name, local: text(p.name), region: text(p.region), area: Number(p.area_sqkm) || 0 }] });
    }
    countries.set(cc, regions);
  }
  const out = new Map();
  for (const [cc, regions] of [...countries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.set(cc, [...regions.values()].sort((a, b) => (a.code < b.code ? -1 : 1)).map(({ parts, ...region }) => {
      // Several features under one ISO code (city districts, cantons) take their shared region name.
      const shared = parts.length > 1 && parts.every((part) => part.region && part.region === parts[0].region) ? parts[0].region : null;
      const main = parts.slice().sort((a, b) => b.area - a.area)[0];
      return { ...region, name: shared ?? main.name, local: shared ? null : main.local };
    }));
  }
  return { countries: out, skipped };
}

export async function buildRegions({ input, sha256, output = new URL('../public/data/regions/', import.meta.url), tolerance = TOLERANCE } = {}) {
  if (!input || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Provide a reviewed local GeoJSON input and its SHA-256');
  const raw = await readFile(input); const hash = createHash('sha256').update(raw).digest('hex'); if (hash !== sha256) throw new Error('Input checksum mismatch');
  const collection = JSON.parse(raw);
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features) || !collection.features.length) throw new Error('Expected Natural Earth admin-1 GeoJSON');
  const { countries, skipped } = groupRegions(collection);
  const dir = output instanceof URL ? output : pathToFileURL(output.endsWith('/') ? output : `${output}/`);
  await mkdir(dir, { recursive: true });
  const counts = {}; const moved = {}; let bytes = 0;
  for (const [cc, regions] of countries) {
    const topology = buildTopology(regions, { tolerance });
    const body = JSON.stringify(topology) + '\n';
    await writeFile(await distinctOutput(input, new URL(`${cc}.json`, dir)), body);
    bytes += body.length;
    counts[cc] = topology.objects.regions.geometries.length;
    for (const region of regions) if (countryCode(region.code.slice(0, 2)) !== cc) moved[region.code] = cc;
  }
  const index = { source: 'Natural Earth 10m admin-1 states and provinces v5.1.2', license: 'Public domain (Natural Earth)', sha256: hash, borders: BORDERS, grid: 1 / GRID, tolerance: tolerance / GRID, countries: counts, moved };
  await writeFile(await distinctOutput(input, new URL('index.json', dir)), JSON.stringify(index, null, 2) + '\n');
  return { countries: countries.size, regions: Object.values(counts).reduce((sum, n) => sum + n, 0), bytes, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, sha256, output] = process.argv.slice(2);
  buildRegions({ input, sha256, ...(output ? { output } : {}) })
    .then(({ countries, regions, bytes, skipped }) => process.stdout.write(`Wrote ${regions} regions in ${countries} countries (${bytes} bytes); skipped ${skipped.length} features\n`))
    .catch((cause) => { process.stderr.write(cause.message + '\n'); process.exitCode = 1; });
}
