// UV unwrapping and island packing for the UV Unwrap and Pack UV Islands nodes. Charts are faces
// connected across non-seam edges; each is flattened with the conformal solver, falling back to
// flat projections of angle-limited face groups when a chart can't be flattened as a disk.
import { unwrapUV } from '../../edit/unwrap';
import type { Topology } from '../../edit/topology';
import type { MeshComponent } from '../geometry';
import { faceNormals, faceAreas } from '../meshutil';
import { directedCorners, nextCorner } from './dual';

/** UV islands: corner lists of faces connected through edges whose corners share UVs. */
export function uvIslands(m: MeshComponent, uv: ArrayLike<number>, stride: number, faceSel: Uint8Array | null): number[][] {
  const nf = m.faceCount;
  const topo = m.topology();
  const nv = m.vertCount;
  const dir = directedCorners(m);
  const parent = new Int32Array(nf);
  for (let f = 0; f < nf; f++) parent[f] = f;
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const same = (a: number, b: number) => Math.abs(uv[a * stride] - uv[b * stride]) < 1e-5 && Math.abs(uv[a * stride + 1] - uv[b * stride + 1]) < 1e-5;
  for (let f = 0; f < nf; f++) {
    if (faceSel && !faceSel[f]) continue;
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
      const n = nextCorner(m, f, c);
      const o = dir.get(m.corners[n] * nv + m.corners[c]);
      if (o === undefined) continue;
      const of = topo.cornerFace[o];
      if (faceSel && !faceSel[of]) continue;
      // o is at the next vertex, its next corner at this vertex
      if (same(n, o) && same(c, nextCorner(m, of, o))) {
        const a = find(f),
          b = find(of);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    if (faceSel && !faceSel[f]) continue;
    const r = find(f);
    let l = groups.get(r);
    if (!l) groups.set(r, (l = []));
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) l.push(c);
  }
  return [...groups.values()];
}

/** Faces connected across edges that are not seams (and are shared by exactly two faces). */
function charts(m: MeshComponent, faceSel: Uint8Array | null, seam: Uint8Array | null): number[][] {
  const topo = m.topology();
  const nf = m.faceCount;
  const parent = new Int32Array(nf);
  for (let f = 0; f < nf; f++) parent[f] = f;
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let e = 0; e < topo.edgeCount; e++) {
    if (seam && seam[e]) continue;
    const a = topo.edgeFaceOffsets[e],
      b = topo.edgeFaceOffsets[e + 1];
    if (b - a !== 2) continue;
    const f0 = topo.edgeFaces[a],
      f1 = topo.edgeFaces[a + 1];
    if (faceSel && (!faceSel[f0] || !faceSel[f1])) continue;
    const x = find(f0),
      y = find(f1);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  }
  const groups = new Map<number, number[]>();
  for (let f = 0; f < nf; f++) {
    if (faceSel && !faceSel[f]) continue;
    const r = find(f);
    let l = groups.get(r);
    if (!l) groups.set(r, (l = []));
    l.push(f);
  }
  return [...groups.values()];
}

/** Flat projection of angle-limited face groups (used when a chart can't be flattened). */
function projectGroups(m: MeshComponent, faces: number[], uv: Float32Array): number[][] {
  const fn = faceNormals(m);
  const topo = m.topology();
  const left = new Set(faces);
  const islands: number[][] = [];
  const limit = Math.cos((66 * Math.PI) / 180);
  for (const seed of faces) {
    if (!left.has(seed)) continue;
    const n = [fn[seed * 3], fn[seed * 3 + 1], fn[seed * 3 + 2]];
    const group: number[] = [];
    const st = [seed];
    left.delete(seed);
    while (st.length) {
      const f = st.pop()!;
      group.push(f);
      for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
        const e = topo.cornerEdge[c];
        for (let k = topo.edgeFaceOffsets[e]; k < topo.edgeFaceOffsets[e + 1]; k++) {
          const g = topo.edgeFaces[k];
          if (!left.has(g)) continue;
          if (fn[g * 3] * n[0] + fn[g * 3 + 1] * n[1] + fn[g * 3 + 2] * n[2] < limit) continue;
          left.delete(g);
          st.push(g);
        }
      }
    }
    // tangent frame of the seed normal
    const up = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const t = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    for (let k = 0; k < 3; k++) t[k] /= tl;
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const corners: number[] = [];
    for (const f of group)
      for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
        const v = m.corners[c];
        const p = [m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]];
        uv[c * 2] = p[0] * t[0] + p[1] * t[1] + p[2] * t[2];
        uv[c * 2 + 1] = p[0] * b[0] + p[1] * b[1] + p[2] * b[2];
        corners.push(c);
      }
    islands.push(corners);
  }
  return islands;
}

