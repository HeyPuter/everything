/**
 * Table Design ▸ Resize Table: type (or take from the selection) the table's new range. The
 * header row stays where it is and the new range must overlap the old one.
 */
import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { rangeName, normalizeRange } from '../core/cell.js';
import * as S from '../core/selection.js';
import { t } from '../i18n/index.js';

const absolute = range => rangeName(range).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2');

/** Why `next` cannot be the table's range, or null (the checks made before resizing). */
export function tableResizeProblem(table, next) {
  if (!next) return t('tableresize.enterRange');
  if (next.r1 !== table.range.r1) return t('tableresize.sameRow');
  const overlaps = !(next.r2 < table.range.r1 || next.r1 > table.range.r2 || next.c2 < table.range.c1 || next.c1 > table.range.c2);
  if (!overlaps) return t('tableresize.mustOverlap');
  return null;
}

export function openTableResizeDialog(ctx, table) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const input = el('input.input', { type: 'text', value: absolute(table.range), 'aria-label': t('tableresize.newRange'), spellcheck: false, autocomplete: 'off' });
  const { alert, refuse } = fieldAlert('resize');
  const useSelection = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { input.value = absolute(normalizeRange(ctx.grid.range)); input.focus(); } }, t('tableresize.useSelection'));
  const read = () => {
    const parsed = wb.rangeFromText(sheetId, input.value.replace(/\$/g, '').trim());
    return parsed && parsed.sheetId === sheetId ? normalizeRange(parsed.range) : null;
  };
  const submit = e => {
    e?.preventDefault();
    const live = wb.tableById(sheetId, table.id);
    if (!live) return refuse(null, t('tableresize.gone'));
    if (wb.isProtected(sheetId)) return refuse(null, t('tableresize.protected'));
    const next = read(), problem = tableResizeProblem(live, next);
    if (problem) return refuse(input, problem);
    let reason = null;
    if (!wb.resizeTable(sheetId, live.id, next, { onInvalid: m => { reason = m; } })) return refuse(input, reason || t('tableresize.failed'));
    modal.close();
    const done = wb.tableById(sheetId, live.id);
    ctx.grid.setSelection(S.fromRange(done.range, { r: done.range.r1, c: done.range.c1 }));
    toast(t('tableresize.done', { name: done.name, range: rangeName(done.range) }), { icon: 'table' });
  };
  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('tableresize.prompt')), el('div.row', {}, input, useSelection)),
    alert,
    el('p.field-hint', {}, t('tableresize.hint')),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('tableresize.title'), content, initialFocus: input, onClose: () => ctx.grid.focus() });
  if (document.activeElement === input) input.select();
  return modal;
}
