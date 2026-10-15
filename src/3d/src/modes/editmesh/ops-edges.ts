// Edge tools: subdivide edge-ring, offset edge loops, edge split, connect vertex pairs, sharpness
// by angle, mark sharp from vertices.
import { Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { withEdit } from './context';
import { editPoll } from './ops-basic';
import { V, vertexNormals, splitFace, insertVertexOnEdge, faceEdgeKeys } from './geom';
import { startValueModal } from './modal';

// ---------------------------------------------------------------------------
// subdivide edge-ring

/** Points along an edge between two loops (linear, or following the surface with `smoothness`). */
function ringPoints(m: MeshEdit, a: number, b: number, cuts: number, interp: string, smoothness: number, normals: Vector3[]): Vector3[] {
  const pa = V(m.p(a)),
    pb = V(m.p(b));
  const d = pb.clone().sub(pa);
  const out: Vector3[] = [];
  // tangents: the edge direction flattened onto each end's tangent plane
  const tangent = (n: Vector3) => {
    const t = d.clone().addScaledVector(n, -d.dot(n));
    return t.lengthSq() > 1e-20 ? t.setLength(d.length() * smoothness) : d.clone().multiplyScalar(smoothness);
  };
  const ta = tangent(normals[a]),
    tb = tangent(normals[b]);
  for (let k = 1; k <= cuts; k++) {
    const t = k / (cuts + 1);
    if (interp === 'LINEAR' || smoothness === 0) {
      out.push(pa.clone().lerp(pb, t));
      continue;
    }
    // cubic Hermite blending between the linear point and the curved path
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1,
      h10 = t ** 3 - 2 * t ** 2 + t,
      h01 = -2 * t ** 3 + 3 * t ** 2,
      h11 = t ** 3 - t ** 2;
    out.push(pa.clone().multiplyScalar(h00).addScaledVector(ta, h10).addScaledVector(pb, h01).addScaledVector(tb, h11));
  }
  return out;
}

export function subdivideEdgeRing(m: MeshEdit, cuts: number, interp = 'PATH', smoothness = 1): boolean {
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!sel.size) return false;
  const ring: { fi: number; k: number }[] = []; // quad and the corner index of its first rail
  // selected edges by vertex, to judge which pair of a fully selected quad continues a loop
  const at = new Map<number, number[]>();
  for (const k of sel) {
    const [a, b] = k.split(':').map(Number);
    (at.get(a) ?? at.set(a, []).get(a)!).push(b);
    (at.get(b) ?? at.set(b, []).get(b)!).push(a);
  }
  const continuation = (f: EFace, a: number, b: number) => {
    // how straight the selection runs on past this edge's ends (outside the face)
    const d = V(m.p(b)).sub(V(m.p(a))).normalize();
    let s = 0;
    for (const [v, sign] of [[a, -1], [b, 1]] as const)
      for (const w of at.get(v) ?? []) {
        if (f.verts.includes(w)) continue;
        s = Math.max(s, V(m.p(w)).sub(V(m.p(v))).normalize().dot(d) * sign);
      }
    return s;
  };
  m.faces.forEach((f, fi) => {
    if (f.verts.length !== 4) return;
    const ks = faceEdgeKeys(f);
    const ok = [0, 1].filter((k) => sel.has(ks[k]) && sel.has(ks[k + 2]));
    if (!ok.length) return;
    let k = ok[0];
    if (ok.length === 2) {
      // all four edges selected: the rails are the pair whose loops continue more smoothly
      const score = (j: number) => continuation(f, f.verts[j], f.verts[j + 1]) + continuation(f, f.verts[j + 2], f.verts[(j + 3) % 4]);
      if (score(1) > score(0) + 1e-6) k = 1;
    } else if (sel.has(ks[k + 1]) || sel.has(ks[(k + 3) % 4])) return;
    ring.push({ fi, k });
  });
  if (!ring.length) return false;
  const normals = vertexNormals(m);
  const pts = new Map<string, number[]>(); // edge key → new vertices ordered from the smaller index
  const along = (a: number, b: number) => {
    const key = edgeKey(a, b);
    let l = pts.get(key);
    if (!l) {
      const [x, y] = a < b ? [a, b] : [b, a];
      l = ringPoints(m, x, y, cuts, interp, smoothness, normals).map((p, i) => m.addVert([p.x, p.y, p.z], [[x, 1 - (i + 1) / (cuts + 1)], [y, (i + 1) / (cuts + 1)]], 1));
      pts.set(key, l);
    }
    return a < b ? l : [...l].reverse();
  };
  const remove = new Set<number>();
  const add: EFace[] = [];
  for (const { fi, k } of ring) {
    const f = m.faces[fi];
    const c = [k, k + 1, k + 2, (k + 3) % 4];
    const [v0, v1, v2, v3] = c.map((i) => f.verts[i]);
    const left = [v0, ...along(v0, v3), v3],
      right = [v1, ...along(v1, v2), v2];
    const uv = (i: number) => [f.uvs[c[i] * 2], f.uvs[c[i] * 2 + 1]];
    const lerp = (p: number[], q: number[], t: number) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    for (let r = 0; r <= cuts; r++) {
      const t0 = r / (cuts + 1),
        t1 = (r + 1) / (cuts + 1);
      const nf = m.makeFace([left[r], right[r], right[r + 1], left[r + 1]], f, [...lerp(uv(0), uv(3), t0), ...lerp(uv(1), uv(2), t0), ...lerp(uv(1), uv(2), t1), ...lerp(uv(0), uv(3), t1)]);
      if (r === 0) {
        nf.seams[0] = f.seams[c[0]];
        nf.sharp[0] = f.sharp[c[0]];
        nf.creases[0] = f.creases[c[0]];
      }
      if (r === cuts) {
        nf.seams[2] = f.seams[c[2]];
        nf.sharp[2] = f.sharp[c[2]];
        nf.creases[2] = f.creases[c[2]];
      }
      add.push(nf);
    }
    remove.add(fi);
  }
  m.faces = m.faces.filter((_, i) => !remove.has(i));
  // other faces using a cut edge get the new vertices on that edge
  for (const [key, list] of pts) {
    const [a, b] = key.split(':').map(Number);
    list.forEach((v, i) => {
      const prev = i === 0 ? a : list[i - 1];
      insertVertexOnEdge(m, prev, b, v, 1 / (list.length - i + 1));
    });
  }
  m.faces.push(...add);
  // the new loops become the selection
  m.sel = m.sel.map(() => 0);
  for (const l of pts.values()) for (const v of l) m.sel[v] = 1;
  return true;
}

