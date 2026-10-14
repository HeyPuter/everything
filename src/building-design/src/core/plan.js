/**
 * Plan graphics: what each element draws in a floor or ceiling plan, as
 * resolution-independent primitives (line segments with a weight class and
 * dash pattern, filled polygons with an optional hatch pattern, and text).
 * Annotation sizes are given in paper millimetres and scaled by the view
 * scale here, so a view's graphics depend on its scale and detail level.
 *
 * Colours: null means the theme's ink colour; INK(a) is ink at alpha a;
 * BG is the canvas colour (used to mask what lies underneath).
 */
import { add, sub, scale, dot, norm, perp, len, dist, lerp, arcPoints, rotate, pointInPolygon, bbox, mid, angleOf } from './geom.js';
import { verticalExtent, openingSize, levelElevation, wallAxis } from './model.js';
import { axisParam, facePoint, hubsOf } from './walls.js';
import { wallOpenings, keepIntervals, splitByCuts, roofGeometry, curtainGrid } from './build3d.js';
import { stairFlights, flightOutline, flightPoint } from './stairs.js';
import { buildFamily } from './families.js';
import { Frame } from './mesh.js';
import { categoryOf } from './catalog.js';
import { formatDimension, formatArea } from './units.js';

export const INK = (a = 255) => [-1, -1, -1, a];
export const BG = [-2, -2, -2, 255];
export const RED = [214, 54, 54, 255];

/** Hatch patterns understood by the renderer. */
export const PATTERN = { none: 0, diag: 1, cross: 2, concrete: 3, insulation: 4, brick: 5, wood: 6, earth: 7, solid: 8 };

/** Line weight classes (renderer maps them to pixels). */
export const W = { thin: 1, light: 2, medium: 3, cut: 4, heavy: 5 };

export class PlanBuilder {
  constructor() {
    this.lines = [];
    this.fills = [];
    this.texts = [];
    this.picks = [];
  }

  get empty() {
    return !this.lines.length && !this.fills.length && !this.texts.length && !this.picks.length;
  }

  line(a, b, w = 1, dash = 0, color = null) {
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return;
    this.lines.push({ a, b, w, d: dash, c: color });
  }

  poly(pts, closed = false, w = 1, dash = 0, color = null) {
    for (let i = 0; i + 1 < pts.length; i++) this.line(pts[i], pts[i + 1], w, dash, color);
    if (closed && pts.length > 2) this.line(pts.at(-1), pts[0], w, dash, color);
  }

  arc(c, r, a0, a1, w = 1, dash = 0, color = null) {
    this.poly(arcPoints(c, r, a0, a1, Math.PI / 32), false, w, dash, color);
  }

  circle(c, r, w = 1, dash = 0, color = null) {
    this.poly(arcPoints(c, r, 0, Math.PI * 2, Math.PI / 24).slice(0, -1), true, w, dash, color);
  }

  fill(poly, holes = [], color = INK(110), pattern = 0) {
    if (poly.length < 3) return;
    this.fills.push({ poly, holes, color, pattern });
  }

  pick(poly) {
    this.picks.push(poly);
  }

  /** size and offsets are model millimetres (already scaled). */
  text(at, text, { size, rot = 0, align = 'center', baseline = 'middle', color = null, bold = false, mask = false } = {}) {
    if (text == null || text === '') return;
    this.texts.push({ at, text: String(text), size, rot, align, baseline, color, bold, mask });
  }

  /** Bounding box of everything drawn. */
  bounds() {
    const pts = [];
    for (const l of this.lines) pts.push(l.a, l.b);
    for (const f of this.fills) for (const p of f.poly) pts.push(p);
    for (const p of this.picks) for (const q of p) pts.push(q);
    for (const t of this.texts) {
      const w = t.size * 0.62 * Math.max(...String(t.text).split('\n').map((s) => s.length));
      const h = t.size * String(t.text).split('\n').length * 1.3;
      pts.push([t.at[0] - w, t.at[1] - h], [t.at[0] + w, t.at[1] + h]);
    }
    return pts.length ? bbox(pts) : null;
  }
}

/**
 * Plan context for one view:
 * { doc, view, level, cutZ, bottomZ, topZ, scale, detail, walls, rooms, ceiling }
 */
export function planContext(doc, view, walls, rooms) {
  const level = doc.get(view.levelId);
  const elev = level?.elevation ?? 0;
  const above = level ? doc.levelAbove(level.id) : null;
  return {
    doc,
    view,
    level,
    walls,
    rooms,
    ceiling: view.kind === 'ceilingPlan',
    cutZ: elev + (+view.cutHeight || 1200),
    bottomZ: elev + (+view.viewDepth || 0),
    topZ: above ? above.elevation : elev + 4000,
    scale: +view.scale || 100,
    detail: view.detail || 'medium',
    units: doc.units,
  };
}

/** Paper millimetres to model millimetres in this view. */
const P = (pc, mm) => mm * pc.scale;

export function materialPattern(mat) {
  return PATTERN[mat?.cut] ?? 0;
}

