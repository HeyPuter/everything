// Topology-changing edit tools: extrude, inset, fill, bridge, subdivide, loop cut, poke, spin, bevel.
import { Matrix4, Vector3, Quaternion } from 'three';
import { app, registerOperators } from '../../app/app';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { withEdit, editMeshObjects, selectMode, active } from './context';
import { startTransform } from '../../ops/transform';
import { editPoll, flipFace, makeNormalsConsistent } from './ops-basic';
import { bevelVertices, bevelEdges, bevelClampLimit } from './bevel';
import { edgeRing } from './select';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { pickContext, nearestEdge } from './pick';
import { renderContext } from '../../render/context';
import { h } from '../../ui/h';
import { editModeHooks } from '../../editors/view3d/hooks';
import type { MeshData } from '../../data/types';

const V = (a: number[]) => new Vector3(a[0], a[1], a[2]);

/** Translate selected vertices of all edited meshes by a world-space vector. */
export function translateSelection(delta: Vector3) {
  for (const { ob, me } of editMeshObjects()) {
    const inv = (app.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert();
    const d = delta.clone().transformDirection(inv).multiplyScalar(delta.length() / Math.max(1e-12, delta.clone().transformDirection(inv).length() || 1));
    // transformDirection normalizes; recover the local length through the matrix
    const local = delta.clone().applyMatrix4(new Matrix4().copy(inv).setPosition(0, 0, 0));
    void d;
    const P = new Float32Array(me.positions);
    const sel = me.select_vert;
    if (!sel) continue;
    for (let i = 0; i < sel.length; i++)
      if (sel[i] && !me.hide_vert?.[i]) {
        P[i * 3] += local.x;
        P[i * 3 + 1] += local.y;
        P[i * 3 + 2] += local.z;
      }
    me.positions = P;
  }
  app.changed('geometry');
}

// ---------------------------------------------------------------------------
// extrude

export function extrudeRegion(m: MeshEdit, individual = false): 'FACES' | 'EDGES' | 'VERTS' | null {
  const fsel = m.selectedFaces();
  if (fsel.length) {
    const groups = individual ? fsel.map((f) => [f]) : [fsel];
    const newSel = new Uint8Array(0);
    void newSel;
    const touched = new Set<number>();
    for (const group of groups) {
      const gset = new Set(group);
      const map = new Map<number, number>();
      // boundary edges of the region (used once by region faces)
      const count = new Map<string, number>();
      for (const fi of group) {
        const f = m.faces[fi];
        for (let i = 0; i < f.verts.length; i++) {
          const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
          count.set(k, (count.get(k) ?? 0) + 1);
        }
      }
      // duplicate region vertices
      for (const fi of group) for (const v of m.faces[fi].verts) if (!map.has(v)) map.set(v, m.addVert(m.p(v), [[v, 1]], 1));
      // a closed region (no boundary) keeps its original faces, turned inside out, as an inner shell
      if ([...count.values()].every((c) => c !== 1))
        for (const fi of group) {
          const f = m.faces[fi];
          const copy = { ...f, verts: [...f.verts], uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined };
          flipFace(copy);
          m.faces.push(copy);
        }
      // side walls along boundary edges, oriented to match the region winding
      for (const fi of group) {
        const f = m.faces[fi];
        const n = f.verts.length;
        for (let i = 0; i < n; i++) {
          const a = f.verts[i],
            b = f.verts[(i + 1) % n];
          if (count.get(edgeKey(a, b)) !== 1) continue;
          const uvA = [f.uvs[i * 2], f.uvs[i * 2 + 1]],
            uvB = [f.uvs[((i + 1) % n) * 2], f.uvs[((i + 1) % n) * 2 + 1]];
          const wall = m.makeFace([a, b, map.get(b)!, map.get(a)!], f, [...uvA, ...uvB, ...uvB, ...uvA]);
          m.faces.push(wall);
        }
        f.verts = f.verts.map((v) => map.get(v)!);
        void gset;
      }
      for (const [o] of map) touched.add(o);
    }
    // deselect original vertices (new ones are selected)
    for (const v of touched) m.sel[v] = 0;
    // drop original vertices no longer used (closed regions)
    m.compact();
    return 'FACES';
  }
  const edges = m.selectedEdges();
  if (edges.length) {
    const map = new Map<number, number>();
    const ef = m.edgeFaces();
    for (const [a, b] of edges) {
      for (const v of [a, b]) if (!map.has(v)) map.set(v, m.addVert(m.p(v), [[v, 1]], 1));
      // orient the new face consistently with an adjacent face (if any)
      const l = ef.get(edgeKey(a, b));
      let x = a,
        y = b;
      if (l?.length) {
        const f = m.faces[l[0][0]];
        const i = l[0][1];
        if (f.verts[i] === a) {
          x = b;
          y = a;
        }
      }
      m.faces.push(m.makeFace([x, y, map.get(y)!, map.get(x)!], l?.length ? m.faces[l[0][0]] : undefined, [0, 0, 1, 0, 1, 1, 0, 1]));
    }
    for (const v of map.keys()) m.sel[v] = 0;
    return 'EDGES';
  }
  const verts = m.selectedVerts();
  if (verts.length) {
    for (const v of verts) {
      const nv = m.addVert(m.p(v), [[v, 1]], 1);
      m.looseEdges.push([v, nv]);
      m.sel[v] = 0;
    }
    return 'VERTS';
  }
  return null;
}

function regionNormalWorld(): Vector3 {
  const n = new Vector3();
  for (const { ob, me } of editMeshObjects()) {
    const w = app.graph.get(ob.id)?.world ?? new Matrix4();
    const m = MeshEdit.from(me);
    for (const fi of m.selectedFaces()) n.add(V(m.faceNormal(m.faces[fi])).transformDirection(w));
  }
  return n.lengthSq() ? n.normalize() : new Vector3(0, 0, 1);
}

registerOperators([
  {
    idname: 'mesh.extrude_region_move',
    label: 'Extrude Region and Move',
    description: 'Extrude region and move result',
    props: [{ id: 'value', label: 'Move', type: 'vec3', default: [0, 0, 0], subtype: 'distance' }],
    poll: editPoll,
    invoke: (ctx) => {
      let kind: string | null = null;
      withEdit((m) => {
        const k = extrudeRegion(m);
        if (!k) return false;
        kind = k;
      });
      if (!kind) return 'CANCELLED';
      app.flush();
      const normal = kind === 'FACES' ? regionNormalWorld() : null;
      const ok = startTransform('TRANSLATION', {
        event: ctx.event,
        constraint: normal ? [false, false, true] : undefined,
        orient: normal ? 'NORMAL' : undefined,
        label: 'Extrude Region and Move',
        redo: (v) => ({ idname: 'mesh.extrude_region_move', props: { value: v } }),
      });
      return ok ? 'RUNNING_MODAL' : 'CANCELLED';
    },
    exec: (_ctx, p) => {
      if (!withEdit((m) => extrudeRegion(m) !== null)) return 'CANCELLED';
      app.flush();
      translateSelection(V(p.value as number[]));
    },
  },
]);

// ---------------------------------------------------------------------------
// inset

export function insetFaces(m: MeshEdit, thickness: number, depth: number, individual: boolean, outset = false, opts: { even?: boolean; relative?: boolean } = {}) {
  const fsel = m.selectedFaces();
  if (!fsel.length) return false;
  const groups = individual ? fsel.map((f) => [f]) : [fsel];
  const t = outset ? -thickness : thickness;
  for (const group of groups) {
    const count = new Map<string, number>();
    for (const fi of group) {
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    // for each boundary vertex compute an inward offset (miter in the region plane)
    const vertNormal = new Map<number, Vector3>();
    const inward = new Map<number, Vector3>();
    for (const fi of group) {
      const f = m.faces[fi];
      const fn = V(m.faceNormal(f));
      for (const v of f.verts) vertNormal.set(v, (vertNormal.get(v) ?? new Vector3()).add(fn));
    }
    for (const fi of group) {
      const f = m.faces[fi];
      const n = f.verts.length;
      const fn = V(m.faceNormal(f));
      for (let i = 0; i < n; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % n];
        if (count.get(edgeKey(a, b)) !== 1) continue;
        const dir = V(m.p(b)).sub(V(m.p(a))).normalize();
        const into = fn.clone().cross(dir).normalize(); // points into the face for CCW winding
        for (const v of [a, b]) {
          const cur = inward.get(v);
          if (!cur) inward.set(v, into.clone());
          else inward.set(v, cur.add(into));
        }
      }
    }
    const map = new Map<number, number>();
    for (const [v, d] of inward) {
      // miter: scale so that the offset distance along each edge normal equals thickness
      const n = d.clone().normalize();
      const cosHalf = Math.max(0.2, d.length() / 2);
      let len = inward.get(v)!.length() > 1.0001 && opts.even !== false ? t / cosHalf : t;
      if (opts.relative) {
        // scale by the average length of the region edges at this vertex
        let sum = 0,
          cnt = 0;
        for (const fi of group) {
          const f = m.faces[fi];
          const i = f.verts.indexOf(v);
          if (i < 0) continue;
          sum += V(m.p(v)).distanceTo(V(m.p(f.verts[(i + 1) % f.verts.length]))) + V(m.p(v)).distanceTo(V(m.p(f.verts[(i + f.verts.length - 1) % f.verts.length])));
          cnt += 2;
        }
        if (cnt) len *= sum / cnt;
      }
      const vn = (vertNormal.get(v) ?? new Vector3(0, 0, 1)).normalize();
      const p = V(m.p(v)).addScaledVector(n, len).addScaledVector(vn, depth);
      map.set(v, m.addVert([p.x, p.y, p.z], [[v, 1]], 1));
    }
    // interior vertices move by depth only
    for (const fi of group) {
      const f = m.faces[fi];
      for (const v of f.verts)
        if (!map.has(v) && depth) {
          const vn = (vertNormal.get(v) ?? new Vector3(0, 0, 1)).normalize();
          const p = V(m.p(v)).addScaledVector(vn, depth);
          m.setP(v, [p.x, p.y, p.z]);
        }
    }
    for (const fi of group) {
      const f = m.faces[fi];
      const n = f.verts.length;
      // ring faces on boundary edges
      for (let i = 0; i < n; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % n];
        if (count.get(edgeKey(a, b)) !== 1) continue;
        const uvA = [f.uvs[i * 2], f.uvs[i * 2 + 1]],
          uvB = [f.uvs[((i + 1) % n) * 2], f.uvs[((i + 1) % n) * 2 + 1]];
        m.faces.push(m.makeFace([a, b, map.get(b)!, map.get(a)!], f, [...uvA, ...uvB, ...uvB, ...uvA]));
      }
      f.verts = f.verts.map((v) => map.get(v) ?? v);
    }
    for (const v of map.keys()) m.sel[v] = 0;
    for (const fi of group) for (const v of m.faces[fi].verts) m.sel[v] = 1;
  }
  return true;
}

