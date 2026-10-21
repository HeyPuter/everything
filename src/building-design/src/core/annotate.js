/**
 * View annotations beyond plain text and aligned dimensions: angular and
 * radial dimensions, spot elevations, coordinates and slopes, revision
 * clouds, insulation, detail items, detail arcs, symbols (north arrow,
 * graphic scale, span direction) and colour fill legends. Each draws into a
 * PlanBuilder in the coordinates of its view (plan, or u/z in elevations).
 *
 * Shapes:
 *   angularDim    { viewId, c, r, a0, a1 }                angle from a0 counterclockwise to a1
 *   radialDim     { viewId, c, r, angle, diameter, targetId }
 *   spot          { viewId, at, mode: 'elevation'|'coordinate'|'slope', label, z }
 *   revisionCloud { viewId, boundary, revisionId }
 *   insulation    { viewId, a, b, width }
 *   detailItem    { viewId, family, at, rotation, w, h }
 *   detailArc     { viewId, c, r, a0, a1, style }
 *   symbol        { viewId, family: 'north'|'scale'|'span', at, rotation, hostId }
 *   colorLegend   { viewId, at, by }
 */
import { add, sub, scale, norm, perp, dist, rotate, arcPoints, angleOf, mid, pointInPolygon, bbox } from './geom.js';
import { W, INK, BG, PATTERN, readableAngle, roomColorFor, lineStyleOf, planGraphics } from './plan.js';
import { formatLength, formatDimension } from './units.js';
import { roofGeometry } from './build3d.js';
import { roofHeightAt } from './roof.js';
import { levelElevation } from './model.js';
import { systemOf } from './mep.js';
import { coordinatesAt, elevationFrom } from './coords.js';

const P = (pc, mm) => mm * pc.scale;

export const ANNOTATION_KINDS = ['image', 'angularDim', 'radialDim', 'spot', 'revisionCloud', 'insulation', 'detailItem', 'detailArc', 'symbol', 'colorLegend', 'legendComponent'];

/** Draw an annotation; returns false when the kind is not one of these. */
export function annotationGraphics(pc, el, b) {
  if (el.viewId !== pc.view.id) return true;
  switch (el.kind) {
    case 'angularDim':
      drawAngular(pc, el, b);
      return true;
    case 'radialDim':
      drawRadial(pc, el, b);
      return true;
    case 'spot':
      drawSpot(pc, el, b);
      return true;
    case 'revisionCloud':
      drawCloud(pc, el, b);
      return true;
    case 'insulation':
      drawInsulation(pc, el, b);
      return true;
    case 'detailItem':
      drawDetailItem(pc, el, b);
      return true;
    case 'detailArc':
      drawArc(pc, el, b);
      return true;
    case 'symbol':
      drawSymbol(pc, el, b);
      return true;
    case 'colorLegend':
      drawLegend(pc, el, b);
      return true;
    case 'legendComponent':
      drawLegendComponent(pc, el, b);
      return true;
    case 'image': {
      // The picture itself is drawn by the image renderer; this is its outline and pick area.
      const rot = ((+el.rotation || 0) * Math.PI) / 180;
      const box = [
        [0, 0],
        [+el.w || 1000, 0],
        [+el.w || 1000, +el.h || 1000],
        [0, +el.h || 1000],
      ].map((p) => add(el.at, rotate(p, rot)));
      b.poly(box, true, W.thin, 0, INK(35));
      b.pick(box);
      return true;
    }
    default:
      return false;
  }
}

// Legend components ------------------------------------------------------------------------------

const LAYERED = new Set(['wallType', 'floorType', 'roofType', 'ceilingType']);

/** Size of a legend component in model millimetres (for placement and picking). */
export function legendComponentSize(doc, el) {
  const type = doc.get(el.typeId);
  if (!type) return [1000, 300];
  if (LAYERED.has(type.kind)) return [+el.length || 1200, (type.layers || []).reduce((s, l) => s + (+l.thickness || 0), 0) || 200];
  if (type.kind === 'doorType' || type.kind === 'windowType') return [(+type.width || 900) + 600, (+type.width || 900) + 400];
  return [+type.width || 600, +type.depth || +type.width || 600];
}

