/**
 * Show Changes: a running record of the edits made to the workbook's cells, for the pane that lists
 * who changed what, where and when (ui/changes-pane.js).
 *
 * The record lives on the workbook (`wb.changeHistory`, oldest first) and travels with it: in the
 * document's drafts through toJSON, and in a saved file through the app's sidecar (io.js). It is no part
 * of undo: undoing a step does not take its entry back out (the edit did happen), it adds an entry of
 * its own ("Undo: Paste"), so the list reads as the story of the book rather than its current state.
 *
 * What is kept is bounded: the newest CHANGE_LIMIT entries, each listing at most CELL_DETAIL_LIMIT cells
 * (with the count of all it touched) and each value cut to TEXT_LIMIT characters. A paste of a hundred
 * thousand cells costs the record a hundred short strings, not a copy of the paste.
 *
 * Every cell write passes through the workbook's _writeCells, which calls recordCellWrites with the
 * cells as they were and as they became; a change of format alone is not an entry. Row, column and
 * sheet changes are recorded by name only (recordStep), with the active sheet as their place. Writes
 * made inside one transaction (a fill, a replace-all on one sheet) join one entry.
 */
import { cellName, parseKey, rangeName, normalizeRange } from './cell.js';
import { formatValue } from './format.js';

export const CHANGE_LIMIT = 1000;
export const CELL_DETAIL_LIMIT = 100;
export const TEXT_LIMIT = 200;

const KINDS = new Set(['cells', 'structure', 'undo', 'redo']);
let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

const cut = (text) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : text);

/** What a cell holds, as the record keeps it: its formula (with its =), or its value as shown; null when empty. */
export function cellText(cell) {
  if (!cell) return null;
  if (cell.f != null) return cut(`=${cell.f}`);
  if (cell.v == null || cell.v === '') return null;
  let text;
  try { text = formatValue(cell.v, cell.s); } catch { text = String(cell.v); }
  return cut(String(text));
}

const sameValue = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
const sameContent = (a, b) => (a?.f ?? null) === (b?.f ?? null) && sameValue(a?.v ?? null, b?.v ?? null);

function push(wb, entry) {
  const list = wb.changeHistory || (wb.changeHistory = []);
  list.push(entry);
  if (list.length > CHANGE_LIMIT) list.splice(0, list.length - CHANGE_LIMIT);
  return entry;
}

/** The open transaction's entry for this sheet and kind, which a further write in it joins. */
function joinable(wb, sheetId, kind) {
  const open = wb._changeJoin;
  if (!open || !wb._group || open.group !== wb._group) return null;
  const last = wb.changeHistory?.at(-1);
  return last === open.entry && last.sheetId === sheetId && last.kind === kind ? last : null;
}

function remember(wb, entry) {
  wb._changeJoin = wb._group ? { group: wb._group, entry } : null;
}

/**
 * Note a write the workbook made: `before` and `after` are its { key, cell } lists, in step, and `box` the
 * block the write covered. Only the cells whose value or formula changed count; a write that only
 * restyled cells is no entry. Only the cells listed are read for their place, so a paste of a hundred
 * thousand cells costs one comparison each.
 */
export function recordCellWrites(wb, sheet, before, after, label, box = null) {
  if (wb._recordingOff) return null;
  const changed = [];
  for (let i = 0; i < after.length; i++) if (!sameContent(before[i].cell, after[i].cell)) changed.push(i);
  if (!changed.length) return null;
  let entry = joinable(wb, sheet.id, 'cells');
  if (!entry) {
    entry = push(wb, { id: newId(), at: Date.now(), author: wb.changeAuthor || null, kind: 'cells', label: String(label || 'Edit'), sheetId: sheet.id, sheet: sheet.name, count: 0, box: null, cells: [] });
    remember(wb, entry);
  }
  // The cells of the entry by key, so a cell written twice in one transaction keeps its first old value and its last new one.
  const known = entry.cells.length ? new Map(entry.cells.map((d, i) => [`${d.r},${d.c}`, i])) : null;
  let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
  for (const i of changed) {
    const at = known?.get(after[i].key);
    if (at != null) { entry.cells[at].to = cellText(after[i].cell); continue; }
    entry.count++;
    if (entry.cells.length >= CELL_DETAIL_LIMIT && box) continue;
    const { r, c } = parseKey(after[i].key);
    if (r < r1) r1 = r; if (r > r2) r2 = r; if (c < c1) c1 = c; if (c > c2) c2 = c;
    if (entry.cells.length < CELL_DETAIL_LIMIT) entry.cells.push({ r, c, from: cellText(before[i].cell), to: cellText(after[i].cell) });
  }
  // The block reached: the write's own when the cells listed are not all of them, else exactly theirs.
  const reach = box && changed.length > CELL_DETAIL_LIMIT ? box : r2 >= 0 ? { r1, c1, r2, c2 } : null;
  const was = entry.box;
  if (reach) entry.box = was ? { r1: Math.min(was.r1, reach.r1), c1: Math.min(was.c1, reach.c1), r2: Math.max(was.r2, reach.r2), c2: Math.max(was.c2, reach.c2) } : reach;
  return entry;
}

