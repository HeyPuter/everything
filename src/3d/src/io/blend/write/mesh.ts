// Meshes in the 4.2 layout: generic attributes in the CustomData of each domain (position,
// .edge_verts, .corner_vert, .corner_edge, material_index, sharp_face, UV maps, colors, …),
// face offsets in poly_offset_indices and vertex groups as MDeformVert layers.
import type { MeshAttribute, MeshData } from '../../../data/types';
import type { Addr, BlendWriter, Struct } from './container';

type Domain = 'POINT' | 'EDGE' | 'FACE' | 'CORNER';

/** A mesh as written, whether it comes from the document or from an evaluated object. */
export interface MeshSource {
  name: string;
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  smooth?: Uint8Array | null;
  materialIndex?: ArrayLike<number> | null;
  uvs: { name: string; data: Float32Array }[];
  activeUv: number;
  renderUv: number;
  colors: { name: string; domain: 'POINT' | 'CORNER'; data: Float32Array }[];
  activeColor: number;
  /** per corner: the edge starting at the corner (flags 0/1, weights 0..1) */
  seams?: ArrayLike<number> | null;
  sharp?: ArrayLike<number> | null;
  creases?: ArrayLike<number> | null;
  bevelEdge?: ArrayLike<number> | null;
  creaseVert?: Float32Array | null;
  bevelVert?: Float32Array | null;
  groups?: { names: string[]; weights: Float32Array[]; active: number } | null;
  attributes?: MeshAttribute[];
  /** material data-block addresses per slot (0 = empty slot) */
  materials: Addr[];
}

/** eCustomDataType values and the struct each element is stored as. */
const CD = {
  MDEFORMVERT: 2,
  FLOAT: 10,
  INT32: 11,
  BYTE_COLOR: 17,
  INT8: 45,
  INT32_2D: 46,
  COLOR: 47,
  FLOAT3: 48,
  FLOAT2: 49,
  BOOL: 50,
} as const;
const CD_ELEM: Record<number, { struct: string; size: number }> = {
  [CD.FLOAT]: { struct: 'MFloatProperty', size: 4 },
  [CD.INT32]: { struct: 'MIntProperty', size: 4 },
  [CD.BYTE_COLOR]: { struct: 'MLoopCol', size: 4 },
  [CD.INT8]: { struct: 'MInt8Property', size: 1 },
  [CD.INT32_2D]: { struct: 'vec2i', size: 8 },
  [CD.COLOR]: { struct: 'MPropCol', size: 16 },
  [CD.FLOAT3]: { struct: 'vec3f', size: 12 },
  [CD.FLOAT2]: { struct: 'vec2f', size: 8 },
  [CD.BOOL]: { struct: 'MBoolProperty', size: 1 },
};
const ATTR_CD: Partial<Record<MeshAttribute['data_type'], number>> = { FLOAT: CD.FLOAT, INT: CD.INT32, INT8: CD.INT8, BOOLEAN: CD.BOOL, FLOAT2: CD.FLOAT2, INT32_2D: CD.INT32_2D, FLOAT_VECTOR: CD.FLOAT3 };
const CD_TYPEMAP_LEN = 53;

interface Layer {
  type: number;
  name: string;
  data: Uint8Array;
  count: number;
  /** MDeformVert layers point at the block written by the caller */
  addr?: Addr;
}

function floats(src: ArrayLike<number>, n: number): Uint8Array {
  const f = new Float32Array(n);
  for (let i = 0; i < n && i < src.length; i++) f[i] = src[i];
  return new Uint8Array(f.buffer);
}
function ints(src: ArrayLike<number>, n: number): Uint8Array {
  const a = new Int32Array(n);
  for (let i = 0; i < n && i < src.length; i++) a[i] = src[i];
  return new Uint8Array(a.buffer);
}
function bytes(src: ArrayLike<number>, n: number, signed = false): Uint8Array {
  const a = signed ? new Int8Array(n) : new Uint8Array(n);
  for (let i = 0; i < n && i < src.length; i++) a[i] = signed ? src[i] : src[i] ? 1 : 0;
  return new Uint8Array(a.buffer);
}
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Unique edges of the faces, and the edge each corner starts. */
export function buildEdges(offsets: Uint32Array, indices: Uint32Array, totvert: number) {
  const map = new Map<number, number>();
  const verts: number[] = [];
  const cornerEdge = new Int32Array(indices.length);
  const faces = offsets.length - 1;
  for (let p = 0; p < faces; p++) {
    const s = offsets[p],
      e = offsets[p + 1];
    for (let c = s; c < e; c++) {
      const a = indices[c],
        b = indices[c + 1 < e ? c + 1 : s];
      const key = Math.min(a, b) * totvert + Math.max(a, b);
      let edge = map.get(key);
      if (edge === undefined) {
        edge = verts.length / 2;
        map.set(key, edge);
        verts.push(a, b);
      }
      cornerEdge[c] = edge;
    }
  }
  return { edgeVerts: Int32Array.from(verts), cornerEdge, totedge: verts.length / 2 };
}

