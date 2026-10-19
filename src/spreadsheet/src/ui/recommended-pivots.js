/**
 * Insert ▸ Recommended PivotTables: a list of summaries of the data around the selection on the left, the
 * chosen one previewed on the right, OK inserting it on a new sheet; Blank PivotTable opens the full
 * PivotTable dialog instead.
 */
import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { recommendPivots } from '../core/pivot-recommend.js';
import { buildPivot, pivotRangeProblem, PivotSizeError } from '../core/pivot.js';
import { formatValue } from '../core/format.js';
import { rangeName } from '../core/cell.js';
import * as S from '../core/selection.js';
import { insertPivotSheet } from './pivotdialog.js';

/** A preview value as the pivot shows it, in the value column's number format (a count in General). */
const shownValue = (pick, v) => formatValue(v, pick.format);

export function openRecommendedPivots(ctx) {
  if (ctx.grid.editing && !ctx.grid.commitEdit()) return null;
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const range = ctx.dataRange ? ctx.dataRange(ctx.range()) : S.isSingle(ctx.selection()) ? (wb.usedRange(sheetId) || ctx.range()) : ctx.range();
  const problem = range ? pivotRangeProblem(wb, sheetId, range) : 'Select a list with a header row';
  if (problem) { toast(problem, { icon: 'info', duration: 3500 }); return null; }
  const picks = recommendPivots(wb, sheetId, range);
  if (!picks.length) {
    toast('No recommendations for this data. Use Blank PivotTable to build one', { icon: 'info', duration: 3500 });
    ctx.run('pivot');
    return null;
  }
  let chosen = 0;
  const preview = el('div.rec-pivot-preview', { 'aria-live': 'polite' });
  const show = () => {
    const pick = picks[chosen];
    preview.replaceChildren(el('div.rec-pivot-title', {}, pick.title),
      el('table.rec-pivot-table', {}, el('thead', {}, el('tr', {}, ...pick.headers.map((h, i) => el(i ? 'th.num' : 'th', { scope: 'col' }, h)))),
        el('tbody', {}, ...pick.preview.map(([label, ...values]) => el('tr', {}, el('td', {}, String(label)), ...values.map((v) => el('td.num', {}, shownValue(pick, v))))))));
    for (const [i, node] of list.querySelectorAll('[role="option"]').entries()) node.setAttribute('aria-selected', String(i === chosen));
  };
  const list = el('div.rec-pivot-list', { role: 'listbox', 'aria-label': 'Recommended PivotTables', tabindex: 0,
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); chosen = Math.max(0, Math.min(picks.length - 1, chosen + (e.key === 'ArrowDown' ? 1 : -1))); show(); }
      if (e.key === 'Enter') { e.preventDefault(); insert(); }
    } },
  ...picks.map((pick, i) => el('div.rec-pivot-item', { role: 'option', 'aria-selected': 'false', onclick: () => { chosen = i; show(); }, ondblclick: () => { chosen = i; insert(); } },
    el('span.rec-pivot-item-title', {}, pick.title),
    el('span.rec-pivot-item-sample', { 'aria-hidden': 'true' }, pick.preview.slice(0, 3).map((row) => `${row[0]} ${shownValue(pick, row.at(-1))}`).join(' · ')))));
  const insert = () => {
    let built;
    try { built = buildPivot(wb, sheetId, picks[chosen].spec); }
    catch (cause) { if (cause instanceof PivotSizeError) { toast(cause.message, { icon: 'alert' }); return; } throw cause; }
    if (!insertPivotSheet(wb, sheetId, built)) return;
    modal.close();
    ctx.grid.focus();
  };
  const content = el('div.rec-pivots', {},
    el('p.small.muted', {}, `Data: ${wb.sheet(sheetId).name}!${rangeName(range)}`),
    el('div.rec-pivot-body', {}, list, preview),
    el('div.row.rec-pivot-foot', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => { modal.close(); ctx.run('pivot'); } }, 'Blank PivotTable'),
      el('div.row.rec-pivot-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-primary', { type: 'button', onclick: insert }, 'OK'))));
  const modal = openModal({ title: 'Recommended PivotTables', content, wide: true, initialFocus: list, onClose: () => ctx.grid.focus() });
  show();
  return modal;
}
