// Modal dialogs with focus management: focus moves into the dialog, Tab is
// trapped, Escape cancels, and focus returns to where it was on close.

import { h } from '../lib/dom.js';
import { icon } from './icons.js';

let openCount = 0;

/**
 * Opens a dialog. `build(close)` returns the body content; `buttons` are
 * { label, value, primary, danger, disabled } and resolve the promise with
 * value (Escape and the close button resolve null). `onSubmit(value)` may
 * return false to keep the dialog open (e.g. validation failed). Enter
 * presses the primary button except inside an element with data-own-enter.
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
    dialog.append(
      h('header.dialog-head', h('h2.dialog-title', { id: titleId }, title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, icon('x'))),
      h('div.dialog-body', content),
      buttons.length ? foot : null,
    );
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
    const target = (initialFocus && dialog.querySelector(initialFocus)) || dialog.querySelector('input, select, textarea') || dialog.querySelector('.btn.primary') || dialog.querySelector('button');
    target?.focus();
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
export async function saveChangesDialog(name) {
  return openDialog({
    title: 'Save changes?',
    body: h('p', { style: { margin: 0, maxWidth: '420px' } }, `Save changes to "${name}" before closing?`),
    buttons: [
      { label: "Don't Save", value: 'discard', danger: true },
      { label: 'Cancel', value: null },
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
