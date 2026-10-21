// Generic mesh attributes: sizes, widths and storage of each data type, domain sizes, and conversion
// between domains and data types (pure, unit tested).
import type { AttributeType, MeshAttribute, MeshData } from '../data/types';

export const ATTRIBUTE_TYPES: [AttributeType, string, string][] = [
  ['FLOAT', 'Float', 'Floating-point value'],
  ['INT', 'Integer', '32-bit integer'],
  ['INT8', '8-Bit Integer', 'Smaller integer with a range from -128 to 127'],
  ['BOOLEAN', 'Boolean', 'True or false'],
  ['FLOAT2', '2D Vector', '2D vector with floating-point values'],
  ['INT32_2D', '2D Integer Vector', '2D vector with 32-bit integer values'],
  ['FLOAT_VECTOR', 'Vector', '3D vector with floating-point values'],
  ['QUATERNION', 'Quaternion', 'Floating-point quaternion rotation'],
  ['FLOAT4X4', '4x4 Matrix', 'Floating-point 4×4 matrix'],
];

export const ATTRIBUTE_DOMAINS: [MeshAttribute['domain'], string][] = [
  ['POINT', 'Vertex'],
  ['EDGE', 'Edge'],
  ['FACE', 'Face'],
  ['CORNER', 'Face Corner'],
];

export function attrWidth(t: AttributeType): number {
  return t === 'FLOAT2' || t === 'INT32_2D' ? 2 : t === 'FLOAT_VECTOR' ? 3 : t === 'QUATERNION' ? 4 : t === 'FLOAT4X4' ? 16 : 1;
}

/** Integer and boolean types: interpolation picks a source value instead of mixing. */
export const isDiscreteAttr = (t: AttributeType) => t === 'INT' || t === 'INT8' || t === 'BOOLEAN' || t === 'INT32_2D';

export function makeAttrArray(t: AttributeType, n: number): Float32Array | Int32Array | Uint8Array {
  return t === 'BOOLEAN' ? new Uint8Array(n) : t === 'INT' || t === 'INT8' || t === 'INT32_2D' ? new Int32Array(n) : new Float32Array(n);
}

/** Elements of a domain (EDGE: face corners followed by loose edges, see MeshAttribute). */
export function attrDomainSize(me: Pick<MeshData, 'positions' | 'offsets' | 'indices' | 'loose_edges'>, domain: MeshAttribute['domain']): number {
  if (domain === 'POINT') return me.positions.length / 3;
  if (domain === 'FACE') return Math.max(0, me.offsets.length - 1);
  if (domain === 'CORNER') return me.indices.length;
  return me.indices.length + (me.loose_edges?.length ?? 0) / 2;
}

/** The default value of a type (identity for quaternions and matrices). */
export function attrDefault(t: AttributeType): number[] {
  if (t === 'QUATERNION') return [1, 0, 0, 0];
  if (t === 'FLOAT4X4') return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return new Array(attrWidth(t)).fill(0);
}

/** Attributes whose size fits the mesh (others are left over from topology changes outside Edit Mode). */
export function validAttributes(me: MeshData): MeshAttribute[] {
  return (me.attributes ?? []).filter((a) => a.data.length === attrDomainSize(me, a.domain) * attrWidth(a.data_type));
}

export function newAttribute(me: MeshData, name: string, domain: MeshAttribute['domain'], data_type: AttributeType): MeshAttribute {
  const n = attrDomainSize(me, domain);
  const w = attrWidth(data_type);
  const data = makeAttrArray(data_type, n * w);
  const d = attrDefault(data_type);
  if (d.some(Boolean)) for (let i = 0; i < n; i++) data.set(d, i * w);
  return { name, domain, data_type, data };
}

/** Convert one value tuple between types (vectors pad / truncate, booleans threshold at 0.5 like a cast to "is non-zero"). */
function castValue(v: number[], from: AttributeType, to: AttributeType): number[] {
  const w = attrWidth(to);
  if (to === 'BOOLEAN') return [v.some((x) => x !== 0) ? 1 : 0];
  if (from === 'BOOLEAN') return Array.from({ length: w }, () => v[0]);
  const out = Array.from({ length: w }, (_, i) => (i < v.length ? v[i] : attrDefault(to)[i] ?? 0));
  if (to === 'INT' || to === 'INT32_2D') return out.map((x) => Math.trunc(x));
  if (to === 'INT8') return out.map((x) => Math.max(-128, Math.min(127, Math.trunc(x))));
  // a single value spreads over all components of a vector
  if (attrWidth(from) === 1 && w > 1 && to !== 'QUATERNION' && to !== 'FLOAT4X4') return out.map(() => v[0]);
  return out;
}

