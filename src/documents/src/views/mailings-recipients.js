/**
 * Recipient lists: typing a new list in a grid, customizing its columns, and the Edit Recipient List
 * dialog (include or exclude rows, sort, filter, find duplicates, check addresses).
 */
import { el, fieldId, isComposing } from '../ui/dom.js';
import { dialog, field, select, input, checkbox, button } from './mailings-ui.js';
import { visibleRows, duplicateRows, validateAddresses, FILTER_OPERATORS, DEFAULT_COLUMNS, autoMatchFields } from '../engine/merge-fields.js';

/** Enter in a list's search field only searches: it must not submit, and close, the dialog around it. */
const stayOnEnter = e => { if (e.key === 'Enter' && !isComposing(e)) e.preventDefault(); };

const PAGE = 200;
const clone = list => structuredClone(list);

/**
 * The grid editor for a list's entries (Type a New List, Edit entries). onSave(list, renamed) receives the
 * edited copy and, for each of the list's original column names, its name now (null when it was removed).
 */
export function openRecipientGrid({ list, title = 'New Address List', onSave }) {
  const draft = clone(list || { columns: [...DEFAULT_COLUMNS], rows: [], sort: [], filters: [] });
  const renamed = new Map(draft.columns.map(column => [column, column]));
  if (!draft.rows.length) draft.rows.push({ values: draft.columns.map(() => ''), included: true });
  let page = 0, query = '';
  const table = el('table.mm-grid', { role: 'grid', 'aria-label': 'Recipient entries' });
  const status = el('span.mm-grid-status', { role: 'status' });
  const pager = el('div.mm-pager');
  const matches = () => draft.rows.map((row, i) => i).filter(i => !query || draft.rows[i].values.some(v => String(v).toLowerCase().includes(query)));
  let focusCell = null;
  function render() {
    const rows = matches(), pages = Math.max(1, Math.ceil(rows.length / PAGE));
    page = Math.min(page, pages - 1);
    const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
    table.replaceChildren(
      el('thead', {}, el('tr', {}, el('th.mm-grid-num', { scope: 'col' }, '#'), ...draft.columns.map(c => el('th', { scope: 'col' }, c)))),
      el('tbody', {}, ...shown.map(index => el('tr', { 'data-row': index },
        el('th.mm-grid-num', { scope: 'row' }, String(index + 1)),
        ...draft.columns.map((column, c) => el('td', {}, el('input.mm-cell', { type: 'text', value: draft.rows[index].values[c] ?? '', 'aria-label': `${column}, entry ${index + 1}`, autocomplete: 'off', spellcheck: 'false',
          oninput: e => { draft.rows[index].values[c] = e.target.value; }, onfocus: () => { focusCell = { index, c }; } })))))));
    status.textContent = `${draft.rows.length} ${draft.rows.length === 1 ? 'entry' : 'entries'}${query ? ` · ${rows.length} shown` : ''}`;
    pager.replaceChildren(...(pages > 1 ? [button('Previous', () => { page--; render(); }, 'btn-ghost', { disabled: page === 0 }), el('span', {}, `Page ${page + 1} of ${pages}`), button('Next', () => { page++; render(); }, 'btn-ghost', { disabled: page >= pages - 1 })] : []));
  }
  const focus = (index, c = 0) => queueMicrotask(() => table.querySelector(`tr[data-row="${index}"] td:nth-of-type(${c + 1}) input`)?.focus());
  const addEntry = () => {
    draft.rows.push({ values: draft.columns.map(() => ''), included: true });
    query = ''; search.value = ''; page = Math.floor((draft.rows.length - 1) / PAGE); render(); focus(draft.rows.length - 1);
  };
  const deleteEntry = () => {
    const index = focusCell?.index ?? draft.rows.length - 1;
    if (index < 0 || !draft.rows[index]) return;
    draft.rows.splice(index, 1);
    if (!draft.rows.length) draft.rows.push({ values: draft.columns.map(() => ''), included: true });
    render(); focus(Math.min(index, draft.rows.length - 1), focusCell?.c ?? 0);
  };
  // Enter moves down a column; on the last entry it starts a new one.
  table.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches('.mm-cell')) return;
    e.preventDefault();
    const { index, c } = focusCell || {};
    if (index === undefined) return;
    if (index === draft.rows.length - 1) addEntry(); else focus(index + 1, c);
  });
  const search = input('', { type: 'search', placeholder: 'Find in list', 'aria-label': 'Find in list', oninput: () => { query = search.value.trim().toLowerCase(); page = 0; render(); }, onkeydown: stayOnEnter });
  const customize = button('Customize Columns…', () => openColumns(draft.columns, (columns, mapping) => {
    draft.rows = draft.rows.map(row => ({ ...row, values: mapping.map(from => from === null ? '' : row.values[from] ?? '') }));
    for (const [original, current] of renamed) {
      const at = mapping.indexOf(draft.columns.indexOf(current));
      renamed.set(original, current !== null && at >= 0 ? columns[at] : null);
    }
    draft.columns = columns;
    draft.sort = (draft.sort || []).filter(s => columns.includes(s.column));
    draft.filters = (draft.filters || []).filter(f => columns.includes(f.column));
    render();
  }));
  render();
  const modal = dialog({ title, size: 'xwide', submit: 'OK', body: [
    el('div.mm-toolbar', {}, button('New Entry', addEntry), button('Delete Entry', deleteEntry), customize, el('span.grow'), search),
    el('div.mm-grid-wrap', {}, table), el('div.mm-grid-foot', {}, status, pager),
  ], onSubmit: () => {
    const rows = draft.rows.filter(row => row.values.some(v => String(v).trim()));
    if (!rows.length) throw new Error('Type at least one entry, or press Cancel.');
    onSave({ ...draft, rows: rows.map(row => ({ ...row, values: row.values.map(v => String(v ?? '').trim()) })) }, renamed);
  }, focus: table.querySelector('input') });
  return modal;
}

