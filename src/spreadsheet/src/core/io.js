import { bindImportedChartText } from './chart-linked-text.js';
import { bindImportedChartCategoryText } from './charts.js';
import { createExternalFormulaLinks } from './external-formula-links.js';
import { savedExternalResult, externalFormulaHasCaches, externalFormulaHasLinks, rebaseExternalWorkbooks } from './external-workbooks.js';
import { readXlsxExternalWorkbooks } from './xlsx-external-workbooks.js';
import { bindNativePivotRules } from './native-pivot-rule-bindings.js';
import { decodeXlsxString } from './xlsx-string.js';
import { readNativeSparklineGroups } from './xlsx-sparklines.js';
import { importXlsxSlicers } from './xlsx-import-slicers.js';
import { importNativePivotSlicerCaches } from './native-pivot-slicer-storage.js';
import { pivotSlicerSidecar, restorePivotSlicerSidecar } from './xlsx-pivot-slicer-sidecar.js';
import { normalizeNativePivots } from './native-pivots.js';
import { slicerItems } from './slicer.js';
import { xlsxScalarFormula } from './xlsx-scalar-formula.js';
import { readXlsxIgnoredErrors } from './xlsx-ignored-errors.js';
import { readXlsxRichText } from './xlsx-rich-text.js';
import { normalizeRichText } from './rich-text.js';
import { normalizeFontColor, sameFontColor } from './font-color.js';
import { stringifyXlsxMetadata, parseXlsxMetadata } from './xlsx-metadata-codec.js';
import { importXlsxThreadedComments } from './xlsx-threaded-comments.js';
import { legacyCommentText } from './comments.js';
/**
 * Files in and out, through SheetJS Community Edition (vendored under
 * src/vendor). The library is a megabyte of source, so it is imported on
 * first use rather than at boot.
 *
 * What survives a round trip through .xlsx:
 *   values, formulas (with the cached result other apps display), number
 *   formats, text styling, column widths, row heights, and sheet order.
 *   xlsx-export completes the native styles and layout missing from the
 *   Community Edition writer. The app's original style inheritance and
 *   additional settings also travel in a very-hidden
 *   sheet named `_puter_meta` as JSON. Other spreadsheet apps ignore that
 *   sheet; this app reads it back and removes it from view.
 */

import { Workbook, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, MAX_STORED_COL_WIDTH, MAX_STORED_ROW_HEIGHT, safeSheetName, MAX_ROWS, MAX_COLS } from './workbook.js';
import { cellKey, cellName, parseKey, MAX_TEXT, parseCellRef, parseRange } from './cell.js';
import { styleToNumFmt, numFmtToStyle, formatValue, dateTimeKind, fontKeyFor, ymdToSerial, NUMBER_FORMAT_KEYS } from './format.js';
import { readXlsxStyles, xlsxAlignment, xlsxColumnPixels, xlsxColor, xlsxAttr, xlsxLayoutDigitWidth, xlsxWidthFromPixels } from './xlsx-styles.js';
import { importXlsxScrollControls } from './xlsx-scroll-controls.js';
import { readXlsxCharts } from './xlsx-charts.js';
import { reconcileDrawings } from './xlsx-drawing-reconcile.js';
import { readXlsxLineStyles, readXlsxRowHeightModes, replaceInheritedStyle } from './xlsx-line-styles.js';
import { XLSX_IMPLICIT_ROW_HEIGHT, normalizeNativeDefaultHeight } from './xlsx-sheet-format.js';
import { createXlsxStyleReconciler, reconciledNormalFont } from './xlsx-style-reconcile.js';
import { FONT_KEYS, xlsxFontProjection, RECONCILED_STYLE_KEYS } from './xlsx-style-projection.js';
import { readXlsxConditionalFormats } from './xlsx-condformat.js';
import { importXlsxCheckboxes } from './xlsx-checkboxes.js';
import { intersectTableFormula } from './xlsx-table-formulas.js';
import { MAX_FORMAT_CODE_LENGTH } from './numfmt.js';
import { toFileFormula, fromFileFormula } from './xlfn.js';
import { readThemeInfo, importedThemeInfo } from './workbook-theme.js';
import { hasTableRefs, parseTableSpec, tableRefsToA1, tableStyleParts, normalizeCustomTableStyle } from './tables.js';
import { exportNamedTableReferences } from './export-named-formulas.js';
import { err, isError } from './formula/functions.js';
import { parseDelimited } from './tsv.js';
import { parseInput, refineImpliedFormat, localeInfo, getLocale } from './format.js';
import { cellsToHtml } from './clipboard.js';
import { reconcileConditionalFormats } from './xlsx-condformat-reconcile.js';
import { prepareXlsxValidationLists } from './xlsx-validation.js';
import { sheetFilters, sameFilterRange, filterRangeKey, mapSheetFilters } from './sheet-filters.js';
import { readXlsxFilter, readXlsxFilterButtons, writeXlsxFilter } from './xlsx-filter.js';
import { readStyleResets, styleResetAt } from './style-resets.js';
import { xlsxResetCells } from './xlsx-style-resets.js';
import { xlsxRowStyleBase, xlsxLineIntersectionCells } from './xlsx-line-intersections.js';
import { MAX_ROW, MAX_COL, shiftFormula, mapFormulaRefs } from './refs.js';
import { tokenize, isExternalFormulaToken, isWorkbookNameScope } from './formula/tokenizer.js';
import { parseFormula } from './formula/parser.js';
import { normalizeCalculationCompatibility } from './calculation-compatibility.js';
import { readXlsxCalculationCompatibility } from './xlsx-calculation-compatibility.js';
import { normalizeIteration } from './iteration.js';
import { normalizeSheetSelection, normalizeSheetOrigin } from './sheet-selection.js';
import { splitFromPane } from './split-panes.js';
import { normalizeWorkbookView, WORKBOOK_VIEW_ATTRIBUTES } from './workbook-view.js';
import { normalizeNormalFont, normalFontStyle, normalIndentUnit } from './normal-font.js';
import { normalizeNativeNormalStyle } from './native-normal-style.js';
import { normalizeFillColor } from './fill-color.js';
import { normalizeNativeFill, packNativeFillState, unpackNativeFillState } from './native-fill.js';
import { readFontTheme, normalizeFontTheme } from './font-theme.js';
import { isRangeSource, ruleFormulaBody } from './validation.js';
import { parseScenariosXml } from './scenarios.js';
import { readXlsxOutlineSettings } from './xlsx-outline.js';
import { readXlsxBackground } from './xlsx-background.js';
import { remapCustomViews } from './custom-views.js';
import { serializeQueries } from './queries.js';
import { serializeScripts } from './scripts.js';
import { readXlsxScripts } from './xlsx-scripts.js';
import { serializeChangeHistory } from './change-history.js';

export const META_SHEET = '_puter_meta';
const META_CHUNK = 30000;
// The file format's limit on a formula's length; anything longer is not a formula another program wrote.
const MAX_FORMULA = 8192;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv;charset=utf-8';
export const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

// SheetJS error cells store numeric BIFF codes, including when writing .xlsx XML.
// The errors Excel added since dynamic arrays are numbered as its XlCVError
// constants minus 2000 (xlErrSpill = 2045 and so on). The XLSX rich-value
// writer replaces modern error caches with native metadata and #VALUE!.
// App-local errors (#CYCLE!, #ERROR!, and the calculation-limit #BUSY!) have
// no equivalent value in the file format, where #BUSY! means waiting for a service.
const ERROR_CODES = new Map([
  ['#NULL!', 0x00], ['#DIV/0!', 0x07], ['#VALUE!', 0x0f], ['#REF!', 0x17],
  ['#NAME?', 0x1d], ['#NUM!', 0x24], ['#N/A', 0x2a], ['#GETTING_DATA', 0x2b],
  ['#SPILL!', 0x2d], ['#CONNECT!', 0x2e], ['#BLOCKED!', 0x2f], ['#UNKNOWN!', 0x30], ['#FIELD!', 0x31], ['#CALC!', 0x32],
]);
const fileErrorCode = (value) => ERROR_CODES.get(value.error) ?? 0x0f;

let xlsxModule = null;
async function XLSX() {
  if (!xlsxModule) {
    xlsxModule = await import('../vendor/xlsx.mjs');
    xlsxModule.set_shared_formula_shifter?.(shiftSharedFormula);
  }
  // The vendor's table of number formats is state of its module: a read adds the file's own
  // <numFmt> codes to it and nothing ever takes them out, so a file naming an id it does not
  // define would show its cells under an earlier file's code, and a save copies the whole table
  // into a book that carries none of its own — a code from a shared file, user text and all,
  // landing in the user's own documents. Every read and write starts from the built-in table.
  xlsxModule.SSF.init_table();
  return xlsxModule;
}

// The ids of the vendor's own table of built-in number formats. A read starts from this
// table and adds the file's <numFmt> codes and, for a built-in id the table lacks, the code
// workbooks from Excel imply for that id.
const VENDOR_FORMAT_IDS = new Set([0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 37, 38, 39, 40, 45, 46, 47, 48, 49, 56]);

/**
 * A cell's number format code where the reader left none: `(cell) => code`.
 * The vendor's table of built-in formats lacks the Currency (5–8), Accounting
 * (41–44) and locale calendar ids, which openpyxl and other generators name by
 * id alone with no <numFmt> entry. The reader knows the implied code for such an id
 * and fills it in on meeting the id, but only after handing the cell the table's
 * entry, so the first cell of each such id arrived with no code (as General)
 * while the cells after it had one. That first cell still carries the text the
 * reader formatted with the code, and the table now holds every code this read
 * added: the code that renders the cell's value to its text is the cell's.
 */
function recoveredFormat(X) {
  const table = X.SSF.get_table();
  const added = Object.keys(table).map(Number).filter((id) => !VENDOR_FORMAT_IDS.has(id));
  return (src) => {
    if (src.z != null || !added.length || typeof src.w !== 'string') return src.z;
    try {
      if (src.w === X.SSF.format('General', src.v)) return undefined;
      for (const id of added) if (X.SSF.format(id, src.v) === src.w) return table[id];
    } catch { /* a value the formatter refuses names no format */ }
    return undefined;
  };
}

/**
 * Excel stores a formula filled across a block once, and every other cell
 * of the block re-derives it by shifting the relative references. The
 * vendor's own shift renumbers anything shaped like an address, including
 * inside quoted sheet names, strings, and defined names; ours knows the
 * grammar. Text the tokenizer refuses is left to the vendor.
 */
function shiftSharedFormula(formula, dr, dc) {
  try { tokenize(formula); } catch { return null; }
  return shiftFormula(formula, dr, dc);
}

export { IMPORT_EXTENSIONS, isSpreadsheetFile } from './filetypes.js';

/** "Budget.xlsx" → "Budget". */
export function stripExtension(name) {
  return String(name || '').replace(/\.[^.]+$/, '');
}

/* ---------- Export ---------- */

const META_ENUMS = { scheme: ['major', 'minor', 'none'], align: ['left', 'center', 'right'], valign: ['top', 'middle', 'bottom'] };
const META_NUMBERS = ['size', 'indent', 'dec', 'rot'];
/** Metadata colors are hex or validated native references; alignments, sizes
 * and format codes retain their existing limits. */
function sanitizeMetaStyle(style) {
  const out = {};
  for (const [k, v] of Object.entries(style)) {
    if (k in Object.prototype) continue; // a key named like an inherited member is never a style
    // Null is an explicit reset of a row/column default, including No fill and Automatic alignment.
    if (v === null) { out[k] = null; continue; }
    if (k === 'shrink') { if (typeof v === 'boolean') out[k] = v; continue; }
    if (k === 'color') { const color = normalizeFontColor(v); if (color) out[k] = color; continue; }
    if (k === 'bg') { const color = normalizeFillColor(v); if (color && color !== 'transparent') out[k] = color; continue; }
    if (k === 'nativeFill') { out[k] = normalizeNativeFill(v); continue; }
    if (Object.hasOwn(META_ENUMS, k)) { if (META_ENUMS[k].includes(v)) out[k] = v; continue; }
    if (META_NUMBERS.includes(k)) { if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; continue; }
    out[k] = v;
  }
  // Showing a number through a code past Excel's limit costs milliseconds a cell: such a cell reads as General.
  if (typeof out.code === 'string' && out.code.length > MAX_FORMAT_CODE_LENGTH) { delete out.code; if (out.fmt === 'custom') delete out.fmt; }
  return out;
}

/**
 * The whole-column or whole-row formats the sidecar recorded, as makeSheet takes them: an index → style
 * map. Metadata is untrusted, so an index that is not a plain number in the grid, and a style that is
 * not an object, are dropped, and each style is sanitized as a cell's own is.
 */
function metaLineStyles(raw, max) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, style] of Object.entries(raw)) {
    if (!/^\d+$/.test(key) || Number(key) > max || !style || typeof style !== 'object' || Array.isArray(style)) continue;
    out[key] = sanitizeMetaStyle(style);
  }
  return out;
}

function styleFor(wb, sheet, r, c) {
  return wb.getCell(sheet.id, r, c)?.s || null;
}

/**
 * The result of `fn`, or `fallback` when it ran out of stack: a file can
 * hold a formula nested deeper than the parser can follow, and one such
 * cell must not make the whole book unsaveable.
 */
function unlessTooDeep(fn, fallback) {
  try { return fn(); } catch (e) { if (e instanceof RangeError) return fallback; throw e; }
}

/**
 * Text the file writer accepts: it refuses anything longer than MAX_TEXT,
 * which would fail every save. The cut falls on a character boundary, so
 * an emoji at the limit is dropped whole rather than left as half a pair.
 */
function fitText(value) {
  if (value.length <= MAX_TEXT) return value;
  const code = value.charCodeAt(MAX_TEXT - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? MAX_TEXT - 1 : MAX_TEXT);
}

/**
 * A number format code the ODS writer accepts. It refuses a quoted literal
 * with no closing quote, which would fail the whole export: the literal is
 * closed at the end of the code, where it ends on screen as well. A code the
 * writer would still refuse (a quote inside a bracket) is written as General.
 */
function odsFormatCode(code) {
  const unclosed = (text, skipBrackets) => {
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (ch === '\\' || ch === '_' || ch === '*') i++;
      else if (skipBrackets && ch === '[') { const end = text.indexOf(']', i + 1); if (end !== -1) i = end; }
    }
    return quoted;
  };
  const closed = unclosed(code, false) ? `${code}"` : code;
  return unclosed(closed, true) ? 'General' : closed;
}

// Token types that end or begin an operand, for spotting Excel's intersection operator.
const OPERAND_ENDS = new Set(['ref', 'name', 'tref', 'rparen']);
const OPERAND_STARTS = new Set(['ref', 'name', 'tref', 'lparen']);

/**
 * Whether a formula is shaped like Excel's intersection operator, a space between two
 * references (A1:A5 B2:D2): Excel reads it, this app does not yet, and it travels as it is.
 */
function looksLikeIntersection(formula) {
  let tokens;
  try { tokens = tokenize(formula); } catch { return false; }
  return tokens.some((t, i) => i > 0 && t.start > tokens[i - 1].end && OPERAND_ENDS.has(tokens[i - 1].type) && OPERAND_STARTS.has(t.type));
}

/**
 * Whether a cell's formula is one no program will read: this app could not parse it, which
 * is what its #ERROR! value says (a typo such as =1+ or ="abc is kept as typed), and it is
 * not the intersection operator. Written into the file as a formula, such a cell makes Excel
 * open the file only after a repair that deletes it; it is written as its text instead.
 */
function unparsedFormula(formula, value) {
  if (!isError(value) || value.error !== '#ERROR!') return false;
  try { parseFormula(formula); return false; } catch (e) { if (e instanceof RangeError) return false; }
  return !looksLikeIntersection(formula);
}

// Preserve detection of an external name even when the surrounding formula is unsupported.
const EXTERNAL_NAME = /(?:^|[^\w\]])\[\d+\]!/;

/**
 * Whether a formula reaches into another workbook: Excel spells such a reference with the
 * book in brackets before the sheet ([1]Sheet1!A1, '[Book.xlsx]Sheet1'!A1, [1]!Name). This
 * app uses supporting-cell caches when available. Without a native link part, Excel
 * would have to repair a file containing such a formula.
 */
function externalReference(formula) {
  if (!formula.includes('[')) return false;
  let tokens;
  try { tokens = tokenize(formula); } catch { return EXTERNAL_NAME.test(formula); }
  return tokens.some(isExternalFormulaToken);
}

/** OpenFormula has no syntax that bypasses worksheet name shadowing.
 * Preserve the value and restore the Excel qualifier from app metadata. */
function workbookNameReference(formula) {
  if (!formula?.includes('[0]')) return false;
  try { return tokenize(formula).some(t => t.type === 'name' && isWorkbookNameScope(t.sheet)); } catch { return false; }
}

/** Whether a value read back from the file is the one cached with a parked external formula. */
const sameCachedValue = (a, b) => (isError(a) || isError(b) ? isError(a) && isError(b) && a.error === b.error : a === b);

