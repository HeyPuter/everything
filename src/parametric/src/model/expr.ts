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

type Tok =
  | { k: 'num'; v: number }
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
      out.push({ k: 'num', v: parseFloat(m[0]) });
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
      const m = /^[A-Za-z_][A-Za-z0-9_@.]*/.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${ch}"`);
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
        const f = table?.[u.v];
        // Explicit units convert to the display unit; the result is scaled once at the end.
        if (f !== undefined) { pos++; return (t.v * f) / bare; }
      }
      return t.v;
    }
    if (t.k === 'name') {
      const p = peek();
      if (p.k === 'op' && p.v === '(') {
        const fn = FUNCS[t.v.toLowerCase()];
        if (!fn) throw new ExprError(`Unknown function "${t.v}"`);
        pos++;
        const args: number[] = [];
        if (!(peek().k === 'op' && (peek() as { v: string }).v === ')')) {
          args.push(expr());
          while (peek().k === 'op' && (peek() as { v: string }).v === ',') { pos++; args.push(expr()); }
        }
        expectOp(')');
        return fn(...args);
      }
      if (t.v in CONSTS) return CONSTS[t.v];
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
      .filter((n) => !(n in CONSTS) && !(n.toLowerCase() in FUNCS) && !(n in LENGTH_SUFFIX) && !(n in ANGLE_SUFFIX));
  } catch {
    return [];
  }
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