function drawLegendComponent(pc, el, b) {
  const doc = pc.doc;
  const type = doc.get(el.typeId);
  const at = el.at;
  if (!type) return;
  const [w, hgt] = legendComponentSize(doc, el);
  if (LAYERED.has(type.kind)) {
    // Layers stacked from the top (exterior or finish face) down.
    let y = at[1] + hgt / 2;
    for (const l of type.layers || []) {
      const t = +l.thickness || 0;
      const mat = doc.get(l.materialId);
      const strip = [
        [at[0] - w / 2, y - t],
        [at[0] + w / 2, y - t],
        [at[0] + w / 2, y],
        [at[0] - w / 2, y],
      ];
      const n = parseInt(String(mat?.color || '#c8c8c8').slice(1, 7), 16) || 0;
      b.fill(strip, [], [(n >> 16) & 255, (n >> 8) & 255, n & 255, 90], PATTERN[mat?.cut] ?? 0);
      b.line(strip[0], strip[1], W.thin);
      y -= t;
    }
    const box = [
      [at[0] - w / 2, at[1] - hgt / 2],
      [at[0] + w / 2, at[1] - hgt / 2],
      [at[0] + w / 2, at[1] + hgt / 2],
      [at[0] - w / 2, at[1] + hgt / 2],
    ];
    b.poly(box, true, W.cut);
    b.pick(box);
    return;
  }
  // Doors, windows, columns and components: their plan symbols, drawn with a stand-in host.
  const kind = { doorType: 'door', windowType: 'window', columnType: 'column', componentType: 'component' }[type.kind];
  if (!kind) {
    b.text(at, type.name, { size: P(pc, 2.5) });
    return;
  }
  const wallType = doc.all('wallType').find((t) => !t.curtain) || null;
  const span = (+type.width || 900) + 600;
  const host = { id: '__legend_host', kind: 'wall', typeId: wallType?.id, a: [at[0] - span / 2, at[1]], b: [at[0] + span / 2, at[1]], baseOffset: 0, height: 3000, locationLine: 'center' };
  const proxy = Object.create(doc);
  proxy.get = (id) => (id === host.id ? host : doc.get(id));
  const pc2 = { ...pc, doc: proxy, cutZ: 1200, bottomZ: -1, topZ: 1e6, ceiling: false, level: null };
  let item;
  if (kind === 'door' || kind === 'window') {
    item = { id: '__legend_item', kind, typeId: type.id, hostId: host.id, t: span / 2 };
    const half = (wallType?.layers || []).reduce((s, l) => s + (+l.thickness || 0), 0) / 2 || 100;
    const ow = +type.width || 900;
    for (const sy of [-1, 1]) {
      b.line([at[0] - span / 2, at[1] + sy * half], [at[0] - ow / 2, at[1] + sy * half], W.cut);
      b.line([at[0] + ow / 2, at[1] + sy * half], [at[0] + span / 2, at[1] + sy * half], W.cut);
    }
    b.line([at[0] - span / 2, at[1] - half], [at[0] - span / 2, at[1] + half], W.thin);
    b.line([at[0] + span / 2, at[1] - half], [at[0] + span / 2, at[1] + half], W.thin);
  } else item = { id: '__legend_item', kind, typeId: type.id, levelId: null, at, rotation: 0, height: 3000 };
  const g = planGraphics(pc2, item);
  if (g) {
    b.lines.push(...g.lines);
    b.fills.push(...g.fills);
    b.texts.push(...g.texts);
  }
  b.pick([
    [at[0] - w / 2, at[1] - hgt / 2],
    [at[0] + w / 2, at[1] - hgt / 2],
    [at[0] + w / 2, at[1] + hgt / 2],
    [at[0] - w / 2, at[1] + hgt / 2],
  ]);
}

/** An open arrowhead at `tip` pointing along `dir`. */
export function arrowHead(b, tip, dir, size, filled = true) {
  const d = norm(dir);
  const n = perp(d);
  const base = sub(tip, scale(d, size));
  const pts = [add(base, scale(n, size * 0.32)), tip, add(base, scale(n, -size * 0.32))];
  if (filled) b.fill([...pts], [], INK(255));
  b.poly(pts, filled, W.thin);
}

