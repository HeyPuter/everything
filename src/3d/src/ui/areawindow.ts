// Area windows: an editor duplicated into a floating window over the main screen
// (Duplicate Area into New Window, Shift-drag from an area corner). They hold a screen
// of their own, so they can be split and their editor type changed like any area.
// 3D views in a window draw into the shared canvas like all 3D views; their pixels are
// copied into a canvas inside the window after each redraw so the window stays on top.
import { h } from './h';
import { app, registerOperators, type OpContext } from '../app/app';
import { openDialog, closeDialog } from '../scripting/dialog';
import { Screen, cloneAreaState, editorTypes, newAreaId, MAIN_WINDOW_ONLY, type Area, type AreaState, type LayoutNode } from './screen';
import { leaves } from './layout';
import { shell } from './shell';
import { renderContext } from '../render/context';

let counter = 0;
export const areaWindows = new Map<string, Screen>();

/** Open a floating window holding one area with state `st` (or a whole layout); returns the window and its screen. */
export function openAreaWindow(st: AreaState | LayoutNode, opts: { width: number; height: number; x: number; y: number; title?: string }): { id: string; screen: Screen } {
  const layout: LayoutNode = 'id' in st ? { area: st } : st;
  const first = leaves(layout)[0];
  const id = `area-window-${++counter}`;
  const host = document.createElement('div');
  host.className = 'aw-host';
  const sc = new Screen(host);
  sc.floating = true;
  const w = Math.max(360, Math.min(innerWidth - 40, Math.round(opts.width))),
    hh = Math.max(240, Math.min(innerHeight - 80, Math.round(opts.height)));
  let unsub: (() => void) | null = null;
  const dlg = openDialog({
    id,
    title: opts.title ?? editorTypes.get(first?.type)?.label ?? 'Window',
    floating: true,
    hostsEditors: true,
    width: w,
    height: hh,
    className: 'area-window',
    body: () => h('div', { class: 'aw-body', ref: (el: HTMLElement) => el.append(host) }),
    onClose: () => {
      unsub?.();
      for (const x of sc.areas) x.editor.dispose();
      areaWindows.delete(id);
      if (app.hoverArea && sc.areas.includes(app.hoverArea as Area)) app.hoverArea = null;
    },
  });
  sc.load(layout);
  hookEngine();
  unsub = app.subscribe((kinds) => sc.update(kinds));
  areaWindows.set(id, sc);
  const box = dlg.el.querySelector<HTMLElement>('.dialog');
  if (box) {
    box.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, opts.x))}px`;
    box.style.top = `${Math.max(4, Math.min(innerHeight - hh - 4, opts.y))}px`;
  }
  return { id, screen: sc };
}

/** Open area `a` duplicated in a floating window; returns the window id. */
export function duplicateIntoWindow(a: Area, at?: { x: number; y: number }): string | null {
  if (MAIN_WINDOW_ONLY.has(a.type)) {
    app.report('WARNING', `The ${editorTypes.get(a.type)?.label ?? a.type} cannot be shown in a separate window`);
    return null;
  }
  const r = a.screen.el.getBoundingClientRect();
  const w = Math.max(360, Math.min(innerWidth - 40, Math.round(a.rect.w)));
  return openAreaWindow(cloneAreaState(a), { width: a.rect.w, height: a.rect.h, x: at ? at.x - w / 2 : r.left + a.rect.x + 30, y: at ? at.y - 14 : r.top + a.rect.y + 30 }).id;
}

export function closeAreaWindow(id: string) {
  closeDialog(id);
}

Screen.duplicateHook = (a, at) => void duplicateIntoWindow(a, at);

const areaOf = (ctx: OpContext) => (ctx.area && 'screen' in (ctx.area as object) ? (ctx.area as Area) : null);

registerOperators([
  {
    idname: 'screen.area_dupli',
    label: 'Duplicate Area into New Window',
    description: 'Show a copy of this editor in a floating window',
    undo: false,
    poll: (ctx) => !!areaOf(ctx) && !MAIN_WINDOW_ONLY.has(areaOf(ctx)!.type),
    exec: (ctx) => (duplicateIntoWindow(areaOf(ctx)!) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'wm.window_new',
    label: 'New Window',
    description: 'Open a window with a copy of the current workspace layout',
    undo: false,
    poll: () => !!shell,
    exec: () => {
      const layout = structuredClone(shell.screen.serialize()) as LayoutNode & { dock?: number };
      delete layout.dock;
      for (const st of leaves(layout)) st.id = newAreaId();
      const w = Math.round(innerWidth * 0.7),
        hh = Math.round(innerHeight * 0.7);
      openAreaWindow(layout, { width: w, height: hh, x: (innerWidth - w) / 2, y: 60, title: shell.active });
    },
  },
  {
    idname: 'outliner.orphans_manage',
    label: 'Manage Unused Data',
    description: 'Open an Outliner window listing the data-blocks nothing uses',
    undo: false,
    exec: () => {
      const { screen } = openAreaWindow({ id: newAreaId(), type: 'OUTLINER' }, { width: 420, height: 480, x: innerWidth / 2 - 210, y: 90 });
      const ed = screen.areas[0]?.editor as unknown as { displayMode?: string; update(k?: Set<string>): void };
      if (ed && 'displayMode' in ed) {
        ed.displayMode = 'ORPHAN_DATA';
        ed.update(new Set(['doc', 'ui']));
        screen.areas[0].drawHeader();
      }
    },
  },
]);

// ---------------------------------------------------------------------------
// 3D views inside area windows

const mirrors = new WeakMap<Area, HTMLCanvasElement>();
const lastRects = new WeakMap<Area, string>();

function windowViews(): Area[] {
  const out: Area[] = [];
  for (const sc of areaWindows.values()) for (const a of sc.areas) if (a.type === 'VIEW_3D' && a.el.style.display !== 'none') out.push(a);
  return out;
}

/** Before drawing: window 3D views draw after the main ones, and moved windows redraw. */
function beforeFrame() {
  const engine = renderContext?.engine;
  const views = windowViews();
  if (!engine || !views.length) return;
  const eds = new Set(views.map((a) => a.editor as unknown));
  const list = [...engine.viewports];
  const firstWin = list.findIndex((v) => eds.has(v));
  if (firstWin >= 0 && list.slice(firstWin).some((v) => !eds.has(v)))
    for (const v of list) if (eds.has(v)) (engine.viewports.delete(v), engine.viewports.add(v));
  for (const a of views) {
    const r = a.editor.el.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (lastRects.get(a) !== key) {
      lastRects.set(a, key);
      engine.requestDraw();
    }
  }
}

/** After drawing: copy each window 3D view's pixels into its window. */
function afterDraw() {
  const engine = renderContext?.engine;
  if (!engine) return;
  const base = engine.canvas.getBoundingClientRect();
  const dpr = engine.dpr;
  for (const a of windowViews()) {
    let c = mirrors.get(a);
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'aw-mirror';
      mirrors.set(a, c);
    }
    if (c.parentElement !== a.mainEl) a.mainEl.prepend(c);
    const r = a.editor.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)),
      h = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== w || c.height !== h) ((c.width = w), (c.height = h));
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
    const ctx = c.getContext('2d');
    if (!ctx) continue;
    try {
      ctx.drawImage(engine.canvas, (r.left - base.left) * dpr, (r.top - base.top) * dpr, w, h, 0, 0, w, h);
    } catch {
      // the canvas is not ready yet
    }
  }
}

let hooked = false;
function hookEngine() {
  const engine = renderContext?.engine;
  if (hooked || !engine) return;
  hooked = true;
  engine.frameCallbacks.add(beforeFrame);
  engine.afterDraw.add(afterDraw);
}
