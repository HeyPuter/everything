// More Edit Mode selection tools: by trait (interior faces, poles, ungrouped), loops/regions,
// linked flat faces, shortest path, sharp edges, side of active, next/previous active, and the
// full Select Similar set for vertices, edges and faces.
import { Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import type { MenuItem } from '../../ui/menu';
import type { MeshData } from '../../data/types';
import { MeshEdit, edgeKey } from './meshedit';
import { editMeshObjects, ensureSelection, selectMode, active, selectHistory, pushSelectHistory, worldMatrix } from './context';
import { editPoll } from './ops-basic';
import { V, faceEdgeKeys, vertexNormals, edgeChains } from './geom';
import { edgeLoop, edgeRing } from './select';
import { selectFaces as selectFaceSet } from './selset';

type SelFn = (me: MeshData, m: MeshEdit, sel: Uint8Array) => void;

/** Run a selection change on every edited mesh. */
function eachSel(fn: SelFn, extend = true) {
  for (const { me } of editMeshObjects()) {
    ensureSelection(me);
    const m = MeshEdit.from(me);
    const sel = extend ? new Uint8Array(me.select_vert!) : new Uint8Array(me.positions.length / 3);
    fn(me, m, sel);
    if (me.hide_vert) for (let i = 0; i < sel.length; i++) if (me.hide_vert[i]) sel[i] = 0;
    me.select_vert = sel;
  }
  app.changed('select');
}

const selectFace = (m: MeshEdit, fi: number, sel: Uint8Array) => {
  for (const v of m.faces[fi].verts) sel[v] = 1;
};

// ---------------------------------------------------------------------------
// region ↔ loop

/** Vertices on the outline of the selected face region. */
export function regionToLoop(m: MeshEdit): number[] {
  const fsel = new Set(m.selectedFaces());
  const ef = m.edgeFaces();
  const out = new Set<number>();
  for (const [k, l] of ef) {
    const n = l.filter(([f]) => fsel.has(f)).length;
    if (n === 1) k.split(':').forEach((x) => out.add(Number(x)));
  }
  return [...out];
}

/** Faces enclosed by the selected edge loops (the smaller side unless `bigger`). */
export function loopToRegion(m: MeshEdit, bigger: boolean): number[] {
  const walls = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  if (!walls.size) return [];
  const ef = m.edgeFaces();
  const comp = new Int32Array(m.faces.length).fill(-1);
  const sizes: number[] = [];
  const touchesWall: boolean[] = [];
  for (let s = 0; s < m.faces.length; s++) {
    if (comp[s] >= 0) continue;
    const c = sizes.length;
    let size = 0,
      touches = false;
    const st = [s];
    comp[s] = c;
    while (st.length) {
      const fi = st.pop()!;
      size++;
      for (const k of faceEdgeKeys(m.faces[fi])) {
        if (walls.has(k)) {
          touches = true;
          continue;
        }
        for (const [g] of ef.get(k) ?? [])
          if (comp[g] < 0) {
            comp[g] = c;
            st.push(g);
          }
      }
    }
    sizes.push(size);
    touchesWall.push(touches);
  }
  // among regions bordering the loop pick the smallest (or biggest) per connected piece
  const cands = sizes.map((s, i) => ({ s, i })).filter((x) => touchesWall[x.i]);
  if (!cands.length) return [];
  cands.sort((a, b) => (bigger ? b.s - a.s : a.s - b.s));
  const pick = cands[0].i;
  // other regions of the same size on other parts of the mesh are included too
  const chosen = new Set(cands.filter((c) => c.s === cands[0].s).map((c) => c.i));
  void pick;
  return m.faces.map((_, i) => i).filter((i) => chosen.has(comp[i]));
}

// ---------------------------------------------------------------------------
// similar

type SimilarType =
  | 'VERT_NORMAL' | 'VERT_FACES' | 'VERT_GROUPS' | 'VERT_EDGES'
  | 'EDGE_LENGTH' | 'EDGE_DIR' | 'EDGE_FACES' | 'EDGE_FACE_ANGLE' | 'EDGE_CREASE' | 'EDGE_SEAM' | 'EDGE_SHARP'
  | 'FACE_MATERIAL' | 'FACE_AREA' | 'FACE_SIDES' | 'FACE_PERIMETER' | 'FACE_NORMAL' | 'FACE_COPLANAR' | 'FACE_SMOOTH';

export const SIMILAR_ITEMS: Record<'VERT' | 'EDGE' | 'FACE', [SimilarType, string][]> = {
  VERT: [['VERT_NORMAL', 'Normal'], ['VERT_FACES', 'Amount of Adjacent Faces'], ['VERT_GROUPS', 'Vertex Groups'], ['VERT_EDGES', 'Amount of Connecting Edges']],
  EDGE: [['EDGE_LENGTH', 'Length'], ['EDGE_DIR', 'Direction'], ['EDGE_FACES', 'Amount of Faces Around an Edge'], ['EDGE_FACE_ANGLE', 'Face Angles'], ['EDGE_CREASE', 'Crease'], ['EDGE_SEAM', 'Seam'], ['EDGE_SHARP', 'Sharpness']],
  FACE: [['FACE_MATERIAL', 'Material'], ['FACE_AREA', 'Area'], ['FACE_SIDES', 'Polygon Sides'], ['FACE_PERIMETER', 'Perimeter'], ['FACE_NORMAL', 'Normal'], ['FACE_COPLANAR', 'Coplanar'], ['FACE_SMOOTH', 'Flat/Smooth']],
};
const LEGACY: Record<string, SimilarType> = { NORMAL: 'FACE_NORMAL', AREA: 'FACE_AREA', SIDES: 'FACE_SIDES', MATERIAL: 'FACE_MATERIAL', SMOOTH: 'FACE_SMOOTH', COPLANAR: 'FACE_COPLANAR' };

function faceArea(m: MeshEdit, fi: number) {
  const f = m.faces[fi];
  const n = new Vector3();
  const p0 = V(m.p(f.verts[0]));
  for (let i = 1; i < f.verts.length - 1; i++) n.add(V(m.p(f.verts[i])).sub(p0).cross(V(m.p(f.verts[i + 1])).sub(p0)));
  return n.length() / 2;
}

export function selectSimilar(m: MeshEdit, me: MeshData, sel: Uint8Array, type: SimilarType, compare: string, threshold: number) {
  const thr = threshold + 1e-5;
  const cmp = (ref: number, v: number, scale = 1) => (compare === 'GREATER' ? v >= ref - thr * scale : compare === 'LESS' ? v <= ref + thr * scale : Math.abs(v - ref) <= thr * scale);
  const dirMatch = (a: Vector3, b: Vector3, both = false) => {
    const d = a.dot(b);
    return (both ? Math.abs(d) : d) >= Math.cos(Math.min(1, thr) * Math.PI) - 1e-9;
  };
  if (type.startsWith('VERT')) {
    const verts = m.selectedVerts();
    if (!verts.length) return;
    const vf = m.vertexFaces();
    const nb = m.neighbors();
    const normals = type === 'VERT_NORMAL' ? vertexNormals(m) : [];
    const groups = (v: number) => m.weights.map((w, i) => ((w[v] ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
    for (let v = 0; v < m.vcount; v++) {
      if (m.hide[v]) continue;
      const ok = verts.some((r) => {
        if (type === 'VERT_NORMAL') return dirMatch(normals[r], normals[v]);
        if (type === 'VERT_FACES') return cmp(vf[r].length, vf[v].length);
        if (type === 'VERT_EDGES') return cmp(nb[r].length, nb[v].length);
        const g = groups(r);
        return groups(v).some((x) => g.includes(x));
      });
      if (ok) sel[v] = 1;
    }
    return;
  }
  if (type.startsWith('EDGE')) {
    const edges = m.edges();
    const selE = m.selectedEdges();
    if (!selE.length) return;
    const ef = m.edgeFaces();
    const flag = (a: number, b: number, key: 'seams' | 'sharp' | 'creases') => {
      for (const [fi, c] of ef.get(edgeKey(a, b)) ?? []) if (m.faces[fi][key][c]) return m.faces[fi][key][c];
      return 0;
    };
    const val = (a: number, b: number): number | Vector3 => {
      switch (type) {
        case 'EDGE_LENGTH':
          return V(m.p(a)).distanceTo(V(m.p(b)));
        case 'EDGE_DIR':
          return V(m.p(b)).sub(V(m.p(a))).normalize();
        case 'EDGE_FACES':
          return ef.get(edgeKey(a, b))?.length ?? 0;
        case 'EDGE_FACE_ANGLE': {
          const l = ef.get(edgeKey(a, b)) ?? [];
          return l.length === 2 ? V(m.faceNormal(m.faces[l[0][0]])).angleTo(V(m.faceNormal(m.faces[l[1][0]]))) : -1;
        }
        case 'EDGE_CREASE':
          return flag(a, b, 'creases');
        case 'EDGE_SEAM':
          return flag(a, b, 'seams') ? 1 : 0;
        default:
          return flag(a, b, 'sharp') ? 1 : 0;
      }
    };
    const refs = selE.map(([a, b]) => val(a, b));
    for (const [a, b] of edges) {
      if (m.hide[a] || m.hide[b]) continue;
      const v = val(a, b);
      const ok = refs.some((r) => {
        if (r instanceof Vector3) return dirMatch(r, v as Vector3, true);
        if (type === 'EDGE_LENGTH') return cmp(r, v as number, Math.max(r, 1e-9));
        if (type === 'EDGE_FACE_ANGLE') return cmp(r, v as number, Math.PI);
        if (type === 'EDGE_SEAM' || type === 'EDGE_SHARP') return r === v;
        return cmp(r, v as number);
      });
      if (ok) sel[a] = sel[b] = 1;
    }
    return;
  }
  const faces = m.selectedFaces();
  if (!faces.length) return;
  const val = (fi: number): number[] => {
    const f = m.faces[fi];
    switch (type) {
      case 'FACE_MATERIAL':
        return [f.material];
      case 'FACE_AREA':
        return [faceArea(m, fi)];
      case 'FACE_SIDES':
        return [f.verts.length];
      case 'FACE_PERIMETER':
        return [f.verts.reduce((s, v, i) => s + V(m.p(v)).distanceTo(V(m.p(f.verts[(i + 1) % f.verts.length]))), 0)];
      case 'FACE_SMOOTH':
        return [f.smooth ? 1 : 0];
      default: {
        const n = m.faceNormal(f);
        const c = m.faceCenter(f);
        return [...n, n[0] * c[0] + n[1] * c[1] + n[2] * c[2]];
      }
    }
  };
  const refs = faces.map(val);
  m.faces.forEach((f, fi) => {
    if (f.verts.some((v) => m.hide[v])) return;
    const v = val(fi);
    const ok = refs.some((r) => {
      if (type === 'FACE_NORMAL' || type === 'FACE_COPLANAR') {
        const same = dirMatch(V(r), V(v));
        return type === 'FACE_NORMAL' ? same : same && Math.abs(r[3] - v[3]) <= 1e-4 + thr;
      }
      if (type === 'FACE_AREA' || type === 'FACE_PERIMETER') return cmp(r[0], v[0], Math.max(r[0], 1e-9));
      if (type === 'FACE_MATERIAL' || type === 'FACE_SMOOTH') return r[0] === v[0];
      return cmp(r[0], v[0]);
    });
    if (ok) selectFace(m, fi, sel);
  });
}

export function similarMenu(): MenuItem[] {
  const items: MenuItem[] = SIMILAR_ITEMS[selectMode()].map(([t, label]) => ({ label, op: 'mesh.select_similar', props: { type: t } }));
  if (selectMode() === 'FACE') items.push({ separator: true }, { label: 'Face Regions', op: 'mesh.select_similar_region' });
  return items;
}

// ---------------------------------------------------------------------------
// similar regions: other places with the same face topology as a selected region

/** Try to map region faces onto the mesh starting from region face `r0` ↦ `m0` with corner offset. */
function matchRegion(m: MeshEdit, region: number[], ef: Map<string, [number, number][]>, r0: number, m0: number, offset: number): number[] | null {
  const inRegion = new Set(region);
  const faceMap = new Map<number, [number, number]>([[r0, [m0, offset]]]); // region face → [mesh face, corner offset]
  const vmap = new Map<number, number>();
  const used = new Set<number>([m0]);
  const queue = [r0];
  const mapVert = (a: number, b: number) => {
    const cur = vmap.get(a);
    if (cur !== undefined) return cur === b;
    vmap.set(a, b);
    return true;
  };
  while (queue.length) {
    const fr = queue.shift()!;
    const [fm, off] = faceMap.get(fr)!;
    const R = m.faces[fr],
      M = m.faces[fm];
    const n = R.verts.length;
    if (M.verts.length !== n) return null;
    for (let i = 0; i < n; i++) if (!mapVert(R.verts[i], M.verts[(i + off) % n])) return null;
    for (let i = 0; i < n; i++) {
      const a = R.verts[i],
        b = R.verts[(i + 1) % n];
      const gr = (ef.get(edgeKey(a, b)) ?? []).map(([g]) => g).find((g) => g !== fr && inRegion.has(g));
      if (gr === undefined) continue;
      const ma = M.verts[(i + off) % n],
        mb = M.verts[(i + 1 + off) % n];
      const gm = (ef.get(edgeKey(ma, mb)) ?? []).map(([g]) => g).find((g) => g !== fm);
      if (gm === undefined) return null;
      // corner of the shared edge in both neighbours fixes the neighbour's offset
      const G = m.faces[gr],
        GM = m.faces[gm];
      if (G.verts.length !== GM.verts.length) return null;
      const jr = G.verts.indexOf(b),
        jm = GM.verts.indexOf(mb);
      if (jr < 0 || jm < 0 || G.verts[(jr + 1) % G.verts.length] !== a || GM.verts[(jm + 1) % GM.verts.length] !== ma) return null;
      const noff = (jm - jr + GM.verts.length) % GM.verts.length;
      const prev = faceMap.get(gr);
      if (prev) {
        if (prev[0] !== gm || prev[1] !== noff) return null;
        continue;
      }
      if (used.has(gm)) return null;
      used.add(gm);
      faceMap.set(gr, [gm, noff]);
      queue.push(gr);
    }
  }
  if (faceMap.size !== region.length) return null;
  return [...faceMap.values()].map(([fm]) => fm);
}

export function similarRegions(m: MeshEdit): number[] {
  const fsel = m.selectedFaces();
  if (!fsel.length) return [];
  const ef = m.edgeFaces();
  const out = new Set<number>(fsel);
  const regions: number[][] = [];
  {
    const set = new Set(fsel);
    const seen = new Set<number>();
    for (const s0 of fsel) {
      if (seen.has(s0)) continue;
      const comp: number[] = [];
      const st = [s0];
      seen.add(s0);
      while (st.length) {
        const f = st.pop()!;
        comp.push(f);
        for (const k of faceEdgeKeys(m.faces[f])) for (const [g] of ef.get(k) ?? []) if (set.has(g) && !seen.has(g)) (seen.add(g), st.push(g));
      }
      regions.push(comp);
    }
  }
  for (const region of regions) {
    const r0 = region[0];
    const n = m.faces[r0].verts.length;
    for (let fm = 0; fm < m.faces.length; fm++) {
      if (m.faces[fm].verts.length !== n || out.has(fm)) continue;
      for (let off = 0; off < n; off++) {
        const hit = matchRegion(m, region, ef, r0, fm, off);
        if (hit && !hit.some((f) => out.has(f) && !region.includes(f))) {
          hit.forEach((f) => out.add(f));
          break;
        }
      }
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// shortest path

/** Vertex path between two vertices (Dijkstra over edge lengths, or hop count). */
export function vertexPath(m: MeshEdit, from: number, to: number, topology = false): number[] {
  const nb = m.neighbors();
  const n = m.vcount;
  const dist = new Float64Array(n).fill(Infinity),
    prev = new Int32Array(n).fill(-1);
  dist[from] = 0;
  // binary heap of [dist, vertex]
  const heap: [number, number][] = [[0, from]];
  const pop = () => {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
    return heap.splice(bi, 1)[0];
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (u === to) break;
    for (const w of nb[u]) {
      if (m.hide[w]) continue;
      const nd = d + (topology ? 1 : V(m.p(u)).distanceTo(V(m.p(w))));
      if (nd < dist[w]) {
        dist[w] = nd;
        prev[w] = u;
        heap.push([nd, w]);
      }
    }
  }
  if (!Number.isFinite(dist[to])) return [];
  const path: number[] = [];
  for (let v = to; v >= 0; v = prev[v]) {
    path.push(v);
    if (v === from) break;
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------
// next / previous active

function nextVertex(m: MeshEdit, prev: number, cur: number): number {
  const nb = m.neighbors();
  const dir = V(m.p(cur)).sub(V(m.p(prev))).normalize();
  let best = -1,
    bd = -Infinity;
  for (const w of nb[cur]) {
    if (w === prev || m.sel[w] || m.hide[w]) continue;
    const d = V(m.p(w)).sub(V(m.p(cur))).normalize().dot(dir);
    if (d > bd) {
      bd = d;
      best = w;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------

const extendProp = { id: 'extend', label: 'Extend', type: 'bool' as const, default: false };
const CMP: [string, string][] = [['EQUAL', 'Equal'], ['GREATER', 'Greater'], ['LESS', 'Less']];

registerOperators([
  {
    idname: 'mesh.select_similar_region',
    label: 'Select Similar Regions',
    description: 'Select other face regions with the same topology as the selected ones',
    poll: (ctx) => editPoll(ctx) && selectMode() === 'FACE',
    exec: () => {
      let any = false;
      for (const { me } of editMeshObjects()) {
        ensureSelection(me);
        const m = MeshEdit.from(me);
        const faces = similarRegions(m);
        if (faces.length <= m.selectedFaces().length) continue;
        selectFaceSet(me, new Set(faces));
        any = true;
      }
      if (!any) {
        app.report('WARNING', 'No matching face regions found');
        return 'CANCELLED';
      }
      app.changed('select');
    },
  },
  {
    idname: 'mesh.select_interior_faces',
    label: 'Select Interior Faces',
    description: 'Select faces whose every edge is shared by more than two faces',
    poll: editPoll,
    exec: () =>
      eachSel((_me, m, sel) => {
        const ef = m.edgeFaces();
        m.faces.forEach((f, fi) => {
          if (faceEdgeKeys(f).every((k) => (ef.get(k)?.length ?? 0) > 2)) selectFace(m, fi, sel);
        });
      }),
  },
  {
    idname: 'mesh.select_by_pole_count',
    label: 'Select By Pole Count',
    description: 'Select vertices by how many edges meet at them',
    props: [
      { id: 'pole_count', label: 'Pole Count', type: 'int', default: 4, min: 0 },
      { id: 'type', label: 'Type', type: 'enum', default: 'NOTEQUAL', items: [['LESS', 'Less Than'], ['EQUAL', 'Equal To'], ['GREATER', 'Greater Than'], ['NOTEQUAL', 'Not Equal To']] },
      extendProp,
      { id: 'exclude_nonmanifold', label: 'Exclude Non Manifold', type: 'bool', default: true },
    ],
    poll: editPoll,
    exec: (_ctx, p) =>
      eachSel((_me, m, sel) => {
        const nb = m.neighbors();
        const N = p.pole_count as number;
        const nonManifold = new Set<number>();
        if (p.exclude_nonmanifold) for (const [k, l] of m.edgeFaces()) if (l.length !== 2) k.split(':').forEach((x) => nonManifold.add(Number(x)));
        for (let v = 0; v < m.vcount; v++) {
          if (nonManifold.has(v) || !nb[v].length) continue;
          const c = nb[v].length;
          const ok = p.type === 'LESS' ? c < N : p.type === 'GREATER' ? c > N : p.type === 'EQUAL' ? c === N : c !== N;
          if (ok) sel[v] = 1;
        }
      }, !!p.extend),
  },
  {
    idname: 'mesh.select_ungrouped',
    label: 'Select Ungrouped',
    description: 'Select vertices that belong to no vertex group',
    props: [extendProp],
    poll: editPoll,
    exec: (_ctx, p) =>
      eachSel((_me, m, sel) => {
        for (let v = 0; v < m.vcount; v++) if (!m.weights.some((w) => (w[v] ?? 0) > 0)) sel[v] = 1;
      }, !!p.extend),
  },
  {
    idname: 'mesh.region_to_loop',
    label: 'Select Boundary Loop',
    description: 'Select the outline of the selected faces',
    poll: editPoll,
    exec: () => {
      let any = false;
      for (const { me } of editMeshObjects()) {
        ensureSelection(me);
        const m = MeshEdit.from(me);
        const out = regionToLoop(m);
        if (!out.length) continue;
        const sel = new Uint8Array(me.positions.length / 3);
        for (const v of out) sel[v] = 1;
        me.select_vert = sel;
        any = true;
      }
      if (!any) return 'CANCELLED';
      // the outline is a set of edges
      if (selectMode() === 'FACE') app.doc.scene.tool_settings.mesh_select_mode = [false, true, false];
      app.changed('select');
    },
  },
  {
    idname: 'mesh.loop_to_region',
    label: 'Select Loop Inner-Region',
    description: 'Select the faces enclosed by the selected edge loop',
    props: [{ id: 'select_bigger', label: 'Select Bigger', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      let any = false;
      for (const { me } of editMeshObjects()) {
        ensureSelection(me);
        const m = MeshEdit.from(me);
        const faces = loopToRegion(m, !!p.select_bigger);
        if (!faces.length) continue;
        const sel = new Uint8Array(me.positions.length / 3);
        for (const fi of faces) selectFace(m, fi, sel);
        me.select_vert = sel;
        any = true;
      }
      if (!any) return 'CANCELLED';
      app.doc.scene.tool_settings.mesh_select_mode = [false, false, true];
      app.changed('select');
    },
  },
  {
    idname: 'mesh.select_edge_loop_multi',
    label: 'Multi Select Loops',
    description: 'Select the edge loops of all selected edges',
    poll: editPoll,
    exec: () => eachSel((me, m, sel) => m.selectedEdges().forEach(([a, b]) => edgeLoop(me, a, b).forEach(([x, y]) => (sel[x] = sel[y] = 1)))),
  },
  {
    idname: 'mesh.select_edge_ring_multi',
    label: 'Multi Select Rings',
    description: 'Select the edge rings of all selected edges',
    poll: editPoll,
    exec: () =>
      eachSel((me, m, sel) => {
        const edges = m.selectedEdges();
        sel.fill(0);
        edges.forEach(([a, b]) => edgeRing(me, a, b).forEach(([x, y]) => (sel[x] = sel[y] = 1)));
      }),
  },
  {
    idname: 'mesh.select_boundary_loop_multi',
    label: 'Select Boundary Loops',
    description: 'Select the whole open boundaries that pass through the selection',
    props: [extendProp],
    poll: editPoll,
    exec: (_ctx, p) =>
      eachSel((me, m, sel) => {
        const src = new Uint8Array(me.select_vert!);
        if (!p.extend) sel.fill(0);
        const boundary: [number, number][] = [];
        for (const [k, l] of m.edgeFaces()) if (l.length === 1) boundary.push(k.split(':').map(Number) as [number, number]);
        for (const chain of edgeChains(boundary)) if (chain.verts.some((v) => src[v])) for (const v of chain.verts) sel[v] = 1;
      }, true),
  },
  {
    idname: 'mesh.faces_select_linked_flat',
    label: 'Select Linked Flat Faces',
    description: 'Grow the selection over neighbouring faces that are nearly flat with it',
    props: [{ id: 'sharpness', label: 'Sharpness', type: 'float', default: (1 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'angle' }],
    poll: editPoll,
    exec: (_ctx, p) =>
      eachSel((_me, m, sel) => {
        const ef = m.edgeFaces();
        const fsel = new Set(m.selectedFaces());
        const stack = [...fsel];
        while (stack.length) {
          const fi = stack.pop()!;
          const n = V(m.faceNormal(m.faces[fi]));
          for (const k of faceEdgeKeys(m.faces[fi]))
            for (const [g] of ef.get(k) ?? []) {
              if (fsel.has(g) || m.faces[g].verts.some((v) => m.hide[v])) continue;
              if (n.angleTo(V(m.faceNormal(m.faces[g]))) > (p.sharpness as number) + 1e-6) continue;
              fsel.add(g);
              stack.push(g);
            }
        }
        for (const fi of fsel) selectFace(m, fi, sel);
      }),
  },
  {
    idname: 'mesh.edges_select_sharp',
    label: 'Select Sharp Edges',
    description: 'Select edges whose faces meet at more than the given angle',
    props: [{ id: 'sharpness', label: 'Sharpness', type: 'float', default: (30 * Math.PI) / 180, min: 0.000174533, max: Math.PI, subtype: 'angle' }],
    poll: editPoll,
    exec: (_ctx, p) =>
      eachSel((_me, m, sel) => {
        for (const [k, l] of m.edgeFaces()) {
          if (l.length !== 2) continue;
          if (V(m.faceNormal(m.faces[l[0][0]])).angleTo(V(m.faceNormal(m.faces[l[1][0]]))) > (p.sharpness as number)) k.split(':').forEach((x) => (sel[Number(x)] = 1));
        }
      }),
  },
  {
    idname: 'mesh.select_axis',
    label: 'Select Axis',
    description: 'Select the vertices on one side of the active vertex along an axis',
    props: [
      { id: 'orientation', label: 'Axis Mode', type: 'enum', default: 'LOCAL', items: [['GLOBAL', 'Global'], ['LOCAL', 'Local']] },
      { id: 'sign', label: 'Axis Sign', type: 'enum', default: 'POS', items: [['POS', 'Positive'], ['NEG', 'Negative'], ['ALIGN', 'Aligned']] },
      { id: 'axis', label: 'Axis', type: 'enum', default: 'X', items: [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']] },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.0001, min: 0.000001, max: 50, softMax: 10, subtype: 'distance' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      if (active.kind !== 'VERT') {
        app.report('WARNING', 'This operator requires an active vertex (last selected)');
        return 'CANCELLED';
      }
      const k = ['X', 'Y', 'Z'].indexOf(p.axis as string);
      const thr = p.threshold as number;
      for (const { ob, me } of editMeshObjects()) {
        if (ob.id !== active.objectId) continue;
        ensureSelection(me);
        const w = worldMatrix(ob);
        const coord = (v: number) => {
          const q = new Vector3(me.positions[v * 3], me.positions[v * 3 + 1], me.positions[v * 3 + 2]);
          return (p.orientation === 'GLOBAL' ? q.applyMatrix4(w) : q).getComponent(k);
        };
        const ref = coord(active.index);
        const sel = new Uint8Array(me.select_vert!);
        for (let v = 0; v < sel.length; v++) {
          if (me.hide_vert?.[v]) continue;
          const d = coord(v) - ref;
          if (p.sign === 'POS' ? d > thr : p.sign === 'NEG' ? d < -thr : Math.abs(d) <= thr) sel[v] = 1;
        }
        me.select_vert = sel;
      }
      app.changed('select');
    },
  },
  {
    idname: 'mesh.select_next_item',
    label: 'Select Next Element',
    description: 'Extend the selection by continuing past the last two selected vertices',
    poll: editPoll,
    exec: () => {
      const h = selectHistory.filter((e) => e.kind === 'VERT');
      if (h.length < 2 || active.kind !== 'VERT') {
        app.report('WARNING', 'Select two vertices one after the other first');
        return 'CANCELLED';
      }
      const [a, b] = h.slice(-2);
      const ob = app.doc.objects[b.objectId];
      const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
      if (!me || a.objectId !== b.objectId) return 'CANCELLED';
      const m = MeshEdit.from(me);
      const nx = nextVertex(m, a.index, b.index);
      if (nx < 0) return 'CANCELLED';
      const sel = new Uint8Array(me.select_vert!);
      sel[nx] = 1;
      me.select_vert = sel;
      active.index = nx;
      pushSelectHistory();
      app.changed('select');
    },
  },
  {
    idname: 'mesh.select_prev_item',
    label: 'Select Previous Element',
    description: 'Shrink the selection by removing the last selected vertex',
    poll: editPoll,
    exec: () => {
      const last = selectHistory[selectHistory.length - 1];
      if (!last || last.kind !== 'VERT' || selectHistory.length < 2) return 'CANCELLED';
      const ob = app.doc.objects[last.objectId];
      const me = ob?.data ? app.doc.meshes[ob.data] : undefined;
      if (!me?.select_vert) return 'CANCELLED';
      const sel = new Uint8Array(me.select_vert);
      sel[last.index] = 0;
      me.select_vert = sel;
      selectHistory.pop();
      const prev = selectHistory[selectHistory.length - 1];
      Object.assign(active, { objectId: prev.objectId, kind: prev.kind, index: prev.index, edge: [...prev.edge] });
      app.changed('select');
    },
  },
  {
    idname: 'mesh.shortest_path_select',
    label: 'Select Shortest Path',
    description: 'Select the shortest path between the last two selected vertices',
    props: [
      { id: 'use_topology_distance', label: 'Topology Distance', type: 'bool', default: false },
      { id: 'skip', label: 'Deselected', type: 'int', default: 0, min: 0 },
      { id: 'nth', label: 'Selected', type: 'int', default: 1, min: 1 },
      { id: 'offset', label: 'Offset', type: 'int', default: 0 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let done = false;
      for (const { me } of editMeshObjects()) {
        ensureSelection(me);
        const m = MeshEdit.from(me);
        // endpoints: the last two picked vertices, or the only two selected ones
        const h = selectHistory.filter((e) => e.kind === 'VERT' && editMeshObjects().some(({ ob }) => ob.id === e.objectId && ob.data && app.doc.meshes[ob.data] === me));
        let ends: number[] = h.slice(-2).map((e) => e.index);
        const selV = m.selectedVerts();
        if (ends.length < 2 || !ends.every((v) => m.sel[v])) ends = selV.length === 2 ? selV : [];
        if (ends.length !== 2) continue;
        const path = vertexPath(m, ends[0], ends[1], !!p.use_topology_distance);
        if (!path.length) continue;
        const sel = new Uint8Array(me.select_vert!);
        const skip = p.skip as number,
          nth = p.nth as number,
          off = p.offset as number;
        path.forEach((v, i) => {
          const j = (((i + off) % (skip + nth)) + skip + nth) % (skip + nth);
          sel[v] = j < nth || i === 0 || i === path.length - 1 ? 1 : 0;
        });
        me.select_vert = sel;
        done = true;
      }
      if (!done) {
        app.report('WARNING', 'Path selection requires two vertices to be selected');
        return 'CANCELLED';
      }
      app.changed('select');
    },
  },
  {
    idname: 'mesh.select_similar',
    label: 'Select Similar',
    description: 'Select elements similar to the selected ones in the chosen property',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'FACE_NORMAL',
        get items() {
          return SIMILAR_ITEMS[selectMode()];
        },
      },
      { id: 'compare', label: 'Compare', type: 'enum', default: 'EQUAL', items: CMP },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const type = (LEGACY[p.type as string] ?? p.type) as SimilarType;
      eachSel((me, m, sel) => selectSimilar(m, me, sel, type, p.compare as string, p.threshold as number));
    },
  },
]);
