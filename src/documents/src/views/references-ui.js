/**
 * Shared building blocks for the References dialogs: labelled fields, check boxes, selects, a
 * dialog shell with an error line and OK/Cancel, tabs, and gallery tiles for ribbon menus. They
 * use the app's own form classes so every References dialog looks and behaves alike.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { closeMenu } from '../ui/menu.js';
import { revealInvalidControls } from './format-dialog-kit.js';

let uid = 0;
export const nextId = prefix => `${prefix}-${++uid}`;

/** A labelled control; `hint` adds a line of help below it. */
export const field = (label, control, hint = null) => el('label.field.ref-field', {}, el('span.field-label', {}, label), control, hint && el('span.field-hint', {}, hint));

/** A check box with its label. Returns the label node; the input is `node.box`. */
export function check(label, checked = false, onchange = null, attrs = {}) {
  const box = el('input', { type: 'checkbox', checked: !!checked, ...attrs, onchange: () => onchange?.(box.checked) });
  const node = el('label.ed-check.ref-check', {}, box, el('span', {}, label));
  node.box = box;
  return node;
}

/** A select of [value, label] pairs. */
export function select(label, options, value = null, onchange = null) {
  const node = el('select.input', { 'aria-label': label, onchange: () => onchange?.(node.value) },
    ...options.map(([v, text, extra = {}]) => el('option', { value: v, ...extra }, text)));
  if (value !== null && value !== undefined) node.value = String(value);
  return node;
}

/** A number input with bounds. */
export const number = (label, value, { min = 0, max = 9999, step = 1, oninput = null } = {}) =>
  el('input.input', { type: 'number', min, max, step, value, 'aria-label': label, oninput });

/** A text input. */
export const text = (label, value = '', attrs = {}) => el('input.input', { type: 'text', value, 'aria-label': label, autocomplete: 'off', ...attrs });

/** A group of fields under a small heading. */
export const section = (legend, ...children) => el('fieldset.ref-section', {}, el('legend', {}, legend), ...children);

/**
 * A dialog with a form, an error line and Cancel/OK. `onSubmit` may return false (or throw) to keep it
 * open; thrown errors show in the error line. `actions` adds buttons on the left of Cancel.
 */
export function openDialog({ title, body, submitLabel = 'OK', onSubmit, wide = false, className = '', actions = [], onClose = null, cancelLabel = 'Cancel' }) {
  const error = el('p.field-error.ref-error', { role: 'alert', hidden: true });
  const submit = el('button.btn.btn-primary', { type: 'submit' }, submitLabel);
  let modal, busy = false, closed = false;
  const form = el(`form.ed-dialog-body.ref-dialog${className ? `.${className}` : ''}`, { onsubmit: async e => {
    e.preventDefault();
    // A second Enter while the first submission is still working must not apply it twice.
    if (busy || closed || !form.reportValidity()) return;
    error.hidden = true; busy = true; submit.disabled = true;
    try {
      const result = await onSubmit?.();
      if (result === false) return;
      closed = true;
      modal.close();
    } catch (failure) { error.textContent = failure?.message || String(failure); error.hidden = false; }
    finally { busy = false; if (!closed) submit.disabled = false; }
  } }, ...body, error,
  el('div.row.row-end.ref-actions', {}, ...actions, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, cancelLabel), submit));
  revealInvalidControls(form);
  modal = openModal({ title, content: form, wide, onClose: () => { closed = true; onClose?.(); } });
  const showError = message => { error.textContent = message; error.hidden = !message; };
  return { modal, form, submit, showError, close: () => modal.close() };
}

/** Tabs over panels: [{ id, label, panel }]. Returns { node, show }. */
export function tabs(list, label) {
  const buttons = list.map(({ id, label: name, panel }, i) => {
    panel.id ||= nextId(`ref-panel-${id}`);
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = i > 0;
    return el('button.ed-font-tab', { type: 'button', role: 'tab', 'aria-controls': panel.id, 'aria-selected': String(!i), tabindex: i ? -1 : 0,
      onclick: () => show(id), onkeydown: e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const next = (i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length;
        show(list[next].id); buttons[next].focus();
      } }, name);
  });
  function show(id) {
    list.forEach((tab, i) => { const on = tab.id === id; tab.panel.hidden = !on; buttons[i].setAttribute('aria-selected', String(on)); buttons[i].tabIndex = on ? 0 : -1; });
  }
  return { node: el('div.ed-font-tabs', { role: 'tablist', 'aria-label': label }, ...buttons), show };
}

/**
 * A gallery tile for a ribbon menu: a small preview over its name. Chosen with a click or Enter
 * like a menu item; the menu closes first and focus returns to the document.
 */
export function galleryItem({ label, description = '', preview, onSelect, disabled = false, focusEditor = null }) {
  const button = el('button.menu-item.ref-gallery-item', { type: 'button', role: 'menuitem', tabindex: -1, disabled,
    'aria-label': description ? `${label}: ${description}` : label,
    onclick: () => { if (disabled) return; closeMenu(); focusEditor?.(); onSelect(); } },
  el('span.ref-gallery-preview', { 'aria-hidden': 'true' }, preview), el('span.ref-gallery-label', {}, label));
  return { custom: button };
}

/** A small paper preview of table rows: [{ text, page, level, bold }] with a leader. */
export function tablePreview(rows, { title = '', leader = 'dot', rightAlign = true, pageNumbers = true } = {}) {
  const leaderText = { dot: '.', hyphen: '-', underscore: '_', middleDot: '·', none: ' ' }[leader] || ' ';
  return el('div.ref-preview-paper', {},
    title && el('div.ref-preview-title', {}, title),
    ...rows.map(row => el('div.ref-preview-row', { style: { paddingLeft: `${(row.level - 1) * 12}px`, fontWeight: row.bold ? '600' : '' } },
      el('span.ref-preview-text', {}, row.text),
      pageNumbers && row.page !== undefined && rightAlign && el('span.ref-preview-leader', { 'data-leader': leaderText }),
      pageNumbers && row.page !== undefined && el('span.ref-preview-page', {}, rightAlign ? String(row.page) : ` ${row.page}`))));
}

/**
 * A modeless panel that floats over the document, for dialogs used while editing (Mark Entry,
 * Mark Citation): the document stays usable behind it. Escape closes it.
 */
export function openPanel({ title, body, actions = [], onClose = null, className = '' }) {
  document.querySelector(`.ref-panel[data-title="${CSS.escape(title)}"]`)?.closePanel?.();
  const heading = el('h2.ref-panel-title', { id: nextId('ref-panel-title') }, title);
  const close = () => { node.remove(); onClose?.(); };
  const node = el(`div.ref-panel${className ? `.${className}` : ''}`, { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': heading.id, dataset: { title },
    onkeydown: e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } } },
  el('div.ref-panel-head', {}, heading, el('button.icon-btn.ref-panel-close', { type: 'button', 'aria-label': `Close ${title}`, onclick: close }, '×')),
  el('div.ref-panel-body', {}, ...body),
  el('div.row.row-end.ref-actions', {}, ...actions));
  node.closePanel = close;
  document.body.append(node);
  (node.querySelector('input, select, button:not(.ref-panel-close)') || node).focus();
  return { node, close };
}
