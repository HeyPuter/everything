/**
 * Modal dialogs built on <dialog>, plus confirm/prompt helpers and toasts.
 * Focus is trapped by the platform's modal dialog and returns to the
 * previously focused element on close.
 */
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * openDialog({ title, body, actions: [{ label, primary, danger, value, onClick }], size, onClose })
 * Resolves with the value of the action used to close it (or null).
 */
export function openDialog({ title, body, actions = [], size = 'md', className, initialFocus, onClose, describedBy }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const dlg = h('dialog.dialog', { 'aria-labelledby': titleId, 'aria-describedby': describedBy, class: `size-${size}${className ? ' ' + className : ''}` });
    const close = (value) => {
      if (!dlg.open) return;
      dlg.close();
      dlg.remove();
      onClose?.(value);
      prev?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const footer = actions.length
      ? h(
          'footer.dialog-actions',
          actions.map((a) =>
            h(
              `button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`,
              {
                type: a.submit ? 'submit' : 'button',
                onClick: async (e) => {
                  if (a.onClick) {
                    const r = await a.onClick(e);
                    if (r === false) return;
                    close(r ?? a.value ?? null);
                  } else close(a.value ?? null);
                },
              },
              a.label,
            ),
          ),
        )
      : null;
    dlg.append(
      h(
        'header.dialog-head',
        h('h2.dialog-title', { id: titleId }, title),
        h('button.icon-btn.dialog-x', { type: 'button', 'aria-label': 'Close', onClick: () => close(null) }, icon('x', 18)),
      ),
      h('div.dialog-body', body),
    );
    if (footer) dlg.append(footer);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    dlg.addEventListener('pointerdown', (e) => {
      if (e.target === dlg) close(null);
    });
    dlg.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Enter in a single-line field confirms, as in any form.
      const t = e.target;
      if (e.key === 'Enter' && !e.isComposing && t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color'].includes(t.type) && !t.closest('.palette')) {
        const primary = dlg.querySelector('.dialog-actions .btn.primary');
        if (primary) {
          e.preventDefault();
          primary.click();
        }
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    const f = initialFocus ? dlg.querySelector(initialFocus) : dlg.querySelector('input, select, textarea, button.primary');
    f?.focus();
    if (f instanceof HTMLInputElement && f.type === 'text') f.select();
    dlg._close = close;
  });
}

export async function confirmDialog(title, message, { confirm = 'OK', cancel = 'Cancel', danger = false } = {}) {
  const r = await openDialog({
    title,
    body: h('p.dialog-text', message),
    size: 'sm',
    actions: [
      { label: cancel, value: false },
      { label: confirm, primary: !danger, danger, value: true },
    ],
  });
  return r === true;
}

/** Three-way choice used for unsaved changes. Returns 'save' | 'discard' | null. */
export function unsavedDialog(name) {
  return openDialog({
    title: 'Save changes?',
    body: h('p.dialog-text', `"${name}" has changes that are not saved.`),
    size: 'sm',
    actions: [
      { label: 'Cancel', value: null },
      { label: "Don't save", danger: true, value: 'discard' },
      { label: 'Save', primary: true, value: 'save' },
    ],
  });
}

export async function promptDialog(title, label, value = '', { placeholder = '', okLabel = 'OK', validate } = {}) {
  const input = h('input.input', { type: 'text', value, placeholder, 'aria-label': label, spellcheck: 'false' });
  const err = h('p.field-error', { role: 'alert' });
  const form = h('form.field', { onSubmit: (e) => e.preventDefault() }, h('label.field-label', label), input, err);
  let result = null;
  await openDialog({
    title,
    body: form,
    size: 'sm',
    initialFocus: 'input',
    actions: [
      { label: 'Cancel', value: null },
      {
        label: okLabel,
        primary: true,
        onClick: () => {
          const v = input.value.trim();
          const msg = validate?.(v);
          if (msg) {
            err.textContent = msg;
            input.setAttribute('aria-invalid', 'true');
            return false;
          }
          result = v;
          return true;
        },
      },
    ],
  });
  return result;
}

// Toasts ---------------------------------------------------------------------

let region = null;

function toastRegion() {
  if (!region) {
    region = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    // As a popover the region sits in the top layer, above (and not hidden by) modal dialogs.
    if ('popover' in region) region.popover = 'manual';
    document.body.append(region);
  }
  if (region.popover) {
    try {
      if (region.matches(':popover-open')) region.hidePopover();
      region.showPopover();
    } catch {
      /* popovers unsupported */
    }
  }
  return region;
}

/** Short, non-blocking notice. kind: 'info' | 'success' | 'error' */
export function toast(message, { kind = 'info', timeout = 3200, action } = {}) {
  const el = h(
    `div.toast.${kind}`,
    h('span.toast-msg', message),
    action ? h('button.btn.sm.ghost', { type: 'button', onClick: () => (action.run(), el.remove()) }, action.label) : null,
    h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Dismiss', onClick: () => el.remove() }, icon('x', 14)),
  );
  toastRegion().append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  return el;
}