/** Rename, add, remove and reorder columns. onDone(columns, mapping) where mapping[i] is the old index of new column i, or null. */
export function openColumns(columns, onDone) {
  let entries = columns.map((name, i) => ({ name, from: i }));
  let selected = 0;
  const listbox = el('div.mm-columns', { role: 'listbox', 'aria-label': 'Columns', tabindex: 0 });
  const optionId = fieldId('mm-column');
  const render = () => {
    listbox.replaceChildren(...entries.map((entry, i) => el('div.mm-column-item', { role: 'option', id: `${optionId}-${i}`, 'aria-selected': String(i === selected), onclick: () => { selected = i; render(); } }, entry.name)));
    // Focus stays on the list; the chosen column is its active option for assistive technology.
    if (entries[selected]) listbox.setAttribute('aria-activedescendant', `${optionId}-${selected}`); else listbox.removeAttribute('aria-activedescendant');
  };
  listbox.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(entries.length - 1, selected + 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); render(); }
  });
  const name = input('', { 'aria-label': 'Column name', placeholder: 'Column name' });
  const unique = (value, except = -1) => !entries.some((e, i) => i !== except && e.name.toLowerCase() === value.toLowerCase());
  const add = () => {
    const value = name.value.trim(); if (!value) { name.focus(); return; }
    if (!unique(value)) { modal.error('A column with that name already exists.'); return; }
    entries.splice(selected + 1, 0, { name: value, from: null }); selected++; name.value = ''; modal.error(''); render();
  };
  const rename = () => {
    const value = name.value.trim(); if (!value || !entries[selected]) return;
    if (!unique(value, selected)) { modal.error('A column with that name already exists.'); return; }
    entries[selected].name = value; name.value = ''; modal.error(''); render();
  };
  const remove = () => { if (entries.length <= 1) { modal.error('A list needs at least one column.'); return; } entries.splice(selected, 1); selected = Math.min(selected, entries.length - 1); render(); };
  const move = d => { const to = selected + d; if (to < 0 || to >= entries.length) return; [entries[selected], entries[to]] = [entries[to], entries[selected]]; selected = to; render(); };
  render();
  const modal = dialog({ title: 'Customize Columns', body: [
    el('div.mm-columns-layout', {}, listbox, el('div.mm-column-buttons', {},
      button('Move Up', () => move(-1)), button('Move Down', () => move(1)), button('Delete', remove))),
    el('div.mm-inline', {}, field('Name', name), button('Add', add), button('Rename', rename)),
    el('p.field-hint', {}, 'Removing a column removes its values from every entry.'),
  ], onSubmit: () => onDone(entries.map(e => e.name), entries.map(e => e.from)) });
  return modal;
}