/** Signed UV area of a set of faces (positive = same winding as in 3D). */
function uvArea(m: MeshComponent, faces: Iterable<number>, uv: ArrayLike<number>): number {
  let a = 0;
  for (const f of faces) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    for (let c = s; c < e; c++) {
      const d = c + 1 < e ? c + 1 : s;
      a += uv[c * 2] * uv[d * 2 + 1] - uv[d * 2] * uv[c * 2 + 1];
    }
  }
  return a / 2;
}

export interface UnwrapOptions {
  margin: number;
  noFlip: boolean;
  fillHoles: boolean;
}

/**
 * A topology for one chart with its holes closed by fans around added centre vertices (all
 * boundary loops but the longest), so the chart flattens as a disk.
 */
function filledChart(t: Topology, m: MeshComponent, chart: number[]): { t: Topology; ids: number[] } | null {
  const dirs = new Set<string>();
  for (const f of chart) for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) dirs.add(`${m.corners[c]},${m.corners[nextCorner(m, f, c)]}`);
  const next = new Map<number, number>();
  for (const f of chart)
    for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
      const a = m.corners[c],
        b = m.corners[nextCorner(m, f, c)];
      if (!dirs.has(`${b},${a}`)) next.set(a, b);
    }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const s0 of next.keys()) {
    if (seen.has(s0)) continue;
    const loop: number[] = [];
    let v = s0;
    while (!seen.has(v) && next.has(v)) {
      seen.add(v);
      loop.push(v);
      v = next.get(v)!;
    }
    if (v === s0 && loop.length >= 3) loops.push(loop);
  }
  if (loops.length < 2) return null;
  const P = m.positions;
  const len = (l: number[]) => l.reduce((s, v, i) => s + Math.hypot(...[0, 1, 2].map((k) => P[l[(i + 1) % l.length] * 3 + k] - P[v * 3 + k])), 0);
  loops.sort((a, b) => len(b) - len(a));
  const pos = Array.from(P);
  const offsets = Array.from(t.offsets);
  const indices = Array.from(t.indices);
  const seams = Array.from(t.seams ?? new Uint32Array(indices.length));
  const ids = chart.slice();
  for (const loop of loops.slice(1)) {
    const centre = [0, 1, 2].map((k) => loop.reduce((s, v) => s + P[v * 3 + k], 0) / loop.length);
    const cv = pos.length / 3;
    pos.push(...centre);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i],
        b = loop[(i + 1) % loop.length];
      indices.push(b, a, cv);
      seams.push(0, 0, 0);
      offsets.push(indices.length);
      ids.push(offsets.length - 2);
    }
  }
  const nc = indices.length;
  return {
    t: {
      positions: new Float32Array(pos),
      offsets: Uint32Array.from(offsets),
      indices: Uint32Array.from(indices),
      uvs: new Float32Array(nc * 2),
      normals: new Float32Array(nc * 3),
      seams: Uint32Array.from(seams),
    },
    ids,
  };
}