function startInsetModal(individual: boolean, outsetInit = false) {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  // snapshot meshes to recompute from on every mouse move
  const snaps = editMeshObjects().map(({ me }) => ({ me, m: MeshEdit.from(me) }));
  const center = new Vector3();
  let cnt = 0;
  for (const { ob, me } of editMeshObjects()) {
    const w = app.graph.get(ob.id)?.world ?? new Matrix4();
    for (let i = 0; i < (me.select_vert?.length ?? 0); i++)
      if (me.select_vert![i]) {
        center.add(new Vector3(me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]).applyMatrix4(w));
        cnt++;
      }
  }
  if (!cnt) return 'CANCELLED' as const;
  center.multiplyScalar(1 / cnt);
  const r = v.el.getBoundingClientRect();
  const cs = v.project(center);
  const d0 = Math.max(10, Math.hypot(app.pointer.x - r.left - cs.x, app.pointer.y - r.top - cs.y));
  const px = v.nav.pixelSize(center);
  let thickness = 0,
    depth = 0,
    depthMode = false,
    outset = outsetInit,
    ind = individual;
  let numeric = '';
  const apply = () => {
    for (const s of snaps) {
      const m = MeshEdit.from({ ...s.me, positions: s.me.positions } as MeshData);
      void m;
      const copy = cloneEdit(s.m);
      insetFaces(copy, thickness, depth, ind, outset);
      copy.write(s.me);
    }
    app.changed('geometry');
  };
  app.startModal({
    label: 'Inset Faces',
    header: () => `Thickness: ${thickness.toFixed(4)}  Depth: ${depth.toFixed(4)}  [Ctrl] Depth  [I] Individual: ${ind ? 'On' : 'Off'}  [O] Outset: ${outset ? 'On' : 'Off'}${numeric ? `  (${numeric})` : ''}`,
    status: () => [['LMB', 'Confirm'], ['RMB', 'Cancel'], ['Ctrl', 'Depth'], ['I', 'Individual'], ['O', 'Outset']],
    onPointerMove(e) {
      const d = Math.hypot(e.clientX - r.left - cs.x, e.clientY - r.top - cs.y);
      const amount = Math.max(0, (d0 - d) * px);
      if (numeric) return;
      if (e.ctrlKey || depthMode) depth = (d - d0) * px * -1 + 0;
      else thickness = Math.max(0, amount);
      if (e.shiftKey) thickness = Math.round(thickness * 100) / 100;
      apply();
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined;
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.key === 'i' || e.key === 'I') {
        ind = !ind;
        apply();
      } else if (e.key === 'o' || e.key === 'O') {
        outset = !outset;
        apply();
      } else if (e.key === 'Control') depthMode = true;
      else if (/^[0-9.]$/.test(e.key) || e.key === 'Backspace') {
        numeric = e.key === 'Backspace' ? numeric.slice(0, -1) : numeric + e.key;
        thickness = parseFloat(numeric) || 0;
        apply();
      }
      return true;
    },
    cancel() {
      for (const s of snaps) s.m.write(s.me);
      app.changed('geometry');
    },
    finish() {
      this.redoOp = { idname: 'mesh.inset', props: { thickness, depth, use_individual: ind, use_outset: outset } };
    },
  });
  apply();
  return 'RUNNING_MODAL' as const;
}

function cloneEdit(m: MeshEdit): MeshEdit {
  const c = new MeshEdit();
  c.pos = m.pos.slice();
  c.sel = m.sel.slice();
  c.hide = m.hide.slice();
  c.weights = m.weights.map((w) => w.slice());
  c.keys = m.keys.map((k) => k.slice());
  c.pcolors = m.pcolors.map((k) => k.slice());
  c.looseEdges = m.looseEdges.map((e) => [e[0], e[1]] as [number, number]);
  c.faces = m.faces.map((f) => ({ ...f, verts: [...f.verts], uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined }));
  return c;
}

// ---------------------------------------------------------------------------
// make edge/face, fill, bridge

function orderBoundary(m: MeshEdit, verts: number[]): number[] {
  // order by selected edges if they form a loop, else by angle around centroid in best-fit plane
  const set = new Set(verts);
  const adj = new Map<number, number[]>();
  for (const [a, b] of m.edges()) if (set.has(a) && set.has(b)) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  if (verts.every((v) => (adj.get(v)?.length ?? 0) === 2)) {
    const out = [verts[0]];
    let prev = -1;
    while (out.length < verts.length) {
      const cur = out[out.length - 1];
      const nx = adj.get(cur)!.find((x) => x !== prev && !out.includes(x));
      if (nx === undefined) break;
      prev = cur;
      out.push(nx);
    }
    if (out.length === verts.length) return out;
  }
  const c = new Vector3();
  for (const v of verts) c.add(V(m.p(v)));
  c.multiplyScalar(1 / verts.length);
  // plane normal via Newell over the angular order of an arbitrary projection
  let n = new Vector3();
  for (let i = 0; i < verts.length; i++) n.add(V(m.p(verts[i])).sub(c).cross(V(m.p(verts[(i + 1) % verts.length])).sub(c)));
  if (n.lengthSq() < 1e-12) n = new Vector3(0, 0, 1);
  n.normalize();
  const u = (Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).cross(n).normalize();
  const w = n.clone().cross(u);
  return [...verts].sort((a, b) => {
    const pa = V(m.p(a)).sub(c),
      pb = V(m.p(b)).sub(c);
    return Math.atan2(pa.dot(w), pa.dot(u)) - Math.atan2(pb.dot(w), pb.dot(u));
  });
}

function edgeFaceAdd(m: MeshEdit): boolean {
  const verts = m.selectedVerts();
  if (verts.length === 2) {
    const [a, b] = verts;
    if (!m.edges().some(([x, y]) => (x === a && y === b) || (x === b && y === a))) m.looseEdges.push([a, b]);
    return true;
  }
  if (verts.length < 3) return false;
  // if selected faces exist, merge them into a single face (like "Make Face" from a face selection)
  const fsel = m.selectedFaces();
  const ordered = orderBoundary(m, fsel.length ? boundaryOfFaces(m, fsel) : verts);
  if (ordered.length < 3) return false;
  if (fsel.length) {
    const s = new Set(fsel);
    m.faces = m.faces.filter((_, i) => !s.has(i));
  }
  const f = m.makeFace(ordered, m.faces[0]);
  m.faces.push(f);
  // orient consistently with neighbours
  const ef = m.edgeFaces();
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i],
      b = ordered[(i + 1) % ordered.length];
    const l = (ef.get(edgeKey(a, b)) ?? []).filter(([fi]) => m.faces[fi] !== f);
    if (l.length) {
      const g = m.faces[l[0][0]];
      const j = l[0][1];
      if (g.verts[j] === a) flipFace(f);
      break;
    }
  }
  m.looseEdges = m.looseEdges.filter(([a, b]) => !(ordered.includes(a) && ordered.includes(b)));
  return true;
}

