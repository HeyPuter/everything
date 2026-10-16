// Dialogs (modal, with backdrop) and floating windows (non-modal, draggable) built on the
// shared .dialog CSS classes.
import { h, patch, clearRoot, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { anyPopupOpen } from '../ui/menu';

export interface DialogHandle {
  el: HTMLElement;
  redraw(): void;
  close(): void;
}

const open = new Map<string, DialogHandle>();

interface DialogOpts {
  id: string;
  title: string;
  body: () => Child;
  /** floating, non-modal window (like a separate OS window) */
  floating?: boolean;
  width?: number;
  height?: number;
  className?: string;
  onClose?: () => void;
  /** extra title bar content */
  titleExtra?: () => Child;
  /** hosts editors (an area window): keys and hover go to the editors as on the main screen */
  hostsEditors?: boolean;
}

export function isDialogOpen(id: string) {
  return open.has(id);
}

export function closeDialog(id: string) {
  open.get(id)?.close();
}

export function openDialog(o: DialogOpts): DialogHandle {
  const existing = open.get(o.id);
  if (existing) {
    existing.el.style.zIndex = String(nextZ());
    existing.redraw();
    return existing;
  }
  const root = document.createElement('div');
  root.className = o.floating ? 'dialog-float' : 'dialog-backdrop';
  root.style.zIndex = String(nextZ());
  const box = document.createElement('div');
  box.className = `dialog ${o.className ?? ''}`;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', o.title);
  if (!o.floating) box.setAttribute('aria-modal', 'true');
  if (o.width) box.style.width = `${o.width}px`;
  if (o.height) box.style.height = `${o.height}px`;
  const titleEl = document.createElement('div');
  titleEl.className = 'dialog-title';
  const bodyEl = document.createElement('div');
  bodyEl.className = 'dialog-body';
  box.append(titleEl, bodyEl);
  root.append(box);
  document.body.append(root);
  if (o.floating) {
    const w = o.width ?? 720,
      hgt = o.height ?? 520;
    box.style.left = `${Math.max(8, (innerWidth - w) / 2)}px`;
    box.style.top = `${Math.max(8, (innerHeight - hgt) / 2.4)}px`;
    box.addEventListener('pointerdown', () => (root.style.zIndex = String(nextZ())), true);
  }
  let unsub: (() => void) | null = null;
  const handle: DialogHandle = {
    el: root,
    redraw: () => {
      patch(titleEl, [
        h('span', { class: 'dlg-title-text' }, o.title),
        h('span', { class: 'grow' }),
        o.titleExtra ? o.titleExtra() : null,
        h('button', { class: 'dlg-close', 'aria-label': 'Close', 'data-tip': 'Close', onclick: () => handle.close() }, icon('panel_close')),
      ]);
      patch(bodyEl, o.body());
    },
    close: () => {
      if (!open.has(o.id)) return;
      open.delete(o.id);
      unsub?.();
      order.splice(order.indexOf(o.id), 1);
      clearRoot(bodyEl);
      clearRoot(titleEl);
      root.remove();
      o.onClose?.();
    },
  };
  if (!o.hostsEditors)
    root.addEventListener('pointerenter', () => {
      // keys pressed over a dialog must not reach the editor underneath
      app.hoverArea = null;
      app.activeArea = null;
    });
  if (!o.floating)
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) handle.close();
    });
  // dragging by the title bar
  titleEl.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    if (!o.floating) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left,
      dy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      box.style.left = `${Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx))}px`;
      box.style.top = `${Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy))}px`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  // keep the global keymap out while typing in dialog inputs; stop editor shortcuts inside dialogs
  box.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).closest('input, textarea, [data-capture]')) e.stopPropagation();
  });
  open.set(o.id, handle);
  order.push(o.id);
  (handle as DialogHandle & { modal: boolean; hostsEditors: boolean }).modal = !o.floating;
  (handle as DialogHandle & { modal: boolean; hostsEditors: boolean }).hostsEditors = !!o.hostsEditors;
  unsub = app.subscribe(() => root.isConnected && handle.redraw());
  handle.redraw();
  return handle;
}

let z = 950;
const nextZ = () => ++z;
const order: string[] = [];

/** Fields, and dialog content that handles its own keys (marked with data-keys). */
const isField = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"], [data-keys]');

// Registered at module load (before the global keyboard handler), so keys aimed at a dialog
// never trigger editor shortcuts underneath. Escape closes the top-most dialog.
addEventListener(
  'keydown',
  (e) => {
    if (!order.length || anyPopupOpen()) return;
    const top = open.get(order[order.length - 1]) as (DialogHandle & { modal: boolean; hostsEditors: boolean }) | undefined;
    if (!top || top.hostsEditors) return;
    const target = e.target as HTMLElement | null;
    const focusIn = [...open.values()].some((d) => d.el.contains(document.activeElement));
    const hoverIn = [...open.values()].some((d) => d.el.querySelector('.dialog')?.matches(':hover'));
    if (!top.modal && !focusIn && !hoverIn) return;
    if (isField(target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      top.close();
    }
    e.stopImmediatePropagation();
  },
  true,
);