/** Choose a worksheet from a workbook with several. Resolves the index, or null. */
export function chooseSheet(names) {
  return new Promise(resolve => {
    let chosen = null;
    const choice = select(names.map((n, i) => [String(i), n]), '0', { 'aria-label': 'Worksheet' });
    dialog({ title: 'Choose a Worksheet', body: [el('p.modal-text', {}, 'This workbook has several sheets. Choose the one with your recipients; its first row should hold the column names.'), field('Worksheet', choice)],
      onSubmit: () => { chosen = Number(choice.value); }, onClose: () => resolve(chosen) });
  });
}

/**
 * The Edit Recipient List dialog. `state` is the mail merge state; onApply(list, mapping) saves.
 * Includes sorting by column, filters, duplicates, address checks and editing entries.
 */
export function openRecipientList({ state, onApply, onEditEntries }) {
  const draft = clone(state.list);
  const mapping = { ...(state.mapping && Object.keys(state.mapping).length ? state.mapping : autoMatchFields(draft.columns)) };
  let query = '', page = 0;
  const table = el('table.mm-grid.mm-recipients', { 'aria-label': 'Recipients' });
  const summary = el('span.mm-grid-status', { role: 'status' });
  const pager = el('div.mm-pager');
  const sortState = column => { const key = draft.sort?.[0]; return key?.column === column ? (key.descending ? 'descending' : 'ascending') : 'none'; };
  const sortBy = column => {
    const current = sortState(column);
    draft.sort = current === 'none' ? [{ column, descending: false }] : current === 'ascending' ? [{ column, descending: true }] : [];
    render();
  };
  function rows() {
    const visible = visibleRows(draft);
    return query ? visible.filter(({ row }) => row.values.some(v => String(v).toLowerCase().includes(query))) : visible;
  }
  function render() {
    const list = rows(), pages = Math.max(1, Math.ceil(list.length / PAGE));
    page = Math.min(page, pages - 1);
    // Sorting or including every row redraws the table: keyboard focus returns to the same control.
    const focusKey = table.contains(document.activeElement) || pager.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') || document.activeElement.title || document.activeElement.textContent : null;
    const all = list.length && list.every(({ row }) => row.included !== false);
    const allBox = el('input', { type: 'checkbox', 'aria-label': 'Include all shown recipients', onchange: e => { for (const { row } of list) row.included = e.target.checked; render(); } });
    allBox.checked = !!all; allBox.indeterminate = !all && list.some(({ row }) => row.included !== false);
    table.replaceChildren(
      el('thead', {}, el('tr', {}, el('th.mm-grid-check', { scope: 'col' }, allBox), ...draft.columns.map(column => el('th', { scope: 'col', 'aria-sort': sortState(column) },
        el('button.mm-sort', { type: 'button', onclick: () => sortBy(column), title: `Sort by ${column}` }, column, el('span.mm-sort-mark', { 'aria-hidden': 'true' }, { ascending: ' ▲', descending: ' ▼', none: '' }[sortState(column)])))))),
      el('tbody', {}, ...list.slice(page * PAGE, page * PAGE + PAGE).map(({ row, number }) => {
        const box = el('input', { type: 'checkbox', 'aria-label': `Include recipient ${number}`, onchange: e => { row.included = e.target.checked; renderSummary(); } });
        box.checked = row.included !== false;
        return el('tr', { class: row.included === false ? 'is-excluded' : '' }, el('td.mm-grid-check', {}, box), ...draft.columns.map((_, i) => el('td', {}, row.values[i] ?? '')));
      })));
    pager.replaceChildren(...(pages > 1 ? [button('Previous', () => { page--; render(); }, 'btn-ghost', { disabled: page === 0 }), el('span', {}, `Page ${page + 1} of ${pages}`), button('Next', () => { page++; render(); }, 'btn-ghost', { disabled: page >= pages - 1 })] : []));
    renderSummary();
    if (focusKey) [...table.querySelectorAll('button, input'), ...pager.querySelectorAll('button')].find(control => !control.disabled && (control.getAttribute('aria-label') || control.title || control.textContent) === focusKey)?.focus();
  }
  function renderSummary() {
    const included = visibleRows(draft).filter(({ row }) => row.included !== false).length;
    const filtered = (draft.filters || []).length ? ' · filtered' : '';
    summary.textContent = `${included} of ${draft.rows.length} recipients will be merged${filtered}`;
  }
  const search = input('', { type: 'search', placeholder: 'Find recipient', 'aria-label': 'Find recipient', oninput: () => { query = search.value.trim().toLowerCase(); page = 0; render(); }, onkeydown: stayOnEnter });
  const source = state.source?.name ? `Data source: ${state.source.name}` : state.source?.kind === 'typed' ? 'Data source: typed in this document' : 'Data source: stored in this document';
  render();
  const modal = dialog({ title: 'Mail Merge Recipients', size: 'xwide', submit: 'OK', body: [
    el('p.field-hint', {}, `${source}. Clear a check box to leave a recipient out; select a column name to sort.`),
    el('div.mm-toolbar', {},
      button('Sort and Filter…', () => openFilter(draft, render)),
      button('Find Duplicates…', () => openDuplicates(draft, render)),
      button('Check Addresses…', () => openValidation(draft, mapping)),
      button('Edit Entries…', () => onEditEntries(draft, (edited, renamed) => {
        Object.assign(draft, edited);
        // Field matching follows renamed columns, and forgets removed ones, rather than naming columns that are gone.
        for (const [key, column] of Object.entries(mapping)) {
          const now = renamed?.has(column) ? renamed.get(column) : column;
          if (now && draft.columns.includes(now)) mapping[key] = now; else delete mapping[key];
        }
        render();
      })),
      el('span.grow'), search),
    el('div.mm-grid-wrap', {}, table), el('div.mm-grid-foot', {}, summary, pager),
  ], onSubmit: () => onApply(draft, mapping) });
  return modal;
}

