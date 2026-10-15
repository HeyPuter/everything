// Fields: lazily evaluated functions over the elements of a geometry domain.
//
// A field is evaluated in a context (component + domain). Evaluation is vectorized: every field
// produces a typed array for the whole domain, or a single value (`single`) when it does not vary.
// Inputs (Position, Index, named attributes, …) read from the context's component; function
// fields (math, mix, noise, …) combine evaluated inputs with a kernel. Constant inputs are folded
// at construction time so single-value sockets can still be read from fields.
import type { AttrArray, Domain, FieldType } from './types';
import { fieldComps } from './types';
import type { Component } from './geometry';

export interface Evaluated {
  data: AttrArray;
  /** one value for all elements */
  single: boolean;
}

export interface FieldContext {
  comp: Component;
  domain: Domain;
  size: number;
  cache: Map<Field, Evaluated>;
}

export type Scalar = number | boolean | number[];

export function allocField(type: FieldType, n: number): AttrArray {
  if (type === 'INT') return new Int32Array(n);
  if (type === 'BOOLEAN') return new Uint8Array(n);
  return new Float32Array(n * fieldComps(type));
}

export abstract class Field {
  constructor(public readonly type: FieldType) {}
  protected abstract compute(ctx: FieldContext): Evaluated;
  /** evaluate with per-context caching (fields shared by several consumers are computed once) */
  eval(ctx: FieldContext): Evaluated {
    let r = ctx.cache.get(this);
    if (!r) {
      r = this.compute(ctx);
      ctx.cache.set(this, r);
    }
    return r;
  }
  /** fields that read the geometry (inputs) or depend on such fields */
  get dependsOnContext(): boolean {
    return true;
  }
}

export class ConstField extends Field {
  readonly data: AttrArray;
  constructor(
    type: FieldType,
    public readonly value: Scalar,
  ) {
    super(type);
    this.data = allocField(type, 1);
    writeScalar(this.data, type, 0, value);
  }
  protected compute(): Evaluated {
    return { data: this.data, single: true };
  }
  get dependsOnContext() {
    return false;
  }
}

export function writeScalar(out: AttrArray, type: FieldType, i: number, v: Scalar) {
  const c = fieldComps(type);
  if (c === 1) {
    const x = Array.isArray(v) ? (v[0] ?? 0) : typeof v === 'boolean' ? (v ? 1 : 0) : v;
    out[i] = type === 'BOOLEAN' ? (x ? 1 : 0) : type === 'INT' ? Math.trunc(x) : x;
  } else if (type === 'MATRIX') {
    for (let k = 0; k < 16; k++) out[i * 16 + k] = Array.isArray(v) && v.length === 16 ? v[k] : k % 5 === 0 ? 1 : 0;
  } else {
    const arr = Array.isArray(v) ? v : [Number(v), Number(v), Number(v), 1];
    for (let k = 0; k < c; k++) out[i * c + k] = arr[k] ?? (k === 3 ? 1 : 0);
  }
}

export function readScalar(e: { data: AttrArray }, type: FieldType, i = 0): Scalar {
  const c = fieldComps(type);
  if (c === 1) return type === 'BOOLEAN' ? !!e.data[i] : e.data[i];
  return Array.from(e.data.subarray(i * c, i * c + c));
}

export type Kernel = (ins: Evaluated[], out: AttrArray, n: number) => void;

/** Function of other fields (vectorized kernel). */
export class FnField extends Field {
  constructor(
    type: FieldType,
    public readonly inputs: Field[],
    private readonly kernel: Kernel,
  ) {
    super(type);
  }
  protected compute(ctx: FieldContext): Evaluated {
    const ins = this.inputs.map((f) => f.eval(ctx));
    if (ins.every((e) => e.single)) {
      const out = allocField(this.type, 1);
      this.kernel(ins, out, 1);
      return { data: out, single: true };
    }
    const out = allocField(this.type, ctx.size);
    this.kernel(ins, out, ctx.size);
    return { data: out, single: false };
  }
}

