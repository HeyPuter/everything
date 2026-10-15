// Utility, math, vector, color and texture nodes (field functions).
import { gn, shared, prop, sprop } from './defs';
import { valueSocket } from './geometry';
import { fnField, ConstField, Field, constOf, type Evaluated } from '../field';
import { mathFn, vectorFn, booleanFn, compareFloat, blend } from '../mathops';
import { positionField, idField } from '../inputs';
import { jhash2, jhash3 } from '../jhash';
import { noiseTexture, noiseTexture3, type NoiseType } from '../noise';
import { readCurve, evalCurve } from '../../nodes/curves';
import { fieldTypeOfEnum, type FieldType } from '../types';
import type { SocketDef, SocketType } from '../../nodes/types';
import type { Val } from '../exec';
import { GeometrySet } from '../geometry';

const st = (e: Evaluated) => (e.single ? 0 : 1);

// ---------------------------------------------------------------------------
// Math

shared('ShaderNodeMath', {
  exec: (ctx) => {
    const fn = mathFn(sprop(ctx.node, 'operation'));
    const clamp = !!prop(ctx.node, 'use_clamp');
    const ins = [ctx.field('Value', 'FLOAT'), ctx.field('Value_001', 'FLOAT'), ctx.field('Value_002', 'FLOAT')];
    return {
      Value: fnField('FLOAT', ins, ([a, b, c], out, n) => {
        const sa = st(a),
          sb = st(b),
          sc = st(c);
        for (let i = 0; i < n; i++) {
          const v = fn(a.data[i * sa], b.data[i * sb], c.data[i * sc]);
          out[i] = clamp ? Math.max(0, Math.min(1, v)) : v;
        }
      }),
    };
  },
});

shared('ShaderNodeVectorMath', {
  exec: (ctx) => {
    const op = sprop(ctx.node, 'operation');
    const fn = vectorFn(op);
    const ins = [ctx.field('Vector', 'VECTOR'), ctx.field('Vector_001', 'VECTOR'), ctx.field('Vector_002', 'VECTOR'), ctx.field('Scale', 'FLOAT')];
    const run = (wantValue: boolean) =>
      fnField(wantValue ? 'FLOAT' : 'VECTOR', ins, ([a, b, c, s], out, n) => {
        const sa = st(a) * 3,
          sb = st(b) * 3,
          sc = st(c) * 3,
          ss = st(s);
        const A: [number, number, number] = [0, 0, 0],
          B: [number, number, number] = [0, 0, 0],
          C: [number, number, number] = [0, 0, 0],
          O: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          for (let k = 0; k < 3; k++) {
            A[k] = a.data[i * sa + k];
            B[k] = b.data[i * sb + k];
            C[k] = c.data[i * sc + k];
          }
          const v = fn(A, B, C, s.data[i * ss], O);
          if (wantValue) out[i] = v;
          else {
            out[i * 3] = O[0];
            out[i * 3 + 1] = O[1];
            out[i * 3 + 2] = O[2];
          }
        }
      });
    const isValue = op === 'DOT_PRODUCT' || op === 'DISTANCE' || op === 'LENGTH';
    return {
      Vector: isValue ? new ConstField('VECTOR', [0, 0, 0]) : run(false),
      Value: isValue ? run(true) : new ConstField('FLOAT', 0),
    };
  },
});

gn(
  'FunctionNodeBooleanMath',
  'converter',
  {
    exec: (ctx) => {
      const fn = booleanFn(sprop(ctx.node, 'operation'));
      return {
        Boolean: fnField('BOOLEAN', [ctx.field('Boolean', 'BOOLEAN'), ctx.field('Boolean_001', 'BOOLEAN')], ([a, b], out, n) => {
          const sa = st(a),
            sb = st(b);
          for (let i = 0; i < n; i++) out[i] = fn(!!a.data[i * sa], !!b.data[i * sb]) ? 1 : 0;
        }),
      };
    },
  },
  {
    available: (n, s) => (s.identifier === 'Boolean_001' ? sprop(n, 'operation') !== 'NOT' : true),
    dynamicLabel: (n) => {
      const items: Record<string, string> = {
        AND: 'And',
        OR: 'Or',
        NOT: 'Not',
        NAND: 'Not And',
        NOR: 'Nor',
        XNOR: 'Equal',
        XOR: 'Not Equal',
        IMPLY: 'Imply',
        NIMPLY: 'Subtract',
      };
      return items[sprop(n, 'operation')] ?? 'Boolean Math';
    },
  },
);

