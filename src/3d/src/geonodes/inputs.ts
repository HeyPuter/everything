// Built-in input fields: Position, Normal, Index, ID, named/anonymous attributes, …
import { InputField, allocField, type Evaluated, type FieldContext, Field } from './field';
import type { DataType, FieldType } from './types';
import { fieldTypeOfData, fieldComps, dataComps } from './types';
import { adaptDomain, readAttribute, type Component } from './geometry';
import { cornerNormals, edgeAngles, faceAreas, faceNormals, smoothFlags, vertexNormals } from './meshutil';
import { controlLengths, controlNormals, controlTangents } from './curves/curvedata';

const full = (data: Float32Array | Int32Array | Uint8Array): Evaluated => ({
  data,
  single: false,
});
const zeros = (type: FieldType, ctx: FieldContext): Evaluated => ({
  data: allocField(type, 1),
  single: true,
});

/** Convert attribute data of one data type to the requested field type (component-wise). */
export function attrToField(data: Float32Array | Int32Array | Uint8Array, from: DataType, to: FieldType, n: number): Float32Array | Int32Array | Uint8Array {
  const fc = dataComps(from),
    tc = fieldComps(to);
  const ft = fieldTypeOfData(from);
  if (ft === to && fc === tc) return data;
  const out = allocField(to, n);
  for (let i = 0; i < n; i++) {
    if (fc === 1) {
      const v = data[i];
      if (tc === 1) out[i] = to === 'BOOLEAN' ? (v ? 1 : 0) : to === 'INT' ? Math.trunc(v) : v;
      else {
        for (let k = 0; k < 3; k++) out[i * tc + k] = v;
        if (tc === 4) out[i * 4 + 3] = 1;
      }
    } else if (tc === 1) {
      let v = 0;
      if (from === 'FLOAT_COLOR') v = data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722;
      else {
        for (let k = 0; k < fc; k++) v += data[i * fc + k];
        v /= fc;
      }
      out[i] = to === 'BOOLEAN' ? (v ? 1 : 0) : to === 'INT' ? Math.trunc(v) : v;
    } else {
      for (let k = 0; k < Math.min(3, fc); k++) out[i * tc + k] = data[i * fc + k];
      if (tc === 4) out[i * 4 + 3] = fc === 4 ? data[i * 4 + 3] : 1;
    }
  }
  return out;
}

export const positionField = () =>
  new InputField('VECTOR', 'position', (ctx) => {
    const a = readAttribute(ctx.comp, 'position', ctx.domain);
    return a ? full(a.data) : zeros('VECTOR', ctx);
  });

export const indexField = () =>
  new InputField('INT', 'index', (ctx) => {
    const out = new Int32Array(ctx.size);
    for (let i = 0; i < ctx.size; i++) out[i] = i;
    return full(out);
  });

export const idField = () =>
  new InputField('INT', 'id', (ctx) => {
    const a = readAttribute(ctx.comp, 'id', ctx.domain);
    if (a) return full(attrToField(a.data, a.type, 'INT', ctx.size));
    const out = new Int32Array(ctx.size);
    for (let i = 0; i < ctx.size; i++) out[i] = i;
    return full(out);
  });

/** Named (or anonymous) attribute read on the context domain, converted to `type`. */
export function attributeField(name: string, type: FieldType, exists?: boolean): Field {
  return new InputField(exists ? 'BOOLEAN' : type, `attr:${name}:${type}:${exists ? 'e' : ''}`, (ctx) => {
    const a = readAttribute(ctx.comp, name, ctx.domain);
    if (exists) return { data: new Uint8Array([a ? 1 : 0]), single: true };
    if (!a) {
      const d = allocField(type, 1);
      if (type === 'RGBA') d[3] = 0;
      return { data: d, single: true };
    }
    return full(attrToField(a.data, a.type, type, ctx.size));
  });
}

export const normalField = (trueNormal = false) => new InputField('VECTOR', trueNormal ? 'true_normal' : 'normal', (ctx) => normalOn(ctx.comp, ctx.domain, ctx.size, trueNormal));

export function normalOn(c: Component, domain: FieldContext['domain'], size: number, trueNormal = false): Evaluated {
  if (c.kind === 'MESH') {
    if (domain === 'FACE') return full(faceNormals(c));
    if (domain === 'POINT') return full(vertexNormals(c));
    if (domain === 'CORNER') return full(trueNormal ? (adaptDomain(c, faceNormals(c), 'FLOAT_VECTOR', 'FACE', 'CORNER') as Float32Array) : cornerNormals(c));
    if (domain === 'EDGE') {
      const n = adaptDomain(c, faceNormals(c), 'FLOAT_VECTOR', 'FACE', 'EDGE') as Float32Array;
      for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l;
        n[i + 1] /= l;
        n[i + 2] /= l;
      }
      return full(n);
    }
  }
  if (c.kind === 'CURVES') {
    const n = controlNormals(c);
    if (domain === 'POINT') return full(n);
    return full(adaptDomain(c, n, 'FLOAT_VECTOR', 'POINT', domain) as Float32Array);
  }
  const out = new Float32Array(3);
  out[2] = 1;
  void size;
  return { data: out, single: true };
}

