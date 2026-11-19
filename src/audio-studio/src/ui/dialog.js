// Modal dialogs with focus management: focus moves into the dialog, Tab is
// trapped, Escape cancels, and focus returns to where it was on close.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

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
    if (sheetLayout() || offset.x || offset.y || positions.has(key)) return;
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

/**
 * Opens a dialog. `build(close)` returns the body content; `buttons` are
 * { label, value, primary, danger, disabled } and resolve the promise with
 * value (Escape and the close button resolve null). `onSubmit(value)` may
 * return false to keep the dialog open (e.g. validation failed). Enter
 * presses the primary button except inside an element with data-own-enter.
 * `initialFocus` is a selector, or selectors in order of preference; the
 * first match that can take focus gets it.
 */
export function openDialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onSubmit, footerStart, className = '', initialFocus }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const titleId = `dlg-title-${++openCount}`;
    const dialog = h(`div.dialog${wide ? '.wide' : ''}${className ? `.${className}` : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    const backdrop = h('div.dialog-backdrop', dialog);
    let done = false;
    const close = async (value) => {
      if (done) return;
      if (value !== null && value !== undefined && onSubmit) {
        const ok = await onSubmit(value);
        if (ok === false) return;
      }
      done = true;
      backdrop.remove();
      document.removeEventListener('keydown', keys, true);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
      resolve(value ?? null);
    };
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
    const movable = makeMovable(dialog, head, typeof title === 'string' ? title : className || 'dialog');
    dialog.append(head, h('div.dialog-body', content), buttons.length ? foot : null);
    const keys = (e) => {
      if (!backdrop.isConnected) return;
      // Only the topmost dialog handles keys (a dialog may open another).
      const all = document.querySelectorAll('.dialog-backdrop');
      if (all[all.length - 1] !== backdrop) return;
      // Inline value editors (hot text) take their own Enter and Escape.
      if ((e.key === 'Enter' || e.key === 'Escape') && e.target.classList?.contains('hot-edit')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON' && dialog.contains(e.target) && !e.target.closest('[data-own-enter]')) {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          close(primary.value);
        }
      } else if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!items.length) return;
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
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.append(backdrop);
    movable.restore();
    // The first candidate that takes focus (a layout may hide some, e.g. tabs on phones).
    const preferred = [].concat(initialFocus || []).flatMap((sel) => [...dialog.querySelectorAll(sel)]);
    const candidates = [...preferred, dialog.querySelector('input, select, textarea'), dialog.querySelector('.btn.primary'), dialog.querySelector('button')];
    const target = candidates.find((el) => {
      el?.focus();
      return el && document.activeElement === el;
    });
    if (target?.select && target.tagName === 'INPUT') target.select();
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
