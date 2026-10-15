// Integer, bit and hash math, float → integer conversion and color combine/separate nodes.
import './fdata';
import { gn, prop, sprop } from './defs';
import { fnField, type Evaluated } from '../field';
import { lift } from './flift';
import { jhash1, jhash2, jhash3, jhash4, bitsOf, stringHash } from '../jhash';
import { eulerToQuat } from '../rotmath';
import { rgbToHsv, rgbToHsl, hslToRgb } from '../../compositor/color/colorops';
import type { FieldType } from '../types';
import type { SocketDef, SocketType } from '../../nodes/types';
import type { NodeData } from '../../data/types';

const st = (e: Evaluated) => (e.single ? 0 : 1);
/** C-style rounding (halves away from zero). */
export const roundHalfAway = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Double → 64-bit integer (saturating) → low 32 bits, as a widening integer cast would. */
function wrap64(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= 9.2233720368547758e18) return -1;
  if (x <= -9.2233720368547758e18) return 0;
  x = Math.trunc(x);
  return Math.abs(x) < 9007199254740992 ? x | 0 : Number(BigInt.asIntN(32, BigInt(x)));
}

function gcd(a: number, b: number) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

const label = (n: NodeData, id: string) => {
  return (items: [string, string][]) => items.find(([v]) => v === sprop(n, id))?.[1];
};

// ---------------------------------------------------------------------------
// Integer Math

const INT_UNARY = new Set(['ABSOLUTE', 'NEGATE', 'SIGN']);

export function intMath(op: string): (a: number, b: number, c: number) => number {
  switch (op) {
    case 'ADD':
      return (a, b) => (a + b) | 0;
    case 'SUBTRACT':
      return (a, b) => (a - b) | 0;
    case 'MULTIPLY':
      return (a, b) => Math.imul(a, b);
    case 'DIVIDE':
      return (a, b) => (b === 0 ? 0 : Math.trunc(a / b));
    case 'MULTIPLY_ADD':
      return (a, b, c) => (Math.imul(a, b) + c) | 0;
    case 'ABSOLUTE':
      return (a) => Math.abs(a) | 0;
    case 'NEGATE':
      return (a) => -a | 0;
    case 'POWER':
      return (a, b) => wrap64(Math.pow(a, b));
    case 'MINIMUM':
      return (a, b) => Math.min(a, b);
    case 'MAXIMUM':
      return (a, b) => Math.max(a, b);
    case 'SIGN':
      return (a) => Math.sign(a);
    case 'DIVIDE_ROUND':
      return (a, b) => (b === 0 ? 0 : roundHalfAway(a / b));
    case 'DIVIDE_FLOOR':
      return (a, b) => (b === 0 ? 0 : Math.floor(a / b));
    case 'DIVIDE_CEIL':
      return (a, b) => (b === 0 ? 0 : Math.ceil(a / b));
    case 'FLOORED_MODULO':
      return (a, b) => (b === 0 ? 0 : a - Math.floor(a / b) * b);
    case 'MODULO':
      return (a, b) => (b === 0 ? 0 : (a % b) | 0);
    case 'GCD':
      return (a, b) => gcd(a, b);
    case 'LCM':
      return (a, b) => {
        const g = gcd(a, b);
        return g ? Math.abs(Math.trunc(a / g) * b) | 0 : 0;
      };
    default:
      return (a) => a;
  }
}

const intMathDef = gn(
  'FunctionNodeIntegerMath',
  'converter',
  {
    exec: (ctx) => {
      const fn = intMath(sprop(ctx.node, 'operation'));
      return {
        Value: fnField('INT', [ctx.field('Value', 'INT'), ctx.field('Value_001', 'INT'), ctx.field('Value_002', 'INT')], ([a, b, c], out, n) => {
          const sa = st(a),
            sb = st(b),
            sc = st(c);
          for (let i = 0; i < n; i++) out[i] = fn(a.data[i * sa], b.data[i * sb], c.data[i * sc]);
        }),
      };
    },
  },
  {
    available: (n, s, isOut) => {
      if (isOut) return true;
      const op = sprop(n, 'operation');
      if (s.identifier === 'Value_001') return !INT_UNARY.has(op);
      if (s.identifier === 'Value_002') return op === 'MULTIPLY_ADD';
      return true;
    },
    dynamicLabel: (n) => label(n, 'operation')(intMathDef.props.find((p) => p.id === 'operation')!.items!) ?? 'Integer Math',
  },
);

