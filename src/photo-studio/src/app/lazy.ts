// On-demand feature code. Features register their commands, tools and panels
// at startup but keep implementations (dialogs, workspaces, codecs, heavy
// algorithms) in modules loaded with import() on first use, so the startup
// bundle stays small. Loads that take noticeable time show a brief loading
// state; likely-next modules are fetched while the browser is idle.
import type { Editor } from '../editor';
import type { Command, Panel, Tool } from './registry';

export interface Lazy<T> {
  (): Promise<T>;
  /** The module once it has loaded (synchronous access for hot paths). */
  loaded?: T;
  /** Start loading without waiting (errors are reported on real use). */
  prefetch(): void;
}

// Loads slower than this show the loading state (cursor and status bar).
const LOADING_DELAY = 150;
let pending = 0;
let loadingTimer = 0;
function track<T>(p: Promise<T>): Promise<T> {
  if (typeof document === 'undefined') return p;
  if (!pending++) loadingTimer = window.setTimeout(() => document.documentElement.classList.add('feature-loading'), LOADING_DELAY);
  const done = () => {
    if (--pending) return;
    clearTimeout(loadingTimer);
    document.documentElement.classList.remove('feature-loading');
  };
  p.then(done, done);
  return p;
}

// How browsers word a failed import(): Chromium, Firefox, Safari, and Vite's
// stylesheet preloading.
const IMPORT_FAILED = /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;
/** A failed module load as a message for the user. Without a connection, or
 * after a new deployment replaced the files of the running version, the
 * browser's own message is only a URL. Other errors pass through. */
export function loadError(error: unknown): unknown {
  if (!(error instanceof Error) || !IMPORT_FAILED.test(error.message)) return error;
  return new Error('This part of Photo Studio could not be loaded. Check the connection and try again, or reload the page if Photo Studio has been updated.', { cause: error });
}

/** A memoized module loader: `lazy(() => import('./dialog'))`. */
export function lazy<T>(load: () => Promise<T>): Lazy<T> {
  let promise: Promise<T> | undefined;
  let quiet = false;
  let shown = false;
  const get = (() => {
    if (!promise) {
      const p = load().then(
        (m) => (get.loaded = m),
        (error) => {
          throw loadError(error);
        },
      );
      // A failed load (offline, new deployment) is retried on the next use.
      p.catch(() => {
        promise = undefined;
        shown = false;
      });
      promise = p;
    }
    // Real use of a module still being prefetched shows the loading state too.
    if (!quiet && !shown && !get.loaded) {
      shown = true;
      track(promise);
    }
    return promise;
  }) as Lazy<T>;
  get.prefetch = () => {
    quiet = true;
    get().catch(() => {});
    quiet = false;
  };
  return get;
}

/** Command fields that run a function of a lazily loaded module:
 * `registerCommand({ id, label, ...lazyRun(dialogs, (m, e) => m.open(e)) })`. */
export function lazyRun<M>(mod: Lazy<M>, run: (m: M, e: Editor, arg?: unknown) => unknown): Pick<Command, 'run' | 'prefetch'> {
  return {
    run: async (e, arg) => void (await run(await mod(), e, arg)),
    prefetch: mod.prefetch,
  };
}

const idleQueue: (() => void)[] = [];
let idleScheduled = false;
// Idle work waits until the workspace has started, so it never competes
// with startup for the network or the main thread.
let idleOpen = false;
/** Allow idle work to run (the editor calls this once it is ready). */
export function startIdleWork() {
  idleOpen = true;
  if (idleQueue.length) scheduleIdle();
}
function idle(fn: () => void, timeout = 2000) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else setTimeout(fn, 50);
}
function drainIdle() {
  idleScheduled = false;
  // One module per idle period keeps each slice short.
  idleQueue.shift()?.();
  if (idleQueue.length) scheduleIdle();
}
function scheduleIdle() {
  if (idleScheduled || !idleOpen) return;
  idleScheduled = true;
  idle(drainIdle, 10_000);
}
/** Run work when the browser is idle, one task per idle period (after startup). */
export function whenIdle(task: () => void) {
  idleQueue.push(task);
  scheduleIdle();
}
/** Fetch modules in the background once the workspace is idle. */
export function prefetchOnIdle(...modules: Lazy<unknown>[]) {
  for (const m of modules) whenIdle(() => m.prefetch());
}

