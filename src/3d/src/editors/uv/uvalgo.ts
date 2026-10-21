// UV editing algorithms: weld/merge, align/straighten, island rotation, stretch relaxation,
// stitching, island scale/packing/arranging, randomizing and mirrored copies. They work on a
// UVTopo plus a writable UV array, so they are deterministic and unit-testable.
import type { MeshData } from '../../data/types';
import { UVTopo, faceUVArea, face3DArea, rng } from './uvcore';

type Sel = (c: number) => boolean;
type V2 = [number, number];

/** Selected corners grouped by UV vertex: [uvVert, corners]. */
export function selGroups(t: UVTopo, sel: Sel): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const f of t.faces)
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++)
      if (sel(c)) {
        const id = t.uvVert[c];
        let l = out.get(id);
        if (!l) out.set(id, (l = []));
        l.push(c);
      }
  return out;
}

function setCorners(uvs: Float32Array, corners: number[], u: number, v: number) {
  for (const c of corners) {
    uvs[c * 2] = u;
    uvs[c * 2 + 1] = v;
  }
}

/** Center of the selected UV vertices. */
export function selCenter(t: UVTopo, uvs: Float32Array, sel: Sel): V2 | null {
  let u = 0,
    v = 0,
    n = 0;
  for (const corners of selGroups(t, sel).values()) {
    u += uvs[corners[0] * 2];
    v += uvs[corners[0] * 2 + 1];
    n++;
  }
  return n ? [u / n, v / n] : null;
}

/** Bounding box of the selected UVs: [minU, minV, maxU, maxV]. */
export function selBounds(t: UVTopo, uvs: Float32Array, sel: Sel): [number, number, number, number] | null {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const corners of selGroups(t, sel).values()) {
    const u = uvs[corners[0] * 2],
      v = uvs[corners[0] * 2 + 1];
    a = Math.min(a, u);
    b = Math.min(b, v);
    c = Math.max(c, u);
    d = Math.max(d, v);
  }
  return a <= c ? [a, b, c, d] : null;
}

// ---------------------------------------------------------------------------
// merge

/** Move every selected UV to their common center. Returns the number of UV vertices moved. */
export function weld(t: UVTopo, uvs: Float32Array, sel: Sel): number {
  const g = selGroups(t, sel);
  const c = selCenter(t, uvs, sel);
  if (!c) return 0;
  for (const corners of g.values()) setCorners(uvs, corners, c[0], c[1]);
  return g.size;
}

/**
 * Merge selected UV vertices closer than `threshold`. With `useUnselected` selected UVs snap
 * onto nearby unselected ones instead; `useSharedVertex` only merges UVs of the same mesh vertex.
 * Returns the number of UV vertices removed.
 */
