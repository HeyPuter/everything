// Skin: builds a quad surface around the vertices and edges of a mesh (a stick figure), using a
// radius per vertex. Chains become square tubes, end points get caps and branch points get a
// convex hull hub joining the tubes.
import { Vector3 } from 'three';
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { MeshBuilder } from '../meshbuild';
import { edgeTopology } from '../../mesh/mesh';
import { bool, num } from './common';
import { convexHull } from './hull';

export const DEFAULT_SKIN_RADIUS = 0.25;
/** Per-vertex skin data stride: radius x, radius y, root flag, loose flag. */
export const SKIN_STRIDE = 4;

/** Default skin data: every vertex has the default radius and the first vertex of each part is a root. */
export function defaultSkinData(m: { positions: ArrayLike<number>; offsets: ArrayLike<number>; indices: ArrayLike<number>; looseEdges?: ArrayLike<number> }): Float32Array {
  const nv = m.positions.length / 3;
  const out = new Float32Array(nv * SKIN_STRIDE);
  for (let v = 0; v < nv; v++) {
    out[v * SKIN_STRIDE] = DEFAULT_SKIN_RADIUS;
    out[v * SKIN_STRIDE + 1] = DEFAULT_SKIN_RADIUS;
  }
  const g = skinGraph(m);
  for (const comp of components(g, nv)) out[comp[0] * SKIN_STRIDE + 2] = 1;
  return out;
}

interface Graph {
  offsets: Uint32Array;
  adj: Uint32Array;
}

/** Vertex adjacency through face edges and loose edges. */
export function skinGraph(m: { positions: ArrayLike<number>; offsets: ArrayLike<number>; indices: ArrayLike<number>; looseEdges?: ArrayLike<number> }): Graph {
  const nv = m.positions.length / 3;
  const pairs: number[] = [];
  if (m.offsets.length > 1) {
    const et = edgeTopology(m as never);
    for (let e = 0; e < et.count; e++) pairs.push(et.verts[e * 2], et.verts[e * 2 + 1]);
  }
  const seen = new Set<string>();
  const add: number[] = [];
  for (let i = 0; i < pairs.length; i += 2) seen.add(pairs[i] < pairs[i + 1] ? `${pairs[i]}:${pairs[i + 1]}` : `${pairs[i + 1]}:${pairs[i]}`);
  if (m.looseEdges)
    for (let i = 0; i + 1 < m.looseEdges.length; i += 2) {
      const a = m.looseEdges[i],
        b = m.looseEdges[i + 1];
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (a === b || seen.has(k)) continue;
      seen.add(k);
      add.push(a, b);
    }
  const all = pairs.concat(add);
  const offsets = new Uint32Array(nv + 1);
  for (const v of all) offsets[v + 1]++;
  for (let i = 0; i < nv; i++) offsets[i + 1] += offsets[i];
  const adj = new Uint32Array(all.length),
    fill = offsets.slice(0, nv);
  for (let i = 0; i < all.length; i += 2) {
    adj[fill[all[i]]++] = all[i + 1];
    adj[fill[all[i + 1]]++] = all[i];
  }
  return { offsets, adj };
}

function components(g: Graph, nv: number, roots?: ArrayLike<number> | null): number[][] {
  const comp = new Int32Array(nv).fill(-1);
  const out: number[][] = [];
  // visit roots first so each part starts at its root
  const order: number[] = [];
  if (roots) for (let v = 0; v < nv; v++) if (roots[v]) order.push(v);
  for (let v = 0; v < nv; v++) order.push(v);
  for (const s of order) {
    if (comp[s] >= 0 || g.offsets[s + 1] === g.offsets[s]) continue;
    const list = [s];
    comp[s] = out.length;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      for (let k = g.offsets[v]; k < g.offsets[v + 1]; k++) {
        const w = g.adj[k];
        if (comp[w] < 0) {
          comp[w] = out.length;
          list.push(w);
        }
      }
    }
    out.push(list);
  }
  return out;
}

/** A unit vector perpendicular to `d`, as close as possible to `hint`. */
function perpendicular(d: Vector3, hint: Vector3, out: Vector3): Vector3 {
  out.copy(hint).addScaledVector(d, -hint.dot(d));
  if (out.lengthSq() < 1e-10) {
    out.set(0, 0, 1).addScaledVector(d, -d.z);
    if (out.lengthSq() < 1e-10) out.set(0, 1, 0).addScaledVector(d, -d.y);
  }
  return out.normalize();
}