function buildSheet(X, wb, sheet, { ods = false } = {}) {
  // ODF has no escape for a carriage return or any other control character: the writer would
  // spell them "_x000d_", which no reader decodes. Line breaks are kept as newlines, which is
  // how every reader hands them back, and the other controls, which XML cannot hold, are dropped.
  const text = (value) => (ods ? String(value).replace(/\r\n?/g, '\n').replace(/[\0-\b\v-\x1f￾￿]/g, '') : String(value));
  const numFmtOf = (style) => (ods ? odsFormatCode(styleToNumFmt(style)) : styleToNumFmt(style));
  const ws = {};
  if (sheet.validations.length) ws['!validations'] = sheet.validations.map((rule) => ({
    ...rule,
    source: rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source))
      ? '=' + toFileFormula(wb.structuredToA1(sheet.id, rule.range.r1, rule.range.c1, ruleFormulaBody(rule.source), null, false, { relativeRows: true }))
      : rule.source,
  }));
  let maxR = -1;
  let maxC = -1;
  // A formula can name a table only when the book has one, or spell a structured reference in brackets; any
  // other formula is its own A1 text, and is not put through the table lookup in a loop over every cell.
  const hasTables = wb.tableNames().length > 0;
  const lineFormats = wb.defaultStyle(sheet) || sheet.colStyles.size || sheet.rowStyles.size || sheet.styleResets.length;
  const parkedFormulas = wb.externalFormulas?.get(sheet.id);
  for (const [key, cell] of sheet.cells) {
    const { r, c } = parseKey(key);
    const parked = parkedFormulas?.get(key);
    const links = ods && savedExternalResult(cell) ? wb._externalLinks(sheet, r, c, cell.f) : null;
    const deferredForOds = links?.linked && !links.cached || ods && workbookNameReference(cell.f);
    const nativeParked = !ods && cell.f == null && parked && sameCachedValue(cell.v, parked.v)
      && wb._externalLinks(sheet, r, c, parked.f).linked;
    const empty = cell.v == null && cell.f == null && !nativeParked;
    // Other readers need the displayed format in the native cell record, including formats inherited
    // from rows/columns. The sidecar separately preserves which fields actually belong to the cell.
    const style = lineFormats ? wb.styleAt(sheet.id, r, c) : cell.s;
    const numFmt = style?.fmt && style.fmt !== 'general' ? numFmtOf(style) : null;
    if (empty && !cell.hyperlink && !numFmt && (ods || !cell.s)) continue;
    // A formatted empty cell can also be occupied by a spilled result. A
    // formula too deep to parse has no value to cache and travels as typed.
    const value = unlessTooDeep(() => (cell.f != null || empty ? wb.getValue(sheet.id, r, c) : cell.v), null);
    const out = {};
    // A formula no program can read is written as the text it was typed as, under the cell's own
    // number format; the sidecar carries the formula, and this app takes it back on opening. One
    // reaching into another workbook needs a native link part; without one, keep the
    // typed text rather than writing a formula that Excel would repair away.
    const unparsed = cell.f != null && !deferredForOds && (unparsedFormula(cell.f, value) || externalReference(cell.f) && (ods || !externalFormulaHasLinks(cell.f, wb.externalWorkbooks)));
    if (unparsed) { out.t = 's'; out.v = fitText(text(`=${cell.f}`)); }
    else if (empty && value == null) out.t = 'z';
    else if (isError(value)) { out.t = 'e'; out.v = fileErrorCode(value); }
    else if (value == null || typeof value === 'object') { out.t = 's'; out.v = ''; }
    else if (typeof value === 'number') { out.t = 'n'; out.v = value; }
    else if (typeof value === 'boolean') { out.t = 'b'; out.v = value; }
    else { out.t = 's'; out.v = fitText(text(value)); }
    if (!ods && out.t === 's' && cell.richText && typeof value === 'string' && !unparsed) {
      out.richText = normalizeRichText(cell.richText, value, out.v.length);
    }
    if (cell.f != null && !unparsed && !deferredForOds) {
      // Native XLSX tables own these references: keeping them live preserves
      // resizing and keeps calculated cells consistent with their template.
      // ODS has no equivalent table-reference syntax, so only it needs A1.
      out.f = unlessTooDeep(() => toFileFormula(ods && (hasTables || cell.f.includes('[')) ? wb.structuredToA1(sheet.id, r, c, cell.f) : cell.f), cell.f);
      // Fixed CSE arrays retain their declared extent even for scalar/error
      // results. Dynamic formulas carry native dynamic-array metadata, including
      // when their current result is one cell or their spill is blocked.
      const spill = unlessTooDeep(() => wb.spillRangeAt(sheet.id, r, c), null);
      if (spill && (cell.array || spill.r2 > spill.r1 || spill.c2 > spill.c1)) out.F = X.utils.encode_range({ s: { r: spill.r1, c: spill.c1 }, e: { r: spill.r2, c: spill.c2 } });
      if (!ods && unlessTooDeep(() => wb.isDynamicArrayFormula(sheet.id, r, c), false)) { out.D = true; out.F ||= X.utils.encode_cell({ r, c }); }
    }
    if (cell.externalResult && cell.f != null && !unparsed && value == null) { out.t = 'n'; delete out.v; }
    if (nativeParked) {
      out.f = toFileFormula(parked.f);
      if (value == null) { out.t = 'n'; delete out.v; }
    }
    if (numFmt) out.z = numFmt;
    if (!ods) { out.s = style; if (empty) out.z ||= 'General'; }
    const link = unlessTooDeep(() => wb.linkAt(sheet.id, r, c), null);
    if (cell.hyperlink) out.l = { Target: cell.hyperlink };
    else if (link) out.l = { Target: link.url };
    ws[X.utils.encode_cell({ r, c })] = out;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  for (const { r, c, value } of unlessTooDeep(() => wb.spillEntries(sheet.id), [])) {
    const addr = X.utils.encode_cell({ r, c });
    const style = { ...(lineFormats ? wb._lineStyle(sheet, r, c) : null), ...wb.spillAt(sheet.id, r, c)?.style, ...wb.getCell(sheet.id, r, c)?.s };
    const numFmt = numFmtOf(style);
    if (ws[addr]) { ws[addr].z = numFmt; if (!ods) ws[addr].s = style; continue; }
    const out = {};
    if (isError(value)) { out.t = 'e'; out.v = fileErrorCode(value); }
    else if (value == null) { out.t = 's'; out.v = ''; }
    else if (typeof value === 'number') { out.t = 'n'; out.v = value; }
    else if (typeof value === 'boolean') { out.t = 'b'; out.v = value; }
    else { out.t = 's'; out.v = fitText(text(value)); }
    out.z = numFmt;
    if (!ods) out.s = style;
    ws[addr] = out;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  // Native XFs replace whole formats. Blank cells need an explicit XF for
  // sparse clears and for column properties a partial row patch inherits.
  // Existing cells and spills already carry their complete effective style.
  const nativeRowStyleBase = !ods ? xlsxRowStyleBase(sheet) : null;
  if (nativeRowStyleBase) ws['!nativeRowStyleBase'] = nativeRowStyleBase;
  const nativeBlankCells = function* () {
    yield* xlsxResetCells(sheet, wb.defaultStyle(sheet));
    yield* xlsxLineIntersectionCells(sheet, wb.defaultStyle(sheet), nativeRowStyleBase);
  };
  if (!ods) for (const { r, c } of nativeBlankCells()) {
    const addr = X.utils.encode_cell({ r, c });
    if (ws[addr]) continue;
    const style = wb.styleAt(sheet.id, r, c);
    ws[addr] = { t: 'z', s: style, z: numFmtOf(style) };
    // These are serializer records, not new own-cell number-format overrides.
    if (NUMBER_FORMAT_KEYS.some(k => Object.hasOwn(style || {}, k))) {
      (ws['!inheritedBlankNumberFormats'] ??= {})[cellKey(r, c)] = {};
    }
    maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
  }
  // A merged block's anchor must exist as a cell, or the ODS writer has nowhere to put the span.
  for (const m of sheet.merges) {
    const addr = X.utils.encode_cell({ r: m.r1, c: m.c1 });
    if (!ws[addr]) ws[addr] = { t: 'z' };
    if (m.r1 > maxR) maxR = m.r1;
    if (m.c1 > maxC) maxC = m.c1;
  }
  // Notes become cell comments; a note on an empty cell gets an empty cell to hang on.
  for (const [key, note] of sheet.notes) {
    const { r, c } = parseKey(key);
    const addr = X.utils.encode_cell({ r, c });
    const target = ws[addr] || (ws[addr] = { t: 'z' });
    target.c = [{ a: 'Spreadsheet', t: fitText(text(note)) }];
    target.c.hidden = true;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  // A threaded comment also goes out as a note, authored after its thread, for readers that know only notes;
  // xlsx-export writes the thread itself (see xlsx-threaded-comments.js).
  for (const [key, thread] of sheet.comments || []) {
    const { r, c } = parseKey(key);
    const addr = X.utils.encode_cell({ r, c });
    const target = ws[addr] || (ws[addr] = { t: 'z' });
    target.c = [{ a: ods ? thread.items[0].author : `tc=${thread.items[0].id}`, t: fitText(legacyCommentText(thread)) }];
    target.c.hidden = true;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, maxR), c: Math.max(0, maxC) } });
  if (sheet.merges.length) ws['!merges'] = sheet.merges.map((m) => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }));
  if (!ods && sheet.tables.length) {
    ws['!tableFormulas'] = Object.fromEntries(sheet.tables.map(table => [table.id, tableFileFormulas(table, wb.externalWorkbooks)]));
  }
  const tableOwners = new Map(sheet.tables.map(t => [filterRangeKey({ range: { ...t.range, r2: t.range.r2 - Number(t.totalsRow) } }), t]));
  for (const context of sheetFilters(sheet)) {
    const range = context.range;
    const owner = !ods && tableOwners.get(filterRangeKey(context));
    const filter = { ...(context.showButtons === false ? { showButtons: false } : {}), criteria: context.criteria, ref: X.utils.encode_range({ s: { r: range.r1, c: range.c1 }, e: { r: range.r2, c: range.c2 } }) };
    // A table owns its AutoFilter. Writing another one in the worksheet over
    // the same cells makes Excel repair the file. Stage it for the table-part
    // writer instead; ordinary range filters still belong to the worksheet.
    if (ods) (ws['!filters'] ??= []).push(filter);
    else if (owner) (ws['!tableFilters'] ??= {})[owner.id] = filter;
    else {
      if (ws['!autofilter']) throw new Error('XLSX supports one worksheet filter per sheet. Convert additional filtered ranges to tables before exporting.');
      ws['!autofilter'] = filter;
    }
    // Excel reads the conditions from the autoFilter element's filterColumn children. A value list
    // names the texts this app's menu showed, but Excel matches a list against the cell's value, so
    // the numbers behind those texts (1234.5 for a cell showing 1,234.50) go into the file instead.
    if (!ods) {
      const behind = new Map();
      const numbersByText = (col) => {
        if (!behind.has(col)) behind.set(col, new Map([...wb.filterKeysByText(sheet.id, col, context)]
          .map(([text, keys]) => [text, [...keys].map((k) => Number(String(k).split('|')[0])).filter(Number.isFinite)])));
        return behind.get(col);
      };
      const filterColumns = writeXlsxFilter(context, numbersByText);
      if (filterColumns) filter.filterColumns = filterColumns;
    }
  }
  // Only a column or row with its own width, height, or hidden state gets an
  // entry. The writers skip the holes, whereas filling every index up to one
  // far-off row would put a million row records into each save.
  if (sheet.colWidths.size || sheet.hiddenCols.size || (!ods && sheet.colStyles.size)) {
    const cols = [];
    for (const [c, wpx] of sheet.colWidths) cols[c] = { wpx };
    for (const c of sheet.hiddenCols) (cols[c] ??= { wpx: sheet.defaultColWidth }).hidden = true;
    if (!ods) for (const c of sheet.colStyles.keys()) cols[c] ??= { wpx: sheet.defaultColWidth };
    ws['!cols'] = cols;
  }
  if (sheet.rowHeights.size || sheet.rowHeightModes.size || sheet.hiddenRows.size || sheet.filterHidden.size || (!ods && sheet.rowStyles.size)) {
    const rows = [];
    for (const [r, hpx] of sheet.rowHeights) rows[r] = { hpx };
    for (const r of sheet.rowHeightModes.keys()) rows[r] ??= { hpx: sheet.defaultRowHeight };
    for (const r of sheet.hiddenRows) (rows[r] ??= { hpx: sheet.defaultRowHeight }).hidden = true;
    // The rows the filter hides are hidden rows in an .xlsx, the only spelling it has, and rows
    // of the "filter" visibility in an .ods: a program opening the file shows the filtered view,
    // and clearing the filter there shows them again.
    for (const r of sheet.filterHidden) (rows[r] ??= { hpx: sheet.defaultRowHeight })[ods ? 'filtered' : 'hidden'] = true;
    if (!ods) {
      for (const r of sheet.rowStyles.keys()) rows[r] ??= {};
      for (const r of Object.keys(rows)) if (rows[r].hpx != null) { rows[r].hpt = rows[r].hpx * 3 / 4; delete rows[r].hpx; }
    }
    ws['!rows'] = rows;
  }
  if (sheet.defaultRowHeight !== DEFAULT_ROW_HEIGHT) ws['!format'] = { defaultRowHeight: sheet.defaultRowHeight * 3 / 4 };
  if (sheet.defaultColWidth !== DEFAULT_COL_WIDTH) ws['!format'] = { ...ws['!format'], defaultColWidth: xlsxWidthFromPixels(sheet.defaultColWidth, wb.normalFont || { name: 'Calibri', sz: 12 }) };
  return ws;
}

/** Formula templates as represented in a native table, relative to its first data row. */
function tableFileFormulas(table, externalWorkbooks = null) {
  const columns = {};
  for (const [offset, template] of Object.entries(table.calc || {})) {
    if (typeof template !== 'string' || !/^\d+$/.test(offset)) continue;
    const first = table.range.r1 + (table.headerRow === false ? 0 : 1);
    const origin = Number.isInteger(table.calcRow) && table.calcRow >= 0 ? table.calcRow : first;
    const formula = shiftFormula(template, first - origin, 0);
    // Keep unsupported templates in the sidecar, as for ordinary cells.
    if (externalReference(formula) && !externalFormulaHasLinks(formula, externalWorkbooks) || unparsedFormula(formula, err('#ERROR!'))) continue;
    columns[offset] = { formula: unlessTooDeep(() => toFileFormula(formula), formula), array: table.calcArray?.[offset] === true };
  }
  return columns;
}

/** The app's own state for the sidecar; `ods` adds what that format's writer and reader lose. */
function collectMeta(wb, structuredNames = [], { ods = false, fileSheets = null, history = true } = {}) {
  // Sheet names are user data; names such as __proto__ must be ordinary keys.
  const meta = { v: 1, format: 'puter-spreadsheet', ...(!ods ? { themeFonts: true } : {}), active: wb.activeSheet?.name || null, sheets: Object.create(null) };
  let any = structuredNames.length > 0;
  if (ods && (wb.calculationCompatibility.version !== 2 || wb.calculationCompatibility.warnBelowVersion)) {
    meta.calculationCompatibility = wb.calculationCompatibility; any = true;
  }
  if (wb.normalFont) { meta.normalFont = wb.normalFont; any = true; }
  if (wb.nativeNormalStyle) { meta.nativeNormalStyle = wb.nativeNormalStyle; any = true; }
  if (wb.nativeNormalFill) { meta.nativeNormalFill = wb.nativeNormalFill; any = true; }
  if (wb.nativeDefaultCellFormat) { meta.nativeDefaultCellFormat = wb.nativeDefaultCellFormat; any = true; }
  if (wb.fontTheme) { meta.fontTheme = wb.fontTheme; any = true; }
  if (wb.themeInfo) { meta.themeInfo = wb.themeInfo; any = true; }
  if (wb.queries?.length) { meta.queries = serializeQueries(wb); any = true; }
  // An .xlsx carries the scripts in a part of their own (xlsx-scripts.js); an .ods in these settings.
  if (ods && wb.scripts?.length) { meta.scripts = serializeScripts(wb); any = true; }
  if (wb.cellStyles?.length) { meta.cellStyles = wb.cellStyles; any = true; }
  // Show Changes: the record of recent edits, which no file format has a place for. A copy downloaded to hand to
  // someone leaves it out, as it holds what cells used to say (a value deleted on purpose among them).
  if (history && wb.changeHistory?.length) { meta.changeHistory = serializeChangeHistory(wb); any = true; }
  const pivotSlicers = !ods && pivotSlicerSidecar(wb);
  if (pivotSlicers?.length) { meta.pivotSlicers = pivotSlicers; any = true; }
  if (structuredNames.length) meta.structuredNames = structuredNames;
  const relativeNames = wb.names.filter(n => n.relative).map(n => ({ name: n.name, ref: n.ref, ...(n.sheet ? { sheet: n.sheet } : {}) }));
  if (relativeNames.length) { meta.relativeNames = relativeNames; any = true; }
  // Custom Views: whole, by sheet name (the native parts have no place for hidden-line lists).
  if (wb.customViews?.length) {
    meta.customViews = remapCustomViews(wb.customViews, (id) => wb.sheet(id)?.name ?? null);
    any = true;
  }
  const tableNames = wb.tableNames();
  const nativeDefaultVAlign = wb.sheets.find(s => s.kind !== 'chart')?.defaultVAlign || 'middle';
  for (const sheet of wb.sheets) {
    const styles = {};
    const inheritedNumberFormats = { ...fileSheets?.[sheet.name]?.['!inheritedBlankNumberFormats'] };
    const lineFormats = wb.defaultStyle(sheet) || sheet.colStyles.size || sheet.rowStyles.size || sheet.styleResets.length;
    const structured = {};
    const unparsed = {};
    const deferredExternal = {};
    const odsDynamicArrays = {};
    let hasSpills = false;
    for (const [key, cell] of sheet.cells) {
      const { r, c } = parseKey(key);
      if (cell.f != null && hasTableRefs(cell.f, tableNames)) structured[key] = cell.f;
      const links = ods && savedExternalResult(cell) ? wb._externalLinks(sheet, r, c, cell.f) : null;
      const deferredForOds = links?.linked && !links.cached || ods && workbookNameReference(cell.f);
      if (deferredForOds) deferredExternal[key] = cell.f;
      // The formulas the file holds as text, so this app can take them back (the sheet builder has the values cached).
      if (cell.f != null && !deferredForOds && (unparsedFormula(cell.f, unlessTooDeep(() => wb.getValue(sheet.id, r, c), null)) || externalReference(cell.f) && (ods || !externalFormulaHasLinks(cell.f, wb.externalWorkbooks)))) unparsed[key] = cell.f;
      if (cell.f != null && unlessTooDeep(() => wb.spillRangeAt(sheet.id, r, c), null)) hasSpills = true;
      // ODF matrix spans have fixed geometry. Preserve this app's resizable
      // arrays separately, tied to the actual exported formula and extent so
      // stale settings cannot reclassify a matrix edited in another program.
      if (ods && cell.f != null && !cell.array) {
        const native = fileSheets?.[sheet.name]?.[cellName(r, c)];
        if (native?.f && native.F) odsDynamicArrays[key] = { f: native.f, ref: native.F };
      }
      const line = lineFormats ? wb._lineStyle(sheet, r, c) : null;
      if (line && NUMBER_FORMAT_KEYS.some((k) => Object.hasOwn(line, k))) {
        // {} means the exported number format was entirely inherited. Keeping the original subset
        // prevents reopening from turning that format into an own-cell override of future defaults.
        inheritedNumberFormats[key] = Object.fromEntries(NUMBER_FORMAT_KEYS.filter((k) => cell.s && Object.hasOwn(cell.s, k)).map((k) => [k, cell.s[k]]));
      }
      if (!cell.s) continue;
      const s = { ...cell.s };
      // Keep original visual overrides separately from the native displayed
      // styles, so reopening does not freeze inherited row/column formatting.
      // Spilled destinations also need their original number-format overrides,
      // and the ODS writer and reader do not carry every code faithfully,
      // so the settings block keeps the formats as well.
      if (!ods && !wb.spillAt(sheet.id, r, c)) {
        // A format code cannot express that this cell resets one of its line's default properties.
        for (const key of NUMBER_FORMAT_KEYS) if (s[key] !== null && !(key === 'code' && s[key] === '')) delete s[key];
      }
      if (Object.keys(s).length) { styles[key] = s; any = true; }
    }
    meta.sheets[sheet.name] = { styles, rows: sheet.rows, cols: sheet.cols, ...(!ods ? { nativeStyles: true } : {}) };
    const nativeRowStyleBase = fileSheets?.[sheet.name]?.['!nativeRowStyleBase'];
    if (nativeRowStyleBase) meta.sheets[sheet.name].nativeRowStyleBase = nativeRowStyleBase;
    if (sheet.kind === 'chart') { meta.sheets[sheet.name].kind = 'chart'; meta.sheets[sheet.name].zoomToFit = !!sheet.zoomToFit; any = true; }
    if (sheet.defaultColWidth !== DEFAULT_COL_WIDTH) {
      meta.sheets[sheet.name].defaultColWidth = sheet.defaultColWidth;
      any = true;
    }
    if (sheet.defaultRowHeight !== DEFAULT_ROW_HEIGHT) {
      meta.sheets[sheet.name].defaultRowHeight = sheet.defaultRowHeight;
      any = true;
    }
    if (sheet.rowHeightModes.size) { meta.sheets[sheet.name].rowHeightModes = Object.fromEntries(sheet.rowHeightModes); any = true; }
    if (sheet.nativeDefaultHeight) { meta.sheets[sheet.name].nativeDefaultHeight = sheet.nativeDefaultHeight; any = true; }
    // Dimensions written with the vendor's pixel convention must be recognized on reopen,
    // even when a plain sheet has no other formatting that would require a sidecar.
    if (sheet.colWidths.size || sheet.rowHeights.size) any = true;
    if (Object.keys(inheritedNumberFormats).length) {
      meta.sheets[sheet.name].inheritedNumberFormats = inheritedNumberFormats;
      any = true;
    }
    if (sheet.styleResets.length) {
      meta.sheets[sheet.name].styleResets = sheet.styleResets;
      any = true;
    }
    // Preserve the app's line defaults even for readers/formats that only
    // hand back per-cell styles, including cells typed after reopening.
    for (const [field, map] of [['colStyles', sheet.colStyles], ['rowStyles', sheet.rowStyles]]) {
      if (!map.size) continue;
      meta.sheets[sheet.name][field] = Object.fromEntries([...map].map(([i, s]) => [i, { ...s }]));
      any = true;
    }
    // A sheet can reference tables elsewhere without containing one itself.
    if (Object.keys(structured).length) {
      meta.sheets[sheet.name].structured = structured;
      any = true;
    }
    if (Object.keys(unparsed).length) {
      meta.sheets[sheet.name].unparsed = unparsed;
      any = true;
    }
    // The formulas of a file from another program that reached into another workbook: their cells
    // hold the values the file cached, and the sidecar keeps the formula text beside each cell that
    // still shows that value, so the information survives this app's own saves.
    const parked = wb.externalFormulas?.get(sheet.id);
    if (parked?.size || Object.keys(deferredExternal).length) {
      const external = { ...deferredExternal };
      for (const [key, { f, v }] of parked || []) {
        const cell = sheet.cells.get(key);
        if (cell && cell.f == null && sameCachedValue(cell.v, v)) external[key] = f;
      }
      if (Object.keys(external).length) { meta.sheets[sheet.name].external = external; any = true; }
    }
    if (hasSpills) {
      meta.sheets[sheet.name].spillFormats = true;
      any = true;
    }
    if (Object.keys(odsDynamicArrays).length) {
      meta.sheets[sheet.name].odsDynamicArrays = odsDynamicArrays;
      any = true;
    }
    if (sheet.frozenRows || sheet.frozenCols) {
      meta.sheets[sheet.name].frozen = { rows: sheet.frozenRows, cols: sheet.frozenCols };
      any = true;
    }
    if (sheet.hiddenRows.size || sheet.hiddenCols.size) {
      meta.sheets[sheet.name].hidden = { rows: [...sheet.hiddenRows], cols: [...sheet.hiddenCols] };
      any = true;
    }
    if (sheet.protectedRanges?.length) {
      meta.sheets[sheet.name].protectedRanges = sheet.protectedRanges;
      any = true;
    }
    if (sheet.rules.length) {
      meta.sheets[sheet.name].rules = sheet.rules;
      any = true;
    }
    if (sheet.validations.length) {
      meta.sheets[sheet.name].validations = sheet.validations;
      any = true;
    }
    if (sheet.color) {
      meta.sheets[sheet.name].color = sheet.color;
      any = true;
    }
    if (sheet.protected) {
      meta.sheets[sheet.name].protected = true;
      any = true;
    }
    // ODF hides a sheet through its table style but has no very-hidden state, so the block records which kind.
    if (ods && sheet.hidden) {
      meta.sheets[sheet.name].visibility = sheet.veryHidden ? 'veryHidden' : 'hidden';
      any = true;
    }
    if (sheet.groups.rows.length || sheet.groups.cols.length) {
      meta.sheets[sheet.name].groups = sheet.groups;
      any = true;
    }
    if (sheet.zeros === false) {
      meta.sheets[sheet.name].zeros = false;
      any = true;
    }
    if (sheet.defaultVAlign) {
      meta.sheets[sheet.name].defaultVAlign = sheet.defaultVAlign;
      any = true;
    }
    if (!ods) meta.sheets[sheet.name].nativeDefaultVAlign = nativeDefaultVAlign;
    if (sheet.rightToLeft) {
      meta.sheets[sheet.name].rightToLeft = true;
      any = true;
    }
    if (sheet.gridlines === false) {
      meta.sheets[sheet.name].gridlines = false;
      any = true;
    }
    if (sheet.headers === false) { meta.sheets[sheet.name].headers = false; any = true; }
    if (sheet.viewSelection) { meta.sheets[sheet.name].viewSelection = sheet.viewSelection; any = true; }
    if (sheet.viewOrigin) { meta.sheets[sheet.name].viewOrigin = sheet.viewOrigin; any = true; }
    if (sheet.frozenOrigin) { meta.sheets[sheet.name].frozenOrigin = sheet.frozenOrigin; any = true; }
    if (sheet.split) { meta.sheets[sheet.name].split = sheet.split; any = true; }
    if (sheet.viewZoom != null) { meta.sheets[sheet.name].viewZoom = sheet.viewZoom; any = true; }
    if (sheet.viewMode) { meta.sheets[sheet.name].viewMode = sheet.viewMode; any = true; }
    if (sheet.showPageBreaks) { meta.sheets[sheet.name].showPageBreaks = true; any = true; }
    // View ▸ Sheet View: the sheet's named filter views (a file has no one in them).
    if (sheet.sheetViews?.length) { meta.sheets[sheet.name].sheetViews = sheet.sheetViews.filter((v) => !v.temporary); any = true; }
    if (sheet.printSettings) { meta.sheets[sheet.name].printSettings = sheet.printSettings; any = true; }
    if (sheet.tables.length) {
      meta.sheets[sheet.name].tables = sheet.tables;
      if (!ods) meta.sheets[sheet.name].nativeTables = true;
      any = true;
    }
    if (sheet.charts.length) {
      meta.sheets[sheet.name].charts = sheet.charts;
      any = true;
    }
    if (sheetFilters(sheet).length) {
      const record = meta.sheets[sheet.name];
      record.filter = sheet.filter;
      if (sheet.otherFilters?.length) record.otherFilters = sheet.otherFilters;
      if (!ods) {
        const ws = fileSheets?.[sheet.name];
        const outputs = [ws?.['!autofilter'], ...Object.values(ws?.['!tableFilters'] || {})].filter(Boolean);
        record.nativeFilters = outputs.map(output => {
          const range = parseRange(output.ref);
          return { range, criteria: readXlsxFilter(output.filterColumns || '', range) || {},
            ...readXlsxFilterButtons(output.filterColumns || '', range) };
        });
        record.nativeFilterView = {
          hidden: Object.entries(ws?.['!rows'] || {}).filter(([, row]) => row?.hidden).map(([r]) => Number(r)),
          filtered: [...sheet.filterHidden].sort((a, b) => a - b),
        };
        // Retain the legacy primary baseline for readers predating multiple contexts.
        record.nativeFilter = record.nativeFilters.find(f => sameFilterRange(f, sheet.filter)) || null;
      }
      any = true;
    }
  }
  // Even a plain XLSX needs to identify our defaults. The writer's generic
  // Calibri font must not replace the app's font when the file is reopened.
  return any || !ods ? packNativeFillState(meta) : null;
}

