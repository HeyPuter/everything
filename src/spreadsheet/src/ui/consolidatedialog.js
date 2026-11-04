/** Data ▸ Consolidate: the function, the references to combine, and whether their top row and left column hold labels. */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { CONSOLIDATE_FUNCTIONS } from '../core/consolidate.js';
import { rangeName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { t } from '../i18n/index.js';

/** Each function's name in the interface, by its id in CONSOLIDATE_FUNCTIONS. */
const FUNCTION_LABELS = {
  sum: 'consolidatedialog.fn.sum', count: 'consolidatedialog.fn.count', average: 'consolidatedialog.fn.average', max: 'consolidatedialog.fn.max',
  min: 'consolidatedialog.fn.min', product: 'consolidatedialog.fn.product', countNums: 'consolidatedialog.fn.countNums', stdev: 'consolidatedialog.fn.stdev',
  stdevp: 'consolidatedialog.fn.stdevp', var: 'consolidatedialog.fn.var', varp: 'consolidatedialog.fn.varp',
};

export function openConsolidateDialog(ctx) {
  const refs = [];
  const fn = el('select.select', { 'aria-label': t('consolidatedialog.function') }, ...CONSOLIDATE_FUNCTIONS.map(([value, label]) => el('option', { value }, FUNCTION_LABELS[value] ? t(FUNCTION_LABELS[value]) : label)));
  const sheetName = ctx.wb.sheet(ctx.sheetId())?.name || '';
  const range = ctx.range();
  const reference = el('input.input', { type: 'text', 'aria-label': t('consolidatedialog.reference'), autocomplete: 'off', spellcheck: false,
    value: range.r1 === range.r2 && range.c1 === range.c2 ? '' : `${quoteSheet(sheetName)}!${rangeName(range)}` });
  const list = el('select.select.consolidate-refs', { size: 5, 'aria-label': t('consolidatedialog.allReferences') });
  const top = el('input', { type: 'checkbox', id: fieldId('consolidate-top') });
  const left = el('input', { type: 'checkbox', id: fieldId('consolidate-left') });
  const { alert, refuse } = fieldAlert('consolidate');
  const sync = () => list.replaceChildren(...refs.map((r) => el('option', { value: r }, r)));
  const add = () => {
    const text = reference.value.trim();
    if (!text) return;
    if (!ctx.resolveRange(text)) { refuse(reference, t('consolidatedialog.errors.enterRange')); return; }
    if (!refs.includes(text)) refs.push(text);
    reference.value = '';
    sync();
  };
  const remove = () => { const i = list.selectedIndex; if (i >= 0) { refs.splice(i, 1); sync(); } };
  const submit = (e) => {
    e.preventDefault();
    if (reference.value.trim()) add();
    if (!refs.length) { refuse(reference, t('consolidatedialog.errors.addReference')); return; }
    // The result goes at the active cell: inside a source it would be written over the data it is made from.
    const at = ctx.active?.();
    const inside = at && refs.find((text) => {
      const hit = ctx.resolveRange(text);
      return hit?.sheetId === ctx.sheetId() && at.r >= hit.range.r1 && at.r <= hit.range.r2 && at.c >= hit.range.c1 && at.c <= hit.range.c2;
    });
    if (inside) { refuse(list, t('consolidatedialog.errors.resultInside', { ref: inside })); return; }
    modal.close();
    ctx.run('consolidate', { fn: fn.value, refs: [...refs], topRow: top.checked, leftColumn: left.checked });
  };
  const content = el('form.consolidate-dialog', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, t('consolidatedialog.function')), el('div.select-wrap', {}, fn)),
    el('label.field', {}, el('span.field-label', {}, t('consolidatedialog.reference')), el('div.row', {}, reference,
      el('button.btn', { type: 'button', onclick: add }, t('common.add')))),
    alert,
    el('label.field', {}, el('span.field-label', {}, t('consolidatedialog.allReferences')), el('div.row', {}, list, el('button.btn', { type: 'button', onclick: remove }, t('common.delete')))),
    el('fieldset.check-group.vertical', {}, el('legend.field-label', {}, t('consolidatedialog.useLabelsIn')),
      el('label.check', { for: top.id }, top, el('span', {}, t('consolidatedialog.topRow'))), el('label.check', { for: left.id }, left, el('span', {}, t('consolidatedialog.leftColumn')))),
    el('div.row.row-end', { style: { marginTop: '12px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('consolidatedialog.title'), content, initialFocus: reference, onClose: () => ctx.grid.focus() });
  return modal;
}
