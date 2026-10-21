// Texture Mapping of shader texture nodes: an axis remap ("projection") and a location / rotation /
// scale transform applied to the texture coordinates before the texture is evaluated. Stored as
// node props (tm_*); absent props mean the identity mapping.
import type { NodeData } from '../data/types';

export type TexMappingType = 'POINT' | 'TEXTURE' | 'VECTOR' | 'NORMAL';
export type TexAxis = 'NONE' | 'X' | 'Y' | 'Z';

export interface TexMapping {
  vector_type: TexMappingType;
  translation: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  mapping_x: TexAxis;
  mapping_y: TexAxis;
  mapping_z: TexAxis;
}

/** Shader node types that carry a texture mapping. */
export const TEX_MAPPING_NODES = new Set([
  'ShaderNodeTexBrick',
  'ShaderNodeTexChecker',
  'ShaderNodeTexEnvironment',
  'ShaderNodeTexGabor',
  'ShaderNodeTexGradient',
  'ShaderNodeTexImage',
  'ShaderNodeTexMagic',
  'ShaderNodeTexNoise',
  'ShaderNodeTexSky',
  'ShaderNodeTexVoronoi',
  'ShaderNodeTexWave',
  'ShaderNodeTexWhiteNoise',
]);

export const DEFAULT_TEX_MAPPING: TexMapping = {
  vector_type: 'POINT',
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  mapping_x: 'X',
  mapping_y: 'Y',
  mapping_z: 'Z',
};

const vec3 = (v: unknown, d: [number, number, number]): [number, number, number] => (Array.isArray(v) && v.length >= 3 ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0] : d);

/** The node's mapping (defaults filled in). */
export function texMapping(n: NodeData): TexMapping {
  const p = n.props;
  const axis = (k: string, d: TexAxis) => (['NONE', 'X', 'Y', 'Z'].includes(String(p[k])) ? (p[k] as TexAxis) : d);
  return {
    vector_type: (['POINT', 'TEXTURE', 'VECTOR', 'NORMAL'].includes(String(p.tm_vector_type)) ? p.tm_vector_type : 'POINT') as TexMappingType,
    translation: vec3(p.tm_translation, [0, 0, 0]),
    rotation: vec3(p.tm_rotation, [0, 0, 0]),
    scale: vec3(p.tm_scale, [1, 1, 1]),
    mapping_x: axis('tm_mapping_x', 'X'),
    mapping_y: axis('tm_mapping_y', 'Y'),
    mapping_z: axis('tm_mapping_z', 'Z'),
  };
}

export function setTexMapping(n: NodeData, m: Partial<TexMapping>) {
  const p = n.props;
  if (m.vector_type) p.tm_vector_type = m.vector_type;
  if (m.translation) p.tm_translation = [...m.translation];
  if (m.rotation) p.tm_rotation = [...m.rotation];
  if (m.scale) p.tm_scale = [...m.scale];
  if (m.mapping_x) p.tm_mapping_x = m.mapping_x;
  if (m.mapping_y) p.tm_mapping_y = m.mapping_y;
  if (m.mapping_z) p.tm_mapping_z = m.mapping_z;
}

/** Whether the mapping changes coordinates at all. */
export function isIdentityMapping(m: TexMapping): boolean {
  return (
    m.vector_type !== 'NORMAL' &&
    m.translation.every((x) => x === 0) &&
    m.rotation.every((x) => x === 0) &&
    m.scale.every((x) => x === 1) &&
    m.mapping_x === 'X' &&
    m.mapping_y === 'Y' &&
    m.mapping_z === 'Z'
  );
}

type M3 = number[]; // 3×3 row-major

const mul3 = (a: M3, b: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};
const mulv = (a: M3, v: number[]) => [0, 1, 2].map((r) => a[r * 3] * v[0] + a[r * 3 + 1] * v[1] + a[r * 3 + 2] * v[2]);

function inverse3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-20) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((x) => x / det);
}
const transpose3 = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Rotation matrix of XYZ Euler angles (X applied first). */
export function eulerXYZ(r: [number, number, number]): M3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(r[0]), Math.sin(r[0]), Math.cos(r[1]), Math.sin(r[1]), Math.cos(r[2]), Math.sin(r[2])];
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(Rz, mul3(Ry, Rx));
}

/**
 * The mapping as `out = L · in + t` (3×3 row-major L, translation t), with the axis remap
 * applied first. NORMAL mappings are normalized after the transform by the caller.
 */
export function texMappingTransform(m: TexMapping): { L: M3; t: [number, number, number] } {
  const axis = (a: TexAxis) => (a === 'X' ? [1, 0, 0] : a === 'Y' ? [0, 1, 0] : a === 'Z' ? [0, 0, 1] : [0, 0, 0]);
  const P: M3 = [...axis(m.mapping_x), ...axis(m.mapping_y), ...axis(m.mapping_z)];
  const R = eulerXYZ(m.rotation);
  const S: M3 = [m.scale[0], 0, 0, 0, m.scale[1], 0, 0, 0, m.scale[2]];
  const RS = mul3(R, S);
  let L: M3,
    t: [number, number, number] = [0, 0, 0];
  switch (m.vector_type) {
    case 'TEXTURE': {
      // inverse of (translate · rotate · scale)
      L = inverse3(RS);
      const it = mulv(L, m.translation);
      t = [-it[0], -it[1], -it[2]];
      break;
    }
    case 'VECTOR':
      L = RS;
      break;
    case 'NORMAL':
      L = transpose3(inverse3(RS));
      break;
    default:
      L = RS;
      t = [...m.translation];
  }
  return { L: mul3(L, P), t };
}

/** Apply a mapping to a point (CPU). */
export function applyTexMapping(m: TexMapping, v: [number, number, number]): [number, number, number] {
  const { L, t } = texMappingTransform(m);
  const o = mulv(L, v);
  const r: [number, number, number] = [o[0] + t[0], o[1] + t[1], o[2] + t[2]];
  if (m.vector_type === 'NORMAL') {
    const l = Math.hypot(r[0], r[1], r[2]) || 1;
    return [r[0] / l, r[1] / l, r[2] / l];
  }
  return r;
}