function tint(hex, a) {
  const n = parseInt(String(hex || '#c8c8c8').slice(1, 7), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** Is this element hidden in the view by category or by element? */
export function hiddenInView(doc, view, el) {
  if (view.hiddenIds?.includes(el.id)) return true;
  const cat = categoryOf(el, doc);
  return !!(cat && view.hiddenCats?.includes(cat));
}

/** Plan graphics for one element (or view marker) in a plan view, or null. */
export function planGraphics(pc, el) {
  const b = new PlanBuilder();
  switch (el.kind) {
    case 'wall':
      planWall(pc, el, b);
      break;
    case 'door':
      if (!pc.ceiling) planDoor(pc, el, b);
      break;
    case 'window':
      if (!pc.ceiling) planWindow(pc, el, b);
      break;
    case 'floor':
      if (!pc.ceiling) planFloor(pc, el, b);
      break;
    case 'ceiling':
      if (pc.ceiling) planCeiling(pc, el, b);
      break;
    case 'roof':
      planRoof(pc, el, b);
      break;
    case 'column':
      planColumn(pc, el, b);
      break;
    case 'beam':
      planBeam(pc, el, b);
      break;
    case 'stair':
      planStair(pc, el, b);
      break;
    case 'railing':
      planRailing(pc, el, b);
      break;
    case 'component':
      planComponent(pc, el, b);
      break;
    case 'room':
      planRoom(pc, el, b);
      break;
    case 'roomSeparator':
      if (el.levelId === pc.view.levelId) b.line(el.a, el.b, W.thin, 0, null);
      break;
    case 'grid':
      planGrid(pc, el, b);
      break;
    case 'dimension':
      if (el.viewId === pc.view.id) drawDimension(pc, el, b);
      break;
    case 'text':
      if (el.viewId === pc.view.id) drawText(pc, el, b);
      break;
    case 'tag':
      if (el.viewId === pc.view.id) drawTag(pc, el, b);
      break;
    case 'detailLine':
      if (el.viewId === pc.view.id) drawDetailLine(el, b);
      break;
    case 'section':
      planSectionMarker(pc, el, b);
      break;
    case 'elevation':
      planElevationMarker(pc, el, b);
      break;
    default:
      return null;
  }
  return b.empty ? null : b;
}

// Walls ----------------------------------------------------------------------------------

function planWall(pc, w, b) {
  const g = pc.walls.wall(w.id);
  if (!g) return;
  const { axis, base, top } = g;
  const cut = base <= pc.cutZ && top > pc.cutZ;
  if (!cut && (top < pc.bottomZ - 1 || base > pc.cutZ)) return;
  if (pc.ceiling && !cut) return;
  const doc = pc.doc;
  const type = doc.get(w.typeId);
  if (type?.curtain) return planCurtain(pc, w, g, type, b, cut);
  const uL0 = axisParam(axis, g.L0);
  const uL1 = axisParam(axis, g.L1);
  const uR0 = axisParam(axis, g.R0);
  const uR1 = axisParam(axis, g.R1);
  const lo = Math.max(uL0, uR0) + 1;
  const hi = Math.min(uL1, uR1) - 1;
  const ops = cut
    ? wallOpenings(doc, w, base, top)
        .filter((o) => o.z0 <= pc.cutZ && o.z1 > pc.cutZ)
        .map((o) => ({ ...o, u0: Math.max(o.u0, lo), u1: Math.min(o.u1, hi) }))
        .filter((o) => o.u1 - o.u0 > 1)
    : [];
  const gaps = ops.map((o) => [o.u0, o.u1]);
  const poly = [g.R0, g.R1, g.L1, g.L0];
  b.pick(poly);
  if (cut) {
    const layers = type?.layers || [];
    const T = layers.reduce((s, l) => s + (+l.thickness || 0), 0) || axis.half * 2;
    if (pc.detail === 'fine' && layers.length > 1) {
      // Layers from the exterior face inward. The exterior is the left face unless flipped.
      const extL = !w.flipped;
      const at = (f, e) => {
        const L = e === 0 ? g.L0 : g.L1;
        const R = e === 0 ? g.R0 : g.R1;
        return extL ? lerp(L, R, f) : lerp(R, L, f);
      };
      let o = 0;
      layers.forEach((layer, k) => {
        const f0 = o / T;
        o += +layer.thickness || 0;
        const f1 = o / T;
        const strip = [at(f0, 0), at(f0, 1), at(f1, 1), at(f1, 0)];
        const mat = doc.get(layer.materialId);
        for (const part of splitByCuts(strip, axis, gaps)) b.fill(part, [], tint(mat?.color, 70), materialPattern(mat));
        if (k < layers.length - 1) {
          const a0 = at(f1, 0);
          const a1 = at(f1, 1);
          const isCore = layer.function === 'structure' || layers[k + 1].function === 'structure';
          for (const [s0, s1] of keepIntervals(axisParam(axis, a0), axisParam(axis, a1), gaps)) {
            b.line(pointAt(a0, a1, axis, s0), pointAt(a0, a1, axis, s1), isCore ? W.light : W.thin);
          }
        }
      });
    } else if (pc.detail === 'medium') {
      const core = layers.find((l) => l.function === 'structure') || layers[0];
      const mat = doc.get(core?.materialId);
      const pat = materialPattern(mat);
      for (const part of splitByCuts(poly, axis, gaps)) b.fill(part, [], pat ? INK(18) : INK(90), pat || 0);
    } else {
      for (const part of splitByCuts(poly, axis, gaps)) b.fill(part, [], INK(115), 0);
    }
    // Hubs belong to the first wall (by id) that meets there.
    for (const hub of hubsOf(pc.walls.level(w.levelId), w.id)) {
      if (pc.detail === 'coarse') b.fill(hub.poly, [], INK(115));
      else b.fill(hub.poly, [], INK(pc.detail === 'medium' ? 90 : 60));
    }
  }
  const wt = cut ? W.cut : W.thin;
  const cutsL = [...g.cuts.left, ...gaps];
  const cutsR = [...g.cuts.right, ...gaps];
  for (const [s0, s1] of keepIntervals(uL0, uL1, cutsL)) b.line(facePoint(axis, s0, 1), facePoint(axis, s1, 1), wt);
  for (const [s0, s1] of keepIntervals(uR0, uR1, cutsR)) b.line(facePoint(axis, s0, -1), facePoint(axis, s1, -1), wt);
  if (g.ends[0].kind === 'free') b.line(g.L0, g.R0, wt);
  if (g.ends[1].kind === 'free') b.line(g.L1, g.R1, wt);
  if (!cut && g.ends[0].kind !== 'free' && g.ends[0].kind !== 'tee') b.line(g.L0, g.R0, W.thin);
  for (const o of ops) {
    b.line(facePoint(axis, o.u0, 1), facePoint(axis, o.u0, -1), wt);
    b.line(facePoint(axis, o.u1, 1), facePoint(axis, o.u1, -1), wt);
  }
}

function pointAt(a0, a1, axis, s) {
  const u0 = axisParam(axis, a0);
  const u1 = axisParam(axis, a1);
  const t = Math.abs(u1 - u0) < 1e-9 ? 0 : (s - u0) / (u1 - u0);
  return lerp(a0, a1, t);
}

function planCurtain(pc, w, g, type, b, cut) {
  const { axis, base, top } = g;
  const c = type.curtain || {};
  const mw = +c.mullionWidth || 50;
  const md = +c.mullionDepth || 150;
  const { nu, du } = curtainGrid(axis.length, top - base, type);
  const wt = cut ? W.medium : W.thin;
  const P0 = (u, y) => add(add(axis.a, scale(axis.dir, u)), scale(axis.n, y));
  b.line(P0(0, 0), P0(axis.length, 0), W.thin);
  b.line(P0(0, -6), P0(axis.length, -6), W.thin);
  b.line(P0(0, 6), P0(axis.length, 6), W.thin);
  for (let i = 0; i <= nu; i++) {
    const u = Math.min(axis.length - mw / 2, Math.max(mw / 2, i * du));
    const r = [P0(u - mw / 2, -md / 2), P0(u + mw / 2, -md / 2), P0(u + mw / 2, md / 2), P0(u - mw / 2, md / 2)];
    if (cut) b.fill(r, [], INK(160));
    b.poly(r, true, wt);
  }
  b.pick([P0(0, -md / 2), P0(axis.length, -md / 2), P0(axis.length, md / 2), P0(0, md / 2)]);
}

// Doors and windows -------------------------------------------------------------------------

function hosted2D(pc, el) {
  const host = pc.doc.get(el.hostId);
  if (!host || host.kind !== 'wall') return null;
  const axis = wallAxis(pc.doc, host);
  const { base, top } = verticalExtent(pc.doc, host);
  const o = add(axis.a, scale(axis.dir, el.t));
  const ext = host.flipped ? -1 : 1;
  const L = (x, y) => add(add(o, scale(axis.dir, x)), scale(axis.n, y));
  return { host, axis, base, top, o, half: axis.half, ext, L };
}

function planDoor(pc, el, b) {
  const h = hosted2D(pc, el);
  if (!h) return;
  const type = pc.doc.get(el.typeId) || {};
  const { width: Wd, height: Hd } = openingSize(pc.doc, el);
  if (!(h.base <= pc.cutZ && h.top > pc.cutZ && Hd > pc.cutZ - h.base)) return;
  const { L, half } = h;
  const fw = +type.frameWidth || 50;
  const pt = +type.thickness || 44;
  const face = el.flipFacing ? -1 : 1;
  const hand = el.flipHand ? -1 : 1;
  b.pick([L(-Wd / 2, -half), L(Wd / 2, -half), L(Wd / 2, half), L(-Wd / 2, half)]);
  // Frame jambs.
  for (const sx of [-1, 1]) {
    const x0 = (sx * Wd) / 2;
    const x1 = sx * (Wd / 2 - fw);
    b.poly([L(x0, -half), L(x1, -half), L(x1, half), L(x0, half)], true, W.light);
  }
  const fam = type.family || 'single';
  const y = face * half;
  const leaf = (hx, dirx, length) => {
    // Leaf drawn open at 90 degrees, hinged at (hx, y), with its swing arc.
    const hinge = L(hx, y);
    const tip = L(hx, y + face * length);
    const side = dirx * pt;
    b.poly([hinge, tip, L(hx + side, y + face * length), L(hx + side, y)], true, W.medium);
    const a0 = angleOf(sub(L(hx + dirx * length, y), hinge));
    const a1 = angleOf(sub(tip, hinge));
    let d = a1 - a0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    b.arc(hinge, length, a0, a0 + d, W.thin);
  };
  const inner = Wd / 2 - fw;
  switch (fam) {
    case 'double':
      leaf(-inner, 1, inner);
      leaf(inner, -1, inner);
      break;
    case 'sliding': {
      const m = 40;
      b.poly([L(-inner, -pt), L(m, -pt), L(m, 0), L(-inner, 0)], true, W.medium);
      b.poly([L(-m, 0), L(inner, 0), L(inner, pt), L(-m, pt)], true, W.medium);
      break;
    }
    case 'pocket':
      b.poly([L(-inner, -pt / 2), L(0, -pt / 2), L(0, pt / 2), L(-inner, pt / 2)], true, W.medium);
      b.poly([L(-Wd / 2 - inner, -pt / 2), L(-Wd / 2, -pt / 2), L(-Wd / 2, pt / 2), L(-Wd / 2 - inner, pt / 2)], true, W.thin, 2);
      break;
    case 'bifold': {
      const n = 4;
      const s = (2 * inner) / n;
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(L(-inner + i * s, y + face * (i % 2 ? s * 0.45 : 0)));
      b.poly(pts, false, W.medium);
      break;
    }
    case 'overhead':
      b.poly([L(-inner, y), L(inner, y), L(inner, y + face * Hd * 0.9), L(-inner, y + face * Hd * 0.9)], true, W.thin, 2);
      b.line(L(-inner, 0), L(inner, 0), W.medium);
      break;
    case 'opening':
      break;
    default:
      leaf(hand * -inner, hand, 2 * inner);
  }
}

function planWindow(pc, el, b) {
  const h = hosted2D(pc, el);
  if (!h) return;
  const type = pc.doc.get(el.typeId) || {};
  const { width: Ww, height: Hw, sill } = openingSize(pc.doc, el);
  const z0 = h.base + sill;
  const z1 = z0 + Hw;
  const { L, half } = h;
  b.pick([L(-Ww / 2, -half), L(Ww / 2, -half), L(Ww / 2, half), L(-Ww / 2, half)]);
  const ext = (el.flipFacing ? -1 : 1) * h.ext;
  if (!(z0 <= pc.cutZ && z1 > pc.cutZ)) {
    // Not cut: show the opening as hidden lines when it is above.
    if (z0 > pc.cutZ && z0 < pc.topZ) b.poly([L(-Ww / 2, -half), L(Ww / 2, -half), L(Ww / 2, half), L(-Ww / 2, half)], true, W.thin, 2);
    return;
  }
  const fd = Math.min(half * 2, +type.frameDepth || 100);
  const yc = ext * (half - fd / 2);
  b.line(L(-Ww / 2, yc - fd / 2), L(Ww / 2, yc - fd / 2), W.thin);
  b.line(L(-Ww / 2, yc + fd / 2), L(Ww / 2, yc + fd / 2), W.thin);
  b.line(L(-Ww / 2, yc), L(Ww / 2, yc), W.light);
  // Interior sill line and exterior sill.
  b.line(L(-Ww / 2, -ext * half), L(Ww / 2, -ext * half), W.thin);
  b.poly([L(-Ww / 2 - 30, ext * half), L(-Ww / 2 - 30, ext * (half + 50)), L(Ww / 2 + 30, ext * (half + 50)), L(Ww / 2 + 30, ext * half)], false, W.thin);
}

// Slabs, roofs --------------------------------------------------------------------------------

function planFloor(pc, el, b) {
  if (!el.boundary || el.boundary.length < 3) return;
  const z = levelElevation(pc.doc, el.levelId) + (+el.offset || 0);
  if (z < pc.bottomZ - 1 || z > pc.cutZ) return;
  b.poly(el.boundary, true, W.thin);
  for (const hole of el.holes || []) b.poly(hole, true, W.thin);
  b.pick(el.boundary);
}

function planCeiling(pc, el, b) {
  if (!el.boundary || el.boundary.length < 3 || el.levelId !== pc.view.levelId) return;
  b.poly(el.boundary, true, W.light);
  for (const hole of el.holes || []) b.poly(hole, true, W.light);
  b.pick(el.boundary);
  const type = pc.doc.get(el.typeId);
  const sp = +type?.pattern || 0;
  if (sp > 50) {
    const bb = bbox(el.boundary);
    for (let x = Math.ceil(bb.x0 / sp) * sp; x < bb.x1; x += sp) for (const [p, q] of clipLine([x, bb.y0 - 1], [x, bb.y1 + 1], el.boundary)) b.line(p, q, W.thin, 0, INK(140));
    for (let y = Math.ceil(bb.y0 / sp) * sp; y < bb.y1; y += sp) for (const [p, q] of clipLine([bb.x0 - 1, y], [bb.x1 + 1, y], el.boundary)) b.line(p, q, W.thin, 0, INK(140));
  }
}

/** Parts of segment pq inside a polygon. */
export function clipLine(p, q, poly) {
  const d = sub(q, p);
  const ts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const e = sub(c, a);
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) continue;
    const ap = sub(a, p);
    const t = (ap[0] * e[1] - ap[1] * e[0]) / den;
    const u = (ap[0] * d[1] - ap[1] * d[0]) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const m = lerp(p, q, (ts[i] + ts[i + 1]) / 2);
    if (pointInPolygon(m, poly)) out.push([lerp(p, q, ts[i]), lerp(p, q, ts[i + 1])]);
  }
  return out;
}