/** The SheetJS workbook for this document; `meta` adds the very-hidden styling sheet this app reads back. */
function buildBook(X, wb, { meta = true, odsSettings = false, ods = false, history = true } = {}) {
  const book = { SheetNames: [], Sheets: Object.create(null), Workbook: { Sheets: [] } };
  for (const sheet of wb.sheets) {
    book.SheetNames.push(sheet.name);
    book.Sheets[sheet.name] = buildSheet(X, wb, sheet, { ods });
    book.Workbook.Sheets.push({ name: sheet.name, Hidden: sheet.hidden ? (sheet.veryHidden ? 2 : 1) : 0 });
  }
  const structuredNames = [];
  if (wb.names.length) {
    const allTables = wb.tableNames(), tablesByScope = new Map();
    book.Workbook.Names = wb.names.map((n) => {
      const scope = n.sheet || null;
      if (!tablesByScope.has(scope)) {
        const defined = new Set(wb.names.filter((entry) => !entry.sheet || entry.sheet === scope).map((entry) => entry.name.toUpperCase()));
        tablesByScope.set(scope, allTables.filter((name) => !defined.has(name.toUpperCase())));
      }
      const tableNames = tablesByScope.get(scope);
      // Native XLSX tables retain named structured references, including
      // connection source names and dynamic table membership. ODS needs A1.
      const fixedRef = ods ? tableRefsToA1(n.ref, (table, spec) => {
        const resolved = wb.resolveTableRef(wb.sheets[0].id, 0, 0, table, spec);
        return isError(resolved) ? null : resolved;
      }, (table, spec) => !!table && parseTableSpec(spec)?.rows !== 'this', tableNames) : n.ref;
      const dynamicRef = ods && workbookNameReference(fixedRef) ? '#REF!' : exportNamedTableReferences(wb, fixedRef);
      const ref = meta ? toFileFormula(dynamicRef) : dynamicRef;
      // Native prefixes and spill syntax decode without metadata. Only table
      // conversion and unsupported ODS name scopes need the original expression saved.
      if (dynamicRef !== n.ref) structuredNames.push({ name: n.name, ref: n.ref, fileRef: ref, ...(n.sheet ? { sheet: n.sheet } : {}) });
      return { Name: n.name, Ref: ref, ...(n.hidden ? { Hidden: true } : {}), ...(n.sheet ? { Sheet: wb.sheets.findIndex((s) => s.name === n.sheet) } : {}) };
    });
  }
  for (const [i, sheet] of wb.sheets.entries()) {
    const p = sheet.printSettings;
    if (!p) continue;
    const prefix = `'${sheet.name.replace(/'/g, "''")}'!`;
    if (p.areas.length) {
      const ref = p.areas.map(r => prefix + X.utils.encode_range({
        s: { r: r.r1, c: r.c1 }, e: { r: r.r2, c: r.c2 },
      }).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')).join(',');
      (book.Workbook.Names ||= []).push({ Name: '_xlnm.Print_Area', Ref: ref, Sheet: i });
    }
    const titles = [];
    if (sheet.kind !== 'chart' && p.titleRows) titles.push(prefix + p.titleRows.map(r => `$${r + 1}`).join(':'));
    if (sheet.kind !== 'chart' && p.titleCols) titles.push(prefix + p.titleCols.map(c => `$${X.utils.encode_col(c)}`).join(':'));
    if (titles.length) (book.Workbook.Names ||= []).push({ Name: '_xlnm.Print_Titles', Ref: titles.join(','), Sheet: i });
  }
  const extra = meta || odsSettings ? collectMeta(wb, structuredNames, { ods: odsSettings, fileSheets: book.Sheets, history }) : null;
  if (extra && odsSettings) book.PuterSettings = extra;
  if (extra && meta) {
    // A user worksheet may have the usual sidecar name. Keep its name and
    // references intact, and choose an unused name for our own sheet.
    const used = new Set(book.SheetNames.map((n) => n.toLowerCase()));
    let metaName = META_SHEET;
    for (let n = 2; used.has(metaName.toLowerCase()); n++) metaName = `${META_SHEET}${n}`;
    const validationCells = prepareXlsxValidationLists(book, metaName, extra, X, wb.tableNames());
    const json = stringifyXlsxMetadata(extra);
    const chunks = [];
    for (let i = 0; i < json.length;) {
      // Never cut between the two halves of a character (an emoji in a sheet name or note).
      let end = Math.min(json.length, i + META_CHUNK);
      if (end < json.length && json.charCodeAt(end - 1) >= 0xd800 && json.charCodeAt(end - 1) <= 0xdbff) end++;
      chunks.push([json.slice(i, end)]);
      i = end;
    }
    book.SheetNames.push(metaName);
    book.Sheets[metaName] = X.utils.aoa_to_sheet(chunks);
    const metaSheet = book.Sheets[metaName], extent = X.utils.decode_range(metaSheet['!ref']);
    for (const [address, cell] of Object.entries(validationCells)) {
      metaSheet[address] = cell;
      const pos = X.utils.decode_cell(address); extent.e.r = Math.max(extent.e.r, pos.r); extent.e.c = Math.max(extent.e.c, pos.c);
    }
    metaSheet['!ref'] = X.utils.encode_range(extent);
    book.Workbook.Sheets.push({ name: metaName, Hidden: 2 });
    book.PuterExportMeta = { name: metaName, data: extra };
  }
  return book;
}

/**
 * The workbook as everyone sees it. While this person is in a sheet view (View ▸ Sheet View) a file must
 * still hold the default view's filters: the copy toJSON makes has them, with the view kept among the views.
 */
function sharedBook(wb) {
  if (!wb.sheets.some((s) => s.personalView)) return wb;
  const copy = new Workbook(wb.toJSON());
  if (wb.externalFormulas) copy.externalFormulas = wb.externalFormulas;
  return copy;
}

/** Serialize the workbook to an .xlsx Blob. */
export async function workbookToXlsx(wb, { sourceWorkbook = null, history = true } = {}) {
  wb = sharedBook(wb);
  const { completeXlsx } = await import('./xlsx-export.js');
  const X = await XLSX();
  const book = buildBook(X, wb, { history });
  const data = await completeXlsx(X, wb, book, X.write(book, { bookType: 'xlsx', type: 'array' }), { sourceWorkbook });
  return new Blob([data], { type: XLSX_MIME });
}

/**
 * Serialize the workbook to an OpenDocument .ods Blob (LibreOffice's native
 * format). Values, formulas, number formats, merges, and column widths
 * travel. Active filters also retain their app-specific criteria and dependent
 * styles, rules, and tables in standard ODF application settings.
 */
export async function workbookToOds(wb, { settings = true, history = true } = {}) {
  wb = sharedBook(wb);
  const X = await XLSX();
  // The app's own settings (styles, frozen panes, tab colours, protection, rules, charts,
  // tables and filter criteria) ride along in a standard ODF settings block other readers
  // ignore. Without them the file is exactly what those readers see. The entries are
  // deflated as an .xlsx's are; the writer keeps the mimetype entry first and stored, as ODF asks.
  const data = X.write(buildBook(X, wb, { meta: false, odsSettings: settings, ods: true, history }), { bookType: 'ods', type: 'array', compression: true });
  return new Blob([data], { type: ODS_MIME });
}

/** One sheet as CSV text (computed values, formatted as displayed). */
export function sheetToCsv(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  const used = wb.usedRange(sheetId);
  if (!sheet || !used) return '';
  return rangeToCsv(wb, sheetId, { r1: 0, c1: 0, r2: used.r2, c2: used.c2 });
}

/** One range as CSV text (computed values, formatted as displayed). */
export function rangeToCsv(wb, sheetId, range) {
  // Where the decimal mark is a comma, fields are separated by semicolons (as Excel does there).
  return rangeToDelimited(wb, sheetId, range, localeInfo().decimal === ',' ? ';' : ',');
}

export const TSV_MIME = 'text/tab-separated-values;charset=utf-8';
export const HTML_MIME = 'text/html;charset=utf-8';

/** One sheet as tab-separated text. */
export function sheetToTsv(wb, sheetId) {
  const used = wb.usedRange(sheetId);
  if (!wb.sheet(sheetId) || !used) return '';
  return rangeToDelimited(wb, sheetId, { r1: 0, c1: 0, r2: used.r2, c2: used.c2 }, '\t');
}

// Text another program would run as a formula when it opens the file (a DDE
// command, say): Excel treats a field starting with any of these as one. A field
// that is only a dash, a plus or an at sign is a dash or a sign, not a formula.
const FORMULA_START = /^[=+\-@\t\r]/;
const LONE_SIGN = /^[-+@]$/;
// The one shape a "+", "-" or "@" text may keep unmarked: a sign and then only what a
// phone number or a signed number is written with. It is a positive rule on purpose —
// Excel and LibreOffice run formulas this app's parser rejects, a DDE command such as
// -2+3+cmd|' /C calc'!A0 among them, so everything outside this shape is marked.
const SIGNED_NUMBER_SHAPE = /^[-+][\d\s().-]*$/;

/**
 * Whether text would run as a formula in another program: after "=", a tab or a return,
 * whatever follows; after "+", "-" or "@" everything except a phone number such as
 * +1 555 123 4567 or +49 (0) 30 1234, which is text there too and would lose the round
 * trip its fidelity for no safety. A signed number (+1, -5) is written the same way but
 * does read as a formula, so it keeps its mark and stays text.
 */
function formulaShapedText(text) {
  if (!FORMULA_START.test(text) || LONE_SIGN.test(text)) return false;
  if (!/^[-+@]/.test(text)) return true;
  if (!SIGNED_NUMBER_SHAPE.test(text)) return true;
  const { f } = parseInput(`=${text}`);
  if (f == null) return true;
  try { parseFormula(f); return true; } catch (e) { return e instanceof RangeError; }
}

/**
 * Whether a field's text would run as a formula in another program. A text cell's
 * is judged by its text; a number's also by whether the text still reads as a number
 * (-5, -$5.00, -50%, +5, -1E+21), which needs no mark, since a format such as "="0 can
 * prepend the same characters to a number and hand the program a formula that way.
 */
function formulaShaped(text, value) {
  if (!formulaShapedText(text)) return false;
  if (typeof value !== 'number') return true;
  const read = parseInput(text);
  return read.f != null || typeof read.v === 'string';
}

/** One range as delimiter-separated text: fields holding the delimiter, quotes, or line breaks are quoted. */
export function rangeToDelimited(wb, sheetId, range, delim) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return '';
  const quoteRe = new RegExp(`["${delim === '\t' ? '\\t' : delim}\\r\\n]`);
  const lines = [];
  // Whole columns or rows end where the sheet's content does, not at row 1,048,576 or column XFD.
  const used = range.r2 >= MAX_ROW || range.c2 >= MAX_COL ? wb.usedRange(sheetId) || { r2: range.r1, c2: range.c1 } : null;
  if (used) range = { ...range, r2: range.r2 >= MAX_ROW ? Math.max(range.r1, used.r2) : range.r2, c2: range.c2 >= MAX_COL ? Math.max(range.c1, used.c2) : range.c2 };
  const c1 = range.c1;
  const c2 = Math.min(range.c2, sheet.cols - 1);
  // Walk each row only as far as its last stored or spilled cell: a far-off cell must not
  // cost a display of every empty coordinate of the rectangle.
  const lastCol = lastContentColumns(wb, sheet);
  for (let r = range.r1; r <= Math.min(range.r2, sheet.rows - 1); r++) {
    const row = [];
    const end = Math.min(c2, lastCol.get(r) ?? -1);
    for (let c = c1; c <= end; c++) {
      let text = wb.getDisplay(sheetId, r, c);
      // Text shaped like a formula is marked as text with a leading apostrophe and quoted,
      // as spreadsheet programs do on export; a number such as -5 is left as it is.
      const guarded = FORMULA_START.test(text) && formulaShaped(text, wb.getValue(sheetId, r, c));
      if (guarded) text = `'${text}`;
      row.push(guarded || quoteRe.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    // The empty fields after the last cell each need a delimiter; an empty row is one field fewer than its columns.
    lines.push(row.join(delim) + delim.repeat(Math.max(0, end >= c1 ? c2 - end : c2 - c1)));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

const escapeHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** For every row holding a stored or spilled cell, the index of its last one. */
function lastContentColumns(wb, sheet) {
  const last = new Map();
  const note = (r, c) => { if ((last.get(r) ?? -1) < c) last.set(r, c); };
  for (const key of sheet.cells.keys()) { const { r, c } = parseKey(key); note(r, c); }
  for (const { r, c } of wb.spillEntries(sheet.id)) note(r, c);
  return last;
}

/**
 * One sheet as a standalone web page: a table of the displayed values with
 * the cells' text styles, colors, alignment, and the conditional formatting
 * and table colors showing on screen, plus the column widths.
 */
export function sheetToHtml(wb, sheetId, { title = '' } = {}) {
  const sheet = wb.sheet(sheetId);
  const used = wb.usedRange(sheetId);
  const head = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title || sheet?.name || 'Sheet')}</title>`
    + '<style>body{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;margin:24px}h1{font-size:18px;margin:0 0 12px}table{border-collapse:collapse;table-layout:fixed}td{border:1px solid #ddd;padding:3px 6px;vertical-align:middle;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>'
    + (title ? `<h1>${escapeHtml(title)}</h1>` : '');
  if (!sheet || !used) return `${head}<p>This sheet is empty.</p></body></html>`;
  const rows = [];
  const cols = [];
  for (let r = 0; r <= used.r2; r++) if (!wb.isRowHidden(sheetId, r)) rows.push(r);
  for (let c = 0; c <= used.c2; c++) if (!sheet.hiddenCols.has(c)) cols.push(c);
  // A row without any cell is an empty table row; only rows with content are read cell by cell.
  const lastCol = lastContentColumns(wb, sheet);
  const filled = (r) => lastCol.has(r);
  const texts = rows.map((r) => (filled(r) ? cols.map((c) => wb.getDisplay(sheetId, r, c)) : []));
  const cells = rows.map((r) => (filled(r) ? cols.map((c) => wb.getCell(sheetId, r, c) || null) : []));
  const values = rows.map((r) => (filled(r) ? cols.map((c) => wb.getValue(sheetId, r, c)) : []));
  const styles = rows.map((r) => (filled(r) ? cols.map((c) => wb.displayStyleAt(sheetId, r, c)) : []));
  const decorated = sheet.rules.length || sheet.tables?.length;
  const looks = decorated ? rows.map((r) => (filled(r) ? cols.map((c) => wb.conditionalStyle(sheetId, r, c, wb.getValue(sheetId, r, c)) || null) : [])) : null;
  const table = cellsToHtml(texts, cells, looks, values, null, { clipboard: false, styles, colorPalette: wb.colorPalette, normalFill: wb.nativeNormalFill, indentUnit: normalIndentUnit(wb.normalFont) })
    .replace(/ data-spreadsheet-[\w-]+="[^"]*"/g, '');
  const colgroup = `<colgroup>${cols.map((c) => `<col style="width:${wb.colWidth(sheetId, c)}px">`).join('')}</colgroup>`;
  return `${head}${table.replace(/^(<table[^>]*>)/, `$1${colgroup}`)}</body></html>`;
}

/* ---------- Import ---------- */

/**
 * SheetJS worksheets are sparse; a distant cell must not make us scan every
 * empty coordinate. Every stored cell counts, even one outside the sheet's
 * declared dimension: generators often write a stale or understated one.
 */
function storedCells(X, ws) {
  if (!ws) return [];
  const cells = [];
  for (const addr of Object.keys(ws)) {
    if (!/^[A-Z]+[1-9]\d*$/.test(addr)) continue;
    const { r, c } = X.utils.decode_cell(addr);
    cells.push({ r, c, addr, cell: ws[addr] });
  }
  // Preserve the original row-major evaluation order, including overlapping array formulas.
  return cells.sort((a, b) => a.r - b.r || a.c - b.c);
}

function readMeta(X, ws) {
  if (!ws || !ws['!ref']) return null;
  let json = '';
  for (const { c, cell } of storedCells(X, ws)) {
    if (c === 0 && cell?.v != null) json += String(cell.v);
  }
  try {
    const meta = parseXlsxMetadata(json);
    return meta && meta.sheets ? meta : null;
  } catch {
    return null;
  }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// XML 1.0 normalizes literal CRLF and CR before resolving character references.
// In particular, table formulas must match LF-containing column names; an
// explicit &#13; still represents a real CR and must survive the import.
const unescapeXml = (text) => String(text).replace(/\r\n?/g, '\n').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, entity) => {
  if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()] ?? m;
  const hex = /^#x/i.test(entity);
  const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});
const xmlAttr = (tag, name) => {
  const m = tag?.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};
// The built-in table styles cycle through the theme's accent colours.
const TABLE_STYLE_COLORS = ['gray', 'blue', 'orange', 'gray', 'orange', 'blue', 'green'];

/**
 * Excel tables from a sheet's table parts (xl/tables/tableN.xml), in this
 * app's model: name, range with its header and optional totals row, style,
 * and the calculated column formulas. The vendor keeps the parts' XML on the
 * sheet; a table without a header row has no place here and is left out.
 */
function nativeTables(X, ws, definedNames, customStyles) {
  const tables = [];
  for (const xml of ws?.['!tableXml'] || []) {
    const open = xml.match(/<table\s[^>]*>/)?.[0];
    const name = decodeXlsxString(xmlAttr(open, 'displayName') || xmlAttr(open, 'name'));
    const ref = xmlAttr(open, 'ref')?.replace(/\$/g, '');
    if (!name?.trim() || !ref || !/^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/i.test(ref)) continue;
    // headerRowCount="0": the Header Row is turned off, and the column names live in tableColumn alone.
    const headerless = xmlAttr(open, 'headerRowCount') === '0', columnNames = [];
    const range = X.utils.decode_range(ref.toUpperCase());
    const styleInfo = xml.match(/<tableStyleInfo\s[^>]*>/)?.[0];
    const styleName = xmlAttr(styleInfo, 'name');
    const customStyle = customStyles?.get(styleName);
    const styleIndex = Number(styleName?.match(/(\d+)$/)?.[1] || 0);
    const calc = {}, calcArray = {}, scalarColumns = new Set();
    let column = 0;
    for (const m of xml.matchAll(/<tableColumn\s[^>]*?(?:\/>|>([\s\S]*?)<\/tableColumn>)/g)) {
      if (headerless) columnNames.push(decodeXlsxString(xmlAttr(m[0].match(/<tableColumn\s[^>]*?\/?>/)?.[0], 'name') || '') || null);
      const formula = m[1]?.match(/(<calculatedColumnFormula(?:\s[^>]*)?>)([\s\S]*?)<\/calculatedColumnFormula>/);
      if (formula) {
        const f = fromFileFormula(unescapeXml(formula[2]), definedNames);
        const array = ['1', 'true'].includes(xmlAttr(formula[1], 'array'));
        calc[column] = array ? f : intersectTableFormula(f);
        if (array) calcArray[column] = true;
        if (!array) scalarColumns.add(range.s.c + column);
      }
      column++;
    }
    const autoFilter = xml.match(/<autoFilter\b[^<>]*(?:\/>|>[\s\S]*?<\/autoFilter>)/)?.[0];
    const filter = xmlAttr(autoFilter?.match(/<autoFilter\b[^<>]*>/)?.[0], 'ref')?.replace(/\$/g, '');
    tables.push({
      name: name.trim(),
      range: { r1: range.s.r, c1: range.s.c, r2: range.e.r, c2: range.e.c },
      totalsRow: Number(xmlAttr(open, 'totalsRowCount') || 0) > 0,
      ...(headerless ? { headerRow: false, columnNames } : {}),
      // An explicit tableStyleInfo without a name is Excel's "None" style.
      // Giving it our default theme recolors directly formatted headers.
      style: styleInfo && !styleName ? 'none' : styleIndex ? TABLE_STYLE_COLORS[(styleIndex - 1) % TABLE_STYLE_COLORS.length] : 'blue',
      ...(customStyle ? { style: 'custom', customStyle } : {}),
      banded: !['0', 'false'].includes(xmlAttr(styleInfo, 'showRowStripes')),
      ...(['1', 'true'].includes(xmlAttr(styleInfo, 'showFirstColumn')) ? { firstColumn: true } : {}),
      ...(['1', 'true'].includes(xmlAttr(styleInfo, 'showColumnStripes')) ? { bandedColumns: true } : {}),
      ...(['1', 'true'].includes(xmlAttr(styleInfo, 'showLastColumn')) ? { lastColumn: true } : {}),
      calc,
      ...(Object.keys(calcArray).length ? { calcArray } : {}),
      scalarColumns,
      filter: !headerless && filter && /^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/i.test(filter) ? { ...X.utils.decode_range(filter.toUpperCase()), xml: autoFilter } : null,
    });
  }
  return tables;
}

const validMetaRange = range => ['r1', 'c1', 'r2', 'c2'].every(k => Number.isInteger(range?.[k])
  && range[k] >= 0 && range[k] <= (k[0] === 'r' ? MAX_ROW : MAX_COL)) && range.r1 <= range.r2 && range.c1 <= range.c2;

/** Native table definitions win; private origins/themes survive only while equivalent. */
function reconcileTables(native, own, xlsx, definedNames, externalWorkbooks, theme = null) {
  const saved = Array.isArray(own?.tables) ? own.tables : [];
  // Older exports and ODS could carry tables exclusively in their sidecar.
  if (!xlsx || (!native.length && own?.nativeTables !== true)) return saved;
  const byName = new Map(saved.filter(t => typeof t?.name === 'string' && validMetaRange(t.range)).map(t => [t.name.toLowerCase(), t]));
  return native.map(({ filter, scalarColumns, ...table }) => {
    const previous = byName.get(table.name.toLowerCase());
    if (!previous) return table;
    const result = { ...table, id: previous.id };
    const appearance = table.style === 'none' ? null : normalizeCustomTableStyle(table.customStyle);
    if ((table.style === 'none' || table.customStyle) && JSON.stringify(appearance) === JSON.stringify(normalizeCustomTableStyle(tableStyleParts(previous, theme)))) {
      result.style = previous.style;
      if (previous.customStyle) result.customStyle = previous.customStyle;
      else delete result.customStyle;
    }
    const expected = {}, arrays = {};
    for (const [offset, value] of Object.entries(tableFileFormulas(previous, externalWorkbooks))) {
      const f = fromFileFormula(value.formula, definedNames);
      expected[offset] = value.array ? f : intersectTableFormula(f);
      if (value.array) arrays[offset] = true;
    }
    const unchanged = JSON.stringify(expected) === JSON.stringify(table.calc)
      && JSON.stringify(arrays) === JSON.stringify(table.calcArray || {});
    // Legacy table parts had no templates; keep those private formulas until a
    // native template supersedes them. New files distinguish deliberate removal.
    if (unchanged || own?.nativeTables !== true && !Object.keys(table.calc).length) {
      result.calc = previous.calc;
      if (previous.calcArray) result.calcArray = previous.calcArray;
      if (previous.calcRow != null) result.calcRow = previous.calcRow;
    }
    return result;
  });
}

/**
 * The sheet's filter as the file has it: the autofilter's range with the
 * conditions the reader found (an .ods) or Excel's filterColumn elements hold,
 * else the range of an Excel table's own filter. Conditions the app has no
 * criterion for leave the filter without any, as before.
 */
function fileFilter(X, own, tableFilter) {
  const source = own?.ref ? { ...X.utils.decode_range(own.ref), xml: own.xml } : tableFilter;
  if (!source) return null;
  const range = { r1: source.s.r, c1: source.s.c, r2: source.e.r, c2: source.e.c };
  const criteria = own?.criteria || (source.xml ? readXlsxFilter(source.xml, range) : null) || {};
  return { range, criteria, ...(own?.showButtons === false ? { showButtons: false } : readXlsxFilterButtons(source.xml, range)) };
}

/** Whether a text is exactly how a number spells itself, which is how a file names one. */
const numberSpelling = (text) => typeof text === 'string' && text !== '' && String(Number(text)) === text;

/**
 * A file's value list names values, not the text this app shows them as: Excel writes
 * `<filter val="1234.5"/>` for a cell showing 1,234.50, so such a list matches no row of a
 * formatted number column and the sheet opens with every row hidden. Now that the book exists
 * and can format its cells, each spelled-out number is replaced by the texts the column shows it
 * as, with the keys of those numbers beside them, which is the shape this app's own filter menu
 * makes: the menu then lists the chosen entries ticked and the rows the file showed stay on screen.
 */
function adoptFileFilters(wb, sheets) {
  wb.sheets.forEach((sheet, i) => {
    const nativeRanges = new Set((sheets[i]?.filtersFromFile || []).map(range => filterRangeKey({ range })));
    let anyChanged = false;
    mapSheetFilters(sheet, filter => {
      if (!nativeRanges.has(filterRangeKey(filter))) return filter;
      const criteria = { ...filter.criteria };
      let changed = false;
      for (const [key, crit] of Object.entries(criteria)) {
        if (!Array.isArray(crit.values) || !crit.values.some(numberSpelling)) continue;
        const byText = wb.filterKeysByText(sheet.id, Number(key), filter);
        // Every number the column shows, filed under the spelling a file would name it by.
        const spelled = new Map();
        for (const [text, keys] of byText) {
          for (const k of keys) {
            const number = String(k).split('|')[0];
            if (!spelled.has(number)) spelled.set(number, new Set());
            spelled.get(number).add(text);
          }
        }
        const values = [...new Set(crit.values.flatMap((value) => (spelled.has(value) ? [...spelled.get(value)] : [value])))];
        if (values.length === crit.values.length && values.every((value, n) => value === crit.values[n])) continue;
        const keys = new Set();
        for (const text of values) for (const k of byText.get(text) || []) keys.add(k);
        criteria[key] = { ...crit, values, ...(keys.size ? { keys: [...keys] } : {}) };
        changed = true;
      }
      if (!changed) return filter;
      anyChanged = true;
      return { ...filter, criteria };
    });
    if (anyChanged && !Array.isArray(sheets[i]?.filterHidden)) wb.reapplyFilter(sheet.id);
  });
}

// Kept merges are filed by bands of this many rows, so a merge is compared with the few near it.
const MERGE_BAND = 64;
// A merge spanning this many bands (a whole column, say) is filed once and compared with every merge.
const TALL_MERGE_BANDS = 256;

/**
 * The merges of a file, less any that shares a cell with an earlier one: two such merges
 * would leave the cell hidden under one block and the anchor of the other, a state the app
 * never makes itself (merging over a block replaces it) and Excel refuses with a repair
 * prompt. The later of the two in the file is dropped. Each merge is compared only with the
 * kept merges filed under its own rows, so a report of thousands of merges, as other
 * programs' exports carry, opens in about the time of their count rather than its square.
 */
function fileMerges(list) {
  const kept = [], bands = new Map(), tall = [];
  const overlaps = (k, m) => !(k.r2 < m.r1 || k.r1 > m.r2 || k.c2 < m.c1 || k.c1 > m.c2);
  for (const m of list) {
    const first = Math.floor(m.r1 / MERGE_BAND), last = Math.floor(m.r2 / MERGE_BAND);
    let clash = tall.some((k) => overlaps(k, m));
    for (let band = first; band <= last && !clash; band++) clash = bands.get(band)?.some((k) => overlaps(k, m)) ?? false;
    if (clash) continue;
    kept.push(m);
    if (last - first >= TALL_MERGE_BANDS) { tall.push(m); continue; }
    for (let band = first; band <= last; band++) {
      const filed = bands.get(band);
      if (filed) filed.push(m); else bands.set(band, [m]);
    }
  }
  return kept;
}

// A defined name whose definition is a bare number.
const BARE_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * In a file on the 1904 date system the cells' date serials were moved to this app's 1900
 * serials; a defined name holding a bare number may be a date serial too (Anniversary =
 * 30000), which nothing in the file says. The cells that read it tell: a name at least one
 * date-formatted cell reads directly, and no cell of another number format, is moved with
 * them. A name read only by unformatted cells or inside functions (=DATEDIF(Start,TODAY(),"y")
 * in a plain cell) cannot be told from a constant such as Periods = 12 and is left as it is.
 */
function shiftDateNames(names, sheets) {
  const votes = new Map();
  for (const n of names) if (BARE_NUMBER.test(n.ref) && Number(n.ref) >= 1) votes.set(n.name.toUpperCase(), { date: 0, other: 0 });
  if (!votes.size) return;
  const mentioned = new RegExp(`\\b(?:${[...votes.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
  for (const sheet of sheets) {
    for (const cell of Object.values(sheet.cells || {})) {
      if (cell.f == null || !mentioned.test(cell.f)) continue;
      const kind = dateTimeKind(cell.s, 0), fmt = cell.s?.fmt;
      const vote = kind === 'date' || kind === 'datetime' ? 'date' : fmt && fmt !== 'general' && fmt !== 'text' ? 'other' : null;
      if (!vote) continue;
      let tokens;
      try { tokens = tokenize(cell.f); } catch { continue; }
      for (const t of tokens) {
        const tally = t.type === 'name' && !t.sheet ? votes.get(String(t.value).toUpperCase()) : null;
        if (tally) tally[vote]++;
      }
    }
  }
  for (const n of names) {
    const tally = votes.get(n.name.toUpperCase());
    if (tally?.date && !tally.other) n.ref = String(Number(n.ref) + 1462);
  }
}

/**
 * The worksheet XML of each sheet of an .xlsx, by name, from the parts the reader inflated:
 * `(name) => xml | null`. What the vendor does not hand on (panes, the tab colour, the
 * gridline setting, protection) this app reads from the part itself; a part is decoded
 * once, and only when asked for. Other containers (.xls, .ods) have no such parts.
 */
function sheetParts(book) {
  const files = book.files, rels = files?.['xl/_rels/workbook.xml.rels'];
  if (!rels?.content || !Array.isArray(book.Workbook?.Sheets)) return () => null;
  const targets = new Map();
  for (const m of new TextDecoder().decode(rels.content).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = xmlAttr(m[0], 'Id'), target = xmlAttr(m[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const part = files[targets.get(book.Workbook.Sheets[book.SheetNames.indexOf(name)]?.id) ?? ''];
    const xml = part?.content ? new TextDecoder().decode(part.content) : null;
    cache.set(name, xml);
    return xml;
  };
}

/** CT_Selection: sqref may contain several ranges; activeCellId names one.
 * Only the active pane of the first workbook view drives the editor selection.
 * https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.selection
 */
function readSheetSelection(view) {
  const pane = view.match(/<(?:\w+:)?pane\b[^>]*>/)?.[0];
  const activePane = xlsxAttr(pane, 'activePane') || 'topLeft';
  const selection = [...view.matchAll(/<(?:\w+:)?selection\b[^>]*>/g)]
    .map(m => m[0]).find(s => (xlsxAttr(s, 'pane') || 'topLeft') === activePane);
  if (!selection) return null;
  const active = parseCellRef(xlsxAttr(selection, 'activeCell'));
  const refs = xlsxAttr(selection, 'sqref');
  const ranges = refs == null ? (active && active.r <= MAX_ROW && active.c <= MAX_COL ? [{ r1: active.r, c1: active.c, r2: active.r, c2: active.c }] : [parseRange('A1')])
    : refs.trim().split(/\s+/).map(parseRange);
  return normalizeSheetSelection({ active, ranges, activeRange: Number(xlsxAttr(selection, 'activeCellId') || 0) });
}

/**
 * Sheet state another program wrote into the worksheet XML that the vendor leaves there,
 * read from the parts before and after <sheetData>: the frozen panes, the tab colour, the
 * gridline setting and whether the sheet is protected.
 */
function sheetPartState(xml) {
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const start = xml.search(/<(?:\w+:)?sheetData[\s>/]/);
  const head = start < 0 ? xml : xml.slice(0, start);
  const close = xml.search(/<\/(?:\w+:)?sheetData>|<(?:\w+:)?sheetData\/>/);
  const chart = /<(?:\w+:)?chartsheet\b/.test(head);
  const tail = close < 0 ? chart ? xml : '' : xml.slice(close);
  // Protection guards the sheet's cells only when the element says sheet="1"; its password is not kept.
  const protection = tail.match(/<(?:\w+:)?sheetProtection\b[^>]*>/)?.[0];
  const locked = !!protection && (chart
    ? ['content', 'objects'].some(key => ['1', 'true'].includes(xmlAttr(protection, key) || ''))
    : ['1', 'true'].includes(xmlAttr(protection, 'sheet') || ''));
  // The first view is the one the sheet shows; gridlines are on unless it says otherwise.
  const viewXml = head.match(/<(?:\w+:)?sheetView\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?sheetView>)/)?.[0] || '';
  const view = viewXml.match(/<(?:\w+:)?sheetView\b[^>]*>/)?.[0];
  const gridlines = !['0', 'false'].includes(xmlAttr(view, 'showGridLines') || '');
  // Only a frozen pane's splits count rows and columns; a split pane's are distances.
  const pane = viewXml.match(/<(?:\w+:)?pane\b[^>]*>/)?.[0];
  const frozen = pane && /^frozen(?:Split)?$/.test(xmlAttr(pane, 'state') || '') ? { rows: Math.max(0, Math.trunc(Number(xmlAttr(pane, 'ySplit')) || 0)), cols: Math.max(0, Math.trunc(Number(xmlAttr(pane, 'xSplit')) || 0)) } : null;
  const topLeft = normalizeSheetOrigin(parseCellRef(xmlAttr(view, 'topLeftCell')));
  const paneTopLeft = normalizeSheetOrigin(parseCellRef(xmlAttr(pane, 'topLeftCell')));
  const base = topLeft || { r: 0, c: 0 };
  // A split window's xSplit and ySplit are distances; sheetView names the top-left pane's first cell, and the
  // pane the bottom-right one's, which is the view origin the grid scrolls.
  const split = pane && !frozen && (xmlAttr(pane, 'state') || 'split') === 'split' ? splitFromPane(xmlAttr(pane, 'xSplit'), xmlAttr(pane, 'ySplit'), base) : null;
  // On frozen axes sheetView names the first frozen cell, while pane names
  // the first scrolling cell. On other axes Excel uses sheetView alone.
  const viewOrigin = frozen ? {
    r: frozen.rows ? Math.max(base.r + frozen.rows, paneTopLeft?.r ?? 0) : base.r,
    c: frozen.cols ? Math.max(base.c + frozen.cols, paneTopLeft?.c ?? 0) : base.c,
  } : split && paneTopLeft ? paneTopLeft : topLeft;
  const frozenOrigin = frozen && topLeft ? { r: frozen.rows ? base.r : 0, c: frozen.cols ? base.c : 0 } : null;
  // A tab colour given as ARGB; one named by theme or palette index has no colour of its own here.
  const rgb = xmlAttr(head.match(/<(?:\w+:)?tabColor\b[^>]*>/)?.[0], 'rgb');
  const color = rgb && /^[0-9a-f]{6}$/i.test(rgb.slice(-6)) ? `#${rgb.slice(-6).toLowerCase()}` : null;
  const zoom = Number(xmlAttr(view, 'zoomScale'));
  // Page Layout view and Page Break Preview are the sheet's own view, as Normal is (CT_SheetView's view).
  const viewMode = { pageLayout: 'pageLayout', pageBreakPreview: 'pageBreak' }[xmlAttr(view, 'view') || ''] || 'normal';
  // CT_SheetView/CT_ChartsheetView default zoomScale to 100. An omitted
  // attribute does not mean the previous sheet's or device's saved zoom.
  return { frozen, color, gridlines, headers: !['0', 'false'].includes(xmlAttr(view, 'showRowColHeaders') || ''), rightToLeft: ['1', 'true'].includes(xmlAttr(view, 'rightToLeft')), protected: locked, ...(!chart ? { viewSelection: readSheetSelection(viewXml), viewOrigin, frozenOrigin, ...(split ? { split } : {}) } : {}), ...(chart ? { zoomToFit: ['1', 'true'].includes(xmlAttr(view, 'zoomToFit')) } : { viewMode }), viewZoom: zoom >= 10 && zoom <= 400 ? zoom / 100 : 1 };
}

/**
 * Outline groups from the levels another program gave its rows or columns (the vendor's !rows
 * or !cols entries): every run of lines at a level or deeper is a group of that level, nested
 * level within level, and a group whose every line is out of sight by hand is a collapsed one.
 * `concealed` says which lines count: a row the file's own filter hides does not, since the
 * filter hides it and clearing the filter brings it back inside an open group.
 */
function levelGroups(lines, concealed = (i) => !!lines[i]?.hidden) {
  const groups = [];
  const levelOf = (i) => Math.max(0, Math.min(7, Math.trunc(Number(lines[i]?.level) || 0)));
  const deepest = lines.reduce((max, line) => Math.max(max, Number(line?.level) || 0), 0);
  for (let level = 1; level <= Math.min(7, deepest); level++) {
    let from = -1;
    for (let i = 0; i <= lines.length; i++) {
      const inside = i < lines.length && levelOf(i) >= level;
      if (inside && from < 0) from = i;
      else if (!inside && from >= 0) {
        let collapsed = true;
        for (let k = from; k < i && collapsed; k++) if (!concealed(k)) collapsed = false;
        groups.push({ from, to: i - 1, collapsed });
        from = -1;
      }
    }
  }
  return groups;
}

/**
 * The row and column groups another program's outline levels describe, or null when it has none.
 * `filtered` holds the ranges of filters whose conditions were read, whose rows this app hides again
 * by the filter rather than by hand (see the hidden rows of importSheet).
 */
function fileGroups(ws, filtered = []) {
  const lines = ws?.['!rows'] || [];
  const byHand = (i) => !!(lines[i]?.hidden || lines[i]?.filtered) && !filtered.some(range => i > range.r1 && i <= range.r2);
  const rows = levelGroups(lines, byHand), cols = levelGroups(ws?.['!cols'] || []);
  return rows.length || cols.length ? { rows, cols } : null;
}

/**
 * The solid fill another program gave a cell, as this app's background colour (the vendor
 * hands on the fill alone of a cell's style, with theme colours resolved to RGB). A pattern
 * fill has no one colour, and the app's own files carry their fills in the sidecar instead.
 */
function fileFill(src) {
  const fill = src.s;
  if (!fill || fill.patternType !== 'solid') return null;
  const rgb = fill.fgColor?.rgb;
  return typeof rgb === 'string' && /^[0-9a-f]{6}$/i.test(rgb.slice(-6)) ? `#${rgb.slice(-6).toLowerCase()}` : null;
}

/**
 * Cell formats by index: the vendor hands on a cell's fill alone. Its style table retains
 * fonts and alignment, while borders come from the XML. Font sizes are points in the file
 * and pixels in the grid. Import reconciles native fonts with private inheritance.
 * Null when no format adds styling, avoiding an unnecessary scan of plain sheets.
 */
function fileCellStyles(styles, native, includeDefaults = true) {
  const fonts = styles?.Fonts, xfs = styles?.CellXf;
  if (!Array.isArray(fonts) || !Array.isArray(xfs)) return null;
  const completeDefault = !!native?.nativeDefaultCellFormat;
  if (completeDefault) includeDefaults = true;
  const base = fonts[native?.normalFontId] || fonts[0] || {};
  const hex = (color) => (typeof color?.rgb === 'string' && !color.auto && /^[0-9a-f]{6}$/i.test(color.rgb.slice(-6)) ? color.rgb.slice(-6).toLowerCase() : null);
  const colorOf = (font, i) => native?.fontColors?.[i] || (hex(font?.color) ? `#${hex(font.color)}` : null);
  const baseColor = colorOf(base, native?.normalFontId ?? 0);
  const byFont = fonts.map((font, i) => {
    if (!font) return null;
    const s = {};
    const family = fontKeyFor(native?.fontNames?.[i] ?? font.name, { literal: true });
    if (family && (includeDefaults || (native?.fontNames?.[i] ?? font.name) !== (native?.fontNames?.[native?.normalFontId ?? 0] ?? base.name))) s.font = family;
    const scheme = native?.fontSchemes?.[i] || 'none';
    if (includeDefaults ? scheme !== 'none' || native?.normalFont?.scheme : scheme !== (native?.fontSchemes?.[native?.normalFontId ?? 0] || 'none')) s.scheme = scheme;
    // A supported workbook font keeps its own size and ink, even when it
    // is the Normal font: the app's defaults are not necessarily the same.
    if (includeDefaults && family && Number.isFinite(font.sz) && font.sz > 0) s.size = font.sz * 4 / 3;
    if (includeDefaults && family && (colorOf(font, i) || baseColor)) s.color = colorOf(font, i) || 'windowtext';
    if (i === 0 && !includeDefaults) return Object.keys(s).length ? s : null;
    // Another font record is complete, not a patch on Normal. Its absent
    // flags must suppress a bold/italic/etc. workbook default.
    for (const key of ['bold', 'italic', 'underline', 'strike']) if (font[key] || base[key]) s[key] = !!font[key];
    if (typeof font.sz === 'number' && font.sz > 0 && font.sz !== base.sz) s.size = font.sz * 4 / 3;
    const color = colorOf(font, i);
    if (color && !sameFontColor(color, baseColor) && (color !== '#000000' || baseColor)) s.color = color;
    return Object.keys(s).length ? s : null;
  });
  const byXf = xfs.map((xf, i) => {
    // A cell XF is a complete format. Excel's omitted vertical alignment is
    // bottom even when the entire alignment element is absent (MS-OI29500
    // 2.1.693). Private sidecars own their app defaults, just as for fonts.
    const s = { ...byFont[Number.isInteger(xf?.fontId) ? xf.fontId : 0], ...native?.fills?.[xf?.fillId], ...xlsxAlignment(xf?.alignment || (includeDefaults ? {} : null)), ...native?.borders?.[xf?.borderId], ...(native?.shrink?.[i] ? { shrink: true } : null), ...(native?.protection?.[i]?.unlocked ? { locked: false } : null), ...(native?.protection?.[i]?.hidden ? { formulaHidden: true } : null),
      ...(completeDefault ? numFmtToStyle(native?.formatCodes?.[xf?.numFmtId]) : null),
      // The named cell style the format is linked to, so the cell follows the style when it is modified.
      ...(native?.cellXfStyleNames?.[i] ? { cellStyle: native.cellXfStyleNames[i] } : null) };
    return Object.keys(s).length ? s : null;
  });
  if (completeDefault && byXf[0]) {
    const defaults = byXf[0];
    // Complete native XFs must clear inherited default properties absent from
    // their records: No fill, false font flags/wrap, General, automatic align,
    // and empty borders are overrides, rather than sparse patches.
    for (let i = 1; i < byXf.length; i++) byXf[i] = { ...Object.fromEntries(Object.keys(defaults)
      .filter(key => !Object.hasOwn(byXf[i] || {}, key)).map(key => [key, key === 'code' ? '' : null])), ...byXf[i] };
  }
  return byXf.some(Boolean) ? byXf : null;
}

/**
 * Each stored cell's format index, including the implicit XF zero when s is absent.
 * Only sheetData owns these records; extension payloads and comments do not.
 */
function cellFormatIndices(xml) {
  const out = new Map();
  const data = xml.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?sheetData\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheetData>/)?.[1] || '';
  const re = /<(?:\w+:)?c\b([^>]*)>/g;
  for (let m; (m = re.exec(data));) {
    const s = /\ss="(\d+)"/.exec(m[1]);
    const r = /\sr="([A-Z]+\d+)"/.exec(m[1]);
    if (r) out.set(r[1], s ? Number(s[1]) : 0);
  }
  return out;
}

/** The value a file cached for a cell, as the cell would hold it: a number, text, boolean, or error. */
function cachedValue(X, src) {
  if (src.t === 'z' || src.v == null) return null; // a formula the file cached no value for
  if (src.t === 'n') return typeof src.v !== 'number' ? null : Number.isFinite(src.v) ? src.v : err('#NUM!');
  if (src.t === 'b') return !!src.v;
  if (src.t === 'e') {
    const code = X.utils.format_cell(src);
    return err(typeof code === 'string' && code.startsWith('#') ? code : '#VALUE!');
  }
  return src.v != null && typeof src.v !== 'object' ? String(src.v) : null;
}

/** The data tables a worksheet part holds: each one's results range and its TABLE formula. */
function readDataTables(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(?:\w+:)?f\b([^>]*\bt="dataTable"[^>]*)\/?>/g)) {
    const attrs = m[1];
    const range = parseRange(xmlAttr(`<f ${attrs}>`, 'ref') || '');
    if (!range || range.r2 > MAX_ROW || range.c2 > MAX_COL) continue;
    const input = (name) => { const v = (xmlAttr(`<f ${attrs}>`, name) || '').replace(/\$/g, '').toUpperCase(); return /^[A-Z]{1,3}[1-9]\d*$/.test(v) ? v : ''; };
    const yes = (name) => ['1', 'true'].includes(xmlAttr(`<f ${attrs}>`, name) || '');
    const r1 = input('r1'), r2 = input('r2');
    if (!r1) continue;
    const formula = yes('dt2D') ? (r2 ? `TABLE(${r1},${r2})` : null) : yes('dtr') ? `TABLE(${r1},)` : `TABLE(,${r1})`;
    if (formula) out.push({ range, formula });
  }
  return out;
}

function importSheet(X, ws, name, meta, date1904 = false, definedNames, fileFormat = (src) => src.z, partXml = null, fonts = null, nativeStyles = null, baseFont = null, themes = null, lineFormats = null, pivotPriorities = false, externalWorkbooks = null, externalLinks = null) {
  // Saved layout sizes are optional, untrusted hints. Actual stored cells
  // still determine the minimum dimensions when a hint is malformed.
  const dimension = (value, limit) => Number.isInteger(value) && value > 0 && value <= limit ? value : 0;
  // Private settings retain app-specific details. Native tables, filters and
  // formulas are reconciled below so external edits are not overwritten.
  const own = meta?.sheets?.[name];
  const nativePart = partXml ? sheetPartState(partXml) : null;
  const part = !own ? nativePart : null;
  const lines = !own ? readXlsxLineStyles(partXml, lineFormats) : null;
  // Native format indexes let reconciliation distinguish edits from inherited fields.
  const formatOf = (fonts || lineFormats) && partXml ? cellFormatIndices(partXml) : null;
  const ownResets = own?.nativeStyles ? readStyleResets(own.styleResets) : [];
  const colStyles = metaLineStyles(own?.colStyles, MAX_COL), rowStyles = metaLineStyles(own?.rowStyles, MAX_ROW);
  // XF zero governs unallocated cells, independently of named Normal. Only
  // sheets using the saved global default follow native edits to that XF;
  // differing sheet defaults were exported as explicit column formats.
  const nativeVAlign = lineFormats?.[0]?.valign;
  const defaultVAlign = own ? (own.nativeDefaultVAlign && (own.defaultVAlign || 'middle') === own.nativeDefaultVAlign
    && nativeVAlign && nativeVAlign !== own.nativeDefaultVAlign ? nativeVAlign : own.defaultVAlign)
    : partXml ? nativeVAlign || 'bottom' : undefined;
  const normal = own ? { ...normalFontStyle(normalizeNormalFont(meta.normalFont)), ...meta.nativeDefaultCellFormat?.style,
    ...(defaultVAlign ? { valign: defaultVAlign } : {}) } : null;
  const reconcileStyle = own?.nativeStyles && partXml && lineFormats
    ? createXlsxStyleReconciler({ cols: colStyles, rows: rowStyles, resets: ownResets,
      rowBase: metaLineStyles({ 0: own.nativeRowStyleBase }, 0)[0],
      normalFont: reconciledNormalFont(meta, nativeStyles?.normalFont), xml: partXml, formats: lineFormats,
      defaultStyle: nativeStyles?.nativeDefaultCellFormat?.style,
      fillBindingsKnown: !!meta.nativeFillBaseline }) : null;
  const privateStyleAt = (r, c, spill = false) => {
    const key = cellKey(r, c), saved = own?.styles?.[key], numbers = own?.inheritedNumberFormats?.[key];
    const originalNumbers = numbers && typeof numbers === 'object' && !Array.isArray(numbers);
    const style = sanitizeMetaStyle({
      ...(originalNumbers ? Object.fromEntries(NUMBER_FORMAT_KEYS.filter(k => Object.hasOwn(numbers, k)).map(k => [k, numbers[k]])) : {}),
      ...(saved && typeof saved === 'object' && !Array.isArray(saved)
        ? Object.fromEntries(RECONCILED_STYLE_KEYS.filter(k => Object.hasOwn(saved, k)).map(k => [k, saved[k]])) : {}),
    });
    // Older exports kept standalone number formats only in the native XF.
    // Inherited formats (including an empty original patch) and dynamic spill
    // destinations have an original sparse representation to compare instead.
    return { style: Object.keys(style).length ? style : undefined,
      nativeNumbers: !originalNumbers && !spill && !NUMBER_FORMAT_KEYS.some(k => Object.hasOwn(style, k)) };
  };
  const spillNumberStyles = new Map();
  const spillNumberStyle = ref => {
    if (spillNumberStyles.has(ref)) return spillNumberStyles.get(ref);
    const anchor = parseRange(ref);
    if (!anchor) return null;
    const { r1: r, c1: c } = anchor, original = privateStyleAt(r, c);
    const resolved = reconcileStyle(r, c, original.style, formatOf?.get(cellName(r, c)) ?? 0, original);
    const effective = { ...colStyles[c], ...rowStyles[r], ...styleResetAt(ownResets, r, c), ...resolved };
    const numbers = Object.fromEntries(NUMBER_FORMAT_KEYS.filter(k => Object.hasOwn(effective, k)).map(k => [k, effective[k]]));
    spillNumberStyles.set(ref, numbers);
    return numbers;
  };
  const arrayKinds = new Map();
  const dynamicArray = (ref) => {
    if (!ref) return false;
    if (arrayKinds.has(ref)) return arrayKinds.get(ref);
    const range = parseRange(ref);
    const anchor = range && ws[cellName(range.r1, range.c1)];
    const saved = range && !partXml && own?.odsDynamicArrays?.[cellKey(range.r1, range.c1)];
    const dynamic = !!anchor?.f && (anchor.D === true || !!saved
      && saved.ref === ref && typeof saved.f === 'string'
      && fromFileFormula(saved.f, definedNames) === fromFileFormula(anchor.f, definedNames));
    arrayKinds.set(ref, dynamic);
    return dynamic;
  };
  const cells = {};
  const notes = {};
  // Formulas reaching into another workbook, parked with the value the file cached for their cell.
  const external = new Map();
  const deferredArrays = new Map();
  let usedR = -1;
  let usedC = -1;
  for (const { r, c, addr, cell: src } of storedCells(X, ws)) {
    if (!src) continue;
    // Inside an array formula's block only the top-left cell holds the
    // formula; keep the other cells' formats, but recompute their values.
    const spillResult = src.F && !src.f;
    const deferred = spillResult && deferredArrays.get(src.F);
    if (deferred) deferred.result.cells[cellKey(r - deferred.r, c - deferred.c)] = cachedValue(X, src);
    // Our exports bake inherited formats into XLSX for other readers, while
    // the sidecar holds only the destination's own overrides.
    const inheritedSpill = spillResult && own?.spillFormats === true && dynamicArray(src.F);
    const fromZ = inheritedSpill ? null : numFmtToStyle(fileFormat(src));
    // A hyperlink/comment can make the reader synthesize a blank cell absent
    // from sheetData. It still inherits row/column formats; only a stored cell
    // without s has the complete XF-zero format.
    const fontIndex = formatOf ? formatOf.get(addr) : 0;
    let font = formatOf ? fonts?.[fontIndex] || null : null;
    // Native fill resources already carry their display paint. The vendor's
    // resolved RGB fallback must not replace that reference on blank XF-zero
    // cells merely because they lack a value or a nonzero style index.
    const bg = own?.nativeStyles || font?.nativeFill ? null : fileFill(src);
    if (reconcileStyle) {
      // Reconcile native components before private styles are merged below. Other
      // native style components retain the existing metadata merge behavior.
      const reset = styleResetAt(ownResets, r, c);
      const saved = own.styles?.[cellKey(r, c)];
      const expected = k => saved && Object.hasOwn(saved, k) ? saved[k]
        : reset && Object.hasOwn(reset, k) ? reset[k] ?? normal?.[k] ?? null
          : rowStyles[r] && Object.hasOwn(rowStyles[r], k) ? rowStyles[r][k]
            : colStyles[c] && Object.hasOwn(colStyles[c], k) ? colStyles[c][k] : normal?.[k];
      const extra = Object.fromEntries(Object.entries(font || {}).filter(([k, v]) => !RECONCILED_STYLE_KEYS.includes(k)
        && JSON.stringify(v) !== JSON.stringify(expected(k) ?? (k === 'valign' ? 'middle' : undefined))));
      const original = privateStyleAt(r, c, inheritedSpill);
      const resolved = reconcileStyle(r, c, original.style, fontIndex,
        { nativeNumbers: original.nativeNumbers, numberBase: inheritedSpill ? spillNumberStyle(src.F) : null });
      font = { ...extra, ...resolved };
      if (!Object.keys(font).length) font = null;
    }
    if (Array.isArray(src.c) && src.c.length) {
      const text = src.c.map((cm) => cm?.t || '').filter(Boolean).join('\n');
      if (text.trim()) notes[cellKey(r, c)] = text;
    }
    if (spillResult && !fromZ && !bg && !font) continue;
    const cell = { v: null, f: null };
    let asText = false;
    if (spillResult) {
      // A style-only cell does not block the formula from spilling again.
    } else if (src.f) {
      const formula = String(src.f).replace(/^=/, '');
      // Excel refuses a formula past 8192 characters, so a longer one comes
      // from another producer or by design. It is kept as text the book can
      // show, search, and save, rather than parsed to any depth.
      if (formula.length > MAX_FORMULA) { cell.v = `=${formula}`.slice(0, MAX_TEXT); asText = true; }
      else {
        const f = fromFileFormula(formula, definedNames);
        // Without supporting cells, retain the native formula's last calculated
        // result separately. Missing link parts still use the legacy sidecar:
        // writing those formulas natively would make Excel repair the file.
        const links = externalLinks?.(f, name, r, c);
        if ((externalReference(f) || links?.external) && !(links?.cached ?? externalFormulaHasCaches(f, externalWorkbooks))) {
          const value = cachedValue(X, src);
          if (links?.linked ?? externalFormulaHasLinks(f, externalWorkbooks)) {
            cell.f = f;
            cell.externalResult = { formula: f, value };
            const range = src.F && parseRange(src.F);
            if (range && range.r1 === r && range.c1 === c && range.r2 <= MAX_ROW && range.c2 <= MAX_COL) {
              const size = { rows: range.r2 - r + 1, cols: range.c2 - c + 1 };
              cell.externalResult.array = { ...size, cells: {} };
              usedR = Math.max(usedR, range.r2); usedC = Math.max(usedC, range.c2);
              deferredArrays.set(src.F, { r, c, result: cell.externalResult.array });
              if (!dynamicArray(src.F)) cell.array = size;
            }
          } else {
            cell.v = value;
            external.set(cellKey(r, c), { f, v: value });
          }
        }
        else {
          cell.f = !own && partXml && !src.F && !src.D ? xlsxScalarFormula(f) : f;
          if (src.F && !dynamicArray(src.F)) {
            const range = parseRange(src.F);
            if (range && range.r1 === r && range.c1 === c && range.r2 <= MAX_ROW && range.c2 <= MAX_COL) {
              cell.array = { rows: range.r2 - r + 1, cols: range.c2 - c + 1 };
            }
          }
        }
      }
    } else if (src.t === 'n') {
      // A number cell whose value is no number (<v>abc</v>) or lies past the double's range
      // (<v>1e999</v>) is #NUM!, as no cell can hold NaN or an infinity and no file format
      // can write one back; left as read, SUM over it gave NaN and the .ods writer spelled
      // it as the formula =#NUM! or =1/0.
      cell.v = typeof src.v === 'number' && !Number.isFinite(src.v) ? err('#NUM!') : src.v;
      // Stored calendar dates use the source workbook's epoch. Normalize
      // those inputs to our 1900 serials so dependent formulas recalculate
      // correctly. Only the format section selected by the source value
      // determines its meaning; unused date or elapsed sections must not
      // change ordinary numbers, times, or the conversion of calendar dates.
      if (date1904 && Number.isFinite(cell.v)) {
        const kind = dateTimeKind(fromZ, cell.v);
        if (kind === 'date' || kind === 'datetime') cell.v += 1462;
      }
    }
    else if (src.t === 'b') cell.v = !!src.v;
    else if (src.t === 'd') {
      // Only reached if a reader hands us Date objects; convert to serial.
      const d = src.v instanceof Date ? src.v : new Date(src.v);
      cell.v = ymdToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate());
      cell.s = { fmt: 'date' };
    } else if (src.t === 'e') {
      const code = X.utils.format_cell(src);
      cell.v = err(typeof code === 'string' && code.startsWith('#') ? code : '#VALUE!');
    }
    // An explicit empty string is still text: ISBLANK, COUNTA and TEXT
    // distinguish it from a missing/stub cell. Preserve its type on import.
    else if (src.v != null && (src.v !== '' || ['s', 'str', 'inlineStr'].includes(src.t))) cell.v = String(src.v);
    if (cell.f == null && typeof cell.v === 'string') {
      const rich = readXlsxRichText(src.r, cell.v, nativeStyles?.colors, baseFont);
      if (rich) cell.richText = rich;
    }
    if (fromZ && !reconcileStyle) cell.s = { ...(cell.s || {}), ...fromZ };
    if (bg) cell.s = { ...(cell.s || {}), bg };
    // Normal text formatting alone must not create a cell for a missing
    // shared string, an uncached external formula, or a blank spill result.
    if (font && (reconcileStyle || cell.v != null || cell.f != null || fontIndex || src.l?.Target || font.nativeFill)) cell.s = { ...(cell.s || {}), ...font };
    // An imported hyperlink keeps the workbook's text styling rather than
    // acquiring the grid's default underlined link appearance.
    if (!own && font && (src.l || /^HYPERLINK\s*\(/i.test(src.f || ''))) cell.s.underline = !!font.underline;
    if (asText) cell.s = { ...(cell.s || {}), fmt: 'text' };
    if (fontIndex != null && lines && (lines.cols[c] || lines.rows[r])) {
      // Even a stored cell without s has XF 0. It must not acquire the
      // formats reserved for unallocated cells in its row/column.
      cell.s = replaceInheritedStyle({ ...lineFormats[fontIndex], ...cell.s }, { ...lines.cols[c], ...lines.rows[r] });
    }
    if (cell.v == null && cell.f == null && !src.l?.Target && !cell.s) continue;
    // Native hyperlinks annotate a value; they are not formulas. Keeping the
    // annotation separate preserves rich strings, ISFORMULA, blank/error
    // values and formulas with attached links. A HYPERLINK formula owns its
    // computed target; its exported cached relationship must not freeze it.
    if (src.l?.Target && !/^HYPERLINK\s*\(/i.test(cell.f || '')) cell.hyperlink = String(src.l.Target);
    cells[cellKey(r, c)] = cell;
    if (r > usedR) usedR = r;
    if (c > usedC) usedC = c;
  }
  // What-If data tables: Excel keeps {=TABLE(row input, column input)} as a dataTable formula naming its input cells.
  for (const { range, formula } of partXml ? readDataTables(partXml) : []) {
    const anchor = cellKey(range.r1, range.c1);
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      const key = cellKey(r, c), cell = cells[key];
      if (key === anchor) cells[key] = { ...(cell || {}), v: null, f: formula, array: { rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1 } };
      else if (cell) { cell.v = null; cell.f = null; }
    }
    usedR = Math.max(usedR, range.r2); usedC = Math.max(usedC, range.c2);
  }
  const styles = meta?.sheets?.[name]?.styles || {};
  for (const [key, s] of Object.entries(styles)) {
    // Metadata is untrusted: inherited keys such as __proto__ are not cells.
    if (!/^\d+,\d+$/.test(key) || !s || typeof s !== 'object' || Array.isArray(s)) continue;
    const { r, c } = parseKey(key);
    // Style-only cells also reach the exporter; an unbounded column can
    // make A1 encoding loop forever, even with no value in that cell.
    if (!Number.isInteger(r) || r < 0 || r > MAX_ROW || !Number.isInteger(c) || c < 0 || c > MAX_COL) continue;
    const cell = cells[key] || (cells[key] = { v: null, f: null });
    const own = sanitizeMetaStyle(s);
    // These fields were already reconciled with the complete native components.
    if (reconcileStyle && formatOf?.has(cellName(r, c))) for (const k of RECONCILED_STYLE_KEYS) delete own[k];
    // A number format the sidecar names replaces the file's reading of the cell's code.
    if (Object.hasOwn(own, 'fmt') && cell.s) for (const field of NUMBER_FORMAT_KEYS) delete cell.s[field];
    cell.s = { ...(cell.s || {}), ...own };
  }
  for (const [key, s] of Object.entries(own?.inheritedNumberFormats || {})) {
    if (!/^\d+,\d+$/.test(key) || !Object.hasOwn(cells, key) || !s || typeof s !== 'object' || Array.isArray(s)) continue;
    const { r, c } = parseKey(key);
    if (reconcileStyle && formatOf?.has(cellName(r, c))) continue;
    const cell = cells[key];
    const original = sanitizeMetaStyle(Object.fromEntries(NUMBER_FORMAT_KEYS.filter((k) => Object.hasOwn(s, k)).map((k) => [k, s[k]])));
    const style = { ...cell.s };
    for (const field of NUMBER_FORMAT_KEYS) delete style[field];
    Object.assign(style, original);
    cell.s = Object.keys(style).length ? style : undefined;
  }
  const colWidths = {};
  const formatPr = partXml?.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?sheetFormatPr\b[^>]*>/)?.[0];
  const nativePixels = col => xlsxColumnPixels(col, baseFont) ?? (Number.isFinite(col?.width)
    ? Math.floor((col.width + Math.floor(128 / xlsxLayoutDigitWidth(baseFont)) / 256) * xlsxLayoutDigitWidth(baseFont)) : null);
  const declaredWidth = Number(xlsxAttr(formatPr, 'defaultColWidth'));
  const base = Number(xlsxAttr(formatPr, 'baseColWidth'));
  // A present sheetFormatPr has the schema's eight-character base default.
  // Excel initializes an entirely absent element with a ten-character base.
  // Both are font-relative widths, not the app's new-workbook pixel default.
  const baseWidth = Number.isFinite(base) && base > 0 ? base : formatPr ? 8 : 10;
  const nativeWidth = Number.isFinite(declaredWidth) && declaredWidth > 0 ? nativePixels({ width: declaredWidth })
    : (nativePixels({ width: baseWidth }) ?? Math.round(baseWidth * 7)) + 5;
  const defaultColWidth = own ? own.defaultColWidth ?? DEFAULT_COL_WIDTH
    : partXml ? Math.max(1, Math.min(MAX_STORED_COL_WIDTH, nativeWidth || 64)) : DEFAULT_COL_WIDTH;
  // Hidden indices later bound export loops. Reject malformed collections,
  // fractions, and coordinates outside the file format's supported grid.
  const hiddenLines = (list, max) => new Set((Array.isArray(list) ? list : [])
    .filter((index) => Number.isInteger(index) && index >= 0 && index <= max));
  const nativeWidths = partXml && normalizeNormalFont(baseFont) && (!own || meta.normalFont) ? {
    font: normalizeNormalFont(baseFont), cols: {}, default: { pixels: defaultColWidth,
      // If export needs to add sheetFormatPr, retain the absent-element width
      // basis explicitly so adding it does not select the schema default.
      ...(!formatPr ? { base: 10 } : {}),
      ...(xlsxAttr(formatPr, 'defaultColWidth') != null && Number.isFinite(declaredWidth) && declaredWidth >= 0 ? { width: declaredWidth } : {}),
      ...(xlsxAttr(formatPr, 'baseColWidth') != null && Number.isInteger(base) && base >= 0 ? { base } : {}),
    },
  } : null;
  const hiddenCols = hiddenLines(meta?.sheets?.[name]?.hidden?.cols, MAX_COL);
  const hiddenRows = hiddenLines(meta?.sheets?.[name]?.hidden?.rows, MAX_ROW);
  (ws?.['!cols'] || []).forEach((col, i) => {
    if (!col) return;
    if (col.hidden) hiddenCols.add(i);
    const px = ((!own || own.nativeStyles) && partXml ? nativePixels(col) : null) ?? col.wpx ?? (col.wch != null ? Math.round(col.wch * 7 + 5) : col.width != null ? Math.round(col.width * 7 + 5) : null);
    // Even a one-pixel override affects cell and drawing boundaries.
    if (px && px !== defaultColWidth) colWidths[i] = Math.max(1, Math.min(MAX_STORED_COL_WIDTH, px));
    if (nativeWidths && Number.isFinite(col.width) && col.width >= 0 && col.width <= 255) nativeWidths.cols[i] = { width: col.width, pixels: colWidths[i] ?? defaultColWidth };
  });
  // Native tables describe the current document, including external edits.
  // Private records only restore details whose native representation is unchanged.
  const native = nativeTables(X, ws, definedNames, nativeStyles?.tables);
  const tables = reconcileTables(native, own, !!partXml, definedNames, externalWorkbooks, nativeStyles && { colorPalette: nativeStyles.colorPalette, themeInfo: nativeStyles.themeInfo });
  // Index scalar-column formulas once. Scanning every stored cell for every
  // table made native reconciliation quadratic in workbooks with many tables.
  const scalarColumns = new Set(native.flatMap(t => [...t.scalarColumns]));
  const byColumn = new Map(), scalarFormulas = new Map();
  if (scalarColumns.size) for (const [key, cell] of Object.entries(cells)) {
    if (!cell.f) continue;
    const { r, c } = parseKey(key);
    if (!scalarColumns.has(c)) continue;
    const source = ws[X.utils.encode_cell({ r, c })];
    if (source?.F || source?.D) continue; // Explicit array semantics win.
    if (!byColumn.has(c)) byColumn.set(c, []);
    byColumn.get(c).push({ r, cell });
  }
  for (const entries of byColumn.values()) entries.sort((a, b) => a.r - b.r);
  for (const table of native) for (const col of table.scalarColumns) {
    const entries = byColumn.get(col) || [];
    let lo = 0, hi = entries.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (entries[mid].r < table.range.r1 + (table.headerRow === false ? 0 : 1)) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < entries.length && entries[i].r <= table.range.r2 - Number(table.totalsRow); i++) {
      const { cell } = entries[i];
      if (!scalarFormulas.has(cell.f)) scalarFormulas.set(cell.f, intersectTableFormula(cell.f));
      cell.f = scalarFormulas.get(cell.f);
    }
  }
  const savedFilters = sheetFilters(own).filter(f => validMetaRange(f.range));
  const currentFilters = [fileFilter(X, ws?.['!autofilter']),
    ...(ws?.['!filters'] || []).map(f => fileFilter(X, f)),
    ...native.filter(t => t.filter).map(t => fileFilter(X, null, t.filter))].filter(Boolean);
  const savedOwners = new Map((Array.isArray(own?.tables) ? own.tables : []).filter(t => typeof t?.name === 'string' && validMetaRange(t.range))
    .map(t => [filterRangeKey({ range: { ...t.range, r2: t.range.r2 - Number(!!t.totalsRow) } }), t]));
  const currentByRange = new Map(currentFilters.map(f => [filterRangeKey(f), f]));
  const nativeByName = new Map(native.map(t => [t.name.toLowerCase(), t]));
  const currentForSaved = f => {
    const owner = savedOwners.get(filterRangeKey(f));
    if (owner) {
      const live = nativeByName.get(owner.name.toLowerCase());
      return live?.filter ? currentByRange.get(filterRangeKey(fileFilter(X, null, live.filter))) : null;
    }
    return currentByRange.get(filterRangeKey(f));
  };
  const savedForCurrent = new Map(savedFilters.map(f => [currentForSaved(f), f]));
  const expectedByRange = new Map((Array.isArray(own?.nativeFilters) ? own.nativeFilters : []).map(f => [filterRangeKey(f), f]));
  const filtersFromFile = [];
  const legacyOnly = own?.nativeFilter === undefined && own?.nativeFilters === undefined && own?.nativeTables !== true && !currentFilters.length && !native.length;
  let filters;
  if (!partXml || legacyOnly) filters = savedFilters.length ? savedFilters : currentFilters;
  else filters = currentFilters.map(current => {
    const saved = savedForCurrent.get(current);
    let expected = saved && (Array.isArray(own?.nativeFilters) ? expectedByRange.get(filterRangeKey(saved))
      : saved === own?.filter ? own?.nativeFilter : undefined);
    if (expected === undefined && validMetaRange(saved?.range)) {
      const xml = writeXlsxFilter({ ...saved, hiddenButtons: Array.isArray(saved.hiddenButtons) ? saved.hiddenButtons : [] });
      expected = { range: saved.range, criteria: readXlsxFilter(xml, saved.range) || {}, ...readXlsxFilterButtons(xml, saved.range) };
    }
    if (saved && JSON.stringify(expected) === JSON.stringify(current)) return saved;
    filtersFromFile.push(current.range);
    return current;
  });
  if (!savedFilters.length && !partXml) filtersFromFile.push(...currentFilters.map(f => f.range));
  const selected = own?.filter && currentForSaved(own.filter);
  const filter = filters.find(f => sameFilterRange(f, selected || own?.filter)) || filters[0] || null;
  const otherFilters = filters.filter(f => f !== filter);
  // The rows a filter hides are hidden rows in the file, the only spelling an .xlsx has for
  // them, while an .ods gives them their own visibility. A known filter owns hides inside
  // its data rows, so clearing it can reveal them. XLSX retains the saved view separately
  // from its predicates: edited data and adjacent tables can legitimately leave different
  // rows visible until Reapply. Unknown conditions still retain their rows as manual hides.
  // The private baseline distinguishes manual/filter hides while native visibility is unchanged.
  const filtered = filters.filter(f => Object.keys(f.criteria || {}).length).map(f => f.range);
  let fileFilterHidden = partXml && currentFilters.length ? [] : undefined;
  const fileHiddenRows = [];
  const rowHeights = {};
  const rowHeightModes = partXml ? readXlsxRowHeightModes(partXml) : own?.rowHeightModes;
  if (partXml && own?.nativeStyles) {
    // Legacy/app-default rows export as fixed. Preserve their unspecified
    // private mode while the native flag still matches that projection;
    // an external change to automatic sizing must remain authoritative.
    for (const [r, mode] of Object.entries(rowHeightModes)) {
      if (mode === 'fixed' && !Object.hasOwn(own.rowHeightModes || {}, r)) delete rowHeightModes[r];
    }
  }
  const nativeHeight = !formatPr && partXml ? XLSX_IMPLICIT_ROW_HEIGHT : Number(xlsxAttr(formatPr, 'defaultRowHeight')) * 4 / 3;
  const defaultRowHeight = own && !own.nativeStyles ? own.defaultRowHeight ?? DEFAULT_ROW_HEIGHT
    : Number.isFinite(nativeHeight) && nativeHeight > 0 ? Math.max(1, Math.min(MAX_STORED_ROW_HEIGHT, nativeHeight)) : DEFAULT_ROW_HEIGHT;
  const customHeight = xlsxAttr(formatPr, 'customHeight');
  const nativeDefaultHeight = normalizeNativeDefaultHeight(partXml
    ? !formatPr ? { pixels: nativeHeight, mode: 'implicit' }
      : customHeight == null || ['0', 'false'].includes(customHeight) ? { pixels: nativeHeight, mode: 'auto' } : null
    : own?.nativeDefaultHeight);
  (ws?.['!rows'] || []).forEach((row, i) => {
    if (!row) return;
    if (row.hidden || row.filtered) {
      fileHiddenRows.push(i);
      if (filtered.some(range => i > range.r1 && i <= range.r2)) fileFilterHidden?.push(i);
      else hiddenRows.add(i);
    }
    // The vendor's hpx equals hpt for XLSX. Excel heights are points, while the grid uses CSS pixels.
    // Older app exports use that vendor convention too; their sidecar identifies those dimensions.
    const px = (!own || own.nativeStyles) && partXml && row.hpt != null ? row.hpt * 4 / 3 : row.hpx ?? (row.hpt != null ? row.hpt * 4 / 3 : null);
    if (px && Math.abs(px - defaultRowHeight) > .001) rowHeights[i] = Math.max(1, Math.min(MAX_STORED_ROW_HEIGHT, px));
  });
  const savedView = own?.nativeFilterView;
  if (fileFilterHidden && Array.isArray(savedView?.hidden) && Array.isArray(savedView?.filtered)
      && JSON.stringify(savedView.hidden) === JSON.stringify(fileHiddenRows)) {
    // The native visibility is unchanged: retain the exact distinction
    // between manual and filter hides, which XLSX stores as one row flag.
    fileFilterHidden = savedView.filtered.filter(r => Number.isInteger(r) && r >= 0 && r <= MAX_ROW
      && filtered.some(range => r > range.r1 && r <= range.r2));
  }
  // A formula this app could not read went into the file as its text, so that other programs open
  // the file without a repair; where the cell still holds that text, the formula comes back.
  for (const [key, f] of Object.entries(meta?.sheets?.[name]?.unparsed || {})) {
    const cell = Object.hasOwn(cells, key) ? cells[key] : null;
    if (cell && cell.f == null && typeof f === 'string' && cell.v === `=${f}`) { cell.f = f; cell.v = null; }
  }
  // The formulas of another program's file that reached into another workbook, parked at the
  // last save beside the cells still holding the values that file cached.
  for (const [key, f] of Object.entries(meta?.sheets?.[name]?.external || {})) {
    const cell = /^\d+,\d+$/.test(key) && Object.hasOwn(cells, key) ? cells[key] : null;
    if (cell && cell.f == null && cell.v != null && typeof f === 'string') {
      const { r, c } = parseKey(key);
      if (externalReference(f) || externalLinks?.(f, name, r, c).external) external.set(key, { f, v: cell.v });
      else {
        // Earlier versions parked [0]!Name as an external cached result.
        // Recover that live local formula when reopening an unchanged cell.
        try {
          if (tokenize(f).some(t => t.type === 'name' && isWorkbookNameScope(t.sheet))) {
            parseFormula(f); cell.f = f; cell.v = null;
          }
        } catch { external.set(key, { f, v: cell.v }); }
      }
    }
  }
  const frozen = partXml ? nativePart?.frozen : own?.frozen;
  const merges = fileMerges((ws?.['!merges'] || []).filter((m) => m?.s && m?.e).map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c })));
  return {
    name,
    merges,
    notes,
    ignoredErrors: readXlsxIgnoredErrors(partXml),
    rules: readXlsxConditionalFormats(partXml, nativeStyles, nativeStyles?.colors || themes, definedNames, { priorities: pivotPriorities }),
    protectedRanges: meta?.sheets?.[name]?.protectedRanges || [],
    scenarios: parseScenariosXml(partXml),
    validations: meta?.sheets?.[name]?.validations || (ws?.['!validations'] || []).map(({ _odsName, ...rule }) => rule),
    color: own?.color || part?.color || (!own && partXml ? xlsxColor(partXml.match(/<tabColor\b[^>]*>/)?.[0], nativeStyles?.colors || themes) : null),
    protected: own ? !!own.protected : !!part?.protected,
    groups: own ? own.groups || null : fileGroups(ws, filtered),
    outlineSettings: readXlsxOutlineSettings(partXml),
    gridlines: own ? own.gridlines !== false : part?.gridlines !== false,
    headers: nativePart?.headers ?? own?.headers ?? true,
    rightToLeft: nativePart?.rightToLeft ?? own?.rightToLeft ?? false,
    defaultVAlign,
    viewZoom: own?.viewZoom ?? part?.viewZoom,
    viewMode: partXml ? nativePart?.viewMode : own?.viewMode,
    showPageBreaks: own?.showPageBreaks === true,
    sheetViews: own?.sheetViews,
    viewSelection: partXml ? nativePart?.viewSelection : own?.viewSelection,
    viewOrigin: partXml ? nativePart?.viewOrigin : own?.viewOrigin,
    frozenOrigin: partXml ? nativePart?.frozenOrigin : own?.frozenOrigin,
    split: partXml ? nativePart?.split : own?.split,
    ...(own?.zoomToFit != null || part?.zoomToFit != null ? { zoomToFit: own?.zoomToFit ?? part?.zoomToFit } : {}),
    zeros: meta?.sheets?.[name]?.zeros !== false,
    sparklineGroups: readNativeSparklineGroups(partXml),
    charts: meta?.sheets?.[name]?.charts || [],
    tables,
    filter, otherFilters, ...(fileFilterHidden ? { filterHidden: fileFilterHidden } : {}),
    // Read from the file rather than from this app's own record: its value lists still name values
    // the way the file spells them, and adoptFileFilters translates them once the book can format.
    filtersFromFile,
    frozenRows: frozen?.rows || 0,
    frozenCols: frozen?.cols || 0,
    hiddenRows: [...hiddenRows],
    hiddenCols: [...hiddenCols],
    rows: Math.max(dimension(meta?.sheets?.[name]?.rows, MAX_ROW + 1), usedR + 21, 100),
    cols: Math.max(dimension(meta?.sheets?.[name]?.cols, MAX_COL + 1), usedC + 6, 26),
    colWidths,
    rowHeights,
    rowHeightModes,
    defaultColWidth,
    defaultRowHeight,
    ...(nativeDefaultHeight ? { nativeDefaultHeight } : {}),
    ...(nativeWidths ? { nativeWidths } : {}),
    // The format a whole column or row carries; the cells in it store none of their own.
    colStyles: lines?.cols || colStyles,
    rowStyles: lines?.rows || rowStyles,
    styleResets: meta?.sheets?.[name]?.styleResets,
    cells,
    ...(external.size ? { externalFormulas: external } : {}),
  };
}

