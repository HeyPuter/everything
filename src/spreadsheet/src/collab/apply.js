/**
 * Applying shared-workbook operations (see ops.js) to a workbook. The same code applies someone else's
 * change, replays this person's own unconfirmed changes on top of the room's latest state, applies an
 * undo, and works out in a scratch workbook where a change's formulas and settings go when rows, columns
 * or sheets moved under it (see replica.js).
 *
 * Every write goes through the workbook's own paths (its cell writer, its row and column operations, its
 * sheet operations), so values are normalized, formulas recalculate and the screen hears of it as it does
 * for a local edit. Each write hands the workbook an undo step (`_push`), which the caller keeps or drops.
 */

import { makeSheet, sheetShapeJSON, cloneCell } from '../core/workbook.js';
import { parseCellKey, LINE_PROPS } from './ops.js';

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** A cell's content, everything but its format, as a change carries it (null for none). `f` overrides its formula. */
export function contentOf(cell, f = cell?.f) {
  if (!cell) return null;
  const c = cloneCell(f === cell.f ? cell : { ...cell, f });
  delete c.s;
  return c.v == null && c.f == null && Object.keys(c).length === 2 ? null : c;
}

/** A sheet as a 'put' carries it: its settings and every cell. */
export function sheetJSON(sheet) {
  return { ...sheetShapeJSON(sheet), cells: Object.fromEntries([...sheet.cells].map(([k, c]) => [k, cloneCell(c)])) };
}

/** The settings of a sheet named in `keys`, serialized (null for one at its default). */
export function sheetProps(sheet, keys) {
  const shape = sheetShapeJSON(sheet);
  return Object.fromEntries(keys.map((k) => [k, shape[k] === undefined ? null : JSON.parse(JSON.stringify(shape[k]))]));
}

/** Put serialized settings on a live sheet, normalized as a file's are; its cells and its view stay. */
function writeProps(live, values) {
  const merged = { ...sheetShapeJSON(live), cells: {} };
  for (const [k, v] of Object.entries(values)) {
    if (v == null) delete merged[k];
    else merged[k] = v;
  }
  const temp = makeSheet(merged);
  for (const k of Object.keys(values)) {
    if (k in temp) live[k] = temp[k];
    else delete live[k];
  }
  // A split window and frozen panes exclude each other: the frozen panes win, as when a sheet is read.
  if (live.frozenRows || live.frozenCols) delete live.split;
}

