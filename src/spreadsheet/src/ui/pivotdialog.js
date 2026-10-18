/**
 * Pivot table dialog: pick the source range, the field for the rows, an
 * optional field for the columns, and the value to summarize. The table is
 * written to a new sheet as live formulas.
 */

import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { buildPivot, previewPivot, pivotFields, pivotFieldValues, pivotAllLabel, pivotRangeProblem, PivotSizeError, PIVOT_AGGS } from '../core/pivot.js';
import { formatValue, dateTimeKind } from '../core/format.js';
import { rangeName } from '../core/cell.js';
import * as S from '../core/selection.js';

/** Write a built pivot table to a new sheet named after its source, as one undo step; returns the new sheet's name. */
export function insertPivotSheet(wb, sheetId, built) {
  const base = `Pivot of ${wb.sheet(sheetId).name}`;
  const withSuffix = (suffix) => base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
  let name = withSuffix('');
  let k = 2;
  while (wb.sheetByName(name)) name = withSuffix(` ${k++}`);
  wb.transaction('Insert pivot table', () => {
    const sheet = wb.addSheet(name);
    wb.setCells(sheet.id, built.cells, 'Insert pivot table');
    built.widths.forEach((w, c) => wb.setColWidth(sheet.id, c, w));
    for (let c = 1; c < built.cols; c++) wb.setColWidth(sheet.id, c, 110);
    for (const fc of built.filterCells) {
      wb.addValidation(sheet.id, { range: { r1: fc.r, c1: fc.c, r2: fc.r, c2: fc.c }, type: 'list', source: fc.values, strict: false, allowBlank: true, prompt: `Pick a value to filter the table, or ${fc.values[0]}` });
    }
    wb.setFrozen(sheet.id, built.headerRow + 1, 0);
  });
  toast(`Pivot table added on ${name}`, { icon: 'check' });
  return name;
}