export function mergeByDistance(t: UVTopo, uvs: Float32Array, sel: Sel, threshold: number, useUnselected = false, useSharedVertex = false): number {
  const groups = [...selGroups(t, sel).entries()];
  const meshVert = (id: number) => t.me.indices[t.vertCorners[id][0]];
  const cell = Math.max(threshold, 1e-6);
  const hash = (u: number, v: number) => `${Math.floor(u / cell)},${Math.floor(v / cell)}`;
  const near = (grid: Map<string, number[]>, u: number, v: number) => {
    const out: number[] = [];
    const cu = Math.floor(u / cell),
      cv = Math.floor(v / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const x of grid.get(`${cu + i},${cv + j}`) ?? []) out.push(x);
    return out;
  };
  if (useUnselected) {
    const selected = new Set(groups.map(([id]) => id));
    const grid = new Map<string, number[]>();
    for (let id = 0; id < t.vertCount; id++) {
      if (selected.has(id)) continue;
      const [u, v] = t.vertUV(id);
      const k = hash(u, v);
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(id);
    }
    let n = 0;
    for (const [id, corners] of groups) {
      const u = uvs[corners[0] * 2],
        v = uvs[corners[0] * 2 + 1];
      let best = -1,
        bd = threshold;
      for (const o of near(grid, u, v)) {
        if (useSharedVertex && meshVert(o) !== meshVert(id)) continue;
        const [ou, ov] = t.vertUV(o);
        const d = Math.hypot(ou - u, ov - v);
        if (d <= bd) {
          bd = d;
          best = o;
        }
      }
      if (best >= 0) {
        const [ou, ov] = t.vertUV(best);
        setCorners(uvs, corners, ou, ov);
        n++;
      }
    }
    return n;
  }
  // union-find over selected elements within the threshold
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new Map<string, number[]>();
  groups.forEach(([, corners], i) => {
    const k = hash(uvs[corners[0] * 2], uvs[corners[0] * 2 + 1]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  groups.forEach(([id, corners], i) => {
    const u = uvs[corners[0] * 2],
      v = uvs[corners[0] * 2 + 1];
    for (const j of near(grid, u, v)) {
      if (j <= i) continue;
      const [oid, oc] = groups[j];
      if (useSharedVertex && meshVert(oid) !== meshVert(id)) continue;
      if (Math.hypot(uvs[oc[0] * 2] - u, uvs[oc[0] * 2 + 1] - v) <= threshold) parent[find(j)] = find(i);
    }
  });
  const clusters = new Map<number, number[]>();
  groups.forEach((_, i) => {
    const r = find(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(i);
  });
  let removed = 0;
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    let u = 0,
      v = 0;
    for (const i of members) {
      u += uvs[groups[i][1][0] * 2];
      v += uvs[groups[i][1][0] * 2 + 1];
    }
    u /= members.length;
    v /= members.length;
    for (const i of members) setCorners(uvs, groups[i][1], u, v);
    removed += members.length - 1;
  }
  return removed;
}

/** Move selected UVs onto the unselected UVs of the same mesh vertex (their average). */
export function snapToAdjacentUnselected(t: UVTopo, uvs: Float32Array, sel: Sel): number {
  const byMeshVert = new Map<number, number[]>();
  for (const f of t.faces)
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++)
      if (!sel(c)) {
        const v = t.me.indices[c];
        (byMeshVert.get(v) ?? byMeshVert.set(v, []).get(v)!).push(c);
      }
  let n = 0;
  for (const corners of selGroups(t, sel).values()) {
    const others = byMeshVert.get(t.me.indices[corners[0]]);
    if (!others?.length) continue;
    let u = 0,
      v = 0;
    for (const o of others) {
      u += t.me.uvs[o * 2];
      v += t.me.uvs[o * 2 + 1];
    }
    setCorners(uvs, corners, u / others.length, v / others.length);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// align

export type AlignAxis = 'ALIGN_S' | 'ALIGN_T' | 'ALIGN_U' | 'ALIGN_AUTO' | 'ALIGN_X' | 'ALIGN_Y';

/** Chains of selected UV edges: connected components of selected UV vertices. */
function selectedChains(t: UVTopo, sel: Sel): { verts: number[]; ends: number[] }[] {
  const g = selGroups(t, sel);
  const adj = new Map<number, Set<number>>();
  for (const id of g.keys()) adj.set(id, new Set());
  for (const f of t.faces)
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) {
      const n = t.next(c);
      if (sel(c) && sel(n)) {
        const a = t.uvVert[c],
          b = t.uvVert[n];
        if (a !== b) {
          adj.get(a)!.add(b);
          adj.get(b)!.add(a);
        }
      }
    }
  const seen = new Set<number>();
  const out: { verts: number[]; ends: number[] }[] = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const verts: number[] = [];
    const st = [s];
    seen.add(s);
    while (st.length) {
      const x = st.pop()!;
      verts.push(x);
      for (const y of adj.get(x)!)
        if (!seen.has(y)) {
          seen.add(y);
          st.push(y);
        }
    }
    out.push({ verts, ends: verts.filter((x) => adj.get(x)!.size === 1) });
  }
  return out;
}

export function align(t: UVTopo, uvs: Float32Array, sel: Sel, axis: AlignAxis, position: 'MEAN' | 'MIN' | 'MAX' = 'MEAN'): boolean {
  const groups = selGroups(t, sel);
  if (!groups.size) return false;
  const pos = (id: number): V2 => {
    const c = groups.get(id)![0];
    return [uvs[c * 2], uvs[c * 2 + 1]];
  };
  if (axis === 'ALIGN_X' || axis === 'ALIGN_Y' || axis === 'ALIGN_AUTO') {
    const b = selBounds(t, uvs, sel)!;
    let ax = axis === 'ALIGN_X' ? 0 : 1;
    if (axis === 'ALIGN_AUTO') ax = b[2] - b[0] <= b[3] - b[1] ? 0 : 1;
    let target = 0;
    if (position === 'MIN') target = b[ax];
    else if (position === 'MAX') target = b[ax + 2];
    else {
      for (const id of groups.keys()) target += pos(id)[ax];
      target /= groups.size;
    }
    for (const corners of groups.values()) for (const c of corners) uvs[c * 2 + ax] = target;
    return true;
  }
  // straighten each chain between its end points
  let changed = false;
  for (const ch of selectedChains(t, sel)) {
    if (ch.verts.length < 3) continue;
    let a: number, b: number;
    if (ch.ends.length === 2) [a, b] = ch.ends;
    else {
      // no clear chain: use the two UVs furthest apart
      let best = -1;
      a = b = ch.verts[0];
      for (const x of ch.verts)
        for (const y of ch.verts) {
          const p = pos(x),
            q = pos(y);
          const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d > best) {
            best = d;
            a = x;
            b = y;
          }
        }
    }
    const [au, av] = pos(a),
      [bu, bv] = pos(b);
    const du = bu - au,
      dv = bv - av;
    for (const id of ch.verts) {
      if (id === a || id === b) continue;
      let [u, v] = pos(id);
      if (axis === 'ALIGN_S') {
        const l2 = du * du + dv * dv;
        if (l2 < 1e-20) continue;
        const k = ((u - au) * du + (v - av) * dv) / l2;
        u = au + du * k;
        v = av + dv * k;
      } else if (axis === 'ALIGN_T') {
        if (Math.abs(dv) < 1e-12) continue;
        u = au + ((v - av) * du) / dv;
      } else {
        if (Math.abs(du) < 1e-12) continue;
        v = av + ((u - au) * dv) / du;
      }
      setCorners(uvs, groups.get(id)!, u, v);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// islands

/** Islands that contain a selected corner (all faces when `all`). */
export function selectedIslands(t: UVTopo, sel: Sel, all = false): number[][] {
  const out: number[][] = [];
  for (const faces of t.islandFaces()) {
    if (all || faces.some((f) => anyCorner(t, f, sel))) out.push(faces);
  }
  return out;
}

function anyCorner(t: UVTopo, f: number, sel: Sel) {
  for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (sel(c)) return true;
  return false;
}

/** Distinct corners of a face list. */
export function islandCorners(t: UVTopo, faces: number[]): number[] {
  const out: number[] = [];
  for (const f of faces) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) out.push(c);
  return out;
}

export function cornersBounds(uvs: Float32Array, corners: number[]): [number, number, number, number] {
  let a = Infinity,
    b = Infinity,
    c = -Infinity,
    d = -Infinity;
  for (const k of corners) {
    const u = uvs[k * 2],
      v = uvs[k * 2 + 1];
    if (u < a) a = u;
    if (v < b) b = v;
    if (u > c) c = u;
    if (v > d) d = v;
  }
  return [a, b, c, d];
}

function rotateCorners(uvs: Float32Array, corners: number[], ang: number, cu: number, cv: number) {
  const cs = Math.cos(ang),
    sn = Math.sin(ang);
  for (const k of corners) {
    const du = uvs[k * 2] - cu,
      dv = uvs[k * 2 + 1] - cv;
    uvs[k * 2] = cu + du * cs - dv * sn;
    uvs[k * 2 + 1] = cv + du * sn + dv * cs;
  }
}

/** Convex hull (monotone chain), counter-clockwise. */
export function convexHull(pts: V2[]): V2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: V2[] = [];
  for (const x of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], x) <= 0) lo.pop();
    lo.push(x);
  }
  const up: V2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const x = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], x) <= 0) up.pop();
    up.push(x);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Rotation (radians, within ±45°) that makes the axis-aligned bounding box of the points smallest. */
