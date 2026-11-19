// Modal dialogs with focus management: focus moves into the dialog, Tab is
// trapped, Escape cancels, and focus returns to where it was on close.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { raiseWindow, stackWindow } from './window-stack.js';

let openCount = 0;
/** Where each dialog (by title) was last moved to: { x, y } offsets from the centered place. */
const memory = new Map();
let store = {
  get: (key) => memory.get(key),
  set: (key, p) => (p ? memory.set(key, p) : memory.delete(key)),
};
/** At most this many dialogs' places are kept. */
const MAX_PLACES = 60;

/**
 * Keeps dialog places in preferences (a { title: { x, y } } object under `key`)
 * instead of for this session only.
 */
export function rememberDialogPlaces(prefs, key = 'dialogPositions') {
  const all = () => {
    const v = prefs.get(key);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  };
  store = {
    get: (name) => {
      const p = all()[name];
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : undefined;
    },
    set: (name, p) => {
      const next = { ...all() };
      delete next[name];
      if (p) next[name] = { x: p.x, y: p.y };
      const names = Object.keys(next);
      for (const old of names.slice(0, Math.max(0, names.length - MAX_PLACES))) delete next[old];
      prefs.set(key, next);
    },
  };
}
/** Pixels of a moved dialog's title bar kept inside the window. */
const KEEP = 80;

const sheetLayout = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;

/**
 * Lets a dialog be dragged by its title bar, like a desktop window, and puts
 * it back where it was last left. Phone-width bottom sheets stay put.
 */
function makeMovable(dialog, head, key) {
  let offset = { x: 0, y: 0 };
  const apply = (x, y) => {
    const r = dialog.getBoundingClientRect();
    const left = r.left - offset.x;
    const top = r.top - offset.y;
    const hh = head.offsetHeight || 32;
    offset = {
      x: Math.round(Math.max(KEEP - (left + r.width), Math.min(window.innerWidth - KEEP - left, x))),
      y: Math.round(Math.max(-top, Math.min(window.innerHeight - hh - top, y))),
    };
    dialog.style.translate = offset.x || offset.y ? `${offset.x}px ${offset.y}px` : '';
  };
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sheetLayout()) return;
    if (e.target instanceof Element && e.target.closest('button, input, select, textarea, a, [role=button]')) return;
    e.preventDefault();
    head.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    head.classList.add('moving');
    const move = (ev) => apply(start.ox + ev.clientX - start.x, start.oy + ev.clientY - start.y);
    const up = () => {
      head.classList.remove('moving');
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      store.set(key, offset.x || offset.y ? { ...offset } : null);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  // Double-clicking the title bar puts the dialog back in the middle.
  head.addEventListener('dblclick', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    apply(0, 0);
    store.set(key, null);
  });
  /**
   * Moves a dialog the user has not placed off `rect` (client px), e.g. the Preview
   * Editor it previews into: beside it if the window has room, else as far right as fits.
   */
  dialog.avoid = (rect) => {
    if (sheetLayout() || offset.x || offset.y || store.get(key)) return;
    const r = dialog.getBoundingClientRect();
    if (r.right <= rect.left || r.left >= rect.right || r.bottom <= rect.top || r.top >= rect.bottom) return;
    const options = [
      { x: rect.right - r.left, y: 0 },
      { x: rect.left - r.right, y: 0 },
      { x: 0, y: rect.top - r.bottom },
    ].filter((o) => r.left + o.x >= 0 && r.right + o.x <= window.innerWidth && r.top + o.y >= 0);
    const best = options[0] || { x: window.innerWidth - 8 - r.right, y: 0 };
    apply(best.x, best.y);
  };
  return {
    restore() {
      const p = store.get(key);
      if (p && !sheetLayout()) apply(p.x, p.y);
    },
  };
}
const narrow = sheetLayout;

/**
 * Opens a dialog. `build(close)` returns the body content; `buttons` are
 * { label, value, primary, danger, disabled } and resolve the promise with
 * value (Escape and the close button resolve null). `onSubmit(value)` may
 * return false to keep the dialog open (e.g. validation failed). Enter
 * presses the primary button except inside an element with data-own-enter.
 * `initialFocus` is a selector, or selectors in order of preference; the
 * first match that can take focus gets it.
 *
 * `modeless: true` opens a floating window instead (not on phone-width
 * screens): the rest of the app stays usable, its keys and the dialog's own
 * (Escape, Enter, Tab) only act while focus is inside it, and its title bar
 * drags it (the place is remembered per `positionKey`). `handle` receives
 * { close(value), el } so the opener can close it from outside.
 */
