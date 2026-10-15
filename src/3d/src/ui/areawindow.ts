// Area windows: an editor duplicated into a floating window over the main screen
// (Duplicate Area into New Window, Shift-drag from an area corner). They hold a screen
// of their own, so they can be split and their editor type changed like any area.
import { h } from './h';
import { app, registerOperators, type OpContext } from '../app/app';
import { openDialog, closeDialog } from '../scripting/dialog';
import { Screen, cloneAreaState, editorTypes, newAreaId, MAIN_WINDOW_ONLY, type Area, type AreaState } from './screen';

let counter = 0;
export const areaWindows = new Map<string, Screen>();

/** Open a floating window holding one area with state `st`; returns the window and its screen. */
export function openAreaWindow(st: AreaState, opts: { width: number; height: number; x: number; y: number }): { id: string; screen: Screen } {
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
    title: editorTypes.get(st.type)?.label ?? 'Window',
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
  sc.load({ area: st });
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