function planRoof(pc, el, b) {
  if (!el.boundary || el.boundary.length < 3 || el.levelId !== pc.view.levelId) return;
  if (pc.ceiling) return;
  const { poly, ridges } = roofGeometry(pc.doc, el);
  b.poly(poly, true, W.light);
  for (const [p, q] of ridges) b.line(p, q, W.thin);
  b.pick(poly);
}

// Structure ------------------------------------------------------------------------------------

export function columnOutline(doc, c) {
  const type = doc.get(c.typeId) || {};
  const w = +type.width || 450;
  const d = +type.depth || w;
  if (type.shape === 'round') return arcPoints(c.at, w / 2, 0, Math.PI * 2, Math.PI / 16).slice(0, -1);
  const fr = new Frame(c.at, ((+c.rotation || 0) * Math.PI) / 180);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map((p) => fr.apply(p));
}

function planColumn(pc, el, b) {
  const { base, top } = verticalExtent(pc.doc, el);
  const cut = base <= pc.cutZ && top > pc.cutZ;
  if (!cut && (top < pc.bottomZ - 1 || base > pc.cutZ)) return;
  const outline = columnOutline(pc.doc, el);
  const type = pc.doc.get(el.typeId) || {};
  const mat = pc.doc.get(type.materialId);
  if (cut) {
    const pat = pc.detail === 'coarse' ? 0 : materialPattern(mat);
    b.fill(outline, [], pat ? INK(18) : INK(140), pat);
  }
  b.poly(outline, true, cut ? W.cut : W.thin);
  b.pick(outline);
}

