/**
 * Remove duplicates: choose whether the first row is a header and which
 * columns decide that two rows are the same.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { rangeName, colName } from '../core/cell.js';
import { sortHeaderDefault, rearrangeProblem } from './sortdialog.js';
import * as S from '../core/selection.js';

/** `expanded`: the range was widened from the selection to the block around it, and reads its header as such a block does. */
export function openDedupeDialog(ctx, range, { expanded: widened = false } = {}) {
  const sheetId = ctx.sheetId();
  const wb = ctx.wb;
  const headerId = fieldId('dd');
  // The first row is a header by the Sort dialog's rule: an explicitly selected list of names is
  // compared whole, its first entry included, while the block read around one cell keeps its title row.
  const expanded = widened || (!!ctx.selection && S.isSingle(ctx.selection())) || (range.r1 === 0 && range.r2 >= wb.sheet(sheetId).rows - 1);
  const headerInput = el('input', { type: 'checkbox', id: headerId, checked: sortHeaderDefault(wb, sheetId, range, { expanded }) });
  const cols = [];
  for (let c = range.c1; c <= range.c2; c++) cols.push(c);
  const label = (c) => {
    const head = headerInput.checked ? wb.getDisplay(sheetId, range.r1, c) : '';
    return head ? `${colName(c)} · ${head}` : `Column ${colName(c)}`;
  };
  const boxes = cols.map((c) => {
    const id = fieldId('dd');
    const input = el('input', { type: 'checkbox', id, checked: true, dataset: { c } });
    const text = el('span', {}, label(c));
    return { c, input, text, node: el('label.find-option', { for: id }, input, text) };
  });
  headerInput.addEventListener('change', () => { for (const b of boxes) b.text.textContent = label(b.c); });
  const allBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { for (const b of boxes) b.input.checked = true; } }, 'Select all');
  const noneBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { for (const b of boxes) b.input.checked = false; } }, 'Clear');
  const { alert: error, refuse } = fieldAlert('dd');
  const submit = (e) => {
    e?.preventDefault();
    const chosen = boxes.filter((b) => b.input.checked).map((b) => b.c);
    if (!chosen.length) return refuse(boxes[0].input, 'Choose at least one column to compare'); // the first box stands for the group
    const all = chosen.length === cols.length && range.c2 - range.c1 + 1 === cols.length;
    if (wb.isProtected(sheetId)) { toast('This sheet is protected. Unprotect it to remove duplicates', { icon: 'lock' }); return; }
    // Merged cells, an array result, or protected cells refuse the removal; say which, rather than reporting rows that were not removed.
    const dataRange = headerInput.checked ? { ...range, r1: range.r1 + 1 } : range;
    const problem = dataRange.r1 <= dataRange.r2 ? rearrangeProblem(wb, sheetId, dataRange, 'row', 'remove duplicates') : '';
    if (problem) { toast(problem, { icon: 'info' }); return; }
    const removed = wb.removeDuplicates(sheetId, range, { header: headerInput.checked, columns: all ? null : chosen });
    if (removed === false) { toast(`Can't remove duplicates from ${rangeName(range)}`, { icon: 'info' }); return; }
    modal.close();
    toast(removed ? `Removed ${removed} duplicate row${removed === 1 ? '' : 's'}` : 'No duplicate rows found', { icon: removed ? 'dedupe' : 'info' });
    if (removed) ctx.grid.setSelection(S.fromRange(range, ctx.active()), { scroll: false });
    ctx.grid.focus();
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, `Rows in ${rangeName(range)} that repeat an earlier row are removed; the first of each stays.`),
    el('label.find-option', { for: headerId }, headerInput, el('span', {}, 'Data has a header row')),
    el('div.field', {},
      el('div.row', {}, el('span.field-label', {}, 'Columns to compare'), el('div.grow'), allBtn, noneBtn),
      el('div.dedupe-cols', {}, ...boxes.map((b) => b.node))),
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Remove duplicates')));
  const modal = openModal({ title: 'Remove duplicates', content, onClose: () => ctx.grid?.focus?.() });
}
