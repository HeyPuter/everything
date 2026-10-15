// Field utility nodes: Accumulate Field, Evaluate at Index, Evaluate on Domain, Field Average,
// Field Min & Max, Field Variance and Blur Attribute. Their fields evaluate inputs on a chosen
// domain of the geometry being processed, then interpolate the result to the domain they are
// used on.
import './fdata';
import { gn, sprop } from './defs';
import { Field, allocField, evalFull, makeContext, type Evaluated, type FieldContext } from '../field';
import { adaptDomain, type Component } from '../geometry';
import { hasDomain } from './common';
import { dataTypeOfField, fieldComps, fieldTypeOfEnum, type Domain, type FieldType } from '../types';
import { valueSocket } from './geometry';
import { mul4 } from './fn_matrix';
import type { SocketDef } from '../../nodes/types';
import type { NodeData } from '../../data/types';

const zeros = (type: FieldType): Evaluated => ({ data: allocField(type, 1), single: true });

/** Evaluate fields on another domain of the context's component (null when the domain is missing). */
function onDomain(ctx: FieldContext, domain: Domain, fields: Field[]): { size: number; values: ReturnType<typeof evalFull>[] } | null {
  const c = ctx.comp;
  if (!hasDomain(c, domain)) return null;
  const sub = domain === ctx.domain ? ctx : makeContext(c, domain);
  return { size: sub.size, values: fields.map((f) => evalFull(f, sub)) };
}

/** Interpolate per-element values from `from` to the context domain. */
function toContext(ctx: FieldContext, data: Float32Array | Int32Array | Uint8Array, type: FieldType, from: Domain): Evaluated {
  if (from === ctx.domain) return { data, single: false };
  const c: Component = ctx.comp;
  return { data: adaptDomain(c, data, dataTypeOfField(type), from, ctx.domain), single: false };
}

/** Field computed from inputs evaluated on `domain`. */
class DomainField extends Field {
  constructor(
    type: FieldType,
    private readonly domain: Domain,
    private readonly inputs: Field[],
    private readonly fn: (values: ReturnType<typeof evalFull>[], size: number) => Float32Array | Int32Array | Uint8Array,
  ) {
    super(type);
  }
  protected compute(ctx: FieldContext): Evaluated {
    const r = onDomain(ctx, this.domain, this.inputs);
    if (!r) return zeros(this.type);
    return toContext(ctx, this.fn(r.values, r.size), this.type, this.domain);
  }
}

/** Element indices of each group (by integer group id) in element order. */
function groupsOf(ids: ArrayLike<number>, n: number): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const g = ids[i];
    let l = m.get(g);
    if (!l) m.set(g, (l = []));
    l.push(i);
  }
  return m;
}

const FIELD_DATA_TYPES: Record<string, FieldType> = {
  FLOAT: 'FLOAT',
  INT: 'INT',
  FLOAT_VECTOR: 'VECTOR',
  TRANSFORM: 'MATRIX',
  FLOAT_COLOR: 'RGBA',
  BOOLEAN: 'BOOLEAN',
  QUATERNION: 'ROTATION',
  FLOAT4X4: 'MATRIX',
};
const typeOf = (n: NodeData, fallback = 'FLOAT'): FieldType => FIELD_DATA_TYPES[sprop(n, 'data_type') || fallback] ?? fieldTypeOfEnum(sprop(n, 'data_type'));
const domainOf = (n: NodeData) => (sprop(n, 'domain') || 'POINT') as Domain;
const DOMAINS = ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE'];

function groupSockets(t: FieldType, value: SocketDef, outs: [string, string][]): { inputs: SocketDef[]; outputs: SocketDef[] } {
  return {
    inputs: [value, { name: 'Group ID', identifier: 'Group Index', type: 'INT', default: 0, hide_value: true, shape: 'DIAMOND' }],
    outputs: outs.map(([id, name]) => valueSocket(id, t, name)),
  };
}

// ---------------------------------------------------------------------------
// Accumulate Field

