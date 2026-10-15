// bmesh.ops registry: every operator takes the BMesh first and then its arguments as
// keywords (Python) or as one trailing object (JavaScript):
//   bmesh.ops.translate(bm, {vec: [0, 0, 1], verts: bm.verts})
// Results use the public key names ({geom: [...]}, {faces: [...]}, …).
import { pyError } from './rna';
import { BMesh, BMElem, BMVert, BMEdge, BMFace, toList, describe, vec3, mat4, IDENTITY4 } from './bmesh_core';

export type OpArgs = Record<string, unknown>;
type OpFn = (bm: BMesh, a: OpArgs) => unknown;

interface OpDef {
  defaults: OpArgs;
  fn: OpFn;
  doc: string;
}

export const opDefs = new Map<string, OpDef>();

/** Register an operator with its keyword defaults. */
export function defOp(name: string, defaults: OpArgs, fn: OpFn, doc = '') {
  opDefs.set(name, { defaults, fn, doc });
}

function callOp(name: string, bm: unknown, opts: unknown) {
  const def = opDefs.get(name)!;
  if (!(bm instanceof BMesh)) throw pyError('TypeError', `bmesh.ops.${name}(): the first argument must be a BMesh, got ${describe(bm)}`);
  bm._chk();
  const given = (opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}) as OpArgs;
  if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Array.isArray(opts))) throw pyError('TypeError', `bmesh.ops.${name}(): arguments are passed by keyword (an object in JavaScript)`);
  const args: OpArgs = { ...def.defaults };
  for (const [k, v] of Object.entries(given)) {
    if (!(k in def.defaults)) throw pyError('TypeError', `bmesh.ops.${name}(): unexpected keyword argument '${k}' (expected: ${Object.keys(def.defaults).join(', ') || 'none'})`);
    if (v !== undefined) args[k] = v;
  }
  const r = def.fn(bm, args);
  return r === undefined ? null : r;
}

const PASS = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'inspect', 'nodeType', 'asymmetricMatch', 'length', 'prototype']);

/** `bmesh.ops`: unknown names raise an AttributeError listing the operators that exist. */
export const ops: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
  get(_t, p) {
    if (typeof p !== 'string') return undefined;
    if (opDefs.has(p)) return (bm: unknown, opts?: unknown) => callOp(p, bm, opts);
    if (p === 'toString' || p === 'repr') return () => '<module bmesh.ops>';
    if (p === '__type') return 'module';
    if (p === '_names') return () => [...opDefs.keys()].sort();
    if (p.startsWith('_') || p.startsWith('@@') || PASS.has(p)) return undefined;
    throw pyError('AttributeError', `bmesh.ops has no operator '${p}'. Available: ${[...opDefs.keys()].sort().join(', ')}`);
  },
  has(_t, p) {
    return typeof p === 'string' && opDefs.has(p);
  },
  ownKeys() {
    return [...opDefs.keys()];
  },
  getOwnPropertyDescriptor(_t, p) {
    return typeof p === 'string' && opDefs.has(p) ? { configurable: true, enumerable: true, writable: false, value: (bm: unknown, o?: unknown) => callOp(p, bm, o) } : undefined;
  },
});

// ---------------------------------------------------------------------------
// argument helpers

export function geomSplit(v: unknown, what: string) {
  const verts: BMVert[] = [],
    edges: BMEdge[] = [],
    faces: BMFace[] = [];
  for (const x of toList(v, what)) {
    if (x instanceof BMVert) verts.push(x);
    else if (x instanceof BMEdge) edges.push(x);
    else if (x instanceof BMFace) faces.push(x);
    else throw pyError('TypeError', `${what}: expected BMVert/BMEdge/BMFace elements, got ${describe(x)}`);
  }
  return { verts: alive(verts), edges: alive(edges), faces: alive(faces) };
}

const alive = <T extends BMElem>(a: T[]) => [...new Set(a)].filter((x) => !!x._bm);

export function argVerts(v: unknown, what: string): BMVert[] {
  const out: BMVert[] = [];
  for (const x of toList(v, what)) {
    if (x instanceof BMVert) out.push(x);
    else throw pyError('TypeError', `${what}: expected BMVert elements, got ${describe(x)}`);
  }
  return alive(out);
}
export function argEdges(v: unknown, what: string): BMEdge[] {
  const out: BMEdge[] = [];
  for (const x of toList(v, what)) {
    if (x instanceof BMEdge) out.push(x);
    else throw pyError('TypeError', `${what}: expected BMEdge elements, got ${describe(x)}`);
  }
  return alive(out);
}
export function argFaces(v: unknown, what: string): BMFace[] {
  const out: BMFace[] = [];
  for (const x of toList(v, what)) {
    if (x instanceof BMFace) out.push(x);
    else throw pyError('TypeError', `${what}: expected BMFace elements, got ${describe(x)}`);
  }
  return alive(out);
}

export const argVec = (v: unknown, what: string) => vec3(v, what);
export const argMat = (v: unknown, what: string) => (v === null || v === undefined ? IDENTITY4() : mat4(v, what));
export const argNum = (v: unknown, what: string) => {
  const n = typeof v === 'boolean' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw pyError('TypeError', `${what}: expected a number, got ${describe(v)}`);
  return n;
};
export const argInt = (v: unknown, what: string) => Math.trunc(argNum(v, what));
export const argEnum = (v: unknown, items: string[], what: string) => {
  const s = String(v);
  if (!items.includes(s)) throw pyError('TypeError', `${what}: expected one of ${items.map((x) => `'${x}'`).join(', ')}, got '${s}'`);
  return s;
};
