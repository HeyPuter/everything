/**
 * Subtotal dialog: which column starts a new group, which function to use,
 * and which columns to total. Existing subtotals in the range can be removed.
 */

import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { looksLikeHeader, rearrangeProblem } from './sortdialog.js';
import { colName, rangeName, parseKey } from '../core/cell.js';
import { dateTimeKind } from '../core/format.js';
import * as S from '../core/selection.js';
import { SUBTOTAL_FUNCTIONS, addSubtotals, removeSubtotals, hasSubtotals, groupsContiguous, tableOverlaps } from '../core/subtotal.js';
import { t } from '../i18n/index.js';

/** Each function's name in the interface, by its SUBTOTAL code in SUBTOTAL_FUNCTIONS. */
const FUNCTION_LABELS = {
  9: 'subtotaldialog.fn.sum', 3: 'subtotaldialog.fn.count', 1: 'subtotaldialog.fn.average', 4: 'subtotaldialog.fn.max', 5: 'subtotaldialog.fn.min',
  6: 'subtotaldialog.fn.product', 2: 'subtotaldialog.fn.countNumbers', 7: 'subtotaldialog.fn.stdDev', 10: 'subtotaldialog.fn.variance',
};

export function openSubtotalDialog(ctx, range) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  if (range.r1 >= range.r2) { toast(t('subtotaldialog.errors.selectRows'), { icon: 'info' }); return null; }
  // Total rows inside a table would join its data and be counted by every reference to it: the way out is named rather than the command simply disabled.
  if (tableOverlaps(wb, sheetId, range)) { toast(t('subtotaldialog.errors.insideTable'), { icon: 'info' }); return null; }
  const headerId = fieldId('subtotal');
  const headerInput = el('input', { type: 'checkbox', id: headerId, checked: looksLikeHeader(wb, sheetId, range) });
  const cols = [];
  for (let c = range.c1; c <= range.c2; c++) cols.push(c);
  const labelFor = (c) => {
    const head = headerInput.checked ? wb.getDisplay(sheetId, range.r1, c) : '';
    return head ? t('subtotaldialog.columnWithHeader', { col: colName(c), header: head }) : t('subtotaldialog.column', { col: colName(c) });
  };
  // Columns worth totalling: mostly numbers, and not dates (which are numbers underneath).
  const counts = new Map();
  const start = range.r1 + (headerInput.checked ? 1 : 0);
  const inside = (r, c) => r >= start && r <= range.r2 && c >= range.c1 && c <= range.c2;
  const count = (r, c, v) => {
    if (v == null || v === '') return;
    const stats = counts.get(c) || { nums: 0, filled: 0 };
    stats.filled++;
    if (typeof v === 'number' && !dateTimeKind(wb.getCell(sheetId, r, c)?.s, v)) stats.nums++;
    counts.set(c, stats);
  };
  const cells = wb.sheet(sheetId).cells;
  if ((range.r2 - start + 1) * cols.length <= cells.size) {
    // Small selections should not scan an otherwise large sheet.
    for (let r = start; r <= range.r2; r++) for (const c of cols) count(r, c, wb.getValue(sheetId, r, c));
  } else {
    // Full-column selections can contain millions of empty coordinates.
    // Count actual values once, including spill children with only a style.
    for (const [key, cell] of cells) {
      if (cell.v == null && cell.f == null) continue;
      const { r, c } = parseKey(key);
      if (inside(r, c)) count(r, c, wb.getValue(sheetId, r, c));
    }
    // Only the results spilled into the range: an array over the whole sheet spills more than any list holds.
    for (const { r, c, value } of wb.spillEntries(sheetId, { r1: start, c1: range.c1, r2: range.r2, c2: range.c2 })) if (inside(r, c)) count(r, c, value);
  }
  const numeric = (c) => {
    const stats = counts.get(c);
    return !!stats && stats.nums >= stats.filled / 2;
  };
  const firstText = cols.find((c) => !numeric(c)) ?? range.c1;
  const groupSel = el('select.select', { 'aria-label': t('subtotaldialog.atEachChange') }, cols.map((c) => el('option', { value: c, selected: c === firstText }, labelFor(c))));
  const fnSel = el('select.select', { 'aria-label': t('subtotaldialog.useFunction') }, SUBTOTAL_FUNCTIONS.map(([code, label]) => el('option', { value: code }, FUNCTION_LABELS[code] ? t(FUNCTION_LABELS[code]) : label)));
  const boxes = cols.map((c) => {
    const id = fieldId('subtotal');
    // The group column holds the labels, so it cannot be totalled as well.
    const input = el('input', { type: 'checkbox', id, checked: c !== firstText && numeric(c), disabled: c === firstText, dataset: { col: c } });
    return el('label.find-option', { for: id }, input, el('span', {}, labelFor(c)));
  });
  const sortId = fieldId('subtotal');
  const sortInput = el('input', { type: 'checkbox', id: sortId, checked: true });
  const groupId = fieldId('subtotal');
  const groupInput = el('input', { type: 'checkbox', id: groupId, checked: true });
  const relabel = () => {
    [...groupSel.options].forEach((o) => { o.textContent = labelFor(Number(o.value)); });
    boxes.forEach((b, i) => { b.querySelector('span').textContent = labelFor(cols[i]); });
  };
  headerInput.addEventListener('change', relabel);
  groupSel.addEventListener('change', () => {
    for (const b of boxes) {
      const input = b.querySelector('input');
      input.disabled = Number(input.dataset.col) === Number(groupSel.value);
      if (input.disabled) input.checked = false;
    }
  });

  const submit = (e) => {
    e.preventDefault();
    // A protected sheet refuses every write; say so, as Remove does, rather than reporting nothing to subtotal.
    if (wb.isProtected(sheetId)) { toast(t('subtotaldialog.errors.protectedAdd'), { icon: 'lock' }); return; }
    const totalCols = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.dataset.col));
    if (!totalCols.length) { toast(t('subtotaldialog.errors.chooseColumn'), { icon: 'info' }); return; }
    // The sort that gathers each group is refused over merged cells, an array result, or protected
    // cells; unless the rows already lie grouped, say which, and offer the way out, rather than
    // reporting subtotals that were not added.
    if (sortInput.checked) {
      const dataRange = { ...range, r1: range.r1 + (headerInput.checked ? 1 : 0) };
      const problem = rearrangeProblem(wb, sheetId, dataRange, 'row', 'sort');
      if (problem && !groupsContiguous(wb, sheetId, dataRange, Number(groupSel.value))) { toast(t('subtotaldialog.errors.sortRefused', { problem }), { icon: 'info' }); return; }
    }
    const out = addSubtotals(wb, sheetId, range, {
      groupCol: Number(groupSel.value), code: Number(fnSel.value), totalCols, header: headerInput.checked, sort: sortInput.checked, group: groupInput.checked,
    });
    modal.close();
    if (!out) { toast(t('subtotaldialog.nothingToSubtotal'), { icon: 'info' }); return; }
    ctx.grid.setSelection(S.fromRange(out, { r: out.r1, c: out.c1 }));
    toast(t('subtotaldialog.added', { range: rangeName(out) }), { icon: 'sigma' });
    ctx.grid.focus();
  };
  const remove = () => {
    // A protected sheet refuses the deletion; say so rather than reporting rows that were not removed.
    if (wb.isProtected(sheetId)) { toast(t('subtotaldialog.errors.protectedRemove'), { icon: 'lock' }); return; }
    const n = removeSubtotals(wb, sheetId, range);
    modal.close();
    toast(n ? t('subtotaldialog.removed', { n }) : t('subtotaldialog.noneInSelection'), { icon: 'sigma' });
    ctx.grid.focus();
  };

  const existing = hasSubtotals(wb, sheetId, range);
  const content = el('form', { onsubmit: submit },
    el('p.modal-text', {}, existing ? t('subtotaldialog.introReplace', { range: rangeName(range) }) : t('subtotaldialog.intro', { range: rangeName(range) })),
    el('label.find-option', { for: headerId }, headerInput, el('span', {}, t('subtotaldialog.hasHeader'))),
    el('div.row.row-2', { style: { marginTop: '10px' } },
      el('label.field', {}, el('span.field-label', {}, t('subtotaldialog.atEachChange')), el('div.select-wrap', {}, groupSel)),
      el('label.field', {}, el('span.field-label', {}, t('subtotaldialog.useFunction')), el('div.select-wrap', {}, fnSel))),
    el('div.field', {}, el('span.field-label', {}, t('subtotaldialog.addTo')), el('div.print-checks', {}, ...boxes)),
    el('label.find-option', { for: sortId }, sortInput, el('span', {}, t('subtotaldialog.sortFirst'))),
    el('label.find-option', { for: groupId }, groupInput, el('span', {}, t('subtotaldialog.groupDetail'))),
    el('div.row.row-end', { style: { marginTop: '16px' } },
      existing && el('button.btn.btn-danger', { type: 'button', onclick: remove }, t('subtotaldialog.remove')),
      el('div.grow'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('subtotaldialog.add'))));
  const modal = openModal({ title: t('subtotaldialog.title'), content, onClose: () => ctx.grid.focus() });
  return modal;
}
