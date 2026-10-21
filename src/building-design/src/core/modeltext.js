/**
 * Model text: lettering built in 3D (signage, plaques, floor markings).
 * Letters are strokes of a simple block alphabet drawn for this app on a
 * 4 x 6 grid, extruded to a depth.
 *
 *   modelText { levelId, at, rotation, text, size, depth, offset, plane, materialId }
 *
 * plane 'vertical' stands the text up facing along its rotation; 'horizontal'
 * lays it on the level. size is the letter height in millimetres.
 */
import { MeshBuilder, hexToRgba } from './mesh.js';
import { levelElevation } from './model.js';
import { W } from './plan.js';

const O = [[1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0]];
const P_ = [[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]];
const DOT = (x, y = 0) => [[x, y], [x, y + 0.45]];

export const GLYPHS = {
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 3], [4, 3]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
  D: [[[0, 0], [0, 6], [2, 6], [4, 4], [4, 2], [2, 0], [0, 0]]],
  E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 6], [3, 6]], [[2, 6], [2, 0]], [[1, 0], [3, 0]]],
  J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1, 3], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [O],
  P: [P_],
  Q: [O, [[2, 2], [4, 0]]],
  R: [P_, [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 4], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  0: [O, [[0, 1], [4, 5]]],
  1: [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  2: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  3: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  4: [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  5: [[[4, 6], [0, 6], [0, 3], [3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  6: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  7: [[[0, 6], [4, 6], [1, 0]]],
  8: [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  9: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [4, 3]]],
  '-': [[[1, 3], [3, 3]]],
  '+': [[[2, 1], [2, 5]], [[0, 3], [4, 3]]],
  '.': [DOT(2)],
  ',': [[[2, 0.6], [1.5, -0.8]]],
  ':': [DOT(2, 1), DOT(2, 4)],
  '/': [[[0, 0], [4, 6]]],
  "'": [[[2, 6], [2, 4.8]]],
  '(': [[[3, 6], [2, 5], [2, 1], [3, 0]]],
  ')': [[[1, 6], [2, 5], [2, 1], [1, 0]]],
  '!': [[[2, 6], [2, 2]], DOT(2)],
  '?': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [2, 3], [2, 2]], DOT(2)],
  '&': [[[4, 0], [1, 4], [1, 5], [2, 6], [3, 5], [3, 4], [0, 2], [0, 1], [1, 0], [2, 0], [4, 2]]],
};

/** Strokes of a text line in letter units (each letter 4 wide on a 6-unit pitch). */
export function textStrokes(text) {
  const out = [];
  let x = 0;
  for (const ch of String(text || '').toUpperCase()) {
    const g = GLYPHS[ch];
    if (g) for (const s of g) out.push(s.map(([u, v]) => [u + x, v]));
    x += 6;
  }
  return { strokes: out, width: Math.max(0, x - 2) };
}

function frameOf(doc, el) {
  const r = ((+el.rotation || 0) * Math.PI) / 180;
  const k = (+el.size || 300) / 6;
  const z0 = levelElevation(doc, el.levelId) + (+el.offset || 0);
  return { dir: [Math.cos(r), Math.sin(r)], nrm: [-Math.sin(r), Math.cos(r)], k, z0, stroke: Math.max(1, k * 0.85) };
}

export function buildModelText(ctx, el) {
  const { strokes } = textStrokes(el.text);
  if (!strokes.length) return null;
  const f = frameOf(ctx.doc, el);
  const mat = ctx.material(el.materialId || 'mat-steel');
  const col = hexToRgba(mat?.color || '#9aa0a6', 1);
  const depth = Math.max(1, +el.depth || 50);
  const vertical = el.plane !== 'horizontal';
  // Letter units to world points.
  const W3 = ([u, v]) =>
    vertical
      ? [el.at[0] + f.dir[0] * u * f.k, el.at[1] + f.dir[1] * u * f.k, f.z0 + v * f.k]
      : [el.at[0] + (f.dir[0] * u + f.nrm[0] * v) * f.k, el.at[1] + (f.dir[1] * u + f.nrm[1] * v) * f.k, f.z0];
  const b = new MeshBuilder();
  // Vertical letters extrude out of their plane (towards the normal); flat ones up.
  const up = vertical ? [f.nrm[0], f.nrm[1], 0] : [0, 0, 1];
  const shift = (p) => (vertical ? [p[0] + f.nrm[0] * depth / 2, p[1] + f.nrm[1] * depth / 2, p[2]] : [p[0], p[1], p[2] + depth / 2]);
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i++) {
      const a = shift(W3(s[i]));
      const c = shift(W3(s[i + 1]));
      const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      if (len < 1e-6) continue;
      // Extend each stroke by half its width so corners close.
      const e = [(c[0] - a[0]) / len, (c[1] - a[1]) / len, (c[2] - a[2]) / len];
      const h = f.stroke / 2;
      b.beam3([a[0] - e[0] * h, a[1] - e[1] * h, a[2] - e[2] * h], [c[0] + e[0] * h, c[1] + e[1] * h, c[2] + e[2] * h], f.stroke, depth, col, { up, edges: false });
    }
  }
  return b.build();
}

/** Plan: flat text as its strokes; standing text as its footprint with the words. */
export function planModelText(pc, el, b) {
  if (el.levelId !== pc.view.levelId || pc.ceiling) return;
  const { strokes, width } = textStrokes(el.text);
  if (!strokes.length) return;
  const f = frameOf(pc.doc, el);
  const P = ([u, v]) => [el.at[0] + (f.dir[0] * u + f.nrm[0] * v) * f.k, el.at[1] + (f.dir[1] * u + f.nrm[1] * v) * f.k];
  if (el.plane === 'horizontal') {
    for (const s of strokes) b.poly(s.map(P), false, W.medium);
    b.pick([P([-1, -1]), P([width + 1, -1]), P([width + 1, 7]), P([-1, 7])]);
    return;
  }
  const d = Math.max(1, +el.depth || 50) / f.k;
  const foot = [P([0, 0]), P([width, 0]), P([width, d]), P([0, d])];
  b.poly(foot, true, W.medium);
  const pad = 1.2 * pc.scale / f.k;
  b.pick([P([-pad, -pad]), P([width + pad, -pad]), P([width + pad, d + pad]), P([-pad, d + pad])]);
}
