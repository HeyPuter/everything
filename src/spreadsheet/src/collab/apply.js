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
import { maxOf } from '../core/numeric.js';

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

function writeLines(live, prop, values, modes = null) {
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
    // A row sized to fit its contents keeps the height this screen measured for it; one the same change gives a
    // height of its own (a row dragged to a size, which the change also marks fixed) takes that height.
    if (prop === 'rowHeights' && (modes && own(modes, k) ? modes[k] : live.rowHeightModes.get(i)) === 'auto') continue;
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

/**
 * The insertions of rows from ops[n] on, on one sheet, each below the rows the one before put in and the line above
 * it one that was already there, none inside a table (a row there takes the table's calculated columns, one place at
 * a time): what inserting them all at once at their places before any went in gives (see Workbook._insertSequence).
 */
function insertRun(ops, n, sheet) {
  const first = ops[n], group = [first];
  if (first.axis !== 'row') return group;
  const inTable = (at) => sheet.tables.some((t) => t.range.r1 < at && at <= t.range.r2);
  if (inTable(first.at)) return group;
  let before = first.n;
  for (let k = n + 1; k < ops.length; k++) {
    const op = ops[k], last = group.at(-1);
    if (op.t !== 'insert' || op.s !== first.s || op.axis !== 'row' || !(op.n >= 1) || !(op.at > last.at + last.n) || inTable(op.at - before)) break;
    group.push(op);
    before += op.n;
  }
  return group;
}

/** The deletions of rows from ops[n] on, on one sheet, each wholly above the one before: one deletion of all their runs. */
function deleteRun(ops, n, sheet) {
  const first = ops[n], group = [first];
  if (first.axis !== 'row') return group;
  const low = (op) => op.runs.reduce((m, r) => Math.min(m, r.from), Infinity);
  let count = first.runs.reduce((k, r) => k + r.to - r.from + 1, 0), floor = low(first);
  for (let k = n + 1; k < ops.length; k++) {
    const op = ops[k];
    if (op.t !== 'delete' || op.s !== first.s || op.axis !== 'row' || !(maxOf(op.runs.map((r) => r.to)) < floor)) break;
    count += op.runs.reduce((c, r) => c + r.to - r.from + 1, 0);
    floor = low(op);
    group.push(op);
  }
  // Deleting every row leaves one, emptied: that stays the last deletion's own doing.
  return count >= sheet.rows ? [first] : group;
}

/** Make sure the sheet reaches line `need - 1` on `axis`, so an operation from a browser scrolled further is not cut short. */
function reach(wb, sheet, axis, need) {
  if (axis === 'row' ? sheet.rows < need : sheet.cols < need) wb._growTo(sheet, axis === 'row' ? need : 0, axis === 'col' ? need : 0);
}

/**
 * Never every sheet hidden, nor a hidden sheet in front, as when a file is read: two people hiding the last two
 * sheets on show at once would leave none (and the next sheet deleted nowhere to go). The first sheet is shown
 * again, as one step to take back with the rest, the same in every browser; this person moves off a sheet hidden.
 */
function keepOneShown(wb, label) {
  if (!wb.sheets.length) return;
  if (wb.sheets.every((s) => s.hidden)) {
    const id = wb.sheets[0].id;
    const show = (hidden) => { const live = wb.sheet(id); if (!live) return; live.hidden = hidden; wb._changed('structure', id); };
    show(false);
    wb._push({ label, undo: () => show(true), redo: () => show(false) });
  }
  const active = wb.sheets.findIndex((s) => s.id === wb.activeSheetId);
  if (active < 0 || wb.sheets[active].hidden) wb.activeSheetId = (wb.sheets.slice(active + 1).find((s) => !s.hidden) || wb.sheets.find((s) => !s.hidden)).id;
}

/**
 * Apply operations to `wb` in order. Call it inside a transaction: each write hands the workbook an undo step.
 * Operations on a sheet that is gone are skipped, as are structural ones the workbook refuses (a protected
 * sheet, say): the same in every browser, which hold the same state.
 */
export function applyOps(wb, ops, label = 'Shared edit') {
  let alone = 0; // ops before this index go in one at a time: the group they were in was refused
  for (let n = 0; n < ops.length; n++) {
    const op = ops[n];
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
        if (own(op.v, 'hidden')) keepOneShown(wb, label);
        break;
      }
      case 'lines': {
        if (!sheet || !LINE_PROPS[op.p]) break;
        const id = sheet.id;
        const prev = lineValues(sheet, op.p, Object.keys(op.v));
        const type = op.p === 'notes' ? 'cells' : 'layout';
        // How the change leaves each row's sizing, when it says (its modes come after its heights).
        const modes = op.p === 'rowHeights' ? Object.assign({}, ...ops.slice(n + 1).filter((o) => o.t === 'lines' && o.p === 'rowHeightModes' && o.s === op.s).map((o) => o.v)) : null;
        const set = (values) => { const live = wb.sheet(id); if (!live) return; writeLines(live, op.p, values, modes); wb._changed(type, id); };
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
      case 'insert': {
        if (!sheet) break;
        // Rows inserted one below another (taking back a deletion of the rows a filter shows: an insertion per run)
        // go in at once, the sheet renumbered once rather than once per run; one refused sends each in on its own.
        const group = n < alone ? [op] : insertRun(ops, n, sheet);
        if (group.length > 1) {
          reach(wb, sheet, 'row', group.at(-1).at - group.slice(0, -1).reduce((k, i) => k + i.n, 0) + 1);
          if (wb._insertSequence(op.s, 'row', group.map((i) => ({ at: i.at, n: i.n })))) { n += group.length - 1; break; }
          alone = n + group.length;
        }
        reach(wb, sheet, op.axis, op.at + 1);
        wb._insert(op.s, op.axis, op.at, op.n);
        break;
      }
      case 'delete': {
        if (!sheet) break;
        reach(wb, sheet, op.axis, maxOf(op.runs.map((r) => r.to)) + 1);
        // Deletions each above the one before (taking back insertions of rows one below another) go at once, as one.
        const group = n < alone ? [op] : deleteRun(ops, n, sheet);
        if (group.length > 1) {
          if (wb._deleteLines(op.s, 'row', group.flatMap((d) => d.runs.map((r) => ({ from: r.from, to: r.to }))))) { n += group.length - 1; break; }
          alone = n + group.length;
        }
        wb._deleteLines(op.s, op.axis, op.runs.map((r) => ({ from: r.from, to: r.to })));
        break;
      }
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
