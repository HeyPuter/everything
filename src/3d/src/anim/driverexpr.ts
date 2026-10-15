// Driver expressions: a safe evaluator for a Python-like expression subset.
// Expressions are parsed once into closures (cached per source string). Nothing here can reach
// globals: names resolve to driver variables, `frame`, `self` (when allowed), and a fixed set of
// math functions and constants.
//
// Supported: numbers, strings (for subscripts), names, attribute access, subscripts, calls,
// tuples/lists, unary + - ~ not, ** * / // % + - << >> & ^ |, chained comparisons, `and`/`or`,
// and `a if cond else b`.

export type Value = number | string | boolean | Value[] | RefValue | FuncValue | ModuleValue | null;

/** A lazily resolved data reference (e.g. `self.location`): `path` is an RNA path on `root`. */
export interface RefValue {
  kind: 'ref';
  path: string;
  /** read the referenced value (undefined when the path doesn't resolve) */
  read: (path: string) => unknown;
}
interface FuncValue {
  kind: 'func';
  name: string;
  fn: (...args: Value[]) => Value;
}
interface ModuleValue {
  kind: 'module';
  name: string;
  members: Record<string, Value>;
}

export interface ExprEnv {
  /** driver variables (plus `frame`) */
  vars: Record<string, number>;
  /** the driven data-block, available when the driver allows `self` */
  self?: RefValue;
}

export interface CompiledExpr {
  source: string;
  run: (env: ExprEnv) => Value;
  /** names read from the environment (variables, frame, self) */
  names: Set<string>;
  /** only numbers, variables, operators and math functions: no data access */
  simple: boolean;
}

export class ExprError extends Error {
  constructor(
    public kind: string,
    message: string,
  ) {
    super(message);
  }
}

const err = (kind: string, msg: string) => new ExprError(kind, msg);

// ---------------------------------------------------------------------------
// builtins

const isNum = (v: Value): v is number => typeof v === 'number';

function toNum(v: Value, what = 'value'): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'ref') return toNum(deref(v), what);
  if (v === null) throw err('TypeError', `${what} is None, expected a number`);
  if (Array.isArray(v)) throw err('TypeError', `${what} is a sequence, expected a number`);
  if (typeof v === 'string') throw err('TypeError', `${what} is a string, expected a number`);
  throw err('TypeError', `${what} is not a number`);
}

/** Resolve references to plain values (numbers, booleans → numbers, arrays). */
export function deref(v: Value): Value {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.kind === 'ref') {
    const raw = v.read(v.path);
    if (raw === undefined) throw err('AttributeError', `'${v.path}' could not be found`);
    return fromRaw(raw, v);
  }
  return v;
}

function fromRaw(raw: unknown, ref?: RefValue): Value {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'string') return raw;
  if (raw === null) return null;
  if (Array.isArray(raw) || ArrayBuffer.isView(raw)) {
    const arr = Array.from(raw as ArrayLike<unknown>);
    if (arr.every((x) => typeof x === 'number' || typeof x === 'boolean')) return arr.map((x) => (typeof x === 'boolean' ? +x : (x as number)));
  }
  // structured data stays a reference so attributes and subscripts can continue the path
  if (ref) return ref;
  throw err('TypeError', 'unsupported value');
}

function seq(v: Value, fn: string): Value[] {
  const d = deref(v);
  if (Array.isArray(d)) return d;
  if (typeof d === 'string') return [...d];
  throw err('TypeError', `${fn}() expects a sequence`);
}

function pyRound(x: number, nd?: number) {
  const f = nd ? 10 ** nd : 1;
  const y = x * f;
  let r = Math.round(y);
  // round half to even
  if (Math.abs(y % 1) === 0.5) r = 2 * Math.round(y / 2);
  return r / f;
}

function minmax(name: string, pick: (a: number, b: number) => boolean) {
  return (...args: Value[]): Value => {
    const items = args.length === 1 ? seq(args[0], name) : args;
    if (!items.length) throw err('ValueError', `${name}() arg is an empty sequence`);
    let best = toNum(items[0]);
    for (const it of items.slice(1)) {
      const n = toNum(it);
      if (pick(n, best)) best = n;
    }
    return best;
  };
}