// ---------------------------------------------------------------------------
// Compare

const COMPARE_TYPES = ['FLOAT', 'INT', 'VECTOR', 'RGBA', 'STRING'];

gn(
  'FunctionNodeCompare',
  'converter',
  {
    exec: (ctx) => {
      const t = sprop(ctx.node, 'data_type');
      const op = sprop(ctx.node, 'operation');
      if (t === 'STRING') {
        const eq = ctx.string('A') === ctx.string('B');
        return { Result: op === 'NOT_EQUAL' ? !eq : eq };
      }
      const eps = ctx.field('Epsilon', 'FLOAT');
      if (t === 'FLOAT' || t === 'INT') {
        const fn = compareFloat(op);
        const ft: FieldType = t === 'INT' ? 'INT' : 'FLOAT';
        return {
          Result: fnField('BOOLEAN', [ctx.field('A', ft), ctx.field('B', ft), eps], ([a, b, e], out, n) => {
            const sa = st(a),
              sb = st(b),
              se = st(e);
            for (let i = 0; i < n; i++) out[i] = fn(a.data[i * sa], b.data[i * sb], t === 'INT' ? 0 : e.data[i * se]) ? 1 : 0;
          }),
        };
      }
      if (t === 'RGBA') {
        const lum = (d: ArrayLike<number>, j: number) => d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722;
        return {
          Result: fnField('BOOLEAN', [ctx.field('A', 'RGBA'), ctx.field('B', 'RGBA'), eps], ([a, b, e], out, n) => {
            const sa = st(a) * 4,
              sb = st(b) * 4,
              se = st(e);
            for (let i = 0; i < n; i++) {
              const la = lum(a.data, i * sa),
                lb = lum(b.data, i * sb);
              let r: boolean;
              if (op === 'BRIGHTER') r = la > lb;
              else if (op === 'DARKER') r = la < lb;
              else {
                let eq = true;
                for (let k = 0; k < 4; k++) if (Math.abs(a.data[i * sa + k] - b.data[i * sb + k]) > e.data[i * se]) eq = false;
                r = op === 'NOT_EQUAL' ? !eq : eq;
              }
              out[i] = r ? 1 : 0;
            }
          }),
        };
      }
      // vectors
      const mode = sprop(ctx.node, 'mode');
      const fn = compareFloat(op);
      return {
        Result: fnField('BOOLEAN', [ctx.field('A', 'VECTOR'), ctx.field('B', 'VECTOR'), ctx.field('C', 'FLOAT'), ctx.field('Angle', 'FLOAT'), eps], ([a, b, c, ang, e], out, n) => {
          const sa = st(a) * 3,
            sb = st(b) * 3,
            sc = st(c),
            sg = st(ang),
            se = st(e);
          for (let i = 0; i < n; i++) {
            const A = [a.data[i * sa], a.data[i * sa + 1], a.data[i * sa + 2]],
              B = [b.data[i * sb], b.data[i * sb + 1], b.data[i * sb + 2]];
            const E = e.data[i * se];
            let r: boolean;
            if (mode === 'LENGTH') r = fn(Math.hypot(A[0], A[1], A[2]), Math.hypot(B[0], B[1], B[2]), E);
            else if (mode === 'AVERAGE') r = fn((A[0] + A[1] + A[2]) / 3, (B[0] + B[1] + B[2]) / 3, E);
            else if (mode === 'DOT_PRODUCT') r = fn(A[0] * B[0] + A[1] * B[1] + A[2] * B[2], c.data[i * sc], E);
            else if (mode === 'DIRECTION') {
              const la = Math.hypot(A[0], A[1], A[2]),
                lb = Math.hypot(B[0], B[1], B[2]);
              const angle = la && lb ? Math.acos(Math.max(-1, Math.min(1, (A[0] * B[0] + A[1] * B[1] + A[2] * B[2]) / (la * lb)))) : 0;
              r = fn(angle, ang.data[i * sg], E);
            } else r = fn(A[0], B[0], E) && fn(A[1], B[1], E) && fn(A[2], B[2], E);
            out[i] = r ? 1 : 0;
          }
        }),
      };
    },
  },
  {
    items: { data_type: COMPARE_TYPES },
    propPatch: { mode: { visible: (n) => sprop(n, 'data_type') === 'VECTOR' } },
    dynamicSockets: (node) => {
      const t = sprop(node, 'data_type') || 'FLOAT';
      const op = sprop(node, 'operation');
      const mode = sprop(node, 'mode');
      const ty = (t === 'STRING' ? 'STRING' : t) as SocketType;
      const def = t === 'VECTOR' ? [0, 0, 0] : t === 'RGBA' ? [0.8, 0.8, 0.8, 1] : t === 'STRING' ? '' : 0;
      const inputs: SocketDef[] = [
        { name: 'A', identifier: 'A', type: ty, default: def },
        { name: 'B', identifier: 'B', type: ty, default: def },
      ];
      const eq = op === 'EQUAL' || op === 'NOT_EQUAL';
      if (t === 'VECTOR' && mode === 'DOT_PRODUCT')
        inputs.push({
          name: 'C',
          identifier: 'C',
          type: 'FLOAT',
          default: 0.9,
        });
      if (t === 'VECTOR' && mode === 'DIRECTION')
        inputs.push({
          name: 'Angle',
          identifier: 'Angle',
          type: 'FLOAT',
          default: 0.0872665,
          subtype: 'ANGLE',
        });
      if ((t === 'FLOAT' || t === 'VECTOR' || t === 'RGBA') && eq)
        inputs.push({
          name: 'Epsilon',
          identifier: 'Epsilon',
          type: 'FLOAT',
          default: 0.001,
          min: 0,
        });
      return {
        inputs,
        outputs: [
          {
            name: 'Result',
            identifier: 'Result',
            type: 'BOOLEAN',
            default: false,
          },
        ],
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Map Range / Clamp / Mix / XYZ / Float Curve

function interpolate(type: string, v: number, f0: number, f1: number, t0: number, t1: number, steps: number, clamp: boolean) {
  let x = f1 !== f0 ? (v - f0) / (f1 - f0) : 0;
  if (type === 'STEPPED') x = steps > 0 ? Math.floor(x * (steps + 1)) / steps : x;
  else if (type === 'SMOOTHSTEP') {
    x = Math.max(0, Math.min(1, x));
    x = x * x * (3 - 2 * x);
  } else if (type === 'SMOOTHERSTEP') {
    x = Math.max(0, Math.min(1, x));
    x = x * x * x * (x * (x * 6 - 15) + 10);
  }
  let r = t0 + x * (t1 - t0);
  if (clamp && (type === 'LINEAR' || type === 'STEPPED')) r = t0 < t1 ? Math.max(t0, Math.min(t1, r)) : Math.max(t1, Math.min(t0, r));
  return r;
}

shared('ShaderNodeMapRange', {
  exec: (ctx) => {
    const type = sprop(ctx.node, 'interpolation_type');
    const clamp = !!prop(ctx.node, 'clamp');
    if (sprop(ctx.node, 'data_type') === 'FLOAT_VECTOR') {
      const ins = ['Vector', 'From_Min_FLOAT3', 'From_Max_FLOAT3', 'To_Min_FLOAT3', 'To_Max_FLOAT3', 'Steps_FLOAT3'].map((id) => ctx.field(id, 'VECTOR'));
      return {
        Vector: fnField('VECTOR', ins, (e, out, n) => {
          const s = e.map((x) => st(x) * 3);
          for (let i = 0; i < n; i++)
            for (let k = 0; k < 3; k++)
              out[i * 3 + k] = interpolate(
                type,
                e[0].data[i * s[0] + k],
                e[1].data[i * s[1] + k],
                e[2].data[i * s[2] + k],
                e[3].data[i * s[3] + k],
                e[4].data[i * s[4] + k],
                e[5].data[i * s[5] + k],
                clamp,
              );
        }),
        Result: 0,
      };
    }
    const ins = ['Value', 'From Min', 'From Max', 'To Min', 'To Max', 'Steps'].map((id) => ctx.field(id, 'FLOAT'));
    return {
      Result: fnField('FLOAT', ins, (e, out, n) => {
        const s = e.map(st);
        for (let i = 0; i < n; i++) out[i] = interpolate(type, e[0].data[i * s[0]], e[1].data[i * s[1]], e[2].data[i * s[2]], e[3].data[i * s[3]], e[4].data[i * s[4]], e[5].data[i * s[5]], clamp);
      }),
      Vector: [0, 0, 0],
    };
  },
});

shared('ShaderNodeClamp', {
  exec: (ctx) => {
    const range = sprop(ctx.node, 'clamp_type') === 'RANGE';
    return {
      Result: fnField('FLOAT', [ctx.field('Value', 'FLOAT'), ctx.field('Min', 'FLOAT'), ctx.field('Max', 'FLOAT')], ([v, a, b], out, n) => {
        const sv = st(v),
          sa = st(a),
          sb = st(b);
        for (let i = 0; i < n; i++) {
          let lo = a.data[i * sa],
            hi = b.data[i * sb];
          if (range && lo > hi) [lo, hi] = [hi, lo];
          out[i] = Math.min(Math.max(v.data[i * sv], lo), hi);
        }
      }),
    };
  },
});

shared('ShaderNodeMix', {
  exec: (ctx) => {
    const t = sprop(ctx.node, 'data_type');
    const clampF = !!prop(ctx.node, 'clamp_factor');
    const cf = (x: number) => (clampF ? Math.max(0, Math.min(1, x)) : x);
    if (t === 'VECTOR') {
      const nonUniform = sprop(ctx.node, 'factor_mode') === 'NON_UNIFORM';
      const fac = nonUniform ? ctx.field('Factor_Vector', 'VECTOR') : ctx.field('Factor_Float', 'FLOAT');
      return {
        Result_Vector: fnField('VECTOR', [fac, ctx.field('A_Vector', 'VECTOR'), ctx.field('B_Vector', 'VECTOR')], ([f, a, b], out, n) => {
          const sf = st(f) * (nonUniform ? 3 : 1),
            sa = st(a) * 3,
            sb = st(b) * 3;
          for (let i = 0; i < n; i++)
            for (let k = 0; k < 3; k++) {
              const ff = cf(f.data[i * sf + (nonUniform ? k : 0)]);
              out[i * 3 + k] = a.data[i * sa + k] + (b.data[i * sb + k] - a.data[i * sa + k]) * ff;
            }
        }),
      };
    }
    if (t === 'RGBA') {
      const mode = sprop(ctx.node, 'blend_type');
      const clampR = !!prop(ctx.node, 'clamp_result');
      return {
        Result_Color: fnField('RGBA', [ctx.field('Factor_Float', 'FLOAT'), ctx.field('A_Color', 'RGBA'), ctx.field('B_Color', 'RGBA')], ([f, a, b], out, n) => {
          const sf = st(f),
            sa = st(a) * 4,
            sb = st(b) * 4;
          for (let i = 0; i < n; i++) {
            const A = [a.data[i * sa], a.data[i * sa + 1], a.data[i * sa + 2]],
              B = [b.data[i * sb], b.data[i * sb + 1], b.data[i * sb + 2]];
            const r = blend(mode, cf(f.data[i * sf]), A, B);
            for (let k = 0; k < 3; k++) out[i * 4 + k] = clampR ? Math.max(0, Math.min(1, r[k])) : r[k];
            out[i * 4 + 3] = a.data[i * sa + 3];
          }
        }),
      };
    }
    return {
      Result_Float: fnField('FLOAT', [ctx.field('Factor_Float', 'FLOAT'), ctx.field('A_Float', 'FLOAT'), ctx.field('B_Float', 'FLOAT')], ([f, a, b], out, n) => {
        const sf = st(f),
          sa = st(a),
          sb = st(b);
        for (let i = 0; i < n; i++) {
          const ff = cf(f.data[i * sf]);
          out[i] = a.data[i * sa] + (b.data[i * sb] - a.data[i * sa]) * ff;
        }
      }),
    };
  },
});

shared('ShaderNodeCombineXYZ', {
  exec: (ctx) => ({
    Vector: fnField('VECTOR', [ctx.field('X', 'FLOAT'), ctx.field('Y', 'FLOAT'), ctx.field('Z', 'FLOAT')], ([x, y, z], out, n) => {
      const sx = st(x),
        sy = st(y),
        sz = st(z);
      for (let i = 0; i < n; i++) {
        out[i * 3] = x.data[i * sx];
        out[i * 3 + 1] = y.data[i * sy];
        out[i * 3 + 2] = z.data[i * sz];
      }
    }),
  }),
});

shared('ShaderNodeSeparateXYZ', {
  exec: (ctx) => {
    const v = ctx.field('Vector', 'VECTOR');
    const comp = (k: number) =>
      fnField('FLOAT', [v], ([a], out, n) => {
        const s = st(a) * 3;
        for (let i = 0; i < n; i++) out[i] = a.data[i * s + k];
      });
    return { X: comp(0), Y: comp(1), Z: comp(2) };
  },
});

shared('ShaderNodeFloatCurve', {
  exec: (ctx) => {
    const pts = readCurve(ctx.node.props, 0);
    const extend = String(ctx.node.props.curve_extend ?? 'HORIZONTAL');
    return {
      Value: fnField('FLOAT', [ctx.field('Factor', 'FLOAT'), ctx.field('Value', 'FLOAT')], ([f, v], out, n) => {
        const sf = st(f),
          sv = st(v);
        for (let i = 0; i < n; i++) {
          const x = v.data[i * sv];
          out[i] = x + (evalCurve(pts, x, extend) - x) * f.data[i * sf];
        }
      }),
    };
  },
});

// ---------------------------------------------------------------------------
// Random Value

const RANDOM_TYPES = ['FLOAT', 'INT', 'BOOLEAN', 'FLOAT_VECTOR'];

gn(
  'FunctionNodeRandomValue',
  'converter',
  {
    exec: (ctx) => {
      const t = sprop(ctx.node, 'data_type');
      const id = ctx.field('ID', 'INT'),
        seed = ctx.field('Seed', 'INT');
      if (t === 'BOOLEAN')
        return {
          Value: fnField('BOOLEAN', [ctx.field('Probability', 'FLOAT'), id, seed], ([p, i, s], out, n) => {
            const sp = st(p),
              si = st(i),
              ss = st(s);
            for (let k = 0; k < n; k++) out[k] = jhash2(i.data[k * si] >>> 0, s.data[k * ss] >>> 0) / 0xffffffff < p.data[k * sp] ? 1 : 0;
          }),
        };
      if (t === 'INT')
        return {
          Value: fnField('INT', [ctx.field('Min', 'INT'), ctx.field('Max', 'INT'), id, seed], ([a, b, i, s], out, n) => {
            const sa = st(a),
              sb = st(b),
              si = st(i),
              ss = st(s);
            for (let k = 0; k < n; k++) {
              const lo = Math.min(a.data[k * sa], b.data[k * sb]),
                hi = Math.max(a.data[k * sa], b.data[k * sb]);
              out[k] = lo + (jhash2(i.data[k * si] >>> 0, s.data[k * ss] >>> 0) % (hi - lo + 1));
            }
          }),
        };
      if (t === 'FLOAT_VECTOR')
        return {
          Value: fnField('VECTOR', [ctx.field('Min', 'VECTOR'), ctx.field('Max', 'VECTOR'), id, seed], ([a, b, i, s], out, n) => {
            const sa = st(a) * 3,
              sb = st(b) * 3,
              si = st(i),
              ss = st(s);
            for (let k = 0; k < n; k++)
              for (let c = 0; c < 3; c++) {
                const r = jhash3(s.data[k * ss] >>> 0, i.data[k * si] >>> 0, c) / 0xffffffff;
                out[k * 3 + c] = a.data[k * sa + c] + r * (b.data[k * sb + c] - a.data[k * sa + c]);
              }
          }),
        };
      return {
        Value: fnField('FLOAT', [ctx.field('Min', 'FLOAT'), ctx.field('Max', 'FLOAT'), id, seed], ([a, b, i, s], out, n) => {
          const sa = st(a),
            sb = st(b),
            si = st(i),
            ss = st(s);
          for (let k = 0; k < n; k++) {
            const r = jhash2(s.data[k * ss] >>> 0, i.data[k * si] >>> 0) / 0xffffffff;
            out[k] = a.data[k * sa] + r * (b.data[k * sb] - a.data[k * sa]);
          }
        }),
      };
    },
    implicit: { ID: idField },
  },
  {
    items: { data_type: RANDOM_TYPES },
    dynamicSockets: (node) => {
      const t = sprop(node, 'data_type') || 'FLOAT';
      const tail: SocketDef[] = [
        {
          name: 'ID',
          identifier: 'ID',
          type: 'INT',
          default: 0,
          hide_value: true,
          shape: 'DIAMOND',
        },
        {
          name: 'Seed',
          identifier: 'Seed',
          type: 'INT',
          default: 0,
          shape: 'DIAMOND_DOT',
        },
      ];
      let inputs: SocketDef[];
      let out: FieldType = 'FLOAT';
      if (t === 'BOOLEAN') {
        inputs = [
          {
            name: 'Probability',
            identifier: 'Probability',
            type: 'FLOAT',
            default: 0.5,
            min: 0,
            max: 1,
            subtype: 'FACTOR',
            shape: 'DIAMOND_DOT',
          },
        ];
        out = 'BOOLEAN';
      } else if (t === 'INT') {
        inputs = [
          {
            name: 'Min',
            identifier: 'Min',
            type: 'INT',
            default: 0,
            shape: 'DIAMOND_DOT',
          },
          {
            name: 'Max',
            identifier: 'Max',
            type: 'INT',
            default: 100,
            shape: 'DIAMOND_DOT',
          },
        ];
        out = 'INT';
      } else if (t === 'FLOAT_VECTOR') {
        inputs = [
          {
            name: 'Min',
            identifier: 'Min',
            type: 'VECTOR',
            default: [0, 0, 0],
            shape: 'DIAMOND_DOT',
          },
          {
            name: 'Max',
            identifier: 'Max',
            type: 'VECTOR',
            default: [1, 1, 1],
            shape: 'DIAMOND_DOT',
          },
        ];
        out = 'VECTOR';
      } else
        inputs = [
          {
            name: 'Min',
            identifier: 'Min',
            type: 'FLOAT',
            default: 0,
            shape: 'DIAMOND_DOT',
          },
          {
            name: 'Max',
            identifier: 'Max',
            type: 'FLOAT',
            default: 1,
            shape: 'DIAMOND_DOT',
          },
        ];
      return {
        inputs: [...inputs, ...tail],
        outputs: [{ name: 'Value', identifier: 'Value', type: out, shape: 'DIAMOND' }],
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Switch

const SWITCH_TYPES = ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION', 'STRING', 'GEOMETRY', 'OBJECT', 'COLLECTION', 'MATERIAL'];
const FIELDABLE = new Set(['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION']);

gn(
  'GeometryNodeSwitch',
  'converter',
  {
    exec: (ctx) => {
      const t = sprop(ctx.node, 'input_type') || 'FLOAT';
      const s = ctx.input('Switch');
      if (s instanceof Field) {
        const c = constOf(s);
        if (c === undefined) {
          if (!FIELDABLE.has(t)) {
            ctx.warn('A field cannot switch between non-field values');
            return { Output: ctx.input('False') as Val };
          }
          const ft = t as FieldType;
          return {
            Output: fnField(ft, [s, ctx.field('False', ft), ctx.field('True', ft)], ([sw, a, b], out, n) => {
              const comps = ft === 'VECTOR' || ft === 'ROTATION' ? 3 : ft === 'RGBA' ? 4 : 1;
              const ss = st(sw),
                sa = st(a) * comps,
                sb = st(b) * comps;
              for (let i = 0; i < n; i++) {
                const src = sw.data[i * ss] ? b : a,
                  so = sw.data[i * ss] ? sb : sa;
                for (let k = 0; k < comps; k++) out[i * comps + k] = src.data[i * so + k];
              }
            }),
          };
        }
        return { Output: ctx.input(c ? 'True' : 'False') };
      }
      return { Output: ctx.input(s ? 'True' : 'False') };
    },
  },
  {
    items: { input_type: SWITCH_TYPES },
    dynamicSockets: (node) => {
      const t = (sprop(node, 'input_type') || 'FLOAT') as SocketType;
      const field = FIELDABLE.has(t);
      const mk = (id: string): SocketDef =>
        field
          ? valueSocket(id, t as FieldType)
          : {
              name: id,
              identifier: id,
              type: t,
              ...(t === 'STRING' ? { default: '' } : {}),
            };
      return {
        inputs: [
          {
            name: 'Switch',
            identifier: 'Switch',
            type: 'BOOLEAN',
            default: false,
            ...(field ? { shape: 'DIAMOND_DOT' as const } : {}),
          },
          { ...mk('False'), shape: field ? 'DIAMOND_DOT' : undefined },
          { ...mk('True'), shape: field ? 'DIAMOND_DOT' : undefined },
        ],
        outputs: [
          {
            ...mk('Output'),
            name: 'Output',
            shape: field ? 'DIAMOND_DOT' : undefined,
          },
        ],
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Rotation helpers (rotations are XYZ Euler triples)

gn('FunctionNodeEulerToRotation', 'converter', {
  exec: (ctx) => ({ Rotation: ctx.field('Euler', 'ROTATION') }),
});
gn('FunctionNodeRotationToEuler', 'converter', {
  exec: (ctx) => ({ Euler: ctx.field('Rotation', 'VECTOR') }),
});

// ---------------------------------------------------------------------------
// Noise Texture

shared('ShaderNodeTexNoise', {
  exec: (ctx) => {
    const dims = sprop(ctx.node, 'noise_dimensions') || '3D';
    const type = (sprop(ctx.node, 'noise_type') || 'FBM') as NoiseType;
    const norm = prop(ctx.node, 'normalize') !== false;
    const ins = [
      ctx.field('Vector', 'VECTOR'),
      ctx.field('W', 'FLOAT'),
      ctx.field('Scale', 'FLOAT'),
      ctx.field('Detail', 'FLOAT'),
      ctx.field('Roughness', 'FLOAT'),
      ctx.field('Lacunarity', 'FLOAT'),
      ctx.field('Offset', 'FLOAT'),
      ctx.field('Gain', 'FLOAT'),
      ctx.field('Distortion', 'FLOAT'),
    ];
    const wantColor = ctx.used('Color');
    const compute = (e: Evaluated[], out4: Float32Array, n: number) => {
      const s = e.map(st);
      for (let i = 0; i < n; i++) {
        const v = (k: number) => e[k].data[i * s[k]];
        const sc = v(2);
        const x = e[0].data[i * s[0] * 3] * sc,
          y = e[0].data[i * s[0] * 3 + 1] * sc,
          z = e[0].data[i * s[0] * 3 + 2] * sc,
          w = v(1) * sc;
        if (dims === '3D' && type === 'FBM') noiseTexture3(x, y, z, v(3), v(4), v(5), v(8), norm, wantColor, out4, i * 4);
        else {
          const p = dims === '1D' ? [w] : dims === '2D' ? [x, y] : dims === '4D' ? [x, y, z, w] : [x, y, z];
          out4.set(noiseTexture(p, v(3), v(4), v(5), v(6), v(7), v(8), type, norm), i * 4);
        }
      }
    };
    // Factor and Color share one evaluation per context (same evaluated inputs)
    let cache: { key: Evaluated[]; data: Float32Array } | null = null;
    const both = (e: Evaluated[], n: number) => {
      if (cache && cache.data.length === n * 4 && cache.key.every((k, i) => k === e[i])) return cache.data;
      const data = new Float32Array(n * 4);
      compute(e, data, n);
      cache = { key: e, data };
      return data;
    };
    return {
      Fac: fnField('FLOAT', ins, (e, out, n) => {
        const d = both(e, n);
        for (let i = 0; i < n; i++) out[i] = d[i * 4];
      }),
      Color: fnField('RGBA', ins, (e, out, n) => {
        const d = both(e, n);
        for (let i = 0; i < n; i++) {
          out[i * 4] = d[i * 4 + 1];
          out[i * 4 + 1] = d[i * 4 + 2];
          out[i * 4 + 2] = d[i * 4 + 3];
          out[i * 4 + 3] = 1;
        }
      }),
    };
  },
  implicit: { Vector: positionField },
});

export { fieldTypeOfEnum, GeometrySet };
