// Script execution: output stream (shared by the Python Console), undo grouping
// ("Run Script" = one undo step), JavaScript execution with line-numbered errors.
import { app } from '../app/app';
import { scriptState, Struct, PropCollection, BoundArray } from './rna';
import { bpy, bpy_extras } from './api';
import { mathutils, VecBase, Matrix } from './mathutils';
import { scriptModules } from './jsmodules';

// ---------------------------------------------------------------------------
// output (scrollback of the Python Console; print() from scripts lands here too)

export type LineType = 'OUTPUT' | 'INPUT' | 'INFO' | 'ERROR';
export interface ConsoleLine {
  text: string;
  type: LineType;
}

export const output = {
  lines: [] as ConsoleLine[],
  listeners: new Set<() => void>(),
  push(text: string, type: LineType = 'OUTPUT') {
    for (const l of String(text).replace(/\n$/, '').split('\n')) this.lines.push({ text: l, type });
    if (this.lines.length > 5000) this.lines.splice(0, this.lines.length - 5000);
    this.notify();
  },
  clear() {
    this.lines.length = 0;
    this.notify();
  },
  notify() {
    for (const f of this.listeners) f();
  },
};

// ---------------------------------------------------------------------------
// undo grouping

/**
 * Run `fn` as one undoable unit: operator calls inside do not push their own undo
 * steps; a single step named `label` is pushed afterwards if anything changed.
 */
export function inScript<T>(label: string, fn: () => T): T {
  const top = scriptState.depth === 0;
  const a = app as unknown as { pushUndo: (l: string) => void };
  if (top) {
    scriptState.mutated = false;
    a.pushUndo = () => {
      scriptState.mutated = true;
    };
  }
  scriptState.depth++;
  try {
    return fn();
  } finally {
    scriptState.depth--;
    if (top) {
      delete (a as Partial<typeof a>).pushUndo;
      if (scriptState.mutated) app.pushUndo(label);
      scriptState.mutated = false;
      app.lastOp = null;
      if (typeof requestAnimationFrame === 'function') app.changed('doc', 'select', 'mode', 'frame', 'ui');
    }
  }
}

/**
 * Run script code inside an operator (a registered script operator's execute): nested
 * operator calls don't push their own undo steps; the outer operator pushes one.
 */
export function nestedInOperator<T>(fn: () => T): T {
  const a = app as unknown as { pushUndo: (l: string) => void };
  const patched = Object.prototype.hasOwnProperty.call(a, 'pushUndo');
  if (!patched)
    a.pushUndo = () => {
      scriptState.mutated = true;
    };
  scriptState.depth++;
  try {
    return fn();
  } finally {
    scriptState.depth--;
    if (!patched) delete (a as Partial<typeof a>).pushUndo;
  }
}

// ---------------------------------------------------------------------------
// value formatting (console echo)

export function formatValue(v: unknown, depth = 0): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return depth ? JSON.stringify(v) : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'function') return (v as { toString(): string }).toString === Function.prototype.toString ? `<function ${v.name || 'anonymous'}>` : String(v);
  if (v instanceof VecBase || v instanceof Matrix) return (v as unknown as { repr(): string }).repr();
  if (v instanceof Struct || v instanceof PropCollection || v instanceof BoundArray) return (v as unknown as { repr(): string }).repr();
  if (v instanceof Set) return `Set {${[...v].map((x) => formatValue(x, depth + 1)).join(', ')}}`;
  if (Array.isArray(v)) return depth > 2 ? '[…]' : `[${v.slice(0, 100).map((x) => formatValue(x, depth + 1)).join(', ')}${v.length > 100 ? ', …' : ''}]`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${(v as unknown as ArrayLike<number>).length})`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  const o = v as { toString?: () => string; __type?: string };
  if (o.__type && typeof o.toString === 'function' && o.toString !== Object.prototype.toString) return o.toString();
  if (depth > 2) return '{…}';
  try {
    return `{${Object.entries(v as object)
      .filter(([k]) => !k.startsWith('__'))
      .slice(0, 30)
      .map(([k, x]) => `${k}: ${formatValue(x, depth + 1)}`)
      .join(', ')}}`;
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// JavaScript

export interface RunResult {
  ok: boolean;
  error?: string;
  line?: number;
  traceback?: string;
}

const printFn = (...a: unknown[]) => output.push(a.map((x) => (typeof x === 'string' ? x : formatValue(x))).join(' '), 'OUTPUT');
const scriptConsole = {
  log: printFn,
  info: printFn,
  debug: printFn,
  warn: (...a: unknown[]) => output.push(a.map((x) => (typeof x === 'string' ? x : formatValue(x))).join(' '), 'INFO'),
  error: (...a: unknown[]) => output.push(a.map((x) => (typeof x === 'string' ? x : formatValue(x))).join(' '), 'ERROR'),
};

/** Globals available to JavaScript scripts and the JS console. */
export function jsGlobals(): Record<string, unknown> {
  return { bpy, bpy_extras, mathutils, ...mathutils, ...scriptModules, C: bpy.context, D: bpy.data, print: printFn, console: scriptConsole };
}

let lineOffset: number | null = null;
function functionLineOffset(): number {
  if (lineOffset !== null) return lineOffset;
  try {
    new Function('"use strict";\nthrow new Error("probe");\n//# sourceURL=__p3d_probe__')();
  } catch (e) {
    const m = /__p3d_probe__:(\d+)/.exec(String((e as Error).stack));
    lineOffset = m ? Number(m[1]) - 2 : 2;
  }
  return lineOffset ?? 2;
}

function errorLine(e: unknown, name: string): number | undefined {
  const stack = String((e as Error)?.stack ?? '');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}:(\\d+)(?::\\d+)?`).exec(stack);
  if (m) return Math.max(1, Number(m[1]) - functionLineOffset() - 1);
  return undefined;
}

