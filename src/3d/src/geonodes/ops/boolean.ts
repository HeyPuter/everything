// Mesh boolean through the triangle CSG library, rebuilt into polygons: triangles that come from
// the same input face are merged back into one face (per connected region without holes) and
// vertices left in the middle of straight polygon sides are dropped where no face needs them.
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';
import { MeshComponent, allocData, dataComps, type AttrMap } from '../geometry';
import { meshTriangles } from './spatial';

export type BooleanOp = 'INTERSECT' | 'UNION' | 'DIFFERENCE';

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal', 'srcface'];
evaluator.useGroups = false;

/** Source face ids are stored per triangle vertex: mesh * FACE_STRIDE + face. */
const FACE_STRIDE = 1 << 22;

function toBrush(m: MeshComponent, meshIndex: number): Brush {
  const tr = meshTriangles(m);
  const n = tr.tris.length;
  const pos = new Float32Array(n * 3);
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = m.corners[tr.tris[i]];
    pos[i * 3] = m.positions[v * 3];
    pos[i * 3 + 1] = m.positions[v * 3 + 1];
    pos[i * 3 + 2] = m.positions[v * 3 + 2];
    src[i] = meshIndex * FACE_STRIDE + tr.triFace[(i / 3) | 0];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('srcface', new Float32BufferAttribute(src, 1));
  g.computeVertexNormals();
  const b = new Brush(g);
  b.updateMatrixWorld();
  return b;
}

export interface BooleanResult {
  mesh: MeshComponent;
  /** edges between faces from different input meshes (by vertex pair) */
  intersecting: [number, number][];
}

export function meshBoolean(op: BooleanOp, first: MeshComponent | null, others: MeshComponent[]): BooleanResult | null {
  const inputs = (first ? [first, ...others] : others).filter((m) => m.faceCount > 0);
  if (!inputs.length) return null;
  const kind = op === 'UNION' ? ADDITION : op === 'INTERSECT' ? INTERSECTION : SUBTRACTION;
  if (op === 'DIFFERENCE' && first !== inputs[0]) return null;
  let result = toBrush(inputs[0], 0);
  for (let i = 1; i < inputs.length; i++) {
    result = evaluator.evaluate(result, toBrush(inputs[i], i), kind) as Brush;
    result.updateMatrixWorld();
  }
  return rebuild(result.geometry, inputs);
}

