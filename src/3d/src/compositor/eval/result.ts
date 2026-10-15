// Compositor values: single values (constants) or images living on the GPU in a domain.
//
// A domain is an image size plus a 2D affine transform placing the image's centred pixel space
// in the compositing plane (transform nodes only change the
// transform; pixels are resampled — "realized" — when an operation needs inputs on a common
// domain, or at the outputs).
import type { Texture } from '../gpu/gpu';
import type { SocketValue } from '../../data/types';

export type DataType = 'FLOAT' | 'VECTOR' | 'RGBA' | 'INT' | 'BOOLEAN' | 'MENU' | 'STRING';

/** Affine transform [a, b, c, d, tx, ty]: x' = a·x + c·y + tx, y' = b·x + d·y + ty. */
export type Xform = [number, number, number, number, number, number];

export const IDENTITY: Xform = [1, 0, 0, 1, 0, 0];

export function xfMul(p: Xform, q: Xform): Xform {
  return [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
}

export function xfInvert(m: Xform): Xform {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [0, 0, 0, 0, 0, 0];
  const ia = m[3] / det,
    ib = -m[1] / det,
    ic = -m[2] / det,
    id = m[0] / det;
  return [ia, ib, ic, id, -(ia * m[4] + ic * m[5]), -(ib * m[4] + id * m[5])];
}

export const xfTranslate = (x: number, y: number): Xform => [1, 0, 0, 1, x, y];
export const xfRotate = (a: number): Xform => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
export const xfScale = (x: number, y: number): Xform => [x, 0, 0, y, 0, 0];

export function xfEqual(a: Xform, b: Xform, eps = 1e-6) {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

export function xfApply(m: Xform, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface Domain {
  w: number;
  h: number;
  xf: Xform;
}

export function domainEqual(a: Domain, b: Domain) {
  return a.w === b.w && a.h === b.h && xfEqual(a.xf, b.xf);
}

/** Axis-aligned bounding domain of a transformed domain (centred, identity transform). */
export function boundingDomain(d: Domain): Domain {
  const m: Xform = [d.xf[0], d.xf[1], d.xf[2], d.xf[3], 0, 0];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of [
    [-d.w / 2, -d.h / 2],
    [d.w / 2, -d.h / 2],
    [-d.w / 2, d.h / 2],
    [d.w / 2, d.h / 2],
  ]) {
    const [px, py] = xfApply(m, x, y);
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  return {
    w: Math.max(1, Math.round(x1 - x0)),
    h: Math.max(1, Math.round(y1 - y0)),
    xf: [...IDENTITY] as Xform,
  };
}

export interface Sampling {
  /** 0 nearest, 1 bilinear, 2 bicubic, 3 anisotropic */
  interp: number;
  /** 0 clip, 1 extend, 2 repeat */
  extX: number;
  extY: number;
}

export const DEFAULT_SAMPLING: Sampling = { interp: 1, extX: 0, extY: 0 };

export class Result {
  /** CPU value of a single value (when known) */
  value?: SocketValue;
  /** GPU pixels: an image (with `domain`) or a 1×1 single value computed on the GPU */
  tex?: Texture;
  domain?: Domain;
  sampling: Sampling = { ...DEFAULT_SAMPLING };

  constructor(public type: DataType) {}

  get isImage() {
    return !!this.domain;
  }

  static single(type: DataType, value: SocketValue): Result {
    const r = new Result(type);
    r.value = value;
    return r;
  }

  static image(type: DataType, tex: Texture, domain: Domain, sampling?: Sampling): Result {
    const r = new Result(type);
    r.tex = tex;
    r.domain = { w: domain.w, h: domain.h, xf: [...domain.xf] as Xform };
    if (sampling) r.sampling = { ...sampling };
    return r;
  }

  /** Same pixels with another transform / sampling (transform nodes). */
  withDomain(domain: Domain, sampling?: Sampling): Result {
    const r = new Result(this.type);
    r.tex = this.tex;
    r.domain = domain;
    r.sampling = { ...(sampling ?? this.sampling) };
    r.value = this.value;
    return r;
  }
}

// ---------------------------------------------------------------------------
// Single value conversions (CPU; the GPU equivalents live in eval/convert.ts)

export const LUMA = [0.2126, 0.7152, 0.0722];

export function asVec4(type: DataType, v: SocketValue): [number, number, number, number] {
  if (Array.isArray(v)) {
    if (type === 'RGBA') return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1];
    return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0];
  }
  const f = typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : 0;
  if (type === 'FLOAT' || type === 'INT' || type === 'BOOLEAN') return [f, f, f, 1];
  return [f, f, f, type === 'RGBA' ? 1 : 0];
}

/** Implicit conversion of a single value between socket types (compositor rules). */
export function convertValue(v: SocketValue, from: DataType, to: DataType): SocketValue {
  if (from === to) return Array.isArray(v) ? [...v] : v;
  const num = (x: SocketValue) => (typeof x === 'boolean' ? (x ? 1 : 0) : typeof x === 'number' ? x : 0);
  const arr = Array.isArray(v) ? v : null;
  let f: number;
  if (from === 'RGBA') f = arr ? arr[0] * LUMA[0] + arr[1] * LUMA[1] + arr[2] * LUMA[2] : num(v);
  else if (from === 'VECTOR') f = arr ? (arr[0] + arr[1] + (arr.length > 2 ? arr[2] : 0)) / (arr.length > 2 ? 3 : 2) : num(v);
  else f = num(v);
  switch (to) {
    case 'FLOAT':
      return f;
    case 'INT':
      return Math.trunc(f);
    case 'BOOLEAN':
      return f > 0;
    case 'VECTOR':
      if (from === 'RGBA' && arr) return [arr[0], arr[1], arr[2]];
      return [f, f, f];
    case 'RGBA':
      if (from === 'VECTOR' && arr) return [arr[0], arr[1], arr[2] ?? 0, 1];
      return [f, f, f, 1];
    default:
      return v;
  }
}