function planBeam(pc, el, b) {
  const type = pc.doc.get(el.typeId) || {};
  const zt = levelElevation(pc.doc, el.levelId) + (+el.offset || 0);
  const zb = zt - (+type.depth || 600);
  const above = zb > pc.cutZ && zb <= pc.topZ + 1;
  const below = zt <= pc.cutZ && zt >= pc.bottomZ - 1;
  if (!above && !below) return;
  const w = +type.width || 300;
  const dir = norm(sub(el.b, el.a));
  const n = perp(dir);
  const pts = [add(el.a, scale(n, -w / 2)), add(el.b, scale(n, -w / 2)), add(el.b, scale(n, w / 2)), add(el.a, scale(n, w / 2))];
  b.poly(pts, true, W.thin, above ? 2 : 0);
  b.line(el.a, el.b, W.thin, 3);
  b.pick(pts);
}

// Stairs and railings ---------------------------------------------------------------------------

function planStair(pc, el, b) {
  const atBase = el.levelId === pc.view.levelId;
  const atTop = el.topLevelId === pc.view.levelId;
  if ((!atBase && !atTop) || pc.ceiling) return;
  const g = stairFlights(pc.doc, el);
  const { riserHeight: rh, tread: td, width: Wd } = g;
  const walk = [];
  let stopped = false;
  for (const [k, f] of g.flights.entries()) {
    const n = f.risers;
    const sEnd = f.run;
    const S = (s, w) => flightPoint(f, Wd, s, w);
    b.pick(flightOutline(f, Wd));
    // Where the cut plane crosses this flight (in the plan of the base level).
    const local = atBase ? Math.floor((pc.cutZ - f.z0) / rh) : n;
    const sCut = local <= 0 ? -1 : local >= n ? Infinity : local * td - td * 0.4;
    for (let i = 0; i <= n - 1; i++) {
      const s = i * td;
      b.line(S(s, 0), S(s, Wd), W.thin, s > sCut ? 2 : 0);
    }
    for (const w of [0, Wd]) {
      if (sCut >= sEnd) b.line(S(0, w), S(sEnd, w), W.light);
      else if (sCut < 0) b.line(S(0, w), S(sEnd, w), W.thin, 2);
      else {
        b.line(S(0, w), S(sCut, w), W.light);
        b.line(S(sCut, w), S(sEnd, w), W.thin, 2);
      }
    }
    if (sCut >= 0 && sCut < sEnd) {
      // Break line: a slanted cut with a small zigzag.
      const p0 = S(sCut - td * 0.6, 0);
      const p1 = S(sCut + td * 0.6, Wd);
      const m = mid(p0, p1);
      const z = scale(f.dir, td * 0.3);
      const zz = scale(f.side, Wd * 0.06);
      b.poly([p0, sub(sub(m, zz), z), add(add(m, zz), z), p1], false, W.light);
    }
    // Walk line points.
    if (!stopped) {
      walk.push(S(k === 0 ? td * 0.4 : 0, Wd / 2));
      if (sCut < sEnd) {
        walk.push(S(Math.max(0, sCut - td * 0.3), Wd / 2));
        stopped = true;
      } else walk.push(S(sEnd - (k === g.flights.length - 1 ? td * 0.2 : 0), Wd / 2));
      // Through the middle of the landing to the next flight.
      if (g.landings[k] && !stopped) walk.push(add(S(sEnd, Wd / 2), scale(f.dir, Wd / 2)));
    }
  }
  for (const l of g.landings) {
    const above = atBase && l.z > pc.cutZ;
    b.poly(l.poly, true, above ? W.thin : W.light, above ? 2 : 0);
    b.pick(l.poly);
  }
  if (walk.length >= 2) {
    b.poly(walk, false, W.thin);
    b.circle(walk[0], P(pc, 0.8), W.thin);
    const tip = walk.at(-1);
    const d = norm(sub(tip, walk.at(-2)));
    const n2 = perp(d);
    const ah = P(pc, 2.2);
    b.poly([add(add(tip, scale(d, -ah)), scale(n2, ah * 0.45)), tip, add(add(tip, scale(d, -ah)), scale(n2, -ah * 0.45))], false, W.thin);
    const f0 = g.flights[0];
    b.text(add(walk[0], scale(f0.dir, -P(pc, 3))), atBase ? 'UP' : 'DN', { size: P(pc, 2.2), rot: readableAngle(angleOf(f0.dir) - Math.PI / 2) });
  }
}

