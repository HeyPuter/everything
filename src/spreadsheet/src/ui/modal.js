import { isComposing, el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { isMenuOpen, closeMenu } from './menu.js';
import { t } from '../i18n/index.js';

const openDialogs = new Set();

export function closeAllModals() {
  for (const close of [...openDialogs]) close();
}

/**
 * Bottom sheet on phones, centered dialog on larger screens.
 * openModal({ title, content, onClose, wide, initialFocus, className }) → { close, panel }
 * `initialFocus` is the control to start on instead of the first one a Tab would reach.
 * `className` marks the panel for a dialog laid out in a way of its own (About). On a
 * phone neither is focused: the soft keyboard would open over the bottom sheet and hide the form.
 */
export function openModal({ title, content, onClose, wide = false, initialFocus = null, className = '' }) {
  // A dialog that opens by itself (a save conflict, say) must not leave a menu open over it: menus sit above
  // dialogs, so its items stayed live on the sheet behind, and the dialog left Escape and Tab to the menu.
  closeMenu();
  const panel = el('div.modal-panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: -1 });
  if (wide) panel.classList.add('wide');
  if (className) panel.classList.add(className);
  const rootNode = el('div.modal-root', {},
    el('div.modal-scrim', { onclick: () => close() }),
    panel);

  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const appEl = document.getElementById('app');

  panel.append(
    el('div.sheet-handle'),
    el('div.modal-head', {},
      el('h2.modal-title', {}, title),
      el('button.icon-btn', { type: 'button', html: icon('x', 20), 'aria-label': t('common.close'), onclick: () => close() })),
    content);
  // A dialog that opens with a message, such as a confirmation or a warning, is described by it: a screen
  // reader then reads the question with the title, not the title and the focused button alone.
  const message = content instanceof Element ? content.querySelector(':scope > .modal-text') : null;
  if (message) {
    if (!message.id) message.id = fieldId('modal-text');
    panel.setAttribute('aria-describedby', message.id);
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openDialogs.delete(close);
    rootNode.classList.add('closing');
    rootNode.setAttribute('inert', '');
    const stack = document.querySelectorAll('.modal-root:not(.closing)');
    stack[stack.length - 1]?.removeAttribute('inert');
    document.removeEventListener('keydown', onKey, true);
    if (!stack.length) {
      document.body.classList.remove('modal-open');
      appEl?.removeAttribute('inert');
    }
    // Finish the focus handoff now. A delayed focus can interrupt the next
    // dialog, while leaving this panel interactive allows a second submit.
    if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    onClose?.();
    setTimeout(() => rootNode.remove(), 200);
  }

  function onKey(e) {
    if (isComposing(e) || e.defaultPrevented || isMenuOpen()) return;
    if (e.key !== 'Escape' && e.key !== 'Tab') return;
    const open = document.querySelectorAll('.modal-root:not(.closing)');
    if (open[open.length - 1] !== rootNode) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    // Recompute on each Tab: dialogs can reveal fields or disable buttons while open.
    // A <details> heading takes the focus too, and the content of a closed one is not drawn: the list
    // leaves that out, or the last control could be one no Tab can reach.
    const controls = [...panel.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
      .filter((node) => {
        if (node.tabIndex < 0 || node.matches(':disabled') || node.closest('[hidden], [inert]')) return false;
        for (let shut = node.closest('details:not([open])'); shut; shut = shut.parentElement?.closest('details:not([open])')) {
          if (!shut.querySelector(':scope > summary')?.contains(node)) return false;
        }
        if (getComputedStyle(node).visibility === 'hidden') return false;
        for (let ancestor = node; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
          if (getComputedStyle(ancestor).display === 'none') return false;
        }
        return true;
      });
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    // The focus can rest inside the dialog on a node the list does not name, such as a scrolling area the
    // browser lets Tab reach: the browser moves on from it, unless no control of the dialog lies that way.
    const onward = active !== panel && panel.contains(active) && !controls.includes(active)
      && controls.some((node) => active.compareDocumentPosition(node) & (e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING));
    if (!first || !(controls.includes(active) || onward) || active === (e.shiftKey ? first : last)) {
      e.preventDefault();
      (e.shiftKey ? last || panel : first || panel).focus({ preventScroll: true });
    }
  }

  document.addEventListener('keydown', onKey, true);
  openDialogs.add(close);
  document.body.classList.add('modal-open');
  appEl?.setAttribute('inert', '');
  for (const m of document.querySelectorAll('.modal-root:not(.closing)')) m.setAttribute('inert', '');
  document.body.append(rootNode);

  // The named control, else the first a Tab would reach: never a disabled one, nor an unchecked radio kept out of the tab order.
  const focusable = initialFocus || [...panel.querySelectorAll('input, select, textarea, button:not(.icon-btn)')].find((n) => !n.disabled && n.tabIndex >= 0 && !n.hidden && !n.closest('[hidden]'));
  if (focusable && matchMedia('(min-width: 640px)').matches) focusable.focus();
  else panel.focus({ preventScroll: true });

  return { close, panel };
}

/**
 * Puts the focus back into a dialog's list after an action rebuilt its rows,
 * which otherwise drops it to the page: on the row at `index` (the last row
 * when that one is gone), preferring its button marked data-action=`action`,
 * then any enabled action button of the row, or on `fallback` (the form's
 * first field, say) when the list is empty.
 */
export function focusListRow(list, index, action, fallback) {
  const rows = list.querySelectorAll('[role="listitem"]');
  const row = rows[Math.min(index, rows.length - 1)];
  const target = row?.querySelector(`[data-action="${action}"]:not(:disabled)`) || row?.querySelector('[data-action]:not(:disabled)') || fallback;
  target?.focus({ preventScroll: true });
}

/**
 * A form's refusal message and the field it blames. `alert` is the `p.field-error[role=alert]` to put
 * in the form. `refuse(field, message)` shows the message, marks `field` invalid and described by it
 * (so a screen reader hears which of the form's fields is at fault), focuses it unless `focus` is
 * false, and returns false, so a submit handler can `return refuse(…)`; with no field it shows the
 * message alone. The mark and the message go when that field's value next changes, ahead of the
 * field's own listeners, so one that judges its value as it is typed can show its own message again.
 * `clear()` takes them off by hand (a form reset, a rule loaded into the form).
 */
export function fieldAlert(prefix = 'f') {
  const alert = el('p.field-error', { id: fieldId(prefix), hidden: true, role: 'alert' });
  let marked = null;
  const wired = new WeakSet();
  const clear = () => {
    alert.hidden = true;
    if (!marked) return;
    marked.removeAttribute('aria-invalid');
    if (marked.getAttribute('aria-describedby') === alert.id) marked.removeAttribute('aria-describedby');
    marked = null;
  };
  const unmark = (e) => { if (marked && e.target === marked) clear(); };
  const refuse = (field, message, { focus = true } = {}) => {
    clear();
    alert.textContent = message;
    alert.hidden = false;
    if (!field) return false;
    marked = field;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', alert.id);
    // Heard on the form in the capture phase: the clearing runs before the field's own handlers.
    const scope = field.form || field.closest('form') || field;
    if (!wired.has(scope)) {
      wired.add(scope);
      scope.addEventListener('input', unmark, true);
      scope.addEventListener('change', unmark, true);
    }
    if (focus) field.focus();
    return false;
  };
  return { alert, refuse, clear };
}

/** Confirm dialog. Dismissal defaults to false; callers with two consequential choices can use null. */
export function confirmDialog({ title, message, confirmLabel = t('common.delete'), cancelLabel = t('common.cancel'), danger = true, dismissValue = false }) {
  return new Promise((resolve) => {
    const content = el('div', {},
      el('p.modal-text', {}, message),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => { resolve(false); modal.close(); } }, cancelLabel),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          type: 'button',
          onclick: () => { resolve(true); modal.close(); },
        }, confirmLabel)));
    const modal = openModal({ title, content, onClose: () => resolve(dismissValue) });
  });
}