export interface SkinOptions {
  smooth: boolean;
  branchSmoothing: number;
}

export function buildSkin(m: EvalMesh, skin: Float32Array, opts: SkinOptions): EvalMesh {
  const P = m.positions,
    nv = P.length / 3;
  const g = skinGraph(m);
  const deg = (v: number) => g.offsets[v + 1] - g.offsets[v];
  const rad = (v: number, k: number) => Math.max(1e-5, Math.abs(skin[v * SKIN_STRIDE + k] ?? DEFAULT_SKIN_RADIUS));
  const roots = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) roots[v] = skin[v * SKIN_STRIDE + 2] ? 1 : 0;
  const b = new MeshBuilder();
  const smooth = opts.smooth ? 1 : 0;
  const pos = (v: number) => new Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);

  // traversal from the roots: parents, depth order and the "up" vector of each vertex frame
  const parent = new Int32Array(nv).fill(-1);
  const up: (Vector3 | null)[] = new Array(nv).fill(null);
  const dir: (Vector3 | null)[] = new Array(nv).fill(null);
  const order: number[] = [];
  for (const comp of components(g, nv, roots)) {
    const root = comp[0];
    const queue = [root];
    const seen = new Set([root]);
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i];
      order.push(v);
      for (let k = g.offsets[v]; k < g.offsets[v + 1]; k++) {
        const w = g.adj[k];
        if (seen.has(w)) continue;
        seen.add(w);
        parent[w] = v;
        queue.push(w);
      }
    }
  }
  // frame direction per vertex (chains and ends; branches use per-edge rings)
  const tmp = new Vector3();
  for (const v of order) {
    const d = deg(v);
    if (d === 1) {
      const w = g.adj[g.offsets[v]];
      dir[v] = pos(w).sub(pos(v)).normalize();
      if (parent[v] === w) dir[v]!.negate();
    } else if (d === 2) {
      let a = g.adj[g.offsets[v]],
        c = g.adj[g.offsets[v] + 1];
      if (parent[v] === c) [a, c] = [c, a];
      const din = pos(v).sub(pos(a)).normalize(),
        dout = pos(c).sub(pos(v)).normalize();
      dir[v] = din.add(dout);
      if (dir[v]!.lengthSq() < 1e-10) dir[v] = dout;
      dir[v]!.normalize();
    }
    const pu = parent[v] >= 0 ? up[parent[v]] : null;
    const dv = dir[v] ?? (parent[v] >= 0 ? pos(v).sub(pos(parent[v])).normalize() : new Vector3(0, 0, 1));
    up[v] = perpendicular(dv, pu ?? (Math.abs(dv.z) > 0.9 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1)), new Vector3());
    void tmp;
  }

  /** Square ring (4 new vertices) around center c facing direction d. */
  const ring = (c: Vector3, d: Vector3, upHint: Vector3, rx: number, ry: number, orig: number): number[] => {
    const u = perpendicular(d, upHint, new Vector3());
    const s = new Vector3().crossVectors(u, d).normalize();
    const pts = [
      [1, -1],
      [-1, -1],
      [-1, 1],
      [1, 1],
    ];
    return pts.map(([a, bb]) => {
      const p = c.clone().addScaledVector(s, a * rx).addScaledVector(u, bb * ry);
      return b.addVert(p.x, p.y, p.z, orig);
    });
  };
  const ringOf = new Map<number, number[]>(); // chain/end vertex → its ring
  for (const v of order) if (deg(v) === 1 || deg(v) === 2) ringOf.set(v, ring(pos(v), dir[v]!, up[v]!, rad(v, 0), rad(v, 1), v));

  // tubes along edges (oriented parent → child)
  const hubRings = new Map<number, number[][]>(); // branch vertex → first rings of its edges
  const hubVerts = new Set<number>();
  const quadOut = (q: number[], axisA: Vector3, axisB: Vector3) => {
    // flip the quad if its normal points towards the edge axis
    const pa = new Vector3().fromArray(b.pos, q[0] * 3),
      pb = new Vector3().fromArray(b.pos, q[1] * 3),
      pc = new Vector3().fromArray(b.pos, q[2] * 3);
    const n = new Vector3().subVectors(pb, pa).cross(new Vector3().subVectors(pc, pa));
    const cen = new Vector3();
    for (const i of q) cen.add(new Vector3().fromArray(b.pos, i * 3));
    cen.multiplyScalar(0.25);
    const axis = new Vector3().subVectors(axisB, axisA);
    const t = axis.lengthSq() > 0 ? new Vector3().subVectors(cen, axisA).dot(axis) / axis.lengthSq() : 0;
    const onAxis = axisA.clone().addScaledVector(axis, t);
    if (n.dot(new Vector3().subVectors(cen, onAxis)) < 0) q.reverse();
    b.addFace(q, undefined, smooth);
  };
  const connect = (r0: number[], r1: number[], A: Vector3, B: Vector3) => {
    // pick the corner rotation of r1 that best matches r0 (frames can twist along a chain)
    let shift = 0,
      bestD = Infinity;
    for (let s = 0; s < 4; s++) {
      let dsum = 0;
      for (let i = 0; i < 4; i++) dsum += new Vector3().fromArray(b.pos, r0[i] * 3).distanceToSquared(new Vector3().fromArray(b.pos, r1[(i + s) % 4] * 3));
      if (dsum < bestD) {
        bestD = dsum;
        shift = s;
      }
    }
    for (let i = 0; i < 4; i++) quadOut([r0[i], r0[(i + 1) % 4], r1[(i + 1 + shift) % 4], r1[(i + shift) % 4]], A, B);
  };
  for (const v of order) {
    const p = parent[v];
    if (p < 0) continue;
    const A = pos(p),
      B = pos(v);
    const len = A.distanceTo(B);
    const rmax = Math.max(rad(p, 0), rad(p, 1), rad(v, 0), rad(v, 1));
    let segs = Math.max(1, Math.ceil(len / (1.6 * rmax)));
    const branchA = deg(p) > 2,
      branchB = deg(v) > 2;
    if (branchA || branchB) segs = Math.max(segs, 2);
    const d = new Vector3().subVectors(B, A).normalize();
    const rings: number[][] = [];
    if (!branchA) rings.push(ringOf.get(p)!);
    const upA = up[p]!;
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const c = A.clone().lerp(B, t);
      rings.push(ring(c, d, upA, rad(p, 0) + (rad(v, 0) - rad(p, 0)) * t, rad(p, 1) + (rad(v, 1) - rad(p, 1)) * t, -1));
    }
    if (!branchB) rings.push(ringOf.get(v)!);
    for (let i = 0; i + 1 < rings.length; i++) connect(rings[i], rings[i + 1], A, B);
    // the ring nearest to a branch vertex joins its hub
    if (branchA) (hubRings.get(p) ?? hubRings.set(p, []).get(p)!).push(rings[0]);
    if (branchB) (hubRings.get(v) ?? hubRings.set(v, []).get(v)!).push(rings[rings.length - 1]);
  }

  // caps at the ends
  for (const v of order) {
    if (deg(v) !== 1) continue;
    const r = ringOf.get(v)!.slice();
    const out = dir[v]!.clone();
    // the cap faces away from the neighbour
    const w = g.adj[g.offsets[v]];
    if (out.dot(new Vector3().subVectors(pos(v), pos(w))) < 0) out.negate();
    const pa = new Vector3().fromArray(b.pos, r[0] * 3),
      pb = new Vector3().fromArray(b.pos, r[1] * 3),
      pc = new Vector3().fromArray(b.pos, r[2] * 3);
    const n = new Vector3().subVectors(pb, pa).cross(new Vector3().subVectors(pc, pa));
    if (n.dot(out) < 0) r.reverse();
    b.addFace(r, undefined, smooth);
  }

  // branch hubs: convex hull of the neighbouring rings, minus each ring's own opening
  for (const [, rings] of hubRings) {
    const ids = rings.flat();
    const pts: number[] = [];
    for (const i of ids) pts.push(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]);
    const tris = convexHull(pts);
    const ringOfPt = new Map<number, number>();
    rings.forEach((r, ri) => r.forEach((i) => ringOfPt.set(i, ri)));
    const kept: number[][] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const f = [ids[tris[t]], ids[tris[t + 1]], ids[tris[t + 2]]];
      const r0 = ringOfPt.get(f[0]);
      if (r0 !== undefined && ringOfPt.get(f[1]) === r0 && ringOfPt.get(f[2]) === r0) continue;
      kept.push(f);
    }
    for (const f of mergeTriangles(kept, b.pos)) b.addFace(f, undefined, smooth);
    for (const i of ids) hubVerts.add(i);
  }
  let out = b.build();
  if (opts.branchSmoothing > 0 && hubVerts.size) out = smoothVerts(out, hubVerts, opts.branchSmoothing);
  return out;
}

