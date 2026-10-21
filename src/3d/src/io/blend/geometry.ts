// Point clouds, hair curves and volumes: their geometry is stored as generic attributes (5.x
// AttributeStorage, or CustomData layers in older files), read with the mesh attribute reader.
import type { AttrArray, DataType } from '../../geonodes/types';
import type { PointCloudData } from '../../pointcloud/types';
import type { HairCurvesData, HairAttribute } from '../../hair/types';
import type { VolumeData } from '../../volume/types';
import { newPointCloud } from '../../pointcloud/data';
import { newHairCurves } from '../../hair/data';
import { newVolume } from '../../volume/data';
import { readVdb } from '../../volume/vdb/reader';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { ATTR_TYPE_5X, AttrReader, CD_STRUCT, CD_TYPE, KIND_SIZE, dataBlockOf, type Kind } from './mesh';

/** 5.x attribute domains by index */
const DOMAIN_5X = ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE', 'LAYER'];

interface RawAttr {
  name: string;
  domain: string;
  kind: Kind;
  offset: number;
  stored: number;
}

/** Generic attributes of a geometry holder (`attribute_storage`, else the given CustomData fields). */
export function geometryAttributes(holder: BStruct, ctx: Ctx, counts: Record<string, number>, legacy: [string, string][], owner: string): { attrs: RawAttr[]; reader: AttrReader } {
  const attrs: RawAttr[] = [];
  const as = holder.sub('attribute_storage');
  const n = as?.num('dna_attributes_num') ?? 0;
  if (as && n > 0)
    for (const a of as.refArray('dna_attributes', n)) {
      const name = a.cstr('name');
      const kind = ATTR_TYPE_5X[a.num('data_type')];
      const domain = DOMAIN_5X[a.num('domain')];
      if (!kind || !domain || counts[domain] === undefined) {
        if (!name.startsWith('.')) ctx.warn.add('Attributes with unsupported type/domain skipped', `${owner}: ${name}`);
        continue;
      }
      const data = a.at(a.ptr('data'));
      if (!data) continue;
      const raw = dataBlockOf(ctx, data, 'data');
      const isArray = data.type === 'AttributeArray' && !data.num('is_single');
      const stored = isArray ? data.num('size') : 1;
      if (!raw || raw.len < stored * KIND_SIZE[kind]) continue;
      attrs.push({ name, domain, kind, offset: raw.offset, stored });
    }
  for (const [field, domain] of legacy) {
    const cd = holder.sub(field);
    if (!cd) continue;
    for (const l of cd.refArray('layers', cd.num('totlayer'))) {
      const addr = l.ptr('data');
      if (addr === 0) continue;
      const hit = ctx.f.blockAt(addr, l.block);
      if (!hit) continue;
      const st = ctx.f.structOf(hit.block.sdna);
      const kind = CD_STRUCT[st && st.size > 0 ? st.type : ''] ?? CD_TYPE[l.num('type')];
      const name = l.str('name');
      if (!kind || attrs.some((x) => x.name === name && x.domain === domain)) continue;
      const count = counts[domain] ?? 0;
      if (hit.block.len - hit.delta < count * KIND_SIZE[kind]) continue;
      attrs.push({ name, domain, kind, offset: hit.block.offset + hit.delta, stored: count });
    }
  }
  return { attrs, reader: new AttrReader(ctx, counts) };
}

const DATA_TYPE: Record<Kind, DataType> = { bool: 'BOOLEAN', int8: 'INT8', int32: 'INT', int2: 'INT', int16_2d: 'INT', float: 'FLOAT', float2: 'FLOAT2', float3: 'FLOAT_VECTOR', color: 'FLOAT_COLOR', bytecolor: 'FLOAT_COLOR', quat: 'QUATERNION', float4x4: 'FLOAT4X4' };