/** The current values of a row/column (or per-cell) setting at `keys`, as a 'lines' operation carries them. */
export function lineValues(sheet, prop, keys) {
  const out = {};
  for (const k of keys) {
    if (prop === 'hiddenRows' || prop === 'hiddenCols') out[k] = sheet[prop].has(Number(k)) ? true : null;
    else if (prop === 'notes') out[k] = sheet.notes.get(k) ?? null;
    else {
      const v = sheet[prop].get(Number(k));
      out[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
    }
  }
  return out;
}

function writeLines(live, prop, values) {
  if (prop === 'hiddenRows' || prop === 'hiddenCols') {
    for (const [k, v] of Object.entries(values)) { if (v) live[prop].add(Number(k)); else live[prop].delete(Number(k)); }
    return;
  }
  if (prop === 'notes') {
    for (const [k, v] of Object.entries(values)) { if (typeof v === 'string' && v.trim()) live.notes.set(k, v); else live.notes.delete(k); }
    return;
  }
  // Sizes and line formats are normalized as a file's are (bounds, colors).
  const temp = makeSheet({ [prop]: Object.fromEntries(Object.entries(values).filter(([, v]) => v != null)), cells: {} });
  for (const [k, v] of Object.entries(values)) {
    const i = Number(k);
    // A row sized to fit its contents keeps the height this screen measured for it.
    if (prop === 'rowHeights' && live.rowHeightModes.get(i) === 'auto') continue;
    const next = v == null ? undefined : temp[prop].get(i);
    if (next === undefined) live[prop].delete(i);
    else live[prop].set(i, next);
  }
}

/** A free sheet name for a sheet added by someone else whose name is taken here: the same answer in every browser. */
function freeName(wb, name) {
  if (!wb.validateSheetName(name)) return name;
  for (let n = 2; n < 10_000; n++) {
    const suffix = ` (${n})`;
    const candidate = name.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
    if (!wb.validateSheetName(candidate)) return candidate;
  }
  return wb.uniqueSheetName();
}

/** Make sure the sheet reaches line `need - 1` on `axis`, so an operation from a browser scrolled further is not cut short. */
function reach(wb, sheet, axis, need) {
  if (axis === 'row' ? sheet.rows < need : sheet.cols < need) wb._growTo(sheet, axis === 'row' ? need : 0, axis === 'col' ? need : 0);
}

/**
 * Apply operations to `wb` in order. Call it inside a transaction: each write hands the workbook an undo step.
 * Operations on a sheet that is gone are skipped, as are structural ones the workbook refuses (a protected
 * sheet, say): the same in every browser, which hold the same state.
 */
export function applyOps(wb, ops, label = 'Shared edit') {
  for (const op of ops) {
    const sheet = op.s != null ? wb.sheet(op.s) : null;
    switch (op.t) {
      case 'cells': {
        if (!sheet) break;
        const keys = new Set([...Object.keys(op.v || {}), ...Object.keys(op.st || {})]);
        const entries = [];
        for (const key of keys) {
          const p = parseCellKey(key);
          if (!p) continue;
          const cur = sheet.cells.get(key);
          const content = own(op.v, key) ? op.v[key] : contentOf(cur);
          let style = cur?.s ? { ...cur.s } : null;
          const patch = op.st?.[key];
          if (patch) {
            style = { ...(style || {}) };
            for (const [k, v] of Object.entries(patch)) { if (v == null) delete style[k]; else style[k] = v; }
            if (!Object.keys(style).length) style = null;
          }
          entries.push({ r: p.r, c: p.c, cell: { ...(content || { v: null, f: null }), ...(style ? { s: style } : {}) } });
        }
        if (entries.length) wb._writeCells(sheet, entries, label);
        break;
      }
      case 'props': {
        if (!sheet) break;
        const id = sheet.id;
        const prev = sheetProps(sheet, Object.keys(op.v));
        const set = (values) => { const live = wb.sheet(id); if (!live) return; writeProps(live, values); wb._changed('structure', id); };
        set(op.v);
        wb._push({ label, undo: () => set(prev), redo: () => set(op.v) });
        break;
      }
      case 'lines': {
        if (!sheet || !LINE_PROPS[op.p]) break;
        const id = sheet.id;
        const prev = lineValues(sheet, op.p, Object.keys(op.v));
        const type = op.p === 'notes' ? 'cells' : 'layout';
        const set = (values) => { const live = wb.sheet(id); if (!live) return; writeLines(live, op.p, values); wb._changed(type, id); };
        set(op.v);
        wb._push({ label, undo: () => set(prev), redo: () => set(op.v) });
        break;
      }
      case 'book': {
        const prev = wb.bookState(Object.keys(op.v));
        wb.applyBookState(op.v);
        wb._push({ label, undo: () => wb.applyBookState(prev), redo: () => wb.applyBookState(op.v) });
        break;
      }
      case 'put': {
        if (sheet) break;
        wb._structural(label, () => {
          const json = { ...op.sheet, id: op.s };
          json.name = freeName(wb, String(json.name || 'Sheet'));
          wb.sheets.splice(Math.min(op.at, wb.sheets.length), 0, makeSheet(json));
        });
        break;
      }
      case 'insert':
        if (!sheet) break;
        reach(wb, sheet, op.axis, op.at + 1);
        wb._insert(op.s, op.axis, op.at, op.n);
        break;
      case 'delete':
        if (!sheet) break;
        reach(wb, sheet, op.axis, Math.max(...op.runs.map((r) => r.to)) + 1);
        wb._deleteLines(op.s, op.axis, op.runs.map((r) => ({ from: r.from, to: r.to })));
        break;
      case 'move':
        if (!sheet) break;
        reach(wb, sheet, op.axis, Math.max(op.from + op.count, op.to));
        wb._moveLines(op.s, op.axis, op.from, op.count, op.to);
        break;
      case 'rename':
        if (sheet) wb.renameSheet(op.s, op.name);
        break;
      case 'drop':
        if (sheet) wb.deleteSheet(op.s);
        break;
      case 'order':
        if (sheet) wb.moveSheet(op.s, op.to);
        break;
    }
  }
}