/** Note a change recorded by name alone: rows or columns inserted, a sheet deleted, an undo or redo. */
export function recordStep(wb, kind, label) {
  if (wb._recordingOff || !KINDS.has(kind)) return null;
  // Showing or hiding an outline's detail changes the view of the cells, not what they hold.
  if (kind === 'structure' && /^(Collapse|Expand)\b/.test(label)) return null;
  // A sheet added, deleted, renamed or moved is a change to the book's list of sheets, not to the sheet shown.
  const sheet = kind === 'structure' && /\bsheets?\b/i.test(label) ? null : wb.activeSheet;
  const open = joinable(wb, sheet?.id ?? null, kind);
  if (open && open.label === String(label)) { open.count++; return open; }
  const entry = push(wb, { id: newId(), at: Date.now(), author: wb.changeAuthor || null, kind, label: String(label || 'Edit'), sheetId: sheet?.id ?? null, sheet: sheet?.name ?? null, count: 1, box: null, cells: [] });
  remember(wb, entry);
  return entry;
}

/** Forget every entry (the pane's Clear command). The book is changed by it, so it saves. */
export function clearChangeHistory(wb) {
  if (!wb.changeHistory?.length) return false;
  wb.changeHistory = [];
  wb._changeJoin = null;
  wb.dirty = true;
  wb._emit?.('change-history');
  return true;
}

const str = (v, max = TEXT_LIMIT + 1) => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Read a stored record back, leaving out whatever is malformed: it comes from a file anyone may have edited. */
export function normalizeChangeHistory(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(-CHANGE_LIMIT)) {
    if (!e || typeof e !== 'object' || !KINDS.has(e.kind) || !Number.isFinite(e.at)) continue;
    const cells = Array.isArray(e.cells) ? e.cells.slice(0, CELL_DETAIL_LIMIT).filter((d) => d && int(d.r) != null && int(d.c) != null)
      .map((d) => ({ r: d.r, c: d.c, from: str(d.from), to: str(d.to) })) : [];
    const b = e.box;
    const box = b && [b.r1, b.c1, b.r2, b.c2].every((n) => int(n) != null) ? normalizeRange(b) : null;
    out.push({ id: str(e.id, 64) || newId(), at: e.at, author: str(e.author, 200), kind: e.kind, label: str(e.label, 200) || 'Edit',
      sheetId: typeof e.sheetId === 'string' || Number.isFinite(e.sheetId) ? e.sheetId : null, sheet: str(e.sheet, 64),
      count: Math.max(int(e.count) ?? cells.length, cells.length), box, cells });
  }
  return out;
}

/** The record for saving: each entry names its sheet as the sheet is called now (a file's sheets get new ids when it opens). */
export function serializeChangeHistory(wb) {
  return (wb.changeHistory || []).map((e) => ({ ...e, sheet: wb.sheet(e.sheetId)?.name ?? e.sheet, box: e.box && { ...e.box }, cells: e.cells.map((d) => ({ ...d })) }));
}

/** The sheet an entry was made on, by its id while the book stays open and by its name once the file has been reopened. */
export function entrySheet(wb, entry) {
  return (entry.sheetId != null && wb.sheet(entry.sheetId)) || (entry.sheet != null ? wb.sheetByName(entry.sheet) : null) || null;
}

/** Where an entry happened, as the pane writes it: Sheet1!B2, Sheet1!A1:C9, or the sheet alone. */
export function entryPlace(wb, entry) {
  const name = entrySheet(wb, entry)?.name ?? entry.sheet ?? '';
  if (!entry.box) return name;
  return `${name}!${rangeName(entry.box)}`;
}

export const detailPlace = (d) => cellName(d.r, d.c);

const overlaps = (a, b) => a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;

/**
 * The entries to show, newest first: on `sheetId` alone when it is given, and reaching into `range`
 * (on that sheet) when that is given too, each such entry's cells cut down to those inside it. `limit`
 * caps the list; `more` says whether older entries were left out.
 */
export function changeEntries(wb, { sheetId = null, range = null, limit = Infinity } = {}) {
  const list = wb.changeHistory || [];
  const area = range ? normalizeRange(range) : null;
  const out = [];
  let more = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const sheet = entrySheet(wb, e);
    if (sheetId != null && sheet?.id !== sheetId) continue;
    let shown = e;
    if (area) {
      if (!e.box || !overlaps(e.box, area)) continue;
      const cells = e.cells.filter((d) => d.r >= area.r1 && d.r <= area.r2 && d.c >= area.c1 && d.c <= area.c2);
      // An entry whose listed cells all lie elsewhere still reached the range when it touched more cells than it lists.
      if (!cells.length && e.count <= e.cells.length) continue;
      shown = { ...e, cells, partial: cells.length < e.cells.length };
    }
    if (out.length >= limit) { more = true; break; }
    out.push(shown);
  }
  return { entries: out, more };
}
