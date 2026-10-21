// Mesh conversion. Reads geometry from generic attributes (Blender 5.x AttributeStorage, or
// 3.x/4.x CustomData layers) with a fallback to the legacy MVert/MEdge/MPoly/MLoop structs.
import type { ColorAttribute, MeshData, ShapeKey } from '../../data/types';
import { newMeshData } from '../../data/defaults';
import { polyNormal } from '../../mesh/mesh';
import type { BStruct } from './reader';
import type { BHead } from './container';
import type { Ctx } from './context';

type Domain = 'POINT' | 'EDGE' | 'FACE' | 'CORNER';
type Kind = 'bool' | 'int8' | 'int32' | 'int2' | 'int16_2d' | 'float' | 'float2' | 'float3' | 'color' | 'bytecolor' | 'quat' | 'float4x4';

const KIND_SIZE: Record<Kind, number> = { bool: 1, int8: 1, int32: 4, int2: 8, int16_2d: 4, float: 4, float2: 8, float3: 12, color: 16, bytecolor: 4, quat: 16, float4x4: 64 };
const KIND_COMPS: Record<Kind, number> = { bool: 1, int8: 1, int32: 1, int2: 2, int16_2d: 2, float: 1, float2: 2, float3: 3, color: 4, bytecolor: 4, quat: 4, float4x4: 16 };
/** AttributeStorage data_type values as written by Blender 5.x */
const ATTR_TYPE_5X: Record<number, Kind> = { 0: 'bool', 1: 'int8', 2: 'int16_2d', 3: 'int32', 4: 'int2', 5: 'float', 6: 'float2', 7: 'float3', 8: 'float4x4', 9: 'bytecolor', 10: 'color', 11: 'quat' };
/** CustomData layer types for generic attributes (3.x/4.x) */
const CD_TYPE: Record<number, Kind> = { 10: 'float', 11: 'int32', 17: 'bytecolor', 45: 'int8', 46: 'int2', 47: 'color', 48: 'float3', 49: 'float2', 50: 'bool', 52: 'quat' };
const CD_STRUCT: Record<string, Kind> = { MFloatProperty: 'float', MIntProperty: 'int32', MLoopCol: 'bytecolor', MPropCol: 'color', vec3f: 'float3', vec2f: 'float2', vec2i: 'int2', MInt8Property: 'int8', MBoolProperty: 'bool', MStringProperty: 'int8' };
const DOMAINS: Domain[] = ['POINT', 'EDGE', 'FACE', 'CORNER'];

interface Attr {
  name: string;
  domain: Domain;
  kind: Kind;
  /** byte offset of the data in the file buffer */
  offset: number;
  /** number of elements stored (1 when single-value) */
  stored: number;
}

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

class AttrReader {
  constructor(
    private ctx: Ctx,
    private counts: Record<Domain, number>,
  ) {}
  /** Values as numbers, expanded to the domain size (`comps` per element). */
  read(a: Attr): Float64Array | null {
    const n = this.counts[a.domain];
    const comps = KIND_COMPS[a.kind];
    const size = KIND_SIZE[a.kind];
    const f = this.ctx.f;
    const dv = f.dv,
      le = f.littleEndian;
    if (a.stored !== n && a.stored !== 1) return null;
    if (a.offset + a.stored * size > f.bytes.length) return null;
    const out = new Float64Array(n * comps);
    const elem = (i: number, o: number) => {
      switch (a.kind) {
        case 'bool':
          out[o] = f.bytes[i] ? 1 : 0;
          break;
        case 'int8':
          out[o] = dv.getInt8(i);
          break;
        case 'int32':
          out[o] = dv.getInt32(i, le);
          break;
        case 'int2':
          out[o] = dv.getInt32(i, le);
          out[o + 1] = dv.getInt32(i + 4, le);
          break;
        case 'int16_2d':
          out[o] = dv.getInt16(i, le);
          out[o + 1] = dv.getInt16(i + 2, le);
          break;
        case 'bytecolor':
          for (let k = 0; k < 4; k++) out[o + k] = f.bytes[i + k] / 255;
          break;
        default:
          for (let k = 0; k < comps; k++) out[o + k] = dv.getFloat32(i + k * 4, le);
      }
    };
    if (a.stored === 1 && n !== 1) {
      elem(a.offset, 0);
      for (let e = 1; e < n; e++) for (let k = 0; k < comps; k++) out[e * comps + k] = out[k];
    } else for (let e = 0; e < n; e++) elem(a.offset + e * size, e * comps);
    return out;
  }
}