export function minAreaAngle(pts: V2[]): number {
  const hull = convexHull(pts);
  if (hull.length < 3) {
    if (hull.length === 2) {
      const a = Math.atan2(hull[1][1] - hull[0][1], hull[1][0] - hull[0][0]);
      return normQuarter(-a);
    }
    return 0;
  }
  let best = Infinity,
    bestAng = 0;
  const cands = new Set<number>([0]);
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i],
      b = hull[(i + 1) % hull.length];
    cands.add(normQuarter(-Math.atan2(b[1] - a[1], b[0] - a[0])));
  }
  for (const ang of cands) {
    const cs = Math.cos(ang),
      sn = Math.sin(ang);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * cs - y * sn,
        ry = x * sn + y * cs;
      x0 = Math.min(x0, rx);
      x1 = Math.max(x1, rx);
      y0 = Math.min(y0, ry);
      y1 = Math.max(y1, ry);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best - 1e-12 || (Math.abs(area - best) <= 1e-12 && Math.abs(ang) < Math.abs(bestAng))) {
      best = area;
      bestAng = ang;
    }
  }
  return bestAng;
}

/** Wrap an angle into (-45°, 45°]. */
export function normQuarter(a: number) {
  const q = Math.PI / 2;
  a = a - Math.round(a / q) * q;
  if (a <= -Math.PI / 4 + 1e-12) a += q;
  return a;
}

/**
 * Rotate islands with selected UVs. AUTO: smallest bounding box; EDGE: the selected edge
 * becomes horizontal or vertical; GEOMETRY: the given 3D axis points up (+V).
 */
export function alignRotation(t: UVTopo, uvs: Float32Array, sel: Sel, method: 'AUTO' | 'EDGE' | 'GEOMETRY', axis: 'X' | 'Y' | 'Z' = 'X'): number {
  let n = 0;
  for (const faces of selectedIslands(t, sel)) {
    const corners = islandCorners(t, faces);
    let ang = 0;
    if (method === 'AUTO') ang = minAreaAngle(corners.map((c) => [uvs[c * 2], uvs[c * 2 + 1]] as V2));
    else if (method === 'EDGE') {
      let found = false;
      for (const f of faces) {
        for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1] && !found; c++) {
          const nx = t.next(c);
          if (sel(c) && sel(nx)) {
            ang = normQuarter(-Math.atan2(uvs[nx * 2 + 1] - uvs[c * 2 + 1], uvs[nx * 2] - uvs[c * 2]));
            found = true;
          }
        }
        if (found) break;
      }
      if (!found) continue;
    } else {
      const d = axisDirectionInUV(t, uvs, faces, axis === 'X' ? 0 : axis === 'Y' ? 1 : 2);
      if (!d) continue;
      ang = Math.PI / 2 - Math.atan2(d[1], d[0]);
    }
    if (Math.abs(ang) < 1e-9) continue;
    const b = cornersBounds(uvs, corners);
    rotateCorners(uvs, corners, ang, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    n++;
  }
  return n;
}

/** Area-weighted UV direction of a 3D axis over the faces (through each triangle's 3D→UV map). */
function axisDirectionInUV(t: UVTopo, uvs: Float32Array, faces: number[], axis: number): V2 | null {
  const p = t.me.positions;
  let su = 0,
    sv = 0;
  for (const f of faces) {
    const s = t.me.offsets[f],
      e = t.me.offsets[f + 1];
    for (let i = s + 1; i < e - 1; i++) {
      const cs = [s, i, i + 1];
      const P = cs.map((c) => [p[t.me.indices[c] * 3], p[t.me.indices[c] * 3 + 1], p[t.me.indices[c] * 3 + 2]]);
      const U = cs.map((c) => [uvs[c * 2], uvs[c * 2 + 1]]);
      const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
      const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      // solve axis ≈ a·e1 + b·e2 (least squares in the triangle plane)
      const g11 = dot(e1, e1),
        g12 = dot(e1, e2),
        g22 = dot(e2, e2);
      const det = g11 * g22 - g12 * g12;
      if (det < 1e-20) continue;
      const r1 = e1[axis],
        r2 = e2[axis];
      const a = (r1 * g22 - r2 * g12) / det,
        b = (r2 * g11 - r1 * g12) / det;
      const area = Math.sqrt(det) / 2;
      su += (a * (U[1][0] - U[0][0]) + b * (U[2][0] - U[0][0])) * area;
      sv += (a * (U[1][1] - U[0][1]) + b * (U[2][1] - U[0][1])) * area;
    }
  }
  return Math.hypot(su, sv) > 1e-12 ? [su, sv] : null;
}

