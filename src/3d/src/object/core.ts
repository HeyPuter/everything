// Pure helpers for object-level data management (vertex groups, shape keys, names).
// Kept free of app state so they can be unit tested directly.
import type { CurveData, MeshData, ShapeKey } from '../data/types';

// ---------------------------------------------------------------------------
// names

const SIDE_SWAP: Record<string, string> = { L: 'R', R: 'L', l: 'r', r: 'l' };
const WORD_SWAP: Record<string, string> = { left: 'right', right: 'left', Left: 'Right', Right: 'Left', LEFT: 'RIGHT', RIGHT: 'LEFT' };

/**
 * Swap the side marker of a name: `Arm.L` ⇄ `Arm.R`, `L_hand` ⇄ `R_hand`, `leftEye` ⇄ `rightEye`.
 * A trailing number block (`Arm.L.001`) is kept. Returns the name unchanged when it has no side.
 */
export function flipSideName(name: string): string {
  const num = /\.\d+$/.exec(name);
  const stem = num ? name.slice(0, num.index) : name;
  const tail = num ? num[0] : '';
  // suffix: separator + single letter
  let m = /^(.*[._\- ])([LlRr])$/.exec(stem);
  if (m) return m[1] + SIDE_SWAP[m[2]] + tail;
  // prefix: single letter + separator
  m = /^([LlRr])([._\- ].*)$/.exec(stem);
  if (m) return SIDE_SWAP[m[1]] + m[2] + tail;
  // whole words anywhere (first occurrence)
  m = /(left|right|Left|Right|LEFT|RIGHT)/.exec(stem);
  if (m) return stem.slice(0, m.index) + WORD_SWAP[m[1]] + stem.slice(m.index + m[1].length) + tail;
  return name;
}

/** `base`, or `base.001`, `base.002`… whichever is free in `taken`. */
export function uniqueIn(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!set.has(n)) return n;
  }
}

// ---------------------------------------------------------------------------
// mirror lookup

/**
 * For every vertex, the index of the vertex at its mirrored position across the
 * local X = 0 plane (or -1 when there is none). Vertices on the plane map to themselves.
 */
export function mirrorVertexMap(positions: ArrayLike<number>, tolerance = 1e-4): Int32Array {
  const n = positions.length / 3;
  const out = new Int32Array(n).fill(-1);
  const inv = 1 / tolerance;
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = 0; i < n; i++) {
    const k = key(Math.round(positions[i * 3] * inv), Math.round(positions[i * 3 + 1] * inv), Math.round(positions[i * 3 + 2] * inv));
    const list = cells.get(k);
    if (list) list.push(i);
    else cells.set(k, [i]);
  }
  const tol2 = tolerance * tolerance * 4;
  for (let i = 0; i < n; i++) {
    const x = -positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    const cx = Math.round(x * inv),
      cy = Math.round(y * inv),
      cz = Math.round(z * inv);
    let best = -1,
      bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const j of list) {
            const ex = positions[j * 3] - x,
              ey = positions[j * 3 + 1] - y,
              ez = positions[j * 3 + 2] - z;
            const d = ex * ex + ey * ey + ez * ez;
            if (d <= tol2 && d < bestD) {
              bestD = d;
              best = j;
            }
          }
        }
    out[i] = best;
  }
  return out;
}

// ---------------------------------------------------------------------------
// vertex group weights

/** (w + offset) * gain, clamped to 0..1, for assigned (non-zero) weights. */
export function levelWeights(w: Float32Array, offset: number, gain: number, mask?: (v: number) => boolean): Float32Array {
  const out = new Float32Array(w);
  for (let i = 0; i < out.length; i++) {
    if (out[i] <= 0 || (mask && !mask(i))) continue;
    out[i] = Math.min(1, Math.max(0, (out[i] + offset) * gain));
  }
  return out;
}

/** Snap assigned weights to `steps` even steps. */
export function quantizeWeights(w: Float32Array, steps: number, mask?: (v: number) => boolean): Float32Array {
  const out = new Float32Array(w);
  const s = Math.max(1, Math.round(steps));
  for (let i = 0; i < out.length; i++) {
    if (out[i] <= 0 || (mask && !mask(i))) continue;
    out[i] = Math.round(out[i] * s) / s;
  }
  return out;
}