const n1 = (f: (x: number) => number, name: string) => (...a: Value[]) => {
  if (a.length !== 1) throw err('TypeError', `${name}() takes exactly one argument (${a.length} given)`);
  return f(toNum(a[0]));
};
const n2 = (f: (x: number, y: number) => number, name: string) => (...a: Value[]) => {
  if (a.length !== 2) throw err('TypeError', `${name}() takes exactly 2 arguments (${a.length} given)`);
  return f(toNum(a[0]), toNum(a[1]));
};
const domain = (ok: (x: number) => boolean, f: (x: number) => number) => (x: number) => {
  if (!ok(x)) throw err('ValueError', 'math domain error');
  return f(x);
};

const MATH_FUNCS: Record<string, (...a: Value[]) => Value> = {
  sin: n1(Math.sin, 'sin'),
  cos: n1(Math.cos, 'cos'),
  tan: n1(Math.tan, 'tan'),
  asin: n1(domain((x) => x >= -1 && x <= 1, Math.asin), 'asin'),
  acos: n1(domain((x) => x >= -1 && x <= 1, Math.acos), 'acos'),
  atan: n1(Math.atan, 'atan'),
  atan2: n2(Math.atan2, 'atan2'),
  sinh: n1(Math.sinh, 'sinh'),
  cosh: n1(Math.cosh, 'cosh'),
  tanh: n1(Math.tanh, 'tanh'),
  asinh: n1(Math.asinh, 'asinh'),
  acosh: n1(domain((x) => x >= 1, Math.acosh), 'acosh'),
  atanh: n1(domain((x) => x > -1 && x < 1, Math.atanh), 'atanh'),
  exp: n1(Math.exp, 'exp'),
  expm1: n1(Math.expm1, 'expm1'),
  log: (...a: Value[]) => {
    const x = toNum(a[0]);
    if (x <= 0) throw err('ValueError', 'math domain error');
    return a.length > 1 ? Math.log(x) / Math.log(toNum(a[1])) : Math.log(x);
  },
  log10: n1(domain((x) => x > 0, Math.log10), 'log10'),
  log2: n1(domain((x) => x > 0, Math.log2), 'log2'),
  log1p: n1(domain((x) => x > -1, Math.log1p), 'log1p'),
  sqrt: n1(domain((x) => x >= 0, Math.sqrt), 'sqrt'),
  pow: n2(Math.pow, 'pow'),
  fabs: n1(Math.abs, 'fabs'),
  floor: n1(Math.floor, 'floor'),
  ceil: n1(Math.ceil, 'ceil'),
  trunc: n1(Math.trunc, 'trunc'),
  fmod: n2((a, b) => {
    if (b === 0) throw err('ValueError', 'math domain error');
    return a % b;
  }, 'fmod'),
  hypot: (...a: Value[]) => Math.hypot(...a.map((x) => toNum(x))),
  copysign: n2((a, b) => Math.abs(a) * (b < 0 || Object.is(b, -0) ? -1 : 1), 'copysign'),
  degrees: n1((x) => (x * 180) / Math.PI, 'degrees'),
  radians: n1((x) => (x * Math.PI) / 180, 'radians'),
  isnan: n1((x) => +Number.isNaN(x), 'isnan'),
  isinf: n1((x) => +(Math.abs(x) === Infinity), 'isinf'),
  isfinite: n1((x) => +Number.isFinite(x), 'isfinite'),
  factorial: n1((x) => {
    if (x < 0 || !Number.isInteger(x)) throw err('ValueError', 'factorial() only accepts non-negative integers');
    let r = 1;
    for (let i = 2; i <= x; i++) r *= i;
    return r;
  }, 'factorial'),
};

const MATH_CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, inf: Infinity, nan: NaN };

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