/**
 * Text prompt. Resolves the trimmed string (unless trim is false), or null when cancelled.
 * `validate(value)` returns an error message or null.
 */
export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = t('common.save'), validate = null, hint = null, trim = true, inputMode = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const errorId = fieldId('prompt');
    // A name in a right-to-left script is laid out that way, its number and full stop at its own end, as a cell is.
    const input = el('input.input', { type: 'text', dir: 'auto', value, placeholder, inputmode: inputMode, 'aria-label': label, autocomplete: 'off', spellcheck: false, 'aria-describedby': errorId });
    const error = el('p.field-error', { id: errorId, hidden: true, role: 'alert' });
    // A changed value is no longer the one refused: the mark and the message go until the next submit.
    input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); });
    const submit = (e) => {
      e?.preventDefault();
      const v = trim ? input.value.trim() : input.value;
      const msg = validate ? validate(v) : (v ? null : t('modal.enterName'));
      if (msg) {
        error.textContent = msg;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      finish(v);
      modal.close();
    };
    const content = el('form', { onsubmit: submit },
      el('label.field', {}, el('span.field-label', {}, label), input, error,
        hint && el('span.field-hint', {}, hint)),
      el('div.row.row-end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
        el('button.btn.btn-primary', { type: 'submit' }, confirmLabel)));
    const modal = openModal({ title, content, initialFocus: input, onClose: () => finish(null) });
    // The value is offered selected, so typing replaces it (where the field took the focus: not on a phone).
    if (document.activeElement === input) input.select();
  });
}