export function openDialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onSubmit, footerStart, className = '', initialFocus, modeless = false, positionKey = className, handle = null }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const titleId = `dlg-title-${++openCount}`;
    const floating = modeless && !narrow();
    const dialog = h(`div.dialog${wide ? '.wide' : ''}${className ? `.${className}` : ''}`, { role: 'dialog', 'aria-modal': floating ? 'false' : 'true', 'aria-labelledby': titleId });
    const backdrop = h(`div.dialog-backdrop${floating ? '.modeless' : ''}`, dialog);
    let done = false;
    const close = async (value) => {
      if (done) return;
      if (value !== null && value !== undefined && onSubmit) {
        const ok = await onSubmit(value);
        if (ok === false) return;
      }
      done = true;
      // A floating window gives focus back only when it had it (not while you work in the editor).
      const hadFocus = dialog.contains(document.activeElement);
      backdrop.remove();
      document.removeEventListener('keydown', keys, true);
      if ((!floating || hadFocus) && previous && previous.isConnected) previous.focus({ preventScroll: true });
      resolve(value ?? null);
    };
    if (handle) {
      handle.close = close;
      handle.el = dialog;
    }
    const content = typeof body === 'function' ? body(close) : body;
    const foot = h('div.dialog-foot');
    if (footerStart) foot.append(footerStart, h('div.spacer'));
    for (const b of buttons) {
      foot.append(
        h(
          `button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`,
          { type: b.primary ? 'submit' : 'button', disabled: b.disabled, onclick: () => close(b.value), dataset: { value: String(b.value) } },
          b.label,
        ),
      );
    }
    // A div, not a <header>: outside sectioning content that is a second page banner landmark.
    const head = h('div.dialog-head', h('h2.dialog-title', { id: titleId }, title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, icon('x')));
    // Floating windows place and drag themselves (placeFloating); modal dialogs move by their title bar.
    const movable = floating ? null : makeMovable(dialog, head, typeof title === 'string' ? title : className || 'dialog');
    dialog.append(head, h('div.dialog-body', content), buttons.length ? foot : null);
    const keys = (e) => {
      if (!backdrop.isConnected) return;
      if (floating && !dialog.contains(e.target)) return;
      // Only the topmost modal dialog handles keys (a dialog may open another); a floating
      // window handles the keys pressed inside it, wherever it sits in the window stack.
      if (!floating) {
        const all = document.querySelectorAll('.dialog-backdrop:not(.modeless)');
        if (all[all.length - 1] !== backdrop) return;
      }
      // Inline value editors (hot text) take their own Enter and Escape.
      if ((e.key === 'Enter' || e.key === 'Escape') && e.target.classList?.contains('hot-edit')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && dialog.contains(e.target) && !e.target.closest('[data-own-enter]')) {
        const primary = buttons.find((b) => b.primary);
        // A primary button the dialog has disabled (nothing to apply yet) ignores Enter too.
        if (primary && !foot.querySelector('.btn.primary')?.disabled) {
          e.preventDefault();
          close(primary.value);
        }
      } else if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!items.length) return;
        // Controls outside the dialog that work with it (data-dialog-companion, e.g. the
        // Preview Editor's A/B) join the Tab cycle after the dialog's own.
        const companions = [...document.querySelectorAll('[data-dialog-companion]')].filter((el) => !el.disabled && el.offsetParent !== null && !dialog.contains(el));
        const cycle = [...items, ...companions];
        const at = cycle.indexOf(document.activeElement);
        if (companions.length && at !== -1) {
          e.preventDefault();
          cycle[(at + (e.shiftKey ? -1 : 1) + cycle.length) % cycle.length].focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      // Other keys reach the dialog's controls; the shell ignores keys while a dialog is open.
    };
    document.addEventListener('keydown', keys, true);
    if (!floating) {
      backdrop.addEventListener('pointerdown', (e) => {
        if (e.target === backdrop) close(null);
      });
    }
    document.body.append(backdrop);
    // A floating window opens in front of the other floating windows and comes forward when clicked.
    if (floating) raiseWindow(stackWindow(backdrop));
    if (floating) placeFloating(dialog, positionKey || (typeof title === 'string' ? title : 'dialog'));
    else movable?.restore();
    // The first candidate that takes focus (a layout may hide some, e.g. tabs on phones).
    const preferred = [].concat(initialFocus || []).flatMap((sel) => [...dialog.querySelectorAll(sel)]);
    // Without a field or default button, a footer button (Cancel) before the title bar's close button.
    const candidates = [...preferred, dialog.querySelector('input, select, textarea'), dialog.querySelector('.btn.primary'), dialog.querySelector('.dialog-foot button'), dialog.querySelector('button')];
    const target = candidates.find((el) => {
      el?.focus();
      return el && document.activeElement === el;
    });
    if (target?.select && target.tagName === 'INPUT') target.select();
  });
}

