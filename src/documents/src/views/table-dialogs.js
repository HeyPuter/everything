// Dialogs of the table commands: Insert Table, Convert Text to Table, Convert
// Table to Text, Split Cells, Insert/Delete Cells, Sort, Formula and the style
// editor. Each one collects choices, previews where it helps, and hands them to
// `apply`; a thrown error stays in the dialog so the choice can be corrected.
import { el, fieldId } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';

const field = (label, control, hint) => {
  const id = control.id || (control.id = fieldId('table'));
  return el('div.field', {}, el('label.field-label', { for: id }, label), control, hint && el('span.field-hint', {}, hint));
};
const number = (label, value, { min = 1, max = 32, step = 1 } = {}) => el('input.input', { type: 'number', min, max, step, value, required: true, 'aria-label': label });
const select = (label, options, value) => el('select.input', { 'aria-label': label }, ...options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));
function radios(name, label, options, value, onChange) {
  const group = el('fieldset.table-radios', { 'aria-label': label }, el('legend.field-label', {}, label));
  for (const [v, text, extra] of options) {
    const input = el('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onChange?.(v) });
    group.append(el('label.table-radio', {}, input, el('span', {}, text), extra || null));
  }
  group.value = () => group.querySelector('input:checked')?.value;
  return group;
}

/** A form dialog: `submit` returns false or throws to keep it open with a message. */
export function formDialog({ title, body, submit, onClose, wide = false, ok = 'OK', className = '' }) {
  const error = el('p.field-error', { role: 'alert', hidden: true });
  let modal;
  const form = el('form.table-dialog', { onsubmit: e => {
    e.preventDefault();
    try {
      if (submit() === false) throw new Error('The table could not be changed that way.');
      modal.close();
    } catch (err) { error.textContent = err.message; error.hidden = false; }
  } }, ...body, error,
  el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, ok)));
  modal = openModal({ title, content: form, wide, onClose: () => {
    const root = modal.panel.closest('.modal-root'); root?.setAttribute('inert', ''); root?.setAttribute('aria-hidden', 'true'); onClose?.();
  } });
  if (className) modal.panel.classList.add(className);
  queueMicrotask(() => form.querySelector('input:not([type=radio]):not([type=checkbox]), select, input:checked')?.focus());
  return { modal, form, error };
}

/* ---- Insert Table ---- */

const REMEMBER_KEY = 'documents.insertTable';
export function rememberedTableSize() {
  try { const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); if (saved && saved.rows >= 1 && saved.columns >= 1) return saved; } catch { /* storage may be unavailable */ }
  return null;
}

/** Insert Table: size, AutoFit behavior, and whether to remember them for next time. */
export function openInsertTableDialog(apply, { onClose } = {}) {
  const saved = rememberedTableSize() || { rows: 2, columns: 5, autofit: 'fixed', width: '' };
  const columns = number('Number of columns', saved.columns), rows = number('Number of rows', saved.rows, { max: 500 });
  const width = el('input.input', { type: 'number', min: 0.1, max: 22, step: 0.01, value: saved.width || '', placeholder: 'Auto', 'aria-label': 'Fixed column width (in)' });
  const autofit = radios('table-autofit', 'AutoFit behavior', [['fixed', 'Fixed column width', width], ['contents', 'AutoFit to contents'], ['window', 'AutoFit to window']], saved.autofit || 'fixed', v => { width.disabled = v !== 'fixed'; preview(); });
  width.disabled = (saved.autofit || 'fixed') !== 'fixed';
  const remember = el('input', { type: 'checkbox', checked: !!rememberedTableSize() });
  const sketch = el('div.table-dialog-preview', { 'aria-hidden': 'true' });
  function preview() {
    const c = Math.max(1, Math.min(12, Number(columns.value) || 1)), r = Math.max(1, Math.min(8, Number(rows.value) || 1));
    sketch.style.gridTemplateColumns = `repeat(${c}, 1fr)`;
    sketch.dataset.autofit = autofit.value();
    sketch.replaceChildren(...Array.from({ length: c * r }, () => el('span')));
  }
  columns.addEventListener('input', preview); rows.addEventListener('input', preview); preview();
  return formDialog({ title: 'Insert Table', onClose, className: 'table-insert-dialog', body: [
    el('div.table-dialog-grid', {}, field('Columns', columns), field('Rows', rows)),
    autofit, sketch,
    el('label.table-check', {}, remember, 'Remember these settings for new tables'),
  ], submit: () => {
    const choice = { rows: Number(rows.value), columns: Number(columns.value), autofit: autofit.value(), width: autofit.value() === 'fixed' && width.value ? Number(width.value) : null };
    if (!Number.isInteger(choice.rows) || !Number.isInteger(choice.columns) || choice.rows < 1 || choice.columns < 1 || choice.columns > 32 || choice.rows > 500) throw new Error('Choose 1–32 columns and 1–500 rows.');
    try { if (remember.checked) localStorage.setItem(REMEMBER_KEY, JSON.stringify({ ...choice, width: choice.width ?? '' })); else localStorage.removeItem(REMEMBER_KEY); } catch { /* storage may be unavailable */ }
    return apply(choice);
  } });
}