/** Unwrap the selected faces; returns UVs per corner (2 values each). */
export function unwrapMesh(m: MeshComponent, faceSel: Uint8Array | null, seam: Uint8Array | null, opts: UnwrapOptions): Float32Array {
  const nc = m.cornerCount;
  const uv = new Float32Array(nc * 2);
  if (!m.faceCount) return uv;
  const topo = m.topology();
  const seams = new Uint32Array(nc);
  if (seam) for (let c = 0; c < nc; c++) if (seam[topo.cornerEdge[c]]) seams[c] = 1;
  const t: Topology = { positions: m.positions, offsets: m.faceOffsets, indices: m.corners, uvs: new Float32Array(nc * 2), normals: new Float32Array(nc * 3), seams };
  const islands: number[][] = [];
  const faceOf = topo.cornerFace;
  for (const chart of charts(m, faceSel, seam)) {
    let done = false;
    try {
      const filled = opts.fillHoles ? filledChart(t, m, chart) : null;
      const r = filled ? unwrapUV(filled.t, filled.ids, 0.001) : unwrapUV(t, chart, 0.001);
      const corners: number[] = [];
      for (const f of chart)
        for (let c = m.faceOffsets[f]; c < m.faceOffsets[f + 1]; c++) {
          uv[c * 2] = r.uvs[c * 2];
          uv[c * 2 + 1] = r.uvs[c * 2 + 1];
          corners.push(c);
        }
      islands.push(corners);
      done = true;
    } catch {
      done = false;
    }
    if (!done) islands.push(...projectGroups(m, chart, uv));
  }
  // islands keep the winding of their faces when flipping is not allowed
  if (opts.noFlip)
    for (const isl of islands) {
      const faces = new Set(isl.map((c) => faceOf[c]));
      if (uvArea(m, faces, uv) < 0) for (const c of isl) uv[c * 2] = -uv[c * 2];
    }
  // scale islands to their surface area so texel density matches, then pack
  const areas = faceAreas(m);
  for (const isl of islands) {
    const faces = new Set(isl.map((c) => faceOf[c]));
    let surf = 0;
    for (const f of faces) surf += areas[f];
    const a = Math.abs(uvArea(m, faces, uv));
    const s = a > 1e-12 ? Math.sqrt(surf / a) : 1;
    for (const c of isl) {
      uv[c * 2] *= s;
      uv[c * 2 + 1] *= s;
    }
  }
  packIslands(uv, 2, islands, { margin: opts.margin, rotate: false, min: [0, 0], max: [1, 1] });
  return uv;
}

export interface PackOptions {
  margin: number;
  rotate: boolean;
  min: [number, number];
  max: [number, number];
}

/** Pack islands (corner lists) into the rectangle min..max, keeping their relative sizes. */
export function packIslands(uv: Float32Array, stride: number, islands: number[][], o: PackOptions) {
  if (!islands.length) return;
  const boxes = islands.map((corners) => {
    let angle = 0;
    if (o.rotate) {
      // the rotation (in 1° steps over a quarter turn) with the smallest bounding area
      let best = Infinity;
      for (let d = 0; d < 90; d++) {
        const a = (d * Math.PI) / 180;
        const cs = Math.cos(a),
          sn = Math.sin(a);
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (const c of corners) {
          const x = uv[c * stride] * cs - uv[c * stride + 1] * sn,
            y = uv[c * stride] * sn + uv[c * stride + 1] * cs;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
        const area = (x1 - x0) * (y1 - y0) + 1e-9 * d;
        if (area < best) {
          best = area;
          angle = a;
        }
      }
      const cs = Math.cos(angle),
        sn = Math.sin(angle);
      for (const c of corners) {
        const x = uv[c * stride],
          y = uv[c * stride + 1];
        uv[c * stride] = x * cs - y * sn;
        uv[c * stride + 1] = x * sn + y * cs;
      }
    }
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of corners) {
      x0 = Math.min(x0, uv[c * stride]);
      x1 = Math.max(x1, uv[c * stride]);
      y0 = Math.min(y0, uv[c * stride + 1]);
      y1 = Math.max(y1, uv[c * stride + 1]);
    }
    return { corners, x0, y0, w: x1 - x0, h: y1 - y0, x: 0, y: 0 };
  });
  const order = boxes.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  const W = o.max[0] - o.min[0],
    H = o.max[1] - o.min[1];
  if (!(W > 0) || !(H > 0)) return;
  // margin is relative to the target size
  const pad = Math.max(0, o.margin) * Math.min(W, H);
  const fit = (s: number) => {
    let x = pad,
      y = pad,
      row = 0;
    for (const b of order) {
      const w = b.w * s,
        h = b.h * s;
      if (x + w + pad > W + 1e-9 && x > pad) {
        x = pad;
        y += row + pad;
        row = 0;
      }
      if (x + w + pad > W + 1e-9 || y + h + pad > H + 1e-9) return false;
      b.x = x;
      b.y = y;
      x += w + pad;
      row = Math.max(row, h);
    }
    return true;
  };
  const maxDim = Math.max(...boxes.map((b) => Math.max(b.w / W, b.h / H)), 1e-12);
  let lo = 0,
    hi = 1 / maxDim;
  if (fit(hi)) lo = hi;
  else
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fit(mid)) lo = mid;
      else hi = mid;
    }
  fit(lo);
  for (const b of boxes)
    for (const c of b.corners) {
      uv[c * stride] = o.min[0] + b.x + (uv[c * stride] - b.x0) * lo;
      uv[c * stride + 1] = o.min[1] + b.y + (uv[c * stride + 1] - b.y0) * lo;
    }
}
