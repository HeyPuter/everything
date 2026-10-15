// Pure geometry helpers of the trim gestures: polygon cleanup, ear clipping and closing the
// T-junction cracks left by boolean operations.
import type { PolyFace } from '../mesh/mesh';
import type { Pt } from './gshape';

/** Drop repeated and collinear points (they break ear clipping and add useless side walls). */
export function cleanPolygon(pts: Pt[]): Pt[] {
  let out = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return Math.hypot(p.x - q.x, p.y - q.y) > 0.5;
  });
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length],
        b = out[i],
        c = out[(i + 1) % out.length];
      const cr = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const l = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      if (Math.abs(cr) / l < 0.05) {
        out = out.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Ear-clipping triangulation of a simple 2D polygon (indices into pts). */
export function triangulate2D(pts: Pt[]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area < 0) idx.reverse();
  const out: number[] = [];
  const cross = (a: Pt, b: Pt, c: Pt) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (p: Pt, a: Pt, b: Pt, c: Pt) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length],
        ib = idx[i],
        ic = idx[(i + 1) % idx.length];
      const a = pts[ia],
        b = pts[ib],
        c = pts[ic];
      if (cross(a, b, c) <= 0) continue;
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(pts[j], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/**
 * Boolean results contain T-junctions (a vertex lying on another triangle's edge), which leave
 * cracks in the welded mesh. Split the triangles along such edges so the surface is closed.
 */
export function closeTJunctions(P: number[], faces: PolyFace[], passes = 4) {
  const key = (a: number, b: number) => (a < b ? a * 0x200000 + b : b * 0x200000 + a);
  for (let pass = 0; pass < passes; pass++) {
    const count = new Map<number, number>();
    for (const f of faces) for (let i = 0; i < 3; i++) {
      const k = key(f.verts[i], f.verts[(i + 1) % 3]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    const openVerts = new Set<number>();
    for (const f of faces)
      for (let i = 0; i < 3; i++)
        if (count.get(key(f.verts[i], f.verts[(i + 1) % 3])) === 1) {
          openVerts.add(f.verts[i]);
          openVerts.add(f.verts[(i + 1) % 3]);
        }
    if (!openVerts.size) return;
    const cand = [...openVerts];
    let changed = false;
    const out: PolyFace[] = [];
    for (const f of faces) {
      let split = false;
      for (let i = 0; i < 3 && !split; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % 3],
          c = f.verts[(i + 2) % 3];
        if (count.get(key(a, b)) !== 1) continue;
        const ax = P[a * 3],
          ay = P[a * 3 + 1],
          az = P[a * 3 + 2];
        const dx = P[b * 3] - ax,
          dy = P[b * 3 + 1] - ay,
          dz = P[b * 3 + 2] - az;
        const len2 = dx * dx + dy * dy + dz * dz;
        if (len2 < 1e-20) continue;
        const on: [number, number][] = [];
        for (const v of cand) {
          if (v === a || v === b || v === c) continue;
          const px = P[v * 3] - ax,
            py = P[v * 3 + 1] - ay,
            pz = P[v * 3 + 2] - az;
          const t = (px * dx + py * dy + pz * dz) / len2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          const ex = px - dx * t,
            ey = py - dy * t,
            ez = pz - dz * t;
          if (ex * ex + ey * ey + ez * ez > len2 * 1e-10) continue;
          on.push([t, v]);
        }
        if (!on.length) continue;
        on.sort((x, y) => x[0] - y[0]);
        const chain = [a, ...on.map((x) => x[1]), b];
        for (let k = 0; k + 1 < chain.length; k++) out.push({ ...f, verts: [chain[k], chain[k + 1], c] });
        split = true;
        changed = true;
      }
      if (!split) out.push(f);
    }
    faces.length = 0;
    faces.push(...out);
    if (!changed) return;
  }
}