/** Weights moved to the mirrored vertices (vertices without a mirror keep nothing). */
export function mirrorWeights(w: Float32Array, map: Int32Array): Float32Array {
  const out = new Float32Array(w.length);
  for (let i = 0; i < w.length; i++) {
    const j = map[i];
    if (j >= 0) out[j] = w[i];
  }
  return out;
}

export interface VGroupMirrorOptions {
  mirror_weights: boolean;
  flip_group_names: boolean;
  all_groups: boolean;
}

/**
 * Mirror vertex groups across X. With name flipping, a group with a side marker swaps its
 * (mirrored) weights with the opposite-side group when that group exists; otherwise the
 * group is mirrored onto itself. Without weight mirroring only names are swapped.
 */
export function mirrorVertexGroups(me: MeshData, active: number, o: VGroupMirrorOptions, map = mirrorVertexMap(me.positions)): void {
  const names = me.vertex_groups.map((g) => g.name);
  const targets = o.all_groups ? names.map((_, i) => i) : [active];
  const done = new Set<number>();
  const weights = me.weights.slice();
  const groups = me.vertex_groups.map((g) => ({ ...g }));
  for (const g of targets) {
    if (done.has(g) || !groups[g]) continue;
    done.add(g);
    const pair = o.flip_group_names ? names.indexOf(flipSideName(names[g])) : -1;
    if (pair >= 0 && pair !== g) {
      done.add(pair);
      if (o.mirror_weights) {
        weights[g] = mirrorWeights(me.weights[pair], map);
        weights[pair] = mirrorWeights(me.weights[g], map);
      } else {
        weights[g] = me.weights[pair];
        weights[pair] = me.weights[g];
      }
    } else {
      if (o.mirror_weights) weights[g] = mirrorWeights(me.weights[g], map);
      if (o.flip_group_names && pair < 0) {
        const flipped = flipSideName(names[g]);
        if (flipped !== names[g]) groups[g].name = flipped;
      }
    }
  }
  me.weights = weights;
  me.vertex_groups = groups;
}

/** New order of groups (indices into the current list). */
export function sortedGroupOrder(names: string[], mode: 'NAME' | 'BONE_HIERARCHY', boneOrder: string[] = []): number[] {
  const idx = names.map((_, i) => i);
  if (mode === 'NAME') return idx.sort((a, b) => names[a].localeCompare(names[b], undefined, { numeric: true }));
  const rank = new Map(boneOrder.map((n, i) => [n, i]));
  // groups matching bones first in hierarchy order, the rest keep their order after them
  return idx.sort((a, b) => (rank.get(names[a]) ?? boneOrder.length + a) - (rank.get(names[b]) ?? boneOrder.length + b));
}

/** Reorder vertex groups and their weight arrays; returns the new index of `active`. */
export function reorderGroups(me: MeshData, order: number[], active: number): number {
  me.vertex_groups = order.map((i) => me.vertex_groups[i]);
  me.weights = order.map((i) => me.weights[i]);
  return Math.max(0, order.indexOf(active));
}

// ---------------------------------------------------------------------------
// shape keys

/** Mixed positions of all keys (what the shape key stack evaluates to). */
export function mixShapeKeys(me: MeshData): Float32Array {
  const keys = me.shape_keys;
  const out = new Float32Array(keys.length ? keys[0].data : me.positions);
  if (keys.length < 2) return out;
  const basis = keys[0].data;
  for (let k = 1; k < keys.length; k++) {
    const key = keys[k];
    if (key.mute || !key.value || key.data.length !== out.length) continue;
    const rel = keys.find((x) => x.name === key.relative_key)?.data ?? basis;
    const gi = key.vertex_group ? me.vertex_groups.findIndex((g) => g.name === key.vertex_group) : -1;
    const w = gi >= 0 ? me.weights[gi] : null;
    for (let i = 0; i < out.length; i++) out[i] += (key.data[i] - rel[i]) * key.value * (w ? w[(i / 3) | 0] : 1);
  }
  return out;
}

