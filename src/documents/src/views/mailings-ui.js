/**
 * Small building blocks the Mailings dialogs share: a form dialog with an action row, labelled
 * fields, selects and checkboxes, in the app's existing dialog style.
 */
import { el, fieldId } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import '../styles/mailings.css';

/** A labelled control. */
export function field(label, control, hint = null) {
  if (!control.id) control.id = fieldId('mm');
  return el('div.field.mm-field', {}, el('label.field-label', { for: control.id }, label), control, hint ? el('p.field-hint', {}, hint) : null);
}

/** A select of [value, label] pairs. */
export function select(options, value, attrs = {}) {
  const node = el('select.input', attrs, ...options.map(([v, label]) => el('option', { value: v }, label)));
  if (value !== undefined && value !== null) node.value = value;
  return node;
}

/** A text input. */
export const input = (value = '', attrs = {}) => el('input.input', { type: 'text', value, autocomplete: 'off', spellcheck: 'false', ...attrs });
export const textarea = (value = '', attrs = {}) => { const node = el('textarea.input.mm-textarea', { rows: 4, spellcheck: 'false', ...attrs }); node.value = value; return node; };

/** A checkbox with its label. */
export function checkbox(label, checked = false, attrs = {}) {
  const box = el('input', { type: 'checkbox', ...attrs });
  box.checked = checked;
  const node = el('label.check.mm-check', {}, box, el('span', {}, label));
  node.input = box;
  return node;
}

/** Radio buttons: [[value, label]] in a group; .value reads the choice. */
export function radios(name, options, value, onChange = () => {}) {
  const group = el('div.mm-radios', { role: 'radiogroup', 'aria-label': name });
  const id = fieldId('mmr');
  for (const [v, label, hint] of options) {
    const radio = el('input', { type: 'radio', name: id, value: v, onchange: () => onChange(v) });
    radio.checked = v === value;
    group.append(el('label.mm-radio', {}, radio, el('span', {}, el('span.mm-radio-label', {}, label), hint ? el('span.mm-radio-hint', {}, hint) : null)));
  }
  Object.defineProperty(group, 'value', { get: () => group.querySelector('input:checked')?.value ?? null, set: v => { for (const r of group.querySelectorAll('input')) r.checked = r.value === v; } });
  return group;
}

export const button = (label, onclick, className = 'btn-outline', attrs = {}) => el(`button.btn.${className}`, { type: 'button', onclick, ...attrs }, label);

/**
 * A dialog: a form whose submit runs `onSubmit` (return false to keep it open). `actions` are extra
 * buttons placed before Cancel and the submit button. Returns the modal with `.error(message)`.
 */
export function dialog({ title, body, submit = 'OK', onSubmit, actions = [], size = '', cancel = 'Cancel', onClose, focus }) {
  const error = el('p.field-error.mm-error', { role: 'alert', hidden: true });
  const submitButton = submit ? el('button.btn.btn-primary', { type: 'submit' }, submit) : null;
  const form = el('form.mm-dialog-body', { onsubmit: async e => {
    e.preventDefault();
    error.hidden = true;
    try {
      submitButton && (submitButton.disabled = true);
      const result = await onSubmit?.();
      if (result !== false) modal.close();
    } catch (err) { error.textContent = err?.message || String(err); error.hidden = false; }
    finally { if (submitButton) submitButton.disabled = false; }
  } }, ...[body].flat().filter(Boolean), error,
  el('div.row.row-end.mm-actions', {}, ...actions, cancel ? el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, cancel) : null, submitButton));
  const modal = openModal({ title, content: form, wide: !!size, onClose });
  modal.panel.classList.add('mm-dialog');
  if (size) modal.panel.classList.add(`mm-${size}`);
  modal.error = message => { error.textContent = message; error.hidden = !message; };
  modal.form = form; modal.submitButton = submitButton;
  queueMicrotask(() => (focus || form.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea, button'))?.focus());
  return modal;
}

/** Run an action that may fail, reporting the failure through `error`. */
export const guard = (error, action) => async (...args) => { try { return await action(...args); } catch (e) { error(e); } };

/** Escape for HTML text. */
export const html = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Print a standalone HTML page in a hidden frame, on paper of the given size (in inches).
 * Used for envelopes and label sheets printed without opening them as documents.
 */
export function printHtml(body, { width, height, title = 'Print' }) {
  const frame = el('iframe.mm-print-frame', { title, 'aria-hidden': 'true', tabindex: -1 });
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${html(title)}</title><style>@page { size: ${width}in ${height}in; margin: 0; } html, body { margin: 0; padding: 0; } body { font-family: Arial, Helvetica, sans-serif; color: #000; } .sheet { position: relative; width: ${width}in; height: ${height}in; overflow: hidden; page-break-after: always; break-after: page; } .sheet:last-child { page-break-after: auto; break-after: auto; } .block { position: absolute; white-space: pre-wrap; line-height: 1.2; overflow: hidden; }</style></head><body>${body}</body></html>`);
  doc.close();
  const done = () => setTimeout(() => frame.remove(), 1000);
  frame.contentWindow.addEventListener('afterprint', done, { once: true });
  setTimeout(() => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(done, 60000); } }, 50);
  return frame;
}