/** CSV / TSV / TXT go through the app's own parser so "7,5" stays text. */
/**
 * The separator a delimited text file uses: tab, comma, semicolon, or pipe,
 * whichever splits the first lines into the same number of fields most often.
 */
export function detectDelimiter(src, filename = '') {
  if (/\.tsv$/i.test(filename)) return '\t';
  // Sample complete records: a newline inside quotes is part of a field,
  // whose punctuation must not count as a competing separator.
  const lines = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < src.length && lines.length < 25; i++) {
    const ch = src[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      const line = src.slice(start, i);
      if (line.trim()) lines.push(line);
      start = i + 1;
    }
  }
  if (lines.length < 25 && src.slice(start).trim()) lines.push(src.slice(start));
  if (!lines.length) return ',';
  // Where the decimal mark is a comma, CSV is written with semicolons (this app does so too),
  // and a file of plain decimals scores the same for both. The separator under which the larger
  // share of fields reads as a value wins the tie (1,5;2,5 holds two decimal-comma numbers under
  // one and a "5;2" under the other, whatever the reader's own decimal mark), then the locale's own.
  const preferred = localeInfo(getLocale()).decimal === ',' ? ';' : ',';
  const valueLike = (field) => {
    const t = field.trim();
    if (!t) return true;
    const { v, f } = parseInput(t);
    return f != null || typeof v !== 'string' || /^[-+]?\d+(?:[.,]\d+)?$/.test(t);
  };
  const readable = new Map();
  const readableShare = (d) => {
    if (!readable.has(d)) {
      const fields = lines.flatMap((line) => parseDelimited(line, d).flat());
      readable.set(d, fields.length ? fields.filter(valueLike).length / fields.length : 0);
    }
    return readable.get(d);
  };
  let best = ',';
  let bestScore = -1;
  for (const d of ['\t', ',', ';', '|']) {
    // Count separators outside quotes on each line; a good separator appears on every line, the same number of times.
    const counts = lines.map((line) => {
      let n = 0;
      let quoted = false;
      for (const ch of line) { if (ch === '"') quoted = !quoted; else if (!quoted && ch === d) n++; }
      return n;
    });
    const nonZero = counts.filter((n) => n > 0).length;
    if (!nonZero) continue;
    const mode = counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    const consistent = counts.filter((n) => n === mode).length;
    const score = nonZero * 2 + consistent + (mode > 0 ? 1 : 0);
    const tie = score === bestScore && (readableShare(d) > readableShare(best) || (readableShare(d) === readableShare(best) && d === preferred));
    if (score > bestScore || tie) { bestScore = score; best = d; }
  }
  return best;
}

