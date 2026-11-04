/**
 * Pivot table dialog: pick the source range, the field for the rows, an
 * optional field for the columns, and the value to summarize. The table is
 * written to a new sheet as live formulas.
 */

import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { buildPivot, previewPivot, pivotFields, pivotFieldValues, pivotAllLabel, pivotRangeProblemShown, writePivotSheet, PivotSizeError, PIVOT_AGGS } from '../core/pivot.js';
import { formatValue, dateTimeKind } from '../core/format.js';
import { rangeName } from '../core/cell.js';
import * as S from '../core/selection.js';
import { t } from '../i18n/index.js';

/** How the dialog names each way to summarize (PIVOT_AGGS's own labels are the ones written into the table). */
const AGG_LABELS = { sum: 'pivotdialog.agg.sum', count: 'pivotdialog.agg.count', average: 'pivotdialog.agg.average', max: 'pivotdialog.agg.max', min: 'pivotdialog.agg.min' };

/**
 * Write a built pivot table to a new sheet named after its source, as one undo step; returns the new sheet's name,
 * or null when no sheet could be added (Protect Workbook locks the structure, and the workbook says so itself).
 */
export function insertPivotSheet(wb, sheetId, built) {
  const sheet = writePivotSheet(wb, sheetId, built);
  if (!sheet) return null;
  toast(t('pivotdialog.added', { sheet: sheet.name }), { icon: 'check' });
  return sheet.name;
}

export function openPivotDialog(ctx) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return;
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const initial = ctx.dataRange ? ctx.dataRange(ctx.range()) : S.isSingle(ctx.selection()) ? (wb.usedRange(sheetId) || ctx.range()) : ctx.range();

  const rangeInput = el('input.input', { type: 'text', value: rangeName(initial), 'aria-label': t('pivotdialog.sourceRange'), spellcheck: false, autocomplete: 'off' });
  const rowsSel = el('select.select', { 'aria-label': t('pivotdialog.rows') });
  const colsSel = el('select.select', { 'aria-label': t('pivotdialog.columns') });
  const valuesSel = el('select.select', { 'aria-label': t('pivotdialog.values') });
  const aggSel = el('select.select', { 'aria-label': t('pivotdialog.summarizeBy') }, PIVOT_AGGS.map(([key]) => el('option', { value: key }, t(AGG_LABELS[key]))));
  const filterSel = el('select.select', { 'aria-label': t('pivotdialog.filterBy') });
  const filterValueSel = el('select.select', { 'aria-label': t('pivotdialog.showing') });
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
    const problem = parsed && parsed.sheetId !== sheetId ? t('pivotdialog.sameSheet') : pivotRangeProblemShown(wb, sheetId, range);
    // Judged as it is typed: a problem marks the range field without taking the focus from it.
    if (problem) refuse(rangeInput, problem, { focus: false }); else clearError();
    if (problem) { fields = []; return null; }
    fields = pivotFields(wb, sheetId, range);
    const hadValueField = fields.some((f) => String(f.index) === valuesSel.value);
    const keep = (sel) => { const v = sel.value; return () => { if ([...sel.options].some((o) => o.value === v)) sel.value = v; }; };
    const restore = [keep(rowsSel), keep(colsSel), keep(valuesSel), keep(filterSel)];
    rowsSel.replaceChildren(...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    colsSel.replaceChildren(el('option', { value: '' }, t('common.none')), ...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    valuesSel.replaceChildren(...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
    filterSel.replaceChildren(el('option', { value: '' }, t('common.none')), ...fields.map((f) => el('option', { value: String(f.index) }, f.label)));
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
      refuse(null, cause.shown);
      return null;
    }
  }

  function refresh() {
    const range = loadFields();
    if (!range) { summary.textContent = ''; return; }
    const spec = currentSpec(range);
    const built = build(spec, true);
    if (!built) { summary.textContent = ''; return; }
    summary.textContent = t('pivotdialog.summary', {
      shape: spec.colField != null ? 'grid' : 'list', rows: built.rowCount, cols: built.colCount, agg: spec.agg, field: fields[spec.valueField].label,
      filtered: spec.filters.length ? 'yes' : 'no', filterField: spec.filters.length ? fields[spec.filters[0].field].label : '',
    });
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
    if (spec.colField === spec.rowField) return refuse(colsSel, t('pivotdialog.errors.sameField'));
    if (spec.filters.length && (spec.filters[0].field === spec.rowField || spec.filters[0].field === spec.colField)) return refuse(filterSel, t('pivotdialog.errors.filterField'));
    const built = build(spec);
    if (!built) return;
    if (!built.rowCount) return refuse(rowsSel, t('pivot.refresh.noRows'));
    if (!insertPivotSheet(wb, sheetId, built)) return;
    modal.close();
    ctx.grid.focus();
  };

  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('pivotdialog.dataRange')), rangeInput, error),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('pivotdialog.rows')), rowsSel),
      el('label.field', {}, el('span.field-label', {}, t('pivotdialog.columns')), colsSel)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('pivotdialog.values')), valuesSel),
      el('label.field', {}, el('span.field-label', {}, t('pivotdialog.summarizeBy')), aggSel)),
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('pivotdialog.filterBy')), filterSel),
      el('label.field', {}, el('span.field-label', {}, t('pivotdialog.showing')), filterValueSel)),
    summary,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('pivotdialog.insert'))));
  const modal = openModal({ title: t('pivotdialog.title'), content, onClose: () => ctx.grid.focus() });
  refresh();
  return modal;
}
