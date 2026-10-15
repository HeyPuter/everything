// Falloff fields for Expand (mask / face set expansion from a vertex): geodesic, topology,
// normal and spherical distances, plus the mapping from a falloff threshold to mask values.

export type ExpandFalloff = 'GEODESIC' | 'TOPOLOGY' | 'TOPOLOGY_DIAGONALS' | 'NORMALS' | 'SPHERICAL' | 'BOUNDARY_TOPOLOGY' | 'BOUNDARY_FACE_SET';

/** Binary min-heap of (key, value) pairs. */
class Heap {
  k: number[] = [];
  v: number[] = [];
  push(key: number, val: number) {
    const k = this.k,
      v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k,
      v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!,
      lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
  get size() {
    return this.k.length;
  }
}

/** Shortest path length along edges from the source vertices (Infinity where unreachable). */
export function geodesicDistances(P: ArrayLike<number>, nbOff: Uint32Array, nb: Uint32Array, sources: number[], hidden?: Uint8Array | null): Float32Array {
  const nv = nbOff.length - 1;
  // float64 while searching: rounding to float32 would make the heap entries look stale
  const d = new Float64Array(nv).fill(Infinity);
  const heap = new Heap();
  for (const s of sources) {
    d[s] = 0;
    heap.push(0, s);
  }
  while (heap.size) {
    const [dist, v] = heap.pop();
    if (dist > d[v]) continue;
    for (let k = nbOff[v]; k < nbOff[v + 1]; k++) {
      const u = nb[k];
      if (hidden?.[u]) continue;
      const nd = dist + Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
      if (nd < d[u]) {
        d[u] = nd;
        heap.push(nd, u);
      }
    }
  }
  return Float32Array.from(d);
}

/** Number of edge steps from the source vertices (Infinity where unreachable). */
export function topologySteps(nbOff: Uint32Array, nb: Uint32Array, sources: number[], hidden?: Uint8Array | null): Float32Array {
  const nv = nbOff.length - 1;
  const d = new Float32Array(nv).fill(Infinity);
  let front = sources.slice();
  for (const s of front) d[s] = 0;
  let step = 0;
  while (front.length) {
    step++;
    const next: number[] = [];
    for (const v of front)
      for (let k = nbOff[v]; k < nbOff[v + 1]; k++) {
        const u = nb[k];
        if (d[u] !== Infinity || hidden?.[u]) continue;
        d[u] = step;
        next.push(u);
      }
    front = next;
  }
  return d;
}

/** Vertex → vertices sharing a face (diagonal neighbours included), CSR. */
export function faceNeighbors(offsets: Uint32Array, indices: Uint32Array, nv: number): { offsets: Uint32Array; nb: Uint32Array } {
  const sets: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  for (let f = 0; f < offsets.length - 1; f++)
    for (let a = offsets[f]; a < offsets[f + 1]; a++) for (let b = offsets[f]; b < offsets[f + 1]; b++) if (a !== b) sets[indices[a]].add(indices[b]);
  const off = new Uint32Array(nv + 1);
  for (let v = 0; v < nv; v++) off[v + 1] = off[v] + sets[v].size;
  const nb = new Uint32Array(off[nv]);
  for (let v = 0; v < nv; v++) {
    let i = off[v];
    for (const u of sets[v]) nb[i++] = u;
  }
  return { offsets: off, nb };
}

/** Angle between each vertex normal and the origin's normal (radians), only where `reach` is finite. */
export function normalAngles(N: ArrayLike<number>, origin: number, reach?: Float32Array): Float32Array {
  const nv = N.length / 3;
  const out = new Float32Array(nv);
  const ox = N[origin * 3],
    oy = N[origin * 3 + 1],
    oz = N[origin * 3 + 2];
  for (let v = 0; v < nv; v++) {
    if (reach && reach[v] === Infinity) {
      out[v] = Infinity;
      continue;
    }
    const d = N[v * 3] * ox + N[v * 3 + 1] * oy + N[v * 3 + 2] * oz;
    out[v] = Math.acos(Math.max(-1, Math.min(1, d)));
  }
  return out;
}

/** Euclidean distance to the origin vertex. */
export function sphericalDistances(P: ArrayLike<number>, origin: number): Float32Array {
  const nv = P.length / 3;
  const out = new Float32Array(nv);
  for (let v = 0; v < nv; v++) out[v] = Math.hypot(P[v * 3] - P[origin * 3], P[v * 3 + 1] - P[origin * 3 + 1], P[v * 3 + 2] - P[origin * 3 + 2]);
  return out;
}

/** Scale a distance field to 0..1 (unreachable vertices become 1). */
export function normalizeField(d: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < d.length; i++) if (d[i] !== Infinity && d[i] > max) max = d[i];
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] === Infinity ? 1 : max > 0 ? d[i] / max : 0;
  return out;
}

export interface ExpandOptions {
  invert?: boolean;
  gradient?: boolean;
  /** number of repeated bands */
  loops?: number;
}

/** Whether a vertex with normalized falloff `f` is inside the expansion at `threshold`. */
export function expandInside(f: number, threshold: number, o: ExpandOptions = {}): boolean {
  const loops = Math.max(1, o.loops ?? 1);
  let x = f;
  if (loops > 1) x = (f * loops) % 1;
  const inside = threshold >= 1 ? true : x <= threshold;
  return o.invert ? !inside : inside;
}

/** Mask value (0..1) of a vertex for the expansion. */
export function expandValue(f: number, threshold: number, o: ExpandOptions = {}): number {
  if (!o.gradient) return expandInside(f, threshold, o) ? 1 : 0;
  const loops = Math.max(1, o.loops ?? 1);
  const x = loops > 1 ? (f * loops) % 1 : f;
  const t = Math.max(threshold, 1e-6);
  const g = x <= t ? 1 - x / t : 0;
  return o.invert ? 1 - g : g;
}
