import { el, fieldId } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';

/**
 * Shared pieces for the Format dialogs (Paragraph, Tabs, Borders and Shading, Bullets and Numbering,
 * Styles): tab strips, labelled fields, measurements in the ruler's unit and a standard footer. They
 * follow the Font dialog's look, focus handling and Escape behavior (openModal).
 */

export const UNITS = { in: { label: 'in', twips: 1440, step: 0.01, digits: 2 }, cm: { label: 'cm', twips: 1440 / 2.54, step: 0.01, digits: 2 } };

/** A tab strip over panels: [[id, label, panel]]. Arrow keys move between tabs. Returns { node, show }. */
export function tabStrip(label, tabs, { prefix = fieldId('fmt-tab'), onShow = () => {} } = {}) {
  const buttons = tabs.map(([id, text, panel], i) => {
    panel.id ||= `${prefix}-${id}-panel`;
    panel.setAttribute('role', 'tabpanel');
    panel.classList.add('ed-font-panel');
    if (i) panel.hidden = true;
    const button = el('button.ed-font-tab', { type: 'button', role: 'tab', id: `${prefix}-${id}`, 'aria-controls': panel.id, 'aria-selected': String(!i), tabindex: i ? -1 : 0,
      onclick: () => show(id),
      onkeydown: e => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = (i + step + tabs.length) % tabs.length;
        show(tabs[next][0]); buttons[next].focus();
      } }, text);
    panel.setAttribute('aria-labelledby', button.id);
    return button;
  });
  function show(id) {
    tabs.forEach(([tab, , panel], i) => { const on = tab === id; panel.hidden = !on; buttons[i].setAttribute('aria-selected', String(on)); buttons[i].tabIndex = on ? 0 : -1; });
    onShow(id);
  }
  return { node: el('div.ed-font-tabs', { role: 'tablist', 'aria-label': label }, ...buttons), show, buttons };
}

/** A label above a control. */
export const field = (label, control, hint = null) => el('label.ed-font-field', {}, el('span.field-label', {}, label), control, hint && el('span.field-hint', {}, hint));
/** A checkbox with a label; `state` true, false or null (mixed). */
export function checkbox(label, state, onchange = () => {}) {
  const box = el('input', { type: 'checkbox', onchange: () => { box.indeterminate = false; onchange(box.checked); } });
  if (state === null || state === undefined) box.indeterminate = state === null; else box.checked = !!state;
  const node = el('label.ed-check', {}, box, label);
  node.box = box;
  return node;
}
/** A titled group of controls. */
export const group = (title, ...children) => el('fieldset.fmt-group', {}, el('legend', {}, title), ...children);
/** A select from [[value, label]] pairs, with an optional blank "Mixed" choice. */
export function select(label, choices, value, { mixed = false, onchange } = {}) {
  const node = el('select.input', { 'aria-label': label, onchange: () => onchange?.(node.value) },
    ...(mixed ? [el('option', { value: '', disabled: true }, 'Mixed')] : []), ...choices.map(([v, text]) => el('option', { value: v }, text)));
  node.value = value ?? '';
  return node;
}

/**
 * A distance in the ruler's unit, read back in twips. An untouched field returns its original twips
 * exactly; a blank mixed field returns null.
 */
export function distance(label, twips, { unit = 'in', min = -22, max = 22, required = false } = {}) {
  const u = UNITS[unit] || UNITS.in;
  const text = twips == null ? '' : String(Number((twips / u.twips).toFixed(u.digits + 1)));
  const input = el('input.input', { type: 'number', step: 'any', min: min * 1440 / u.twips, max: max * 1440 / u.twips, required, value: text, placeholder: twips == null ? 'Mixed' : '', 'aria-label': `${label} (${u.label})` });
  input.read = () => input.value === text ? twips ?? null : input.value === '' ? null : Math.round(Number(input.value) * u.twips);
  input.changed = () => input.value !== text;
  input.unit = u.label;
  return input;
}
/** A number in points (spacing, sizes). */
export function points(label, value, { min = 0, max = 600, step = 0.5 } = {}) {
  const text = value == null ? '' : String(value);
  const input = el('input.input', { type: 'number', min, max, step, value: text, placeholder: value == null ? 'Mixed' : '', 'aria-label': `${label} (pt)` });
  input.read = () => input.value === '' ? null : Number(input.value);
  input.changed = () => input.value !== text;
  return input;
}

/**
 * Open a Format dialog: a form with an error line and Cancel/OK, plus optional extra footer buttons on
 * the left (Tabs…, Set As Default). submit() returns false or throws to keep the dialog open.
 */
export function openFormatDialog({ title, body, submit, extra = [], okLabel = 'OK', wide = true, className = '', onClose }) {
  const error = el('p.field-error', { role: 'alert', hidden: true });
  let modal;
  const fail = message => { error.textContent = message; error.hidden = false; };
  const form = el('form.ed-dialog-body.fmt-dialog', { onsubmit: async e => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    try {
      const ok = await submit({ fail });
      if (ok === false) { if (error.hidden) fail('These settings cannot be applied here.'); return; }
      modal.close();
    } catch (err) { fail(err?.message || String(err)); }
  } }, ...[body].flat(), error,
  el('div.fmt-footer', {}, el('div.fmt-footer-start', {}, ...extra),
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, okLabel))));
  if (className) form.classList.add(...className.split(' '));
  modal = openModal({ title, content: form, wide, onClose });
  modal.panel.classList.add('fmt-dialog-panel');
  modal.fail = fail;
  modal.form = form;
  return modal;
}

/** A small page-like preview: grey neighbour paragraphs around the sample, styled by `apply(node)`. */
export function paragraphPreview() {
  const before = el('p.fmt-preview-ghost', {}, 'Previous paragraph '.repeat(10).trim());
  const sample = el('p.fmt-preview-sample', {}, 'Sample text '.repeat(36).trim());
  const after = el('p.fmt-preview-ghost', {}, 'Following paragraph '.repeat(10).trim());
  const node = el('div.fmt-preview', { 'aria-hidden': 'true' }, before, sample, after);
  return { node, sample, before, after };
}

/**
 * A color field: a button showing the current color that opens the palette. reset is the palette's first
 * choice ({ value, label, indicator }). Returns the button with .value and .set(value).
 */
export function colorField(label, value, { reset = { value: 'auto', label: 'Automatic', indicator: 'A' }, onchange = () => {} } = {}) {
  const chip = el('span.ed-font-chip'), name = el('span.ed-font-color-name');
  const button = el('button.btn.btn-outline.ed-font-color', { type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', onclick: async () => {
    const { openColorPalette } = await import('../ui/color-palette.js');
    const { TEXT_COLORS } = await import('./text-color.js');
    openColorPalette({ anchor: button, label, value: button.value, choices: TEXT_COLORS, reset, custom: true, customLabel: label.toLowerCase(), onPick: color => { button.set(color); onchange(color); } });
  } }, chip, name);
  button.set = color => {
    button.value = color;
    chip.style.background = color === null ? 'repeating-linear-gradient(45deg, #ccc 0 3px, #fff 3px 6px)' : color === reset.value ? (reset.value === 'auto' && reset.indicator ? '#000' : 'transparent') : color === 'foreground' ? '#000' : `#${color}`;
    chip.classList.toggle('is-none', color === reset.value && !reset.indicator);
    name.textContent = color === null ? 'Mixed' : color === reset.value ? reset.label : color === 'foreground' ? 'Automatic' : `#${color}`;
  };
  button.set(value);
  return button;
}