function boundaryOfFaces(m: MeshEdit, faces: number[]): number[] {
  const count = new Map<string, number>();
  for (const fi of faces) {
    const f = m.faces[fi];
    for (let i = 0; i < f.verts.length; i++) {
      const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const out = new Set<number>();
  for (const [k, c] of count) if (c === 1) k.split(':').forEach((x) => out.add(Number(x)));
  return [...out];
}

export interface BridgeOptions {
  twist?: number;
  type?: 'SINGLE' | 'CLOSED' | 'PAIRS';
  cuts?: number;
  interpolation?: 'LINEAR' | 'PATH';
  smoothness?: number;
  merge?: boolean;
  mergeFactor?: number;
}

/** Bridge selected edge loops (or the outlines of selected faces, which are removed) with quads. */
export function bridgeLoops(m: MeshEdit, o: BridgeOptions = {}): boolean {
  const fsel = m.selectedFaces();
  let edges: [number, number][];
  if (fsel.length) {
    // bridge face regions: their outlines, with the faces removed
    const count = new Map<string, number>();
    for (const fi of fsel) {
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
        count.set(k, (count.get(k) ?? 0) + 1);
      }
    }
    edges = [...count].filter(([, c]) => c === 1).map(([k]) => k.split(':').map(Number) as [number, number]);
    const rm = new Set(fsel);
    m.faces = m.faces.filter((_, i) => !rm.has(i));
  } else edges = m.selectedEdges();
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const loops: { verts: number[]; closed: boolean }[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const st = [start];
    seen.add(start);
    while (st.length) {
      const u = st.pop()!;
      comp.push(u);
      for (const w of adj.get(u)!)
        if (!seen.has(w)) {
          seen.add(w);
          st.push(w);
        }
    }
    const ends = comp.filter((v) => adj.get(v)!.length === 1);
    const first = ends[0] ?? comp[0];
    const order = [first];
    let prev = -1;
    while (order.length < comp.length) {
      const cur = order[order.length - 1];
      const nx = adj.get(cur)!.find((x) => x !== prev && !order.includes(x));
      if (nx === undefined) break;
      prev = cur;
      order.push(nx);
    }
    loops.push({ verts: order, closed: !ends.length });
  }
  if (loops.length < 2 || loops.some((l) => l.verts.length !== loops[0].verts.length)) {
    app.report('ERROR', 'Select two or more edge loops with the same number of vertices');
    return false;
  }
  // order the loops along the line through their centres
  const centre = (l: { verts: number[] }) => l.verts.reduce((c, v) => c.add(V(m.p(v))), new Vector3()).multiplyScalar(1 / l.verts.length);
  if (loops.length > 2) {
    const cs = loops.map(centre);
    const dir = cs[cs.length - 1].clone().sub(cs[0]);
    let far = 0;
    for (let i = 0; i < cs.length; i++) for (let j = 0; j < cs.length; j++) if (cs[i].distanceTo(cs[j]) > far) {
      far = cs[i].distanceTo(cs[j]);
      dir.copy(cs[j]).sub(cs[i]);
    }
    loops.sort((x, y) => centre(x).dot(dir) - centre(y).dot(dir));
  }
  const pairs: [number, number][] = [];
  if (o.type === 'PAIRS') for (let i = 0; i + 1 < loops.length; i += 2) pairs.push([i, i + 1]);
  else {
    for (let i = 0; i + 1 < loops.length; i++) pairs.push([i, i + 1]);
    if (o.type === 'CLOSED' && loops.length > 2) pairs.push([loops.length - 1, 0]);
  }
  const normals = (o.interpolation ?? 'PATH') === 'PATH' && (o.smoothness ?? 0) > 0 ? vertexNormalsOf(m) : null;
  for (const [ia, ib] of pairs) bridgePair(m, loops[ia], loops[ib], o, normals);
  makeNormalsConsistentNew(m);
  return true;
}

function vertexNormalsOf(m: MeshEdit): Vector3[] {
  const out = Array.from({ length: m.vcount }, () => new Vector3());
  for (const f of m.faces) {
    const n = V(m.faceNormal(f));
    for (const v of f.verts) out[v].add(n);
  }
  for (const n of out) n.normalize();
  return out;
}

function bridgePair(m: MeshEdit, A: { verts: number[]; closed: boolean }, B: { verts: number[]; closed: boolean }, o: BridgeOptions, normals: Vector3[] | null) {
  const n = A.verts.length;
  // align: rotation (closed loops) and direction with the least total distance
  let best = { off: 0, rev: false, d: Infinity };
  for (const rev of [false, true]) {
    const bv = rev ? [...B.verts].reverse() : B.verts;
    for (let off = 0; off < (A.closed ? n : 1); off++) {
      let d = 0;
      for (let i = 0; i < n; i++) d += V(m.p(A.verts[i])).distanceToSquared(V(m.p(bv[(i + off) % n])));
      if (d < best.d) best = { off, rev, d };
    }
  }
  const twist = o.twist ?? 0;
  const bvRaw = best.rev ? [...B.verts].reverse() : B.verts;
  const bv = A.verts.map((_, i) => bvRaw[(i + best.off + twist + n * 4) % n]);
  if (o.merge) {
    // merge the loops at a point between them
    const t = o.mergeFactor ?? 0.5;
    const map = Array.from({ length: m.vcount }, (_, i) => i);
    for (let i = 0; i < n; i++) {
      const p = V(m.p(A.verts[i])).lerp(V(m.p(bv[i])), t);
      m.setP(A.verts[i], [p.x, p.y, p.z]);
      map[bv[i]] = A.verts[i];
    }
    m.remap(map);
    return;
  }
  // rows of vertices from loop A to loop B (intermediate rows for the cuts)
  const cuts = Math.max(0, o.cuts ?? 0);
  const rows: number[][] = [A.verts];
  for (let r = 1; r <= cuts; r++) {
    const t = r / (cuts + 1);
    rows.push(
      A.verts.map((a, i) => {
        const b = bv[i];
        const pa = V(m.p(a)),
          pb = V(m.p(b));
        let p = pa.clone().lerp(pb, t);
        if (normals) {
          // bow the bridge outwards along the loops' surface direction
          const d = pb.clone().sub(pa);
          const ta = normals[a].clone().cross(d).cross(normals[a]).setLength(d.length() * (o.smoothness ?? 1));
          const tb = normals[b].clone().cross(d).cross(normals[b]).setLength(d.length() * (o.smoothness ?? 1));
          const h00 = 2 * t ** 3 - 3 * t ** 2 + 1,
            h10 = t ** 3 - 2 * t ** 2 + t,
            h01 = -2 * t ** 3 + 3 * t ** 2,
            h11 = t ** 3 - t ** 2;
          p = pa.clone().multiplyScalar(h00).addScaledVector(ta, h10).addScaledVector(pb, h01).addScaledVector(tb, h11);
        }
        return m.addVert([p.x, p.y, p.z], [[a, 1 - t], [b, t]], 1);
      }),
    );
  }
  rows.push(bv);
  const segs = A.closed ? n : n - 1;
  for (let r = 0; r < rows.length - 1; r++)
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const v0 = r / (rows.length - 1),
        v1 = (r + 1) / (rows.length - 1);
      m.faces.push(m.makeFace([rows[r][i], rows[r][j], rows[r + 1][j], rows[r + 1][i]], m.faces[0], [i / segs, v0, (i + 1) / segs, v0, (i + 1) / segs, v1, i / segs, v1]));
    }
}

function makeNormalsConsistentNew(m: MeshEdit) {
  const saved = m.sel.slice();
  m.sel = m.sel.map(() => 1);
  makeNormalsConsistent(m, false, false);
  m.sel = saved;
}

// ---------------------------------------------------------------------------
// subdivide

export interface SubdivideOptions {
  /** how a quad with two adjacent cut edges is split */
  quadcorner?: 'STRAIGHT_CUT' | 'INNERVERT' | 'FAN';
  fractal?: number;
  fractalAlongNormal?: number;
  seed?: number;
}