// ---------------------------------------------------------------------------
// Bit Math

export function bitMath(op: string): (a: number, b: number, s: number) => number {
  switch (op) {
    case 'AND':
      return (a, b) => a & b;
    case 'OR':
      return (a, b) => a | b;
    case 'XOR':
      return (a, b) => a ^ b;
    case 'NOT':
      return (a) => ~a;
    case 'SHIFT':
      return (a, _b, s) => (s >= 32 || s <= -32 ? 0 : s >= 0 ? a << s : (a >>> -s) | 0);
    case 'ROTATE':
      return (a, _b, s) => {
        const k = ((s % 32) + 32) % 32;
        return k ? (a << k) | (a >>> (32 - k)) : a;
      };
    default:
      return (a) => a;
  }
}

const bitMathDef = gn(
  'FunctionNodeBitMath',
  'converter',
  {
    exec: (ctx) => {
      const fn = bitMath(sprop(ctx.node, 'operation'));
      return {
        Value: fnField('INT', [ctx.field('A', 'INT'), ctx.field('B', 'INT'), ctx.field('Shift', 'INT')], ([a, b, s], out, n) => {
          const sa = st(a),
            sb = st(b),
            ss = st(s);
          for (let i = 0; i < n; i++) out[i] = fn(a.data[i * sa], b.data[i * sb], s.data[i * ss]);
        }),
      };
    },
  },
  {
    available: (n, s, isOut) => {
      if (isOut) return true;
      const op = sprop(n, 'operation');
      if (s.identifier === 'B') return op === 'AND' || op === 'OR' || op === 'XOR';
      if (s.identifier === 'Shift') return op === 'SHIFT' || op === 'ROTATE';
      return true;
    },
    dynamicLabel: (n) => label(n, 'operation')(bitMathDef.props.find((p) => p.id === 'operation')!.items!) ?? 'Bit Math',
  },
);

// ---------------------------------------------------------------------------
// Float to Integer

const ROUNDING: Record<string, (x: number) => number> = {
  ROUND: roundHalfAway,
  FLOOR: Math.floor,
  CEILING: Math.ceil,
  TRUNCATE: Math.trunc,
};

/** Float → int32 the way a saturating cast would (NaN → 0). */
const toInt = (x: number) => (Number.isNaN(x) ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : x);

gn(
  'FunctionNodeFloatToInt',
  'converter',
  {
    exec: (ctx) => {
      const r = ROUNDING[sprop(ctx.node, 'rounding_mode')] ?? roundHalfAway;
      return {
        Integer: fnField('INT', [ctx.field('Float', 'FLOAT')], ([a], out, n) => {
          const s = st(a);
          for (let i = 0; i < n; i++) out[i] = toInt(r(a.data[i * s]));
        }),
      };
    },
  },
  { propPatch: { rounding_mode: { noLabel: true } } },
);

// ---------------------------------------------------------------------------
// Hash Value

const HASH_TYPES = ['FLOAT', 'INT', 'VECTOR', 'RGBA', 'ROTATION', 'MATRIX', 'STRING'];