// A first line of "sep=;" names the separator of the lines after it, as Excel reads (and some
// programs write) a CSV whose separator is not the locale's; the line is not data.
const SEP_DIRECTIVE = /^sep=(.)(?:\r\n|\r|\n|$)/i;
// A field reads as typed input does, the seven error spellings Excel and Sheets read from delimited
// text (where this app's own CSV export writes an error cell as its code) included.
function textFieldValue(text) {
  // In the editor a leading apostrophe marks text; in a file it is part of the field, as Excel
  // and Sheets read it, except before text shaped like a formula, where it is the guard mark an
  // export put there so the text would not run when the file is opened — this app's own export,
  // Excel's or another tool's. That text comes back as it was, mirroring formulaShaped above, so
  // that a CSV round trip neither drops the guard nor adds an apostrophe to the data.
  if (text.startsWith("'")) {
    const rest = text.slice(1);
    return { v: formulaShapedText(rest) ? rest : text, f: null, fmt: null };
  }
  return parseInput(text);
}

function workbookFromText(text, filename) {
  let src = text.replace(/^\ufeff/, '');
  const directive = SEP_DIRECTIVE.exec(src);
  if (directive) src = src.slice(directive[0].length);
  const delim = directive ? directive[1] : detectDelimiter(src, filename);
  const rows = parseDelimited(src, delim);
  const cells = {};
  let maxC = 0;
  // What the grid has no room for is counted, so that the import can say so rather than leave
  // the file looking as though it ended where the data does. Only a field holding something
  // counts; the blank lines and ragged trailing separators past the last column lose nothing.
  let beyondRows = 0;
  let beyondCols = 0;
  let countedRow = -1;
  rows.forEach((row, r) => row.forEach((text, c) => {
    if (text !== '') {
      if (r > MAX_ROW && r !== countedRow) { countedRow = r; beyondRows++; }
      if (c > MAX_COL) beyondCols = Math.max(beyondCols, c - MAX_COL);
    }
    // Beyond the grid's limits nothing can be shown or saved.
    if (r > MAX_ROW || c > MAX_COL) return;
    const { v, f, fmt, dateStyle, cur } = textFieldValue(text);
    if (v == null && f == null) return;
    cells[cellKey(r, c)] = { v, f, s: fmt ? refineImpliedFormat({ fmt, ...(cur ? { cur } : {}), ...(dateStyle ? { dateStyle } : {}) }, fmt, text) : undefined };
    if (c > maxC) maxC = c;
  }));
  const name = stripExtension(filename.split('/').pop()) || 'Sheet1';
  const wb = new Workbook({
    sheets: [{ name: safeSheetName(name), rows: Math.min(MAX_ROW + 1, Math.max(100, rows.length + 20)), cols: Math.min(MAX_COL + 1, Math.max(26, maxC + 6)), cells }],
  });
  if (beyondRows || beyondCols) wb.importTruncated = { rows: beyondRows, cols: beyondCols };
  wb.dirty = false;
  return wb;
}

