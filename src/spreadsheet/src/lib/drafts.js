/**
 * Local drafts: a copy of unsaved changes kept in this browser, so a tab
 * closed while offline (or before an autosave landed) loses nothing. The
 * draft is written shortly after each edit and removed once the file on
 * Puter holds the same version; opening a file whose draft is newer offers
 * to restore it.
 */

import { accountStorageKey, storageScope } from './account-storage.js';
import { cloneCell, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT } from '../core/workbook.js';
import { normalizeCalculationCompatibility } from '../core/calculation-compatibility.js';
import { effectiveColorPalette } from '../core/font-color.js';
import { effectiveFontTheme } from '../core/font-theme.js';
import { normalFontStyle } from '../core/normal-font.js';
import { unpackNativeFillState, nativeFillProjection } from '../core/native-fill.js';
import { nativeDefaultCellFormatProjection } from '../core/native-default-cell-format.js';
import { normalizeRichText, richFontStyle } from '../core/rich-text.js';
import { styleResetAt } from '../core/style-resets.js';
import { numFmtToStyle, styleToNumFmt } from '../core/format.js';
import { DRAFT_ENCODING, packDraftWorkbook, unpackDraftWorkbook } from './draft-codec.js';
import { serializeChangeHistory } from '../core/change-history.js';

const PREFIX = 'spreadsheet:draft';
// localStorage gives an origin about 5 MB, counted in UTF-16 units, so one item can hold some
// 2.5 million characters at most; a little under that leaves room for the key and the account's
// other records. Very large books are not drafted.
const MAX_CHARS = 2_400_000;
const MIN_CELL_CHARS = 14; // '"1,2":{"v":1},' — the least a cell takes in the draft
// What the last full attempt measured for a book: characters of draft per stored cell (about 45 for
// ordinary cells). While that says the book cannot fit, it is not serialized again after every edit
// for nothing; a sample of its cells confirms first, since the cells may have grown shorter meanwhile.
const measured = new WeakMap();
const SAMPLE_CELLS = 400;
const SAMPLE_MARGIN = 1.1; // a sample is an estimate: a book it puts within a tenth of the cap is tried in full

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** An id for a draft's revision, or for a new spreadsheet's key: two documents with the same title need independent recovery copies. */
export const uniqueId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('');

/** A plain object, as JSON gives one: not null, not a list. */
const isRecord = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

/**
 * Does the record hold a book and a name, as a draft written here does? A book is a non-empty list of
 * sheets, each an object holding its cells as a map: the least the workbook's loader takes (see
 * makeSheet), which sifts the rest of a sheet's metadata itself. A record with a null sheet, or a sheet
 * without cells, is no book, so it is neither offered, parked nor kept over another draft.
 */
export const readableDraft = (draft) => typeof draft?.name === 'string' && !!draft.name
  && Array.isArray(draft.workbook?.sheets) && draft.workbook.sheets.length > 0
  && draft.workbook.sheets.every((sheet) => isRecord(sheet) && isRecord(sheet.cells));

/** The storage key for a document: its path, or its name while it has no file yet. */
export function draftKey(path, name = '', owner = storageScope(), id = '') {
  return `${accountStorageKey(PREFIX, owner)}${path || `new:${name}${id ? `:${id}` : ''}`}`;
}

/** Where edits made while an earlier draft of the same document awaits a decision are kept: beside it. */
const LIVE = ':live';
export function liveDraftKey(key) {
  return `${key}${LIVE}`;
}

/**
 * Write the workbook as a draft. False when storage is unavailable or the book is too large.
 * `fileModified` is the file's modification time (ms) as the document knew it when the edits
 * were made, so that on reopening the draft can be compared with the file by revision rather
 * than by this browser's clock against the server's. `fileUid` is the file's id on the drive,
 * by which the file is found again when it has been moved or renamed elsewhere meanwhile.
 */
