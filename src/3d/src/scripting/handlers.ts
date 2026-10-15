// bpy.app.handlers and bpy.app.timers: functions scripts register to run when the frame
// changes, after the scene is re-evaluated, when a file loads or saves, around renders and
// undo/redo, and on timers. JavaScript handlers live in the lists here; Python handlers live in
// Python lists (py/bpy.py) and are reached through one dispatcher the Python side registers.
import { App, app, onAppReady, operators } from '../app/app';
import { output } from './runner';
import { bpy, sceneWrapper } from './api';

export const HANDLER_NAMES = [
  'frame_change_pre',
  'frame_change_post',
  'depsgraph_update_pre',
  'depsgraph_update_post',
  'load_pre',
  'load_post',
  'load_factory_startup_post',
  'save_pre',
  'save_post',
  'render_init',
  'render_pre',
  'render_post',
  'render_write',
  'render_complete',
  'render_cancel',
  'undo_pre',
  'undo_post',
  'redo_pre',
  'redo_post',
  'animation_playback_pre',
  'animation_playback_post',
] as const;
export type HandlerName = (typeof HANDLER_NAMES)[number];

type Handler = ((...a: unknown[]) => unknown) & { _bpy_persistent?: boolean };

/** JavaScript handler lists (bpy.app.handlers.<name>.push(fn) / append(fn)). */
export const handlers = Object.fromEntries(HANDLER_NAMES.map((n) => [n, [] as Handler[]])) as unknown as Record<HandlerName, Handler[]> & { persistent: (fn: Handler) => Handler };
for (const n of HANDLER_NAMES) {
  const list = handlers[n] as Handler[] & { append?: (f: Handler) => void; remove?: (f: Handler) => void; clear?: () => void };
  Object.defineProperties(list, {
    append: { value: (f: Handler) => void list.push(f) },
    remove: {
      value: (f: Handler) => {
        const i = list.indexOf(f);
        if (i < 0) throw new Error('ValueError: list.remove(x): x not in list');
        list.splice(i, 1);
      },
    },
    clear: { value: () => void (list.length = 0) },
  });
}
/** Marks a handler to stay registered when another file is loaded. */
Object.defineProperty(handlers, 'persistent', {
  value: (fn: Handler) => {
    fn._bpy_persistent = true;
    return fn;
  },
});

/** Python's dispatcher: (event name, argument: a file path, or undefined for the scene). */
let pyDispatch: ((name: string, arg?: unknown) => unknown) | null = null;
let pyCount: ((name: string) => number) | null = null;
export function setPythonHandlerDispatch(fn: ((name: string, arg?: unknown) => unknown) | null, count: ((name: string) => number) | null) {
  pyDispatch = fn;
  pyCount = count;
}

const depsgraph = () => bpy.context && (bpy.context as { evaluated_depsgraph_get(): unknown }).evaluated_depsgraph_get();

export function hasHandlers(name: HandlerName) {
  return handlers[name].length > 0 || (pyCount?.(name) ?? 0) > 0;
}

const firing = new Set<string>();

/** Runs the handlers registered for `name`; errors are printed and don't stop the others. */
export function fireHandlers(name: HandlerName, arg?: unknown) {
  if (!hasHandlers(name) || firing.has(name)) return;
  firing.add(name);
  try {
    const first = arg === undefined ? sceneWrapper : arg;
    for (const fn of [...handlers[name]]) {
      try {
        // handlers that take one argument get the scene (or file path), two get the depsgraph too
        fn.length >= 2 ? fn(first, depsgraph()) : fn(first);
      } catch (e) {
        output.push(`Error in ${name} handler ${fn.name || '<anonymous>'}: ${(e as Error)?.message ?? e}`, 'ERROR');
      }
    }
    if (pyDispatch && (pyCount?.(name) ?? 0) > 0) {
      try {
        pyDispatch(name, typeof arg === 'string' ? arg : undefined);
      } catch (e) {
        output.push(`Error in ${name} handler: ${String((e as Error)?.message ?? e).trim().split('\n').pop()}`, 'ERROR');
      }
    }
  } finally {
    firing.delete(name);
  }
}

