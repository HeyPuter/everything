/**
 * Data ▸ Form: the pure parts of the record-by-record form over a list.
 *
 * A list is a block of rows under a header row: the table at the selection, or
 * else the current region around it (the block of filled cells it sits in),
 * whose first row names the fields. Each row under the header is a record.
 * The form reads a record's fields, writes them back as one undo step, appends
 * a new record below the list (growing a table to take it), deletes a record
 * by shifting the rows under it up within the list's columns, and steps through
 * the records that match a set of criteria.
 */

import { cellKey, colName } from './cell.js';
import { editText } from './format.js';
import { tableRows } from './tables.js';
import { shiftFormula } from './refs.js';

/**
 * The list at (r, c) on a sheet: { sheetId, header, first, last, c1, c2, tableId, fields }, where `header`
 * is the header row, records run from `first` to `last` (last < first when there are none), and `fields`
 * is [{ c, name }] for each column. Null when there is no list there (an empty cell with nothing around it).
 */
export function findList(wb, sheetId, r, c) {
  const table = wb.tableAt?.(sheetId, r, c);
  if (table) {
    const rows = tableRows(table);
    const { c1, c2 } = table.range;
    const header = rows.header;
    const names = wb.tableColumns(sheetId, table);
    const fields = [];
    for (let cc = c1; cc <= c2; cc++) fields.push({ c: cc, name: names[cc - c1] || `Column ${colName(cc)}` });
    return { sheetId, header, first: rows.dataStart, last: rows.dataEnd, c1, c2, tableId: table.id, fields };
  }
  const region = wb.dataRegion(sheetId, r, c);
  if (!region) return null;
  const fields = [];
  for (let cc = region.c1; cc <= region.c2; cc++) {
    const name = String(wb.getDisplay(sheetId, region.r1, cc) ?? '').trim();
    fields.push({ c: cc, name: name || `Column ${colName(cc)}` });
  }
  return { sheetId, header: region.r1, first: region.r1 + 1, last: region.r2, c1: region.c1, c2: region.c2, tableId: null, fields };
}

/** How many records the list holds. */
export const recordCount = (list) => Math.max(0, list.last - list.first + 1);

/** The sheet row of record `i` (0-based). */
export const recordRow = (list, i) => list.first + i;

/**
 * Record `i`'s fields as the form shows them: { c, name, text, display, formula }, where `text` is what an
 * editable field holds (the cell as it would be edited) and `display` what a formula field shows.
 */
export function readRecord(wb, list, i) {
  const r = recordRow(list, i);
  return list.fields.map(({ c, name }) => {
    const cell = wb.getCell(list.sheetId, r, c);
    const formula = cell?.f != null;
    return { c, name, formula, text: formula ? '' : editText(cell), display: String(wb.getDisplay(list.sheetId, r, c) ?? '') };
  });
}

/**
 * Write a record's changed fields: `inputs` maps a column to the text typed for it. Formula fields are never
 * written. One undo step; returns how many cells changed.
 */
export function writeRecord(wb, list, i, inputs) {
  const r = recordRow(list, i);
  const before = readRecord(wb, list, i);
  const changes = before.filter((f) => !f.formula && inputs[f.c] != null && inputs[f.c] !== f.text);
  if (!changes.length) return 0;
  const version = wb.version;
  wb.transaction('Edit record', () => {
    for (const f of changes) wb.setInput(list.sheetId, r, f.c, inputs[f.c], { label: 'Edit record' });
  });
  return wb.version === version ? 0 : changes.length;
}

/**
 * Why a new record cannot be added under the list, or null when it can: the row below must be free within the
 * list's columns (a table makes room itself) and inside the sheet.
 */
export function appendProblem(wb, list) {
  const r = list.last + 1;
  if (list.tableId) return null;
  const sheet = wb.sheet(list.sheetId);
  if (!sheet) return 'The list is gone';
  for (let c = list.c1; c <= list.c2; c++) {
    const cell = sheet.cells.get(cellKey(r, c));
    if (cell && (cell.v != null || cell.f != null)) return 'The row under the list is not empty, so the list cannot grow into it';
  }
  return null;
}

/**
 * Add a record under the list from `inputs` (column → text). A table takes the row in (with its calculated
 * columns); a plain list carries the formulas of its last record down into the formula fields. One undo
 * step. Returns the list as it now stands, or null when the record could not be added.
 */
