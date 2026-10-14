/**
 * Elevation and section views: the view frame (how plan points and heights
 * map to the 2D view) and the 2D annotations drawn over the 3D render:
 * levels, grids, and the view's own dimensions, text and lines.
 */
import { PlanBuilder, W, BG, INK, planGraphics, sectionFrame } from './plan.js';
import { formatLength } from './units.js';
import { sub, dot, norm, lineIntersect } from './geom.js';

/**
 * Frame of an elevation or section view: origin (plan point), right (unit
 * plan vector for +u), look (unit plan vector into the view), near/far
 * depths and the horizontal crop (u range) when there is one.
 */
export function viewFrame(view) {
  if (view.kind === 'section') {
    const { dir, look, length } = sectionFrame(view);
    const right = [look[1], -look[0]];
    // u = 0 at the end of the section line on the left of the view.
    const ua = dot(sub(view.a, view.a), right);
    const ub = dot(sub(view.b, view.a), right);
    void dir;
    void length;
    return { origin: view.a, right, look, near: 0, far: +view.depth || 10000, u0: Math.min(ua, ub), u1: Math.max(ua, ub), cut: true };
  }
  const look = [Math.cos(view.look), Math.sin(view.look)];
  const right = [look[1], -look[0]];
  return { origin: view.origin, right, look, near: 0, far: +view.depth || 30000, u0: null, u1: null, cut: false };
}

export function toView(frame, p) {
  const d = sub([p[0], p[1]], frame.origin);
  return [dot(d, frame.right), p[2] ?? 0];
}

/** Plan point of a view coordinate u at depth 0. */
export function fromView(frame, u) {
  return [frame.origin[0] + frame.right[0] * u, frame.origin[1] + frame.right[1] * u];
}

/** Clip planes ([nx, ny, nz, d], discard where n.p > d) for the view depth. */
export function viewClip(frame) {
  const L = frame.look;
  const o = dot(L, frame.origin);
  const planes = [
    [L[0], L[1], 0, o + frame.far],
    [-L[0], -L[1], 0, -(o + frame.near) + (frame.cut ? 0 : 1)],
  ];
  if (frame.u0 != null) {
    const r = frame.right;
    const ro = dot(r, frame.origin);
    planes.push([r[0], r[1], 0, ro + frame.u1], [-r[0], -r[1], 0, -(ro + frame.u0)]);
  }
  return planes;
}

/**
 * Graphics for the annotations of an elevation or section view.
 * range: { u0, u1, z0, z1 } extents of the model in view coordinates.
 * Returns [{ id, kind, g }].
 */
export function elevationAnnotations(doc, view, frame, range, walls) {
  const out = [];
  const scale = +view.scale || 100;
  const P = (mm) => mm * scale;
  const pc = { doc, view, scale, units: doc.units, walls, detail: view.detail || 'medium', cutZ: 0, bottomZ: 0, topZ: 0, ceiling: false };
  const pad = P(12);
  const u0 = (frame.u0 ?? range.u0) - pad;
  const u1 = (frame.u1 ?? range.u1) + pad;
  if (!view.hiddenCats?.includes('levels')) {
    for (const lv of doc.levels()) {
      const b = new PlanBuilder();
      const z = lv.elevation;
      b.line([u0, z], [u1, z], W.thin, 3);
      // Head: a small diamond with the name and elevation.
      const r = P(1.6);
      const h = [u1 + r, z];
      b.fill([[h[0] - r, z], [h[0], z + r], [h[0] + r, z], [h[0], z - r]], [], INK(255));
      b.text([h[0] + r * 1.6, z + P(1.6)], lv.name, { size: P(2.5), align: 'left', bold: true });
      b.text([h[0] + r * 1.6, z - P(1.6)], formatLength(z, doc.units), { size: P(2), align: 'left' });
      b.pick([
        [u0, z - P(1)],
        [u1 + P(20), z - P(1)],
        [u1 + P(20), z + P(1)],
        [u0, z + P(1)],
      ]);
      out.push({ id: lv.id, kind: 'level', g: b });
    }
  }
  if (!view.hiddenCats?.includes('grids')) {
    const zTop = range.z1 + P(10);
    const zBot = range.z0 - P(4);
    for (const gr of doc.all('grid')) {
      const d = norm(sub(gr.b, gr.a));
      // Where the grid crosses the view's picture line.
      const hit = lineIntersect(gr.a, d, frame.origin, frame.right);
      if (!hit) continue;
      if (Math.abs(dot(d, frame.right)) > 0.985) continue;
      const u = dot(sub(hit.point, frame.origin), frame.right);
      if (frame.u0 != null && (u < frame.u0 - 1 || u > frame.u1 + 1)) continue;
      const b = new PlanBuilder();
      b.line([u, zBot], [u, zTop], W.thin, 3);
      const r = P(4);
      const c = [u, zTop + r];
      const circle = [];
      for (let i = 0; i < 32; i++) circle.push([c[0] + Math.cos((i / 32) * Math.PI * 2) * r, c[1] + Math.sin((i / 32) * Math.PI * 2) * r]);
      b.fill(circle, [], BG);
      b.poly(circle, true, W.light);
      b.text(c, gr.name, { size: P(3.5) });
      b.pick([
        [u - P(1), zBot],
        [u + P(1), zBot],
        [u + P(1), zTop + 2 * r],
        [u - P(1), zTop + 2 * r],
      ]);
      out.push({ id: gr.id, kind: 'grid', g: b });
    }
  }
  for (const el of doc.items.values()) {
    if (el.viewId !== view.id) continue;
    if (view.hiddenCats?.includes(catOf(el.kind))) continue;
    const g = planGraphics(pc, el);
    if (g) out.push({ id: el.id, kind: el.kind, g });
  }
  return out;
}