export function saveDraft(key, wb, name = '', revision = null, { fileModified, fileUid } = {}) {
  const s = store();
  if (!s) return false;
  // A book far too large to fit is not serialized at all: even the
  // smallest cell takes MIN_CELL_CHARS, so this estimate never turns away a
  // draft that would have fit.
  const cells = wb.sheets.reduce((n, sheet) => n + sheet.cells.size, 0);
  if (cells * MIN_CELL_CHARS > MAX_CHARS) return false;
  // A book the last attempt found too large is drafted again once it shrinks below the cap, by
  // losing cells or by its cells growing shorter; until then the attempt is not repeated.
  const perCell = measured.get(wb);
  if (perCell && cells * perCell > MAX_CHARS && sampleChars(wb, cells) > MAX_CHARS * SAMPLE_MARGIN) return false;
  let text;
  // Whether the book may load outside content travels with the draft: an import from elsewhere stays blocked when recovered.
  try {
    const workbook = wb.toJSON(), packed = packDraftWorkbook(workbook);
    // Show Changes' record of edits rides beside the book (it is no part of toJSON, which undo restores exactly).
    if (wb.changeHistory?.length) (packed || workbook).changeHistory = serializeChangeHistory(wb);
    text = JSON.stringify({ savedAt: Date.now(), name, version: wb.version, ...(revision ? { revision } : {}), ...(fileModified !== undefined ? { fileModified } : {}), ...(fileUid ? { fileUid } : {}), external: wb.externalAllowed !== false,
      // Older tabs must not mistake encoded metadata for an ordinary workbook
      // and offer an incomplete recovery. The reader returns the usual shape.
      workbook: packed ? null : workbook, ...(packed ? { encoding: DRAFT_ENCODING, packedWorkbook: packed } : {}) });
  } catch { return false; }
  text = compact(text);
  if (cells) measured.set(wb, text.length / cells);
  if (text.length > MAX_CHARS) return false;
  try { s.setItem(key, text); return true; } catch { return false; }
}

/**
 * A cell without a formula, or without a value, goes without that key (a third of the text for
 * plain cells; the book reads either back as null). Each pattern holds a bare quote, which no JSON
 * string can, so nothing inside a cell's text is touched; only cells have keys named v and f.
 */
function compact(text) {
  return text.replaceAll(',"f":null', '').replaceAll('"v":null,', '');
}

/** About how many characters a book's cells would take in the draft, from a spread sample of them as they are now. */
function sampleChars(wb, cells) {
  // Every cell has the same chance whatever the sheet's width (a fixed stride over a sheet of ten columns
  // lands on one column only), and the same cells are picked on every attempt: the k-th cell is taken when
  // the low word of k times the golden ratio falls under the share wanted.
  const threshold = 2 ** 32 * Math.min(1, SAMPLE_CELLS / Math.max(1, cells));
  const sample = [];
  let k = 0;
  for (const sheet of wb.sheets) {
    sheet.cells.forEach((cell, key) => { if (((k++ * 2654435761) >>> 0) < threshold) sample.push([key, cloneCell(cell)]); });
  }
  if (!sample.length) return 0;
  // In the draft a cell reads "key":{...}, two characters shorter than the ["key",{...}] pairs measured here.
  return (compact(JSON.stringify(sample)).length - 2 * sample.length) / sample.length * cells;
}

/** Is `key` where the current account keeps a draft of a spreadsheet that has no file yet? */
export function isUnsavedDraftKey(key) {
  const prefix = accountStorageKey(PREFIX);
  return typeof key === 'string' && key.startsWith(prefix) && key.slice(prefix.length).startsWith('new:');
}

function parseDraft(raw) {
  try {
    if (!raw) return null;
    let draft = JSON.parse(raw);
    if (draft?.encoding) {
      if (draft.encoding !== DRAFT_ENCODING || draft.workbook !== null) return null;
      const { encoding, packedWorkbook, ...rest } = draft;
      draft = { ...rest, workbook: unpackDraftWorkbook(packedWorkbook) };
    }
    return draft && draft.workbook && Number.isFinite(draft.savedAt) ? draft : null;
  } catch { return null; }
}

/** The draft under a key: { savedAt, name, version, workbook } or null. */
export function loadDraft(key) {
  const s = store();
  if (!s) return null;
  try { return parseDraft(s.getItem(key)); } catch { return null; }
}