export function appendRecord(wb, list, inputs) {
  if (appendProblem(wb, list)) return null;
  const typed = list.fields.filter((f) => inputs[f.c] != null && String(inputs[f.c]) !== '');
  let r = list.last + 1;
  let ok = false;
  wb.transaction('New record', () => {
    if (list.tableId) {
      r = wb.addTableRow(list.sheetId, list.tableId);
      if (r < 0) return;
    } else if (recordCount(list)) {
      // A plain list's computed columns: the last record's formula, moved down a row.
      const prev = list.last;
      const entries = [];
      for (const { c } of list.fields) {
        const cell = wb.getCell(list.sheetId, prev, c);
        if (cell?.f == null) continue;
        entries.push({ r, c, cell: { v: null, f: shiftFormula(cell.f, 1, 0), s: cell.s } });
      }
      if (entries.length) wb.setCells(list.sheetId, entries, 'New record');
    }
    for (const f of typed) if (wb.getCell(list.sheetId, r, f.c)?.f == null) wb.setInput(list.sheetId, r, f.c, String(inputs[f.c]), { label: 'New record' });
    ok = true;
  });
  if (!ok) return null;
  return { ...list, last: Math.max(list.last, r) };
}

/** Delete record `i`, pulling the records under it up within the list's columns. One undo step. Returns the shorter list, or null. */
export function deleteRecord(wb, list, i) {
  const r = recordRow(list, i);
  if (i < 0 || r > list.last) return null;
  const ok = wb.deleteCells(list.sheetId, { r1: r, c1: list.c1, r2: r, c2: list.c2 }, 'up');
  return ok === false ? null : { ...list, last: list.last - 1 };
}

/* ---------- Criteria ---------- */

const OPERATORS = ['>=', '<=', '<>', '>', '<', '='];

/** A wildcard pattern (* any run, ? one character, ~ escapes either) as a case-insensitive RegExp; `prefix` matches a beginning only. */
function wildcardRegExp(text, prefix) {
  let out = '';
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === '~' && k + 1 < text.length && '*?~'.includes(text[k + 1])) { out += `\\${text[++k]}`; continue; }
    if (ch === '*') out += '[\\s\\S]*';
    else if (ch === '?') out += '[\\s\\S]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}${prefix ? '' : '$'}`, 'i');
}

const asNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return null;
  const t = String(v ?? '').trim().replace(/,/g, '');
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return null;
  return t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
};

/**
 * Does a cell match one criterion? A criterion starting with a comparison (>, >=, <, <=, =, <>) compares
 * numbers as numbers and anything else as text, ignoring case; a bare criterion matches text that begins
 * with it. * and ? are wildcards in text, ~ takes either literally. `value` is the cell's value, `shown`
 * the text it shows (a date matches as it reads).
 */
export function matchesCriterion(value, shown, criterion) {
  const raw = String(criterion ?? '');
  if (!raw.trim()) return true;
  const op = OPERATORS.find((o) => raw.startsWith(o));
  const operand = op ? raw.slice(op.length).trim() : raw.trim();
  const n = asNumber(operand);
  const v = value && typeof value === 'object' ? (value.error ?? '') : value;
  if (!op) {
    if (n != null && typeof v === 'number') return v === n || wildcardRegExp(operand, true).test(String(shown ?? ''));
    return wildcardRegExp(operand, true).test(String(shown ?? v ?? ''));
  }
  // =  with nothing after it is a blank cell; <> with nothing after it is any filled one.
  if (operand === '' && (op === '=' || op === '<>')) return (v == null || v === '') === (op === '=');
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  let order;
  if (n != null && typeof v === 'number') order = cmp(v, n);
  else if (op === '=' || op === '<>') {
    const same = wildcardRegExp(operand, false).test(String(shown ?? v ?? '')) || wildcardRegExp(operand, false).test(String(v ?? ''));
    return op === '=' ? same : !same;
  } else {
    if (n != null || typeof v === 'number' || v == null) return false; // numbers and text do not order against each other
    order = cmp(String(v).toLowerCase(), operand.toLowerCase());
  }
  switch (op) {
    case '>': return order > 0;
    case '>=': return order >= 0;
    case '<': return order < 0;
    case '<=': return order <= 0;
    case '=': return order === 0;
    default: return order !== 0;
  }
}

/** Does record `i` match every criterion (column → criterion text)? */
export function recordMatches(wb, list, i, criteria) {
  const r = recordRow(list, i);
  for (const [c, criterion] of Object.entries(criteria || {})) {
    if (!String(criterion ?? '').trim()) continue;
    const col = Number(c);
    if (!matchesCriterion(wb.getValue(list.sheetId, r, col), wb.getDisplay(list.sheetId, r, col), criterion)) return false;
  }
  return true;
}

/** Whether any criterion is set. */
export const hasCriteria = (criteria) => Object.values(criteria || {}).some((v) => String(v ?? '').trim() !== '');

/**
 * The next record from `from` in direction `dir` (1 or -1) that matches the criteria, or -1 when there is
 * none. Searching does not wrap round, as stepping does not.
 */
export function findRecord(wb, list, from, dir, criteria) {
  const n = recordCount(list);
  for (let i = from + dir; i >= 0 && i < n; i += dir) if (recordMatches(wb, list, i, criteria)) return i;
  return -1;
}