/** Sort keys and filter conditions for a list (edited in place). */
export function openFilter(list, done) {
  const columns = [['', '(none)'], ...list.columns.map(c => [c, c])];
  const conditions = el('div.mm-conditions');
  const rows = [];
  const addRow = (filter = {}) => {
    const join = select([['and', 'And'], ['or', 'Or']], filter.join || 'and', { 'aria-label': 'Join' });
    const column = select(columns, filter.column || '', { 'aria-label': 'Field' });
    const operator = select(FILTER_OPERATORS, filter.operator || 'equals', { 'aria-label': 'Comparison' });
    const value = input(filter.value || '', { 'aria-label': 'Compare to' });
    const sync = () => { value.disabled = ['empty', 'notEmpty'].includes(operator.value); };
    operator.addEventListener('change', sync); sync();
    const row = el('div.mm-condition', {}, join, column, operator, value);
    rows.push({ join, column, operator, value });
    if (rows.length === 1) join.style.visibility = 'hidden';
    conditions.append(row);
  };
  for (const filter of list.filters || []) addRow(filter);
  while (rows.length < 3) addRow();
  const keys = [0, 1, 2].map(i => {
    const key = list.sort?.[i] || {};
    return { column: select(columns, key.column || '', { 'aria-label': `Sort by, key ${i + 1}` }), order: select([['asc', 'Ascending'], ['desc', 'Descending']], key.descending ? 'desc' : 'asc', { 'aria-label': `Order, key ${i + 1}` }) };
  });
  return dialog({ title: 'Sort and Filter', size: 'wide', body: [
    el('h3.mm-subhead', {}, 'Filter records'), conditions, el('div.row', {}, button('Add Condition', () => addRow())),
    el('h3.mm-subhead', {}, 'Sort records'), el('div.mm-sort-keys', {}, ...keys.map((k, i) => el('div.mm-condition', {}, el('span.mm-key-label', {}, i ? 'Then by' : 'Sort by'), k.column, k.order))),
  ], actions: [button('Clear All', () => { for (const r of rows) { r.column.value = ''; r.value.value = ''; } for (const k of keys) k.column.value = ''; })],
  onSubmit: () => {
    list.filters = rows.filter(r => r.column.value).map(r => ({ column: r.column.value, operator: r.operator.value, value: r.value.value, join: r.join.value }));
    list.sort = keys.filter(k => k.column.value).map(k => ({ column: k.column.value, descending: k.order.value === 'desc' }));
    done();
  } });
}