/** Mirror a shape key's offsets (relative to its reference key) across X. */
export function mirrorShapeKey(data: Float32Array, rel: Float32Array, map: Int32Array): Float32Array {
  const out = new Float32Array(rel);
  const n = data.length / 3;
  for (let i = 0; i < n; i++) {
    const j = map[i];
    if (j < 0) {
      // unmatched vertices keep their own offset
      for (let c = 0; c < 3; c++) out[i * 3 + c] = data[i * 3 + c];
      continue;
    }
    const dx = data[i * 3] - rel[i * 3],
      dy = data[i * 3 + 1] - rel[i * 3 + 1],
      dz = data[i * 3 + 2] - rel[i * 3 + 2];
    out[j * 3] = rel[j * 3] - dx;
    out[j * 3 + 1] = rel[j * 3 + 1] + dy;
    out[j * 3 + 2] = rel[j * 3 + 2] + dz;
  }
  return out;
}

/** Shape keys whose name is `name` are renamed in every `relative_key` reference too. */
export function renameShapeKey(keys: ShapeKey[], from: string, to: string) {
  for (const k of keys) {
    if (k.relative_key === from) k.relative_key = to;
    if (k.name === from) k.name = to;
  }
}

// ---------------------------------------------------------------------------
// centers of mass

function fanTriangles(me: MeshData, fn: (a: number, b: number, c: number) => void) {
  for (let f = 0; f + 1 < me.offsets.length; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    for (let c = s + 1; c + 1 < e; c++) fn(me.indices[s], me.indices[c], me.indices[c + 1]);
  }
}

/** Area-weighted centroid of the faces (falls back to the vertex average). */
export function surfaceCenter(me: MeshData): [number, number, number] {
  const P = me.positions;
  let area = 0;
  const acc = [0, 0, 0];
  fanTriangles(me, (a, b, c) => {
    const ux = P[b * 3] - P[a * 3],
      uy = P[b * 3 + 1] - P[a * 3 + 1],
      uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3],
      vy = P[c * 3 + 1] - P[a * 3 + 1],
      vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx;
    const w = Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    area += w;
    for (let k = 0; k < 3; k++) acc[k] += (w * (P[a * 3 + k] + P[b * 3 + k] + P[c * 3 + k])) / 3;
  });
  if (area > 1e-12) return [acc[0] / area, acc[1] / area, acc[2] / area];
  return vertexAverage(me);
}

/** Centroid of the enclosed volume (signed tetrahedra; needs a closed mesh, else the surface center). */
export function volumeCenter(me: MeshData): [number, number, number] {
  const P = me.positions;
  let vol = 0;
  const acc = [0, 0, 0];
  fanTriangles(me, (a, b, c) => {
    const ax = P[a * 3],
      ay = P[a * 3 + 1],
      az = P[a * 3 + 2];
    const bx = P[b * 3],
      by = P[b * 3 + 1],
      bz = P[b * 3 + 2];
    const cx = P[c * 3],
      cy = P[c * 3 + 1],
      cz = P[c * 3 + 2];
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    acc[0] += (v * (ax + bx + cx)) / 4;
    acc[1] += (v * (ay + by + cy)) / 4;
    acc[2] += (v * (az + bz + cz)) / 4;
  });
  if (Math.abs(vol) > 1e-12) return [acc[0] / vol, acc[1] / vol, acc[2] / vol];
  return surfaceCenter(me);
}

function vertexAverage(me: MeshData): [number, number, number] {
  const n = me.positions.length / 3;
  const acc: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) acc[k] += me.positions[i * 3 + k] / Math.max(1, n);
  return acc;
}

// ---------------------------------------------------------------------------
// mesh → curve

/**
 * Split the edges of a mesh (face edges and loose edges) into chains of vertex indices.
 * Chains break at vertices that do not have exactly two edges; closed loops are flagged cyclic.
 */
