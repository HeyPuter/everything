/**
 * Goal seek: set a formula cell to a wanted value by changing one input cell.
 */

import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { cellName, parseCellRef } from '../core/cell.js';
import * as S from '../core/selection.js';
import { typedNumber } from './typed-number.js';
import { t } from '../i18n/index.js';

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
  const setInput = el('input.input', { type: 'text', 'aria-label': t('goalseek.setCell'), value: cellName(a.r, a.c), spellcheck: false, autocomplete: 'off' });
  // Typed as a cell takes a number in the regional format (1,5 where the decimal mark is a comma), not as the browser's language reads one.
  const toInput = el('input.input', { type: 'text', inputmode: 'decimal', 'aria-label': t('goalseek.toValue'), placeholder: t('goalseek.wantedResult'), autocomplete: 'off', spellcheck: false });
  const byInput = el('input.input', { type: 'text', 'aria-label': t('goalseek.byChangingCell'), value: guess ? cellName(guess.r, guess.c) : '', placeholder: t('goalseek.example'), spellcheck: false, autocomplete: 'off' });
  const { alert: error, refuse } = fieldAlert('goal'); // the workbook's own reason for refusing names no field
  const submit = (e) => {
    e?.preventDefault();
    const target = parseCellRef(setInput.value.trim());
    const variable = parseCellRef(byInput.value.trim());
    if (!target) return refuse(setInput, t('goalseek.errors.noSetCell'));
    const goal = typedNumber(toInput.value);
    if (goal == null) return refuse(toInput, t('goalseek.errors.noValue'));
    if (!variable) return refuse(byInput, t('goalseek.errors.noChangingCell'));
    const res = wb.goalSeek(sheetId, target, goal, variable);
    if (!res.ok) return refuse(null, res.reason);
    modal.close();
    ctx.grid.setSelection(S.single(variable.r, variable.c), { scroll: true });
    toast(t('goalseek.done', { cell: cellName(variable.r, variable.c), value: wb.getDisplay(sheetId, variable.r, variable.c), target: cellName(target.r, target.c), result: wb.getDisplay(sheetId, target.r, target.c) }), { icon: 'check', duration: 4000 });
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, t('goalseek.intro')),
    el('label.field', {}, el('span.field-label', {}, t('goalseek.setCell')), setInput),
    el('label.field', {}, el('span.field-label', {}, t('goalseek.toValue')), toInput),
    el('label.field', {}, el('span.field-label', {}, t('goalseek.byChangingCell')), byInput),
    error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('goalseek.seek'))));
  const modal = openModal({ title: t('goalseek.title'), content, initialFocus: toInput, onClose: () => ctx.grid?.focus?.() });
}
