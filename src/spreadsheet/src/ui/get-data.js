/**
 * Data ▸ Get Data: the ways a query starts (From Text/CSV, From Workbook, From Web, From Table/Range, Blank
 * Query), the preview each source opens with (the text file's dialog, the Navigator), and the Import Data
 * dialog behind Load To…. A query is then loaded as a table, or opened in the Power Query Editor.
 */
import { el } from './dom.js';
import { openModal, fieldAlert, promptDialog } from './modal.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { icon } from './icons.js';
import * as P from '../lib/puter.js';
import { workbookFromFile, detectDelimiter, decodeText } from '../core/io.js';
import { parseCellRef, colName } from '../core/cell.js';
import {
  csvTable, initialSteps, applyStep, uniqueQueryName, saveQuery, evaluateQuery, loadResult, unloadQuery, webItems, sheetRows,
  displayValue, TYPE_MARKS, TYPE_LABELS, queryById, loadedTable,
} from '../core/queries.js';

/** What a query may reach outside the workbook through: the web (through Puter), the drive, and the file readers. */
export function queryIo(ctx) {
  return {
    fetchBytes: (url) => P.fetchBytes(url),
    readFile: P.isApp?.() ? (path) => P.readFile(path) : null,
    workbookFromFile, decodeText, detectDelimiter,
    ...(ctx?.ioOverrides || {}),
  };
}

/** The columns of the tables these queries load, fitted to their contents after a load or refresh. */
export function fitQueryTables(ctx, queries) {
  for (const q of queries) {
    const hit = q && loadedTable(ctx.wb, q);
    if (hit) ctx.autofitColumns?.(hit.sheet.id, hit.table.range.c1, hit.table.range.c2);
  }
}

