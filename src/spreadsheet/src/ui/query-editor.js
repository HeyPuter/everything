/**
 * The Power Query Editor: a large window over the workbook with its own ribbon (Home, Transform, Add Column),
 * the workbook's queries on the left, the selected step's preview (first 200 rows) in the middle under a
 * formula bar, and Query Settings (the name and the Applied Steps) on the right. Column headers carry the
 * common transforms: the type button, the filter and sort drop-down, and a right-click menu. Edits are made to
 * copies of the queries; Close & Load saves them and loads (or refreshes) the tables, and closing without it
 * asks whether to keep them.
 */
import { el, isComposing } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { openMenu, closeMenu } from './menu.js';
import { toast } from './toast.js';
import { icon } from './icons.js';
import {
  evaluateQuery, sourceTable, stepNames, stepFormula, saveQuery, loadedTable, refreshQuery, queryNameProblem, uniqueQueryName,
  displayValue, keyOf, parseTyped, detectedTypeStep, initialSteps, TYPES, TYPE_LABELS, TYPE_MARKS, FILTER_OPS, AGGREGATIONS, JOIN_KINDS, PREVIEW_ROWS, sourceSummary, TEXT_COLUMN_NAMES,
} from '../core/queries.js';
import { queryIo, cellNode, loadNew, openImportData, urlProblem, fitQueryTables } from './get-data.js';
import { maxOf } from '../core/numeric.js';

const newId = () => (globalThis.crypto?.randomUUID?.() || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
const TEXT_FILTERS = ['equals', 'notEquals', 'beginsWith', 'notBeginsWith', 'endsWith', 'notEndsWith', 'contains', 'notContains'];
const NUMBER_FILTERS = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'];
const DATE_FILTERS = ['equals', 'notEquals', 'before', 'onOrBefore', 'after', 'onOrAfter'];
const filtersFor = (type) => (type === 'int' || type === 'decimal' ? NUMBER_FILTERS : type === 'date' ? DATE_FILTERS : TEXT_FILTERS);
const filterMenuName = (type) => (type === 'int' || type === 'decimal' ? 'Number Filters' : type === 'date' ? 'Date Filters' : 'Text Filters');

/** A small dialog with a form: fields, an error line, OK and Cancel. `submit` returns an error message to refuse. */
function formDialog({ title, fields, submit, okLabel = 'OK', wide = false }) {
  const { alert, refuse } = fieldAlert('pq');
  const content = el('form.pq-form', { onsubmit: (e) => {
    e.preventDefault();
    const problem = submit();
    if (problem) { refuse(problem.field || null, problem.message || problem); return; }
    modal.close();
  } }, ...fields, alert,
  el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, okLabel)));
  const modal = openModal({ title, content, wide });
  return modal;
}
const field = (label, control, extra = null) => el('label.field', {}, el('span.field-label', {}, label), control, extra);
const select = (label, options, value) => el('select.select', { 'aria-label': label }, options.map(([v, text]) => el('option', { value: v, selected: v === value }, text)));