/** Locate a syntax error by compiling growing prefixes of the source. */
function syntaxErrorLine(code: string, message: string): number | undefined {
  const lines = code.split('\n');
  for (let n = 1; n <= lines.length; n++) {
    try {
      new Function(lines.slice(0, n).join('\n'));
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === message && !/end of input|Unterminated/.test(msg)) return n;
      continue;
    }
  }
  return undefined;
}

const sanitizeName = (name: string) => name.replace(/[^\w.-]/g, '_') || 'script.js';

/** Run JavaScript source as a script (one undo step). */
export function runJavaScript(code: string, name = 'script.js', label = 'Run Script'): RunResult {
  const g = jsGlobals();
  const file = sanitizeName(name);
  let fn: (...a: unknown[]) => unknown;
  try {
    fn = new Function(...Object.keys(g), `"use strict";\n${code}\n//# sourceURL=${file}`) as typeof fn;
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: `SyntaxError: ${msg}`, line: syntaxErrorLine(code, msg) };
  }
  try {
    inScript(label, () => fn(...Object.values(g)));
    return { ok: true };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: `${err?.name && !String(err.message).startsWith(err.name) ? `${err.name}: ` : ''}${err?.message ?? String(e)}`, line: errorLine(e, file), traceback: String(err?.stack ?? '') };
  }
}

// ---------------------------------------------------------------------------
// JavaScript console (persistent scope)

const consoleScope: Record<string, unknown> = {};

const scopeProxy = new Proxy(consoleScope, {
  has(t, p) {
    if (typeof p !== 'string' || p.startsWith('__')) return false;
    if (p in t) return true;
    if (p in jsGlobalsCache()) return true;
    return !(p in globalThis);
  },
  get(t, p) {
    if (typeof p !== 'string') return undefined;
    if (p in t) return t[p];
    const g = jsGlobalsCache();
    if (p in g) return g[p];
    return undefined;
  },
  set(t, p, v) {
    if (typeof p === 'string') t[p] = v;
    return true;
  },
});

let globalsCache: Record<string, unknown> | null = null;
const jsGlobalsCache = () => (globalsCache ??= jsGlobals());

/** Rewrite top-level declarations so they persist between console lines. */
function replRewrite(src: string) {
  return src
    .replace(/^(\s*)(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, '$1$2 =')
    .replace(/^(\s*)(?:let|var)\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm, '$1$2 = undefined;')
    .replace(/^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/gm, '$1$2 = function $2(')
    .replace(/^(\s*)class\s+([A-Za-z_$][\w$]*)\b/gm, '$1$2 = class $2');
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const sloppyEval = new Function('__scope', '__src', 'with (__scope) { return eval(__src); }') as (scope: object, src: string) => unknown;

/** Evaluate one console entry in JavaScript; echoes the value like a REPL. */
export function evalConsoleJS(src: string): RunResult & { value?: unknown } {
  try {
    const value = inScript('Console', () => sloppyEval(scopeProxy, replRewrite(src)));
    if (value !== undefined) output.push(formatValue(value), 'OUTPUT');
    consoleScope._ = value;
    return { ok: true, value };
  } catch (e) {
    const err = e as Error;
    output.push(`${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`, 'ERROR');
    return { ok: false, error: err?.message };
  }
}

/** Names visible from the JS console (for completion). */
export function jsConsoleNames(): string[] {
  return [...new Set([...Object.keys(consoleScope), ...Object.keys(jsGlobalsCache())])];
}

/** Resolve an expression path like `bpy.data.objects` in the JS console scope (no side effects beyond getters). */
export function jsResolvePath(path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = parts[0] in consoleScope ? consoleScope[parts[0]] : jsGlobalsCache()[parts[0]];
  for (const p of parts.slice(1)) {
    if (cur === null || cur === undefined) return undefined;
    try {
      cur = (cur as Record<string, unknown>)[p];
    } catch {
      return undefined;
    }
  }
  return cur;
}
