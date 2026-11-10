/**
 * Table dialog: make a table of a range (name, header row, totals row, style,
 * banding), or edit an existing one (rename, totals, style, convert back to
 * a plain range).
 */

import { el, fieldId, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { looksLikeHeader } from './sortdialog.js';
import { rangeName, normalizeRange } from '../core/cell.js';
import { TABLE_STYLES, tableNameMessage } from '../core/tables.js';
import { t } from '../i18n/index.js';
import { MAX_ROWS, MAX_COLS } from '../core/workbook.js';
import * as S from '../core/selection.js';

export function openTableDialog(ctx, { range = null, table = null, style: preset = null, onCreated = null } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const editing = !!table;
  const src = table ? table.range : range;
  const nameInput = el('input.input', { type: 'text', value: table ? table.name : wb.uniqueTableName(), 'aria-label': t('tabledialog.tableName'), spellcheck: false, autocomplete: 'off', maxlength: 60 });
  const rangeInput = el('input.input', { type: 'text', value: rangeName(src), 'aria-label': t('tabledialog.range'), spellcheck: false, autocomplete: 'off', disabled: editing });
  // A refusal names the field it is about (the range, the name, the totals box); one about the sheet itself names none.
  const { alert: error, refuse } = fieldAlert('table');
  const headerId = fieldId('table');
  const headerInput = el('input', { type: 'checkbox', id: headerId, checked: editing || looksLikeHeader(wb, sheetId, src) });
  // A different range may or may not start with a header: re-detect until the user decides.
  let headerTouched = false;
  headerInput.addEventListener('change', () => { headerTouched = true; });
  // The same reading as every other range box: A1:D20, Sheet1!A1:D20, or a name, on this sheet.
  const readRange = () => {
    const parsed = wb.rangeFromText(sheetId, rangeInput.value.trim());
    return parsed && parsed.sheetId === sheetId ? normalizeRange(parsed.range) : null;
  };
  rangeInput.addEventListener('input', () => {
    const r = readRange();
    if (r && !headerTouched) headerInput.checked = looksLikeHeader(wb, sheetId, r);
  });
  const totalsId = fieldId('table');
  const totalsInput = el('input', { type: 'checkbox', id: totalsId, checked: !!table?.totalsRow });
  const bandedId = fieldId('table');
  const bandedInput = el('input', { type: 'checkbox', id: bandedId, checked: table ? table.banded !== false : true });
  const columnOptions = [['firstColumn', t('tabledialog.firstColumn')], ['lastColumn', t('tabledialog.lastColumn')]].map(([key, label]) => {
    const input = el('input', { type: 'checkbox', checked: !!table?.[key] });
    return { key, input, field: el('label.find-option', {}, input, el('span', {}, label)) };
  });
  const columnPrefs = () => Object.fromEntries(columnOptions.map(({ key, input }) => [key, input.checked]));
  const styleRow = el('div.table-styles', { role: 'radiogroup', 'aria-label': t('tabledialog.tableStyle') });
  let style = table?.style || (TABLE_STYLES.some(([key]) => key === preset) ? preset : 'blue');
  const firstTab = TABLE_STYLES.find(([key]) => key === style)?.[0] || TABLE_STYLES[0][0];
  const chooseStyle = (key) => {
    style = key;
    for (const x of styleRow.children) {
      const selected = x.dataset.key === style;
      x.setAttribute('aria-checked', String(selected));
      x.tabIndex = selected ? 0 : -1;
    }
  };
  for (const [key, label, look] of TABLE_STYLES) {
    const b = el('button.table-style', {
      type: 'button', role: 'radio', 'aria-checked': String(style === key), 'aria-label': label, title: label, dataset: { key }, tabindex: key === firstTab ? 0 : -1,
      onclick: () => chooseStyle(key),
    }, el('span.table-style-head', { style: { background: look.header } }), el('span.table-style-band', { style: { background: look.band } }), el('span.table-style-band.plain'));
    styleRow.append(b);
  }
  styleRow.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    const step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 0;
    if (!step) return;
    const choices = [...styleRow.children];
    const index = choices.indexOf(e.target.closest('[role="radio"]'));
    if (index < 0) return;
    e.preventDefault();
    const next = choices[(index + step + choices.length) % choices.length];
    chooseStyle(next.dataset.key);
    next.focus();
  });

  const submit = (e) => {
    e?.preventDefault();
    if (wb.isProtected(sheetId)) return refuse(null, t('tabledialog.protectedChange'));
    const name = nameInput.value.trim();
    const nameErr = wb.validateTableName(name, table?.name);
    if (nameErr) return refuse(nameInput, tableNameMessage(nameErr));
    if (editing) {
      if (!wb.updateTable(sheetId, table.id, { name, style, banded: bandedInput.checked, ...columnPrefs(), totalsRow: totalsInput.checked })) {
        return refuse(null, t('tabledialog.couldNotUpdate'));
      }
      modal.close();
      toast(t('tabledialog.updated', { name }), { icon: 'table' });
      ctx.grid.focus();
      return;
    }
    let r = readRange();
    if (!r) return refuse(rangeInput, wb.rangeFromText(sheetId, rangeInput.value.trim()) ? t('tabledialog.rangeOnSheet') : t('tabledialog.rangeLike'));
    // The grid's own edge, not the file format's: past it the workbook refuses every edit (a
    // file may bring a larger sheet, whose cells stay editable). The same limit addTable holds
    // the totals row to, checked here before any header row is inserted.
    const sheet = wb.sheet(sheetId);
    const limit = { r2: Math.max(sheet.rows, MAX_ROWS) - 1, c2: Math.max(sheet.cols, MAX_COLS) - 1 };
    const lastRow = Math.max(r.r2 + (headerInput.checked ? 0 : 1), r.r1 + 1) + (totalsInput.checked ? 1 : 0);
    if (r.c2 > limit.c2 || lastRow > limit.r2) {
      return refuse(rangeInput, t('tabledialog.withinLimit', { range: rangeName({ r1: 0, c1: 0, ...limit }) }));
    }
    if (wb.tablesOn(sheetId).some((tb) => !(r.r2 < tb.range.r1 || r.r1 > tb.range.r2 || r.c2 < tb.range.c1 || r.c1 > tb.range.c2))) {
      return refuse(rangeInput, t('tabledialog.overlapsTable'));
    }
    const reportArea = headerInput.checked ? { ...r, r2: Math.max(r.r2, r.r1 + 1) } : r;
    if (wb.nativePivotOverlap(sheetId, reportArea)) return refuse(rangeInput, t('tabledialog.overlapsPivot'));
    if (totalsInput.checked) {
      const totalRow = reportArea.r2 + 1;
      if (wb.tableRowOccupied(sheetId, { ...r, r1: totalRow, r2: totalRow })
        && wb.pivotLineEditBlocked(sheetId, 'row', totalRow, headerInput.checked ? 1 : 2)) {
        return refuse(totalsInput, t('tabledialog.totalsSplitPivot'));
      }
    }
    // A protected range starting above the insertion point expands over
    // the new row. Check before inserting a header that cannot be written.
    if (!headerInput.checked && wb.sheet(sheetId).protectedRanges.some(({ range: p }) =>
      p.r1 < r.r1 && p.r2 >= r.r1 && p.c1 <= r.c2 && p.c2 >= r.c1)) {
      return refuse(null, t('tabledialog.headerProtected'));
    }
    if (totalsInput.checked) {
      // Check before adding a header: the protected cells move with that
      // insertion, and a refused table must not leave an extra row behind.
      // Read off the sheet's own list, as the header row is above: the workbook's lockedIn
      // would announce the protection itself, beside the message the dialog shows.
      const totalRow = (headerInput.checked ? Math.max(r.r2, r.r1 + 1) : r.r2) + 1;
      if (sheet.protectedRanges.some(({ range: p }) => p.r1 <= totalRow && p.r2 >= totalRow && p.c1 <= r.c2 && p.c2 >= r.c1)) {
        return refuse(totalsInput, t('tabledialog.totalsProtected'));
      }
    }
    // addTable refuses merged cells; found here, before the header row is inserted, for the same reason.
    if (wb.mergesIn(sheetId, r).length) return refuse(rangeInput, t('tabledialog.merged'));
    let id;
    let roomForHeader = true;
    wb.transaction(t('tabledialog.create'), () => {
      if (!headerInput.checked) {
        // No header row yet: make room for one above the data. Refused (content would be pushed off
        // the sheet), the transaction ends here with nothing done, rather than with a table whose
        // header is the first data row.
        roomForHeader = wb.insertRows(sheetId, r.r1, 1);
        if (!roomForHeader) return;
        r = { ...r, r2: r.r2 + 1 };
      }
      if (r.r2 <= r.r1) r = { ...r, r2: r.r1 + 1 };
      id = wb.addTable(sheetId, r, { name, style, banded: bandedInput.checked, ...columnPrefs(), totalsRow: totalsInput.checked });
    });
    if (!roomForHeader) return refuse(null, t('tabledialog.noRoomHeader'));
    if (!id) return refuse(rangeInput, t('tabledialog.couldNotCreate'));
    modal.close();
    const made = wb.tableById(sheetId, id);
    ctx.grid.setSelection(S.fromRange(made.range, { r: made.range.r1, c: made.range.c1 }));
    toast(t('tabledialog.created', { name: made.name }), { icon: 'table', duration: 3200 });
    ctx.grid.focus();
    onCreated?.(made); // Data ▸ From Table/Range goes on to the query editor
  };
  const convert = () => {
    if (wb.isProtected(sheetId)) { refuse(null, t('tabledialog.protectedConvert')); return; }
    if (!wb.tableById(sheetId, table.id)) { refuse(null, t('tabledialog.gone')); return; }
    wb.deleteTable(sheetId, table.id);
    modal.close();
    toast(t('tabledialog.converted'), { icon: 'table', duration: 2600 });
    ctx.grid.focus();
  };

  const content = el('form', { onsubmit: submit },
    el('div.row.row-2', {},
      el('label.field', {}, el('span.field-label', {}, t('common.name')), nameInput),
      el('label.field', {}, el('span.field-label', {}, t('tabledialog.range')), rangeInput)),
    error,
    el('div.field', {}, el('span.field-label', {}, t('tabledialog.style')), styleRow),
    el('div.print-checks', {},
      !editing && el('label.find-option', { for: headerId }, headerInput, el('span', {}, t('tabledialog.hasHeader'))),
      el('label.find-option', { for: totalsId }, totalsInput, el('span', {}, t('tabledialog.totalsRow'))),
      el('label.find-option', { for: bandedId }, bandedInput, el('span', {}, t('tabledialog.bandedRows'))), columnOptions.map(option => option.field)),
    el('p.field-hint', {}, t('tabledialog.hint')),
    el('div.row.row-end', { style: { marginTop: '16px' } },
      editing && el('button.btn.btn-danger', { type: 'button', onclick: convert }, t('tabledialog.convertToRange')),
      el('div.grow'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, editing ? t('common.save') : t('tabledialog.create'))));
  const modal = openModal({ title: editing ? t('tabledialog.editTitle', { name: table.name }) : t('tabledialog.create'), content, initialFocus: nameInput, onClose: () => ctx.grid.focus() });
  // The generated name is offered selected, so typing replaces it (where the field took the focus).
  if (document.activeElement === nameInput) nameInput.select();
  return modal;
}