// A draft's text opens with what names it (see saveDraft): when it was written, its name and, after a
// few small fields, the id of the file it was made for; the book, nearly all of the text, follows.
const HEAD = /^\{"savedAt":(\d+),"name":("(?:[^"\\]|\\.)*")(?:,"(?:version|revision|fileModified)":(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|null))*(?:,"fileUid":("(?:[^"\\]|\\.)*"))?/;
/** What a draft is called, when it was written and which file it was made for (when one), read off the head of its text without parsing the book; null when the text is not a draft. */
function draftHead(raw) {
  const m = HEAD.exec(raw || '');
  if (m && raw.endsWith('}')) { try { return { name: JSON.parse(m[2]), savedAt: Number(m[1]), ...(m[3] ? { fileUid: JSON.parse(m[3]) } : {}) }; } catch { /* an odd escape: read the whole draft */ } }
  const draft = parseDraft(raw);
  return draft ? { name: draft.name, savedAt: draft.savedAt, ...(draft.fileUid ? { fileUid: draft.fileUid } : {}) } : null;
}

/**
 * The key of a draft this account kept for the file with this id, or null. A file renamed or moved
 * elsewhere keeps its id but not its address, and its draft is keyed by the address it had. The
 * edits made beside such a draft while it awaited a decision (see liveDraftKey) name the file too,
 * and answer with the key they are kept beside, whether or not a draft is still under it.
 */
export function draftKeyForFile(uid, owner = storageScope()) {
  const s = store();
  if (!s || !uid) return null;
  const prefix = accountStorageKey(PREFIX, owner);
  const tag = `"fileUid":${JSON.stringify(uid)}`;
  try {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key?.startsWith(prefix)) continue;
      const raw = s.getItem(key);
      // A cell's text could spell the tag too; the head of the draft decides, for the few texts that carry it.
      if (raw?.includes(tag) && draftHead(raw)?.fileUid === uid) return key.endsWith(LIVE) ? key.slice(0, -LIVE.length) : key;
    }
  } catch { /* storage refused */ }
  return null;
}

/**
 * Does one serialized book hold what the other holds? A load mints sheet ids anew and keeps
 * cells (notes, widths, heights) in another order than editing did, so both are compared in a
 * form that puts those aside; which sheet is in front, and how far the grid reaches, is a view,
 * not content.
 */
export function sameBook(a, b) {
  return canonicalBook(a) === canonicalBook(b);
}