function pickBand(b, a, c, pad) {
  const d = norm(sub(c, a));
  const n = perp(d);
  b.pick([add(a, scale(n, -pad)), add(c, scale(n, -pad)), add(c, scale(n, pad)), add(a, scale(n, pad))]);
}

// Dimensions -----------------------------------------------------------------------------------

function drawAngular(pc, el, b) {
  const { c, r } = el;
  let a1 = el.a1;
  while (a1 < el.a0) a1 += Math.PI * 2;
  const sweep = a1 - el.a0;
  const pts = arcPoints(c, r, el.a0, a1, Math.PI / 48);
  b.poly(pts, false, W.thin);
  // Witness lines from near the centre out past the arc.
  const ext = P(pc, 2);
  for (const a of [el.a0, a1]) {
    const u = [Math.cos(a), Math.sin(a)];
    b.line(add(c, scale(u, Math.max(0, r - ext * 4))), add(c, scale(u, r + ext)), W.thin);
  }
  const ah = P(pc, 2.2);
  if (r * sweep > ah * 3) {
    arrowHead(b, pts[0], sub(pts[0], pts[1]), ah);
    arrowHead(b, pts.at(-1), sub(pts.at(-1), pts.at(-2)), ah);
  }
  const am = el.a0 + sweep / 2;
  const tp = add(c, scale([Math.cos(am), Math.sin(am)], r + P(pc, 2.6)));
  const deg = (sweep * 180) / Math.PI;
  b.text(tp, `${Math.round(deg * 100) / 100}°`, { size: P(pc, 2.5), rot: readableAngle(am - Math.PI / 2), mask: true });
  b.pick(arcPoints(c, r + P(pc, 4), el.a0, a1, Math.PI / 24).concat(arcPoints(c, Math.max(1, r - P(pc, 2)), a1, el.a0, Math.PI / 24)));
}

/** Centre and radius of what a radial dimension measures (it follows its target). */
export function radialTarget(doc, el) {
  const t = el.targetId ? doc.get(el.targetId) : null;
  if (t?.kind === 'detailArc') return { c: t.c, r: t.r, a0: t.a0 ?? 0, a1: t.a1 ?? Math.PI * 2 };
  if (t?.kind === 'column') {
    const type = doc.get(t.typeId);
    if (type?.shape === 'round') return { c: t.at, r: (+type.width || 450) / 2 };
  }
  return { c: el.c, r: el.r };
}

/** Arc length: a dimension arc concentric with the measured arc, its length written along it. */
function drawArcLength(pc, el, b, { c, r, a0, a1 }) {
  const R = Math.max(r * 0.2, r + (+el.offset || P(pc, 8)));
  const sweep = Math.abs(a1 - a0) || Math.PI * 2;
  const start = Math.min(a0, a1);
  const pts = arcPoints(c, R, start, start + sweep, Math.PI / 48);
  b.poly(pts, false, W.thin);
  const tick = P(pc, 1.4);
  for (const a of [start, start + sweep]) {
    const u = [Math.cos(a), Math.sin(a)];
    // Extension line from the arc out past the dimension arc, and a slash tick.
    b.line(add(c, scale(u, r + Math.sign(R - r) * P(pc, 1.5))), add(c, scale(u, R + Math.sign(R - r) * P(pc, 2))), W.thin);
    const q = add(c, scale(u, R));
    const t = [-u[1], u[0]];
    const diag = norm(add(u, t));
    b.line(add(q, scale(diag, -tick)), add(q, scale(diag, tick)), W.medium);
  }
  const am = start + sweep / 2;
  const um = [Math.cos(am), Math.sin(am)];
  const ang = readableAngle(am - Math.PI / 2);
  b.text(add(c, scale(um, R + P(pc, 2.2))), `? ${formatDimension(r * sweep, pc.units)}`, { size: P(pc, 2.5), rot: ang, mask: true });
  for (let i = 0; i + 1 < pts.length; i++) pickBand(b, pts[i], pts[i + 1], P(pc, 2));
}