// ---------------------------------------------------------------------------
// offset edge loops

/** Add edge loops on both sides of the selected edges, `factor` of the way along the side edges. */
export function offsetEdgeLoops(m: MeshEdit, factor: number, capEndpoint = false): boolean {
  const selKeys = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!selKeys.size) return false;
  const onLoop = new Set<number>();
  for (const k of selKeys) k.split(':').forEach((x) => onLoop.add(Number(x)));
  // per face with a selected edge: corners where the loop leaves along an unselected face edge
  const newOnEdge = new Map<string, number>(); // "v:w" (from loop vertex v towards w) → new vertex
  const pointOn = (v: number, w: number) => {
    const key = `${v}:${w}`;
    let id = newOnEdge.get(key);
    if (id === undefined) {
      const p = V(m.p(v)).lerp(V(m.p(w)), factor);
      id = m.addVert([p.x, p.y, p.z], [[v, 1 - factor], [w, factor]], 1);
      newOnEdge.set(key, id);
    }
    return id;
  };
  type Cut = { fi: number; pairs: [number, number][] };
  const cuts: Cut[] = [];
  m.faces.forEach((f, fi) => {
    const n = f.verts.length;
    const ks = faceEdgeKeys(f);
    if (!ks.some((k) => selKeys.has(k))) return;
    // runs of consecutive selected edges in this face
    const pairs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (!selKeys.has(ks[i]) || selKeys.has(ks[(i + n - 1) % n])) continue;
      // run starts at corner i
      let j = i;
      while (selKeys.has(ks[j % n]) && j - i < n) j++;
      if (j - i >= n) continue; // whole face outline selected
      const start = f.verts[i],
        end = f.verts[j % n];
      const before = f.verts[(i + n - 1) % n],
        after = f.verts[(j + 1) % n];
      if (selKeys.has(edgeKey(before, start)) || selKeys.has(edgeKey(end, after))) continue;
      pairs.push([pointOn(start, before), pointOn(end, after)]);
    }
    if (pairs.length) cuts.push({ fi, pairs });
  });
  if (!newOnEdge.size) return false;
  // insert the new vertices into every face sharing those edges
  for (const [key, id] of newOnEdge) {
    const [v, w] = key.split(':').map(Number);
    insertVertexOnEdge(m, v, w, id, factor);
  }
  // split the faces by connecting the inserted points
  for (const { fi, pairs } of cuts)
    for (const [a, b] of pairs) {
      const f = m.faces[fi];
      const i = f.verts.indexOf(a),
        j = f.verts.indexOf(b);
      if (i < 0 || j < 0) continue;
      const n = f.verts.length;
      if ((i + 1) % n === j || (j + 1) % n === i) continue;
      splitFace(m, fi, i, j);
      // the part keeping index fi must be the one that still contains the next pair (keep the larger part)
      const A = m.faces[fi],
        B = m.faces[m.faces.length - 1];
      if (B.verts.length > A.verts.length) {
        m.faces[fi] = B;
        m.faces[m.faces.length - 1] = A;
      }
    }
  void capEndpoint;
  m.sel = m.sel.map(() => 0);
  for (const id of newOnEdge.values()) m.sel[id] = 1;
  return true;
}