const BUILTIN_FUNCS: Record<string, (...a: Value[]) => Value> = {
  ...MATH_FUNCS,
  abs: (...a: Value[]) => {
    const v = deref(a[0]);
    return Array.isArray(v) ? Math.hypot(...v.map((x) => toNum(x))) : Math.abs(toNum(v));
  },
  min: minmax('min', (a, b) => a < b),
  max: minmax('max', (a, b) => a > b),
  sum: (...a: Value[]) => seq(a[0], 'sum').reduce<number>((s, x) => s + toNum(x), a.length > 1 ? toNum(a[1]) : 0),
  len: (...a: Value[]) => seq(a[0], 'len').length,
  round: (...a: Value[]) => pyRound(toNum(a[0]), a.length > 1 ? toNum(a[1]) : undefined),
  int: (...a: Value[]) => {
    const v = deref(a[0] ?? 0);
    if (typeof v === 'string') {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n)) throw err('ValueError', `invalid literal for int(): '${v}'`);
      return n;
    }
    return Math.trunc(toNum(v));
  },
  float: (...a: Value[]) => {
    const v = deref(a[0] ?? 0);
    if (typeof v === 'string') {
      const n = Number(v.trim());
      if (v.trim() === '' || Number.isNaN(n)) throw err('ValueError', `could not convert string to float: '${v}'`);
      return n;
    }
    return toNum(v);
  },
  bool: (...a: Value[]) => +truthy(a[0] ?? 0),
  clamp: (...a: Value[]) => clamp(toNum(a[0]), a.length > 1 ? toNum(a[1]) : 0, a.length > 2 ? toNum(a[2]) : 1),
  lerp: (...a: Value[]) => {
    const [x, y, t] = a.map((v) => toNum(v));
    return x + (y - x) * t;
  },
  smoothstep: (...a: Value[]) => {
    const [e0, e1, x] = a.map((v) => toNum(v));
    const t = e1 === e0 ? (x < e0 ? 0 : 1) : clamp((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  },
  sign: n1(Math.sign, 'sign'),
};

/** Builtin names (for completion and validation). */
export const builtinNames = (): string[] => [...Object.keys(BUILTIN_FUNCS), ...Object.keys(MATH_CONSTS), 'frame', 'True', 'False', 'None', 'math'];

const mathModule: ModuleValue = {
  kind: 'module',
  name: 'math',
  members: {
    ...Object.fromEntries(Object.entries(MATH_FUNCS).map(([k, fn]) => [k, { kind: 'func', name: k, fn } as FuncValue])),
    ...MATH_CONSTS,
  },
};

function truthy(v: Value): boolean {
  const d = deref(v);
  if (typeof d === 'number') return d !== 0;
  if (typeof d === 'boolean') return d;
  if (typeof d === 'string') return d.length > 0;
  if (Array.isArray(d)) return d.length > 0;
  return d !== null;
}

// ---------------------------------------------------------------------------
// lexer

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: 'end' };

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'in', 'is', 'lambda', 'for', 'True', 'False', 'None']);
/** Words that may not be used as variable names. */
export const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]); // prettier-ignore

