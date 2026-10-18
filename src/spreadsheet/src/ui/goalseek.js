/**
 * Goal seek: set a formula cell to a wanted value by changing one input cell.
 */

import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { cellName, parseCellRef } from '../core/cell.js';
import * as S from '../core/selection.js';
import { typedNumber } from './typed-number.js';

export function openGoalSeek(ctx) {
  const sheetId = ctx.sheetId();
  const a = ctx.active();
  const wb = ctx.wb;
  // The changing cell defaults to the first plain number the formula reads.
  const guess = wb.precedents(sheetId, a.r, a.c).find((p) => {
    if (p.sheetId !== sheetId) return false;
    const cell = wb.getCell(sheetId, p.r, p.c);
    return cell && cell.f == null && typeof cell.v === 'number';
  });
  const setInput = el('input.input', { type: 'text', 'aria-label': 'Set cell', value: cellName(a.r, a.c), spellcheck: false, autocomplete: 'off' });
  // Typed as a cell takes a number in the regional format (1,5 where the decimal mark is a comma), not as the browser's language reads one.
  const toInput = el('input.input', { type: 'text', inputmode: 'decimal', 'aria-label': 'To value', placeholder: 'Wanted result', autocomplete: 'off', spellcheck: false });
  const byInput = el('input.input', { type: 'text', 'aria-label': 'By changing cell', value: guess ? cellName(guess.r, guess.c) : '', placeholder: 'e.g. B2', spellcheck: false, autocomplete: 'off' });
  const { alert: error, refuse } = fieldAlert('goal'); // the workbook's own reason for refusing names no field
  const submit = (e) => {
    e?.preventDefault();
    const target = parseCellRef(setInput.value.trim());
    const variable = parseCellRef(byInput.value.trim());
    if (!target) return refuse(setInput, 'Enter the cell to set, like C12');
    const goal = typedNumber(toInput.value);
    if (goal == null) return refuse(toInput, 'Enter the value to reach');
    if (!variable) return refuse(byInput, 'Enter the cell to change, like B2');
    const res = wb.goalSeek(sheetId, target, goal, variable);
    if (!res.ok) return refuse(null, res.reason);
    modal.close();
    ctx.grid.setSelection(S.single(variable.r, variable.c), { scroll: true });
    toast(`${cellName(variable.r, variable.c)} set to ${wb.getDisplay(sheetId, variable.r, variable.c)}; ${cellName(target.r, target.c)} is now ${wb.getDisplay(sheetId, target.r, target.c)}`, { icon: 'check', duration: 4000 });
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, 'Finds the input that makes a formula reach a value. One undo step.'),
    el('label.field', {}, el('span.field-label', {}, 'Set cell'), setInput),
    el('label.field', {}, el('span.field-label', {}, 'To value'), toInput),
    el('label.field', {}, el('span.field-label', {}, 'By changing cell'), byInput),
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Seek')));
  const modal = openModal({ title: 'Goal seek', content, initialFocus: toInput, onClose: () => ctx.grid?.focus?.() });
}