function accumulate(t: FieldType, which: 'Leading' | 'Trailing' | 'Total', values: ReturnType<typeof evalFull>[], n: number) {
  const [v, g] = values;
  const c = fieldComps(t);
  const out = allocField(t, n);
  if (t === 'MATRIX') {
    for (const idx of groupsOf(g, n).values()) {
      let acc = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const lead: number[][] = [];
      for (const i of idx) {
        const prev = acc;
        acc = mul4(acc, Array.from(v.subarray(i * 16, i * 16 + 16)));
        lead.push(which === 'Trailing' ? prev : acc);
      }
      idx.forEach((i, k) => out.set(which === 'Total' ? acc : lead[k], i * 16));
    }
    return out;
  }
  for (const idx of groupsOf(g, n).values()) {
    const sum = new Float64Array(c);
    for (const i of idx) {
      for (let k = 0; k < c; k++) {
        const x = v[i * c + k];
        if (which === 'Trailing') out[i * c + k] = t === 'INT' ? sum[k] | 0 : sum[k];
        sum[k] = t === 'INT' ? (sum[k] + x) | 0 : Math.fround(sum[k] + x);
        if (which === 'Leading') out[i * c + k] = sum[k];
      }
    }
    if (which === 'Total') for (const i of idx) for (let k = 0; k < c; k++) out[i * c + k] = sum[k];
  }
  return out;
}

gn(
  'GeometryNodeAccumulateField',
  'converter',
  {
    exec: (ctx) => {
      const t = typeOf(ctx.node);
      const d = domainOf(ctx.node);
      const ins = [ctx.field('Value', t), ctx.field('Group Index', 'INT')];
      const mk = (w: 'Leading' | 'Trailing' | 'Total') => new DomainField(t, d, ins, (v, n) => accumulate(t, w, v, n));
      return { Leading: mk('Leading'), Trailing: mk('Trailing'), Total: mk('Total') };
    },
  },
  {
    items: { data_type: ['FLOAT', 'INT', 'FLOAT_VECTOR', 'TRANSFORM'], domain: DOMAINS },
    dynamicSockets: (node) => {
      const t = typeOf(node);
      return groupSockets(t, { ...valueSocket('Value', t), default: t === 'VECTOR' ? [1, 1, 1] : t === 'MATRIX' ? undefined : 1 }, [
        ['Leading', 'Leading'],
        ['Trailing', 'Trailing'],
        ['Total', 'Total'],
      ]);
    },
  },
);

// ---------------------------------------------------------------------------
// Field Average / Min & Max / Variance

function perGroup(t: FieldType, values: ReturnType<typeof evalFull>[], n: number, reduce: (vals: number[]) => number) {
  const [v, g] = values;
  const c = fieldComps(t);
  const out = allocField(t, n);
  for (const idx of groupsOf(g, n).values())
    for (let k = 0; k < c; k++) {
      const r = reduce(idx.map((i) => v[i * c + k]));
      for (const i of idx) out[i * c + k] = r;
    }
  return out;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
};
const variance = (a: number[]) => {
  const m = mean(a);
  return a.length ? a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length : 0;
};

function statNode(idname: string, types: string[], outs: [string, string, (a: number[]) => number][]) {
  gn(
    idname,
    'converter',
    {
      exec: (ctx) => {
        const t = typeOf(ctx.node);
        const d = domainOf(ctx.node);
        const ins = [ctx.field('Value', t), ctx.field('Group Index', 'INT')];
        const r: Record<string, Field> = {};
        for (const [id, , fn] of outs) r[id] = new DomainField(t, d, ins, (v, n) => perGroup(t, v, n, fn));
        return r;
      },
    },
    {
      items: { data_type: types, domain: DOMAINS },
      dynamicSockets: (node) => {
        const t = typeOf(node);
        return groupSockets(
          t,
          valueSocket('Value', t),
          outs.map(([id, name]) => [id, name]),
        );
      },
    },
  );
}

statNode(
  'GeometryNodeFieldAverage',
  ['FLOAT', 'FLOAT_VECTOR'],
  [
    ['Mean', 'Mean', mean],
    ['Median', 'Median', median],
  ],
);
statNode(
  'GeometryNodeFieldMinAndMax',
  ['FLOAT', 'INT', 'FLOAT_VECTOR'],
  [
    ['Min', 'Min', (a) => Math.min(...a)],
    ['Max', 'Max', (a) => Math.max(...a)],
  ],
);
statNode(
  'GeometryNodeFieldVariance',
  ['FLOAT', 'FLOAT_VECTOR'],
  [
    ['Standard Deviation', 'Standard Deviation', (a) => Math.sqrt(variance(a))],
    ['Variance', 'Variance', variance],
  ],
);