gn(
  'FunctionNodeHashValue',
  'converter',
  {
    exec: (ctx) => {
      const t = sprop(ctx.node, 'data_type') || 'INT';
      const seed = ctx.field('Seed', 'INT');
      if (t === 'STRING') {
        const h = stringHash(ctx.string('Value'));
        return { Hash: lift('INT', [seed], ([s]) => jhash2(h, (s as number) >>> 0) | 0) };
      }
      const ft = t as FieldType;
      const v = ctx.field('Value', ft);
      const word: (a: number | number[]) => number =
        t === 'INT'
          ? (a) => jhash1((a as number) >>> 0)
          : t === 'FLOAT'
            ? (a) => jhash1(bitsOf(a as number))
            : t === 'VECTOR'
              ? (a) => jhash3(bitsOf((a as number[])[0]), bitsOf((a as number[])[1]), bitsOf((a as number[])[2]))
              : t === 'RGBA'
                ? (a) => {
                    const c = a as number[];
                    return jhash4(bitsOf(c[0]), bitsOf(c[1]), bitsOf(c[2]), bitsOf(c[3]));
                  }
                : t === 'ROTATION'
                  ? (a) => {
                      const e = a as number[];
                      const q = eulerToQuat(e[0], e[1], e[2]);
                      return jhash4(bitsOf(q[0]), bitsOf(q[1]), bitsOf(q[2]), bitsOf(q[3]));
                    }
                  : (a) => {
                      const m = a as number[];
                      let h = 0;
                      for (let c = 0; c < 4; c++) h = jhash2(h, jhash4(bitsOf(m[c * 4]), bitsOf(m[c * 4 + 1]), bitsOf(m[c * 4 + 2]), bitsOf(m[c * 4 + 3])));
                      return h;
                    };
      return { Hash: lift('INT', [v, seed], ([a, s]) => jhash2(word(a), (s as number) >>> 0) | 0) };
    },
  },
  {
    items: { data_type: HASH_TYPES },
    dynamicSockets: (node) => {
      const t = (sprop(node, 'data_type') || 'INT') as SocketType;
      const d: Record<string, SocketDef['default']> = { FLOAT: 0, INT: 0, VECTOR: [0, 0, 0], RGBA: [0, 0, 0, 1], ROTATION: [0, 0, 0], STRING: '' };
      return {
        inputs: [
          { name: 'Value', identifier: 'Value', type: t, default: d[t], ...(t === 'ROTATION' ? { subtype: 'EULER' } : {}) },
          { name: 'Seed', identifier: 'Seed', type: 'INT', default: 0 },
        ],
        outputs: [{ name: 'Hash', identifier: 'Hash', type: 'INT', default: 0 }],
      };
    },
  },
);

// ---------------------------------------------------------------------------
// Color

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** HSV → RGB with clamped hue ramps (hues outside 0…1 saturate rather than wrap). */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const r = clamp01(Math.abs(h * 6 - 3) - 1),
    g = clamp01(2 - Math.abs(h * 6 - 2)),
    b = clamp01(2 - Math.abs(h * 6 - 4));
  return [((r - 1) * s + 1) * v, ((g - 1) * s + 1) * v, ((b - 1) * s + 1) * v];
}

const CHANNELS: Record<string, [string, string, string]> = {
  RGB: ['Red', 'Green', 'Blue'],
  HSV: ['Hue', 'Saturation', 'Value'],
  HSL: ['Hue', 'Saturation', 'Lightness'],
};
const channelLabel = (n: NodeData, s: SocketDef) => {
  const i = ['Red', 'Green', 'Blue'].indexOf(s.identifier);
  return i < 0 ? undefined : CHANNELS[sprop(n, 'mode') || 'RGB']?.[i];
};

gn(
  'FunctionNodeCombineColor',
  'converter',
  {
    exec: (ctx) => {
      const mode = sprop(ctx.node, 'mode') || 'RGB';
      const conv = mode === 'HSV' ? hsvToRgb : mode === 'HSL' ? hslToRgb : null;
      return {
        Color: lift(
          'RGBA',
          ['Red', 'Green', 'Blue', 'Alpha'].map((id) => ctx.field(id, 'FLOAT')),
          ([r, g, b, a]) => {
            const c = conv ? conv(r as number, g as number, b as number) : [r as number, g as number, b as number];
            return [c[0], c[1], c[2], a as number];
          },
        ),
      };
    },
  },
  { socketLabel: (n, s) => channelLabel(n, s), propPatch: { mode: { noLabel: true } } },
);

gn(
  'FunctionNodeSeparateColor',
  'converter',
  {
    exec: (ctx) => {
      const mode = sprop(ctx.node, 'mode') || 'RGB';
      const conv = mode === 'HSV' ? rgbToHsv : mode === 'HSL' ? rgbToHsl : null;
      const col = ctx.field('Color', 'RGBA');
      const comp = (k: number) =>
        lift('FLOAT', [col], ([c]) => {
          const v = c as number[];
          if (k === 3) return v[3];
          return conv ? conv(v[0], v[1], v[2])[k] : v[k];
        });
      return { Red: comp(0), Green: comp(1), Blue: comp(2), Alpha: comp(3) };
    },
  },
  { socketLabel: (n, s) => channelLabel(n, s), propPatch: { mode: { noLabel: true } } },
);

gn(
  'FunctionNodeInputColor',
  'input',
  {
    exec: (ctx) => {
      const v = (prop(ctx.node, 'value') as number[] | null) ?? [0.5, 0.5, 0.5, 1];
      return { Color: [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1] };
    },
  },
  { propPatch: { value: { noLabel: true } } },
);