export function subdivide(m: MeshEdit, cuts: number, smoothness: number, opts: SubdivideOptions = {}) {
  const firstNew = m.vcount;
  const selEdges = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!selEdges.size) return false;
  // new vertices along each selected edge (ordered from min to max vertex index)
  const edgeVerts = new Map<string, number[]>();
  const nb = smoothness ? m.neighbors() : null;
  for (const k of selEdges) {
    const [a, b] = k.split(':').map(Number);
    const list: number[] = [];
    for (let c = 1; c <= cuts; c++) {
      const t = c / (cuts + 1);
      const p = V(m.p(a)).lerp(V(m.p(b)), t);
      if (smoothness && nb) {
        // push towards the average of neighbour positions (approximate smooth subdivision)
        const avg = new Vector3();
        for (const v of [...nb[a], ...nb[b]]) avg.add(V(m.p(v)));
        avg.multiplyScalar(1 / (nb[a].length + nb[b].length));
        const mid = V(m.p(a)).lerp(V(m.p(b)), 0.5);
        p.add(mid.sub(avg).multiplyScalar(-smoothness * 0.25 * Math.sin(Math.PI * t)));
      }
      list.push(m.addVert([p.x, p.y, p.z], [[a, 1 - t], [b, t]], 1));
    }
    edgeVerts.set(k, list);
  }
  const along = (a: number, b: number): number[] => {
    const l = edgeVerts.get(edgeKey(a, b));
    if (!l) return [];
    return a < b ? l : [...l].reverse();
  };
  const out: EFace[] = [];
  for (const f of m.faces) {
    const n = f.verts.length;
    const allSel = f.verts.every((v, i) => selEdges.has(edgeKey(v, f.verts[(i + 1) % n])));
    const uvAt = (i: number) => [f.uvs[i * 2], f.uvs[i * 2 + 1]];
    const lerpUV = (i: number, j: number, t: number) => [f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * t, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * t];
    if (allSel && n === 4) {
      // grid subdivision
      const N = cuts + 1;
      const grid: number[][] = [];
      const guv: number[][][] = [];
      const [v0, v1, v2, v3] = f.verts;
      const e01 = [v0, ...along(v0, v1), v1],
        e32 = [v3, ...along(v3, v2), v2],
        e03 = [v0, ...along(v0, v3), v3],
        e12 = [v1, ...along(v1, v2), v2];
      for (let j = 0; j <= N; j++) {
        grid.push([]);
        guv.push([]);
        for (let i = 0; i <= N; i++) {
          let id: number;
          if (j === 0) id = e01[i];
          else if (j === N) id = e32[i];
          else if (i === 0) id = e03[j];
          else if (i === N) id = e12[j];
          else {
            const s = i / N,
              t = j / N;
            const p = V(m.p(v0)).multiplyScalar((1 - s) * (1 - t)).add(V(m.p(v1)).multiplyScalar(s * (1 - t))).add(V(m.p(v2)).multiplyScalar(s * t)).add(V(m.p(v3)).multiplyScalar((1 - s) * t));
            id = m.addVert([p.x, p.y, p.z], [[v0, (1 - s) * (1 - t)], [v1, s * (1 - t)], [v2, s * t], [v3, (1 - s) * t]], 1);
          }
          grid[j].push(id);
          const s = i / N,
            t = j / N;
          const u0 = uvAt(0),
            u1 = uvAt(1),
            u2 = uvAt(2),
            u3 = uvAt(3);
          guv[j].push([0, 1].map((k) => u0[k] * (1 - s) * (1 - t) + u1[k] * s * (1 - t) + u2[k] * s * t + u3[k] * (1 - s) * t));
        }
      }
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) out.push(m.makeFace([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]], f, [...guv[j][i], ...guv[j][i + 1], ...guv[j + 1][i + 1], ...guv[j + 1][i]]));
      continue;
    }
    if (allSel && n === 3 && cuts === 1) {
      const [a, b, c] = f.verts;
      const ab = along(a, b)[0],
        bc = along(b, c)[0],
        ca = along(c, a)[0];
      const uab = lerpUV(0, 1, 0.5),
        ubc = lerpUV(1, 2, 0.5),
        uca = lerpUV(2, 0, 0.5);
      out.push(m.makeFace([a, ab, ca], f, [...uvAt(0), ...uab, ...uca]));
      out.push(m.makeFace([ab, b, bc], f, [...uab, ...uvAt(1), ...ubc]));
      out.push(m.makeFace([ca, bc, c], f, [...uca, ...ubc, ...uvAt(2)]));
      out.push(m.makeFace([ab, bc, ca], f, [...uab, ...ubc, ...uca]));
      continue;
    }
    // a quad with two adjacent cut edges (a corner)
    const cutAt = f.verts.map((v, i) => selEdges.has(edgeKey(v, f.verts[(i + 1) % n])));
    if (n === 4 && cutAt.filter(Boolean).length === 2 && cutAt[0] === cutAt[2]) {
      // two opposite cut edges: a strip of quads across the face
      const k = cutAt[0] ? 0 : 1;
      const c = [k, k + 1, k + 2, (k + 3) % 4];
      const [v0, v1, v2, v3] = c.map((i) => f.verts[i]);
      const top = [v0, ...along(v0, v1), v1],
        bottom = [v3, ...along(v3, v2), v2];
      const N = cuts + 1;
      const uvT = (j: number) => lerpUV(c[0], c[1], j / N),
        uvB = (j: number) => lerpUV(c[3], c[2], j / N);
      for (let j = 0; j < N; j++) {
        const nf = m.makeFace([top[j], top[j + 1], bottom[j + 1], bottom[j]], f, [...uvT(j), ...uvT(j + 1), ...uvB(j + 1), ...uvB(j)]);
        for (const [e, src] of [[0, c[0]], [2, c[2]]])
          if (f.seams[src] || f.sharp[src] || f.creases[src]) {
            nf.seams[e] = f.seams[src];
            nf.sharp[e] = f.sharp[src];
            nf.creases[e] = f.creases[src];
          }
        if (j === 0) {
          nf.seams[3] = f.seams[c[3]];
          nf.sharp[3] = f.sharp[c[3]];
          nf.creases[3] = f.creases[c[3]];
        }
        if (j === N - 1) {
          nf.seams[1] = f.seams[c[1]];
          nf.sharp[1] = f.sharp[c[1]];
          nf.creases[1] = f.creases[c[1]];
        }
        out.push(nf);
      }
      continue;
    }
    if (n === 4 && cutAt.filter(Boolean).length === 2) {
      const k = [0, 1, 2, 3].find((i) => cutAt[(i + 3) % 4] && cutAt[i]);
      if (k !== undefined) {
        // corner c with cut edges c→a and b→c (b is the previous corner), o opposite
        const ci = k,
          ai = (k + 1) % 4,
          oi = (k + 2) % 4,
          bi = (k + 3) % 4;
        const [c, a, o, b] = [f.verts[ci], f.verts[ai], f.verts[oi], f.verts[bi]];
        const ca = along(c, a),
          cb = along(c, b);
        const uvCA = (t: number) => lerpUV(ci, ai, t),
          uvCB = (t: number) => lerpUV(ci, bi, t);
        const T = (j: number) => (j + 1) / (cuts + 1);
        const mode = opts.quadcorner ?? 'STRAIGHT_CUT';
        if (mode === 'FAN') {
          // cut points connect to the opposite corner; the corner itself keeps a quad
          const uvO = uvAt(oi);
          out.push(m.makeFace([c, ca[0], o, cb[0]], f, [...uvAt(ci), ...uvCA(T(0)), ...uvO, ...uvCB(T(0))]));
          const sideA = [...ca, a],
            uvA = [...ca.map((_, j) => uvCA(T(j))), uvAt(ai)];
          for (let j = 0; j < sideA.length - 1; j++) out.push(m.makeFace([sideA[j], sideA[j + 1], o], f, [...uvA[j], ...uvA[j + 1], ...uvO]));
          const sideB = [...cb, b],
            uvB = [...cb.map((_, j) => uvCB(T(j))), uvAt(bi)];
          for (let j = 0; j < sideB.length - 1; j++) out.push(m.makeFace([sideB[j + 1], sideB[j], o], f, [...uvB[j + 1], ...uvB[j], ...uvO]));
          continue;
        }
        if (mode === 'INNERVERT' && cuts === 1) {
          const p = V(m.p(ca[0])).add(V(m.p(cb[0]))).add(V(m.p(o))).add(V(m.p(c))).multiplyScalar(0.25);
          const iv = m.addVert([p.x, p.y, p.z], [[c, 0.25], [a, 0.25], [o, 0.25], [b, 0.25]], 1);
          const uvI = [0, 1].map((q) => (uvAt(0)[q] + uvAt(1)[q] + uvAt(2)[q] + uvAt(3)[q]) / 4);
          out.push(m.makeFace([c, ca[0], iv, cb[0]], f, [...uvAt(ci), ...uvCA(0.5), ...uvI, ...uvCB(0.5)]));
          out.push(m.makeFace([ca[0], a, o, iv], f, [...uvCA(0.5), ...uvAt(ai), ...uvAt(oi), ...uvI]));
          out.push(m.makeFace([iv, o, b, cb[0]], f, [...uvI, ...uvAt(oi), ...uvAt(bi), ...uvCB(0.5)]));
          continue;
        }
        // straight cuts: the j-th point on one edge connects to the j-th point on the other
        out.push(m.makeFace([c, ca[0], cb[0]], f, [...uvAt(ci), ...uvCA(T(0)), ...uvCB(T(0))]));
        for (let j = 0; j < cuts - 1; j++) out.push(m.makeFace([ca[j], ca[j + 1], cb[j + 1], cb[j]], f, [...uvCA(T(j)), ...uvCA(T(j + 1)), ...uvCB(T(j + 1)), ...uvCB(T(j))]));
        out.push(m.makeFace([ca[cuts - 1], a, o, b, cb[cuts - 1]], f, [...uvCA(T(cuts - 1)), ...uvAt(ai), ...uvAt(oi), ...uvAt(bi), ...uvCB(T(cuts - 1))]));
        continue;
      }
    }
    // otherwise insert new vertices into split edges (n-gon)
    const verts: number[] = [],
      uvs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = f.verts[i],
        b = f.verts[(i + 1) % n];
      verts.push(a);
      uvs.push(...uvAt(i));
      const mid = along(a, b);
      mid.forEach((v, k) => {
        verts.push(v);
        uvs.push(...lerpUV(i, (i + 1) % n, (k + 1) / (cuts + 1)));
      });
    }
    const nf = m.makeFace(verts, f, uvs);
    out.push(nf);
  }
  m.faces = out;
  if (opts.fractal) {
    // random displacement of the new vertices, scaled by the average selected edge length
    let len = 0;
    for (const k of selEdges) {
      const [a, b] = k.split(':').map(Number);
      len += V(m.p(a)).distanceTo(V(m.p(b)));
    }
    len /= selEdges.size;
    let s = ((opts.seed ?? 0) * 2654435761 + 1) >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) / 4294967296) * 2 - 1;
    };
    const normals = new Map<number, Vector3>();
    for (const f of m.faces) {
      const nrm = V(m.faceNormal(f));
      for (const v of f.verts) if (v >= firstNew) (normals.get(v) ?? normals.set(v, new Vector3()).get(v)!).add(nrm);
    }
    const along = opts.fractalAlongNormal ?? 0;
    for (let v = firstNew; v < m.vcount; v++) {
      const d = new Vector3(rnd(), rnd(), rnd());
      const nrm = (normals.get(v) ?? new Vector3()).normalize();
      if (along) d.lerp(nrm.multiplyScalar(rnd()), along);
      const p = V(m.p(v)).addScaledVector(d, (opts.fractal * len) / 10);
      m.setP(v, [p.x, p.y, p.z]);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// loop cut

export function loopCut(m: MeshEdit, a: number, b: number, cuts: number, slide: number): boolean {
  // walk the ring with consistent orientation
  const ef = m.edgeFaces();
  type RE = { x: number; y: number };
  const ring: RE[] = [{ x: a, y: b }];
  const ringFaces: number[] = [];
  const seen = new Set([edgeKey(a, b)]);
  const walk = (start: RE, skipFace: number) => {
    let cur = start,
      from = skipFace;
    for (let guard = 0; guard < 100000; guard++) {
      const fs = (ef.get(edgeKey(cur.x, cur.y)) ?? []).map(([fi]) => fi).filter((fi) => fi !== from);
      if (!fs.length) return;
      const fi = fs[0];
      const f = m.faces[fi];
      if (f.verts.length !== 4) return;
      const ix = f.verts.indexOf(cur.x),
        iy = f.verts.indexOf(cur.y);
      // neighbour of x (not y) and neighbour of y (not x) form the opposite edge
      const nx = f.verts[(ix + 1) % 4] === cur.y ? f.verts[(ix + 3) % 4] : f.verts[(ix + 1) % 4];
      const ny = f.verts[(iy + 1) % 4] === cur.x ? f.verts[(iy + 3) % 4] : f.verts[(iy + 1) % 4];
      ringFaces.push(fi);
      const k = edgeKey(nx, ny);
      if (seen.has(k)) return;
      seen.add(k);
      const nxt = { x: nx, y: ny };
      if (from === skipFace && skipFace === -2) ring.unshift(nxt);
      else ring.push(nxt);
      cur = nxt;
      from = fi;
    }
  };
  const startFaces = (ef.get(edgeKey(a, b)) ?? []).map(([fi]) => fi);
  walk({ x: a, y: b }, startFaces[1] ?? -1);
  if (startFaces.length > 1) {
    // walk the other direction and prepend
    const before: RE[] = [];
    let cur = { x: a, y: b },
      from = startFaces[0];
    for (let guard = 0; guard < 100000; guard++) {
      const fs = (ef.get(edgeKey(cur.x, cur.y)) ?? []).map(([fi]) => fi).filter((fi) => fi !== from && !ringFaces.includes(fi));
      if (!fs.length) break;
      const fi = fs[0];
      const f = m.faces[fi];
      if (f.verts.length !== 4) break;
      const ix = f.verts.indexOf(cur.x),
        iy = f.verts.indexOf(cur.y);
      const nx = f.verts[(ix + 1) % 4] === cur.y ? f.verts[(ix + 3) % 4] : f.verts[(ix + 1) % 4];
      const ny = f.verts[(iy + 1) % 4] === cur.x ? f.verts[(iy + 3) % 4] : f.verts[(iy + 1) % 4];
      ringFaces.push(fi);
      const k = edgeKey(nx, ny);
      if (seen.has(k)) break;
      seen.add(k);
      before.unshift({ x: nx, y: ny });
      cur = { x: nx, y: ny };
      from = fi;
    }
    ring.unshift(...before);
  }
  // new vertices on every ring edge, t measured from x to y
  const s = Math.max(-0.999, Math.min(0.999, slide));
  const params = Array.from({ length: cuts }, (_, i) => {
    const t = (i + 1) / (cuts + 1);
    return s >= 0 ? t + (1 - t) * s * (1 - Math.abs(2 * t - 1)) * 0 + s * (1 - t) * (cuts === 1 ? 1 : 0.5) : t + s * t * (cuts === 1 ? 1 : 0.5);
  });
  const newV = new Map<string, { x: number; y: number; ids: number[] }>();
  for (const e of ring) {
    const ids = params.map((t) => {
      const p = V(m.p(e.x)).lerp(V(m.p(e.y)), t);
      return m.addVert([p.x, p.y, p.z], [[e.x, 1 - t], [e.y, t]], 1);
    });
    newV.set(edgeKey(e.x, e.y), { x: e.x, y: e.y, ids });
  }
  const along = (u: number, w: number) => {
    const r = newV.get(edgeKey(u, w));
    if (!r) return [];
    return r.x === u ? r.ids : [...r.ids].reverse();
  };
  const ringFaceSet = new Set(ringFaces);
  const out: EFace[] = [];
  m.faces.forEach((f, fi) => {
    const n = f.verts.length;
    if (ringFaceSet.has(fi) && n === 4) {
      // find the two ring edges in this quad
      let i0 = -1;
      for (let i = 0; i < 4; i++) if (newV.has(edgeKey(f.verts[i], f.verts[(i + 1) % 4])) && newV.has(edgeKey(f.verts[(i + 2) % 4], f.verts[(i + 3) % 4]))) i0 = i;
      if (i0 >= 0) {
        const p0 = f.verts[i0],
          p1 = f.verts[(i0 + 1) % 4],
          p2 = f.verts[(i0 + 2) % 4],
          p3 = f.verts[(i0 + 3) % 4];
        const top = [p0, ...along(p0, p1), p1];
        const bot = [p3, ...along(p3, p2), p2];
        const uv = (i: number) => [f.uvs[((i0 + i) % 4) * 2], f.uvs[((i0 + i) % 4) * 2 + 1]];
        const lerp = (u0: number[], u1: number[], t: number) => [u0[0] + (u1[0] - u0[0]) * t, u0[1] + (u1[1] - u0[1]) * t];
        const tParam = [0, ...params, 1];
        for (let k = 0; k < top.length - 1; k++) {
          const ta = tParam[k],
            tb = tParam[k + 1];
          out.push(m.makeFace([top[k], top[k + 1], bot[k + 1], bot[k]], f, [...lerp(uv(0), uv(1), ta), ...lerp(uv(0), uv(1), tb), ...lerp(uv(3), uv(2), tb), ...lerp(uv(3), uv(2), ta)]));
        }
        return;
      }
    }
    // faces touching a ring edge (ends of open rings, n-gons): insert the new vertices
    let touched = false;
    for (let i = 0; i < n; i++) if (newV.has(edgeKey(f.verts[i], f.verts[(i + 1) % n]))) touched = true;
    if (!touched) return out.push(f);
    const verts: number[] = [],
      uvs: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = f.verts[i],
        w = f.verts[(i + 1) % n];
      verts.push(u);
      uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
      const mid = along(u, w);
      const r = newV.get(edgeKey(u, w));
      mid.forEach((v, k) => {
        verts.push(v);
        const t = r && r.x === u ? params[k] : 1 - params[params.length - 1 - k];
        const j = (i + 1) % n;
        uvs.push(f.uvs[i * 2] + (f.uvs[j * 2] - f.uvs[i * 2]) * t, f.uvs[i * 2 + 1] + (f.uvs[j * 2 + 1] - f.uvs[i * 2 + 1]) * t);
      });
    }
    out.push(m.makeFace(verts, f, uvs));
  });
  m.faces = out;
  // select the new loop(s)
  m.sel = m.sel.map(() => 0);
  for (const r of newV.values()) for (const id of r.ids) m.sel[id] = 1;
  return true;
}