/** Field read from the context's geometry. */
export class InputField extends Field {
  constructor(
    type: FieldType,
    public readonly key: string,
    private readonly fn: (ctx: FieldContext) => Evaluated,
  ) {
    super(type);
  }
  protected compute(ctx: FieldContext): Evaluated {
    return this.fn(ctx);
  }
}

/** Build a function field, folding constants. */
export function fnField(type: FieldType, inputs: Field[], kernel: Kernel): Field {
  if (inputs.every((f) => f instanceof ConstField)) {
    const out = allocField(type, 1);
    kernel(
      inputs.map((f) => ({ data: (f as ConstField).data, single: true })),
      out,
      1,
    );
    return new ConstField(type, readScalar({ data: out }, type));
  }
  return new FnField(type, inputs, kernel);
}

export const constOf = (f: Field): Scalar | undefined => (f instanceof ConstField ? f.value : undefined);

// ---------------------------------------------------------------------------
// Conversions between field types (implicit socket conversions)

export function convertField(f: Field, to: FieldType): Field {
  const from = f.type;
  if (from === to) return f;
  if (from === 'VECTOR' && to === 'ROTATION') return fnField(to, [f], (ins, out, n) => out.set(ins[0].data.subarray(0, n * 3)));
  // a rotation read as a vector gives its canonical Euler angles
  if (from === 'ROTATION' && to === 'VECTOR')
    return fnField(to, [f], (ins, out, n) => {
      const d = ins[0].data,
        m = new Float64Array(16);
      for (let i = 0; i < n; i++) {
        eulerToMatrix(d[i * 3], d[i * 3 + 1], d[i * 3 + 2], m, 0);
        matrixToEuler(m, 0, out, i * 3);
      }
    });
  if (from === 'MATRIX' || to === 'MATRIX') return convertMatrixField(f, to);
  return fnField(to, [f], (ins, out, n) => {
    const a = ins[0],
      s = a.single ? 0 : 1,
      d = a.data;
    const fc = fieldComps(from),
      tc = fieldComps(to);
    for (let i = 0; i < n; i++) {
      const j = i * s;
      if (fc === 1) {
        const v = d[j];
        if (tc === 1) out[i] = to === 'BOOLEAN' ? (v > 0 ? 1 : 0) : to === 'INT' ? Math.trunc(v) : v;
        else {
          for (let k = 0; k < 3; k++) out[i * tc + k] = v;
          if (tc === 4) out[i * 4 + 3] = 1;
        }
      } else if (tc === 1) {
        let v: number;
        if (from === 'RGBA') v = d[j * 4] * 0.2126 + d[j * 4 + 1] * 0.7152 + d[j * 4 + 2] * 0.0722;
        else v = (d[j * 3] + d[j * 3 + 1] + d[j * 3 + 2]) / 3;
        if (to === 'BOOLEAN') out[i] = from === 'RGBA' ? (v > 0 ? 1 : 0) : d[j * 3] !== 0 || d[j * 3 + 1] !== 0 || d[j * 3 + 2] !== 0 ? 1 : 0;
        else out[i] = to === 'INT' ? Math.trunc(v) : v;
      } else {
        for (let k = 0; k < 3; k++) out[i * tc + k] = d[j * fc + k];
        if (tc === 4) out[i * 4 + 3] = fc === 4 ? d[j * 4 + 3] : 1;
      }
    }
  });
}

/** Rotation ↔ matrix conversions; other types do not convert to or from matrices (identity / zero). */
function convertMatrixField(f: Field, to: FieldType): Field {
  const from = f.type;
  if (from === 'ROTATION' && to === 'MATRIX')
    return fnField('MATRIX', [f], ([a], out, n) => {
      const s = a.single ? 0 : 3;
      for (let i = 0; i < n; i++) eulerToMatrix(a.data[i * s], a.data[i * s + 1], a.data[i * s + 2], out, i * 16);
    });
  if (from === 'MATRIX' && to === 'ROTATION')
    return fnField('ROTATION', [f], ([a], out, n) => {
      const s = a.single ? 0 : 16;
      for (let i = 0; i < n; i++) matrixToEuler(a.data, i * s, out, i * 3);
    });
  return new ConstField(to, to === 'MATRIX' ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : 0);
}