/* ---- Converting ---- */

function separatorChoice(name, label, value, onChange, paragraphLabel = 'Paragraphs') {
  const other = el('input.input.table-other', { type: 'text', maxLength: 1, value: '-', 'aria-label': 'Other separator', oninput: () => onChange?.() });
  const group = radios(name, label, [['paragraph', paragraphLabel], ['tab', 'Tabs'], ['comma', 'Commas'], ['other', 'Other', other]], value, () => onChange?.());
  return { group, other };
}

/** Convert Text to Table: separator, columns (counted from the text), AutoFit. */
export function openConvertTextDialog({ shape, separator = 'tab' }, apply, { onClose } = {}) {
  const columns = number('Number of columns', 1), rowsText = el('output.table-dialog-count', {});
  let touched = false;
  const update = () => {
    try {
      const s = shape(choice.group.value(), choice.other.value);
      if (!touched) columns.value = s.columns;
      columns.min = choice.group.value() === 'paragraph' ? 1 : s.columns;
      const rows = choice.group.value() === 'paragraph' ? Math.ceil(s.rows / Math.max(1, Number(columns.value) || 1)) : s.rows;
      rowsText.textContent = `${rows} ${rows === 1 ? 'row' : 'rows'}`;
    } catch (e) { rowsText.textContent = e.message; }
  };
  const choice = separatorChoice('table-separator', 'Separate text at', separator, () => { touched = false; update(); });
  columns.addEventListener('input', () => { touched = true; update(); });
  const autofit = radios('convert-autofit', 'AutoFit behavior', [['fixed', 'Fixed column width'], ['contents', 'AutoFit to contents'], ['window', 'AutoFit to window']], 'fixed');
  update();
  return formDialog({ title: 'Convert Text to Table', onClose, body: [
    el('div.table-dialog-grid', {}, field('Columns', columns), el('div.field', {}, el('span.field-label', {}, 'Rows'), rowsText)), choice.group, autofit,
  ], submit: () => apply({ separator: choice.group.value(), other: choice.other.value, columns: Number(columns.value), autofit: autofit.value() }) });
}

/** Convert Table to Text: what separates the cells' text. */
export function openConvertTableDialog(apply, { onClose } = {}) {
  const choice = separatorChoice('table-to-text', 'Separate text with', 'tab', null, 'Paragraph marks');
  return formDialog({ title: 'Convert Table to Text', onClose, body: [choice.group, el('p.field-hint', {}, 'Each row becomes a paragraph; with paragraph marks, each cell keeps its own paragraphs.')],
    submit: () => apply({ separator: choice.group.value(), other: choice.other.value }) });
}

/* ---- Cells ---- */

export function openSplitCellsDialog({ several = false } = {}, apply, { onClose } = {}) {
  const columns = number('Number of columns', 2), rows = number('Number of rows', 1);
  const merge = el('input', { type: 'checkbox', checked: true });
  return formDialog({ title: 'Split Cells', onClose, body: [
    el('div.table-dialog-grid', {}, field('Columns', columns), field('Rows', rows)),
    several && el('label.table-check', {}, merge, 'Merge cells before splitting'),
  ], submit: () => apply({ rows: Number(rows.value), columns: Number(columns.value), merge: !several || merge.checked }) });
}

