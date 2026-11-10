/**
 * Named ranges manager: list, add, edit, and delete the workbook's names.
 * Names can also be created from the name box; this is where they are
 * reviewed.
 */

import { el, clear, isComposing } from './dom.js';
import { tableRows } from '../core/tables.js';
import { icon } from './icons.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { t, compareText } from '../i18n/index.js';

/** `define` opens the New Name dialog by itself, as Define Name does, without the review list behind it. */
export function openNamesManager(ctx, { define = false } = {}) {
  const PAGE_SIZE = 100;
  const list = el('div.names-list.names-review-scroll');
  const body = el('tbody');
  const header = el('tr');
  const tableView = el('table.names-review', { 'aria-label': t('names.namedRanges') }, el('thead', {}, header), body);
  const search = el('input.input', { type: 'search', 'aria-label': t('names.search'), placeholder: t('names.searchPlaceholder'), autocomplete: 'off', spellcheck: false });
  const filter = el('select.select', { 'aria-label': t('names.filter.label') },
    ...[['all', 'names.filter.all'], ['sheet', 'names.filter.sheet'], ['workbook', 'names.filter.workbook'], ['defined', 'names.filter.defined'], ['table', 'names.filter.table']].map(([value, label]) => el('option', { value }, t(label))),
    el('option', { disabled: true }, t('names.filter.withErrors')), el('option', { disabled: true }, t('names.filter.withoutErrors')));
  const summary = el('span.small.muted', { role: 'status' });
  let start = 0, sortKey = null, descending = false;
  const previous = el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': t('names.previousPage'), onclick: () => { start = Math.max(0, start - PAGE_SIZE); render(); } }, t('names.previous'));
  const next = el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': t('names.nextPage'), onclick: () => { start += PAGE_SIZE; render(); } }, t('common.next'));
  const columns = [['name', 'common.name'], ['value', 'names.column.value'], ['ref', 'names.refersTo'], ['scope', 'names.scope'], ['kind', 'names.column.type']];
  for (const [key, labelKey] of columns) { const label = t(labelKey); header.append(el('th', { scope: 'col', dataset: { sort: key } },
    key === 'value' ? label : el('button', { type: 'button', 'aria-label': t('names.sortBy', { column: label }), onclick: () => {
      descending = sortKey === key ? !descending : false; sortKey = key; start = 0; render();
    } }, label))); }
  header.append(el('th', { scope: 'col' }, t('names.column.actions')));
  list.append(tableView);
  search.addEventListener('input', () => { start = 0; render(); });
  filter.addEventListener('change', () => { start = 0; render(); });
  const nameInput = el('input.input', { type: 'text', placeholder: t('names.namePlaceholder'), 'aria-label': t('common.name'), autocomplete: 'off', spellcheck: false });
  const refInput = el('input.input', { type: 'text', placeholder: 'Sheet1!$A$1:$B$5  or  =LAMBDA(x, x*2)', 'aria-label': t('names.refersTo'), autocomplete: 'off', spellcheck: false, value: ctx.wb.refTextFor(ctx.sheetId(), ctx.grid.range) || '' });
  const scopeInput = el('select.select', { 'aria-label': t('names.scope') },
    el('option', { value: '' }, t('names.workbook')),
    ...ctx.wb.sheets.map((sheet) => el('option', { value: sheet.name }, sheet.name)));
  // A name keeps its scope while it is edited: moved to a sheet, it would be gone from every
  // formula on the other sheets, and the rename that follows a new spelling cannot follow a move.
  const scopeHint = el('span.field-hint', { hidden: true }, t('names.scopeHint'));
  const { alert: error, refuse, clear: clearError } = fieldAlert('names');
  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, t('names.saveName'));
  let editor = null;
  let editing = null; // the existing name the form is changing: { name, sheet }
  const stopEditing = () => {
    editing = null; saveBtn.textContent = t('names.saveName'); cancelEdit.hidden = true; scopeInput.disabled = false; scopeHint.hidden = true;
    if (editor) { editor.panel.setAttribute('aria-label', t('names.newNameTitle')); editor.panel.querySelector('.modal-title').textContent = t('names.newNameTitle'); }
  };
  const clearForm = () => { nameInput.value = ''; refInput.value = ''; scopeInput.value = ''; clearError(); };
  // A way out of editing that keeps the name as it was: typing a different spelling while editing
  // renames the name everywhere, where a new name may have been meant.
  const cancelEdit = el('button.btn.btn-ghost', { type: 'button', hidden: true, onclick: () => { stopEditing(); clearForm(); nameInput.focus(); } }, t('names.newNameInstead'));
  // Clearing the name means starting over with a new one, not renaming the edited one to nothing.
  nameInput.addEventListener('input', () => { if (editing && !nameInput.value.trim()) stopEditing(); });

  // Previews read at most six cells of a literal, non-relative A1 reference.
  // Opening this manager must not start evaluating arbitrary named formulas.
  function preview(record) {
    if (record.kind === 'Defined name' && record.entry.relative) return '—';
    if (record.kind === 'Table' && !record.dataRange) return '{}';
    const ref = record.kind === 'Table' ? { ...record.dataRange, sheet: record.sheet.name } : ctx.wb.parseNamedRef(record.ref);
    if (ref && !ref.sheetEnd && !ref.spill) {
      const sheet = ctx.wb.sheetByName(ref.sheet);
      if (!sheet) return '#REF!';
      const r1 = ref.r1 ?? 0, c1 = ref.c1 ?? 0;
      const r2 = ref.r2 ?? sheet.rows - 1, c2 = ref.c2 ?? sheet.cols - 1;
      const values = [];
      for (let r = r1; r <= r2 && values.length < 6; r++) for (let c = c1; c <= c2 && values.length < 6; c++) values.push(ctx.wb.getDisplay(sheet.id, r, c));
      const more = (r2 - r1 + 1) * (c2 - c1 + 1) > values.length;
      return values.length === 1 && !more ? values[0] : `{${values.join('; ')}${more ? '; …' : ''}}`;
    }
    const text = record.ref.replace(/^=/, '').trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text))) return String(Number(text));
    if (/^(?:TRUE|FALSE|#REF!|#NAME\?|#VALUE!|#DIV\/0!|#N\/A|#NUM!|#NULL!)$/i.test(text)) return text.toUpperCase();
    if (/^"(?:[^"]|"")*"$/.test(text)) return text.slice(1, -1).replace(/""/g, '"');
    return '—';
  }

  function records() {
    const tables = ctx.wb.sheets.flatMap(sheet => (sheet.tables || []).map(table => {
      const rows = tableRows(table);
      const dataRange = rows.empty ? null : { ...table.range, r1: rows.dataStart, r2: rows.dataEnd };
      return { name: table.name, label: table.name, ref: ctx.wb.refTextFor(sheet.id, dataRange || table.range), scope: t('names.workbook'), kind: 'Table', kindLabel: t('names.kind.table'), sheet, table, dataRange };
    }));
    const names = ctx.wb.names.filter(n => !n.hidden).map(entry => ({ name: entry.name, label: ctx.wb.nameLabel(entry), ref: entry.ref, scope: entry.sheet || t('names.workbook'), kind: 'Defined name', kindLabel: t('names.kind.defined'), entry }));
    const term = search.value.trim().toLocaleLowerCase();
    let rows = [...tables, ...names].filter(row => (filter.value !== 'sheet' || !!row.entry?.sheet)
      && (filter.value !== 'workbook' || !row.entry?.sheet) && (filter.value !== 'defined' || !!row.entry)
      && (filter.value !== 'table' || !!row.table) && (!term || [row.label, row.ref, row.scope, row.kind, row.kindLabel, row.entry?.sheet ? '' : 'Workbook'].some(value => value.toLocaleLowerCase().includes(term))));
    if (sortKey) { const field = sortKey === 'kind' ? 'kindLabel' : sortKey; rows = rows.sort((a, b) => compareText(a[field], b[field]) * (descending ? -1 : 1)); }
    return rows;
  }

  function focusAfterDelete(index) {
    const rows = body.querySelectorAll('tr');
    (rows[Math.min(index, rows.length - 1)]?.querySelector('[data-action="delete"]') || newButton).focus({ preventScroll: true });
  }

  function render() {
    clear(body);
    const rows = records();
    start = Math.min(start, Math.max(0, Math.floor((rows.length - 1) / PAGE_SIZE) * PAGE_SIZE));
    const shown = rows.slice(start, start + PAGE_SIZE);
    summary.textContent = rows.length ? t('names.summary', { from: start + 1, to: start + shown.length, total: rows.length }) : t('names.noMatching');
    previous.hidden = next.hidden = rows.length <= PAGE_SIZE;
    previous.disabled = start === 0; next.disabled = start + PAGE_SIZE >= rows.length;
    for (const th of header.children) {
      if (th.dataset.sort === sortKey) th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    }
    if (!rows.length) {
      body.append(el('tr', {}, el('td', { colSpan: 6 }, ctx.wb.names.some(n => !n.hidden) || ctx.wb.sheets.some(s => s.tables?.length)
        ? t('names.noMatchFilters') : t('names.empty'))));
      return;
    }
    shown.forEach((record, index) => {
      const { entry: n, table, sheet, label } = record;
      const go = el('button.names-main', { type: 'button', title: table ? t('names.goToTable') : t('names.goToRange'), onclick: () => {
        modal.close(); ctx.run('goToName', table ? table.name : { name: n.name, sheet: n.sheet || null });
      } }, el('span.names-name', { dir: 'auto' }, label));
      const editButton = el('button.icon-btn', { type: 'button', html: icon('pencil', 16), 'aria-label': table ? t('names.editTable', { name: table.name }) : t('names.edit', { name: label }), dataset: { action: 'edit' }, onclick: () => {
        if (table) { modal.close(); ctx.run('editTableById', { sheetId: sheet.id, id: table.id }); return; }
        openEditor(n);
      } });
      const remove = el('button.icon-btn', { type: 'button', html: icon('trash', 16), 'aria-label': table ? t('names.convertTable', { name: table.name }) : t('names.delete', { name: label }), dataset: { action: 'delete' }, onclick: () => {
        if (table) {
          if (ctx.wb.isProtected(sheet.id)) { toast(t('names.sheetProtected', { sheet: sheet.name, name: table.name }), { icon: 'lock' }); return; }
          ctx.wb.deleteTable(sheet.id, table.id); toast(t('names.convertedTable', { name: table.name }), { icon: 'table' });
        } else {
          ctx.wb.deleteName(n.name, n.sheet);
          if (editing && editing.name.toLowerCase() === n.name.toLowerCase() && editing.sheet === (n.sheet || null)) { stopEditing(); clearForm(); }
          toast(t('names.deleted', { name: label }), { icon: 'trash' });
        }
        render(); focusAfterDelete(index);
      } });
      const value = preview(record);
      body.append(el('tr.names-review-row', {}, el('td', {}, go),
        el('td.names-value', { title: value === '—' ? t('names.previewUnavailable') : value }, value),
        el('td.names-ref', { title: record.ref }, record.ref), el('td', {}, el('span', { dir: 'auto' }, record.scope)),
        el('td', {}, record.kindLabel), el('td.names-review-actions', {}, editButton, remove)));
      go.addEventListener('keydown', e => {
        if (isComposing(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        const to = { ArrowDown: start + index + 1, ArrowUp: start + index - 1, Home: 0, End: rows.length - 1,
          PageDown: start + index + PAGE_SIZE, PageUp: start + index - PAGE_SIZE }[e.key];
        if (to == null) return;
        e.preventDefault(); e.stopPropagation();
        const target = Math.max(0, Math.min(rows.length - 1, to)); start = Math.floor(target / PAGE_SIZE) * PAGE_SIZE;
        render(); const button = body.querySelectorAll('.names-main')[target - start]; button?.focus({ preventScroll: true }); button?.scrollIntoView?.({ block: 'nearest' });
      });
    });
  }

  const submit = (e) => {
    e.preventDefault();
    if (!editor || editor.panel.closest('[inert]')) return;
    const name = nameInput.value;
    const ref = refInput.value.trim().replace(/^=/, '');
    const scope = editing ? editing.sheet : scopeInput.value || null; // an edited name stays in its scope
    // The workbook redefines an existing name given its spelling; adding one must not silently
    // retarget a name every formula already uses. The pencil edits it.
    const key = name.trim().toLowerCase();
    if (!editing && ctx.wb.names.some((n) => (n.sheet || null) === scope && n.name.toLowerCase() === key)) {
      return refuse(nameInput, t('names.alreadyUsed'));
    }
    // The workbook says which field a problem belongs to: the spelling (or a formula that binds the new spelling
    // as a variable) is the Name field's, anything else Refers to's.
    // Editing keeps one name: a new spelling renames it everywhere instead of adding a second one.
    const problem = editing ? ctx.wb.renameName(editing.name, editing.sheet, name, ref, { detail: true }) : ctx.wb.defineName(name, ref, scope, { detail: true });
    if (problem) return refuse(problem.field === 'name' ? nameInput : refInput, problem.message);
    clearError();
    toast(t('names.saved', { name: name.trim() })); // the workbook takes the spelling as typed, a change of case included
    const edited = !!editing, savedLabel = ctx.wb.nameLabel(ctx.wb.namedEntry(name.trim(), scope)).toLowerCase();
    editor.close();
    render();
    const row = [...body.children].find(row => row.querySelector('.names-name')?.textContent.toLowerCase() === savedLabel);
    (edited && row?.querySelector('[data-action="edit"]') || newButton).focus({ preventScroll: true });
  };

  // Keep the review list intact while the existing form is in a child dialog. Filters, sort and
  // pagination survive both cancellation and saving; the shared modal stack traps focus in the editor.
  const form = el('form.names-form', { onsubmit: submit },
    el('div.names-editor-fields', {},
      el('label.field', {}, el('span.field-label', {}, t('common.name')), nameInput),
      el('label.field', {}, el('span.field-label', {}, t('names.scope')), scopeInput, scopeHint),
      el('label.field', {}, el('span.field-label', {}, t('names.comment')),
        el('textarea.input', { disabled: true, rows: 3, 'aria-label': t('names.commentLabel'), placeholder: t('names.commentUnavailable') })),
      el('label.field', {}, el('span.field-label', {}, t('names.refersTo')),
        el('div.names-editor-reference', {}, refInput,
          el('button.icon-btn', { type: 'button', disabled: true, html: icon('table', 16), 'aria-label': t('names.chooseRange'), title: t('names.chooseRangeHint') })))),
    error,
    el('div.row.row-end.names-editor-footer', {}, cancelEdit,
      el('button.btn.btn-ghost', { type: 'button', onclick: () => editor?.close() }, t('common.cancel')), saveBtn));

  function openEditor(entry = null) {
    editor?.close(); stopEditing(); clearForm();
    if (entry) {
      editing = { name: entry.name, sheet: entry.sheet || null };
      saveBtn.textContent = t('names.saveChanges'); cancelEdit.hidden = false;
      nameInput.value = entry.name; refInput.value = entry.ref; scopeInput.value = entry.sheet || '';
      scopeInput.disabled = true; scopeHint.hidden = false;
    } else refInput.value = ctx.wb.refTextFor(ctx.sheetId(), ctx.grid.range) || '';
    editor = openModal({ title: entry ? t('names.editNameTitle') : t('names.newNameTitle'), content: form, className: 'names-editor', initialFocus: nameInput,
      onClose: () => { editor = null; stopEditing(); clearForm(); if (define) ctx.grid?.focus?.(); } });
    if (entry && matchMedia('(min-width: 640px)').matches) nameInput.select();
  }

  const newButton = el('button.btn', { type: 'button', 'aria-label': t('names.newName'), onclick: () => openEditor() }, t('names.newName'));
  const content = el('div', {},
    el('div.names-review-tools', {}, newButton, search, el('div.select-wrap', {}, filter)),
    el('div.row.names-review-pages', {}, summary, previous, next), list,
    el('p.field-hint', {}, t('names.previewHint')),
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.close'))));
  if (define) { openEditor(); return; }
  const modal = openModal({ title: t('names.manager'), content, wide: true, className: 'names-manager', initialFocus: newButton,
    onClose: () => { editor?.close(); ctx.grid?.focus?.(); } });
  render();
}
