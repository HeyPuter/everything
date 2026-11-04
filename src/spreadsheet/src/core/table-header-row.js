/**
 * Table Design ▸ Header Row and Filter Button.
 *
 * A table whose Header Row is turned off starts at its first data row: the header
 * cells leave the table (their text is cleared from the grid) and the column names are kept on
 * the table itself, `columnNames`, so structured references keep working and turning the Header
 * Row back on writes the same names above the data again. A table without a header row has no
 * AutoFilter (the buttons live in the header), so its filter goes with the header row and a
 * fresh one comes back with it; `filterButton: false` remembers a hidden Filter Button meanwhile.
 * In SpreadsheetML the same table is written with headerRowCount="0" and its tableColumn names.
 */
import { tableRows } from './tables.js';
import { sheetFilters, filterTable } from './sheet-filters.js';
import { t } from '../i18n/index.js';

const MAX_NAME = 255;

/** The stored names of a table with its Header Row off, padded with ColumnN for any missing. */
export function headerlessTableColumns(table) {
  const width = table.range.c2 - table.range.c1 + 1, stored = Array.isArray(table.columnNames) ? table.columnNames : [];
  const out = [], taken = new Set(stored.filter(n => typeof n === 'string' && n).map(n => n.toLowerCase()));
  for (let i = 0; i < width; i++) {
    const name = stored[i];
    if (typeof name === 'string' && name) { out.push(name); continue; }
    let k = i + 1;
    while (taken.has(`column${k}`)) k++;
    taken.add(`column${k}`);
    out.push(`Column${k}`);
  }
  return out;
}

/** The loader's view of a stored table's header state: only `headerRow: false` and its names are kept. */
export function normalizeTableHeaderState(raw) {
  const out = {};
  if (raw?.headerRow === false) {
    out.headerRow = false;
    out.columnNames = Array.isArray(raw.columnNames) ? raw.columnNames.map(n => (typeof n === 'string' ? n.slice(0, MAX_NAME) : null)) : [];
  }
  if (raw?.filterButton === false) out.filterButton = false;
  return out;
}

/** Columns inserted inside a headerless table (offset `at` from its first column) get free ColumnN names. */
export function headerlessInsertColumns(table, at, n, freeName) {
  const names = headerlessTableColumns({ ...table, range: { ...table.range, c2: table.range.c2 - n } });
  const added = [];
  for (let i = 0; i < n; i++) {
    const name = freeName([...names, ...added], at + i);
    added.push(name);
  }
  names.splice(at, 0, ...added);
  table.columnNames = names;
  return table;
}

/** Deleted columns take their names with them. `deleted(c)` answers for an absolute column. */
export function headerlessDeleteColumns(table, deleted) {
  const names = headerlessTableColumns(table).filter((_, i) => !deleted(table.range.c1 + i));
  return { ...table, columnNames: names };
}

/** A resize keeps the names of the columns that stay; columns joining get theirs from headerlessJoinColumns. */
export function headerlessResizeNames(table, range) {
  if (table.headerRow !== false) return {};
  const names = headerlessTableColumns(table), out = [];
  for (let c = range.c1; c <= range.c2; c++) out.push(c >= table.range.c1 && c <= table.range.c2 ? names[c - table.range.c1] : null);
  return { columnNames: out };
}

/** Fill the names a resize left open with the first free ColumnN, as a blank header gets. */
export function headerlessJoinColumns(table, freeName) {
  const stored = Array.isArray(table.columnNames) ? table.columnNames : [];
  const width = table.range.c2 - table.range.c1 + 1, names = [];
  for (let i = 0; i < width; i++) names.push(typeof stored[i] === 'string' && stored[i] ? stored[i] : null);
  for (let i = 0; i < width; i++) if (!names[i]) names[i] = freeName(names.filter(Boolean), i);
  return { ...table, columnNames: names };
}

/** Slicers filter through the table's AutoFilter, which lives in the header row. */
export const tableHasSlicers = (wb, table) => wb.sheets.some(s => s.charts.some(ch => ch.type === 'slicer' && typeof ch.tableRef === 'string'
  && ch.tableRef.split('[')[0].toLowerCase() === table.name.toLowerCase()));

const tableFilter = (sheet, table) => sheetFilters(sheet).find(f => filterTable(sheet, f)?.id === table.id) || null;

/**
 * Turn a table's Header Row on or off. Returns null when done, or the reason it was refused.
 * Off: the table starts one row lower and the header text leaves the grid. On: the names are
 * written in the row above; when that row holds anything (or there is none), a row is inserted
 * first so nothing is overwritten, as the totals row makes room below.
 */
