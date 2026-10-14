// Floating tool windows (instrument and effect editors). Non-modal, dragged
// by the title bar, kept on screen, raised on focus, closed with the close
// button or Escape. One window per key: opening an open key raises it. On
// phones a window is a full-width sheet at the bottom of the screen.
//
//   const win = openWindow({ key: `channel:${id}`, title, icon, body, width, onClose })
//   win.setTitle(text); win.close(); win.el; win.body

import { h } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { icon } from './icons.js';

const open = new Map(); // key -> window api
let z = 500;
let cascade = 0;

export function getWindow(key) {
  return open.get(key) || null;
}

export function closeWindow(key) {
  open.get(key)?.close();
}

/** Closes every window whose key starts with `prefix` (e.g. when its channel is deleted). */
export function closeWindows(prefix = '') {
  for (const [k, w] of [...open]) if (k.startsWith(prefix)) w.close();
}

export function openWindow({ key, title, icon: glyph, body, width = 420, onClose, toolbar, focus = true }) {
  const existing = open.get(key);
  if (existing) {
    existing.raise();
    if (focus) existing.focus();
    return existing;
  }
  const titleEl = h('h2.win-title', title);
  const closeBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': `Close ${title}`, title: 'Close (Escape)' }, icon('x', 14));
  const head = h('header.win-head', glyph ? h('span.win-icon', icon(glyph, 14)) : null, titleEl, h('div.win-tools', toolbar || null), closeBtn);
  const content = h('div.win-body', body);
  const el = h('section.float-win', { role: 'dialog', 'aria-modal': 'false', 'aria-label': title, tabindex: '-1' }, head, content);
  el.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
  document.body.append(el);

  // Place cascading from the upper middle of the screen.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = clamp(vw / 2 - el.offsetWidth / 2 + (cascade % 6) * 24, 8, vw - el.offsetWidth - 8);
  let y = clamp(90 + (cascade % 6) * 24, 8, Math.max(8, vh - el.offsetHeight - 8));
  cascade++;
  const place = () => {
    x = clamp(x, 8 - el.offsetWidth + 120, window.innerWidth - 120);
    y = clamp(y, 4, window.innerHeight - 40);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  };
  place();
  // Keep the whole window on screen when its content grows (tabs, sections).
  const fit = new ResizeObserver(() => {
    const over = y + el.offsetHeight - (window.innerHeight - 8);
    if (over > 0) {
      y = Math.max(4, y - over);
      place();
    }
  });
  fit.observe(el);

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const sx = e.clientX - x;
    const sy = e.clientY - y;
    const move = (ev) => {
      x = ev.clientX - sx;
      y = ev.clientY - sy;
      place();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });

  const previous = document.activeElement;
  const api = {
    el,
    body: content,
    key,
    raise() {
      el.style.zIndex = String(++z);
    },
    focus() {
      (el.querySelector('[role="slider"], button:not(.win-head button), input, select') || el).focus({ preventScroll: true });
    },
    setTitle(t) {
      titleEl.textContent = t;
      el.setAttribute('aria-label', t);
      closeBtn.setAttribute('aria-label', `Close ${t}`);
    },
    close() {
      if (!open.has(key)) return;
      open.delete(key);
      el.remove();
      fit.disconnect();
      window.removeEventListener('resize', place);
      onClose?.();
      if (el.contains(document.activeElement) || document.activeElement === document.body) previous?.focus?.({ preventScroll: true });
    },
  };
  closeBtn.addEventListener('click', () => api.close());
  el.addEventListener('pointerdown', () => api.raise(), true);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.target.closest('input, select, textarea')) {
      e.preventDefault();
      e.stopPropagation();
      api.close();
    }
  });
  window.addEventListener('resize', place);
  open.set(key, api);
  api.raise();
  if (focus) api.focus();
  return api;
}
