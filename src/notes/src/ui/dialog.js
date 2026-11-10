import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/**
 * Modal dialogs on the native <dialog> element: focus is trapped, Esc
 * cancels and focus returns to the opener.
 *   openDialog({ title, body, actions: [{ label, primary, danger, run }], width })
 * An action's run() may return false to keep the dialog open, or a function
 * to run after the dialog has closed.
 */
export function openDialog({ title, body, actions = [], width = 440, className = '', onClose, describedBy, initialFocus } = {}) {
  const opener = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const dialog = h(`dialog.dialog${className ? '.' + className : ''}`, { 'aria-labelledby': titleId, style: { '--dialog-width': `${width}px` } });
  if (describedBy) dialog.setAttribute('aria-describedby', describedBy);
  const close = (result) => {
    if (!dialog.open) return;
    dialog.close();
    dialog.remove();
    onClose?.(result);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const header = h('div.dialog-header',
    h('h2.dialog-title', { id: titleId }, title),
    h('button.icon-btn.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, icon('x', 16)),
  );
  const content = h('div.dialog-body', body);
  const footer = h('div.dialog-actions');
  // One action at a time: a second click or Enter while an action is still
  // working (copying a page, publishing a link) must not run it again.
  let busy = false;
  for (const a of actions) {
    const btn = h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, { type: a.primary ? 'submit' : 'button', disabled: a.disabled }, a.label);
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      let result;
      try {
        result = await a.run?.(btn);
      } finally {
        busy = false;
      }
      if (result === false) return;
      // A function result runs once the dialog is closed, when the page is
      // no longer inert and the caret can be restored.
      if (typeof result === 'function') {
        close(true);
        result();
      } else close(result ?? a.value ?? true);
    });
    a.el = btn;
    footer.append(btn);
  }
  const form = h('form.dialog-form', { method: 'dialog', novalidate: true }, header, content, actions.length ? footer : null);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const primary = actions.find((a) => a.primary);
    if (primary && !primary.el.disabled) primary.el.click();
  });
  dialog.append(form);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close(null);
  });
  // Close on a backdrop click only when the press also started there, so
  // a text selection dragged out of a field doesn't dismiss the dialog.
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && downOnBackdrop) close(null);
    downOnBackdrop = false;
  });
  document.body.append(dialog);
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');
  const focusTarget = initialFocus || content.querySelector('[autofocus], input, select, textarea') || footer.querySelector('.primary') || dialog.querySelector('.dialog-close');
  focusTarget?.focus();
  if (focusTarget?.select && focusTarget.type === 'text') focusTarget.select();
  return { dialog, close, body: content };
}

/** Asks for a line of text. Resolves to the string or null. */
export function promptText({ title, label, value = '', placeholder = '', okLabel = 'OK', validate } = {}) {
  return new Promise((resolve) => {
    const id = `f-${Math.random().toString(36).slice(2, 8)}`;
    const input = h('input.input', { id, type: 'text', value, placeholder, autocomplete: 'off', spellcheck: 'false' });
    const error = h('p.field-error', { role: 'alert' });
    let done = false;
    openDialog({
      title,
      body: h('div.field', h('label.field-label', { for: id }, label), input, error),
      actions: [
        { label: 'Cancel', run: () => {} },
        {
          label: okLabel,
          primary: true,
          run: () => {
            const v = input.value.trim();
            const problem = validate?.(v) || (!v ? 'Enter a name.' : '');
            if (problem) {
              error.textContent = problem;
              input.setAttribute('aria-invalid', 'true');
              input.focus();
              return false;
            }
            done = true;
            resolve(v);
            return true;
          },
        },
      ],
      onClose: () => {
        if (!done) resolve(null);
      },
    });
  });
}

/** Yes/no confirmation. Resolves true when confirmed. */
export function confirmDialog({ title, message, okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openDialog({
      title,
      body: h('p.dialog-message', message),
      actions: [
        { label: 'Cancel', run: () => {} },
        { label: okLabel, primary: true, danger, run: () => (ok = true) },
      ],
      onClose: () => resolve(ok),
    });
  });
}