function dataBlockOf(ctx: Ctx, holder: BStruct, field: string): { offset: number; len: number; block: BHead } | null {
  const a = holder.ptr(field);
  if (a === 0) return null;
  return ctx.f.rawAt(a, holder.block);
}

/** Generic attributes stored in Blender 5.x AttributeStorage. */
function attributesFromStorage(me: BStruct, ctx: Ctx, counts: Record<Domain, number>): Attr[] {
  const as = me.sub('attribute_storage');
  if (!as) return [];
  const n = as.num('dna_attributes_num');
  if (n <= 0) return [];
  const out: Attr[] = [];
  for (const a of as.refArray('dna_attributes', n)) {
    const name = a.cstr('name');
    const kind = ATTR_TYPE_5X[a.num('data_type')];
    const domain = DOMAINS[a.num('domain')];
    if (!kind || !domain) {
      if (!name.startsWith('.')) ctx.warn.add('Mesh attributes with unsupported type/domain skipped', name);
      continue;
    }
    const holder = a.at(a.ptr('data'));
    if (!holder) continue;
    const raw = dataBlockOf(ctx, holder, 'data');
    const isArray = holder.type === 'AttributeArray' && !holder.num('is_single');
    const stored = isArray ? holder.num('size') : 1;
    if (stored === 0 && counts[domain] === 0) continue;
    if (!raw || raw.len < stored * KIND_SIZE[kind]) {
      ctx.warn.add('Mesh attributes with missing data skipped', name);
      continue;
    }
    out.push({ name, domain, kind, offset: raw.offset, stored });
  }
  return out;
}

interface LegacyLayers {
  attrs: Attr[];
  structs: { domain: Domain; type: string; holder: BStruct; addr: ReturnType<BStruct['ptr']> }[];
  dvert: BStruct | null;
}

/** CustomData layers (3.x/4.x and older). Generic layers become Attr; struct layers are returned raw. */
function customDataLayers(me: BStruct, ctx: Ctx, counts: Record<Domain, number>): LegacyLayers {
  const res: LegacyLayers = { attrs: [], structs: [], dvert: null };
  const doms: [string, Domain][] = [
    ['vdata', 'POINT'],
    ['edata', 'EDGE'],
    ['pdata', 'FACE'],
    ['ldata', 'CORNER'],
  ];
  for (const [field, domain] of doms) {
    const cd = me.sub(field);
    if (!cd) continue;
    const layers = cd.refArray('layers', cd.num('totlayer'));
    for (const l of layers) {
      const addr = l.ptr('data');
      if (addr === 0) continue;
      const hit = ctx.f.blockAt(addr, l.block);
      if (!hit) continue;
      const st = ctx.f.structOf(hit.block.sdna);
      const stName = st && st.size > 0 ? st.type : '';
      const type = l.num('type');
      const name = l.str('name');
      if (stName === 'MDeformVert' || type === 2) {
        res.dvert = l;
        continue;
      }
      if (['MVert', 'MEdge', 'MPoly', 'MLoop', 'MLoopUV', 'MFace', 'MTFace', 'MCol'].includes(stName)) {
        res.structs.push({ domain, type: stName, holder: l, addr });
        continue;
      }
      const kind = CD_STRUCT[stName] ?? CD_TYPE[type];
      if (!kind || stName === 'MStringProperty' || type === 12) {
        if (!name.startsWith('.')) ctx.warn.add('Mesh layers of unsupported type skipped', `${me.idName}: ${name || stName || `type ${type}`}`);
        continue;
      }
      const n = counts[domain];
      const len = hit.block.len - hit.delta;
      if (len < n * KIND_SIZE[kind]) continue;
      res.attrs.push({ name, domain, kind, offset: hit.block.offset + hit.delta, stored: n });
    }
  }
  return res;
}

