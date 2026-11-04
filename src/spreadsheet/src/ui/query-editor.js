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
import { t, tRich, formatDate } from '../i18n/index.js';
import {
  evaluateQuery, sourceTable, stepNames, stepFormula, saveQuery, loadedTable, refreshQuery, queryNameProblem, uniqueQueryName,
  displayValue, keyOf, parseTyped, detectedTypeStep, initialSteps, TYPES, typeLabel, TYPE_MARKS, DATE_TYPES, filterOpLabel, AGGREGATIONS, aggregationLabel,
  JOIN_KINDS, joinKindLabel, PREVIEW_ROWS, sourceSummary, TEXT_COLUMN_NAMES,
} from '../core/queries.js';
import { queryIo, cellNode, loadNew, openImportData, urlProblem, fitQueryTables } from './get-data.js';
import { maxOf } from '../core/numeric.js';

const newId = () => (globalThis.crypto?.randomUUID?.() || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
const TEXT_FILTERS = ['equals', 'notEquals', 'beginsWith', 'notBeginsWith', 'endsWith', 'notEndsWith', 'contains', 'notContains'];
const NUMBER_FILTERS = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'];
const DATE_FILTERS = ['equals', 'notEquals', 'before', 'onOrBefore', 'after', 'onOrAfter'];
const filtersFor = (type) => (type === 'int' || type === 'decimal' ? NUMBER_FILTERS : DATE_TYPES.has(type) ? DATE_FILTERS : TEXT_FILTERS);
const filterMenuName = (type) => (type === 'int' || type === 'decimal' ? t('queryEditor.filters.number') : type === 'time' ? t('queryEditor.filters.time') : DATE_TYPES.has(type) ? t('queryEditor.filters.date') : t('queryEditor.filters.text'));
/** The filter drop-down's condition items ("Does not equal…"), as catalog keys. */
const FILTER_MENU = {
  equals: 'queryEditor.filterMenu.equals', notEquals: 'queryEditor.filterMenu.notEquals', beginsWith: 'queryEditor.filterMenu.beginsWith',
  notBeginsWith: 'queryEditor.filterMenu.notBeginsWith', endsWith: 'queryEditor.filterMenu.endsWith', notEndsWith: 'queryEditor.filterMenu.notEndsWith',
  contains: 'queryEditor.filterMenu.contains', notContains: 'queryEditor.filterMenu.notContains', gt: 'queryEditor.filterMenu.gt', gte: 'queryEditor.filterMenu.gte',
  lt: 'queryEditor.filterMenu.lt', lte: 'queryEditor.filterMenu.lte', before: 'queryEditor.filterMenu.before', onOrBefore: 'queryEditor.filterMenu.onOrBefore',
  after: 'queryEditor.filterMenu.after', onOrAfter: 'queryEditor.filterMenu.onOrAfter',
};
/** The ribbon's tabs (their names are the editor's ids for them) and the label each shows. */
const TAB_LABELS = { Home: 'queryEditor.tab.home', Transform: 'queryEditor.tab.transform', 'Add Column': 'queryEditor.tab.addColumn' };
/** Transform ▸ Format and Add Column ▸ Format: each operation and its label's catalog key. */
const TEXT_FORMATS = [['lower', 'queryEditor.textFormat.lower'], ['upper', 'queryEditor.textFormat.upper'], ['proper', 'queryEditor.textFormat.proper'],
  ['trim', 'queryEditor.textFormat.trim'], ['clean', 'queryEditor.textFormat.clean']];
/** The delimiters Split Column offers, as Power Query lists them, and their labels' catalog keys. */
const SPLIT_DELIMITERS = [[':', 'getData.delimiter.colon'], [',', 'getData.delimiter.comma'], ['=', 'getData.delimiter.equals'], [';', 'getData.delimiter.semicolon'],
  [' ', 'getData.delimiter.space'], ['\t', 'getData.delimiter.tab'], ['', 'getData.delimiter.custom']];

/** A small dialog with a form: fields, an error line, OK and Cancel. `submit` returns an error message to refuse. */
function formDialog({ title, fields, submit, okLabel = t('common.ok'), wide = false }) {
  const { alert, refuse } = fieldAlert('pq');
  const content = el('form.pq-form', { onsubmit: (e) => {
    e.preventDefault();
    const problem = submit();
    if (problem) { refuse(problem.field || null, problem.message || problem); return; }
    modal.close();
  } }, ...fields, alert,
  el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')), el('button.btn.btn-primary', { type: 'submit' }, okLabel)));
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
  const ribbonTabs = el('div.pq-tabs', { role: 'tablist', 'aria-label': t('queryEditor.ribbonLabel') });
  const ribbonPanel = el('div.pq-ribbon-panel', { role: 'toolbar', 'aria-label': t('queryEditor.commandsLabel') });
  const queryList = el('div.pq-query-list', { role: 'listbox', 'aria-label': t('queryEditor.queries') });
  const queriesHead = el('div.pq-side-head', {}, t('queryEditor.queries'));
  const formula = el('div.pq-formula-text', { title: t('queryEditor.formulaTitle') });
  const gridHost = el('div.pq-grid', { tabindex: 0, 'aria-label': t('common.preview') });
  const nameInput = el('input.input.pq-name', { type: 'text', 'aria-label': t('common.name'), spellcheck: false, autocomplete: 'off' });
  const nameError = el('div.field-error', { role: 'alert', hidden: true });
  const stepList = el('ol.pq-steps', { 'aria-label': t('queryEditor.appliedSteps') });
  const statusLeft = el('span.pq-status-left');
  const statusRight = el('span.pq-status-right');
  const closeBtn = el('button.icon-btn.pq-close', { type: 'button', 'aria-label': t('common.close'), title: t('common.close'), html: icon('x', 18), onclick: () => requestClose() });
  const root = el('div.pq-editor', {},
    el('div.pq-titlebar', {}, el('span.pq-title', { html: icon('powerQuery', 18) }, el('span', {}, t('queryEditor.title'))), closeBtn),
    el('div.pq-ribbon', {}, ribbonTabs, ribbonPanel),
    el('div.pq-body', {},
      el('aside.pq-side', { 'aria-label': t('queryEditor.queries') }, queriesHead, queryList),
      el('section.pq-main', { 'aria-label': t('common.preview') },
        el('div.pq-formula', {}, el('span.pq-fx', { 'aria-hidden': 'true' }, 'fx'), formula),
        gridHost),
      el('aside.pq-settings', { 'aria-label': t('queryEditor.querySettings') },
        el('div.pq-settings-head', {}, t('queryEditor.querySettings')),
        el('div.pq-settings-section', {}, t('queryEditor.propertiesHead')),
        el('label.field', {}, el('span.field-label', {}, t('common.name')), nameInput), nameError,
        el('div.pq-settings-section', {}, t('queryEditor.appliedStepsHead')),
        stepList)),
    el('div.pq-status', {}, statusLeft, statusRight));

  const modal = openModal({ title: t('queryEditor.title'), content: root, className: 'pq-editor-modal', initialFocus: gridHost });
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
    toast(min > 1 ? t('queryEditor.selectColumnsFirst') : t('queryEditor.selectColumnFirst'), { icon: 'info' });
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
    const arrow = el('button.pq-rb.pq-rb-arrow', { type: 'button', 'aria-label': t('queryEditor.splitOptions', { label }), 'aria-haspopup': 'menu', html: icon('chevD', 10) });
    arrow.addEventListener('click', () => openMenu({ anchor: arrow, label, items: menu() }));
    return el('span.pq-rb-split', {}, face, arrow);
  };
  const group = (label, ...controls) => el('div.pq-rgroup', { role: 'group', 'aria-label': label }, el('div.pq-rgroup-controls', {}, ...controls), el('div.pq-rgroup-label', {}, label));
  const typeSelect = el('select.select.pq-type-select', { 'aria-label': t('queryEditor.dataType'), onchange: () => { if (needCols()) changeType(selected, typeSelect.value); } },
    TYPES.map((ty) => el('option', { value: ty }, typeLabel(ty))));
  const typeField = el('label.pq-rb-field', {}, el('span', {}, t('queryEditor.dataTypeField')), typeSelect);
  const TABS = {
    Home: () => [
      group(t('common.close'), split(t('queryEditor.closeLoad'), 'closeLoad', () => closeAndLoad(false), () => [
        { label: t('queryEditor.closeLoad'), icon: 'closeLoad', onSelect: () => closeAndLoad(false) },
        { label: t('queryEditor.closeLoadTo'), onSelect: () => closeAndLoad(true) }])),
      group(t('queryEditor.query'), btn(t('queryEditor.refreshPreview'), 'refresh', () => { sourceCache.clear(); compute(); }, { large: true }),
        btn(t('queryEditor.dataSourceSettings'), 'database', () => openSourceDialog(), { title: t('queryEditor.changeSource') })),
      group(t('queryEditor.manageColumns'), btn(t('queryEditor.chooseColumns'), 'chooseColumns', null, { large: true, menu: () => [
        { label: t('queryEditor.chooseColumnsDialog'), icon: 'chooseColumns', onSelect: () => chooseColumns() }] }),
      btn(t('queryEditor.removeColumns'), 'deleteCols', null, { large: true, menu: () => [
        { label: t('queryEditor.removeColumns'), icon: 'deleteCols', onSelect: () => removeColumns() },
        { label: t('queryEditor.removeOtherColumns'), onSelect: () => removeOtherColumns() }] })),
      group(t('queryEditor.reduceRows'), btn(t('queryEditor.keepRows'), 'keepRows', null, { large: true, menu: () => [
        { label: t('queryEditor.keepTopRowsDialog'), onSelect: () => rowsCount('keepFirst') }, { label: t('queryEditor.keepBottomRowsDialog'), onSelect: () => rowsCount('keepLast') },
        { label: t('queryEditor.keepDuplicates'), disabled: true, hint: t('queryEditor.notAvailable') }] }),
      btn(t('queryEditor.removeRows'), 'deleteRows', null, { large: true, menu: () => [
        { label: t('queryEditor.removeTopRowsDialog'), onSelect: () => rowsCount('removeFirst') }, { label: t('queryEditor.removeBottomRowsDialog'), onSelect: () => rowsCount('removeLast') },
        { separator: true },
        { label: t('queryEditor.removeDuplicates'), icon: 'dedupe', onSelect: () => removeDuplicates() },
        { label: t('queryEditor.removeBlankRows'), onSelect: () => addStep({ type: 'removeBlankRows' }) },
        { label: t('queryEditor.removeErrors'), onSelect: () => addStep({ type: 'removeErrors', columns: selected.slice() }) }] })),
      group(t('queryEditor.sort'), btn(t('queryEditor.sortAscending'), 'sortAsc', () => needCols() && sortBy(selected[0], false)), btn(t('queryEditor.sortDescending'), 'sortDesc', () => needCols() && sortBy(selected[0], true))),
      group(t('queryEditor.transform'), btn(t('queryEditor.splitColumn'), 'textToColumns', null, { menu: () => [{ label: t('queryEditor.byDelimiter'), onSelect: () => needCols() && splitColumn(selected[0]) }] }),
        btn(t('queryEditor.groupBy'), 'groupBy', () => groupBy()), typeField,
        btn(t('queryEditor.useFirstRowAsHeaders'), 'promoteHeaders', null, { menu: () => [
          { label: t('queryEditor.useFirstRowAsHeaders'), onSelect: () => addStep({ type: 'promoteHeaders' }) },
          { label: t('queryEditor.useHeadersAsFirstRow'), onSelect: () => addStep({ type: 'demoteHeaders' }) }] }),
        btn(t('queryEditor.replaceValues'), 'replace', () => needCols() && replaceValues())),
      group(t('queryEditor.combine'), btn(t('queryEditor.mergeQueries'), 'mergeQueries', () => mergeQueries(), { large: true })),
    ],
    Transform: () => [
      group(t('queryEditor.table'), btn(t('queryEditor.groupBy'), 'groupBy', () => groupBy(), { large: true }),
        btn(t('queryEditor.useFirstRowAsHeaders'), 'promoteHeaders', () => addStep({ type: 'promoteHeaders' }))),
      group(t('queryEditor.anyColumn'), typeField, btn(t('queryEditor.replaceValues'), 'replace', () => needCols() && replaceValues()),
        btn(t('queryEditor.fill'), 'fillDown', null, { menu: () => [{ label: t('queryEditor.fillDown'), icon: 'fillDown', onSelect: () => needCols() && addStep({ type: 'fillDown', columns: selected.slice() }) },
          { label: t('queryEditor.fillUp'), icon: 'fillUp', onSelect: () => needCols() && addStep({ type: 'fillUp', columns: selected.slice() }) }] }),
        btn(t('common.rename'), 'pencil', () => needCols() && renameColumn(selected[0]))),
      group(t('queryEditor.textColumn'), btn(t('queryEditor.splitColumn'), 'textToColumns', null, { large: true, menu: () => [{ label: t('queryEditor.byDelimiter'), onSelect: () => needCols() && splitColumn(selected[0]) }] }),
        btn(t('queryEditor.format'), 'text', null, { large: true, menu: () => textMenu() })),
    ],
    'Add Column': () => [
      group(t('queryEditor.general'), btn(t('queryEditor.duplicateColumn'), 'copy', () => needCols() && addStep({ type: 'duplicateColumn', column: selected[0] }), { large: true }),
        btn(t('queryEditor.indexColumn'), 'indexColumn', null, { large: true, menu: () => [
          { label: t('queryEditor.fromZero'), onSelect: () => addIndex(0, 1) }, { label: t('queryEditor.fromOne'), onSelect: () => addIndex(1, 1) },
          { label: t('queryEditor.customIndex'), onSelect: () => customIndex() }] })),
      group(t('queryEditor.fromText'), btn(t('queryEditor.format'), 'text', null, { large: true, menu: () => textMenu(true) })),
    ],
  };
  const drawRibbon = () => {
    ribbonTabs.replaceChildren(...Object.keys(TABS).map((name) => el('button.pq-tab', { type: 'button', role: 'tab', 'aria-selected': String(name === tab),
      onclick: () => { tab = name; drawRibbon(); } }, t(TAB_LABELS[name]))));
    ribbonPanel.replaceChildren(...TABS[tab]());
    syncTypeSelect();
  };
  const syncTypeSelect = () => {
    typeSelect.value = selected.length ? typeOf(selected[0]) : 'any';
    typeSelect.disabled = !selected.length;
  };
  // Transform ▸ Format changes the selected columns; Add Column ▸ Format adds a formatted copy of the first beside them.
  const textMenu = (adding = false) => TEXT_FORMATS
    .map(([op, label]) => ({ label: t(label), onSelect: () => needCols() && addStep(adding ? { type: 'addTextColumn', column: selected[0], op, as: TEXT_COLUMN_NAMES[op] } : { type: 'transformText', columns: selected.slice(), op }) }));

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
    const m = openModal({ title: t('queryEditor.insertStep.title'), content: el('div', {},
      el('p.modal-text', {}, t('queryEditor.insertStep.message')),
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => done(false) }, t('common.cancel')), el('button.btn.btn-primary', { type: 'button', onclick: () => done(true) }, t('common.insert')))),
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
  /**
   * `replace`: the conditions were read from the column's filter step just before (the dialog it filled in, the
   * list it ticked) and take its place; other conditions are a filter of their own on what that step left, so the
   * rows it took out stay out.
   */
  function filterBy(column, conditions, join = 'and', { replace = false } = {}) {
    const prev = previous();
    if (replace && prev?.type === 'filterRows' && prev.column === column) addStep({ conditions, join }, { replacePrevious: true });
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
    const m = openModal({ title: t('queryEditor.deleteStep.title'), content: el('div', {},
      el('p.modal-text', {}, t('queryEditor.deleteStep.message')),
      el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => m.close() }, t('common.cancel')),
        el('button.btn.btn-primary', { type: 'button', onclick: () => { answered = true; m.close(); go(); } }, t('common.delete')))),
    onClose: () => { if (!answered) gridHost.focus(); } });
  }

  /* ---------- Dialogs ---------- */
  function rowsCount(type) {
    const titles = { keepFirst: [t('queryEditor.rows.keepTop'), t('queryEditor.rows.keepHint')], keepLast: [t('queryEditor.rows.keepBottom'), t('queryEditor.rows.keepHint')],
      removeFirst: [t('queryEditor.rows.removeTop'), t('queryEditor.rows.removeTopHint')], removeLast: [t('queryEditor.rows.removeBottom'), t('queryEditor.rows.removeBottomHint')] }[type];
    const input = el('input.input', { type: 'number', min: 0, step: 1, value: '' , 'aria-label': t('queryEditor.rows.count') });
    formDialog({ title: titles[0], fields: [el('p.field-hint', {}, titles[1]), field(t('queryEditor.rows.count'), input)], submit: () => {
      // An empty box is no count: read as 0, Keep Top Rows kept none of them.
      const n = input.value.trim() === '' ? NaN : Number(input.value);
      if (!Number.isInteger(n) || n < 0) return { field: input, message: t('queryEditor.rows.notWhole') };
      addStep({ type, count: n });
      return null;
    } });
  }

  function chooseColumns() {
    const cols = table()?.columns || [];
    const boxes = cols.map((c) => el('input', { type: 'checkbox', checked: true, value: c }));
    const all = el('input', { type: 'checkbox', checked: true, onchange: () => { for (const b of boxes) b.checked = all.checked; } });
    const search = el('input.input', { type: 'search', placeholder: t('queryEditor.choose.search'), 'aria-label': t('queryEditor.choose.search'), oninput: () => {
      const needle = search.value.toLowerCase();
      boxes.forEach((b) => { b.closest('label').hidden = !!needle && !b.value.toLowerCase().includes(needle); });
    } });
    formDialog({ title: t('queryEditor.chooseColumns'), fields: [el('p.field-hint', {}, t('queryEditor.choose.hint')), search,
      el('div.pq-checklist', {}, el('label.check', {}, all, el('span', {}, t('queryEditor.choose.all'))), ...boxes.map((b) => el('label.check', {}, b, el('span', {}, b.value))))],
    submit: () => {
      const keep = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!keep.length) return t('queryEditor.choose.none');
      addStep({ type: 'selectColumns', columns: keep });
      return null;
    } });
  }

  function replaceValues() {
    const find = el('input.input', { type: 'text', 'aria-label': t('queryEditor.replace.find') });
    const repl = el('input.input', { type: 'text', 'aria-label': t('queryEditor.replace.with') });
    const entire = el('input', { type: 'checkbox' });
    const textual = selected.every((c) => ['text', 'any'].includes(typeOf(c)));
    formDialog({ title: t('queryEditor.replaceValues'), fields: [el('p.field-hint', {}, t('queryEditor.replace.hint')),
      field(t('queryEditor.replace.find'), find), field(t('queryEditor.replace.with'), repl),
      textual ? el('details.pq-advanced', {}, el('summary', {}, t('queryEditor.replace.advanced')), el('label.check', {}, entire, el('span', {}, t('queryEditor.replace.matchEntire')))) : null],
    submit: () => {
      const cols = table().columns.filter((c) => selected.includes(c));
      const one = typeOf(cols[0]);
      addStep({ type: 'replaceValues', columns: cols, find: textual ? find.value : parseTyped(find.value, one), replace: textual ? repl.value : (repl.value === '' ? null : parseTyped(repl.value, one)),
        matchEntire: textual ? entire.checked : true });
      return null;
    } });
  }

  function splitColumn(column) {
    const options = SPLIT_DELIMITERS.map(([d, label]) => [d, t(label)]);
    const sample = (table()?.rows || []).map((r) => r[table().columns.indexOf(column)]).find((v) => typeof v === 'string') || '';
    const guess = options.find(([d]) => d && sample.includes(d))?.[0] ?? ',';
    const sel = select(t('queryEditor.split.delimiter'), options, guess);
    const custom = el('input.input', { type: 'text', 'aria-label': t('getData.customDelimiter'), hidden: true });
    sel.addEventListener('change', () => { custom.hidden = sel.value !== ''; });
    const mode = (v, label, checked) => el('label.check', {}, el('input', { type: 'radio', name: 'pq-split', value: v, checked }), el('span', {}, label));
    const modes = el('div.field.pq-radio-group', { role: 'radiogroup', 'aria-label': t('queryEditor.split.at') }, el('span.field-label', {}, t('queryEditor.split.at')),
      mode('left', t('queryEditor.split.left'), false), mode('right', t('queryEditor.split.right'), false), mode('each', t('queryEditor.split.each'), true));
    formDialog({ title: t('queryEditor.split.title'), fields: [el('p.field-hint', {}, t('queryEditor.split.hint')),
      field(t('queryEditor.split.delimiter'), sel, custom), modes], submit: () => {
      const delimiter = sel.value || custom.value;
      if (!delimiter) return { field: custom, message: t('queryEditor.split.noDelimiter') };
      const how = modes.querySelector('input:checked').value;
      const tbl = table(), i = tbl.columns.indexOf(column);
      const parts = how === 'each' ? maxOf(tbl.rows.map((r) => (typeof r[i] === 'string' ? r[i].split(delimiter).length : 1)), 1) : 2;
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
    const addKey = (value) => keysHost.append(el('div.pq-group-row', {}, colSelect(value, t('queryEditor.group.by')),
      el('button.icon-btn', { type: 'button', 'aria-label': t('queryEditor.group.removeKey'), html: icon('x', 14), onclick: (e) => { if (keysHost.children.length > 1) e.currentTarget.parentElement.remove(); } })));
    const addAgg = (name = 'Count', op = 'count', column = cols[0]) => {
      const opSel = select(t('queryEditor.group.operation'), Object.keys(AGGREGATIONS).map((k) => [k, aggregationLabel(k)]), op);
      const colSel = colSelect(column, t('queryEditor.group.column'));
      // Count Rows and Count Distinct Rows take the whole group's rows, so they have no column, as in Power Query.
      const sync = () => { colSel.disabled = opSel.value === 'count' || opSel.value === 'countDistinct'; };
      opSel.addEventListener('change', sync); sync();
      aggsHost.append(el('div.pq-group-row', {}, el('input.input', { type: 'text', value: name, 'aria-label': t('queryEditor.group.newName') }), opSel, colSel,
        el('button.icon-btn', { type: 'button', 'aria-label': t('queryEditor.group.removeAggregation'), html: icon('x', 14), onclick: (e) => { if (aggsHost.children.length > 1) e.currentTarget.parentElement.remove(); } })));
    };
    addKey(selected[0] || cols[0]);
    addAgg();
    formDialog({ title: t('queryEditor.groupBy'), wide: true, fields: [el('p.field-hint', {}, t('queryEditor.group.hint')),
      el('div.field-label', {}, t('queryEditor.group.by')), keysHost, el('button.btn.btn-sm', { type: 'button', onclick: () => addKey(cols[0]) }, t('queryEditor.group.addKey')),
      el('div.pq-group-head', {}, el('span', {}, t('queryEditor.group.newName')), el('span', {}, t('queryEditor.group.operation')), el('span', {}, t('queryEditor.group.column'))), aggsHost,
      el('button.btn.btn-sm', { type: 'button', onclick: () => addAgg(`Column${aggsHost.children.length + 1}`, 'sum') }, t('queryEditor.group.addAggregation'))],
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
    const start = el('input.input', { type: 'number', value: '0', 'aria-label': t('queryEditor.index.start') });
    const inc = el('input.input', { type: 'number', value: '1', 'aria-label': t('queryEditor.index.increment') });
    formDialog({ title: t('queryEditor.index.title'), fields: [field(t('queryEditor.index.start'), start), field(t('queryEditor.index.increment'), inc)], submit: () => {
      // An emptied box is no number (Number('') is 0, which made every index the same).
      const read = (input) => (input.value.trim() === '' ? NaN : Number(input.value));
      const s = read(start), i = read(inc);
      if (!Number.isFinite(s)) return { field: start, message: t('queryEditor.index.notNumber') };
      if (!Number.isFinite(i)) return { field: inc, message: t('queryEditor.index.notNumber') };
      addIndex(s, i);
      return null;
    } });
  }

  function renameColumn(column) {
    const th = gridHost.querySelector(`th[data-col="${CSS.escape(column)}"]`);
    const label = th?.querySelector('.pq-colname');
    if (!label) return;
    const input = el('input.input.pq-rename', { type: 'text', value: column, 'aria-label': t('queryEditor.renameColumn', { column }) });
    label.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== column) {
        if (table().columns.includes(name)) { toast(t('queryEditor.columnExists', { name }), { icon: 'alert' }); drawGrid(); return; }
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
    const existing = prev?.type === 'filterRows' && prev.column === column && prev.conditions.every((c) => c.op !== 'in' && c.op !== 'notIn') ? prev : null;
    const ops = [...filtersFor(type), 'isNull', 'notNull'].map((o) => [o, filterOpLabel(o)]);
    const values = [...new Set((table()?.rows || []).map((r) => r[table().columns.indexOf(column)]).filter((v) => v != null).map((v) => displayValue(v, type)))].slice(0, 200);
    const listId = `pq-values-${Math.random().toString(36).slice(2)}`;
    const datalist = el('datalist', { id: listId }, values.map((v) => el('option', { value: v })));
    const row = (c) => {
      const o = select(t('queryEditor.filter.operator'), [['', ''], ...ops], c?.op || '');
      const v = el('input.input', { type: 'text', list: listId, 'aria-label': t('common.value'), value: c?.value == null ? '' : displayValue(c.value, type) });
      return { o, v, node: el('div.pq-filter-row', {}, o, v) };
    };
    const first = row(existing?.conditions[0] || (op ? { op } : null));
    const second = row(existing?.conditions[1]);
    const join = existing?.join || 'and';
    const joinGroup = el('div.pq-radio-group.pq-inline', { role: 'radiogroup', 'aria-label': t('queryEditor.filter.join') },
      el('label.check', {}, el('input', { type: 'radio', name: 'pq-join', value: 'and', checked: join === 'and' }), el('span', {}, t('queryEditor.filter.and'))),
      el('label.check', {}, el('input', { type: 'radio', name: 'pq-join', value: 'or', checked: join === 'or' }), el('span', {}, t('queryEditor.filter.or'))));
    formDialog({ title: t('queryEditor.filter.title'), wide: true, fields: [el('p.field-hint', {}, t('queryEditor.filter.hint')),
      el('p', {}, ...tRich('queryEditor.filter.keepWhere', { column, strong: (c) => el('strong', {}, c) })), first.node, joinGroup, second.node, datalist],
    submit: () => {
      const conds = [first, second].filter((r) => r.o.value).map((r) => ({ op: r.o.value, value: ['isNull', 'notNull'].includes(r.o.value) ? null : parseTyped(r.v.value, type) }));
      if (!conds.length) return { field: first.o, message: t('queryEditor.filter.noCondition') };
      filterBy(column, conds, joinGroup.querySelector('input:checked').value, { replace: !!existing });
      return null;
    } });
  }

  function mergeQueries() {
    const q = current();
    const others = drafts.filter((d) => d.id !== q.id);
    if (!others.length) { toast(t('queryEditor.merge.noOther'), { icon: 'info', duration: 4000 }); return; }
    const cols = table()?.columns || [];
    const leftSel = select(t('queryEditor.merge.leftColumn'), cols.map((c) => [c, c]), selected[0] || cols[0]);
    const otherSel = select(t('queryEditor.merge.otherQuery'), others.map((o) => [o.name, o.name]), others[0].name);
    const rightSel = el('select.select', { 'aria-label': t('queryEditor.merge.rightColumnLabel') });
    const kindSel = select(t('queryEditor.merge.joinKind'), Object.keys(JOIN_KINDS).map((k) => [k, joinKindLabel(k)]), 'leftOuter');
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
      note.textContent = t('queryEditor.merge.matches', { hit, total: table().rows.length });
    };
    otherSel.addEventListener('change', loadOther);
    leftSel.addEventListener('change', updateNote); rightSel.addEventListener('change', updateNote);
    loadOther();
    formDialog({ title: t('queryEditor.merge.title'), wide: true, fields: [el('p.field-hint', {}, t('queryEditor.merge.hint')),
      el('div.pq-merge', {}, field(q.name, leftSel), field(t('queryEditor.merge.otherTable'), otherSel), field(t('queryEditor.merge.rightColumn'), rightSel)),
      field(t('queryEditor.merge.joinKind'), kindSel), el('div.field-label', {}, t('queryEditor.merge.expand')), expandHost, note],
    submit: () => {
      if (!rightSel.value) return { field: rightSel, message: t('queryEditor.merge.noColumn') };
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
    const kinds = [['table', t('queryEditor.source.table')], ['query', t('queryEditor.source.query')], ['web', t('queryEditor.source.web')], ['csv', t('queryEditor.source.csv')]];
    if (s.kind === 'workbook') kinds.push(['workbook', t('queryEditor.source.workbook', { name: s.name })]);
    const kindSel = select(t('queryEditor.source.title'), kinds, s.kind === 'blank' ? 'table' : s.kind);
    const tableSel = select(t('queryEditor.table'), tables.map((n) => [n, n]), s.table || tables[0]);
    const querySel = select(t('queryEditor.query'), drafts.filter((d) => d.id !== q.id).map((d) => [d.name, d.name]), s.query);
    const url = el('input.input', { type: 'url', value: s.url || '', 'aria-label': t('queryEditor.source.url'), placeholder: 'https://example.com/data.csv' });
    const text = el('textarea.input.pq-source-text', { rows: 8, 'aria-label': t('queryEditor.source.text'), spellcheck: false }, s.kind === 'csv' ? s.text : '');
    const parts = { table: field(t('queryEditor.table'), tableSel), query: field(t('queryEditor.query'), querySel), web: field(t('queryEditor.source.url'), url), csv: field(t('queryEditor.source.text'), text), workbook: el('p.field-hint', {}, s.item ? t('queryEditor.source.workbookItem', { item: s.item, name: s.name }) : t('queryEditor.source.workbookSheet', { name: s.name })) };
    const sync = () => { for (const [k, node] of Object.entries(parts)) node.hidden = k !== kindSel.value; };
    kindSel.addEventListener('change', sync);
    formDialog({ title: t('queryEditor.source.title'), wide: true, fields: [field(t('queryEditor.source.title'), kindSel), ...Object.values(parts)], submit: () => {
      const kind = kindSel.value;
      let next;
      if (kind === 'table') { if (!tableSel.value) return { field: tableSel, message: t('queryEditor.source.noTable') }; next = { kind, table: tableSel.value }; }
      else if (kind === 'query') { if (!querySel.value) return { field: querySel, message: t('queryEditor.source.noQuery') }; next = { kind, query: querySel.value }; }
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
      { label: many ? t('queryEditor.removeColumns') : t('common.remove'), icon: 'deleteCols', onSelect: () => removeColumns() },
      { label: t('queryEditor.removeOtherColumns'), onSelect: () => removeOtherColumns() },
      { label: t('queryEditor.duplicateColumn'), icon: 'copy', disabled: many, onSelect: () => addStep({ type: 'duplicateColumn', column }) },
      { separator: true },
      { label: t('queryEditor.removeDuplicates'), icon: 'dedupe', onSelect: () => removeDuplicates() },
      { label: t('queryEditor.removeErrors'), onSelect: () => addStep({ type: 'removeErrors', columns: selected.slice() }) },
      { separator: true },
      { label: t('queryEditor.changeType'), submenu: TYPES.map((ty) => ({ label: typeLabel(ty), radio: true, checked: !many && ty === type, onSelect: () => changeType(selected.slice(), ty) })) },
      { label: t('queryEditor.transform'), submenu: textMenu() },
      { separator: true },
      { label: t('queryEditor.replaceValuesDialog'), icon: 'replace', onSelect: () => replaceValues() },
      { label: t('queryEditor.fill'), submenu: [{ label: t('queryEditor.fillDown'), icon: 'fillDown', onSelect: () => addStep({ type: 'fillDown', columns: selected.slice() }) }, { label: t('queryEditor.fillUp'), icon: 'fillUp', onSelect: () => addStep({ type: 'fillUp', columns: selected.slice() }) }] },
      { separator: true },
      { label: t('queryEditor.groupByDialog'), icon: 'groupBy', onSelect: () => groupBy() },
      { label: t('queryEditor.splitColumn'), disabled: many, submenu: [{ label: t('queryEditor.byDelimiter'), onSelect: () => splitColumn(column) }] },
      { separator: true },
      { label: t('queryEditor.renameDialog'), icon: 'pencil', disabled: many, onSelect: () => renameColumn(column) },
    ];
  }

  function tableMenu() {
    return [
      { label: t('queryEditor.useFirstRowAsHeaders'), icon: 'promoteHeaders', onSelect: () => addStep({ type: 'promoteHeaders' }) },
      { label: t('queryEditor.useHeadersAsFirstRow'), onSelect: () => addStep({ type: 'demoteHeaders' }) },
      { separator: true },
      { label: t('queryEditor.index.title'), submenu: [{ label: t('queryEditor.fromZero'), onSelect: () => addIndex(0, 1) }, { label: t('queryEditor.fromOne'), onSelect: () => addIndex(1, 1) }, { label: t('queryEditor.customIndex'), onSelect: () => customIndex() }] },
      { label: t('queryEditor.chooseColumnsDialog'), icon: 'chooseColumns', onSelect: () => chooseColumns() },
      { separator: true },
      { label: t('queryEditor.keepTopRowsDialog'), onSelect: () => rowsCount('keepFirst') },
      { label: t('queryEditor.removeTopRowsDialog'), onSelect: () => rowsCount('removeFirst') },
      { label: t('queryEditor.removeDuplicates'), icon: 'dedupe', onSelect: () => addStep({ type: 'removeDuplicates', columns: null }) },
      { label: t('queryEditor.removeBlankRows'), onSelect: () => addStep({ type: 'removeBlankRows' }) },
      { separator: true },
      { label: t('queryEditor.groupByDialog'), icon: 'groupBy', onSelect: () => groupBy() },
      { label: t('queryEditor.mergeQueriesDialog'), icon: 'mergeQueries', onSelect: () => mergeQueries() },
    ];
  }

  function closePopup() { popup?.remove(); popup = null; document.removeEventListener('pointerdown', outside, true); }
  function outside(e) { if (popup && !popup.contains(e.target) && !e.target.closest?.('.menu')) closePopup(); }

  /** The filter drop-down: sort, the type's filters, and the column's values to keep. */
  function filterPopup(column, anchor) {
    closePopup();
    const tbl = table(), i = tbl.columns.indexOf(column), type = typeOf(column);
    const counts = new Map();
    for (const r of tbl.rows) { const k = keyOf(r[i]); if (!counts.has(k)) counts.set(k, r[i]); }
    const values = [...counts.values()].slice(0, 1000);
    const prev = previous();
    const list = prev?.type === 'filterRows' && prev.column === column && prev.conditions.length === 1 && ['in', 'notIn'].includes(prev.conditions[0].op) ? prev.conditions[0] : null;
    const listed = list && new Set(list.values.map(keyOf));
    const ticked = (v) => (!list ? true : list.op === 'in' ? listed.has(keyOf(v)) : !listed.has(keyOf(v)));
    const boxes = values.map((v) => el('input', { type: 'checkbox', checked: ticked(v) }));
    boxes.forEach((b, n) => { b._value = values[n]; });
    const all = el('input', { type: 'checkbox', checked: boxes.every((b) => b.checked), onchange: () => { for (const b of boxes) if (!b.closest('label').hidden) b.checked = all.checked; } });
    const search = el('input.input', { type: 'search', placeholder: t('common.search'), 'aria-label': t('queryEditor.popup.search'), oninput: () => {
      const q = search.value.toLowerCase();
      boxes.forEach((b) => { b.closest('label').hidden = !!q && !displayValue(b._value, type).toLowerCase().includes(q); });
    } });
    const act = (label, fn, glyph = null) => el('button.pq-pop-item', { type: 'button', html: glyph ? icon(glyph, 16) : '', onclick: () => { closePopup(); fn(); } }, el('span', {}, label));
    const filtersBtn = el('button.pq-pop-item.pq-pop-sub', { type: 'button', 'aria-haspopup': 'menu' }, el('span', {}, filterMenuName(type)), el('span', { html: icon('chevR', 12) }));
    filtersBtn.addEventListener('click', () => openMenu({ anchor: filtersBtn, align: 'start', label: filterMenuName(type),
      items: [...filtersFor(type).map((op) => ({ label: t(FILTER_MENU[op]), onSelect: () => { closePopup(); filterDialog(column, op); } })),
        { separator: true }, { label: t('queryEditor.popup.customFilter'), onSelect: () => { closePopup(); filterDialog(column); } }] }));
    const truncated = counts.size >= 1000;
    let okBtn = null;
    // Enter in the search box confirms the list, as OK does.
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); okBtn.click(); } });
    popup = el('div.pq-popup', { role: 'dialog', 'aria-label': t('queryEditor.filterColumn', { column }) },
      act(t('queryEditor.sortAscending'), () => sortBy(column, false), 'sortAsc'),
      act(t('queryEditor.sortDescending'), () => sortBy(column, true), 'sortDesc'),
      el('div.pq-pop-sep'),
      act(t('queryEditor.popup.clearFilter'), () => {
        const q = current(), at = stepIndex(q);
        const last = at > 0 ? q.steps[at - 1] : null;
        if (last?.type === 'filterRows' && last.column === column) deleteStep(at - 1);
      }, 'filterClear'),
      act(t('queryEditor.popup.removeEmpty'), () => filterBy(column, [{ op: 'notBlank' }])),
      filtersBtn,
      search,
      el('div.pq-checklist.pq-pop-list', {}, el('label.check', {}, all, el('span', {}, t('queryEditor.popup.selectAll'))),
        ...boxes.map((b) => el('label.check', {}, b, el('span', {}, displayValue(b._value, type))))),
      truncated ? el('p.field-hint', {}, t('queryEditor.popup.incomplete')) : null,
      el('div.row.row-end', {},
        okBtn = el('button.btn.btn-primary', { type: 'button', onclick: () => {
          // The values a search hides are left out, as in Power Query: "pen" and OK keeps the pens.
          const on = (b) => b.checked && !b.closest('label').hidden;
          const keep = boxes.filter(on).map((b) => b._value);
          closePopup();
          if (keep.length === boxes.length) return;
          // The list is read after this column's filter, so what that filter left out stays out. A list cut short at
          // 1,000 values names the ones cleared rather than the ones kept, so the values it did not show stay, as in
          // Power Query.
          const cleared = boxes.filter((b) => !on(b)).map((b) => b._value), gone = new Set(cleared.map(keyOf));
          if (list?.op === 'in') filterBy(column, [{ op: 'in', values: list.values.filter((v) => !gone.has(keyOf(v))) }], 'and', { replace: true });
          else if (truncated || list?.op === 'notIn') filterBy(column, [{ op: 'notIn', values: [...(list?.values || []), ...cleared] }], 'and', { replace: !!list });
          else filterBy(column, [{ op: 'in', values: keep }]);
        } }, t('common.ok')),
        el('button.btn', { type: 'button', onclick: () => closePopup() }, t('common.cancel'))));
    root.append(popup);
    const a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
    popup.style.left = `${Math.max(4, Math.min(a.left - r.left, r.width - 280))}px`;
    popup.style.top = `${a.bottom - r.top + 2}px`;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    search.focus();
  }

  /* ---------- Rendering ---------- */
  function drawQueries() {
    queriesHead.textContent = t('queryEditor.queriesCount', { count: drafts.length });
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
        i === 0 ? el('button.icon-btn.pq-step-gear', { type: 'button', title: t('queryEditor.step.sourceSettings'), 'aria-label': t('queryEditor.step.sourceSettings'), html: icon('sliders', 14), onclick: () => openSourceDialog() }) : null,
        i > 0 ? el('button.icon-btn.pq-step-delete', { type: 'button', title: t('queryEditor.deleteNamed', { name }), 'aria-label': t('queryEditor.deleteNamed', { name }), html: icon('x', 14), onclick: () => deleteStep(i - 1) }) : null);
      if (failed) li.classList.add('pq-step-error');
      return li;
    }));
  }

  function stepMenu(i, e) {
    const q = current();
    if (i === 0) { openMenu({ x: e.clientX, y: e.clientY, label: t('queryEditor.source.title'), items: [{ label: t('queryEditor.step.editSettings'), onSelect: () => openSourceDialog() }] }); return; }
    const k = i - 1;
    openMenu({ x: e.clientX, y: e.clientY, label: t('queryEditor.step.menu'), items: [
      { label: t('common.rename'), icon: 'pencil', onSelect: () => {
        const input = el('input.input', { type: 'text', value: stepNames(q)[i], 'aria-label': t('queryEditor.step.name') });
        formDialog({ title: t('queryEditor.step.renameTitle'), fields: [field(t('common.name'), input)], submit: () => {
          const name = input.value.trim();
          if (!name) return { field: input, message: t('queryEditor.step.noName') };
          if (stepNames(q).some((n, j) => j !== i && n.toLowerCase() === name.toLowerCase())) return { field: input, message: t('queryEditor.step.nameTaken') };
          q.steps[k].name = name; markDirty(q); drawSteps(); drawFormula();
          return null;
        } });
      } },
      { label: t('common.delete'), onSelect: () => deleteStep(k) },
      { label: t('queryEditor.step.deleteToEnd'), onSelect: () => { q.steps.splice(k); stepAt.delete(q.id); markDirty(q); compute(); } },
      { separator: true },
      { label: t('queryEditor.step.moveBefore'), disabled: k === 0, onSelect: () => { [q.steps[k - 1], q.steps[k]] = [q.steps[k], q.steps[k - 1]]; stepAt.set(q.id, i - 1); markDirty(q); compute(); } },
      { label: t('queryEditor.step.moveAfter'), disabled: k === q.steps.length - 1, onSelect: () => { [q.steps[k + 1], q.steps[k]] = [q.steps[k], q.steps[k + 1]]; stepAt.set(q.id, i + 1); markDirty(q); compute(); } },
    ] });
  }

  function drawFormula() {
    const q = current();
    formula.textContent = q ? stepFormula(q, stepIndex(q)) : '';
  }

  function drawGrid() {
    const q = current();
    if (!q) {
      gridHost.replaceChildren(el('div.pq-empty', {}, el('p', {}, t('queryEditor.empty.noQueries')), el('p.muted', {}, t('queryEditor.empty.noQueriesHint'))));
      return;
    }
    if (q.source.kind === 'blank' && !q.steps.length) {
      gridHost.replaceChildren(el('div.pq-empty', {}, el('p', {}, t('queryEditor.empty.noSource')),
        el('button.btn.btn-primary', { type: 'button', onclick: () => openSourceDialog() }, t('queryEditor.empty.chooseSource'))));
      return;
    }
    const tbl = result.table;
    if (result.error && (!tbl || result.error.step + 1 === stepIndex(q) || result.error.step === -1)) {
      gridHost.replaceChildren(el('div.pq-error-box', { role: 'alert' }, el('span', { html: icon('alert', 18) }), el('div', {},
        el('strong', {}, result.error.message.split(':')[0].includes('.') ? result.error.message.split(':')[0] : 'Expression.Error'),
        el('p', {}, result.error.message.includes(':') ? result.error.message.slice(result.error.message.indexOf(':') + 1).trim() : result.error.message),
        result.error.step >= 0 ? el('button.btn.btn-sm', { type: 'button', onclick: () => { stepAt.set(q.id, result.error.step); compute(); } }, t('queryEditor.goToError')) : null)));
      return;
    }
    if (!tbl) { gridHost.replaceChildren(); return; }
    const corner = el('th.pq-corner', {}, el('button.pq-table-btn', { type: 'button', 'aria-label': t('queryEditor.tableActions'), title: t('queryEditor.tableActions'), html: icon('table', 14),
      onclick: (e) => openMenu({ anchor: e.currentTarget, label: t('queryEditor.table'), items: tableMenu() }) }));
    const heads = tbl.columns.map((name, i) => {
      const type = tbl.types[i];
      const typeBtn = el('button.pq-type', { type: 'button', title: typeLabel(type), 'aria-label': t('queryEditor.columnType', { name, type: typeLabel(type) }) }, TYPE_MARKS[type].replace('\n', ''));
      typeBtn.addEventListener('click', (e) => { e.stopPropagation(); pick(name, e, true); openMenu({ anchor: typeBtn, label: t('queryEditor.dataType'), items: TYPES.map((tp) => ({ label: typeLabel(tp), radio: true, checked: tp === type, onSelect: () => changeType(selected.slice(), tp) })) }); });
      const filterBtn = el('button.pq-filter', { type: 'button', 'aria-label': t('queryEditor.filterColumn', { column: name }), title: t('queryEditor.filterAndSort'), html: icon('chevD', 12) });
      filterBtn.addEventListener('click', (e) => { e.stopPropagation(); pick(name, e, true); filterPopup(name, filterBtn); });
      const th = el('th.pq-col', { dataset: { col: name }, 'aria-selected': String(selected.includes(name)), tabindex: -1 }, typeBtn, el('span.pq-colname', {}, name), filterBtn);
      th.addEventListener('click', (e) => pick(name, e));
      th.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) renameColumn(name); });
      th.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!selected.includes(name)) pick(name, e); openMenu({ x: e.clientX, y: e.clientY, label: name, items: columnMenu(name) }); });
      return th;
    });
    const rows = tbl.rows.slice(0, PREVIEW_ROWS).map((row, n) => el('tr', {}, el('th.pq-rownum', {}, String(n + 1)),
      ...tbl.columns.map((name, i) => { const td = cellNode(row[i], tbl.types[i]); if (selected.includes(name)) td.classList.add('pq-selcol'); return td; })));
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
    const tbl = result.table;
    statusLeft.textContent = !tbl || result.error ? ''
      : tbl.rows.length > 999 ? t('queryEditor.status.manyRows', { cols: tbl.columns.length }) : t('queryEditor.status.size', { cols: tbl.columns.length, rows: tbl.rows.length });
    statusRight.textContent = t('queryEditor.status.downloaded', { time: formatDate(downloadedAt, { hour: 'numeric', minute: '2-digit' }).toUpperCase() });
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
    if (e.key === t('common.delete') && selected.length) { e.preventDefault(); removeColumns(); }
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
        if (res.error) toast(t('queryEditor.refreshFailed', { name: q.name, error: res.error }), { icon: 'alert', duration: 5000 });
        else fitQueryTables(ctx, [q]);
      }
    }
    if (to && cur && !fresh.has(cur.id) && !saved.some((q) => q.id === cur.id)) openImportData(ctx, { query: cur });
    ctx.onQueriesChanged?.();
  }

  function requestClose() {
    if (!touched.size) { finish(); ctx.grid?.focus?.(); return; }
    const m = openModal({ title: t('queryEditor.title'), content: el('div', {},
      el('p.modal-text', {}, t('queryEditor.keepChanges.message')),
      el('div.row.row-end', {},
        el('button.btn.btn-primary', { type: 'button', onclick: () => { m.close(); closeAndLoad(false); } }, t('queryEditor.keepChanges.keep')),
        el('button.btn', { type: 'button', onclick: () => { m.close(); finish(); ctx.grid?.focus?.(); } }, t('queryEditor.keepChanges.discard')),
        el('button.btn.btn-ghost', { type: 'button', onclick: () => m.close() }, t('common.cancel')))) });
  }

  drawRibbon();
  const ready = compute();
  return { close: finish, ready, root, get query() { return current(); }, get result() { return result; }, select: (names) => { selected = names.slice(); drawGrid(); syncTypeSelect(); } };
}