/** Join coplanar triangle pairs into quads. */
function mergeTriangles(tris: number[][], pos: number[]): number[][] {
  const normal = (f: number[]) => {
    const a = new Vector3().fromArray(pos, f[0] * 3),
      bb = new Vector3().fromArray(pos, f[1] * 3),
      c = new Vector3().fromArray(pos, f[2] * 3);
    return new Vector3().subVectors(bb, a).cross(new Vector3().subVectors(c, a)).normalize();
  };
  const used = new Uint8Array(tris.length);
  const edgeMap = new Map<string, number>();
  tris.forEach((f, i) => f.forEach((v, k) => edgeMap.set(`${v}:${f[(k + 1) % 3]}`, i)));
  const out: number[][] = [];
  for (let i = 0; i < tris.length; i++) {
    if (used[i]) continue;
    const f = tris[i];
    const n = normal(f);
    let merged = false;
    for (let k = 0; k < 3 && !merged; k++) {
      const a = f[k],
        c = f[(k + 1) % 3];
      const j = edgeMap.get(`${c}:${a}`);
      if (j === undefined || j === i || used[j]) continue;
      if (normal(tris[j]).dot(n) < 0.9999) continue;
      const g = tris[j];
      const opp = g.find((v) => v !== a && v !== c)!;
      // quad a, opp, c, (third of f)
      const third = f[(k + 2) % 3];
      out.push([a, opp, c, third]);
      used[i] = used[j] = 1;
      merged = true;
    }
    if (!merged) {
      out.push(f);
      used[i] = 1;
    }
  }
  return out;
}

