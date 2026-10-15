// bmesh ⇄ mesh data-blocks: from_mesh / to_mesh / from_object and the Edit Mode link
// (from_edit_mesh / update_edit_mesh). Every attribute the document stores travels: UVs
// (with pins / UV selection), corner and point colors, vertex groups, shape keys, seams,
// sharp edges, creases, smooth flags, material indices, selection and hidden state.
import type { MeshData, ColorAttribute, ShapeKey } from '../data/types';
import { buildMesh } from '../mesh/mesh';
import { exclusionsOf, setExclusions } from '../modes/editmesh/selset';
import { edgeKey } from '../modes/editmesh/meshedit';
import { BMesh, BMVert, BMLayerItem, faceLoops, makeVert, makeEdge, makeFace, edgeBetween, layerValue, faceNormal, vertNormal, type Domain } from './bmesh_core';

/** The geometry a BMesh can be filled from (document meshes and evaluated meshes). */
export interface MeshSource {
  positions: ArrayLike<number>;
  offsets: ArrayLike<number>;
  indices: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  uv_map_name?: string;
  smooth?: ArrayLike<number>;
  material_index?: ArrayLike<number>;
  seams?: ArrayLike<number>;
  sharp?: ArrayLike<number>;
  creases?: ArrayLike<number>;
  select_vert?: ArrayLike<number>;
  hide_vert?: ArrayLike<number>;
  vertex_groups?: { name: string }[];
  weights?: ArrayLike<number>[];
  shape_keys?: ShapeKey[];
  color_attributes?: ColorAttribute[];
  /** evaluated meshes: the active corner colors */
  colors?: ArrayLike<number>;
  loose_edges?: ArrayLike<number>;
  uv_pin?: ArrayLike<number>;
  uv_select?: ArrayLike<number>;
}

function layerNamed(bm: BMesh, d: Domain, kind: 'uv' | 'color' | 'shape' | 'deform', name: string): BMLayerItem {
  return bm._layers(d, kind).find((l) => kind === 'deform' || l._name === name) ?? bm._addLayer(d, kind, name);
}

export interface FromMeshOptions {
  /** read edge / face selection exclusions (Edit Mode selection in edge / face select mode) */
  exclusions?: { faces: Set<number>; edges: Set<string> } | null;
  /** use this shape key's coordinates for the vertex positions */
  shapeKey?: number | null;
}