// ---------------------------------------------------------------------------
// Evaluate on Domain / Evaluate at Index

const EVAL_TYPES = ['FLOAT', 'INT', 'BOOLEAN', 'FLOAT_VECTOR', 'FLOAT_COLOR', 'QUATERNION', 'FLOAT4X4'];

gn(
  'GeometryNodeFieldOnDomain',
  'converter',
  {
    exec: (ctx) => {
      const t = typeOf(ctx.node);
      return { Value: new DomainField(t, domainOf(ctx.node), [ctx.field('Value', t)], (v) => v[0]) };
    },
  },
  {
    items: { data_type: EVAL_TYPES, domain: DOMAINS },
    dynamicSockets: (node) => {
      const t = typeOf(node);
      return { inputs: [valueSocket('Value', t)], outputs: [valueSocket('Value', t)] };
    },
  },
);

/** Value of a field on another element (by index, evaluated on `domain`). */
class AtIndexField extends Field {
  constructor(
    type: FieldType,
    private readonly domain: Domain,
    private readonly value: Field,
    private readonly index: Field,
  ) {
    super(type);
  }
  protected compute(ctx: FieldContext): Evaluated {
    const r = onDomain(ctx, this.domain, [this.value]);
    if (!r) return zeros(this.type);
    const src = r.values[0];
    const idx = evalFull(this.index, ctx);
    const c = fieldComps(this.type);
    const out = allocField(this.type, ctx.size);
    for (let i = 0; i < ctx.size; i++) {
      const j = idx[i];
      if (j < 0 || j >= r.size) continue;
      for (let k = 0; k < c; k++) out[i * c + k] = src[j * c + k];
    }
    return { data: out, single: false };
  }
}