const CUT_KINDS = new Set(['wall', 'floor', 'roof', 'ceiling', 'column', 'beam', 'stair']);

/**
 * Cut fills for a section: the loops where the section plane cuts each
 * element's closed mesh, in view coordinates. Returns [{ id, kind, g }].
 */
export function sectionCuts(doc, frame, meshOf, detail = 'medium') {
  const out = [];
  if (!frame.cut) return out;
  const L = frame.look;
  const c = L[0] * frame.origin[0] + L[1] * frame.origin[1];
  const r = frame.right;
  const ro = r[0] * frame.origin[0] + r[1] * frame.origin[1];
  for (const kind of CUT_KINDS)
    for (const el of doc.all(kind)) {
      const m = meshOf(el);
      if (!m?.bounds) continue;
      // Quick reject on the plan bounds.
      const b = m.bounds;
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of [b.min[0], b.max[0]])
        for (const y of [b.min[1], b.max[1]]) {
          const d = L[0] * x + L[1] * y - c;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      if (lo > 0 || hi < 0) continue;
      const segs = [];
      const P = m.pos;
      for (let t = 0; t < P.length; t += 9) {
        const pts = [];
        const ds = [];
        for (let k = 0; k < 3; k++) {
          const x = P[t + k * 3];
          const y = P[t + k * 3 + 1];
          ds.push(L[0] * x + L[1] * y - c);
          pts.push([x, y, P[t + k * 3 + 2]]);
        }
        const hits = [];
        for (let k = 0; k < 3; k++) {
          const a = k;
          const bb = (k + 1) % 3;
          const da = ds[a];
          const db = ds[bb];
          if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
            const s = da / (da - db);
            const p = [pts[a][0] + (pts[bb][0] - pts[a][0]) * s, pts[a][1] + (pts[bb][1] - pts[a][1]) * s, pts[a][2] + (pts[bb][2] - pts[a][2]) * s];
            hits.push([r[0] * p[0] + r[1] * p[1] - ro, p[2]]);
          } else if (da === 0 && db !== 0) hits.push([r[0] * pts[a][0] + r[1] * pts[a][1] - ro, pts[a][2]]);
        }
        if (hits.length === 2) segs.push(hits);
      }
      const loops = chainLoops(segs);
      if (!loops.length) continue;
      const g = new PlanBuilder();
      for (let loop of loops) {
        if (frame.u0 != null) {
          loop = clipU(loop, frame.u0, frame.u1);
          if (loop.length < 3) continue;
        }
        g.fill(loop, [], detail === 'coarse' || kind !== 'wall' ? INK(150) : INK(115));
        g.poly(loop, true, W.cut);
        g.pick(loop);
      }
      if (!g.empty) out.push({ id: el.id, kind, g });
    }
  return out;
}

function chainLoops(segs) {
  const key = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const adj = new Map();
  segs.forEach((s, i) => {
    for (const p of s) {
      const k = key(p);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i][0], segs[i][1]];
    let cur = segs[i][1];
    for (let guard = 0; guard < segs.length; guard++) {
      const next = (adj.get(key(cur)) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      cur = key(s[0]) === key(cur) ? s[1] : s[0];
      if (key(cur) === key(loop[0])) break;
      loop.push(cur);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function clipU(loop, u0, u1) {
  const clip = (pts, keep) => {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = keep(a[0]);
      const ib = keep(b[0]);
      if (ia >= 0) res.push(a);
      if ((ia < 0 && ib > 0) || (ia > 0 && ib < 0)) {
        const s = ia / (ia - ib);
        res.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      }
    }
    return res;
  };
  return clip(clip(loop, (u) => u - u0), (u) => u1 - u);
}

function catOf(kind) {
  return { dimension: 'dimensions', text: 'text', tag: 'tags', detailLine: 'lines' }[kind] || kind;
}