export function openCellsDialog(kind, apply, { onClose } = {}) {
  const options = kind === 'delete'
    ? [['left', 'Shift cells left'], ['up', 'Shift cells up'], ['row', 'Delete entire row'], ['column', 'Delete entire column']]
    : [['right', 'Shift cells right'], ['down', 'Shift cells down'], ['row', 'Insert entire row'], ['column', 'Insert entire column']];
  const group = radios(`cells-${kind}`, kind === 'delete' ? 'After deleting' : 'After inserting', options, options[kind === 'delete' ? 0 : 1][0]);
  return formDialog({ title: kind === 'delete' ? 'Delete Cells' : 'Insert Cells', onClose, body: [group], submit: () => apply(group.value()) });
}

/* ---- Sort ---- */

/** Sort: up to three keys over the table's columns. `columns`: [{ label, column }]. */
export function openSortDialog({ columns, header }, apply, { onClose } = {}) {
  const keyRow = (index, value) => {
    const by = select(`${index === 0 ? 'Sort by' : 'Then by'} column`, [...(index ? [['', '(none)']] : []), ...columns.map(c => [String(c.column), c.label])], value);
    const type = select(`${index === 0 ? 'Sort by' : 'Then by'} type`, [['text', 'Text'], ['number', 'Number'], ['date', 'Date']], 'text');
    const order = select(`${index === 0 ? 'Sort by' : 'Then by'} order`, [['asc', 'Ascending'], ['desc', 'Descending']], 'asc');
    return { by, type, order, node: el('div.table-sort-key', {}, el('span.field-label', {}, index === 0 ? 'Sort by' : 'Then by'), by, type, order) };
  };
  const keys = [keyRow(0, String(columns[0]?.column ?? 0)), keyRow(1, ''), keyRow(2, '')];
  const hasHeader = radios('sort-header', 'My table has', [['yes', 'A header row'], ['no', 'No header row']], header ? 'yes' : 'no', v => relabel(v === 'yes'));
  const caseSensitive = el('input', { type: 'checkbox' });
  function relabel(on) {
    for (const key of keys) for (const option of key.by.options) {
      const c = columns.find(c => String(c.column) === option.value);
      if (c) option.textContent = on && c.header ? c.header : c.label;
    }
  }
  relabel(header);
  return formDialog({ title: 'Sort', onClose, className: 'table-sort-dialog', body: [...keys.map(k => k.node), hasHeader, el('label.table-check', {}, caseSensitive, 'Case sensitive')],
    submit: () => apply({ header: hasHeader.value() === 'yes', caseSensitive: caseSensitive.checked,
      keys: keys.filter(k => k.by.value !== '').map(k => ({ column: Number(k.by.value), type: k.type.value, descending: k.order.value === 'desc' })) }) });
}

/* ---- Formula ---- */

/** Formula: the expression, a number format and a function to paste, with the result previewed as you type. */
export function openFormulaDialog({ suggested, formats, functions, preview }, apply, { onClose } = {}) {
  const formula = el('input.input.table-formula', { type: 'text', value: suggested, required: true, spellcheck: false, 'aria-label': 'Formula', autocomplete: 'off' });
  const listId = fieldId('formats');
  const format = el('input.input', { type: 'text', 'aria-label': 'Number format', placeholder: 'General', list: listId, spellcheck: false });
  const datalist = el('datalist', { id: listId }, ...formats.map(f => el('option', { value: f })));
  const paste = select('Paste function', [['', 'Paste function…'], ...functions.map(f => [f, f])], '');
  paste.addEventListener('change', () => {
    if (!paste.value) return;
    const at = formula.selectionStart ?? formula.value.length, insert = `${paste.value}()`;
    formula.value = formula.value.slice(0, at) + insert + formula.value.slice(formula.selectionEnd ?? at);
    formula.focus(); formula.setSelectionRange(at + insert.length - 1, at + insert.length - 1);
    paste.value = ''; show();
  });
  const result = el('output.table-formula-result', { 'aria-live': 'polite' });
  function show() {
    try { result.textContent = `Result: ${preview(formula.value, format.value)}`; result.classList.remove('is-error'); }
    catch (e) { result.textContent = e.message; result.classList.add('is-error'); }
  }
  formula.addEventListener('input', show); format.addEventListener('input', show); show();
  return formDialog({ title: 'Formula', onClose, className: 'table-formula-dialog', body: [
    field('Formula', formula, 'Directions: ABOVE, BELOW, LEFT, RIGHT. Cells: A1, B2:C4.'), result,
    el('div.table-dialog-grid', {}, field('Number format', format), field('Function', paste)), datalist,
  ], submit: () => apply(formula.value, format.value.trim() || null) });
}