/**
 * Parse spreadsheet file bytes (xlsx, xls, csv, ods, ...) into a Workbook.
 * `data` may be an ArrayBuffer, Uint8Array, or Blob.
 */
/**
 * Bytes of a text file as a string: UTF-16 by its byte-order mark, otherwise
 * UTF-8, falling back to Windows-1252 when the bytes are not valid UTF-8
 * (the usual case for CSVs saved by older Windows programs).
 */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    // One stray byte (a truncated file, a bad paste) must not turn a UTF-8 file into mojibake:
    // when almost every non-ASCII sequence decodes, keep UTF-8 and lose only the bad bytes.
    const lenient = new TextDecoder('utf-8').decode(b);
    const bad = (lenient.match(/\ufffd/g) || []).length;
    let nonAscii = 0;
    for (const ch of lenient) if (ch > '\x7f' && ch !== '\ufffd') nonAscii++;
    if (nonAscii >= 3 && bad <= Math.max(2, nonAscii / 25)) return lenient;
    try {
      // Some ICU-backed decoders treat Windows-1252 as Latin-1. Repair
      // its C1 range using the WHATWG mapping; conforming decoders are unchanged.
      const c1 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
      return new TextDecoder('windows-1252').decode(b).replace(/[\u0080-\u009f]/g, (ch) => c1[ch.charCodeAt(0) - 0x80]);
    } catch { return new TextDecoder('utf-8').decode(b); }
  }
}