function dot(a: number[], b: number[]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Scale islands so they all have the same texel density (UV area per 3D area). */
export function averageIslandsScale(t: UVTopo, uvs: Float32Array, islands: number[][]): number {
  const me: MeshData = { ...t.me, uvs } as MeshData;
  const info = islands.map((faces) => {
    let a2 = 0,
      a3 = 0;
    for (const f of faces) {
      a2 += Math.abs(faceUVArea(me, f));
      a3 += face3DArea(t.me, f);
    }
    return { faces, a2, a3 };
  });
  const tot2 = info.reduce((s, i) => s + i.a2, 0),
    tot3 = info.reduce((s, i) => s + i.a3, 0);
  if (tot2 <= 0 || tot3 <= 0) return 0;
  const density = tot2 / tot3;
  let n = 0;
  for (const i of info) {
    if (i.a2 <= 1e-20 || i.a3 <= 1e-20) continue;
    const s = Math.sqrt((density * i.a3) / i.a2);
    const corners = islandCorners(t, i.faces);
    const b = cornersBounds(uvs, corners);
    const cu = (b[0] + b[2]) / 2,
      cv = (b[1] + b[3]) / 2;
    for (const k of corners) {
      uvs[k * 2] = cu + (uvs[k * 2] - cu) * s;
      uvs[k * 2 + 1] = cv + (uvs[k * 2 + 1] - cv) * s;
    }
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// packing

interface Box {
  corners: number[];
  w: number;
  h: number;
  x0: number;
  y0: number;
}

/** Bottom-left skyline packing of rectangles into a strip of width 1; returns the used height. */
function skyline(boxes: { w: number; h: number }[], margin: number, out: V2[]): number {
  let sky: { x: number; y: number; w: number }[] = [{ x: 0, y: 0, w: 1 }];
  let top = 0;
  for (let i = 0; i < boxes.length; i++) {
    const w = boxes[i].w + margin,
      h = boxes[i].h + margin;
    let bestY = Infinity,
      bestX = 0,
      bestI = -1;
    for (let s = 0; s < sky.length; s++) {
      const x = sky[s].x;
      if (x + w > 1 + 1e-9) break;
      let y = 0,
        span = 0,
        j = s;
      while (span < w - 1e-12 && j < sky.length) {
        y = Math.max(y, sky[j].y);
        span += sky[j].w;
        j++;
      }
      if (span < w - 1e-12) continue;
      if (y < bestY - 1e-12) {
        bestY = y;
        bestX = x;
        bestI = s;
      }
    }
    if (bestI < 0) {
      // wider than the strip: put it on top
      bestY = top;
      bestX = 0;
      out[i] = [bestX, bestY];
      top = bestY + h;
      sky = [{ x: 0, y: top, w: 1 }];
      continue;
    }
    out[i] = [bestX, bestY];
    top = Math.max(top, bestY + h);
    // raise the skyline under the box
    const next: { x: number; y: number; w: number }[] = [];
    const x0 = bestX,
      x1 = bestX + w;
    for (const seg of sky) {
      const s0 = seg.x,
        s1 = seg.x + seg.w;
      if (s1 <= x0 + 1e-12 || s0 >= x1 - 1e-12) next.push(seg);
      else {
        if (s0 < x0) next.push({ x: s0, y: seg.y, w: x0 - s0 });
        if (s1 > x1) next.push({ x: x1, y: seg.y, w: s1 - x1 });
      }
    }
    next.push({ x: x0, y: bestY + h, w });
    next.sort((a, b) => a.x - b.x);
    // merge neighbours of equal height
    sky = [];
    for (const seg of next) {
      const last = sky[sky.length - 1];
      if (last && Math.abs(last.y - seg.y) < 1e-12 && Math.abs(last.x + last.w - seg.x) < 1e-9) last.w += seg.w;
      else sky.push({ ...seg });
    }
  }
  return top;
}

export interface PackOptions {
  margin: number;
  rotate: boolean;
  rotateMethod?: 'ANY' | 'CARDINAL' | 'AXIS_ALIGNED' | 'AXIS_ALIGNED_X' | 'AXIS_ALIGNED_Y';
  /** scale the islands to fill the unit square (else keep their size) */
  scale: boolean;
  /** target rectangle [x, y, width, height] in UV space (default: the 0–1 square) */
  region?: [number, number, number, number];
}

/** Pack islands into the 0–1 UV square keeping their relative sizes. */
export function packIslandsUV(t: UVTopo, uvs: Float32Array, islands: number[][], o: PackOptions): boolean {
  if (!islands.length) return false;
  // pack in a space where the target region is the unit square, then map back
  const [RX, RY, RW0, RH0] = o.region ?? [0, 0, 1, 1];
  const RW = Math.max(RW0, 1e-9),
    RH = Math.max(RH0, 1e-9);
  const boxes: Box[] = islands.map((faces) => {
    const corners = islandCorners(t, faces);
    if (o.rotate) {
      const m = o.rotateMethod ?? 'ANY';
      let b = cornersBounds(uvs, corners);
      if (m === 'ANY') {
        const ang = minAreaAngle(corners.map((c) => [uvs[c * 2], uvs[c * 2 + 1]] as V2));
        rotateCorners(uvs, corners, ang, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
        b = cornersBounds(uvs, corners);
      }
      const w = b[2] - b[0],
        h = b[3] - b[1];
      // orient: tall islands for the vertical method, wide ones otherwise
      const wantTall = m === 'AXIS_ALIGNED_Y' || m === 'ANY' || m === 'AXIS_ALIGNED';
      if (m !== 'CARDINAL' && ((wantTall && w > h * (1 + 1e-6)) || (m === 'AXIS_ALIGNED_X' && h > w * (1 + 1e-6)))) rotateCorners(uvs, corners, Math.PI / 2, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
      if (m === 'AXIS_ALIGNED' || m === 'AXIS_ALIGNED_X' || m === 'AXIS_ALIGNED_Y') {
        const ang = minAreaAngle(corners.map((c) => [uvs[c * 2], uvs[c * 2 + 1]] as V2));
        const bb = cornersBounds(uvs, corners);
        rotateCorners(uvs, corners, ang, (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
        const b2 = cornersBounds(uvs, corners);
        const w2 = b2[2] - b2[0],
          h2 = b2[3] - b2[1];
        if ((m !== 'AXIS_ALIGNED_X' && w2 > h2 * (1 + 1e-6)) || (m === 'AXIS_ALIGNED_X' && h2 > w2 * (1 + 1e-6))) rotateCorners(uvs, corners, Math.PI / 2, (b2[0] + b2[2]) / 2, (b2[1] + b2[3]) / 2);
      }
    }
    const b = cornersBounds(uvs, corners);
    return { corners, w: Math.max(b[2] - b[0], 1e-9) / RW, h: Math.max(b[3] - b[1], 1e-9) / RH, x0: b[0], y0: b[1] };
  });
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h || boxes[b].w - boxes[a].w);
  const pos: V2[] = [];
  const m = o.margin;
  let k = 1;
  if (o.scale) {
    // find the largest scale at which everything fits in the unit square
    const area = boxes.reduce((s, b) => s + b.w * b.h, 0);
    const maxSide = Math.max(...boxes.map((b) => Math.max(b.w, b.h)));
    let hi = Math.min(1 / Math.sqrt(area), (1 - m) / maxSide),
      lo = hi;
    const fits = (s: number) => skyline(order.map((i) => ({ w: boxes[i].w * s, h: boxes[i].h * s })), m, []) <= 1 - m + 1e-9;
    if (!fits(hi)) {
      // step down until it fits, then refine between the last failing and the fitting scale
      lo = hi * 0.9;
      for (let it = 0; it < 60 && !fits(lo); it++) {
        hi = lo;
        lo *= 0.9;
      }
      for (let it = 0; it < 8; it++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
    }
    k = lo;
  }
  const sorted = order.map((i) => ({ w: boxes[i].w * k, h: boxes[i].h * k }));
  skyline(sorted, m, pos);
  order.forEach((bi, j) => {
    const b = boxes[bi];
    const [x, y] = pos[j];
    for (const c of b.corners) {
      uvs[c * 2] = RX + (m + x) * RW + (uvs[c * 2] - b.x0) * k;
      uvs[c * 2 + 1] = RY + (m + y) * RH + (uvs[c * 2 + 1] - b.y0) * k;
    }
  });
  return true;
}

export interface ArrangeOptions {
  initial_position: 'BOUNDING_BOX' | 'UV_GRID' | 'ACTIVE_UDIM' | 'CURSOR';
  axis: 'X' | 'Y';
  align: 'MIN' | 'MAX' | 'CENTER' | 'NONE';
  order: 'LARGE_TO_SMALL' | 'SMALL_TO_LARGE' | 'Fixed';
  margin: number;
}

/** Line islands up next to each other along an axis without changing their size. */
export function arrangeIslands(t: UVTopo, uvs: Float32Array, islands: number[][], o: ArrangeOptions, cursor: V2 = [0, 0]): boolean {
  if (!islands.length) return false;
  const boxes = islands.map((faces) => {
    const corners = islandCorners(t, faces);
    const b = cornersBounds(uvs, corners);
    return { corners, b, size: (b[2] - b[0]) * (b[3] - b[1]) };
  });
  if (o.order !== 'Fixed') boxes.sort((a, b) => (o.order === 'LARGE_TO_SMALL' ? b.size - a.size : a.size - b.size));
  let start: V2;
  if (o.initial_position === 'CURSOR') start = cursor;
  else if (o.initial_position === 'BOUNDING_BOX') {
    start = [Math.min(...boxes.map((b) => b.b[0])), Math.min(...boxes.map((b) => b.b[1]))];
  } else start = [0, 0];
  const ax = o.axis === 'X' ? 0 : 1,
    cross = 1 - ax;
  const crossMax = Math.max(...boxes.map((b) => b.b[cross + 2] - b.b[cross]));
  let along = start[ax];
  for (const box of boxes) {
    const off: V2 = [0, 0];
    off[ax] = along - box.b[ax];
    const ext = box.b[cross + 2] - box.b[cross];
    if (o.align === 'MIN') off[cross] = start[cross] - box.b[cross];
    else if (o.align === 'MAX') off[cross] = start[cross] + crossMax - ext - box.b[cross];
    else if (o.align === 'CENTER') off[cross] = start[cross] + (crossMax - ext) / 2 - box.b[cross];
    for (const c of box.corners) {
      uvs[c * 2] += off[0];
      uvs[c * 2 + 1] += off[1];
    }
    along += box.b[ax + 2] - box.b[ax] + o.margin;
  }
  return true;
}

export interface RandomizeOptions {
  random_seed: number;
  use_loc: boolean;
  loc: V2;
  use_rot: boolean;
  rot: number;
  use_scale: boolean;
  scale_even: boolean;
  scale: V2;
}

/** Randomly offset, rotate and scale islands with selected UVs. */
export function randomizeIslands(t: UVTopo, uvs: Float32Array, islands: number[][], o: RandomizeOptions): number {
  const r = rng(o.random_seed);
  const s = () => r() * 2 - 1;
  for (const faces of islands) {
    const corners = islandCorners(t, faces);
    const b = cornersBounds(uvs, corners);
    const cu = (b[0] + b[2]) / 2,
      cv = (b[1] + b[3]) / 2;
    const du = s() * o.loc[0],
      dv = s() * o.loc[1];
    const ang = s() * o.rot;
    const se = s();
    const su = 1 + se * (o.scale[0] - 1),
      sv = 1 + (o.scale_even ? se : s()) * (o.scale[1] - 1);
    const cs = Math.cos(ang),
      sn = Math.sin(ang);
    for (const c of corners) {
      let x = uvs[c * 2] - cu,
        y = uvs[c * 2 + 1] - cv;
      if (o.use_scale) {
        x *= su;
        y *= o.scale_even ? su : sv;
      }
      if (o.use_rot) {
        const rx = x * cs - y * sn;
        y = x * sn + y * cs;
        x = rx;
      }
      uvs[c * 2] = cu + x + (o.use_loc ? du : 0);
      uvs[c * 2 + 1] = cv + y + (o.use_loc ? dv : 0);
    }
  }
  return islands.length;
}

// ---------------------------------------------------------------------------
// minimize stretch

/**
 * Relax the selected, unpinned UV vertices toward the shape of the 3D surface: each triangle's
 * 3D shape is fitted to its current UVs with a rotation and uniform scale, and every vertex moves
 * to the average of where its triangles want it.
 */
export function minimizeStretch(t: UVTopo, uvs: Float32Array, movable: Set<number>, iterations: number, blend = 0): number {
  if (!movable.size || iterations <= 0) return 0;
  const p = t.me.positions;
  const orig = new Float32Array(uvs);
  // triangles touching movable vertices, with their flattened 3D shape
  const tris: { c: [number, number, number]; r: [V2, V2, V2]; w: number }[] = [];
  for (const f of t.faces) {
    const s = t.me.offsets[f],
      e = t.me.offsets[f + 1];
    let touches = false;
    for (let c = s; c < e; c++) if (movable.has(t.uvVert[c])) touches = true;
    if (!touches) continue;
    for (let i = s + 1; i < e - 1; i++) {
      const cs: [number, number, number] = [s, i, i + 1];
      const P = cs.map((c) => [p[t.me.indices[c] * 3], p[t.me.indices[c] * 3 + 1], p[t.me.indices[c] * 3 + 2]]);
      const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
      const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      const l1 = Math.hypot(e1[0], e1[1], e1[2]);
      if (l1 < 1e-12) continue;
      const x2 = dot(e1, e2) / l1;
      const y2 = Math.sqrt(Math.max(0, dot(e2, e2) - x2 * x2));
      if (y2 < 1e-12) continue;
      // keep the UV winding of the face so mirrored islands relax correctly
      const ua = uvs[cs[0] * 2],
        va = uvs[cs[0] * 2 + 1];
      const wind = (uvs[cs[1] * 2] - ua) * (uvs[cs[2] * 2 + 1] - va) - (uvs[cs[2] * 2] - ua) * (uvs[cs[1] * 2 + 1] - va);
      const flip = wind < 0 ? -1 : 1;
      tris.push({ c: cs, r: [[0, 0], [l1, 0], [x2, y2 * flip]], w: (l1 * y2) / 2 });
    }
  }
  const nv = t.vertCount;
  const acc = new Float64Array(nv * 2),
    wsum = new Float64Array(nv);
  for (let it = 0; it < iterations; it++) {
    acc.fill(0);
    wsum.fill(0);
    for (const tri of tris) {
      const U = tri.c.map((c) => [uvs[c * 2], uvs[c * 2 + 1]]);
      // best similarity transform rest → current (2D Procrustes)
      const rc = [(tri.r[0][0] + tri.r[1][0] + tri.r[2][0]) / 3, (tri.r[0][1] + tri.r[1][1] + tri.r[2][1]) / 3];
      const uc = [(U[0][0] + U[1][0] + U[2][0]) / 3, (U[0][1] + U[1][1] + U[2][1]) / 3];
      let a = 0,
        b = 0,
        n = 0;
      for (let k = 0; k < 3; k++) {
        const x = tri.r[k][0] - rc[0],
          y = tri.r[k][1] - rc[1];
        const X = U[k][0] - uc[0],
          Y = U[k][1] - uc[1];
        a += x * X + y * Y;
        b += x * Y - y * X;
        n += x * x + y * y;
      }
      if (n < 1e-20) continue;
      a /= n;
      b /= n;
      for (let k = 0; k < 3; k++) {
        const id = t.uvVert[tri.c[k]];
        if (!movable.has(id)) continue;
        const x = tri.r[k][0] - rc[0],
          y = tri.r[k][1] - rc[1];
        acc[id * 2] += (uc[0] + a * x - b * y) * tri.w;
        acc[id * 2 + 1] += (uc[1] + b * x + a * y) * tri.w;
        wsum[id] += tri.w;
      }
    }
    for (const id of movable) {
      if (!wsum[id]) continue;
      const u = acc[id * 2] / wsum[id],
        v = acc[id * 2 + 1] / wsum[id];
      for (const c of t.vertCorners[id]) {
        uvs[c * 2] = u;
        uvs[c * 2 + 1] = v;
      }
    }
  }
  if (blend > 0)
    for (const id of movable)
      for (const c of t.vertCorners[id]) {
        uvs[c * 2] = uvs[c * 2] * (1 - blend) + orig[c * 2] * blend;
        uvs[c * 2 + 1] = uvs[c * 2 + 1] * (1 - blend) + orig[c * 2 + 1] * blend;
      }
  return movable.size;
}

// ---------------------------------------------------------------------------
// stitch

export interface StitchOptions {
  mode: 'VERTEX' | 'EDGE';
  snap_islands: boolean;
  midpoint_snap: boolean;
  use_limit: boolean;
  limit: number;
  static_island: number;
  clear_seams: boolean;
}

/**
 * Stitch selected UVs to the other UVs of the same mesh vertex (or edge). Islands can first be
 * moved and rotated as a whole so the stitched UVs line up. Returns the number of stitched groups
 * and the corners whose seams were cleared.
 */
export function stitch(t: UVTopo, uvs: Float32Array, sel: Sel, o: StitchOptions): { groups: number; seamCorners: number[] } {
  const selVerts = new Set(selGroups(t, sel).keys());
  // pairs of UV vertices to join, as groups per mesh vertex
  const pairs: [number, number][] = [];
  if (o.mode === 'EDGE') {
    for (const corners of t.meshEdges.values()) {
      const selected = corners.filter((c) => sel(c) && sel(t.next(c)));
      if (selected.length < 1 || corners.length < 2) continue;
      for (let i = 0; i < corners.length; i++)
        for (let j = i + 1; j < corners.length; j++) {
          const a = corners[i],
            b = corners[j];
          if (!(sel(a) && sel(t.next(a))) || !(sel(b) && sel(t.next(b)))) continue;
          if (t.edgeKey(a) === t.edgeKey(b)) continue; // already connected
          // match endpoints by mesh vertex
          const an = t.next(a),
            bn = t.next(b);
          const sameDir = t.me.indices[a] === t.me.indices[b];
          pairs.push([t.uvVert[a], t.uvVert[sameDir ? b : bn]], [t.uvVert[an], t.uvVert[sameDir ? bn : b]]);
        }
    }
  } else {
    const byMesh = new Map<number, number[]>();
    for (const id of selVerts) {
      const v = t.me.indices[t.vertCorners[id][0]];
      (byMesh.get(v) ?? byMesh.set(v, []).get(v)!).push(id);
    }
    for (const ids of byMesh.values()) for (let i = 1; i < ids.length; i++) pairs.push([ids[0], ids[i]]);
  }
  const pos = (id: number): V2 => {
    const c = t.vertCorners[id][0];
    return [uvs[c * 2], uvs[c * 2 + 1]];
  };
  const usable = pairs.filter(([a, b]) => a !== b && (!o.use_limit || Math.hypot(pos(a)[0] - pos(b)[0], pos(a)[1] - pos(b)[1]) <= o.limit));
  if (!usable.length) return { groups: 0, seamCorners: [] };
  const { faceIsland } = t.islands;
  const islandOf = (id: number) => faceIsland[t.cornerFace[t.vertCorners[id][0]]];
  // islands taking part, ordered; the static one stays in place
  const involved = [...new Set(usable.flatMap(([a, b]) => [islandOf(a), islandOf(b)]))].sort((a, b) => a - b);
  const staticIsland = involved[Math.min(Math.max(0, o.static_island), involved.length - 1)];
  const placed = new Set<number>([staticIsland]);
  if (o.snap_islands && !o.midpoint_snap) {
    // grow from the static island: fit each neighbouring island onto the placed ones
    let progress = true;
    while (progress) {
      progress = false;
      for (const isl of involved) {
        if (placed.has(isl)) continue;
        const src: V2[] = [],
          dst: V2[] = [];
        for (const [a, b] of usable) {
          const ia = islandOf(a),
            ib = islandOf(b);
          if (ia === isl && placed.has(ib)) {
            src.push(pos(a));
            dst.push(pos(b));
          } else if (ib === isl && placed.has(ia)) {
            src.push(pos(b));
            dst.push(pos(a));
          }
        }
        if (!src.length) continue;
        const tf = rigidFit(src, dst);
        const corners = islandCorners(
          t,
          t.faces.filter((f) => faceIsland[f] === isl),
        );
        for (const c of corners) {
          const [x, y] = tf(uvs[c * 2], uvs[c * 2 + 1]);
          uvs[c * 2] = x;
          uvs[c * 2 + 1] = y;
        }
        placed.add(isl);
        progress = true;
      }
    }
  }
  // join: union UV vertices into stitch groups
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of usable) parent.set(find(a), find(b));
  const groups = new Map<number, number[]>();
  for (const [a, b] of usable)
    for (const x of [a, b]) {
      const r = find(x);
      const l = groups.get(r) ?? groups.set(r, []).get(r)!;
      if (!l.includes(x)) l.push(x);
    }
  for (const members of groups.values()) {
    let target: V2;
    const anchor = members.find((m) => islandOf(m) === staticIsland);
    if (!o.midpoint_snap && anchor !== undefined) target = pos(anchor);
    else {
      let u = 0,
        v = 0;
      for (const m of members) {
        u += pos(m)[0];
        v += pos(m)[1];
      }
      target = [u / members.length, v / members.length];
    }
    for (const m of members) for (const c of t.vertCorners[m]) {
      uvs[c * 2] = target[0];
      uvs[c * 2 + 1] = target[1];
    }
  }
  // seams between stitched UVs
  const seamCorners: number[] = [];
  if (o.clear_seams) {
    const joined = new Set(usable.flat());
    for (const corners of t.meshEdges.values()) {
      if (corners.length < 2) continue;
      if (corners.every((c) => joined.has(t.uvVert[c]) && joined.has(t.uvVert[t.next(c)]))) seamCorners.push(...corners);
    }
  }
  return { groups: groups.size, seamCorners };
}

/** Rotation + translation that best maps src points onto dst points. */
export function rigidFit(src: V2[], dst: V2[]): (x: number, y: number) => V2 {
  const n = src.length;
  let sx = 0,
    sy = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  let a = 0,
    b = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx,
      y = src[i][1] - sy;
    const X = dst[i][0] - dx,
      Y = dst[i][1] - dy;
    a += x * X + y * Y;
    b += x * Y - y * X;
  }
  const ang = n > 1 && Math.hypot(a, b) > 1e-15 ? Math.atan2(b, a) : 0;
  const cs = Math.cos(ang),
    sn = Math.sin(ang);
  return (x, y) => {
    const px = x - sx,
      py = y - sy;
    return [dx + px * cs - py * sn, dy + px * sn + py * cs];
  };
}

// ---------------------------------------------------------------------------
// seams

/** Per-corner seam flags marking every UV island border that is not a mesh border. */
export function seamsFromIslands(t: UVTopo, base?: ArrayLike<number>): { seams: Uint32Array; sharpCorners: number[] } {
  const seams = new Uint32Array(t.me.indices.length);
  if (base) for (let i = 0; i < seams.length; i++) seams[i] = base[i] ? 1 : 0;
  const sharpCorners: number[] = [];
  for (const corners of t.meshEdges.values()) {
    if (corners.length < 2) continue;
    // split in UV when the shown faces do not share the UV edge
    if (new Set(corners.map((c) => t.edgeKey(c))).size > 1) {
      for (const c of corners) seams[c] = 1;
      sharpCorners.push(...corners);
    }
  }
  return { seams, sharpCorners };
}

// ---------------------------------------------------------------------------
// mirrored copies

/**
 * Copy UVs from faces on one side of a mesh axis to their mirrored counterparts.
 * Returns the number of faces changed.
 */
export function copyMirroredFaces(t: UVTopo, uvs: Float32Array, axis: 'POS_X' | 'POS_Y' | 'POS_Z' | 'NEG_X' | 'NEG_Y' | 'NEG_Z', precision: number): number {
  const me = t.me;
  const ax = axis.endsWith('X') ? 0 : axis.endsWith('Y') ? 1 : 2;
  const toPos = axis.startsWith('POS'); // -X to +X: copy from the negative side onto the positive side
  const scale = Math.pow(10, precision);
  const q = (x: number) => Math.round(x * scale);
  const vkey = (v: number, mirror: boolean) => {
    const p = [me.positions[v * 3], me.positions[v * 3 + 1], me.positions[v * 3 + 2]];
    if (mirror) p[ax] = -p[ax];
    return `${q(p[0])},${q(p[1])},${q(p[2])}`;
  };
  const faceSide = (f: number) => {
    let s = 0;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) s += me.positions[me.indices[c] * 3 + ax];
    return s / (me.offsets[f + 1] - me.offsets[f]);
  };
  // index source faces by their (mirrored) vertex positions
  const eps = 0.5 / scale;
  const src = new Map<string, number>();
  for (const f of t.faces) {
    const side = faceSide(f);
    if (toPos ? side >= -eps : side <= eps) continue;
    const key = [...Array.from({ length: me.offsets[f + 1] - me.offsets[f] }, (_, i) => vkey(me.indices[me.offsets[f] + i], true))].sort().join('|');
    src.set(key, f);
  }
  let n = 0;
  for (const f of t.faces) {
    const side = faceSide(f);
    if (toPos ? side <= eps : side >= -eps) continue;
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    const key = [...Array.from({ length: e - s }, (_, i) => vkey(me.indices[s + i], false))].sort().join('|');
    const g = src.get(key);
    if (g === undefined) continue;
    // match corners by mirrored position
    const map = new Map<string, number>();
    for (let c = me.offsets[g]; c < me.offsets[g + 1]; c++) map.set(vkey(me.indices[c], true), c);
    for (let c = s; c < e; c++) {
      const sc = map.get(vkey(me.indices[c], false));
      if (sc === undefined) continue;
      uvs[c * 2] = uvs[sc * 2];
      uvs[c * 2 + 1] = uvs[sc * 2 + 1];
    }
    n++;
  }
  return n;
}