// interactive loop cut: preview the ring under the cursor, wheel changes cuts, click cuts then slides
let loopPreview: { v: View3D; edges: [number, number][]; obId: string; cuts: number } | null = null;

function ringPreviewEdges(me: MeshData, a: number, b: number) {
  return edgeRing(me, a, b);
}

editModeHooks.svg.push((v) => {
  if (!loopPreview || loopPreview.v !== v) return null;
  const ob = app.doc.objects[loopPreview.obId];
  const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
  if (!me) return null;
  const w = app.graph.get(ob.id)?.world ?? new Matrix4();
  const P = me.positions;
  const segs: string[] = [];
  const pts = (i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(w);
  // draw the cut lines across the ring faces
  const ring = loopPreview.edges;
  for (let c = 1; c <= loopPreview.cuts; c++) {
    const t = c / (loopPreview.cuts + 1);
    const line = ring.map(([x, y]) => v.project(pts(x).lerp(pts(y), t)));
    segs.push(line.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(''));
  }
  return h('g', { class: 'loopcut-preview' }, segs.map((d) => h('path', { d, fill: 'none', stroke: '#ffd34d', 'stroke-width': 2 })));
});

function startLoopCut() {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  let cuts = 1;
  let target: { obId: string; a: number; b: number } | null = null;
  const update = (cx: number, cy: number) => {
    const r = v.el.getBoundingClientRect();
    target = null;
    loopPreview = null;
    for (const { ob, me } of editMeshObjects()) {
      const c = pickContext(v, ob, me);
      const e = nearestEdge(c, cx - r.left, cy - r.top, 60);
      if (!e) continue;
      target = { obId: ob.id, a: e.a, b: e.b };
      loopPreview = { v, edges: ringPreviewEdges(me, e.a, e.b), obId: ob.id, cuts };
      break;
    }
    v.drawSvg();
  };
  update(app.pointer.x, app.pointer.y);
  let cutsTyped = '';
  app.startModal({
    label: 'Loop Cut and Slide',
    header: () => `Number of Cuts: ${cuts}   (wheel / +/- to change, click to cut)`,
    status: () => [['LMB', 'Cut'], ['Wheel', 'Number of Cuts'], ['RMB', 'Cut without slide']],
    onPointerMove(e) {
      update(e.clientX, e.clientY);
    },
    onWheel(e) {
      cuts = Math.max(1, Math.min(100, cuts + (e.deltaY < 0 ? 1 : -1)));
      if (loopPreview) loopPreview.cuts = cuts;
      v.drawSvg();
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === '+' || e.key === '=') cuts++;
      if (e.key === '-') cuts = Math.max(1, cuts - 1);
      // typing a number sets the cut count directly
      if (/^[0-9]$/.test(e.key)) {
        cutsTyped = (cutsTyped + e.key).slice(-3);
        cuts = Math.max(1, Math.min(100, Number(cutsTyped)));
      } else if (e.key === 'Backspace') {
        cutsTyped = cutsTyped.slice(0, -1);
        cuts = Math.max(1, Number(cutsTyped) || 1);
      }
      if (loopPreview) loopPreview.cuts = cuts;
      v.drawSvg();
      return true;
    },
    onPointerDown(e) {
      if (!target) return 'CANCELLED';
      const t = target as { obId: string; a: number; b: number };
      const ob = app.doc.objects[t.obId];
      const me = app.doc.meshes[ob.data!];
      const m = MeshEdit.from(me);
      if (!loopCut(m, t.a, t.b, cuts, 0)) return 'CANCELLED';
      m.write(me);
      this.redoOp = { idname: 'mesh.loopcut', props: { object: t.obId, edge: [t.a, t.b], number_cuts: cuts, smoothness: 0, falloff: 'INVERSE_SQUARE', edge_slide: 0 } };
      loopPreview = null;
      app.changed('geometry');
      // right click: cut only; left click: continue into an edge slide
      if (e.button === 0) setTimeout(() => app.run('transform.edge_slide', {}, { event: { x: e.clientX, y: e.clientY } }), 0);
      return 'FINISHED';
    },
    cancel() {
      loopPreview = null;
      v.drawSvg();
    },
  });
  return 'RUNNING_MODAL' as const;
}

