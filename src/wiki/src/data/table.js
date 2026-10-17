/**
 * A table block's content, kept on the block under 'table':
 *
 *   Y.Map {
 *     header: boolean,
 *     rows:  Y.Map<rowId, order>   (fractional keys)
 *     cols:  Y.Map<colId, order>
 *     cells: Y.Map<'rowId:colId', text>   (empty cells have no entry)
 *   }
 *
 * Each cell is its own key, so two people typing in different cells, or
 * adding rows and columns at once, never overwrite each other; within one
 * cell the last save wins. Older pages kept the whole table as one plain
 * { rows: [[text]], header } value. It reads the same (rows r0, r1...,
 * columns c0, c1...) and becomes a Y.Map on its next change.
 */
import { Y, local } from './ydoc.js';
import { uid } from '../lib/ids.js';
import { keyBetween, keysAfter, compareOrder } from '../lib/order.js';

export const MAX_ROWS = 50;
export const MAX_COLS = 20;
export const MAX_CELL = 2000;

const cellKey = (row, col) => `${row}:${col}`;

function sortedIds(map) {
  return [...map.entries()].map(([id, order]) => ({ id, order })).sort(compareOrder).map((x) => x.id);
}

/**
 * A table as plain data: rows of cell text, plus the row and column ids the
 * editor uses to address cells.
 */
export function readTable(value) {
  if (value instanceof Y.Map) {
    const rows = value.get('rows');
    const cols = value.get('cols');
    const cells = value.get('cells');
    const rowIds = rows instanceof Y.Map ? sortedIds(rows) : [];
    const colIds = cols instanceof Y.Map ? sortedIds(cols) : [];
    return {
      rows: rowIds.map((r) => colIds.map((c) => (cells instanceof Y.Map ? cells.get(cellKey(r, c)) : '') || '')),
      header: value.get('header') !== false,
      rowIds,
      colIds,
    };
  }
  const rows = Array.isArray(value?.rows) && value.rows.length ? value.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) : [['']];
  const width = Math.max(1, ...rows.map((r) => r.length));
  return {
    rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
    header: value?.header !== false,
    rowIds: rows.map((_, i) => `r${i}`),
    colIds: Array.from({ length: width }, (_, i) => `c${i}`),
  };
}

/**
 * A new table structure holding plain { rows, header } data. The size
 * limits only stop adding rows and columns, so imported and older tables
 * keep everything they hold.
 */
export function tableValue(data, { rowIds = null, colIds = null } = {}) {
  const src = Array.isArray(data?.rows) && data.rows.length ? data.rows : [['']];
  const width = src.reduce((w, r) => Math.max(w, Array.isArray(r) ? r.length : 0), 1);
  const rIds = rowIds || src.map(() => uid(8));
  const cIds = colIds || Array.from({ length: width }, () => uid(8));
  const m = new Y.Map();
  const rows = new Y.Map();
  const cols = new Y.Map();
  const cells = new Y.Map();
  keysAfter('', rIds.length).forEach((k, i) => rows.set(rIds[i], k));
  keysAfter('', cIds.length).forEach((k, i) => cols.set(cIds[i], k));
  src.forEach((row, r) =>
    cIds.forEach((c, i) => {
      const text = String((Array.isArray(row) ? row[i] : '') ?? '').slice(0, MAX_CELL);
      if (text) cells.set(cellKey(rIds[r], c), text);
    }),
  );
  m.set('header', data?.header !== false);
  m.set('rows', rows);
  m.set('cols', cols);
  m.set('cells', cells);
  return m;
}

/** The block's table structure, converting an older plain table first. */
function tableOf(doc, blockId) {
  const block = doc.getMap('blocks').get(blockId);
  if (!(block instanceof Y.Map)) return null;
  const value = block.get('table');
  if (value instanceof Y.Map) return value;
  // Same ids as readTable gives the plain table, so callers' ids still apply.
  const plain = readTable(value);
  const m = tableValue(plain, { rowIds: plain.rowIds, colIds: plain.colIds });
  block.set('table', m);
  return m;
}

/** Writes cell text: [{ row, col, text }]. Only cells that changed are written. */
export function setCells(doc, blockId, changes) {
  local(doc, () => {
    const t = tableOf(doc, blockId);
    if (!t) return;
    const rows = t.get('rows');
    const cols = t.get('cols');
    const cells = t.get('cells');
    for (const { row, col, text } of changes) {
      // A row or column someone else deleted meanwhile stays deleted.
      if (!rows.has(row) || !cols.has(col)) continue;
      const key = cellKey(row, col);
      const next = String(text ?? '').replace(/\n/g, ' ').slice(0, MAX_CELL);
      if ((cells.get(key) || '') === next) continue;
      if (next) cells.set(key, next);
      else cells.delete(key);
    }
  });
}

function insertLine(doc, blockId, which, { before = null, after = null } = {}) {
  let id = null;
  local(doc, () => {
    const t = tableOf(doc, blockId);
    if (!t) return;
    const lines = t.get(which);
    if (lines.size >= (which === 'rows' ? MAX_ROWS : MAX_COLS)) return;
    const ids = sortedIds(lines);
    let i = after ? ids.indexOf(after) + 1 : before ? ids.indexOf(before) : ids.length;
    if (i < 0 || (after && i === 0)) i = ids.length;
    const lo = i > 0 ? lines.get(ids[i - 1]) : '';
    const hi = i < ids.length ? lines.get(ids[i]) : '';
    id = uid(8);
    lines.set(id, keyBetween(lo, hi > lo ? hi : ''));
    // Two people deleting the last rows (or columns) at once can empty one side.
    const other = t.get(which === 'rows' ? 'cols' : 'rows');
    if (!other.size) other.set(uid(8), keyBetween('', ''));
  });
  return id;
}

/** Adds a row before or after another (or at the end). Returns its id, or null at the limit. */
export function insertRow(doc, blockId, where = {}) {
  return insertLine(doc, blockId, 'rows', where);
}

/** Adds a column before or after another (or at the end). Returns its id, or null at the limit. */
export function insertCol(doc, blockId, where = {}) {
  return insertLine(doc, blockId, 'cols', where);
}

function deleteLine(doc, blockId, which, id) {
  local(doc, () => {
    const t = tableOf(doc, blockId);
    if (!t) return;
    const lines = t.get(which);
    // A table keeps at least one row and one column.
    if (!lines.has(id) || lines.size <= 1) return;
    lines.delete(id);
    const cells = t.get('cells');
    const at = which === 'rows' ? 0 : 1;
    for (const key of [...cells.keys()]) if (key.split(':')[at] === id) cells.delete(key);
  });
}

export function deleteRow(doc, blockId, rowId) {
  deleteLine(doc, blockId, 'rows', rowId);
}

export function deleteCol(doc, blockId, colId) {
  deleteLine(doc, blockId, 'cols', colId);
}

export function setHeader(doc, blockId, on) {
  local(doc, () => {
    const t = tableOf(doc, blockId);
    if (t && (t.get('header') !== false) !== !!on) t.set('header', !!on);
  });
}
