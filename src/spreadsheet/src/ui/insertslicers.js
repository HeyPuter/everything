/**
 * The Insert Slicers dialog: a checkbox for every column of the table (or field of the
 * PivotTable) the active cell is in; OK puts one slicer on the sheet for each one ticked.
 */
import { el, fieldId, MOD_KEY } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { insertTableSlicers, insertPivotSlicers, pivotSlicerFields } from '../core/slicer-insert.js';
import { decodeXlsxString } from '../core/xlsx-string.js';
import { t } from '../i18n/index.js';

/** source: { table } or { pivot }. */
export function openInsertSlicersDialog(ctx, { table = null, pivot = null }) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const choices = table
    ? wb.tableColumns(sheetId, table).map(name => ({ key: name, label: name }))
    : pivotSlicerFields(wb, pivot).map(f => ({ key: f.index, label: f.name, problem: f.problem }));
  const { alert, refuse } = fieldAlert('slicers');
  const boxes = choices.map(choice => {
    const id = fieldId('slicer-field');
    const input = el('input', { type: 'checkbox', id, disabled: !!choice.problem, dataset: { key: String(choice.key) } });
    return { choice, input, node: el('label.find-option', { for: id, title: choice.problem || choice.label }, input, el('span', {}, choice.label)) };
  });
  const submit = e => {
    e?.preventDefault();
    const chosen = boxes.filter(b => b.input.checked).map(b => b.choice.key);
    if (!chosen.length) { modal.close(); return; } // OK with nothing ticked inserts nothing.
    let ids;
    try {
      ids = table ? insertTableSlicers(wb, sheetId, table.id, chosen) : insertPivotSlicers(wb, sheetId, pivot, chosen);
    } catch (error) { refuse(null, error.message || t('insertslicers.couldNotInsert')); return; }
    modal.close();
    if (ids.length) {
      ctx.grid.selectChart?.(ids[ids.length - 1]);
      // On a Mac a Control-click is a right-click: several items are chosen with Command there, as the slicer reads it.
      toast(t('insertslicers.inserted', { count: ids.length, key: MOD_KEY }), { icon: 'filter', duration: 2600 });
    }
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, table ? t('insertslicers.chooseTable', { name: table.name }) : t('insertslicers.choosePivot', { name: decodeXlsxString(pivot.name) })),
    el('div.field', { role: 'group', 'aria-label': t('insertslicers.fields') }, el('div.dedupe-cols.slicer-fields', {}, ...boxes.map(b => b.node))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('insertslicers.title'), content, initialFocus: boxes.find(b => !b.input.disabled)?.input, onClose: () => ctx.grid.focus() });
  return modal;
}