/** Vertex → face / corner / edge and back: averages for numbers, any-true for booleans. */
function mapDomain(me: MeshData, a: MeshAttribute, to: MeshAttribute['domain']): number[][] {
  const w = attrWidth(a.data_type);
  const val = (i: number) => Array.from(a.data.subarray(i * w, (i + 1) * w));
  const nf = me.offsets.length - 1;
  const nc = me.indices.length;
  const nv = me.positions.length / 3;
  const loose = me.loose_edges ?? new Uint32Array(0);
  // per corner: the corner's vertex, face, and the vertices of the edge starting there
  const cornerFace = new Int32Array(nc);
  for (let f = 0; f < nf; f++) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) cornerFace[c] = f;
  const cornerNext = (c: number) => {
    const f = cornerFace[c];
    return c + 1 < me.offsets[f + 1] ? c + 1 : me.offsets[f];
  };
  const avg = (vals: number[][]) => {
    if (!vals.length) return new Array(w).fill(0);
    if (a.data_type === 'BOOLEAN') return [vals.some((v) => v[0]) ? 1 : 0];
    const out = new Array(w).fill(0);
    for (const v of vals) for (let k = 0; k < w; k++) out[k] += v[k] / vals.length;
    return isDiscreteAttr(a.data_type) ? out.map(Math.round) : out;
  };
  const from = a.domain;
  if (from === to) return Array.from({ length: attrDomainSize(me, from) }, (_, i) => val(i));
  // gather to points first when needed
  const pointVals = (): number[][] => {
    if (from === 'POINT') return Array.from({ length: nv }, (_, i) => val(i));
    const acc: number[][][] = Array.from({ length: nv }, () => []);
    if (from === 'FACE') for (let c = 0; c < nc; c++) acc[me.indices[c]].push(val(cornerFace[c]));
    else if (from === 'CORNER') for (let c = 0; c < nc; c++) acc[me.indices[c]].push(val(c));
    else {
      for (let c = 0; c < nc; c++) {
        acc[me.indices[c]].push(val(c));
        acc[me.indices[cornerNext(c)]].push(val(c));
      }
      for (let i = 0; i + 1 < loose.length; i += 2) {
        acc[loose[i]].push(val(nc + i / 2));
        acc[loose[i + 1]].push(val(nc + i / 2));
      }
    }
    return acc.map(avg);
  };
  if (to === 'POINT') return pointVals();
  if (to === 'CORNER') {
    if (from === 'FACE') return Array.from({ length: nc }, (_, c) => val(cornerFace[c]));
    const pv = pointVals();
    return Array.from({ length: nc }, (_, c) => pv[me.indices[c]]);
  }
  if (to === 'FACE') {
    const out: number[][] = [];
    const pv = from === 'POINT' ? pointVals() : null;
    for (let f = 0; f < nf; f++) {
      const vals: number[][] = [];
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) vals.push(pv ? pv[me.indices[c]] : val(c));
      out.push(avg(vals));
    }
    return out;
  }
  // to EDGE: per corner + loose edges, from the edge's vertices (or the corner / face)
  const pv = from === 'POINT' || from === 'CORNER' || from === 'FACE' ? pointVals() : [];
  const out: number[][] = [];
  for (let c = 0; c < nc; c++) out.push(avg([pv[me.indices[c]], pv[me.indices[cornerNext(c)]]]));
  for (let i = 0; i + 1 < loose.length; i += 2) out.push(avg([pv[loose[i]], pv[loose[i + 1]]]));
  return out;
}

/** The attribute converted to another domain and / or data type. */
export function convertAttribute(me: MeshData, a: MeshAttribute, domain: MeshAttribute['domain'], data_type: AttributeType): MeshAttribute {
  const vals = mapDomain(me, a, domain).map((v) => castValue(v, a.data_type, data_type));
  const w = attrWidth(data_type);
  const data = makeAttrArray(data_type, vals.length * w);
  vals.forEach((v, i) => data.set(v, i * w));
  return { name: a.name, domain, data_type, data };
}

/** Per-element booleans of a boolean attribute mapped to vertices / faces (for selection). */
export function attributeTrue(me: MeshData, a: MeshAttribute, to: 'POINT' | 'FACE'): boolean[] {
  return Array.from(convertAttribute(me, a, to, 'BOOLEAN').data as ArrayLike<number>, (x) => !!x);
}

/** A name not used by any attribute or color attribute of the mesh. */
export function uniqueAttributeName(me: MeshData, base: string): string {
  const used = new Set([...(me.attributes ?? []).map((a) => a.name), ...me.color_attributes.map((c) => c.name), me.uv_map_name, 'position', 'sharp_face', 'sharp_edge', 'crease_edge', 'crease_vert', 'bevel_weight_edge', 'bevel_weight_vert', 'material_index']);
  if (!used.has(base)) return base;
  let i = 1;
  while (used.has(`${base}.${String(i).padStart(3, '0')}`)) i++;
  return `${base}.${String(i).padStart(3, '0')}`;
}