export const radiusField = () =>
  new InputField('FLOAT', 'radius', (ctx) => {
    const a = readAttribute(ctx.comp, 'radius', ctx.domain);
    if (a) return full(a.data);
    return {
      data: new Float32Array([ctx.comp.kind === 'POINTS' ? 0.01 : 1]),
      single: true,
    };
  });

export const materialIndexField = () =>
  new InputField('INT', 'material_index', (ctx) => {
    const a = readAttribute(ctx.comp, 'material_index', ctx.domain);
    return a ? full(attrToField(a.data, a.type, 'INT', ctx.size)) : zeros('INT', ctx);
  });

export const shadeSmoothField = () =>
  new InputField('BOOLEAN', 'shade_smooth', (ctx) => {
    if (ctx.comp.kind !== 'MESH') return zeros('BOOLEAN', ctx);
    const s = smoothFlags(ctx.comp);
    return full(adaptDomain(ctx.comp, s, 'BOOLEAN', 'FACE', ctx.domain));
  });

export const faceAreaField = () =>
  new InputField('FLOAT', 'face_area', (ctx) => {
    if (ctx.comp.kind !== 'MESH') return zeros('FLOAT', ctx);
    return full(adaptDomain(ctx.comp, faceAreas(ctx.comp), 'FLOAT', 'FACE', ctx.domain));
  });

export const edgeAngleField = (signed: boolean) =>
  new InputField('FLOAT', signed ? 'edge_angle_s' : 'edge_angle_u', (ctx) => {
    if (ctx.comp.kind !== 'MESH') return zeros('FLOAT', ctx);
    const a = edgeAngles(ctx.comp);
    return full(adaptDomain(ctx.comp, signed ? a.signed : a.unsigned, 'FLOAT', 'EDGE', ctx.domain));
  });

/** Spline Parameter: factor / length along the curve and point index within the curve. */
export const splineParameterField = (which: 'Factor' | 'Length' | 'Index') =>
  new InputField(which === 'Index' ? 'INT' : 'FLOAT', `spline_param:${which}`, (ctx) => {
    const c = ctx.comp;
    if (c.kind !== 'CURVES') return zeros(which === 'Index' ? 'INT' : 'FLOAT', ctx);
    if (ctx.domain === 'CURVE') {
      const out = which === 'Index' ? new Int32Array(ctx.size) : new Float32Array(ctx.size);
      if (which === 'Length') {
        const L = controlLengths(c).total;
        let acc = 0;
        for (let k = 0; k < c.curveCount; k++) {
          out[k] = acc;
          acc += L[k];
        }
      } else if (which === 'Factor') {
        const L = controlLengths(c).total;
        let total = 0;
        for (const l of L) total += l;
        let acc = 0;
        for (let k = 0; k < c.curveCount; k++) {
          out[k] = total ? acc / total : 0;
          acc += L[k];
        }
      } else for (let k = 0; k < c.curveCount; k++) out[k] = k;
      return full(out);
    }
    const { segment, total } = controlLengths(c);
    const out = which === 'Index' ? new Int32Array(c.pointCount) : new Float32Array(c.pointCount);
    for (let k = 0; k < c.curveCount; k++)
      for (let i = c.curveOffsets[k]; i < c.curveOffsets[k + 1]; i++) {
        if (which === 'Index') out[i] = i - c.curveOffsets[k];
        else if (which === 'Length') out[i] = segment[i];
        else out[i] = total[k] ? segment[i] / total[k] : 0;
      }
    return full(out);
  });

export const curveTangentField = () =>
  new InputField('VECTOR', 'curve_tangent', (ctx) => {
    if (ctx.comp.kind !== 'CURVES') return zeros('VECTOR', ctx);
    const t = controlTangents(ctx.comp);
    return full(ctx.domain === 'POINT' ? t : (adaptDomain(ctx.comp, t, 'FLOAT_VECTOR', 'POINT', ctx.domain) as Float32Array));
  });

export const cyclicField = () =>
  new InputField('BOOLEAN', 'cyclic', (ctx) => {
    if (ctx.comp.kind !== 'CURVES') return zeros('BOOLEAN', ctx);
    return full(adaptDomain(ctx.comp, ctx.comp.cyclic, 'BOOLEAN', 'CURVE', ctx.domain));
  });
