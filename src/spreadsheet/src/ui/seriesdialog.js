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

export function openSeriesDialog(ctx) {
  const sheetId = ctx.sheetId();
  const range = ctx.range();
  const single = range.r1 === range.r2 && range.c1 === range.c2;
  const first = ctx.wb.getValue(sheetId, range.r1, range.c1);
  const startIsDate = ['date', 'datetime'].includes(dateTimeKind(ctx.wb.getCell(sheetId, range.r1, range.c1)?.s, first));
  const dirSelect = el('select.select', { 'aria-label': 'Direction' },
    el('option', { value: 'down', selected: range.r2 > range.r1 || range.c1 === range.c2 }, 'Columns'),
    el('option', { value: 'right', selected: range.r1 === range.r2 && range.c2 > range.c1 }, 'Rows'));
  const typeSelect = el('select.select', { 'aria-label': 'Type' },
    el('option', { value: 'linear', selected: !startIsDate }, 'Linear (add the step)'),
    el('option', { value: 'growth' }, 'Growth (multiply by the step)'),
    el('option', { value: 'date', selected: startIsDate }, 'Date'),
    el('option', { value: 'autofill' }, 'AutoFill (as the fill handle)'));
  // Trend: the best-fit line (or growth curve) through the values each row or column starts with, step ignored.
  const trendBox = el('input', { type: 'checkbox', 'aria-label': 'Trend' });
  const trendField = el('label.check', {}, trendBox, el('span', {}, 'Trend'));
  const unitSelect = el('select.select', { 'aria-label': 'Date unit' },
    el('option', { value: 'day' }, 'Days'),
    el('option', { value: 'weekday' }, 'Weekdays'),
    el('option', { value: 'month' }, 'Months'),
    el('option', { value: 'year' }, 'Years'));
  const stepInput = el('input.input', { type: 'number', step: 'any', 'aria-label': 'Step', value: '1' });
  const stopInput = el('input.input', { type: 'number', step: 'any', 'aria-label': 'Stop value', autocomplete: 'off' });
  const unitField = el('label.field', { hidden: !startIsDate }, el('span.field-label', {}, 'Unit'), el('div.select-wrap', {}, unitSelect));
  const { alert: error, refuse } = fieldAlert('series'); // a start cell without a number is about the sheet, not a field
  // A date series stops at a date, typed the way a cell takes one; the other series stop at a number.
  const syncStop = () => {
    const dates = typeSelect.value === 'date';
    stopInput.type = dates ? 'text' : 'number';
    if (dates) stopInput.removeAttribute('step'); else stopInput.step = 'any';
    stopInput.placeholder = dates ? `${single ? 'Required' : 'Optional'}: a date like 2024-12-31` : single ? 'Required for a single cell' : 'Optional';
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
      if (single) return refuse(null, 'Select the cells to fill, starting with the values to continue');
      if (ctx.wb.isProtected(sheetId)) { toast('This sheet is protected. Unprotect it to fill a series', { icon: 'lock' }); return; }
      if (ctx.wb.lockedIn(sheetId, range)) { modal.close(); return; }
      const n = fillSeriesLines(ctx.wb, sheetId, range, { type: typeSelect.value, trend: trendBox.checked, direction: dirSelect.value });
      modal.close();
      if (!n) { toast('Nothing to fill: start each row or column with values to continue, followed by empty cells', { icon: 'info', duration: 3200 }); return; }
      toast(`Filled ${n} cell${n === 1 ? '' : 's'}`, { icon: 'check', duration: 1600 });
      ctx.grid.focus();
      return;
    }
    if (typeof first !== 'number') return refuse(null, `${rangeName({ ...range, r2: range.r1, c2: range.c1 })} must hold a number or date to start from`);
    const step = Number(stepInput.value);
    if (stepInput.value.trim() === '' || !Number.isFinite(step) || (typeSelect.value === 'growth' && step === 0)) return refuse(stepInput, 'Enter a step');
    // Only the stop value bounds a single-cell fill, and a series that stands still never reaches it.
    if (single && step === 0) return refuse(stepInput, 'With one cell selected, enter a step other than 0 so the series can reach the stop value');
    if (single && stopInput.value.trim() === '') return refuse(stopInput, 'With one cell selected, enter a stop value');
    let stop = null;
    if (stopInput.value.trim() !== '') {
      if (typeSelect.value === 'date') {
        const parsed = parseInput(stopInput.value.trim());
        if (typeof parsed.v !== 'number') return refuse(stopInput, 'Enter the stop value as a date, like 2024-12-31');
        stop = parsed.v;
      } else stop = Number(stopInput.value);
    }
    if (ctx.wb.isProtected(sheetId)) { toast('This sheet is protected. Unprotect it to fill a series', { icon: 'lock' }); return; }
    // A fill refused for protection is explained by the lock message every tool shares, not blamed on the series.
    if (!single && ctx.wb.lockedIn(sheetId, range)) { modal.close(); return; }
    let refused = false;
    const onProtection = ({ detail }) => { if (detail?.type === 'protected' && detail.sheetId === sheetId) refused = true; };
    ctx.wb.addEventListener('change', onProtection);
    let n = 0;
    try {
      // Every row or column of the selection, each from its own first cell.
      n = fillSeriesLines(ctx.wb, sheetId, range, { type: typeSelect.value, step, stop, unit: unitSelect.value, direction: dirSelect.value });
    } finally { ctx.wb.removeEventListener('change', onProtection); }
    modal.close();
    if (refused) return;
    if (!n) { toast('Nothing to fill: the series ends before the next cell', { icon: 'info' }); return; }
    if (single) {
      const end = dirSelect.value === 'down' ? { r1: range.r1, c1: range.c1, r2: range.r1 + n, c2: range.c1 } : { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 + n };
      ctx.grid.setSelection(S.fromRange(end, { r: range.r1, c: range.c1 }), { scroll: false });
    }
    toast(`Filled ${n} cell${n === 1 ? '' : 's'}`, { icon: 'check', duration: 1600 });
    ctx.grid.focus();
  };
  const content = el('form', { onsubmit: submit },
    el('p.modal-text', {}, `Starts from ${rangeName({ ...range, r2: range.r1, c2: range.c1 })}${typeof first === 'number' ? ` (${ctx.wb.getDisplay(sheetId, range.r1, range.c1)})` : ''}.`),
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, 'Series in'), el('div.select-wrap', {}, dirSelect)),
      el('label.field', {}, el('span.field-label', {}, 'Type'), el('div.select-wrap', {}, typeSelect))),
    unitField,
    trendField,
    el('div.names-fields', {},
      el('label.field', {}, el('span.field-label', {}, 'Step value'), stepInput),
      el('label.field', {}, el('span.field-label', {}, 'Stop value'), stopInput)),
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Fill')));
  // Closing by any route (Cancel, Escape, the scrim) hands focus back to the grid, not the toolbar button.
  const modal = openModal({ title: 'Fill series', content, initialFocus: stepInput, onClose: () => ctx.grid.focus() });
  // The suggested step is offered selected, so typing replaces it (where the field took the focus).
  if (document.activeElement === stepInput) stepInput.select();
}