/** XYZ Euler angles to a column-major 4×4 rotation matrix. */
export function eulerToMatrix(x: number, y: number, z: number, out: ArrayLike<number> & { [i: number]: number }, o = 0) {
  const cx = Math.cos(x),
    sx = Math.sin(x),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cz = Math.cos(z),
    sz = Math.sin(z);
  out[o] = cy * cz;
  out[o + 1] = cy * sz;
  out[o + 2] = -sy;
  out[o + 3] = 0;
  out[o + 4] = sx * sy * cz - cx * sz;
  out[o + 5] = sx * sy * sz + cx * cz;
  out[o + 6] = sx * cy;
  out[o + 7] = 0;
  out[o + 8] = cx * sy * cz + sx * sz;
  out[o + 9] = cx * sy * sz - sx * cz;
  out[o + 10] = cx * cy;
  out[o + 11] = 0;
  out[o + 12] = out[o + 13] = out[o + 14] = 0;
  out[o + 15] = 1;
}

/**
 * Rotation part of a column-major 4×4 (or 3×3 with `stride` 3) matrix to XYZ Euler angles. The
 * columns are normalized first; of the two equivalent angle sets the one with the smaller total
 * magnitude is chosen.
 */
export function matrixToEuler(m: ArrayLike<number>, o: number, out: { [i: number]: number }, oo: number, stride = 4) {
  const col = (c: number) => {
    const x = m[o + c * stride],
      y = m[o + c * stride + 1],
      z = m[o + c * stride + 2];
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  const c0 = col(0),
    c1 = col(1),
    c2 = col(2);
  const cy = Math.hypot(c0[0], c0[1]);
  let a: number[], b: number[];
  if (cy > 16 * 1.1920929e-7) {
    a = [Math.atan2(c1[2], c2[2]), Math.atan2(-c0[2], cy), Math.atan2(c0[1], c0[0])];
    b = [Math.atan2(-c1[2], -c2[2]), Math.atan2(-c0[2], -cy), Math.atan2(-c0[1], -c0[0])];
  } else {
    a = b = [Math.atan2(-c2[1], c1[1]), Math.atan2(-c0[2], cy), 0];
  }
  const r = Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]) > Math.abs(b[0]) + Math.abs(b[1]) + Math.abs(b[2]) ? b : a;
  out[oo] = r[0];
  out[oo + 1] = r[1];
  out[oo + 2] = r[2];
}

export function convertScalar(v: Scalar, from: FieldType, to: FieldType): Scalar {
  const f = convertField(new ConstField(from, v), to) as ConstField;
  return f.value;
}

// ---------------------------------------------------------------------------
// Evaluation entry points

export function makeContext(comp: Component, domain: Domain): FieldContext {
  return { comp, domain, size: comp.domainSize(domain), cache: new Map() };
}

/** Evaluate a field to a full array of the domain size. */
export function evalFull(f: Field, ctx: FieldContext): AttrArray {
  const e = f.eval(ctx);
  if (!e.single) return e.data;
  const c = fieldComps(f.type);
  const out = allocField(f.type, ctx.size);
  if (c === 1) out.fill(e.data[0]);
  else for (let i = 0; i < ctx.size; i++) for (let k = 0; k < c; k++) out[i * c + k] = e.data[k];
  return out;
}

/** Evaluate a boolean selection; null means "everything selected". */
export function evalSelection(f: Field | undefined, ctx: FieldContext): Uint8Array | null {
  if (!f) return null;
  const e = convertField(f, 'BOOLEAN').eval(ctx);
  if (e.single) return e.data[0] ? null : new Uint8Array(ctx.size);
  return e.data as Uint8Array;
}

/** Number of selected elements of a selection. */
export function countSelected(sel: Uint8Array | null, n: number) {
  if (!sel) return n;
  let c = 0;
  for (let i = 0; i < n; i++) if (sel[i]) c++;
  return c;
}

export const isField = (v: unknown): v is Field => v instanceof Field;