function toArray(kind: Kind, v: Float64Array): AttrArray {
  if (kind === 'bool' || kind === 'int8') return Uint8Array.from(v);
  if (kind === 'int32') return Int32Array.from(v);
  if (kind === 'int2' || kind === 'int16_2d') {
    // pairs of ints have no generic type here: keep the first component
    const out = new Int32Array(v.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = v[i * 2];
    return out;
  }
  return Float32Array.from(v);
}

export function convertPointCloud(pc: BStruct, ctx: Ctx): PointCloudData {
  const data = newPointCloud(pc.idName);
  const n = Math.max(0, pc.has('totpoint') ? pc.num('totpoint') : pc.has('point_num') ? pc.num('point_num') : pc.num('point_size'));
  const { attrs, reader } = geometryAttributes(pc, ctx, { POINT: n }, [['pdata', 'POINT']], pc.idName);
  const pos = attrs.find((a) => a.name === 'position' && a.domain === 'POINT');
  const pv = pos ? reader.read(pos) : null;
  data.positions = pv ? Float32Array.from(pv) : new Float32Array(n * 3);
  data.attributes = [];
  for (const a of attrs) {
    if (a === pos) continue;
    const v = reader.read(a);
    if (!v) continue;
    data.attributes.push({ name: a.name, data_type: DATA_TYPE[a.kind], data: toArray(a.kind, v) });
  }
  if (!data.attributes.some((a) => a.name === 'radius')) data.attributes.push({ name: 'radius', data_type: 'FLOAT', data: new Float32Array(n).fill(0.01) });
  data.materials = pc.ptrArray('mat', Math.max(0, pc.num('totcol'))).map((a) => (a === 0 ? null : ctx.material(pc.at(a))));
  return data;
}

export function convertHairCurves(cv: BStruct, ctx: Ctx): HairCurvesData {
  const data = newHairCurves(cv.idName);
  const g = cv.sub('geometry');
  if (!g) return data;
  // field names differ between file versions
  const np = Math.max(0, g.has('point_num') ? g.num('point_num') : g.num('point_size')),
    nc = Math.max(0, g.has('curve_num') ? g.num('curve_num') : g.num('curve_size'));
  const offs = nc > 0 ? ctx.f.array(g.ptr('curve_offsets'), 'i32', nc + 1, g.block) : [0];
  data.curve_offsets = Uint32Array.from(offs ?? Array.from({ length: nc + 1 }, (_, i) => i));
  const { attrs, reader } = geometryAttributes(
    g,
    ctx,
    { POINT: np, CURVE: nc },
    [
      ['point_data', 'POINT'],
      ['curve_data', 'CURVE'],
    ],
    cv.idName,
  );
  const pos = attrs.find((a) => a.name === 'position' && a.domain === 'POINT');
  const pv = pos ? reader.read(pos) : null;
  data.positions = pv ? Float32Array.from(pv) : new Float32Array(np * 3);
  const keep: HairAttribute[] = [];
  for (const a of attrs) {
    if (a === pos || (a.domain !== 'POINT' && a.domain !== 'CURVE')) continue;
    const v = reader.read(a);
    if (!v) continue;
    keep.push({ name: a.name, domain: a.domain as 'POINT', data_type: DATA_TYPE[a.kind], data: toArray(a.kind, v) });
  }
  data.attributes = keep;
  const surf = cv.ref('surface');
  data.surface = surf ? ctx.objectRef(surf) : null;
  data.surface_uv_map = cv.cstr('surface_uv_map');
  const sym = cv.num('symmetry');
  data.use_mirror_x = (sym & 1) !== 0;
  data.use_mirror_y = (sym & 2) !== 0;
  data.use_mirror_z = (sym & 4) !== 0;
  data.materials = cv.ptrArray('mat', Math.max(0, cv.num('totcol'))).map((a) => (a === 0 ? null : ctx.material(cv.at(a))));
  return data;
}

export function convertVolume(vo: BStruct, ctx: Ctx): VolumeData {
  const data = newVolume(vo.idName);
  const path = vo.str('filepath');
  data.filepath = path.replace(/^.*[\\/]/, '');
  const pf = vo.ref('packedfile');
  const size = pf?.num('size') ?? 0;
  const bytes = pf && size > 0 ? ctx.f.bytesAt(pf.ptr('data'), size, pf.block) : null;
  if (bytes) {
    try {
      const r = readVdb(bytes);
      data.grids = r.grids;
      for (const w of r.warnings) ctx.warn.add('Volume grids', `${vo.idName}: ${w}`);
    } catch (e) {
      ctx.warn.add('Packed volume files that could not be read', `${vo.idName} (${e instanceof Error ? e.message : String(e)})`);
    }
  } else if (path) ctx.warn.add('Volume files are not packed in the .blend file (add the .vdb with File ▸ Import ▸ OpenVDB)', `${vo.idName} (${path})`);
  data.materials = vo.ptrArray('mat', Math.max(0, vo.num('totcol'))).map((a) => (a === 0 ? null : ctx.material(vo.at(a))));
  return data;
}

