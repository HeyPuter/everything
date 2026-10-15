// Python support via Pyodide (MPL-2.0), loaded lazily from the official jsDelivr CDN the
// first time Python is used. JavaScript scripting works offline; Python needs the network
// once per session to fetch the runtime.
import { app } from '../app/app';
import { Struct, BoundArray, PropCollection, isIdWrapper, pyError } from './rna';
import { bpy, callOperator, opModules, opNames, type ExecContext } from './api';
import { operators } from '../app/app';
import { VecBase, Matrix, mathutils } from './mathutils';
import { registerScriptOperator, unregisterScriptOperator, registerScriptPanel, unregisterScriptPanel, UILayout, type ScriptProp } from './registry';
import { output, inScript, type RunResult } from './runner';
import { pyTimers, setPythonHandlerDispatch } from './handlers';
import { registerScriptMenu, unregisterScriptMenu } from './menus';
import { declareGroup, declareTypeProp, markGroup, removeTypeProp, type TypeProp } from './typeprops';
import mathutilsPy from './py/mathutils.py?raw';
import bpyPy from './py/bpy.py?raw';
import runtimePy from './py/p3d_runtime.py?raw';
import bpyExtrasPy from './py/bpy_extras.py?raw';
import { pyModuleFiles, scriptModules } from './jsmodules';

export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
export const PYODIDE_LICENSE = 'MPL-2.0';

interface PyProxyFn {
  (...a: unknown[]): unknown;
  destroy?: () => void;
}
interface PyodideAPI {
  version: string;
  runPython(code: string): unknown;
  registerJsModule(name: string, mod: object): void;
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  pyimport(name: string): Record<string, PyProxyFn>;
  FS: { mkdirTree(p: string): void; writeFile(p: string, data: string): void };
}

export type PyState = 'idle' | 'loading' | 'ready' | 'error';
export const python = {
  state: 'idle' as PyState,
  error: '',
  version: '',
  listeners: new Set<() => void>(),
};
let py: PyodideAPI | null = null;
let runtime: Record<string, PyProxyFn> | null = null;
let loading: Promise<PyodideAPI> | null = null;