export function openQueryEditor(ctx, { queryId = null, draft = null } = {}) {
  const { wb } = ctx;
  const drafts = clone(wb.queries || []);
  wb.queries?.forEach((q, i) => { if (q.load?.tableId) drafts[i].load.tableId = q.load.tableId; });
  const fresh = new Set();
  if (draft) { const d = clone(draft); drafts.push(d); fresh.add(d.id); queryId = d.id; }
  const touched = new Set(fresh);
  let currentId = queryId && drafts.some((q) => q.id === queryId) ? queryId : drafts[0]?.id || null;
  const stepAt = new Map();
  const sourceCache = new Map();
  let selected = [];
  let result = { table: null, error: null };
  let computing = 0;
  let downloadedAt = new Date();
  let tab = 'Home';
  let popup = null;
  const io = { ...queryIo(ctx), queries: drafts };

  const current = () => drafts.find((q) => q.id === currentId) || null;
  const stepIndex = (q = current()) => (q ? Math.min(stepAt.has(q.id) ? stepAt.get(q.id) : q.steps.length, q.steps.length) : 0);
  const table = () => result.table;
  const typeOf = (name) => table()?.types[table().columns.indexOf(name)] || 'any';
  const markDirty = (q = current()) => { if (q) touched.add(q.id); };

  /* ---------- Layout ---------- */
  const ribbonTabs = el('div.pq-tabs', { role: 'tablist', 'aria-label': 'Power Query Editor ribbon' });
  const ribbonPanel = el('div.pq-ribbon-panel', { role: 'toolbar', 'aria-label': 'Power Query Editor commands' });
  const queryList = el('div.pq-query-list', { role: 'listbox', 'aria-label': 'Queries' });
  const queriesHead = el('div.pq-side-head', {}, 'Queries');
  const formula = el('div.pq-formula-text', { title: 'The step as a Power Query formula' });
  const gridHost = el('div.pq-grid', { tabindex: 0, 'aria-label': 'Preview' });
  const nameInput = el('input.input.pq-name', { type: 'text', 'aria-label': 'Name', spellcheck: false, autocomplete: 'off' });
  const nameError = el('div.field-error', { role: 'alert', hidden: true });
  const stepList = el('ol.pq-steps', { 'aria-label': 'Applied Steps' });
  const statusLeft = el('span.pq-status-left');
  const statusRight = el('span.pq-status-right');
  const closeBtn = el('button.icon-btn.pq-close', { type: 'button', 'aria-label': 'Close', title: 'Close', html: icon('x', 18), onclick: () => requestClose() });
  const root = el('div.pq-editor', {},
    el('div.pq-titlebar', {}, el('span.pq-title', { html: icon('powerQuery', 18) }, el('span', {}, 'Power Query Editor')), closeBtn),
    el('div.pq-ribbon', {}, ribbonTabs, ribbonPanel),
    el('div.pq-body', {},
      el('aside.pq-side', { 'aria-label': 'Queries' }, queriesHead, queryList),
      el('section.pq-main', { 'aria-label': 'Preview' },
        el('div.pq-formula', {}, el('span.pq-fx', { 'aria-hidden': 'true' }, 'fx'), formula),
        gridHost),
      el('aside.pq-settings', { 'aria-label': 'Query Settings' },
        el('div.pq-settings-head', {}, 'Query Settings'),
        el('div.pq-settings-section', {}, 'PROPERTIES'),
        el('label.field', {}, el('span.field-label', {}, 'Name'), nameInput), nameError,
        el('div.pq-settings-section', {}, 'APPLIED STEPS'),
        stepList)),
    el('div.pq-status', {}, statusLeft, statusRight));

  const modal = openModal({ title: 'Power Query Editor', content: root, className: 'pq-editor-modal', initialFocus: gridHost });
  // The window closes through Close & Load or the close button's question, not a stray click beside it.
  const scrim = modal.panel.parentElement?.querySelector('.modal-scrim');
  scrim?.replaceWith(el('div.modal-scrim'));
  const onKey = (e) => {
    if (isComposing(e) || e.key !== 'Escape') return;
    const open = document.querySelectorAll('.modal-root:not(.closing)');
    if (open[open.length - 1] !== modal.panel.parentElement || document.querySelector('.menu')) return;
    e.preventDefault(); e.stopPropagation();
    if (popup) { closePopup(); return; }
    requestClose();
  };
  window.addEventListener('keydown', onKey, true);
  let finished = false;
  const finish = () => { finished = true; window.removeEventListener('keydown', onKey, true); closePopup(); modal.close(); };

  /* ---------- Ribbon ---------- */
  const needCols = (min = 1) => {
    if (selected.length >= min) return true;
    toast(min > 1 ? 'Select the columns first' : 'Select a column first', { icon: 'info' });
    return false;
  };
  const btn = (label, glyph, fn, { large = false, menu = null, title = null } = {}) => {
    const b = el('button.pq-rb', { type: 'button', title: title || label, 'aria-label': label, html: icon(glyph, large ? 28 : 16) },
      el('span.pq-rb-label', {}, label));
    if (large) b.classList.add('pq-rb-large');
    b.addEventListener('click', () => {
      if (menu) { openMenu({ anchor: b, label, items: menu() }); return; }
      fn?.();
    });
    if (menu) b.setAttribute('aria-haspopup', 'menu');
    return b;
  };
  const split = (label, glyph, fn, menu) => {
    const face = btn(label, glyph, fn, { large: true });
    const arrow = el('button.pq-rb.pq-rb-arrow', { type: 'button', 'aria-label': `${label} options`, 'aria-haspopup': 'menu', html: icon('chevD', 10) });
    arrow.addEventListener('click', () => openMenu({ anchor: arrow, label, items: menu() }));
    return el('span.pq-rb-split', {}, face, arrow);
  };
  const group = (label, ...controls) => el('div.pq-rgroup', { role: 'group', 'aria-label': label }, el('div.pq-rgroup-controls', {}, ...controls), el('div.pq-rgroup-label', {}, label));
  const typeSelect = el('select.select.pq-type-select', { 'aria-label': 'Data Type', onchange: () => { if (needCols()) changeType(selected, typeSelect.value); } },
    TYPES.map((t) => el('option', { value: t }, TYPE_LABELS[t])));
  const typeField = el('label.pq-rb-field', {}, el('span', {}, 'Data Type:'), typeSelect);
  const TABS = {
    Home: () => [
      group('Close', split('Close & Load', 'closeLoad', () => closeAndLoad(false), () => [
        { label: 'Close & Load', icon: 'closeLoad', onSelect: () => closeAndLoad(false) },
        { label: 'Close & Load To…', onSelect: () => closeAndLoad(true) }])),
      group('Query', btn('Refresh Preview', 'refresh', () => { sourceCache.clear(); compute(); }, { large: true }),
        btn('Data Source Settings', 'database', () => openSourceDialog(), { title: 'Change the source of this query' })),
      group('Manage Columns', btn('Choose Columns', 'chooseColumns', null, { large: true, menu: () => [
        { label: 'Choose Columns…', icon: 'chooseColumns', onSelect: () => chooseColumns() }] }),
      btn('Remove Columns', 'deleteCols', null, { large: true, menu: () => [
        { label: 'Remove Columns', icon: 'deleteCols', onSelect: () => removeColumns() },
        { label: 'Remove Other Columns', onSelect: () => removeOtherColumns() }] })),
      group('Reduce Rows', btn('Keep Rows', 'keepRows', null, { large: true, menu: () => [
        { label: 'Keep Top Rows…', onSelect: () => rowsCount('keepFirst') }, { label: 'Keep Bottom Rows…', onSelect: () => rowsCount('keepLast') },
        { label: 'Keep Duplicates', disabled: true, hint: 'Not available here' }] }),
      btn('Remove Rows', 'deleteRows', null, { large: true, menu: () => [
        { label: 'Remove Top Rows…', onSelect: () => rowsCount('removeFirst') }, { label: 'Remove Bottom Rows…', onSelect: () => rowsCount('removeLast') },
        { separator: true },
        { label: 'Remove Duplicates', icon: 'dedupe', onSelect: () => removeDuplicates() },
        { label: 'Remove Blank Rows', onSelect: () => addStep({ type: 'removeBlankRows' }) },
        { label: 'Remove Errors', onSelect: () => addStep({ type: 'removeErrors', columns: selected.slice() }) }] })),
      group('Sort', btn('Sort Ascending', 'sortAsc', () => needCols() && sortBy(selected[0], false)), btn('Sort Descending', 'sortDesc', () => needCols() && sortBy(selected[0], true))),
      group('Transform', btn('Split Column', 'textToColumns', null, { menu: () => [{ label: 'By Delimiter…', onSelect: () => needCols() && splitColumn(selected[0]) }] }),
        btn('Group By', 'groupBy', () => groupBy()), typeField,
        btn('Use First Row as Headers', 'promoteHeaders', null, { menu: () => [
          { label: 'Use First Row as Headers', onSelect: () => addStep({ type: 'promoteHeaders' }) },
          { label: 'Use Headers as First Row', onSelect: () => addStep({ type: 'demoteHeaders' }) }] }),
        btn('Replace Values', 'replace', () => needCols() && replaceValues())),
      group('Combine', btn('Merge Queries', 'mergeQueries', () => mergeQueries(), { large: true })),
    ],
    Transform: () => [
      group('Table', btn('Group By', 'groupBy', () => groupBy(), { large: true }),
        btn('Use First Row as Headers', 'promoteHeaders', () => addStep({ type: 'promoteHeaders' }))),
      group('Any Column', typeField, btn('Replace Values', 'replace', () => needCols() && replaceValues()),
        btn('Fill', 'fillDown', null, { menu: () => [{ label: 'Down', icon: 'fillDown', onSelect: () => needCols() && addStep({ type: 'fillDown', columns: selected.slice() }) },
          { label: 'Up', icon: 'fillUp', onSelect: () => needCols() && addStep({ type: 'fillUp', columns: selected.slice() }) }] }),
        btn('Rename', 'pencil', () => needCols() && renameColumn(selected[0]))),
      group('Text Column', btn('Split Column', 'textToColumns', null, { large: true, menu: () => [{ label: 'By Delimiter…', onSelect: () => needCols() && splitColumn(selected[0]) }] }),
        btn('Format', 'text', null, { large: true, menu: () => textMenu() })),
    ],
    'Add Column': () => [
      group('General', btn('Duplicate Column', 'copy', () => needCols() && addStep({ type: 'duplicateColumn', column: selected[0] }), { large: true }),
        btn('Index Column', 'indexColumn', null, { large: true, menu: () => [
          { label: 'From 0', onSelect: () => addIndex(0, 1) }, { label: 'From 1', onSelect: () => addIndex(1, 1) },
          { label: 'Custom…', onSelect: () => customIndex() }] })),
      group('From Text', btn('Format', 'text', null, { large: true, menu: () => textMenu(true) })),
    ],
  };
  const drawRibbon = () => {
    ribbonTabs.replaceChildren(...Object.keys(TABS).map((name) => el('button.pq-tab', { type: 'button', role: 'tab', 'aria-selected': String(name === tab),
      onclick: () => { tab = name; drawRibbon(); } }, name)));
    ribbonPanel.replaceChildren(...TABS[tab]());
    syncTypeSelect();
  };
  const syncTypeSelect = () => {
    typeSelect.value = selected.length ? typeOf(selected[0]) : 'any';
    typeSelect.disabled = !selected.length;
  };
  // Transform ▸ Format changes the selected columns; Add Column ▸ Format adds a formatted copy of the first beside them.
  const textMenu = (adding = false) => [['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['proper', 'Capitalize Each Word'], ['trim', 'Trim'], ['clean', 'Clean']]
    .map(([op, label]) => ({ label, onSelect: () => needCols() && addStep(adding ? { type: 'addTextColumn', column: selected[0], op, as: TEXT_COLUMN_NAMES[op] } : { type: 'transformText', columns: selected.slice(), op }) }));

  /* ---------- Steps ---------- */
  async function addStep(step, { replacePrevious = false } = {}) {
    const q = current();
    if (!q) return;
    const at = stepIndex(q);
    if (!replacePrevious && at < q.steps.length) {
      const ok = await askInsert();
      if (!ok) return;
    }
    if (replacePrevious && at > 0) q.steps[at - 1] = { ...q.steps[at - 1], ...step };
    else { q.steps.splice(at, 0, { id: newId(), ...step }); stepAt.set(q.id, at + 1); }
    markDirty(q);
    await compute();
  }
  const askInsert = () => new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; m.close(); resolve(v); };
    const m = openModal({ title: 'Insert Step', content: el('div', {},
      el('p.modal-text', {}, 'Are you sure you want to insert a step? Inserting an intermediate step may affect subsequent steps which could cause your query to break.'),
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => done(false) }, 'Cancel'), el('button.btn.btn-primary', { type: 'button', onclick: () => done(true) }, 'Insert'))),
    onClose: () => { if (!answered) resolve(false); } });
  });
  const previous = () => { const q = current(); const at = stepIndex(q); return at > 0 ? q.steps[at - 1] : null; };

  function changeType(columns, type) {
    const prev = previous();
    if (prev?.type === 'changeType') { addStep({ columns: { ...prev.columns, ...Object.fromEntries(columns.map((c) => [c, type])) } }, { replacePrevious: true }); return; }
    addStep({ type: 'changeType', columns: Object.fromEntries(columns.map((c) => [c, type])) });
  }
  function sortBy(column, desc) {
    const prev = previous();
    if (prev?.type === 'sortRows') {
      const keys = prev.keys.filter((k) => k.column !== column);
      addStep({ keys: [...keys, { column, desc }] }, { replacePrevious: true });
    } else addStep({ type: 'sortRows', keys: [{ column, desc }] });
  }
  function filterBy(column, conditions, join = 'and') {
    const prev = previous();
    if (prev?.type === 'filterRows' && prev.column === column) addStep({ conditions, join }, { replacePrevious: true });
    else addStep({ type: 'filterRows', column, join, conditions });
  }
  const removeColumns = () => needCols() && addStep({ type: 'removeColumns', columns: selected.slice() });
  const removeOtherColumns = () => needCols() && addStep({ type: 'selectColumns', columns: table().columns.filter((c) => selected.includes(c)) });
  const removeDuplicates = () => addStep({ type: 'removeDuplicates', columns: selected.length ? table().columns.filter((c) => selected.includes(c)) : null });
  const addIndex = (start, increment) => addStep({ type: 'addIndex', column: uniqueColumn('Index'), start, increment });
  const uniqueColumn = (base) => { const cols = table()?.columns || []; let n = base, k = 1; while (cols.includes(n)) n = `${base}.${k++}`; return n; };

  function deleteStep(index) {
    const q = current();
    const go = () => {
      q.steps.splice(index, 1);
      const at = stepIndex(q);
      if (at > index) stepAt.set(q.id, at - 1);
      markDirty(q);
      compute();
    };
    if (index === q.steps.length - 1) { go(); return; }
    let answered = false;
    const m = openModal({ title: 'Delete Step', content: el('div', {},
      el('p.modal-text', {}, 'Are you sure you want to delete this step? Any subsequent steps may cause errors.'),
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'),
        el('button.btn.btn-primary', { type: 'button', onclick: () => { answered = true; m.close(); go(); } }, 'Delete'))),
    onClose: () => { if (!answered) gridHost.focus(); } });
  }

  /* ---------- Dialogs ---------- */
  function rowsCount(type) {
    const titles = { keepFirst: ['Keep Top Rows', 'Specify how many rows to keep.'], keepLast: ['Keep Bottom Rows', 'Specify how many rows to keep.'],
      removeFirst: ['Remove Top Rows', 'Specify how many rows to remove from the top.'], removeLast: ['Remove Bottom Rows', 'Specify how many rows to remove from the bottom.'] }[type];
    const input = el('input.input', { type: 'number', min: 0, step: 1, value: '' , 'aria-label': 'Number of rows' });
    formDialog({ title: titles[0], fields: [el('p.field-hint', {}, titles[1]), field('Number of rows', input)], submit: () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 0) return { field: input, message: 'Enter a whole number' };
      addStep({ type, count: n });
      return null;
    } });
  }

  function chooseColumns() {
    const cols = table()?.columns || [];
    const boxes = cols.map((c) => el('input', { type: 'checkbox', checked: true, value: c }));
    const all = el('input', { type: 'checkbox', checked: true, onchange: () => { for (const b of boxes) b.checked = all.checked; } });
    const search = el('input.input', { type: 'search', placeholder: 'Search Columns', 'aria-label': 'Search Columns', oninput: () => {
      const t = search.value.toLowerCase();
      boxes.forEach((b) => { b.closest('label').hidden = !!t && !b.value.toLowerCase().includes(t); });
    } });
    formDialog({ title: 'Choose Columns', fields: [el('p.field-hint', {}, 'Choose the columns to keep'), search,
      el('div.pq-checklist', {}, el('label.check', {}, all, el('span', {}, '(Select All Columns)')), ...boxes.map((b) => el('label.check', {}, b, el('span', {}, b.value))))],
    submit: () => {
      const keep = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!keep.length) return 'Choose at least one column';
      addStep({ type: 'selectColumns', columns: keep });
      return null;
    } });
  }

  function replaceValues() {
    const find = el('input.input', { type: 'text', 'aria-label': 'Value To Find' });
    const repl = el('input.input', { type: 'text', 'aria-label': 'Replace With' });
    const entire = el('input', { type: 'checkbox' });
    const textual = selected.every((c) => ['text', 'any'].includes(typeOf(c)));
    formDialog({ title: 'Replace Values', fields: [el('p.field-hint', {}, 'Replace one value with another in the selected columns.'),
      field('Value To Find', find), field('Replace With', repl),
      textual ? el('details.pq-advanced', {}, el('summary', {}, 'Advanced options'), el('label.check', {}, entire, el('span', {}, 'Match entire cell contents'))) : null],
    submit: () => {
      const cols = table().columns.filter((c) => selected.includes(c));
      const one = typeOf(cols[0]);
      addStep({ type: 'replaceValues', columns: cols, find: textual ? find.value : parseTyped(find.value, one), replace: textual ? repl.value : (repl.value === '' ? null : parseTyped(repl.value, one)),
        matchEntire: textual ? entire.checked : true });
      return null;
    } });
  }

  function splitColumn(column) {
    const options = [[':', 'Colon'], [',', 'Comma'], ['=', 'Equals Sign'], [';', 'Semicolon'], [' ', 'Space'], ['\t', 'Tab'], ['', '--Custom--']];
    const sample = (table()?.rows || []).map((r) => r[table().columns.indexOf(column)]).find((v) => typeof v === 'string') || '';
    const guess = options.find(([d]) => d && sample.includes(d))?.[0] ?? ',';
    const sel = select('Select or enter delimiter', options, guess);
    const custom = el('input.input', { type: 'text', 'aria-label': 'Custom delimiter', hidden: true });
    sel.addEventListener('change', () => { custom.hidden = sel.value !== ''; });
    const mode = (v, label, checked) => el('label.check', {}, el('input', { type: 'radio', name: 'pq-split', value: v, checked }), el('span', {}, label));
    const modes = el('div.field.pq-radio-group', { role: 'radiogroup', 'aria-label': 'Split at' }, el('span.field-label', {}, 'Split at'),
      mode('left', 'Left-most delimiter', false), mode('right', 'Right-most delimiter', false), mode('each', 'Each occurrence of the delimiter', true));
    formDialog({ title: 'Split Column by Delimiter', fields: [el('p.field-hint', {}, 'Specify the delimiter used to split the text column.'),
      field('Select or enter delimiter', sel, custom), modes], submit: () => {
      const delimiter = sel.value || custom.value;
      if (!delimiter) return { field: custom, message: 'Enter a delimiter' };
      const how = modes.querySelector('input:checked').value;
      const t = table(), i = t.columns.indexOf(column);
      const parts = how === 'each' ? maxOf(t.rows.map((r) => (typeof r[i] === 'string' ? r[i].split(delimiter).length : 1)), 1) : 2;
      const step = { type: 'splitColumn', column, delimiter, mode: how, count: parts };
      addStep(step).then(() => {
        // Power Query types the new columns at once, as a Changed Type step after the split.
        const detected = table() && detectedTypeStep(table(), Array.from({ length: parts }, (_, k) => `${column}.${k + 1}`));
        if (detected) addStep({ type: 'changeType', columns: detected.columns });
      });
      return null;
    } });
  }

  function groupBy() {
    const cols = table()?.columns || [];
    if (!cols.length) return;
    const keysHost = el('div.pq-group-rows.pq-group-keys');
    const aggsHost = el('div.pq-group-rows.pq-group-aggs');
    const colSelect = (value, label) => select(label, cols.map((c) => [c, c]), value);
    const addKey = (value) => keysHost.append(el('div.pq-group-row', {}, colSelect(value, 'Group by'),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Remove grouping', html: icon('x', 14), onclick: (e) => { if (keysHost.children.length > 1) e.currentTarget.parentElement.remove(); } })));
    const addAgg = (name = 'Count', op = 'count', column = cols[0]) => {
      const opSel = select('Operation', Object.entries(AGGREGATIONS), op);
      const colSel = colSelect(column, 'Column');
      // Count Rows and Count Distinct Rows take the whole group's rows, so they have no column, as in Power Query.
      const sync = () => { colSel.disabled = opSel.value === 'count' || opSel.value === 'countDistinct'; };
      opSel.addEventListener('change', sync); sync();
      aggsHost.append(el('div.pq-group-row', {}, el('input.input', { type: 'text', value: name, 'aria-label': 'New column name' }), opSel, colSel,
        el('button.icon-btn', { type: 'button', 'aria-label': 'Remove aggregation', html: icon('x', 14), onclick: (e) => { if (aggsHost.children.length > 1) e.currentTarget.parentElement.remove(); } })));
    };
    addKey(selected[0] || cols[0]);
    addAgg();
    formDialog({ title: 'Group By', wide: true, fields: [el('p.field-hint', {}, 'Specify the columns to group by and one or more outputs.'),
      el('div.field-label', {}, 'Group by'), keysHost, el('button.btn.btn-sm', { type: 'button', onclick: () => addKey(cols[0]) }, 'Add grouping'),
      el('div.pq-group-head', {}, el('span', {}, 'New column name'), el('span', {}, 'Operation'), el('span', {}, 'Column')), aggsHost,
      el('button.btn.btn-sm', { type: 'button', onclick: () => addAgg(`Column${aggsHost.children.length + 1}`, 'sum') }, 'Add aggregation')],
    submit: () => {
      const keys = [...keysHost.querySelectorAll('select')].map((s) => s.value);
      const aggregations = [...aggsHost.children].map((row) => {
        const [name, op, column] = row.querySelectorAll('input, select');
        return { name: name.value.trim() || AGGREGATIONS[op.value], op: op.value, column: column.disabled ? '' : column.value };
      });
      addStep({ type: 'groupBy', keys: [...new Set(keys)], aggregations });
      return null;
    } });
  }

  function customIndex() {
    const start = el('input.input', { type: 'number', value: '0', 'aria-label': 'Starting Index' });
    const inc = el('input.input', { type: 'number', value: '1', 'aria-label': 'Increment' });
    formDialog({ title: 'Add Index Column', fields: [field('Starting Index', start), field('Increment', inc)], submit: () => {
      const s = Number(start.value), i = Number(inc.value);
      if (!Number.isFinite(s)) return { field: start, message: 'Enter a number' };
      if (!Number.isFinite(i)) return { field: inc, message: 'Enter a number' };
      addIndex(s, i);
      return null;
    } });
  }

  function renameColumn(column) {
    const th = gridHost.querySelector(`th[data-col="${CSS.escape(column)}"]`);
    const label = th?.querySelector('.pq-colname');
    if (!label) return;
    const input = el('input.input.pq-rename', { type: 'text', value: column, 'aria-label': `Rename ${column}` });
    label.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== column) {
        if (table().columns.includes(name)) { toast(`A column named ${name} already exists`, { icon: 'alert' }); drawGrid(); return; }
        const prev = previous();
        if (prev?.type === 'renameColumns') addStep({ renames: [...prev.renames.map(([a, b]) => (b === column ? [a, name] : [a, b])), ...(prev.renames.some(([, b]) => b === column) ? [] : [[column, name]])] }, { replacePrevious: true });
        else addStep({ type: 'renameColumns', renames: [[column, name]] });
        selected = [name];
      } else drawGrid();
    };
    input.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  }

  /** Filter Rows: one or two conditions on a column, joined with And or Or. */
  function filterDialog(column, op = null) {
    const type = typeOf(column);
    const prev = previous();
    const existing = prev?.type === 'filterRows' && prev.column === column && prev.conditions.every((c) => c.op !== 'in') ? prev : null;
    const ops = [...filtersFor(type), 'isNull', 'notNull'].map((o) => [o, FILTER_OPS[o]]);
    const values = [...new Set((table()?.rows || []).map((r) => r[table().columns.indexOf(column)]).filter((v) => v != null).map((v) => displayValue(v, type)))].slice(0, 200);
    const listId = `pq-values-${Math.random().toString(36).slice(2)}`;
    const datalist = el('datalist', { id: listId }, values.map((v) => el('option', { value: v })));
    const row = (c) => {
      const o = select('Operator', [['', ''], ...ops], c?.op || '');
      const v = el('input.input', { type: 'text', list: listId, 'aria-label': 'Value', value: c?.value == null ? '' : displayValue(c.value, type) });
      return { o, v, node: el('div.pq-filter-row', {}, o, v) };
    };
    const first = row(existing?.conditions[0] || (op ? { op } : null));
    const second = row(existing?.conditions[1]);
    const join = existing?.join || 'and';
    const joinGroup = el('div.pq-radio-group.pq-inline', { role: 'radiogroup', 'aria-label': 'And or Or' },
      el('label.check', {}, el('input', { type: 'radio', name: 'pq-join', value: 'and', checked: join === 'and' }), el('span', {}, 'And')),
      el('label.check', {}, el('input', { type: 'radio', name: 'pq-join', value: 'or', checked: join === 'or' }), el('span', {}, 'Or')));
    formDialog({ title: 'Filter Rows', wide: true, fields: [el('p.field-hint', {}, 'Apply one or more filter conditions to the rows in this table.'),
      el('p', {}, 'Keep rows where \'', el('strong', {}, column), '\''), first.node, joinGroup, second.node, datalist],
    submit: () => {
      const conds = [first, second].filter((r) => r.o.value).map((r) => ({ op: r.o.value, value: ['isNull', 'notNull'].includes(r.o.value) ? null : parseTyped(r.v.value, type) }));
      if (!conds.length) return { field: first.o, message: 'Choose a condition' };
      filterBy(column, conds, joinGroup.querySelector('input:checked').value);
      return null;
    } });
  }

  function mergeQueries() {
    const q = current();
    const others = drafts.filter((d) => d.id !== q.id);
    if (!others.length) { toast('Merge needs another query to match against. Add one with Get Data first.', { icon: 'info', duration: 4000 }); return; }
    const cols = table()?.columns || [];
    const leftSel = select('Matching column in this query', cols.map((c) => [c, c]), selected[0] || cols[0]);
    const otherSel = select('Second query', others.map((o) => [o.name, o.name]), others[0].name);
    const rightSel = el('select.select', { 'aria-label': 'Matching column in the second query' });
    const kindSel = select('Join Kind', Object.entries(JOIN_KINDS), 'leftOuter');
    const expandHost = el('div.pq-checklist');
    const note = el('p.field-hint');
    let otherTable = null;
    const loadOther = async () => {
      const other = drafts.find((d) => d.name === otherSel.value);
      const res = await evaluateQuery(wb, other, io);
      otherTable = res.table;
      const oc = otherTable?.columns || [];
      rightSel.replaceChildren(...oc.map((c) => el('option', { value: c, selected: c === leftSel.value }, c)));
      expandHost.replaceChildren(...oc.map((c) => el('label.check', {}, el('input', { type: 'checkbox', value: c, checked: true }), el('span', {}, c))));
      updateNote();
    };
    const updateNote = () => {
      if (!otherTable || !table()) { note.textContent = ''; return; }
      const li = table().columns.indexOf(leftSel.value), ri = otherTable.columns.indexOf(rightSel.value);
      if (li < 0 || ri < 0) { note.textContent = ''; return; }
      const keys = new Set(otherTable.rows.map((r) => keyOf(r[ri])));
      const hit = table().rows.filter((r) => keys.has(keyOf(r[li]))).length;
      note.textContent = `The selection matches ${hit} of ${table().rows.length} rows from the first table.`;
    };
    otherSel.addEventListener('change', loadOther);
    leftSel.addEventListener('change', updateNote); rightSel.addEventListener('change', updateNote);
    loadOther();
    formDialog({ title: 'Merge', wide: true, fields: [el('p.field-hint', {}, 'Select tables and matching columns to create a merged table.'),
      el('div.pq-merge', {}, field(q.name, leftSel), field('Second table', otherSel), field('Matching column', rightSel)),
      field('Join Kind', kindSel), el('div.field-label', {}, 'Columns to add'), expandHost, note],
    submit: () => {
      if (!rightSel.value) return { field: rightSel, message: 'Choose the matching column' };
      const expand = [...expandHost.querySelectorAll('input:checked')].map((b) => b.value);
      addStep({ type: 'merge', query: otherSel.value, left: [leftSel.value], right: [rightSel.value], kind: kindSel.value, column: otherSel.value, expand });
      return null;
    } });
  }

  /** The Source step's settings: a table or another query of this workbook, a web address, or delimited text. */
  function openSourceDialog() {
    const q = current();
    if (!q) return;
    const s = q.source;
    const tables = wb.tableNames().filter((n) => !drafts.some((d) => d.load?.table === n && d.id === q.id));
    const kinds = [['table', 'Table in this workbook'], ['query', 'Another query'], ['web', 'Web address'], ['csv', 'Text (comma-separated)']];
    if (s.kind === 'workbook') kinds.push(['workbook', `Workbook: ${s.name}`]);
    const kindSel = select('Source', kinds, s.kind === 'blank' ? 'table' : s.kind);
    const tableSel = select('Table', tables.map((n) => [n, n]), s.table || tables[0]);
    const querySel = select('Query', drafts.filter((d) => d.id !== q.id).map((d) => [d.name, d.name]), s.query);
    const url = el('input.input', { type: 'url', value: s.url || '', 'aria-label': 'URL', placeholder: 'https://example.com/data.csv' });
    const text = el('textarea.input.pq-source-text', { rows: 8, 'aria-label': 'Text', spellcheck: false }, s.kind === 'csv' ? s.text : '');
    const parts = { table: field('Table', tableSel), query: field('Query', querySel), web: field('URL', url), csv: field('Text', text), workbook: el('p.field-hint', {}, `The values of ${s.item || 'the sheet'} as they were read from ${s.name}.`) };
    const sync = () => { for (const [k, node] of Object.entries(parts)) node.hidden = k !== kindSel.value; };
    kindSel.addEventListener('change', sync);
    formDialog({ title: 'Source', wide: true, fields: [field('Source', kindSel), ...Object.values(parts)], submit: () => {
      const kind = kindSel.value;
      let next;
      if (kind === 'table') { if (!tableSel.value) return { field: tableSel, message: 'There is no table in this workbook. Create one with Insert ▸ Table.' }; next = { kind, table: tableSel.value }; }
      else if (kind === 'query') { if (!querySel.value) return { field: querySel, message: 'There is no other query' }; next = { kind, query: querySel.value }; }
      else if (kind === 'web') { const p = urlProblem(url.value); if (p) return { field: url, message: p }; next = { kind, url: url.value.trim() }; }
      else if (kind === 'csv') next = { kind, name: s.kind === 'csv' ? s.name : 'Text.csv', text: text.value, ...(s.delimiter ? { delimiter: s.delimiter } : {}) };
      else next = s;
      const wasBlank = s.kind === 'blank' && !q.steps.length;
      q.source = next;
      sourceCache.delete(q.id);
      markDirty(q);
      compute().then(() => {
        // A blank query given its first source takes the steps Power Query starts such a source with.
        if (wasBlank && table()) {
          q.steps = initialSteps(table(), { promote: kind !== 'table' && kind !== 'query' });
          stepAt.delete(q.id);
          compute();
        }
      });
      return null;
    } });
    sync();
  }

  /* ---------- Column header menus ---------- */
  function columnMenu(column) {
    const type = typeOf(column);
    const many = selected.length > 1;
    return [
      { label: many ? 'Remove Columns' : 'Remove', icon: 'deleteCols', onSelect: () => removeColumns() },
      { label: 'Remove Other Columns', onSelect: () => removeOtherColumns() },
      { label: 'Duplicate Column', icon: 'copy', disabled: many, onSelect: () => addStep({ type: 'duplicateColumn', column }) },
      { separator: true },
      { label: 'Remove Duplicates', icon: 'dedupe', onSelect: () => removeDuplicates() },
      { label: 'Remove Errors', onSelect: () => addStep({ type: 'removeErrors', columns: selected.slice() }) },
      { separator: true },
      { label: 'Change Type', submenu: TYPES.map((t) => ({ label: TYPE_LABELS[t], radio: true, checked: !many && t === type, onSelect: () => changeType(selected.slice(), t) })) },
      { label: 'Transform', submenu: textMenu() },
      { separator: true },
      { label: 'Replace Values…', icon: 'replace', onSelect: () => replaceValues() },
      { label: 'Fill', submenu: [{ label: 'Down', icon: 'fillDown', onSelect: () => addStep({ type: 'fillDown', columns: selected.slice() }) }, { label: 'Up', icon: 'fillUp', onSelect: () => addStep({ type: 'fillUp', columns: selected.slice() }) }] },
      { separator: true },
      { label: 'Group By…', icon: 'groupBy', onSelect: () => groupBy() },
      { label: 'Split Column', disabled: many, submenu: [{ label: 'By Delimiter…', onSelect: () => splitColumn(column) }] },
      { separator: true },
      { label: 'Rename…', icon: 'pencil', disabled: many, onSelect: () => renameColumn(column) },
    ];
  }

  function tableMenu() {
    return [
      { label: 'Use First Row as Headers', icon: 'promoteHeaders', onSelect: () => addStep({ type: 'promoteHeaders' }) },
      { label: 'Use Headers as First Row', onSelect: () => addStep({ type: 'demoteHeaders' }) },
      { separator: true },
      { label: 'Add Index Column', submenu: [{ label: 'From 0', onSelect: () => addIndex(0, 1) }, { label: 'From 1', onSelect: () => addIndex(1, 1) }, { label: 'Custom…', onSelect: () => customIndex() }] },
      { label: 'Choose Columns…', icon: 'chooseColumns', onSelect: () => chooseColumns() },
      { separator: true },
      { label: 'Keep Top Rows…', onSelect: () => rowsCount('keepFirst') },
      { label: 'Remove Top Rows…', onSelect: () => rowsCount('removeFirst') },
      { label: 'Remove Duplicates', icon: 'dedupe', onSelect: () => addStep({ type: 'removeDuplicates', columns: null }) },
      { label: 'Remove Blank Rows', onSelect: () => addStep({ type: 'removeBlankRows' }) },
      { separator: true },
      { label: 'Group By…', icon: 'groupBy', onSelect: () => groupBy() },
      { label: 'Merge Queries…', icon: 'mergeQueries', onSelect: () => mergeQueries() },
    ];
  }

  function closePopup() { popup?.remove(); popup = null; document.removeEventListener('pointerdown', outside, true); }
  function outside(e) { if (popup && !popup.contains(e.target) && !e.target.closest?.('.menu')) closePopup(); }

  /** The filter drop-down: sort, the type's filters, and the column's values to keep. */
  function filterPopup(column, anchor) {
    closePopup();
    const t = table(), i = t.columns.indexOf(column), type = typeOf(column);
    const counts = new Map();
    for (const r of t.rows) { const k = keyOf(r[i]); if (!counts.has(k)) counts.set(k, r[i]); }
    const values = [...counts.values()].slice(0, 1000);
    const prev = previous();
    const kept = prev?.type === 'filterRows' && prev.column === column && prev.conditions.length === 1 && prev.conditions[0].op === 'in' ? new Set(prev.conditions[0].values.map(keyOf)) : null;
    const boxes = values.map((v) => el('input', { type: 'checkbox', checked: kept ? kept.has(keyOf(v)) : true }));
    boxes.forEach((b, n) => { b._value = values[n]; });
    const all = el('input', { type: 'checkbox', checked: boxes.every((b) => b.checked), onchange: () => { for (const b of boxes) if (!b.closest('label').hidden) b.checked = all.checked; } });
    const search = el('input.input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search values', oninput: () => {
      const q = search.value.toLowerCase();
      boxes.forEach((b) => { b.closest('label').hidden = !!q && !displayValue(b._value, type).toLowerCase().includes(q); });
    } });
    const act = (label, fn, glyph = null) => el('button.pq-pop-item', { type: 'button', html: glyph ? icon(glyph, 16) : '', onclick: () => { closePopup(); fn(); } }, el('span', {}, label));
    const filtersBtn = el('button.pq-pop-item.pq-pop-sub', { type: 'button', 'aria-haspopup': 'menu' }, el('span', {}, filterMenuName(type)), el('span', { html: icon('chevR', 12) }));
    filtersBtn.addEventListener('click', () => openMenu({ anchor: filtersBtn, align: 'start', label: filterMenuName(type),
      items: [...filtersFor(type).map((op) => ({ label: `${FILTER_OPS[op][0].toUpperCase()}${FILTER_OPS[op].slice(1)}…`, onSelect: () => { closePopup(); filterDialog(column, op); } })),
        { separator: true }, { label: 'Custom Filter…', onSelect: () => { closePopup(); filterDialog(column); } }] }));
    const truncated = counts.size >= 1000;
    popup = el('div.pq-popup', { role: 'dialog', 'aria-label': `Filter ${column}` },
      act('Sort Ascending', () => sortBy(column, false), 'sortAsc'),
      act('Sort Descending', () => sortBy(column, true), 'sortDesc'),
      el('div.pq-pop-sep'),
      act('Clear Filter', () => {
        const q = current(), at = stepIndex(q);
        const last = at > 0 ? q.steps[at - 1] : null;
        if (last?.type === 'filterRows' && last.column === column) deleteStep(at - 1);
      }, 'filterClear'),
      act('Remove Empty', () => filterBy(column, [{ op: 'notBlank' }])),
      filtersBtn,
      search,
      el('div.pq-checklist.pq-pop-list', {}, el('label.check', {}, all, el('span', {}, '(Select All)')),
        ...boxes.map((b) => el('label.check', {}, b, el('span', {}, displayValue(b._value, type))))),
      truncated ? el('p.field-hint', {}, 'List may be incomplete.') : null,
      el('div.row.row-end', {},
        el('button.btn.btn-primary', { type: 'button', onclick: () => {
          const keep = boxes.filter((b) => b.checked).map((b) => b._value);
          closePopup();
          if (keep.length === boxes.length && !truncated) return;
          filterBy(column, [{ op: 'in', values: keep }]);
        } }, 'OK'),
        el('button.btn', { type: 'button', onclick: () => closePopup() }, 'Cancel')));
    root.append(popup);
    const a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
    popup.style.left = `${Math.max(4, Math.min(a.left - r.left, r.width - 280))}px`;
    popup.style.top = `${a.bottom - r.top + 2}px`;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    search.focus();
  }

  /* ---------- Rendering ---------- */
  function drawQueries() {
    queriesHead.textContent = `Queries [${drafts.length}]`;
    queryList.replaceChildren(...drafts.map((q) => {
      const item = el('button.pq-query', { type: 'button', role: 'option', 'aria-selected': String(q.id === currentId), title: sourceSummary(q),
        html: icon('table', 16), onclick: () => { if (q.id !== currentId) { currentId = q.id; selected = []; compute(); } } });
      item.append(el('span', {}, q.name));
      if (touched.has(q.id)) item.classList.add('pq-changed');
      return item;
    }));
  }

  function drawSteps() {
    const q = current();
    if (!q) { stepList.replaceChildren(); return; }
    const names = stepNames(q), at = stepIndex(q);
    stepList.replaceChildren(...names.map((name, i) => {
      const failed = result.error && (result.error.step + 1 === i || (result.error.step === -1 && i === 0)) && i === at;
      const li = el('li.pq-step', { 'aria-current': i === at ? 'step' : null },
        el('button.pq-step-name', { type: 'button', onclick: () => { stepAt.set(q.id, i); compute(); },
          oncontextmenu: (e) => { e.preventDefault(); stepMenu(i, e); } }, name),
        i === 0 ? el('button.icon-btn.pq-step-gear', { type: 'button', title: 'Source settings', 'aria-label': 'Source settings', html: icon('sliders', 14), onclick: () => openSourceDialog() }) : null,
        i > 0 ? el('button.icon-btn.pq-step-delete', { type: 'button', title: `Delete ${name}`, 'aria-label': `Delete ${name}`, html: icon('x', 14), onclick: () => deleteStep(i - 1) }) : null);
      if (failed) li.classList.add('pq-step-error');
      return li;
    }));
  }

  function stepMenu(i, e) {
    const q = current();
    if (i === 0) { openMenu({ x: e.clientX, y: e.clientY, label: 'Source', items: [{ label: 'Edit Settings', onSelect: () => openSourceDialog() }] }); return; }
    const k = i - 1;
    openMenu({ x: e.clientX, y: e.clientY, label: 'Step', items: [
      { label: 'Rename', icon: 'pencil', onSelect: () => {
        const input = el('input.input', { type: 'text', value: stepNames(q)[i], 'aria-label': 'Step name' });
        formDialog({ title: 'Rename Step', fields: [field('Name', input)], submit: () => {
          const name = input.value.trim();
          if (!name) return { field: input, message: 'Enter a name' };
          if (stepNames(q).some((n, j) => j !== i && n.toLowerCase() === name.toLowerCase())) return { field: input, message: 'Another step has that name' };
          q.steps[k].name = name; markDirty(q); drawSteps(); drawFormula();
          return null;
        } });
      } },
      { label: 'Delete', onSelect: () => deleteStep(k) },
      { label: 'Delete Until End', onSelect: () => { q.steps.splice(k); stepAt.delete(q.id); markDirty(q); compute(); } },
      { separator: true },
      { label: 'Move Before', disabled: k === 0, onSelect: () => { [q.steps[k - 1], q.steps[k]] = [q.steps[k], q.steps[k - 1]]; stepAt.set(q.id, i - 1); markDirty(q); compute(); } },
      { label: 'Move After', disabled: k === q.steps.length - 1, onSelect: () => { [q.steps[k + 1], q.steps[k]] = [q.steps[k], q.steps[k + 1]]; stepAt.set(q.id, i + 1); markDirty(q); compute(); } },
    ] });
  }

  function drawFormula() {
    const q = current();
    formula.textContent = q ? stepFormula(q, stepIndex(q)) : '';
  }

  function drawGrid() {
    const q = current();
    if (!q) {
      gridHost.replaceChildren(el('div.pq-empty', {}, el('p', {}, 'There are no queries in this workbook yet.'), el('p.muted', {}, 'Close this window and choose Data ▸ Get Data to start one.')));
      return;
    }
    if (q.source.kind === 'blank' && !q.steps.length) {
      gridHost.replaceChildren(el('div.pq-empty', {}, el('p', {}, 'This query has no source yet.'),
        el('button.btn.btn-primary', { type: 'button', onclick: () => openSourceDialog() }, 'Choose a source…')));
      return;
    }
    const t = result.table;
    if (result.error && (!t || result.error.step + 1 === stepIndex(q) || result.error.step === -1)) {
      gridHost.replaceChildren(el('div.pq-error-box', { role: 'alert' }, el('span', { html: icon('alert', 18) }), el('div', {},
        el('strong', {}, result.error.message.split(':')[0].includes('.') ? result.error.message.split(':')[0] : 'Expression.Error'),
        el('p', {}, result.error.message.includes(':') ? result.error.message.slice(result.error.message.indexOf(':') + 1).trim() : result.error.message),
        result.error.step >= 0 ? el('button.btn.btn-sm', { type: 'button', onclick: () => { stepAt.set(q.id, result.error.step); compute(); } }, 'Go To Error') : null)));
      return;
    }
    if (!t) { gridHost.replaceChildren(); return; }
    const corner = el('th.pq-corner', {}, el('button.pq-table-btn', { type: 'button', 'aria-label': 'Table actions', title: 'Table actions', html: icon('table', 14),
      onclick: (e) => openMenu({ anchor: e.currentTarget, label: 'Table', items: tableMenu() }) }));
    const heads = t.columns.map((name, i) => {
      const type = t.types[i];
      const typeBtn = el('button.pq-type', { type: 'button', title: TYPE_LABELS[type], 'aria-label': `${name} type: ${TYPE_LABELS[type]}` }, TYPE_MARKS[type].replace('\n', ''));
      typeBtn.addEventListener('click', (e) => { e.stopPropagation(); pick(name, e, true); openMenu({ anchor: typeBtn, label: 'Data Type', items: TYPES.map((tp) => ({ label: TYPE_LABELS[tp], radio: true, checked: tp === type, onSelect: () => changeType(selected.slice(), tp) })) }); });
      const filterBtn = el('button.pq-filter', { type: 'button', 'aria-label': `Filter ${name}`, title: 'Filter and sort', html: icon('chevD', 12) });
      filterBtn.addEventListener('click', (e) => { e.stopPropagation(); pick(name, e, true); filterPopup(name, filterBtn); });
      const th = el('th.pq-col', { dataset: { col: name }, 'aria-selected': String(selected.includes(name)), tabindex: -1 }, typeBtn, el('span.pq-colname', {}, name), filterBtn);
      th.addEventListener('click', (e) => pick(name, e));
      th.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) renameColumn(name); });
      th.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!selected.includes(name)) pick(name, e); openMenu({ x: e.clientX, y: e.clientY, label: name, items: columnMenu(name) }); });
      return th;
    });
    const rows = t.rows.slice(0, PREVIEW_ROWS).map((row, n) => el('tr', {}, el('th.pq-rownum', {}, String(n + 1)),
      ...t.columns.map((name, i) => { const td = cellNode(row[i], t.types[i]); if (selected.includes(name)) td.classList.add('pq-selcol'); return td; })));
    gridHost.replaceChildren(el('table.pq-table.pq-live', {}, el('thead', {}, el('tr', {}, corner, ...heads)), el('tbody', {}, ...rows)));
  }

  function pick(name, e, keep = false) {
    const cols = table()?.columns || [];
    if (keep && selected.includes(name)) return;
    if (e?.shiftKey && selected.length) {
      const a = cols.indexOf(selected[selected.length - 1]), b = cols.indexOf(name);
      selected = cols.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else if (e && (e.ctrlKey || e.metaKey)) selected = selected.includes(name) ? selected.filter((c) => c !== name) : [...selected, name];
    else selected = [name];
    for (const th of gridHost.querySelectorAll('th.pq-col')) th.setAttribute('aria-selected', String(selected.includes(th.dataset.col)));
    for (const tr of gridHost.querySelectorAll('tbody tr')) [...tr.children].slice(1).forEach((td, i) => td.classList.toggle('pq-selcol', selected.includes(cols[i])));
    syncTypeSelect();
  }

  function drawStatus() {
    const t = result.table;
    statusLeft.textContent = t && !result.error ? `${t.columns.length} COLUMN${t.columns.length === 1 ? '' : 'S'}, ${t.rows.length > 999 ? '999+' : t.rows.length} ROW${t.rows.length === 1 ? '' : 'S'}` : '';
    statusRight.textContent = `PREVIEW DOWNLOADED AT ${downloadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase()}`;
  }

  function drawName() {
    const q = current();
    nameInput.value = q?.name || '';
    nameInput.disabled = !q;
    nameError.hidden = true;
  }

  async function compute() {
    const token = ++computing;
    const q = current();
    drawQueries(); drawName(); drawRibbon();
    if (!q) { result = { table: null, error: null }; drawSteps(); drawFormula(); drawGrid(); drawStatus(); return; }
    let base = null;
    const key = JSON.stringify(q.source);
    if (['csv', 'web', 'workbook'].includes(q.source.kind)) {
      const cached = sourceCache.get(q.id);
      if (cached?.key === key) base = cached.table;
      else {
        try { base = await sourceTable(wb, q, io); sourceCache.set(q.id, { key, table: base }); downloadedAt = new Date(); } catch { base = null; }
      }
    }
    const res = await evaluateQuery(wb, q, io, { upTo: stepIndex(q), base });
    if (token !== computing || finished) return;
    result = res;
    const cols = res.table?.columns || [];
    selected = selected.filter((c) => cols.includes(c));
    drawSteps(); drawFormula(); drawGrid(); drawStatus(); syncTypeSelect();
  }

  /* ---------- Name ---------- */
  const commitName = () => {
    const q = current();
    if (!q) return;
    const name = nameInput.value.trim();
    if (name === q.name) { nameError.hidden = true; return; }
    const problem = queryNameProblem({ queries: drafts }, name, q.id);
    if (problem) { nameError.textContent = problem; nameError.hidden = false; return; }
    const old = q.name;
    q.name = name;
    for (const other of drafts) {
      if (other.source.kind === 'query' && other.source.query.toLowerCase() === old.toLowerCase()) { other.source.query = name; markDirty(other); }
      for (const s of other.steps) if (s.type === 'merge' && s.query.toLowerCase() === old.toLowerCase()) { s.query = name; markDirty(other); }
    }
    markDirty(q);
    nameError.hidden = true;
    drawQueries();
  };
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('keydown', (e) => { if (!isComposing(e) && e.key === 'Enter') { e.preventDefault(); commitName(); } });

  gridHost.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'Delete' && selected.length) { e.preventDefault(); removeColumns(); }
    if (e.key === 'F2' && selected.length === 1) { e.preventDefault(); renameColumn(selected[0]); }
  });

  /* ---------- Close ---------- */
  /** Write the edited queries back; returns the stored ones that changed. */
  function commit() {
    const saved = [];
    for (const q of drafts) {
      if (!touched.has(q.id) || fresh.has(q.id)) continue;
      saved.push(saveQuery(wb, q));
    }
    return saved;
  }

  async function closeAndLoad(to) {
    commitName();
    if (!nameError.hidden) return;
    const saved = commit();
    const freshOnes = drafts.filter((q) => fresh.has(q.id));
    const cur = current();
    finish();
    for (const q of freshOnes) {
      if (to && q.id === cur?.id) { openImportData(ctx, { query: q, fresh: true }); continue; }
      await loadNew(ctx, { ...q, name: uniqueQueryName(wb, q.name, q.id) }, null);
    }
    for (const q of saved) {
      if (to && q.id === cur?.id) { openImportData(ctx, { query: q }); continue; }
      if (q.load?.kind === 'table' && loadedTable(wb, q)) {
        const res = await refreshQuery(wb, q, queryIo(ctx));
        if (res.error) toast(`${q.name}: ${res.error}`, { icon: 'alert', duration: 5000 });
        else fitQueryTables(ctx, [q]);
      }
    }
    if (to && cur && !fresh.has(cur.id) && !saved.some((q) => q.id === cur.id)) openImportData(ctx, { query: cur });
    ctx.onQueriesChanged?.();
  }

  function requestClose() {
    if (!touched.size) { finish(); ctx.grid?.focus?.(); return; }
    const m = openModal({ title: 'Power Query Editor', content: el('div', {},
      el('p.modal-text', {}, 'Do you want to keep your changes?'),
      el('div.row.row-end', {},
        el('button.btn.btn-primary', { type: 'button', onclick: () => { m.close(); closeAndLoad(false); } }, 'Keep'),
        el('button.btn', { type: 'button', onclick: () => { m.close(); finish(); ctx.grid?.focus?.(); } }, 'Discard'),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'))) });
  }

  drawRibbon();
  const ready = compute();
  return { close: finish, ready, root, get query() { return current(); }, get result() { return result; }, select: (names) => { selected = names.slice(); drawGrid(); syncTypeSelect(); } };
}