function planRailing(pc, el, b) {
  if (el.levelId !== pc.view.levelId || !el.path || el.path.length < 2 || pc.ceiling) return;
  const type = pc.doc.get(el.typeId) || {};
  const r = +type.rail || 50;
  for (let i = 0; i + 1 < el.path.length; i++) {
    const a = el.path[i];
    const c = el.path[i + 1];
    const n = perp(norm(sub(c, a)));
    b.line(add(a, scale(n, r / 2)), add(c, scale(n, r / 2)), W.light);
    b.line(add(a, scale(n, -r / 2)), add(c, scale(n, -r / 2)), W.light);
    b.pick([add(a, scale(n, -r)), add(c, scale(n, -r)), add(c, scale(n, r)), add(a, scale(n, r))]);
  }
}

// Components -------------------------------------------------------------------------------------

function planComponent(pc, el, b) {
  const type = pc.doc.get(el.typeId);
  if (!type) return;
  const z = levelElevation(pc.doc, el.levelId) + (+el.offset || 0) + (+type.elevation || 0);
  if (z < pc.bottomZ - 1 || z >= pc.topZ) return;
  if (pc.ceiling && type.category !== 'lighting') return;
  const frame = new Frame(el.at, ((+el.rotation || 0) * Math.PI) / 180);
  const sym = buildFamily(type, frame, null, () => null);
  const outline = sym.outline.map((p) => frame.apply(p));
  if (sym.fillColor) b.fill(outline, [], sym.fillColor);
  else if (!sym.noFill) b.fill(outline, [], BG);
  for (const loop of sym.loops) b.poly(loop.pts.map((p) => frame.apply(p)), !!loop.closed, W.thin, loop.dash || 0);
  b.pick(outline);
}