const OPS = ['**', '//', '<<', '>>', '<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '<', '>', '(', ')', '[', ']', ',', '.', '&', '|', '^', '~'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') break; // comment
    // numbers: 12, 1.5, .5, 1e-3, 0x1F, 1_000
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][-+]?\d+)?\.?)/.exec(src.slice(i));
      let text = m![0];
      // "1." is a float; "1.x" isn't valid python but "1 .x" is attribute access - keep it simple
      i += text.length;
      text = text.replace(/_/g, '');
      const v = /^0[xX]/.test(text) ? parseInt(text.slice(2), 16) : /^0[bB]/.test(text) ? parseInt(text.slice(2), 2) : /^0[oO]/.test(text) ? parseInt(text.slice(2), 8) : Number(text);
      if (Number.isNaN(v)) throw err('SyntaxError', `invalid number '${text}'`);
      out.push({ t: 'num', v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1,
        s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw err('SyntaxError', 'unterminated string literal');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw err('SyntaxError', `invalid character '${c}'`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  out.push({ t: 'end' });
  return out;
}

// ---------------------------------------------------------------------------
// parser → closures

type Fn = (env: ExprEnv) => Value;

interface ParseState {
  toks: Tok[];
  i: number;
  names: Set<string>;
  simple: boolean;
}

const BINOPS: Record<string, (a: Value, b: Value) => Value> = {
  '+': (a, b) => arith(a, b, (x, y) => x + y, '+'),
  '-': (a, b) => arith(a, b, (x, y) => x - y, '-'),
  '*': (a, b) => arith(a, b, (x, y) => x * y, '*'),
  '/': (a, b) =>
    arith(
      a,
      b,
      (x, y) => {
        if (y === 0) throw err('ZeroDivisionError', 'division by zero');
        return x / y;
      },
      '/',
    ),
  '//': (a, b) =>
    arith(
      a,
      b,
      (x, y) => {
        if (y === 0) throw err('ZeroDivisionError', 'integer division or modulo by zero');
        return Math.floor(x / y);
      },
      '//',
    ),
  '%': (a, b) =>
    arith(
      a,
      b,
      (x, y) => {
        if (y === 0) throw err('ZeroDivisionError', 'modulo by zero');
        const r = x % y;
        return r !== 0 && r < 0 !== y < 0 ? r + y : r;
      },
      '%',
    ),
  '**': (a, b) =>
    arith(
      a,
      b,
      (x, y) => {
        if (x === 0 && y < 0) throw err('ZeroDivisionError', '0.0 cannot be raised to a negative power');
        return x ** y;
      },
      '**',
    ),
  '<<': (a, b) => toInt(a) * 2 ** toInt(b),
  '>>': (a, b) => Math.floor(toInt(a) / 2 ** toInt(b)),
  '&': (a, b) => Number(BigInt(toInt(a)) & BigInt(toInt(b))),
  '|': (a, b) => Number(BigInt(toInt(a)) | BigInt(toInt(b))),
  '^': (a, b) => Number(BigInt(toInt(a)) ^ BigInt(toInt(b))),
};

function toInt(v: Value): number {
  const n = toNum(v);
  if (!Number.isInteger(n)) throw err('TypeError', 'bitwise operations need integers');
  return n;
}

/** Arithmetic on numbers, element-wise on equal-length sequences, sequence × number broadcasts. */
function arith(a: Value, b: Value, f: (x: number, y: number) => number, op: string): Value {
  const x = deref(a),
    y = deref(b);
  if (typeof x === 'string' && typeof y === 'string' && op === '+') return x + y;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (Array.isArray(x) && Array.isArray(y)) {
      if (op === '+' && x.length !== y.length) return [...x, ...y];
      if (x.length !== y.length) throw err('ValueError', 'sequences of different lengths');
      if (op === '*') return x.reduce<number>((s, v, i) => s + toNum(v) * toNum(y[i]), 0); // dot product
      return x.map((v, i) => f(toNum(v), toNum(y[i])));
    }
    if (Array.isArray(x)) return x.map((v) => f(toNum(v), toNum(y)));
    return (y as Value[]).map((v) => f(toNum(x), toNum(v)));
  }
  return f(toNum(x, `left operand of ${op}`), toNum(y, `right operand of ${op}`));
}

function compare(op: string, a: Value, b: Value): boolean {
  const x = deref(a),
    y = deref(b);
  if (op === '==' || op === '!=') {
    const eq = Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => toNum(v) === toNum(y[i])) : typeof x === 'string' || typeof y === 'string' ? x === y : toNum(x) === toNum(y);
    return op === '==' ? eq : !eq;
  }
  if (typeof x === 'string' && typeof y === 'string') return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
  const p = toNum(x),
    q = toNum(y);
  return op === '<' ? p < q : op === '>' ? p > q : op === '<=' ? p <= q : p >= q;
}

const AXES: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

function getAttr(obj: Value, name: string): Value {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj.kind === 'module') {
      if (!(name in obj.members)) throw err('AttributeError', `module '${obj.name}' has no attribute '${name}'`);
      return obj.members[name];
    }
    if (obj.kind === 'ref') {
      // vector swizzles on array properties: self.location.x
      if (name in AXES) {
        const raw = obj.read(obj.path);
        if (Array.isArray(raw) || ArrayBuffer.isView(raw)) return getItem(fromRaw(raw), AXES[name]);
      }
      return { kind: 'ref', path: obj.path ? `${obj.path}.${name}` : name, read: obj.read };
    }
  }
  if (Array.isArray(obj) && name in AXES) return getItem(obj, AXES[name]);
  throw err('AttributeError', `value has no attribute '${name}'`);
}

function getItem(obj: Value, key: Value): Value {
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.kind === 'ref') {
    const k = deref(key);
    const raw = obj.read(obj.path);
    if ((Array.isArray(raw) || ArrayBuffer.isView(raw)) && typeof k === 'number') {
      const arr = fromRaw(raw) as Value[];
      if (Array.isArray(arr)) return getItem(arr, k);
    }
    const part = typeof k === 'string' ? `["${k.replace(/"/g, '\\"')}"]` : `[${toNum(k)}]`;
    return { kind: 'ref', path: obj.path + part, read: obj.read };
  }
  const d = deref(obj);
  if (Array.isArray(d) || typeof d === 'string') {
    let i = toNum(deref(key), 'index');
    if (!Number.isInteger(i)) throw err('TypeError', 'indices must be integers');
    if (i < 0) i += d.length;
    if (i < 0 || i >= d.length) throw err('IndexError', 'index out of range');
    return d[i];
  }
  throw err('TypeError', 'value is not subscriptable');
}