function canonicalBook(json) {
  json = unpackNativeFillState(json || {});
  // The record of edits (Show Changes) is a log beside the book, not its contents.
  const { colorPalette, fontTheme, calculationCompatibility, nativeFillRecords, nativeNormalFill, changeHistory, ...content } = json;
  const sheets = Array.isArray(json?.sheets) ? json.sheets : [];
  const ids = new Map(sheets.map((s, i) => [s.id, i]));
  const sorted = (o, each = (x) => x) => (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, each(o[k], k)])) : o);
  // Archive resource IDs and dictionary insertion order are transport details.
  // Compare each fill's definition and its sharing relationship with Normal,
  // cells and lines, retaining distinctions between identical duplicate fills.
  const fillClasses = new Map(), fillDefinitions = [];
  const canonicalFill = fill => {
    if (!fill) return fill;
    if (!fillClasses.has(fill.key)) {
      fillClasses.set(fill.key, fillClasses.size);
      const { key, ...definition } = nativeFillProjection(fill);
      fillDefinitions.push(definition);
    }
    return { resource: fillClasses.get(fill.key) };
  };
  const normalFill = canonicalFill(nativeNormalFill);
  const fillStyle = style => style?.nativeFill ? { ...style, nativeFill: canonicalFill(style.nativeFill) } : style;
  // A table made in the session has no calculated columns until one is added; a load gives every table
  // an (empty) map of them. Compared without an empty map, the two are the same table.
  const table = (t) => { if (!t || typeof t !== 'object') return t; const { calc, ...rest } = t; return sorted(calc && Object.keys(calc).length ? { ...rest, calc: sorted(calc) } : rest); };
  // The file spells a number format out as its code and a load keeps that spelling: a cell made Currency in
  // the session ({ fmt: 'currency' }) comes back as { fmt: 'currency', cur: 'USD', dec: 2 }, a Number cell
  // with its group: true. Both books are compared in the spelling the loader gives, so a draft whose cells
  // show as the file's do is the same book, whichever side wrote the defaults out.
  const spelled = new Map();
  const numberFormat = (s) => {
    const { fmt, dec, cur, dateStyle, sec, group, code, ...rest } = s;
    const key = JSON.stringify([fmt, dec, cur, dateStyle, sec, group, code]);
    if (!spelled.has(key)) spelled.set(key, numFmtToStyle(styleToNumFmt({ fmt, dec, cur, dateStyle, sec, group, code })));
    return { ...rest, ...(spelled.get(key) || {}) };
  };
  // Cells are compared as the book reads them, whether a draft wrote their empty keys or not, and with their
  // style's keys in one order, whichever order the edits or the load gave them.
  const normal = { ...normalFontStyle(json?.normalFont || { name: 'Calibri', sz: 12 }), ...json.nativeDefaultCellFormat?.style };
  const cell = (c, key, sheet) => {
    const out = cloneCell(c);
    if (out?.richText) {
      // Native run-property records spell out default font properties. Compare
      // that spelling on both sides, without making absent records explicit:
      // those runs still inherit future changes to their cell's font.
      const [r, col] = key.split(',').map(Number);
      const reset = styleResetAt(sheet.styleResets || [], r, col);
      const base = richFontStyle({ ...normal, ...sheet.colStyles?.[col], ...sheet.rowStyles?.[r],
        ...(reset && Object.fromEntries(Object.keys(reset).map(k => [k, normal?.[k] ?? reset[k]]))), ...out.s });
      out.richText = normalizeRichText(out.richText.map(run => {
        if (!run.s) return run;
        const s = { bold: false, italic: false, strike: false, outline: false, shadow: false,
          condense: false, extend: false, underline: false, vertAlign: 'baseline',
          font: normal.font, size: normal.size, color: 'windowtext', scheme: 'none', ...base, ...run.s };
        if (s.underline === true) s.underline = 'single';
        if (s.underline === 'none') s.underline = false;
        return { text: run.text, s };
      }), out.v);
    }
    if (!out?.s) return out;
    const style = sorted(fillStyle(numberFormat(out.s)));
    if (Object.keys(style).length) out.s = style; else delete out.s;
    return out;
  };
  // How far the grid reaches (a sheet's rows and cols) is a view: the file does not hold it, so a
  // save and a load never give it back, and restoring a draft could not preserve it either. A width
  // or height the file cannot tell from the default is dropped as well, for the loader drops it too.
  const sized = (o, fallback, tolerance = 1) => sorted(o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).filter(([, v]) => !(Number.isFinite(Number(v)) && Math.abs(Number(v) - fallback) <= tolerance)))
    : o);
  // Auto-fit heights are renderer caches (fonts may differ between machines).
  // The sizing mode is content; a recalculated cache alone is not a lost edit.
  const heights = s => s.rowHeights && typeof s.rowHeights === 'object'
    ? Object.fromEntries(Object.entries(s.rowHeights).filter(([r]) => s.rowHeightModes?.[r] !== 'auto')) : s.rowHeights;
  return JSON.stringify({ ...content, ...(json.nativeDefaultCellFormat ? { nativeDefaultCellFormat: {
    ...nativeDefaultCellFormatProjection(json.nativeDefaultCellFormat), style: fillStyle(json.nativeDefaultCellFormat.style),
  } } : {}), nativeFillDefinitions: fillDefinitions, ...(normalFill ? { nativeNormalFill: normalFill } : {}), calculationCompatibility: normalizeCalculationCompatibility(calculationCompatibility), colorPalette: effectiveColorPalette(colorPalette), fontTheme: effectiveFontTheme(fontTheme), activeSheetId: null, sheets: sheets.map(({ rows, cols, viewSelection, viewOrigin, ...s }) => ({ ...s, id: ids.get(s.id),
    ...(s.colStyles ? { colStyles: sorted(s.colStyles, fillStyle) } : {}), ...(s.rowStyles ? { rowStyles: sorted(s.rowStyles, fillStyle) } : {}),
    ...(s.styleResets ? { styleResets: s.styleResets.map(record => record.values ? { ...record, values: fillStyle(record.values) } : record) } : {}),
    cells: sorted(s.cells, (c, key) => cell(c, key, s)), notes: sorted(s.notes), colWidths: sized(s.colWidths, s.defaultColWidth ?? DEFAULT_COL_WIDTH), rowHeights: sized(heights(s), s.defaultRowHeight ?? DEFAULT_ROW_HEIGHT, .001), ...(Array.isArray(s.tables) ? { tables: s.tables.map(table) } : {}) })) });
}