export function convertMesh(me: BStruct, ctx: Ctx, fallbackGroupNames: string[]): MeshData | null {
  const f = ctx.f;
  const name = me.idName;
  const totvert = Math.max(0, me.num('totvert')),
    totedge = Math.max(0, me.num('totedge')),
    totpoly = Math.max(0, me.num('totpoly')),
    totloop = Math.max(0, me.num('totloop'));
  const LIMIT = 50_000_000;
  if (totvert > LIMIT || totloop > LIMIT * 4 || totpoly > LIMIT || totedge > LIMIT * 2) throw new Error(`Mesh "${name}" is too large`);
  const counts: Record<Domain, number> = { POINT: totvert, EDGE: totedge, FACE: totpoly, CORNER: totloop };
  const reader = new AttrReader(ctx, counts);
  const attrs = attributesFromStorage(me, ctx, counts);
  const legacy = customDataLayers(me, ctx, counts);
  attrs.push(...legacy.attrs.filter((a) => !attrs.some((b) => b.name === a.name && b.domain === a.domain)));
  const get = (n: string, domain?: Domain) => attrs.find((a) => a.name === n && (!domain || a.domain === domain));
  const used = new Set<Attr>();
  const take = (a: Attr | undefined) => {
    if (!a) return null;
    used.add(a);
    return reader.read(a);
  };
  const legacyStruct = (type: string) => legacy.structs.find((s) => s.type === type);
  const structArray = (l: { holder: BStruct; addr: ReturnType<BStruct['ptr']> }, type: string, n: number) => f.structsAt(l.addr, type, n, l.holder.block);

  // --- positions
  let positions: Float32Array;
  const posAttr = take(get('position', 'POINT'));
  if (posAttr) positions = Float32Array.from(posAttr);
  else {
    const mv = legacyStruct('MVert');
    if (mv) {
      positions = new Float32Array(totvert * 3);
      structArray(mv, 'MVert', totvert).forEach((v, i) => positions.set(v.nums('co', 3), i * 3));
    } else if (totvert === 0) positions = new Float32Array(0);
    else {
      ctx.warn.add('Meshes without readable vertex positions skipped', name);
      return null;
    }
  }

  // --- faces
  let offsets = new Uint32Array(totpoly + 1);
  let indices = new Uint32Array(totloop);
  let cornerEdge: Float64Array | null = null;
  let polyFlags: number[] | null = null;
  let polyMat: number[] | null = null;
  if (totpoly > 0) {
    const offAddr = me.ptr('poly_offset_indices');
    const offs = offAddr !== 0 ? f.int32(offAddr, totpoly + 1, me.block) : null;
    if (offs) offsets = Uint32Array.from(offs);
    else {
      const mp = legacyStruct('MPoly');
      if (!mp) {
        ctx.warn.add('Meshes with unreadable faces skipped', name);
        return null;
      }
      const polys = structArray(mp, 'MPoly', totpoly);
      polyFlags = [];
      polyMat = [];
      // MPoly stores loopstart/totloop; assume contiguous ascending corners (Blender guarantees this)
      polys.forEach((p, i) => {
        offsets[i] = p.num('loopstart');
        polyFlags!.push(p.num('flag'));
        polyMat!.push(p.num('mat_nr'));
      });
      offsets[totpoly] = totloop;
    }
    const cv = take(get('.corner_vert', 'CORNER'));
    if (cv) indices = Uint32Array.from(cv);
    else {
      const ml = legacyStruct('MLoop');
      if (!ml) {
        ctx.warn.add('Meshes with unreadable faces skipped', name);
        return null;
      }
      const loops = structArray(ml, 'MLoop', totloop);
      cornerEdge = new Float64Array(totloop);
      loops.forEach((l, i) => {
        indices[i] = l.num('v');
        cornerEdge![i] = l.num('e');
      });
    }
  } else if (me.num('totface') > 0) {
    ctx.warn.add('Pre-2.63 meshes (tessellated faces only) are not supported', name);
  }
  // validate topology
  if (offsets[0] !== 0 || offsets[totpoly] !== totloop) {
    if (totpoly > 0) {
      ctx.warn.add('Meshes with corrupt face data skipped', name);
      return null;
    }
  }
  for (let i = 0; i < totpoly; i++) {
    if (offsets[i + 1] <= offsets[i] || offsets[i + 1] - offsets[i] < 3 || offsets[i + 1] > totloop) {
      ctx.warn.add('Meshes with corrupt face data skipped', name);
      return null;
    }
  }
  for (let i = 0; i < totloop; i++) {
    if (indices[i] >= totvert) {
      ctx.warn.add('Meshes with corrupt face data skipped', name);
      return null;
    }
  }

  // --- edges (for per-corner edge flags)
  let edgeVerts: Float64Array | null = take(get('.edge_verts', 'EDGE'));
  let edgeFlags: number[] | null = null;
  let edgeCreaseLegacy: number[] | null = null;
  if (!edgeVerts && totedge) {
    const medge = legacyStruct('MEdge');
    if (medge) {
      edgeVerts = new Float64Array(totedge * 2);
      edgeFlags = [];
      edgeCreaseLegacy = [];
      structArray(medge, 'MEdge', totedge).forEach((e, i) => {
        edgeVerts![i * 2] = e.num('v1');
        edgeVerts![i * 2 + 1] = e.num('v2');
        edgeFlags!.push(e.num('flag'));
        edgeCreaseLegacy!.push(e.num('crease') / 255);
      });
    }
  }
  if (!cornerEdge) cornerEdge = take(get('.corner_edge', 'CORNER'));
  if (!cornerEdge && edgeVerts && totloop) {
    const map = new Map<number, number>();
    for (let e = 0; e < totedge; e++) {
      const a = edgeVerts[e * 2],
        b = edgeVerts[e * 2 + 1];
      map.set(Math.min(a, b) * totvert + Math.max(a, b), e);
    }
    cornerEdge = new Float64Array(totloop).fill(-1);
    for (let p = 0; p < totpoly; p++) {
      const s = offsets[p],
        e = offsets[p + 1];
      for (let c = s; c < e; c++) {
        const a = indices[c],
          b = indices[c + 1 < e ? c + 1 : s];
        cornerEdge[c] = map.get(Math.min(a, b) * totvert + Math.max(a, b)) ?? -1;
      }
    }
  }
  // count loose edges (not representable)
  if (totedge && cornerEdge) {
    const usedEdges = new Uint8Array(totedge);
    for (let c = 0; c < totloop; c++) if (cornerEdge[c] >= 0 && cornerEdge[c] < totedge) usedEdges[cornerEdge[c]] = 1;
    let loose = 0;
    for (let e = 0; e < totedge; e++) if (!usedEdges[e]) loose++;
    if (loose) ctx.warn.add('Loose edges (not part of a face) dropped', `${name} (${loose})`);
  } else if (totedge && totpoly === 0) ctx.warn.add('Loose edges (not part of a face) dropped', `${name} (${totedge})`);

  const edgeToCorner = (vals: ArrayLike<number> | null, asFlag: boolean): Float64Array | null => {
    if (!vals || !cornerEdge) return null;
    const out = new Float64Array(totloop);
    let any = false;
    for (let c = 0; c < totloop; c++) {
      const e = cornerEdge[c];
      const v = e >= 0 && e < totedge ? vals[e] : 0;
      out[c] = asFlag ? (v ? 1 : 0) : v;
      if (v) any = true;
    }
    return any ? out : null;
  };
  let seamVals: ArrayLike<number> | null = take(get('uv_seam', 'EDGE')) ?? take(get('.uv_seam', 'EDGE'));
  let sharpVals: ArrayLike<number> | null = take(get('sharp_edge', 'EDGE'));
  let creaseVals: ArrayLike<number> | null = take(get('crease_edge', 'EDGE')) ?? take(get('crease', 'EDGE'));
  if (edgeFlags) {
    if (!seamVals) seamVals = edgeFlags.map((fl) => (fl & 4 ? 1 : 0));
    if (!sharpVals) sharpVals = edgeFlags.map((fl) => (fl & 512 ? 1 : 0));
    if (!creaseVals && edgeCreaseLegacy?.some((x) => x > 0)) creaseVals = edgeCreaseLegacy;
  }
  const seams = edgeToCorner(seamVals, true);
  const sharp = edgeToCorner(sharpVals, true);
  const creases = edgeToCorner(creaseVals, false);

  // --- face attributes
  const smooth = new Uint8Array(totpoly);
  const sharpFace = take(get('sharp_face', 'FACE'));
  if (sharpFace) for (let i = 0; i < totpoly; i++) smooth[i] = sharpFace[i] ? 0 : 1;
  else if (polyFlags) polyFlags.forEach((fl, i) => (smooth[i] = fl & 1 ? 1 : 0));
  else smooth.fill(1);
  const material_index = new Uint16Array(totpoly);
  const matAttr = take(get('material_index', 'FACE'));
  if (matAttr) for (let i = 0; i < totpoly; i++) material_index[i] = Math.max(0, Math.min(32767, matAttr[i]));
  else if (polyMat) polyMat.forEach((m, i) => (material_index[i] = Math.max(0, m)));

  // --- UV maps (float2 corner attributes; legacy MLoopUV layers)
  const uvAttrs = attrs.filter((a) => a.kind === 'float2' && a.domain === 'CORNER' && !a.name.startsWith('.'));
  const activeUvName = me.cstr('active_uv_map_attribute') || me.cstr('default_uv_map_attribute');
  let uvs = new Float32Array(totloop * 2);
  let uvName = 'UVMap';
  const uvChoice = uvAttrs.find((a) => a.name === activeUvName) ?? uvAttrs[0];
  if (uvChoice) {
    const v = take(uvChoice);
    if (v) uvs = Float32Array.from(v);
    uvName = uvChoice.name;
    for (const a of uvAttrs) used.add(a);
    const others = uvAttrs.filter((a) => a !== uvChoice).map((a) => a.name);
    if (others.length) ctx.warn.add('Additional UV maps dropped (only the active UV map is kept)', `${name}: ${others.join(', ')}`);
  } else {
    const uvLayers = legacy.structs.filter((s) => s.type === 'MLoopUV');
    if (uvLayers.length) {
      const l = uvLayers.find((x) => x.holder.num('active_rnd') === uvLayers.indexOf(x)) ?? uvLayers[0];
      uvName = l.holder.str('name') || 'UVMap';
      structArray(l, 'MLoopUV', totloop).forEach((u, i) => uvs.set(u.nums('uv', 2), i * 2));
      if (uvLayers.length > 1) ctx.warn.add('Additional UV maps dropped (only the active UV map is kept)', name);
    }
  }

  // --- flat corner normals for the polygon kernels
  const normals = new Float32Array(totloop * 3);
  const nrm: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < totpoly; p++) {
    const s = offsets[p],
      e = offsets[p + 1];
    polyNormal(positions, indices.subarray(s, e), nrm);
    for (let c = s; c < e; c++) normals.set(nrm, c * 3);
  }

  const mesh = newMeshData(name, { positions, offsets, indices, uvs, normals, smooth, material_index });
  mesh.uv_map_name = uvName;
  if (seams) mesh.seams = Uint32Array.from(seams);
  if (sharp) mesh.sharp = Uint32Array.from(sharp);
  if (creases) mesh.creases = Float32Array.from(creases);
  const bevelE = edgeToCorner(take(get('bevel_weight_edge', 'EDGE')), false);
  if (bevelE) mesh.bevel_weight_edge = Float32Array.from(bevelE);
  for (const key of ['bevel_weight_vert', 'crease_vert'] as const) {
    const vals = take(get(key, 'POINT'));
    if (vals && vals.length === totvert && Array.prototype.some.call(vals, (x: number) => x > 0)) mesh[key] = Float32Array.from(vals);
  }
  const hideV = take(get('.hide_vert', 'POINT'));
  if (hideV && hideV.some((x) => x)) mesh.hide_vert = Uint8Array.from(hideV);
  const selV = take(get('.select_vert', 'POINT'));
  if (selV) mesh.select_vert = Uint8Array.from(selV);
  for (const n of ['.select_edge', '.select_poly', '.hide_edge', '.hide_poly', '.uv_select_vert', '.uv_select_edge', '.uv_select_face', 'sharp_face', '.edge_verts', '.corner_edge', '.corner_vert']) {
    const a = get(n);
    if (a) used.add(a);
  }

  // --- color attributes
  const colorAttrs = attrs.filter((a) => (a.kind === 'color' || a.kind === 'bytecolor') && (a.domain === 'POINT' || a.domain === 'CORNER') && !a.name.startsWith('.'));
  const cols: ColorAttribute[] = [];
  for (const a of colorAttrs) {
    const v = take(a);
    if (!v) continue;
    const data = new Float32Array(v.length);
    if (a.kind === 'bytecolor') for (let i = 0; i < v.length; i++) data[i] = i % 4 === 3 ? v[i] : srgbToLinear(v[i]);
    else data.set(v);
    cols.push({ name: a.name, domain: a.domain as 'POINT' | 'CORNER', data });
  }
  mesh.color_attributes = cols;
  const activeCol = me.cstr('active_color_attribute');
  mesh.active_color_index = Math.max(0, cols.findIndex((c) => c.name === activeCol));

  // --- vertex groups
  let groupNames = me.list('vertex_group_names').map((g) => g.str('name'));
  if (!groupNames.length) groupNames = fallbackGroupNames;
  mesh.vertex_groups = groupNames.map((n) => ({ name: n }));
  if (groupNames.length) {
    const weights = groupNames.map(() => new Float32Array(totvert));
    const dvHolder = legacy.dvert;
    const addr = dvHolder ? dvHolder.ptr('data') : me.ptr('dvert');
    const from = dvHolder ? dvHolder.block : me.block;
    const dverts = f.structsAt(addr, 'MDeformVert', totvert, from);
    {
      for (let v = 0; v < dverts.length; v++) {
        const dv = dverts[v];
        const n = dv.num('totweight');
        if (n <= 0) continue;
        const raw = f.rawAt(dv.ptr('dw'), dv.block);
        if (!raw) continue;
        const cnt = Math.min(n, Math.floor(raw.len / 8));
        for (let k = 0; k < cnt; k++) {
          const g = f.dv.getInt32(raw.offset + k * 8, f.littleEndian);
          const w = f.dv.getFloat32(raw.offset + k * 8 + 4, f.littleEndian);
          if (g >= 0 && g < weights.length && Number.isFinite(w)) weights[g][v] = w;
        }
      }
    }
    mesh.weights = weights;
  }

  // --- shape keys
  const key = me.ref('key');
  if (key) mesh.shape_keys = convertShapeKeys(key, ctx, name, totvert);

  // --- materials
  const totcol = Math.max(0, Math.min(32767, me.num('totcol')));
  mesh.materials = me.ptrArray('mat', totcol).map((a) => (a === 0 ? null : ctx.material(me.at(a))));

  // --- auto smooth (pre-4.1 meshes)
  if (ctx.version < 401 && me.num('flag') & 32) mesh.auto_smooth_angle = me.num('smoothresh');
  const vs = me.num('remesh_voxel_size');
  if (vs > 0) mesh.remesh_voxel_size = vs;

  // unmapped generic attributes
  for (const a of attrs) {
    if (used.has(a) || a.name.startsWith('.')) continue;
    if (['position', 'material_index', 'sharp_edge', 'uv_seam', 'crease_edge', 'crease_vert', 'bevel_weight_edge', 'bevel_weight_vert'].includes(a.name) && used.has(a)) continue;
    ctx.warn.add('Generic mesh attributes not imported', `${name}.${a.name}`);
  }
  return mesh;
}