function smoothVerts(m: EvalMesh, verts: Set<number>, factor: number): EvalMesh {
  const et = edgeTopology(m);
  const P = Float32Array.from(m.positions);
  const sum = new Float64Array(P.length),
    cnt = new Uint32Array(P.length / 3);
  for (let e = 0; e < et.count; e++) {
    const a = et.verts[e * 2],
      c = et.verts[e * 2 + 1];
    for (let k = 0; k < 3; k++) {
      sum[a * 3 + k] += m.positions[c * 3 + k];
      sum[c * 3 + k] += m.positions[a * 3 + k];
    }
    cnt[a]++;
    cnt[c]++;
  }
  for (const v of verts) if (cnt[v]) for (let k = 0; k < 3; k++) P[v * 3 + k] += (sum[v * 3 + k] / cnt[v] - P[v * 3 + k]) * factor;
  return { ...m, positions: P };
}

function skinMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const nv = m.positions.length / 3;
  if (!nv) return m;
  const src = ctx.source?.skin_vertices;
  // skin data follows the source vertices (earlier modifiers may have changed the count)
  let skin: Float32Array;
  if (src && src.length === nv * SKIN_STRIDE) skin = src;
  else if (src && m.origIndex) {
    skin = new Float32Array(nv * SKIN_STRIDE);
    for (let v = 0; v < nv; v++) {
      const o = m.origIndex[v];
      if (o >= 0 && (o + 1) * SKIN_STRIDE <= src.length) skin.set(src.subarray(o * SKIN_STRIDE, (o + 1) * SKIN_STRIDE), v * SKIN_STRIDE);
      else skin.set([DEFAULT_SKIN_RADIUS, DEFAULT_SKIN_RADIUS, 0, 0], v * SKIN_STRIDE);
    }
  } else skin = defaultSkinData(m);
  return buildSkin(m, skin, { smooth: bool(mod, 'use_smooth_shade'), branchSmoothing: num(mod, 'branch_smoothing', 0) });
}

export const skinModifiers: ModifierType[] = [
  {
    type: 'SKIN',
    label: 'Skin',
    category: 'GENERATE',
    icon: 'mod_skin',
    supportsEditMode: true,
    defaults: () => ({ branch_smoothing: 0, use_smooth_shade: false, use_x_symmetry: true, use_y_symmetry: false, use_z_symmetry: false }),
    apply: skinMod,
  },
];

for (const t of skinModifiers) registerModifier(t);