const stripExt = (name) => String(name || '').replace(/\.[^.]+$/, '') || 'Query';
const newId = () => (globalThis.crypto?.randomUUID?.() || `q${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/** A preview table: the column names with their type marks, and the first rows. */
export function previewTable(table, { maxRows = 200, className = 'pq-table' } = {}) {
  const head = el('tr', {}, el('th.pq-corner', { 'aria-hidden': 'true' }),
    ...table.columns.map((name, i) => el('th', {}, el('span.pq-type', { title: TYPE_LABELS[table.types[i]] || 'Any' }, (TYPE_MARKS[table.types[i]] || 'ABC').replace('\n', '')), el('span.pq-colname', {}, name))));
  const body = table.rows.slice(0, maxRows).map((row, n) => el('tr', {}, el('th.pq-rownum', {}, String(n + 1)),
    ...table.columns.map((_, i) => cellNode(row[i], table.types[i]))));
  return el(`table.${className}`, {}, el('thead', {}, head), el('tbody', {}, ...body));
}

export function cellNode(v, type) {
  const text = displayValue(v, type);
  const td = el('td', {}, text);
  if (v == null) td.classList.add('pq-null');
  else if (typeof v === 'object' && v.error) { td.classList.add('pq-error'); td.title = v.message || v.error; }
  else if (typeof v === 'number' || type === 'date') td.classList.add('pq-num');
  return td;
}

/** Pick a file: the drive's Open dialog inside Puter (the path lets Refresh read it again), else the browser's. */
async function pickFile(accept) {
  if (P.canPickFiles?.()) {
    const picked = await P.pickFile({ accept });
    if (!picked) return null;
    return { name: picked.name, path: picked.path, bytes: new Uint8Array(await P.readFile(picked.path)) };
  }
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: accept.join(','), hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    document.body.append(input);
    input.click();
  });
}

/**
 * The end of every Get Data flow: `mode` 'load' puts the query in the workbook and loads it to a new sheet;
 * 'loadTo' asks where first (Import Data); 'transform' opens the Power Query Editor on it, unsaved.
 */
async function finish(ctx, query, mode, editor) {
  if (mode === 'transform') { editor?.(ctx, { draft: query }); return; }
  if (mode === 'loadTo') { openImportData(ctx, { query, fresh: true }); return; }
  await loadNew(ctx, query, null);
}

/** Save a new query and load it (to a new sheet, or `at`); says what happened. */
export async function loadNew(ctx, query, at) {
  const saved = saveQuery(ctx.wb, { ...query, name: uniqueQueryName(ctx.wb, query.name, query.id) });
  if (at === 'connection') { toast(`Query ${saved.name} saved as a connection`, { icon: 'database' }); ctx.onQueriesChanged?.(); return saved; }
  const res = await evaluateQuery(ctx.wb, saved, queryIo(ctx));
  if (res.error) { toast(res.error.message, { icon: 'alert', duration: 5000 }); ctx.onQueriesChanged?.(); return saved; }
  const out = loadResult(ctx.wb, saved, res.table, { at });
  if (out.error) toast(out.error, { icon: 'alert', duration: 5000 });
  else {
    if (!at) ctx.wb.setActiveSheet?.(out.sheetId);
    fitQueryTables(ctx, [saved]);
    toast(`${out.rows.toLocaleString()} row${out.rows === 1 ? '' : 's'} loaded${out.errors ? `, ${out.errors} error${out.errors === 1 ? '' : 's'}` : ''}`, { icon: 'table', duration: 3000 });
  }
  ctx.onQueriesChanged?.();
  return saved;
}

/** The split Load button these dialogs end with: Load, or Load To… from its arrow. */
function loadButtons(onChoose, cancel) {
  const arrow = el('button.btn.pq-load-arrow', { type: 'button', 'aria-label': 'Load options', html: icon('chevD', 12),
    onclick: () => openMenu({ anchor: arrow, label: 'Load', items: [
      { label: 'Load', onSelect: () => onChoose('load') },
      { label: 'Load To…', onSelect: () => onChoose('loadTo') },
    ] }) });
  return el('div.row.row-end.pq-dialog-buttons', {},
    el('span.pq-split', {}, el('button.btn.btn-primary', { type: 'button', onclick: () => onChoose('load') }, 'Load'), arrow),
    el('button.btn', { type: 'button', onclick: () => onChoose('transform') }, 'Transform Data'),
    el('button.btn.btn-ghost', { type: 'button', onclick: cancel }, 'Cancel'));
}

const DELIMITERS = [[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], [' ', 'Space'], [':', 'Colon'], ['=', 'Equals Sign'], ['|', 'Vertical Bar'], ['', '--Custom--']];

/** Data ▸ From Text/CSV: the file's preview with its delimiter and type detection, then Load or Transform Data. */
export async function fromText(ctx, editor) {
  const picked = await pickFile(['.csv', '.tsv', '.txt', '.prn']);
  if (!picked) return;
  const text = decodeText(picked.bytes);
  openTextDialog(ctx, { name: picked.name, path: picked.path, text }, editor);
}

export function openTextDialog(ctx, { name, path = null, text }, editor) {
  let delimiter = detectDelimiter(text.replace(/^﻿/, ''), name) || ',';
  let detect = true;
  const custom = el('input.input.pq-custom-delim', { type: 'text', maxlength: 4, 'aria-label': 'Custom delimiter', hidden: true });
  const delimSel = el('select.select', { 'aria-label': 'Delimiter' }, DELIMITERS.map(([v, label]) => el('option', { value: v }, label)));
  if (!DELIMITERS.some(([v]) => v === delimiter)) { delimSel.value = ''; custom.hidden = false; custom.value = delimiter; } else delimSel.value = delimiter;
  const detectSel = el('select.select', { 'aria-label': 'Data Type Detection' }, el('option', { value: 'yes' }, 'Based on first 200 rows'), el('option', { value: 'no' }, 'Do not detect data types'));
  const preview = el('div.pq-preview');
  const steps = () => {
    const base = csvTable(text, delimiter);
    const list = initialSteps(base);
    return { base, list: detect ? list : list.filter((s) => s.type !== 'changeType') };
  };
  const draw = () => {
    const { base, list } = steps();
    const table = list.reduce((t, s) => applyStep(t, s), base);
    preview.replaceChildren(previewTable(table, { maxRows: 50 }));
  };
  delimSel.addEventListener('change', () => { custom.hidden = delimSel.value !== ''; delimiter = delimSel.value || custom.value || ','; draw(); });
  custom.addEventListener('input', () => { if (custom.value) { delimiter = custom.value; draw(); } });
  detectSel.addEventListener('change', () => { detect = detectSel.value === 'yes'; draw(); });
  const choose = (mode) => {
    modal.close();
    const { list } = steps();
    const query = { id: newId(), name: stripExt(name), source: { kind: 'csv', name, text, delimiter, ...(path ? { path } : {}) }, steps: list, load: { kind: 'connection' } };
    finish(ctx, query, mode, editor);
  };
  const content = el('div.pq-dialog',
    {},
    el('div.pq-dialog-options', {},
      el('label.field', {}, el('span.field-label', {}, 'File Origin'), el('select.select', { 'aria-label': 'File Origin' }, el('option', {}, '65001: Unicode (UTF-8)'))),
      el('label.field', {}, el('span.field-label', {}, 'Delimiter'), delimSel, custom),
      el('label.field', {}, el('span.field-label', {}, 'Data Type Detection'), detectSel)),
    preview,
    loadButtons(choose, () => modal.close()));
  const modal = openModal({ title: name, content, wide: true, className: 'pq-source-dialog' });
  draw();
  return modal;
}

/**
 * The Navigator: the tables or sheets a source offers on the left, the chosen one's preview on the right.
 * `make(item)` builds the query for the chosen item.
 */
export function openNavigator(ctx, { title, items, make }, editor) {
  let chosen = items[0];
  const preview = el('div.pq-preview');
  const list = el('div.pq-nav-list', { role: 'listbox', 'aria-label': 'Display Options' });
  const draw = () => {
    for (const node of list.children) node.setAttribute('aria-selected', String(node._item === chosen));
    const base = { columns: [], types: [], rows: [] };
    const table = chosen ? initialSteps(rawOf(chosen.rows)).reduce((t, s) => applyStep(t, s), rawOf(chosen.rows)) : base;
    preview.replaceChildren(chosen ? previewTable(table, { maxRows: 50 }) : el('p.muted', {}, 'Nothing to preview'));
  };
  for (const item of items) {
    const node = el('button.pq-nav-item', { type: 'button', role: 'option', html: icon(item.kind === 'sheet' ? 'normalView' : 'table', 16), onclick: () => { chosen = item; draw(); } });
    node.append(el('span', {}, item.name));
    node._item = item;
    list.append(node);
  }
  const choose = (mode) => {
    if (!chosen) return;
    modal.close();
    finish(ctx, make(chosen), mode, editor);
  };
  const content = el('div.pq-dialog', {},
    el('div.pq-nav', {}, el('div.pq-nav-side', {}, el('div.field-label', {}, title), list), preview),
    loadButtons(choose, () => modal.close()));
  const modal = openModal({ title: 'Navigator', content, wide: true, className: 'pq-source-dialog' });
  draw();
  return modal;
}

function rawOf(rows) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return { columns: Array.from({ length: width }, (_, i) => `Column${i + 1}`), types: Array(width).fill('any'), rows: rows.map((r) => [...r, ...Array(width - r.length).fill(null)]) };
}

/** Data ▸ Get Data ▸ From File ▸ From Workbook: the Navigator over the workbook's sheets; the chosen sheet's values are kept with the query. */
export async function fromWorkbook(ctx, editor) {
  const picked = await pickFile(['.xlsx', '.xlsm', '.xls', '.ods']);
  if (!picked) return;
  let other;
  try { other = await workbookFromFile(picked.bytes, picked.name); } catch (e) { toast(e?.message || `Could not read ${picked.name}`, { icon: 'alert', duration: 5000 }); return; }
  const items = other.sheets.filter((s) => s.kind !== 'chart').map((s) => ({ name: s.name, kind: 'sheet', rows: sheetRows(other, s.id) }));
  if (!items.length) { toast(`${picked.name} has no sheets to read`, { icon: 'info' }); return; }
  openNavigator(ctx, { title: picked.name, items, make: (item) => ({ id: newId(), name: item.name,
    source: { kind: 'workbook', name: picked.name, item: item.name, rows: item.rows, ...(picked.path ? { path: picked.path } : {}) },
    steps: initialSteps(rawOf(item.rows)), load: { kind: 'connection' } }) }, editor);
}

export const urlProblem = (text) => {
  const t = String(text || '').trim();
  if (!t) return 'Enter a web address';
  try { const u = new URL(t); if (!/^https?:$/.test(u.protocol)) return 'Enter an http or https address'; } catch { return 'Enter a full address, such as https://example.com/data.csv'; }
  return null;
};

/** Data ▸ From Web: an address, then the Navigator over the page's tables (or the file's sheets, or the text). */
export async function fromWeb(ctx, editor) {
  const url = await promptDialog({ title: 'From Web', label: 'URL', placeholder: 'https://example.com/data.csv', confirmLabel: 'OK', validate: urlProblem,
    hint: 'A web page with tables, a .csv or text file, or a workbook. The address must allow access from other sites.' });
  if (!url) return;
  toast('Connecting…', { icon: 'spinner', duration: 1500 });
  let items;
  try { items = await webItems(await P.fetchBytes(url.trim()), url.trim(), queryIo(ctx)); } catch (e) { toast(e?.message || 'Could not fetch that address', { icon: 'alert', duration: 5000 }); return; }
  if (!items.length) { toast('No tables were found at that address', { icon: 'info' }); return; }
  const name = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || new URL(u).hostname); } catch { return 'Web'; } };
  const make = (item) => ({ id: newId(), name: items.length > 1 ? item.name : stripExt(name(url)), source: { kind: 'web', url: url.trim(), ...(items.length > 1 ? { item: item.name } : {}) },
    steps: initialSteps(rawOf(item.rows)), load: { kind: 'connection' } });
  if (items.length === 1 && items[0].csv) { finish(ctx, make(items[0]), 'transform', editor); return; }
  openNavigator(ctx, { title: url.trim(), items: items.map((i) => ({ ...i, kind: 'table' })), make }, editor);
}

/** Data ▸ From Table/Range: the table at the selection (a range is made a table first), opened in the editor. */
export function fromTable(ctx, editor, { createTable } = {}) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId(), a = ctx.active();
  const table = wb.tableAt(sheetId, a.r, a.c);
  const start = (t) => {
    const name = uniqueQueryName(wb, t.name);
    const query = { id: newId(), name, source: { kind: 'table', table: t.name }, steps: [], load: { kind: 'connection' } };
    evaluateQuery(wb, query, queryIo(ctx), { upTo: 0 }).then(({ table: base }) => {
      if (base) query.steps = initialSteps(base, { promote: false });
      editor?.(ctx, { draft: query });
    });
  };
  if (table) { start(table); return; }
  createTable?.((made) => start(made));
}

/** Data ▸ Get Data ▸ From Other Sources ▸ Blank Query: an empty query in the editor, whose source is chosen there. */
export function blankQuery(ctx, editor) {
  editor?.(ctx, { draft: { id: newId(), name: uniqueQueryName(ctx.wb, 'Query1'), source: { kind: 'blank' }, steps: [], load: { kind: 'connection' } } });
}

/** A cell typed as =$A$1, A1, or Sheet2!$B$3: { sheetId, r, c } or null. */
export function parseLocation(wb, text, sheetId) {
  let t = String(text || '').trim().replace(/^=/, '');
  let sid = sheetId;
  const bang = t.lastIndexOf('!');
  if (bang >= 0) {
    const name = t.slice(0, bang).replace(/^'(.*)'$/, (m, n) => n.replace(/''/g, "'"));
    const sheet = wb.sheetByName(name);
    if (!sheet) return null;
    sid = sheet.id; t = t.slice(bang + 1);
  }
  const ref = parseCellRef(t.replace(/\$/g, '').split(':')[0]);
  return ref ? { sheetId: sid, r: ref.r, c: ref.c } : null;
}

/**
 * Import Data (Close & Load To…, Load To…): view the data as a Table or Only Create Connection, in an
 * existing worksheet at a cell or a new worksheet. `fresh` is a query not yet in the workbook.
 * `onDone(saved)` follows a choice that was carried out.
 */
export function openImportData(ctx, { query, fresh = false, onDone = null }) {
  const { wb } = ctx;
  const loaded = !fresh && query.load?.kind === 'table';
  let view = fresh || loaded ? 'table' : 'connection';
  let where = 'new';
  const a = ctx.active?.() || { r: 0, c: 0 };
  const sheetName = wb.sheet(ctx.sheetId())?.name || '';
  const quoted = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
  const cellInput = el('input.input', { type: 'text', value: `=${quoted}!$${colName(a.c)}$${a.r + 1}`, 'aria-label': 'Existing worksheet location', spellcheck: false });
  const { alert, refuse } = fieldAlert('pq-import');
  const radio = (group, value, label, checked, onchange, disabled = false) => el('label.check', {},
    el('input', { type: 'radio', name: group, value, checked, disabled, onchange }), el('span', {}, label));
  const sync = () => { cellInput.disabled = view !== 'table' || where !== 'existing'; for (const n of whereGroup.querySelectorAll('input')) n.disabled = view !== 'table'; };
  const viewGroup = el('div.field.pq-radio-group', { role: 'radiogroup', 'aria-label': 'Select how you want to view this data in your workbook.' },
    el('span.field-label', {}, 'Select how you want to view this data in your workbook.'),
    radio('pq-view', 'table', 'Table', view === 'table', () => { view = 'table'; sync(); }),
    radio('pq-view', 'pivot', 'PivotTable Report', false, null, true),
    radio('pq-view', 'chart', 'PivotChart', false, null, true),
    radio('pq-view', 'connection', 'Only Create Connection', view === 'connection', () => { view = 'connection'; sync(); }));
  const whereGroup = el('div.field.pq-radio-group', { role: 'radiogroup', 'aria-label': 'Where do you want to put the data?' },
    el('span.field-label', {}, 'Where do you want to put the data?'),
    radio('pq-where', 'existing', 'Existing worksheet:', false, () => { where = 'existing'; sync(); }),
    el('div.pq-indent', {}, cellInput),
    radio('pq-where', 'new', 'New worksheet', true, () => { where = 'new'; sync(); }));
  const submit = async (e) => {
    e?.preventDefault();
    let at = null;
    if (view === 'table' && where === 'existing') {
      at = parseLocation(wb, cellInput.value, ctx.sheetId());
      if (!at) return refuse(cellInput, 'The reference is not valid. Enter a cell such as =$A$1 or =Sheet1!$A$1.');
    }
    modal.close();
    if (fresh) { const saved = await loadNew(ctx, query, view === 'connection' ? 'connection' : at); onDone?.(saved); return; }
    const live = queryById(wb, query.id) || saveQuery(wb, query);
    if (view === 'connection') { if (loaded) unloadQuery(wb, live); else saveQuery(wb, { ...live, load: { kind: 'connection' } }); ctx.onQueriesChanged?.(); onDone?.(live); return; }
    if (loaded && where === 'new' && !at) { onDone?.(live); return; }
    if (loaded) unloadQuery(wb, live);
    const res = await evaluateQuery(wb, live, queryIo(ctx));
    if (res.error) { toast(res.error.message, { icon: 'alert', duration: 5000 }); return; }
    const out = loadResult(wb, live, res.table, { at });
    if (out.error) toast(out.error, { icon: 'alert', duration: 5000 });
    else { fitQueryTables(ctx, [live]); toast(`${out.rows.toLocaleString()} rows loaded`, { icon: 'table' }); }
    ctx.onQueriesChanged?.();
    onDone?.(live);
  };
  const content = el('form.pq-import', { onsubmit: submit }, viewGroup, whereGroup,
    el('label.check.pq-disabled', {}, el('input', { type: 'checkbox', disabled: true }), el('span', {}, 'Add this data to the Data Model')),
    alert,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Import Data', content });
  sync();
  return modal;
}