function drawRadial(pc, el, b) {
  const target = radialTarget(pc.doc, el);
  if (el.arcLength && target.a0 != null) return drawArcLength(pc, el, b, target);
  const { c, r } = target;
  const u = [Math.cos(el.angle || 0), Math.sin(el.angle || 0)];
  const tip = add(c, scale(u, r));
  const tail = el.diameter ? sub(c, scale(u, r)) : c;
  const over = add(tip, scale(u, P(pc, 6)));
  b.line(tail, over, W.thin);
  const ah = P(pc, 2.2);
  arrowHead(b, tip, u, ah);
  if (el.diameter) arrowHead(b, tail, scale(u, -1), ah);
  else b.circle(c, P(pc, 0.6), W.thin);
  const label = `${el.diameter ? '⌀' : 'R'} ${formatDimension(el.diameter ? r * 2 : r, pc.units)}`;
  const ang = readableAngle(angleOf(u));
  b.text(add(mid(tail, over), scale(rotate([0, 1], ang), P(pc, 1.8))), label, { size: P(pc, 2.5), rot: ang, mask: true });
  pickBand(b, tail, over, P(pc, 2));
}

// Spot dimensions ---------------------------------------------------------------------------

/** Elevation of the top of the model at a plan point (floors, roofs, else the level). */
export function spotElevationAt(doc, view, p) {
  let best = null;
  const levelZ = levelElevation(doc, view.levelId);
  for (const f of doc.all('floor')) {
    if (!f.boundary || !pointInPolygon(p, f.boundary) || (f.holes || []).some((h) => pointInPolygon(p, h))) continue;
    const z = levelElevation(doc, f.levelId) + (+f.offset || 0);
    if (z <= levelZ + 1 && (best == null || z > best)) best = z;
  }
  for (const r of doc.all('roof')) {
    if (!r.boundary || !pointInPolygon(p, r.boundary)) continue;
    const g = roofGeometry(doc, r);
    const z = g.base + (g.planes.length ? roofHeightAt(g.planes, p) : 0) + g.th;
    if (best == null || (r.levelId === view.levelId && z > best)) best = z;
  }
  return best ?? levelZ;
}

/** Downhill direction and slope (rise/run) of the roof at a plan point. */
export function spotSlopeAt(doc, p) {
  for (const r of doc.all('roof')) {
    if (!r.boundary || !pointInPolygon(p, r.boundary)) continue;
    const g = roofGeometry(doc, r);
    let best = null;
    for (const pl of g.planes) {
      const h = pl.k * ((p[0] - pl.p[0]) * pl.m[0] + (p[1] - pl.p[1]) * pl.m[1]);
      if (!best || h < best.h) best = { h, pl };
    }
    if (best) return { dir: scale(best.pl.m, -1), k: best.pl.k, deg: best.pl.slope };
    return { dir: [1, 0], k: 0, deg: 0 };
  }
  return null;
}

function spotLabel(pc, el) {
  const doc = pc.doc;
  const units = pc.units;
  if (el.mode === 'coordinate') {
    // Elevations and sections have no plan position to report.
    if (pc.elevationView) return '';
    const c = coordinatesAt(doc, el.at, el.origin || 'survey');
    return `N ${formatLength(c.n, units)}\nE ${formatLength(c.e, units)}`;
  }
  if (el.mode === 'slope') {
    const s = pc.elevationView ? null : spotSlopeAt(doc, el.at);
    if (!s) return '';
    return s.deg ? `${Math.round(s.deg * 10) / 10}°` : 'Flat';
  }
  const z = pc.elevationView ? el.at[1] : spotElevationAt(doc, pc.view, el.at);
  const v = elevationFrom(doc, z, el.origin || 'project');
  if (Math.abs(v) < 0.5) return `±${formatLength(0, units)}`;
  return `${v > 0 ? '+' : ''}${formatLength(v, units)}`;
}

