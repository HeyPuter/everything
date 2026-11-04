/**
 * Fill series dialog: from the first cell of the selection, write a linear,
 * growth, or date series down or across, to the end of the selection or
 * until a stop value.
 */

import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { dateTimeKind, parseInput } from '../core/format.js';
import * as S from '../core/selection.js';
import { fillSeriesLines } from '../core/autofill-options.js';
import { MAX_ROW, MAX_COL } from '../core/refs.js';
import { t } from '../i18n/index.js';

/** As far as one cell's series runs to its stop value (Workbook.fillSeries). */
const STOP_REACH = 10000;

/**
 * Whole columns (or rows) as far as the sheet's content goes, as Fill Down takes them: a series into all
 * 1,048,576 rows wrote a million numbers, and over two minutes of them for a sheet selected whole. A stop
 * value carries each line past the content as far as it would carry one cell's series.
 */
function toUsedExtent(wb, sheetId, range, direction, stop) {
  if (range.r2 < MAX_ROW && range.c2 < MAX_COL) return range;
  const used = wb.usedRange(sheetId);
  const r2 = range.r2 < MAX_ROW ? range.r2
    : Math.min(range.r2, Math.max(range.r1, used?.r2 ?? range.r1, direction === 'down' && stop != null ? range.r1 + STOP_REACH : range.r1));
  const c2 = range.c2 < MAX_COL ? range.c2
    : Math.min(range.c2, Math.max(range.c1, used?.c2 ?? range.c1, direction === 'right' && stop != null ? range.c1 + STOP_REACH : range.c1));
  return { ...range, r2, c2 };
}

