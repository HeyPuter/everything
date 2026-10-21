/**
 * Wall sweeps and reveals: a profile run along one face of a wall at a
 * height. Sweeps project from the face (cornices, skirtings, string
 * courses, drip moulds); reveals are grooves cut into it.
 *
 *   wallSweep      { wallId, typeId, side: 'exterior' | 'interior', z, t0?, t1? }
 *   wallSweepType  { profile, width, height, materialId, reveal? }
 *
 * z is measured from the wall's base; t0 and t1 limit the run along the
 * wall (from its start), otherwise it runs the full length.
 */
import { add, scale } from './geom.js';
import { wallAxis, verticalExtent } from './model.js';
import { MeshBuilder, hexToRgba } from './mesh.js';
import { wallOpenings } from './build3d.js';
import { W } from './plan.js';

/** Profiles in (out from the face, up) for a unit size; scaled by the type's width and height. */
export const PROFILES = {
  rect: { label: 'Rectangle', pts: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  cornice: { label: 'Cornice', pts: [[0, 0], [0.35, 0], [0.35, 0.25], [0.7, 0.45], [1, 0.75], [1, 1], [0, 1]] },
  skirting: { label: 'Skirting', pts: [[0, 0], [1, 0], [1, 0.8], [0.55, 1], [0, 1]] },
  drip: { label: 'Drip mould', pts: [[0, 0.35], [0.85, 0], [1, 0.15], [1, 1], [0, 1]] },
  chamfer: { label: 'Chamfered band', pts: [[0, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0, 1]] },
};

/** Where a sweep runs: { p0, p1, n (outward), z0, profile: [[out, up]], reveal }. */
export function sweepGeometry(doc, el) {
  const wall = doc.get(el.wallId);
  if (!wall) return null;
  const type = doc.get(el.typeId) || {};
  const ax = wallAxis(doc, wall);
  const n = el.side === 'interior' ? scale(ax.ext, -1) : ax.ext;
  const t0 = Math.max(0, +el.t0 || 0);
  const t1 = Math.min(ax.length, el.t1 == null ? ax.length : +el.t1);
  if (t1 - t0 < 1) return null;
  const face = (t) => add(add(ax.a, scale(ax.dir, t)), scale(n, ax.half));
  const { base } = verticalExtent(doc, wall);
  const w = +type.width || 100;
  const h = +type.height || 100;
  const pts = (PROFILES[type.profile] || PROFILES.rect).pts.map(([o, u]) => [type.reveal ? -o * w : o * w, u * h]);
  const z0 = base + (+el.z || 0);
  // Doors and windows the profile's height crosses interrupt it.
  let runs = [[t0, t1]];
  for (const op of wallOpenings(doc, wall, base, Infinity)) {
    if (op.z1 <= z0 || op.z0 >= z0 + h) continue;
    runs = runs.flatMap(([a, c]) => (op.u1 <= a || op.u0 >= c ? [[a, c]] : [[a, op.u0], [op.u1, c]].filter(([x, y]) => y - x > 1)));
  }
  return { p0: face(t0), p1: face(t1), runs: runs.map(([a, c]) => [face(a), face(c)]), n, dir: ax.dir, z0, profile: pts, reveal: !!type.reveal, type };
}

export function buildSweep(ctx, el) {
  const g = sweepGeometry(ctx.doc, el);
  if (!g) return null;
  const mat = ctx.material(g.type.materialId);
  const b = new MeshBuilder();
  const at = (p, [o, u]) => [p[0] + g.n[0] * o, p[1] + g.n[1] * o, g.z0 + u];
  if (g.reveal) {
    // A groove: drawn as a darker band just proud of the face, with its edges.
    const col = [70, 70, 70, 255];
    const lift = 0.8;
    const bottom = g.z0 + Math.min(...g.profile.map((q) => q[1]));
    const top = g.z0 + Math.max(...g.profile.map((q) => q[1]));
    const o = [g.n[0] * lift, g.n[1] * lift];
    for (const [p0, p1] of g.runs) {
      const A = [p0[0] + o[0], p0[1] + o[1], bottom];
      const B = [p1[0] + o[0], p1[1] + o[1], bottom];
      const C = [p1[0] + o[0], p1[1] + o[1], top];
      const D = [p0[0] + o[0], p0[1] + o[1], top];
      b.quad(A, B, C, D, col);
      b.edge(A, B);
      b.edge(D, C);
    }
    return b.build();
  }
  const col = hexToRgba(mat?.color || '#d8d4cc', 1);
  const P = g.profile;
  for (const [p0, p1] of g.runs) {
    for (let i = 0; i < P.length; i++) {
      const q0 = P[i];
      const q1 = P[(i + 1) % P.length];
      b.quad(at(p0, q0), at(p1, q0), at(p1, q1), at(p0, q1), col);
      // Edges along the run where the profile turns.
      b.edge(at(p0, q0), at(p1, q0));
    }
    // End caps (profiles are convex enough to fan from the first point).
    for (let i = 1; i + 1 < P.length; i++) {
      b.tri(at(p0, P[0]), at(p0, P[i + 1]), at(p0, P[i]), col);
      b.tri(at(p1, P[0]), at(p1, P[i]), at(p1, P[i + 1]), col);
    }
    b.edgeLoop(P.map((q) => at(p0, q)));
    b.edgeLoop(P.map((q) => at(p1, q)));
  }
  return b.build();
}

/** Plan: the sweep's outline where the view cuts through it, or its projection below the cut. */
export function planSweep(pc, el, b) {
  const wall = pc.doc.get(el.wallId);
  if (!wall || wall.levelId !== pc.view.levelId) return;
  const g = sweepGeometry(pc.doc, el);
  if (!g || g.reveal) return;
  const lo = g.z0 + Math.min(...g.profile.map((q) => q[1]));
  const hi = g.z0 + Math.max(...g.profile.map((q) => q[1]));
  if (lo > pc.cutZ) return;
  const cut = hi >= pc.cutZ;
  const out = Math.max(...g.profile.map((q) => q[0]));
  const o = scale(g.n, out);
  for (const [p0, p1] of g.runs) {
    const poly = [p0, p1, add(p1, o), add(p0, o)];
    if (cut) b.fill(poly, [], [-1, -1, -1, 140]);
    b.poly(poly, true, cut ? W.medium : W.thin);
    b.pick(poly);
  }
}