function call(fnv: Value, args: Value[]): Value {
  if (fnv && typeof fnv === 'object' && !Array.isArray(fnv) && fnv.kind === 'func') return fnv.fn(...args);
  throw err('TypeError', 'value is not callable');
}

function parse(src: string): CompiledExpr {
  const st: ParseState = { toks: lex(src), i: 0, names: new Set(), simple: true };
  const peek = () => st.toks[st.i];
  const isOp = (v: string) => {
    const t = peek();
    return t.t === 'op' && t.v === v;
  };
  const isKw = (v: string) => {
    const t = peek();
    return t.t === 'name' && t.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw err('SyntaxError', `expected '${v}'${describe(peek())}`);
    st.i++;
  };
  const describe = (t: Tok) => (t.t === 'end' ? ' at end of expression' : ` before '${'v' in t ? t.v : ''}'`);

  const test = (): Fn => {
    const a = orTest();
    if (isKw('if')) {
      st.i++;
      const c = orTest();
      if (!isKw('else')) throw err('SyntaxError', `expected 'else'${describe(peek())}`);
      st.i++;
      const b = test();
      return (env) => (truthy(c(env)) ? a(env) : b(env));
    }
    return a;
  };
  const orTest = (): Fn => {
    let a = andTest();
    while (isKw('or')) {
      st.i++;
      const l = a,
        r = andTest();
      a = (env) => {
        const v = l(env);
        return truthy(v) ? v : r(env);
      };
    }
    return a;
  };
  const andTest = (): Fn => {
    let a = notTest();
    while (isKw('and')) {
      st.i++;
      const l = a,
        r = notTest();
      a = (env) => {
        const v = l(env);
        return truthy(v) ? r(env) : v;
      };
    }
    return a;
  };
  const notTest = (): Fn => {
    if (isKw('not')) {
      st.i++;
      const a = notTest();
      return (env) => !truthy(a(env));
    }
    return comparison();
  };
  const CMP = ['<', '>', '<=', '>=', '==', '!='];
  const comparison = (): Fn => {
    const first = bitOr();
    const ops: string[] = [],
      rest: Fn[] = [];
    while (peek().t === 'op' && CMP.includes((peek() as { v: string }).v)) {
      ops.push((st.toks[st.i++] as { v: string }).v);
      rest.push(bitOr());
    }
    if (!ops.length) return first;
    // chained: a < b < c  ==  a < b and b < c
    return (env) => {
      let left = first(env);
      for (let k = 0; k < ops.length; k++) {
        const right = rest[k](env);
        if (!compare(ops[k], left, right)) return false;
        left = right;
      }
      return true;
    };
  };
  const binLevel = (ops: string[], next: () => Fn) => (): Fn => {
    let a = next();
    while (peek().t === 'op' && ops.includes((peek() as { v: string }).v)) {
      const op = (st.toks[st.i++] as { v: string }).v;
      const l = a,
        r = next(),
        f = BINOPS[op];
      a = (env) => f(l(env), r(env));
    }
    return a;
  };
  const factor = (): Fn => {
    if (isOp('-') || isOp('+') || isOp('~')) {
      const op = (st.toks[st.i++] as { v: string }).v;
      const a = factor();
      if (op === '+') return (env) => arith(a(env), 0, (x) => x, '+');
      if (op === '~') return (env) => -toInt(a(env)) - 1;
      return (env) => arith(a(env), 0, (x) => -x, '-');
    }
    return power();
  };
  const power = (): Fn => {
    const a = primary();
    if (isOp('**')) {
      st.i++;
      const b = factor(); // right associative, binds tighter than unary on the left
      return (env) => BINOPS['**'](a(env), b(env));
    }
    return a;
  };
  const arithExpr = binLevel(['+', '-'], binLevel(['*', '/', '//', '%'], factor));
  const shiftExpr = binLevel(['<<', '>>'], arithExpr);
  const andExpr = binLevel(['&'], shiftExpr);
  const xorExpr = binLevel(['^'], andExpr);
  const bitOr = binLevel(['|'], xorExpr);

  const primary = (): Fn => {
    let a = atom();
    for (;;) {
      if (isOp('(')) {
        st.i++;
        const args: Fn[] = [];
        if (!isOp(')')) {
          args.push(test());
          while (isOp(',')) {
            st.i++;
            if (isOp(')')) break;
            args.push(test());
          }
        }
        expectOp(')');
        const f = a;
        a = (env) =>
          call(
            f(env),
            args.map((x) => x(env)),
          );
        continue;
      }
      if (isOp('[')) {
        st.i++;
        const k = test();
        expectOp(']');
        const o = a;
        a = (env) => getItem(o(env), k(env));
        continue;
      }
      if (isOp('.')) {
        st.i++;
        const t = st.toks[st.i++];
        if (t.t !== 'name') throw err('SyntaxError', 'expected an attribute name after "."');
        const o = a,
          name = t.v;
        a = (env) => getAttr(o(env), name);
        continue;
      }
      return a;
    }
  };

  const atom = (): Fn => {
    const t = st.toks[st.i++];
    if (t.t === 'num') {
      const v = t.v;
      return () => v;
    }
    if (t.t === 'str') {
      const v = t.v;
      return () => v;
    }
    if (t.t === 'op' && (t.v === '(' || t.v === '[')) {
      const close = t.v === '(' ? ')' : ']';
      if (isOp(close)) {
        st.i++;
        return () => [];
      }
      const items = [test()];
      let tuple = t.v === '[';
      while (isOp(',')) {
        st.i++;
        tuple = true;
        if (isOp(close)) break;
        items.push(test());
      }
      expectOp(close);
      if (!tuple) return items[0];
      return (env) => items.map((f) => deref(f(env)));
    }
    if (t.t === 'name') {
      const name = t.v;
      if (name === 'True') return () => true;
      if (name === 'False') return () => false;
      if (name === 'None') return () => null;
      if (KEYWORDS.has(name)) throw err('SyntaxError', `unexpected '${name}'`);
      st.names.add(name);
      if (name === 'self') st.simple = false;
      return (env) => lookup(env, name);
    }
    if (t.t === 'end') throw err('SyntaxError', 'unexpected end of expression');
    throw err('SyntaxError', `unexpected '${t.v}'`);
  };

  const run = test();
  if (peek().t !== 'end') throw err('SyntaxError', `unexpected ${'v' in peek() ? `'${(peek() as { v: string }).v}'` : 'token'}`);
  // attribute access and subscripts on data (not on the math module) need data lookups
  if (st.toks.some((x) => x.t === 'str')) st.simple = false;
  return { source: src, run, names: st.names, simple: st.simple };
}