export function openSeriesDialog(ctx) {
  const sheetId = ctx.sheetId();
  const range = ctx.range();
  const single = range.r1 === range.r2 && range.c1 === range.c2;
  const first = ctx.wb.getValue(sheetId, range.r1, range.c1);
  const startIsDate = ['date', 'datetime'].includes(dateTimeKind(ctx.wb.getCell(sheetId, range.r1, range.c1)?.s, first));
  const dirSelect = el('select.select', { 'aria-label': t('seriesdialog.direction') },
    el('option', { value: 'down', selected: range.r2 > range.r1 || range.c1 === range.c2 }, t('seriesdialog.columns')),
    el('option', { value: 'right', selected: range.r1 === range.r2 && range.c2 > range.c1 }, t('seriesdialog.rows')));
  const typeSelect = el('select.select', { 'aria-label': t('seriesdialog.type') },
    el('option', { value: 'linear', selected: !startIsDate }, t('seriesdialog.linear')),
    el('option', { value: 'growth' }, t('seriesdialog.growth')),
    el('option', { value: 'date', selected: startIsDate }, t('seriesdialog.date')),
    el('option', { value: 'autofill' }, t('seriesdialog.autofill')));
  // Trend: the best-fit line (or growth curve) through the values each row or column starts with, step ignored.
  const trendBox = el('input', { type: 'checkbox', 'aria-label': t('seriesdialog.trend') });
  const trendField = el('label.check', {}, trendBox, el('span', {}, t('seriesdialog.trend')));
  const unitSelect = el('select.select', { 'aria-label': t('seriesdialog.dateUnit') },
    el('option', { value: 'day' }, t('seriesdialog.days')),
    el('option', { value: 'weekday' }, t('seriesdialog.weekdays')),
    el('option', { value: 'month' }, t('seriesdialog.months')),
    el('option', { value: 'year' }, t('seriesdialog.years')));
  const stepInput = el('input.input', { type: 'number', step: 'any', 'aria-label': t('seriesdialog.step'), value: '1' });
  const stopInput = el('input.input', { type: 'number', step: 'any', 'aria-label': t('seriesdialog.stopValue'), autocomplete: 'off' });
  const unitField = el('label.field', { hidden: !startIsDate }, el('span.field-label', {}, t('seriesdialog.unit')), el('div.select-wrap', {}, unitSelect));
  const { alert: error, refuse } = fieldAlert('series'); // a start cell without a number is about the sheet, not a field
  // A date series stops at a date, typed the way a cell takes one; the other series stop at a number.
  const syncStop = () => {
    const dates = typeSelect.value === 'date';
    stopInput.type = dates ? 'text' : 'number';
    if (dates) stopInput.removeAttribute('step'); else stopInput.step = 'any';
    stopInput.placeholder = dates ? (single ? t('seriesdialog.stopDateRequired') : t('seriesdialog.stopDateOptional')) : single ? t('seriesdialog.stopRequired') : t('common.optional');
  };
  syncStop();
  const syncTrend = () => {
    const can = typeSelect.value === 'linear' || typeSelect.value === 'growth';
    trendBox.disabled = !can; if (!can) trendBox.checked = false;
    trendField.classList.toggle('is-disabled', !can);
    // AutoFill and Trend take their steps from the cells.
    const own = typeSelect.value === 'autofill' || trendBox.checked;
    stepInput.disabled = own; stopInput.disabled = own;
  };
  syncTrend();
  trendBox.addEventListener('change', syncTrend);
  typeSelect.addEventListener('change', () => { unitField.hidden = typeSelect.value !== 'date'; syncStop(); syncTrend(); });
  const submit = (e) => {
    e?.preventDefault();
    const own = typeSelect.value === 'autofill' || trendBox.checked;
    if (own) {
      if (single) return refuse(null, t('seriesdialog.selectCells'));
      if (ctx.wb.isProtected(sheetId)) { toast(t('seriesdialog.protected'), { icon: 'lock' }); return; }
      if (ctx.wb.lockedIn(sheetId, range)) { modal.close(); return; }
      const n = fillSeriesLines(ctx.wb, sheetId, toUsedExtent(ctx.wb, sheetId, range, dirSelect.value, null), { type: typeSelect.value, trend: trendBox.checked, direction: dirSelect.value });
      modal.close();
      if (!n) { toast(t('seriesdialog.nothingToFillStart'), { icon: 'info', duration: 3200 }); return; }
      toast(t('seriesdialog.filled', { count: n }), { icon: 'check', duration: 1600 });
      ctx.grid.focus();
      return;
    }
    if (typeof first !== 'number') return refuse(null, t('seriesdialog.needsNumber', { cell: rangeName({ ...range, r2: range.r1, c2: range.c1 }) }));
    const step = Number(stepInput.value);
    if (stepInput.value.trim() === '' || !Number.isFinite(step) || (typeSelect.value === 'growth' && step === 0)) return refuse(stepInput, t('seriesdialog.enterStep'));
    // Only the stop value bounds a single-cell fill, and a series that stands still never reaches it.
    if (single && step === 0) return refuse(stepInput, t('seriesdialog.stepNonZero'));
    if (single && stopInput.value.trim() === '') return refuse(stopInput, t('seriesdialog.enterStop'));
    let stop = null;
    if (stopInput.value.trim() !== '') {
      if (typeSelect.value === 'date') {
        const parsed = parseInput(stopInput.value.trim());
        if (typeof parsed.v !== 'number') return refuse(stopInput, t('seriesdialog.stopAsDate'));
        stop = parsed.v;
      } else stop = Number(stopInput.value);
    }
    if (ctx.wb.isProtected(sheetId)) { toast(t('seriesdialog.protected'), { icon: 'lock' }); return; }
    // A fill refused for protection is explained by the lock message every tool shares, not blamed on the series.
    if (!single && ctx.wb.lockedIn(sheetId, range)) { modal.close(); return; }
    let refused = false;
    const onProtection = ({ detail }) => { if (detail?.type === 'protected' && detail.sheetId === sheetId) refused = true; };
    ctx.wb.addEventListener('change', onProtection);
    let n = 0;
    try {
      // Every row or column of the selection, each from its own first cell.
      n = fillSeriesLines(ctx.wb, sheetId, toUsedExtent(ctx.wb, sheetId, range, dirSelect.value, stop), { type: typeSelect.value, step, stop, unit: unitSelect.value, direction: dirSelect.value });
    } finally { ctx.wb.removeEventListener('change', onProtection); }
    modal.close();
    if (refused) return;
    if (!n) { toast(t('seriesdialog.endsBefore'), { icon: 'info' }); return; }
    if (single) {
      const end = dirSelect.value === 'down' ? { r1: range.r1, c1: range.c1, r2: range.r1 + n, c2: range.c1 } : { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 + n };
      ctx.grid.setSelection(S.fromRange(end, { r: range.r1, c: range.c1 }), { scroll: false });
    }
    toast(t('seriesdialog.filled', { count: n }), { icon: 'check', duration: 1600 });
    ctx.grid.focus();
  };
  const content = el('form', { onsubmit: submit },
    el('p.modal-text', {}, typeof first === 'number'
      ? t('seriesdialog.startsFromValue', { cell: rangeName({ ...range, r2: range.r1, c2: range.c1 }), value: ctx.wb.getDisplay(sheetId, range.r1, range.c1) })
      : t('seriesdialog.startsFrom', { cell: rangeName({ ...range, r2: range.r1, c2: range.c1 }) })),
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, t('seriesdialog.seriesIn')), el('div.select-wrap', {}, dirSelect)),
      el('label.field', {}, el('span.field-label', {}, t('seriesdialog.type')), el('div.select-wrap', {}, typeSelect))),
    unitField,
    trendField,
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, t('seriesdialog.stepValue')), stepInput),
      el('label.field', {}, el('span.field-label', {}, t('seriesdialog.stopValue')), stopInput)),
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('seriesdialog.fill'))));
  // Closing by any route (Cancel, Escape, the scrim) hands focus back to the grid, not the toolbar button.
  const modal = openModal({ title: t('seriesdialog.title'), content, initialFocus: stepInput, onClose: () => ctx.grid.focus() });
  // The suggested step is offered selected, so typing replaces it (where the field took the focus).
  if (document.activeElement === stepInput) stepInput.select();
}