export function openPivotDialog(ctx) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const initial = ctx.dataRange ? ctx.dataRange(ctx.range()) : S.isSingle(ctx.selection()) ? (wb.usedRange(sheetId) || ctx.range()) : ctx.range();

  const rangeInput = el('input.input', { type: 'text', value: rangeName(initial), 'aria-label': 'Source range', spellcheck: false, autocomplete: 'off' });
  const rowsSel = el('select.select', { 'aria-label': 'Rows' });
  const colsSel = el('select.select', { 'aria-label': 'Columns' });
  const valuesSel = el('select.select', { 'aria-label': 'Values' });
  const aggSel = el('select.select', { 'aria-label': 'Summarize by' }, PIVOT_AGGS.map(([key, label]) => el('option', { value: key }, label)));
  const filterSel = el('select.select', { 'aria-label': 'Filter by' });
  const filterValueSel = el('select.select', { 'aria-label': 'Showing' });
  let filterValues = [];
  let filterColumn = null;
  // A refusal names the field it is about; a table too large to write names none.
  const { alert: error, refuse, clear: clearError } = fieldAlert('pivot');
  const summary = el('p.field-hint');

  let fields = [];
  function loadFields() {
    // A1:D20, a named range, or a table name / Table[Column]; the source must be on this sheet.
    const parsed = wb.rangeFromText(sheetId, rangeInput.value.trim());
    const range = parsed && parsed.sheetId === sheetId ? parsed.range : null;
    const problem = parsed && parsed.sheetId !== sheetId ? 'The source must be on this sheet' : pivotRangeProblem(wb, sheetId, range);
    // Judged as it is typed: a problem marks the range field without taking the focus from it.
    if (problem) refuse(rangeInput, problem, { focus: false }); else clearError();
    if (problem) { fields = []; return null; }
    fields = pivotFields(wb, sheetId, range);
    const hadValueField = fields.some((f) => String(f.index) === valuesSel.value);
    const keep = (sel) => { const v = sel.value; return () => { if ([...sel.options].some((o) => o.value === v)) sel.value = v; }; };
    const restore = [keep(rowsSel), keep(colsSel), keep(valuesSel), keep(filterSel)];
    rowsSel.replaceChildren(...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    colsSel.replaceChildren(el('option', { value: '' }, 'None'), ...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    valuesSel.replaceChildren(...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    filterSel.replaceChildren(el('option', { value: '' }, 'None'), ...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    restore.forEach((fn) => fn());
    // The values the filter can show: "(All)" plus the field's distinct values.
    const wanted = filterValueSel.value === '' ? null : filterValues[Number(filterValueSel.value)];
    const nextColumn = filterSel.value === '' ? null : range.c1 + Number(filterSel.value);
    // Each number's format comes back in `styles`, so a date field lists dates; a number without one reads as General.
    const styles = new Map();
    filterValues = filterSel.value === '' ? [] : pivotFieldValues(wb, sheetId, range, Number(filterSel.value), styles);
    filterValueSel.replaceChildren(el('option', { value: '' }, pivotAllLabel(filterValues)), ...filterValues.map((v, i) => el('option', { value: String(i) }, typeof v === 'number' ? formatValue(v, styles.get(v)) : String(v))));
    // Option indices can move when the source range changes. Keep the actual
    // category only within the same source column; a new field starts at All.
    const wantedIndex = nextColumn === filterColumn && wanted != null
      ? filterValues.findIndex((v) => typeof v === 'string' && typeof wanted === 'string'
        ? v.toLowerCase() === wanted.toLowerCase() : v === wanted)
      : -1;
    if (wantedIndex >= 0) filterValueSel.value = String(wantedIndex);
    filterColumn = nextColumn;
    filterValueSel.disabled = filterSel.value === '';
    if (!hadValueField) {
      // Guess only initially or when the old field no longer exists.
      // A user may intentionally summarize the field that also groups rows.
      // A date is a number underneath, but one to group by, not to total.
      const numeric = fields.find((f) => {
        const v = wb.getValue(sheetId, range.r1 + 1, f.col);
        return f.index !== Number(rowsSel.value) && typeof v === 'number' && !dateTimeKind(wb.styleAt(sheetId, range.r1 + 1, f.col), v);
      });
      valuesSel.value = String((numeric || fields[fields.length - 1]).index);
    }
    return range;
  }

  function build(spec, preview = false) {
    try { return (preview ? previewPivot : buildPivot)(wb, sheetId, spec); }
    catch (cause) {
      if (!(cause instanceof PivotSizeError)) throw cause;
      refuse(null, cause.message);
      return null;
    }
  }

  function refresh() {
    const range = loadFields();
    if (!range) { summary.textContent = ''; return; }
    const spec = currentSpec(range);
    const built = build(spec, true);
    if (!built) { summary.textContent = ''; return; }
    const filterNote = spec.filters.length ? `, filtered by ${fields[spec.filters[0].field].label} (a dropdown above the table picks the value)` : '';
    summary.textContent = `${built.rowCount} row${built.rowCount === 1 ? '' : 's'}${spec.colField != null ? ` × ${built.colCount} column${built.colCount === 1 ? '' : 's'}` : ''}, ${PIVOT_AGGS.find((a) => a[0] === spec.agg)[1].toLowerCase()} of ${fields[spec.valueField].label}${filterNote}. The table is written to a new sheet as formulas that follow your data.`;
  }

  function currentSpec(range) {
    return {
      range,
      rowField: Number(rowsSel.value),
      colField: colsSel.value === '' ? null : Number(colsSel.value),
      valueField: Number(valuesSel.value),
      agg: aggSel.value,
      filters: filterSel.value === '' ? [] : [{ field: Number(filterSel.value), value: filterValueSel.value === '' ? null : filterValues[Number(filterValueSel.value)] ?? null }],
    };
  }

  rangeInput.addEventListener('input', refresh);
  for (const sel of [rowsSel, colsSel, valuesSel, aggSel, filterSel, filterValueSel]) sel.addEventListener('change', refresh);

  const submit = (e) => {
    e?.preventDefault();
    const range = loadFields();
    if (!range) { rangeInput.focus(); return; }
    const spec = currentSpec(range);
    if (spec.colField === spec.rowField) return refuse(colsSel, 'Rows and columns must be different fields');
    if (spec.filters.length && (spec.filters[0].field === spec.rowField || spec.filters[0].field === spec.colField)) return refuse(filterSel, 'The filter must be a field other than the rows and columns');
    const built = build(spec);
    if (!built) return;
    if (!built.rowCount) return refuse(rowsSel, 'The rows field has no values to group by');
    insertPivotSheet(wb, sheetId, built);
    modal.close();
    ctx.grid.focus();
  };

  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Data range (first row holds the field names)'), rangeInput, error),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Rows'), rowsSel),
      el('label.field', {}, el('span.field-label', {}, 'Columns'), colsSel)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Values'), valuesSel),
      el('label.field', {}, el('span.field-label', {}, 'Summarize by'), aggSel)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, 'Filter by'), filterSel),
      el('label.field', {}, el('span.field-label', {}, 'Showing'), filterValueSel)),
    summary,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Insert on a new sheet')));
  const modal = openModal({ title: 'Pivot table', content, onClose: () => ctx.grid.focus() });
  refresh();
  return modal;
}