// Rooms ------------------------------------------------------------------------------------------

function roomColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  // HSL to RGB with soft saturation.
  const s = 0.5;
  const l = 0.72;
  const k = (n) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255), 120];
}

export function roomLabel(doc, room, region) {
  const area = region ? formatArea(region.area, doc.units) : '';
  return { name: room.name || 'Room', number: room.number || '', area };
}

function planRoom(pc, el, b) {
  if (el.levelId !== pc.view.levelId) return;
  const region = pc.rooms.room(el);
  const at = el.tagAt || el.at;
  if (region) {
    if (pc.view.roomFill) b.fill(region.outer, region.holes, roomColor(el.name));
    b.pick(region.outer);
  } else {
    const s = P(pc, 1.5);
    b.line(add(el.at, [-s, -s]), add(el.at, [s, s]), W.thin, 0, RED);
    b.line(add(el.at, [-s, s]), add(el.at, [s, -s]), W.thin, 0, RED);
    b.pick([add(el.at, [-s, -s]), add(el.at, [s, -s]), add(el.at, [s, s]), add(el.at, [-s, s])]);
  }
  if (pc.view.hiddenCats?.includes('tags')) return;
  const lab = roomLabel(pc.doc, el, region);
  const sz = P(pc, 2.5);
  b.text([at[0], at[1] + sz * 0.9], lab.name.toUpperCase(), { size: sz, bold: true, mask: true });
  const second = [lab.number, region ? lab.area : 'Not enclosed'].filter(Boolean).join('   ');
  b.text([at[0], at[1] - sz * 0.6], second, { size: P(pc, 2), color: region ? null : RED, mask: true });
}

// Datums -------------------------------------------------------------------------------------------

function planGrid(pc, el, b) {
  const d = norm(sub(el.b, el.a));
  if (!len(d)) return;
  b.line(el.a, el.b, W.thin, 3);
  const r = P(pc, 4);
  const ends = el.bubbles === 'start' ? [0] : el.bubbles === 'end' ? [1] : [0, 1];
  for (const e of ends) {
    const p = e === 0 ? el.a : el.b;
    const c = add(p, scale(d, e === 0 ? -r : r));
    b.fill(arcPoints(c, r, 0, Math.PI * 2, Math.PI / 20).slice(0, -1), [], BG);
    b.circle(c, r, W.light);
    b.text(c, el.name, { size: P(pc, 3.5) });
  }
  const n = perp(d);
  const pad = P(pc, 1);
  b.pick([add(el.a, scale(n, -pad)), add(el.b, scale(n, -pad)), add(el.b, scale(n, pad)), add(el.a, scale(n, pad))]);
}

// Annotations ---------------------------------------------------------------------------------------

/** Keep text upright: angles between 90 and 270 degrees flip. */
export function readableAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x <= -Math.PI) x += Math.PI * 2;
  if (x > Math.PI / 2 + 1e-6) x -= Math.PI;
  else if (x <= -Math.PI / 2 + 1e-6) x += Math.PI;
  return x;
}

