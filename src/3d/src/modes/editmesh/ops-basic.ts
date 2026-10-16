// Edit-mode mesh operators: delete/dissolve, merge, split/separate, duplicate, normals,
// edge flags, shading, triangulate, smoothing, adding primitives.
import { symmetrizeMesh } from './symmetrize';
import { Matrix4, Vector3, Euler, Quaternion } from 'three';
import { app, registerOperators, type OpContext } from '../../app/app';
import { MeshEdit, edgeKey, type EFace } from './meshedit';
import { withEdit, editMeshObjects, selectMode, active } from './context';
import { startTransform } from '../../ops/transform';
import { newObject, newMeshData, uid } from '../../data/defaults';
import { uniqueName } from '../../ops/object';
import { cloneShared } from '../../data/cow';
import { trisToQuads } from './geom';
import { modeHandlers } from '../../ops/modes';
import type { PrimitiveArrays } from '../../mesh/primitives';

export const editPoll = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';

// ---------------------------------------------------------------------------
// delete / dissolve

export function deleteGeometry(m: MeshEdit, type: string) {
  const sel = m.sel;
  if (type === 'VERT') {
    m.faces = m.faces.filter((f) => !f.verts.some((v) => sel[v]));
    m.looseEdges = m.looseEdges.filter(([a, b]) => !sel[a] && !sel[b]);
    const keep = sel.map((s) => (s ? 0 : 1));
    m.keepVerts(keep);
    return;
  }
  if (type === 'EDGE' || type === 'EDGE_FACE') {
    const selEdges = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
    m.faces = m.faces.filter((f) => !f.verts.some((v, i) => selEdges.has(edgeKey(v, f.verts[(i + 1) % f.verts.length]))));
    m.looseEdges = m.looseEdges.filter(([a, b]) => !selEdges.has(edgeKey(a, b)));
    if (type === 'EDGE') {
      // remove vertices left without edges
      const used = new Uint8Array(m.vcount);
      for (const f of m.faces) for (const v of f.verts) used[v] = 1;
      for (const [a, b] of m.looseEdges) used[a] = used[b] = 1;
      m.keepVerts(Array.from(used, (u, i) => (u || !sel[i] ? 1 : 0)));
    }
    return;
  }
  if (type === 'FACE' || type === 'ONLY_FACE') {
    const selFaces = new Set(m.selectedFaces());
    const removed = m.faces.filter((_, i) => selFaces.has(i));
    m.faces = m.faces.filter((_, i) => !selFaces.has(i));
    if (type === 'FACE') {
      // drop vertices no longer used, but keep edges of removed faces that border kept faces
      const used = new Uint8Array(m.vcount);
      for (const f of m.faces) for (const v of f.verts) used[v] = 1;
      for (const [a, b] of m.looseEdges) used[a] = used[b] = 1;
      m.keepVerts(Array.from(used, (u, i) => (u || !sel[i] ? 1 : 0)));
    } else {
      // keep edges of removed faces as loose edges where no remaining face uses them
      const kept = new Set<string>();
      for (const f of m.faces) for (let i = 0; i < f.verts.length; i++) kept.add(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]));
      for (const f of removed)
        for (let i = 0; i < f.verts.length; i++) {
          const a = f.verts[i],
            b = f.verts[(i + 1) % f.verts.length];
          if (!kept.has(edgeKey(a, b))) {
            kept.add(edgeKey(a, b));
            m.looseEdges.push([a, b]);
          }
        }
    }
  }
}

/** Dissolve selected vertices: merge their surrounding faces into one. */
function dissolveVerts(m: MeshEdit) {
  const vf = m.vertexFaces();
  const selV = m.selectedVerts();
  for (const v of selV) {
    const faces = vf[v].filter((f) => m.faces[f] && m.faces[f].verts.includes(v));
    if (faces.length < 2) {
      // boundary or wire: just remove the vertex from its face
      for (const fi of faces) {
        const f = m.faces[fi];
        const i = f.verts.indexOf(v);
        if (f.verts.length > 3) removeCorner(f, i);
      }
      continue;
    }
    // walk the ring of faces around v to build the merged polygon
    const merged = mergeFacesAroundVertex(m, v, faces);
    if (!merged) continue;
    const set = new Set(faces);
    const template = m.faces[faces[0]];
    m.faces = m.faces.map((f, i) => (set.has(i) ? (null as unknown as EFace) : f)).filter(Boolean);
    m.faces.push({ ...m.makeFace(merged.verts, template, merged.uvs) });
    // recompute adjacency after each dissolve
    const nvf = m.vertexFaces();
    for (let i = 0; i < nvf.length; i++) vf[i] = nvf[i];
  }
  const used = new Uint8Array(m.vcount);
  for (const f of m.faces) for (const v of f.verts) used[v] = 1;
  for (const [a, b] of m.looseEdges) used[a] = used[b] = 1;
  m.keepVerts(Array.from(used, (u, i) => (u || !m.sel[i] ? 1 : 0)));
}