export function edgeChains(offsets: ArrayLike<number>, indices: ArrayLike<number>, nverts: number, loose?: ArrayLike<number>): { verts: number[]; cyclic: boolean }[] {
  const adj: number[][] = Array.from({ length: nverts }, () => []);
  const seen = new Set<string>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    adj[a].push(b);
    adj[b].push(a);
  };
  for (let f = 0; f + 1 < offsets.length; f++) {
    const s = offsets[f],
      e = offsets[f + 1];
    for (let c = s; c < e; c++) addEdge(indices[c], indices[c + 1 < e ? c + 1 : s]);
  }
  if (loose) for (let i = 0; i + 1 < loose.length; i += 2) addEdge(loose[i], loose[i + 1]);
  const used = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const out: { verts: number[]; cyclic: boolean }[] = [];
  const walk = (start: number, next: number) => {
    const verts = [start];
    let prev = start,
      cur = next;
    used.add(key(prev, cur));
    for (;;) {
      if (cur === start) return { verts, cyclic: true };
      verts.push(cur);
      if (adj[cur].length !== 2) break;
      const nxt = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
      if (used.has(key(cur, nxt))) break;
      used.add(key(cur, nxt));
      prev = cur;
      cur = nxt;
    }
    return { verts, cyclic: false };
  };
  // open chains start at branch points or ends
  for (let v = 0; v < nverts; v++) {
    if (adj[v].length === 2) continue;
    for (const n of adj[v]) if (!used.has(key(v, n))) out.push(walk(v, n));
  }
  // what remains are closed loops
  for (let v = 0; v < nverts; v++)
    for (const n of adj[v])
      if (!used.has(key(v, n))) out.push(walk(v, n));
  return out;
}

// ---------------------------------------------------------------------------
// curve control points

/** Control point positions of a curve (bezier knots and poly/NURBS points). */
export function curvePoints(cu: CurveData): Float32Array {
  const out: number[] = [];
  for (const s of cu.splines) {
    for (const b of s.bezier_points) out.push(b.co[0], b.co[1], b.co[2]);
    for (const p of s.points) out.push(p.co[0], p.co[1], p.co[2]);
  }
  return new Float32Array(out);
}

/** Move every control point and handle of a curve. */
export function translateCurve(cu: CurveData, d: [number, number, number]) {
  const add = (v: number[]) => [v[0] + d[0], v[1] + d[1], v[2] + d[2]] as [number, number, number];
  cu.splines = cu.splines.map((s) => ({
    ...s,
    bezier_points: s.bezier_points.map((b) => ({ ...b, co: add(b.co), handle_left: add(b.handle_left), handle_right: add(b.handle_right) })),
    points: s.points.map((p) => ({ ...p, co: [p.co[0] + d[0], p.co[1] + d[1], p.co[2] + d[2], p.co[3]] as [number, number, number, number] })),
  }));
}

// ---------------------------------------------------------------------------
// sharp edges by angle

/**
 * Per-corner sharp flags marking edges whose faces meet at more than `angle` (radians).
 * Boundary edges are left alone; `keep` keeps edges that are already sharp.
 */
export function sharpByAngle(me: MeshData, angle: number, keep: boolean, topo: { cornerEdge: Uint32Array; faceOffsets: Uint32Array; faces: Uint32Array; count: number }, faceNormals: Float32Array): Uint32Array {
  const out = new Uint32Array(me.indices.length);
  const cos = Math.cos(angle);
  const sharpEdge = new Uint8Array(topo.count);
  for (let e = 0; e < topo.count; e++) {
    const a = topo.faceOffsets[e],
      b = topo.faceOffsets[e + 1];
    if (b - a !== 2) continue;
    const f = topo.faces[a],
      g = topo.faces[a + 1];
    const d = faceNormals[f * 3] * faceNormals[g * 3] + faceNormals[f * 3 + 1] * faceNormals[g * 3 + 1] + faceNormals[f * 3 + 2] * faceNormals[g * 3 + 2];
    if (d < cos - 1e-7) sharpEdge[e] = 1;
  }
  for (let c = 0; c < out.length; c++) out[c] = sharpEdge[topo.cornerEdge[c]] || (keep && me.sharp?.[c]) ? 1 : 0;
  return out;
}
