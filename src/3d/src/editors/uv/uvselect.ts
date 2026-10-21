// UV selection queries: picking, edge loops/rings, grow/shrink, similar, overlap, winding and
// shortest paths. Pure functions over UVTopo.
import type { MeshData } from '../../data/types';
import { UVTopo, faceUVArea, face3DArea, pointInFace, segDist, faceUVCenter, isPinned } from './uvcore';

type Sel = (c: number) => boolean;

// ---------------------------------------------------------------------------
// picking

/** Nearest UV vertex to (u, v) within `radius` (UV units). */
export function pickVert(t: UVTopo, u: number, v: number, radius: number): { id: number; corner: number; d: number } | null {
  let best: { id: number; corner: number; d: number } | null = null;
  for (let id = 0; id < t.vertCorners.length; id++) {
    const c = t.vertCorners[id][0];
    const d = Math.hypot(t.u(c) - u, t.v(c) - v);
    if (d <= radius && (!best || d < best.d)) best = { id, corner: c, d };
  }
  return best;
}

/** Nearest UV edge (as the corner starting it) within `radius`. */
export function pickEdge(t: UVTopo, u: number, v: number, radius: number): { corner: number; d: number } | null {
  let best: { corner: number; d: number } | null = null;
  for (const f of t.faces)
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) {
      const n = t.next(c);
      const { d } = segDist(u, v, t.u(c), t.v(c), t.u(n), t.v(n));
      if (d <= radius && (!best || d < best.d - 1e-12)) best = { corner: c, d };
    }
  return best;
}

/** Face under (u, v); when none contains the point, the face with the nearest center within `radius`. */
export function pickFace(t: UVTopo, u: number, v: number, radius: number): number {
  let best = -1,
    bestArea = Infinity;
  for (const f of t.faces)
    if (pointInFace(t.me, f, u, v)) {
      const a = Math.abs(faceUVArea(t.me, f));
      if (a < bestArea) {
        bestArea = a;
        best = f;
      }
    }
  if (best >= 0) return best;
  let bd = radius;
  for (const f of t.faces) {
    const [cu, cv] = faceUVCenter(t.me, f);
    const d = Math.hypot(cu - u, cv - v);
    if (d <= bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// loops and rings

function edgeEnds(t: UVTopo, c: number): [number, number] {
  return [t.uvVert[c], t.uvVert[t.next(c)]];
}

/** Edges (key → a corner starting it) touching a UV vertex. */
function incident(t: UVTopo, id: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const k of t.vertCorners[id]) {
    out.set(t.edgeKey(k), k);
    const p = t.prev(k);
    out.set(t.edgeKey(p), p);
  }
  return out;
}

function edgeFaceSet(t: UVTopo, key: number): Set<number> {
  return new Set((t.edges.get(key) ?? []).map((c) => t.cornerFace[c]));
}

/** UV edge loop through the edge starting at corner c; returns a corner per edge. */
export function edgeLoop(t: UVTopo, c0: number): number[] {
  const k0 = t.edgeKey(c0);
  const out = [c0];
  const seen = new Set([k0]);
  const [a0, b0] = edgeEnds(t, c0);
  for (const start of [b0, a0]) {
    let key = k0,
      at = start;
    for (let guard = 0; guard < 1e6; guard++) {
      const inc = incident(t, at);
      inc.delete(key);
      const boundary = (t.edges.get(key)?.length ?? 0) < 2;
      let next = -1;
      if (boundary) {
        const others = [...inc.entries()].filter(([k]) => (t.edges.get(k)?.length ?? 0) < 2);
        if (others.length === 1) next = others[0][1];
      } else if (inc.size === 3) {
        const faces = edgeFaceSet(t, key);
        const cands = [...inc.entries()].filter(([k]) => ![...edgeFaceSet(t, k)].some((f) => faces.has(f)));
        // a regular grid vertex: four quads around it
        let quads = true;
        for (const k of t.vertCorners[at]) if (t.me.offsets[t.cornerFace[k] + 1] - t.me.offsets[t.cornerFace[k]] !== 4) quads = false;
        if (cands.length === 1 && quads) next = cands[0][1];
      }
      if (next < 0) break;
      const nk = t.edgeKey(next);
      if (seen.has(nk)) break;
      seen.add(nk);
      out.push(next);
      const [x, y] = edgeEnds(t, next);
      at = x === at ? y : x;
      key = nk;
    }
  }
  return out;
}

/** UV edge ring through the edge starting at corner c; returns edge corners and the faces crossed. */
export function edgeRing(t: UVTopo, c0: number): { corners: number[]; faces: number[] } {
  const k0 = t.edgeKey(c0);
  const corners = [c0];
  const faces: number[] = [];
  const seenKeys = new Set([k0]);
  const seenFaces = new Set<number>();
  for (const startCorner of t.edges.get(k0) ?? [c0]) {
    let c = startCorner;
    for (let guard = 0; guard < 1e6; guard++) {
      const f = t.cornerFace[c];
      if (seenFaces.has(f)) break;
      if (t.me.offsets[f + 1] - t.me.offsets[f] !== 4) break;
      seenFaces.add(f);
      faces.push(f);
      const opp = t.next(t.next(c));
      const key = t.edgeKey(opp);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        corners.push(opp);
      }
      const across = (t.edges.get(key) ?? []).filter((x) => x !== opp);
      if (!across.length) break;
      c = across[0];
    }
  }
  return { corners, faces };
}

// ---------------------------------------------------------------------------
// grow / shrink

/** Corners to select for "Select More": every corner of faces touching the selection. */
export function growCorners(t: UVTopo, sel: Sel, faceMode: boolean): number[] {
  const out: number[] = [];
  const selVert = new Uint8Array(t.vertCount);
  if (faceMode) {
    for (const f of t.faces) {
      let all = true;
      for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (!sel(c)) all = false;
      if (all) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) selVert[t.uvVert[c]] = 1;
    }
  } else for (const f of t.faces) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (sel(c)) selVert[t.uvVert[c]] = 1;
  for (const f of t.faces) {
    let touch = false;
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (selVert[t.uvVert[c]]) touch = true;
    if (!touch) continue;
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) {
      if (faceMode) out.push(c);
      else for (const k of t.vertCorners[t.uvVert[c]]) out.push(k);
    }
  }
  return out;
}