function drawSpot(pc, el, b) {
  const sz = P(pc, 2.5);
  const at = el.at;
  if (el.mode === 'slope') {
    const s = pc.elevationView ? null : spotSlopeAt(pc.doc, at);
    const dir = s ? s.dir : [1, 0];
    const L = P(pc, 12);
    const a0 = sub(at, scale(dir, L / 2));
    const a1 = add(at, scale(dir, L / 2));
    b.line(a0, a1, W.thin);
    arrowHead(b, a1, dir, P(pc, 2.2));
    const ang = readableAngle(angleOf(dir));
    b.text(add(at, scale(rotate([0, 1], ang), sz * 0.9)), spotLabel(pc, el), { size: sz, rot: ang, mask: true });
    pickBand(b, a0, a1, sz);
    return;
  }
  const leader = el.leader || add(at, [P(pc, 6), P(pc, 6)]);
  const right = leader[0] >= at[0];
  if (el.mode === 'coordinate') {
    const s = P(pc, 1.6);
    b.line(add(at, [-s, 0]), add(at, [s, 0]), W.thin);
    b.line(add(at, [0, -s]), add(at, [0, s]), W.thin);
    b.circle(at, s * 0.6, W.thin);
  } else {
    // A small triangle pointing at the spot.
    const t = P(pc, 1.6);
    b.fill([at, add(at, [-t * 0.8, t * 1.3]), add(at, [t * 0.8, t * 1.3])], [], INK(255));
  }
  const shelf = add(leader, [right ? P(pc, 14) : -P(pc, 14), 0]);
  b.line(at, leader, W.thin);
  b.line(leader, shelf, W.thin);
  const label = spotLabel(pc, el);
  const lines = label.split('\n');
  const tx = right ? leader[0] + P(pc, 1) : shelf[0] + P(pc, 1);
  lines.forEach((ln, i) => b.text([tx, leader[1] + sz * (0.75 + (lines.length - 1 - i) * 1.3)], ln, { size: sz, align: 'left' }));
  const bb = bbox([at, leader, shelf, [tx, leader[1] + sz * (1.3 * lines.length + 0.5)]]);
  b.pick([
    [bb.x0, bb.y0],
    [bb.x1, bb.y0],
    [bb.x1, bb.y1],
    [bb.x0, bb.y1],
  ]);
}

// Clouds, insulation, items and arcs ---------------------------------------------------------------

/** Scalloped outline of a revision cloud: arcs along each edge, bulging outward. */
export function cloudPoints(boundary, arc) {
  const out = [];
  // Walking a counterclockwise outline, a semicircle swept counterclockwise
  // over each chord bulges to the right of the edge, which is the outside.
  const sweep = signed(boundary) > 0 ? Math.PI : -Math.PI;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i];
    const c = boundary[(i + 1) % boundary.length];
    const L = dist(a, c);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.round(L / arc));
    const d = norm(sub(c, a));
    for (let k = 0; k < n; k++) {
      const p0 = add(a, scale(d, (L * k) / n));
      const m = add(a, scale(d, (L * (k + 0.5)) / n));
      const start = angleOf(sub(p0, m));
      const pts = arcPoints(m, L / n / 2, start, start + sweep, Math.PI / 10);
      out.push(...pts.slice(0, -1));
    }
  }
  return out;
}

function signed(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    s += a[0] * c[1] - c[0] * a[1];
  }
  return s / 2;
}

function drawCloud(pc, el, b) {
  if (!el.boundary || el.boundary.length < 3) return;
  const pts = cloudPoints(el.boundary, P(pc, 6));
  b.poly(pts, true, W.medium);
  b.pick(el.boundary);
  const rev = el.revisionId ? pc.doc.get(el.revisionId) : null;
  if (rev && el.showTag !== false) {
    // A small triangle with the revision number at the cloud's first corner.
    const at = add(el.tagAt || el.boundary[0], [P(pc, 2), P(pc, 2)]);
    const r = P(pc, 2.6);
    const tri = [add(at, [0, r]), add(at, [-r * 0.9, -r * 0.55]), add(at, [r * 0.9, -r * 0.55])];
    b.fill(tri, [], BG);
    b.poly(tri, true, W.thin);
    b.text(add(at, [0, -r * 0.1]), String(rev.number ?? rev.seq ?? ''), { size: P(pc, 2) });
  }
}

function drawInsulation(pc, el, b) {
  const L = dist(el.a, el.b);
  if (L < 1) return;
  const d = norm(sub(el.b, el.a));
  const n = perp(d);
  const w = Math.max(10, +el.width || 100);
  // Batt symbol: a loop for every insulation width along the run.
  const step = w / 2;
  const count = Math.max(1, Math.round(L / step));
  const s = L / count;
  const pts = [];
  for (let i = 0; i <= count * 8; i++) {
    const t = (i / 8) * s;
    const phase = (i % 16) / 16;
    const y = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5) * w - w / 2;
    pts.push(add(add(el.a, scale(d, t)), scale(n, y)));
  }
  b.poly(pts, false, W.thin);
  b.line(add(el.a, scale(n, -w / 2)), add(el.b, scale(n, -w / 2)), W.thin, 2);
  b.line(add(el.a, scale(n, w / 2)), add(el.b, scale(n, w / 2)), W.thin, 2);
  pickBand(b, el.a, el.b, w / 2);
}