/** Groups of matching entries; clearing a check box leaves that duplicate out of the merge. */
export function openDuplicates(list, done) {
  const columns = el('div.mm-chips', { role: 'group', 'aria-label': 'Compare columns' });
  const boxes = list.columns.map(c => { const box = checkbox(c, /name|address|street|city|zip|postal|email/i.test(c)); columns.append(box); return box; });
  const result = el('div.mm-duplicates');
  const choices = new Map();
  const find = () => {
    const chosen = list.columns.filter((_, i) => boxes[i].input.checked);
    const groups = chosen.length ? duplicateRows(list, chosen) : [];
    choices.clear();
    result.replaceChildren(groups.length ? el('p.field-hint', {}, `${groups.length} ${groups.length === 1 ? 'group' : 'groups'} of matching entries. Keep the entries you want to merge.`) : el('p.field-hint', {}, 'No duplicate entries.'),
      ...groups.map((group, g) => el('fieldset.mm-dup-group', {}, el('legend', {}, `Group ${g + 1}`), ...group.map((number, i) => {
        const row = list.rows[number - 1];
        const box = checkbox(`${number}. ${row.values.filter(Boolean).slice(0, 4).join(', ')}`, i === 0);
        choices.set(number, box.input);
        return box;
      }))));
  };
  for (const b of boxes) b.input.addEventListener('change', find);
  find();
  return dialog({ title: 'Find Duplicates', size: 'wide', body: [el('p.field-hint', {}, 'Entries match when these columns have the same values, ignoring capitals and extra spaces.'), columns, result], onSubmit: () => {
    for (const [number, box] of choices) list.rows[number - 1].included = box.checked;
    done();
  } });
}

/** A report of entries whose addresses look incomplete. */
export function openValidation(list, mapping) {
  const report = validateAddresses(list, mapping);
  return dialog({ title: 'Check Addresses', submit: null, cancel: 'Close', size: 'wide', body: report.length
    ? [el('p.field-hint', {}, `${report.length} of the included entries may need attention. These are simple checks for missing parts and common formats; they do not look addresses up.`),
      el('ul.mm-report', {}, ...report.slice(0, 300).map(r => el('li', {}, el('strong', {}, `Entry ${r.number}: `), list.rows[r.number - 1].values.filter(Boolean).slice(0, 3).join(', '), el('br'), el('span.muted', {}, r.problems.join(' · ')))))]
    : [el('p.modal-text', {}, 'Every included entry has a name, street, city and postal code where those columns are matched.')] });
}