/** Corners to deselect for "Select Less": selected UVs on the border of the selection. */
export function shrinkCorners(t: UVTopo, sel: Sel, faceMode: boolean): number[] {
  const fullFace = new Uint8Array(t.me.offsets.length - 1);
  for (const f of t.faces) {
    let all = true;
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (!sel(c)) all = false;
    fullFace[f] = all ? 1 : 0;
  }
  const out: number[] = [];
  if (faceMode) {
    for (const f of t.faces) {
      if (!fullFace[f]) continue;
      let border = false;
      for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1] && !border; c++) for (const k of t.vertCorners[t.uvVert[c]]) if (!fullFace[t.cornerFace[k]]) border = true;
      if (border) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) out.push(c);
    }
    return out;
  }
  for (let id = 0; id < t.vertCount; id++) {
    const cs = t.vertCorners[id];
    if (!cs.some(sel)) continue;
    if (cs.some((k) => !fullFace[t.cornerFace[k]])) out.push(...cs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// similar

export type SimilarType = 'PIN' | 'LENGTH' | 'LENGTH_3D' | 'AREA' | 'AREA_3D' | 'MATERIAL' | 'OBJECT' | 'SIDES' | 'WINDING' | 'FACE';
export type Compare = 'EQUAL' | 'GREATER' | 'LESS';

export function compareValue(x: number, refs: number[], cmp: Compare, threshold: number): boolean {
  for (const r of refs) {
    const tol = threshold * Math.max(Math.abs(r), 1e-12) + 1e-9 * Math.max(1, Math.abs(r));
    if (cmp === 'EQUAL' && Math.abs(x - r) <= tol) return true;
    if (cmp === 'GREATER' && x >= r - tol) return true;
    if (cmp === 'LESS' && x <= r + tol) return true;
  }
  return false;
}

function edgeLen(t: UVTopo, c: number, d3: boolean) {
  const n = t.next(c);
  if (!d3) return Math.hypot(t.u(n) - t.u(c), t.v(n) - t.v(c));
  const p = t.me.positions,
    a = t.me.indices[c] * 3,
    b = t.me.indices[n] * 3;
  return Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
}

export interface SimilarInput {
  t: UVTopo;
  sel: Sel;
  objectIndex: number;
}

/**
 * Corners to add for Select Similar, per layer. `mode` is the UV select mode; the reference values
 * come from the selection of all layers.
 */
export function similarCorners(layers: SimilarInput[], mode: 'VERTEX' | 'EDGE' | 'FACE' | 'ISLAND', type: SimilarType, cmp: Compare, threshold: number): number[][] {
  const refs: number[] = [];
  const out: number[][] = layers.map(() => []);
  if (mode === 'VERTEX') {
    if (type !== 'PIN') return out;
    for (const { t, sel } of layers) for (let id = 0; id < t.vertCount; id++) if (t.vertCorners[id].some(sel)) refs.push(t.vertCorners[id].some((c) => isPinned(t.me, c)) ? 1 : 0);
    layers.forEach(({ t }, li) => {
      for (let id = 0; id < t.vertCount; id++) {
        const v = t.vertCorners[id].some((c) => isPinned(t.me, c)) ? 1 : 0;
        if (compareValue(v, refs, cmp, threshold)) out[li].push(...t.vertCorners[id]);
      }
    });
    return out;
  }
  if (mode === 'EDGE') {
    const val = (t: UVTopo, c: number) => (type === 'LENGTH' ? edgeLen(t, c, false) : type === 'LENGTH_3D' ? edgeLen(t, c, true) : type === 'PIN' ? (isPinned(t.me, c) && isPinned(t.me, t.next(c)) ? 1 : 0) : NaN);
    if (!['LENGTH', 'LENGTH_3D', 'PIN'].includes(type)) return out;
    for (const { t, sel } of layers) for (const f of t.faces) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (sel(c) && sel(t.next(c))) refs.push(val(t, c));
    layers.forEach(({ t }, li) => {
      for (const f of t.faces) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (compareValue(val(t, c), refs, cmp, threshold)) out[li].push(...t.vertCorners[t.uvVert[c]], ...t.vertCorners[t.uvVert[t.next(c)]]);
    });
    return out;
  }
  if (mode === 'ISLAND') {
    if (!['AREA', 'AREA_3D', 'FACE'].includes(type)) return out;
    const islandVals = (t: UVTopo) =>
      t.islandFaces().map((faces) => {
        let v = 0;
        for (const f of faces) v += type === 'AREA' ? Math.abs(faceUVArea(t.me, f)) : type === 'AREA_3D' ? face3DArea(t.me, f) : 1;
        return { faces, v };
      });
    const all = layers.map(({ t }) => islandVals(t));
    layers.forEach(({ t, sel }, li) => {
      for (const isl of all[li]) if (isl.faces.some((f) => faceFull(t, f, sel))) refs.push(isl.v);
    });
    layers.forEach(({ t }, li) => {
      for (const isl of all[li]) if (compareValue(isl.v, refs, cmp, threshold)) for (const f of isl.faces) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) out[li].push(c);
    });
    return out;
  }
  // faces
  const faceVal = (t: UVTopo, f: number, objectIndex: number, me: MeshData) => {
    switch (type) {
      case 'AREA':
        return Math.abs(faceUVArea(me, f));
      case 'AREA_3D':
        return face3DArea(me, f);
      case 'MATERIAL':
        return me.material_index?.[f] ?? 0;
      case 'OBJECT':
        return objectIndex;
      case 'SIDES':
        return me.offsets[f + 1] - me.offsets[f];
      case 'WINDING':
        return faceUVArea(me, f) >= 0 ? 1 : 0;
      case 'PIN': {
        let all = true;
        for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!isPinned(me, c)) all = false;
        return all ? 1 : 0;
      }
    }
    return NaN;
  };
  if (type === 'LENGTH' || type === 'LENGTH_3D' || type === 'FACE') return out;
  const exact = type === 'MATERIAL' || type === 'OBJECT' || type === 'SIDES' || type === 'WINDING' || type === 'PIN';
  for (const { t, sel, objectIndex } of layers) for (const f of t.faces) if (faceFull(t, f, sel)) refs.push(faceVal(t, f, objectIndex, t.me));
  layers.forEach(({ t, objectIndex }, li) => {
    for (const f of t.faces) {
      const x = faceVal(t, f, objectIndex, t.me);
      const ok = exact && cmp === 'EQUAL' ? refs.includes(x) : compareValue(x, refs, cmp, threshold);
      if (ok) for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) out[li].push(c);
    }
  });
  return out;
}