// ---------------------------------------------------------------------------
// bevel (vertices: chamfer corners; edges: offset along adjacent faces)

interface BevelState {
  offset: number;
  segments: number;
  profile: number;
  affect: 'VERTICES' | 'EDGES';
  clamp: boolean;
  seam: boolean;
  sharp: boolean;
}

function applyBevel(m: MeshEdit, st: BevelState) {
  if (st.offset <= 0) return false;
  return st.affect === 'VERTICES' ? bevelVertices(m, st.clamp ? Math.min(st.offset, bevelClampLimit(m) * 2) : st.offset, st.segments, st.profile) : bevelEdges(m, st.offset, st.segments, st.profile, { clamp: st.clamp, markSeam: st.seam, markSharp: st.sharp });
}

/**
 * Interactive bevel: mouse distance sets the width (A), profile (P) or segments (S); wheel and
 * numpad +/- change segments; V switches vertices/edges; C clamps overlap; U/K mark seams/sharp.
 */
function startBevelModal(p: Record<string, unknown>) {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  const st: BevelState = {
    offset: 0,
    segments: Math.max(1, (p.segments as number) ?? 1),
    profile: (p.profile as number) ?? 0.5,
    affect: p.affect === 'VERTICES' ? 'VERTICES' : 'EDGES',
    clamp: !!p.clamp_overlap,
    seam: !!p.mark_seam,
    sharp: !!p.mark_sharp,
  };
  const snaps = editMeshObjects().map(({ me }) => ({ me, m: MeshEdit.from(me) }));
  const hasSel = () => snaps.some((s) => (st.affect === 'VERTICES' ? s.m.selectedVerts().length : s.m.selectedEdges().length));
  if (!hasSel()) {
    app.report('WARNING', st.affect === 'VERTICES' ? 'Select vertices to bevel' : 'Select edges to bevel');
    return 'CANCELLED' as const;
  }
  const r = v.el.getBoundingClientRect();
  const center = new Vector3();
  let cnt = 0;
  for (const { ob, me } of editMeshObjects()) {
    const w = app.graph.get(ob.id)?.world ?? new Matrix4();
    me.select_vert?.forEach((sv, i) => {
      if (sv) {
        center.add(new Vector3(me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]).applyMatrix4(w));
        cnt++;
      }
    });
  }
  center.multiplyScalar(1 / Math.max(1, cnt));
  const cs = v.project(center);
  const d0 = Math.max(10, Math.hypot(app.pointer.x - r.left - cs.x, app.pointer.y - r.top - cs.y));
  const px = v.nav.pixelSize(center);
  let mode: 'OFFSET' | 'PROFILE' | 'SEGMENTS' = 'OFFSET';
  let typed = '';
  let lastDist = d0;
  let precise = false;
  let snapOn = false;
  const apply = () => {
    for (const sn of snaps) {
      const c = sn.m.clone();
      applyBevel(c, st);
      c.write(sn.me);
    }
    app.changed('geometry');
  };
  const applyTyped = () => {
    const x = parseFloat(typed);
    if (!Number.isFinite(x)) return;
    if (mode === 'SEGMENTS') st.segments = Math.max(1, Math.min(1000, Math.round(x)));
    else if (mode === 'PROFILE') st.profile = Math.max(0, Math.min(1, x));
    else st.offset = Math.max(0, x);
  };
  const fromMouse = (dist: number) => {
    if (mode === 'OFFSET') {
      let o = Math.max(0, (dist - d0) * px);
      if (snapOn) o = Math.round(o * 10) / 10;
      st.offset = precise ? st.offset + (dist - lastDist) * px * 0.1 : o;
      st.offset = Math.max(0, st.offset);
    } else if (mode === 'PROFILE') st.profile = Math.max(0, Math.min(1, st.profile + ((dist - lastDist) / 200) * (precise ? 0.1 : 1)));
    else st.segments = Math.max(1, Math.min(100, st.segments + Math.round((dist - lastDist) / 25)));
    if (mode !== 'SEGMENTS' || Math.abs(dist - lastDist) >= 25) lastDist = dist;
  };
  const on = (b: boolean) => (b ? 'On' : 'Off');
  const val = (m: typeof mode, text: string) => (mode === m && typed ? `${typed}|` : text);
  app.startModal({
    label: st.affect === 'VERTICES' ? 'Bevel Vertices' : 'Bevel',
    header: () =>
      `Bevel ${st.affect === 'VERTICES' ? 'Vertices' : 'Edges'} — ${mode === 'OFFSET' ? '[Width]' : 'Width'}: ${val('OFFSET', st.offset.toFixed(4) + ' m')}  ${mode === 'SEGMENTS' ? '[Segments]' : 'Segments'}: ${val('SEGMENTS', String(st.segments))}  ${mode === 'PROFILE' ? '[Shape]' : 'Shape'}: ${val('PROFILE', st.profile.toFixed(3))}  Clamp: ${on(st.clamp)}  Seams: ${on(st.seam)}  Sharp: ${on(st.sharp)}`,
    status: () => [
      ['LMB', 'Confirm'],
      ['RMB', 'Cancel'],
      ['A', 'Width'],
      ['S', 'Segments'],
      ['P', 'Shape'],
      ['Wheel', 'Segments ±'],
      ['V', 'Vertices/Edges'],
      ['C', 'Clamp Overlap'],
      ['U', 'Mark Seams'],
      ['K', 'Mark Sharp'],
    ],
    onPointerMove(e) {
      if (typed) return;
      precise = e.shiftKey;
      snapOn = e.ctrlKey;
      fromMouse(Math.hypot(e.clientX - r.left - cs.x, e.clientY - r.top - cs.y));
      apply();
    },
    onWheel(e) {
      st.segments = Math.max(1, Math.min(1000, st.segments + (e.deltaY < 0 ? 1 : -1)));
      apply();
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined;
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      const setMode = (m: typeof mode) => {
        mode = m;
        typed = '';
      };
      if (k === 'a') setMode('OFFSET');
      else if (k === 's') setMode('SEGMENTS');
      else if (k === 'p') setMode('PROFILE');
      else if (k === 'v') {
        st.affect = st.affect === 'VERTICES' ? 'EDGES' : 'VERTICES';
        if (!hasSel()) st.affect = st.affect === 'VERTICES' ? 'EDGES' : 'VERTICES';
      } else if (k === 'c') st.clamp = !st.clamp;
      else if (k === 'u') st.seam = !st.seam;
      else if (k === 'k') st.sharp = !st.sharp;
      else if (e.key === '+' || (e.code === 'NumpadAdd' && !typed)) st.segments = Math.min(1000, st.segments + 1);
      else if ((e.key === '-' && typed === '' && mode === 'SEGMENTS') || e.code === 'NumpadSubtract') st.segments = Math.max(1, st.segments - 1);
      else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !typed)) {
        typed += e.key;
        applyTyped();
      } else if (e.key === 'Backspace') {
        typed = typed.slice(0, -1);
        applyTyped();
      } else return true;
      apply();
      return true;
    },
    cancel() {
      for (const sn of snaps) sn.m.write(sn.me);
      app.changed('geometry');
    },
    finish() {
      this.label = st.affect === 'VERTICES' ? 'Bevel Vertices' : 'Bevel';
      this.redoOp = { idname: 'mesh.bevel', props: { offset: st.offset, segments: st.segments, profile: st.profile, affect: st.affect, clamp_overlap: st.clamp, mark_seam: st.seam, mark_sharp: st.sharp } };
    },
  });
  return 'RUNNING_MODAL' as const;
}