/** Detail item families: outline loops in a unit frame of width w and height h. */
export const DETAIL_FAMILIES = [
  { value: 'blocking', label: 'Wood Blocking', w: 38, h: 140 },
  { value: 'lumber', label: 'Dimension Lumber', w: 38, h: 235 },
  { value: 'steelI', label: 'Steel I Section', w: 150, h: 300 },
  { value: 'steelAngle', label: 'Steel Angle', w: 75, h: 75 },
  { value: 'cmu', label: 'Concrete Block', w: 190, h: 190 },
  { value: 'brick', label: 'Brick', w: 90, h: 57 },
  { value: 'board', label: 'Rigid Insulation', w: 50, h: 600 },
  { value: 'breakLine', label: 'Break Line', w: 600, h: 60 },
  { value: 'anchor', label: 'Anchor Bolt', w: 16, h: 300 },
];

function drawDetailItem(pc, el, b) {
  const w = +el.w || 100;
  const hh = +el.h || 100;
  const rot = ((+el.rotation || 0) * Math.PI) / 180;
  const T = (p) => add(el.at, rotate(p, rot));
  const box = [
    [-w / 2, -hh / 2],
    [w / 2, -hh / 2],
    [w / 2, hh / 2],
    [-w / 2, hh / 2],
  ].map(T);
  switch (el.family) {
    case 'blocking':
    case 'lumber':
      b.fill(box, [], BG);
      b.poly(box, true, W.medium);
      b.line(box[0], box[2], W.thin);
      if (el.family === 'blocking') b.line(box[1], box[3], W.thin);
      break;
    case 'steelI': {
      const tf = Math.max(4, hh * 0.06);
      const tw = Math.max(3, w * 0.05);
      const shape = [
        [-w / 2, -hh / 2],
        [w / 2, -hh / 2],
        [w / 2, -hh / 2 + tf],
        [tw / 2, -hh / 2 + tf],
        [tw / 2, hh / 2 - tf],
        [w / 2, hh / 2 - tf],
        [w / 2, hh / 2],
        [-w / 2, hh / 2],
        [-w / 2, hh / 2 - tf],
        [-tw / 2, hh / 2 - tf],
        [-tw / 2, -hh / 2 + tf],
        [-w / 2, -hh / 2 + tf],
      ].map(T);
      b.fill(shape, [], INK(200));
      b.poly(shape, true, W.medium);
      break;
    }
    case 'steelAngle': {
      const t = Math.max(4, w * 0.1);
      const shape = [
        [-w / 2, -hh / 2],
        [w / 2, -hh / 2],
        [w / 2, -hh / 2 + t],
        [-w / 2 + t, -hh / 2 + t],
        [-w / 2 + t, hh / 2],
        [-w / 2, hh / 2],
      ].map(T);
      b.fill(shape, [], INK(200));
      b.poly(shape, true, W.medium);
      break;
    }
    case 'cmu': {
      b.fill(box, [], INK(16), PATTERN.diag);
      b.poly(box, true, W.medium);
      const cw = w * 0.3;
      for (const sx of [-1, 1]) {
        const cell = [
          [sx * w * 0.25 - cw / 2, -hh * 0.3],
          [sx * w * 0.25 + cw / 2, -hh * 0.3],
          [sx * w * 0.25 + cw / 2, hh * 0.3],
          [sx * w * 0.25 - cw / 2, hh * 0.3],
        ].map(T);
        b.fill(cell, [], BG);
        b.poly(cell, true, W.thin);
      }
      break;
    }
    case 'brick':
      b.fill(box, [], INK(16), PATTERN.brick);
      b.poly(box, true, W.medium);
      break;
    case 'board':
      b.fill(box, [], INK(14), PATTERN.cross);
      b.poly(box, true, W.medium);
      break;
    case 'anchor': {
      const r = w / 2;
      b.poly([T([-r, hh / 2]), T([-r, -hh / 2 + r * 4]), T([-r * 4, -hh / 2])], false, W.medium);
      b.poly([T([r, hh / 2]), T([r, -hh / 2 + r * 4]), T([-r * 2, -hh / 2 - r])], false, W.medium);
      b.poly(box, true, W.thin, 0, INK(0));
      break;
    }
    case 'breakLine': {
      // Straight run with a sharp zigzag in the middle; the box masks what is behind.
      b.fill(box, [], BG);
      const z = hh / 2;
      b.poly([T([-w / 2, 0]), T([-z * 0.8, 0]), T([-z * 0.3, z]), T([z * 0.3, -z]), T([z * 0.8, 0]), T([w / 2, 0])], false, W.thin);
      break;
    }
    default:
      b.poly(box, true, W.medium);
  }
  b.pick(box);
}