/** Drops handlers not marked persistent (when another file is loaded). */
function dropNonPersistent() {
  for (const n of HANDLER_NAMES) {
    const keep = handlers[n].filter((f) => f._bpy_persistent);
    handlers[n].length = 0;
    handlers[n].push(...keep);
  }
  if (pyDispatch) {
    try {
      pyDispatch('__clear_nonpersistent__');
    } catch {
      /* the Python side reports its own errors */
    }
  }
}

// ---------------------------------------------------------------------------
// where the events come from

const proto = App.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const origSetFrame = proto.setFrame;
proto.setFrame = function (this: App, ...a: unknown[]) {
  const live = hasHandlers('frame_change_pre') || hasHandlers('frame_change_post');
  if (live) fireHandlers('frame_change_pre');
  const r = origSetFrame.apply(this, a);
  if (live && hasHandlers('frame_change_post')) {
    // post handlers see the scene evaluated at the new frame
    this.evaluate();
    fireHandlers('frame_change_post');
  }
  return r;
};

const origEvaluate = proto.evaluate;
proto.evaluate = function (this: App, ...a: unknown[]) {
  fireHandlers('depsgraph_update_pre');
  const r = origEvaluate.apply(this, a);
  fireHandlers('depsgraph_update_post');
  return r;
};

const origSetDocument = proto.setDocument;
proto.setDocument = function (this: App, ...a: unknown[]) {
  const reset = a[1] !== false;
  if (reset) fireHandlers('load_pre', this.filename);
  const r = origSetDocument.apply(this, a);
  if (reset) {
    stopTimers(false);
    dropNonPersistent();
    fireHandlers('load_post', this.filename);
  }
  return r;
};

for (const [m, pre, post] of [
  ['undoStep', 'undo_pre', 'undo_post'],
  ['redoStep', 'redo_pre', 'redo_post'],
] as [string, HandlerName, HandlerName][]) {
  const orig = proto[m];
  proto[m] = function (this: App, ...a: unknown[]) {
    fireHandlers(pre);
    const r = orig.apply(this, a);
    fireHandlers(post);
    return r;
  };
}

// the render module is loaded lazily here: it needs the DOM, which scripting itself doesn't
if (typeof document !== 'undefined')
  void import('../render/final/result')
    .then(({ renderPostHooks }) =>
      renderPostHooks.push((_r, ctx) => {
        fireHandlers('render_post');
        fireHandlers('render_write');
        if (ctx.final) fireHandlers('render_complete');
      }),
    )
    .catch(() => {});

function wrapOperator(idname: string, before: HandlerName[], after: HandlerName[]) {
  const op = operators.get(idname);
  const exec = op?.exec;
  if (!op || !exec) return;
  op.exec = (ctx, p) => {
    for (const h of before) fireHandlers(h, h.startsWith('save') ? app.filename : undefined);
    const r = exec(ctx, p);
    const done = () => {
      for (const h of after) fireHandlers(h, h.startsWith('save') ? app.filename : undefined);
    };
    if (r && typeof (r as unknown as Promise<unknown>).then === 'function') void (r as unknown as Promise<unknown>).then(done);
    else done();
    return r;
  };
}

onAppReady(() => {
  wrapOperator('wm.save_mainfile', ['save_pre'], ['save_post']);
  wrapOperator('wm.save_as_mainfile', ['save_pre'], ['save_post']);
  wrapOperator('render.render', ['render_init', 'render_pre'], []);
  let playing: unknown = false;
  app.subscribe(() => {
    if (app.playing !== playing) {
      fireHandlers(app.playing ? 'animation_playback_pre' : 'animation_playback_post');
      playing = app.playing;
    }
  });
});

// ---------------------------------------------------------------------------
// timers