function faceFull(t: UVTopo, f: number, sel: Sel) {
  for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (!sel(c)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// overlap / winding

type Tri = [number, number, number, number, number, number];

function faceTris(me: MeshData, f: number): Tri[] {
  const s = me.offsets[f],
    e = me.offsets[f + 1];
  const out: Tri[] = [];
  for (let i = s + 1; i < e - 1; i++) out.push([me.uvs[s * 2], me.uvs[s * 2 + 1], me.uvs[i * 2], me.uvs[i * 2 + 1], me.uvs[(i + 1) * 2], me.uvs[(i + 1) * 2 + 1]]);
  return out;
}

/** Whether two triangles overlap with a positive area (touching edges do not count). */
export function trisOverlap(a: Tri, b: Tri, eps = 1e-7): boolean {
  for (const [p, q] of [
    [a, b],
    [b, a],
  ] as [Tri, Tri][]) {
    for (let i = 0; i < 3; i++) {
      const x0 = p[i * 2],
        y0 = p[i * 2 + 1];
      const x1 = p[((i + 1) % 3) * 2],
        y1 = p[((i + 1) % 3) * 2 + 1];
      const nx = y0 - y1,
        ny = x1 - x0;
      const len = Math.hypot(nx, ny);
      if (len < 1e-15) continue;
      let pmin = Infinity,
        pmax = -Infinity,
        qmin = Infinity,
        qmax = -Infinity;
      for (let k = 0; k < 3; k++) {
        const d = (p[k * 2] * nx + p[k * 2 + 1] * ny) / len;
        pmin = Math.min(pmin, d);
        pmax = Math.max(pmax, d);
        const e = (q[k * 2] * nx + q[k * 2 + 1] * ny) / len;
        qmin = Math.min(qmin, e);
        qmax = Math.max(qmax, e);
      }
      if (pmax <= qmin + eps || qmax <= pmin + eps) return false;
    }
  }
  return true;
}

/** Faces of the layers whose UVs overlap another face (from any layer). */
export function overlappingFaces(layers: UVTopo[]): number[][] {
  const items: { li: number; f: number; tris: Tri[]; b: [number, number, number, number] }[] = [];
  layers.forEach((t, li) => {
    for (const f of t.faces) {
      const tris = faceTris(t.me, f);
      let a = Infinity,
        b = Infinity,
        c = -Infinity,
        d = -Infinity;
      for (const tr of tris)
        for (let k = 0; k < 3; k++) {
          a = Math.min(a, tr[k * 2]);
          c = Math.max(c, tr[k * 2]);
          b = Math.min(b, tr[k * 2 + 1]);
          d = Math.max(d, tr[k * 2 + 1]);
        }
      items.push({ li, f, tris, b: [a, b, c, d] });
    }
  });
  const out: Set<number>[] = layers.map(() => new Set());
  // sweep along u
  const order = items.map((_, i) => i).sort((x, y) => items[x].b[0] - items[y].b[0]);
  const active: number[] = [];
  for (const i of order) {
    const it = items[i];
    for (let j = active.length - 1; j >= 0; j--) if (items[active[j]].b[2] < it.b[0]) active.splice(j, 1);
    for (const j of active) {
      const o = items[j];
      if (o.b[1] > it.b[3] || o.b[3] < it.b[1]) continue;
      if (o.li === it.li && o.f === it.f) continue;
      let hit = false;
      for (const ta of it.tris) {
        for (const tb of o.tris)
          if (trisOverlap(ta, tb)) {
            hit = true;
            break;
          }
        if (hit) break;
      }
      if (hit) {
        out[it.li].add(it.f);
        out[o.li].add(o.f);
      }
    }
    active.push(i);
  }
  return out.map((s) => [...s]);
}

/** Faces whose UV winding is counter-clockwise (positive) or clockwise (negative). */
export function windingFaces(t: UVTopo, positive: boolean): number[] {
  return t.faces.filter((f) => (faceUVArea(t.me, f) > 0) === positive && Math.abs(faceUVArea(t.me, f)) > 1e-14);
}

// ---------------------------------------------------------------------------
// shortest path

/** Shortest chain of UV vertices between two UV vertices along UV edges (by UV length). */
function vertGraph(t: UVTopo, topology: boolean): [number, number][][] {
  const adj: [number, number][][] = Array.from({ length: t.vertCount }, () => []);
  for (const corners of t.edges.values()) {
    const c = corners[0];
    const a = t.uvVert[c],
      b = t.uvVert[t.next(c)];
    const w = topology ? 1 : Math.hypot(t.u(c) - t.u(t.next(c)), t.v(c) - t.v(t.next(c)));
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  }
  return adj;
}

export function shortestVertPath(t: UVTopo, from: number, to: number, topology = false): number[] {
  return dijkstra(t.vertCount, vertGraph(t, topology), from, to);
}

/** Every element on some shortest path between two (fill: the region between them on a grid). */
function fillBetween(n: number, adj: [number, number][][], from: number, to: number): number[] {
  const a = distances(n, adj, from),
    b = distances(n, adj, to);
  const best = a[to];
  if (!Number.isFinite(best)) return [];
  const eps = 1e-7 * Math.max(1, best);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (a[i] + b[i] <= best + eps) out.push(i);
  return out;
}

export function shortestVertFill(t: UVTopo, from: number, to: number, topology = false): number[] {
  return fillBetween(t.vertCount, vertGraph(t, topology), from, to);
}

export function shortestFaceFill(t: UVTopo, from: number, to: number, topology = false): number[] {
  return fillBetween(t.me.offsets.length - 1, faceGraph(t, topology), from, to);
}

/** Shortest chain of faces between two faces across shared UV edges. */
export function shortestFacePath(t: UVTopo, from: number, to: number, topology = false): number[] {
  return dijkstra(t.me.offsets.length - 1, faceGraph(t, topology), from, to);
}

function faceGraph(t: UVTopo, topology: boolean): [number, number][][] {
  const nf = t.me.offsets.length - 1;
  const adj: [number, number][][] = Array.from({ length: nf }, () => []);
  for (const corners of t.edges.values()) {
    if (corners.length < 2) continue;
    for (let i = 0; i < corners.length; i++)
      for (let j = i + 1; j < corners.length; j++) {
        const a = t.cornerFace[corners[i]],
          b = t.cornerFace[corners[j]];
        const ca = faceUVCenter(t.me, a),
          cb = faceUVCenter(t.me, b);
        const w = topology ? 1 : Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
        adj[a].push([b, w]);
        adj[b].push([a, w]);
      }
  }
  return adj;
}

/** Distances of every node from `from` (unreachable: Infinity). */
function distances(n: number, adj: [number, number][][], from: number): Float64Array {
  const dist = new Float64Array(n).fill(Infinity);
  dist[from] = 0;
  const done = new Uint8Array(n);
  // binary heap of [distance, node]
  const heap: [number, number][] = [[0, from]];
  const push = (e: [number, number]) => {
    heap.push(e);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = i * 2 + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, x] = pop();
    if (done[x]) continue;
    done[x] = 1;
    for (const [y, w] of adj[x]) {
      const nd = d + w;
      if (nd < dist[y]) {
        dist[y] = nd;
        push([nd, y]);
      }
    }
  }
  return dist;
}

function dijkstra(n: number, adj: [number, number][][], from: number, to: number): number[] {
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  // binary heap
  const heap: [number, number][] = [[0, from]];
  const push = (x: [number, number]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, x] = pop();
    if (done[x]) continue;
    done[x] = 1;
    if (x === to) break;
    for (const [y, w] of adj[x]) {
      const nd = d + w;
      if (nd < dist[y]) {
        dist[y] = nd;
        prev[y] = x;
        push([nd, y]);
      }
    }
  }
  if (!Number.isFinite(dist[to])) return [];
  const path: number[] = [];
  for (let x = to; x >= 0; x = prev[x]) {
    path.push(x);
    if (x === from) break;
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------
// rip

/**
 * Rip: keep selected only the corners on the side of the pointer, so moving the selection tears
 * the UVs apart. Corners of fully selected faces stay selected (region rip).
 */
export function ripKeep(t: UVTopo, sel: Sel, u: number, v: number): Set<number> {
  const keep = new Set<number>();
  const fullFace = (f: number) => {
    for (let c = t.me.offsets[f]; c < t.me.offsets[f + 1]; c++) if (!sel(c)) return false;
    return true;
  };
  for (let id = 0; id < t.vertCount; id++) {
    const cs = t.vertCorners[id].filter(sel);
    if (!cs.length) continue;
    const full = cs.filter((c) => fullFace(t.cornerFace[c]));
    if (full.length) {
      for (const c of full) keep.add(c);
      continue;
    }
    // single UVs / edges: the corners whose face lies toward the pointer
    const pu = t.u(cs[0]),
      pv = t.v(cs[0]);
    let best = -Infinity;
    const scored = cs.map((c) => {
      const [cu, cv] = faceUVCenter(t.me, t.cornerFace[c]);
      const dx = cu - pu,
        dy = cv - pv;
      const l = Math.hypot(dx, dy) || 1;
      const mx = u - pu,
        my = v - pv;
      const ml = Math.hypot(mx, my) || 1;
      const s = (dx * mx + dy * my) / (l * ml);
      best = Math.max(best, s);
      return { c, s };
    });
    let mine = scored.filter((x) => x.s >= best - 1e-6 || x.s > 0);
    // never keep every corner: that would not tear anything
    if (mine.length === scored.length && scored.length > 1) mine = scored.filter((x) => x.s >= best - 1e-6);
    for (const x of mine) keep.add(x.c);
  }
  return keep;
}
