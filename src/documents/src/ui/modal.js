import { el, isComposing, fieldId } from './dom.js';
import { icon } from './icons.js';

const openDialogs = new Set();
const dialogOpeners = new WeakMap();

export function closeAllModals() {
  for (const close of [...openDialogs]) close();
}

/**
 * Bottom sheet on phones, centered dialog on larger screens.
 * openModal({ title, content, onClose, wide }) -> { close, panel }
 */
export function openModal({ title, content, onClose, wide = false }) {
  const panel = el('div.modal-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: -1 });
  if (wide) panel.classList.add('wide');
  const rootNode = el('div.modal-root', {},
    el('div.modal-scrim', { onclick: () => close() }),
    panel);

  let opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // A prompt can open its next dialog before the previous one's exit animation
  // ends. Follow that dialog's opener instead of retaining a soon-removed input.
  while (opener?.closest('.modal-root.closing')) {
    opener = dialogOpeners.get(opener.closest('.modal-root.closing')) || null;
  }
  dialogOpeners.set(rootNode, opener);
  const appEl = document.getElementById('app');

  panel.append(
    el('div.sheet-handle'),
    el('div.modal-head', {},
      el('h2.modal-title', {}, title),
      el('button.icon-btn', { type: 'button', html: icon('x', 20), 'aria-label': 'Close', onclick: () => close() })),
    content);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openDialogs.delete(close);
    rootNode.classList.add('closing');
    const stack = document.querySelectorAll('.modal-root:not(.closing)');
    stack[stack.length - 1]?.removeAttribute('inert');
    // The page behind is usable again at once. A caller that puts focus back
    // in the document right after closing (Apply in a formatting dialog) must
    // not be ignored while the exit animation plays.
    if (!stack.length) appEl?.removeAttribute('inert');
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    setTimeout(() => {
      // Focus returns to the opener only when nothing else claimed it meanwhile.
      const active = document.activeElement;
      const unclaimed = !active || active === document.body || rootNode.contains(active);
      rootNode.remove();
      if (!document.querySelector('.modal-root')) document.body.classList.remove('modal-open');
      if (unclaimed && opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    }, 200);
  }

  function onKey(e) {
    if (isComposing(e)) return;
    const open = document.querySelectorAll('.modal-root:not(.closing)');
    if (open[open.length - 1] !== rootNode) return;
    // A dialog's popup handles Escape/Tab first and returns focus to its anchor.
    if (e.target.closest?.('[role="menu"]')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // A collapsible section's <summary> takes focus too; left out, Tab from it jumped back to the first control.
    const controls = [...panel.querySelectorAll('a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]')]
      .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden], [inert]')
        && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
    const first = controls[0];
    const last = controls.at(-1);
    const active = document.activeElement;
    if (!first || !controls.includes(active) || (e.shiftKey ? active === first : active === last)) {
      e.preventDefault();
      (e.shiftKey ? last || panel : first || panel).focus();
    }
  }

  document.addEventListener('keydown', onKey, true);
  openDialogs.add(close);
  document.body.classList.add('modal-open');
  appEl?.setAttribute('inert', '');
  for (const m of document.querySelectorAll('.modal-root:not(.closing)')) m.setAttribute('inert', '');
  document.body.append(rootNode);

  if (matchMedia('(width > 640px)').matches) {
    for (const control of panel.querySelectorAll('input, select, textarea, button:not(.icon-btn)')) {
      if (control.matches(':disabled, input[type="hidden"]') || control.closest('[hidden], [inert]')) continue;
      // A group of choices is one control, as it is in a menu: opening on the
      // first option would put the ring on an answer the dialog has not chosen,
      // and Enter there would pick it instead of submitting.
      const group = control.closest('[role="radiogroup"]');
      const target = group?.querySelector('[role="radio"][aria-checked="true"]:not([disabled])') || control;
      target.focus();
      // CSS can also hide a control; only stop once focus actually moved.
      if (document.activeElement === target) break;
    }
  }
  if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

  return { close, panel };
}

/** Confirm dialog. Resolves true/false (false on Escape, scrim, or X). */
export function confirmDialog({ title, message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true }) {
  return new Promise((resolve) => {
    const content = el('div', {},
      el('p.modal-text', {}, message),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, cancelLabel),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          type: 'button',
          onclick: () => { resolve(true); modal.close(); },
        }, confirmLabel)));
    const modal = openModal({ title, content, onClose: () => resolve(false) });
  });
}

