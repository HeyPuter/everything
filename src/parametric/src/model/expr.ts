// Safe arithmetic expression evaluator for dimension values and equations.
// Grammar: expr := term (('+'|'-') term)*; term := unary (('*'|'/') unary)*;
// unary := ('-'|'+') unary | power; power := atom ('^' unary)?;
// atom := number [unit] | name | name '(' args ')' | '(' expr ')'.
// No eval, no property access: only numbers, named variables and a fixed
// function table.

import { ANGLE_SUFFIX, LENGTH_SUFFIX } from './units';

export class ExprError extends Error {}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  int: Math.trunc,
};

const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI };

/**
 * Whether a variable name is taken by the expression language: a constant
 * (which would win over the variable, so =pi*2 ignored a variable "pi"), a
 * unit ("2 m" is two metres, not 2 times m) or a function.
 */
export function reservedName(name: string): boolean {
  return [CONSTS, LENGTH_SUFFIX, ANGLE_SUFFIX, FUNCS].some((t) => Object.hasOwn(t, name)) || name === 'atan2';
}

type Tok =
  | { k: 'num'; v: number; at?: number; len?: number }
  | { k: 'name'; v: string }
  | { k: 'op'; v: string }
  | { k: 'end' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${ch}"`);
      out.push({ k: 'num', v: parseFloat(m[0]), at: i, len: m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_"'°]/.test(ch)) {
      if (ch === '"' || ch === "'") {
        // Quoted variable name, or an inch/foot mark right after a number.
        const prev = out[out.length - 1];
        if (prev && prev.k === 'num') { out.push({ k: 'name', v: ch }); i++; continue; }
        const end = src.indexOf(ch, i + 1);
        if (end < 0) throw new ExprError('Unclosed quote');
        out.push({ k: 'name', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      if (ch === '°') { out.push({ k: 'name', v: '°' }); i++; continue; }
      const m = /^[A-Za-z_][A-Za-z0-9_@.]*/.exec(src.slice(i))!;
      out.push({ k: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    throw new ExprError(`Unexpected "${ch}"`);
  }
  out.push({ k: 'end' });
  return out;
}

export type Lookup = (name: string) => number | undefined;

export interface EvalOptions {
  /** 'length' converts unit suffixes to mm, 'angle' to degrees. */
  kind?: 'length' | 'angle' | 'none';
  /** Scale applied to bare numbers (display unit to internal). */
  bareScale?: number;
  lookup?: Lookup;
}

export function evaluate(src: string, opts: EvalOptions = {}): number {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const kind = opts.kind ?? 'none';
  const bare = opts.bareScale ?? 1;

  const expectOp = (v: string) => {
    const t = next();
    if (t.k !== 'op' || t.v !== v) throw new ExprError(`Expected "${v}"`);
  };

  function atom(): number {
    const t = next();
    if (t.k === 'num') {
      const u = peek();
      if (u.k === 'name') {
        const table = kind === 'angle' ? ANGLE_SUFFIX : kind === 'length' ? LENGTH_SUFFIX : null;
        const f = table && Object.hasOwn(table, u.v) ? table[u.v] : undefined;
        // Explicit units convert to the display unit; the result is scaled once at the end.
        if (f !== undefined) { pos++; return (t.v * f) / bare; }
        // Variables and counts are plain numbers: say so rather than "Unexpected text".
        if (!table && (Object.hasOwn(LENGTH_SUFFIX, u.v) || Object.hasOwn(ANGLE_SUFFIX, u.v))) throw new ExprError(`A unit ("${u.v}") cannot be used here; give a plain number`);
      }
      return t.v;
    }
    if (t.k === 'name') {
      const p = peek();
      if (p.k === 'op' && p.v === '(') {
        const fn = Object.hasOwn(FUNCS, t.v.toLowerCase()) ? FUNCS[t.v.toLowerCase()] : undefined;
        if (!fn) throw new ExprError(`Unknown function "${t.v}"`);
        pos++;
        const args: number[] = [];
        if (!(peek().k === 'op' && (peek() as { v: string }).v === ')')) {
          args.push(expr());
          while (peek().k === 'op' && (peek() as { v: string }).v === ',') { pos++; args.push(expr()); }
        }
        expectOp(')');
        // round(2.567, 2) would quietly drop the 2 (and give 3); sin() is not a number.
        const variadic = fn === Math.min || fn === Math.max;
        if (variadic ? !args.length : args.length !== 1) throw new ExprError(`${t.v}() takes ${variadic ? 'one or more values' : 'one value'}`);
        return fn(...args);
      }
      if (Object.hasOwn(CONSTS, t.v)) return CONSTS[t.v];
      const v = opts.lookup?.(t.v);
      if (v === undefined) throw new ExprError(`Unknown name "${t.v}"`);
      return v;
    }
    if (t.k === 'op' && t.v === '(') {
      const v = expr();
      expectOp(')');
      return v;
    }
    throw new ExprError('Unexpected end of expression');
  }

  function power(): number {
    const base = atom();
    const p = peek();
    if (p.k === 'op' && p.v === '^') { pos++; return Math.pow(base, unary()); }
    return base;
  }

  function unary(): number {
    const p = peek();
    if (p.k === 'op' && (p.v === '-' || p.v === '+')) { pos++; const v = unary(); return p.v === '-' ? -v : v; }
    return power();
  }

  function term(): number {
    let v = unary();
    for (;;) {
      const p = peek();
      if (p.k === 'op' && (p.v === '*' || p.v === '/')) {
        pos++;
        const r = unary();
        // Caught here, not by the finite check at the end: 1/(1/0) would come out as 0.
        if (p.v === '/' && r === 0) throw new ExprError('Division by zero');
        v = p.v === '*' ? v * r : v / r;
      } else return v;
    }
  }

  function expr(): number {
    let v = term();
    for (;;) {
      const p = peek();
      if (p.k === 'op' && (p.v === '+' || p.v === '-')) {
        pos++;
        const r = term();
        v = p.v === '+' ? v + r : v - r;
      } else return v;
    }
  }

  const src2 = src.trim();
  if (!src2) throw new ExprError('Enter a value');
  const v = expr();
  if (peek().k !== 'end') throw new ExprError('Unexpected text after expression');
  if (!Number.isFinite(v)) throw new ExprError('Result is not a finite number');
  // Expressions are written in display units (variables are plain numbers in
  // display units too); convert the result to internal units.
  return v * bare;
}

/** Names referenced by an expression (for dependency ordering). */
export function referencedNames(src: string): string[] {
  try {
    return tokenize(src)
      .filter((t): t is { k: 'name'; v: string } => t.k === 'name')
      .map((t) => t.v)
      .filter((n) => !Object.hasOwn(CONSTS, n) && !Object.hasOwn(FUNCS, n.toLowerCase()) && !Object.hasOwn(LENGTH_SUFFIX, n) && !Object.hasOwn(ANGLE_SUFFIX, n));
  } catch {
    return [];
  }
}

/**
 * Rewrites the variable names an expression refers to (old name to new name),
 * leaving everything else as typed. Unit suffixes and function names are not
 * references and stay as they are.
 */
export function renameReferences(src: string, renamed: Map<string, string>): string {
  let out = '';
  let i = 0;
  let afterNumber = false;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    const num = /[0-9.]/.test(ch) ? /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest) : null;
    if (num) { out += num[0]; i += num[0].length; afterNumber = true; continue; }
    if ((ch === '"' || ch === "'") && !afterNumber) {
      const end = src.indexOf(ch, i + 1);
      if (end > i) {
        const to = renamed.get(src.slice(i + 1, end));
        out += to !== undefined ? `${ch}${to}${ch}` : src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const name = /^[A-Za-z_][A-Za-z0-9_@.]*/.exec(rest);
    if (name) {
      const call = /^\s*\(/.test(src.slice(i + name[0].length));
      const to = afterNumber || call ? undefined : renamed.get(name[0]);
      out += to ?? name[0];
      i += name[0].length;
      afterNumber = false;
      continue;
    }
    out += ch;
    i++;
    if (!/\s/.test(ch)) afterNumber = false;
  }
  return out;
}

// ---------- unit conversion ----------

type Node =
  | { t: 'num'; v: number; unit: 'length' | 'angle' | null; at: number; len: number }
  | { t: 'var'; name: string }
  | { t: 'const' }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

/** Parses an expression into a tree (same grammar as evaluate); null when it does not parse. */
function parseTree(src: string): Node | null {
  let toks: Tok[];
  try { toks = tokenize(src); } catch { return null; }
  let pos = 0;
  const peekOp = (v: string) => { const t = toks[pos]; return t.k === 'op' && t.v === v; };
  const fail = (): never => { throw new ExprError('parse'); };
  const atom = (): Node => {
    const t = toks[pos++];
    if (t.k === 'num') {
      const u = toks[pos];
      if (u.k === 'name' && (Object.hasOwn(LENGTH_SUFFIX, u.v) || Object.hasOwn(ANGLE_SUFFIX, u.v))) { pos++; return { t: 'num', v: t.v, unit: Object.hasOwn(LENGTH_SUFFIX, u.v) ? 'length' : 'angle', at: t.at!, len: t.len! }; }
      return { t: 'num', v: t.v, unit: null, at: t.at!, len: t.len! };
    }
    if (t.k === 'name') {
      if (peekOp('(')) {
        pos++;
        const args: Node[] = [];
        if (!peekOp(')')) { args.push(expr()); while (peekOp(',')) { pos++; args.push(expr()); } }
        if (!peekOp(')')) fail();
        pos++;
        return { t: 'call', fn: t.v.toLowerCase(), args };
      }
      return Object.hasOwn(CONSTS, t.v) ? { t: 'const' } : { t: 'var', name: t.v };
    }
    if (t.k === 'op' && t.v === '(') { const v = expr(); if (!peekOp(')')) fail(); pos++; return v; }
    return fail();
  };
  const power = (): Node => { const a = atom(); if (peekOp('^')) { pos++; return { t: 'bin', op: '^', a, b: unary() }; } return a; };
  const unary = (): Node => { if (peekOp('-')) { pos++; return { t: 'neg', a: unary() }; } if (peekOp('+')) { pos++; return unary(); } return power(); };
  const binary = (next: () => Node, ops: string[]) => (): Node => {
    let a = next();
    for (;;) {
      const t = toks[pos];
      if (t.k === 'op' && ops.includes(t.v)) { pos++; a = { t: 'bin', op: t.v, a, b: next() }; } else return a;
    }
  };
  const term = binary(unary, ['*', '/']);
  const expr = binary(term, ['+', '-']);
  try {
    const n = expr();
    return toks[pos].k === 'end' ? n : null;
  } catch {
    return null;
  }
}

/** Length dimension of an expression: a power of length, 'free' for plain numbers, null when unknown, NaN when inconsistent. */
type Dim = number | 'free' | null;
const SAME_DIM = new Set(['abs', 'min', 'max', 'round', 'floor', 'ceil', 'int']);

function dimOf(n: Node, vars: Map<string, number>): Dim {
  switch (n.t) {
    case 'num': return n.unit === 'length' ? 1 : n.unit === 'angle' ? 0 : 'free';
    case 'const': return 0;
    case 'var': return vars.get(n.name) ?? null;
    case 'neg': return dimOf(n.a, vars);
    case 'call': {
      if (!SAME_DIM.has(n.fn) && n.fn !== 'sqrt') return 0;
      let d: Dim = 'free';
      for (const a of n.args) d = sumDim(d, dimOf(a, vars));
      if (n.fn === 'sqrt' && typeof d === 'number') return d / 2;
      return d;
    }
    case 'bin': {
      const a = dimOf(n.a, vars), b = dimOf(n.b, vars);
      if (n.op === '+' || n.op === '-') return sumDim(a, b);
      if (n.op === '^') return a === 'free' || a === 0 ? a : NaN;
      if (a === null || b === null) return null;
      if (a === 'free' && b === 'free') return 'free';
      const da = a === 'free' ? 0 : a, db = b === 'free' ? 0 : b;
      return n.op === '*' ? da + db : da - db;
    }
  }
}

function sumDim(a: Dim, b: Dim): Dim {
  if (a === 'free') return b;
  if (b === 'free') return a;
  if (a === null || b === null) return a ?? b;
  return a === b ? a : NaN;
}

/** Learns the dimension of variables from an expression expected to have dimension d. */
function learn(n: Node, d: number, vars: Map<string, number>): boolean {
  switch (n.t) {
    case 'var': if (vars.has(n.name)) return false; vars.set(n.name, d); return true;
    case 'neg': return learn(n.a, d, vars);
    case 'call': return SAME_DIM.has(n.fn) ? n.args.some((a) => learn(a, d, vars)) : n.fn === 'sqrt' && n.args.length === 1 ? learn(n.args[0], 2 * d, vars) : false;
    case 'bin': {
      if (n.op === '+' || n.op === '-') return learn(n.a, d, vars) || learn(n.b, d, vars);
      const known = (x: Node) => { const v = dimOf(x, vars); return v === 'free' ? 0 : typeof v === 'number' && Number.isFinite(v) ? v : null; };
      const da = known(n.a), db = known(n.b);
      if (n.op === '*') return da !== null ? learn(n.b, d - da, vars) : db !== null ? learn(n.a, d - db, vars) : false;
      if (n.op === '/') return da !== null ? learn(n.b, da - d, vars) : db !== null ? learn(n.a, d + db, vars) : false;
      return false;
    }
    default: return false;
  }
}

/** Collects the plain numbers of an expression of dimension d with the power of length each stands for. */
function plainNumbers(n: Node, d: number, vars: Map<string, number>, out: { at: number; len: number; v: number; d: number }[]) {
  const fixed = (x: Node) => { const v = dimOf(x, vars); return typeof v === 'number' ? v : null; };
  switch (n.t) {
    case 'num': if (!n.unit && d !== 0) out.push({ at: n.at, len: n.len, v: n.v, d }); return;
    case 'neg': plainNumbers(n.a, d, vars, out); return;
    case 'call':
      for (const a of n.args) plainNumbers(a, SAME_DIM.has(n.fn) ? d : n.fn === 'sqrt' ? 2 * d : 0, vars, out);
      return;
    case 'bin': {
      if (n.op === '+' || n.op === '-') { plainNumbers(n.a, d, vars, out); plainNumbers(n.b, d, vars, out); return; }
      if (n.op === '^') { plainNumbers(n.a, 0, vars, out); plainNumbers(n.b, 0, vars, out); return; }
      const fa = fixed(n.a), fb = fixed(n.b);
      // A plain-number factor takes the dimension the other factor lacks; two plain factors: the first carries it.
      const da = fa ?? (n.op === '*' ? d - (fb ?? 0) : d + (fb ?? 0));
      const db = fb ?? (n.op === '*' ? d - da : da - d);
      plainNumbers(n.a, da, vars, out);
      plainNumbers(n.b, db, vars, out);
      return;
    }
    default:
  }
}

/**
 * Rewrites expressions written in one length unit so that they keep their
 * value in another: plain numbers that stand for lengths are scaled by k
 * (old display unit / new display unit). Variables are lengths when the
 * dimensions and feature values that use them say so. Returns the rewritten
 * expressions in the order given, null for one that cannot be converted.
 */
export function convertExpressionUnits(items: { src: string; dim: number | 'variable'; name?: string }[], k: number): (string | null)[] {
  const trees = items.map((it) => parseTree(it.src.replace(/^=/, '')));
  const vars = new Map<string, number>();
  for (let changed = true, guard = 0; changed && guard < 50; guard++) {
    changed = false;
    items.forEach((it, i) => {
      const t = trees[i];
      if (!t) return;
      const d = it.dim === 'variable' ? vars.get(it.name!) : it.dim;
      if (d !== undefined) { if (learn(t, d, vars)) changed = true; return; }
      // A variable whose equation has a known dimension has that dimension.
      const own = dimOf(t, vars);
      if (typeof own === 'number' && Number.isFinite(own)) { vars.set(it.name!, own); changed = true; }
    });
  }
  return items.map((it, i) => {
    const t = trees[i];
    if (!t) return null;
    const d = it.dim === 'variable' ? vars.get(it.name!) ?? 0 : it.dim;
    const own = dimOf(t, vars);
    if (own !== 'free' && own !== d) return own === null && d === 0 ? it.src : null;
    const nums: { at: number; len: number; v: number; d: number }[] = [];
    const prefix = it.src.startsWith('=') ? 1 : 0;
    plainNumbers(t, d, vars, nums);
    let out = it.src;
    for (const n of nums.sort((a, b) => b.at - a.at)) {
      const at = n.at + prefix;
      out = out.slice(0, at) + String(Number((n.v * k ** n.d).toPrecision(12))) + out.slice(at + n.len);
    }
    return out;
  });
}

/**
 * Evaluates global variables in dependency order. Returns values and per-name
 * errors (cycles and unknown names are errors, never exceptions).
 */
export function evaluateVariables(vars: { name: string; expr: string }[]): {
  values: Map<string, number>;
  errors: Map<string, string>;
} {
  const values = new Map<string, number>();
  const errors = new Map<string, string>();
  const byName = new Map(vars.map((v) => [v.name, v]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): number | undefined => {
    if (values.has(name)) return values.get(name);
    const v = byName.get(name);
    if (!v) return undefined;
    if (state.get(name) === 'visiting') { errors.set(name, 'Circular reference'); return undefined; }
    if (state.get(name) === 'done') return undefined;
    state.set(name, 'visiting');
    try {
      const r = evaluate(v.expr.replace(/^=/, ''), {
        lookup: (n) => {
          const x = visit(n);
          if (x === undefined && !errors.has(name)) throw new ExprError(byName.has(n) ? `"${n}" has an error` : `Unknown name "${n}"`);
          return x;
        },
      });
      values.set(name, r);
      return r;
    } catch (e) {
      if (!errors.has(name)) errors.set(name, (e as Error).message);
      return undefined;
    } finally {
      state.set(name, 'done');
    }
  };
  for (const v of vars) visit(v.name);
  return { values, errors };
}