/** Per-corner values onto edges (an edge takes the largest value of the corners starting it). */
function cornersToEdges(vals: ArrayLike<number> | null | undefined, cornerEdge: Int32Array, totedge: number): Float32Array | null {
  if (!vals) return null;
  const out = new Float32Array(totedge);
  let any = false;
  for (let c = 0; c < cornerEdge.length && c < vals.length; c++) {
    const v = vals[c];
    if (v > out[cornerEdge[c]]) {
      out[cornerEdge[c]] = v;
      any = true;
    }
  }
  return any ? out : null;
}

/** The document's mesh as a MeshSource (its own data, unevaluated). */
export function meshSourceFromDoc(me: MeshData, materials: Addr[]): MeshSource {
  const uvs = [{ name: me.uv_map_name || 'UVMap', data: me.uvs }];
  const extra = me.uv_layers_extra ?? [];
  // the active map sits at uv_active_index among the others
  const active = Math.max(0, Math.min(extra.length, me.uv_active_index ?? 0));
  const ordered = [...extra.slice(0, active), uvs[0], ...extra.slice(active)];
  const render = me.uv_render_name ? Math.max(0, ordered.findIndex((u) => u.name === me.uv_render_name)) : 0;
  const nv = me.positions.length / 3;
  return {
    name: me.name,
    positions: me.positions,
    offsets: me.offsets,
    indices: me.indices,
    smooth: me.smooth,
    materialIndex: me.material_index,
    uvs: me.uvs.length ? ordered : [],
    activeUv: active,
    renderUv: render,
    colors: me.color_attributes.map((c) => ({ name: c.name, domain: c.domain, data: c.data })),
    activeColor: me.active_color_index,
    seams: me.seams,
    sharp: me.sharp,
    creases: me.creases,
    bevelEdge: me.bevel_weight_edge,
    creaseVert: me.crease_vert,
    bevelVert: me.bevel_weight_vert,
    groups: me.vertex_groups.length ? { names: me.vertex_groups.map((g) => g.name), weights: me.weights.map((w) => (w.length === nv ? w : new Float32Array(nv))), active: 0 } : null,
    attributes: me.attributes,
    materials,
  };
}