/**
 * Text prompt. Resolves the trimmed string, or null when cancelled.
 * `validate(value)` returns an error message or null. `multiline` uses a textarea.
 * Optional `prepare(value, { signal })` runs before closing; rejection keeps the
 * input and displays the error for retry. Closing aborts its signal.
 */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', validate = null, hint = null, type = 'text', multiline = false, prepare = null, pendingLabel = 'Working…' }) {
  return new Promise((resolve) => {
    let done = false, busy = false, controller = null;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const input = el(multiline ? 'textarea.input' : 'input.input', { type: multiline ? null : type, rows: multiline ? 3 : null, value, placeholder, 'aria-label': label, autocomplete: 'off', spellcheck: false });
    const error = el('p.field-error', { hidden: true, role: 'alert', id: fieldId('dialog-error') });
    // The field is named by its label; its hint and its error reach a screen reader as descriptions.
    const hintId = hint ? fieldId('dialog-hint') : null;
    input.setAttribute('aria-describedby', [hintId, error.id].filter(Boolean).join(' '));
    const submit = async (e) => {
      e?.preventDefault();
      if (done || busy) return;
      const v = input.value.trim();
      const msg = validate ? validate(v) : (v ? null : 'Enter a name');
      if (msg) {
        error.textContent = msg;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      if (prepare) {
        busy = true;
        controller = new AbortController();
        input.disabled = confirm.disabled = true;
        confirm.textContent = pendingLabel;
        content.setAttribute('aria-busy', 'true');
        try {
          await prepare(v, { signal: controller.signal });
          if (done) return;
        } catch (e) {
          if (!done) {
            error.textContent = e?.message || 'Could not complete this action. Try again';
            error.hidden = false;
          }
          return;
        } finally {
          busy = false;
          if (!done) {
            input.disabled = confirm.disabled = false;
            confirm.textContent = confirmLabel;
            content.removeAttribute('aria-busy');
            if (!error.hidden) input.focus();
          }
        }
      }
      finish(v);
      modal.close();
    };
    const confirm = el('button.btn.btn-primary', { type: 'submit' }, confirmLabel);
    const content = el('form', { onsubmit: submit },
      el('label.field', {}, el('span.field-label', {}, label), input, error,
        hint && el('span.field-hint', { id: hintId }, hint)),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        confirm));
    const modal = openModal({ title, content, onClose: () => { finish(null); controller?.abort(); } });
    input.focus();
    input.select();
  });
}

/**
 * Multi-field form dialog. `fields`: [{ name, label, value, placeholder, type, hint }].
 * Resolves an object of trimmed values, or null when cancelled. `validate(values)`
 * returns an error message or null. Optional `prepare(values, { signal })`
 * runs before closing; rejection preserves inputs for retry, closing aborts.
 */
export function formDialog({ title, fields, confirmLabel = 'Save', validate = null, extra = null, prepare = null, pendingLabel = 'Working…' }) {
  return new Promise((resolve) => {
    let done = false, busy = false, controller = null;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const inputs = {};
    const error = el('p.field-error', { hidden: true, role: 'alert', id: fieldId('dialog-error') });
    const submit = async (e) => {
      e?.preventDefault();
      if (done || busy) return;
      // An emptied number field is not a zero: it fails the dialog's own check instead of applying as one.
      const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'number' ? (i.value.trim() === '' ? NaN : Number(i.value)) : i.value.trim()]));
      const msg = validate ? validate(values) : null;
      if (msg) {
        error.textContent = msg;
        error.hidden = false;
        for (const input of Object.values(inputs)) input.setAttribute('aria-invalid', 'true');
        return;
      }
      error.hidden = true;
      for (const input of Object.values(inputs)) input.removeAttribute('aria-invalid');
      if (prepare) {
        busy = true;
        controller = new AbortController();
        const controls = [...content.querySelectorAll('input, select, textarea, button')].filter((control) => control !== cancel);
        const disabled = controls.map((control) => control.disabled);
        for (const control of controls) control.disabled = true;
        confirm.textContent = pendingLabel;
        content.setAttribute('aria-busy', 'true');
        try {
          await prepare(values, { signal: controller.signal });
          if (done) return;
        } catch (e) {
          if (!done) { error.textContent = e?.message || 'Could not complete this action. Try again'; error.hidden = false; }
          return;
        } finally {
          busy = false;
          if (!done) {
            controls.forEach((control, i) => { control.disabled = disabled[i]; });
            confirm.textContent = confirmLabel;
            content.removeAttribute('aria-busy');
            if (!error.hidden) (controls.find((control) => !control.disabled) || confirm).focus();
          }
        }
      }
      finish(values);
      modal.close();
    };
    const cancel = el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel');
    const confirm = el('button.btn.btn-primary', { type: 'submit' }, confirmLabel);
    const content = el('form', { onsubmit: submit },
      fields.map((f) => {
        const hintId = f.hint ? fieldId('dialog-hint') : null;
        const input = el('input.input', {
          type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', 'aria-label': f.label,
          // The hint and the shared error message are the field's descriptions.
          'aria-describedby': [hintId, error.id].filter(Boolean).join(' '),
          autocomplete: 'off', spellcheck: false, min: f.min, max: f.max, step: f.type === 'number' ? 'any' : null, inputmode: f.type === 'number' ? 'decimal' : null,
        });
        inputs[f.name] = input;
        return el('label.field', {}, el('span.field-label', {}, f.label), input, f.hint && el('span.field-hint', { id: hintId }, f.hint));
      }),
      error,
      extra,
      el('div.row.row-end', {}, cancel, confirm));
    const modal = openModal({ title, content, onClose: () => { finish(null); controller?.abort(); } });
    const first = Object.values(inputs)[0];
    first?.focus();
    first?.select?.();
  });
}