// ---------------------------------------------------------------------------
// edge split

/** Split along the selected edges (EDGE) or detach the faces around the selected vertices (VERT). */
export function edgeSplit(m: MeshEdit, type: 'EDGE' | 'VERT'): boolean {
  const selKeys = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!selKeys.size) return false;
  const verts = new Set<number>();
  for (const k of selKeys) k.split(':').forEach((x) => verts.add(Number(x)));
  const vf = m.vertexFaces();
  let changed = false;
  for (const v of verts) {
    const fs = vf[v];
    if (fs.length < 2) continue;
    // group faces around v that stay connected (share an unsplit edge through v)
    const parent = new Map(fs.map((f) => [f, f]));
    const find = (f: number): number => {
      while (parent.get(f) !== f) f = parent.get(f)!;
      return f;
    };
    if (type === 'EDGE') {
      const around = (fi: number) => {
        const vs = m.faces[fi].verts,
          n = vs.length,
          i = vs.indexOf(v);
        return [vs[(i + n - 1) % n], vs[(i + 1) % n]];
      };
      for (let i = 0; i < fs.length; i++)
        for (let j = i + 1; j < fs.length; j++)
          for (const o of around(fs[i])) if (around(fs[j]).includes(o) && !selKeys.has(edgeKey(v, o))) parent.set(find(fs[i]), find(fs[j]));
    }
    const groups = new Map<number, number[]>();
    for (const f of fs) (groups.get(find(f)) ?? groups.set(find(f), []).get(find(f))!).push(f);
    let first = true;
    for (const g of groups.values()) {
      if (first) {
        first = false;
        continue;
      }
      const nv = m.addVert(m.p(v), [[v, 1]], m.sel[v]);
      for (const fi of g) m.faces[fi].verts = m.faces[fi].verts.map((x) => (x === v ? nv : x));
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// connect vertex pairs

/** Split each face between its selected (non-adjacent) vertices. */
export function connectVertexPairs(m: MeshEdit): number {
  let n = 0;
  const count = m.faces.length;
  for (let fi = 0; fi < count; fi++) {
    let guard = 0;
    // repeatedly split while a face part still has two non-adjacent selected corners
    const queue = [fi];
    while (queue.length && guard++ < 1000) {
      const f = queue.pop()!;
      const vs = m.faces[f].verts;
      const k = vs.length;
      const idx = vs.map((v, i) => (m.sel[v] && !m.hide[v] ? i : -1)).filter((i) => i >= 0);
      let pair: [number, number] | null = null;
      for (let a = 0; a < idx.length && !pair; a++)
        for (let b = a + 1; b < idx.length && !pair; b++) {
          const i = idx[a],
            j = idx[b];
          if ((i + 1) % k !== j && (j + 1) % k !== i) pair = [i, j];
        }
      if (!pair) continue;
      const nf = splitFace(m, f, pair[0], pair[1]);
      n++;
      queue.push(f, nf);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// sharpness

function setSharp(m: MeshEdit, pred: (a: number, b: number) => boolean | null) {
  for (const f of m.faces) {
    const n = f.verts.length;
    for (let i = 0; i < n; i++) {
      const r = pred(f.verts[i], f.verts[(i + 1) % n]);
      if (r !== null) f.sharp[i] = r ? 1 : 0;
    }
  }
}

export function sharpnessByAngle(m: MeshEdit, angle: number, extend: boolean) {
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  const ef = m.edgeFaces();
  const sharp = new Set<string>();
  for (const k of sel) {
    const l = ef.get(k);
    if (!l || l.length !== 2) continue;
    if (V(m.faceNormal(m.faces[l[0][0]])).angleTo(V(m.faceNormal(m.faces[l[1][0]]))) > angle) sharp.add(k);
  }
  setSharp(m, (a, b) => {
    const k = edgeKey(a, b);
    if (sharp.has(k)) return true;
    return sel.has(k) && !extend ? false : null;
  });
}

// ---------------------------------------------------------------------------

registerOperators([
  {
    idname: 'mesh.subdivide_edgering',
    label: 'Subdivide Edge-Ring',
    description: 'Cut the ring of faces between the selected edge loops',
    props: [
      { id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 10, min: 0, max: 1000, softMax: 64 },
      { id: 'interpolation', label: 'Interpolation', type: 'enum', default: 'PATH', items: [['LINEAR', 'Linear'], ['PATH', 'Blend Path']] },
      { id: 'smoothness', label: 'Smoothness', type: 'float', default: 1, min: 0, max: 1000, softMax: 2, showIf: (p) => p.interpolation !== 'LINEAR' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      if ((p.number_cuts as number) < 1) return 'FINISHED';
      if (!withEdit((m) => subdivideEdgeRing(m, p.number_cuts as number, p.interpolation as string, p.smoothness as number))) {
        app.report('ERROR', 'Select edge loops on both sides of a ring of quads');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'mesh.offset_edge_loops',
    label: 'Offset Edge Loop',
    description: 'Add edge loops on both sides of the selected edges',
    props: [
      { id: 'factor', label: 'Factor', type: 'float', default: 0.25, min: 0, max: 1, subtype: 'factor' },
      { id: 'use_cap_endpoint', label: 'Cap Endpoint', type: 'bool', default: false, hidden: true },
    ],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => offsetEdgeLoops(m, p.factor as number, !!p.use_cap_endpoint)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.offset_edge_loops_slide',
    label: 'Offset Edge Slide',
    description: 'Add edge loops on both sides of the selected edges and slide them into place',
    props: [{ id: 'factor', label: 'Factor', type: 'float', default: 0.25, min: 0, max: 1, subtype: 'factor' }],
    poll: editPoll,
    invoke: (ctx) => startValueModal({ label: 'Offset Edge Slide', idname: 'mesh.offset_edge_loops_slide', prop: 'factor', initial: 0.25, min: 0.001, max: 0.999, perPixel: 0.002, name: 'Factor', apply: (m, f) => offsetEdgeLoops(m, f) }, ctx.event),
    exec: (_ctx, p) => (withEdit((m) => offsetEdgeLoops(m, p.factor as number)) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.edge_split',
    label: 'Edge Split',
    description: 'Split the mesh along the selected edges',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'EDGE', items: [['EDGE', 'Faces by Edges'], ['VERT', 'Faces & Edges by Vertices']] }],
    poll: editPoll,
    exec: (_ctx, p) => (withEdit((m) => edgeSplit(m, p.type as 'EDGE')) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.vert_connect',
    label: 'Vertex Connect',
    description: 'Connect selected vertices that share a face with new edges',
    poll: editPoll,
    exec: () => (withEdit((m) => connectVertexPairs(m) > 0) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'mesh.set_sharpness_by_angle',
    label: 'Set Sharpness by Angle',
    description: 'Mark selected edges sharp where their faces meet at more than the angle',
    props: [
      { id: 'angle', label: 'Angle', type: 'float', default: (30 * Math.PI) / 180, min: (1 * Math.PI) / 180, max: Math.PI, subtype: 'angle' },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => sharpnessByAngle(m, p.angle as number, !!p.extend)),
  },
  {
    idname: 'mesh.mark_sharp',
    label: 'Mark Sharp',
    description: 'Mark (or clear) the selected edges as sharp',
    props: [
      { id: 'clear', label: 'Clear', type: 'bool', default: false },
      { id: 'use_verts', label: 'Vertices', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const value = p.clear ? 0 : 1;
        const on = (v: number) => !!m.sel[v] && !m.hide[v];
        // vertex mode: every edge touching a selected vertex
        setSharp(m, (a, b) => ((p.use_verts ? on(a) || on(b) : on(a) && on(b)) ? !!value : null));
      }),
  },
]);
