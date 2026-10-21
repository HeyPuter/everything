// Scalar and vector operations of the Math, Vector Math, Boolean Math, Compare and Mix nodes.
import { rgbToHsvA, hsvToRgbA } from '../nodes/curves';

const safeDiv = (a: number, b: number) => (b !== 0 ? a / b : 0);
const fract = (x: number) => x - Math.floor(x);

export function mathFn(op: string): (a: number, b: number, c: number) => number {
  switch (op) {
    case 'ADD':
      return (a, b) => a + b;
    case 'SUBTRACT':
      return (a, b) => a - b;
    case 'MULTIPLY':
      return (a, b) => a * b;
    case 'DIVIDE':
      return safeDiv;
    case 'MULTIPLY_ADD':
      return (a, b, c) => a * b + c;
    case 'POWER':
      return (a, b) => {
        if (a >= 0) return Math.pow(a, b);
        const fr = b - Math.floor(b);
        return fr === 0 ? Math.pow(a, b) : 0;
      };
    case 'LOGARITHM':
      return (a, b) => (a > 0 && b > 0 && b !== 1 ? Math.log(a) / Math.log(b) : 0);
    case 'SQRT':
      return (a) => (a > 0 ? Math.sqrt(a) : 0);
    case 'INVERSE_SQRT':
      return (a) => (a > 0 ? 1 / Math.sqrt(a) : 0);
    case 'ABSOLUTE':
      return (a) => Math.abs(a);
    case 'EXPONENT':
      return (a) => Math.exp(a);
    case 'MINIMUM':
      return (a, b) => Math.min(a, b);
    case 'MAXIMUM':
      return (a, b) => Math.max(a, b);
    case 'LESS_THAN':
      return (a, b) => (a < b ? 1 : 0);
    case 'GREATER_THAN':
      return (a, b) => (a > b ? 1 : 0);
    case 'SIGN':
      return (a) => Math.sign(a);
    case 'COMPARE':
      return (a, b, c) => (Math.abs(a - b) <= Math.max(c, 1e-5) ? 1 : 0);
    case 'SMOOTH_MIN':
      return (a, b, c) => {
        if (c <= 0) return Math.min(a, b);
        const h = Math.max(c - Math.abs(a - b), 0) / c;
        return Math.min(a, b) - h * h * h * c * (1 / 6);
      };
    case 'SMOOTH_MAX':
      return (a, b, c) => {
        if (c <= 0) return Math.max(a, b);
        const h = Math.max(c - Math.abs(a - b), 0) / c;
        return Math.max(a, b) + h * h * h * c * (1 / 6);
      };
    case 'ROUND':
      return (a) => Math.floor(a + 0.5);
    case 'FLOOR':
      return (a) => Math.floor(a);
    case 'CEIL':
      return (a) => Math.ceil(a);
    case 'TRUNC':
      return (a) => Math.trunc(a);
    case 'FRACT':
      return fract;
    case 'MODULO':
      return (a, b) => (b !== 0 ? a - b * Math.trunc(a / b) : 0);
    case 'FLOORED_MODULO':
      return (a, b) => (b !== 0 ? a - b * Math.floor(a / b) : 0);
    case 'WRAP':
      return (a, b, c) => {
        const r = b - c;
        return r !== 0 ? a - r * Math.floor((a - c) / r) : c;
      };
    case 'SNAP':
      return (a, b) => (b !== 0 ? Math.floor(a / b) * b : 0);
    case 'PINGPONG':
      return (a, b) => (b !== 0 ? Math.abs(fract((a - b) / (b * 2)) * b * 2 - b) : 0);
    case 'SINE':
      return (a) => Math.sin(a);
    case 'COSINE':
      return (a) => Math.cos(a);
    case 'TANGENT':
      return (a) => Math.tan(a);
    case 'ARCSINE':
      // inputs outside [-1, 1] are clamped
      return (a) => Math.asin(Math.max(-1, Math.min(1, a)));
    case 'ARCCOSINE':
      return (a) => Math.acos(Math.max(-1, Math.min(1, a)));
    case 'ARCTANGENT':
      return (a) => Math.atan(a);
    case 'ARCTAN2':
      return (a, b) => Math.atan2(a, b);
    case 'SINH':
      return (a) => Math.sinh(a);
    case 'COSH':
      return (a) => Math.cosh(a);
    case 'TANH':
      return (a) => Math.tanh(a);
    case 'RADIANS':
      return (a) => (a * Math.PI) / 180;
    case 'DEGREES':
      return (a) => (a * 180) / Math.PI;
    default:
      return (a) => a;
  }
}