/**
 * What a file's first bytes say it is: 'zip' (.xlsx, .xlsb, .ods, .numbers), 'cfb' (a
 * binary .xls), 'markup' (a flat XML spreadsheet, SpreadsheetML 2003, a saved web page,
 * or a SYLK or DIF text the library reads), 'text' (delimited text: a UTF-16 byte-order
 * mark, or no control characters but tabs, line breaks and form feeds in the first
 * kilobyte), or 'binary' (anything else, such as an Excel 4 or 5 .xls, or no bytes at all).
 */
function sniffFileKind(b) {
  if (!b.length) return 'binary';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] < 0x09 && b[3] < 0x09) return 'zip';
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) return 'cfb';
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return 'text';
  const head = b.subarray(0, 1024);
  for (const byte of head) if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return 'binary';
  const text = new TextDecoder().decode(head).replace(/^﻿/, '').trimStart();
  return /^(?:<\?xml\b|<\?mso-application\b|<!doctype\s+html\b|<html\b|<head\b|<body\b|<meta\b|<table\b|ID;P|TABLE\r?\n0,1)/i.test(text) ? 'markup' : 'text';
}

// A zip's central directory says what each part unpacks to before any of it is unpacked. A
// worksheet part of a few tens of megabytes can unpack to hundreds, which the reader then holds
// unpacked and decoded at once, so a file from a drive or a mail attachment could exhaust the
// tab long before any of this app's own limits were consulted. Anything past these is refused
// with a reason; they are far beyond what a browser tab could have opened anyway.
const MAX_PART_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/**
 * What the parts of a zip declare they unpack to: `{ largest, total }`, or null when the bytes
 * are not a zip (an .xls, a text file) or its directory cannot be read, where nothing is claimed
 * and the file is read as before. A zip64 directory, which holds sizes this app cannot open
 * anyway, counts as past every limit.
 */
function declaredUnpackedSize(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 22 || u8[0] !== 0x50 || u8[1] !== 0x4b) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u32 = (at) => view.getUint32(at, true);
  const u16 = (at) => view.getUint16(at, true);
  // The end-of-central-directory record is last, after a comment of up to 64 KB.
  let eocd = -1;
  for (let i = u8.length - 22, floor = Math.max(0, u8.length - 0x10016); i >= floor; i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = u16(eocd + 10);
  let at = u32(eocd + 16);
  const beyond = { largest: Infinity, total: Infinity };
  if (at === 0xffffffff || count === 0xffff) return beyond;
  let largest = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at < 0 || at + 46 > u8.length || u32(at) !== 0x02014b50) return null;
    const size = u32(at + 24);
    if (size === 0xffffffff) return beyond;
    if (size > largest) largest = size;
    total += size;
    at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
  }
  return { largest, total };
}

