import { el, isComposing } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { commandIconEl } from '../ui/ribbon.js';
import { recallUnit } from '../lib/units.js';

const PER_UNIT = { in: 1440, cm: 1440 / 2.54 };
/** Half an inch between columns, the usual default. */
export const COLUMN_SPACE = 720;
export const MAX_COLUMNS = 12;
export const COLUMN_PRESETS = [['one', 'One', 'columnsOne'], ['two', 'Two', 'columnsTwo'], ['three', 'Three', 'columnsThree'], ['left', 'Left', 'columnsLeft'], ['right', 'Right', 'columnsRight']];

/** The section columns a preset describes for a writing width in twips; null for one column. */
export function presetColumns(id, available, space = COLUMN_SPACE) {
  if (id === 'one') return null;
  if (id === 'two' || id === 'three') return { count: id === 'two' ? 2 : 3, space, equalWidth: true, separator: false, entries: [] };
  // Left and Right: two columns, the narrower about a third of the width.
  const narrow = Math.round((available - space) / 3), wide = available - space - narrow;
  const entries = id === 'left' ? [{ width: narrow, space }, { width: wide, space: 0 }] : [{ width: wide, space }, { width: narrow, space: 0 }];
  return { count: 2, space, equalWidth: false, separator: false, entries };
}

/** Which preset the columns match, or null. */
export function columnPreset(columns) {
  const count = columns?.count || 1;
  if (count === 1) return 'one';
  if (columns.equalWidth !== false) return count === 2 ? 'two' : count === 3 ? 'three' : null;
  if (count !== 2) return null;
  const [a, b] = columns.entries.map(e => e.width);
  return Math.abs(a * 2 - b) <= a * 0.25 ? 'left' : Math.abs(b * 2 - a) <= b * 0.25 ? 'right' : null;
}

/** Column widths and spacing in twips, whatever the stored form: [{ width, space }]. */
export function columnEntries(columns, available) {
  const count = columns?.count || 1;
  if (columns && columns.equalWidth === false) return columns.entries.map(e => ({ ...e }));
  const space = columns?.space ?? COLUMN_SPACE;
  const width = Math.round((available - (count - 1) * space) / count);
  return Array.from({ length: count }, (_, i) => ({ width, space: i === count - 1 ? 0 : space }));
}

/**
 * The Columns dialog: presets, the number of columns, each column's width and spacing, a line
 * between them, and where they apply. apply(columns | null, scope) returns false when they cannot fit.
 */