gn(
  'GeometryNodeFieldAtIndex',
  'converter',
  {
    exec: (ctx) => {
      const t = typeOf(ctx.node);
      return { Value: new AtIndexField(t, domainOf(ctx.node), ctx.field('Value', t), ctx.field('Index', 'INT')) };
    },
  },
  {
    items: { data_type: EVAL_TYPES, domain: DOMAINS },
    dynamicSockets: (node) => {
      const t = typeOf(node);
      return {
        inputs: [
          { ...valueSocket('Value', t), hide_value: true },
          { name: 'Index', identifier: 'Index', type: 'INT', default: 0, shape: 'DIAMOND' },
        ],
        outputs: [valueSocket('Value', t)],
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Blur Attribute

/** Neighbor lists (CSR) of the elements of a domain. */
export function neighborsOf(c: Component, domain: Domain): { offsets: Uint32Array; items: Uint32Array } | null {
  const lists: number[][] = [];
  if (c.kind === 'MESH') {
    const t = c.topology();
    if (domain === 'POINT') {
      for (let v = 0; v < c.vertCount; v++) {
        const l: number[] = [];
        for (let k = t.vertEdgeOffsets[v]; k < t.vertEdgeOffsets[v + 1]; k++) {
          const e = t.vertEdges[k];
          l.push(t.edges[e * 2] === v ? t.edges[e * 2 + 1] : t.edges[e * 2]);
        }
        lists.push(l);
      }
    } else if (domain === 'EDGE') {
      for (let e = 0; e < t.edgeCount; e++) {
        const l: number[] = [];
        for (const v of [t.edges[e * 2], t.edges[e * 2 + 1]]) for (let k = t.vertEdgeOffsets[v]; k < t.vertEdgeOffsets[v + 1]; k++) if (t.vertEdges[k] !== e) l.push(t.vertEdges[k]);
        lists.push(l);
      }
    } else if (domain === 'FACE') {
      for (let f = 0; f < c.faceCount; f++) {
        const l: number[] = [];
        for (let k = c.faceOffsets[f]; k < c.faceOffsets[f + 1]; k++) {
          const e = t.cornerEdge[k];
          for (let j = t.edgeFaceOffsets[e]; j < t.edgeFaceOffsets[e + 1]; j++) if (t.edgeFaces[j] !== f) l.push(t.edgeFaces[j]);
        }
        lists.push(l);
      }
    } else return null;
  } else if (c.kind === 'CURVES' && domain === 'POINT') {
    for (let cv = 0; cv < c.curveCount; cv++) {
      const s = c.curveOffsets[cv],
        e = c.curveOffsets[cv + 1],
        n = e - s;
      for (let i = s; i < e; i++) {
        const l: number[] = [];
        if (i > s) l.push(i - 1);
        else if (c.cyclic[cv] && n > 2) l.push(e - 1);
        if (i < e - 1) l.push(i + 1);
        else if (c.cyclic[cv] && n > 2) l.push(s);
        lists.push(l);
      }
    }
  } else return null;
  const offsets = new Uint32Array(lists.length + 1);
  for (let i = 0; i < lists.length; i++) offsets[i + 1] = offsets[i] + lists[i].length;
  const items = new Uint32Array(offsets[lists.length]);
  lists.forEach((l, i) => items.set(l, offsets[i]));
  return { offsets, items };
}

/** Repeated neighbor averaging: each element mixes in its neighbors by its own weight. */
export function blurValues(
  values: Float32Array | Int32Array | Uint8Array,
  comps: number,
  weights: ArrayLike<number>,
  nb: { offsets: Uint32Array; items: Uint32Array },
  iterations: number,
  isInt: boolean,
) {
  const n = nb.offsets.length - 1;
  let cur = Float64Array.from(values);
  let next = new Float64Array(cur.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const w = weights[i];
      const a = nb.offsets[i],
        b = nb.offsets[i + 1];
      const denom = 1 + w * (b - a);
      for (let k = 0; k < comps; k++) {
        let s = 0;
        for (let j = a; j < b; j++) s += cur[nb.items[j] * comps + k];
        const v = (cur[i * comps + k] + w * s) / denom;
        next[i * comps + k] = isInt ? Math.round(v) : Math.fround(v);
      }
    }
    [cur, next] = [next, cur];
  }
  const out = new (values.constructor as { new (n: number): Float32Array | Int32Array })(values.length);
  for (let i = 0; i < out.length; i++) out[i] = cur[i];
  return out;
}

class BlurField extends Field {
  constructor(
    type: FieldType,
    private readonly value: Field,
    private readonly iterations: Field,
    private readonly weight: Field,
  ) {
    super(type);
  }
  protected compute(ctx: FieldContext): Evaluated {
    const v = evalFull(this.value, ctx);
    const its = Math.max(0, Math.round(this.iterations.eval(ctx).data[0] ?? 0));
    const nb = its ? neighborsOf(ctx.comp, ctx.domain) : null;
    if (!nb || nb.offsets.length - 1 !== ctx.size) return { data: v, single: false };
    const w = evalFull(this.weight, ctx);
    return { data: blurValues(v, fieldComps(this.type), w, nb, its, this.type === 'INT'), single: false };
  }
}

const blurTypeOf = (n: NodeData): FieldType => FIELD_DATA_TYPES[sprop(n, 'data_type') || 'FLOAT'] ?? 'FLOAT';

gn(
  'GeometryNodeBlurAttribute',
  'attribute',
  {
    exec: (ctx) => {
      const t = blurTypeOf(ctx.node);
      return { Value: new BlurField(t, ctx.field('Value', t), ctx.field('Iterations', 'INT'), ctx.field('Weight', 'FLOAT')) };
    },
  },
  {
    items: { data_type: ['FLOAT', 'INT', 'FLOAT_VECTOR', 'FLOAT_COLOR'] },
    dynamicSockets: (node) => {
      const t = blurTypeOf(node);
      return {
        inputs: [
          { ...valueSocket('Value', t), hide_value: true },
          { name: 'Iterations', identifier: 'Iterations', type: 'INT', default: 1, min: 0 },
          { name: 'Weight', identifier: 'Weight', type: 'FLOAT', default: 1, min: 0, max: 1, subtype: 'FACTOR', shape: 'DIAMOND' },
        ],
        outputs: [valueSocket('Value', t)],
      };
    },
  },
);