export async function workbookFromFile(data, filename = '', { sourceWorkbook = null } = {}) {
  let bytes = data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) bytes = await data.arrayBuffer();
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  // The bytes choose the reader, as Excel opens a comma-separated file named .xlsx as text
  // and a workbook named .csv as a workbook. A file named .csv, .tsv or .txt is delimited
  // text unless its bytes are a zip or a compound file, the two shapes text cannot take: a
  // German export whose header is "ID;Preis" shares its first bytes with a SYLK file, and a
  // first cell of "<table" or "<?xml" with a web page, and the library's readers for those
  // made numbers of decimal commas, mojibake of umlauts, or refused the file outright.
  const kind = sniffFileKind(bytes), textName = /\.(csv|tsv|txt)$/i.test(filename);
  if (kind === 'text' || (textName && kind !== 'zip' && kind !== 'cfb')) {
    const text = await workbookFromText(decodeText(bytes), filename);
    // Delimited text carries no column widths: fit them to the data on open.
    text.fitColumnsOnOpen = text.sheets.map((s) => s.id);
    return text;
  }
  const unpacked = declaredUnpackedSize(bytes);
  if (unpacked && (unpacked.largest > MAX_PART_BYTES || unpacked.total > MAX_UNPACKED_BYTES)) {
    const mb = (n) => `${Math.round(n / (1024 * 1024))} MB`;
    throw Object.assign(new Error(`This file is too large to open here: its parts unpack to ${Number.isFinite(unpacked.total) ? mb(unpacked.total) : `more than ${mb(MAX_UNPACKED_BYTES)}`}`), { code: 'too-large' });
  }
  const X = await XLSX();
  // cellStyles is what makes SheetJS keep column widths and row heights.
  // Keep prefixes intact for our token-aware decoder; the vendor's default
  // cleanup also removes matching text from strings and sheet names.
  // bookFiles keeps the inflated parts, from which the sheet state the reader leaves in the XML is read.
  const book = X.read(bytes, { type: 'array', cellNF: true, cellDates: false, cellStyles: true, sheetStubs: true, xlfn: true, bookFiles: true });
  const fileFormat = recoveredFormat(X);
  const partOf = sheetParts(book);
  // The reader keeps quiet about a sheet whose part it could not parse and
  // leaves it out of the book. Importing that sheet as empty would let the
  // next save overwrite the file without it; refuse the file instead.
  const unreadable = book.Workbook?.UnreadableSheets?.[0];
  if (unreadable != null) throw new Error(`Sheet "${unreadable}" could not be read; the file may be damaged`);
  // The reader keys sheets by name, so the second of two same-named sheets lands on top of
  // the first: one sheet's data would be gone and the other's shown twice, and a save would
  // write the file that way. Excel refuses such a file with a repair prompt; so do we.
  const twice = book.SheetNames.find((name, i) => book.SheetNames.indexOf(name) !== i);
  if (twice != null) throw new Error(`Two sheets are named "${twice}"; the file may be damaged`);
  const candidates = book.SheetNames.filter((n) => /^_puter_meta\d*$/i.test(n))
    .map((name) => ({ name, data: readMeta(X, book.Sheets[name]) })).filter((m) => m.data);
  // Prefer marked sidecars; older files used the fixed name without a marker.
  const sidecar = candidates.find((m) => m.data.format === 'puter-spreadsheet')
    || candidates.find((m) => m.name === META_SHEET);
  const storedMeta = sidecar?.data || book.PuterSettings;
  const meta = storedMeta ? unpackNativeFillState(storedMeta) : storedMeta;
  const nativeStyles = readXlsxStyles(book, meta?.nativeFillBaseline, meta?.nativeFillRecords);
  const fonts = fileCellStyles(book.Styles, nativeStyles);
  if (nativeStyles.nativeDefaultCellFormat) {
    let style = fonts?.[0] || {};
    // A non-font edit to XF zero must not turn an unchanged writer-created
    // font into an app-default override. Older sidecars intentionally retain
    // their implicit font, just as reconciledNormalFont does for Normal.
    if (meta && !meta.nativeDefaultCellFormat && !meta.normalFont && !reconciledNormalFont(meta, nativeStyles.normalFont)
      && JSON.stringify(xlsxFontProjection(style)) === JSON.stringify(xlsxFontProjection(normalFontStyle(nativeStyles.normalFont) || {}))) {
      style = Object.fromEntries(Object.entries(style).filter(([key]) => !FONT_KEYS.includes(key)));
    }
    nativeStyles.nativeDefaultCellFormat.style = style;
  }
  const lineFormats = book.Styles?.CellXf?.map((xf, i) => ({
    valign: 'bottom', ...fonts?.[i], ...numFmtToStyle(X.SSF.get_table()[xf.numFmtId]),
  }));
  // Our writer supplies a generic Normal font; the sidecar owns the app's
  // defaults. Still accept actual font changes made by another editor.
  const ownFonts = meta ? fileCellStyles(book.Styles, nativeStyles, false) : null;
  const veryHidden = new Set((book.Workbook?.Sheets || []).filter((s) => s.Hidden === 2).map((s) => s.name));
  const hidden = new Set((book.Workbook?.Sheets || []).filter((s) => s.Hidden === 1).map((s) => s.name));
  // Collect names before decoding either cells or names, so a defined
  // ANCHORARRAY call cannot be mistaken for legacy spill syntax.
  const validationNameKey = n => JSON.stringify([n.Name, n.Ref, n.Sheet ?? null]);
  const validationNames = new Set((Array.isArray(meta?.validationNames) ? meta.validationNames : [])
    .filter(n => n && typeof n.Name === 'string' && typeof n.Ref === 'string')
    .map(validationNameKey));
  const fileNames = (book.Workbook?.Names || [])
    .filter((n) => n?.Name && n?.Ref && !/^_xlnm\./i.test(n.Name)
      && !validationNames.has(validationNameKey(n))
      && (n.Sheet == null || (Number.isInteger(n.Sheet) && book.SheetNames[n.Sheet] != null && book.SheetNames[n.Sheet] !== sidecar?.name)));
  const globalNames = new Set(fileNames.filter((n) => n.Sheet == null).map((n) => n.Name.toUpperCase()));
  const scopedNames = new Map();
  for (const n of fileNames) if (n.Sheet != null) {
    const scope = book.SheetNames[n.Sheet];
    if (!scopedNames.has(scope)) scopedNames.set(scope, new Set(globalNames));
    scopedNames.get(scope).add(n.Name.toUpperCase());
  }
  const readXlsxPrint = book.files ? (await import('./xlsx-print.js')).readXlsxPrint : () => null;
  const nativePivotImport = /\/pivotCacheDefinition["']/.test(new TextDecoder().decode(book.files?.['xl/_rels/workbook.xml.rels']?.content || new Uint8Array()));
  const externalWorkbooks = rebaseExternalWorkbooks(readXlsxExternalWorkbooks(book), sourceWorkbook);
  const nameKey = (name, sheet) => JSON.stringify([sheet || null, name.toLowerCase()]);
  const structuredNames = new Map((Array.isArray(meta?.structuredNames) ? meta.structuredNames : [])
    .filter((n) => typeof n?.name === 'string' && typeof n.ref === 'string' && typeof n.fileRef === 'string')
    .map((n) => [nameKey(n.name, n.sheet), n]));
  const relativeNames = new Map((Array.isArray(meta?.relativeNames) ? meta.relativeNames : [])
    .filter(n => typeof n?.name === 'string' && typeof n.ref === 'string')
    .map(n => [nameKey(n.name, n.sheet), n.ref]));
  const names = fileNames
    .map((n) => {
      const ref = String(n.Ref).replace(/^=/, '');
      const scope = n.Sheet == null ? null : book.SheetNames[n.Sheet];
      const original = structuredNames.get(nameKey(n.Name, scope));
      const formula = original?.fileRef === ref ? original.ref : fromFileFormula(ref, scopedNames.get(scope) || globalNames);
      let relative = false;
      if (!meta && book.bookType === 'xlsx') mapFormulaRefs(formula, parsed => {
        if ((parsed.kind !== 'cols' && (!parsed.absR1 || !parsed.absR2)) || (parsed.kind !== 'rows' && (!parsed.absC1 || !parsed.absC2))) relative = true;
        return parsed;
      });
      else relative = relativeNames.get(nameKey(n.Name, scope)) === formula;
      return { name: n.Name, ref: formula, ...(n.Hidden ? { hidden: true } : {}), ...(scope ? { sheet: scope } : {}), ...(relative ? { relative: true } : {}) };
    });
  const externalLinks = createExternalFormulaLinks(names, externalWorkbooks);
  const sheets = book.SheetNames
    .filter((n) => n !== sidecar?.name)
    .map((n) => {
      // An .ods hides a sheet through its table style; only the settings block tells a very hidden one apart.
      const visibility = meta?.sheets?.[n]?.visibility;
      const isVeryHidden = veryHidden.has(n) || visibility === 'veryHidden';
      const chartSheet = book.Sheets[n]?.['!type'] === 'chart' || meta?.sheets?.[n]?.kind === 'chart';
      // The vendor turns chart caches into a few worksheet cells. They are not cells on a chart sheet.
      const sheet = importSheet(X, chartSheet ? {} : book.Sheets[n], n, meta, !!book.Workbook?.WBProps?.date1904, scopedNames.get(n) || globalNames, fileFormat, partOf(n), meta?.sheets?.[n] ? ownFonts : fonts, nativeStyles, nativeStyles.normalFont || book.Styles?.Fonts?.[0], book.Themes, lineFormats, nativePivotImport, externalWorkbooks, externalLinks);
      if (chartSheet) sheet.kind = 'chart';
      const printSettings = readXlsxPrint(partOf(n), book.Workbook?.Names, n, book.SheetNames.indexOf(n));
      sheet.printSettings = printSettings ? { ...meta?.sheets?.[n]?.printSettings, ...printSettings } : meta?.sheets?.[n]?.printSettings;
      // A native editor can delete the built-in title name. Absence in the
      // native package must override the app's older private metadata too.
      if (sheet.printSettings && partOf(n)) sheet.printSettings = { ...sheet.printSettings,
        titleRows: printSettings?.titleRows, titleCols: printSettings?.titleCols,
        // Page breaks, likewise: the native part's list is the one in force.
        rowBreaks: printSettings?.rowBreaks, colBreaks: printSettings?.colBreaks };
      if (!meta?.sheets?.[n]) {
        if (chartSheet) sheet.gridlines = false;
      }
      if (!chartSheet && partOf(n)) sheet.background = readXlsxBackground(book, n, partOf(n));
      return { ...sheet, hidden: hidden.has(n) || isVeryHidden || visibility === 'hidden', veryHidden: isVeryHidden };
    });
  const pivotRulePriorities = new Map();
  for (const sheet of sheets) {
    const nativeRules = sheet.rules;
    if (nativePivotImport) sheet.rules = nativeRules.map(({ priority, ...rule }) => rule);
    const own = meta?.sheets?.[sheet.name];
    const xml = partOf(sheet.name), baseline = xml ? own?.nativeConditionalFormats : null;
    // Older projections fingerprinted raw relative threshold formulas. Compare
    // those historical signatures while keeping the corrected native result
    // for rules changed by another editor (or with no saved app counterpart).
    const fingerprintRules = Array.isArray(own?.rules) && [1, 2].includes(baseline?.version)
      ? readXlsxConditionalFormats(xml, nativeStyles, nativeStyles.colors || book.Themes, scopedNames.get(sheet.name) || globalNames, { legacyThresholds: true }) : sheet.rules;
    if (nativePivotImport) {
      const priorities = new Map();
      sheet.rules = nativeRules.map(({ priority, ...rule }) => {
        if (!priorities.has(priority)) priorities.set(priority, crypto.randomUUID());
        return { ...rule, pivotRuleIds: [priorities.get(priority)] };
      });
      pivotRulePriorities.set(sheet.name, priorities);
    }
    sheet.rules = await reconcileConditionalFormats(own?.rules, baseline, sheet.rules, fingerprintRules);
  }
  const workbookRels = book.files?.['xl/_rels/workbook.xml.rels']?.content;
  const richValues = workbookRels && /\/rdRichValue["']/.test(new TextDecoder().decode(workbookRels))
    ? (await import('./xlsx-rich-values.js')).readXlsxRichValues(book) : new Map();
  if (richValues.size) for (const sheet of sheets) {
    for (const m of (partOf(sheet.name) || '').matchAll(/<(?:\w+:)?c\b[^>]*>/g)) {
      const value = richValues.get(Number(xlsxAttr(m[0], 'vm')));
      const address = xlsxAttr(m[0], 'r');
      if (!value || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address || '')) continue;
      const { r, c } = X.utils.decode_cell(address), cell = sheet.cells[cellKey(r, c)];
      // Computed rich values keep their formula, so they recalculate after edits.
      if (cell && !cell.f) cell.v = value;
    }
  }
  // Two-cell drawing anchors need the imported row heights and column widths.
  const drawingInventory = new Map();
  const nativeCharts = await readXlsxCharts(book, sheets, drawingInventory, {
    // The groups this app wrote of its own objects, which come apart into those objects again.
    splitGroups: (name) => { const keys = meta?.sheets?.[name]?.nativeGroups; return Array.isArray(keys) ? new Set(keys.filter((k) => typeof k === 'string')) : null; } });
  for (const sheet of sheets) if (book.files?.['xl/workbook.xml']) sheet.charts = await reconcileDrawings(meta?.sheets?.[sheet.name], nativeCharts.get(sheet.name) || [], drawingInventory.get(sheet.name));
  // A timeline has no Excel drawing of ours: it comes back from the app's own data (see timeline.js).
  for (const sheet of sheets) {
    const savedCharts = meta?.sheets?.[sheet.name]?.charts;
    // Untrusted metadata: a collection that is not a list carries no timelines.
    const timelines = (Array.isArray(savedCharts) ? savedCharts : []).filter(c => c?.type === 'timeline');
    if (timelines.length) sheet.charts = [...(sheet.charts || []).filter(c => c?.type !== 'timeline'), ...timelines];
  }
  const nativeSlicers = importXlsxSlicers(book, sheets, nativeStyles.colors || book.Themes, partOf);
  importXlsxScrollControls(book, sheets);
  importXlsxCheckboxes(book, sheets.filter(sheet => !meta?.sheets?.[sheet.name]));
  importXlsxThreadedComments(book, sheets);
  if (!sheets.length) sheets.push({ name: 'Sheet1' });
  if (book.Workbook?.WBProps?.date1904) shiftDateNames(names, sheets);
  const iteration = normalizeIteration(book.Workbook?.CalcPr);
  if (iteration) for (const sheet of sheets) {
    const source = book.Sheets[sheet.name];
    for (const [key, cell] of Object.entries(sheet.cells)) if (cell.f) {
      const src = source?.[X.utils.encode_cell(parseKey(key))];
      if (src?.v != null) {
        cell.v = cachedValue(X, src);
        if (book.Workbook?.WBProps?.date1904 && Number.isFinite(cell.v) && ['date', 'datetime'].includes(dateTimeKind(cell.s, cell.v))) cell.v += 1462;
      }
    }
  }
  const normalFont = reconciledNormalFont(meta, nativeStyles.normalFont);
  // Themes.raw is the vendor's byte string. Decode the actual UTF-8 part so
  // non-Latin fallback faces do not acquire mojibake on each round trip.
  const themePart = book.files?.[book.Directory?.themes?.[0]?.replace(/^\//, '')]?.content;
  const workbookPath = book.Directory?.workbooks?.[0]?.replace(/^\//, '') || 'xl/workbook.xml';
  const workbookPart = book.files?.[workbookPath]?.content;
  const modelRelsPath = workbookPath.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels');
  const modelRels = book.files?.[modelRelsPath]?.content;
  const dataModel = modelRels && /\/powerPivotData["']/.test(new TextDecoder().decode(modelRels))
    ? (await import('./xlsx-data-model.js')).readXlsxDataModel(book) : null;
  const calculationCompatibility = book.bookType === 'xlsx'
    ? readXlsxCalculationCompatibility(workbookPart ? new TextDecoder().decode(workbookPart) : '')
    : normalizeCalculationCompatibility(meta?.calculationCompatibility, ['xls', 'biff2', 'biff5', 'biff8', 'xlsb'].includes(book.bookType) ? 1 : 2);
  // Keep parser-only display strings outside the normalized/serialized chart model.
  // Assign IDs before construction so discarded or reordered drawings cannot shift bindings.
  const importedChartTexts = new Map();
  for (const sheet of sheets) for (const chart of sheet.charts || []) {
    const texts = chart.sourceRefs?.map(source => source.nativeCategoryTexts);
    const labels = chart.sourceRefs?.map(source => source.nativeLabelTexts);
    const linked = Object.fromEntries([...['title', 'xTitle', 'yTitle', 'y2Title'].map(key => [key, chart[`${key}NativeText`]]),
      ...(chart.sourceRefs || []).map((source, i) => [`name:${i}`, source.nativeNameText])].filter(([, value]) => typeof value === 'string'));
    if (!texts?.some(Array.isArray) && !labels?.some(Array.isArray) && !Object.keys(linked).length) continue;
    chart.id ||= crypto.randomUUID();
    const key = JSON.stringify([sheet.name, chart.id]);
    importedChartTexts.set(key, importedChartTexts.has(key) ? null : { categories: texts, labels, linked });
  }
  const calcMode = String(book.Workbook?.CalcPr?.calcMode || '').toLowerCase() === 'manual' ? 'manual' : undefined;
  const workbookXml = (() => { const path = book.Directory?.workbooks?.[0]?.replace(/^\//, '') || 'xl/workbook.xml'; const part = book.files?.[path]?.content; return part ? new TextDecoder().decode(part) : ''; })();
  const structureProtected = ['1', 'true'].includes(xmlAttr(workbookXml.match(/<(?:\w+:)?workbookProtection\b[^>]*>/)?.[0], 'lockStructure') || '') || undefined;
  // Edit Links ▸ Startup Prompt, from workbookPr's updateLinks (userSet, the default, is to ask).
  const linkStartup = { always: 'update', never: 'none' }[xmlAttr(workbookXml.match(/<(?:\w+:)?workbookPr\b[^>]*>/)?.[0], 'updateLinks') || ''];
  const wb = new Workbook({ sheets, names, iteration, calcMode, structureProtected, linkStartup, calculationCompatibility, normalFont,
    nativeNormalStyle: book.bookType === 'xlsx' ? nativeStyles.nativeNormalStyle : normalizeNativeNormalStyle(meta?.nativeNormalStyle),
    nativeNormalFill: book.bookType === 'xlsx' ? nativeStyles.nativeNormalFill : meta?.nativeNormalFill,
    nativeDefaultCellFormat: book.bookType === 'xlsx' ? nativeStyles.nativeDefaultCellFormat : meta?.nativeDefaultCellFormat,
    dataModel, externalWorkbooks, colorPalette: nativeStyles.colorPalette, queries: meta?.queries, changeHistory: meta?.changeHistory,
    scripts: book.bookType === 'xlsx' ? readXlsxScripts(book.files) : meta?.scripts,
    // The app's own record of its named styles, else the file's (another program's custom styles).
    cellStyles: Array.isArray(meta?.cellStyles) ? meta.cellStyles : nativeStyles?.namedStyles,
    fontTheme: themePart ? readFontTheme(new TextDecoder().decode(themePart)) : normalizeFontTheme(meta?.fontTheme),
    themeInfo: importedThemeInfo(themePart ? readThemeInfo(new TextDecoder().decode(themePart)) : null, meta?.themeInfo, normalFont) });
  if (modelRels && /\/pivotCacheDefinition["']/.test(new TextDecoder().decode(modelRels)))
    wb.nativePivots = (await import('./xlsx-pivots.js')).readXlsxPivots(book, wb);
  bindNativePivotRules(wb.nativePivots, wb.sheets, pivotRulePriorities);
  if (nativeSlicers?.caches.some(c => c.kind === 'pivot')) {
    wb.nativePivots = normalizeNativePivots(importNativePivotSlicerCaches(nativeSlicers, wb.nativePivots, wb.sheets));
    if (!wb.nativePivots) throw new Error('Native pivot storage exceeds limits');
    for (const sheet of wb.sheets) for (const control of sheet.charts) if (control.type === 'slicer' && control.pivotCache != null) {
      if (!slicerItems(wb, control)) throw new Error('Missing native pivot slicer binding');
    }
  }
  // PivotTable slicers travel in the app's own data (see xlsx-pivot-slicer-sidecar.js).
  restorePivotSlicerSidecar(wb, meta?.pivotSlicers, meta?.sheets);
  if (!wb.nativePivots) for (const sheet of wb.sheets) for (const rule of sheet.rules) delete rule.pivotRuleIds;
  // Older XLSX exports and ODS flatten table references; native XLSX also
  // spells @ as SINGLE. Restore private spelling only while the native
  // formula still equals an exported representation;
  // a formula or value changed in another editor is authoritative.
  let restoredStructured = false;
  for (const sheet of wb.sheets) for (const [key, formula] of Object.entries(meta?.sheets?.[sheet.name]?.structured || {})) {
    const cell = sheet.cells.get(key);
    if (typeof formula !== 'string' || !cell?.f || cell.f === formula) continue;
    const { r, c } = parseKey(key);
    const canonical = f => fromFileFormula(toFileFormula(f), scopedNames.get(sheet.name) || globalNames);
    const native = unlessTooDeep(() => canonical(formula), null);
    const flattened = unlessTooDeep(() => canonical(wb.structuredToA1(sheet.id, r, c, formula)), null);
    if (cell.f === native || cell.f === flattened) {
      cell.f = formula;
      restoredStructured = true;
    }
  }
  if (restoredStructured) {
    wb.recalculate();
    wb.sheets.forEach((sheet, i) => { if (sheetFilters(sheet).length && !Array.isArray(sheets[i]?.filterHidden)) wb._applyFilter(sheet); });
  }
  for (const sheet of wb.sheets) for (const chart of sheet.charts) {
    const texts = importedChartTexts.get(JSON.stringify([sheet.name, chart.id]));
    if (texts?.categories) bindImportedChartCategoryText(wb, sheet.id, chart, texts.categories);
    if (texts?.labels) bindImportedChartCategoryText(wb, sheet.id, chart, texts.labels, 'label');
    if (texts?.linked) bindImportedChartText(wb, sheet.id, chart, texts.linked);
  }
  // The parked external formulas ride with the book by sheet id, so a rename does not lose them.
  const parked = new Map(wb.sheets.flatMap((sheet, i) => (sheets[i]?.externalFormulas ? [[sheet.id, sheets[i].externalFormulas]] : [])));
  if (parked.size) wb.externalFormulas = parked;
  adoptFileFilters(wb, sheets);
  // Other programs allow names the .xlsx writer refuses (a slash, 40
  // characters, "History"); renaming here, with every reference following,
  // keeps the file saveable.
  const renamed = new Map();
  for (const sheet of wb.sheets) {
    const fixed = safeSheetName(sheet.name, wb.sheets.filter((s) => s !== sheet).map((s) => s.name));
    if (fixed === sheet.name) continue;
    renamed.set(sheet.name, fixed);
    wb.renameSheet(sheet.id, fixed);
  }
  if (renamed.size) wb.clearHistory();
  // SheetJS CE does not carry the workbook's active tab through a write, so
  // the sidecar remembers which sheet was open. Treat this optional hint as
  // a name only; coercing malformed objects can abort an otherwise valid import.
  // Custom Views: the native ones, made whole from the app's record of them where it has one.
  const workbookText = book.bookType === 'xlsx' && workbookPart ? new TextDecoder().decode(workbookPart) : null;
  const views = workbookText != null
    ? /customWorkbookView\b/.test(workbookText) ? (await import('./xlsx-custom-views.js')).readXlsxCustomViews(workbookText, book.SheetNames.filter((n) => n !== sidecar?.name), partOf, meta?.customViews) : []
    : Array.isArray(meta?.customViews) ? meta.customViews.map((v) => ({ ...v, activeSheet: v.activeSheetId })) : [];
  if (views.length) {
    const idOf = (name) => wb.sheetByName(renamed.get(name) || name)?.id ?? null;
    wb.adoptCustomViews(remapCustomViews(views.map((v) => ({ ...v, activeSheetId: v.activeSheet })), idOf));
  }
  const view = workbookPart && new TextDecoder().decode(workbookPart).replace(/<!--[\s\S]*?-->/g, '').match(/<(?:\w+:)?workbookView\b[^>]*>/)?.[0];
  if (view) {
    const rawFirstSheet = xlsxAttr(view, 'firstSheet');
    const firstIndex = rawFirstSheet == null ? null : Number(rawFirstSheet);
    const firstName = Number.isInteger(firstIndex) && firstIndex >= 0 ? book.SheetNames[firstIndex] : null;
    const firstSheetId = firstName ? wb.sheetByName(renamed.get(firstName) || firstName)?.id : null;
    wb.workbookView = normalizeWorkbookView({
      ...Object.fromEntries(WORKBOOK_VIEW_ATTRIBUTES.filter(key => key !== 'firstSheet').map(key => [key, xlsxAttr(view, key)])),
      firstSheetId,
    });
  }
  const tab = Number(xlsxAttr(view, 'activeTab'));
  const activeName = typeof meta?.active === 'string' ? meta.active : Number.isInteger(tab) && tab >= 0 ? book.SheetNames[tab] : null;
  const active = activeName ? wb.sheetByName(renamed.get(activeName) || activeName) : null;
  if (active && !active.hidden) wb.activeSheetId = active.id;
  wb.dirty = false;
  return wb;
}
