/**
 * Trusses: chords and web members generated between two points.
 *
 *   truss      { levelId, a, b, offset, height?, typeId }
 *   trussType  { pattern, height, panels, chord, web, materialId }
 *
 * Patterns: 'pratt' and 'howe' (flat, verticals and diagonals), 'warren'
 * (flat, diagonals only), 'fink' and 'kingpost' (pitched, for roofs). The
 * bottom chord sits at the level plus the offset.
 */
import { add, sub, scale, norm, perp, dist } from './geom.js';
import { MeshBuilder, hexToRgba } from './mesh.js';
import { levelElevation } from './model.js';
import { W } from './plan.js';

export const PATTERNS = [
  { value: 'pratt', label: 'Pratt (flat)' },
  { value: 'howe', label: 'Howe (flat)' },
  { value: 'warren', label: 'Warren (flat)' },
  { value: 'fink', label: 'Fink (pitched)' },
  { value: 'kingpost', label: 'King post (pitched)' },
];

/** Members as pairs of points in (s along the truss, z above the bottom chord). */
export function trussMembers(pattern, length, height, panels) {
  const n = Math.max(2, Math.round(panels) || 4);
  const L = length;
  const H = height;
  const out = { chords: [], webs: [] };
  const pitched = pattern === 'fink' || pattern === 'kingpost';
  const top = (s) => (pitched ? H * (1 - Math.abs(2 * s - L) / L) : H);
  out.chords.push([[0, 0], [L, 0]]);
  if (pitched) out.chords.push([[0, 0], [L / 2, H]], [[L / 2, H], [L, 0]]);
  else out.chords.push([[0, H], [L, H]], [[0, 0], [0, H]], [[L, 0], [L, H]]);
  if (pattern === 'kingpost') {
    out.webs.push([[L / 2, 0], [L / 2, H]]);
    return out;
  }
  if (pattern === 'fink') {
    // W-shaped webs.
    const q = [L / 3, (2 * L) / 3];
    out.webs.push([[q[0], 0], [L / 4, top(L / 4)]], [[q[0], 0], [L / 2, H]], [[q[1], 0], [L / 2, H]], [[q[1], 0], [(3 * L) / 4, top((3 * L) / 4)]]);
    return out;
  }
  const xs = Array.from({ length: n + 1 }, (_, i) => (L * i) / n);
  for (let i = 1; i < n; i++) if (pattern !== 'warren') out.webs.push([[xs[i], 0], [xs[i], H]]);
  for (let i = 0; i < n; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const leftHalf = (x0 + x1) / 2 < L / 2;
    if (pattern === 'warren') out.webs.push(i % 2 === 0 ? [[x0, 0], [x1, H]] : [[x0, H], [x1, 0]]);
    // Pratt diagonals slope down toward the middle, Howe ones up toward it.
    else if ((pattern === 'pratt') === leftHalf) out.webs.push([[x0, H], [x1, 0]]);
    else out.webs.push([[x0, 0], [x1, H]]);
  }
  return out;
}

export function trussGeometry(doc, el) {
  const t = doc.get(el.typeId) || {};
  const L = dist(el.a, el.b);
  if (L < 100) return null;
  const H = +el.height || +t.height || 1500;
  const z0 = levelElevation(doc, el.levelId) + (+el.offset || 0);
  const dir = norm(sub(el.b, el.a));
  return { t, L, H, z0, dir, members: trussMembers(t.pattern || 'pratt', L, H, +t.panels || Math.max(2, Math.round(L / 1500))) };
}

export function buildTruss(ctx, el) {
  const g = trussGeometry(ctx.doc, el);
  if (!g) return null;
  const mat = ctx.material(g.t.materialId);
  const col = hexToRgba(mat?.color || '#8a8f96', 1);
  const P = ([s, z]) => [el.a[0] + g.dir[0] * s, el.a[1] + g.dir[1] * s, g.z0 + z];
  const b = new MeshBuilder();
  const n = perp(g.dir);
  const up = [n[0], n[1], 0];
  const chord = +g.t.chord || 120;
  const web = +g.t.web || 80;
  // Chords and webs are square members, set side by side within the truss's plane.
  for (const [p, q] of g.members.chords) b.beam3(P(p), P(q), chord, chord, col, { up });
  for (const [p, q] of g.members.webs) b.beam3(P(p), P(q), web, web, col, { up });
  return b.build();
}

export function planTruss(pc, el, b) {
  if (el.levelId !== pc.view.levelId || pc.ceiling || !el.a || !el.b) return;
  const g = trussGeometry(pc.doc, el);
  if (!g) return;
  const w = (+g.t.chord || 120) / 2;
  const n = perp(g.dir);
  const poly = [add(el.a, scale(n, -w)), add(el.b, scale(n, -w)), add(el.b, scale(n, w)), add(el.a, scale(n, w))];
  b.poly(poly, true, W.light, 0);
  // Panel points along the truss.
  for (const [p, q] of g.members.webs) for (const s of [p[0], q[0]]) {
    const c = add(el.a, scale(g.dir, s));
    b.line(add(c, scale(n, -w)), add(c, scale(n, w)), W.thin);
  }
  const pad = Math.max(w, 1.2 * pc.scale);
  b.pick([add(el.a, scale(n, -pad)), add(el.b, scale(n, -pad)), add(el.b, scale(n, pad)), add(el.a, scale(n, pad))]);
}