function removeCorner(f: EFace, i: number) {
  f.verts.splice(i, 1);
  f.uvs.splice(i * 2, 2);
  f.seams.splice(i, 1);
  f.sharp.splice(i, 1);
  f.creases.splice(i, 1);
  if (f.colors) f.colors.splice(i * 4, 4);
}

function mergeFacesAroundVertex(m: MeshEdit, v: number, faces: number[]): { verts: number[]; uvs: number[] } | null {
  // Each face contributes the path from v's next neighbor to v's previous neighbor (excluding v)
  const paths = faces.map((fi) => {
    const f = m.faces[fi];
    const n = f.verts.length,
      i = f.verts.indexOf(v);
    const verts: number[] = [],
      uvs: number[] = [];
    for (let k = 1; k < n; k++) {
      const j = (i + k) % n;
      verts.push(f.verts[j]);
      uvs.push(f.uvs[j * 2], f.uvs[j * 2 + 1]);
    }
    return { verts, uvs };
  });
  // chain paths: path end == next path start
  const out: number[] = [],
    ouv: number[] = [];
  const used = new Set<number>();
  let cur = 0;
  for (let step = 0; step < paths.length; step++) {
    used.add(cur);
    const p = paths[cur];
    const take = step === paths.length - 1 ? p.verts.length - 1 : p.verts.length - 1;
    for (let k = 0; k < take; k++) {
      out.push(p.verts[k]);
      ouv.push(p.uvs[k * 2], p.uvs[k * 2 + 1]);
    }
    const end = p.verts[p.verts.length - 1];
    const next = paths.findIndex((q, qi) => !used.has(qi) && q.verts[0] === end);
    if (next < 0) {
      if (step !== paths.length - 1) return null;
      break;
    }
    cur = next;
  }
  if (new Set(out).size !== out.length || out.length < 3) return null;
  return { verts: out, uvs: ouv };
}

/** Dissolve selected edges: merge the two faces on each edge. */
function dissolveEdges(m: MeshEdit, useVerts: boolean) {
  let changed = true;
  const selEdges = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  while (changed) {
    changed = false;
    const ef = m.edgeFaces();
    for (const k of selEdges) {
      const l = ef.get(k);
      if (!l || l.length !== 2 || l[0][0] === l[1][0]) continue;
      const [fa, ia] = l[0],
        [fb] = l[1];
      const A = m.faces[fa],
        B = m.faces[fb];
      const a = A.verts[ia],
        b = A.verts[(ia + 1) % A.verts.length];
      // A: ... a b ... ; B contains b a
      const na = A.verts.length,
        nb = B.verts.length;
      const jb = B.verts.indexOf(b);
      if (B.verts[(jb + 1) % nb] !== a) continue;
      const verts: number[] = [],
        uvs: number[] = [];
      for (let k2 = 0; k2 < na; k2++) {
        const j = (ia + 1 + k2) % na; // start at b, go around to a
        verts.push(A.verts[j]);
        uvs.push(A.uvs[j * 2], A.uvs[j * 2 + 1]);
      }
      // B from after a back to before b
      for (let k2 = 2; k2 < nb; k2++) {
        const j = (jb + k2) % nb;
        verts.push(B.verts[j]);
        uvs.push(B.uvs[j * 2], B.uvs[j * 2 + 1]);
      }
      if (new Set(verts).size !== verts.length) continue;
      const nf = m.makeFace(verts, A, uvs);
      m.faces = m.faces.filter((_, i) => i !== fa && i !== fb);
      m.faces.push(nf);
      selEdges.delete(k);
      changed = true;
      break;
    }
  }
  if (useVerts) {
    // remove 2-valence vertices left in the middle of straight runs
    const vf = m.vertexFaces();
    const nb = m.neighbors();
    for (let v = 0; v < m.vcount; v++) {
      if (!m.sel[v] || nb[v].length !== 2) continue;
      for (const fi of vf[v]) {
        const f = m.faces[fi];
        const i = f.verts.indexOf(v);
        if (i >= 0 && f.verts.length > 3) removeCorner(f, i);
      }
    }
  }
  m.compact();
}

function dissolveFaces(m: MeshEdit) {
  // dissolve all interior edges of the selected face regions
  const fsel = new Set(m.selectedFaces());
  const ef = m.edgeFaces();
  const interior: [number, number][] = [];
  for (const [k, l] of ef) if (l.length === 2 && fsel.has(l[0][0]) && fsel.has(l[1][0])) interior.push(k.split(':').map(Number) as [number, number]);
  const saved = m.sel.slice();
  m.sel.fill(0);
  for (const [a, b] of interior) m.sel[a] = m.sel[b] = 1;
  dissolveEdges(m, true);
  void saved;
}

// ---------------------------------------------------------------------------
// merge

