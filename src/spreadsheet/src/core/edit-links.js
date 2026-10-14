/**
 * Data ▸ Edit Links: the pure parts of managing the book's links to other workbooks.
 *
 * A link is one entry of wb.externalWorkbooks.books, addressed from formulas as [n] (its place in the list,
 * from 1): =[1]Prices!B4. Each workbook link keeps the target it was saved with (a path relative to this
 * file, a drive path, or an address elsewhere) and a cache of the cells it supplies, which is what formulas
 * read. Updating reads the source again and refreshes that cache; changing the source points the link at
 * another file; breaking it turns every formula that reads it into the value it shows now.
 */

import { normalizeExternalWorkbooks, mapExternalWorkbookRefs } from './external-workbooks.js';
import { rebaseWorkbookTarget, relativeWorkbookTarget, workbookPathUri } from './workbook-location.js';
import { tokenize } from './formula/tokenizer.js';
import { sheetKey } from './refs.js';
import { parseKey } from './cell.js';

/** Cells a refreshed link may cache in all, as the file format allows. */
const MAX_CACHED_CELLS = 1048576;

/** A link's file name, for the list: the last part of its target, decoded. */
export function linkName(target) {
  const path = String(target || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const last = path.split('/').filter(Boolean).at(-1) || path;
  try { return decodeURIComponent(last); } catch { return last; }
}

/**
 * The drive path a link's target names, or null when it names nothing on the drive (an address on another
 * computer or the web, or a relative path when this book has never been saved). `docPath` is this book's path.
 */
export function linkPath(target, docPath = null) {
  const text = String(target || '').trim();
  if (!text || /^[a-z][\w+.-]*:/i.test(text) || text.startsWith('//') || text.includes('\\')) return null;
  let path = text;
  if (!text.startsWith('/')) {
    const base = workbookPathUri(docPath);
    if (!base) return null;
    path = rebaseWorkbookTarget(text, base);
    if (!path.startsWith('/')) return null;
  }
  try { return path.split(/[?#]/, 1)[0].split('/').map(decodeURIComponent).join('/'); } catch { return null; }
}

/** The target to store for a drive path: relative to this book where both are on the drive, else the path itself. */
export function targetForPath(path, docPath = null) {
  const absolute = workbookPathUri(path);
  if (!absolute) return encodeURI(String(path));
  return (workbookPathUri(docPath) && relativeWorkbookTarget(path, docPath)) || absolute;
}

/** The links for the dialog: { index (from 1), kind, name, target, type, update, sheets }. */
export function linkEntries(wb) {
  return (wb.externalWorkbooks?.books || []).map((book, i) => {
    const kind = book.kind === 'dde' ? 'dde' : book.kind === 'ole' ? 'ole' : 'workbook';
    const target = kind === 'dde' ? '' : book.target || '';
    return {
      index: i + 1, kind, target,
      name: kind === 'dde' ? 'DDE link' : linkName(target),
      type: kind === 'workbook' ? 'Workbook' : kind === 'dde' ? 'DDE' : 'OLE object',
      // Workbook links follow their source whenever it is updated; the others wait to be asked.
      update: kind === 'workbook' ? 'Automatic' : 'Manual',
      sheets: book.sheets.map((s) => s.name),
    };
  });
}

/** Does a formula read the link numbered `index`? Unreadable text is taken to (so nothing it may need is dropped). */
export function formulaUsesLink(formula, index) {
  if (typeof formula !== 'string' || !formula.includes(`[${index}]`)) return false;
  let tokens;
  try { tokens = tokenize(formula); } catch { return true; }
  const prefix = `[${index}]`;
  return tokens.some((t) => [t.sheet, t.sheetEnd].some((s) => typeof s === 'string' && s.startsWith(prefix)));
}

/**
 * Where a link is read: the cells whose formulas read it ({ sheetId, r, c }), and how many other places (defined
 * names, conditional formats, validation rules, table column templates) still do.
 */
export function linkUsage(wb, index) {
  const cells = [];
  let other = 0;
  for (const sheet of wb.sheets) {
    for (const [key, cell] of sheet.cells) if (cell.f != null && formulaUsesLink(cell.f, index)) cells.push({ sheetId: sheet.id, ...parseKey(key) });
    for (const rule of [...(sheet.rules || []), ...(sheet.validations || [])]) if (textsOf(rule).some((f) => formulaUsesLink(f, index))) other++;
    for (const t of sheet.tables || []) for (const f of Object.values(t.calc || {})) if (formulaUsesLink(f, index)) other++;
  }
  for (const n of wb.names || []) if (formulaUsesLink(n.ref, index)) other++;
  return { cells, other };
}

/** The strings an object holds, at any depth (a rule's formulas, wherever its kind keeps them). */
function textsOf(value, out = [], depth = 0) {
  if (typeof value === 'string') out.push(value.replace(/^=/, ''));
  else if (value && typeof value === 'object' && depth < 6) for (const v of Object.values(value)) textsOf(v, out, depth + 1);
  return out;
}

/** A copy of the links with one book replaced (or, with `book` null, left out). */
function withBook(wb, index, book) {
  const books = [...(wb.externalWorkbooks?.books || [])];
  if (book) books[index - 1] = book; else books.splice(index - 1, 1);
  return books.length ? normalizeExternalWorkbooks({ version: 1, books }) : null;
}

/** The value a source cell hands a link's cache: a plain value, or { error }. */
function cachedValue(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  if (typeof value === 'string') return value.slice(0, 32767);
  if (typeof value === 'object' && typeof value.error === 'string') return { error: value.error };
  if (typeof value === 'object' && value.range) return cachedValue(value.values?.[0]?.[0]);
  return null;
}

/**
 * The link's sheets filled from a source workbook (a Workbook): each sheet of the link takes the values of the
 * source sheet of the same name (case aside); a sheet the source no longer has keeps its cache, marked as not
 * refreshed. `missing` names those sheets.
 */
export function refreshedSheets(book, source) {
  const missing = [];
  let budget = MAX_CACHED_CELLS;
  const sheets = book.sheets.map((sheet) => {
    const from = source.sheets.find((s) => sheetKey(s.name) === sheetKey(sheet.name));
    if (!from) { missing.push(sheet.name); return { ...sheet, refreshError: true }; }
    const cells = {};
    for (const key of from.cells.keys()) {
      if (budget <= 0) break;
      const { r, c } = parseKey(key);
      const v = cachedValue(source.getValue(from.id, r, c));
      if (v == null) continue;
      cells[`${r},${c}`] = v;
      budget--;
    }
    const { refreshError, ...rest } = sheet;
    return { ...rest, cells };
  });
  return { sheets, missing };
}

/** Update Values: refresh link `index` from its source workbook (a Workbook). One undo step. Returns the sheets the source lacked. */
export function updateLinkValues(wb, index, source, label = 'Update link values') {
  const book = wb.externalWorkbooks?.books[index - 1];
  if (!book || book.kind) return { missing: [], updated: false };
  const { sheets, missing } = refreshedSheets(book, source);
  wb.setExternalWorkbooks(withBook(wb, index, { ...book, sheets }), label);
  return { missing, updated: true };
}

/**
 * Change Source: point link `index` at `target` instead. With the new source's workbook in hand the cache is
 * refreshed from it at once; the sheet names the formulas read must be found there, or they show #REF! until they
 * are. The link's saved extras (other addresses for the old file) belong to the old source and are dropped.
 */
export function changeLinkSource(wb, index, target, source = null) {
  const book = wb.externalWorkbooks?.books[index - 1];
  if (!book || book.kind || !String(target || '').trim()) return { changed: false, missing: [] };
  const { relationships, xml, ...rest } = book;
  let next = { ...rest, target: String(target).trim() };
  let missing = [];
  if (source) ({ sheets: next.sheets, missing } = { ...refreshedSheets(next, source) });
  wb.setExternalWorkbooks(withBook(wb, index, next), 'Change link source');
  return { changed: true, missing };
}

/**
 * Break Link: every cell formula that reads link `index` becomes the value it shows now (its spilled cells too),
 * as one undo step. The link itself goes once nothing reads it any more, and the links after it move up a place in
 * every formula. Returns { converted, removed, kept } where `kept` counts the places that still read it (formulas a
 * protected sheet would not let go, defined names, rules).
 */
export function breakLink(wb, index) {
  const book = wb.externalWorkbooks?.books[index - 1];
  if (!book) return { converted: 0, removed: false, kept: 0 };
  let converted = 0;
  let removed = false;
  let kept = 0;
  wb.transaction('Break link', () => {
    const bySheet = new Map();
    for (const at of linkUsage(wb, index).cells) {
      if (!bySheet.has(at.sheetId)) bySheet.set(at.sheetId, []);
      bySheet.get(at.sheetId).push({ r1: at.r, c1: at.c, r2: at.r, c2: at.c });
    }
    for (const [sheetId, ranges] of bySheet) {
      const snapshot = wb.formulaValueSnapshot(sheetId, ranges, { includeErrors: true, includeLinks: true });
      const { count } = snapshot;
      // A value keeps no record of the result the link last gave its formula.
      const entries = snapshot.entries.map((e) => { const cell = { ...e.cell }; delete cell.externalResult; return { ...e, cell }; });
      if (entries.length && wb.setCells(sheetId, entries, 'Break link')) converted += count;
    }
    const left = linkUsage(wb, index);
    kept = left.cells.length + left.other;
    if (kept) return;
    // Nothing reads the link now: it goes, and [n+1] and after become [n] and after everywhere they are written.
    const shift = (f) => (typeof f === 'string' && f.includes('[') ? mapExternalWorkbookRefs(f, (n) => (n > index ? n - 1 : n)) : f);
    const later = wb.externalWorkbooks.books.length > index;
    wb.setExternalWorkbooks(withBook(wb, index, null), 'Break link');
    if (later) {
      wb._rewriteFormulas((f) => shift(f), 'Break link');
      wb._rewriteNamedFormulas((f) => shift(f), 'Break link');
      wb._rewriteRuleFormulas((f) => shift(f), 'Break link');
    }
    removed = true;
  });
  return { converted, removed, kept };
}