export function openColumns({ columns, available, unit = recallUnit(), scopes = [['document', 'Whole document']], scope: initialScope, apply, onClose }) {
  const per = PER_UNIT[unit] || 1440, step = unit === 'cm' ? 0.01 : 0.01;
  const min = Math.round(per * (unit === 'cm' ? 0.5 : 0.2));
  let count = columns?.count || 1, equal = columns?.equalWidth !== false, entries = columnEntries(columns, available);
  const separator = el('input', { type: 'checkbox', checked: !!columns?.separator, onchange: render });
  const equalBox = el('input', { type: 'checkbox', checked: equal, onchange: () => { equal = equalBox.checked; if (equal) entries = columnEntries({ count, space: entries[0]?.space ?? COLUMN_SPACE, equalWidth: true }, available); render(); } });
  const number = el('input.input', { type: 'number', min: 1, max: MAX_COLUMNS, step: 1, value: count, 'aria-label': 'Number of columns', onchange: () => {
    const next = Math.max(1, Math.min(MAX_COLUMNS, Math.round(Number(number.value)) || 1));
    number.value = next; setCount(next);
  } });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const presets = el('div.ps-presets', { role: 'group', 'aria-label': 'Presets' }, ...COLUMN_PRESETS.map(([id, label, icon]) => el('button.ps-preset', { type: 'button', dataset: { preset: id }, 'aria-pressed': 'false',
    onclick: () => {
      const next = presetColumns(id, available, entries[0]?.space || COLUMN_SPACE);
      count = next?.count || 1; equal = next?.equalWidth !== false; entries = columnEntries(next, available);
      number.value = count; equalBox.checked = equal; render();
    } }, commandIconEl(icon, 32), el('span', {}, label))));
  const table = el('div.ps-columns', { role: 'table', 'aria-label': 'Width and spacing' });
  const sheet = el('div.ps-preview-sheet', { 'aria-hidden': 'true' });
  const scope = el('select.input', { 'aria-label': 'Apply to' }, ...scopes.map(([value, label]) => el('option', { value }, label)));
  scope.value = initialScope && scopes.some(([v]) => v === initialScope) ? initialScope : scopes[0][0];
  const show = twips => String(Number((twips / per).toFixed(2)));
  let fields = [];

  function setCount(next) {
    count = next;
    if (equal || count === 1) { equal = true; equalBox.checked = true; entries = columnEntries({ count, space: entries[0]?.space || COLUMN_SPACE, equalWidth: true }, available); }
    else {
      entries = entries.slice(0, count);
      while (entries.length < count) entries.push({ width: min, space: 0 });
      entries.forEach((e, i) => { if (i < count - 1 && !e.space) e.space = COLUMN_SPACE; if (i === count - 1) e.space = 0; });
      fit(count - 1);
    }
    render();
  }
  /** Keep the columns filling the writing width: the last column (or, editing it, the first) takes up the difference. */
  function fit(changed) {
    const absorb = changed === count - 1 ? 0 : count - 1;
    const used = entries.reduce((sum, e, i) => sum + (i === absorb ? 0 : e.width) + (i < count - 1 ? e.space : 0), 0);
    entries[absorb].width = available - used;
  }
  function edit(index, key, value) {
    if (!Number.isFinite(value) || value < 0) return;
    if (equal) {
      // Equal columns: width and spacing trade against each other across the writing width.
      const space = key === 'space' ? value : count > 1 ? (available - count * value) / (count - 1) : 0;
      entries = columnEntries({ count, space: Math.max(0, Math.round(space)), equalWidth: true }, available);
    } else {
      entries[index][key] = value;
      if (count > 1) fit(index);
    }
    render();
  }
  function result() {
    if (count === 1) return null;
    const space = equal ? entries[0].space : COLUMN_SPACE;
    return equal ? { count, space, equalWidth: true, separator: separator.checked, entries: [] }
      : { count, space, equalWidth: false, separator: separator.checked, entries: entries.map((e, i) => ({ width: Math.round(e.width), space: i === count - 1 ? 0 : Math.round(e.space) })) };
  }
  function problem() {
    if (count > 1 && entries.some(e => e.width < min)) return `Each column must be at least ${show(min)} ${unit} wide. Use fewer columns or less spacing.`;
    return null;
  }
  function render() {
    for (const button of presets.children) button.setAttribute('aria-pressed', String(columnPreset(result()) === button.dataset.preset));
    equalBox.disabled = count === 1;
    // The rows are rebuilt only when the number of columns changes. A change to one field (committed by Tab or a
    // click elsewhere) updates the others in place, so the field the keyboard just moved to is still there.
    if (fields.length !== entries.length) {
      const header = el('div.ps-columns-row.is-head', { role: 'row' }, ...['Column', `Width (${unit})`, `Spacing (${unit})`].map(text => el('span', { role: 'columnheader' }, text)));
      fields = entries.map((entry, i) => ['width', 'space'].map(key => el('input.input', { type: 'number', min: 0, step, 'aria-label': `${key === 'width' ? 'Width' : 'Spacing'} of column ${i + 1} (${unit})`,
        onchange: e => edit(i, key, Math.round(Number(e.target.value) * per)),
        onkeydown: e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); e.target.dispatchEvent(new Event('change')); } } })));
      table.replaceChildren(header, ...fields.map(([width, space], i) => el('div.ps-columns-row', { role: 'row' }, el('span', { role: 'cell' }, `${i + 1}:`),
        el('span', { role: 'cell' }, width), el('span', { role: 'cell' }, space))));
    }
    entries.forEach((entry, i) => {
      const [width, space] = fields[i];
      width.value = show(entry.width); width.disabled = equal && i > 0 || count === 1;
      space.value = show(entry.space); space.disabled = i === count - 1 || equal && i > 0;
    });
    // Preview: the columns on a page, with the line between them.
    const scale = 120 / available;
    let x = 0;
    sheet.replaceChildren(...entries.flatMap((entry, i) => {
      const parts = [el('span.ps-column', { style: { left: `${x * scale}px`, width: `${Math.max(1, entry.width * scale)}px` } })];
      x += entry.width;
      if (i < count - 1) { if (separator.checked) parts.push(el('span.ps-column-line', { style: { left: `${(x + entry.space / 2) * scale}px` } })); x += entry.space; }
      return parts;
    }));
    sheet.style.width = `${available * scale}px`;
    const message = problem();
    error.textContent = message || ''; error.hidden = !message;
  }

  let modal;
  const content = el('form.ed-dialog-body.ps-dialog.ps-columns-dialog', { onsubmit: e => {
    e.preventDefault();
    const message = problem();
    if (message) { error.textContent = message; error.hidden = false; return; }
    const ok = apply(result(), scope.value);
    if (ok === false) { error.textContent = 'These columns cannot be applied here. Try fewer columns or another section.'; error.hidden = false; return; }
    modal.close();
  } },
  el('div.ps-body', {}, el('div.ps-panels', {}, presets,
    el('div.ps-columns-options', {}, el('label.field', {}, el('span.field-label', {}, 'Number of columns'), number),
      el('label.ed-check', {}, separator, 'Line between'), el('label.ed-check', {}, equalBox, 'Equal column width')),
    el('fieldset.ps-group', {}, el('legend', {}, 'Width and spacing'), table)),
  el('div.ps-side', {}, el('span.field-label', {}, 'Preview'), el('div.ps-preview.is-columns', { role: 'img', 'aria-label': 'Columns preview' }, sheet),
    el('label.field', {}, el('span.field-label', {}, 'Apply to'), scope))),
  error,
  el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  render();
  modal = openModal({ title: 'Columns', content, wide: true, onClose });
  number.focus(); number.select();
  return modal;
}
