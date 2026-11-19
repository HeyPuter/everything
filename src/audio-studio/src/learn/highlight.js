// Points at the part of the interface a tutorial step is about: a ring around it and a
// small callout with the step's title. The target is found again every few frames, so it
// follows menus as they open, panels as they move and dialogs as they appear.

import { h } from '../lib/dom.js';

const visible = (el) => {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

const label = (row) => row.querySelector?.('.menu-label')?.textContent?.trim() || row.textContent.trim();

/**
 * The element a step points at right now:
 *   the command's row in an open menu, else the next submenu on the step's menu path
 *   in an open menu, else the step's own target, else the menu bar entry the path starts
 *   from, else a toolbar or panel button that runs the command.
 */
export function resolveTarget(step, app, ctx, root = document) {
  if (!step) return null;
  const rows = [...root.querySelectorAll('.menu .menu-item')];
  if (step.command) {
    const row = rows.find((r) => r._item?.id === step.command);
    if (visible(row)) return row;
  }
  if (step.menu?.length && rows.length) {
    for (let i = step.menu.length - 1; i >= 1; i--) {
      const row = rows.find((r) => label(r) === step.menu[i]);
      if (visible(row)) return row;
    }
  }
  let el = null;
  try {
    el = typeof step.target === 'function' ? step.target(app, ctx) : typeof step.target === 'string' ? root.querySelector(step.target) : null;
  } catch {
    el = null;
  }
  if (visible(el)) return el;
  if (step.menu?.length) {
    const top = [...root.querySelectorAll('.menubar-item')].find((b) => b.textContent.trim() === step.menu[0]);
    if (visible(top)) return top;
  }
  if (step.command) {
    const btn = [...root.querySelectorAll(`[data-cmd="${CSS.escape(step.command)}"]`)].find(visible);
    if (btn) return btn;
  }
  return null;
}

/** Where to put a callout of size w x h next to rect r inside a W x H window. */
export function calloutPosition(r, w, hgt, W, H, gap = 10) {
  let top = r.bottom + gap;
  if (top + hgt > H - 4) top = r.top - gap - hgt;
  if (top < 4) top = Math.min(H - hgt - 4, Math.max(4, r.top));
  const left = Math.max(4, Math.min(W - w - 4, r.left));
  return { left: Math.round(left), top: Math.round(top) };
}

export class Highlighter {
  constructor() {
    this.ring = h('div.learn-ring', { 'aria-hidden': 'true', hidden: true });
    this.callout = h('div.learn-callout', { 'aria-hidden': 'true', hidden: true });
    this.timer = 0;
    this.step = null;
  }

  /** Points at `step` (null hides) until changed; `resolve()` finds its element. */
  show(step, resolve) {
    this.step = step;
    this.resolve = resolve;
    if (!this.ring.isConnected) document.body.append(this.ring, this.callout);
    this.callout.textContent = step?.title || '';
    clearInterval(this.timer);
    if (!step) {
      this.ring.hidden = this.callout.hidden = true;
      return;
    }
    this.place();
    this.timer = setInterval(() => this.place(), 200);
  }

  place() {
    const el = this.step ? this.resolve?.() : null;
    if (!el) {
      this.ring.hidden = this.callout.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 3;
    Object.assign(this.ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    this.ring.hidden = false;
    this.callout.hidden = false;
    const c = this.callout.getBoundingClientRect();
    const w = c.width || 200;
    const menu = el.closest?.('.menu')?.getBoundingClientRect();
    // In a menu, beside it rather than over the next items.
    const p = menu
      ? { left: Math.round(menu.right + 8 + w <= window.innerWidth ? menu.right + 8 : Math.max(4, menu.left - 8 - w)), top: Math.round(r.top + (r.height - (c.height || 24)) / 2) }
      : calloutPosition(r, w, c.height || 28, window.innerWidth, window.innerHeight);
    Object.assign(this.callout.style, { left: `${p.left}px`, top: `${p.top}px` });
  }

  dispose() {
    clearInterval(this.timer);
    this.ring.remove();
    this.callout.remove();
  }
}