export function mergeVerts(m: MeshEdit, groups: number[][], positions: Vector3[]) {
  const map = Array.from({ length: m.vcount }, (_, i) => i);
  groups.forEach((g, gi) => {
    const target = g[0];
    m.setP(target, [positions[gi].x, positions[gi].y, positions[gi].z]);
    for (const v of g) map[v] = target;
  });
  m.remap(map);
}

/**
 * Merge vertices closer than `threshold`. Vertices are visited in order of x+y+z; each one that is
 * not merged yet collects the later vertices within reach (clusters do not chain). With
 * `centroid` the kept vertex moves to the middle of its cluster. When `onlySelected` is false,
 * selected vertices may also merge into unselected ones (which stay in place).
 */
export function removeDoubles(m: MeshEdit, threshold: number, onlySelected = true, centroid = true): number {
  const n = m.vcount;
  const cand: number[] = [];
  for (let v = 0; v < n; v++) if (!m.hide[v] && (m.sel[v] || !onlySelected)) cand.push(v);
  const key = (v: number) => m.pos[v * 3] + m.pos[v * 3 + 1] + m.pos[v * 3 + 2];
  // unselected vertices act as fixed targets only (they come first among equals)
  cand.sort((a, b) => key(a) - key(b) || (m.sel[a] ? 1 : 0) - (m.sel[b] ? 1 : 0) || a - b);
  const map = Array.from({ length: n }, (_, i) => i);
  const t2 = threshold * threshold;
  const reach = threshold * 3 + 1e-12;
  const clusters = new Map<number, number[]>();
  const done = new Uint8Array(n);
  let merged = 0;
  for (let i = 0; i < cand.length; i++) {
    const v = cand[i];
    if (done[v]) continue;
    done[v] = 1;
    const kv = key(v);
    for (let j = i + 1; j < cand.length; j++) {
      const u = cand[j];
      if (key(u) - kv > reach) break;
      if (done[u] || !m.sel[u]) continue;
      // two unselected vertices never merge with each other
      if (!m.sel[v] && !m.sel[u]) continue;
      const dx = m.pos[u * 3] - m.pos[v * 3],
        dy = m.pos[u * 3 + 1] - m.pos[v * 3 + 1],
        dz = m.pos[u * 3 + 2] - m.pos[v * 3 + 2];
      if (dx * dx + dy * dy + dz * dz > t2) continue;
      done[u] = 1;
      map[u] = v;
      merged++;
      (clusters.get(v) ?? clusters.set(v, [v]).get(v)!).push(u);
    }
  }
  if (!merged) return 0;
  if (centroid)
    for (const [v, list] of clusters) {
      if (!m.sel[v]) continue;
      const c = [0, 0, 0];
      for (const u of list) for (let k = 0; k < 3; k++) c[k] += m.pos[u * 3 + k] / list.length;
      m.setP(v, c);
    }
  m.remap(map);
  return merged;
}

// ---------------------------------------------------------------------------
// normals

export function makeNormalsConsistent(m: MeshEdit, inside = false, onlySelected = true) {
  const faces = onlySelected ? m.selectedFaces() : m.faces.map((_, i) => i);
  if (!faces.length) return;
  const fset = new Set(faces);
  const ef = m.edgeFaces();
  const visited = new Set<number>();
  for (const seed of faces) {
    if (visited.has(seed)) continue;
    // BFS component, orienting neighbors consistently with the seed
    const comp: number[] = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length) {
      const fi = queue.shift()!;
      comp.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        const a = f.verts[i],
          b = f.verts[(i + 1) % f.verts.length];
        for (const [g] of ef.get(edgeKey(a, b)) ?? []) {
          if (g === fi || visited.has(g) || !fset.has(g)) continue;
          const G = m.faces[g];
          const j = G.verts.indexOf(a);
          // consistent if neighbor traverses the edge as b→a
          if (G.verts[(j + 1) % G.verts.length] === b) flipFace(G);
          visited.add(g);
          queue.push(g);
        }
      }
    }
    // decide outward via signed volume relative to component centroid
    let vol = 0;
    const c = new Vector3();
    let cnt = 0;
    for (const fi of comp)
      for (const v of m.faces[fi].verts) {
        c.add(new Vector3(...m.p(v)));
        cnt++;
      }
    c.multiplyScalar(1 / Math.max(1, cnt));
    for (const fi of comp) {
      const f = m.faces[fi];
      for (let i = 1; i < f.verts.length - 1; i++) {
        const p0 = new Vector3(...m.p(f.verts[0])).sub(c),
          p1 = new Vector3(...m.p(f.verts[i])).sub(c),
          p2 = new Vector3(...m.p(f.verts[i + 1])).sub(c);
        vol += p0.dot(p1.clone().cross(p2));
      }
    }
    if ((vol < 0) !== inside) for (const fi of comp) flipFace(m.faces[fi]);
  }
}