function drawArc(pc, el, b) {
  const [w, d, col] = lineStyleOf(pc.doc, el.style, 'medium');
  const full = Math.abs((el.a1 ?? Math.PI * 2) - (el.a0 ?? 0)) >= Math.PI * 2 - 1e-6;
  if (full) b.circle(el.c, el.r, w, d, col);
  else b.arc(el.c, el.r, el.a0, el.a1, w, d, col);
  const pad = Math.max(P(pc, 1), 20);
  const outer = full ? arcPoints(el.c, el.r + pad, 0, Math.PI * 2, Math.PI / 24) : arcPoints(el.c, el.r + pad, el.a0, el.a1, Math.PI / 24);
  const inner = full ? [] : arcPoints(el.c, Math.max(1, el.r - pad), el.a1, el.a0, Math.PI / 24);
  if (full) {
    b.pick(outer);
  } else b.pick(outer.concat(inner));
}

// Symbols and legends -----------------------------------------------------------------------------

function drawSymbol(pc, el, b) {
  const rot = ((+el.rotation || 0) * Math.PI) / 180;
  const T = (p) => add(el.at, rotate(p, rot));
  const s = P(pc, +el.size || 1);
  if (el.family === 'north') {
    const r = 6 * s;
    b.circle(el.at, r, W.thin);
    const tri = [T([0, r * 1.15]), T([-r * 0.45, -r * 0.6]), T([0, -r * 0.25])];
    const tri2 = [T([0, r * 1.15]), T([r * 0.45, -r * 0.6]), T([0, -r * 0.25])];
    b.fill(tri, [], INK(255));
    b.poly(tri, true, W.thin);
    b.poly(tri2, true, W.thin);
    b.text(T([0, r * 1.15 + 2.6 * s]), 'N', { size: 3 * s, rot: readableAngle(rot), bold: true });
    b.pick(arcPoints(el.at, r * 1.4, 0, Math.PI * 2, Math.PI / 12));
    return;
  }
  if (el.family === 'scale') {
    // Graphic scale: alternating blocks of a round model length.
    const imp = pc.units.system === 'imperial';
    const seg = imp ? 304.8 * (pc.scale >= 96 ? 4 : 1) : pc.scale >= 100 ? 1000 : 500;
    const n = 4;
    const hgt = 1.6 * s;
    for (let i = 0; i < n; i++) {
      const box = [T([i * seg, 0]), T([(i + 1) * seg, 0]), T([(i + 1) * seg, hgt]), T([i * seg, hgt])];
      if (i % 2 === 0) b.fill(box, [], INK(255));
      b.poly(box, true, W.thin);
      b.text(T([i * seg, -2.2 * s]), formatLength(i * seg, pc.units), { size: 2 * s, rot: readableAngle(rot) });
    }
    b.text(T([n * seg, -2.2 * s]), formatLength(n * seg, pc.units), { size: 2 * s, rot: readableAngle(rot) });
    b.pick([T([0, -4 * s]), T([n * seg, -4 * s]), T([n * seg, hgt + s]), T([0, hgt + s])]);
    return;
  }
  if (el.family === 'span') {
    // Span direction: a long double-headed arrow with a diamond in the middle.
    const L = 14 * s;
    const a = T([-L, 0]);
    const c = T([L, 0]);
    b.line(a, c, W.medium);
    arrowHead(b, c, sub(c, a), 2.6 * s);
    arrowHead(b, a, sub(a, c), 2.6 * s);
    const dm = [T([0, 2 * s]), T([-2 * s, 0]), T([0, -2 * s]), T([2 * s, 0])];
    b.fill(dm, [], BG);
    b.poly(dm, true, W.thin);
    pickBand(b, a, c, 2.5 * s);
    return;
  }
  b.circle(el.at, 4 * s, W.thin);
  b.pick(arcPoints(el.at, 4 * s, 0, Math.PI * 2, Math.PI / 12));
}