/** Pins a floating window where it was last left (or where it opened) and lets its title bar drag it. */
function placeFloating(dialog, key) {
  const keep = (left, top) => {
    // The whole window stays on screen (its title bar at least, when it is taller than the window).
    // Layout size, not the on-screen box: the opening animation scales the window down a little.
    const r = dialog.getBoundingClientRect();
    const maxL = Math.max(0, window.innerWidth - (dialog.offsetWidth || r.width));
    const maxT = Math.max(0, window.innerHeight - (dialog.offsetHeight || r.height));
    dialog.style.left = `${Math.round(Math.min(maxL, Math.max(0, left)))}px`;
    dialog.style.top = `${Math.round(Math.min(maxT, Math.max(0, top)))}px`;
  };
  const r = dialog.getBoundingClientRect();
  const saved = store.get(`float:${key}`);
  const placed = saved ? { left: saved.x, top: saved.y } : null;
  dialog.classList.add('floating');
  // A click on a bare part of the window (its title, a label) moves focus into it, so its keys work.
  dialog.tabIndex = -1;
  dialog.addEventListener('pointerdown', (e) => {
    if (!dialog.contains(document.activeElement) && !e.target.closest('button, input, select, textarea, a, [tabindex]:not(.dialog)')) dialog.focus({ preventScroll: true });
  });
  keep(placed ? placed.left : r.left, placed ? placed.top : r.top);
  // Content that lays out after opening (graphs, meters) or a smaller window can push the
  // window past the edge: it steps back in whenever its size or the window's changes.
  const refit = () => {
    if (!dialog.isConnected) return removeEventListener('resize', refit);
    const left = parseFloat(dialog.style.left) || 0;
    const top = parseFloat(dialog.style.top) || 0;
    if (left + dialog.offsetWidth > window.innerWidth || top + dialog.offsetHeight > window.innerHeight) keep(left, top);
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(refit).observe(dialog);
  addEventListener('resize', refit);
  // Steps off `rect` (e.g. the Preview Editor) unless the user has placed this window.
  dialog.avoid = (rect) => {
    if (store.get(`float:${key}`)) return;
    const d = dialog.getBoundingClientRect();
    if (d.right <= rect.left || d.left >= rect.right || d.bottom <= rect.top || d.top >= rect.bottom) return;
    // Beside it, else above or below it, else wherever overlaps it least.
    const spots = [
      { left: rect.right, top: d.top },
      { left: rect.left - d.width, top: d.top },
      { left: d.left, top: rect.top - d.height },
      { left: d.left, top: rect.bottom },
    ];
    const fits = (o) => o.left >= 0 && o.top >= 0 && o.left + d.width <= window.innerWidth && o.top + d.height <= window.innerHeight;
    const overlap = (o) => Math.max(0, Math.min(o.left + d.width, rect.right) - Math.max(o.left, rect.left)) * Math.max(0, Math.min(o.top + d.height, rect.bottom) - Math.max(o.top, rect.top));
    const clamp = (o) => ({ left: Math.min(Math.max(0, o.left), Math.max(0, window.innerWidth - d.width)), top: Math.min(Math.max(0, o.top), Math.max(0, window.innerHeight - d.height)) });
    const best = spots.find(fits) || spots.map(clamp).sort((a, b) => overlap(a) - overlap(b))[0];
    keep(best.left, best.top);
  };
  const head = dialog.querySelector('.dialog-head');
  head?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, a')) return;
    e.preventDefault();
    const start = dialog.getBoundingClientRect();
    const dx = e.clientX - start.left;
    const dy = e.clientY - start.top;
    head.setPointerCapture?.(e.pointerId);
    const move = (ev) => keep(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      const now = dialog.getBoundingClientRect();
      store.set(`float:${key}`, { x: now.left, y: now.top });
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
}

export async function confirmDialog({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false }) {
  const r = await openDialog({
    title,
    body: h('p', { style: { margin: 0, maxWidth: '420px' } }, message),
    buttons: [
      { label: cancel, value: false },
      { label: confirm, value: true, primary: !danger, danger },
    ],
  });
  return r === true;
}

/** Three-way question: resolves 'save' | 'discard' | null (cancel). */
/**
 * Asks whether to save a file before it closes: 'save', 'discard' or null (cancel). When
 * `others` more unsaved files are closing after it, it also offers 'saveAll' and 'discardAll'.
 */
export async function saveChangesDialog(name, { others = 0 } = {}) {
  const more = others > 0 ? ` ${others} more file${others === 1 ? ' has' : 's have'} unsaved changes.` : '';
  return openDialog({
    title: 'Save changes?',
    body: h('p', { style: { margin: 0, maxWidth: '420px' } }, `Save changes to "${name}" before closing?${more}`),
    buttons: [
      { label: "Don't Save", value: 'discard', danger: true },
      ...(others > 0 ? [{ label: "Don't Save Any", value: 'discardAll', danger: true }] : []),
      { label: 'Cancel', value: null },
      ...(others > 0 ? [{ label: 'Save All', value: 'saveAll' }] : []),
      { label: 'Save', value: 'save', primary: true },
    ],
  });
}

export async function promptDialog({ title, label, value = '', confirm = 'OK', validate }) {
  const input = h('input.input', { type: 'text', value, 'aria-label': label, style: { width: '100%' } });
  const error = h('div.faint', { role: 'alert', style: { minHeight: '1em', color: 'var(--danger)' } });
  const r = await openDialog({
    title,
    body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '300px' } }, h('label', label), input, error),
    buttons: [
      { label: 'Cancel', value: null },
      { label: confirm, value: 'ok', primary: true },
    ],
    onSubmit: () => {
      const msg = validate?.(input.value);
      if (msg) {
        error.textContent = msg;
        return false;
      }
      return true;
    },
  });
  return r === 'ok' ? input.value : null;
}