type V = [number, number, number];

/** Vector math: returns [vector, value] for one element. */
export function vectorFn(op: string): (a: V, b: V, c: V, s: number, out: V) => number {
  const each = (f: (x: number, y: number, z: number) => number) => (a: V, b: V, c: V, _s: number, o: V) => {
    o[0] = f(a[0], b[0], c[0]);
    o[1] = f(a[1], b[1], c[1]);
    o[2] = f(a[2], b[2], c[2]);
    return 0;
  };
  const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  switch (op) {
    case 'ADD':
      return each((x, y) => x + y);
    case 'SUBTRACT':
      return each((x, y) => x - y);
    case 'MULTIPLY':
      return each((x, y) => x * y);
    case 'DIVIDE':
      return each(safeDiv);
    case 'MULTIPLY_ADD':
      return each((x, y, z) => x * y + z);
    case 'CROSS_PRODUCT':
      return (a, b, _c, _s, o) => {
        o[0] = a[1] * b[2] - a[2] * b[1];
        o[1] = a[2] * b[0] - a[0] * b[2];
        o[2] = a[0] * b[1] - a[1] * b[0];
        return 0;
      };
    case 'PROJECT':
      return (a, b, _c, _s, o) => {
        const d = dot(b, b);
        const k = d > 0 ? dot(a, b) / d : 0;
        o[0] = b[0] * k;
        o[1] = b[1] * k;
        o[2] = b[2] * k;
        return 0;
      };
    case 'REFLECT':
      return (a, b, _c, _s, o) => {
        const l = Math.hypot(...b) || 1;
        const n = [b[0] / l, b[1] / l, b[2] / l];
        const d = 2 * (a[0] * n[0] + a[1] * n[1] + a[2] * n[2]);
        o[0] = a[0] - d * n[0];
        o[1] = a[1] - d * n[1];
        o[2] = a[2] - d * n[2];
        return 0;
      };
    case 'REFRACT':
      return (a, b, _c, eta, o) => {
        const l = Math.hypot(...b) || 1;
        const n: V = [b[0] / l, b[1] / l, b[2] / l];
        const d = dot(n, a);
        const k = 1 - eta * eta * (1 - d * d);
        if (k < 0) o[0] = o[1] = o[2] = 0;
        else for (let i = 0; i < 3; i++) o[i] = eta * a[i] - (eta * d + Math.sqrt(k)) * n[i];
        return 0;
      };
    case 'FACEFORWARD':
      return (a, b, c, _s, o) => {
        const sgn = dot(c, b) < 0 ? 1 : -1;
        o[0] = a[0] * sgn;
        o[1] = a[1] * sgn;
        o[2] = a[2] * sgn;
        return 0;
      };
    case 'DOT_PRODUCT':
      return (a, b) => dot(a, b);
    case 'DISTANCE':
      return (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    case 'LENGTH':
      return (a) => Math.hypot(a[0], a[1], a[2]);
    case 'SCALE':
      return (a, _b, _c, s, o) => {
        o[0] = a[0] * s;
        o[1] = a[1] * s;
        o[2] = a[2] * s;
        return 0;
      };
    case 'NORMALIZE':
      return (a, _b, _c, _s, o) => {
        const l = Math.hypot(a[0], a[1], a[2]);
        o[0] = l ? a[0] / l : 0;
        o[1] = l ? a[1] / l : 0;
        o[2] = l ? a[2] / l : 0;
        return 0;
      };
    case 'ABSOLUTE':
      return each((x) => Math.abs(x));
    case 'POWER':
      return each((x, y) => mathFn('POWER')(x, y, 0));
    case 'SIGN':
      return each((x) => Math.sign(x));
    case 'MINIMUM':
      return each((x, y) => Math.min(x, y));
    case 'MAXIMUM':
      return each((x, y) => Math.max(x, y));
    case 'FLOOR':
      return each((x) => Math.floor(x));
    case 'CEIL':
      return each((x) => Math.ceil(x));
    case 'ROUND':
      return each((x) => Math.floor(x + 0.5));
    case 'FRACTION':
      return each(fract);
    case 'MODULO':
      return each((x, y) => (y !== 0 ? x - y * Math.trunc(x / y) : 0));
    case 'WRAP':
      return each((x, y, z) => mathFn('WRAP')(x, y, z));
    case 'SNAP':
      return each((x, y) => (y !== 0 ? Math.floor(x / y) * y : 0));
    case 'SINE':
      return each((x) => Math.sin(x));
    case 'COSINE':
      return each((x) => Math.cos(x));
    case 'TANGENT':
      return each((x) => Math.tan(x));
    default:
      return each((x) => x);
  }
}

export function booleanFn(op: string): (a: boolean, b: boolean) => boolean {
  switch (op) {
    case 'OR':
      return (a, b) => a || b;
    case 'NOT':
      return (a) => !a;
    case 'NAND':
      return (a, b) => !(a && b);
    case 'NOR':
      return (a, b) => !(a || b);
    case 'XNOR':
      return (a, b) => a === b;
    case 'XOR':
      return (a, b) => a !== b;
    case 'IMPLY':
      return (a, b) => !a || b;
    case 'NIMPLY':
      return (a, b) => a && !b;
    default:
      return (a, b) => a && b;
  }
}

export function compareFloat(op: string): (a: number, b: number, eps: number) => boolean {
  switch (op) {
    case 'LESS_THAN':
      return (a, b) => a < b;
    case 'LESS_EQUAL':
      return (a, b) => a <= b;
    case 'GREATER_EQUAL':
      return (a, b) => a >= b;
    case 'EQUAL':
      return (a, b, e) => Math.abs(a - b) <= e;
    case 'NOT_EQUAL':
      return (a, b, e) => Math.abs(a - b) > e;
    default:
      return (a, b) => a > b;
  }
}

// ---------------------------------------------------------------------------
// Color blending (Mix node, color mode)

export const BLEND_MODES = [
  'MIX',
  'DARKEN',
  'MULTIPLY',
  'BURN',
  'LIGHTEN',
  'SCREEN',
  'DODGE',
  'ADD',
  'OVERLAY',
  'SOFT_LIGHT',
  'LINEAR_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'SUBTRACT',
  'DIVIDE',
  'HUE',
  'SATURATION',
  'COLOR',
  'VALUE',
];

export function blend(mode: string, f: number, a: number[], b: number[]): number[] {
  const mix = (x: number[], y: number[]) => [0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * f);
  const per = (fn: (x: number, y: number) => number) =>
    mix(
      a,
      [0, 1, 2].map((i) => fn(a[i], b[i])),
    );
  switch (mode) {
    case 'DARKEN':
      return per(Math.min);
    case 'MULTIPLY':
      return per((x, y) => x * y);
    case 'BURN':
      // the factor scales the darkening (not a mix afterwards); results stay in [0, 1]
      return [0, 1, 2].map((i) => {
        const t = 1 - f + f * b[i];
        return t <= 0 ? 0 : Math.max(0, Math.min(1, 1 - (1 - a[i]) / t));
      });
    case 'LIGHTEN':
      return per(Math.max);
    case 'SCREEN':
      return per((x, y) => 1 - (1 - x) * (1 - y));
    case 'DODGE':
      return [0, 1, 2].map((i) => {
        if (a[i] === 0) return 0;
        const t = 1 - f * b[i];
        return t <= 0 ? 1 : Math.min(1, a[i] / t);
      });
    case 'ADD':
      return [0, 1, 2].map((i) => a[i] + f * b[i]);
    case 'OVERLAY':
      return per((x, y) => (x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y)));
    case 'SOFT_LIGHT':
      return per((x, y) => {
        const scr = 1 - (1 - y) * (1 - x);
        return (1 - x) * y * x + x * scr;
      });
    case 'LINEAR_LIGHT':
      return [0, 1, 2].map((i) => a[i] + f * (2 * b[i] - 1));
    case 'DIFFERENCE':
      return per((x, y) => Math.abs(x - y));
    case 'EXCLUSION':
      return per((x, y) => x + y - 2 * x * y);
    case 'SUBTRACT':
      return [0, 1, 2].map((i) => a[i] - f * b[i]);
    case 'DIVIDE':
      return per(safeDiv);
    case 'HUE':
    case 'SATURATION':
    case 'COLOR':
    case 'VALUE': {
      const ha = rgbToHsvA([a[0], a[1], a[2], 1]),
        hb = rgbToHsvA([b[0], b[1], b[2], 1]);
      if (mode === 'HUE' && hb[1] !== 0) ha[0] = hb[0];
      else if (mode === 'SATURATION' && ha[1] !== 0) ha[1] = hb[1];
      else if (mode === 'COLOR' && hb[1] !== 0) {
        ha[0] = hb[0];
        ha[1] = hb[1];
      } else if (mode === 'VALUE') ha[2] = hb[2];
      else return [a[0], a[1], a[2]];
      return mix(a, hsvToRgbA(ha));
    }
    default:
      return mix(a, b);
  }
}