/** Values the rooms of a view are coloured by, with their colours. */
export function legendEntries(doc, view, source = 'rooms') {
  const seen = new Map();
  if (source === 'ducts' || source === 'pipes') {
    const kinds = source === 'ducts' ? ['duct'] : ['pipe'];
    for (const r of doc.all(...kinds)) {
      if (r.levelId !== view.levelId) continue;
      const s = systemOf(r);
      if (!seen.has(s.label)) seen.set(s.label, hexColor(s.color));
    }
    return [...seen].sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (source === 'zones') {
    for (const sp of doc.all('space')) {
      if (sp.levelId !== view.levelId) continue;
      const z = doc.get(sp.zoneId);
      const label = z?.name || 'No zone';
      if (!seen.has(label)) seen.set(label, hexColor(z?.color || '#7a8aa0'));
    }
    return [...seen].sort((a, b) => a[0].localeCompare(b[0]));
  }
  const by = view.roomFillBy || 'name';
  for (const r of doc.all('room')) {
    if (r.levelId !== view.levelId) continue;
    const v = String(r[by] || '(none)');
    if (!seen.has(v)) seen.set(v, roomColorFor(v));
  }
  return [...seen].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
}

const FILL_BY_LABEL = { name: 'Name', department: 'Department', occupant: 'Occupant', floorFinish: 'Floor Finish', number: 'Number' };

const LEGEND_TITLE = { ducts: 'Duct Systems', pipes: 'Pipe Systems', zones: 'Zones' };

function hexColor(hex) {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawLegend(pc, el, b) {
  const entries = legendEntries(pc.doc, pc.view, el.source || 'rooms');
  const sz = P(pc, 2.5);
  const row = sz * 1.8;
  const sw = sz * 2.2;
  const at = el.at;
  b.text([at[0], at[1] + row * 0.6], LEGEND_TITLE[el.source] || `Rooms by ${FILL_BY_LABEL[pc.view.roomFillBy || 'name'] || 'Name'}`, { size: sz * 1.1, align: 'left', bold: true });
  let maxLen = 10;
  entries.forEach(([label, color], i) => {
    const y = at[1] - i * row - row * 0.4;
    const box = [
      [at[0], y - sz * 0.6],
      [at[0] + sw, y - sz * 0.6],
      [at[0] + sw, y + sz * 0.6],
      [at[0], y + sz * 0.6],
    ];
    b.fill(box, [], [color[0], color[1], color[2], 220]);
    b.poly(box, true, W.thin);
    b.text([at[0] + sw + sz * 0.8, y], label, { size: sz, align: 'left' });
    maxLen = Math.max(maxLen, label.length);
  });
  const width = sw + sz * (1 + maxLen * 0.62);
  const bottom = at[1] - Math.max(1, entries.length) * row - row * 0.2;
  b.pick([
    [at[0], bottom],
    [at[0] + width, bottom],
    [at[0] + width, at[1] + row * 1.2],
    [at[0], at[1] + row * 1.2],
  ]);
  if (!entries.length) b.text([at[0], at[1] - row * 0.4], 'No rooms in this view', { size: sz, align: 'left', color: INK(140) });
}

/** Where a text note's leader starts: the side of the text nearest the tip. */
export function leaderStart(el, tip, width, height) {
  const rot = ((+el.rotation || 0) * Math.PI) / 180;
  const x0 = el.align === 'center' ? -width / 2 : el.align === 'right' ? -width : 0;
  const local = rotate(sub(tip, el.at), -rot);
  const x = local[0] < x0 + width / 2 ? x0 - width * 0.02 : x0 + width * 1.02;
  void height;
  return add(el.at, rotate([x, 0], rot));
}