/** Current position of a dimension reference (follows walls and grids it is attached to). */
export function dimRefPoint(doc, walls, ref, dir) {
  if (!ref.id) return ref.at;
  const el = doc.get(ref.id);
  if (!el) return ref.at;
  let a;
  let d;
  if (el.kind === 'wall') {
    const ax = wallAxis(doc, el);
    if (ref.ref === 'a' || ref.ref === 'b') return ref.ref === 'a' ? el.a : el.b;
    const side = ref.ref === 'left' ? 1 : ref.ref === 'right' ? -1 : 0;
    a = add(ax.a, scale(ax.n, side * ax.half));
    d = ax.dir;
  } else if (el.kind === 'grid' || el.kind === 'detailLine' || el.kind === 'roomSeparator') {
    if (ref.ref === 'a' || ref.ref === 'b') return ref.ref === 'a' ? el.a : el.b;
    a = el.a;
    d = norm(sub(el.b, el.a));
  } else if (el.kind === 'door' || el.kind === 'window' || el.kind === 'opening') {
    const host = doc.get(el.hostId);
    if (!host) return ref.at;
    const ax = wallAxis(doc, host);
    const { width } = openingSize(doc, el);
    const u = el.t + (ref.ref === 'left' ? -width / 2 : ref.ref === 'right' ? width / 2 : 0);
    const p = add(ax.a, scale(ax.dir, u));
    // Project onto the measuring line through the stored point.
    return add(ref.at, scale(dir, dot(sub(p, ref.at), dir)));
  } else return ref.at;
  // Intersect the reference line with the measurement line through `at`.
  const den = d[0] * dir[1] - d[1] * dir[0];
  if (Math.abs(den) < 1e-9) return ref.at;
  const ap = sub(ref.at, a);
  const t = (ap[0] * dir[1] - ap[1] * dir[0]) / den;
  return add(a, scale(d, t));
}

/** Resolved dimension geometry: reference points, positions along `dir`, line points. */
export function dimensionGeometry(doc, walls, el) {
  const dir = norm(el.dir);
  const refs = el.refs.map((r) => dimRefPoint(doc, walls, r, dir));
  const pos = refs.map((p) => dot(sub(p, el.line), dir));
  const order = pos.map((v, i) => i).sort((i, j) => pos[i] - pos[j]);
  return { dir, refs, pos, order, at: (s) => add(el.line, scale(dir, s)) };
}

function drawDimension(pc, el, b) {
  if (!el.refs || el.refs.length < 2 || !el.dir) return;
  const g = dimensionGeometry(pc.doc, pc.walls, el);
  const { dir } = g;
  const n = perp(dir);
  const sorted = g.order.map((i) => ({ s: g.pos[i], p: g.refs[i] }));
  const first = sorted[0].s;
  const last = sorted.at(-1).s;
  const ext = P(pc, 2);
  b.line(g.at(first - ext), g.at(last + ext), W.thin);
  const tick = P(pc, 1.4);
  const diag = norm(add(dir, n));
  for (const { s, p } of sorted) {
    const q = g.at(s);
    const off = dot(sub(q, p), n);
    const sign = off >= 0 ? 1 : -1;
    const gap = Math.min(P(pc, 1.5), Math.abs(off) * 0.5);
    b.line(add(p, scale(n, sign * gap)), add(q, scale(n, sign * P(pc, 2))), W.thin);
    b.line(add(q, scale(diag, -tick)), add(q, scale(diag, tick)), W.medium);
  }
  const ang = readableAngle(angleOf(dir));
  const up = rotate([0, 1], ang);
  const tsz = P(pc, 2.5);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const v = sorted[i + 1].s - sorted[i].s;
    if (v < 0.5) continue;
    const m = g.at((sorted[i].s + sorted[i + 1].s) / 2);
    b.text(add(m, scale(up, tsz * 0.75)), el.override || formatDimension(v, pc.units), { size: tsz, rot: ang });
  }
  b.pick([add(g.at(first - ext), scale(n, -tsz)), add(g.at(last + ext), scale(n, -tsz)), add(g.at(last + ext), scale(n, tsz * 1.8)), add(g.at(first - ext), scale(n, tsz * 1.8))]);
}

function drawText(pc, el, b) {
  const sz = P(pc, +el.size || 2.5);
  const rot = ((+el.rotation || 0) * Math.PI) / 180;
  b.text(el.at, el.text, { size: sz, rot, align: el.align || 'left', baseline: 'middle', bold: !!el.bold });
  const lines = String(el.text || '').split('\n');
  const w = sz * 0.6 * Math.max(1, ...lines.map((l) => l.length));
  const hgt = sz * 1.3 * lines.length;
  const x0 = el.align === 'center' ? -w / 2 : el.align === 'right' ? -w : 0;
  const corners = [
    [x0, -hgt / 2],
    [x0 + w, -hgt / 2],
    [x0 + w, hgt / 2],
    [x0, hgt / 2],
  ].map((p) => add(el.at, rotate(p, rot)));
  b.pick(corners);
}

export function tagText(doc, target) {
  if (!target) return '?';
  if (target.kind === 'door' || target.kind === 'window') return target.mark || '?';
  if (target.kind === 'room') return target.number || target.name || '?';
  if (target.kind === 'wall') return doc.get(target.typeId)?.mark || '?';
  return target.mark || doc.get(target.typeId)?.mark || '?';
}