type PyodideModule = { loadPyodide: (o: Record<string, unknown>) => Promise<PyodideAPI> };
/** Where the runtime comes from: the CDN in the browser; tests point it at a local copy. */
let pyodideSource: { load: () => Promise<PyodideModule>; indexURL?: string } = {
  load: () => import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`) as Promise<PyodideModule>,
  indexURL: PYODIDE_INDEX_URL,
};

/** Loads the runtime from elsewhere (a local package in tests) instead of the CDN. */
export function setPyodideSource(load: () => Promise<PyodideModule>, indexURL?: string) {
  pyodideSource = { load, indexURL };
}

function setState(s: PyState, err = '') {
  python.state = s;
  python.error = err;
  python.listeners.forEach((f) => f());
  app.changed('ui');
}

// ---------------------------------------------------------------------------
// bridge exposed to Python as the `_p3d_bridge` module

const out = (v: unknown) => {
  if (v === null) return undefined;
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  return v;
};

function typeName(o: unknown): string {
  if (o === null || o === undefined) return 'NoneType';
  return (o as { __type?: string }).__type ?? (o as object).constructor?.name ?? typeof o;
}

function descriptorKind(o: object, name: string): 'method' | 'value' {
  let p: object | null = o;
  for (let depth = 0; p && depth < 12; depth++) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return d.get || d.set ? 'value' : typeof d.value === 'function' ? 'method' : 'value';
    p = Object.getPrototypeOf(p);
  }
  return 'value';
}

function hasAttr(o: unknown, name: string) {
  if (o === null || o === undefined || (typeof o !== 'object' && typeof o !== 'function')) return false;
  if (name.startsWith('__') && !['__module'].includes(name)) return false;
  try {
    return name in (o as object);
  } catch {
    return false;
  }
}

function asArray(a: unknown): unknown[] {
  if (Array.isArray(a)) return a;
  if (a && typeof (a as Iterable<unknown>)[Symbol.iterator] === 'function') return [...(a as Iterable<unknown>)];
  return [];
}

function applyKw(fn: { __params?: string[]; name?: string }, args: unknown[], kw: Record<string, unknown> | undefined, label: string) {
  const keys = kw ? Object.keys(kw) : [];
  if (!keys.length) return args;
  const params = fn.__params;
  if (!params) return [...args, kw];
  const a = [...args];
  for (const k of keys) {
    const i = params.indexOf(k);
    if (i < 0) throw pyError('TypeError', `${label}(): got an unexpected keyword argument '${k}'`);
    if (i < args.length) throw pyError('TypeError', `${label}(): argument '${k}' given by name and position`);
    a[i] = kw![k];
  }
  return a;
}

/** Returned by bridge.attr for methods (a string Python compares cheaply). */
const METHOD = '\u0000method';

export const bridge = {
  kind(v: unknown): string {
    if (v === null || v === undefined) return 'none';
    if (typeof v === 'function') return 'function';
    if (Array.isArray(v)) return 'jsarray';
    if (v instanceof Set) return 'set';
    if (v instanceof VecBase) return v.__kind;
    if (v instanceof Matrix) return 'matrix';
    if (v instanceof PropCollection) return 'collection';
    if (v instanceof BoundArray) return 'array';
    if ((v as { __kind?: string }).__kind === 'opmodule') return 'opmodule';
    return 'struct';
  },
  bound: (v: VecBase) => !!(v as unknown as { __bound?: boolean }).__bound,
  /** kind() in one call for live vectors: 'b:<kind>:<size>' (bound vectors keep their size). */
  wrapkind(v: unknown): string {
    if (v instanceof VecBase && (v as unknown as { __bound?: boolean }).__bound) return `b:${v.__kind}:${v.size}`;
    return bridge.kind(v);
  },
  components: (v: VecBase) => v.toArray(),
  order: (v: { order?: string }) => v.order ?? 'XYZ',
  vlen: (v: VecBase) => v.size,
  vget: (v: VecBase, i: number) => v.get(i),
  vset: (v: VecBase, i: number, x: number) => v.set(i, x),
  rows: (m: Matrix) => m.rows,
  matrix: (rows: number[][]) => new Matrix(rows),
  attrkind(o: object, name: string): 'method' | 'value' {
    if (!hasAttr(o, name)) throw pyError('AttributeError', `'${typeName(o)}' object has no attribute '${name}'`);
    return descriptorKind(o, name);
  },
  /** One call for attribute access: the value, or METHOD when it is a method to call. */
  attr(o: Record<string, unknown>, name: string) {
    if (!hasAttr(o, name)) throw pyError('AttributeError', `'${typeName(o)}' object has no attribute '${name}'`);
    return descriptorKind(o, name) === 'method' ? METHOD : out(o[name]);
  },
  getattr(o: Record<string, unknown>, name: string) {
    if (!hasAttr(o, name)) throw pyError('AttributeError', `'${typeName(o)}' object has no attribute '${name}'`);
    return out(o[name]);
  },
  setattr(o: Record<string, unknown>, name: string, v: unknown) {
    if (o instanceof Struct || (o as { __kind?: string }).__kind === 'opprops' || o instanceof UILayout) {
      o[name] = v;
      return;
    }
    if (!hasAttr(o, name)) throw pyError('AttributeError', `'${typeName(o)}' object attribute '${name}' is read-only`);
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d && !d.writable && !d.set) throw pyError('AttributeError', `'${typeName(o)}' object attribute '${name}' is read-only`);
    o[name] = v;
  },
  call(o: Record<string, unknown>, name: string, args: unknown, kw: Record<string, unknown>) {
    const fn = o[name] as ((...a: unknown[]) => unknown) & { __params?: string[] };
    if (typeof fn !== 'function') throw pyError('TypeError', `'${typeName(o)}.${name}' is not callable`);
    return out(fn.apply(o, applyKw(fn, asArray(args), kw, name)));
  },
  callf(fn: ((...a: unknown[]) => unknown) & { __params?: string[] }, args: unknown, kw: Record<string, unknown>) {
    return out(fn(...applyKw(fn, asArray(args), kw, fn.name || 'function')));
  },
  getitem(o: Record<string, unknown> & { getItem?: (k: unknown) => unknown }, key: unknown) {
    if (typeof o.getItem === 'function') return out(o.getItem(key));
    if (Array.isArray(o) && typeof key === 'number') {
      const i = key < 0 ? o.length + key : key;
      if (i < 0 || i >= o.length) throw pyError('IndexError', 'index out of range');
      return out(o[i]);
    }
    if (typeof key === 'string' && key in o) return out(o[key]);
    throw pyError('KeyError', `'${String(key)}'`);
  },
  setitem(o: Record<string, unknown> & { setItem?: (k: unknown, v: unknown) => void }, key: unknown, v: unknown) {
    if (typeof o.setItem === 'function') return o.setItem(key, v);
    throw pyError('TypeError', `'${typeName(o)}' object does not support item assignment`);
  },
  delitem(o: { delItem?: (k: unknown) => void }, key: unknown) {
    if (typeof o.delItem === 'function') return o.delItem(key);
    throw pyError('TypeError', `'${typeName(o)}' object does not support item deletion`);
  },
  contains(o: Record<string, unknown> & { contains?: (k: unknown) => boolean }, key: unknown) {
    if (typeof o.contains === 'function') return o.contains(key);
    if (o instanceof Struct) return typeof key === 'string' && (o.keys() as string[]).includes(key);
    if (o instanceof BoundArray) return o.toArray().includes(key);
    return typeof key === 'string' && key in o;
  },
  len(o: { length?: number }) {
    if (typeof o.length !== 'number') throw pyError('TypeError', `object of type '${typeName(o)}' has no len()`);
    return o.length;
  },
  list(o: Iterable<unknown>) {
    return [...o].map(out);
  },
  /** Items with their wrap kinds in one call (iteration over big collections). */
  listkinds(o: Iterable<unknown>) {
    const items = [...o].map(out);
    return [items, items.map((x) => (x === null || x === undefined || typeof x !== 'object' ? '' : bridge.wrapkind(x)))];
  },
  same(a: unknown, b: unknown) {
    if (a === b) return true;
    if (isIdWrapper(a) && isIdWrapper(b)) return a.__id === b.__id;
    if (a instanceof Struct && b instanceof Struct) return a.__resolve() === b.__resolve();
    return false;
  },
  key(o: unknown) {
    if (isIdWrapper(o)) return `${o.__table}:${o.__id}`;
    if (o instanceof Struct) return o.__path;
    if (!(o instanceof BoundArray) && typeof (o as { __key?: unknown })?.__key === 'string') return (o as { __key: string }).__key;
    return String(o);
  },
  repr(o: { repr?: () => string }) {
    return typeof o.repr === 'function' ? o.repr() : String(o);
  },
  str: (o: unknown) => String(o),
  typename: typeName,
  dir(o: unknown): string[] {
    if (o instanceof Struct) return o.__fields();
    const keys = new Set<string>();
    let p: object | null = o as object;
    for (let d = 0; p && p !== Object.prototype && d < 8; d++) {
      for (const k of Object.getOwnPropertyNames(p)) if (!k.startsWith('_') && k !== 'constructor' && !/^(getItem|setItem|delItem|list|nameOf|contains|toString|repr|toArray)$/.test(k)) keys.add(k);
      p = Object.getPrototypeOf(p);
    }
    return [...keys].sort();
  },
  op(idname: string, kw: Record<string, unknown>, ctx: string) {
    const r = callOperator(idname, kw ?? {}, (ctx || 'EXEC_DEFAULT') as ExecContext);
    return r;
  },
  op_exists: (idname: string) => operators.has(idname),
  op_modules: () => opModules(),
  op_names: (mod: string) => opNames(mod),
  op_poll: (idname: string) => app.poll(idname),
  op_description: (idname: string) => operators.get(idname)?.description ?? operators.get(idname)?.label ?? '',
  op_info: (idname: string) => ({ __kind: 'struct', __type: 'Struct', name: operators.get(idname)?.label ?? '', description: operators.get(idname)?.description ?? '', identifier: idname }),
  register_operator(spec: Record<string, unknown>) {
    const exec = spec.exec as PyProxyFn;
    const poll = spec.poll as PyProxyFn | undefined;
    const invoke = spec.invoke as PyProxyFn | undefined;
    registerScriptOperator({
      idname: String(spec.idname),
      label: String(spec.label ?? ''),
      description: String(spec.description ?? ''),
      options: asArray(spec.options).map(String),
      props: (spec.props ?? {}) as Record<string, ScriptProp>,
      poll: poll ? () => !!pyCall(() => poll()) : undefined,
      exec: (p) => pyCall(() => exec(p)),
      invoke: invoke ? (p, ev) => pyCall(() => invoke(p, ev)) : undefined,
      language: 'python',
    });
  },
  unregister_operator: (id: string) => unregisterScriptOperator(id),
  register_panel(spec: Record<string, unknown>) {
    const draw = spec.draw as PyProxyFn;
    const poll = spec.poll as PyProxyFn | undefined;
    registerScriptPanel({
      idname: String(spec.idname),
      label: String(spec.label ?? ''),
      space: String(spec.space ?? 'VIEW_3D'),
      region: String(spec.region ?? 'UI'),
      category: String(spec.category ?? 'Misc'),
      order: Number(spec.order ?? 0),
      defaultClosed: !!spec.defaultClosed,
      hideHeader: !!spec.hideHeader,
      poll: poll ? () => !!pyCall(() => poll()) : undefined,
      draw: (layout) => void pyCall(() => draw(layout)),
      language: 'python',
    });
  },
  unregister_panel: (id: string) => unregisterScriptPanel(id),
  register_menu(spec: Record<string, unknown>) {
    const draw = spec.draw as PyProxyFn;
    const poll = spec.poll as PyProxyFn | undefined;
    registerScriptMenu({ idname: String(spec.idname), label: String(spec.label ?? ''), draw: (layout) => void pyCall(() => draw(layout)), poll: poll ? () => !!pyCall(() => poll()) : undefined, language: 'python' });
  },
  unregister_menu: (id: string) => unregisterScriptMenu(id),
  report(type: string, msg: string) {
    app.report(type === 'ERROR' || type === 'WARNING' ? type : 'INFO', msg);
  },
  root: (name: string) => bpy[name],
  /** A registered script module (bmesh, …) by name. */
  module: (name: string) => scriptModules[name] ?? null,
  /** The JavaScript mathutils module (the Python submodules forward to it). */
  mathutils: () => mathutils,
  new_layout: () => new UILayout(),
  /** bpy.app.handlers: Python registers one dispatcher (event, argument) and a counter of its handlers. */
  set_handlers: (dispatch: PyProxyFn | null, count: PyProxyFn | null) => setPythonHandlerDispatch(dispatch as never, count as never),
  /** bpy.app.timers: the Python side passes a function returning the next delay, or -1 to stop. */
  /** Properties scripts add to data types and property groups (typeprops.ts). */
  declare_type_prop: (type: string, name: string, spec: TypeProp) => declareTypeProp(String(type), String(name), spec),
  remove_type_prop: (type: string, name: string) => removeTypeProp(String(type), String(name)),
  declare_group(name: string, props: Record<string, TypeProp>) {
    declareGroup(String(name), props);
    markGroup(String(name));
  },
  timer_add: (fn: PyProxyFn, first: number, persistent: boolean) => pyTimers.add(fn as never, Number(first), !!persistent),
  timer_remove: (id: number) => pyTimers.remove(id),
  timer_active: (id: number) => pyTimers.active(id),
};

/** Call into Python, turning a Python traceback into a concise JavaScript error. */
function pyCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const lines = msg.trim().split('\n').filter(Boolean);
    throw new Error(lines[lines.length - 1] ?? msg);
  }
}

// ---------------------------------------------------------------------------
// loading

/** Load Pyodide and the bpy package (once). Shows progress in the console scrollback. */
export function loadPython(): Promise<PyodideAPI> {
  if (py) return Promise.resolve(py);
  if (loading) return loading;
  setState('loading');
  output.push(`Loading Python runtime… (Pyodide ${PYODIDE_VERSION} from cdn.jsdelivr.net)`, 'INFO');
  loading = (async () => {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('timed out after 90 s')), 90000)));
      timeout.catch(() => {});
      const mod = await Promise.race([pyodideSource.load(), timeout]);
      const inst = await Promise.race([mod.loadPyodide(pyodideSource.indexURL ? { indexURL: pyodideSource.indexURL } : {}), timeout]);
      clearTimeout(timer);
      inst.setStdout({ batched: (s: string) => output.push(s, 'OUTPUT') });
      inst.setStderr({ batched: (s: string) => output.push(s, 'ERROR') });
      inst.registerJsModule('_p3d_bridge', bridge);
      inst.FS.mkdirTree('/home/pyodide/p3d');
      inst.FS.writeFile('/home/pyodide/p3d/mathutils.py', mathutilsPy);
      inst.FS.writeFile('/home/pyodide/p3d/bpy.py', bpyPy);
      inst.FS.writeFile('/home/pyodide/p3d/p3d_runtime.py', runtimePy);
      inst.FS.writeFile('/home/pyodide/p3d/bpy_extras.py', bpyExtrasPy);
      for (const [file, src] of Object.entries(pyModuleFiles)) inst.FS.writeFile(`/home/pyodide/p3d/${file}`, src);
      inst.runPython("import sys\nsys.path.insert(0, '/home/pyodide/p3d')\nimport bpy, mathutils, p3d_runtime, bpy_extras\nsys.modules['bpy_extras.object_utils'] = bpy_extras.object_utils");
      runtime = inst.pyimport('p3d_runtime');
      py = inst;
      python.version = String(inst.runPython('import sys; sys.version.split()[0]'));
      setState('ready');
      output.push(`Python ${python.version} ready.`, 'INFO');
      return inst;
    } catch (e) {
      loading = null;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      const msg = `Could not load the Python runtime${offline ? ' (you appear to be offline)' : ''}: ${(e as Error)?.message ?? e}. Python needs a network connection the first time it is used; JavaScript scripting works offline.`;
      setState('error', msg);
      output.push(msg, 'ERROR');
      throw new Error(msg);
    }
  })();
  return loading;
}

export const pythonReady = () => !!py;

/** Run Python source as a script (requires loadPython() to have resolved). */
export function runPythonText(code: string, name: string, label = 'Run Script'): RunResult {
  if (!runtime) return { ok: false, error: 'Python runtime is not loaded' };
  const r = inScript(label, () => String(runtime!.run_text(code, name)));
  if (r === 'null') return { ok: true };
  const info = JSON.parse(r) as { line: number; error: string; traceback: string };
  return { ok: false, error: info.error, line: info.line || undefined, traceback: info.traceback };
}

/** Feed one line to the interactive console. */
export function pythonConsolePush(line: string): 'more' | 'done' {
  if (!runtime) throw new Error('Python runtime is not loaded');
  return inScript('Console', () => String(runtime!.console_push(line))) as 'more' | 'done';
}

export function pythonConsoleReset() {
  runtime?.console_reset_buffer();
}

export function pythonComplete(text: string): { word: string; matches: string[] } {
  if (!runtime) return { word: '', matches: [] };
  return JSON.parse(String(runtime.complete(text)));
}