interface Timer {
  fn: (...a: unknown[]) => unknown;
  handle: ReturnType<typeof setTimeout> | null;
  persistent: boolean;
  python: boolean;
}
const timers = new Map<number, Timer>();
let nextTimer = 1;

function schedule(id: number, seconds: number) {
  const t = timers.get(id);
  if (!t) return;
  t.handle = setTimeout(() => tick(id), Math.max(0, seconds * 1000));
}

function tick(id: number) {
  const t = timers.get(id);
  if (!t) return;
  t.handle = null;
  let next: unknown;
  try {
    next = t.fn();
  } catch (e) {
    output.push(`Error in timer ${t.fn.name || '<anonymous>'}: ${(e as Error)?.message ?? e}`, 'ERROR');
    next = null;
  }
  if (typeof next === 'number' && next >= 0 && Number.isFinite(next)) schedule(id, next);
  else removeTimer(id);
}

/** Registers a timer: `fn` runs after `first` seconds and again after the number of seconds it returns (stops on None/undefined). */
export function addTimer(fn: (...a: unknown[]) => unknown, first = 0, persistent = false, python = false): number {
  const id = nextTimer++;
  timers.set(id, { fn, handle: null, persistent, python });
  schedule(id, Number(first) || 0);
  return id;
}

export function removeTimer(id: number) {
  const t = timers.get(id);
  if (!t) return;
  if (t.handle) clearTimeout(t.handle);
  timers.delete(id);
  if (t.python) (t.fn as unknown as { destroy?: () => void }).destroy?.();
}

function stopTimers(all: boolean) {
  for (const [id, t] of [...timers]) if (all || !t.persistent) removeTimer(id);
}

const jsTimerIds = new Map<unknown, number>();
export const timersApi = {
  __kind: 'struct',
  __type: 'Timers',
  register(fn: (...a: unknown[]) => unknown, first_interval = 0, persistent = false) {
    if (typeof fn !== 'function') throw new Error('TypeError: bpy.app.timers.register(): expected a function');
    if (jsTimerIds.has(fn) && timers.has(jsTimerIds.get(fn)!)) throw new Error('ValueError: function is already registered as a timer');
    const opts = first_interval && typeof first_interval === 'object' ? (first_interval as { first_interval?: number; persistent?: boolean }) : null;
    jsTimerIds.set(fn, addTimer(fn, opts ? opts.first_interval ?? 0 : first_interval, opts ? !!opts.persistent : persistent));
  },
  unregister(fn: unknown) {
    const id = jsTimerIds.get(fn);
    if (id === undefined || !timers.has(id)) throw new Error('ValueError: function is not registered as a timer');
    removeTimer(id);
    jsTimerIds.delete(fn);
  },
  is_registered(fn: unknown) {
    const id = jsTimerIds.get(fn);
    return id !== undefined && timers.has(id);
  },
  toString: () => '<bpy.app.timers>',
};

/** For the Python bridge: Python wraps its function so that it returns a delay or -1 to stop. */
export const pyTimers = {
  add: (fn: (...a: unknown[]) => unknown, first: number, persistent: boolean) => addTimer(fn, first, persistent, true),
  remove: (id: number) => removeTimer(id),
  active: (id: number) => timers.has(id),
};

// expose on bpy.app
const appRoot = bpy.app as Record<string, unknown>;
appRoot.handlers = handlers;
appRoot.timers = timersApi;
appRoot.driver_namespace = {};

/** Where the handler lists and timers stand (to undo what a failed or trial script registered). */
export function handlerMark() {
  return { lists: Object.fromEntries(HANDLER_NAMES.map((n) => [n, [...handlers[n]]])) as Record<HandlerName, Handler[]>, timers: new Set(timers.keys()) };
}

/** Removes handlers and timers registered since `mark`. */
export function revertHandlers(mark: ReturnType<typeof handlerMark>) {
  for (const n of HANDLER_NAMES) {
    handlers[n].length = 0;
    handlers[n].push(...mark.lists[n]);
  }
  for (const id of [...timers.keys()]) if (!mark.timers.has(id)) removeTimer(id);
}