export function flipFace(f: EFace) {
  const n = f.verts.length;
  const order = Array.from({ length: n }, (_, i) => (n - i) % n);
  const perEdge = (arr: number[]) => order.map((i) => arr[(i - 1 + n) % n]);
  f.seams = perEdge(f.seams);
  f.sharp = perEdge(f.sharp);
  f.creases = perEdge(f.creases);
  f.verts = order.map((i) => f.verts[i]);
  f.uvs = order.flatMap((i) => [f.uvs[i * 2], f.uvs[i * 2 + 1]]);
  if (f.colors) f.colors = order.flatMap((i) => f.colors!.slice(i * 4, i * 4 + 4));
  // custom normals follow their corners and turn around with the face
  if (f.cnormals) f.cnormals = order.length * 3 === f.cnormals.length ? order.flatMap((i) => f.cnormals!.slice(i * 3, i * 3 + 3).map((x) => -x)) : undefined;
}

function setEdgeFlag(m: MeshEdit, key: 'seams' | 'sharp' | 'creases', value: number) {
  const sel = new Set(m.selectedEdges().map(([a, b]) => edgeKey(a, b)));
  for (const f of m.faces)
    for (let i = 0; i < f.verts.length; i++) if (sel.has(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]))) f[key][i] = value;
}

/** Move selected vertices towards the average of their neighbours. */
export function smoothVertices(m: MeshEdit, factor: number, repeat: number, axes: boolean[] = [true, true, true]) {
  const nb = m.neighbors();
  for (let it = 0; it < repeat; it++) {
    const next = m.pos.slice();
    for (let v = 0; v < m.vcount; v++) {
      if (!m.sel[v] || m.hide[v] || !nb[v].length) continue;
      const c = [0, 0, 0];
      for (const w of nb[v]) for (let k = 0; k < 3; k++) c[k] += m.pos[w * 3 + k] / nb[v].length;
      for (let k = 0; k < 3; k++) if (axes[k]) next[v * 3 + k] = m.pos[v * 3 + k] + (c[k] - m.pos[v * 3 + k]) * factor;
    }
    m.pos = next;
  }
  if (m.keys.length) m.keys[0] = m.pos.slice();
  return m.selectedVerts().length > 0;
}

// ---------------------------------------------------------------------------
// duplicate / split / separate

export function duplicateSelection(m: MeshEdit): void {
  const selV = m.selectedVerts();
  if (!selV.length) return;
  const map = new Map<number, number>();
  for (const v of selV) map.set(v, m.addVert(m.p(v), [[v, 1]], 1));
  const fsel = m.selectedFaces();
  const newFaces = fsel.map((fi) => {
    const f = m.faces[fi];
    return { ...f, verts: f.verts.map((v) => map.get(v)!), uvs: [...f.uvs], seams: [...f.seams], sharp: [...f.sharp], creases: [...f.creases], colors: f.colors ? [...f.colors] : undefined };
  });
  // selected edges not belonging to selected faces become loose edges
  const faceEdges = new Set<string>();
  for (const fi of fsel) {
    const f = m.faces[fi];
    for (let i = 0; i < f.verts.length; i++) faceEdges.add(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length]));
  }
  const newLoose: [number, number][] = [];
  for (const [a, b] of m.selectedEdges()) if (!faceEdges.has(edgeKey(a, b))) newLoose.push([map.get(a)!, map.get(b)!]);
  for (const v of selV) m.sel[v] = 0;
  m.faces.push(...newFaces);
  m.looseEdges.push(...newLoose);
}

function splitSelection(m: MeshEdit) {
  // detach selected faces: give them their own copies of vertices shared with unselected faces
  const fsel = new Set(m.selectedFaces());
  if (!fsel.size) return;
  const vf = m.vertexFaces();
  const map = new Map<number, number>();
  for (const fi of fsel) {
    const f = m.faces[fi];
    f.verts = f.verts.map((v) => {
      if (!vf[v].some((g) => !fsel.has(g))) return v;
      let nv = map.get(v);
      if (nv === undefined) {
        nv = m.addVert(m.p(v), [[v, 1]], 1);
        map.set(v, nv);
      }
      return nv;
    });
  }
  for (const v of map.keys()) m.sel[v] = 0;
}