function convertShapeKeys(key: BStruct, ctx: Ctx, meshName: string, totvert: number): ShapeKey[] {
  const blocks = key.list('block', 10_000);
  if (!blocks.length) return [];
  // Key.type: 0 = absolute keys (not supported), 1 = relative
  if (key.num('type') === 0 && blocks.length > 1) ctx.warn.add('Absolute shape keys imported as relative', meshName);
  const names = blocks.map((b) => b.str('name'));
  const out: ShapeKey[] = [];
  for (const kb of blocks) {
    const n = kb.num('totelem');
    if (n !== totvert) {
      ctx.warn.add('Shape keys with mismatched vertex count skipped', `${meshName}: ${kb.str('name')}`);
      continue;
    }
    const data = ctx.f.float32(kb.ptr('data'), n * 3, kb.block);
    if (!data) {
      ctx.warn.add('Shape keys with missing data skipped', `${meshName}: ${kb.str('name')}`);
      continue;
    }
    const rel = kb.num('relative');
    const sk: ShapeKey = {
      name: kb.str('name'),
      data,
      value: kb.num('curval'),
      slider_min: kb.num('slidermin'),
      slider_max: kb.num('slidermax'),
      mute: (kb.num('flag') & 1) !== 0,
      relative_key: names[rel] ?? names[0],
    };
    const vg = kb.str('vgroup');
    if (vg) sk.vertex_group = vg;
    out.push(sk);
  }
  return out;
}