/** Anchor point of a tag's target in plan. */
export function tagAnchor(doc, target) {
  if (!target) return null;
  if (target.kind === 'door' || target.kind === 'window') {
    const host = doc.get(target.hostId);
    if (!host) return null;
    const ax = wallAxis(doc, host);
    return add(ax.a, scale(ax.dir, target.t));
  }
  if (target.at) return target.at;
  if (target.a && target.b) return mid(target.a, target.b);
  if (target.boundary) return bbox(target.boundary) && [(bbox(target.boundary).x0 + bbox(target.boundary).x1) / 2, (bbox(target.boundary).y0 + bbox(target.boundary).y1) / 2];
  return null;
}

function drawTag(pc, el, b) {
  const target = pc.doc.get(el.targetId);
  if (!target) return;
  const text = tagText(pc.doc, target);
  const sz = P(pc, 2.5);
  const at = el.at;
  const r = Math.max(sz * 0.95, sz * 0.36 * text.length + sz * 0.4);
  let outline;
  if (target.kind === 'door') outline = arcPoints(at, r, 0, Math.PI * 2, Math.PI / 16).slice(0, -1);
  else if (target.kind === 'window')
    outline = [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i * Math.PI) / 3;
      return [at[0] + Math.cos(a) * r * 1.1, at[1] + Math.sin(a) * r * 1.1];
    });
  else
    outline = [
      [at[0] - r * 1.2, at[1] - sz * 0.8],
      [at[0] + r * 1.2, at[1] - sz * 0.8],
      [at[0] + r * 1.2, at[1] + sz * 0.8],
      [at[0] - r * 1.2, at[1] + sz * 0.8],
    ];
  b.fill(outline, [], BG);
  b.poly(outline, true, W.thin);
  b.text(at, text, { size: sz });
  if (el.leader) {
    const anchor = tagAnchor(pc.doc, target);
    if (anchor && dist(anchor, at) > r * 1.5) {
      const d = norm(sub(anchor, at));
      b.line(add(at, scale(d, r)), anchor, W.thin);
    }
  }
  b.pick(outline);
}

const LINE_STYLE = { thin: [W.thin, 0], medium: [W.medium, 0], wide: [W.heavy, 0], dashed: [W.thin, 1], hidden: [W.thin, 2], center: [W.thin, 3] };

function drawDetailLine(el, b) {
  const [w, d] = LINE_STYLE[el.style] || LINE_STYLE.thin;
  b.line(el.a, el.b, w, d);
  const n = perp(norm(sub(el.b, el.a)));
  const pad = 20;
  b.pick([add(el.a, scale(n, -pad)), add(el.b, scale(n, -pad)), add(el.b, scale(n, pad)), add(el.a, scale(n, pad))]);
}

// View markers ------------------------------------------------------------------------------------

/** Look direction of a section: to the right of a→b, or the left when flipped. */
export function sectionFrame(sec) {
  const dir = norm(sub(sec.b, sec.a));
  const look = sec.flip ? [-dir[1], dir[0]] : [dir[1], -dir[0]];
  return { dir, look, length: dist(sec.a, sec.b) };
}

function planSectionMarker(pc, sec, b) {
  if (!sec.a || !sec.b) return;
  const { dir, look, length } = sectionFrame(sec);
  if (length < 1) return;
  const r = P(pc, 3.5);
  const seg = Math.min(length * 0.2, P(pc, 8));
  b.line(sec.a, add(sec.a, scale(dir, seg)), W.heavy);
  b.line(sub(sec.b, scale(dir, seg)), sec.b, W.heavy);
  b.line(add(sec.a, scale(dir, seg)), sub(sec.b, scale(dir, seg)), W.thin, 3);
  for (const [p, out] of [
    [sec.a, -1],
    [sec.b, 1],
  ]) {
    const c = add(p, scale(dir, out * r));
    const circle = arcPoints(c, r, 0, Math.PI * 2, Math.PI / 20).slice(0, -1);
    b.fill(circle, [], BG);
    // Filled half toward the look direction.
    const a0 = angleOf(look) - Math.PI / 2;
    b.fill([c, ...arcPoints(c, r, a0, a0 + Math.PI, Math.PI / 16)], [], INK(255));
    b.circle(c, r, W.light);
    b.text(sub(c, scale(look, r * 0.45)), abbreviation(sec.name), { size: P(pc, 1.8), rot: 0, color: null });
  }
  const pad = P(pc, 2);
  const n = perp(dir);
  b.pick([add(sec.a, scale(n, -pad)), add(sec.b, scale(n, -pad)), add(sec.b, scale(n, pad)), add(sec.a, scale(n, pad))]);
}

function planElevationMarker(pc, v, b) {
  if (!v.origin) return;
  const r = P(pc, 4);
  const c = v.origin;
  const look = [Math.cos(v.look), Math.sin(v.look)];
  const side = perp(look);
  const circle = arcPoints(c, r, 0, Math.PI * 2, Math.PI / 20).slice(0, -1);
  b.fill(circle, [], BG);
  b.circle(c, r, W.light);
  const tip = add(c, scale(look, r * 1.75));
  const tri = [tip, add(c, scale(side, r * 0.95)), add(c, scale(side, -r * 0.95))];
  b.fill(tri, [], INK(255));
  b.text(c, abbreviation(v.name), { size: P(pc, 2) });
  b.pick(circle);
  b.pick(tri);
}

function abbreviation(name) {
  const s = String(name || '').trim();
  if (s.length <= 3) return s;
  const words = s.split(/\s+/);
  if (words.length > 1) return words.map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return s.slice(0, 1).toUpperCase();
}