function lookup(env: ExprEnv, name: string): Value {
  if (name in env.vars) return env.vars[name];
  if (name === 'self') {
    if (env.self) return env.self;
    throw err('NameError', "name 'self' is not defined (enable Use Self)");
  }
  if (name in MATH_CONSTS) return MATH_CONSTS[name];
  if (name in BUILTIN_FUNCS) return { kind: 'func', name, fn: BUILTIN_FUNCS[name] };
  if (name === 'math') return mathModule;
  throw err('NameError', `name '${name}' is not defined`);
}

const compiled = new Map<string, CompiledExpr | ExprError>();

/** Parse (cached). Throws ExprError on syntax errors. */
export function compileExpr(src: string): CompiledExpr {
  let c = compiled.get(src);
  if (!c) {
    try {
      c = parse(src);
    } catch (e) {
      c = e instanceof ExprError ? e : err('SyntaxError', String(e));
    }
    if (compiled.size > 2000) compiled.clear();
    compiled.set(src, c);
  }
  if (c instanceof ExprError) throw c;
  return c;
}

/** Evaluate to a number (booleans count as 0/1). */
export function runExpr(c: CompiledExpr, env: ExprEnv): number {
  const v = deref(c.run(env));
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isNum(v)) return v;
  if (v === null) throw err('TypeError', 'expression evaluated to None');
  if (Array.isArray(v)) throw err('TypeError', 'expression evaluated to a sequence, not a number');
  throw err('TypeError', 'expression did not evaluate to a number');
}

/** Error text in "Kind: message" form. */
export function exprErrorText(e: unknown): string {
  if (e instanceof ExprError) return `${e.kind}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