/** A tool whose handlers live in a lazily loaded module. The toolbar entry,
 * key and icon exist at startup; the implementation loads when the tool is
 * chosen (or hovered in the toolbar). Pointer input that arrives before it has
 * loaded is replayed in order, so a quick first stroke is not lost. */
export function lazyTool(meta: Pick<Tool, 'id' | 'label' | 'key' | 'icon' | 'group' | 'needsDocument'>, load: Lazy<Tool>): Tool {
  let queue: (() => void)[] | undefined;
  const impl = () => load.loaded;
  const replay = (e: Editor) => {
    if (queue) return;
    queue = [];
    void load().then(
      () => {
        const q = queue!;
        queue = undefined;
        // Activate first (it was chosen before it loaded), then replay input.
        const active = e.tool === meta.id;
        if (active) impl()!.activate?.(e);
        for (const f of q) f();
        // Options, cursor and overlay of the tool appear once it has loaded.
        if (active) {
          e.options();
          e.overlay();
        }
      },
      (error) => {
        queue = undefined;
        e.message(error instanceof Error ? error.message : String(error));
      },
    );
  };
  // Calls forwarded once loaded; before that, pointer input is queued.
  const later =
    <A extends unknown[]>(name: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'doubleClick') =>
    (e: Editor, ...args: A) => {
      const t = impl();
      if (t) return (t[name] as ((e: Editor, ...a: A) => void) | undefined)?.(e, ...args);
      replay(e);
      queue!.push(() => (impl()![name] as ((e: Editor, ...a: A) => void) | undefined)?.(e, ...args));
    };
  return {
    ...meta,
    get brush() {
      return impl()?.brush;
    },
    cursor: (e) => impl()?.cursor?.(e) ?? '',
    options: (e) => impl()?.options?.(e) ?? '',
    bindOptions: (ctx) => impl()?.bindOptions?.(ctx),
    activate: (e) => {
      const t = impl();
      if (t) t.activate?.(e);
      else replay(e);
    },
    deactivate: (e, reason) => impl()?.deactivate?.(e, reason),
    pointerDown: later('pointerDown'),
    pointerMove: later('pointerMove'),
    pointerUp: later('pointerUp'),
    doubleClick: later('doubleClick'),
    hover: (e, p) => impl()?.hover?.(e, p),
    keyDown: (e, ev) => impl()?.keyDown?.(e, ev) ?? false,
    overlay: (e) => impl()?.overlay?.(e) ?? '',
    prefetch: load.prefetch,
  } as Tool;
}

/** A panel whose body lives in a lazily loaded module; it loads the first
 * time the panel is shown. */
export function lazyPanel(meta: Omit<Panel, 'mount' | 'update'>, load: Lazy<Pick<Panel, 'mount' | 'update' | 'menu'>>): Panel {
  const panel: Panel = {
    ...meta,
    menu: meta.menu ?? (load.loaded?.menu ? (e) => load.loaded!.menu!(e) : undefined),
    mount: (e, el) => {
      const ready = load.loaded;
      if (ready) return ready.mount(e, el);
      el.classList.add('panel-loading');
      void load().then(
        (m) => {
          el.classList.remove('panel-loading');
          m.mount(e, el);
          if (el.isConnected) m.update?.(e, el);
        },
        (error) => {
          // The dock mounts a panel once: offer to load it again here.
          el.classList.remove('panel-loading');
          const text = error instanceof Error ? error.message : String(error);
          const box = document.createElement('div');
          box.className = 'panel-load-error';
          box.setAttribute('role', 'alert');
          const p = document.createElement('p');
          p.textContent = text;
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = 'Try Again';
          retry.addEventListener('click', () => {
            el.replaceChildren();
            panel.mount(e, el);
          });
          box.append(p, retry);
          el.replaceChildren(box);
          e.message(text);
        },
      );
    },
    update: (e, el) => load.loaded?.update?.(e, el),
  };
  return panel;
}