// ---------------------------------------------------------------------------
// spin

export function spin(m: MeshEdit, steps: number, angle: number, center: Vector3, axis: Vector3, dupli = false, opts: { autoMerge?: boolean; flip?: boolean } = {}) {
  const fsel = m.selectedFaces();
  const profileVerts = m.selectedVerts();
  if (!profileVerts.length) return false;
  const selEdges = m.selectedEdges();
  // edges that sweep into walls: region outline for faces, else the selected edges
  const count = new Map<string, number>();
  for (const fi of fsel) {
    const f = m.faces[fi];
    for (let i = 0; i < f.verts.length; i++) {
      const k = edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const faceEdges = new Set(count.keys());
  const profileEdges: [number, number][] = [...[...count.entries()].filter(([, c]) => c === 1).map(([k]) => k.split(':').map(Number) as [number, number]), ...selEdges.filter(([a, b]) => !faceEdges.has(edgeKey(a, b)))];
  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-4;
  const merge = !dupli && full && !!opts.autoMerge;
  const first = new Map(profileVerts.map((v) => [v, v]));
  let prev = first;
  const firstFace = m.faces.length;
  for (let s = 1; s <= steps; s++) {
    const last = s === steps;
    let cur: Map<number, number>;
    if (last && merge) cur = first;
    else {
      const q = new Quaternion().setFromAxisAngle(axis, (angle * s) / steps);
      cur = new Map<number, number>();
      for (const v of profileVerts) {
        const p = V(m.p(v)).sub(center).applyQuaternion(q).add(center);
        cur.set(v, m.addVert([p.x, p.y, p.z], [[v, 1]], last ? 1 : 0));
      }
    }
    if (dupli) {
      // a rotated copy of the selection at every step
      for (const fi of fsel) {
        const f = m.faces[fi];
        m.faces.push({ ...f, verts: f.verts.map((v) => cur.get(v)!), uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined, cnormals: undefined });
      }
      for (const [a, b] of selEdges) if (!faceEdges.has(edgeKey(a, b))) m.looseEdges.push([cur.get(a)!, cur.get(b)!]);
    } else for (const [a, b] of profileEdges) m.faces.push(m.makeFace([prev.get(a)!, prev.get(b)!, cur.get(b)!, cur.get(a)!], fsel.length ? m.faces[fsel[0]] : undefined));
    prev = cur;
  }
  if (!dupli && fsel.length && !merge) {
    // end cap: the selected faces at the final position
    for (const fi of fsel) {
      const f = m.faces[fi];
      m.faces.push({ ...f, verts: f.verts.map((v) => prev.get(v)!), uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined, cnormals: undefined });
    }
  }
  if (!dupli && fsel.length) {
    // like an extrusion, the swept faces leave their start position
    const rm = new Set(fsel);
    m.faces = m.faces.filter((_, i) => !rm.has(i));
  }
  if (!merge) for (const v of profileVerts) m.sel[v] = 0;
  makeNormalsConsistentNew(m);
  if (opts.flip) for (let i = firstFace - (!dupli ? fsel.length : 0); i < m.faces.length; i++) if (m.faces[i]) flipFace(m.faces[i]);
  return true;
}

// ---------------------------------------------------------------------------

registerOperators([
  {
    idname: 'mesh.inset',
    label: 'Inset Faces',
    props: [
      { id: 'thickness', label: 'Thickness', type: 'float', default: 0, min: 0, subtype: 'distance' },
      { id: 'depth', label: 'Depth', type: 'float', default: 0, subtype: 'distance' },
      { id: 'use_individual', label: 'Individual', type: 'bool', default: false },
      { id: 'use_outset', label: 'Outset', type: 'bool', default: false },
      { id: 'use_select_inset', label: 'Select Outer', type: 'bool', default: false },
      { id: 'use_even_offset', label: 'Offset Even', type: 'bool', default: true },
      { id: 'use_relative_offset', label: 'Offset Relative', type: 'bool', default: false },
    ],
    poll: editPoll,
    invoke: (_ctx, p) => startInsetModal(!!p.use_individual, !!p.use_outset),
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const before = m.faces.length;
        if (!insetFaces(m, p.thickness as number, p.depth as number, !!p.use_individual, !!p.use_outset, { even: p.use_even_offset !== false, relative: !!p.use_relative_offset })) return false;
        if (p.use_select_inset) {
          // select the new rim instead of the inner faces
          const inner = new Set(m.selectedFaces());
          m.sel = m.sel.map(() => 0);
          for (let i = before; i < m.faces.length; i++) for (const v of m.faces[i].verts) m.sel[v] = 1;
          for (const fi of inner) m.faces[fi].selX = true;
        }
      }),
  },
  {
    idname: 'mesh.edge_face_add',
    label: 'Make Edge/Face',
    description: 'Add an edge or face to selected',
    poll: editPoll,
    exec: () => {
      if (!withEdit((m) => edgeFaceAdd(m))) return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.bridge_edge_loops',
    label: 'Bridge Edge Loops',
    description: 'Join two or more edge loops (or face outlines) with faces',
    props: [
      { id: 'type', label: 'Connect Loops', type: 'enum', default: 'SINGLE', items: [['SINGLE', 'Open Loop'], ['CLOSED', 'Closed Loop'], ['PAIRS', 'Loop Pairs']] },
      { id: 'use_merge', label: 'Merge', type: 'bool', default: false },
      { id: 'merge_factor', label: 'Merge Factor', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor', showIf: (p) => !!p.use_merge },
      { id: 'twist_offset', label: 'Twist', type: 'int', default: 0, min: -1000, max: 1000 },
      { id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 0, min: 0, max: 1000, showIf: (p) => !p.use_merge },
      { id: 'interpolation', label: 'Interpolation', type: 'enum', default: 'PATH', items: [['LINEAR', 'Linear'], ['PATH', 'Blend Path']], showIf: (p) => !p.use_merge && (p.number_cuts as number) > 0 },
      { id: 'smoothness', label: 'Smoothness', type: 'float', default: 1, min: 0, max: 1000, softMax: 2, showIf: (p) => !p.use_merge && (p.number_cuts as number) > 0 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const o: BridgeOptions = { type: p.type as 'SINGLE', merge: !!p.use_merge, mergeFactor: p.merge_factor as number, twist: p.twist_offset as number, cuts: p.number_cuts as number, interpolation: p.interpolation as 'PATH', smoothness: p.smoothness as number };
      if (!withEdit((m) => bridgeLoops(m, o))) return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.subdivide',
    label: 'Subdivide',
    description: 'Split the selected edges and faces into smaller ones',
    props: [
      { id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 100 },
      { id: 'smoothness', label: 'Smoothness', type: 'float', default: 0, min: 0, max: 1000, softMax: 1, subtype: 'factor' },
      { id: 'quadcorner', label: 'Quad Corner Type', type: 'enum', default: 'STRAIGHT_CUT', items: [['INNERVERT', 'Inner Vert'], ['STRAIGHT_CUT', 'Straight Cut'], ['FAN', 'Fan']] },
      { id: 'fractal', label: 'Fractal', type: 'float', default: 0, min: 0, max: 1e6, softMax: 1000 },
      { id: 'fractal_along_normal', label: 'Along Normal', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const o: SubdivideOptions = { quadcorner: p.quadcorner as 'FAN', fractal: p.fractal as number, fractalAlongNormal: p.fractal_along_normal as number, seed: p.seed as number };
      if (!withEdit((m) => subdivide(m, p.number_cuts as number, p.smoothness as number, o))) return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.loopcut_slide',
    label: 'Loop Cut and Slide',
    poll: editPoll,
    invoke: () => startLoopCut(),
  },
  {
    idname: 'mesh.loopcut',
    label: 'Loop Cut',
    props: [
      { id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 100 },
      { id: 'smoothness', label: 'Smoothness', type: 'float', default: 0, min: -1000, max: 1000, subtype: 'factor', hidden: true },
      { id: 'edge_slide', label: 'Factor', type: 'float', default: 0, min: -1, max: 1, subtype: 'factor' },
      { id: 'object', label: 'Object', type: 'string', default: '', hidden: true },
      { id: 'edge', label: 'Edge', type: 'vec2', default: [0, 1], hidden: true },
      { id: 'falloff', label: 'Falloff', type: 'string', default: 'INVERSE_SQUARE', hidden: true },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const ob = app.doc.objects[p.object as string] ?? app.activeObject;
      if (!ob?.data) return 'CANCELLED';
      const me = app.doc.meshes[ob.data];
      const [a, b] = p.edge as number[];
      const m = MeshEdit.from(me);
      if (!loopCut(m, a, b, p.number_cuts as number, p.edge_slide as number)) return 'CANCELLED';
      m.write(me);
      app.changed('geometry');
    },
  },
  {
    idname: 'mesh.poke',
    label: 'Poke Faces',
    description: 'Split each selected face into a fan of triangles around a new centre vertex',
    props: [
      { id: 'offset', label: 'Poke Offset', type: 'float', default: 0, min: -1000, max: 1000, softMin: -1, softMax: 1, subtype: 'distance' },
      { id: 'use_relative_offset', label: 'Offset Relative', type: 'bool', default: false },
      { id: 'center_mode', label: 'Poke Center', type: 'enum', default: 'MEDIAN_WEIGHTED', items: [['MEDIAN_WEIGHTED', 'Weighted Median', 'Centre weighted by edge length'], ['MEDIAN', 'Median', 'Average of the corners'], ['BOUNDS', 'Bounds', 'Centre of the bounding box']] },
    ],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const fsel = new Set(m.selectedFaces());
        const out: EFace[] = [];
        m.faces.forEach((f, fi) => {
          if (!fsel.has(fi)) return out.push(f);
          const pts = f.verts.map((v) => V(m.p(v)));
          const n = pts.length;
          let c = new Vector3();
          if (p.center_mode === 'BOUNDS') {
            const min = pts[0].clone(),
              max = pts[0].clone();
            for (const q of pts) {
              min.min(q);
              max.max(q);
            }
            c = min.add(max).multiplyScalar(0.5);
          } else if (p.center_mode === 'MEDIAN') {
            for (const q of pts) c.add(q);
            c.multiplyScalar(1 / n);
          } else {
            // each corner weighted by the length of its two edges
            let wsum = 0;
            pts.forEach((q, i) => {
              const w = q.distanceTo(pts[(i + 1) % n]) + q.distanceTo(pts[(i + n - 1) % n]);
              c.addScaledVector(q, w);
              wsum += w;
            });
            c.multiplyScalar(1 / (wsum || 1));
          }
          let off = p.offset as number;
          if (p.use_relative_offset) off *= pts.reduce((s, q) => s + q.distanceTo(c), 0) / n;
          c.addScaledVector(V(m.faceNormal(f)), off);
          const cid = m.addVert([c.x, c.y, c.z], f.verts.map((v) => [v, 1 / n] as [number, number]), 1);
          const cu = [0, 1].map((k) => f.verts.reduce((acc, _, i) => acc + f.uvs[i * 2 + k], 0) / n);
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const t = m.makeFace([f.verts[i], f.verts[j], cid], f, [f.uvs[i * 2], f.uvs[i * 2 + 1], f.uvs[j * 2], f.uvs[j * 2 + 1], ...cu]);
            t.seams[0] = f.seams[i];
            t.sharp[0] = f.sharp[i];
            t.creases[0] = f.creases[i];
            out.push(t);
          }
        });
        m.faces = out;
      }),
  },
  {
    idname: 'mesh.bevel',
    label: 'Bevel',
    description: 'Cut off the selected edges or vertices at an angle',
    props: [
      { id: 'offset', label: 'Width', type: 'float', default: 0, min: 0, subtype: 'distance' },
      { id: 'segments', label: 'Segments', type: 'int', default: 1, min: 1, max: 1000 },
      { id: 'profile', label: 'Shape', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'affect', label: 'Affect', type: 'enum', default: 'EDGES', items: [['VERTICES', 'Vertices'], ['EDGES', 'Edges']] },
      { id: 'clamp_overlap', label: 'Clamp Overlap', type: 'bool', default: false },
      { id: 'mark_seam', label: 'Mark Seams', type: 'bool', default: false, showIf: (p) => p.affect !== 'VERTICES' },
      { id: 'mark_sharp', label: 'Mark Sharp', type: 'bool', default: false, showIf: (p) => p.affect !== 'VERTICES' },
    ],
    poll: editPoll,
    invoke: (_ctx, p) => startBevelModal(p),
    exec: (_ctx, p) => {
      const st: BevelState = { offset: p.offset as number, segments: p.segments as number, profile: p.profile as number, affect: p.affect === 'VERTICES' ? 'VERTICES' : 'EDGES', clamp: !!p.clamp_overlap, seam: !!p.mark_seam, sharp: !!p.mark_sharp };
      if (!withEdit((m) => applyBevel(m, st))) return 'CANCELLED';
    },
  },
  {
    idname: 'mesh.spin',
    label: 'Spin',
    description: 'Extrude the selection around the 3D cursor',
    props: [
      { id: 'steps', label: 'Steps', type: 'int', default: 12, min: 0, max: 1000000, softMax: 128 },
      { id: 'dupli', label: 'Use Duplicates', type: 'bool', default: false },
      { id: 'angle', label: 'Angle', type: 'float', default: Math.PI / 2, min: -Math.PI * 2, max: Math.PI * 2, subtype: 'angle' },
      { id: 'use_auto_merge', label: 'Auto Merge', type: 'bool', default: true },
      { id: 'use_normal_flip', label: 'Flip Normals', type: 'bool', default: false },
      { id: 'center', label: 'Center', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'axis', label: 'Axis', type: 'vec3', default: null },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const c = p.center ? V(p.center as number[]) : V(app.doc.scene.cursor.location);
      p.center = [c.x, c.y, c.z];
      let axis = p.axis ? V(p.axis as number[]) : null;
      if (!axis || axis.lengthSq() === 0) {
        // the view axis (towards the viewer)
        const v = activeView3D();
        axis = v ? new Vector3(0, 0, 1).applyQuaternion(v.camera.quaternion) : new Vector3(0, 0, 1);
        p.axis = [axis.x, axis.y, axis.z];
      }
      const ax = axis;
      if ((p.steps as number) < 1) return 'CANCELLED';
      const ok = withEdit((m, ob) => {
        const inv = (app.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert();
        return spin(m, p.steps as number, p.angle as number, c.clone().applyMatrix4(inv), ax.clone().transformDirection(inv).normalize(), !!p.dupli, { autoMerge: !!p.use_auto_merge, flip: !!p.use_normal_flip });
      });
      if (!ok) return 'CANCELLED';
    },
  },
]);

export { translateSelection as moveSelected, selectMode, active, renderContext };