/** Identify the exact snapshot, including drafts written before revision IDs existed. */
export function draftRevision(draft) {
  return draft ? draft.revision || JSON.stringify(draft) : null;
}

/** When a revision is supplied, leave drafts subsequently written by another tab alone. */
export function clearDraft(key, revision = undefined) {
  if (revision === null) return;
  try {
    if (revision !== undefined && draftRevision(loadDraft(key)) !== revision) return;
    store()?.removeItem(key);
  } catch { /* nothing to clear */ }
}

/**
 * Keep the draft under `key` as an unsaved spreadsheet of its own, under a new: key of the same account,
 * where the home screen lists it: for a draft that can no longer be offered where it is (its file gone and
 * another at its address, say, or newer edits taking its place), rather than dropping it or writing over
 * it. The new key, or null when there is no readable draft to keep (or, given a revision, not that one).
 */
export function parkDraft(key, revision = undefined) {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    const draft = parseDraft(raw);
    if (!readableDraft(draft) || (revision !== undefined && draftRevision(draft) !== revision)) return null;
    return park(s, key, raw, draft);
  } catch { return null; }
}

// A key is the account's prefix (see draftKey) and the document's address; the encoded account holds no colon.
const ACCOUNT_PREFIX = new RegExp(`^${PREFIX}:account:[^:]*:`);
/** Move the draft's text from `key` to a new: address of its own under the same account; the new key, or null when it could not be kept. */
function park(s, key, raw, draft) {
  const prefix = ACCOUNT_PREFIX.exec(key)?.[0];
  if (!prefix) return null;
  const to = `${prefix}new:${draft.name}:${uniqueId()}`;
  try { s.setItem(to, raw); } catch { return null; }
  s.removeItem(key);
  return to;
}

/**
 * A document got a (new) path: its draft follows. Another document's draft already at the destination
 * (of a file deleted elsewhere whose name a new spreadsheet took, say) is kept as an unsaved spreadsheet
 * of its own rather than written over; the same snapshot, moved there by another tab first, and a record
 * that is not a readable draft give way. When the occupant cannot be kept, the move is left undone.
 * True when the draft is under `to` now.
 */
export function moveDraft(from, to, revision = undefined) {
  if (from === to || revision === null) return false;
  const s = store();
  if (!s) return false;
  try {
    const raw = s.getItem(from);
    if (raw == null) return false;
    let moved; // the moving draft's revision, read once, when something is compared with it
    const revisionMoved = () => (moved ??= draftRevision(parseDraft(raw)));
    if (revision !== undefined && revisionMoved() !== revision) return false;
    const occupied = s.getItem(to);
    if (occupied != null && occupied !== raw) {
      const occupant = parseDraft(occupied);
      if (readableDraft(occupant) && draftRevision(occupant) !== revisionMoved() && !park(s, to, occupied, occupant)) return false;
    }
    s.setItem(to, raw);
    s.removeItem(from);
    return true;
  } catch { return false; /* leave the old draft where it is */ }
}

/** Every draft in this browser, newest first: [{ key, path, name, savedAt, fileUid? }] (fileUid names the file a draft was made for, when it was kept). */
export function listDrafts() {
  const s = store();
  if (!s) return [];
  const out = [];
  const prefix = accountStorageKey(PREFIX);
  try {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key?.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.endsWith(LIVE)) continue; // kept beside an undecided draft of the same document, not a document of its own
      const head = draftHead(s.getItem(key));
      if (!head) continue;
      out.push({ key, path: rest.startsWith('new:') ? null : rest, name: head.name, savedAt: head.savedAt, ...(head.fileUid ? { fileUid: head.fileUid } : {}) });
    }
  } catch { /* storage refused */ }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