function rebuild(g: BufferGeometry, inputs: MeshComponent[]): BooleanResult {
  const P = g.getAttribute('position');
  const S = g.getAttribute('srcface');
  const count = g.index ? g.index.count : P.count;
  const at = (c: number) => (g.index ? g.index.getX(c) : c);
  // weld vertices
  const q = (v: number) => Math.round(v * 1e5);
  const ids = new Map<string, number>();
  const pos: number[] = [];
  const vid = (i: number) => {
    const x = P.getX(i),
      y = P.getY(i),
      z = P.getZ(i);
    const k = `${q(x)},${q(y)},${q(z)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = pos.length / 3;
      pos.push(x, y, z);
      ids.set(k, id);
    }
    return id;
  };
  // triangles grouped by source face
  const groups = new Map<number, number[][]>();
  const order: number[] = [];
  for (let t = 0; t < count / 3; t++) {
    const c = [at(t * 3), at(t * 3 + 1), at(t * 3 + 2)];
    const v = c.map(vid);
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const src = Math.round(S.getX(c[0]));
    let l = groups.get(src);
    if (!l) (groups.set(src, (l = [])), order.push(src));
    l.push(v);
  }
  order.sort((a, b) => a - b);
  const faces: { verts: number[]; src: number }[] = [];
  for (const src of order) for (const poly of mergeTriangles(groups.get(src)!, pos)) faces.push({ verts: poly, src });
  dropStraightVertices(faces, pos);
  // compact vertices
  const used = new Int32Array(pos.length / 3).fill(-1);
  const outPos: number[] = [];
  for (const f of faces)
    for (let k = 0; k < f.verts.length; k++) {
      const v = f.verts[k];
      if (used[v] < 0) {
        used[v] = outPos.length / 3;
        outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      }
      f.verts[k] = used[v];
    }
  const offsets = [0];
  const corners: number[] = [];
  for (const f of faces) {
    corners.push(...f.verts);
    offsets.push(corners.length);
  }
  const base = inputs[0];
  const mesh = new MeshComponent(new Float32Array(outPos), Uint32Array.from(offsets), Uint32Array.from(corners), new Uint32Array(0), new Map(), [...base.materials]);
  // face attributes of the source faces
  const attrs: AttrMap = mesh.attrs;
  const names = new Set<string>();
  for (const m of inputs) for (const [name, a] of m.attrs) if (a.domain === 'FACE') names.add(name);
  for (const name of names) {
    const ref = inputs.map((m) => m.attrs.get(name)).find((a) => a && a.domain === 'FACE')!;
    const comps = dataComps(ref.type);
    const d = allocData(ref.type, faces.length);
    faces.forEach((f, i) => {
      const mi = Math.floor(f.src / FACE_STRIDE),
        fi = f.src % FACE_STRIDE;
      const a = inputs[mi]?.attrs.get(name);
      if (!a || a.domain !== 'FACE' || a.type !== ref.type) return;
      for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[fi * comps + k];
    });
    attrs.set(name, { domain: 'FACE', type: ref.type, data: d });
  }
  // intersection edges: shared by faces of different inputs
  const edgeMesh = new Map<string, Set<number>>();
  faces.forEach((f) => {
    const mi = Math.floor(f.src / FACE_STRIDE);
    for (let k = 0; k < f.verts.length; k++) {
      const a = f.verts[k],
        b = f.verts[(k + 1) % f.verts.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let s = edgeMesh.get(key);
      if (!s) edgeMesh.set(key, (s = new Set()));
      s.add(mi);
    }
  });
  const intersecting: [number, number][] = [];
  for (const [k, s] of edgeMesh)
    if (s.size > 1) {
      const [a, b] = k.split(',').map(Number);
      intersecting.push([a, b]);
    }
  return { mesh, intersecting };
}

/** Merge triangles (same source face) into polygons: one per region whose boundary is a single loop. */
function mergeTriangles(tris: number[][], pos: number[]): number[][] {
  if (tris.length === 1) return tris;
  // connected regions through shared edges
  const edgeTris = new Map<string, number[]>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k],
        b = t[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const l = edgeTris.get(key);
      if (l) l.push(i);
      else edgeTris.set(key, [i]);
    }
  });
  const region = new Int32Array(tris.length).fill(-1);
  let nr = 0;
  for (let i = 0; i < tris.length; i++) {
    if (region[i] >= 0) continue;
    const st = [i];
    region[i] = nr;
    while (st.length) {
      const x = st.pop()!;
      const t = tris[x];
      for (let k = 0; k < 3; k++) {
        const a = t[k],
          b = t[(k + 1) % 3];
        for (const y of edgeTris.get(a < b ? `${a},${b}` : `${b},${a}`)!) if (region[y] < 0) ((region[y] = nr), st.push(y));
      }
    }
    nr++;
  }
  const out: number[][] = [];
  for (let r = 0; r < nr; r++) {
    const rt = tris.filter((_, i) => region[i] === r);
    // directed boundary edges
    const dir = new Set<string>();
    for (const t of rt) for (let k = 0; k < 3; k++) dir.add(`${t[k]},${t[(k + 1) % 3]}`);
    const next = new Map<number, number>();
    let bad = false;
    for (const t of rt)
      for (let k = 0; k < 3; k++) {
        const a = t[k],
          b = t[(k + 1) % 3];
        if (dir.has(`${b},${a}`)) continue;
        if (next.has(a)) bad = true;
        next.set(a, b);
      }
    const loops: number[][] = [];
    const seen = new Set<number>();
    for (const s of next.keys()) {
      if (seen.has(s)) continue;
      const loop: number[] = [];
      let v = s;
      while (!seen.has(v) && next.has(v)) {
        seen.add(v);
        loop.push(v);
        v = next.get(v)!;
      }
      if (v !== s) bad = true;
      loops.push(loop);
    }
    if (bad || loops.length !== 1 || loops[0].length < 3) out.push(...rt);
    else out.push(loops[0]);
  }
  void pos;
  return out;
}

/** Remove vertices that sit on a straight side in every face using them. */
function dropStraightVertices(faces: { verts: number[] }[], pos: number[]) {
  const straightIn = (f: number[], k: number) => {
    const a = f[(k + f.length - 1) % f.length],
      v = f[k],
      b = f[(k + 1) % f.length];
    const ux = pos[v * 3] - pos[a * 3],
      uy = pos[v * 3 + 1] - pos[a * 3 + 1],
      uz = pos[v * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[b * 3] - pos[v * 3],
      wy = pos[b * 3 + 1] - pos[v * 3 + 1],
      wz = pos[b * 3 + 2] - pos[v * 3 + 2];
    const cx = uy * wz - uz * wy,
      cy = uz * wx - ux * wz,
      cz = ux * wy - uy * wx;
    const lu = Math.hypot(ux, uy, uz),
      lw = Math.hypot(wx, wy, wz);
    if (!lu || !lw) return true;
    return Math.hypot(cx, cy, cz) <= 1e-6 * lu * lw && ux * wx + uy * wy + uz * wz > 0;
  };
  const corner = new Set<number>();
  const usedBy = new Map<number, number>();
  for (const f of faces)
    f.verts.forEach((v, k) => {
      usedBy.set(v, (usedBy.get(v) ?? 0) + 1);
      if (!straightIn(f.verts, k)) corner.add(v);
    });
  for (const f of faces) {
    if (f.verts.length <= 3) continue;
    const keep = f.verts.filter((v) => corner.has(v));
    if (keep.length >= 3) f.verts = keep;
  }
}