function separate(type: 'SELECTED' | 'MATERIAL' | 'LOOSE') {
  const doc = app.doc;
  let created = 0;
  for (const { ob, me } of editMeshObjects()) {
    const m = MeshEdit.from(me);
    const groups: Set<number>[] = [];
    if (type === 'SELECTED') {
      const s = new Set(m.selectedFaces());
      if (!s.size && !m.selectedVerts().length) continue;
      groups.push(s);
    } else if (type === 'MATERIAL') {
      const byMat = new Map<number, Set<number>>();
      m.faces.forEach((f, i) => (byMat.get(f.material) ?? byMat.set(f.material, new Set()).get(f.material)!).add(i));
      const mats = [...byMat.keys()].sort((a, b) => a - b);
      for (const k of mats.slice(1)) groups.push(byMat.get(k)!);
    } else {
      // loose parts: connected components over faces
      const ef = m.edgeFaces();
      const comp = new Int32Array(m.faces.length).fill(-1);
      let nc = 0;
      for (let s = 0; s < m.faces.length; s++) {
        if (comp[s] >= 0) continue;
        const stack = [s];
        comp[s] = nc;
        while (stack.length) {
          const fi = stack.pop()!;
          const f = m.faces[fi];
          for (const v of f.verts) void v;
          for (let i = 0; i < f.verts.length; i++)
            for (const [g] of ef.get(edgeKey(f.verts[i], f.verts[(i + 1) % f.verts.length])) ?? [])
              if (comp[g] < 0) {
                comp[g] = nc;
                stack.push(g);
              }
          // also connect through shared vertices
        }
        nc++;
      }
      for (let c = 1; c < nc; c++) groups.push(new Set(Array.from(comp).map((x, i) => (x === c ? i : -1)).filter((i) => i >= 0)));
    }
    for (const g of groups) {
      const part = MeshEdit.from(me);
      const cur = MeshEdit.from(me);
      // part keeps only group faces; current loses them
      part.faces = part.faces.filter((_, i) => g.has(i));
      part.looseEdges = type === 'SELECTED' ? part.looseEdges.filter(([a, b]) => part.sel[a] && part.sel[b]) : [];
      part.compact();
      cur.faces = cur.faces.filter((_, i) => !g.has(i));
      if (type === 'SELECTED') {
        cur.looseEdges = cur.looseEdges.filter(([a, b]) => !(cur.sel[a] && cur.sel[b]));
        // remove selected verts not used by remaining faces
        const used = new Uint8Array(cur.vcount);
        for (const f of cur.faces) for (const v of f.verts) used[v] = 1;
        for (const [a, b] of cur.looseEdges) used[a] = used[b] = 1;
        cur.keepVerts(Array.from(used, (u, i) => (u || !cur.sel[i] ? 1 : 0)));
      } else cur.compact();
      cur.write(me);
      const nme = newMeshData(uniqueName(doc, me.name, 'meshes'), { positions: new Float32Array(0), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) });
      nme.vertex_groups = cloneShared(me.vertex_groups);
      nme.shape_keys = me.shape_keys.map((k) => ({ ...k }));
      nme.color_attributes = me.color_attributes.map((c) => ({ ...c }));
      nme.materials = [...me.materials];
      part.sel.fill(0);
      part.write(nme);
      doc.meshes[nme.id] = nme;
      const nob = cloneShared(ob);
      nob.id = uid('ob');
      nob.name = uniqueName(doc, ob.name);
      nob.data = nme.id;
      nob.select = false;
      nob.modifiers = nob.modifiers.map((md) => ({ ...md, id: uid('md') }));
      doc.objects[nob.id] = nob;
      doc.object_order.push(nob.id);
      for (const c of Object.values(doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(nob.id);
      created++;
      me.select_vert = new Uint8Array(me.positions.length / 3);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// add primitives in edit mode

modeHandlers.EDIT = {
  ...(modeHandlers.EDIT ?? {}),
  enter(ob) {
    if (ob.type === 'MESH' && ob.data) {
      const me = app.doc.meshes[ob.data];
      if (!me.select_vert || me.select_vert.length !== me.positions.length / 3) me.select_vert = new Uint8Array(me.positions.length / 3);
      active.kind = '';
      return true;
    }
    return ['CURVE', 'FONT', 'ARMATURE', 'LATTICE'].includes(ob.type);
  },
  exit() {
    active.kind = '';
  },
  addPrimitive(arrays: PrimitiveArrays, props: Record<string, unknown>) {
    const ob = app.activeObject;
    if (!ob || ob.type !== 'MESH' || !ob.data) return 'CANCELLED';
    const me = app.doc.meshes[ob.data];
    const world = app.graph.get(ob.id)?.world ?? new Matrix4();
    const loc = new Vector3(...((props.location as number[]) ?? app.doc.scene.cursor.location));
    const rot = (props.rotation as number[]) ?? [0, 0, 0];
    const m4 = world.clone().invert().multiply(new Matrix4().compose(loc, new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], 'ZYX')), new Vector3(...((props.scale as number[] | null) ?? [1, 1, 1]))));
    const m = MeshEdit.from(me);
    m.sel.fill(0);
    const base = m.vcount;
    const v = new Vector3();
    for (let i = 0; i < arrays.positions.length; i += 3) {
      v.set(arrays.positions[i], arrays.positions[i + 1], arrays.positions[i + 2]).applyMatrix4(m4);
      m.addVert([v.x, v.y, v.z], [], 1);
    }
    for (let f = 0; f < arrays.offsets.length - 1; f++) {
      const s = arrays.offsets[f],
        e = arrays.offsets[f + 1];
      const verts = Array.from(arrays.indices.subarray(s, e), (x) => x + base);
      m.faces.push(m.makeFace(verts, undefined, Array.from(arrays.uvs.subarray(s * 2, e * 2))));
    }
    m.write(me);
    if (props.location === null || props.location === undefined) props.location = [loc.x, loc.y, loc.z];
    app.changed('geometry');
    return 'FINISHED';
  },
};

// ---------------------------------------------------------------------------

registerOperators([
  {
    idname: 'mesh.delete',
    label: 'Delete',
    description: 'Delete selected vertices, edges or faces',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'VERT', items: [['VERT', 'Vertices'], ['EDGE', 'Edges'], ['FACE', 'Faces'], ['EDGE_FACE', 'Only Edges & Faces'], ['ONLY_FACE', 'Only Faces']] }],
    poll: editPoll,
    exec: (_ctx, p) => {
      if (!withEdit((m) => deleteGeometry(m, p.type as string))) return 'CANCELLED';
      active.kind = '';
    },
  },
  {
    idname: 'mesh.dissolve_verts',
    label: 'Dissolve Vertices',
    poll: editPoll,
    exec: () => void withEdit((m) => dissolveVerts(m)),
  },
  {
    idname: 'mesh.dissolve_edges',
    label: 'Dissolve Edges',
    props: [{ id: 'use_verts', label: 'Dissolve Vertices', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => dissolveEdges(m, !!p.use_verts)),
  },
  {
    idname: 'mesh.dissolve_faces',
    label: 'Dissolve Faces',
    poll: editPoll,
    exec: () => void withEdit((m) => dissolveFaces(m)),
  },
  {
    idname: 'mesh.dissolve_mode',
    label: 'Dissolve Selection',
    poll: editPoll,
    exec: () => {
      const mode = selectMode();
      void withEdit((m) => (mode === 'VERT' ? dissolveVerts(m) : mode === 'EDGE' ? dissolveEdges(m, true) : dissolveFaces(m)));
    },
  },
  {
    idname: 'mesh.delete_loose',
    label: 'Delete Loose',
    description: 'Delete selected vertices, edges and faces that are not connected to anything else',
    props: [
      { id: 'use_verts', label: 'Vertices', type: 'bool', default: true },
      { id: 'use_edges', label: 'Edges', type: 'bool', default: true },
      { id: 'use_faces', label: 'Faces', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let removed = 0;
      withEdit((m) => {
        const before = m.vcount;
        if (p.use_faces) {
          // faces that share no edge with another face
          const ef = m.edgeFaces();
          const fsel = new Set(m.selectedFaces());
          m.faces = m.faces.filter((f, i) => !fsel.has(i) || f.verts.some((v, k) => (ef.get(edgeKey(v, f.verts[(k + 1) % f.verts.length]))?.length ?? 0) > 1));
        }
        if (p.use_edges) m.looseEdges = m.looseEdges.filter(([a, b]) => !(m.sel[a] && m.sel[b]));
        if (p.use_verts) {
          const used = new Uint8Array(m.vcount);
          for (const f of m.faces) for (const v of f.verts) used[v] = 1;
          for (const [a, b] of m.looseEdges) used[a] = used[b] = 1;
          m.keepVerts(Array.from(used, (u, i) => (u || !m.sel[i] ? 1 : 0)));
        }
        removed += before - m.vcount;
      });
      app.report('INFO', `Removed: ${removed} vertices`);
    },
  },
  {
    idname: 'mesh.merge',
    label: 'Merge',
    description: 'Merge selected vertices',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CENTER', items: [['CENTER', 'At Center'], ['CURSOR', 'At Cursor'], ['COLLAPSE', 'Collapse'], ['FIRST', 'At First'], ['LAST', 'At Last']] }, { id: 'uvs', label: 'UVs', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      let n = 0;
      withEdit((m, ob) => {
        const sel = m.selectedVerts();
        if (sel.length < 2) return false;
        const world = app.graph.get(ob.id)?.world ?? new Matrix4();
        let groups: number[][];
        if (p.type === 'COLLAPSE') {
          // merge each connected selected island
          const nb = m.neighbors();
          const seen = new Set<number>();
          groups = [];
          for (const v of sel) {
            if (seen.has(v)) continue;
            const g: number[] = [];
            const st = [v];
            seen.add(v);
            while (st.length) {
              const u = st.pop()!;
              g.push(u);
              for (const w of nb[u])
                if (m.sel[w] && !seen.has(w)) {
                  seen.add(w);
                  st.push(w);
                }
            }
            groups.push(g);
          }
        } else groups = [sel];
        const positions = groups.map((g) => {
          if (p.type === 'CURSOR') return new Vector3(...app.doc.scene.cursor.location).applyMatrix4(world.clone().invert());
          if (p.type === 'FIRST') return new Vector3(...m.p(g[0]));
          if (p.type === 'LAST') return new Vector3(...m.p(g[g.length - 1]));
          const c = new Vector3();
          for (const v of g) c.add(new Vector3(...m.p(v)));
          return c.multiplyScalar(1 / g.length);
        });
        n += sel.length - groups.length;
        mergeVerts(m, groups, positions);
      });
      app.report('INFO', `Removed ${n} vertice(s)`);
    },
  },
  {
    idname: 'mesh.remove_doubles',
    label: 'Merge by Distance',
    props: [
      { id: 'threshold', label: 'Merge Distance', type: 'float', default: 0.0001, min: 0, subtype: 'distance' },
      { id: 'use_centroid', label: 'Centroid Merge', type: 'bool', default: true },
      { id: 'use_unselected', label: 'Unselected', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      let n = 0;
      withEdit((m) => {
        n += removeDoubles(m, p.threshold as number, !p.use_unselected, p.use_centroid !== false);
      });
      app.report('INFO', `Removed ${n} vertice(s)`);
    },
  },
  {
    idname: 'mesh.split',
    label: 'Split',
    description: 'Split off selected geometry from connected unselected geometry',
    poll: editPoll,
    exec: () => void withEdit((m) => splitSelection(m)),
  },
  {
    idname: 'mesh.separate',
    label: 'Separate',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'SELECTED', items: [['SELECTED', 'Selection'], ['MATERIAL', 'By Material'], ['LOOSE', 'By Loose Parts']] }],
    poll: editPoll,
    exec: (_ctx, p) => {
      const n = separate(p.type as 'SELECTED');
      if (!n) {
        app.report('WARNING', 'Nothing selected');
        return 'CANCELLED';
      }
      app.changed('doc');
    },
  },
  {
    idname: 'mesh.duplicate_move',
    label: 'Duplicate',
    description: 'Duplicate the selection and move the copy',
    props: [{ id: 'value', label: 'Move', type: 'vec3', default: [0, 0, 0], subtype: 'distance' }],
    poll: editPoll,
    invoke: (ctx) => {
      if (!withEdit((m) => (m.selectedVerts().length ? void duplicateSelection(m) : false))) return 'CANCELLED';
      app.flush();
      if (!startTransform('TRANSLATION', { event: ctx.event, label: 'Duplicate', redo: (v) => ({ idname: 'mesh.duplicate_move', props: { value: v } }) })) return 'FINISHED';
      return 'RUNNING_MODAL';
    },
    exec: (_ctx, p) =>
      withEdit((m, ob) => {
        if (!m.selectedVerts().length) return false;
        duplicateSelection(m);
        const d = new Vector3(...((p.value as number[]) ?? [0, 0, 0]));
        const inv = (app.graph.get(ob.id)?.world ?? new Matrix4()).clone().invert().setPosition(0, 0, 0);
        d.applyMatrix4(inv);
        for (const v of m.selectedVerts()) m.setP(v, [m.pos[v * 3] + d.x, m.pos[v * 3 + 1] + d.y, m.pos[v * 3 + 2] + d.z]);
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
  {
    idname: 'mesh.flip_normals',
    label: 'Flip',
    description: 'Flip the direction of selected faces’ normals',
    props: [{ id: 'only_clnors', label: 'Custom Normals Only', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) =>
        m.selectedFaces().forEach((fi) => {
          const f = m.faces[fi];
          if (!p.only_clnors) flipFace(f);
          else if (f.cnormals) f.cnormals = f.cnormals.map((x) => -x);
        }),
      ),
  },
  {
    idname: 'mesh.normals_make_consistent',
    label: 'Recalculate Normals',
    props: [{ id: 'inside', label: 'Inside', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => makeNormalsConsistent(m, !!p.inside)),
  },
  {
    idname: 'mesh.mark_seam',
    label: 'Mark Seam',
    props: [{ id: 'clear', label: 'Clear', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => setEdgeFlag(m, 'seams', p.clear ? 0 : 1)),
  },
  {
    idname: 'transform.edge_crease',
    label: 'Edge Crease',
    props: [{ id: 'value', label: 'Factor', type: 'float', default: 1, min: -1, max: 1, subtype: 'factor' }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => setEdgeFlag(m, 'creases', Math.max(0, Math.min(1, p.value as number)))),
  },
  {
    idname: 'mesh.faces_shade_smooth',
    label: 'Shade Smooth',
    poll: editPoll,
    exec: () => void withEdit((m) => m.selectedFaces().forEach((fi) => (m.faces[fi].smooth = true))),
  },
  {
    idname: 'mesh.faces_shade_flat',
    label: 'Shade Flat',
    poll: editPoll,
    exec: () => void withEdit((m) => m.selectedFaces().forEach((fi) => (m.faces[fi].smooth = false))),
  },
  {
    idname: 'mesh.tris_convert_to_quads',
    label: 'Tris to Quads',
    props: [
      { id: 'face_threshold', label: 'Max Face Angle', type: 'float', default: (40 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'angle' },
      { id: 'shape_threshold', label: 'Max Shape Angle', type: 'float', default: (40 * Math.PI) / 180, min: 0, max: Math.PI, subtype: 'angle' },
      { id: 'uvs', label: 'Compare UVs', type: 'bool', default: false },
      { id: 'seam', label: 'Compare Seam', type: 'bool', default: false },
      { id: 'sharp', label: 'Compare Sharp', type: 'bool', default: false },
      { id: 'materials', label: 'Compare Materials', type: 'bool', default: false },
      { id: 'deselect_joined', label: 'Deselect Joined', type: 'bool', default: false },
    ],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const n = trisToQuads(m, new Set(m.selectedFaces()), p.face_threshold as number, { shapeThreshold: p.shape_threshold as number, compareUVs: !!p.uvs, compareSeam: !!p.seam, compareSharp: !!p.sharp, compareMaterials: !!p.materials });
        if (p.deselect_joined && n) {
          // the new quads are at the end: keep only the triangles that could not be joined selected
          const keep = new Set<number>();
          for (let i = 0; i < m.faces.length - n; i++) if (m.faces[i].verts.length === 3 && m.isFaceSelected(m.faces[i])) m.faces[i].verts.forEach((v) => keep.add(v));
          for (let i = m.faces.length - n; i < m.faces.length; i++) for (const v of m.faces[i].verts) if (!keep.has(v)) m.sel[v] = 0;
        }
      }),
  },
  {
    idname: 'mesh.vertices_smooth',
    label: 'Smooth Vertices',
    props: [{ id: 'factor', label: 'Smoothing', type: 'float', default: 0.5, min: -10, max: 10, subtype: 'factor' }, { id: 'repeat', label: 'Repeat', type: 'int', default: 1, min: 1, max: 1000 }, { id: 'xaxis', label: 'X', type: 'bool', default: true }, { id: 'yaxis', label: 'Y', type: 'bool', default: true }, { id: 'zaxis', label: 'Z', type: 'bool', default: true }],
    poll: editPoll,
    exec: (_ctx, p) => void withEdit((m) => smoothVertices(m, p.factor as number, p.repeat as number, [!!p.xaxis, !!p.yaxis, !!p.zaxis])),
  },
  {
    idname: 'mesh.symmetrize',
    label: 'Symmetrize',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'NEGATIVE_X', items: [['NEGATIVE_X', '-X to +X'], ['POSITIVE_X', '+X to -X'], ['NEGATIVE_Y', '-Y to +Y'], ['POSITIVE_Y', '+Y to -Y'], ['NEGATIVE_Z', '-Z to +Z'], ['POSITIVE_Z', '+Z to -Z']] }, { id: 'threshold', label: 'Threshold', type: 'float', default: 0.0001, min: 0, subtype: 'distance' }],
    poll: editPoll,
    exec: (_ctx, p) =>
      withEdit((m) => {
        const d = p.direction as string;
        return symmetrizeMesh(m, d.endsWith('X') ? 0 : d.endsWith('Y') ? 1 : 2, d.startsWith('NEGATIVE'), p.threshold as number);
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
  {
    idname: 'mesh.edge_rotate',
    label: 'Rotate Edge',
    props: [{ id: 'use_ccw', label: 'Counter Clockwise', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) =>
      void withEdit((m) => {
        const ef = m.edgeFaces();
        for (const [a, b] of m.selectedEdges()) {
          const l = ef.get(edgeKey(a, b));
          if (!l || l.length !== 2) continue;
          const [fa] = l[0],
            [fb] = l[1];
          const A = m.faces[fa],
            B = m.faces[fb];
          if (!A || !B) continue;
          // merge the two faces then re-split rotated by one vertex
          const ia = A.verts.indexOf(a);
          const startA = A.verts[(ia + 1) % A.verts.length] === b ? ia : A.verts.indexOf(b);
          const ring: number[] = [];
          const na = A.verts.length;
          for (let k = 0; k < na; k++) ring.push(A.verts[(startA + 1 + k) % na]);
          const end = ring[ring.length - 1];
          const ib = B.verts.indexOf(end);
          for (let k = 2; k < B.verts.length; k++) ring.push(B.verts[(ib + k) % B.verts.length]);
          if (new Set(ring).size !== ring.length || ring.length < 4) continue;
          const shift = p.use_ccw ? ring.length - 1 : 1;
          const r = ring.map((_, i) => ring[(i + shift) % ring.length]);
          const half = Math.floor(r.length / 2);
          const f1 = r.slice(0, half + 1),
            f2 = [...r.slice(half), r[0]];
          m.faces[fa] = m.makeFace(f1, A);
          m.faces[fb] = m.makeFace(f2, B);
        }
      }),
  },
]);

export { selectMode };