/** Append a mesh's geometry and attributes to a BMesh. */
export function fromMeshData(bm: BMesh, me: MeshSource, o: FromMeshOptions = {}) {
  const nv = me.positions.length / 3;
  const nf = Math.max(0, me.offsets.length - 1);
  const corners = me.indices.length;
  const sel = me.select_vert && me.select_vert.length === nv ? me.select_vert : null;
  const hide = me.hide_vert && me.hide_vert.length === nv ? me.hide_vert : null;
  const ex = o.exclusions ?? null;
  const vBase = bm._v.size,
    eBase = bm._e.size,
    fBase = bm._f.size;

  // layers
  const hasUV = !!me.uvs && corners > 0 && me.uvs.length === corners * 2;
  const uvLayer = hasUV ? layerNamed(bm, 'loops', 'uv', me.uv_map_name || 'UVMap') : null;
  const groups = me.vertex_groups?.length ? me.vertex_groups : null;
  const deform = groups && me.weights?.length ? layerNamed(bm, 'verts', 'deform', '') : null;
  const keys = me.shape_keys ?? [];
  const keyLayers = keys.map((k) => layerNamed(bm, 'verts', 'shape', k.name));
  const colors = (me.color_attributes ?? []).map((c) => ({ c, layer: layerNamed(bm, c.domain === 'POINT' ? 'verts' : 'loops', 'color', c.name) }));
  if (me.colors && me.colors.length === corners * 4 && !colors.length) colors.push({ c: { name: 'Color', domain: 'CORNER', data: me.colors as Float32Array }, layer: layerNamed(bm, 'loops', 'color', 'Color') });
  const pointColors = colors.filter((x) => x.c.domain === 'POINT' && x.c.data.length === nv * 4);
  const cornerColors = colors.filter((x) => x.c.domain === 'CORNER' && x.c.data.length === corners * 4);

  const shapeCo = o.shapeKey !== null && o.shapeKey !== undefined ? keys[o.shapeKey]?.data : null;
  const P = shapeCo && shapeCo.length === nv * 3 ? shapeCo : me.positions;
  const verts: BMVert[] = new Array(nv);
  for (let i = 0; i < nv; i++) {
    const v = makeVert(bm, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    v.index = vBase + i;
    v._sel = !!sel?.[i];
    v._hide = !!hide?.[i];
    if (deform) {
      const m = new Map<number, number>();
      me.weights!.forEach((w, g) => {
        const x = w[i];
        if (x) m.set(g, x);
      });
      v._cd[deform._slot] = m;
    }
    keys.forEach((k, ki) => {
      if (k.data.length === nv * 3) v._cd[keyLayers[ki]._slot] = [k.data[i * 3], k.data[i * 3 + 1], k.data[i * 3 + 2]];
    });
    for (const { c, layer } of pointColors) v._cd[layer._slot] = [c.data[i * 4], c.data[i * 4 + 1], c.data[i * 4 + 2], c.data[i * 4 + 3]];
    verts[i] = v;
  }
  const edgeSel = (a: number, b: number) => !!sel?.[a] && !!sel?.[b] && !ex?.edges.has(edgeKey(a, b));
  for (let f = 0; f < nf; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    const ids: number[] = [],
      cs: number[] = [];
    for (let c = s; c < e; c++) {
      const v = me.indices[c];
      if (v >= nv || (ids.length && ids[ids.length - 1] === v)) continue;
      ids.push(v);
      cs.push(c);
    }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop(), cs.pop();
    if (ids.length < 3 || new Set(ids).size !== ids.length) continue;
    const fv = ids.map((i) => verts[i]);
    const face = makeFace(bm, fv);
    face.index = fBase + f;
    face.smooth = !!me.smooth?.[f];
    face.material_index = me.material_index?.[f] ?? 0;
    face._sel = ids.every((i) => !!sel?.[i]) && !ex?.faces.has(f);
    face._hide = ids.some((i) => !!hide?.[i]);
    const ls = faceLoops(face);
    ls.forEach((l, k) => {
      const c = cs[k];
      const edge = l.edge;
      if (me.seams?.[c]) edge.seam = true;
      if (me.sharp?.[c]) edge.smooth = false;
      if (me.creases?.[c]) edge._crease = Math.max(edge._crease, me.creases[c]);
      edge._sel = edgeSel(ids[k], ids[(k + 1) % ids.length]);
      edge._hide = !!hide?.[ids[k]] || !!hide?.[ids[(k + 1) % ids.length]];
      if (uvLayer) l._cd[uvLayer._slot] = [me.uvs![c * 2], me.uvs![c * 2 + 1], me.uv_pin?.[c] ? 1 : 0, me.uv_select?.[c] ? 1 : 0, 0];
      for (const { c: ca, layer } of cornerColors) l._cd[layer._slot] = [ca.data[c * 4], ca.data[c * 4 + 1], ca.data[c * 4 + 2], ca.data[c * 4 + 3]];
    });
  }
  const loose = me.loose_edges;
  if (loose)
    for (let i = 0; i + 1 < loose.length; i += 2) {
      const a = loose[i],
        b = loose[i + 1];
      if (a === b || a >= nv || b >= nv || edgeBetween(verts[a], verts[b])) continue;
      const e = makeEdge(bm, verts[a], verts[b]);
      e._sel = edgeSel(a, b);
      e._hide = !!hide?.[a] || !!hide?.[b];
    }
  // indices and normals of the new elements
  let k = 0;
  for (const e of bm._e) if (k++ >= eBase) e.index = k - 1;
  let fi = 0;
  for (const f of bm._f) if (fi++ >= fBase) f._no = faceNormal(f);
  for (const v of verts) v._no = vertNormal(v);
  bm._vt = bm._et = bm._ft = null;
}

export interface ToMeshOptions {
  /** register edge / face selection exclusions (Edit Mode) */
  selection?: boolean;
}

/** Write a BMesh into a mesh data-block (replacing its geometry). */
export function toMeshData(bm: BMesh, me: MeshData, o: ToMeshOptions = {}) {
  const verts = [...bm._v];
  verts.forEach((v, i) => (v.index = i));
  const nv = verts.length;
  const positions = new Float32Array(nv * 3);
  verts.forEach((v, i) => {
    positions[i * 3] = v._co[0];
    positions[i * 3 + 1] = v._co[1];
    positions[i * 3 + 2] = v._co[2];
  });
  const uvLayer = bm._activeOf('loops', 'uv');
  const faces = [...bm._f];
  faces.forEach((f, i) => (f.index = i));
  let ei = 0;
  for (const e of bm._e) e.index = ei++;
  let anySeam = false,
    anySharp = false,
    anyCrease = false,
    anyPin = false,
    anyUvSel = false;
  const polys = faces.map((f) => {
    const ls = faceLoops(f);
    const uvs: number[] = [];
    const seams: number[] = [],
      sharp: number[] = [],
      creases: number[] = [];
    for (const l of ls) {
      if (uvLayer) {
        const d = layerValue(l, uvLayer) as number[];
        uvs.push(d[0], d[1]);
        if (d[2]) anyPin = true;
        if (d[3]) anyUvSel = true;
      } else uvs.push(0, 0);
      seams.push(l.edge.seam ? 1 : 0);
      sharp.push(l.edge.smooth ? 0 : 1);
      creases.push(l.edge._crease);
      anySeam ||= l.edge.seam;
      anySharp ||= !l.edge.smooth;
      anyCrease ||= l.edge._crease > 0;
    }
    return { verts: ls.map((l) => l.vert.index), uvs, smooth: f.smooth, material: f.material_index, seams, sharp, creases };
  });
  const built = buildMesh(positions, polys);
  const corners = built.indices.length;
  const oldFaces = me.offsets.length - 1,
    oldVerts = me.positions.length / 3;
  me.positions = built.positions;
  me.offsets = built.offsets;
  me.indices = built.indices;
  me.uvs = built.uvs;
  me.normals = built.normals;
  me.smooth = built.smooth;
  me.material_index = built.material_index;
  me.seams = anySeam ? built.seams : undefined;
  me.sharp = anySharp ? built.sharp : undefined;
  me.creases = anyCrease ? built.creases : undefined;
  if (uvLayer) me.uv_map_name = uvLayer._name;
  // per-corner UV flags
  if (anyPin || anyUvSel) {
    const pin = new Uint8Array(corners),
      usel = new Uint8Array(corners);
    let c = 0;
    for (const f of faces)
      for (const l of faceLoops(f)) {
        const d = layerValue(l, uvLayer!) as number[];
        pin[c] = d[2] ? 1 : 0;
        usel[c++] = d[3] ? 1 : 0;
      }
    me.uv_pin = anyPin ? pin : undefined;
    me.uv_select = anyUvSel ? usel : undefined;
  } else {
    me.uv_pin = undefined;
    me.uv_select = undefined;
  }
  // selection / hidden
  const sel = Uint8Array.from(verts, (v) => (v._sel ? 1 : 0));
  me.select_vert = sel;
  me.hide_vert = verts.some((v) => v._hide) ? Uint8Array.from(verts, (v) => (v._hide ? 1 : 0)) : undefined;
  if (o.selection) {
    const exFaces = new Set<number>(),
      exEdges = new Set<string>();
    faces.forEach((f, i) => {
      if (!f._sel && faceLoops(f).every((l) => l.vert._sel)) exFaces.add(i);
    });
    for (const e of bm._e) if (!e._sel && e.v1._sel && e.v2._sel) exEdges.add(edgeKey(e.v1.index, e.v2.index));
    setExclusions(sel, { faces: exFaces, edges: exEdges });
  }
  // vertex groups
  const deform = bm._layers('verts', 'deform')[0];
  let ngroups = me.vertex_groups.length;
  if (deform) for (const v of verts) (v._cd[deform._slot] as Map<number, number> | undefined)?.forEach((_, g) => (ngroups = Math.max(ngroups, g + 1)));
  while (me.vertex_groups.length < ngroups) {
    const names = new Set(me.vertex_groups.map((g) => g.name));
    let n = 'Group';
    for (let i = 1; names.has(n); i++) n = `Group.${String(i).padStart(3, '0')}`;
    me.vertex_groups.push({ name: n });
  }
  me.weights = me.vertex_groups.map(() => new Float32Array(nv));
  if (deform)
    verts.forEach((v, i) =>
      (v._cd[deform._slot] as Map<number, number> | undefined)?.forEach((w, g) => {
        if (me.weights[g]) me.weights[g][i] = w;
      }),
    );
  // shape keys
  const shapeLayers = bm._layers('verts', 'shape');
  const oldKeys = new Map(me.shape_keys.map((k) => [k.name, k]));
  const basisName = shapeLayers[0]?._name ?? 'Basis';
  me.shape_keys = shapeLayers.map((layer) => {
    const data = new Float32Array(nv * 3);
    verts.forEach((v, i) => {
      const c = (v._cd[layer._slot] as number[] | undefined) ?? v._co;
      data[i * 3] = c[0];
      data[i * 3 + 1] = c[1];
      data[i * 3 + 2] = c[2];
    });
    const old = oldKeys.get(layer._name);
    return old ? { ...old, data } : { name: layer._name, data, value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: basisName };
  });
  me.active_shape_key_index = Math.min(Math.max(0, me.active_shape_key_index ?? 0), Math.max(0, me.shape_keys.length - 1));
  // colors
  const activeColor = me.color_attributes[me.active_color_index]?.name;
  const colorAttrs: ColorAttribute[] = [];
  for (const layer of bm._layers('verts', 'color')) {
    const data = new Float32Array(nv * 4);
    verts.forEach((v, i) => data.set((v._cd[layer._slot] as number[] | undefined) ?? [1, 1, 1, 1], i * 4));
    colorAttrs.push({ name: layer._name, domain: 'POINT', data });
  }
  for (const layer of bm._layers('loops', 'color')) {
    const data = new Float32Array(corners * 4);
    let c = 0;
    for (const f of faces) for (const l of faceLoops(f)) data.set((l._cd[layer._slot] as number[] | undefined) ?? [1, 1, 1, 1], 4 * c++);
    colorAttrs.push({ name: layer._name, domain: 'CORNER', data });
  }
  me.color_attributes = colorAttrs;
  const ai = colorAttrs.findIndex((c) => c.name === activeColor);
  me.active_color_index = ai >= 0 ? ai : 0;
  // loose edges
  const loose: number[] = [];
  for (const e of bm._e) if (!e._l.length) loose.push(e.v1.index, e.v2.index);
  me.loose_edges = loose.length ? Uint32Array.from(loose) : undefined;
  // data that only stays meaningful when the element counts are unchanged
  me.custom_normals = undefined;
  me.quad_flip = undefined;
  me.face_strength = undefined;
  if (faces.length !== oldFaces) {
    me.sculpt_face_set = undefined;
    me.hide_poly = undefined;
    me.uv_hide = undefined;
  }
  if (nv !== oldVerts) me.sculpt_mask = undefined;
}