export function setTableHeaderRow(wb, sheetId, id, on) {
  const sheet = wb.sheet(sheetId);
  const table = sheet?.tables.find(tb => tb.id === id);
  if (!table) return t('tableHeaderRow.selectTable');
  if (wb._gridLocked(sheet)) return t('tableHeaderRow.unprotect');
  if ((table.headerRow !== false) === !!on) return null;
  const { c1, c2 } = table.range;
  if (!on) {
    const rows = tableRows(table);
    if (rows.empty) return t('tableHeaderRow.needsData');
    const r = rows.header;
    if (wb.lockedIn(sheetId, { r1: r, r2: r, c1, c2 })) return t('tableHeaderRow.headerProtected');
    if (tableHasSlicers(wb, table)) return t('tableHeaderRow.hasSlicers');
    const names = wb.tableColumns(sheetId, table);
    const filter = tableFilter(sheet, table);
    wb.transaction(t('tableHeaderRow.undo.hide'), () => {
      // The filter goes first: its buttons and the rows it hid belong to the header it hangs from.
      if (filter) wb._setFilter(sheet, null, t('tableHeaderRow.undo.hide'), { target: filter });
      const next = { ...wb.tableById(sheetId, id), headerRow: false, columnNames: names, range: { ...table.range, r1: r + 1 },
        ...(filter?.showButtons === false ? { filterButton: false } : {}) };
      wb._setTables(sheet, sheet.tables.map(tb => (tb.id === id ? next : tb)), t('tableHeaderRow.undo.hide'));
      wb.clearRange(sheetId, { r1: r, r2: r, c1, c2 });
    });
    return null;
  }
  const names = wb.tableColumns(sheetId, table);
  let refused = null;
  wb.transaction(t('tableHeaderRow.undo.show'), () => {
    let live = wb.tableById(sheetId, id);
    let r = live.range.r1 - 1;
    if (r < 0 || wb.tableRowOccupied(sheetId, { r1: r, r2: r, c1, c2 }, id)) {
      if (!wb.insertRows(sheetId, live.range.r1, 1)) { refused = t('tableHeaderRow.noRoom'); return; }
      live = wb.tableById(sheetId, id);
      r = live.range.r1 - 1;
    }
    if (wb.lockedIn(sheetId, { r1: r, r2: r, c1, c2 })) { refused = t('tableHeaderRow.rowAboveProtected'); return; }
    const { headerRow, columnNames, filterButton, ...rest } = live;
    const next = { ...rest, range: { ...live.range, r1: r } };
    wb._setTables(sheet, wb.sheet(sheetId).tables.map(tb => (tb.id === id ? next : tb)), t('tableHeaderRow.undo.show'));
    wb.setCells(sheetId, names.map((name, i) => ({ r, c: c1 + i, cell: { v: name, f: null, s: wb.getCell(sheetId, r, c1 + i)?.s } })), t('tableHeaderRow.undo.show'));
    const range = { r1: r, c1, r2: tableRows(next).dataEnd, c2 };
    wb._setFilter(wb.sheet(sheetId), { range, criteria: {}, ...(filterButton === false ? { showButtons: false } : {}) }, t('tableHeaderRow.undo.show'), { create: true });
  });
  return refused;
}

/** Table Design ▸ Filter Button: show or hide every AutoFilter button of the table, keeping its criteria. */
export function setTableFilterButton(wb, sheetId, id, on) {
  const sheet = wb.sheet(sheetId);
  const table = sheet?.tables.find(tb => tb.id === id);
  if (!table) return t('tableHeaderRow.selectTable');
  if (wb._gridLocked(sheet)) return t('tableHeaderRow.unprotect');
  if (table.headerRow === false) return t('tableHeaderRow.needsHeader');
  const filter = tableFilter(sheet, table);
  const rows = tableRows(table);
  const next = filter ? { ...filter } : { range: { r1: rows.header, c1: table.range.c1, r2: rows.dataEnd, c2: table.range.c2 }, criteria: {} };
  if (on) { delete next.showButtons; delete next.hiddenButtons; } else next.showButtons = false;
  wb._setFilter(sheet, next, on ? t('tableHeaderRow.undo.showButtons') : t('tableHeaderRow.undo.hideButtons'), filter ? { target: filter } : { create: true });
  return null;
}

/** Is the Filter Button on for this table (a table without a filter shows none)? */
export function tableFilterButtonOn(wb, sheetId, table) {
  if (!table || table.headerRow === false) return false;
  const filter = tableFilter(wb.sheet(sheetId), table);
  return !!filter && filter.showButtons !== false && !(filter.hiddenButtons?.length === table.range.c2 - table.range.c1 + 1);
}
