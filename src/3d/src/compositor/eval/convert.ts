// GLSL encoding of compositor data types in RGBA32F textures and implicit conversions.
//
// Storage: FLOAT/INT/BOOLEAN → (v, v, v, 1); VECTOR → (x, y, z, w) (unused components 0);
// RGBA → premultiplied (r, g, b, a). Colours convert to floats by Rec.709 luminance, vectors by
// the average of their components (the compositor's implicit conversions).
import type { DataType } from './result';

export type GType = 'float' | 'vec3' | 'vec4';

export function gtypeOf(t: DataType): GType {
  return t === 'VECTOR' ? 'vec3' : t === 'RGBA' ? 'vec4' : 'float';
}

/** Expression reading texel expression `t` (a vec4) stored as `from`, as GLSL type `to`. */
export function readAs(t: string, from: DataType, to: GType): string {
  if (from === 'RGBA') return to === 'float' ? `cmpLuma((${t}).rgb)` : to === 'vec3' ? `(${t}).rgb` : `(${t})`;
  if (from === 'VECTOR') return to === 'float' ? `dot((${t}).xyz, vec3(1.0 / 3.0))` : to === 'vec3' ? `(${t}).xyz` : `vec4((${t}).xyz, 1.0)`;
  return to === 'float' ? `(${t}).r` : to === 'vec3' ? `vec3((${t}).r)` : `vec4(vec3((${t}).r), 1.0)`;
}

/** Expression packing a GLSL value of type `g` into the storage format of socket type `to`. */
export function pack(expr: string, g: GType, to: DataType): string {
  if (to === 'RGBA') return g === 'vec4' ? expr : g === 'vec3' ? `vec4(${expr}, 1.0)` : `vec4(vec3(${expr}), 1.0)`;
  if (to === 'VECTOR') return g === 'vec4' ? `vec4((${expr}).xyz, 0.0)` : g === 'vec3' ? `vec4(${expr}, 0.0)` : `vec4(vec3(${expr}), 0.0)`;
  const f = g === 'vec4' ? `cmpLuma((${expr}).rgb)` : g === 'vec3' ? `dot(${expr}, vec3(1.0 / 3.0))` : expr;
  if (to === 'INT') return `vec4(vec3(trunc(${f})), 1.0)`;
  if (to === 'BOOLEAN') return `vec4(vec3(${f} > 0.0 ? 1.0 : 0.0), 1.0)`;
  return `vec4(vec3(${f}), 1.0)`;
}