/** Writes a Mesh ID block and its data; returns its address. */
export function writeMesh(w: BlendWriter, src: MeshSource, idName: string, addr: Addr, warn: (msg: string) => void): Addr {
  const slot = w.reserve();
  const totvert = src.positions.length / 3;
  const totpoly = Math.max(0, src.offsets.length - 1);
  const totloop = src.indices.length;
  const { edgeVerts, cornerEdge, totedge } = buildEdges(src.offsets, src.indices, totvert);

  const vdata: Layer[] = [];
  const edata: Layer[] = [];
  const pdata: Layer[] = [];
  const ldata: Layer[] = [];
  const counts: Record<Domain, number> = { POINT: totvert, EDGE: totedge, FACE: totpoly, CORNER: totloop };
  const lists: Record<Domain, Layer[]> = { POINT: vdata, EDGE: edata, FACE: pdata, CORNER: ldata };

  vdata.push({ type: CD.FLOAT3, name: 'position', data: floats(src.positions, totvert * 3), count: totvert });
  edata.push({ type: CD.INT32_2D, name: '.edge_verts', data: ints(edgeVerts, totedge * 2), count: totedge });
  ldata.push({ type: CD.INT32, name: '.corner_vert', data: ints(src.indices, totloop), count: totloop });
  ldata.push({ type: CD.INT32, name: '.corner_edge', data: ints(cornerEdge, totloop), count: totloop });
  if (src.materialIndex && Array.prototype.some.call(src.materialIndex, (x: number) => x !== 0)) pdata.push({ type: CD.INT32, name: 'material_index', data: ints(src.materialIndex, totpoly), count: totpoly });
  if (src.smooth) {
    const sharp = new Uint8Array(totpoly);
    let any = false;
    for (let i = 0; i < totpoly; i++)
      if (!src.smooth[i]) {
        sharp[i] = 1;
        any = true;
      }
    if (any) pdata.push({ type: CD.BOOL, name: 'sharp_face', data: sharp, count: totpoly });
  }
  const edgeFlag = (name: string, vals: ArrayLike<number> | null | undefined, asBool: boolean) => {
    const e = cornersToEdges(vals, cornerEdge, totedge);
    if (!e) return;
    edata.push(asBool ? { type: CD.BOOL, name, data: bytes(e, totedge), count: totedge } : { type: CD.FLOAT, name, data: floats(e, totedge), count: totedge });
  };
  edgeFlag('.uv_seam', src.seams, true);
  edgeFlag('sharp_edge', src.sharp, true);
  edgeFlag('crease_edge', src.creases, false);
  edgeFlag('bevel_weight_edge', src.bevelEdge, false);
  if (src.creaseVert) vdata.push({ type: CD.FLOAT, name: 'crease_vert', data: floats(src.creaseVert, totvert), count: totvert });
  if (src.bevelVert) vdata.push({ type: CD.FLOAT, name: 'bevel_weight_vert', data: floats(src.bevelVert, totvert), count: totvert });

  const uvLayers: Layer[] = src.uvs.map((u) => ({ type: CD.FLOAT2, name: u.name, data: floats(u.data, totloop * 2), count: totloop }));
  ldata.push(...uvLayers);

  // color attributes: byte colors where every value fits 8 bits sRGB would lose precision, so
  // they are kept as float colors (Blender's "Color" attributes), on their own domain
  const colorLayers: Layer[] = [];
  for (const c of src.colors) {
    const n = counts[c.domain];
    if (c.data.length < n * 4) continue;
    const l: Layer = { type: CD.COLOR, name: c.name, data: floats(c.data, n * 4), count: n };
    colorLayers.push(l);
    lists[c.domain].push(l);
  }

  // generic attributes the document keeps (EDGE values per corner become per edge)
  const taken = new Set<string>([...vdata, ...edata, ...pdata, ...ldata].map((l) => l.name));
  for (const a of src.attributes ?? []) {
    if (taken.has(a.name)) continue;
    const type = ATTR_CD[a.data_type];
    if (type === undefined) {
      warn(`Mesh attributes of type ${a.data_type} are not stored in .blend files (${src.name}: ${a.name})`);
      continue;
    }
    const comps = type === CD.FLOAT3 ? 3 : type === CD.FLOAT2 || type === CD.INT32_2D ? 2 : 1;
    let data: ArrayLike<number> = a.data;
    let n = counts[a.domain];
    if (a.domain === 'EDGE') {
      // per corner → per edge (first corner wins)
      const out = new Float64Array(totedge * comps);
      const done = new Uint8Array(totedge);
      for (let c = 0; c < totloop; c++) {
        const e = cornerEdge[c];
        if (done[e]) continue;
        done[e] = 1;
        for (let k = 0; k < comps; k++) out[e * comps + k] = a.data[c * comps + k] ?? 0;
      }
      data = out;
      n = totedge;
    }
    const enc = type === CD.FLOAT || type === CD.FLOAT2 || type === CD.FLOAT3 ? floats(data, n * comps) : type === CD.INT32 || type === CD.INT32_2D ? ints(data, n * comps) : type === CD.INT8 ? bytes(data, n, true) : bytes(data, n);
    lists[a.domain].push({ type, name: a.name, data: enc, count: n });
    taken.add(a.name);
  }

  // vertex groups: one MDeformVert per vertex, each pointing at its own MDeformWeight block
  let dvertAddr: Addr = 0;
  if (src.groups && src.groups.names.length && totvert) {
    const dverts: Struct[] = [];
    for (let v = 0; v < totvert; v++) {
      const dv = w.struct('MDeformVert');
      const ws: Struct[] = [];
      src.groups.weights.forEach((g, gi) => {
        const val = g[v];
        if (val > 0) ws.push(w.struct('MDeformWeight').set('def_nr', gi).set('weight', val));
      });
      if (ws.length) {
        dv.set('totweight', ws.length);
        dv.ptr('dw', w.write('DATA', ws));
      }
      dverts.push(dv);
    }
    dvertAddr = w.write('DATA', dverts);
    vdata.push({ type: CD.MDEFORMVERT, name: '', data: new Uint8Array(0), count: totvert, addr: dvertAddr });
  }

  const me = w.struct('Mesh');
  me.set('id.name', idName).set('id.us', 1);
  me.set('totvert', totvert).set('totedge', totedge).set('totpoly', totpoly).set('totloop', totloop);
  if (totpoly) me.ptr('poly_offset_indices', w.raw(ints(src.offsets, totpoly + 1)));

  const writeLayers = (field: string, layers: Layer[], activeOf: (l: Layer, i: number) => { active: number; rnd: number }) => {
    const cd = me.sub(field);
    const typemap = new Array<number>(CD_TYPEMAP_LEN).fill(-1);
    const structs: Struct[] = [];
    let totsize = 0;
    // CustomData keeps layers grouped by type, in type order
    const sorted = layers.map((l, i) => ({ l, i })).sort((a, b) => a.l.type - b.l.type || a.i - b.i);
    sorted.forEach(({ l }, i) => {
      if (typemap[l.type] < 0) typemap[l.type] = i;
      const st = w.struct('CustomDataLayer');
      st.set('type', l.type).set('name', l.name).set('uid', i);
      const sameType = sorted.filter((x) => x.l.type === l.type).map((x) => x.l);
      const { active, rnd } = activeOf(l, sameType.indexOf(l));
      st.set('active', active).set('active_rnd', rnd).set('active_clone', rnd).set('active_mask', rnd);
      st.set('offset', totsize);
      const elem = l.type === CD.MDEFORMVERT ? 16 : CD_ELEM[l.type]?.size ?? 0;
      totsize += elem;
      const data = l.addr ?? (l.count ? w.array(CD_ELEM[l.type].struct, l.data, l.count) : 0);
      st.ptr('data', data);
      structs.push(st);
    });
    cd.set('typemap', typemap).set('totlayer', structs.length).set('maxlayer', structs.length).set('totsize', totsize);
    if (structs.length) cd.ptr('layers', w.write('DATA', structs));
  };
  const firstActive = () => ({ active: 0, rnd: 0 });
  writeLayers('vdata', vdata, (l) => (l.type === CD.COLOR ? colorActive(l) : firstActive()));
  writeLayers('edata', edata, firstActive);
  writeLayers('pdata', pdata, firstActive);
  writeLayers('ldata', ldata, (l) => {
    if (l.type === CD.FLOAT2 && uvLayers.length) {
      // every corner float2 layer is a UV map; active / render index the layers of the type
      return { active: Math.min(src.activeUv, uvLayers.length - 1), rnd: Math.min(src.renderUv, uvLayers.length - 1) };
    }
    if (l.type === CD.COLOR) return colorActive(l);
    return firstActive();
  });
  function colorActive(_l: Layer) {
    return { active: 0, rnd: 0 };
  }
  const activeColor = colorLayers[Math.max(0, Math.min(colorLayers.length - 1, src.activeColor))];
  if (activeColor) {
    me.ptr('active_color_attribute', w.cstring(activeColor.name));
    me.ptr('default_color_attribute', w.cstring(activeColor.name));
  }

  if (src.groups && src.groups.names.length) {
    const gs = src.groups.names.map((n) => w.struct('bDeformGroup').set('name', n));
    const addrs = gs.map(() => w.addr());
    gs.forEach((g, i) => {
      if (i > 0) g.ptr('prev', addrs[i - 1]);
      if (i < gs.length - 1) g.ptr('next', addrs[i + 1]);
    });
    gs.forEach((g, i) => w.write('DATA', g, addrs[i]));
    me.list('vertex_group_names', addrs[0], addrs[addrs.length - 1]);
    me.set('vertex_group_active_index', src.groups.active + 1);
  } else me.set('vertex_group_active_index', 0);

  if (src.materials.length) {
    me.set('totcol', src.materials.length);
    me.ptr('mat', w.pointers(src.materials));
  }
  return w.fill(slot, 'ME', me, addr);
}
