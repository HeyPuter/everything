import { normalizeThemeInfo, themedTableLook } from './workbook-theme.js';
import { normalizeCellStyles } from './custom-cell-styles.js';
import { normalizeFillColor, fillColorCss, sameFillColor } from './fill-color.js';
import { normalizeNativeFill, nativeFillPatch, packNativeFillState, unpackNativeFillState } from './native-fill.js';
import { tableConversionStyle } from './table-conversion-style.js';
import { transposeFormula } from './transpose-formula.js';
import { refreshCellDrawings, reanchorCellDrawing, mapCellDrawing, normalizeCellAnchor } from './drawing-cell-anchor.js';
import { preserveCopiedChartText } from './chart-linked-text.js';
import { externalProvenance, externalFormulaProvenance } from './external-provenance.js';
import { externalLinksFromDependencies } from './external-formula-links.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { externalInputContext, canRebaseCopiedExternalInputs } from './external-result-inputs.js';
import { callerDependencies } from './formula/caller-context.js';
import { externalWorkbookSheetCopy } from './external-workbook-sheet-copy.js';
import { normalizeExternalWorkbooks, savedExternalResult, savedExternalRange, reindexExternalCell, externalFormulaHasLinks, externalFormulaHasCaches, externalWorkbookScope, externalWorkbookSpan, externalNamedEntries, offsetExternalWorkbookRefs, appendExternalWorkbooks } from './external-workbooks.js';
import { clonedPivotRuleMap } from './native-pivot-rule-bindings.js';
import { nativeSparklineDateMismatch, nativeSparklineLocation } from './native-sparkline-data.js';
import { importedNativeSparklines } from './native-sparkline-import.js';
import { packedMoveReferences } from './packed-move-refs.js';
import { copyNativeSparklines, mapPastedNativeSparklines, replacePastedNativeSparklines } from './native-sparkline-paste.js';
import { copyValidations, mapPastedValidations, replaceValidations } from './validation-paste.js';
import { NATIVE_ICON_SETS, nativeIconFor, nativeIconCount } from './native-icons.js';
import { conditionalRuleGroups, conditionalGroupPieces, distinctConditionalRanges } from './conditional-groups.js';
import { moveConditionalFormats, conditionalMoveBlocks } from './conditional-move.js';
import { copyConditionalFormats, mapPastedConditionalFormats, replaceConditionalFormats } from './conditional-paste.js';
import { BAR_FORMULAS, SCALE_FORMULAS, ICON_FORMULAS, conditionalThresholdIsFormula, conditionalThresholdFormula, conditionalFormulaFields, mapConditionalFormulas, conditionalPredicateField } from './conditional-scale.js';
import { NativeDuplicateCounts, duplicateAreaStats, duplicateSourceAreas, duplicateSourceFormula } from './conditional-duplicates.js';
import { cloneStyle, replaceInheritedStyle } from './style-values.js';
import { normalizeNativeNormalStyle } from './native-normal-style.js';
import { normalizeNativeDefaultCellFormat } from './native-default-cell-format.js';
import { nativePivotDisplayStyle, hasNativePivotDisplay, nativePivotDisplayIssues } from './native-pivot-display.js';
import { borderSnapshot, restyledBorderRegions, changedBorderRegions, paintedBorder, borderPaintSides, borderPaintPatch, borderPaintState } from './border-regions.js';
import { normalizeIgnoredErrors } from './ignored-errors.js';
import { normalizeFontTheme, exportFontScheme } from './font-theme.js';
import { normalizeRichText, richTextValue, editRichText, patchRichText } from './rich-text.js';
import { clearRangeFlagsAtCells, compactRangeFlags, removeRangeFlags, shiftRangeFlags, moveLineRangeFlags, mapRangeFlags } from './range-flags.js';
import { normalizeFontColor, normalizeColorPalette, sameFontColor, DEFAULT_FONT_COLOR, fontColorInPalette } from './font-color.js';
/**
 * The document model: sheets of sparse cells, lazy formula evaluation with
 * a cache that is dropped whole on every change, and an undo history.
 *
 * Cell: { v, f, s, array?, richText?, hyperlink?, externalResult? }
 *   v  raw value: number | string | boolean | null
 *   f  formula body without "=" (null when the cell holds a plain value)
 *   s  style: { bold, italic, underline, strike, align, color, bg, fmt, dec, cur }
 *   externalResult  last native linked-formula result, tied to its formula and caller
 *   array  fixed CSE output size: { rows, cols }, on the formula anchor only
 *   richText  character runs: [{ text, s? }], whose combined text is the value
 *
 * Every mutating method records one undo entry. Cell-level edits store the
 * cells they replaced; structural edits (rows, columns, sheets) snapshot the
 * whole workbook, because they can touch formulas on every sheet and are
 * rare enough that a snapshot is the cheaper thing to get right.
 */

import { cellKey, parseKey, normalizeRange, cellName, MAX_TEXT } from './cell.js';
import { fontName, parseInput, refineImpliedFormat, formatValue, serialToYMD, ymdToSerial, dateTimeKind, FORMAT_DETAIL_KEYS, getLocale } from './format.js';
import { MAX_FORMAT_CODE_LENGTH, codeIsFraction } from './numfmt.js';
import { normalizeCalculationCompatibility } from './calculation-compatibility.js';
import { normalizeIteration, calculateIteratively } from './iteration.js';
import { normalizeNativeSparklineGroups, mapNativeSparklineReferences, mapNativeSparklineDestinations, nativeSparklineSize, nativeSparklineFlags, nativeSparklineColors, nativeSparklineChoices } from './native-sparklines.js';
import { normalizeSheetSelection, normalizeSheetOrigin } from './sheet-selection.js';
import { normalizeSplit } from './split-panes.js';
import { fixedArraySize, fixedArrayValue, FixedArrayIndex } from './fixed-arrays.js';
import { readComments, freshCommentIds, commentsJSON, remapComments, permuteComments, carryComments } from './comments.js';
import { mapPasteMerges, planPasteMerges, planFormatPasteMerges, remainingPasteMerges } from './paste-merges.js';
import { normalizeNormalFont, normalizeNativeWidths, mapNativeWidths, normalFontStyle } from './normal-font.js';
import { normalizeWorkbookView } from './workbook-view.js';
import { normalizeNativeDefaultHeight } from './xlsx-sheet-format.js';
import { normalizeDataModel } from './data-model.js';
import { normalizeNativePivots, pivotLineConflict, pivotBlockConflict, mapNativePivotRanges, pivotMoveConflict, moveNativePivotRanges, pivotClearPlan, pivotChartQualifier, renamePivotChartSheet, duplicateNativePivots, cloneNativePivotReports, renameNativePivotTableSource } from './native-pivots.js';
import { mapNativePivotSlicerConnections } from './native-pivot-slicer-storage.js';
import { transferNativePivots } from './native-pivot-transfer.js';
import { prepareDataModelImport } from './data-model-import.js';
import { nativePivotSheetCopy } from './native-pivot-sheet-copy.js';
import { normalizePrintSettings, mapPrintAreas } from './print-settings.js';
import { normalizeBackground } from './sheet-background.js';
import { normalizeCustomViews, captureCustomView, MAX_CUSTOM_VIEWS, CUSTOM_VIEW_NAME_MAX } from './custom-views.js';
import { parseFormula } from './formula/parser.js';
import { ARRAY_BUDGET, evaluate, evaluateFormula, isVolatile, paramSpec, resetArrayBudget, withArrayBudget } from './formula/evaluator.js';
import { FUNCTIONS, err, isError, isRange, scalar, compareStoredValues, toText } from './formula/functions.js';
import { parseDelimited } from './tsv.js';
import { splitPieces, detectDelimiter, DEFAULT_SPLIT } from './text-split.js';
import { adjustFormula, adjustRefForInsert, adjustRefForDelete, adjustRefForDeletedLines, deleteMap, renameSheetInFormula, shiftFormula, resolveRelativeName, mapFormulaRefs, parseRefText, refToText, MAX_ROW, MAX_COL, quoteSheet, sheetKey, sameSheetName } from './refs.js';
import { headerlessTableColumns, normalizeTableHeaderState, headerlessInsertColumns, headerlessDeleteColumns, headerlessJoinColumns, headerlessResizeNames } from './table-header-row.js';
import { tableStyle, tableRows, normalizeCustomTableStyle, customTableStyleAt, validateTableName, MAX_TABLE_NAME_LENGTH, parseTableSpec, resolveTableSpec, renderTableSpec, renameTableInFormula, tableColumnRenames, renameColumnsInFormula, tableRefsToA1, hasTableRefs } from './tables.js';
import { tokenize, upperName, isWorkbookNameScope, isExternalFormulaToken } from './formula/tokenizer.js';
import { adjustLineRules, adjustBlockRules } from './rule-refs.js';
import { adjustFilterForEdit, filterFormulaReader, filterFormulaRules, compileFilterFormula, mapFilterFormula } from './filter-formulas.js';
import { filterValueIdentity, sheetFilters, sameFilterRange, filterRangeKey, filterTable, copyFilter, mapSheetFilters } from './sheet-filters.js';
import { freeNameTokens } from './formula/names.js';
import { matchesRule, scaleColor, scaleMidpoint, valueIdentity, bandColor, dataBar, iconFor, barColorOf, DEFAULT_BAR_COLOR } from './condformat.js';
import { checkValue, listOptions, listOptionIndex, chipFor, isRangeSource, ruleFormulaBody } from './validation.js';
import { normalizeChart, placeAlong, mapChartReferences, snapshotChartData, preserveCopiedChartFormats, OBJECT_NAME_MAX } from './charts.js';
import { orderObjects, moveObjectTo, groupObjects, ungroupObjects, alignRects, distributeRects, boundsOf, withGroups, canRotate, rotatePatch } from './arrange.js';
import { explainError } from './errhelp.js';
import { impliedFormulaStyle } from './implied-format.js';
import { formulaReachesOut } from './reaches-out.js';
import { STYLE_KEYS, BORDER_STYLE_KEYS, GRID_RANGE, intersection, rowRuns, readStyleResets, styleResetAt, assignStyleExceptionRegions, compactStyleResets, removeStyleResets, mapStyleResets, shiftStyleResets, permuteStyleResets, moveLineStyleResets, moveStyleResets } from './style-resets.js';
import { normalizeScenarios, copyScenarios, mapScenarioCells } from './scenarios.js';
import { normalizeQueries, serializeQueries } from './queries.js';
import { normalizeScripts, serializeScripts } from './scripts.js';
import { installSheetGroups } from './sheet-group.js';
import { normalizeChangeHistory, recordCellWrites, recordStep } from './change-history.js';

/** What a floating object is called in undo labels: chart, image, or text box. */
function objectNoun(obj) {
  return obj?.type === 'slicer' ? 'slicer' : obj?.type === 'scroll' ? 'scroll bar' : obj?.type === 'image' ? 'image' : obj?.type === 'smartart' ? 'SmartArt' : obj?.type === 'text' ? obj.equation ? 'equation' : 'text box' : 'chart';
}

export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 26;
// A sheet is the full .xlsx grid, A1:XFD1048576. The grid shows only as much as has been reached and
// grows as the user goes further, but every command treats the sheet as this size.
export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384; // XFD
export const DEFAULT_COL_WIDTH = 100;
/**
 * The column width and row height a blank workbook starts with, the .xlsx defaults (8.43 characters, 15 points). They are
 * stored with each sheet, so files that relied on DEFAULT_COL_WIDTH and DEFAULT_ROW_HEIGHT keep their geometry.
 */
export const EXCEL_SHEET_DEFAULTS = Object.freeze({ defaultColWidth: 64, defaultRowHeight: 20 });
export const DEFAULT_ROW_HEIGHT = 19.5;
// Interactive sizing limits, shared by drag previews, dialogs and stored resize operations.
export const MIN_COL_WIDTH = 24;
export const MAX_COL_WIDTH = 800;
export const MIN_ROW_HEIGHT = 18;
export const MAX_ROW_HEIGHT = 400;
// Designed .xlsx reports can have columns wider than the interactive resize limit.
export const MAX_STORED_COL_WIDTH = 4096;
// Rows may be up to 409.5 points (546 CSS pixels), the .xlsx limit, including chart layouts.
export const MAX_STORED_ROW_HEIGHT = 546;
const HISTORY_LIMIT = 200;
// A structural undo step holds snapshots of the sheets it changed; the oldest steps go once those hold more cells than this in all.
const SNAPSHOT_CELLS = 1_000_000;
// The changes kept on record, newest last, for a listener asking what changed since a version it knows (see changesSince).
const CHANGE_LOG = 256;
// Formulas that read other files or the web; a file from elsewhere may not run them until the user allows it.
// Formulas that reach outside the file: the web and other files, and the AI service, which spends the account's quota on a foreign file's prompts.
/** Edit Links ▸ Startup Prompt choices (see setLinkStartup). */
export const LINK_STARTUP_MODES = ['ask', 'update', 'none'];
const EXTERNAL_PROVIDERS = new Set(['IMPORTDATA', 'IMPORTHTML', 'IMPORTXML', 'IMPORTRANGE', 'WEBSERVICE', 'AI', 'TRANSLATE', 'DETECTLANGUAGE']);
const DEEP_FRAMES = 16; // nested evaluations above this depth hand a stack overflow to a shallower frame
// A bounded reference is read this far past the data (A1:A5000 on a sheet with
// 20 rows reads 1,000 rows); COUNTBLANK, COUNTIF, and INDEX account for the rest.
const READ_ROWS = 1000;
const READ_COLS = 26;
// Arrays read from ranges are kept for the other formulas naming the same range, up to this much
// memory in all, measured in cells: each row's own array weighs about as much as eight cells.
const RANGE_CACHE_CELLS = 2_000_000;
// Families of ranges (one start and one span of columns, ending lower and lower) whose longest read
// so far is remembered, so that a longer one of the family carries on from it (see getRangeValues).
const RANGE_CACHE_RUNS = 4000;
function rangeCost(values) { return values.length * ((values[0]?.length || 0) + 8); }
// Formatting a range formats its empty cells too, so what is typed there later takes the format. Over a range
// of more cells than this (a whole sheet of 20,000 rows) that would store a cell per empty coordinate, 320,000
// of them for Select all → Bold on a sheet holding 200,000 values, and every later scan, save and draft would
// carry them: there the format goes to the cells holding something and the empty cells beside them (applyStyle).
const STYLE_FILL_CELLS = 50_000;
const INVALID_SHEET_CHARS = /[[\]:*?/\\]/;

/**
 * A sheet name every file format accepts: the app's own rules plus the .xlsx ones
 * (no apostrophe at either end, "History" is reserved), unique among `taken`.
 * Files from other programs may arrive with names the .xlsx writer refuses,
 * and a refused name would fail every save.
 */
export function safeSheetName(name, taken = []) {
  // Whitespace is part of a sheet's identity, including at either end. In
  // particular, changing it would break INDIRECT's literal references.
  let base = String(name ?? '').replace(new RegExp(INVALID_SHEET_CHARS.source, 'g'), ' ').replace(/^'+|'+$/g, '').slice(0, 31).replace(/[\uD800-\uDBFF]$/, '').replace(/'+$/, '');
  if (!base) base = 'Sheet1';
  else if (base.toLowerCase() === 'history') base = 'History sheet';
  const keys = new Set(taken.map(sheetKey));
  let out = base;
  for (let n = 2; keys.has(sheetKey(out)); n++) {
    const suffix = ` ${n}`;
    out = suffixedSheetName(base, suffix);
  }
  return out;
}
const NAME_RE = /^[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]{0,254}$/u; // letters of any script: Größe, 合計
/** The .xlsx limit on a formula's text. */
export const MAX_FORMULA_LENGTH = 8192;
/** Brackets nested deeper than this overflow the parser's stack, so such an entry stays text. */
export const MAX_FORMULA_NESTING = 256;

/** How deeply parentheses, brackets, and braces nest in a formula body, outside its string literals. */
function formulaNesting(body) {
  let depth = 0;
  let deepest = 0;
  let quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '(' || ch === '[' || ch === '{') deepest = Math.max(deepest, ++depth);
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return deepest;
}
/** Whether a formula body has more opening than closing parentheses outside its string literals: one that stops short of its end. */
function unclosedParens(body) {
  let open = 0;
  let quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '(') open++;
    else if (ch === ')') open--;
  }
  return open > 0;
}
/** A list option's identity: its type and plain text, as the validation module dedupes typed options. */
const optionKey = (v) => `${typeof v}:${typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v}`;

// A lone R or C stands for the current row or column in R1C1 notation, so they are reserved as names too.
const LOOKS_LIKE_REF = /^\$?[A-Za-z]{1,3}\$?\d{1,7}$|^[A-Za-z]{1,3}:[A-Za-z]{1,3}$|^\d+:\d+$|^[Rr]\d*[Cc]\d*$|^[RrCc]$/;

/** Leave room for a generated suffix within the 31-character sheet-name limit. */
function suffixedSheetName(name, suffix) {
  return name.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
}

let nextId = 1;
const newId = () => `s${Date.now().toString(36)}${(nextId++).toString(36)}`;

export function cloneCell(cell) {
  if (!cell) return null;
  const out = { v: cell.v ?? null, f: cell.f ?? null };
  const result = savedExternalResult(cell);
  if (result) out.externalResult = result;
  if (typeof cell.hyperlink === 'string' && cell.hyperlink && cell.hyperlink.length <= MAX_TEXT) out.hyperlink = cell.hyperlink;
  if (cell.richText) {
    const rich = normalizeRichText(cell.richText, typeof out.v === 'string' ? out.v : typeof out.f === 'string' ? richTextValue(cell.richText) : null);
    if (rich) out.richText = rich;
  }
  const array = typeof out.f === 'string' && fixedArraySize(cell.array);
  if (array) out.array = array;
  if (cell.s && Object.keys(cell.s).length) {
    out.s = cloneStyle(cell.s);
    // Persisted format codes must be strings. Coercing malformed metadata
    // can change the displayed value or throw in renderers and format dialogs.
    if (typeof out.s.code !== 'string') delete out.s.code;
    // A code past 255 characters, the format-code limit, reads as General here as it does
    // at the file and paste doors: shown through it, every cell cost some ten milliseconds.
    else if (out.s.code.length > MAX_FORMAT_CODE_LENGTH) { delete out.s.code; if (out.s.fmt === 'custom') delete out.s.fmt; }
    if (!Object.keys(out.s).length) delete out.s;
  }
  return out;
}

// A fraction as it is typed: "1/2", "-3/4" or "2 3/4".
const TYPED_FRACTION_RE = /^([-+]?)(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/;

/** The number a typed fraction stands for, or null when the text is not one (or divides by zero). */
function typedFraction(text) {
  const m = TYPED_FRACTION_RE.exec(text.trim().replace(/−/g, '-'));
  if (!m || Number(m[4]) === 0) return null;
  const v = Number(m[2] || 0) + Number(m[3]) / Number(m[4]);
  return m[1] === '-' ? -v : v;
}

/**
 * Typed text plus the cell's existing style → the cell to store. A typed
 * percent or date sets the number format unless one is already chosen, so
 * "12%" reads back as 12% and "0.5" typed into that cell shows 50%.
 */
export function cellFromInput(text, prevStyle) {
  const raw = text == null ? '' : String(text);
  // A new entry may be a link again: the mark a removed link left on the cell (see removeLink) goes with what is typed over it.
  if (prevStyle?.nolink) { const { nolink, ...rest } = prevStyle; prevStyle = Object.keys(rest).length ? rest : undefined; }
  if (prevStyle?.fmt === 'text' && !/^=./.test(raw)) {
    // Plain text keeps what was typed: "00123" stays "00123" and "1/2" is not a
    // date. A leading apostrophe still only marks text; formulas still work.
    const kept = raw.startsWith("'") ? raw.slice(1) : raw;
    return { v: kept === '' ? null : kept, f: null, s: { ...prevStyle } };
  }
  if (prevStyle?.fmt === 'custom' && typeof prevStyle.code === 'string') {
    // A cell formatted as a fraction reads "1/2" as one half once the Fraction
    // format is on (which keeps such an entry from becoming a date), rather than as January 2.
    const half = typedFraction(raw);
    if (half != null && codeIsFraction(half, prevStyle.code)) return { v: half, f: null, s: { ...prevStyle } };
  }
  const { v: parsed, f, fmt, dateStyle, cur } = parseInput(text);
  // A formula longer than the .xlsx limit, or nested deeper than the parser can follow, stays
  // the text that was typed rather than becoming a formula nothing can read.
  if (f != null && (f.length > MAX_FORMULA_LENGTH || formulaNesting(f) > MAX_FORMULA_NESTING)) return { v: raw, f: null, s: prevStyle ? { ...prevStyle } : undefined };
  // A number of one or more typed into a percent cell is that many percent
  // (5 is 5%); a number under one is the share it already is (0.5 is 50%). A typed "5%",
  // currency, date or time is what it says.
  const v = prevStyle?.fmt === 'percent' && typeof parsed === 'number' && (!fmt || fmt === 'number' || fmt === 'scientific') && Math.abs(parsed) >= 1 ? parsed / 100 : parsed;
  let s = prevStyle ? { ...prevStyle } : undefined;
  // A leading apostrophe keeps this one entry as text; it does not make the cell
  // Plain text, so a number typed into it later is a number. The editor shows the apostrophe again itself.
  if (fmt && fmt !== 'text' && (!s?.fmt || s.fmt === 'general')) {
    // A cell with no format of its own may still carry the code, seconds, decimals or grouping of one it was
    // reset from (an older Automatic left them); they are no choice of the user's, so the entry's format starts clean.
    if (s) for (const k of FORMAT_DETAIL_KEYS) delete s[k];
    s = { ...(s || {}), fmt, ...(cur ? { cur } : {}), ...(dateStyle ? { dateStyle } : {}) };
    // The decimals, seconds or fraction code the text was typed with refine only the format this entry
    // implied: a cell already set to Percent, Number or Time keeps its own decimals and seconds.
    refineImpliedFormat(s, fmt, text);
  }
  return v == null && f == null && !s ? null : { v, f, s };
}

/** Calculated-column offsets after `n` columns are inserted (or removed) at absolute column `at`; `c1` is the table's first column. */
function shiftCalc(calc, c1, at, n, remove) {
  const out = {};
  for (const [k, f] of Object.entries(calc || {})) {
    const abs = c1 + Number(k);
    if (remove) {
      if (abs >= at && abs < at + n) continue;
      const nc1 = c1 >= at + n ? c1 - n : c1 >= at ? at : c1;
      out[(abs >= at + n ? abs - n : abs) - nc1] = f;
    } else {
      const nc1 = c1 >= at ? c1 + n : c1;
      out[(abs >= at ? abs + n : abs) - nc1] = f;
    }
  }
  return out;
}

/**
 * A sheet's outline settings, kept only where they differ from the defaults: summary rows below their detail and
 * summary columns to its right (the outline buttons sit on the summary line), and automatic styles off.
 */
export function normalizeOutlineSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (raw.summaryBelow === false) out.summaryBelow = false;
  if (raw.summaryRight === false) out.summaryRight = false;
  if (raw.autoStyles === true) out.autoStyles = true;
  return Object.keys(out).length ? out : null;
}

/** The outline settings in force on a sheet, every field spelt out. */
export function outlineSettingsOf(sheet) {
  const s = sheet?.outlineSettings || {};
  return { summaryBelow: s.summaryBelow !== false, summaryRight: s.summaryRight !== false, autoStyles: s.autoStyles === true };
}

/** Outline groups: { rows: [{ from, to, collapsed }], cols: [...] }, sorted, sane. */
function normalizeGroups(raw) {
  // Collapsing and expanding iterate every line. File metadata must never
  // introduce bounds outside the format's grid (including huge finite values).
  const clean = (list, max) => (Array.isArray(list) ? list : [])
    .map((g) => ({ from: Math.max(0, Math.trunc(Number(g?.from))), to: Math.trunc(Number(g?.to)), collapsed: !!g?.collapsed }))
    .filter((g) => Number.isFinite(g.from) && Number.isFinite(g.to) && g.to >= g.from && g.to <= max)
    .sort((a, b) => a.from - b.from || b.to - a.to);
  return { rows: clean(raw?.rows, MAX_ROW), cols: clean(raw?.cols, MAX_COL) };
}

/**
 * Text is sorted the way a dictionary orders it, accented letters beside their base letters, rather
 * than by code point, which would put every "É" after "z". The collators are kept: building one is
 * far costlier than a comparison, and a sort makes thousands.
 */
const collators = {};
function textCollator(caseSensitive) {
  const key = caseSensitive ? 'variant' : 'accent';
  // Case-insensitive sorting still tells "e" from "é" (accent); the case-sensitive option puts lowercase first.
  collators[key] ??= new Intl.Collator(undefined, { sensitivity: key, caseFirst: 'lower' });
  return collators[key];
}

/** Sort order for one key: blanks and errors last, text by locale (optionally case-sensitive, lowercase first), other values by compareStoredValues. */
function sortComparator(caseSensitive) {
  const empty = (v) => v == null || v === '';
  const collator = textCollator(caseSensitive);
  return (a, b, ascending) => {
    if (empty(a) && empty(b)) return 0;
    if (empty(a)) return 1;
    if (empty(b)) return -1;
    if (isError(a) && isError(b)) return 0;
    if (isError(a)) return 1;
    if (isError(b)) return -1;
    // Pictures in cells have no order of their own: they follow the values, before errors and blanks, in either direction.
    const picture = (v) => !!v && typeof v === 'object' && typeof v.image === 'string';
    if (picture(a) || picture(b)) return picture(a) === picture(b) ? 0 : picture(a) ? 1 : -1;
    const cmp = typeof a === 'string' && typeof b === 'string' ? collator.compare(a, b) : compareStoredValues(a, b);
    return ascending ? cmp : -cmp;
  };
}

/** One answer from an async source as a cell value: numbers and booleans as they are, text trimmed, nothing as blank. */
function asyncCell(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value == null) return '';
  // An error value passes; any other object, a nested array or a date among them, is no value a cell can hold.
  if (typeof value === 'object') return 'error' in value ? value : err('#VALUE!');
  const text = String(value).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  // A cell holds MAX_TEXT characters at most, as typed input does; a surrogate pair is not cut in two.
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, '') : text;
}

/** An answer from an async source as a cell value; a block of rows (IMPORTRANGE) spills like any array. */
function asyncResult(value) {
  if (Array.isArray(value)) {
    if (!value.length) return { range: true, values: [['']] };
    const width = value.reduce((n, row) => Math.max(n, Array.isArray(row) ? row.length : 1), 0);
    if (value.length * width > 200000) return err('#NUM!');
    const values = value.map((row) => {
      const cells = (Array.isArray(row) ? row : [row]).map(asyncCell);
      while (cells.length < width) cells.push('');
      return cells;
    });
    return { range: true, values };
  }
  return asyncCell(value) ?? '';
}

/** Whether two calculation results are the same: values, errors by code, arrays cell by cell. */
function sameResult(a, b) {
  if (isRange(a) || isRange(b)) {
    if (!isRange(a) || !isRange(b)) return false;
    const A = a.values, B = b.values;
    return A.length === B.length && A.every((row, i) => row.length === B[i].length && row.every((x, j) => sameResult(x, B[i][j])));
  }
  if (isError(a) || isError(b)) return isError(a) && isError(b) && a.error === b.error;
  return a === b || (a == null && b == null);
}

function isEmptyCell(cell) {
  return !cell || (cell.v == null && cell.f == null && !cell.hyperlink && !(cell.s && Object.keys(cell.s).length));
}

/**
 * Whether two cells, as cloneCell makes them, would serialize alike: what an edit asks of every cell it
 * writes, answered field by field rather than by serializing both. A style key holding undefined is no
 * key, as it is none in JSON; a value that is an object (an error) is the rare case still compared as text.
 */
function sameCell(a, b) {
  if (a === b) return true;
  if (!a || !b || a.f !== b.f || a.hyperlink !== b.hyperlink) return false;
  if (a.externalResult !== b.externalResult && JSON.stringify(a.externalResult) !== JSON.stringify(b.externalResult)) return false;
  if (a.richText !== b.richText && JSON.stringify(a.richText) !== JSON.stringify(b.richText)) return false;
  if (a.array?.rows !== b.array?.rows || a.array?.cols !== b.array?.cols) return false;
  if (a.v !== b.v && !(a.v != null && b.v != null && typeof a.v === 'object' && typeof b.v === 'object' && JSON.stringify(a.v) === JSON.stringify(b.v))) return false;
  const sa = a.s || {}, sb = b.s || {};
  let n = 0;
  for (const k in sa) { if (sa[k] === undefined) continue; if (sa[k] !== sb[k]) return false; n++; }
  for (const k in sb) if (sb[k] !== undefined) n--;
  return n === 0;
}

// Functions that read cells their arguments do not name: INDIRECT and OFFSET reach wherever they are
// pointed, and SUMIF and AVERAGEIF read their sum range in the shape of the criteria range.
const EXTERNAL_CALLER_ORDER = Symbol('external caller sheet order');
const OPEN_READERS = new Set(['INDIRECT', 'OFFSET', 'SUMIF', 'AVERAGEIF']);

// Functions whose answer is a position or count from 1 up (or an error), and those whose answer can be
// 0: what an INDEX row or column index built from them can be is judged from its text (see _isArrayCandidate).
const POSITIVE_CALLS = new Set(['ROW', 'COLUMN', 'ROWS', 'COLUMNS', 'MATCH', 'XMATCH', 'AREAS', 'SHEET', 'SHEETS']);
const COUNT_CALLS = new Set(['COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'LEN', 'ABS']);

/**
 * The cells a formula can read, as the rectangles its references name, each with the sheet it names or
 * null for the formula's own; or null when they cannot be known from its text: a defined name or lambda
 * parameter (a bare name), a table, an unknown or sheet-qualified function, one of the OPEN_READERS, a
 * 3-D reference, or A1:INDEX(...) reaching between two references. A spill reference (A1#) is marked,
 * since how far it reaches is only known once the anchor has calculated (see _noteReads). Kept with the AST.
 */
function staticReads(ast) {
  if (ast._reads !== undefined) return ast._reads;
  const out = [];
  const walk = (node) => {
    switch (node.type) {
      case 'ref': {
        const ref = node.ref;
        if (ref.sheetEnd) return false;
        out.push({ sheet: ref.sheet || null, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2, spill: !!ref.spill });
        return true;
      }
      case 'call':
        if (node.bare || node.sheet || !FUNCTIONS[node.name] || OPEN_READERS.has(node.name)) return false;
        return node.args.every(walk);
      case 'apply': return walk(node.fn) && node.args.every(walk);
      // A chain of operators parses left-deep: its spine is walked as a list, so 1+1+… with thousands of terms does not recurse once per term.
      case 'binary': {
        let leftmost = node;
        while (leftmost.type === 'binary') { if (!walk(leftmost.right)) return false; leftmost = leftmost.left; }
        return walk(leftmost);
      }
      case 'unary': case 'percent': return walk(node.arg);
      case 'union': return node.parts.every(walk);
      case 'array': return node.rows.every((row) => row.every(walk));
      case 'num': case 'str': case 'bool': case 'err': case 'empty': return true;
      default: return false; // 'range', 'tref', and whatever else
    }
  };
  ast._reads = walk(ast) ? out : null;
  return ast._reads;
}

/** The rows and columns a sheet's cells may occupy: the grid's limits, or the sheet's own size when a file brought a larger one. */
function gridLimits(sheet) {
  return { rows: Math.max(sheet.rows, MAX_ROWS), cols: Math.max(sheet.cols, MAX_COLS) };
}

function fontPatch(patch) {
  return Object.hasOwn(patch, 'font') && !Object.hasOwn(patch, 'scheme')
    ? { ...patch, scheme: patch.font == null ? null : 'none' } : patch;
}

/** The style keys an entry may change in an unlocked cell of a protected sheet: the number format typing implies, and the mark itself. */
const ENTRY_FORMAT_KEYS = new Set(['fmt', 'dec', 'dateStyle', 'code', 'sec', 'cur', 'group', 'locked']);
/** Does a write change no formatting but what typing a value implies? Formatting stays protected. */
function contentOnly(before, after) {
  if (after === undefined) return true;
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) if (!ENTRY_FORMAT_KEYS.has(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) return false;
  return true;
}

/**
 * A style with a formatting patch merged in, as applyStyle applies one: a key the app does not know is
 * ignored, and null (or false, except for grouping, which defaults to on) takes a key away rather than
 * being stored. A reset over an inherited value is kept explicitly, or the line's format would
 * immediately show through again. Undefined when nothing is left.
 */
function styleWithPatch(base, patch, inherited = null) {
  patch = nativeFillPatch(fontPatch(patch));
  const s = { ...(base || {}) };
  for (const [k, val] of Object.entries(patch)) {
    if (!STYLE_KEYS.includes(k)) continue;
    // Cell protection: locked is the default, so only an unlocked cell carries the key; Hidden is stored only when on.
    if (k === 'locked') { if (val === false) s.locked = false; else delete s.locked; continue; }
    if (k === 'formulaHidden') { if (val === true) s.formulaHidden = true; else delete s.formulaHidden; continue; }
    if (['bt', 'bb', 'bl', 'br'].includes(k) && !val) delete s[`${k}Border`];
    if (k === 'bc' || k === 'bs') for (const side of ['bt', 'bb', 'bl', 'br']) {
      if (s[`${side}Border`]) s[`${side}Border`] = { ...s[`${side}Border`], [k]: val || null };
    }
    if (val == null || (val === false && k !== 'group')) {
      if (inherited?.[k] != null) s[k] = k === 'code' ? '' : null;
      else delete s[k];
    }
    else if (k === 'color' && typeof val === 'object') { const color = normalizeFontColor(val); if (color) s[k] = color; }
    else if (k === 'bg' && typeof val === 'object') { const color = normalizeFillColor(val); if (color) s[k] = color; }
    else s[k] = val;
  }
  return Object.keys(s).length ? cloneStyle(s) : undefined;
}

const isNumberFormatKey = (key) => key === 'fmt' || FORMAT_DETAIL_KEYS.includes(key);
const removesStyleKey = (key, value) => value == null || (value === false && key !== 'group');

/** A cell's style with a patch applied: a key set to null takes that style away, as applyStyle does, rather than being stored as null. */
function patchedStyle(base, patch) {
  patch = nativeFillPatch(patch);
  const s = { ...(base || {}) };
  for (const [k, val] of Object.entries(patch)) {
    if (val == null) delete s[k];
    else if (k === 'color' && typeof val === 'object') { const color = normalizeFontColor(val); if (color) s[k] = color; }
    else if (k === 'bg' && typeof val === 'object') { const color = normalizeFillColor(val); if (color) s[k] = color; }
    else s[k] = val;
  }
  return Object.keys(s).length ? s : undefined;
}

/** Is (r, c) a cell of the grid with these limits? A cell past its edge would be stored where no view, export or reference reaches. */
function inGrid(r, c, limit) {
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < limit.rows && c < limit.cols;
}

/** Metadata ranges must fit the file format's grid before they drive loops or references. */
function validStoredRange(range) {
  return !!range && ['r1', 'r2'].every((key) => Number.isInteger(range[key]) && range[key] >= 0 && range[key] <= MAX_ROW)
    && ['c1', 'c2'].every((key) => Number.isInteger(range[key]) && range[key] >= 0 && range[key] <= MAX_COL);
}

/** Imported filters run immediately on load; reject unsafe bounds and criteria first. */
function normalizeFilter(raw) {
  const range = raw?.range;
  if (!validStoredRange(range)) return null;
  const n = normalizeRange(range);
  const criteria = {};
  const source = raw.criteria && typeof raw.criteria === 'object' && !Array.isArray(raw.criteria) ? raw.criteria : {};
  for (const [key, criterion] of Object.entries(source)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) < n.c1 || Number(key) > n.c2) continue;
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) continue;
    if ('values' in criterion && (!Array.isArray(criterion.values) || !criterion.values.every((v) => typeof v === 'string'))) continue;
    if (['op', 'formula', 'text', 'color'].some((key) => key in criterion && typeof criterion[key] !== 'string')) continue;
    // The keys beside a value filter's texts (see _filterValueKeys) are a list of strings or nothing: an odd
    // shape is dropped on its own, and the texts still judge the rows.
    const { keys, ...rest } = criterion;
    criteria[key] = Array.isArray(keys) && keys.every((v) => typeof v === 'string') ? { ...criterion } : rest;
  }
  const hiddenButtons = Array.isArray(raw.hiddenButtons)
    ? [...new Set(raw.hiddenButtons.filter(c => Number.isInteger(c) && c >= n.c1 && c <= n.c2))].sort((a, b) => a - b) : [];
  return { range: n, criteria, ...(raw.showButtons === false ? { showButtons: false } : {}), ...(hiddenButtons.length ? { hiddenButtons } : {}) };
}

/**
 * A whole column's or row's default format as a file or a snapshot may store it: only the style keys the
 * app knows, sanitized the way a cell's own style is, and nothing at all when none are left.
 */
function lineStyle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = {};
  for (const k of STYLE_KEYS) if (Object.hasOwn(raw, k)) s[k] = raw[k];
  return Object.keys(s).length ? (cloneCell({ v: null, f: null, s }).s ?? null) : null;
}

/** Keep fixed drawings in sheet coordinates, including after a drag supplied a cell anchor. */
function absoluteDrawingAnchor(sheet, chart) {
  if (chart && sheet.kind === 'chart') { chart = { ...chart, anchorMode: 'absolute' }; delete chart.cellAnchor; }
  if (!chart || chart.anchorMode !== 'absolute' || !chart.anchor.r && !chart.anchor.c) return chart;
  const offset = (count, sizes, fallback, hidden, filtered = new Set()) => {
    let pixels = count * fallback;
    for (const [i, size] of sizes) if (i < count) pixels += size - fallback;
    for (const i of new Set([...hidden, ...filtered])) if (i < count) pixels -= sizes.get(i) ?? fallback;
    return pixels;
  };
  return { ...chart, anchor: { r: 0, c: 0 },
    dx: chart.dx + offset(chart.anchor.c, sheet.colWidths, sheet.defaultColWidth, sheet.hiddenCols),
    dy: chart.dy + offset(chart.anchor.r, sheet.rowHeights, sheet.defaultRowHeight, sheet.hiddenRows, sheet.filterHidden),
    ...(['image', 'text', 'smartart'].includes(chart.type) ? { range: { r1: 0, c1: 0, r2: 0, c2: 0 } } : {}) };
}

/**
 * A sheet's sheet views (View ▸ Sheet View) as saved: the one this person is in takes the filters on show,
 * and a temporary view nobody kept stays out of a file.
 */
function sheetViewsJSON(s, live) {
  return s.sheetViews.filter((v) => live || !v.temporary).map((v) => {
    const active = s.personalView?.id === v.id;
    return { id: v.id, name: v.name, ...(v.temporary ? { temporary: true } : {}),
      filter: copyFilter(active ? s.filter : v.filter) || null, otherFilters: ((active ? s.otherFilters : v.otherFilters) || []).map(copyFilter) };
  });
}

/** Sheet views as stored: a name each (unique on the sheet), and filters that pass the sheet's own checks. */
function normalizeSheetViews(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, 256).filter((v) => v && typeof v.name === 'string' && v.name.trim() && typeof v.id === 'string' && v.id).flatMap((v) => {
    const name = v.name.trim().slice(0, 255);
    if (seen.has(name.toLowerCase()) || seen.has(`#${v.id}`)) return [];
    seen.add(name.toLowerCase()); seen.add(`#${v.id}`);
    return [{ id: v.id.slice(0, 64), name, ...(v.temporary === true ? { temporary: true } : {}),
      filter: normalizeFilter(v.filter), otherFilters: (Array.isArray(v.otherFilters) ? v.otherFilters : []).map(normalizeFilter).filter(Boolean) }];
  });
}

/** The views a worksheet can be shown in (CT_SheetView's view: normal, pageLayout, pageBreakPreview). */
export const SHEET_VIEW_MODES = ['normal', 'pageLayout', 'pageBreak'];

export function makeSheet({ id, name, kind, rows, cols, colWidths, rowHeights, rowHeightModes, defaultColWidth, defaultRowHeight, nativeWidths, nativeDefaultHeight, colStyles, rowStyles, styleResets, ignoredErrors, cells, frozenRows, frozenCols, hiddenRows, hiddenCols, merges, notes, rules, validations, color, filter, otherFilters, filterHidden, hidden, veryHidden, charts, sparklineGroups, protected: locked, groups, gridlines, headers, rightToLeft, defaultVAlign, zeros, viewZoom, viewSelection, viewOrigin, frozenOrigin, split, viewMode, zoomToFit, printSettings, protectedRanges, tables, scenarios, outlineSettings, showPageBreaks, background, sheetViews, personalView, freshIds = false }) {
  // Optional metadata from a file may be malformed. An invalid collection
  // must not prevent the workbook's actual cell data from opening.
  const arrayOrEmpty = (value) => Array.isArray(value) ? value : [];
  // A table, chart, rule, validation, or protected range is told apart by its id, so a sheet copied
  // beside its original (duplicated, imported, or replacing another) gets new ones; a file keeps its own.
  const idOf = (stored) => (freshIds ? null : stored) || newId();
  const selection = kind === 'chart' ? null : normalizeSheetSelection(viewSelection);
  const origin = kind === 'chart' ? null : normalizeSheetOrigin(viewOrigin);
  const frozenStart = kind === 'chart' ? null : normalizeSheetOrigin(frozenOrigin);
  const freezeRows = Math.max(0, Math.min(50, frozenRows | 0)), freezeCols = Math.max(0, Math.min(20, frozenCols | 0));
  if (frozenStart) {
    frozenStart.r = freezeRows ? Math.min(frozenStart.r, MAX_ROW - freezeRows) : 0;
    frozenStart.c = freezeCols ? Math.min(frozenStart.c, MAX_COL - freezeCols) : 0;
  }
  const widths = normalizeNativeWidths(nativeWidths);
  const defaultHeight = normalizeNativeDefaultHeight(nativeDefaultHeight);
  // A split window and frozen panes exclude each other: the frozen panes win.
  const splitView = kind === 'chart' || freezeRows || freezeCols ? null : normalizeSplit(split);
  const sheet = {
    ...(selection ? { viewSelection: selection } : {}),
    ...(splitView ? { split: splitView } : {}),
    ...(origin ? { viewOrigin: origin } : {}),
    ...(frozenStart ? { frozenOrigin: frozenStart } : {}),
    ...(widths ? { nativeWidths: widths } : {}),
    ...(defaultHeight ? { nativeDefaultHeight: defaultHeight } : {}),
    id: id || newId(),
    // A name is text, and a size stays within the grid, whatever a stored file says.
    name: typeof name === 'string' && name ? name : String(name ?? '') || 'Sheet',
    ...(kind === 'chart' ? { kind: 'chart', zoomToFit: zoomToFit === true } : {}),
    // Imported sheets may exceed the interactive growth limits, but never the file format's grid.
    rows: Math.min(MAX_ROW + 1, Math.max(origin ? origin.r + 1 : 1, frozenStart ? frozenStart.r + freezeRows + 1 : 1, selection ? selection.ranges.reduce((n, r) => Math.max(n, r.r1 === 0 && r.r2 === MAX_ROW ? selection.active.r + 1 : r.r2 + 1), 1) : 1, Number.isFinite(Number(rows)) && Number(rows) > 0 ? Math.trunc(Number(rows)) : DEFAULT_ROWS)),
    cols: Math.min(MAX_COL + 1, Math.max(origin ? origin.c + 1 : 1, frozenStart ? frozenStart.c + freezeCols + 1 : 1, selection ? selection.ranges.reduce((n, r) => Math.max(n, r.c1 === 0 && r.c2 === MAX_COL ? selection.active.c + 1 : r.c2 + 1), 1) : 1, Number.isFinite(Number(cols)) && Number(cols) > 0 ? Math.trunc(Number(cols)) : DEFAULT_COLS)),
    color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : null,
    hidden: !!hidden,
    veryHidden: !!veryHidden,
    protected: !!locked,
    groups: normalizeGroups(groups),
    ...(normalizeOutlineSettings(outlineSettings) ? { outlineSettings: normalizeOutlineSettings(outlineSettings) } : {}),
    gridlines: gridlines !== false,
    headers: headers !== false,
    rightToLeft: rightToLeft === true,
    ...(['top', 'middle', 'bottom'].includes(defaultVAlign) ? { defaultVAlign } : {}),
    zeros: zeros !== false,
    ...(Number.isFinite(viewZoom) && viewZoom >= .1 && viewZoom <= 4 ? { viewZoom } : {}),
    ...(kind !== 'chart' && SHEET_VIEW_MODES.includes(viewMode) && viewMode !== 'normal' ? { viewMode } : {}),
    ...(kind !== 'chart' && showPageBreaks === true ? { showPageBreaks: true } : {}),
    ...(kind !== 'chart' && normalizeBackground(background) ? { background: normalizeBackground(background) } : {}),
    // View ▸ Sheet View: the sheet's named filter views; personalView is the one this person is in (undo snapshots only).
    ...(kind !== 'chart' && normalizeSheetViews(sheetViews).length ? { sheetViews: normalizeSheetViews(sheetViews) } : {}),
    printSettings: normalizePrintSettings(printSettings),
    filter: normalizeFilter(filter),
    otherFilters: arrayOrEmpty(otherFilters).map(normalizeFilter).filter(Boolean),
    filterHidden: new Set((Array.isArray(filterHidden) ? filterHidden : []).filter(r => Number.isInteger(r) && r >= 0 && r <= MAX_ROW)),
    frozenRows: freezeRows,
    frozenCols: freezeCols,
    colWidths: new Map(),
    rowHeights: new Map(),
    rowHeightModes: new Map(Object.entries(rowHeightModes || {}).filter(([r, mode]) => /^\d+$/.test(r) && Number(r) <= MAX_ROW && ['auto', 'fixed'].includes(mode)).map(([r, mode]) => [Number(r), mode])),
    defaultColWidth: Number.isFinite(defaultColWidth) && defaultColWidth > 0 ? Math.max(1, Math.min(MAX_STORED_COL_WIDTH, defaultColWidth)) : DEFAULT_COL_WIDTH,
    defaultRowHeight: Number.isFinite(defaultRowHeight) && defaultRowHeight > 0 ? Math.max(1, Math.min(MAX_STORED_ROW_HEIGHT, defaultRowHeight)) : DEFAULT_ROW_HEIGHT,
    // A whole column's or row's format, kept on the line so it holds for lines the sheet has not reached yet.
    colStyles: new Map(),
    rowStyles: new Map(),
    // Clear formats can exclude a large block from those defaults without storing blank cells.
    styleResets: readStyleResets(styleResets),
    ignoredErrors: normalizeIgnoredErrors(ignoredErrors),
    hiddenRows: new Set((hiddenRows || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_ROW)),
    hiddenCols: new Set((hiddenCols || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_COL)),
    merges: (merges || []).map((m) => normalizeRange(m)).filter((m) => validStoredRange(m) && (m.r1 !== m.r2 || m.c1 !== m.c2)),
    notes: new Map(Object.entries(notes || {}).filter(([, t]) => typeof t === 'string' && t.trim())),
    // Threaded comments (see comments.js); a copied sheet's threads get ids of their own.
    comments: (freshIds ? freshCommentIds : readComments)(arguments[0]?.comments),
    rules: arrayOrEmpty(rules).filter((r) => r && validStoredRange(r.range) && r.type).map((r) => ({ ...r, id: idOf(r.id), range: normalizeRange(r.range), style: cloneStyle(r.style),
      // Colors reach CSS strings, so only plain hex colors survive the file.
      ...(r.barColor != null ? { barColor: barColorOf(r) } : {}) })),
    protectedRanges: arrayOrEmpty(protectedRanges).filter((p) => p && validStoredRange(p.range)).map((p) => ({ id: idOf(p.id), range: normalizeRange(p.range), description: p.description || '' })),
    scenarios: normalizeScenarios(scenarios),
    validations: arrayOrEmpty(validations).filter((v) => v && validStoredRange(v.range) && v.type).map((v) => ({ ...v, id: idOf(v.id), range: normalizeRange(v.range) })),
    sparklineGroups: normalizeNativeSparklineGroups(sparklineGroups || []).map(group => ({
      ...group, uid: freshIds || !group.uid ? `{${crypto.randomUUID().toUpperCase()}}` : group.uid,
    })),
    charts: arrayOrEmpty(charts).map(normalizeChart).filter(Boolean).map((ch) => {
      if (freshIds && ch.type === 'slicer') { delete ch.nativeName; delete ch.nativeCacheName; }
      return { ...ch, id: idOf(ch.id) };
    }),
    tables: arrayOrEmpty(tables).filter((t) => t && validStoredRange(t.range) && typeof t.name === 'string' && t.name.trim()).map((t) => ({
      id: idOf(t.id), name: t.name.trim(), range: normalizeRange(t.range), totalsRow: !!t.totalsRow,
      style: typeof t.style === 'string' ? t.style : 'blue', banded: t.banded !== false,
      ...(t.firstColumn === true ? { firstColumn: true } : {}),
      ...(t.lastColumn === true ? { lastColumn: true } : {}),
      ...(t.bandedColumns === true ? { bandedColumns: true } : {}),
      ...normalizeTableHeaderState(t),
      ...(t.customStyle ? { customStyle: normalizeCustomTableStyle(t.customStyle) } : {}),
      // Templates normally start at the first data row. An explicit origin
      // follows structural edits without losing relative cross-sheet refs.
      ...(Number.isInteger(t.calcRow) && t.calcRow >= 0 ? { calcRow: t.calcRow } : {}),
      ...(t.calcArray && typeof t.calcArray === 'object' ? { calcArray: Object.fromEntries(Object.entries(t.calcArray).filter(([k, v]) => /^\d+$/.test(k) && v === true && typeof t.calc?.[k] === 'string')) } : {}),
      calc: Object.fromEntries(Object.entries(t.calc && typeof t.calc === 'object' ? t.calc : {}).filter(([k, f]) => /^\d+$/.test(k) && typeof f === 'string')),
    })).filter((t) => t.range.r2 >= t.range.r1 && t.range.c2 >= t.range.c1),
    cells: new Map(),
  };
  if (personalView && sheet.sheetViews?.some((v) => v.id === personalView.id)) {
    sheet.personalView = { id: personalView.id, saved: { filter: normalizeFilter(personalView.saved?.filter),
      otherFilters: (Array.isArray(personalView.saved?.otherFilters) ? personalView.saved.otherFilters : []).map(normalizeFilter).filter(Boolean) } };
  }
  const filterRanges = new Set([filterRangeKey(sheet.filter)]);
  sheet.otherFilters = sheet.otherFilters.filter(f => {
    const key = filterRangeKey(f);
    if (filterRanges.has(key)) return false;
    filterRanges.add(key); return true;
  });
  const filterContexts = sheetFilters(sheet);
  sheet.filterHidden = new Set([...sheet.filterHidden].filter(r => filterContexts.some(f => r > f.range.r1 && r <= f.range.r2)));
  // Sizes come from files and drafts: only finite numbers within the grid's own limits count.
  for (const [k, w] of Object.entries(colWidths || {})) if (/^\d+$/.test(k) && Number(k) <= MAX_COL && Number.isFinite(Number(w))) sheet.colWidths.set(Number(k), Number(w) > 0 ? Math.max(1, Math.min(MAX_STORED_COL_WIDTH, Number(w))) : 24);
  for (const [k, h] of Object.entries(rowHeights || {})) if (/^\d+$/.test(k) && Number(k) <= MAX_ROW && Number.isFinite(Number(h))) sheet.rowHeights.set(Number(k), Number(h) > 0 ? Math.max(1, Math.min(MAX_STORED_ROW_HEIGHT, Number(h))) : 18);
  for (const [k, s] of Object.entries(colStyles || {})) { const st = /^\d+$/.test(k) && Number(k) <= MAX_COL ? lineStyle(s) : null; if (st) sheet.colStyles.set(Number(k), st); }
  for (const [k, s] of Object.entries(rowStyles || {})) { const st = /^\d+$/.test(k) && Number(k) <= MAX_ROW ? lineStyle(s) : null; if (st) sheet.rowStyles.set(Number(k), st); }
  for (const [k, cell] of Object.entries(cells || {})) {
    const c = cloneCell(cell);
    if (!isEmptyCell(c)) sheet.cells.set(k, c);
  }
  for (const group of sheet.sparklineGroups) for (const spark of group.sparklines) {
    const ref = parseRefText(spark.ref); sheet.rows = Math.max(sheet.rows, ref.r1 + 1); sheet.cols = Math.max(sheet.cols, ref.c1 + 1);
  }
  sheet.charts = sheet.charts.map(ch => absoluteDrawingAnchor(sheet, ch));
  refreshCellDrawings(sheet);
  return sheet;
}

/* Fill-handle series for names: Jan → Feb, Monday → Tuesday, Q1 → Q2. */
const SERIES = [
  ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  ['q1', 'q2', 'q3', 'q4'],
];

function applyCase(word, like) {
  if (like === like.toUpperCase() && like !== like.toLowerCase()) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/**
 * Recognize a run of names from one calendar sequence. Returns
 * { seq, start, step, like } or null. A single name counts, with step 1.
 */
export function textSeriesFor(values) {
  if (!values.length || !values.every((v) => typeof v === 'string' && v.trim())) return null;
  const lower = values.map((v) => v.trim().toLowerCase());
  for (const seq of SERIES) {
    const idx = lower.map((v) => seq.indexOf(v));
    if (idx.some((i) => i < 0)) continue;
    // "may" is in both month lists; prefer the one that fits every value.
    if (idx.length === 1) return { seq, start: idx[0], step: 1, like: values[0].trim() };
    const L = seq.length;
    const step = ((idx[1] - idx[0]) % L + L) % L;
    if (step === 0) continue;
    const ok = idx.every((i, k) => k === 0 || i === (idx[k - 1] + step) % L);
    if (ok) return { seq, start: idx[0], step, like: values[0].trim() };
  }
  return null;
}

const URL_RE = /^(https?:\/\/|ftp:\/\/|mailto:|www\.)[^\s]+$/i;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A URL the browser can open, or null when the text is not one. */
export function textUrl(text) {
  const t = String(text || '').trim();
  // Browsers drop embedded control characters when parsing a URL's scheme, as safeLinkUrl also guards.
  if (!t || /[\s\x00-\x1f\x7f]/.test(t)) return null;
  if (URL_RE.test(t)) return normalizeUrl(t);
  if (URL_SCHEME_RE.test(t)) return null;
  // A sheet-reference separator follows the sheet name; # and ! can also occur in an email local part.
  if (t.startsWith('#') && t.lastIndexOf('!') > t.lastIndexOf('@')) return null;
  if (EMAIL_RE.test(t)) return `mailto:${t}`;
  return null;
}

export function normalizeUrl(url) {
  const t = String(url).trim();
  // Explicit URLs and workbook locations must not be reclassified as email addresses.
  if (t.startsWith('#') || URL_SCHEME_RE.test(t)) return t;
  if (/^www\./i.test(t)) return `https://${t}`;
  if (EMAIL_RE.test(t)) return `mailto:${t}`;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(t)) return `https://${t}`;
  return t;
}

/** Only workbook locations and ordinary network links may become clickable. */
export function safeLinkUrl(url) {
  const normalized = normalizeUrl(url);
  // Browsers remove embedded tabs/newlines when parsing a URL's scheme.
  if (/[\x00-\x1f\x7f]/.test(normalized)) return null;
  if (normalized.startsWith('#')) return normalized;
  return /^(?:https?:\/\/|ftp:\/\/|mailto:)/i.test(normalized) ? normalized : null;
}

/**
 * A sheet as toJSON writes it, apart from its cells; makeSheet reads the same shape back. A file gets the
 * sheet as everyone sees it: while this person is in a sheet view (View ▸ Sheet View), the default view's
 * filters, with the view's own kept among the sheet's views, and `defaultHidden` gives the rows those
 * filters hide. `live` is the state as it stands, the person's view included (undo snapshots, copies).
 */
export function sheetShapeJSON(s, { live = false, defaultHidden = null } = {}) {
  const personal = !live && s.personalView ? s.personalView : null;
  const shown = personal ? { filter: personal.saved.filter || null, otherFilters: personal.saved.otherFilters || [] } : s;
  const hiddenByFilter = personal ? defaultHidden?.(s) || null : s.filterHidden;
  return {
    id: s.id,
    name: s.name,
    ...(s.kind === 'chart' ? { kind: 'chart', zoomToFit: !!s.zoomToFit } : {}),
    rows: s.rows,
    cols: s.cols,
    frozenRows: s.frozenRows,
    frozenCols: s.frozenCols,
    color: s.color,
    hidden: s.hidden || undefined,
    veryHidden: s.veryHidden || undefined,
    protected: s.protected || undefined,
    gridlines: s.gridlines === false ? false : undefined,
    headers: s.headers === false ? false : undefined,
    rightToLeft: s.rightToLeft || undefined,
    ...(s.defaultVAlign ? { defaultVAlign: s.defaultVAlign } : {}),
    zeros: s.zeros === false ? false : undefined,
    ...(s.viewZoom != null ? { viewZoom: s.viewZoom } : {}),
    ...(s.viewMode ? { viewMode: s.viewMode } : {}),
    ...(s.showPageBreaks ? { showPageBreaks: true } : {}),
    ...(s.background ? { background: { ...s.background } } : {}),
    ...(s.viewSelection ? { viewSelection: normalizeSheetSelection(s.viewSelection) } : {}),
    ...(s.viewOrigin ? { viewOrigin: normalizeSheetOrigin(s.viewOrigin) } : {}),
    ...(s.frozenOrigin ? { frozenOrigin: normalizeSheetOrigin(s.frozenOrigin) } : {}),
    ...(s.split ? { split: normalizeSplit(s.split) } : {}),
    printSettings: s.printSettings ? normalizePrintSettings(s.printSettings) : undefined,
    groups: s.groups.rows.length || s.groups.cols.length ? { rows: s.groups.rows.map((g) => ({ ...g })), cols: s.groups.cols.map((g) => ({ ...g })) } : undefined,
    ...(s.outlineSettings ? { outlineSettings: { ...s.outlineSettings } } : {}),
    filter: shown.filter ? copyFilter(shown.filter) : null,
    ...(shown.otherFilters?.length ? { otherFilters: shown.otherFilters.map(copyFilter) } : {}),
    ...(sheetFilters(shown).length && hiddenByFilter ? { filterHidden: [...hiddenByFilter] } : {}),
    ...(s.sheetViews?.length ? { sheetViews: sheetViewsJSON(s, live) } : {}),
    ...(live && s.personalView ? { personalView: { id: s.personalView.id, saved: { filter: copyFilter(s.personalView.saved.filter) || null, otherFilters: (s.personalView.saved.otherFilters || []).map(copyFilter) } } } : {}),
    hiddenRows: [...s.hiddenRows].sort((a, b) => a - b),
    hiddenCols: [...s.hiddenCols].sort((a, b) => a - b),
    merges: s.merges.map((m) => ({ ...m })),
    notes: Object.fromEntries(s.notes),
    comments: commentsJSON(s.comments),
    rules: s.rules.map((r) => ({ ...r, range: { ...r.range }, style: { ...r.style } })),
    protectedRanges: s.protectedRanges.length ? s.protectedRanges.map((p) => ({ ...p, range: { ...p.range } })) : undefined,
    ...(s.scenarios ? { scenarios: copyScenarios(s.scenarios) } : {}),
    validations: s.validations.map((v) => ({ ...v, range: { ...v.range } })),
    ...(s.sparklineGroups.length ? { sparklineGroups: normalizeNativeSparklineGroups(s.sparklineGroups) } : {}),
    charts: s.charts.map((ch) => ({ ...ch, ...(ch.cellAnchor ? { cellAnchor: normalizeCellAnchor(ch.cellAnchor) } : {}), range: { ...ch.range }, anchor: { ...ch.anchor } })),
    tables: s.tables.length ? s.tables.map((t) => ({ ...t, range: { ...t.range }, ...(t.calc ? { calc: { ...t.calc } } : {}), ...(t.calcArray ? { calcArray: { ...t.calcArray } } : {}) })) : undefined,
    colWidths: Object.fromEntries(s.colWidths),
    ...(s.nativeWidths ? { nativeWidths: normalizeNativeWidths(s.nativeWidths) } : {}),
    ...(s.nativeDefaultHeight ? { nativeDefaultHeight: normalizeNativeDefaultHeight(s.nativeDefaultHeight) } : {}),
    rowHeights: Object.fromEntries(s.rowHeights),
    ...(s.rowHeightModes.size ? { rowHeightModes: Object.fromEntries(s.rowHeightModes) } : {}),
    ...(s.defaultColWidth !== DEFAULT_COL_WIDTH ? { defaultColWidth: s.defaultColWidth } : {}),
    ...(s.defaultRowHeight !== DEFAULT_ROW_HEIGHT ? { defaultRowHeight: s.defaultRowHeight } : {}),
    colStyles: s.colStyles.size ? Object.fromEntries([...s.colStyles].map(([i, st]) => [i, cloneStyle(st)])) : undefined,
    rowStyles: s.rowStyles.size ? Object.fromEntries([...s.rowStyles].map(([i, st]) => [i, cloneStyle(st)])) : undefined,
    ...(s.ignoredErrors.length ? { ignoredErrors: normalizeIgnoredErrors(s.ignoredErrors) } : {}),
    styleResets: s.styleResets.length ? s.styleResets.map(({ range, keys, values }) => ({ range: { ...range }, keys: [...keys], ...(values ? { values: cloneStyle(values) } : {}) })) : undefined,
  };
}

/** The sheet list as an undo snapshot holds it: each sheet's id, with the name and hidden state a step on the list changes. */
const sheetListEntry = (s) => ({ id: s.id, name: s.name, hidden: s.hidden, veryHidden: s.veryHidden });

/** Whether two values as toJSON writes them are alike: the same keys and, key by key, the same values. */
export function sameJSON(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameJSON(x, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameJSON(a[k], b[k]));
}

/** What a validation rule's readers assume for a key it does not carry (see checkValue and the editor's strict check). */
const VALIDATION_DEFAULTS = { allowBlank: true, strict: true, chips: false, colors: {}, min: null, max: null, source: '', message: '', prompt: '', relativeSource: false };

/** What a conditional-format rule's readers assume for a key it does not carry (see condformat.js). */
const RULE_DEFAULTS = {
  style: {}, value: null, value2: null,
  header: true, headerColor: (rule) => rule.color1 || '#e0ecff', color1: null, color2: null,
  from: '#ffffff', to: '#4a8dff', mid: null,
  barColor: DEFAULT_BAR_COLOR, set: 'arrows', lo: 33, hi: 67, iconOnly: false, iconReverse: false, iconCustom: false,
  ...Object.fromEntries(ICON_FORMULAS.map(key => [`${key}Gte`, true])),
};

/**
 * Would saving `next` over the stored rule change it? Compared key by key against what the readers assume
 * for a key the stored rule does not carry, so a caller that writes out every field of its form — a dialog,
 * an importer, a script — records no undo step and leaves the document clean by naming a default the stored
 * rule simply left out. A key handed in as undefined counts as absent, as it does once the rule is saved.
 */
function sameRule(stored, next, defaults) {
  const read = (rule, key) => {
    if (rule[key] !== undefined) return rule[key];
    const fallback = defaults[key];
    return typeof fallback === 'function' ? fallback(stored) : fallback;
  };
  for (const key of new Set([...Object.keys(stored), ...Object.keys(next)])) {
    if (!sameJSON(read(stored, key), read(next, key))) return false;
  }
  return true;
}

/** The calculation's working state, set aside while a data table calculates with substituted inputs. */
const SUBSTITUTE_STATE = ['_iterationReady', '_cache', '_rangeCache', '_rangeCacheCells', '_rangeRuns', '_usedCache', '_cellBoundsCache', '_statsCache',
  '_volatile', '_spills', '_spillBuilds', '_hasDeferredSpills', '_spillComputed', '_evaluating', '_cyclic', '_provisional', '_blankProvisional',
  '_blankKeys', '_unsettled', '_tentative', '_grown'];

/** The workbook's settings beside its sheets and their active one (see bookState): what a file holds of the book itself. */
export const BOOK_STATE_KEYS = ['dataModel', 'nativePivots', 'externalWorkbooks', 'iteration', 'calcMode', 'structureProtected', 'queries', 'watches',
  'calculationCompatibility', 'colorPalette', 'fontTheme', 'themeInfo', 'normalFont', 'nativeNormalStyle', 'nativeNormalFill', 'nativeDefaultCellFormat', 'names',
  'scripts', 'cellStyles', 'linkStartup', 'customViews'];

export class Workbook extends EventTarget {
  /** Async sources for functions like AI(): name → (text) => Promise<string>. Answers are cached per prompt. */
  _asyncProviders = new Map();
  _asyncCache = new Map();
  _snapshotBudget = SNAPSHOT_CELLS;
  _fixedArrayIndexes = new WeakMap();
  /** Sheet settings a sheet added in this session starts with (see addSheet); never saved. */
  newSheetDefaults = null;

  constructor(json = null) {
    super();
    this._history = [];
    this._future = [];
    this._snapshotCells = 0; // cells the steps in the history hold: structural snapshots, and cell steps' before-and-after pairs
    this._captures = []; // the structural steps under way, each noting the sheets changed under it (see _capture)
    this._changeLog = []; // the last changes, each against the version it made (see changesSince)
    this._group = null;
    this._cache = new Map();
    this._rangeCache = new Map(); // range address → the values array last read, per calculation
    this._rangeCacheCells = 0; // cells held by those arrays in all
    this._rangeRuns = new Map(); // "sheet|r1,c1,c2" → the furthest r2 read of that family, per calculation
    this._astCache = new Map();
    this._evaluating = new Set();
    this._cyclic = new Set(); // cells found on a circle of references while they were being calculated
    this._provisional = new Map(); // reader cell → the circle whose provisional value it read, settled once it has its answer
    this._blankProvisional = 0; // while a reader is calculated again with provisional cells read as blank
    this._blankKeys = null; // the cells read as blank while the outermost cell of a circle is calculated again (see _judgeCircles)
    this._astByCell = new WeakMap(); // cell → { f, ast }: filled-down formulas are all distinct strings, so the text cache alone thrashes
    this.externalAllowed = true; // may IMPORT* formulas and web images reach out? Off for files from elsewhere until allowed
    this._externalBlocked = false; // a blocked request has been noticed this version
    this._depth = 0; // nested _compute calls in progress
    this._deepening = new Set(); // cells being evaluated bottom-up after a stack overflow
    this._priming = false; // while a column is being settled top down for a chain the formula text cannot be walked
    this._usedCache = new Map();
    this._cellBoundsCache = new Map(); // sheetId → last row/col with content, valid for the whole version
    this._statsCache = new Map();
    this._volatile = null; // whether any formula in the book is volatile, until the book next changes
    this._spills = new Map(); // sheetId → { anchors, cover, building }
    this._spillBuilds = [];
    this._grown = new Set(); // sheets a spill grew during a calculation, announced once it has finished
    this._settlingSpills = false;
    this._hasDeferredSpills = false;
    this.version = 0;
    this.dirty = false;
    this._load(json || { sheets: [{ name: 'Sheet1' }] });
  }

  static blank() {
    return new Workbook();
  }

  /* ---------- Serialization ---------- */

  _load(json) {
    json = unpackNativeFillState(json);
    this._loadSettings(json);
    // Show Changes: the record of recent edits (see change-history.js). It is no part of undo, nor of toJSON, which
    // undo restores exactly: the draft and the file's sidecar carry it beside the book (drafts.js, io.js).
    this.changeHistory = normalizeChangeHistory(json.changeHistory);
    this._changeJoin = null;
    this.sheets = (json.sheets?.length ? json.sheets : [{ name: 'Sheet1' }]).map(makeSheet);
    this.workbookView = normalizeWorkbookView(json.workbookView);
    // View ▸ Custom Views (see custom-views.js).
    this.customViews = normalizeCustomViews(json.customViews, this.sheets.map((s) => s.id), normalizeFilter);
    this._loadNames(json);
    // Never every sheet hidden, and never a hidden sheet in front.
    if (this.sheets.every((s) => s.hidden)) this.sheets[0].hidden = false;
    this.activeSheetId = this.sheets.some((s) => s.id === json.activeSheetId && !s.hidden)
      ? json.activeSheetId : this.sheets.find((s) => !s.hidden).id;
    this._invalidate();
    const bind = [];
    for (const sheet of this.sheets) for (const [key, cell] of sheet.cells) if (cell.externalResult && !cell.externalResult.context) {
      const { r, c } = parseKey(key);
      bind.push({ sheet, r, c, cell });
      cell.externalResult.context = this._externalCallerContext(sheet, r, c, cell.f);
    }
    let filtered = false;
    this.sheets.forEach((s, i) => { if (sheetFilters(s).length && !Array.isArray(json.sheets?.[i]?.filterHidden)) { this._applyFilter(s); filtered = true; } });
    if (filtered && bind.length) {
      // The imported result belongs to the fully loaded state, including any
      // filters reconstructed from criteria. Existing provenance is never rebound.
      this._invalidate();
      for (const { sheet, r, c, cell } of bind) cell.externalResult.context = this._externalCallerContext(sheet, r, c, cell.f);
    }
  }

  /** The workbook's own settings (everything but its sheets and defined names), read from serialized contents. */
  _loadSettings(json) {
    this.dataModel = normalizeDataModel(json.dataModel);
    this.nativePivots = normalizeNativePivots(json.nativePivots);
    this.externalWorkbooks = normalizeExternalWorkbooks(json.externalWorkbooks);
    this.iteration = normalizeIteration(json.iteration);
    // Calculation Options: 'automatic' recalculates after every change; 'manual' keeps results until F9 (see _changed).
    this.calcMode = json.calcMode === 'manual' ? 'manual' : 'automatic';
    // Protect Workbook (structure): sheets cannot be added, deleted, renamed, moved, copied, hidden, shown or recoloured.
    this.structureProtected = json.structureProtected === true;
    // Watch Window: cells whose values are kept in view, by sheet id and position.
    // Get & Transform: the workbook's queries (see queries.js); their loaded tables are ordinary tables.
    this.queries = normalizeQueries(json.queries);
    // Automate: the scripts the workbook carries (see scripts.js).
    this.scripts = normalizeScripts(json.scripts);
    // Edit Links ▸ Startup Prompt: what opening the book does about its links to other workbooks.
    this.linkStartup = LINK_STARTUP_MODES.includes(json.linkStartup) ? json.linkStartup : 'ask';
    // Named cell styles this workbook defines, and built-in ones it modified (see custom-cell-styles.js).
    this.cellStyles = normalizeCellStyles(json.cellStyles);
    this.watches = Array.isArray(json.watches) ? json.watches.filter((w) => w && Number.isInteger(w.r) && Number.isInteger(w.c) && w.sheetId != null).slice(0, 500).map(({ sheetId, r, c }) => ({ sheetId, r, c })) : [];
    this.calcPending = false;
    this.calculationCompatibility = normalizeCalculationCompatibility(json.calculationCompatibility);
    this.colorPalette = normalizeColorPalette(json.colorPalette);
    this.fontTheme = normalizeFontTheme(json.fontTheme);
    this.themeInfo = normalizeThemeInfo(json.themeInfo);
    this.normalFont = normalizeNormalFont(json.normalFont);
    this.nativeNormalStyle = normalizeNativeNormalStyle(json.nativeNormalStyle);
    this.nativeNormalFill = normalizeNativeFill(json.nativeNormalFill);
    this.normalStyle = normalFontStyle(this.normalFont);
    this.nativeDefaultCellFormat = normalizeNativeDefaultCellFormat(json.nativeDefaultCellFormat);
    this.cellDefaultStyle = this.nativeDefaultCellFormat ? { ...this.normalStyle, ...this.nativeDefaultCellFormat.style } : this.normalStyle;
    this._sheetDefaultStyles = new WeakMap();
  }

  /** The defined names, read from serialized contents against the sheets already loaded (a scope must name one). */
  _loadNames(json) {
    this.names = [];
    for (const n of json.names || []) {
      // Preserve legacy name/table collisions on load; reject new collisions
      // through editing APIs without silently discarding stored definitions.
      const scope = n?.sheet == null ? null : this.sheetByName(n.sheet)?.name;
      if (n?.sheet != null && !scope) continue;
      if (n?.name && n?.ref && !this.validateName(n.name, null, { allowTableName: true, sheet: scope })) this.names.push({ name: n.name, ref: String(n.ref), ...(n.hidden === true ? { hidden: true } : {}), ...(scope ? { sheet: scope } : {}), ...(n.relative === true ? { relative: true } : {}) });
    }
  }

  /**
   * The workbook's settings beside its sheets, each as the live value it is held as (shared editing compares these
   * by identity first, as an edit replaces a setting rather than changing it in place). See bookState.
   */
  bookFields() {
    const out = {};
    for (const key of BOOK_STATE_KEYS) out[key] = this[key];
    return out;
  }

  /** The workbook's settings beside its sheets, serialized as a file holds them (natively filled colors unpacked); `keys` limits them. */
  bookState(keys = BOOK_STATE_KEYS) {
    const out = {};
    for (const key of keys) {
      const value = key === 'queries' ? serializeQueries(this) : key === 'scripts' ? serializeScripts(this) : key === 'names' ? this.names.map((n) => ({ ...n })) : this[key];
      out[key] = JSON.parse(JSON.stringify(value ?? null));
    }
    return out;
  }

  /**
   * Put serialized settings (some keys of bookState) in place, read as a file's are; the sheets stay. Not an undo step:
   * shared editing applies the settings someone else changed with this, and keeps its own record around it.
   */
  applyBookState(partial) {
    const json = { ...this.bookState(), ...partial };
    this._loadSettings(json);
    if ('names' in partial) this._loadNames(json);
    if ('customViews' in partial) this.customViews = normalizeCustomViews(json.customViews, this.sheets.map((s) => s.id), normalizeFilter);
    this._changed('structure');
  }

  /**
   * Replace the whole book with serialized contents (a recovered draft).
   * The history is cleared and the book is dirty afterwards, so it saves.
   */
  replaceWith(json) {
    this._load(json);
    // The snapshots the old steps held go with them; a tally left standing would evict the new steps as they came.
    this.clearHistory();
    this.dirty = true;
    this.version++;
    this._emit('load');
  }

  toJSON() {
    return packNativeFillState({
      version: 1,
      ...(this.dataModel ? { dataModel: normalizeDataModel(this.dataModel) } : {}),
      ...(this.nativePivots ? { nativePivots: normalizeNativePivots(this.nativePivots) } : {}),
      ...(this.externalWorkbooks ? { externalWorkbooks: normalizeExternalWorkbooks(this.externalWorkbooks) } : {}),
      activeSheetId: this.activeSheetId,
      ...(this.workbookView ? { workbookView: normalizeWorkbookView(this.workbookView) } : {}),
      ...(this.customViews?.length ? { customViews: normalizeCustomViews(this.customViews, this.sheets.map((s) => s.id), normalizeFilter) } : {}),
      names: this.names.map((n) => ({ ...n })),
      ...(this.iteration ? { iteration: { ...this.iteration } } : {}),
      ...(this.calcMode === 'manual' ? { calcMode: 'manual' } : {}),
      ...(this.structureProtected ? { structureProtected: true } : {}),
      ...(this.linkStartup !== 'ask' ? { linkStartup: this.linkStartup } : {}),
      ...(this.queries.length ? { queries: serializeQueries(this) } : {}),
      ...(this.scripts.length ? { scripts: serializeScripts(this) } : {}),
      ...(this.cellStyles.length ? { cellStyles: normalizeCellStyles(this.cellStyles) } : {}),
      ...(this.watches.length ? { watches: this.watches.filter((w) => this.sheet(w.sheetId)).map((w) => ({ ...w })) } : {}),
      calculationCompatibility: { ...this.calculationCompatibility },
      ...(this.colorPalette ? { colorPalette: normalizeColorPalette(this.colorPalette) } : {}),
      ...(this.fontTheme ? { fontTheme: normalizeFontTheme(this.fontTheme) } : {}),
      ...(this.themeInfo ? { themeInfo: normalizeThemeInfo(this.themeInfo) } : {}),
      ...(this.normalFont ? { normalFont: normalizeNormalFont(this.normalFont) } : {}),
      ...(this.nativeNormalStyle ? { nativeNormalStyle: normalizeNativeNormalStyle(this.nativeNormalStyle) } : {}),
      ...(this.nativeNormalFill ? { nativeNormalFill: this.nativeNormalFill } : {}),
      ...(this.nativeDefaultCellFormat ? { nativeDefaultCellFormat: normalizeNativeDefaultCellFormat(this.nativeDefaultCellFormat) } : {}),
      sheets: this.sheets.map((s) => ({ ...sheetShapeJSON(s, { defaultHidden: (sheet) => this._defaultFilterHidden(sheet) }), cells: Object.fromEntries([...s.cells].map(([k, c]) => [k, cloneCell(c)])) })),
    });
  }

  /**
   * The workbook as an undo snapshot: the sheet list (order, names, hidden sheets, the active sheet, the defined
   * names) and the JSON of the sheets in `touched`, the ones the step changed. Every other sheet is named by id
   * alone and kept as it is: a step that left a sheet alone has nothing to put back on it, and the steps since are
   * undone or redone into place before this one is (see _restore). `cells` is the memory the snapshot holds,
   * weighed against the budget.
   */
  _snapshot(touched) {
    const sheets = new Map();
    let cells = 0;
    for (const s of this.sheets) {
      if (!touched.has(s.id)) continue;
      const json = { ...sheetShapeJSON(s, { live: true }), cells: Object.fromEntries([...s.cells].map(([k, c]) => [k, cloneCell(c)])) };
      sheets.set(s.id, json);
      cells += s.cells.size + s.styleResets.length + s.ignoredErrors.length + nativeSparklineSize(s.sparklineGroups);
    }
    return { externalWorkbooks: this.externalWorkbooks, dataModel: this.dataModel, nativePivots: this.nativePivots, order: this.sheets.map(sheetListEntry), activeSheetId: this.activeSheetId, names: this.names.map((n) => ({ ...n })), sheets, touched, cells };
  }

  /**
   * Note the book as it stands before a structural step, so that once the step has run the sheets it changed can be
   * told from the rest and only those serialized for its undo (see _settle). Which sheets a step changes is known
   * only afterwards: a row inserted on one sheet moves the references to it in every other sheet's formulas. So every
   * sheet is noted, cheaply enough to do for the whole book on each step: a step never alters a cell's value or style
   * in place, so the cell objects themselves stand for the cells and are only listed; it does rewrite formula text in
   * place, so each formula's text is kept; and the rest of a sheet is small beside its cells. A sheet a change is
   * announced for while the capture is open (a cell edit later in the same transaction) counts as changed too.
   */
  _capture() {
    const capture = { externalWorkbooks: this.externalWorkbooks, dataModel: this.dataModel, nativePivots: this.nativePivots, order: this.sheets.map(sheetListEntry), activeSheetId: this.activeSheetId, names: this.names.map((n) => ({ ...n })), sheets: new Map(), announced: new Set() };
    for (const s of this.sheets) {
      const cells = Array.from(s.cells.values());
      const fAt = [];
      const fText = [];
      for (let i = 0; i < cells.length; i++) { const f = cells[i].f; if (f != null) { fAt.push(i); fText.push(f); } }
      capture.sheets.set(s.id, { sheet: s, map: s.cells, keys: Array.from(s.cells.keys()), cells, fAt, fText, shape: sheetShapeJSON(s, { live: true }) });
    }
    this._captures.push(capture);
    return capture;
  }

  /**
   * Whether a sheet differs from its capture: in its cells, their formula texts, or anything else about it but what
   * the sheet list part of the snapshot carries (its name and hidden state, which a rename or a hiding changes alone).
   */
  _sheetChanged(cap, live) {
    if (live !== cap.sheet || live.cells !== cap.map || live.cells.size !== cap.cells.length) return true;
    let i = 0;
    let p = 0;
    for (const c of live.cells.values()) {
      if (c.f != null) { if (cap.fAt[p] !== i || cap.fText[p] !== c.f) return true; p++; }
      i++;
    }
    const listed = { name: null, hidden: null, veryHidden: null };
    return p !== cap.fAt.length || !sameJSON({ ...sheetShapeJSON(live, { live: true }), ...listed }, { ...cap.shape, ...listed });
  }

  /**
   * Close a capture now that its step has run: the snapshot of the state before the step, holding the JSON of the
   * sheets it changed or removed (rebuilt from the capture, with the formula texts as they were) and, among the
   * touched, the ids of the sheets it added, which have nothing to put back.
   */
  _settle(capture) {
    const open = this._captures.indexOf(capture);
    if (open >= 0) this._captures.splice(open, 1);
    const touched = new Set(capture.announced);
    const live = new Map(this.sheets.map((s) => [s.id, s]));
    for (const [id, cap] of capture.sheets) if (!live.has(id) || this._sheetChanged(cap, live.get(id))) touched.add(id);
    for (const id of live.keys()) if (!capture.sheets.has(id)) touched.add(id);
    const sheets = new Map();
    let cells = 0;
    for (const id of touched) {
      const cap = capture.sheets.get(id);
      if (!cap) continue;
      const cellsJSON = {};
      let p = 0;
      for (let i = 0; i < cap.cells.length; i++) {
        const f = cap.fAt[p] === i ? cap.fText[p++] : null;
        const cell = cloneCell(cap.cells[i].externalResult ? { ...cap.cells[i], f } : cap.cells[i]);
        cell.f = f;
        cellsJSON[cap.keys[i]] = cell;
      }
      sheets.set(id, { ...cap.shape, cells: cellsJSON });
      cells += cap.cells.length + (cap.shape.styleResets?.length || 0) + (cap.shape.ignoredErrors?.length || 0) + nativeSparklineSize(cap.shape.sparklineGroups);
    }
    return { externalWorkbooks: capture.externalWorkbooks, dataModel: capture.dataModel, nativePivots: capture.nativePivots, order: capture.order, activeSheetId: capture.activeSheetId, names: capture.names, sheets, touched, cells };
  }

  /* ---------- Sheets ---------- */

  get activeSheet() {
    return this.sheet(this.activeSheetId) || this.sheets[0];
  }

  setActiveSheet(id) {
    const sheet = this.sheet(id);
    if (!sheet || sheet.externalCache || id === this.activeSheetId) return;
    // Going to a hidden sheet brings it back.
    if (sheet.hidden) { this.setSheetHidden(id, false); return; }
    this.activeSheetId = id;
    this._emit('active-sheet');
  }

  /** Sheets shown in the tab bar. */
  get visibleSheets() {
    return this.sheets.filter((s) => !s.hidden);
  }

  /**
   * Hide a sheet (its tab goes away; formulas still reach it) or show it
   * again. The last visible sheet cannot be hidden. Showing a sheet makes
   * it active. Undoable.
   */
  setSheetHidden(id, hidden) {
    if (this._structureLocked()) return false;
    const sheet = this.sheet(id);
    if (!sheet || sheet.externalCache || sheet.hidden === !!hidden) return false;
    if (hidden && this.visibleSheets.length <= 1) return false;
    this._structural(hidden ? 'Hide sheet' : 'Show sheet', () => {
      sheet.hidden = !!hidden;
      if (hidden && this.activeSheetId === id) {
        const i = this.sheets.indexOf(sheet);
        const next = this.sheets.slice(i + 1).find((s) => !s.hidden) || this.sheets.slice(0, i).reverse().find((s) => !s.hidden);
        this.activeSheetId = next.id;
      }
      if (!hidden) this.activeSheetId = id;
    });
    return true;
  }

  sheet(id) {
    return this.sheets.find((s) => s.id === id) || this._externalSheetById(id);
  }

  sheetByName(name) {
    const key = sheetKey(name);
    return this.sheets.find((s) => sheetKey(s.name) === key) || this._externalSheet(name);
  }

  _externalSheetById(id) {
    if (this._externalViewSource !== this.externalWorkbooks) return undefined;
    return this._externalViews?.get(id);
  }

  _externalSheet(name) {
    if (!this.externalWorkbooks || !String(name).startsWith('[')) return undefined;
    if (this._externalViewSource !== this.externalWorkbooks) {
      this._externalViewSource = this.externalWorkbooks;
      this._externalViews = new Map(); this._externalNames = new Map();
    }
    const resolved = externalWorkbookScope(this.externalWorkbooks, name);
    if (!resolved || resolved.sheet && (resolved.sheet.cells == null || resolved.sheet.refreshError)) return undefined;
    const canonical = `[${resolved.index + 1}]${resolved.sheet?.name || ''}`;
    if (this._externalNames.has(canonical)) return this._externalNames.get(canonical);
    const visibility = resolved.sheet?.visibility;
    const view = makeSheet({ name: canonical, protected: true,
      hiddenRows: visibility?.hiddenRows, hiddenCols: visibility?.hiddenCols,
      cells: Object.fromEntries(Object.entries(resolved.sheet?.cells || {}).map(([key, v]) => [key, { v }])) });
    // This is the source's last applied filter result, not a local AutoFilter
    // whose criteria can be recomputed against the supporting-cell cache.
    view.filterHidden = new Set(visibility?.filteredRows || []);
    view.externalCache = true;
    this._externalNames.set(canonical, view); this._externalViews.set(view.id, view);
    return view;
  }

  /** A name no sheet uses yet: "Sheet2", "Sheet3", ... */
  /**
   * The names of every sheet from `a` to `b` in tab order, either way round,
   * hidden ones included (a 3D span like Sheet1:Sheet3!A1). Null when a
   * name is unknown.
   */
  sheetsBetween(a, b) {
    if (String(a).startsWith('[')) {
      const span = externalWorkbookSpan(this.externalWorkbooks, a, b);
      return span && !span.sheets.some(s => s.cells == null || s.refreshError)
        ? span.sheets.map(s => `[${span.index + 1}]${s.name}`) : null;
    }
    const i = this.sheets.findIndex((s) => sheetKey(s.name) === sheetKey(a));
    const j = this.sheets.findIndex((s) => sheetKey(s.name) === sheetKey(b));
    if (i < 0 || j < 0) return null;
    return this.sheets.slice(Math.min(i, j), Math.max(i, j) + 1).map((s) => s.name);
  }

  uniqueSheetName(base = 'Sheet') {
    let n = this.sheets.length + 1;
    let name = `${base}${n}`;
    while (this.sheetByName(name)) name = `${base}${++n}`;
    return name;
  }

  validateSheetName(name, exceptId = null) {
    const t = String(name ?? '');
    if (!t) return 'Sheet name cannot be empty';
    if (t.length > 31) return 'Sheet name must be 31 characters or fewer';
    if (INVALID_SHEET_CHARS.test(t)) return 'Sheet name cannot contain [ ] : * ? / \\';
    // Excel refuses these, so a saved file could not be opened there.
    if (t.startsWith("'") || t.endsWith("'")) return "Sheet name cannot start or end with an apostrophe";
    if (t.toLowerCase() === 'history') return 'History is a reserved sheet name; choose another';
    const dup = this.sheetByName(t);
    if (dup && dup.id !== exceptId) return 'A sheet with that name already exists';
    return null;
  }

  addSheet(name = null, index = this.sheets.length) {
    if (this._structureLocked()) return null;
    const sheetName = name && !this.validateSheetName(name) ? String(name) : this.uniqueSheetName();
    // A sheet added beside one at the .xlsx default geometry takes it too.
    const beside = this.sheet(this.activeSheetId);
    const excel = beside && beside.defaultColWidth === EXCEL_SHEET_DEFAULTS.defaultColWidth && beside.defaultRowHeight === EXCEL_SHEET_DEFAULTS.defaultRowHeight;
    return this._structural('Add sheet', () => {
      // `newSheetDefaults` is the person's choice for new sheets (the editor sets it from the app's options: the
      // view they open in, whether headers show); it belongs to this session, not to the file.
      const sheet = makeSheet({ name: sheetName, ...(excel ? EXCEL_SHEET_DEFAULTS : {}), ...(excel && beside.defaultVAlign ? { defaultVAlign: beside.defaultVAlign } : {}), ...this.newSheetDefaults });
      this.sheets.splice(index, 0, sheet);
      this.activeSheetId = sheet.id;
      return sheet;
    });
  }

  /** Rewrite every stored sheet reference during a structural operation. */
  _renameSheetReferences(sheet, from, to) {
    // Internal links are HYPERLINK("#Sheet!A1", ...) strings, which the reference rewrite does not see.
    // A bare name is one quoteSheet leaves unquoted: letters of any script, marks, digits, _ and . (#Données!A1).
    const linkRe = /(HYPERLINK\(\s*")#(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{M}\p{N}_.]*))!/giu;
    const fromKey = sheetKey(from);
    const renameLinks = (f) => (/HYPERLINK/i.test(f) ? f.replace(linkRe, (m, head, quoted, bare) => {
      const name = quoted ? quoted.replace(/''/g, "'") : bare;
      return sheetKey(name) === fromKey ? `${head}#${quoteSheet(to)}!` : m;
    }) : f);
    const rename = (f) => renameLinks(renameSheetInFormula(f, from, to));
    let contextualCells;
    for (const [key, cell] of sheet.cells) if (cell.externalResult?.context?.sheetName === from) {
      contextualCells ||= new Map(sheet.cells);
      contextualCells.set(key, { ...cell, externalResult: { ...cell.externalResult, context: { ...cell.externalResult.context, sheetName: to } } });
    }
    if (contextualCells) sheet.cells = contextualCells;
    this._mapSheetFormulas(sheet, rename);
    let linkedCells = null;
    for (const [key, cell] of sheet.cells) {
      if (cell.hyperlink?.startsWith('#')) {
        const hyperlink = cell.hyperlink.replace(/^#(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{M}\p{N}_.]*))!/u,
          (match, quoted, bare) => sheetKey(quoted ? quoted.replace(/''/g, "'") : bare) === fromKey ? `#${quoteSheet(to)}!` : match);
        if (hyperlink !== cell.hyperlink) { linkedCells ||= new Map(sheet.cells); linkedCells.set(key, { ...cell, hyperlink }); }
      }
    }
    if (linkedCells) sheet.cells = linkedCells;
    sheet.charts = sheet.charts.map(chart => {
      if (!chart.hyperlink?.startsWith('#')) return chart;
      const hyperlink = chart.hyperlink.replace(/^#(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{M}\p{N}_.]*))!/u,
        (match, quoted, bare) => sheetKey(quoted ? quoted.replace(/''/g, "'") : bare) === fromKey ? `#${quoteSheet(to)}!` : match);
      return hyperlink === chart.hyperlink ? chart : { ...chart, hyperlink };
    });
  }

  /** Rewrite formulas consistently across cells and their dependent objects. */
  _mapSheetFormulas(sheet, rename) {
    sheet.charts = sheet.charts.map(chart => mapChartReferences(chart, rename));
    sheet.sparklineGroups = mapNativeSparklineReferences(sheet.sparklineGroups, (formula, binding) => {
      const ref = parseRefText(binding.ref || binding.sparklines[0].ref);
      return rename(formula, { r: ref.r1, c: ref.c1 });
    });
    for (const [key, cell] of sheet.cells) if (cell.f != null) {
      if (cell.externalResult) sheet.cells.set(key, reindexExternalCell(cell, f => rename(f, parseKey(key))));
      else cell.f = rename(cell.f, parseKey(key));
    }
    sheet.tables = sheet.tables.map((table) => ({ ...table, calc: Object.fromEntries(
      Object.entries(table.calc || {}).map(([c, f]) => [c, rename(f, { r: table.calcRow ?? tableRows(table).dataStart, c: table.range.c1 + Number(c), relativeRows: true })])),
    }));
    sheet.rules = sheet.rules.map(rule => mapConditionalFormulas(rule, (formula, key) => rename(formula, key === conditionalPredicateField(rule)
      ? { r: rule.range.r1, c: rule.range.c1, relativeRows: true } : { r: 0, c: 0 })));
    sheet.validations = sheet.validations.map((rule) => rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source))
      ? { ...rule, source: rename(String(rule.source || ''), rule.type === 'formula' || rule.relativeSource === true
        ? { r: rule.range.r1, c: rule.range.c1, relativeRows: true } : { r: 0, c: 0 }) } : rule);
    mapSheetFilters(sheet, f => ({ ...f, criteria: Object.fromEntries(Object.entries(f.criteria).map(([col, criterion]) =>
      [col, mapFilterFormula(criterion, (formula, range) => rename(formula, { r: range?.r1 ?? f.range.r1 + 1, c: range?.c1 ?? Number(col), relativeRows: true }))])) }));
  }

  renameSheet(id, name) {
    if (this._structureLocked()) return false;
    const sheet = this.sheet(id);
    if (!sheet || sheet.externalCache) return false;
    const t = String(name);
    if (this.validateSheetName(t, id)) return false;
    if (t === sheet.name) return true;
    this._structural('Rename sheet', () => {
      const old = sheet.name;
      const pivots = (this.nativePivots?.tables || []).filter(p => p.owner === id);
      if (pivots.length) for (const owner of this.sheets) {
        const charts = owner.charts.map(chart => renamePivotChartSheet(chart, pivots, old, t));
        if (charts.some((chart, i) => chart !== owner.charts[i])) owner.charts = charts;
      }
      sheet.name = t;
      for (const s of this.sheets) this._renameSheetReferences(s, old, t);
      this.names = this.names.map((n) => ({ ...n, ...(n.sheet === old ? { sheet: t } : {}), ref: renameSheetInFormula(n.ref, old, t) }));
    });
    return true;
  }

  deleteSheet(id) {
    if (this.sheets.length <= 1 || this._structureLocked()) return false;
    const i = this.sheets.findIndex((s) => s.id === id);
    if (i < 0) return false;
    if (!this.sheets[i].hidden && this.visibleSheets.length <= 1) return false;
    // The sheet is matched as sheet names are: without regard to case or to how their accents are composed.
    const goneKey = sheetKey(this.sheets[i].name);
    const isGone = (name) => name != null && sheetKey(name) === goneKey;
    // A 3D span that ends at the deleted sheet shrinks to the sheets that remain; one with no sheet left reads #REF!.
    const shrink = (f) => (f.includes(':') ? mapFormulaRefs(f, (ref) => {
      if (!ref.sheetEnd || ref.sheet?.startsWith('[') || (!isGone(ref.sheet) && !isGone(ref.sheetEnd))) return ref;
      const names = (this.sheetsBetween(ref.sheet, ref.sheetEnd) || []).filter((name) => !isGone(name));
      if (!names.length) { const { sheetEnd, ...one } = ref; return { ...one, sheet: '#REF!' }; }
      const out = { ...ref, sheet: names[0], sheetEnd: names[names.length - 1] };
      if (out.sheet === out.sheetEnd) delete out.sheetEnd;
      return out;
    }) : f);
    // References to the sheet's cells are written as Excel writes them, #REF!A1 (a sheet-qualified name becomes the
    // error itself), and read #REF!; kept verbatim, a later sheet given the same name would silently take them over.
    const unlink = (f) => (f.includes('!') ? mapFormulaRefs(f, (ref) => (isGone(ref.sheet) && !ref.sheetEnd ? { ...ref, sheet: '#REF!' } : ref),
      (t) => (isGone(t.sheet) ? '#REF!' : null)) : f);
    // Structured references to the sheet's tables have nothing left to name and read #REF!, as references to its cells do.
    const goneTables = this.sheets[i].tables.map((t) => t.name);
    const goneLower = goneTables.map((name) => name.toLowerCase());
    const dropTables = (f) => (goneLower.some((name) => f.toLowerCase().includes(name))
      ? tableRefsToA1(f, () => null, (table) => !!table && goneLower.includes(table.toLowerCase()), goneTables) : f);
    const rewrite = (f) => dropTables(unlink(shrink(f)));
    this._structural('Delete sheet', () => {
      this._removeNativePivots((this.nativePivots?.tables || []).filter(p => p.owner === id), 'Delete sheet', true);
      if (this.nativePivots) this.nativePivots = { ...this.nativePivots, caches: this.nativePivots.caches.map(c =>
        c.sourceSheetId === id && c.sourceRef ? { ...c, sourceSheetId: null, sourceRef: '#REF!' } : c) };
      for (const s of this.sheets) {
        if (s.id === id) continue;
        for (const cell of s.cells.values()) if (cell.f != null) cell.f = rewrite(cell.f);
        s.tables = s.tables.map((t) => (t.calc ? { ...t, calc: Object.fromEntries(Object.entries(t.calc).map(([c, f]) => [c, rewrite(f)])) } : t));
        Object.assign(s, this._ruleFormulaUpdates(s, rewrite));
      }
      // Names scoped to the sheet go with it. One that pointed at it alone stays, reading #REF!, so its
      // dependents show #REF! rather than #NAME? and no later sheet of the same name takes it over; the rest are rewritten.
      this.names = this.names.filter((n) => !isGone(n.sheet)).map((n) => ({ ...n, ref: isGone(this.parseNamedRef(n.ref)?.sheet) ? '#REF!' : rewrite(n.ref) }));
      this.sheets.splice(i, 1);
      if (this.activeSheetId === id) {
        const after = this.sheets.slice(i).find((s) => !s.hidden) || this.sheets.slice(0, i).reverse().find((s) => !s.hidden);
        this.activeSheetId = after.id;
      }
    });
    return true;
  }

  moveSheet(id, toIndex) {
    if (this._structureLocked()) return;
    const from = this.sheets.findIndex((s) => s.id === id);
    const to = Math.max(0, Math.min(this.sheets.length - 1, toIndex));
    if (from < 0 || from === to) return;
    this._structural('Move sheet', () => {
      const [s] = this.sheets.splice(from, 1);
      this.sheets.splice(to, 0, s);
    });
  }

  duplicateSheet(id) {
    if (this._structureLocked()) return null;
    const src = this.sheet(id);
    if (!src || src.externalCache) return null;
    const i = this.sheets.indexOf(src);
    return this._structural('Duplicate sheet', () => {
      // Only this sheet is written out. Serializing the whole book for one of its sheets made a tab-menu
      // click take a second on a book of a sheet per month, for a copy that reads nothing from the others.
      // The copy shows what this person sees, and becomes everyone's: it is in no sheet view of its own.
      const { personalView: _personal, ...json } = { ...sheetShapeJSON(src, { live: true }), cells: Object.fromEntries([...src.cells].map(([k, c]) => [k, cloneCell(c)])) };
      let name = suffixedSheetName(src.name, ' (copy)');
      let n = 2;
      while (this.sheetByName(name)) name = suffixedSheetName(src.name, ` (copy ${n++})`);
      const copy = makeSheet({ ...json, id: null, name, hidden: false, freshIds: true });
      // References to the original sheet inside the copy now point at itself.
      this._renameSheetReferences(copy, src.name, name);
      // Table names are unique across the workbook: the copies get fresh ones, and the copy's formulas follow.
      const tableRenames = this._renameTablesUniquely([copy], this.names.map((n) => n.name), (name) => !!this.namedEntry(name, src.name));
      const native = duplicateNativePivots(this.nativePivots, src, copy, copy.charts);
      copy.charts = native.charts;
      for (const n of this.names.filter((n) => n.sheet === src.name)) {
        let ref = renameSheetInFormula(n.ref, src.name, name);
        for (const [from, to] of tableRenames) ref = renameTableInFormula(ref, from, to, !this.namedEntry(from, src.name));
        this.names.push({ ...n, sheet: name, ref });
      }
      this.nativePivots = native.pivots;
      this.sheets.splice(i + 1, 0, copy);
      this.activeSheetId = copy.id;
      this._refreshFilters([copy], { preserveView: true });
      return copy;
    });
  }

  /**
   * A new workbook holding a copy of one sheet (cells, styles, tables,
   * charts, rules, and the name definitions it uses), ready to be
   * written to another file or imported into one. References to omitted
   * sheets retain native workbook links and supporting-cell caches.
   */
  sheetToWorkbook(id, options = {}) {
    const src = this.sheet(id);
    if (!src || src.externalCache) return null;
    // Serialize this sheet; supporting dependencies are collected separately.
    const { personalView: _personal, ...sheet } = { ...sheetShapeJSON(src, { live: true }), cells: Object.fromEntries([...src.cells].map(([k, c]) => [k, cloneCell(c)])) };
    const native = nativePivotSheetCopy(this, sheet, options);
    sheet.charts = native.charts;
    const names = this._namesForSheetCopy(sheet, [...this.names.map((n) => ({ ...n })), ...native.entries], native.names);
    const external = externalWorkbookSheetCopy(this, src, options);
    const mapped = { ...sheet, tables: sheet.tables || [], sparklineGroups: sheet.sparklineGroups || [], cells: new Map(Object.entries(sheet.cells)) };
    this._mapSheetFormulas(mapped, external.rewrite);
    mapped.charts = mapped.charts.map((chart, i) => preserveCopiedChartFormats(this, id, sheet.charts[i], chart, options.sourceWorkbook));
    for (const name of names) name.ref = external.rewriteName(name.ref);
    const externalWorkbooks = external.finish();
    const copy = new Workbook({ sheets: [{ ...mapped, cells: Object.fromEntries(mapped.cells), hidden: false }], externalWorkbooks, names, activeSheetId: sheet.id, iteration: this.iteration, calculationCompatibility: this.calculationCompatibility,
      normalFont: this.normalFont, nativeNormalStyle: this.nativeNormalStyle, nativeNormalFill: this.nativeNormalFill, nativeDefaultCellFormat: this.nativeDefaultCellFormat, colorPalette: this.colorPalette, fontTheme: this.fontTheme, nativePivots: native.pivots, dataModel: native.dataModel });
    copy.activeSheet.charts.forEach((chart, i) => preserveCopiedChartText(this, id, sheet.charts[i], copy, chart));
    let rebound = false;
    for (const [key, cell] of copy.activeSheet.cells) {
      const saved = cell.externalResult, original = src.cells.get(key);
      if (!saved?.context?.inputs || !original?.externalResult?.context) continue;
      const { r, c } = parseKey(key);
      // Only a valid source result may follow the proved local-to-supporting
      // cache conversion. A stale source result must stay stale in the copy.
      if (!sameJSON(original.externalResult.context, this._externalCallerContext(src, r, c, original.f))
        || !canRebaseCopiedExternalInputs(this, copy, src, copy.activeSheet, r, c)) continue;
      const context = copy._externalCallerContext(copy.activeSheet, r, c, cell.f);
      for (const field of ['inputs', 'sources']) {
        if (context[field]) saved.context[field] = context[field]; else delete saved.context[field];
      }
      rebound = true;
    }
    if (rebound) copy._invalidate();
    return copy;
  }

  /** Retain the copied sheet's names and the definitions its formulas depend on. */
  _namesForSheetCopy(sheet, entries, extraFormulas = [], workbookNames = null) {
    if (!entries.length) return entries;
    const lower = sheet.name.toLowerCase(), globals = new Map(), locals = new Map();
    for (const n of entries) {
      if (!n.sheet) globals.set(n.name.toUpperCase(), n);
      else if (n.sheet.toLowerCase() === lower) locals.set(n.name.toUpperCase(), n);
    }
    const kept = new Set(), queued = new Map(), pending = [...extraFormulas];
    for (const chart of sheet.charts || []) {
      mapChartReferences(chart, f => { pending.push(f); return f; });
      if (chart.hyperlink?.startsWith('#')) pending.push(chart.hyperlink.slice(1));
    }
    const keep = (n, global = false) => {
      if (!n) return;
      kept.add(n);
      if (global && !n.sheet) workbookNames?.add(n.name.toLowerCase());
      const scopes = queued.get(n) || new Set();
      if (scopes.has(global)) return;
      scopes.add(global); queued.set(n, scopes); pending.push({ formula: n.ref, global });
    };
    for (const n of entries) {
      if (n.sheet ? n.sheet.toLowerCase() === lower : this.parseNamedRef(n.ref)?.sheet?.toLowerCase() === lower) keep(n);
    }
    if (!workbookNames && [...globals.values()].every((n) => kept.has(n))) return entries.filter((n) => kept.has(n));
    for (const cell of Object.values(sheet.cells)) {
      if (cell.f != null) pending.push(cell.f);
      if (cell.hyperlink?.startsWith('#')) pending.push(cell.hyperlink.slice(1));
    }
    for (const group of sheet.sparklineGroups || []) {
      if (group.dateFormula) pending.push(group.dateFormula);
      for (const spark of group.sparklines) if (spark.formula) pending.push(spark.formula);
    }
    for (const table of sheet.tables || []) for (const f of Object.values(table.calc || {})) pending.push(f);
    for (const rule of sheet.rules || []) for (const key of conditionalFormulaFields(rule)) pending.push(rule[key]);
    for (const rule of sheet.validations || []) if (rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source))) pending.push(rule.source);
    for (const f of sheetFilters(sheet)) for (const criterion of Object.values(f.criteria)) if (criterion.formula) pending.push(criterion.formula);
    const scanned = new Set();
    let keepAll = false;
    for (let at = 0; at < pending.length; at++) {
      const item = pending[at], global = item?.global || false;
      const formula = String(item?.formula ?? item ?? '');
      const scanKey = JSON.stringify([formula, global]);
      if (!formula || scanned.has(scanKey)) continue;
      scanned.add(scanKey);
      let tokens;
      try { tokens = tokenize(formula); } catch { continue; }
      const positions = new Map(tokens.map((t, i) => [t.start, i]));
      for (const t of freeNameTokens(formula, tokens, { includeCalls: true, includeQualified: true })) {
        if (t.sheet && !isWorkbookNameScope(t.sheet) && t.sheet.toLowerCase() !== lower) continue;
        const i = positions.get(t.start), called = tokens[i + 1]?.type === 'lparen';
        const builtin = !t.sheet && called && (FUNCTIONS[t.value] || ['LET', 'LAMBDA', 'ISOMITTED'].includes(t.value));
        if (!builtin) {
          const workbookScope = isWorkbookNameScope(t.sheet) || !t.sheet && global;
          keep(workbookScope ? globals.get(t.value) : locals.get(t.value) || globals.get(t.value), workbookScope);
          continue;
        }
        if (t.value !== 'INDIRECT' && t.value !== 'HYPERLINK') continue;
        const arg = tokens[i + 2], end = tokens[i + 3]?.type;
        if (arg?.type === 'string' && (end === 'comma' || end === 'rparen')) {
          const text = arg.value.trim();
          if (t.value === 'INDIRECT' || text.startsWith('#')) pending.push({ formula: text.replace(/^#/, ''), global });
        } else {
          // A computed address can name any definition. Keep the namespace
          // without evaluating potentially expensive or asynchronous formulas.
          keepAll = true;
          for (const n of entries) if (!n.sheet || n.sheet.toLowerCase() === lower) keep(n, global && !n.sheet);
        }
      }
    }
    return entries.filter((n) => kept.has(n) || keepAll && (!n.sheet || n.sheet.toLowerCase() === lower));
  }

  /** Qualified workbook names cannot be localized on import: [0] must keep
   * selecting the incoming definition even when the destination has that name.
   * Give only those colliding definitions a new spelling in a private copy. */
  _workbookNameImport(other, sheetIds = other.sheets.map(s => s.id)) {
    const json = unpackNativeFillState(other.toJSON()), qualified = new Set();
    for (const sheet of json.sheets) if (sheetIds.includes(sheet.id)) other._namesForSheetCopy(sheet, json.names, [], qualified);
    const collisions = other.names.filter(n => !n.sheet && qualified.has(n.name.toLowerCase())
      && (this.names.some(x => !x.sheet && x.name.toLowerCase() === n.name.toLowerCase()) || this.tableByName(n.name)));
    if (!collisions.length) return { workbook: other, qualified };
    const copy = new Workbook(other.toJSON());
    const taken = new Set([...this.names, ...other.names].map(n => n.name.toLowerCase()));
    for (const name of [...this.tableNames(), ...other.tableNames()]) taken.add(name.toLowerCase());
    for (const entry of collisions) {
      let suffix = 2, next;
      do { next = `${entry.name.slice(0, 240)}_Imported${suffix++}`; } while (taken.has(next.toLowerCase()));
      const error = copy.renameName(entry.name, null, next, copy.namedEntry(entry.name, null).ref);
      if (error) throw new Error(error);
      taken.add(next.toLowerCase()); qualified.delete(entry.name.toLowerCase()); qualified.add(next.toLowerCase());
    }
    copy.clearHistory();
    return { workbook: copy, qualified };
  }

  /**
   * Sheets about to join the workbook may carry tables whose names clash with
   * ones already here (or with each other): give those fresh names (Sales →
   * Sales2) and rewrite the formulas on the incoming sheets to match.
   */
  _renameTablesUniquely(incoming, reservedNames = [], hasDefinedName = null) {
    const defined = new Set(reservedNames.map((name) => name.toLowerCase()));
    const taken = new Set(this.sheets.filter((s) => !incoming.includes(s)).flatMap((s) => s.tables.map((t) => t.name.toLowerCase())));
    for (const name of [...this.names.map((n) => n.name), ...reservedNames]) taken.add(name.toLowerCase());
    const originalNames = new Set(incoming.flatMap((s) => s.tables.map((t) => t.name.toLowerCase())));
    const renames = [];
    for (const sheet of incoming) {
      for (const t of sheet.tables) {
        if (!taken.has(t.name.toLowerCase())) { taken.add(t.name.toLowerCase()); continue; }
        let base = t.name.replace(/\d+$/, '') || 'Table';
        const candidate = (index) => {
          const suffix = String(index);
          return `${base.slice(0, MAX_TABLE_NAME_LENGTH - suffix.length)}${suffix}`;
        };
        // Removing a long numeric suffix can turn a valid name into a cell
        // address (X12345678 → X2). Keep generated names unambiguous.
        if (validateTableName(candidate(2))) base += '_';
        let n = 2;
        let next = candidate(n);
        while (taken.has(next.toLowerCase()) || originalNames.has(next.toLowerCase())) next = candidate(++n);
        renames.push([t.name, next]);
        t.name = next;
        taken.add(next.toLowerCase());
      }
    }
    if (!renames.length) return renames;
    for (const sheet of incoming) {
      // A reserved spelling can belong to an unrelated local scope. Resolve
      // bindings in the source sheet before applying its new table names.
      const rewrites = renames.map(([from, to]) => [from, to,
        !(hasDefinedName ? hasDefinedName(from, sheet) : defined.has(from.toLowerCase()))]);
      const rewrite = formula => {
        for (const [from, to, bare] of rewrites) formula = renameTableInFormula(formula, from, to, bare);
        return formula;
      };
      for (const cell of sheet.cells.values()) if (cell.f != null) cell.f = rewrite(cell.f);
      for (const t of sheet.tables) {
        for (const k of Object.keys(t.calc || {})) t.calc[k] = rewrite(t.calc[k]);
      }
      Object.assign(sheet, this._ruleFormulaUpdates(sheet, rewrite));
    }
    return renames;
  }

  /**
   * Bring every sheet of another workbook into this one, after the current
   * sheets. Names that clash get a " (2)" suffix and the formulas that
   * mention them follow; the other workbook's named ranges come along
   * unless a name is already taken. Returns the new sheets.
   */
  importSheets(other) {
    if (this._structureLocked()) return [];
    other = this._workbookNameImport(other).workbook;
    const json = unpackNativeFillState(other.toJSON());
    const modelImport = prepareDataModelImport(this, other);
    if (modelImport) json.names.push(...modelImport.entries);
    const externalOffset = this.externalWorkbooks?.books.length || 0;
    const externalWorkbooks = appendExternalWorkbooks(this.externalWorkbooks, json.externalWorkbooks);
    const incomingNames = new Set(json.names.map((n) => n.name.toLowerCase()));
    if (!json.sheets.length) return [];
    return this._structural('Import sheets', () => {
      const renames = new Map();
      const added = [];
      // Names are taken as sheetByName matches them: in any case, and in either Unicode composition.
      const taken = new Set(this.sheets.map((s) => sheetKey(s.name)));
      // A generated name must not be another incoming sheet's original name:
      // sequential reference rewrites would otherwise redirect it twice.
      const originalNames = new Set(json.sheets.map((s) => sheetKey(s.name)));
      for (const sj of json.sheets) {
        let name = sj.name;
        let n = 2;
        if (taken.has(sheetKey(name))) {
          do { name = suffixedSheetName(sj.name, ` (${n++})`); }
          while (taken.has(sheetKey(name)) || originalNames.has(sheetKey(name)));
        }
        taken.add(sheetKey(name));
        if (name !== sj.name) renames.set(sj.name, name);
        added.push(makeSheet({ ...sj, id: null, name, freshIds: true }));
      }
      for (const sheet of added) {
        if (json.externalWorkbooks) this._mapSheetFormulas(sheet, f => offsetExternalWorkbookRefs(f, externalOffset));
        for (const [from, to] of renames) this._renameSheetReferences(sheet, from, to);
      }
      const sourceScopes = new Map(added.map((s, i) => [s.id, json.sheets[i].name]));
      const tableRenames = this._renameTablesUniquely(added, json.names.map((n) => n.name),
        (name, sheet) => !!other.namedEntry(name, sourceScopes.get(sheet.id)));
      const nativePivots = transferNativePivots(this, other, added, tableRenames, modelImport);
      this.sheets.push(...added);
      this.nativePivots = nativePivots;
      if (modelImport) this.dataModel = modelImport.dataModel;
      this.externalWorkbooks = externalWorkbooks;
      // Which incoming names each new sheet reads, directly or through other names; worked out
      // only when an incoming workbook name is already defined here another way.
      let needed = null;
      const needs = (i, nm) => (needed ??= added.map((s, k) => new Set(other._namesForSheetCopy(json.sheets[k], json.names))))[i].has(nm);
      for (const nm of json.names || []) {
        const scope = nm.sheet ? renames.get(nm.sheet) || nm.sheet : null;
        let ref = json.externalWorkbooks ? offsetExternalWorkbookRefs(nm.ref, externalOffset) : nm.ref;
        for (const [from, to] of renames) ref = renameSheetInFormula(ref, from, to);
        for (const [from, to] of tableRenames) ref = renameTableInFormula(ref, from, to,
          nm.sheet ? !other.namedEntry(from, nm.sheet) : !incomingNames.has(from.toLowerCase()));
        const existing = this.names.find((x) => x.name.toLowerCase() === nm.name.toLowerCase() && (x.sheet || null) === scope);
        if (existing) {
          // A name already defined here keeps its definition, and the file's is dropped when it is the
          // same. When it differs, the file's joins each new sheet that reads it as that sheet's own local
          // name, so the sheet goes on showing the file's values rather than silently taking this book's.
          if (scope || (existing.ref.trim().toLowerCase() === ref.trim().toLowerCase() && !!existing.relative === !!nm.relative)) continue;
          added.forEach((sheet, i) => {
            if (needs(i, nm) && !this.validateName(nm.name, null, { sheet: sheet.name, allowTableName: true })) this.names.push({ ...nm, ref, sheet: sheet.name });
          });
          continue;
        }
        // A local definition on a new sheet cannot shadow table references
        // on existing sheets. Retain imported legacy collisions in that scope.
        if (!this.validateName(nm.name, null, { sheet: scope, allowTableName: !!scope })) this.names.push({ ...nm, ref, ...(scope ? { sheet: scope } : {}) });
      }
      const firstVisible = added.find((sh) => !sh.hidden) || added[0];
      firstVisible.hidden = false;
      this.activeSheetId = firstVisible.id;
      this._refreshFilters(added, { preserveView: true });
      return added;
    });
  }

  /**
   * Replace a sheet's contents with a sheet of another workbook, keeping its
   * id, name, color, and place among the tabs (Import → replace the current
   * sheet). Table names that clash with other sheets' are made unique.
   * Incoming name dependencies belong to the replacement's local scope.
   */
  replaceSheetWith(sheetId, other, otherSheetId) {
    const i = this.sheets.findIndex((s) => s.id === sheetId);
    const j = other.sheets.findIndex((s) => s.id === otherSheetId);
    if (i < 0 || j < 0) return null;
    if (this._locked(this.sheets[i])) return null;
    const prepared = other === this ? { workbook: other, qualified: new Set() } : this._workbookNameImport(other, [otherSheetId]);
    other = prepared.workbook;
    const source = unpackNativeFillState(other.toJSON()), json = source.sheets[j];
    const linked = other !== this && source.externalWorkbooks;
    const externalOffset = linked ? this.externalWorkbooks?.books.length || 0 : 0;
    const externalWorkbooks = linked ? appendExternalWorkbooks(this.externalWorkbooks, source.externalWorkbooks) : this.externalWorkbooks;
    const dependencies = other._namesForSheetCopy(json, source.names);
    const incoming = new Map(), globals = dependencies.filter(n => !n.sheet && prepared.qualified.has(n.name.toLowerCase()));
    for (const entry of dependencies) {
      // Definitions keep the bindings visible from the source sheet. Localize
      // external globals so importing cannot change other destination sheets.
      if (!entry.sheet && (other === this || prepared.qualified.has(entry.name.toLowerCase()))) continue;
      const key = entry.name.toLowerCase();
      if (entry.sheet || !incoming.has(key)) incoming.set(key, entry);
    }
    const { id, name, color, hidden } = this.sheets[i];
    return this._structural('Replace sheet', () => {
      const sheet = makeSheet({ ...json, id, name, color, hidden, freshIds: true });
      if (linked) this._mapSheetFormulas(sheet, f => offsetExternalWorkbookRefs(f, externalOffset));
      this.externalWorkbooks = externalWorkbooks;
      this._renameSheetReferences(sheet, json.name, name);
      this.sheets[i] = sheet;
      const tableRenames = this._renameTablesUniquely([sheet], other.names.map((n) => n.name), (name) => !!other.namedEntry(name, json.name));
      const copiedNames = [];
      for (const entry of incoming.values()) {
        let ref = renameSheetInFormula(linked ? offsetExternalWorkbookRefs(entry.ref, externalOffset) : entry.ref, json.name, name);
        for (const [from, to] of tableRenames) ref = renameTableInFormula(ref, from, to, !other.namedEntry(from, json.name));
        copiedNames.push({ ...entry, ref, sheet: name });
      }
      for (const entry of globals) {
        let ref = renameSheetInFormula(linked ? offsetExternalWorkbookRefs(entry.ref, externalOffset) : entry.ref, json.name, name);
        for (const [from, to] of tableRenames) ref = renameTableInFormula(ref, from, to, !other.namedEntry(from, null));
        this.names.push({ ...entry, ref });
      }
      if (incoming.size) {
        const scope = name.toLowerCase();
        this.names = this.names.filter(n => n.sheet?.toLowerCase() !== scope || !incoming.has(n.name.toLowerCase()));
        this.names.push(...copiedNames);
      }
      // A hidden sheet has no tab to go to, and a hidden active sheet is a state no reload or undo can
      // reproduce (see _load and _restore), so replacing one leaves the tab the user is on where it is.
      if (!hidden) this.activeSheetId = id;
      this._refreshFilters([sheet], { preserveView: true });
      return sheet;
    });
  }

  /**
   * Paste another workbook's sheet — the cells of its used range, values,
   * formulas, and styles, with the merges, notes, validation rules and
   * conditional formats inside that range — onto a sheet starting at
   * (r0, c0), as one undo step. Relative references move with the block, in
   * the rules' formulas as in the cells'. `lines` brings the rows' heights
   * and hidden state too (appended rows are new lines of the sheet; rows an
   * import lands on beside existing data are not). Returns the range filled,
   * or null when there is nothing to place, the destination is protected,
   * or it would not fit.
   */
  placeSheetAt(sheetId, other, otherSheetId, r0, c0, label = 'Import cells', { lines = false } = {}) {
    const used = other.usedRange(otherSheetId);
    const sheet = this.sheet(sheetId);
    if (!used || !sheet || this._gridLocked(sheet)) return null;
    // Tight bounds: leading blank rows and columns of the source stay behind.
    const src = other.sheet(otherSheetId);
    let minR = Infinity;
    let minC = Infinity;
    for (const [key, cell] of src.cells) {
      if (isEmptyCell(cell)) continue;
      const { r, c } = parseKey(key);
      if (r < minR) minR = r;
      if (c < minC) minC = c;
    }
    for (const group of src.sparklineGroups) for (const spark of group.sparklines) {
      const ref = parseRefText(spark.ref); minR = Math.min(minR, ref.r1); minC = Math.min(minC, ref.c1);
    }
    if (minR === Infinity) return null;
    used.r1 = Math.min(minR, used.r2);
    used.c1 = Math.min(minC, used.c2);
    const range = { r1: r0, c1: c0, r2: r0 + used.r2 - used.r1, c2: c0 + used.c2 - used.c1 };
    if (r0 < 0 || c0 < 0 || range.r2 >= MAX_ROWS || range.c2 >= MAX_COLS) return null;
    // A paste includes blank cells, so any overlapping protection refuses
    // the entire block. Report that refusal before the UI announces success.
    const protectedRange = sheet.protectedRanges.find(({ range: p }) =>
      p.r1 <= range.r2 && p.r2 >= range.r1 && p.c1 <= range.c2 && p.c2 >= range.c1);
    if (protectedRange) {
      this._emit('protected', sheetId, { range: protectedRange.range, description: protectedRange.description });
      return null;
    }
    const linked = other !== this && other.externalWorkbooks;
    const externalOffset = linked ? this.externalWorkbooks?.books.length || 0 : 0;
    const externalWorkbooks = linked ? appendExternalWorkbooks(this.externalWorkbooks, other.externalWorkbooks) : this.externalWorkbooks;
    const reindex = f => linked ? offsetExternalWorkbookRefs(String(f ?? ''), externalOffset) : f;
    const cells = other.copyRange(otherSheetId, used);
    if (linked) for (const row of cells) for (let c = 0; c < row.length; c++) row[c] = reindexExternalCell(row[c], reindex);
    const nativeSparklines = importedNativeSparklines(other, otherSheetId, used, sheet, r0, c0, this.colorPalette);
    if (linked && nativeSparklines) nativeSparklines.groups = mapNativeSparklineReferences(nativeSparklines.groups, reindex);
    const dr = r0 - used.r1, dc = c0 - used.c1;
    const inUsed = (r, c) => r >= used.r1 && r <= used.r2 && c >= used.c1 && c <= used.c2;
    // A merge, validation or rule reaching past the block comes along clipped to it rather than
    // dropped: a title merged wider than its data and a dropdown or colour rule applied down a
    // whole column are the ordinary shapes of both, and the dialog promises they arrive.
    const overlaps = (g) => g.r1 <= used.r2 && g.r2 >= used.r1 && g.c1 <= used.c2 && g.c2 >= used.c1;
    const clip = (g) => ({ r1: Math.max(g.r1, used.r1), c1: Math.max(g.c1, used.c1), r2: Math.min(g.r2, used.r2), c2: Math.min(g.c2, used.c2) });
    const moved = (g) => { const k = clip(g); return { r1: k.r1 + dr, c1: k.c1 + dc, r2: k.r2 + dr, c2: k.c2 + dc }; };
    const inRange = (r, c) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
    // Notes travel cell by cell with the paste, laid out like the cells.
    let notes = null;
    for (const [key, text] of src.notes) {
      const { r, c } = parseKey(key);
      if (!inUsed(r, c)) continue;
      (notes ??= cells.map((row) => row.map(() => null)))[r - used.r1][c - used.c1] = text;
    }
    this.transaction(label, () => {
      if (linked) this._structural(label, () => { this.externalWorkbooks = externalWorkbooks; });
      // The block replaces what it lands on: a merge under it would keep the cells landing under
      // it from being written (and the import would report success short of them), so such merges
      // are split first, and the notes under it go, all in the same undo step.
      const hit = this.mergesIn(sheetId, range);
      if (hit.length) this._setMerges(sheet, sheet.merges.filter((m) => !hit.includes(m)), label);
      for (const key of [...sheet.notes.keys()]) { const { r, c } = parseKey(key); if (inRange(r, c)) this.setNote(sheetId, r, c, null); }
      this.pasteCells(sheetId, cells, r0, c0, { r: used.r1, c: used.c1 }, null, { notes, nativeSparklines });
      // The block's merges, validation rules and conditional formats follow it, each formula shifted
      // as the cells' own were (a list source is shifted only when it follows its cells, as a formula
      // does), and by the clipped corner where the group started before the block, so the formula
      // still reads from its own first cell; a merge landing on a table's cells is left out, since no
      // merge can be made there, and a merge clipped down to one cell is no longer a merge.
      const merges = src.merges.filter(overlaps).map(moved)
        .filter((m) => (m.r1 !== m.r2 || m.c1 !== m.c2)
          && !sheet.tables.some((t) => !(m.r2 < t.range.r1 || m.r1 > tableRows(t).dataEnd || m.c2 < t.range.c1 || m.c1 > t.range.c2)));
      if (merges.length) this._setMerges(sheet, [...sheet.merges, ...merges], label);
      const shift = (g, f) => shiftFormula(String(reindex(f) ?? ''), clip(g).r1 - g.r1 + dr, clip(g).c1 - g.c1 + dc);
      const validations = src.validations.filter((v) => overlaps(v.range)).map((v) => ({
        ...v, id: newId(), range: moved(v.range),
        ...(v.type === 'list' && isRangeSource(v.source) ? { source: reindex(v.source) } : {}),
        ...(v.type === 'formula' || (v.type === 'list' && v.relativeSource === true && isRangeSource(v.source)) ? { source: shift(v.range, v.source) } : {}),
      }));
      if (validations.length) this._setValidations(sheet, [...sheet.validations, ...validations], label);
      const rules = src.rules.filter((rule) => overlaps(rule.range)).map((rule) => ({
        ...mapConditionalFormulas(rule, f => shift(rule.range, f)), id: newId(), range: moved(rule.range), style: cloneStyle(rule.style),
      }));
      if (rules.length) this._setRules(sheet, [...sheet.rules, ...rules], label);
      if (lines) {
        for (const r of new Set([...src.rowHeights.keys(), ...src.rowHeightModes.keys()])) if (r >= used.r1 && r <= used.r2) {
          this.setRowHeight(sheetId, r + dr, src.rowHeights.get(r) ?? src.defaultRowHeight, { auto: src.rowHeightModes.get(r) === 'auto' });
        }
        const hidden = [...src.hiddenRows].filter((r) => r >= used.r1 && r <= used.r2).map((r) => r + dr);
        if (hidden.length) this.setHidden(sheetId, 'row', hidden, true);
      }
    });
    return range;
  }

  /**
   * Help for the error a cell shows, specific where the formula tells:
   * "There is no function called SUMM. Did you mean SUM?" Null when the
   * cell holds no error.
   */
  errorHelpAt(sheetId, r, c) {
    const v = this.getValue(sheetId, r, c);
    if (!isError(v)) return null;
    const own = this.getCell(sheetId, r, c);
    const spill = own?.f == null ? this.spillAt(sheetId, r, c) : null;
    const formula = own?.f ?? (spill?.anchor ? this.getCell(sheetId, spill.anchor.r, spill.anchor.c)?.f : null) ?? null;
    return explainError(v.error, formula, {
      names: this.namesForSheet(sheetId).map((n) => n.name),
      tables: this.sheets.flatMap((sh) => sh.tables.map((t) => t.name)),
      hasSheet: (name) => !!this.sheetByName(name),
    });
  }

  /* ---------- Cells ---------- */

  getCell(sheetId, r, c) {
    return this.sheet(sheetId)?.cells.get(cellKey(r, c));
  }

  /**
   * Sheet defaults, column defaults, row defaults, then the cell's stored format; each later field wins.
   * For a spilled result's inherited number format too, use displayStyleAt. Whole-line formats stay
   * on their lines (see applyStyle), so they hold beyond the stored cells and cost no extra stored
   * cell; `getCell` still answers with the cell's own style alone, so nothing that writes cells changes.
   * Undefined when nothing is set, as a cell without a style is.
   */
  styleAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return undefined;
    const own = sheet.cells.get(cellKey(r, c))?.s;
    const line = this._lineStyle(sheet, r, c);
    if (!line) return own;
    const s = { ...line, ...own };
    return Object.keys(s).length ? s : undefined;
  }

  /** The displayed style, including saved PivotTable layers and a spill's inherited format. */
  displayStyleAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return undefined;
    const cell = sheet.cells.get(cellKey(r, c));
    const line = this._lineStyle(sheet, r, c);
    const spill = !cell || (cell.v == null && cell.f == null) ? this.spillAt(sheetId, r, c) : null;
    if (!line && !spill?.style) return this._pivotDisplayStyle(sheetId, r, c, cell?.s);
    const s = { ...line, ...spill?.style, ...cell?.s };
    return this._pivotDisplayStyle(sheetId, r, c, Object.keys(s).length ? s : undefined);
  }

  _pivotDisplayStyle(sheetId, r, c, base) { return nativePivotDisplayStyle(this, sheetId, r, c, base); }
  hasNativePivotDisplay(sheetId) { return hasNativePivotDisplay(this, sheetId); }
  nativePivotDisplayIssues(sheetId) { return nativePivotDisplayIssues(this, sheetId); }

  /** A formatting patch for a batch write, keeping explicit inherited resets.
   * An optional prepared baseStyle composes several edits without writing cells. */
  patchedCellStyle(sheetId, r, c, patch, prepared = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return undefined;
    const cell = sheet.cells.get(cellKey(r, c));
    let inherited = this._lineStyle(sheet, r, c);
    if ((!cell || (cell.v == null && cell.f == null)) && Object.entries(patch).some(([k, v]) => isNumberFormatKey(k) && removesStyleKey(k, v))) {
      const spill = this.spillAt(sheetId, r, c)?.style;
      if (spill) inherited = { ...inherited, ...spill };
    }
    return styleWithPatch(prepared ? prepared.baseStyle : cell?.s, patch, inherited);
  }

  /** Default cell format and native vertical alignment, cached without allocating per cell. */
  defaultStyle(sheet) {
    const base = this.nativeDefaultCellFormat ? this.cellDefaultStyle : this.normalStyle;
    if (!sheet?.defaultVAlign) return base;
    let cached = this._sheetDefaultStyles.get(sheet);
    if (!cached || cached.valign !== sheet.defaultVAlign || cached.normal !== base) {
      cached = { valign: sheet.defaultVAlign, normal: base, style: { ...base, valign: sheet.defaultVAlign } };
      this._sheetDefaultStyles.set(sheet, cached);
    }
    return cached.style;
  }

  /**
   * The default format a cell inherits from its sheet, column and row, with Clear formats restoring
   * the sheet's properties; null when none apply. A sheet that carries no line format at all — every sheet until a
   * whole column or row is formatted — answers on two size reads, so the readers that ask per cell
   * (styleAt, the copy loops) pay nothing for it. The stored patch itself is returned when only one
   * line has one: callers spread it, never keep or change it.
   */
  _lineStyle(sheet, r, c) {
    const base = this.defaultStyle(sheet);
    if (!sheet.colStyles.size && !sheet.rowStyles.size && !sheet.styleResets.length) return base;
    const col = sheet.colStyles.get(c);
    const row = sheet.rowStyles.get(r);
    const reset = styleResetAt(sheet.styleResets, r, c);
    if (reset) return { ...base, ...col, ...row, ...Object.fromEntries(Object.keys(reset).map(k => [k, reset[k] ?? base?.[k] ?? null])) };
    if (!base && (!col || !row)) return col || row || null;
    return { ...base, ...col, ...row };
  }

  /**
   * Give a freshly typed formula the number format it implies (=TODAY() reads as a date) when the cell has
   * none of its own. A structured reference names the same cells an A1 one does, so it is resolved from the
   * cell the formula sits in first: a calculated column's =[@Price]*[@Qty] carries the currency of the Price
   * column, as the =B2*C2 beside it does, and so does a formula over a defined name.
   */
  _applyImpliedStyle(sheetId, cell, r = null, c = null) {
    if (!cell || cell.f == null || (cell.s?.fmt && cell.s.fmt !== 'general')) return;
    const sheet = this.sheet(sheetId);
    const formula = r == null ? cell.f : this.structuredToA1(sheetId, r, c, cell.f);
    const patch = impliedFormulaStyle(formula, (ref) => {
      const target = ref.sheet ? this.sheetByName(ref.sheet) : sheet;
      // What the referenced cell shows, the format of its column or row included (styleAt), so a formula
      // over a column formatted Currency reads as money even where that column has stored no cell of its own.
      return (target && this.styleAt(target.id, ref.r1, ref.c1)) || null;
    }, (name, scope) => this.namedRef(name, scope || sheet?.name, r == null ? undefined : { r, c }));
    if (patch) cell.s = { ...(cell.s || {}), ...patch };
  }

  /** Type a value into a cell, optionally patching its style; literal values bypass input parsing. */
  setInput(sheetId, r, c, text, { literal = false, style = null, label = 'Edit cell', preserveRichText = false } = {}) {
    const sheet = this.sheet(sheetId);
    // A refused edit must not trigger table expansion or calculated columns.
    if (!sheet || !inGrid(r, c, gridLimits(sheet)) || this.lockedAt(sheetId, r, c)) return;
    if (this.arrayEditBlocked(sheetId, { r1: r, c1: c, r2: r, c2: c })) return;
    // What the cell shows: its own style over its column's and row's defaults, so an entry in a
    // formatted column takes that format even where the sheet had stored no cell yet (see styleAt).
    const base = this.styleAt(sheetId, r, c);
    // A new entry drops the mark a removed link left (cellFromInput does the same for typed text).
    const nextStyle = style || base?.nolink ? patchedStyle(base, { ...(style || {}), nolink: null }) : base;
    let cell = literal ? { v: text == null || text === '' ? null : text, f: null, s: nextStyle } : cellFromInput(text, nextStyle);
    if (!literal && cell?.f != null) {
      cell.f = this._closeParentheses(cell.f);
      // Closed, the formula may be longer than a formula may be; then it stays the text typed, as it would have typed whole.
      if (cell.f.length > MAX_FORMULA_LENGTH) cell = { v: String(text), f: null, s: cell.s };
    }
    if (!literal) this._applyImpliedStyle(sheetId, cell, r, c);
    if (preserveRichText && cell?.f == null && typeof cell?.v === 'string') {
      const previous = this.getCell(sheetId, r, c);
      const runs = editRichText(previous?.richText, previous?.v, cell.v);
      if (runs) cell.richText = runs;
      if (previous?.hyperlink) cell.hyperlink = previous.hyperlink;
    }
    if (!sheet.tables.length) { this.setCells(sheetId, [{ r, c, cell }], label); return; }
    // Inside a table: a renamed header rewrites the formulas that used the old column name.
    const table = this.tableAt(sheetId, r, c);
    const header = table && r === tableRows(table).header;
    const oldNames = header ? this.tableColumns(sheetId, table) : null;
    const oldName = header ? oldNames[c - table.range.c1] : null;
    this.transaction(label, () => {
      this.setCells(sheetId, [{ r, c, cell }], label);
      if (header) {
        // Headers are text: a formula typed into one becomes the text it shows, as when a
        // table is created over formulas; a column named after a live result would be renamed by its inputs.
        if (cell?.f != null) this.setCells(sheetId, [{ r, c, cell: { v: this.getDisplay(sheetId, r, c) || null, f: null, s: cell.s } }], label);
        const next = this._uniqueTableHeaders(sheet, table, new Set([c - table.range.c1]));
        const newName = next[c - table.range.c1];
        if (newName !== oldName) {
          const names = tableColumnRenames(oldNames, next);
          this._rewriteFormulas((f, s, rr, cc) => renameColumnsInFormula(f, table.name, names, this.tableAt(s.id, rr, cc)?.name || null), label);
          this._rewriteColumnRuleReferences(sheet, [{ table, names }], label);
          // A defined name that spells out the column (SUM(T[Qty])) follows the rename too.
          this._rewriteNamedFormulas((f) => renameColumnsInFormula(f, table.name, names, null), label);
        }
      }
      if (table && !header) this._calculatedColumn(sheet, table, r, c, cell);
      this._autoExpandTable(sheet, r, c, cell);
    });
  }

  /**
   * A typed formula that stops short of its closing parentheses (=SUM(A1:A2) gets them)
   * when that alone makes it readable. Nothing else is corrected.
   */
  _closeParentheses(formula) {
    if (this._astOrNull(formula)) return formula;
    let open = 0;
    let quoted = false;
    for (const ch of formula) {
      if (ch === '"') quoted = !quoted;
      else if (quoted) continue;
      else if (ch === '(') open++;
      else if (ch === ')') open--;
    }
    if (open <= 0) return formula;
    const closed = formula + ')'.repeat(open);
    return this._astOrNull(closed) ? closed : formula;
  }

  /**
   * A formula typed into a table column whose other data cells are empty (or
   * already hold that formula) becomes the column's formula: every data row
   * gets it, and rows added later inherit it. Typing a plain value into a
   * calculated column's cell just overrides that cell.
   */
  _calculatedColumn(sheet, table, r, c, cell) {
    const rows = tableRows(table);
    if (r < rows.dataStart || r > rows.dataEnd) return;
    const offset = c - table.range.c1;
    if (cell?.f == null) return;
    const entries = [];
    for (let rr = rows.dataStart; rr <= rows.dataEnd; rr++) {
      if (rr === r) continue;
      const other = sheet.cells.get(cellKey(rr, c));
      const expected = shiftFormula(cell.f, rr - r, 0);
      if (other && (other.v != null || other.f != null) && other.f !== expected) return; // the column holds other content: leave it alone
      if (!other || other.f !== expected) entries.push({ r: rr, c, cell: { v: null, f: expected, s: other?.s ?? cell.s } });
    }
    // One protected cell among the rows to fill refuses the fill whole, as it refuses a paste, and is
    // announced the same way; the formula is then no template, or the column would be left half
    // calculated, with only the rows added later taking it.
    if (entries.length && sheet.protectedRanges.length) {
      for (const { r: rr, c: cc } of entries) {
        const p = this._protectedAt(sheet, rr, cc);
        if (p) { this._emit('protected', sheet.id, { range: p.range, description: p.description }); return; }
      }
    }
    const first = shiftFormula(cell.f, (table.calcRow ?? rows.dataStart) - r, 0);
    const next = { ...table, calc: { ...table.calc, [offset]: first } };
    this._setTables(sheet, sheet.tables.map((t) => (t.id === table.id ? next : t)), 'Edit cell');
    if (entries.length) this.setCells(sheet.id, entries, 'Edit cell');
  }

  /** Write a table's calculated columns into one data row (a row that was just added). */
  _fillCalculatedRow(sheet, table, r, skipCol = -1) {
    const entries = this._calculatedRowEntries(sheet, table, r, skipCol);
    if (entries.length) this.setCells(sheet.id, entries, 'Resize table');
  }

  /** The calculated-column cells a data row still lacks, as setCells entries. */
  _calculatedRowEntries(sheet, table, r, skipCol = -1) {
    const rows = tableRows(table);
    const entries = [];
    for (const [k, f] of Object.entries(table.calc || {})) {
      const c = table.range.c1 + Number(k);
      if (c === skipCol || c > table.range.c2) continue;
      const cell = sheet.cells.get(cellKey(r, c));
      if (cell && (cell.v != null || cell.f != null)) continue;
      const aboveRow = Math.max(rows.dataStart, r - 1);
      const above = sheet.cells.get(cellKey(aboveRow, c));
      const reset = styleResetAt(sheet.styleResets, aboveRow, c);
      entries.push({ r, c, cell: { v: null, f: shiftFormula(f, r - (table.calcRow ?? rows.dataStart), 0), s: reset ? { ...reset, ...above?.s } : above?.s } });
    }
    return entries;
  }

  /**
   * Replace a batch of cells in one undoable step. `cell` is { v, f, s } or
   * null to clear. Rows and columns grow to fit. Returns the number changed.
   */
  setCells(sheetId, entries, label = 'Edit', { arrayRange = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !entries.length) return 0;
    // On a protected sheet only cells the user unlocked take new contents, and they keep their unlocked mark.
    if (sheet.protected && !sheet.externalCache && sheet.kind !== 'chart' && entries.every(({ r, c, cell }) => this._unlockedCell(sheet, r, c) && contentOnly(sheet.cells.get(cellKey(r, c))?.s, cell?.s))) {
      entries = entries.map((e) => (e.cell && e.cell.s?.locked !== false ? { ...e, cell: { ...e.cell, s: { ...(e.cell.s || {}), locked: false } } } : e));
    } else if (this._gridLocked(sheet)) return 0;
    // A cell past the grid's edge would be stored where no view, export or reference reaches: such entries are left out
    // (a paste clips its block beforehand and says so) and the rest of the batch is written, so a caller that did not clip
    // loses those cells alone rather than its whole edit; a batch with nothing left in the grid changes nothing.
    const limit = gridLimits(sheet);
    const off = ({ r, c }) => !inGrid(r, c, limit);
    if (entries.some(off)) {
      entries = entries.filter((e) => !off(e));
      if (!entries.length) return 0;
    }
    if (sheet.protectedRanges.length) {
      // One protected cell in the batch refuses the whole edit, so a paste never half-lands.
      for (const { r, c } of entries) {
        const p = this._protectedAt(sheet, r, c);
        if (p) { this._emit('protected', sheet.id, { range: p.range, description: p.description }); return 0; }
      }
    }
    if (this._fixedWritesBlocked(sheet, entries, arrayRange)) return 0;
    // Only the cells this call really writes are completed, and only they withdraw the document's external-content
    // trust: a paste a protected sheet refused, or one whose block fell off the grid, wrote nothing and must leave
    // every IMPORTRANGE in the book working. The withdrawal follows the write, so the banner never goes up before
    // the cell that raised it is there; nothing is calculated in between, so a blocked formula still cannot reach out.
    let reachesOut = false;
    entries = entries.map((e) => {
      const cell = this._completedFormulaCell(e.cell);
      if (cell === e.cell) return e;
      if (this.externalAllowed && formulaReachesOut(cell.f)) reachesOut = true;
      return { ...e, cell };
    });
    const written = this._writeCells(sheet, entries, label);
    if (reachesOut) this.setExternalAllowed(false);
    return written;
  }

  /**
   * A formula written through setCells, stored as a typed one is (setInput): one that stops short of its closing
   * parentheses is completed when that alone makes it readable, and one longer than a formula may be stays the text it
   * would have been typed as. A completed formula that reaches outside the file (=MAP(url,IMPORTDATA) is blocked by
   * its caller until the user allows it: the paste's own scan could not read the unclosed text, and F2+Enter would
   * otherwise have run it.
   */
  _completedFormulaCell(cell) {
    const f = cell?.f;
    if (typeof f !== 'string') return cell;
    // Only a formula left one parenthesis short is completed here, as a typed one is. A formula that is whole is
    // written as given, however long: a sort, a shuffle or a table resize passes the cells a file loaded back through
    // this door, and must not turn a formula the parser cannot follow into text on the way.
    if (f.length > MAX_FORMULA_LENGTH || !unclosedParens(f)) return cell;
    const closed = this._closeParentheses(f);
    if (closed === f) return cell;
    if (closed.length > MAX_FORMULA_LENGTH) return { ...cell, v: `=${f}`, f: null };
    return { ...cell, f: closed };
  }

  /** Record already-authorized cell changes; user edits must go through setCells. */
  _writeCells(sheet, entries, label) {
    const sheetId = sheet.id;
    let maxR = -1;
    let maxC = -1;
    let minR = Infinity;
    let minC = Infinity;
    let formula = false; // whether a formula is among the cells written over or written (its result may spill past them)
    let arrays = false;
    const before = [];
    const after = [];
    const changedContent = [];
    const beforeIgnored = sheet.ignoredErrors;
    let cut = null; // the first cell whose text was cut to fit, announced once for the batch
    for (const { r, c, cell } of entries) {
      const key = cellKey(r, c);
      const prev = cloneCell(sheet.cells.get(key));
      const next = isEmptyCell(cell) ? null : cloneCell(cell);
      if (typeof next?.v === 'string' && next.v.length > MAX_TEXT) {
        // A cell holds no more text than a file can store, whichever door the text came in by (typed, pasted,
        // filled, or written by a script); what is kept is announced so the editor can say so. The cut falls on a
        // character boundary: an emoji at the limit goes whole rather than leaving half a pair.
        const value = next.v.slice(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, '');
        if (next.richText) {
          const rich = normalizeRichText(next.richText, next.v, value.length);
          if (rich) next.richText = rich; else delete next.richText;
        }
        next.v = value;
        cut ??= { r, c };
      }
      if (sameCell(prev, next)) continue;
      if (beforeIgnored.length && (!sameJSON(prev?.v ?? null, next?.v ?? null) || (prev?.f ?? null) !== (next?.f ?? null))) changedContent.push({ r, c });
      before.push({ key, cell: prev });
      after.push({ key, cell: next });
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (c < minC) minC = c;
      if (prev?.f != null || next?.f != null) formula = true;
      if (prev?.array || next?.array) arrays = true;
    }
    if (!after.length) return 0;
    const afterIgnored = clearRangeFlagsAtCells(beforeIgnored, changedContent);
    const box = { r1: minR, c1: minC, r2: maxR, c2: maxC }; // the cells the write covers, for whoever asks what changed (see changesSince)
    const apply = (list, ignored) => {
      // Looked up by id: a structural undo in the same transaction may have replaced the sheet object.
      const live = this.sheet(sheetId);
      if (!live) return;
      live.ignoredErrors = ignored;
      if (arrays) this._fixedArrayIndexes.delete(live);
      // The last row and column holding content follow the cells written; only clearing a cell
      // on that edge calls for the scan of every cell that finding them again would be.
      let bounds = this._cellBoundsCache.get(live.id);
      if (bounds) bounds = { ...bounds };
      for (const { key, cell } of list) {
        if (cell) live.cells.set(key, cloneCell(cell));
        else live.cells.delete(key);
        if (!bounds) continue;
        const { r, c } = parseKey(key);
        if (cell && (cell.v != null || cell.f != null)) { if (r > bounds.r2) bounds.r2 = r; if (c > bounds.c2) bounds.c2 = c; }
        else if (r === bounds.r2 || c === bounds.c2) bounds = null;
      }
      this._growTo(live, maxR + 1, maxC + 1);
      if (list.some(({ cell }) => cell?.externalResult && !cell.externalResult.context)) {
        this._invalidate();
        for (const { key, cell } of list) if (cell?.externalResult && !cell.externalResult.context) {
          const { r, c } = parseKey(key);
          const context = this._externalCallerContext(live, r, c, cell.f);
          cell.externalResult.context = context;
          live.cells.get(key).externalResult.context = { ...context };
        }
      }
      this._changed('cells', live.id, { box, formula });
      if (bounds) this._cellBoundsCache.set(live.id, bounds);
    };
    // Grouped sheets: the cells written on the active sheet are noted, to be written again on the rest of the group.
    if (this._groupRecorder?.sheetId === sheetId) for (let i = 0; i < before.length; i++) this._groupRecorder.writes.push({ key: before[i].key, prev: before[i].cell, next: after[i].cell });
    apply(after, afterIgnored);
    recordCellWrites(this, sheet, before, after, label, box);
    // The before-and-after pair the step closes over is the memory it costs, and a sort, fill, paste or
    // replace-all holds a clone of every cell it touched twice over. Weighed against the same budget as a
    // structural step's snapshots, so that a history of them cannot grow without end (see _evictSnapshots).
    this._push({ label, undo: () => apply(before, beforeIgnored), redo: () => apply(after, afterIgnored), snapshotCells: before.length + after.length + (beforeIgnored === afterIgnored ? 0 : beforeIgnored.length + afterIgnored.length) });
    // Said once the shortened text is stored, so a listener reading the cell sees what was kept, and only
    // for a write that happened: pasting the same long text a second time changes nothing and says nothing.
    if (cut) this._announce('truncated', sheetId, { ...cut, max: MAX_TEXT });
    return after.length;
  }

  /**
   * Replace the formulas in a range with the values they show, formatting and
   * links kept; an array formula's spilled cells become plain values too.
   * Formulas whose result is an error stay. Returns how many were replaced.
   */
  formulasToValues(sheetId, range) {
    if (this.arrayEditBlocked(sheetId, range, { whole: true })) return 0;
    const { entries, count } = this.formulaValueSnapshot(sheetId, [range]);
    // A protected sheet or range refuses the whole batch: then nothing was replaced, whatever was counted.
    if (!entries.length || !this.setCells(sheetId, entries, 'Replace formulas with values')) return 0;
    return count;
  }

  /**
   * Read formula results and their spilled cells without rewriting any inputs. Import takes this
   * snapshot before changing references, so ISFORMULA and FORMULATEXT still see the source file.
   * Normal formula-to-value conversion keeps errors and links; import can capture those too when
   * their formulas refer to sheets that are not coming along.
   */
  formulaValueSnapshot(sheetId, ranges, { includeErrors = false, includeLinks = false } = {}) {
    const sheet = this.sheet(sheetId);
    const entries = [];
    if (!sheet) return { entries, count: 0 };
    const seen = new Set();
    let n = 0;
    const plain = (cell, v) => { const next = { ...cell, v: v == null ? null : v, f: null }; delete next.structured; delete next.array; return next; };
    for (const range of ranges) {
      const { r1, c1, r2, c2 } = normalizeRange(range);
      for (let r = r1; r <= Math.min(r2, sheet.rows - 1); r++) {
        for (let c = c1; c <= Math.min(c2, sheet.cols - 1); c++) {
          const key = cellKey(r, c), cell = sheet.cells.get(key);
          if (!cell || cell.f == null || seen.has(key)) continue;
          // A link is a HYPERLINK formula: made plain it would be only its label, so it stays, as errors do.
          if (!includeLinks && this.linkAt(sheetId, r, c)) continue;
          const value = scalar(this._compute(sheet, r, c));
          if (!includeErrors && isError(value)) continue;
          const spill = this.spillRangeAt(sheetId, r, c);
          if (spill) {
            const fmt = !cell.array && cell.s ? Object.fromEntries(Object.entries(cell.s).filter(([k, v]) => ['fmt', 'dec', 'cur', 'dateStyle', 'group', 'code'].includes(k) && v != null)) : null;
            for (let rr = spill.r1; rr <= Math.min(spill.r2, sheet.rows - 1); rr++) {
              for (let cc = spill.c1; cc <= Math.min(spill.c2, sheet.cols - 1); cc++) {
                const key = cellKey(rr, cc);
                if (seen.has(key)) continue;
                seen.add(key);
                const sv = rr === r && cc === c ? value : this.spillAt(sheetId, rr, cc)?.value;
                const prev = sheet.cells.get(key) || {};
                const base = rr === r && cc === c ? cell : { ...prev, s: prev.s || (fmt && Object.keys(fmt).length ? fmt : undefined) };
                entries.push({ r: rr, c: cc, cell: plain(base, !cell.array && !includeErrors && isError(sv) ? null : sv) });
              }
            }
          } else {
            seen.add(key);
            entries.push({ r, c, cell: plain(cell, value) });
          }
          n++;
        }
      }
    }
    return { entries, count: n };
  }

  /**
   * The lines a range covers whole, for a format that belongs to the line rather than to its cells: the
   * columns of a whole-column selection (it starts at the first row and reaches the sheet's last, which
   * is what selection.js produces), or the rows of a whole-row one; columns first, so Select all is a
   * format on the columns. Null when the range covers neither, when it spans a single line (a sheet of
   * one row would make every cell of it a whole column), when a filter leaves rows out, or when the
   * range is protected, so that the ordinary cell path refuses the edit and says so as it does now.
   */
  _wholeLines(sheet, { r1, c1, r2, c2 }, skipRow = null) {
    if (skipRow || sheet.protected) return null;
    if (sheet.protectedRanges.some(({ range: g }) => g.r1 <= r2 && g.r2 >= r1 && g.c1 <= c2 && g.c2 >= c1)) return null;
    const axis = r1 === 0 && r2 > r1 && r2 >= sheet.rows - 1 ? 'col' : c1 === 0 && c2 > c1 && c2 >= sheet.cols - 1 ? 'row' : null;
    if (!axis) return null;
    const from = axis === 'col' ? c1 : r1;
    const to = Math.min(axis === 'col' ? c2 : r2, axis === 'col' ? MAX_COL : MAX_ROW);
    if (to < from || to - from + 1 > STYLE_FILL_CELLS) return null;
    const indices = [];
    for (let i = from; i <= to; i++) indices.push(i);
    return { axis, indices };
  }

  /**
   * Set or clear the default format of whole columns or rows, in one undoable step; `patch` of null takes
   * their format away altogether (Clear formats). Returns how many lines changed.
   */
  _setLineStyles(sheet, axis, indices, patch, label) {
    const sheetId = sheet.id;
    const field = axis === 'col' ? 'colStyles' : 'rowStyles';
    const before = [];
    const after = [];
    for (const i of indices) {
      const prev = sheet[field].get(i);
      const next = patch === null ? undefined : styleWithPatch(prev, patch, this.defaultStyle(sheet));
      if (sameJSON(prev ?? null, next ?? null)) continue;
      before.push([i, prev]);
      after.push([i, next]);
    }
    if (!after.length) return 0;
    const apply = (list) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      for (const [i, st] of list) { if (st) live[field].set(i, cloneStyle(st)); else live[field].delete(i); }
      this._changed('cells', live.id);
    };
    apply(after);
    this._push({ label, undo: () => apply(before), redo: () => apply(after) });
    return after.length;
  }

  /** Sparse Clear formats exceptions, kept in the same undo step as cell/default edits. */
  _setStyleResets(sheet, records, label) {
    const before = sheet.styleResets;
    if (before === records || (!before.length && !records.length)) return;
    const after = compactStyleResets(records);
    if (sameJSON(before, after)) return;
    const apply = (value) => {
      const live = this.sheet(sheet.id);
      if (!live) return;
      live.styleResets = value;
      this._changed('cells', live.id);
    };
    apply(after);
    this._push({ label, undo: () => apply(before), redo: () => apply(after), snapshotCells: before.length + after.length });
  }

  /**
   * Merge style fields into every cell of a range; null removes a field.
   * `skipRow(r)` leaves a row out (the rows a filter hides), so a filtered
   * list is formatted in one call and one undo step however many runs of
   * shown rows it has.
   *
   * A whole column or row keeps the format on the line itself, so it holds
   * for the lines the sheet has not reached yet (see styleAt); its cells are
   * then formatted the way a selection over the cap is, so a sheet scrolled
   * to row 20,000 no longer stores a blank cell for every one of them.
   *
   * Over more than STYLE_FILL_CELLS cells the format goes to the cells
   * holding something, and to the empty cells beside them as far as a fresh
   * sheet reaches (100 rows, 26 columns) past the last of them while that
   * block stays within the cap; the other empty cells keep the default.
   */
  applyStyle(sheetId, range, patch, { skipRow = null } = {}) {
    // Choosing a family explicitly removes its former theme binding, including
    // when the selected family happens to match the current theme.
    patch = nativeFillPatch(fontPatch(patch));
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const { r1, c1, r2, c2 } = normalizeRange(range);
    const rows = Math.min(r2, sheet.rows - 1);
    const cols = Math.min(c2, sheet.cols - 1);
    const entries = [];
    const lines = this._wholeLines(sheet, { r1, c1, r2, c2 }, skipRow);
    // Whole-line edits change the default itself. A smaller selection needs an explicit reset
    // where the unchanged line would otherwise restore the property the user just removed.
    const keys = Object.entries(patch);
    const resets = !lines && keys.some(([k, v]) => removesStyleKey(k, v));
    const numberFormat = keys.some(([k]) => isNumberFormatKey(k));
    const resetsSpill = numberFormat && keys.some(([k, v]) => isNumberFormatKey(k) && removesStyleKey(k, v));
    const format = (r, c, prev) => {
      let inherited = resets ? this._lineStyle(sheet, r, c) : null;
      // A spill's anchor keeps its format when its destination is reset, even for a whole-line edit.
      if (resetsSpill && (!prev || (prev.v == null && prev.f == null))) {
        const spill = this.spillAt(sheetId, r, c)?.style;
        if (spill) inherited = { ...inherited, ...spill };
      }
      entries.push({ r, c, cell: { ...prev, v: prev?.v ?? null, f: prev?.f ?? null,
        ...(prev?.richText ? { richText: patchRichText(prev.richText, richTextValue(prev.richText), patch) } : {}),
        s: styleWithPatch(prev?.s, patch, inherited) } });
    };
    if (!lines && (rows - r1 + 1) * (cols - c1 + 1) <= STYLE_FILL_CELLS) {
      for (let r = r1; r <= rows; r++) {
        if (skipRow?.(r)) continue;
        for (let c = c1; c <= cols; c++) format(r, c, sheet.cells.get(cellKey(r, c)));
      }
    } else {
      // The stored cells of the range, and the block they span.
      const stored = new Set();
      let br1 = Infinity, bc1 = Infinity, br2 = -1, bc2 = -1;
      for (const [key, cell] of sheet.cells) {
        const { r, c } = parseKey(key);
        if (r < r1 || r > rows || c < c1 || c > cols || skipRow?.(r)) continue;
        format(r, c, cell);
        stored.add(key);
        if (r < br1) br1 = r;
        if (r > br2) br2 = r;
        if (c < bc1) bc1 = c;
        if (c > bc2) bc2 = c;
      }
      // Spills are visible data even without stored cells. Finite selections must format them;
      // whole lines also need number-format overrides because the anchor stands over line defaults.
      if (numberFormat || !lines) for (const { r, c } of this.spillEntries(sheetId, { r1, c1, r2: rows, c2: cols })) {
        const key = cellKey(r, c);
        if (r < r1 || r > rows || c < c1 || c > cols || skipRow?.(r) || stored.has(key)) continue;
        format(r, c, null);
        stored.add(key);
      }
      // The empty cells beside them: from the range's corner when it holds nothing yet.
      const er1 = br2 < 0 ? r1 : br1, ec1 = br2 < 0 ? c1 : bc1;
      const er2 = Math.min(rows, (br2 < 0 ? r1 - 1 : br2) + DEFAULT_ROWS);
      const ec2 = Math.min(cols, (br2 < 0 ? c1 - 1 : bc2) + DEFAULT_COLS);
      if ((er2 - er1 + 1) * (ec2 - ec1 + 1) <= STYLE_FILL_CELLS) {
        for (let r = er1; r <= er2; r++) {
          if (skipRow?.(r)) continue;
          for (let c = ec1; c <= ec2; c++) if (!stored.has(cellKey(r, c))) format(r, c, null);
        }
      }
    }
    if (!lines) { this.setCellsWithTableHeaders(sheetId, entries, 'Format', { r1, c1, r2: rows, c2: cols }); return; }
    this.transaction('Format', () => {
      this._setLineStyles(sheet, lines.axis, lines.indices, patch, 'Format');
      const area = lines.axis === 'col' ? { ...GRID_RANGE, c1, c2 } : { ...GRID_RANGE, r1, r2 };
      this._setStyleResets(sheet, removeStyleResets(sheet.styleResets, area, Object.keys(patch)), 'Format');
      this.setCellsWithTableHeaders(sheetId, entries, 'Format', { r1, c1, r2: rows, c2: cols });
    });
  }

  /** Batch edits that rename table headers must keep references and templates in step. */
  setCellsWithTableHeaders(sheetId, entries, label = 'Edit', range = null, options = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !entries.length) return 0;
    if (!sheet.tables.length) return this.setCells(sheetId, entries, label, options);
    if (!range) {
      range = { r1: Infinity, c1: Infinity, r2: -Infinity, c2: -Infinity };
      for (const { r, c } of entries) {
        range.r1 = Math.min(range.r1, r); range.r2 = Math.max(range.r2, r);
        range.c1 = Math.min(range.c1, c); range.c2 = Math.max(range.c2, c);
      }
    }
    const { r1, c1, r2, c2 } = range;
    const headers = sheet.tables.filter((t) => t.headerRow !== false && t.range.r1 >= r1 && t.range.r1 <= r2 && t.range.c1 <= c2 && t.range.c2 >= c1)
      .map((table) => ({ table, names: this.tableColumns(sheet.id, table) }));
    if (!headers.length) return this.setCells(sheet.id, entries, label, options);
    // Explicit formula edits already express the user's chosen references.
    // In particular, Replace may have renamed them along with the headers.
    const editedFormulas = new Set(entries.filter(({ r, c, cell }) => cell?.f != null && cell.f !== this.getCell(sheetId, r, c)?.f)
      .map(({ r, c }) => cellKey(r, c)));
    let changed = 0;
    this.transaction(label, () => {
      changed = this.setCells(sheet.id, entries, label, options);
      if (!changed) return;
      const renamed = headers.map(({ table, names }) => {
        const edited = new Set(entries.filter(({ r, c }) => r === table.range.r1 && c >= table.range.c1 && c <= table.range.c2).map(({ c }) => c - table.range.c1));
        const next = this._uniqueTableHeaders(sheet, table, edited);
        return { table, names: tableColumnRenames(names, next) };
      }).filter(({ names }) => names.size);
      if (!renamed.length) return;
      this._rewriteFormulas((formula, owner, r, c, template) => {
        if (!template && owner.id === sheetId && editedFormulas.has(cellKey(r, c))) return formula;
        const ownerTable = this.tableAt(owner.id, r, c)?.name || null;
        for (const { table, names } of renamed) formula = renameColumnsInFormula(formula, table.name, names, ownerTable);
        return formula;
      }, label);
      this._rewriteColumnRuleReferences(sheet, renamed, label);
      // Defined names that spell out a renamed column follow the rename too.
      this._rewriteNamedFormulas((formula) => {
        for (const { table, names } of renamed) formula = renameColumnsInFormula(formula, table.name, names, null);
        return formula;
      }, label);
    });
    return changed;
  }

  /**
   * Column names must stay distinct, or a structured reference could not
   * say which column it means. A header just typed that repeats another
   * column's name gets a numbered suffix (Qty, Qty2), and a
   * header cleared while another column is called its default ColumnN is
   * written the first free default instead; the final names are returned.
   */
  _uniqueTableHeaders(sheet, table, edited) {
    const names = this.tableColumns(sheet.id, table);
    if (!edited.size) return names;
    const taken = new Set(names.filter((_, i) => !edited.has(i)).map((name) => name.toLowerCase()));
    const fixes = [];
    for (const i of [...edited].sort((a, b) => a - b)) {
      const r = table.range.r1, c = table.range.c1 + i;
      let cell = sheet.cells.get(cellKey(r, c));
      let fix = null;
      // Headers are text: a formula pasted or filled into one, or grown over, becomes the text
      // it shows, as one typed does (see setInput), or the column would be renamed by its inputs; a number
      // or date becomes the text it shows too, or the column's name would change with its format and the
      // regional settings, and a reference written for one spelling would break under another.
      if (cell?.f != null || (cell?.v != null && typeof cell.v !== 'string')) {
        fix = { ...cell, v: this.getDisplay(sheet.id, r, c) || null, f: null };
        cell = fix;
      }
      if (taken.has(names[i].toLowerCase())) {
        let next;
        // A blank header reads as its default ColumnN. When another column is called that, the two would be
        // one name and a reference to either could land on the first: the blank one takes the first free
        // default as text, as a table is created with, so each reference keeps the column it was written for.
        if (cell?.v == null) next = this._freeColumnName([...taken], i);
        else { let n = 2; do next = `${names[i]}${n++}`; while (taken.has(next.toLowerCase())); }
        names[i] = next;
        fix = { ...cell, v: next, f: null };
      }
      taken.add(names[i].toLowerCase());
      if (fix) fixes.push({ r, c, cell: fix });
    }
    // Through setCells, not the internal writer: a header rewritten here is an edit like any other and a
    // protected one refuses it and says so, rather than the only door in the app that writes through protection.
    if (fixes.length) this.setCells(sheet.id, fixes, 'Rename column');
    return names;
  }

  /** Clear direct and inherited borders without materializing an empty rectangle. */
  _clearBorders(sheet, range, lines) {
    if (this._gridLocked(sheet)) return;
    const { r1, c1, r2, c2 } = range;
    const area = intersection(GRID_RANGE, lines?.wholeSheet ? GRID_RANGE : lines?.axis === 'col' ? { ...GRID_RANGE, c1, c2 }
      : lines?.axis === 'row' ? { ...GRID_RANGE, r1, r2 } : range);
    if (!area) return;
    const protectedRange = sheet.protectedRanges.find(({ range: g }) => intersection(g, area));
    if (protectedRange) { this._emit('protected', sheet.id, protectedRange); return; }
    const entries = [];
    const clear = (r, c, cell) => {
      if (!cell || !BORDER_STYLE_KEYS.some(k => Object.hasOwn(cell.s || {}, k))) return;
      const s = { ...cell.s };
      for (const k of BORDER_STYLE_KEYS) delete s[k];
      entries.push({ r, c, cell: { ...cell, s: Object.keys(s).length ? s : undefined } });
    };
    if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) < sheet.cells.size) {
      for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) clear(r, c, sheet.cells.get(cellKey(r, c)));
    } else for (const [key, cell] of sheet.cells) {
      const { r, c } = parseKey(key);
      if (r >= area.r1 && r <= area.r2 && c >= area.c1 && c <= area.c2) clear(r, c, cell);
    }
    this.transaction('Borders', () => {
      // Whole lines should export as line defaults, not a million explicit
      // blank exceptions. Crossing defaults on the other axis still need a reset.
      const patch = Object.fromEntries(BORDER_STYLE_KEYS.map(k => [k, null]));
      for (const axis of lines?.wholeSheet ? ['col', 'row'] : lines ? [lines.axis] : []) {
        const defaults = axis === 'col' ? sheet.colStyles : sheet.rowStyles;
        const first = axis === 'col' ? area.c1 : area.r1, last = axis === 'col' ? area.c2 : area.r2;
        this._setLineStyles(sheet, axis, [...defaults.keys()].filter(i => i >= first && i <= last), patch, 'Borders');
      }
      const keys = new Set();
      const collect = (st) => { for (const k of BORDER_STYLE_KEYS) if (st?.[k] != null && st[k] !== false) keys.add(k); };
      const collectLines = (styles, first, last) => {
        if (last - first + 1 < styles.size) for (let i = first; i <= last; i++) collect(styles.get(i));
        else for (const [i, st] of styles) if (i >= first && i <= last) collect(st);
      };
      collectLines(sheet.colStyles, area.c1, area.c2);
      collectLines(sheet.rowStyles, area.r1, area.r2);
      const kept = removeStyleResets(sheet.styleResets, area, BORDER_STYLE_KEYS);
      this._setStyleResets(sheet, keys.size ? [...kept, { range: area, keys: [...keys] }] : kept, 'Borders');
      this.setCells(sheet.id, entries, 'Borders');
    });
  }

  /** Restyle existing sides, including inherited borders on empty cells. */
  _restyleBorders(sheet, range, options, lines) {
    if (options.color === undefined && options.style === undefined || this._gridLocked(sheet)) return;
    const wholeSheet = lines?.wholeSheet;
    const area = intersection(GRID_RANGE, wholeSheet ? GRID_RANGE : lines?.axis === 'col' ? { ...GRID_RANGE, c1: range.c1, c2: range.c2 }
      : lines?.axis === 'row' ? { ...GRID_RANGE, r1: range.r1, r2: range.r2 } : range);
    if (!area) return;
    const protectedRange = sheet.protectedRanges.find(({ range: g }) => intersection(g, area));
    if (protectedRange) { this._emit('protected', sheet.id, protectedRange); return; }
    const before = { ...sheet, ...(lines ? { colStyles: new Map(sheet.colStyles), rowStyles: new Map(sheet.rowStyles) } : {}) };
    const beforeAt = (r, c) => this._lineStyle(before, r, c);
    const entries = [];
    const restyle = (r, c, cell) => {
      if (!cell) return;
      const inherited = beforeAt(r, c);
      const effective = { ...inherited, ...cell.s };
      if (!(effective.bt || effective.bb || effective.bl || effective.br)) return;
      const next = borderSnapshot(effective, options);
      // Ordinary shared borders retain their compact representation. Explicit
      // per-side snapshots are needed when inherited edges can show through.
      const shared = BORDER_STYLE_KEYS.every(k => inherited?.[k] == null)
        && ['bt', 'bb', 'bl', 'br'].every(k => !cell.s?.[`${k}Border`]);
      const s = shared ? { ...cell.s } : { ...cell.s, ...next };
      // Keep the shared setting available to format controls; per-side values
      // preserve a mixed border when only color or weight was changed.
      if (options.color !== undefined) {
        if (shared && !options.color) delete s.bc; else s.bc = options.color || null;
      }
      if (options.style !== undefined) {
        if (shared && (!options.style || options.style === 'thin')) delete s.bs; else s.bs = options.style || 'thin';
      }
      entries.push({ r, c, cell: { ...cell, s }, border: next });
    };
    if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) < sheet.cells.size) {
      for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) restyle(r, c, sheet.cells.get(cellKey(r, c)));
    } else for (const [key, cell] of sheet.cells) {
      const { r, c } = parseKey(key);
      if (r >= area.r1 && r <= area.r2 && c >= area.c1 && c <= area.c2) restyle(r, c, cell);
    }
    this.transaction('Borders', () => {
      const patch = { ...(options.color !== undefined ? { bc: options.color } : {}), ...(options.style !== undefined ? { bs: options.style } : {}) };
      for (const axis of wholeSheet ? ['col', 'row'] : lines ? [lines.axis] : []) {
        const defaults = axis === 'col' ? before.colStyles : before.rowStyles;
        const first = axis === 'col' ? area.c1 : area.r1, last = axis === 'col' ? area.c2 : area.r2;
        const indices = [...defaults].filter(([i, st]) => i >= first && i <= last && (st.bt || st.bb || st.bl || st.br)).map(([i]) => i);
        this._setLineStyles(sheet, axis, indices, patch, 'Borders');
      }
      const regions = [...restyledBorderRegions(before, area, beforeAt, (r, c) => this._lineStyle(sheet, r, c), options)];
      this._setStyleResets(sheet, assignStyleExceptionRegions(sheet.styleResets, regions), 'Borders');
      // Changing inherited storage from shared settings to per-side values
      // must not displace a stored cell's existing shared color or weight.
      // Compare after the inherited edit, so no-op cells stay out of history.
      this.setCells(sheet.id, entries.filter(({ r, c, border }) => !sameJSON(border,
        borderSnapshot({ ...this._lineStyle(sheet, r, c), ...sheet.cells.get(cellKey(r, c))?.s }))), 'Borders');
    });
  }

  /** Disjoint inherited border regions for bounded readers such as printing.
   * Stored cell overrides are separate, as they are in the style model. */
  *inheritedBorderRegions(sheetId, range) {
    const sheet = this.sheet(sheetId), area = intersection(GRID_RANGE, range);
    if (!sheet || !area) return;
    yield* changedBorderRegions(sheet, area, (r, c) => this._lineStyle(sheet, r, c), () => null,
      style => style?.bt || style?.bb || style?.bl || style?.br ? borderSnapshot(style) : null);
  }

  /** Paint full finite rectangles or line defaults without a cell-area cutoff. */
  _paintSparseBorders(sheet, range, kind, options, lines) {
    if (this._gridLocked(sheet)) return;
    const wholeSheet = lines?.wholeSheet;
    const wholeCols = wholeSheet || lines?.axis === 'col', wholeRows = wholeSheet || lines?.axis === 'row';
    const area = intersection(GRID_RANGE, { ...range,
      ...(wholeCols ? { r1: GRID_RANGE.r1, r2: GRID_RANGE.r2 } : {}),
      ...(wholeRows ? { c1: GRID_RANGE.c1, c2: GRID_RANGE.c2 } : {}) });
    if (!area) return;
    const protectedRange = sheet.protectedRanges.find(({ range: g }) => {
      const cut = intersection(g, area);
      if (!cut) return false;
      if (!['top', 'bottom', 'left', 'right'].includes(kind)) return true;
      return [cut.r1, cut.r2].some(r => [cut.c1, cut.c2].some(c =>
        borderPaintSides(kind, area, r, c, { wholeCols, wholeRows }).length));
    });
    if (protectedRange) { this._emit('protected', sheet.id, protectedRange); return; }
    const before = { ...sheet, ...(lines ? { colStyles: new Map(sheet.colStyles), rowStyles: new Map(sheet.rowStyles) } : {}) };
    const beforeAt = (r, c) => this._lineStyle(before, r, c);
    const paint = (st, r, c) => paintedBorder(st, area, r, c, kind, options, { wholeCols, wholeRows });
    const candidates = [];
    for (const [key, cell] of sheet.cells) {
      const { r, c } = parseKey(key);
      if (r < area.r1 || r > area.r2 || c < area.c1 || c > area.c2) continue;
      const border = paint({ ...beforeAt(r, c), ...cell.s }, r, c);
      if (border) candidates.push({ r, c, cell: { ...cell, s: { ...cell.s, ...border } }, border });
    }
    this.transaction('Borders', () => {
      for (const axis of wholeSheet ? ['col', 'row'] : lines ? [lines.axis] : []) {
        // Group equal patches so a sheet-wide pen creates one undoable line
        // update, rather than thousands of independent history closures.
        const defaults = axis === 'col' ? before.colStyles : before.rowStyles;
        const groups = new Map(), first = axis === 'col' ? area.c1 : area.r1, last = axis === 'col' ? area.c2 : area.r2;
        const indices = wholeSheet && axis === 'row' ? [...defaults.keys()]
          : Array.from({ length: last - first + 1 }, (_, i) => first + i);
        for (const i of indices) {
          const painted = borderPaintPatch(defaults.get(i), area, axis === 'col' ? area.r1 : i,
            axis === 'col' ? i : Math.min(area.c1 + 1, area.c2), kind, options, { wholeCols, wholeRows });
          if ((options.perSide || options.remove) && painted
            && sameJSON(borderPaintState(painted), borderPaintState(defaults.get(i)))) continue;
          // Explicit removals clear old shared pens without freezing missing
          // fields that should continue to inherit the crossing line.
          const patch = painted && { ...Object.fromEntries(Object.keys(defaults.get(i) || {}).filter(k => BORDER_STYLE_KEYS.includes(k) && !Object.hasOwn(painted, k)).map(k => [k, null])), ...painted };
          if (!patch || !options.remove && !['bt', 'bb', 'bl', 'br'].some(k => patch[k])) continue;
          const signature = JSON.stringify(patch);
          if (!groups.has(signature)) groups.set(signature, { patch, indices: [] });
          groups.get(signature).indices.push(i);
        }
        for (const { patch, indices } of groups.values()) this._setLineStyles(sheet, axis, indices, patch, 'Borders');
      }
      const regions = [...changedBorderRegions(before, area, beforeAt, (r, c) => this._lineStyle(sheet, r, c), paint,
        { rows: [area.r1 + 1, area.r2], cols: [area.c1 + 1, area.c2] }, borderPaintState)];
      this._setStyleResets(sheet, assignStyleExceptionRegions(sheet.styleResets, regions), 'Borders');
      const entries = candidates.filter(({ r, c, border }) => !sameJSON(borderPaintState(border),
        borderPaintState({ ...this._lineStyle(sheet, r, c), ...sheet.cells.get(cellKey(r, c))?.s })));
      this._mirrorMergeBorders(sheet, area, entries, options.perSide || options.remove ? {} : options);
      this.setCells(sheet.id, entries, 'Borders');
    });
  }

  /**
   * kind: 'all' | 'outer' | 'inner' | 'horizontal' | 'vertical' | 'top' | 'bottom' | 'left' | 'right' | 'none'
   * | 'restyle' (keep the sides, change color/style). `color` (hex) and
   * `style` (thin, medium, thick, dashed, dotted, double) apply to every
   * cell the call touches; null means the default, undefined keeps the
   * cell's current color or style.
   * `perSide` paints only the chosen sides with independent pens. `remove`
   * clears only those sides, including inherited edges, and ignores the pen.
   *
   * Legacy small finite selections retain direct cell styles; independent
   * edge gestures and large selections use equivalent sparse rectangles.
   * Whole lines use defaults that also apply
   * beyond the currently allocated grid. `scope` ('columns', 'rows', 'sheet')
   * identifies header selections; ordinary coordinate ranges remain finite.
   */
  applyBorders(sheetId, range, kind, { color = undefined, style = undefined, scope = range.scope, perSide = false, remove = false } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const { r1, c1, r2, c2 } = normalizeRange(range);
    const rows = Math.min(r2, sheet.rows - 1);
    const cols = Math.min(c2, sheet.cols - 1);
    if (rows < r1 || cols < c1) return;
    const area = { r1, c1, r2: rows, c2: cols };
    // Reaching the allocated edge does not make a finite form a whole line.
    // Header selections explicitly name their scope; their defaults also apply
    // to future cells. Protection is checked over that actual affected region.
    const lines = ['columns', 'rows', 'sheet'].includes(scope)
      ? { axis: scope === 'rows' ? 'row' : 'col', wholeSheet: scope === 'sheet' } : null;
    if (kind === 'none') { this._clearBorders(sheet, area, lines); return; }
    if (kind === 'restyle') { this._restyleBorders(sheet, area, { color, style }, lines); return; }
    if (!['all', 'outer', 'inner', 'horizontal', 'vertical', 'top', 'bottom', 'left', 'right'].includes(kind)) return;
    if (perSide || remove || lines || (rows - r1 + 1) * (cols - c1 + 1) > STYLE_FILL_CELLS) {
      this._paintSparseBorders(sheet, area, kind, { color, style, perSide, remove }, lines); return;
    }
    const entries = [];
    for (let r = r1; r <= rows; r++) for (let c = c1; c <= cols; c++) {
      const prev = sheet.cells.get(cellKey(r, c));
      const inherited = this._lineStyle(sheet, r, c);
      const st = { ...Object.fromEntries(BORDER_STYLE_KEYS.filter(k => inherited && Object.hasOwn(inherited, k)).map(k => [k, inherited[k]])), ...prev?.s };
      const edge = { bt: r === r1, bb: r === rows, bl: c === c1, br: c === cols };
      const set = (key, on) => { if (on) st[key] = true; else { delete st[key]; delete st[`${key}Border`]; } };
      if (kind === 'all') { set('bt', true); set('bb', true); set('bl', true); set('br', true); }
      else if (kind === 'outer') { for (const k of ['bt', 'bb', 'bl', 'br']) if (edge[k]) set(k, true); }
      else if (kind === 'inner') { if (!edge.bt) set('bt', true); if (!edge.bb) set('bb', true); if (!edge.bl) set('bl', true); if (!edge.br) set('br', true); }
      else if (kind === 'horizontal') { if (!edge.bt) set('bt', true); if (!edge.bb) set('bb', true); }
      else if (kind === 'vertical') { if (!edge.bl) set('bl', true); if (!edge.br) set('br', true); }
      else if (kind === 'top' && edge.bt) set('bt', true);
      else if (kind === 'bottom' && edge.bb) set('bb', true);
      else if (kind === 'left' && edge.bl) set('bl', true);
      else if (kind === 'right' && edge.br) set('br', true);
      else continue;
      // One color and style per cell: a call that names them repaints the
      // cell's whole border; undefined leaves what is there.
      const any = st.bt || st.bb || st.bl || st.br;
      if (!any) continue;
      else {
        if (color !== undefined) { if (color) st.bc = color; else if (inherited?.bc != null) st.bc = null; else delete st.bc; }
        if (style !== undefined) { if (style && style !== 'thin') st.bs = style; else if (inherited?.bs != null) st.bs = 'thin'; else delete st.bs; }
        for (const key of ['bt', 'bb', 'bl', 'br']) if (st[`${key}Border`]) st[`${key}Border`] = {
          ...st[`${key}Border`], ...(color !== undefined ? { bc: color || null } : {}), ...(style !== undefined ? { bs: style || 'thin' } : {}),
        };
      }
      entries.push({ r, c, cell: { ...prev, v: prev?.v ?? null, f: prev?.f ?? null, s: Object.keys(st).length ? st : undefined } });
    }
    this._mirrorMergeBorders(sheet, { r1, c1, r2: rows, c2: cols }, entries, { color, style });
    this.setCells(sheetId, entries, 'Borders');
  }

  /** Retain anchor border summaries for merged-cell editing and copied styles. */
  _mirrorMergeBorders(sheet, range, entries, { color, style }) {
    const written = new Map(entries.map((e) => [cellKey(e.r, e.c), e]));
    const styleAt = (r, c) => ({ ...this._lineStyle(sheet, r, c), ...(written.has(cellKey(r, c)) ? written.get(cellKey(r, c)).cell.s : sheet.cells.get(cellKey(r, c))?.s) });
    for (const m of this.mergesIn(sheet.id, range)) {
      if (m.r1 < range.r1 || m.c1 < range.c1) continue;
      const key = cellKey(m.r1, m.c1);
      let entry = written.get(key);
      if (!entry) {
        const prev = sheet.cells.get(key);
        entry = { r: m.r1, c: m.c1, cell: { ...prev, v: prev?.v ?? null, f: prev?.f ?? null, s: prev?.s ? { ...prev.s } : undefined } };
        entries.push(entry);
        written.set(key, entry);
      }
      const inherited = this._lineStyle(sheet, m.r1, m.c1);
      const effective = styleAt(m.r1, m.c1);
      const st = { ...Object.fromEntries(BORDER_STYLE_KEYS.filter(k => Object.hasOwn(effective, k)).map(k => [k, effective[k]])), ...entry.cell.s };
      const bottom = styleAt(m.r2, m.c1), right = styleAt(m.r1, m.c2);
      if (m.r2 > m.r1) { if (bottom.bb) st.bb = true; else delete st.bb; }
      if (m.c2 > m.c1) { if (right.br) st.br = true; else delete st.br; }
      if (m.r2 > m.r1 && bottom.bbBorder) st.bbBorder = { ...bottom.bbBorder };
      if (m.c2 > m.c1 && right.brBorder) st.brBorder = { ...right.brBorder };
      if (st.bt || st.bb || st.bl || st.br) {
        const from = m.r2 > m.r1 && bottom.bb ? bottom : right;
        if (color !== undefined) { if (color) st.bc = color; else if (inherited?.bc != null) st.bc = null; else delete st.bc; } else if (st.bc == null && from.bc) st.bc = from.bc;
        if (style !== undefined) { if (style && style !== 'thin') st.bs = style; else if (inherited?.bs != null) st.bs = 'thin'; else delete st.bs; } else if (st.bs == null && from.bs) st.bs = from.bs;
      } else { delete st.bc; delete st.bs; }
      entry.cell.s = Object.keys(st).length ? st : undefined;
    }
  }

  /** Bold/italic/underline/strike: set on all when the active cell lacks it, else clear. */
  toggleStyle(sheetId, range, key, active) {
    // What the active cell shows, its column's and row's defaults included, so pressing Bold in a bold
    // column clears it wherever the cursor is rather than setting it again.
    // Table/conditional differential fonts are deliberately excluded: the
    // font controls edit the direct format, leaving those styles in force.
    const on = !this.styleAt(sheetId, active.r, active.c)?.[key];
    this.applyStyle(sheetId, range, { [key]: on ? true : null });
  }

  /** Clear the contents, the styles, or both of a range; `skipRow(r)` leaves a row out (the rows a filter hides). */
  clearRange(sheetId, range, options = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const area = normalizeRange(range), contents = options.contents !== false;
    const plan = contents ? pivotClearPlan(this.nativePivots, sheetId, area, options.skipRow) : { removed: [], conflict: null };
    if (plan.conflict) {
      const { pivot, range, reason } = plan.conflict;
      this._emit('pivot-edit', sheetId, { name: pivot.name, range, reason }); return;
    }
    if (!plan.removed.length) return this._clearRange(sheetId, area, options);
    // Metadata removal must not precede a refused cell clear.
    if (this._gridLocked(sheet) || this.arrayEditBlocked(sheetId, area, { whole: true, skipRow: options.skipRow })) return;
    for (const protectedRange of sheet.protectedRanges) {
      const cut = intersection(protectedRange.range, area);
      if (!cut) continue;
      for (let r = cut.r1; r <= cut.r2; r++) if (!options.skipRow?.(r)) {
        this._emit('protected', sheetId, protectedRange); return;
      }
    }
    this.transaction('Clear', () => {
      this._removeNativePivots(plan.removed, 'Clear');
      this._clearRange(sheetId, area, options);
    });
  }

  _clearRange(sheetId, range, { contents = true, styles = false, skipRow = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const { r1, c1, r2, c2 } = normalizeRange(range);
    const areaToClear = { r1, c1, r2, c2 };
    if (contents && this.arrayEditBlocked(sheetId, areaToClear, { whole: true, skipRow })) return;
    if (styles) {
      if (this._gridLocked(sheet)) return;
      // Empty cells can inherit formatting too, so protect the entire visible selection.
      const protectedRange = sheet.protectedRanges.find(({ range: g }) => {
        const cut = intersection(g, { r1, c1, r2, c2 });
        if (!cut) return false;
        if (!skipRow) return true;
        for (let r = cut.r1; r <= cut.r2; r++) if (!skipRow(r)) return true;
        return false;
      });
      if (protectedRange) { this._emit('protected', sheet.id, protectedRange); return; }
    }
    const entries = [];
    const clear = (r, c, cell) => {
      if (contents && styles) entries.push({ r, c, cell: null });
      else if (contents) entries.push({ r, c, cell: { v: null, f: null, s: cell.s } });
      // Clearing formats neither removes a link nor brings a removed one back: the mark is no format.
      else entries.push({ r, c, cell: { ...cell, v: cell.v, f: cell.f, richText: undefined, s: cell.s?.nolink ? { nolink: true } : undefined } });
    };
    // Whichever there are fewer of is walked: the range's cells, or the sheet's (a whole-column range spans a million rows).
    if ((r2 - r1 + 1) * (c2 - c1 + 1) < sheet.cells.size) {
      for (let r = r1; r <= r2; r++) {
        if (skipRow?.(r)) continue;
        for (let c = c1; c <= c2; c++) {
          const cell = sheet.cells.get(cellKey(r, c));
          if (cell) clear(r, c, cell);
        }
      }
    } else {
      for (const [key, cell] of sheet.cells) {
        const { r, c } = parseKey(key);
        if (r < r1 || r > r2 || c < c1 || c > c2 || skipRow?.(r)) continue;
        clear(r, c, cell);
      }
    }
    // A cleared table header takes a default column name and its references follow, as when it is retyped.
    // Clearing the formats of a whole column or row takes away the format the line itself carries too,
    // or the format would come back on the next cell typed into it (see applyStyle).
    const lines = styles ? this._wholeLines(sheet, { r1, c1, r2, c2 }, skipRow) : null;
    const arrayOptions = contents ? { arrayRange: areaToClear } : {};
    if (!styles) { this.setCellsWithTableHeaders(sheetId, entries, 'Clear', areaToClear, arrayOptions); return; }
    this.transaction('Clear', () => {
      if (lines) this._setLineStyles(sheet, lines.axis, lines.indices, null, 'Clear');
      // Select all is represented as whole columns, but a sheet can carry row defaults too.
      // Clear both sets without materializing the empty cells those defaults used to format.
      const wholeSheet = lines && r1 === 0 && c1 === 0 && r2 >= sheet.rows - 1 && c2 >= sheet.cols - 1;
      if (wholeSheet) {
        const other = lines.axis === 'col' ? 'row' : 'col';
        const defaults = other === 'row' ? sheet.rowStyles : sheet.colStyles;
        this._setLineStyles(sheet, other, [...defaults.keys()], null, 'Clear');
      }
      const area = intersection(GRID_RANGE, lines?.wholeSheet ? GRID_RANGE : lines?.axis === 'col' ? { ...GRID_RANGE, c1, c2 }
        : lines?.axis === 'row' ? { ...GRID_RANGE, r1, r2 } : { r1, c1, r2, c2 });
      if (wholeSheet) this._setStyleResets(sheet, [], 'Clear');
      else if (area) {
        // Only inherited keys need exceptions. Own styles are removed below, including on blank cells.
        const keys = new Set();
        for (const [c, st] of sheet.colStyles) if (c >= area.c1 && c <= area.c2) for (const k of Object.keys(st)) keys.add(k);
        for (const [r, st] of sheet.rowStyles) if (r >= area.r1 && r <= area.r2 && !skipRow?.(r)) for (const k of Object.keys(st)) keys.add(k);
        const kept = removeStyleResets(sheet.styleResets, area, null, skipRow);
        const added = keys.size ? rowRuns(area, skipRow ? (r) => !skipRow(r) : null).map((range) => ({ range, keys: [...keys] })) : [];
        this._setStyleResets(sheet, [...kept, ...added], 'Clear');
      }
      this.setCellsWithTableHeaders(sheetId, entries, 'Clear', areaToClear, arrayOptions);
    });
  }

  /**
   * A cell as a copy carries it: its own style over the format its column and row lend it, so a cell
   * that looks formatted on screen is pasted formatted, and a blank cell of a formatted column carries
   * that column's format rather than arriving plain (see styleAt).
   */
  _copiedCell(sheet, r, c, cell = sheet.cells.get(cellKey(r, c))) {
    const line = this._lineStyle(sheet, r, c);
    if (!line) return cloneCell(cell);
    // A copied imported font is a complete appearance. Omitted regular flags
    // must not inherit bold/italic or colored ink from another workbook.
    const defaults = this.normalStyle ? { bold: false, italic: false, underline: false, strike: false, color: '#000000' } : null;
    return cloneCell({ ...cell, v: cell?.v ?? null, f: cell?.f ?? null, s: { ...defaults, ...line, ...(cell?.s || {}) } });
  }

  /** Copy a cell, materializing a spill only when its formula is not copied. */
  _copyCellReader(sheet, includes, selection) {
    let spills;
    const complete = new Map();
    return (r, c) => {
      if (!sheet) return null;
      const key = cellKey(r, c), cell = sheet.cells.get(key);
      const fixed = this._fixedArrays(sheet).at(r, c);
      if (fixed) {
        if (!complete.has(fixed.key)) complete.set(fixed.key, selection(fixed));
        const block = complete.get(fixed.key);
        if (!block.contiguous) {
          // A packed copy with omitted interior lines cannot carry one
          // rectangular array. Preserve the selected cells' displayed values.
          const value = this.getValue(sheet.id, r, c);
          return this._copiedCell(sheet, r, c, { v: value?.error ? { error: value.error } : value, f: null, s: cell?.s });
        }
        if (r === block.r1 && c === block.c1) {
          // Even a partial CSE array is copied as a smaller fixed array.
          // Its new formula origin moves from the original array anchor to
          // the selected corner, before the paste's displacement is applied.
          const anchor = sheet.cells.get(fixed.key);
          return this._copiedCell(sheet, r, c, { v: null,
            f: shiftFormula(anchor.f, r - fixed.r, c - fixed.c),
            array: { rows: block.rows, cols: block.cols }, externalResult: anchor.externalResult, s: cell?.s });
        }
        return this._copiedCell(sheet, r, c, cell);
      }
      if (cell?.v != null || cell?.f != null) return this._copiedCell(sheet, r, c, cell);
      // Resolve spill metadata once, only if the selection contains blanks.
      spills ??= this._ensureSpills(sheet);
      if (!spills.cover.has(key) && !spills.fixed.at(r, c)) return this._copiedCell(sheet, r, c, cell);
      const spill = this.spillAt(sheet.id, r, c);
      if (!spill || includes(spill.anchor.r, spill.anchor.c)) return this._copiedCell(sheet, r, c, cell);
      const v = spill.value?.error ? { error: spill.value.error } : spill.value;
      return this._copiedCell(sheet, r, c, { v, f: null, s: { ...spill.style, ...cell?.s } });
    };
  }

  /** Cells of a range as clones; unanchored spill results copy as literal values. */
  copyRange(sheetId, range) {
    const sheet = this.sheet(sheetId);
    const { r1, c1, r2, c2 } = normalizeRange(range);
    // Keep the ordinary copy loop when evaluated metadata confirms there
    // are no spilled values to materialize (the common case in the editor).
    if (!sheet || (this._spills.get(sheet.id)?.cover.size === 0 && !this._fixedArrays(sheet).size)) {
      const out = [];
      for (let r = r1; r <= r2; r++) {
        const row = [];
        for (let c = c1; c <= c2; c++) row.push(sheet ? this._copiedCell(sheet, r, c) : null);
        out.push(row);
      }
      return out;
    }
    const includes = (r, c) => r >= r1 && r <= r2 && c >= c1 && c <= c2;
    const copyCell = this._copyCellReader(sheet, includes, a => ({
      r1: Math.max(r1, a.r1), c1: Math.max(c1, a.c1),
      rows: Math.min(r2, a.r2) - Math.max(r1, a.r1) + 1,
      cols: Math.min(c2, a.c2) - Math.max(c1, a.c1) + 1, contiguous: true,
    }));
    const out = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(copyCell(r, c));
      out.push(row);
    }
    return out;
  }

  /**
   * The visible row and column indices inside a range: hidden and
   * filtered-out rows and hidden columns are left out, so a copy of a
   * filtered list carries only what is on screen.
   */
  visibleIndices(sheetId, range) {
    const { r1, c1, r2, c2 } = normalizeRange(range);
    const rows = [];
    const cols = [];
    for (let r = r1; r <= r2; r++) if (!this.isRowHidden(sheetId, r)) rows.push(r);
    for (let c = c1; c <= c2; c++) if (!this.isHidden(sheetId, 'col', c)) cols.push(c);
    return { rows, cols, all: rows.length === r2 - r1 + 1 && cols.length === c2 - c1 + 1 };
  }

  /** The cells at the given rows and columns, as copyRange gives them for a block. */
  copyCells(sheetId, rows, cols) {
    const sheet = this.sheet(sheetId);
    if (!sheet || (this._spills.get(sheet.id)?.cover.size === 0 && !this._fixedArrays(sheet).size)) {
      return rows.map((r) => cols.map((c) => (sheet ? this._copiedCell(sheet, r, c) : null)));
    }
    const selectedRows = new Set(rows), selectedCols = new Set(cols);
    const includes = (r, c) => selectedRows.has(r) && selectedCols.has(c);
    const copyCell = this._copyCellReader(sheet, includes, a => {
      const rr = rows.filter(r => r >= a.r1 && r <= a.r2), cc = cols.filter(c => c >= a.c1 && c <= a.c2);
      return { r1: rr[0], c1: cc[0], rows: rr.length, cols: cc.length,
        contiguous: rr.every((r, i) => r === rr[0] + i) && cc.every((c, i) => c === cc[0] + i) };
    });
    return rows.map((r) => cols.map((c) => copyCell(r, c)));
  }

  /** Snapshot the live rules covering a copied set of visible rows and columns. */
  copyValidations(sheetId, rows, cols) {
    return copyValidations(this.sheet(sheetId)?.validations || [], rows, cols);
  }

  /** Create a native group without replacing scalar values or existing charts. */
  createNativeSparklines(sheetId, { source = '', location = '', type = 'line', orientation = 'auto' } = {}) {
    const sheet = this.sheet(sheetId), bad = (field, message) => ({ field, message });
    if (!sheet) return bad('location', 'Choose a worksheet destination.');
    if (!nativeSparklineChoices.type.includes(type)) return bad('type', 'Choose a sparkline type.');
    if (!['auto', 'rows', 'columns'].includes(orientation)) return bad('orientation', 'Choose rows or columns.');
    const tokens = text => { try { return tokenize(String(text).trim().replace(/^=/, '')); } catch { return []; } };
    const loc = tokens(location);
    if (loc.length !== 1 || loc[0].type !== 'ref' || loc[0].sheetEnd || loc[0].spill || loc[0].sheet && !sameSheetName(loc[0].sheet, sheet.name))
      return bad('location', 'Choose a cell range on this worksheet.');
    let dest = parseRefText(loc[0].text);
    if (!dest || !['cell', 'range'].includes(dest.kind)) return bad('location', 'Choose a bounded cell range.');
    const merge = this.mergeAt(sheetId, dest.r1, dest.c1);
    if (merge && ['r1', 'r2', 'c1', 'c2'].every(k => merge[k] === dest[k])) dest = { ...dest, r2: dest.r1, c2: dest.c1 };
    if (dest.r1 !== dest.r2 && dest.c1 !== dest.c2) return bad('location', 'Choose a single row or column of destination cells.');
    if (dest.r2 >= Math.max(MAX_ROWS, sheet.rows) || dest.c2 >= Math.max(MAX_COLS, sheet.cols))
      return bad('location', 'The destination exceeds the worksheet size limit.');
    const formula = String(source).trim().replace(/^=/, ''), srcTokens = tokens(formula);
    const data = nativeSparklineLocation(this, sheetId, formula, { r: dest.r1, c: dest.c1 });
    const dataSheet = data && this.sheetByName(data.sheet);
    if (!data || data.sheetEnd || !dataSheet || dataSheet.kind === 'chart') return bad('source', 'Choose an available data range or range name.');
    const count = Math.max(dest.r2 - dest.r1, dest.c2 - dest.c1) + 1;
    const rows = data.r2 - data.r1 + 1, cols = data.c2 - data.c1 + 1;
    let byRows = orientation === 'rows';
    if (orientation === 'auto') byRows = rows === count && (cols !== count || dest.r1 !== dest.r2);
    if ((byRows ? rows : cols) !== count) return bad('source', 'The number of data rows or columns must match the destination cells.');
    // A vector name/spill can stay live as one native series. Slicing a dynamic
    // matrix into fixed addresses would silently discard its binding semantics.
    if (count > 1 && (srcTokens[0]?.type !== 'ref' || srcTokens[0]?.spill))
      return bad('source', 'Use a direct data range for multiple sparklines, or one destination for a named vector.');
    const sparklines = [];
    for (let i = 0; i < count; i++) {
      const r = dest.r1 + (dest.r1 === dest.r2 ? 0 : i), c = dest.c1 + (dest.c1 === dest.c2 ? 0 : i);
      const merged = this.mergeAt(sheetId, r, c);
      if (merged && (merged.r1 !== r || merged.c1 !== c)) return bad('location', 'A destination is inside a merged cell. Choose its top-left cell.');
      sparklines.push({ ref: cellName(r, c), formula: count === 1 ? formula : refToText({ ...data, kind: 'range',
        ...(byRows ? { r1: data.r1 + i, r2: data.r1 + i } : { c1: data.c1 + i, c2: data.c1 + i }),
        sheet: srcTokens[0].sheet,
      }) });
    }
    const occupied = new Set(sheet.sparklineGroups.flatMap(g => g.sparklines.map(s => s.ref)));
    if (sparklines.some(s => occupied.has(s.ref))) return bad('location', 'A destination already contains a sparkline. Clear it or choose another cell.');
    if (this._gridLocked(sheet) || this.lockedIn(sheetId, dest)) return bad('location', 'A destination is protected.');
    const group = normalizeNativeSparklineGroups([{ type, colorSeries: { theme: 4 }, uid: `{${crypto.randomUUID().toUpperCase()}}`, sparklines }])[0];
    this._growTo(sheet, dest.r2 + 1, dest.c2 + 1);
    this._writeRuleFormulaUpdates(sheet, { sparklineGroups: [...sheet.sparklineGroups, group] }, 'Insert sparklines');
    return null;
  }

  /** Edit one native series and/or its group's shared presentation settings. */
  updateNativeSparkline(sheetId, ref, { settings = {}, formula, expectedGroupUid } = {}) {
    const sheet = this.sheet(sheetId);
    const group = sheet?.sparklineGroups.find(g => g.sparklines.some(s => s.ref === ref));
    if (!group) return 'Select a cell containing a sparkline.';
    if (expectedGroupUid != null && group.uid !== expectedGroupUid) return 'This sparkline group changed. Reopen its settings.';
    const fields = new Set([...nativeSparklineFlags, ...nativeSparklineColors, ...Object.keys(nativeSparklineChoices), 'lineWeight', 'manualMin', 'manualMax', 'dateFormula']);
    const next = { ...group };
    for (const [key, value] of Object.entries(settings)) {
      if (!fields.has(key)) return 'Unknown sparkline setting.';
      if (value == null) delete next[key]; else next[key] = value;
    }
    next.sparklines = group.sparklines.map(spark => {
      if (spark.ref !== ref || formula === undefined) return spark;
      const copy = { ...spark }; if (formula == null || formula === '') delete copy.formula; else copy.formula = formula;
      return copy;
    });
    let normalized;
    try { [normalized] = normalizeNativeSparklineGroups([next]); }
    catch (error) { return error.message; }
    if (normalized.minAxisType === 'custom' && normalized.maxAxisType === 'custom' && normalized.manualMin > normalized.manualMax) return 'Maximum must be at least the minimum.';
    if (sameJSON(group, normalized)) return null;
    const shared = !sameJSON({ ...group, sparklines: [] }, { ...normalized, sparklines: [] });
    if (this._gridLocked(sheet) || (shared ? group.sparklines : group.sparklines.filter(s => s.ref === ref)).some(s => {
      const pos = parseRefText(s.ref); return this.lockedAt(sheetId, pos.r1, pos.c1);
    })) return 'A sparkline affected by this change is protected.';
    this._writeRuleFormulaUpdates(sheet, { sparklineGroups: sheet.sparklineGroups.map(g => g === group ? normalized : g) }, 'Edit sparkline');
    return null;
  }

  /** Remove native charts only. Group clearing includes unselected members;
   * protection is checked over the complete affected set before any mutation. */
  clearNativeSparklines(sheetId, ranges, { groups = false, skipRow = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    const selected = ranges.map(normalizeRange);
    const hits = spark => {
      const p = parseRefText(spark.ref);
      return !skipRow?.(p.r1) && selected.some(g => p.r1 >= g.r1 && p.r1 <= g.r2 && p.c1 >= g.c1 && p.c1 <= g.c2);
    };
    const removed = [];
    const next = sheet.sparklineGroups.flatMap(group => {
      const whole = groups && group.sparklines.some(hits);
      const sparklines = group.sparklines.filter(spark => {
        if (!whole && !hits(spark)) return true;
        removed.push(spark); return false;
      });
      return sparklines.length === group.sparklines.length ? [group] : sparklines.length ? [{ ...group, sparklines }] : [];
    });
    if (!removed.length) return 0;
    if (this._gridLocked(sheet) || removed.some(spark => {
      const p = parseRefText(spark.ref); return this.lockedAt(sheetId, p.r1, p.c1);
    })) return null;
    this._writeRuleFormulaUpdates(sheet, { sparklineGroups: next }, groups ? 'Clear sparkline groups' : 'Clear sparklines');
    return removed.length;
  }

  /** Change membership without changing any series source or scalar cell. */
  regroupNativeSparklines(sheetId, ranges, { ungroup = false, templateRef = null, skipRow = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 'Select cells containing sparklines';
    const selected = ranges.map(normalizeRange), picked = new Map(), members = [];
    for (const group of sheet.sparklineGroups) {
      const sparks = group.sparklines.filter(spark => {
        const p = parseRefText(spark.ref);
        return !skipRow?.(p.r1) && selected.some(g => p.r1 >= g.r1 && p.r1 <= g.r2 && p.c1 >= g.c1 && p.c1 <= g.c2);
      });
      if (sparks.length) { picked.set(group, new Set(sparks)); members.push(...sparks.map(spark => ({ group, spark }))); }
    }
    if (!members.length) return 'Select cells containing sparklines';
    const template = members.find(({ spark }) => spark.ref === templateRef);
    if (!ungroup) {
      if (members.length < 2) return 'Select at least two sparklines to group';
      if (!template) return 'The active sparkline must be in the selection';
      if (picked.size === 1 && members.length === template.group.sparklines.length) return null;
    }
    if (!ungroup && template.group.dateAxis && template.group.dateFormula) {
      if (nativeSparklineDateMismatch(this, sheetId, template.group.dateFormula, members.map(({ spark }) => spark)))
        return 'The active sparkline’s date range must match every selected data range';
    }
    const affected = ungroup ? members.filter(({ group }) => group.sparklines.length > 1) : members;
    if (!affected.length) return null;
    if (this._gridLocked(sheet) || affected.some(({ spark }) => {
      const p = parseRefText(spark.ref); return this.lockedAt(sheetId, p.r1, p.c1);
    })) return 'A sparkline affected by this change is protected';
    const fresh = (group, sparklines) => normalizeNativeSparklineGroups([{
      ...group, uid: `{${crypto.randomUUID().toUpperCase()}}`, sparklines,
    }])[0];
    const added = [], kept = sheet.sparklineGroups.flatMap(group => {
      const chosen = picked.get(group);
      if (!chosen || ungroup && group.sparklines.length === 1) return [group];
      const sparklines = group.sparklines.filter(spark => !chosen.has(spark));
      if (ungroup) for (const spark of chosen) added.push(fresh(group, [spark]));
      return sparklines.length ? [{ ...group, sparklines }] : [];
    });
    if (!ungroup) {
      // The UI explicitly chooses the active sparkline's shared presentation,
      // including date categories and axes; each member retains its own source.
      const sparks = [template.spark, ...members.filter(m => m !== template).map(m => m.spark)];
      added.push(fresh(template.group, sparks));
    }
    this._writeRuleFormulaUpdates(sheet, { sparklineGroups: [...kept, ...added] }, ungroup ? 'Ungroup sparklines' : 'Group sparklines');
    return null;
  }

  copyNativeSparklines(sheetId, rows, cols) {
    return copyNativeSparklines(this.sheet(sheetId), rows, cols);
  }

  /** Internal report snapshot; complete contiguous layouts retain their native cache. */
  copyNativePivots(sheetId, rows, cols) {
    if (!this.nativePivots || !rows.length || !cols.length) return null;
    const rr = new Map(rows.map((r, i) => [r, i])), cc = new Map(cols.map((c, i) => [c, i]));
    const tables = [];
    for (const pivot of this.nativePivots.tables) {
      if (pivot.owner !== sheetId) continue;
      const area = parseRefText(pivot.ref);
      if (!area) continue;
      const r = rr.get(area.r1), c = cc.get(area.c1);
      if (r == null || c == null || rr.get(area.r2) - r !== area.r2 - area.r1 || cc.get(area.c2) - c !== area.c2 - area.c1) continue;
      let contiguous = true;
      for (let i = 0; i <= area.r2 - area.r1; i++) if (rows[r + i] !== area.r1 + i) { contiguous = false; break; }
      for (let i = 0; contiguous && i <= area.c2 - area.c1; i++) if (cols[c + i] !== area.c1 + i) { contiguous = false; break; }
      if (contiguous) tables.push({ pivot: { ...pivot }, range: { r1: r, c1: c, r2: r + area.r2 - area.r1, c2: c + area.c2 - area.c1 } });
    }
    return tables.length ? { workbook: this, tables, dxfs: this.nativePivots.dxfs, styles: this.nativePivots.styles, formats: this.nativePivots.formats,
      caches: this.nativePivots.caches.filter(c => tables.some(t => t.pivot.cache === c.key)) } : null;
  }

  /** Preflight the entire paste before either the cells or native reports change. */
  _pasteNativeReports(sheetId, cells, r0, c0, origin, target, options, snapshot) {
    const sheet = this.sheet(sheetId), unchanged = { clippedRows: 0, clippedCols: 0 };
    if (!sheet || snapshot.workbook !== this || !this.nativePivots) return options.checkOnly ? false : unchanged;
    const limit = gridLimits(sheet), h = cells.length, w = cells[0]?.length || 0;
    const repeat = this.pasteReps(h, w, target), reports = [];
    const refused = (reason, name = '') => { this._emit('pivot-edit', sheetId, { reason, name }); return options.checkOnly ? false : unchanged; };
    if (snapshot.dxfs !== this.nativePivots.dxfs || snapshot.styles !== this.nativePivots.styles || snapshot.formats !== this.nativePivots.formats
      || snapshot.caches.some(old => !this.nativePivots.caches.some(c => c.key === old.key && c.xml === old.xml && c.records === old.records))) return refused('copy-layout');
    if (!h || !w || options.transpose || options.keepStyles || options.skipBlanks) return refused('copy-layout');
    if (snapshot.tables.length * repeat.rows * repeat.cols + this.nativePivots.tables.length > 65536) return refused('copy-limit');
    const destination = { r1: r0, c1: c0, r2: Math.min(limit.rows - 1, r0 + h * repeat.rows - 1), c2: Math.min(limit.cols - 1, c0 + w * repeat.cols - 1) };
    const existing = this.nativePivots.tables.find(p => p.owner === sheetId && parseRefText(p.ref) && intersection(parseRefText(p.ref), destination));
    if (existing) return refused('overlap', existing.name);
    const merges = mapPasteMerges(options.merges || [], h, w, r0, c0, repeat, false, limit);
    if (!merges) return refused('copy-layout');
    const plan = planPasteMerges(sheet.merges, merges);
    if (plan.error) return refused('copy-layout');
    const sameRange = (a, b) => ['r1', 'r2', 'c1', 'c2'].every(k => a[k] === b[k]);
    for (let ry = 0; ry < repeat.rows; ry++) for (let rx = 0; rx < repeat.cols; rx++) for (const { pivot, range } of snapshot.tables) {
      const area = { r1: r0 + ry * h + range.r1, r2: r0 + ry * h + range.r2, c1: c0 + rx * w + range.c1, c2: c0 + rx * w + range.c2 };
      if (area.r1 < 0 || area.c1 < 0 || area.r2 >= limit.rows || area.c2 >= limit.cols) return refused('bounds', pivot.name);
      if (!this.nativePivots.caches.some(c => c.key === pivot.cache)) return refused('copy-layout', pivot.name);
      if (sheet.tables.some(t => intersection(t.range, area))) return refused('table-overlap', pivot.name);
      // Destination merges must not alter the report's copied geometry.
      if ((plan.remaining || sheet.merges).some(m => intersection(m, area) && !merges.some(copy => sameRange(m, copy)))) return refused('copy-layout', pivot.name);
      reports.push({ pivot: { ...pivot }, owner: sheetId, ref: refToText(area), ry, rx });
    }
    if (!this.pasteCells(sheetId, cells, r0, c0, origin, target, { ...options, checkOnly: true })) return options.checkOnly ? false : unchanged;
    let next;
    try {
      const copies = cloneNativePivotReports(this.nativePivots, reports);
      const maps = new Map();
      for (const report of reports) {
        const key = `${report.ry},${report.rx}`;
        if (!maps.has(key)) maps.set(key, new Map());
        maps.get(key).set(report.pivot, copies.get(report.pivot));
      }
      for (const [key, copies] of maps) maps.set(key, clonedPivotRuleMap(copies));
      options = { ...options, pivotRuleCopies: (ry, rx) => maps.get(`${ry},${rx}`) };
      next = { ...this.nativePivots, tables: [...this.nativePivots.tables, ...copies.values()] };
      if (!normalizeNativePivots(next)) return refused('copy-limit');
    } catch { return refused('copy-layout'); }
    if (options.checkOnly) return true;
    return this.transaction('Paste', () => {
      const result = this.pasteCells(sheetId, cells, r0, c0, origin, target, options), previous = this.nativePivots;
      const apply = value => { this.nativePivots = value; this._changed('pivots', sheetId); };
      apply(next);
      this._push({ label: 'Paste', undo: () => apply(previous), redo: () => apply(next) });
      return result;
    });
  }

  copyConditionalFormats(sheetId, rows, cols) {
    return copyConditionalFormats(this.sheet(sheetId)?.rules || [], rows, cols, this.sheet(sheetId)?.name);
  }

  /** How many times an h×w block repeats across `target`: once, unless the target is a multiple of it in both directions. */
  pasteReps(h, w, target) {
    if (!target || !h || !w) return { rows: 1, cols: 1 };
    const n = normalizeRange(target);
    const th = n.r2 - n.r1 + 1;
    const tw = n.c2 - n.c1 + 1;
    return th % h === 0 && tw % w === 0 && (th > h || tw > w) ? { rows: th / h, cols: tw / w } : { rows: 1, cols: 1 };
  }

  /**
   * Paste a 2D array of cells (from copyRange) at (r, c), shifting relative
   * references by each cell's own move. srcOrigin is where the block was
   * copied from: { r, c }, plus `rows` and `cols` listing the source lines
   * when hidden ones were skipped, so a formula from a filtered list still
   * shifts by the distance its cell travelled. When the target range is a
   * multiple of the source, the source tiles across it. `notes`, laid out
   * like `cells`, are the copied cells' notes: each pasted cell takes its
   * note (or loses the one it had), in the same undo step. Returns how many
   * rows and columns of the block fell past the sheet's edge and were not
   * written, as { clippedRows, clippedCols }, so the caller can say so. When
   * source merges are carried, mergeLosses counts values excluded by retained
   * destination merges, rather than values successfully copied beneath new ones.
   */
  pasteCells(sheetId, cells, r0, c0, srcOrigin, target = null, { transpose = false, keepStyles = false, skipBlanks = false, notes = null, merges = [], conditionalFormats = null, validations = null, checkOnly = false, clearEntries = [], clearMerges = [], nativePivots = null, nativeSparklines = null, pivotRuleCopies = null, externalWorkbooks = null } = {}) {
    if (nativePivots?.tables.length) return this._pasteNativeReports(sheetId, cells, r0, c0, srcOrigin, target,
      { transpose, keepStyles, skipBlanks, notes, merges, conditionalFormats, validations, checkOnly, clearEntries, clearMerges, nativeSparklines, externalWorkbooks }, nativePivots);
    // keepStyles: the pasted cells take the formatting already at the target (paste formulas only).
    // skipBlanks: empty source cells leave the target alone.
    // The block is clipped at the grid's edge (a sheet a file brought in larger keeps its own), and what was cut off is reported.
    const sheet = this.sheet(sheetId);
    if (!sheet) return checkOnly ? false : { clippedRows: 0, clippedCols: 0 };
    const limit = gridLimits(sheet);
    const clipped = (rows, cols, result) => ({ clippedRows: Math.max(0, rows - limit.rows), clippedCols: Math.max(0, cols - limit.cols),
      ...(result?.mergeLosses != null ? { mergeLosses: result.mergeLosses } : {}) });
    if (!cells.length || !cells[0].length) return checkOnly ? true : clipped(0, 0);
    const repeat = transpose ? { rows: 1, cols: 1 } : this.pasteReps(cells.length, cells[0].length, target);
    const sparks = keepStyles ? null : mapPastedNativeSparklines(nativeSparklines, sheet, cells.length, cells[0].length, r0, c0, repeat, transpose);
    const sparkCells = new Set(sparks?.groups.flatMap(g => g.sparklines.map(s => s.ref)) || []);
    const rules = keepStyles ? null : mapPastedConditionalFormats(conditionalFormats, cells.length, cells[0].length, r0, c0, repeat, transpose, pivotRuleCopies);
    const validationRules = keepStyles ? null : mapPastedValidations(validations, cells.length, cells[0].length, r0, c0, repeat, transpose);
    const mappedMerges = mapPasteMerges(merges, cells.length, cells[0].length, r0, c0, repeat, transpose, limit);
    const existingMerges = remainingPasteMerges(sheet.merges, checkOnly ? clearMerges : []);
    // Preflight must include cells that become writable when the cut removes a merge.
    const coveredAtDestination = checkOnly && clearMerges.length
      ? (r, c) => existingMerges.some(m => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2 && (r !== m.r1 || c !== m.c1))
      : (r, c) => this._coveredByMerge(sheetId, r, c);

    if (!mappedMerges) {
      this._emit('merge-paste', sheetId, { reason: 'invalid' });
      return checkOnly ? false : clipped(0, 0);
    }
    // Check declarations before clipping/skipping cells. Otherwise a formula
    // anchor hidden by a destination merge could disappear while its source
    // is cleared by a cut, leaving only the array's blank body cells to paste.
    for (let i = 0; i < cells.length; i++) for (let j = 0; j < cells[i].length; j++) {
      if (!cells[i][j]?.array) continue;
      const size = fixedArraySize(cells[i][j].array);
      for (let ry = 0; ry < repeat.rows; ry++) for (let rx = 0; rx < repeat.cols; rx++) {
        const r = r0 + ry * cells.length + (transpose ? j : i), c = c0 + rx * cells[0].length + (transpose ? i : j);
        const area = { r1: r, c1: c, r2: r + ((transpose ? size?.cols : size?.rows) ?? 1) - 1, c2: c + ((transpose ? size?.rows : size?.cols) ?? 1) - 1 };
        const reason = !size || i + size.rows > cells.length || j + size.cols > cells[0].length
          || area.r2 >= limit.rows || area.c2 >= limit.cols ? 'bounds'
          : existingMerges.some(m => intersection(m, area)) || sheet.tables.some(t => intersection(t.range, area)) ? 'overlap' : null;
        if (reason) {
          this._arrayRefused(sheet, area, reason);
          return checkOnly ? false : clipped(r0 + (transpose ? cells[0].length : repeat.rows * cells.length), c0 + (transpose ? cells.length : repeat.cols * cells[0].length));
        }
      }
    }
    const srcRow = (i) => srcOrigin.rows?.[i] ?? srcOrigin.r + i;
    const srcCol = (j) => srcOrigin.cols?.[j] ?? srcOrigin.c + j;
    const noteWrites = [];
    const contentsOnly = (cell, r, c) => {
      if (!keepStyles) return cell;
      const previous = this.getCell(sheetId, r, c);
      const result = cell || { v: null, f: null };
      result.s = previous?.s ? { ...previous.s } : undefined;
      // Paste Special > Formulas transfers content, including constant
      // text, without its character formats or hyperlink annotation.
      delete result.richText;
      delete result.hyperlink;
      if (previous?.hyperlink) result.hyperlink = previous.hyperlink;
      return result;
    };
    if (transpose) {
      // Rows become columns; each formula shifts by its own displacement.
      const flipped = cells[0].map((_, j) => cells.map((row) => row[j]));
      const entries = [];
      flipped.forEach((row, i) => row.forEach((src, j) => {
        const r = r0 + i;
        const c = c0 + j;
        if (r >= limit.rows || c >= limit.cols || !mappedMerges.length && coveredAtDestination(r, c)) return;
        // Blank cells are skipped and the target's formatting kept on the same terms as in a paste that keeps its shape.
        const blank = !src || (src.v == null && src.f == null);
        if (blank && skipBlanks && !sparkCells.has(cellName(r, c))) return;
        if (notes) noteWrites.push({ r, c, text: notes[j]?.[i] ?? null });
        if (!src) { entries.push({ r, c, cell: keepStyles ? contentsOnly(null, r, c) : this._replaceCellStyle(sheet, null, r, c) }); return; }
        const cell = cloneCell(src);
        // References transpose with the block (see transpose-formula.js).
        if (cell.f != null && srcOrigin) cell.f = transposeFormula(cell.f, { r: srcRow(j), c: srcCol(i) }, { r, c }, srcOrigin, cells.length, cells[0].length, { r: r0, c: c0 });
        // Paste Special swaps the CSE extent, not the expression or its
        // result matrix (which is then truncated or padded to the new rectangle).
        if (cell.array) cell.array = { rows: cell.array.cols, cols: cell.array.rows };
        contentsOnly(cell, r, c);
        entries.push({ r, c, cell: keepStyles ? cell : this._replaceCellStyle(sheet, cell, r, c) });
      }));
      const accepted = this._commitPaste(sheetId, entries, noteWrites, { checkOnly, clearEntries, clearMerges, merges: mappedMerges, conditionalFormats: rules, validations: validationRules, nativeSparklines: sparks, externalWorkbooks });
      if (checkOnly) return accepted;
      return clipped(r0 + cells[0].length, c0 + cells.length, accepted);
    }
    const h = cells.length;
    const w = cells[0].length;
    const reps = this.pasteReps(h, w, target);
    const entries = [];
    for (let ry = 0; ry < reps.rows; ry++) {
      for (let rx = 0; rx < reps.cols; rx++) {
        for (let i = 0; i < h; i++) {
          for (let j = 0; j < w; j++) {
            const r = r0 + ry * h + i;
            const c = c0 + rx * w + j;
            if (r >= limit.rows || c >= limit.cols) continue;
            // Cells hidden under a merge are never written: a merged cell takes one value, at its top-left.
            if (!mappedMerges.length && coveredAtDestination(r, c)) continue;
            const src = cells[i][j];
            const blank = !src || (src.v == null && src.f == null);
            if (blank && skipBlanks && !sparkCells.has(cellName(r, c))) continue;
            if (notes) noteWrites.push({ r, c, text: notes[i]?.[j] ?? null });
            if (!src) { entries.push({ r, c, cell: keepStyles ? contentsOnly(null, r, c) : this._replaceCellStyle(sheet, null, r, c) }); continue; }
            const cell = cloneCell(src);
            if (cell.f != null && srcOrigin) cell.f = shiftFormula(cell.f, r - srcRow(i), c - srcCol(j));
            contentsOnly(cell, r, c);
            entries.push({ r, c, cell: keepStyles ? cell : this._replaceCellStyle(sheet, cell, r, c) });
          }
        }
      }
    }
    const accepted = this._commitPaste(sheetId, entries, noteWrites, { checkOnly, clearEntries, clearMerges, merges: mappedMerges, conditionalFormats: rules, validations: validationRules, nativeSparklines: sparks, externalWorkbooks });
    if (checkOnly) return accepted;
    return clipped(r0 + reps.rows * h, c0 + reps.cols * w, accepted);
  }

  // Copies carry complete formats. Model cells are patches over Normal,
  // row, column and sparse range defaults, so absent source properties must
  // explicitly mask those defaults, even when the source cell is blank.
  _replaceCellStyle(sheet, cell, r, c) {
    // Cross-workbook paste retains resolved faces. A source binding remains
    // meaningful only when the destination theme selects that same face.
    const copiedFont = style => style && ['major', 'minor'].includes(style.scheme)
      && !exportFontScheme(fontName(style.font), style.scheme, this.fontTheme)
      ? { ...style, scheme: 'none' } : style;
    const own = copiedFont(cell?.s);
    if (own !== cell?.s) cell = { ...cell, s: own };
    if (cell?.richText) cell = { ...cell, richText: cell.richText.map(run => ({ ...run, s: copiedFont(run.s) })) };
    const inherited = this._lineStyle(sheet, r, c);
    if (!inherited) return cell;
    const s = replaceInheritedStyle(cell?.s, inherited);
    return Object.keys(s).length ? { ...cell, v: cell?.v ?? null, f: cell?.f ?? null, s } : cell;
  }

  /** Complete format replacement used by format-only paste, preserving the target's link marker. */
  replacedCellStyle(sheetId, r, c, source) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return undefined;
    const { nolink, ...s } = source || {};
    if (this.getCell(sheetId, r, c)?.s?.nolink) s.nolink = true;
    return this._replaceCellStyle(sheet, { s: Object.keys(s).length ? s : undefined }, r, c)?.s;
  }

  /** Actual cells reached by a format paste, including tiling and grid clipping. */
  stylePasteRange(sheetId, cells, r0, c0, target = null) {
    const sheet = this.sheet(sheetId), h = cells?.length, w = cells?.[0]?.length;
    if (!sheet || !h || !w) return null;
    const reps = this.pasteReps(h, w, target), limit = gridLimits(sheet);
    const r2 = Math.min(limit.rows - 1, r0 + reps.rows * h - 1), c2 = Math.min(limit.cols - 1, c0 + reps.cols * w - 1);
    return r2 < r0 || c2 < c0 ? null : { r1: r0, r2, c1: c0, c2 };
  }

  /** Prepare format-only clipboard metadata beside an already validated cell plan.
   * Uses the ordinary paste planners, but never installs links, merges or rules
   * until the caller commits its native cell/rule plan in the same transaction.
   */
  _prepareStylePasteExtras(sheetId, entries, cells, r, c, target, {
    merges = null, conditionalFormats = null, externalWorkbooks = null, maxWork = 4 * 1048576 } = {}) {
    const sheet = this.sheet(sheetId), h = cells.length, w = cells[0].length;
    const reps = this.pasteReps(h, w, target), range = this.stylePasteRange(sheetId, cells, r, c, target);
    if (!sheet || !range || !entries?.length) return null;
    const work = entries.length + sheet.rules.length + sheet.merges.length
      + ((merges?.length || 0) + (conditionalFormats?.length || 0)) * reps.rows * reps.cols;
    if (!Number.isSafeInteger(work) || work > maxWork) throw new Error('Cannot paste native formats: metadata work limit');
    let mapped = [], plan = null;
    if (merges !== null) {
      mapped = mapPasteMerges(merges, h, w, r, c, reps, false, gridLimits(sheet));
      if (!mapped) { this._emit('merge-paste', sheetId, { reason: 'invalid' }); return null; }
      // Native merged report layout needs its own semantic mapping. Ordinary
      // merges outside reports can still travel in the same mixed paste.
      if (mapped.some(g => this.nativePivotOverlap(sheetId, g))) throw new Error('Cannot paste native formats: report merge');
      plan = planFormatPasteMerges(sheet.merges, mapped, range);
      if (plan.error) { this._emit('merge-paste', sheetId, { reason: plan.error }); return null; }
    }
    if (!this._commitPaste(sheetId, entries, [], { checkOnly: true, merges: mapped, formatRange: merges === null ? null : range, formatsOnly: true })) return null;
    let incoming = mapPastedConditionalFormats(conditionalFormats, h, w, r, c, reps), combined = null;
    if (externalWorkbooks) {
      combined = appendExternalWorkbooks(this.externalWorkbooks, normalizeExternalWorkbooks(externalWorkbooks));
      const offset = this.externalWorkbooks?.books.length || 0;
      incoming = incoming?.map(rule => mapConditionalFormulas(rule, f => offsetExternalWorkbookRefs(f, offset))) ?? null;
    }
    const rules = replaceConditionalFormats(sheet.rules, incoming, entries, newId, sheet.name);
    return { sheet, externalWorkbooks: combined, merges: plan?.changed ? plan.next : null,
      rules: rules === sheet.rules ? null : rules };
  }

  /** External typed cells are already positioned; their source-relative merges follow the same paste geometry. */
  pasteEntries(sheetId, entries, { merges = [], rows, cols, r = 0, c = 0, target = null, transpose = false, keepStyles = false } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const repeat = transpose ? { rows: 1, cols: 1 } : this.pasteReps(rows, cols, target);
    const mapped = mapPasteMerges(merges, rows, cols, r, c, repeat, transpose, gridLimits(sheet));
    if (!mapped) { this._emit('merge-paste', sheetId, { reason: 'invalid' }); return false; }
    const copied = keepStyles ? entries : entries.map(e => ({ ...e, cell: this._replaceCellStyle(sheet, e.cell, e.r, e.c) }));
    return this._commitPaste(sheetId, copied, [], { merges: mapped });
  }

  /** Cells, notes and merge geometry commit together; a refused paste writes none of them. */
  _commitPaste(sheetId, entries, noteWrites, { checkOnly = false, clearEntries = [], clearMerges = [], merges = [], formatRange = null, conditionalFormats = null, validations = null, nativeSparklines = null, externalWorkbooks = null, formatsOnly = false } = {}) {
    if (externalWorkbooks && entries.length) {
      // Validate before changing state; incoming link indexes belong to the
      // source namespace, including links nested in supporting defined names.
      const incoming = normalizeExternalWorkbooks(externalWorkbooks);
      const combined = appendExternalWorkbooks(this.externalWorkbooks, incoming);
      const options = { checkOnly, clearEntries, clearMerges, merges, formatRange, conditionalFormats, validations, nativeSparklines };
      if (!this._commitPaste(sheetId, entries, noteWrites, { ...options, checkOnly: true })) return false;
      if (checkOnly) return true;
      const offset = this.externalWorkbooks?.books.length || 0;
      const reindex = f => offsetExternalWorkbookRefs(f, offset);
      const mapped = formatsOnly ? entries : entries.map(e => e.cell?.f == null ? e : { ...e, cell: reindexExternalCell(e.cell, reindex) });
      options.conditionalFormats = conditionalFormats?.map(rule => mapConditionalFormulas(rule, reindex)) ?? null;
      options.validations = validations?.map(rule => rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source))
        ? { ...rule, source: reindex(rule.source) } : rule) ?? null;
      options.nativeSparklines = nativeSparklines ? { ...nativeSparklines, groups: mapNativeSparklineReferences(nativeSparklines.groups, reindex) } : null;
      let result;
      this.transaction('Paste', () => {
        this._structural('Paste', () => { this.externalWorkbooks = combined; });
        result = this._commitPaste(sheetId, mapped, noteWrites, options);
      });
      return result;
    }
    const sheet = this.sheet(sheetId);
    if (sheet && (merges.length || formatRange)) {
      const plan = formatRange ? planFormatPasteMerges(sheet.merges, merges, formatRange)
        : planPasteMerges(remainingPasteMerges(sheet.merges, checkOnly ? clearMerges : []), merges);
      if (plan.error) { this._emit('merge-paste', sheetId, { reason: plan.error }); return false; }
      // Keep destination merges that survive the paste, but let source styles
      // reach cells under merges replaced by the incoming geometry.
      const writable = e => !plan.retainedBody(e.r, e.c) && !plan.remaining.some(m => e.r >= m.r1 && e.r <= m.r2 && e.c >= m.c1 && e.c <= m.c2
        && (e.r !== m.r1 || e.c !== m.c1));
      let mergeLosses = 0;
      if (!formatRange) {
        entries = entries.filter(e => {
          const keep = writable(e);
          if (!keep && (e.cell?.v != null || e.cell?.f != null)) mergeLosses++;
          return keep;
        });
        noteWrites = noteWrites.filter(writable);
      }
      if (this._gridLocked(sheet) || plan.ranges.some(m => this.lockedIn(sheetId, m))) return false;
      const declarations = [];
      for (const e of entries) {
        const size = fixedArraySize(e.cell?.array);
        if (size) declarations.push({ r1: e.r, c1: e.c, r2: e.r + size.rows - 1, c2: e.c + size.cols - 1 });
      }
      for (const m of plan.ranges) {
        const array = this._fixedArrays(sheet).overlapping(m).next().value;
        if (array) { this._arrayRefused(sheet, array, 'overlap'); return false; }
        if (sheet.tables.some(t => intersection(m, { ...t.range, r2: tableRows(t).dataEnd }))) {
          this._emit('merge-paste', sheetId, { reason: 'table' }); return false;
        }
        for (const declaration of declarations) {
          if (intersection(m, declaration)) {
            this._arrayRefused(sheet, m, 'overlap'); return false;
          }
        }
      }
      if (!this._commitPaste(sheetId, entries, noteWrites, { checkOnly: true, clearEntries })) return false;
      if (checkOnly) return true;
      // Formats paste retains destination contents beneath merges. Ordinary
      // copies retain source contents there too: values and formulas can
      // sit beneath a merge created by Paste Special > Formats.
      const written = [...entries];
      // Skip-blanks can omit source-empty covered cells. Their old
      // destination values are cleared when a new merge is applied, unlike Formats.
      const keys = new Set(written.map(e => cellKey(e.r, e.c)));
      for (const m of formatRange ? [] : plan.ranges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) {
        if (r === m.r1 && c === m.c1 || keys.has(cellKey(r, c))) continue;
        const prev = sheet.cells.get(cellKey(r, c));
        if (prev?.v != null || prev?.f != null) written.push({ r, c, cell: { v: null, f: null, s: prev.s } });
      }
      const label = formatRange ? 'Paste formatting' : 'Paste';
      this.transaction(label, () => {
        this._commitPaste(sheetId, written, noteWrites, { conditionalFormats, validations, nativeSparklines });
        if (formatRange ? plan.changed : plan.ranges.length) this._setMerges(sheet, plan.next, label);
      });
      return { mergeLosses };
    }
    if (checkOnly) {
      if (!sheet || this._gridLocked(sheet)) return false;
      const combined = [...clearEntries, ...entries];
      if (sheet.protectedRanges.length && combined.some(({ r, c }) => this.lockedAt(sheetId, r, c))) return false;
      return !this._fixedWritesBlocked(sheet, combined);
    }
    if (!sheet || !noteWrites.length && conditionalFormats === null && validations === null && nativeSparklines === null) { this.setCellsWithTableHeaders(sheetId, entries, 'Paste'); return; }
    if (this._fixedWritesBlocked(sheet, entries)) return;
    // The same refusal as setCells: one protected cell keeps the whole paste out.
    if (this._gridLocked(sheet) || (sheet.protectedRanges.length && entries.some(({ r, c }) => this._protectedAt(sheet, r, c)))) {
      this.setCellsWithTableHeaders(sheetId, entries, 'Paste');
      return;
    }
    this.transaction('Paste', () => {
      const groups = replacePastedNativeSparklines(sheet.sparklineGroups, nativeSparklines, entries);
      if (groups !== sheet.sparklineGroups) {
        for (const group of groups) for (const spark of group.sparklines) {
          const ref = parseRefText(spark.ref); this._growTo(sheet, ref.r1 + 1, ref.c1 + 1);
        }
        this._writeRuleFormulaUpdates(sheet, { sparklineGroups: groups }, 'Paste');
      }
      this.setCellsWithTableHeaders(sheetId, entries, 'Paste');
      for (const { r, c, text } of noteWrites) this.setNote(sheetId, r, c, text);
      const rules = replaceConditionalFormats(sheet.rules, conditionalFormats, entries, newId, sheet.name);
      if (rules !== sheet.rules) this._setRules(sheet, rules, 'Paste');
      const nextValidations = replaceValidations(sheet.validations, validations, entries, newId);
      if (nextValidations !== sheet.validations) this._setValidations(sheet, nextValidations, 'Paste');
    });
  }

  /** Is (r, c) hidden under a merge, i.e. inside one without being its top-left cell? */
  _coveredByMerge(sheetId, r, c) {
    const m = this.mergeAt(sheetId, r, c);
    return !!m && (m.r1 !== r || m.c1 !== c);
  }

  /** A cell holding nothing but its current formatting (or null when it has none). */
  _styleOnly(sheetId, r, c) {
    const s = this.getCell(sheetId, r, c)?.s;
    return s ? { v: null, f: null, s: { ...s } } : null;
  }

  /**
   * Paste with arithmetic: add, subtract, multiply, or divide each target
   * number by the copied number in the same position (the Paste Special
   * operations). Formulas and text at the target are left alone; a blank
   * target counts as 0. `values` is a 2D array of numbers (null to skip).
   * Returns the number of cells actually changed, or zero when refused.
   */
  pasteOperation(sheetId, values, r0, c0, op) {
    const apply = { add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => (b === 0 ? err('#DIV/0!') : a / b) }[op];
    if (!apply) return 0;
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    const limit = gridLimits(sheet);
    const entries = [];
    values.forEach((row, i) => row.forEach((v, j) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      const r = r0 + i;
      const c = c0 + j;
      if (!inGrid(r, c, limit) || this._coveredByMerge(sheetId, r, c)) return;
      const prev = this.getCell(sheetId, r, c);
      if (prev && (prev.f != null || (prev.v != null && typeof prev.v !== 'number'))) return;
      const result = apply(prev?.v ?? 0, v);
      // Dividing by zero writes #DIV/0!, as the formula would, rather than leaving the cell as it was.
      if (isError(result)) { entries.push({ r, c, cell: { v: result, f: null, s: prev?.s } }); return; }
      if (result == null || !Number.isFinite(result)) return;
      // Remove floating-point noise using significant digits. Scaling by
      // 1e12 overflows large values and rounds small nonzero values to zero.
      const value = Number.isInteger(result) ? result : Number(result.toPrecision(15));
      entries.push({ r, c, cell: { v: value, f: null, s: prev?.s } });
    }));
    return this.setCellsWithTableHeaders(sheetId, entries, 'Paste operation');
  }

  /**
   * Paste only the styles of copied cells over a target, tiling across it the
   * way pasteCells does; values and formulas already there are kept.
   */
  pasteStyles(sheetId, cells, r0, c0, target = null, { merges = null, conditionalFormats = null, externalWorkbooks = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !cells.length || !cells[0].length) return;
    const limit = gridLimits(sheet);
    const h = cells.length;
    const w = cells[0].length;
    const reps = this.pasteReps(h, w, target);
    const entries = [];
    for (let ry = 0; ry < reps.rows; ry++) {
      for (let rx = 0; rx < reps.cols; rx++) {
        for (let i = 0; i < h; i++) {
          for (let j = 0; j < w; j++) {
            const r = r0 + ry * h + i;
            const c = c0 + rx * w + j;
            if (r >= limit.rows || c >= limit.cols) continue;
            const prev = this.getCell(sheetId, r, c);
            // A pasted format neither removes the target's link nor brings a removed one back: the mark stays the target's own.
            const cell = { ...prev, v: prev?.v ?? null, f: prev?.f ?? null, s: this.replacedCellStyle(sheetId, r, c, cells[i][j]?.s) };
            entries.push({ r, c, cell });
          }
        }
      }
    }
    const rules = mapPastedConditionalFormats(conditionalFormats, h, w, r0, c0, reps);
    // A clipboard snapshot includes its merge layout (an empty array means
    // unmerged). Callers carrying only cell styles can omit it.
    if (merges !== null) {
      const mapped = mapPasteMerges(merges, h, w, r0, c0, reps, false, limit);
      if (!mapped) { this._emit('merge-paste', sheetId, { reason: 'invalid' }); return false; }
      const formatRange = { r1: r0, c1: c0, r2: Math.min(limit.rows - 1, r0 + reps.rows * h - 1),
        c2: Math.min(limit.cols - 1, c0 + reps.cols * w - 1) };
      return this._commitPaste(sheetId, entries, [], { merges: mapped, formatRange, conditionalFormats: rules, externalWorkbooks, formatsOnly: true });
    }
    if (rules !== null) return this._commitPaste(sheetId, entries, [], { conditionalFormats: rules, externalWorkbooks, formatsOnly: true });
    this.setCellsWithTableHeaders(sheetId, entries, 'Paste formatting');
  }

  /** Paste plain text (a 2D array of strings) with type inference. */
  /**
   * Paste links: formulas pointing at the copied cells (=B2, ='Other sheet'!B2),
   * one per source cell, laid out like the source. `rows`/`cols` are the
   * source coordinates (visible cells only when some were hidden). Returns
   * how many cells were written.
   */
  pasteLinks(sheetId, r0, c0, srcSheetId, rows, cols) {
    const sheet = this.sheet(sheetId);
    const src = this.sheet(srcSheetId);
    if (!sheet || !src || !rows.length || !cols.length) return 0;
    // setInput also expands tables and fills calculated columns. Refuse the
    // entire destination before the first write can produce those effects.
    // The links reach as far as pasted cells do, to the grid's edge, growing the sheet on the way.
    const limit = gridLimits(sheet);
    const r2 = Math.min(limit.rows - 1, r0 + rows.length - 1);
    const c2 = Math.min(limit.cols - 1, c0 + cols.length - 1);
    if (r2 < r0 || c2 < c0 || this.lockedIn(sheetId, { r1: r0, c1: c0, r2, c2 })) return 0;
    const prefix = srcSheetId === sheetId ? '' : `${quoteSheet(src.name)}!`;
    let n = 0;
    this.transaction('Paste links', () => {
      rows.forEach((r, i) => cols.forEach((c, j) => {
        const tr = r0 + i;
        const tc = c0 + j;
        if (tr > r2 || tc > c2) return;
        this.setInput(sheetId, tr, tc, `=${prefix}${cellName(r, c)}`);
        n++;
      }));
    });
    return n;
  }

  /** Paste plain text (a 2D array of strings) with type inference, tiling across `target` the way pasteCells does. */
  pasteValues(sheetId, rows, r0, c0, target = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const limit = gridLimits(sheet);
    const h = rows.length;
    const w = rows.reduce((width, row) => Math.max(width, row.length), 0);
    const reps = this.pasteReps(h, w, target);
    const entries = [];
    for (let ry = 0; ry < reps.rows; ry++) {
      for (let rx = 0; rx < reps.cols; rx++) {
        rows.forEach((row, i) => row.forEach((text, j) => {
          const r = r0 + ry * h + i;
          const c = c0 + rx * w + j;
          if (r >= limit.rows || c >= limit.cols || this._coveredByMerge(sheetId, r, c)) return;
          // A value pasted as text takes the format of the cell, or of its column or row, it lands in.
          entries.push({ r, c, cell: cellFromInput(text, this.styleAt(sheetId, r, c)) });
        }));
      }
    }
    this.setCellsWithTableHeaders(sheetId, entries, 'Paste');
  }

  /** Paste a snapshot of computed values without reparsing text or changing formatting, tiling across `target` like pasteCells. */
  pasteLiteralValues(sheetId, values, r0, c0, target = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    const limit = gridLimits(sheet);
    const h = values.length;
    const w = values.reduce((width, row) => Math.max(width, row.length), 0);
    const reps = this.pasteReps(h, w, target);
    const entries = [];
    for (let ry = 0; ry < reps.rows; ry++) {
      for (let rx = 0; rx < reps.cols; rx++) {
        values.forEach((row, i) => row.forEach((v, j) => {
          const r = r0 + ry * h + i;
          const c = c0 + rx * w + j;
          if (r >= limit.rows || c >= limit.cols || this._coveredByMerge(sheetId, r, c)) return;
          const s = this.getCell(sheetId, r, c)?.s;
          // An empty text is no value, as typing nothing is: the cell is left blank rather than holding text COUNTA would count.
          entries.push({ r, c, cell: { v: v == null || v === '' ? null : v, f: null, s } });
        }));
      }
    }
    return this.setCellsWithTableHeaders(sheetId, entries, 'Paste values');
  }

  /** Apply only after the caller has validated the complete cell move. */
  _moveConditionalFormats(sourceId, targetId, blocks) {
    const source = this.sheet(sourceId), target = this.sheet(targetId);
    const updates = moveConditionalFormats(this.sheets, source, target, blocks, newId,
      (sheet, range, r) => this._visibleOrdinal(sheet, range.r1, range.r2, r));
    for (const [sheet, rules] of updates) if (rules !== sheet.rules) this._writeRuleFormulaUpdates(sheet, { rules }, 'Move cells');
  }

  /** Prepare a preflighted packed cut inside its transaction. Rewrite dependencies
   * before clearing source cells, and carry formulas without copy-style shifts. */
  preparePackedMoveCells(sourceId, targetId, rows, cols, r, c, cells) {
    const source = this.sheet(sourceId), target = this.sheet(targetId);
    const move = packedMoveReferences(source.name, target.name, rows, cols, r, c);
    const bindNames = formula => {
      if (source === target) return formula;
      let tokens;
      try { tokens = freeNameTokens(formula, tokenize(formula), { includeCalls: true, builtin: name => !!FUNCTIONS[name] }); }
      catch { return formula; }
      let result = formula;
      for (const token of tokens.reverse()) {
        if (token.sheet || FUNCTIONS[token.value] && /^\s*\(/.test(formula.slice(token.end))) continue;
        const entry = this.namedEntry(token.value, source.name);
        if (!entry || entry === this.namedEntry(token.value, target.name)) continue;
        result = result.slice(0, token.start) + `${quoteSheet(source.name)}!${formula.slice(token.start, token.end)}` + result.slice(token.end);
      }
      return result;
    };
    const carried = cells.map(row => row.map(original => {
      const cell = cloneCell(original);
      if (cell?.f != null) cell.f = move.carry(bindNames(cell.f));
      return cell;
    }));
    this._rewriteFormulas((formula, owner, r, c, template) => {
      if (!template && (owner === source && move.sourceCell(r, c) || owner === target && move.targetCell(r, c))) return formula;
      return move.follow(formula, owner.name);
    }, 'Move cells');
    this._rewriteNamedFormulas((formula, name) => move.follow(formula, name.sheet || null), 'Move cells');
    // Conditional formats and native sparklines have their own destination move.
    this._rewriteRuleFormulas((formula, owner) => move.follow(formula, owner.name), 'Move cells', { conditional: false, sparklines: false });
    return carried;
  }

  moveConditionalFormatsFromCells(sourceId, targetId, rows, cols, r, c) {
    this._moveConditionalFormats(sourceId, targetId, conditionalMoveBlocks(rows, cols, r, c));
  }

  /**
   * Move a block of cells so its top-left lands on (r0, c0), the way dragging
   * a selection by its border does. Formulas everywhere that point into the
   * block follow it; the moved formulas keep pointing at what they pointed
   * at. Notes and merges inside the block move too. One undo step. Returns
   * the destination range, or null when nothing moved.
   */
  moveRange(sheetId, source, r0, c0) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    if (this._gridLocked(sheet)) return null;
    const src = normalizeRange(source);
    const dr = r0 - src.r1;
    const dc = c0 - src.c1;
    if (!dr && !dc) return null;
    const h = src.r2 - src.r1 + 1;
    const w = src.c2 - src.c1 + 1;
    // A sheet a file brought in larger than the interactive caps keeps its own limits, as every other write door reads them.
    const limit = gridLimits(sheet);
    if (r0 < 0 || c0 < 0 || r0 + h > limit.rows || c0 + w > limit.cols || h * w > 200000) return null;
    const dst = { r1: r0, c1: c0, r2: r0 + h - 1, c2: c0 + w - 1 };
    // A refused cell write must not leave references, notes, or merges moved.
    if (this.lockedIn(sheetId, src) || this.lockedIn(sheetId, dst)) return null;
    if (this.pivotMoveEditBlocked(sheetId, src, sheetId, dst)) return null;
    if (this.arrayEditBlocked(sheetId, src, { whole: true })) return null;
    if (this._arrayMoveBlocked(sheet, src, sheet, dst)) return null;
    // Spilled values cannot leave their array: moving some of them without the anchor would clear the
    // destination and leave the source as it was.
    if (this._splitsSpill(sheet, src)) return null;
    // A table wholly inside the block travels with it. A block that would tear a table, taking
    // some of its cells along with cells outside it, is refused, as a sort over part of a table is; so is
    // landing a table on another one.
    const inside = (m) => m.r1 >= src.r1 && m.r2 <= src.r2 && m.c1 >= src.c1 && m.c2 <= src.c2;
    const shifted = (m) => ({ ...m, r1: m.r1 + dr, c1: m.c1 + dc, r2: m.r2 + dr, c2: m.c2 + dc });
    const overlaps = (a, b) => !(a.r2 < b.r1 || a.r1 > b.r2 || a.c2 < b.c1 || a.c1 > b.c2);
    // A block taking part of a merged block is refused: its value would leave and the empty merge stay.
    if (sheet.merges.some((m) => overlaps(m, src) && !inside(m))) return null;
    // Landing on part of a merged block is refused too (part of a merged cell cannot change); a merge the block
    // covers whole gives way to it, as it gives way to a paste.
    const insideDst = (m) => m.r1 >= dst.r1 && m.r2 <= dst.r2 && m.c1 >= dst.c1 && m.c2 <= dst.c2;
    if (sheet.merges.some((m) => !inside(m) && overlaps(m, dst) && !insideDst(m))) return null;
    const movingTables = sheet.tables.filter((t) => inside(t.range));
    if (sheet.tables.some((t) => !inside(t.range) && overlaps(t.range, src) && !(src.r1 >= t.range.r1 && src.r2 <= t.range.r2 && src.c1 >= t.range.c1 && src.c2 <= t.range.c2))) return null;
    if (movingTables.some((t) => sheet.tables.some((o) => !inside(o.range) && overlaps(shifted(t.range), o.range)))) return null;
    // A 3D span (Sheet1:Two!A1) names the same cells on every sheet between two tabs, so one sheet's
    // moved block cannot take it along; it stays where it is.
    const inSrc = (ref) => !ref.sheetEnd && ref.kind !== 'cols' && ref.kind !== 'rows' && ref.r1 >= src.r1 && ref.r2 <= src.r2 && ref.c1 >= src.c1 && ref.c2 <= src.c2;
    const follow = (formula, ownerSheet) => mapFormulaRefs(formula, (ref) => {
      const target = ref.sheet ?? ownerSheet;
      if (!sameSheetName(target, sheet.name) || !inSrc(ref)) return ref;
      // Absolute references move too: the cell they name has moved.
      return { ...ref, r1: ref.r1 + dr, r2: ref.r2 + dr, c1: ref.c1 + dc, c2: ref.c2 + dc };
    });
    this.transaction('Move cells', () => {
      this._moveNativePivots(sheetId, src, sheetId, dst);
      this._moveConditionalFormats(sheetId, sheetId, [{ source: src, target: dst }]);
      this._setStyleResets(sheet, moveStyleResets(sheet.styleResets, src, dst), 'Move cells');
      const entries = new Map();
      const put = (r, c, cell) => entries.set(cellKey(r, c), { r, c, cell });
      for (let r = src.r1; r <= src.r2; r++) for (let c = src.c1; c <= src.c2; c++) put(r, c, null);
      for (let r = src.r1; r <= src.r2; r++) {
        for (let c = src.c1; c <= src.c2; c++) {
          const cell = cloneCell(sheet.cells.get(cellKey(r, c)));
          if (cell?.f != null) cell.f = follow(cell.f, sheet.name);
          put(r + dr, c + dc, cell);
        }
      }
      // Existing formulas and templates for future table rows must both
      // follow moved inputs. Source/destination cells are handled above.
      this._rewriteFormulas((formula, owner, r, c, template) => {
        if (!template && owner === sheet && entries.has(cellKey(r, c))) return formula;
        return follow(formula, owner.name);
      }, 'Move cells');
      const names = this.names.map((n) => ({ ...n, ref: follow(n.ref, n.sheet || null) }));
      if (names.some((n, i) => n.ref !== this.names[i].ref)) this._setNames(names, 'Move cells');
      // Tables inside the block keep their name, columns, and templates (which followed above like any
      // formula). They step aside while the cells are written, so their headers leaving and landing are
      // not taken for renames, and return at their new place in their old order.
      const ids = new Set(movingTables.map((t) => t.id));
      const order = sheet.tables;
      const moved = new Map(order.filter((t) => ids.has(t.id)).map((t) => [t.id, { ...t, range: shifted(t.range), ...(t.calcRow != null ? { calcRow: t.calcRow + dr } : {}) }]));
      if (ids.size) this._setTables(sheet, order.filter((t) => !ids.has(t.id)), 'Move cells');
      // A cell landing on (or leaving) a table header renames that column, as a pasted header does.
      this.setCellsWithTableHeaders(sheetId, [...entries.values()], 'Move cells', {
        r1: Math.min(src.r1, dst.r1), c1: Math.min(src.c1, dst.c1), r2: Math.max(src.r2, dst.r2), c2: Math.max(src.c2, dst.c2),
      });
      if (ids.size) {
        const live = new Map(sheet.tables.map((t) => [t.id, t]));
        this._setTables(sheet, order.map((t) => moved.get(t.id) || live.get(t.id)), 'Move cells');
        // A moving table's filter goes with it, its column criteria re-keyed; the moved cells decide anew what it hides.
        for (const f of sheetFilters(sheet)) {
          const owner = movingTables.find(t => t.range.r1 === f.range.r1 && t.range.c1 === f.range.c1 && t.range.c2 === f.range.c2);
          if (owner) this._setFilter(sheet, { ...f, range: shifted(f.range), criteria: Object.fromEntries(Object.entries(f.criteria).map(([c, crit]) => [Number(c) + dc, crit])),
            ...(f.hiddenButtons ? { hiddenButtons: f.hiddenButtons.map(c => c + dc) } : {}) }, 'Move cells', { target: f });
        }
      }
      // Notes travel with their cells; notes already at the destination go.
      const moving = [];
      for (const [key, text] of sheet.notes) {
        const { r, c } = parseKey(key);
        if (r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2) moving.push({ r, c, text });
        else if (r >= dst.r1 && r <= dst.r2 && c >= dst.c1 && c <= dst.c2) this.setNote(sheetId, r, c, null);
      }
      for (const { r, c } of moving) this.setNote(sheetId, r, c, null);
      for (const { r, c, text } of moving) this.setNote(sheetId, r + dr, c + dc, text);
      carryComments(this, sheetId, src, sheetId, dr, dc);
      // Merges inside the block move; a merge under the landing block gives way.
      if (sheet.merges.length) {
        const kept = sheet.merges.filter((m) => !inside(m) && !overlaps(m, dst));
        const moved = sheet.merges.filter(inside).map((m) => ({ r1: m.r1 + dr, c1: m.c1 + dc, r2: m.r2 + dr, c2: m.c2 + dc }));
        if (kept.length + moved.length !== sheet.merges.length || moved.length) this._setMerges(sheet, [...kept, ...moved], 'Move cells');
      }
      // Validation rules and chart sources that lie
      // wholly inside the block travel with it.
      if (sheet.validations.some((v) => inside(v.range))) this._setValidations(sheet, sheet.validations.map((v) => (inside(v.range) ? { ...v, range: shifted(v.range) } : v)), 'Move cells');
      if (sheet.charts.some((ch) => inside(ch.range))) this._setCharts(sheet, sheet.charts.map((ch) => (inside(ch.range) ? { ...ch, range: shifted(ch.range) } : ch)), 'Move cells');
      this._rewriteRuleFormulas((formula, owner) => follow(formula, owner.name), 'Move cells', { conditional: false });
      this._moveNativeSparklines(sheet, sheet, src, dst);
    });
    return dst;
  }

  /** Carry native sparkline destinations with a cut, retaining shared settings.
   * Source references have already followed the moved cells once. A group split
   * across sheets needs a new revision identity and explicit old-sheet bindings. */
  _moveNativeSparklines(source, target, src, dst) {
    const inside = (r, c, area) => r >= area.r1 && r <= area.r2 && c >= area.c1 && c <= area.c2;
    this._moveNativeSparklineCells(source, target, {
      destinationCell: (r, c) => inside(r, c, src) ? { r: r + dst.r1 - src.r1, c: c + dst.c1 - src.c1 } : null,
      targetCell: (r, c) => inside(r, c, dst),
    }, dst);
  }

  /** The caller has preflighted the complete packed cut before changing cells. */
  moveNativeSparklinesFromCells(sourceId, targetId, rows, cols, r, c) {
    if (!rows.length || !cols.length) return;
    const source = this.sheet(sourceId), target = this.sheet(targetId);
    // Anchors are individual cells: reuse the indexed mapping rather than
    // expanding the Cartesian product of fragmented row and column runs.
    const move = packedMoveReferences(source.name, target.name, rows, cols, r, c);
    for (const owner of this.sheets) {
      const groups = mapNativeSparklineReferences(owner.sparklineGroups, formula => move.follow(formula, owner.name));
      if (groups !== owner.sparklineGroups) this._writeRuleFormulaUpdates(owner, { sparklineGroups: groups }, 'Move cells');
    }
    this._moveNativeSparklineCells(source, target, move, { r2: r + rows.length - 1, c2: c + cols.length - 1 });
  }

  _moveNativeSparklineCells(source, target, move, bounds) {
    const across = source !== target;
    const moving = [];
    this._growTo(target, bounds.r2 + 1, bounds.c2 + 1);
    const kept = source.sparklineGroups.flatMap(group => {
      const carried = [], remaining = [];
      for (const spark of group.sparklines) {
        const ref = parseRefText(spark.ref);
        const dest = move.destinationCell(ref.r1, ref.c1);
        if (dest) carried.push({ ...spark, ref: cellName(dest.r, dest.c) });
        else if (across || !move.targetCell(ref.r1, ref.c1)) remaining.push(spark);
      }
      if (!across) return carried.length || remaining.length ? [{ ...group, sparklines: [...remaining, ...carried] }] : [];
      if (carried.length) {
        const moved = { ...group, uid: remaining.length ? `{${crypto.randomUUID().toUpperCase()}}` : group.uid, sparklines: carried };
        moving.push(...mapNativeSparklineReferences([moved], formula => {
          // An unqualified name retains the source sheet's name scope too.
          if (this.namedEntry(formula.trim(), source.name)) return `${quoteSheet(source.name)}!${formula.trim()}`;
          return mapFormulaRefs(formula, ref => ref.sheet == null ? { ...ref, sheet: source.name } : ref);
        }));
      }
      return remaining.length ? [{ ...group, sparklines: remaining }] : [];
    });
    if (!across) {
      if (!sameJSON(kept, source.sparklineGroups)) this._writeRuleFormulaUpdates(source, { sparklineGroups: kept }, 'Move cells');
      return;
    }
    const landing = target.sparklineGroups.flatMap(group => {
      const sparklines = group.sparklines.filter(spark => {
        const ref = parseRefText(spark.ref); return !move.targetCell(ref.r1, ref.c1);
      });
      return sparklines.length ? [{ ...group, sparklines }] : [];
    });
    if (!sameJSON(kept, source.sparklineGroups)) this._writeRuleFormulaUpdates(source, { sparklineGroups: kept }, 'Move cells');
    const next = [...landing, ...moving];
    if (!sameJSON(next, target.sparklineGroups)) this._writeRuleFormulaUpdates(target, { sparklineGroups: next }, 'Move cells');
  }

  /** Does the block take some cells of a spilled array without its anchor? Those values have no cell of their own to move. */
  _splitsSpill(sheet, block) {
    for (const a of this._ensureSpills(sheet).anchors.values()) {
      const rows = a.rows || 1;
      const cols = a.cols || 1;
      if (a.r > block.r2 || a.r + rows - 1 < block.r1 || a.c > block.c2 || a.c + cols - 1 < block.c1) continue;
      if (a.fixed && (a.r < block.r1 || a.c < block.c1 || a.r + rows - 1 > block.r2 || a.c + cols - 1 > block.c2)) return true;
      if (a.r < block.r1 || a.r > block.r2 || a.c < block.c1 || a.c > block.c2) return true;
    }
    return false;
  }

  /**
   * Finish a cut: the cut cells land at (r0, c0) as a move and leave their
   * old place, in one undo step (the cut alone changed nothing). Formulas
   * everywhere that pointed into the cut block now point at its new place,
   * even on another sheet, and the moved formulas keep pointing at what they
   * pointed at. Returns the destination range; null when the paste is
   * refused; false when the cut block holds part of a spilled array without
   * its anchor, whose values clearing the source cannot remove, so the
   * caller pastes a copy instead of moving.
   */
  placeMoved(sheetId, r0, c0, cells, from) {
    const sheet = this.sheet(sheetId);
    const source = this.sheet(from?.sheetId);
    if (!sheet || !source || !cells.length || !cells[0].length) return null;
    const src = normalizeRange(from.range);
    const h = cells.length;
    const w = cells[0].length;
    // The destination sheet's own limits, which a file may have made larger than the interactive caps.
    const limit = gridLimits(sheet);
    if (r0 < 0 || c0 < 0 || r0 + h > limit.rows || c0 + w > limit.cols) return null;
    const dst = { r1: r0, c1: c0, r2: r0 + h - 1, c2: c0 + w - 1 };
    if (this.lockedIn(sheetId, dst) || this.lockedIn(source.id, src)) return null;
    if (this.pivotMoveEditBlocked(source.id, src, sheetId, dst)) return null;
    if (this._splitsSpill(source, src)) return false;
    if (this._arrayMoveBlocked(source, src, sheet, dst)) return null;
    const dr = r0 - src.r1;
    const dc = c0 - src.c1;
    const across = sheet.id !== source.id;
    // A table wholly inside the cut block moves with it, even to another sheet; a block that would tear a
    // table (some of its cells along with cells outside it) is refused, as is landing a table on another one.
    const inside = (m) => m.r1 >= src.r1 && m.r2 <= src.r2 && m.c1 >= src.c1 && m.c2 <= src.c2;
    const shifted = (m) => ({ ...m, r1: m.r1 + dr, c1: m.c1 + dc, r2: m.r2 + dr, c2: m.c2 + dc });
    const overlaps = (a, b) => !(a.r2 < b.r1 || a.r1 > b.r2 || a.c2 < b.c1 || a.c1 > b.c2);
    // Part of a merged block cannot be cut away from the rest, as it cannot be dragged away.
    if (source.merges.some((m) => overlaps(m, src) && !inside(m))) return null;
    // Landing on part of a merged block is refused too; a merge the block covers whole gives way (see moveRange).
    const overlapsDst = (m) => overlaps(m, dst);
    const insideDst = (m) => m.r1 >= dst.r1 && m.r2 <= dst.r2 && m.c1 >= dst.c1 && m.c2 <= dst.c2;
    if (sheet.merges.some((m) => (across || !inside(m)) && overlapsDst(m) && !insideDst(m))) return null;
    const movingTables = source.tables.filter((t) => inside(t.range));
    const ids = new Set(movingTables.map((t) => t.id));
    if (source.tables.some((t) => !inside(t.range) && overlaps(t.range, src) && !(src.r1 >= t.range.r1 && src.r2 <= t.range.r2 && src.c1 >= t.range.c1 && src.c2 <= t.range.c2))) return null;
    // On another sheet every table is in the way, the moving ones being still on the source sheet.
    if (movingTables.some((t) => sheet.tables.some((o) => (across || !ids.has(o.id)) && overlaps(shifted(t.range), o.range)))) return null;
    // A 3D span stays where it is, as when the block is dragged: it names every sheet between two tabs.
    const inSrc = (ref) => !ref.sheetEnd && ref.kind !== 'cols' && ref.kind !== 'rows' && ref.r1 >= src.r1 && ref.r2 <= src.r2 && ref.c1 >= src.c1 && ref.c2 <= src.c2;
    // A reference into the cut block follows it, naming the new sheet when the block changed sheets.
    const follow = (formula, ownerSheet) => mapFormulaRefs(formula, (ref) => {
      const target = ref.sheet ?? ownerSheet;
      if (!sameSheetName(target, source.name) || !inSrc(ref)) return ref;
      const moved = { ...ref, r1: ref.r1 + dr, r2: ref.r2 + dr, c1: ref.c1 + dc, c2: ref.c2 + dc };
      if (ref.sheet != null || across) moved.sheet = sheet.name;
      return moved;
    });
    // A moved formula: references into the block move with it; references to
    // other cells of the old sheet keep naming that sheet from the new one.
    const carry = (formula) => mapFormulaRefs(formula, (ref) => {
      const target = ref.sheet ?? source.name;
      if (!sameSheetName(target, source.name)) return ref;
      if (inSrc(ref)) return { ...ref, r1: ref.r1 + dr, r2: ref.r2 + dr, c1: ref.c1 + dc, c2: ref.c2 + dc, ...(ref.sheet != null ? { sheet: sheet.name } : {}) };
      return across && ref.sheet == null ? { ...ref, sheet: source.name } : ref;
    });
    this.transaction('Move cells', () => {
      this._moveNativePivots(source.id, src, sheetId, dst);
      this._moveConditionalFormats(source.id, sheetId, [{ source: src, target: dst }]);
      this._rewriteFormulas((formula, owner, r, c, template) => {
        if (!template && owner === sheet && r >= dst.r1 && r <= dst.r2 && c >= dst.c1 && c <= dst.c2) return formula; // overwritten below
        return follow(formula, owner.name);
      }, 'Move cells');
      const names = this.names.map((n) => ({ ...n, ref: follow(n.ref, n.sheet || null) }));
      if (names.some((n, i) => n.ref !== this.names[i].ref)) this._setNames(names, 'Move cells');
      // Tables inside the block keep their name, columns, and templates, which keep pointing at what they
      // pointed at as moved formulas do. They step aside while the cells are written, so their headers
      // leaving and landing are not taken for renames, and return at their new place.
      const order = source.tables;
      const moved = movingTables.map((t) => ({ ...t, range: shifted(t.range), ...(t.calcRow != null ? { calcRow: t.calcRow + dr } : {}),
        calc: Object.fromEntries(Object.entries(t.calc || {}).map(([c, f]) => [c, carry(f)])) }));
      if (ids.size) this._setTables(source, order.filter((t) => !ids.has(t.id)), 'Move cells');
      // The block leaves its place first, so where old and new place overlap the landing cells win.
      this._clearRange(source.id, src, { contents: true, styles: true });
      const entries = [];
      cells.forEach((row, i) => row.forEach((srcCell, j) => {
        const cell = srcCell ? cloneCell(srcCell) : null;
        if (cell?.f != null) cell.f = carry(cell.f);
        entries.push({ r: r0 + i, c: c0 + j, cell });
      }));
      this.setCellsWithTableHeaders(sheetId, entries, 'Move cells');
      if (ids.size) {
        if (across) this._setTables(sheet, [...sheet.tables, ...moved], 'Move cells');
        else {
          const live = new Map(sheet.tables.map((t) => [t.id, t]));
          const byId = new Map(moved.map((t) => [t.id, t]));
          this._setTables(sheet, order.map((t) => byId.get(t.id) || live.get(t.id)), 'Move cells');
        }
        // Every moving table carries its filter, including onto a sheet with existing filters.
        for (const f of sheetFilters(source)) {
          const owner = movingTables.find(t => t.range.r1 === f.range.r1 && t.range.c1 === f.range.c1 && t.range.c2 === f.range.c2);
          if (!owner) continue;
          const next = { ...f, range: shifted(f.range), criteria: Object.fromEntries(Object.entries(f.criteria).map(([c, crit]) => [Number(c) + dc, crit])),
            ...(f.hiddenButtons ? { hiddenButtons: f.hiddenButtons.map(c => c + dc) } : {}) };
          if (!across) this._setFilter(sheet, next, 'Move cells', { target: f });
          else { this._setFilter(source, null, 'Move cells', { target: f }); this._setFilter(sheet, next, 'Move cells', { create: true }); }
        }
      }
      // Notes, merges, validation rules and conditional formats inside the cut block travel
      // with it, as they do when the block is dragged; whatever they land on gives way.
      const inDst = (r, c) => r >= dst.r1 && r <= dst.r2 && c >= dst.c1 && c <= dst.c2;
      const movingNotes = [];
      for (const [key, text] of source.notes) { const { r, c } = parseKey(key); if (r >= src.r1 && r <= src.r2 && c >= src.c1 && c <= src.c2) movingNotes.push({ r, c, text }); }
      for (const key of [...sheet.notes.keys()]) { const { r, c } = parseKey(key); if (inDst(r, c)) this.setNote(sheetId, r, c, null); }
      for (const { r, c } of movingNotes) this.setNote(source.id, r, c, null);
      for (const { r, c, text } of movingNotes) this.setNote(sheetId, r + dr, c + dc, text);
      carryComments(this, source.id, src, sheetId, dr, dc);
      const movedMerges = source.merges.filter(inside).map(shifted);
      if (across && movedMerges.length) this._setMerges(source, source.merges.filter((m) => !inside(m)), 'Move cells');
      const keptMerges = sheet.merges.filter((m) => !overlapsDst(m) && (across || !inside(m)));
      if (keptMerges.length !== sheet.merges.length || movedMerges.length) this._setMerges(sheet, [...keptMerges, ...movedMerges], 'Move cells');
      const carryOver = (key, setter) => {
        const moved = source[key].filter((x) => inside(x.range)).map((x) => ({ ...x, range: shifted(x.range) }));
        if (!moved.length) return;
        if (across) {
          setter(source, source[key].filter((x) => !inside(x.range)));
          setter(sheet, [...sheet[key], ...moved]);
        } else setter(sheet, sheet[key].map((x) => (inside(x.range) ? { ...x, range: shifted(x.range) } : x)));
      };
      carryOver('validations', (s, list) => this._setValidations(s, list, 'Move cells'));
      if (!across && sheet.charts.some((ch) => inside(ch.range))) this._setCharts(sheet, sheet.charts.map((ch) => (inside(ch.range) ? { ...ch, range: shifted(ch.range) } : ch)), 'Move cells');
      this._rewriteRuleFormulas((formula, owner) => follow(formula, owner.name), 'Move cells', { conditional: false });
      this._moveNativeSparklines(source, sheet, src, dst);
    });
    return dst;
  }

  /**
   * Fill handle: extend the source block over `target`. A single value or
   * formula repeats (formulas shift); a numeric run continues its step;
   * text with a trailing number counts up.
   */
  fill(sheetId, source, target, { series = true, invert = false } = {}) {
    // invert (Ctrl/Cmd while dragging): a single number counts up instead of
    // repeating, and a run or text series repeats instead of continuing.
    const src = normalizeRange(source);
    const tgt = normalizeRange(target);
    const sheet = this.sheet(sheetId);
    const cells = this.copyRange(sheetId, src);
    const h = cells.length;
    const w = cells[0].length;
    const entries = [];
    const vertical = tgt.r2 - tgt.r1 + 1 > h || (tgt.c2 - tgt.c1 + 1 === w);
    const sparkSources = new Map();
    for (const group of sheet.sparklineGroups) for (const spark of group.sparklines) {
      sparkSources.set(spark.ref, { group, spark });
    }
    const sparkTargets = new Set(), sparkCopies = new Map();
    const fillLimit = gridLimits(sheet);
    const arrayCells = new Map();
    cells.forEach((row, i) => row.forEach((cell, j) => { if (cell?.array) arrayCells.set(cellKey(i, j), cell); }));
    const sourceArrays = arrayCells.size ? new FixedArrayIndex(arrayCells) : null;
    const filledArrays = new Map();

    const seriesFor = (list) => {
      const nums = list.map((cell) => cell?.f == null && typeof cell?.v === 'number' ? cell.v : null);
      const kinds = list.map((cell) => (cell?.f == null && typeof cell?.v === 'number' ? dateTimeKind(cell.s, cell.v) : null));
      if (nums.length >= 2 && nums.every((n) => n !== null)) {
        // Dates a month or a year apart (the same day, or both month ends) step by calendar months or years.
        if (kinds.every((k) => k === 'date' || k === 'datetime')) {
          const calendar = calendarStep(nums);
          if (calendar) return { kind: 'calendar', ...calendar, last: nums[nums.length - 1], first: nums[0], count: nums.length };
        }
        const step = nums[1] - nums[0];
        if (nums.every((n, i) => i === 0 || Math.abs(n - nums[i - 1] - step) < 1e-9)) return { kind: 'linear', step, last: nums[nums.length - 1], first: nums[0] };
        // Numbers without a constant step continue their best-fit straight line
        // (1, 2, 4 → 5.33, 6.83, 8.33): least squares over their positions 0 … n-1.
        if (!kinds.some((k) => k === 'date' || k === 'datetime' || k === 'time')) {
          const n = nums.length, mx = (n - 1) / 2, my = nums.reduce((a, b) => a + b, 0) / n;
          let sxy = 0, sxx = 0;
          nums.forEach((y, x) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
          const slope = sxy / sxx;
          return { kind: 'trend', slope, intercept: my - slope * mx, count: n };
        }
      }
      if (nums.length === 1 && nums[0] !== null) {
        // A lone date counts up by days and a lone time by hours; a lone number repeats unless Ctrl is held.
        if (kinds[0] === 'date' || kinds[0] === 'datetime') return { kind: 'linear', step: 1, last: nums[0], first: nums[0] };
        if (kinds[0] === 'time') return { kind: 'linear', step: 1 / 24, last: nums[0], first: nums[0] };
        return { kind: 'linear', step: 1, last: nums[0], first: nums[0], single: true };
      }
      return null;
    };
    // A run of dates that share their day of month (or all fall on month ends) a fixed number of
    // months apart: { months } to step by; null when the run is not such a series.
    const calendarStep = (serials) => {
      const parts = serials.map((n) => serialToYMD(Math.floor(n)));
      if (parts.some((p) => !Number.isFinite(p.y))) return null;
      const monthIndex = (p) => p.y * 12 + (p.m - 1);
      const months = monthIndex(parts[1]) - monthIndex(parts[0]);
      if (months === 0) return null;
      const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
      const monthEnd = parts.every((p) => p.d === daysIn(p.y, p.m));
      const sameDay = parts.every((p) => p.d === parts[0].d);
      if (!monthEnd && !sameDay) return null;
      for (let i = 1; i < parts.length; i++) if (monthIndex(parts[i]) - monthIndex(parts[i - 1]) !== months) return null;
      return { months, day: monthEnd ? 'end' : parts[0].d, frac: serials[0] - Math.floor(serials[0]) };
    };
    // The date `k` months from the run's start on the same day (or month end).
    const calendarAt = (series, k) => {
      const start = serialToYMD(Math.floor(series.first));
      const index = start.y * 12 + (start.m - 1) + series.months * k;
      const y = Math.floor(index / 12);
      const m = (index % 12) + 1;
      const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = series.day === 'end' ? daysIn : Math.min(series.day, daysIn);
      return ymdToSerial(y, m, d) + series.frac;
    };

    // "Item 1", "Item 2", ...: the shared prefix, the first number, its width and the step, or null.
    const textNumberRun = (list) => {
      const parts = list.map((cell) => (cell?.f == null && typeof cell?.v === 'string' ? /^(.*?)(\d+)$/.exec(cell.v) : null));
      if (parts.some((m) => !m) || !parts.length) return null;
      if (!parts.every((m) => m[1] === parts[0][1])) return null;
      const numbers = parts.map((m) => parseInt(m[2], 10));
      // A number too long to count exactly would repeat the same rounded value; such text is repeated as it is.
      if (numbers.some((v) => v > Number.MAX_SAFE_INTEGER)) return null;
      const step = parts.length > 1 ? numbers[1] - numbers[0] : 1;
      if (parts.length > 1 && (step === 0 || numbers.some((v, i) => i && v - numbers[i - 1] !== step))) return null;
      return { prefix: parts[0][1], startNum: numbers[0], width: parts[0][2].length, step, count: parts.length };
    };
    const line = (k) => (vertical ? cells.map((row) => row[k]) : cells[k]);
    const lines = vertical ? w : h;
    for (let k = 0; k < lines; k++) {
      const list = line(k);
      const numericRaw = seriesFor(list);
      const numeric = invert ? (numericRaw?.single ? { ...numericRaw, single: false } : null) : series ? numericRaw : null;
      const names = series && !invert ? textSeriesFor(list.map((cell) => (cell?.f == null ? cell?.v : null))) : null;
      const n = list.length;
      const span = vertical ? [tgt.r1, tgt.r2] : [tgt.c1, tgt.c2];
      const srcStart = vertical ? src.r1 : src.c1;
      const srcEnd = vertical ? src.r2 : src.c2;
      // Rows a filter hides are skipped, and the series continues across
      // them as if they were not there.
      const filtered = vertical ? sheet.filterHidden : null;
      const before = [];
      const after = [];
      for (let p = span[0]; p <= span[1]; p++) {
        if ((p >= srcStart && p <= srcEnd) || filtered?.has(p)) continue;
        (p < srcStart ? before : after).push(p);
      }
      const positions = [...before.map((p, i) => [p, i - before.length]), ...after.map((p, i) => [p, i])];
      for (const [p, offset] of positions) {
        const r = vertical ? p : src.r1 + k;
        const c = vertical ? src.c1 + k : p;
        // Cells hidden under a merge are never written: a merged cell takes one value, at its top-left.
        if (!inGrid(r, c, fillLimit) || this._coveredByMerge(sheetId, r, c)) continue;
        const idx = ((offset % n) + n) % n;
        const base = list[idx];
        if (sparkSources.size) {
          const sr = src.r1 + (vertical ? idx : k), sc = src.c1 + (vertical ? k : idx);
          const ref = cellName(r, c), sourceSpark = sparkSources.get(cellName(sr, sc));
          sparkTargets.add(ref);
          if (sourceSpark) {
            const { group, spark } = sourceSpark;
            if (!sparkCopies.has(group)) sparkCopies.set(group, []);
            sparkCopies.get(group).push({ ...spark, ref,
              ...(spark.formula != null ? { formula: shiftFormula(spark.formula, r - sr, c - sc) } : {}) });
          }
        }
        const a = sourceArrays?.at(vertical ? idx : k, vertical ? k : idx);
        if (a) {
          const ar = r - (vertical ? idx : k) + a.r, ac = c - (vertical ? k : idx) + a.c;
          const key = cellKey(ar, ac);
          const covered = filledArrays.get(key) || { r1: ar, c1: ac, r2: ar + a.rows - 1, c2: ac + a.cols - 1, total: a.rows * a.cols, count: 0 };
          covered.count++;
          filledArrays.set(key, covered);
        }
        let cell = cloneCell(base);
        const steps = p < srcStart ? offset : offset + 1;
        if (numeric && numeric.kind === 'trend') {
          const x = p < srcStart ? steps : numeric.count - 1 + steps;
          const value = numeric.intercept + numeric.slope * x;
          cell = { v: Number.isInteger(value) ? value : Number(value.toPrecision(15)), f: null, s: base?.s };
        } else if (numeric && numeric.kind === 'calendar') {
          const k = p < srcStart ? steps : numeric.count - 1 + steps;
          cell = { v: calendarAt(numeric, k), f: null, s: base?.s };
        } else if (numeric && !numeric.single) {
          const value = p < srcStart ? numeric.first + numeric.step * steps : numeric.last + numeric.step * steps;
          // Round on the value's significant digits: a fixed decimal scale overflowed large numbers to Infinity.
          cell = { v: Number.isInteger(value) ? value : Number(value.toPrecision(15)), f: null, s: base?.s };
        } else if (names) {
          const L = names.seq.length;
          const from = p < srcStart ? names.start : names.start + names.step * (n - 1);
          const at = (((from + names.step * steps) % L) + L) % L;
          cell = { v: applyCase(names.seq[at], names.like), f: null, s: base?.s };
        } else if (base?.f != null) {
          const dr = r - (src.r1 + (vertical ? idx : k));
          const dc = c - (src.c1 + (vertical ? k : idx));
          cell.f = shiftFormula(base.f, dr, dc);
        } else if (series && !invert && base && typeof base.v === 'string') {
          // Text ending in a number counts on: one cell steps by 1, a run with a constant step keeps it ("Item 1, Item 3" → "Item 5").
          const run = textNumberRun(list);
          if (run) {
            const at = p < srcStart ? -run.count + offset + run.count : run.count - 1 + steps;
            const num = run.startNum + run.step * (p < srcStart ? offset : run.count - 1 + steps);
            // Filled upward the count runs on past zero (Item1, Item0, Item-1); a padded width keeps its digits.
            cell = { v: `${run.prefix}${num < 0 ? '-' : ''}${String(Math.abs(num)).padStart(run.width, '0')}`, f: null, s: base.s };
            void at;
          }
        }
        entries.push({ r, c, cell: this._replaceCellStyle(sheet, base ? cell : null, r, c) });
      }
    }
    for (const a of filledArrays.values()) if (a.count !== a.total) { this._arrayRefused(sheet, a); return; }
    // Sparkline-only cells have no scalar change to report. Preflight the whole
    // edit before changing their metadata, including array and protection guards.
    if (sparkTargets.size && (this._gridLocked(sheet) ||
        entries.some(({ r, c }) => this._protectedAt(sheet, r, c)) ||
        this._fixedWritesBlocked(sheet, entries))) {
      this.setCellsWithTableHeaders(sheetId, entries, 'Fill');
      return;
    }
    this.transaction('Fill', () => {
      let nativeChanged = false;
      if (sparkTargets.size) {
        // Filled members stay in the source group: date categories and shared
        // axes are group properties, while each series reference shifts alone.
        const next = sheet.sparklineGroups.flatMap(group => {
          const sparklines = [...group.sparklines.filter(spark => !sparkTargets.has(spark.ref)), ...(sparkCopies.get(group) || [])];
          return sparklines.length ? [{ ...group, sparklines }] : [];
        });
        if (!sameJSON(next, sheet.sparklineGroups)) {
          for (const copies of sparkCopies.values()) for (const spark of copies) {
            const ref = parseRefText(spark.ref);
            this._growTo(sheet, ref.r1 + 1, ref.c1 + 1);
          }
          this._writeRuleFormulaUpdates(sheet, { sparklineGroups: next }, 'Fill');
          nativeChanged = true;
        }
      }
      // A fill over a table header renames its column and keeps the headers distinct, as a paste does.
      const changed = this.setCellsWithTableHeaders(sheetId, entries, 'Fill');
      // Rows filled under a table join it, whether the fill handle was dragged or double-clicked or Ctrl+D
      // pressed; the drag's own extendTableToCover call afterwards finds the table already grown. A fill
      // that wrote nothing (one a protected cell refused) grows no table. The whole target goes over, not
      // just the part under the source row: a Ctrl+D whose source row lies inside the table still grows it.
      // Blank native anchors are real filled content even without scalar writes.
      if ((changed || nativeChanged) && tgt.r2 > src.r2) this.extendTableToCover(sheetId, { r1: tgt.r1, c1: tgt.c1, r2: tgt.r2, c2: tgt.c2 });
    });
  }

  /**
   * Ctrl+Enter: put one typed entry into every cell of a range, formulas
   * shifting relative to `origin` (the cell it was typed in).
   */
  fillInput(sheetId, range, text, origin) {
    const { r1, c1, r2, c2 } = normalizeRange(range);
    const total = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (total > 50000) return;
    const entries = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (this._coveredByMerge(sheetId, r, c)) continue; // Ctrl+Enter over a merged cell writes its top-left only
        const cell = cellFromInput(text, this.styleAt(sheetId, r, c));
        if (cell?.f != null && (r !== origin.r || c !== origin.c)) cell.f = shiftFormula(cell.f, r - origin.r, c - origin.c);
        this._applyImpliedStyle(sheetId, cell, r, c);
        entries.push({ r, c, cell });
      }
    }
    this.transaction('Fill', () => {
      // Rows entered right under a table join it, as pasted rows do.
      if (this.setCellsWithTableHeaders(sheetId, entries, 'Fill')) this.extendTableToCover(sheetId, { r1, c1, r2, c2 });
    });
  }

  /**
   * Ctrl+D / Ctrl+R: copy the first row (or column) of the range into the
   * rest of it; a single cell takes the cell above (or to the left).
   */
  fillDirection(sheetId, range, direction) {
    const n = normalizeRange(range);
    const single = n.r1 === n.r2 && n.c1 === n.c2;
    // Fill Up and Fill Left copy from the last row or column of the range (a single cell: from the one below or right).
    if (direction === 'up') {
      if (single) { if (n.r1 + 1 >= gridLimits(this.sheet(sheetId)).rows) return; this.fill(sheetId, { ...n, r1: n.r1 + 1, r2: n.r1 + 1 }, { ...n, r2: n.r1 + 1 }, { series: false }); return; }
      if (n.r1 === n.r2) return;
      this.fill(sheetId, { ...n, r1: n.r2 }, n, { series: false });
      return;
    }
    if (direction === 'left') {
      if (single) { if (n.c1 + 1 >= gridLimits(this.sheet(sheetId)).cols) return; this.fill(sheetId, { ...n, c1: n.c1 + 1, c2: n.c1 + 1 }, { ...n, c2: n.c1 + 1 }, { series: false }); return; }
      if (n.c1 === n.c2) return;
      this.fill(sheetId, { ...n, c1: n.c2 }, n, { series: false });
      return;
    }
    if (direction === 'down') {
      if (single) {
        if (n.r1 === 0) return;
        this.fill(sheetId, { r1: n.r1 - 1, c1: n.c1, r2: n.r1 - 1, c2: n.c2 }, { ...n, r1: n.r1 - 1 }, { series: false });
        return;
      }
      if (n.r1 === n.r2) return;
      this.fill(sheetId, { ...n, r2: n.r1 }, n, { series: false });
      return;
    }
    if (single) {
      if (n.c1 === 0) return;
      this.fill(sheetId, { r1: n.r1, c1: n.c1 - 1, r2: n.r2, c2: n.c1 - 1 }, { ...n, c1: n.c1 - 1 }, { series: false });
      return;
    }
    if (n.c1 === n.c2) return;
    this.fill(sheetId, { ...n, c2: n.c1 }, n, { series: false });
  }

  /**
   * Fill a series from the first cell of a range: linear (add step), growth
   * (multiply by step), or date (add step days, weekdays, months, or years).
   * Fills to the end of the range, or, with a stop value, until the value
   * would pass it (a single cell then fills down or right on its own).
   * Returns how many cells were written.
   */
  fillSeries(sheetId, range, { type = 'linear', step = 1, stop = null, unit = 'day', direction = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    if (this._gridLocked(sheet)) return 0;
    const n = normalizeRange(range);
    const dir = direction || (n.r2 > n.r1 || n.c1 === n.c2 ? 'down' : 'right');
    const start = sheet.cells.get(cellKey(n.r1, n.c1));
    const first = start ? this._compute(sheet, n.r1, n.c1) : null;
    if (typeof first !== 'number' || !Number.isFinite(first)) return 0;
    const k = Number(step);
    if (!Number.isFinite(k) || (type === 'growth' && k === 0)) return 0;
    const hasStop = stop != null && stop !== '' && Number.isFinite(Number(stop));
    const limit = Number(stop);
    const single = n.r1 === n.r2 && n.c1 === n.c2;
    const last = single ? (hasStop ? 10000 : 0) : dir === 'down' ? n.r2 - n.r1 : n.c2 - n.c1;
    const reset = styleResetAt(sheet.styleResets, n.r1, n.c1);
    const style = reset || start?.s ? { ...reset, ...start?.s } : undefined;
    const next = (v, i) => {
      if (type === 'growth') return first * k ** i;
      if (type === 'date') {
        const base = serialToYMD(first);
        if (unit === 'month' || unit === 'year') {
          const months = (unit === 'year' ? 12 : 1) * k * i;
          const total = base.y * 12 + (base.m - 1) + Math.round(months);
          const y = Math.floor(total / 12);
          const m = (total % 12 + 12) % 12 + 1;
          const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
          return ymdToSerial(y, m, Math.min(base.d, lastDay)) + (first - Math.floor(first));
        }
        if (unit === 'weekday') {
          let d = Math.floor(v);
          let left = Math.abs(Math.round(k));
          const sign = k < 0 ? -1 : 1;
          while (left > 0) {
            d += sign;
            const wd = serialToYMD(d).weekday;
            if (wd !== 0 && wd !== 6) {
              left--;
              // From a weekday, five working days always span seven calendar
              // days. Skip whole weeks so a large step cannot freeze the UI.
              d += sign * Math.floor(left / 5) * 7;
              left %= 5;
            }
          }
          return d + (first - Math.floor(first));
        }
        return v + k;
      }
      return first + k * i;
    };
    const entries = [];
    const increasing = type === 'growth' ? (first < 0 ? k <= 1 : k >= 1) : k >= 0;
    let v = first;
    for (let i = 1; i <= last; i++) {
      const moved = next(v, i);
      // A series standing still (a zero step, a growth factor of one) can never reach a stop value:
      // when only that value bounds the fill, it writes nothing rather than ten thousand cells.
      if (single && hasStop && moved === v) break;
      v = moved;
      if (!Number.isFinite(v)) break;
      if (hasStop && (increasing ? v > limit : v < limit)) break;
      const r = dir === 'down' ? n.r1 + i : n.r1;
      const c = dir === 'down' ? n.c1 : n.c1 + i;
      if (r >= MAX_ROWS || c >= MAX_COLS) break;
      // A cell hidden under a merge shows nothing and takes no value: the series passes over it, as the
      // fill handle does, rather than leaving a number there for SUM to count and unmerging to reveal.
      if (this._coveredByMerge(sheetId, r, c)) continue;
      const prev = sheet.cells.get(cellKey(r, c));
      // Clean arithmetic noise without rounding small nonzero values to zero
      // or changing large integers by scaling them past their precision.
      const rounded = Number.isInteger(v) ? v : Number(v.toPrecision(15));
      entries.push({ r, c, cell: { v: rounded, f: null, s: style || prev?.s } });
    }
    if (!entries.length) return 0;
    const begin = entries[0];
    const end = entries[entries.length - 1];
    if (this.lockedIn(sheetId, { r1: begin.r, c1: begin.c, r2: end.r, c2: end.c })) return 0;
    // setCells grows the sheet only after its protection checks succeed.
    this.setCells(sheetId, entries, 'Fill series');
    return entries.length;
  }

  /**
   * Double-click on the fill handle: extend the selection downward as far
   * as the data beside it reaches, the longer run of the two neighbouring
   * columns. Returns the target range or null.
   */
  autoFillTarget(sheetId, range) {
    const n = normalizeRange(range);
    const has = (r, c) => { const cell = this.getCell(sheetId, r, c); return !!cell && (cell.v != null || cell.f != null); };
    const sheet = this.sheet(sheetId);
    const limit = Math.min(sheet.rows, MAX_ROWS);
    const reach = (c) => { let r = n.r2; while (r + 1 < limit && has(r + 1, c)) r++; return r; };
    const r = Math.max(n.c1 > 0 ? reach(n.c1 - 1) : n.r2, n.c2 + 1 < MAX_COLS ? reach(n.c2 + 1) : n.r2);
    if (r === n.r2) return null;
    return { ...n, r2: r };
  }

  /** Sort the rows of a range by one of its columns (absolute column index). */
  sortRange(sheetId, range, col, ascending = true) {
    return this.sortRangeBy(sheetId, range, [{ col, ascending }]);
  }

  /**
   * Sort by several keys in turn: keys = [{ col, ascending }]. Empty cells
   * and errors sort last whatever the direction; ties keep their order.
   */
  /**
   * Sort the rows of a range by one or more columns: keys = [{ col, ascending }].
   * Blanks and errors sink to the end either way; `caseSensitive` puts
   * "apple" before "Apple" instead of treating them as equal.
   */
  /** The fill colors (from styles or conditional formatting) used in one column of a range, most common first. */
  columnFills(sheetId, range, col) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const { r1, r2 } = normalizeRange(range);
    const counts = new Map();
    for (let r = r1; r <= Math.min(r2, sheet.rows - 1); r++) {
      const fill = this._cellFill(sheet, r, col);
      if (fill) counts.set(fill, (counts.get(fill) || 0) + 1);
    }
    return [...counts.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count);
  }

  /**
   * Sort the rows of a range by one or more columns: keys = [{ col, ascending }]
   * for values, or [{ col, color }] to bring rows with that fill to the top
   * (ascending false sends them to the bottom).
   */
  /**
   * A row tool's range trimmed to a table's data rows: the header and totals
   * never move. Null when the range only partly overlaps a table or touches
   * more than one.
   */
  _dataRowsOnly(sheet, range) {
    return this._rearrangeCheck(sheet, range, 'row').range || null;
  }

  /**
   * Can the rows (or, for axis 'col', the columns) of a range change places?
   * { range } trimmed to a table's data rows, and widened to the table's
   * columns, when they can; { reason } when not: 'table' (a table only
   * partly inside, or two of them; any table when sorting columns), 'merged'
   * (merges that would come apart or hide cells) or 'array' (a spilled
   * result that would scatter).
   */
  _rearrangeCheck(sheet, range, axis) {
    const hit = sheet.tables.filter((t) => !(range.r2 < t.range.r1 || range.r1 > t.range.r2 || range.c2 < t.range.c1 || range.c1 > t.range.c2));
    let out = range;
    if (hit.length > 1 || (axis === 'col' && hit.length)) return { reason: 'table' };
    if (hit.length === 1) {
      const [t] = hit;
      if (range.r1 < t.range.r1 || range.r2 > t.range.r2) return { reason: 'table' };
      // A table's row is the unit that moves: a range inside the table takes in its other columns,
      // so no record comes apart. One that reaches past a side of the table would
      // move the table's rows with only some of the columns outside it, and is refused.
      if (range.c1 >= t.range.c1 && range.c2 <= t.range.c2) out = { ...range, c1: t.range.c1, c2: t.range.c2 };
      else if (range.c1 > t.range.c1 || range.c2 < t.range.c2) return { reason: 'table' };
      const { dataStart, dataEnd } = tableRows(t);
      out = { ...out, r1: Math.max(range.r1, dataStart), r2: Math.min(range.r2, dataEnd) };
      if (out.r1 > out.r2) return { reason: 'table' };
    }
    // Lines can only change places when every line has the same merges (all of them one line
    // wide and inside the range), and when no spilled array lies across them: a rearranged
    // block would otherwise hide cells under a merge or scatter an array.
    const merges = this.mergesIn(sheet.id, out);
    if (merges.length) {
      const [lo, hi, across1, across2] = axis === 'row' ? ['r1', 'r2', 'c1', 'c2'] : ['c1', 'c2', 'r1', 'r2'];
      const shapes = new Map();
      for (const m of merges) {
        if (m[lo] !== m[hi] || m.r1 < out.r1 || m.r2 > out.r2 || m.c1 < out.c1 || m.c2 > out.c2) return { reason: 'merged' };
        shapes.set(m[lo], [...(shapes.get(m[lo]) || []), `${m[across1]}:${m[across2]}`].sort().join(','));
      }
      const first = shapes.get(out[lo]) || '';
      for (let i = out[lo]; i <= out[hi]; i++) if ((shapes.get(i) || '') !== first) return { reason: 'merged' };
    }
    for (const a of this._ensureSpills(sheet).anchors.values()) {
      const rows = a.rows || 1;
      const cols = a.cols || 1;
      if (a.r <= out.r2 && a.r + rows - 1 >= out.r1 && a.c <= out.c2 && a.c + cols - 1 >= out.c1) return { reason: 'array' };
    }
    return { range: out };
  }

  /**
   * Why a sort, shuffle, or duplicate removal over a range would be refused:
   * 'protected' (the sheet, or a cell inside), 'table', 'merged', or 'array'
   * as in _rearrangeCheck; null when the lines may change places. A query
   * only: unlike the tools themselves it announces nothing.
   */
  rearrangeBlocker(sheetId, range, axis = 'row') {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 'protected';
    if (sheet.protected) return 'protected';
    const check = this._rearrangeCheck(sheet, normalizeRange(range), axis);
    if (check.reason) return check.reason;
    const n = check.range;
    return sheet.protectedRanges.some(({ range: g }) => g.r1 <= n.r2 && g.r2 >= n.r1 && g.c1 <= n.c2 && g.c2 >= n.c1) ? 'protected' : null;
  }

  /** Returns true when the rows were sorted, false when the range cannot be rearranged (see rearrangeBlocker). */
  sortRangeBy(sheetId, range, keys, { caseSensitive = false } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !keys?.length) return false;
    if (this._gridLocked(sheet)) return false;
    const trimmed = this._dataRowsOnly(sheet, normalizeRange(range));
    if (!trimmed || this.lockedIn(sheetId, trimmed)) return false;
    const { r1, c1 } = trimmed;
    // Rows below the range's content are blank and sort last anyway, and columns past it are blank in every
    // row: a whole-column or whole-row range moves only what is there. Content is whatever a row takes along
    // when it moves, a note or a format on an empty cell as much as a value.
    const bounds = this._contentBounds(sheet, trimmed);
    const r2 = Math.min(trimmed.r2, bounds.r2);
    const c2 = Math.min(trimmed.c2, bounds.c2);
    if (r2 < r1 || c2 < c1) return true;
    const rows = [];
    for (let r = r1; r <= r2; r++) {
      const cells = [];
      for (let c = c1; c <= c2; c++) cells.push(cloneCell(sheet.cells.get(cellKey(r, c))));
      // A color key sorts rows with that fill first (0) and the rest after (1); a value key sorts by the cell's value.
      rows.push({ r, cells, keys: keys.map((k) => (k.color !== undefined ? (this._cellFill(sheet, r, k.col) === String(k.color).toLowerCase() ? 0 : 1) : this.getValue(sheetId, r, k.col))) });
    }
    const compareKey = sortComparator(caseSensitive);
    rows.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const cmp = compareKey(a.keys[i], b.keys[i], keys[i].ascending !== false);
        if (cmp) return cmp;
      }
      return a.r - b.r;
    });
    const entries = [];
    const notes = [];
    rows.forEach((row, i) => {
      const r = r1 + i;
      row.cells.forEach((cell, j) => {
        const c = c1 + j;
        let next = cell;
        if (cell?.f != null && row.r !== r) next = { ...cell, f: shiftFormula(cell.f, r - row.r, 0) };
        entries.push({ r, c, cell: next });
        // A note belongs to its row's cell and sorts along with it.
        const note = sheet.notes.get(cellKey(row.r, c));
        if (note && row.r !== r) notes.push({ from: { r: row.r, c }, to: { r, c }, note });
      });
    });
    this.transaction('Sort', () => {
      if (sheet.styleResets.length) {
        const movedRows = new Map(rows.map((row, i) => [row.r, r1 + i]));
        this._setStyleResets(sheet, permuteStyleResets(sheet.styleResets, { r1, r2, c1, c2: trimmed.c2 }, 'row', (r) => movedRows.get(r)), 'Sort');
      }
      this.setCells(sheetId, entries, 'Sort');
      this._moveNotes(sheetId, notes);
      permuteComments(this, sheetId, { r1, r2, c1, c2 }, 'row', new Map(rows.map((row, i) => [row.r, r1 + i])));
      this._refilterRearranged(sheet, { r1, r2 }, 'Sort');
    });
    return true;
  }

  /**
   * The last row and column of a range that carry anything a line takes along when it moves: a value or
   * formula, a format or link kept on an empty cell, or a note; -1 for a blank range. The used range would
   * not do: it counts values alone, and left the notes of an otherwise empty column behind as their rows moved.
   */
  _contentBounds(sheet, range) {
    let r2 = -1;
    let c2 = -1;
    const take = (key) => {
      const { r, c } = parseKey(key);
      if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) return;
      if (r > r2) r2 = r;
      if (c > c2) c2 = c;
    };
    for (const key of sheet.cells.keys()) take(key);
    for (const key of sheet.notes.keys()) take(key);
    for (const key of sheet.comments.keys()) take(key);
    return { r2, c2 };
  }

  /** Notes that travelled with sorted cells: cleared at their old cells first, then written at the new ones. */
  _moveNotes(sheetId, moves) {
    if (!moves.length) return;
    for (const { from } of moves) this.setNote(sheetId, from.r, from.c, null);
    for (const { to, note } of moves) this.setNote(sheetId, to.r, to.c, note);
  }

  /**
   * Sort the columns of a range left to right by one or more rows:
   * keys = [{ row, ascending }]. Each column's cells move together and
   * formulas shift with their column. Returns true when sorted, false when
   * the columns cannot change places (see rearrangeBlocker).
   */
  sortColumnsBy(sheetId, range, keys, { caseSensitive = false } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !keys?.length) return false;
    if (this._gridLocked(sheet)) return false;
    // A merge wider than one column, a spilled array, or a table would come apart under moving columns.
    const { range: n } = this._rearrangeCheck(sheet, normalizeRange(range), 'col');
    if (!n || this.lockedIn(sheetId, n)) return false;
    const { r1, c1, c2 } = n;
    // Rows below the range's content (notes and formats included) are blank in every column: a whole-column
    // range moves only what is there.
    const r2 = Math.min(n.r2, this._contentBounds(sheet, n).r2);
    if (r2 < r1) return true;
    const cols = [];
    for (let c = c1; c <= c2; c++) {
      const cells = [];
      for (let r = r1; r <= r2; r++) cells.push(cloneCell(sheet.cells.get(cellKey(r, c))));
      cols.push({ c, cells, keys: keys.map((k) => this.getValue(sheetId, k.row, c)) });
    }
    const compareKey = sortComparator(caseSensitive);
    cols.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const cmp = compareKey(a.keys[i], b.keys[i], keys[i].ascending !== false);
        if (cmp) return cmp;
      }
      return a.c - b.c;
    });
    const entries = [];
    const notes = [];
    cols.forEach((col, j) => {
      const c = c1 + j;
      col.cells.forEach((cell, i) => {
        const r = r1 + i;
        const next = cell?.f != null && col.c !== c ? { ...cell, f: shiftFormula(cell.f, 0, c - col.c) } : cell;
        entries.push({ r, c, cell: next });
        const note = sheet.notes.get(cellKey(r, col.c));
        if (note && col.c !== c) notes.push({ from: { r, c: col.c }, to: { r, c }, note });
      });
    });
    this.transaction('Sort', () => {
      if (sheet.styleResets.length) {
        const movedCols = new Map(cols.map((col, i) => [col.c, c1 + i]));
        this._setStyleResets(sheet, permuteStyleResets(sheet.styleResets, { r1, r2: n.r2, c1, c2 }, 'col', (c) => movedCols.get(c)), 'Sort');
      }
      this.setCells(sheetId, entries, 'Sort');
      this._moveNotes(sheetId, notes);
      permuteComments(this, sheetId, { r1, r2, c1, c2 }, 'col', new Map(cols.map((col, j) => [col.c, c1 + j])));
      this._refilterRearranged(sheet, { r1, r2 }, 'Sort');
    });
    return true;
  }

  /**
   * Randomize range: shuffle the rows of a range (Fisher–Yates), keeping each
   * row's cells together; formulas shift with their row like a sort. Returns
   * the number of rows moved.
   */
  shuffleRows(sheetId, range, { random = Math.random } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    if (this._gridLocked(sheet)) return 0;
    const trimmed = this._dataRowsOnly(sheet, normalizeRange(range));
    // A protected cell among the rows refuses the shuffle, as it does a sort; the writes below would be declined anyway.
    if (!trimmed || this.lockedIn(sheetId, trimmed)) return 0;
    const { r1, c1 } = trimmed;
    let { r2, c2 } = trimmed;
    // Whole columns or rows shuffle the lines that hold something, not a million blank ones among them.
    if (r2 >= MAX_ROW || c2 >= MAX_COL) {
      const bounds = this._contentBounds(sheet, trimmed);
      if (r2 >= MAX_ROW) r2 = Math.min(r2, bounds.r2);
      if (c2 >= MAX_COL) c2 = Math.min(c2, bounds.c2);
    }
    if (r2 <= r1 || c2 < c1) return 0;
    const rows = [];
    for (let r = r1; r <= r2; r++) {
      const cells = [];
      for (let c = c1; c <= c2; c++) cells.push(cloneCell(sheet.cells.get(cellKey(r, c))));
      rows.push({ r, cells });
    }
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    const entries = [];
    const notes = [];
    let moved = 0;
    rows.forEach((row, i) => {
      const r = r1 + i;
      if (row.r !== r) moved++;
      row.cells.forEach((cell, j) => {
        const c = c1 + j;
        const next = cell?.f != null && row.r !== r ? { ...cell, f: shiftFormula(cell.f, r - row.r, 0) } : cell;
        entries.push({ r, c, cell: next });
        // A note belongs to its row's cell and travels with it.
        const note = sheet.notes.get(cellKey(row.r, c));
        if (note && row.r !== r) notes.push({ from: { r: row.r, c }, to: { r, c }, note });
      });
    });
    if (moved) {
      this.transaction('Randomize range', () => {
        if (sheet.styleResets.length) {
          const movedRows = new Map(rows.map((row, i) => [row.r, r1 + i]));
          this._setStyleResets(sheet, permuteStyleResets(sheet.styleResets, trimmed, 'row', (r) => movedRows.get(r)), 'Randomize range');
        }
        this.setCells(sheetId, entries, 'Randomize range');
        this._moveNotes(sheetId, notes);
        permuteComments(this, sheetId, trimmed, 'row', new Map(rows.map((row, i) => [row.r, r1 + i])));
        this._refilterRearranged(sheet, { r1, r2 }, 'Randomize range');
      });
    }
    return moved;
  }

  /**
   * Rewrite the text cells of a range: 'trim' | 'upper' | 'lower' | 'proper'.
   * Formulas and non-text values are left alone. Returns how many changed,
   * or false when a protected cell refused the change.
   */
  transformText(sheetId, range, kind) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    if (this._gridLocked(sheet)) return 0;
    const n = normalizeRange(range);
    const fn = {
      // Leading, trailing and repeated spaces go; the line breaks of wrapped text stay.
      trim: (t) => t.split('\n').map((line) => line.trim().replace(/[^\S\n]+/g, ' ')).join('\n').trim(),
      upper: (t) => t.toUpperCase(),
      lower: (t) => t.toLowerCase(),
      proper: (t) => t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, ch) => p + ch.toUpperCase()),
      // Text that reads as a number, date, percent, or currency becomes that value.
      number: (t) => {
        const parsed = parseInput(t.trim());
        return parsed && parsed.f == null && parsed.v != null && typeof parsed.v !== 'string' ? parsed : null;
      },
    }[kind];
    if (!fn) return 0;
    const entries = [];
    for (const [key, cell] of sheet.cells) {
      if (cell.f != null || typeof cell.v !== 'string') continue;
      const { r, c } = parseKey(key);
      if (r < n.r1 || r > n.r2 || c < n.c1 || c > n.c2) continue;
      if (kind === 'number') {
        // A table's headers are text (see addTable): one that reads as a number stays as it is.
        if (sheet.tables.some((t) => tableRows(t).header === r && c >= t.range.c1 && c <= t.range.c2)) continue;
        const parsed = fn(cell.v);
        if (!parsed) continue;
        // Drop a "plain text" format so the number shows as one; take the format the text implied (%, $, a date).
        const st = { ...(cell.s || {}) };
        if (st.fmt === 'text') delete st.fmt;
        if (parsed.fmt && (!st.fmt || st.fmt === 'general')) {
          // As for a typed entry, the details of a format the cell no longer has are no choice of the user's.
          for (const k of FORMAT_DETAIL_KEYS) delete st[k];
          st.fmt = parsed.fmt;
          if (parsed.dateStyle && !st.dateStyle) st.dateStyle = parsed.dateStyle;
          // The currency the text names comes with its format, as it does when the same text is typed: €5 stays in euros.
          if (parsed.cur) st.cur = parsed.cur;
          // The decimals or seconds the text carries refine only the format it just implied, as a typed entry's
          // do: a cell already set to Percent or Time keeps its own.
          refineImpliedFormat(st, parsed.fmt, cell.v);
        }
        entries.push({ r, c, cell: { v: parsed.v, f: null, s: Object.keys(st).length ? st : undefined } });
        continue;
      }
      const next = fn(cell.v);
      if (next !== cell.v) entries.push({ r, c, cell: { v: next, f: null, s: cell.s } });
    }
    if (!entries.length) return 0;
    // Every entry changes its cell, so the only write that changes nothing is one a protected cell refused.
    // Over a table's header row the change renames columns: the names stay distinct and the formulas that
    // used the old names follow, as they do when a header is typed, pasted or filled.
    return this.setCellsWithTableHeaders(sheetId, entries, kind === 'number' ? 'Convert to numbers' : 'Change text', n) || false;
  }

  /**
   * Split the text in the first column of a range into the columns to its
   * right, on a delimiter (auto-detected when null). Returns { rows, cols },
   * both 0 when nothing was split, with `reason` 'protected' when a protected
   * cell among the targets refused the split, 'room' when the pieces would
   * run past the last column, or 'merged' when one would land under a merge.
   *
   * `delimiter` may instead be the Text to Columns options (see text-split.js): separators or fixed
   * widths, plus `formats` (per piece: 'general', 'text' to keep it as typed, 'skip' to leave it out) and
   * `dest` ({ r, c }, where the first row's pieces start; by default over the text itself).
   */
  splitTextToColumns(sheetId, range, delimiter = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return { rows: 0, cols: 0 };
    if (this._gridLocked(sheet)) return { rows: 0, cols: 0 };
    const plan = this.splitTextPlan(sheetId, range, delimiter);
    if (!plan.entries) return { rows: 0, cols: 0, ...(plan.reason ? { reason: plan.reason } : {}) };
    const { entries } = plan;
    // A piece under a merged block would be stored out of sight: the split is refused rather than the merge undone unasked.
    for (const { r, c: cc } of entries) if (this._coveredByMerge(sheetId, r, cc)) return { rows: 0, cols: 0, reason: 'merged' };
    // The pieces land right of the selection, where a protected cell refuses the whole split; the
    // refusal is told apart from text that held no delimiter, which writes nothing new either.
    if (sheet.protectedRanges.length) {
      for (const { r, c: cc } of entries) if (this.lockedIn(sheetId, { r1: r, c1: cc, r2: r, c2: cc })) return { rows: 0, cols: 0, reason: 'protected' };
    }
    // Pieces written over a table's header row rename its columns: the names stay distinct and the
    // formulas that used the old names follow, as when a header is typed or pasted over.
    if (!this.setCellsWithTableHeaders(sheetId, entries, 'Split text')) return { rows: 0, cols: 0 };
    return { rows: plan.rows, cols: plan.cols };
  }

  /**
   * The cells a split would write, without writing them: { entries, rows, cols }, or { reason } (or {}) when
   * there is nothing to split. The editor asks it before a split whether cells holding data would be written over.
   */
  splitTextPlan(sheetId, range, delimiter = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return {};
    const n = normalizeRange(range);
    const c = n.c1;
    const texts = [];
    for (let r = n.r1; r <= n.r2; r++) {
      const cell = sheet.cells.get(cellKey(r, c));
      if (cell && cell.f == null && typeof cell.v === 'string') texts.push({ r, cell });
    }
    if (!texts.length) return {};
    let split;
    const options = delimiter && typeof delimiter === 'object' ? delimiter : null;
    if (options) {
      split = texts.map(({ r, cell }) => ({ r, cell, parts: splitPieces(cell.v, { ...DEFAULT_SPLIT, ...options }) }));
    } else {
      // The delimiter most rows contain wins; space is the last resort.
      const delim = delimiter || detectDelimiter(texts.map((t) => t.cell.v));
      if (!delim) return {};
      // Quoted fields keep their delimiter: "Smith, John",42 splits into two. A line
      // break inside a cell (Alt+Enter) is part of its piece, not the row break it is
      // in pasted text: the breaks are hidden from the parser and put back in the pieces.
      const pieces = (text) => (parseDelimited(text.replace(/\r/g, '\u0001').replace(/\n/g, '\u0002'), delim)[0] || [])
        .map((piece) => piece.replace(/\u0001/g, '\r').replace(/\u0002/g, '\n'));
      split = texts.map(({ r, cell }) => ({ r, cell, parts: delim === ' ' ? cell.v.trim().split(/\s+/) : pieces(cell.v) }));
    }
    const formats = options?.formats || [];
    const dest = options?.dest || { r: n.r1, c };
    const entries = [];
    let cols = 1;
    for (const { r, parts } of split) {
      const row = dest.r + (r - n.r1);
      let k = 0;
      parts.forEach((part, i) => {
        const fmt = formats[i] || 'general';
        if (fmt === 'skip') return;
        const at = dest.c + k++;
        const style = this.styleAt(sheetId, row, at);
        entries.push({ r: row, c: at, cell: cellFromInput(part.trim(), fmt === 'text' ? { ...(style || {}), fmt: 'text' } : style) });
      });
      cols = Math.max(cols, k);
    }
    // Pieces past the last column (or row) would be dropped while the split was reported as written, so the split is refused.
    if (dest.c + cols > Math.max(sheet.cols, MAX_COLS) || dest.r + (n.r2 - n.r1) >= Math.max(sheet.rows, MAX_ROWS)) return { reason: 'room' };
    if (!entries.length) return {};
    return { entries, rows: texts.length, cols };
  }

  /**
   * Delete the rows inside a range that hold nothing at all (no value, no
   * formula) across the whole sheet. Returns how many were removed.
   */
  removeEmptyRows(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    if (this._gridLocked(sheet)) return 0;
    const n = normalizeRange(range);
    const filled = new Set();
    for (const key of sheet.cells.keys()) {
      const cell = sheet.cells.get(key);
      if (cell.v == null && cell.f == null) continue;
      filled.add(parseKey(key).r);
    }
    // A row showing spilled results, or carrying a note, is not empty either.
    for (const key of this._ensureSpills(sheet).cover.keys()) filled.add(parseKey(key).r);
    for (const key of sheet.notes.keys()) filled.add(parseKey(key).r);
    for (const key of sheet.comments.keys()) filled.add(parseKey(key).r);
    // Nor is a row a merged block crosses, wherever in the row the block lies: the block is its content.
    const last = Math.min(n.r2, sheet.rows - 1);
    for (const a of this._fixedArrays(sheet).ranges) for (let r = Math.max(a.r1, n.r1), end = Math.min(a.r2, last); r <= end; r++) filled.add(r);
    for (const m of sheet.merges) for (let r = Math.max(m.r1, n.r1), end = Math.min(m.r2, last); r <= end; r++) filled.add(r);
    const blank = [];
    for (let r = n.r1; r <= last; r++) if (!filled.has(r)) blank.push(r);
    // A row holding a protected cell stays, as deleting it would be refused; the rows that do go are
    // the ones counted, and the first row kept is named the way the refused deletion would name it.
    const locked = (r) => sheet.protectedRanges.some(({ range: g }) => g.r1 <= r && g.r2 >= r);
    const empty = blank.filter((r) => !locked(r));
    if (empty.length < blank.length) this.lockedIn(sheetId, { r1: blank.find(locked), r2: blank.find(locked), c1: 0, c2: MAX_COL });
    if (!empty.length) return 0;
    // Every empty row goes in one deletion, so thousands of them scattered down a sheet cost no more than one block.
    this.deleteLines(sheetId, 'row', empty.map((r) => ({ from: r, to: r })), 'Remove empty rows');
    return empty.length;
  }

  /**
   * Remove rows within a range whose cells all match an earlier row
   * (case-insensitive, by displayed value). Remaining rows move up; the
   * freed rows at the bottom of the range are cleared. Returns the count,
   * or false when the rows cannot change places (see rearrangeBlocker).
   */
  removeDuplicates(sheetId, range, { header = false, columns = null } = {}) {
    // `columns`: the (absolute) columns that decide whether two rows match; all of them when null.
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return false;
    const asked = normalizeRange(range);
    const n = this._dataRowsOnly(sheet, asked);
    if (!n) return false;
    // Inside a table the header row is the table's own and was trimmed away already.
    const table = sheet.tables.find((t) => n.r1 > t.range.r1 && n.r2 <= t.range.r2 && n.c1 >= t.range.c1 && n.c2 <= t.range.c2) || null;
    const start = header && !table ? n.r1 + 1 : n.r1;
    if (start > n.r2) return 0;
    if (this.lockedIn(sheetId, { ...n, r1: start })) return false;
    // The columns asked for decide whether two rows match: a table's other columns, taken in so that
    // whole rows move (see _rearrangeCheck), do not join the comparison unasked.
    const compare = columns ? new Set(columns)
      : n.c1 !== asked.c1 || n.c2 !== asked.c2 ? new Set(Array.from({ length: asked.c2 - asked.c1 + 1 }, (_, i) => asked.c1 + i)) : null;
    const seen = new Set();
    const kept = [];
    let removed = 0;
    for (let r = start; r <= n.r2; r++) {
      const cells = [];
      const parts = [];
      let blank = true;
      for (let c = n.c1; c <= n.c2; c++) {
        const cell = cloneCell(sheet.cells.get(cellKey(r, c)));
        cells.push(cell);
        const v = cell && (cell.v != null || cell.f != null) ? this._compute(sheet, r, c) : null;
        if (v != null && v !== '') blank = false;
        if (compare && !compare.has(c)) continue;
        // Rows match by the text they show: a date and its serial, or 1.5 and
        // 150%, are two values, while two cells that both read 0.3 are one.
        parts.push(this.getDisplay(sheetId, r, c).toLowerCase());
      }
      // Cell text can contain any delimiter, including control characters.
      // Keep column boundaries unambiguous so distinct rows are never deleted.
      const key = JSON.stringify(parts);
      if (!blank && seen.has(key)) { removed++; continue; }
      if (!blank) seen.add(key);
      kept.push({ r, cells });
    }
    if (!removed) return 0;
    const entries = [];
    const notes = [];
    const keptRows = new Set(kept.map((row) => row.r));
    kept.forEach((row, i) => {
      const r = start + i;
      row.cells.forEach((cell, j) => {
        const c = n.c1 + j;
        let next = cell;
        if (cell?.f != null && row.r !== r) next = { ...cell, f: shiftFormula(cell.f, r - row.r, 0) };
        entries.push({ r, c, cell: next });
        // A note belongs to its row's cell and moves up with it.
        const note = sheet.notes.get(cellKey(row.r, c));
        if (note && row.r !== r) notes.push({ from: { r: row.r, c }, to: { r, c }, note });
      });
    });
    for (let r = start + kept.length; r <= n.r2; r++) {
      for (let c = n.c1; c <= n.c2; c++) entries.push({ r, c, cell: null });
    }
    // Notes on the duplicate rows go with them.
    for (let r = start; r <= n.r2; r++) {
      if (keptRows.has(r)) continue;
      for (let c = n.c1; c <= n.c2; c++) if (sheet.notes.has(cellKey(r, c))) notes.push({ from: { r, c }, to: null, note: null });
    }
    this.transaction('Remove duplicates', () => {
      if (sheet.styleResets.length) {
        const movedRows = new Map(kept.map((row, i) => [row.r, start + i]));
        this._setStyleResets(sheet, permuteStyleResets(sheet.styleResets, { ...n, r1: start }, 'row', (r) => movedRows.get(r)), 'Remove duplicates');
      }
      this.setCells(sheetId, entries, 'Remove duplicates');
      // Duplicates' notes go first, before a kept row's note moves into one of their rows.
      for (const m of notes) if (!m.to) this.setNote(sheetId, m.from.r, m.from.c, null);
      this._moveNotes(sheetId, notes.filter((m) => m.to));
      permuteComments(this, sheetId, { ...n, r1: start }, 'row', new Map(kept.map((row, i) => [row.r, start + i])));
      // Inside a table the rows leave the table as well, which shrinks it. Kept as
      // data rows they stayed banded and counted by ROWS(T[#Data]) while holding nothing, and a row typed
      // into one got no calculated columns — nothing fills those for a row already inside the table.
      if (table) this.resizeTable(sheetId, table.id, { ...table.range, r2: table.range.r2 - removed });
      this._refilterRearranged(sheet, { r1: start, r2: n.r2 }, 'Remove duplicates');
    });
    return removed;
  }

  /* ---------- Go To Special ---------- */

  /**
   * The cells of one kind inside a range: 'blanks' | 'formulas' | 'constants'
   * | 'numbers' | 'text' | 'errors' | 'notes'. Blanks are looked for within
   * the used area only. Matching cells come back as rectangles (runs down
   * each column), at most `limit` of them.
   */
  specialCells(sheetId, range, kind, limit = 500, active = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    let rg = normalizeRange(range);
    const inside = (r, c) => r >= rg.r1 && r <= rg.r2 && c >= rg.c1 && c <= rg.c2;
    const found = [];
    const at = active || { r: rg.r1, c: rg.c1 };
    // The further Go To Special kinds, each a list of rectangles.
    if (kind === 'visible') {
      // The selection less its hidden rows and columns, as runs of visible lines crossed.
      const rows = Math.min(rg.r2, sheet.rows - 1), cols = Math.min(rg.c2, sheet.cols - 1);
      const runs = (from, to, hidden) => {
        const out = [];
        for (let i = from; i <= to; i++) {
          if (hidden(i)) continue;
          const last = out[out.length - 1];
          if (last && last[1] === i - 1) last[1] = i; else out.push([i, i]);
        }
        return out;
      };
      const rowRuns = runs(rg.r1, rows, (r) => sheet.hiddenRows.has(r) || sheet.filterHidden.has(r));
      const colRuns = runs(rg.c1, cols, (c) => sheet.hiddenCols.has(c));
      const out = [];
      for (const [c1, c2] of colRuns) for (const [r1, r2] of rowRuns) {
        if (out.length >= limit) { out.truncated = true; return out; }
        out.push({ r1, c1, r2, c2 });
      }
      return out;
    }
    if (kind === 'currentRegion') { const region = this.dataRegion(sheetId, at.r, at.c); return region ? [region] : []; }
    if (kind === 'lastCell') { const used = this.usedRange(sheetId); return used ? [{ r1: used.r2, c1: used.c2, r2: used.r2, c2: used.c2 }] : []; }
    if (kind === 'conditionalFormats' || kind === 'validation') {
      const list = kind === 'validation' ? sheet.validations : sheet.rules;
      const out = [];
      for (const item of list) {
        const cut = item.range && intersection(item.range, rg);
        if (cut && !out.some((x) => x.r1 === cut.r1 && x.c1 === cut.c1 && x.r2 === cut.r2 && x.c2 === cut.c2)) out.push(cut);
      }
      return out.slice(0, limit);
    }
    if (kind === 'precedents' || kind === 'dependents') {
      const cells = (kind === 'precedents' ? this.precedents(sheetId, at.r, at.c) : this.dependents(sheetId, at.r, at.c)).filter((x) => x.sheetId === sheetId);
      for (const { r, c } of cells) found.push({ r, c });
    } else if (kind === 'rowDiff' || kind === 'colDiff') {
      // Row differences: in each row, the cells whose contents differ from the cell in the active cell's column
      // (column differences: in each column, from the cell in the active cell's row), compared as their values show.
      const used = this.usedRange(sheetId);
      if (!used) return [];
      const r2 = Math.min(rg.r2, used.r2), c2 = Math.min(rg.c2, used.c2);
      if ((r2 - rg.r1 + 1) * (c2 - rg.c1 + 1) > 400000) return [];
      const content = (r, c) => { const cell = sheet.cells.get(cellKey(r, c)); return cell?.f != null ? `=${cell.f}` : this.getDisplay(sheetId, r, c); };
      for (let c = rg.c1; c <= c2; c++) {
        for (let r = rg.r1; r <= r2; r++) {
          const ref = kind === 'rowDiff' ? content(r, at.c) : content(at.r, c);
          if ((kind === 'rowDiff' ? c !== at.c : r !== at.r) && content(r, c) !== ref) found.push({ r, c });
        }
      }
    } else if (kind === 'blanks') {
      const used = this.usedRange(sheetId);
      if (!used) return [];
      rg = { r1: Math.max(rg.r1, used.r1), c1: Math.max(rg.c1, used.c1), r2: Math.min(rg.r2, used.r2), c2: Math.min(rg.c2, used.c2) };
      if (rg.r1 > rg.r2 || rg.c1 > rg.c2 || (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1) > 400000) return [];
      for (let c = rg.c1; c <= rg.c2; c++) {
        for (let r = rg.r1; r <= rg.r2; r++) {
          const cell = sheet.cells.get(cellKey(r, c));
          if ((!cell || (cell.v == null && cell.f == null)) && !this.spillAt(sheetId, r, c)) found.push({ r, c });
        }
      }
    } else if (kind === 'notes') {
      for (const key of sheet.notes.keys()) { const p = parseKey(key); if (inside(p.r, p.c)) found.push(p); }
    } else {
      for (const [key, cell] of sheet.cells) {
        if (cell.v == null && cell.f == null) continue;
        const p = parseKey(key);
        if (!inside(p.r, p.c)) continue;
        const formula = cell.f != null;
        let hit = false;
        if (kind === 'formulas') hit = formula;
        else if (kind === 'constants') hit = !formula;
        else if (kind === 'numbers') hit = !formula && typeof cell.v === 'number';
        else if (kind === 'text') hit = !formula && typeof cell.v === 'string';
        else if (kind === 'errors') hit = isError(this._compute(sheet, p.r, p.c));
        if (hit) found.push(p);
      }
    }
    // Column by column, consecutive rows fold into one rectangle.
    found.sort((a, b) => a.c - b.c || a.r - b.r);
    const out = [];
    for (const { r, c } of found) {
      const last = out[out.length - 1];
      if (last && last.c1 === c && last.r2 === r - 1) last.r2 = r;
      else {
        if (out.length >= limit) { out.truncated = true; break; } // so the caller can say the list stops short
        out.push({ r1: r, c1: c, r2: r, c2: c });
      }
    }
    return out;
  }

  /* ---------- What-if ---------- */

  /**
   * Goal seek: find the number for `variable` that makes the formula in
   * `target` evaluate to `goal`. Secant iterations with a widening step when
   * the formula is flat; the trial values never touch history, only the
   * answer is written (one undo step). Returns { ok, value, result,
   * iterations } or { ok: false, reason }.
   */
  goalSeek(sheetId, target, goal, variable, { maxIter = 200, tol = 1e-9 } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return { ok: false, reason: 'No such sheet' };
    if (this._gridLocked(sheet)) return { ok: false, reason: 'The sheet is protected' };
    if (this.lockedAt(sheetId, variable.r, variable.c)) return { ok: false, reason: 'The cell to change is protected' };
    const tKey = cellKey(target.r, target.c);
    const vKey = cellKey(variable.r, variable.c);
    const tCell = sheet.cells.get(tKey);
    if (!tCell || tCell.f == null) return { ok: false, reason: 'The cell to set must contain a formula' };
    if (tKey === vKey) return { ok: false, reason: 'Choose a different cell to change' };
    const vCell = sheet.cells.get(vKey);
    if (vCell && vCell.f != null) return { ok: false, reason: 'The cell to change must hold a number, not a formula' };
    // A blank cell showing part of a spilled result is not free to take a number: one would block the spill.
    if (vCell?.v == null && this.spillAt(sheetId, variable.r, variable.c)) return { ok: false, reason: 'The cell to change shows part of an array formula\'s result' };
    if (!Number.isFinite(goal)) return { ok: false, reason: 'Enter a number to reach' };
    const original = vCell ? cloneCell(vCell) : null;
    const start = typeof vCell?.v === 'number' ? vCell.v : 0;
    let met = false; // the goal is reached with the cell as it is: nothing to write, and a blank cell stays blank
    const f = (x) => {
      sheet.cells.set(vKey, { v: x, f: null, s: original?.s });
      this._invalidate();
      const v = this.getValue(sheetId, target.r, target.c);
      return typeof v === 'number' && Number.isFinite(v) ? v - goal : NaN;
    };
    const close = (d) => Math.abs(d) <= tol * Math.max(1, Math.abs(goal));
    let result = null;
    let iterations = 0;
    let x0 = start;
    let f0 = f(x0);
    if (Number.isNaN(f0)) {
      // A blank or text input may not compute: try from 1.
      x0 = 1; f0 = f(x0);
    }
    if (Number.isNaN(f0)) result = NaN;
    else if (close(f0)) { result = x0; met = x0 === start; }
    else {
      let x1 = x0 + (x0 === 0 ? 1 : Math.abs(x0) * 0.05);
      let f1 = f(x1);
      for (; iterations < maxIter; iterations++) {
        if (Number.isNaN(f1)) { x1 = (x0 + x1) / 2; f1 = f(x1); continue; }
        if (close(f1)) { result = x1; break; }
        const d = f1 - f0;
        if (d === 0) {
          const step = (x1 - x0) * 2 || 1;
          x0 = x1; f0 = f1; x1 += step; f1 = f(x1);
          continue;
        }
        const x2 = x1 - (f1 * (x1 - x0)) / d;
        if (!Number.isFinite(x2)) break;
        x0 = x1; f0 = f1; x1 = x2; f1 = f(x1);
      }
      if (result === null && !Number.isNaN(f1) && Math.abs(f1) <= 1e-6 * Math.max(1, Math.abs(goal))) result = x1;
    }
    let clean = result;
    if (Number.isFinite(result)) {
      const rounded = Number(result.toPrecision(12));
      // Cleaning the input can undo convergence for sensitive formulas (for
      // example A1-1e12). Keep it only if the formula still reaches the goal.
      if (Number.isFinite(rounded) && rounded !== result && close(f(rounded))) clean = rounded;
    }
    if (original) sheet.cells.set(vKey, original); else sheet.cells.delete(vKey);
    this._invalidate();
    if (result === null || Number.isNaN(result)) return { ok: false, reason: Number.isNaN(result) ? 'The formula does not produce a number' : 'Could not find a value that reaches the goal', iterations };
    if (met) return { ok: true, value: start, result: this.getValue(sheetId, target.r, target.c), iterations };
    this.setCells(sheetId, [{ r: variable.r, c: variable.c, cell: { v: clean, f: null, s: original?.s } }], 'Goal seek');
    return { ok: true, value: clean, result: this.getValue(sheetId, target.r, target.c), iterations };
  }

  /* ---------- Formula auditing ---------- */

  /**
   * The cells a formula reads directly: every reference and named range in
   * it, expanded to cells (whole rows and columns clipped to the used range).
   * Returns [{ sheetId, r, c }], capped at `limit`. Not for INDIRECT/OFFSET,
   * whose targets are only known at run time.
   */
  precedents(sheetId, r, c, limit = 5000) {
    const sheet = this.sheet(sheetId);
    const cell = sheet?.cells.get(cellKey(r, c));
    if (!cell || cell.f == null) return [];
    const out = [];
    const seen = new Set();
    const addRange = (target, ref) => {
      const used = this.usedRange(target.id) || { r1: 0, c1: 0, r2: -1, c2: -1 };
      const r1 = ref.kind === 'cols' ? 0 : ref.r1;
      const r2 = ref.kind === 'cols' ? Math.max(used.r2, r1) : Math.min(ref.r2, target.rows - 1);
      const c1 = ref.kind === 'rows' ? 0 : ref.c1;
      const c2 = ref.kind === 'rows' ? Math.max(used.c2, c1) : Math.min(ref.c2, target.cols - 1);
      for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) {
        if (out.length >= limit) return;
        if (rr === r && cc === c && target.id === sheetId) continue;
        const key = `${target.id}:${rr},${cc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sheetId: target.id, r: rr, c: cc });
      }
    };
    for (const { ref, name } of this._formulaRefs(cell.f, sheet.name, { r, c })) {
      const target = this.sheetByName(ref.sheet);
      if (target) addRange(target, ref);
      if (out.length >= limit) break;
      void name;
    }
    return out;
  }

  /**
   * The formulas, on any sheet, that read cell (r, c) of `sheetId` directly:
   * through a reference, a range that covers it, or a named range.
   */
  dependents(sheetId, r, c, limit = 5000) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const out = [];
    for (const s of this.sheets) {
      for (const [key, cell] of s.cells) {
        if (cell.f == null) continue;
        const pos = parseKey(key);
        if (s.id === sheetId && pos.r === r && pos.c === c) continue;
        const hit = this._formulaRefs(cell.f, s.name, pos).some(({ ref }) => {
          if (!sameSheetName(ref.sheet, sheet.name)) return false;
          return r >= ref.r1 && r <= ref.r2 && c >= ref.c1 && c <= ref.c2;
        });
        if (hit) {
          out.push({ sheetId: s.id, r: pos.r, c: pos.c });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  /**
   * Every reference in a formula, with named ranges and structured references
   * resolved and sheet names filled in. `owner` is the formula's own cell,
   * which a [@Column] reference is read from.
   */
  _formulaRefs(formula, ownerSheet, owner = null) {
    let tokens;
    try { tokens = tokenize(formula); } catch { return []; }
    const out = [];
    for (const t of tokens) {
      if (t.type === 'ref') {
        const ref = parseRefText(t.text, t.sheet);
        if (!ref) continue;
        // A 3D span reads the cells on every sheet it covers.
        const sheetNames = t.sheetEnd ? this.sheetsBetween(t.sheet, t.sheetEnd) || [] : [ref.sheet ?? ownerSheet];
        for (const sheetName of sheetNames) {
          // A1# reads the whole spill of A1.
          const spill = t.spill ? this.spillRangeAt(this.sheetByName(sheetName)?.id, ref.r1, ref.c1) : null;
          out.push({ ref: spill ? { ...ref, kind: 'range', ...spill, sheet: sheetName } : { ...ref, sheet: sheetName } });
        }
      } else if (t.type === 'name') {
        const named = this.namedRef(t.value, t.sheet ?? ownerSheet, owner || { r: 0, c: 0 }); // as the formula's own sheet resolves it
        if (named) out.push({ ref: { kind: 'range', ...named }, name: t.value });
      } else if (t.type === 'tref') {
        // Table1[Column] reads the column's cells, [@Column] the one on the formula's own row; a table or
        // column that is not there reads nothing, as a [@Column] outside any table does.
        const sheet = this.sheetByName(ownerSheet);
        const ref = sheet ? this._resolveTableRef(sheet, owner || { r: -1, c: -1 }, t.table, t.spec) : null;
        if (ref && !isError(ref)) out.push({ ref });
      }
    }
    return out;
  }

  /* ---------- Structure ---------- */

  /** Insert rows above `at`. False when the sheet is protected or content would leave the grid. */
  insertRows(sheetId, at, n = 1) {
    const sheet = this.sheet(sheetId);
    // Rows inserted right above a table's totals row join its data (Add table row and Tab from the last
    // cell insert them there too): the table's filter, which ends at the last data row and would otherwise
    // stop short of them, takes them in, and the charts, conditional formats and validation rules that
    // ended at that row grow over them, as they do when a table without a totals row grows.
    const tables = sheet?.tables.filter(t => t.totalsRow && t.range.r2 === at) || [];
    if (!tables.length) return this._insert(sheetId, 'row', at, n);
    let inserted = false;
    this.transaction('Insert rows', () => {
      inserted = this._insert(sheetId, 'row', at, n);
      if (!inserted) return;
      const live = this.sheet(sheetId);
      const show = Array.from({ length: n }, (_, i) => at + i);
      for (const table of tables) {
        const filter = sheetFilters(live).find(f => f.range.r1 === table.range.r1 && f.range.c1 === table.range.c1 && f.range.c2 === table.range.c2);
        if (filter) this._setFilter(live, { ...filter, range: { ...filter.range, r2: at - 1 + n } }, 'Insert rows', { show, target: filter });
        this._growTableDependents(live, table, at - 1, at - 1 + n, 'Insert rows');
      }
    });
    return inserted;
  }

  insertCols(sheetId, at, n = 1) {
    return this._insert(sheetId, 'col', at, n);
  }

  deleteRows(sheetId, at, n = 1) {
    if (n >= 1) this._deleteLines(sheetId, 'row', [{ from: at, to: at + n - 1 }]);
  }

  deleteCols(sheetId, at, n = 1) {
    if (n >= 1) this._deleteLines(sheetId, 'col', [{ from: at, to: at + n - 1 }]);
  }

  /**
   * Delete several stretches of rows (axis 'row') or columns at once: runs =
   * [{ from, to }] in any order, touching or overlapping ones taken together.
   * Every cell, formula and range is renumbered in one pass and the deletion
   * is one undo step, however many runs there are, so deleting the shown rows
   * of a filtered list costs what deleting them unfiltered would. Returns true
   * when lines were deleted; a protected line refuses the whole deletion.
   * `label` names the undo step after the tool that asked, when one did.
   */
  deleteLines(sheetId, axis, runs, label = null) {
    return this._deleteLines(sheetId, axis, runs, label);
  }

  /**
   * Insert blank cells over `range`, pushing what was there (and everything
   * after it in those columns, or rows) down or right
   * (Insert cells). Formulas that point into the shifted band follow it
   * and ranges spanning the insertion point grow; references outside the
   * band are untouched. One undo step. Returns true when cells were shifted.
   */
  insertCells(sheetId, range, direction = 'down', paste = null) {
    return this._shiftBlock(sheetId, range, direction === 'right' ? 'col' : 'row', false, paste);
  }

  /**
   * Delete the cells in `range`, pulling the cells below (or to the right)
   * into their place. Formulas that pointed at the deleted cells show #REF!;
   * those pointing further down the band move up with their cells.
   */
  deleteCells(sheetId, range, direction = 'up') {
    return this._shiftBlock(sheetId, range, direction === 'left' ? 'col' : 'row', true);
  }

  _shiftBlock(sheetId, range, axis, remove, paste = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return false;
    const rg = normalizeRange(range);
    if (!validStoredRange(rg)) return false;
    if (this.pivotBlockEditBlocked(sheetId, rg, axis, remove)) return false;
    // The removed cells are gone for good; protected ones stay put instead.
    if (remove && this.lockedIn(sheetId, rg)) return false;
    const at = axis === 'row' ? rg.r1 : rg.c1;
    const n = axis === 'row' ? rg.r2 - rg.r1 + 1 : rg.c2 - rg.c1 + 1;
    // The band: the columns (or rows) the shift runs along.
    const b1 = axis === 'row' ? rg.c1 : rg.r1;
    const b2 = axis === 'row' ? rg.c2 : rg.r2;
    const inBand = (r, c) => (axis === 'row' ? c >= b1 && c <= b2 : r >= b1 && r <= b2);
    const lo = axis === 'row' ? 'r1' : 'c1';
    const hi = axis === 'row' ? 'r2' : 'c2';
    const olo = axis === 'row' ? 'c1' : 'r1';
    const ohi = axis === 'row' ? 'c2' : 'r2';
    const insideBand = (m) => m[olo] >= b1 && m[ohi] <= b2;
    const touchesBand = (m) => !(m[ohi] < b1 || m[olo] > b2) && m[hi] >= at;
    for (const a of this._fixedArrays(sheet).ranges) {
      if (!touchesBand(a)) continue;
      const partial = !insideBand(a) || (!remove && a[lo] < at)
        || (remove && a[lo] < at + n && !(at <= a[lo] && at + n > a[hi]));
      const beyond = !remove && a[hi] + n > (axis === 'row' ? MAX_ROW : MAX_COL);
      if (partial || beyond) { this._arrayRefused(sheet, a, beyond ? 'bounds' : 'partial'); return false; }
    }
    for (const { range: m } of sheet.tables) {
      if (!touchesBand(m)) continue;
      // A table must stay rectangular and keep its header unless the
      // operation removes the entire table.
      if (!insideBand(m) || (remove && axis === 'row' && at <= m.r1 && at + n > m.r1 && at + n <= m.r2)) return false;
    }
    // A merged block half inside the band cannot be shifted in part; the insert is refused rather than unmerging it unasked.
    for (const m of sheet.merges) {
      if (touchesBand(m) && !insideBand(m)) return false;
    }
    // Nor can a protected range: left at its address while its cells slid, it would lock other cells' values and free its own.
    for (const p of sheet.protectedRanges) {
      if (touchesBand(p.range) && !insideBand(p.range)) return false;
    }
    const limit = axis === 'row' ? MAX_ROW : MAX_COL;
    const adjust = (m) => {
      const out = { ...m };
      if (remove) {
        out[lo] = m[lo] >= at + n ? m[lo] - n : m[lo] >= at ? at : m[lo];
        out[hi] = m[hi] >= at + n ? m[hi] - n : m[hi] >= at ? at - 1 : m[hi];
      } else if (m[lo] >= at) { out[lo] += n; out[hi] += n; } else if (m[hi] >= at) out[hi] += n;
      // A range that already reached the sheet's last line stays anchored there instead of running past the grid.
      if (!remove) { if (out[hi] > limit) out[hi] = limit; if (out[lo] > limit) out[lo] = limit; }
      return out;
    };
    // Insert copied merges only after validating the layout the insertion
    // would produce. A table or growing merge must not cause a refused paste
    // after the existing cells have already shifted.
    if (!remove && paste?.merges?.length) {
      const incoming = mapPasteMerges(paste.merges, rg.r2 - rg.r1 + 1, rg.c2 - rg.c1 + 1,
        rg.r1, rg.c1, { rows: 1, cols: 1 }, false, { rows: MAX_ROW + 1, cols: MAX_COL + 1 });
      if (!incoming) { this._emit('merge-paste', sheetId, { reason: 'invalid' }); return false; }
      const futureMerges = sheet.merges.map(m => insideBand(m) ? adjust(m) : m);
      const plan = planPasteMerges(futureMerges, incoming);
      if (plan.error || plan.displacedAnchor) {
        this._emit('merge-paste', sheetId, { reason: 'overlap' }); return false;
      }
      for (const table of sheet.tables) {
        const moved = { ...table, range: insideBand(table.range) ? adjust(table.range) : table.range };
        if (incoming.some(m => intersection(m, { ...moved.range, r2: tableRows(moved).dataEnd }))) {
          this._emit('merge-paste', sheetId, { reason: 'table' }); return false;
        }
      }
      for (let r = 0; r < (paste.cells?.length || 0); r++) for (let c = 0; c < paste.cells[r].length; c++) {
        const size = fixedArraySize(paste.cells[r][c]?.array);
        const area = size && { r1: rg.r1 + r, c1: rg.c1 + c, r2: rg.r1 + r + size.rows - 1, c2: rg.c1 + c + size.cols - 1 };
        if (area && incoming.some(m => intersection(m, area))) { this._arrayRefused(sheet, area, 'overlap'); return false; }
      }
    }
    // Where a line index lands after the shift; null when it is deleted.
    const moveIndex = (i) => {
      if (remove) return i >= at + n ? i - n : i >= at ? null : i;
      return i >= at ? i + n : i;
    };
    let extent = rg[hi];
    if (!remove) {
      // Cells shifted into a protected range grow it over blank cells nobody may then fill, breaking up
      // the block someone locked: refuse and say so, as deleting cells out of one is refused. A range the
      // shift only moves whole, or one already reaching the sheet's last line, is left as it was.
      const locked = sheet.protectedRanges.find((p) => insideBand(p.range) && p.range[lo] < at && p.range[hi] >= at
        && Math.min(p.range[hi] + n, limit) > p.range[hi]);
      if (locked) { this._emit('protected', sheet.id, { range: locked.range, description: locked.description }); return false; }
      // Explicit insertion can grow past the scrolling cap. Include notes
      // and blank metadata ranges so all moved content stays accessible.
      const includePoint = (r, c) => {
        const i = axis === 'row' ? r : c;
        if (inBand(r, c) && i >= at) extent = Math.max(extent, i + n);
      };
      // A metadata range that already ends at the sheet's last line (a whole-column rule, validation or
      // protected range) stays anchored there, as Insert rows keeps it, rather than counting as content
      // the shift would push off the sheet and refusing the whole edit.
      const includeRange = (m) => {
        if (insideBand(m) && m[hi] >= at && m[hi] < limit) extent = Math.max(extent, m[hi] + n);
      };
      for (const entries of [sheet.cells, sheet.notes, sheet.comments]) for (const key of entries.keys()) {
        const { r, c } = parseKey(key);
        includePoint(r, c);
      }
      for (const group of sheet.sparklineGroups) for (const spark of group.sparklines) { const ref = parseRefText(spark.ref); includePoint(ref.r1, ref.c1); }
      for (const m of sheet.merges) includeRange(m);
      for (const entries of [sheet.protectedRanges, sheet.tables]) {
        for (const item of entries) includeRange(item.range);
      }
      for (const entries of [sheet.rules, sheet.validations]) for (const { range } of entries) {
        if (touchesBand(range) && range[hi] < limit) extent = Math.max(extent, range[hi] + n);
      }
      for (const { range } of sheet.styleResets) {
        if (touchesBand(range) && range[hi] >= at && (range[lo] > 0 || range[hi] < limit)) extent = Math.max(extent, range[hi] + n);
      }
      for (const f of sheetFilters(sheet)) includeRange(f.range);
      for (const ch of sheet.charts) { includePoint(ch.anchor.r, ch.anchor.c); includeRange(ch.range); }
      if (extent > limit) return false;
    }
    const label = remove ? 'Delete cells' : 'Insert cells';
    this._structural(label, () => {
      if (remove) this._removeNativePivots((this.nativePivots?.tables || []).filter(p => {
        const ref = p.owner === sheetId && parseRefText(p.ref || '');
        return ref && insideBand(ref) && !adjustRefForDelete(ref, axis, at, n);
      }), label, true);
      const band = axis === 'row' ? { ...GRID_RANGE, c1: b1, c2: b2 } : { ...GRID_RANGE, r1: b1, r2: b2 };
      sheet.styleResets = shiftStyleResets(sheet.styleResets, axis, at, n, remove, band);
      sheet.ignoredErrors = shiftRangeFlags(sheet.ignoredErrors, axis, at, n, remove, band);
      for (const s of this.sheets) {
        const options = { ownerSheet: s.name, sheetName: sheet.name, axis, at, count: n, remove, bandStart: b1, bandEnd: b2,
          sheetsBetween: (a, b) => this.sheetsBetween(a, b), newId };
        s.rules = adjustBlockRules(s.rules, 'value', options);
        s.validations = adjustBlockRules(s.validations, 'source', options);
        mapSheetFilters(s, f => adjustFilterForEdit(f, options));
        if (!sheetFilters(s).length) s.filterHidden = new Set();
      }
      const moved = new Map();
      for (const [key, cell] of sheet.cells) {
        const { r, c } = parseKey(key);
        if (!inBand(r, c)) { moved.set(key, cell); continue; }
        const i = moveIndex(axis === 'row' ? r : c);
        if (i == null) continue;
        moved.set(axis === 'row' ? cellKey(i, c) : cellKey(r, i), cell);
      }
      sheet.cells = moved;
      const movedNotes = new Map();
      for (const [key, text] of sheet.notes) {
        const { r, c } = parseKey(key);
        if (!inBand(r, c)) { movedNotes.set(key, text); continue; }
        const i = moveIndex(axis === 'row' ? r : c);
        if (i == null) continue;
        movedNotes.set(axis === 'row' ? cellKey(i, c) : cellKey(r, i), text);
      }
      sheet.notes = movedNotes;
      sheet.comments = remapComments(sheet.comments, (r, c) => {
        if (!inBand(r, c)) return { r, c };
        const i = moveIndex(axis === 'row' ? r : c);
        return i == null ? null : axis === 'row' ? { r: i, c } : { r, c: i };
      });
      sheet.sparklineGroups = mapNativeSparklineDestinations(sheet.sparklineGroups, ref => {
        if (!inBand(ref.r1, ref.c1)) return ref;
        const index = moveIndex(axis === 'row' ? ref.r1 : ref.c1);
        return index == null ? null : { ...ref, ...(axis === 'row' ? { r1: index, r2: index } : { c1: index, c2: index }) };
      });
      // Merges wholly inside the band move with it (a straddling one was refused above).
      sheet.merges = sheet.merges
        .filter((m) => insideBand(m) || !touchesBand(m))
        .map((m) => (insideBand(m) ? adjust(m) : m))
        .filter((m) => m[hi] >= m[lo] && (m.r1 !== m.r2 || m.c1 !== m.c2));
      sheet.protectedRanges = sheet.protectedRanges.map((p) => (insideBand(p.range) ? { ...p, range: adjust(p.range) } : p)).filter((p) => p.range[hi] >= p.range[lo]);
      mapScenarioCells(sheet, (m) => (insideBand(m) ? adjust(m) : m));
      sheet.tables = sheet.tables.map((t) => {
        if (!touchesBand(t.range)) return t;
        const range = adjust(t.range);
        if (range.r2 < range.r1 || range.c2 < range.c1) return null;
        const origin = t.calcRow ?? tableRows(t).dataStart;
        const offset = remove && axis === 'row' && origin >= at && origin < at + n ? at + n - origin : 0;
        const calc = axis === 'col' ? shiftCalc(t.calc, t.range.c1, at, n, remove)
          : Object.fromEntries(Object.entries(t.calc || {}).map(([c, f]) => [c, offset ? shiftFormula(f, offset, 0) : f]));
        const totalsDeleted = remove && axis === 'row' && t.range.r2 >= at && t.range.r2 < at + n;
        return { ...t, range, calc, totalsRow: t.totalsRow && !totalsDeleted,
          ...(axis === 'col' && t.calcArray ? { calcArray: shiftCalc(t.calcArray, t.range.c1, at, n, remove) } : {}),
          ...(axis === 'row' ? { calcRow: moveIndex(origin) ?? at } : {}) };
      }).filter(Boolean);
      sheet.charts = sheet.charts.map((ch) => {
        const anchor = { ...ch.anchor };
        if (ch.anchorMode !== 'absolute' && inBand(anchor.r, anchor.c)) {
          const a = axis === 'row' ? anchor.r : anchor.c;
          const i = remove ? (a >= at + n ? a - n : a >= at ? at : a) : moveIndex(a);
          if (axis === 'row') anchor.r = i; else anchor.c = i;
        }
        let rangeOut = ch.range;
        if (insideBand(ch.range)) { rangeOut = adjust(ch.range); if (rangeOut[hi] < rangeOut[lo]) rangeOut[hi] = rangeOut[lo]; }
        return { ...ch, range: rangeOut, anchor, ...mapCellDrawing(ch, p => {
          if (inBand(p.r, p.c)) { const key = axis === 'row' ? 'r' : 'c', a = p[key];
            if (remove && a >= at && a < at + n) p[axis === 'row' ? 'dy' : 'dx'] = 0;
            p[key] = remove ? (a >= at + n ? a - n : a >= at ? at : a) : Math.min(axis === 'row' ? MAX_ROW : MAX_COL, moveIndex(a)); } return p;
        }) };
      });
      if (!remove) {
        if (axis === 'row') sheet.rows = Math.max(sheet.rows, extent + 1);
        else sheet.cols = Math.max(sheet.cols, extent + 1);
      }
      // Only references that lie within the band follow the shift.
      this.nativePivots = mapNativePivotRanges(this.nativePivots, sheetId, ref => insideBand(ref)
        ? remove ? adjustRefForDelete(ref, axis, at, n) : adjustRefForInsert(ref, axis, at, n) : ref);
      const follow = (formula, ownerSheet) => mapFormulaRefs(formula, (ref) => {
        const target = ref.sheet ?? ownerSheet;
        if (!sameSheetName(target, sheet.name)) return ref;
        if (ref.kind === 'cols' || ref.kind === 'rows') return ref;
        if (!insideBand(ref)) return ref;
        return remove ? adjustRefForDelete(ref, axis, at, n) : adjustRefForInsert(ref, axis, at, n);
      });
      for (const s of this.sheets) {
        s.sparklineGroups = mapNativeSparklineReferences(s.sparklineGroups, f => follow(f, s.name));
        for (const cell of s.cells.values()) {
          if (cell.f == null) continue;
          cell.f = follow(cell.f, s.name);
        }
        s.tables = s.tables.map((t) => !t.calc ? t : { ...t, calc: Object.fromEntries(
          Object.entries(t.calc).map(([c, f]) => [c, follow(f, s.name)]),
        ) });
      }
      this.names = this.names.map((nm) => ({ ...nm, ref: follow(nm.ref, nm.sheet || null) }));
      // A row inserted among a table's data rows by shifting its cells down is a new table row, and
      // gets the calculated columns as one inserted with the row tools does. The templates were
      // adjusted above, so the shift is not applied to the fresh formulas a second time.
      if (!remove && axis === 'row') {
        for (const t of sheet.tables) {
          if (!(t.range.r1 < at && at + n - 1 <= tableRows(t).dataEnd)) continue;
          for (let r = at; r < at + n; r++) for (const { r: rr, c, cell } of this._calculatedRowEntries(sheet, t, r)) sheet.cells.set(cellKey(rr, c), cell);
        }
      }
      this._refreshFilters(this.sheets);
    });
    return true;
  }

  /** Inspect the persisted native report layout; this does not refresh it. */
  async inspectPivotLayout(name, sheetId = null) {
    const matches = (this.nativePivots?.tables || []).filter(p => sheetKey(p.name) === sheetKey(name) && (sheetId == null || p.owner === sheetId));
    if (matches.length !== 1) throw new Error('Missing or ambiguous native PivotTable');
    const pivot = matches[0], cache = this.nativePivots.caches.find(c => c.key === pivot.cache);
    if (!cache) throw new Error('Missing native pivot cache');
    return (await import('./native-pivot-layout.js')).readNativePivotLayout(pivot, cache);
  }

  /** Calculate a declared measure from its linked worksheet source, or its
   * saved model snapshot with { source: 'stored' }. Pivot
   * refresh and native model serialization are separate operations. */
  async evaluateModelMeasure(table, measure, options = {}) {
    return (await import('./data-model-evaluate.js')).evaluateDataModelMeasure(this, table, measure, options);
  }

  /** Rebuild linked model tables and their connected native reports atomically.
   * New string domains currently require explicit per-table/column sort keys;
   * unsupported model dependencies fail before any stored state is changed. */
  async refreshDataModel(options = {}) {
    return (await import('./data-model-refresh.js')).refreshLinkedModelReports(this, options);
  }

  pivotMoveEditBlocked(sourceId, src, targetId, dst) {
    let conflict = pivotMoveConflict(this.nativePivots, sourceId, src, targetId, dst);
    if (!conflict) for (const pivot of this.nativePivots?.tables || []) {
      if (pivot.owner !== sourceId) continue;
      const range = parseRefText(pivot.ref || '');
      if (!range || range.r1 < src.r1 || range.r2 > src.r2 || range.c1 < src.c1 || range.c2 > src.c2) continue;
      const dr = dst.r1 - src.r1, dc = dst.c1 - src.c1;
      if (this.sheet(targetId).tables.some(t => t.range.r1 <= range.r2 + dr && t.range.r2 >= range.r1 + dr
        && t.range.c1 <= range.c2 + dc && t.range.c2 >= range.c1 + dc)) {
        conflict = { pivot, range, reason: 'table-overlap' }; break;
      }
    }
    if (!conflict) return false;
    this._emit('pivot-edit', targetId, { name: conflict.pivot.name, range: conflict.range, reason: conflict.reason });
    return true;
  }

  _setDependentCharts(sheet, next, label, structural = false) {
    // A dependency update follows an authorized source edit, including when
    // the chart's own sheet is protected. Structural capture owns its undo.
    if (structural) { sheet.charts = next; return; }
    const previous = sheet.charts;
    const apply = list => { const live = this.sheet(sheet.id) || sheet; live.charts = list; this._changed('layout', live.id); };
    apply(next);
    this._push({ label, undo: () => apply(previous), redo: () => apply(next) });
  }

  _removeNativePivots(removed, label, structural = false) {
    if (!removed.length) return;
    const previous = this.nativePivots, ids = new Set(removed);
    const tables = previous.tables.filter(p => !ids.has(p));
    const next = { ...previous, tables, ...mapNativePivotSlicerConnections(previous, tables) };
    // Snapshot a dependent chart before clearing its source cells. Other
    // reports sharing the cache, including chart-only pivots, remain live.
    for (const sheet of this.sheets) {
      let changed = false;
      const charts = sheet.charts.map(chart => {
        if (!chart.pivotSource || chart.pivotSource.standalone || !removed.some(p =>
          pivotChartQualifier(chart.pivotSource.name, this.sheet(p.owner)?.name || '', p.name))) return chart;
        changed = true;
        return { ...snapshotChartData(this, sheet.id, chart), pivotSource: undefined };
      });
      if (changed) this._setDependentCharts(sheet, charts, label, structural);
    }
    if (structural) { this.nativePivots = next; return; }
    const apply = value => { this.nativePivots = value; this._changed('pivots'); };
    apply(next);
    this._push({ label, undo: () => apply(previous), redo: () => apply(next) });
  }

  _moveNativePivots(sourceId, src, targetId, dst) {
    const previous = this.nativePivots, next = moveNativePivotRanges(previous, sourceId, src, targetId, dst);
    if (previous === next) return;
    const apply = value => { this.nativePivots = value; this._changed('pivots', targetId); };
    apply(next);
    this._push({ label: 'Move cells', undo: () => apply(previous), redo: () => apply(next) });
    if (sourceId === targetId) return;
    const oldSheet = this.sheet(sourceId).name, newSheet = this.sheet(targetId).name;
    const moved = previous.tables.filter((p, i) => p.owner === sourceId && next.tables[i].owner === targetId);
    for (const sheet of this.sheets) {
      let changed = false;
      const charts = sheet.charts.map(chart => {
        const next = renamePivotChartSheet(chart, moved, oldSheet, newSheet);
        if (next !== chart) changed = true;
        return next;
      });
      if (changed) this._setDependentCharts(sheet, charts, 'Move cells');
    }
  }

  /** Native report space is occupied even where cached worksheet cells are empty. */
  nativePivotOverlap(sheetId, area) {
    for (const pivot of this.nativePivots?.tables || []) {
      if (pivot.owner !== sheetId) continue;
      const range = parseRefText(pivot.ref);
      if (range && intersection(area, range)) return { pivot, range };
    }
    return null;
  }

  /** Whether an explicit table row needs insertion rather than reusing empty cells. */
  tableRowOccupied(sheetId, area, excludeTableId = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this.nativePivotOverlap(sheetId, area)
      || sheet.tables.some(t => t.id !== excludeTableId && intersection(t.range, area))
      || sheet.merges.some(m => intersection(m, area))
      || this._fixedArrays(sheet).overlapping(area).next().value) return true;
    for (let c = area.c1; c <= area.c2; c++) {
      const key = cellKey(area.r1, c);
      if (sheet.cells.has(key) || sheet.notes.has(key) || sheet.comments.has(key)) return true;
    }
    return false;
  }

  _tablePivotEditBlocked(sheetId, area) {
    const conflict = this.nativePivotOverlap(sheetId, area);
    if (!conflict) return false;
    this._emit('pivot-edit', sheetId, { name: conflict.pivot.name, range: conflict.range, reason: 'table-overlap' });
    return true;
  }

  pivotBlockEditBlocked(sheetId, block, axis, remove) {
    const conflict = pivotBlockConflict(this.nativePivots, sheetId, normalizeRange(block), axis, remove);
    if (!conflict) return false;
    this._emit('pivot-edit', sheetId, { name: conflict.pivot.name, range: conflict.range, reason: conflict.reason });
    return true;
  }

  pivotLineEditBlocked(sheetId, axis, at, n, lines = null) {
    const conflict = pivotLineConflict(this.nativePivots, sheetId, axis, at, n, lines);
    if (!conflict) return false;
    this._emit('pivot-edit', sheetId, { name: conflict.pivot.name, range: conflict.range, reason: conflict.reason });
    return true;
  }

  _insert(sheetId, axis, at, n) {
    const sheet = this.sheet(sheetId);
    if (!sheet || n < 1) return false;
    if (this._gridLocked(sheet)) return false;
    // Content pushed past the last line would be lost: refuse. Ranges that
    // already reach the edge (a whole-column rule or protected range) stay anchored there.
    const limit = axis === 'row' ? MAX_ROW : MAX_COL;
    if (at > limit) return false;
    if (this.pivotLineEditBlocked(sheetId, axis, at, n)) return false;
    const hi = axis === 'row' ? 'r2' : 'c2';
    const lo = axis === 'row' ? 'r1' : 'c1';
    for (const a of this._fixedArrays(sheet).ranges) {
      if (a[lo] < at && a[hi] >= at) { this._arrayRefused(sheet, a); return false; }
      if (a[hi] >= at && a[hi] + n > limit) { this._arrayRefused(sheet, a, 'bounds'); return false; }
    }
    // A line inserted inside a protected range grows the range over a blank line nobody may then fill,
    // breaking up the block someone locked: refuse and say so, as deleting a protected line is refused
    // (_deleteLines). A line added at the range's first line, above it or below it only moves it, and one
    // added inside a range that already reaches the sheet's last line (a whole protected column) leaves
    // its extent where it was; neither changes what the range protects, so neither is refused.
    const locked = sheet.protectedRanges.find((p) => p.range[lo] < at && p.range[hi] >= at
      && Math.min(p.range[hi] + n, limit) > p.range[hi]);
    if (locked) { this._emit('protected', sheet.id, { range: locked.range, description: locked.description }); return false; }
    let extent = -1;
    const includeIndex = (i) => { if (i >= at) extent = Math.max(extent, i + n); };
    for (const entries of [sheet.cells, sheet.notes, sheet.comments]) for (const key of entries.keys()) {
      const { r, c } = parseKey(key);
      includeIndex(axis === 'row' ? r : c);
    }
    for (const m of sheet.merges) includeIndex(m[hi]);
    for (const a of this._fixedArrays(sheet).ranges) includeIndex(a[hi]);
    // Finite cleared blocks are formatting content; only a whole-line exception stays anchored at the edge.
    for (const { range } of sheet.styleResets) if (range[lo] > 0 || range[hi] < limit) includeIndex(range[hi]);
    for (const group of sheet.sparklineGroups) for (const spark of group.sparklines) includeIndex(parseRefText(spark.ref)[hi]);
    for (const ch of sheet.charts) includeIndex(axis === 'row' ? ch.anchor.r : ch.anchor.c);
    if (extent > limit) return false;
    const clamp = (range) => (range[hi] > limit ? { ...range, [hi]: limit } : range);
    this._structural(axis === 'row' ? 'Insert rows' : 'Insert columns', () => {
      this.nativePivots = mapNativePivotRanges(this.nativePivots, sheetId, ref => adjustRefForInsert(ref, axis, at, n));
      this._adjustLineRules(sheet.name, axis, at, n, false);
      // The line before the new ones lends them its formatting (from above, or from
      // the left): the style alone, never a value, formula or note. A table's header row
      // keeps its look to itself (it is the table's), as do the cells of a merged block.
      const lends = (r, c) => !(axis === 'row' && sheet.tables.some((t) => tableRows(t).header === r && c >= t.range.c1 && c <= t.range.c2))
        && !sheet.merges.some((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
      const previous = axis === 'row' ? { ...GRID_RANGE, r1: at - 1, r2: at - 1 } : { ...GRID_RANGE, c1: at - 1, c2: at - 1 };
      let inherited = sheet.styleResets.flatMap((record) => {
        const range = intersection(record.range, previous);
        return range ? [{ ...record, range }] : [];
      });
      for (const m of sheet.merges) inherited = removeStyleResets(inherited, m);
      if (axis === 'row') for (const t of sheet.tables) if (t.headerRow !== false) inherited = removeStyleResets(inherited, { ...t.range, r2: t.range.r1 });
      if (inherited.length) sheet.styleResets = compactStyleResets([...sheet.styleResets,
        ...inherited.map((record) => ({ ...record, range: { ...record.range, [lo]: at, [hi]: at + n - 1 } }))]);
      const lent = [];
      const moved = new Map();
      for (const [key, cell] of sheet.cells) {
        const { r, c } = parseKey(key);
        const rr = axis === 'row' && r >= at ? r + n : r;
        const cc = axis === 'col' && c >= at ? c + n : c;
        moved.set(cellKey(rr, cc), cell);
        if ((axis === 'row' ? r : c) === at - 1 && cell.s && Object.keys(cell.s).length && lends(r, c)) lent.push({ r, c, s: cell.s });
      }
      for (const { r, c, s } of lent) {
        for (let i = at; i < at + n && i <= limit; i++) moved.set(cellKey(axis === 'row' ? i : r, axis === 'row' ? c : i), { v: null, f: null, s: { ...s } });
      }
      sheet.cells = moved;
      const movedNotes = new Map();
      for (const [key, text] of sheet.notes) {
        const { r, c } = parseKey(key);
        movedNotes.set(cellKey(axis === 'row' && r >= at ? r + n : r, axis === 'col' && c >= at ? c + n : c), text);
      }
      sheet.notes = movedNotes;
      sheet.comments = remapComments(sheet.comments, (r, c) => ({ r: axis === 'row' && r >= at ? r + n : r, c: axis === 'col' && c >= at ? c + n : c }));
      const sizes = axis === 'row' ? sheet.rowHeights : sheet.colWidths;
      const shifted = new Map();
      for (const [i, size] of sizes) shifted.set(i >= at ? i + n : i, size);
      // A whole line's own format follows it, as its size does; the new lines start without one.
      const lineStyles = axis === 'row' ? sheet.rowStyles : sheet.colStyles;
      const shiftedStyles = new Map();
      for (const [i, st] of lineStyles) if (i + (i >= at ? n : 0) <= limit) shiftedStyles.set(i >= at ? i + n : i, st);
      if (axis === 'row') sheet.rowStyles = shiftedStyles; else sheet.colStyles = shiftedStyles;
      const hidden = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
      const lastLine = axis === 'row' ? MAX_ROW : MAX_COL;
      // Lines pushed past the grid's last one are gone; the grid never grows past A1:XFD1048576.
      const shiftedHidden = new Set([...hidden].map((i) => (i >= at ? i + n : i)).filter((i) => i <= lastLine));
      const groupKey = axis === 'row' ? 'rows' : 'cols';
      // Lines inserted inside a collapsed group join it hidden like the rest of it, rather than showing
      // through a group whose button says it is closed; lines at its first line move it down instead.
      if (sheet.groups[groupKey].some((g) => g.collapsed && g.from < at && g.to >= at)) for (let i = at; i < at + n; i++) shiftedHidden.add(i);
      const grow = (m) => {
        const out = { ...m };
        if (m[lo] >= at) { out[lo] += n; out[hi] += n; } else if (m[hi] >= at) out[hi] += n;
        return out;
      };
      sheet.merges = sheet.merges.map(grow);
      mapPrintAreas(sheet, m => clamp(grow(m)), axis);
      sheet.protectedRanges = sheet.protectedRanges.map((p) => ({ ...p, range: clamp(grow(p.range)) }));
      mapScenarioCells(sheet, (m) => clamp(grow(m)));
      sheet.groups[groupKey] = sheet.groups[groupKey].map((g) => {
        const out = { ...g };
        if (g.from >= at) { out.from += n; out.to += n; } else if (g.to >= at) out.to += n;
        return out;
      });
      sheet.charts = sheet.charts.map((ch) => {
        const anchor = { ...ch.anchor };
        if (ch.anchorMode !== 'absolute') {
          if (axis === 'row' && anchor.r >= at) anchor.r += n;
          if (axis === 'col' && anchor.c >= at) anchor.c += n;
        }
        return { ...ch, range: clamp(grow(ch.range)), anchor, ...mapCellDrawing(ch, p => {
          const key = axis === 'row' ? 'r' : 'c'; if (p[key] >= at) p[key] = Math.min(axis === 'row' ? MAX_ROW : MAX_COL, p[key] + n); return p;
        }) };
      });
      // A table grows when lines land inside it, but not when they are added right below its last row.
      sheet.tables = sheet.tables.map((t) => {
        const origin = t.calcRow ?? tableRows(t).dataStart;
        return { ...t, range: clamp(grow(t.range)), calc: axis === 'col' ? shiftCalc(t.calc, t.range.c1, at, n, false) : t.calc,
          ...(axis === 'col' && t.calcArray ? { calcArray: shiftCalc(t.calcArray, t.range.c1, at, n, false) } : {}),
          ...(axis === 'row' ? { calcRow: origin >= at ? origin + n : origin } : {}) };
      });
      // Columns inserted inside a table get header names of their own, so no two columns share one.
      if (axis === 'col') {
        for (const t of sheet.tables) {
          if (!(t.range.c1 < at && at + n - 1 <= t.range.c2)) continue;
          this._invalidate(); // header displays are read at their moved positions
          const others = this.tableColumns(sheet.id, t).filter((_, i) => t.range.c1 + i < at || t.range.c1 + i >= at + n);
          // A table whose Header Row is off keeps its names on itself: the new columns are named there.
          if (t.headerRow === false) { headerlessInsertColumns(t, at - t.range.c1, n, (taken, i) => this._freeColumnName(taken, i)); continue; }
          for (let c = at; c < at + n; c++) {
            const name = this._freeColumnName(others, c - t.range.c1);
            others.push(name);
            // The header cell keeps the formatting it inherited from the column to its left.
            const inherited = sheet.cells.get(cellKey(t.range.r1, c))?.s;
            sheet.cells.set(cellKey(t.range.r1, c), { v: name, f: null, ...(inherited ? { s: inherited } : {}) });
          }
        }
      }
      // A table's filter reaches its last data row, including rows inserted under a table that had none.
      if (axis === 'row') mapSheetFilters(sheet, f => {
        const owner = sheet.tables.find(t => t.range.r1 === f.range.r1 && t.range.c1 === f.range.c1 && t.range.c2 === f.range.c2);
        const end = owner ? tableRows(owner).dataEnd : -1;
        return owner && f.range.r2 < end ? { ...f, range: { ...f.range, r2: end } } : f;
      });
      // Explicit insertion moves existing cells and layout. The scrolling
      // growth cap must not hide those shifted lines or shrink an import.
      if (axis === 'row') {
        sheet.rowHeights = shifted;
        sheet.rowHeightModes = new Map([...sheet.rowHeightModes].map(([r, mode]) => [r >= at ? r + n : r, mode]).filter(([r]) => r <= MAX_ROW));
        sheet.hiddenRows = shiftedHidden; sheet.rows = Math.min(sheet.rows + n, MAX_ROW + 1);
      }
      else { sheet.colWidths = shifted; sheet.hiddenCols = shiftedHidden; sheet.cols = Math.min(sheet.cols + n, MAX_COL + 1); mapNativeWidths(sheet, c => c >= at ? c + n : c); }
      // Lines inserted inside the frozen area stay frozen, so the pane keeps ending at the same content.
      if (axis === 'row' && at < sheet.frozenRows) sheet.frozenRows = Math.min(50, sheet.frozenRows + n);
      if (axis === 'col' && at < sheet.frozenCols) sheet.frozenCols = Math.min(20, sheet.frozenCols + n);
      this._adjustFormulas(sheet.name, axis, at, n, false);
      // Rows inserted among a table's data rows are new table rows: they get the calculated
      // columns, as rows added below the table do. The structural snapshot covers the undo.
      if (axis === 'row') {
        for (const t of sheet.tables) {
          if (!(t.range.r1 < at && at + n - 1 <= tableRows(t).dataEnd)) continue;
          for (let r = at; r < at + n; r++) for (const { r: rr, c, cell } of this._calculatedRowEntries(sheet, t, r)) sheet.cells.set(cellKey(rr, c), cell);
        }
      }
      // Formula addresses and cached positions must both be current before
      // the filter decides which of the moved rows remain visible.
      this._refreshFilters(this.sheets);
      // A row just inserted inside a filtered list stays in view until the filter is applied again;
      // otherwise the new blank row would vanish the moment it appeared.
      if (axis === 'row' && sheet.filterHidden?.size) for (let i = at; i < at + n; i++) sheet.filterHidden.delete(i);
    });
    return true;
  }

  _deleteLines(sheetId, axis, asked, label = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return false;
    const total = axis === 'row' ? sheet.rows : sheet.cols;
    // A band running past the end removes only the lines that exist; the
    // sheet must not shrink by lines that were never there.
    let lines = deleteMap(asked.map(({ from, to }) => ({ from: Math.max(0, from), to: Math.min(to, total - 1) })));
    if (!lines.count) return false;
    if (this.pivotLineEditBlocked(sheetId, axis, 0, 0, lines)) return false;
    const pivotLines = lines; // Keep the full requested deletion when the grid retains one empty line.
    for (const a of this._fixedArrays(sheet).ranges) {
      const first = axis === 'row' ? a.r1 : a.c1, last = axis === 'row' ? a.r2 : a.c2;
      const removed = lines.runs.reduce((count, run) => count + Math.max(0, Math.min(last, run.to) - Math.max(first, run.from) + 1), 0);
      if (removed && removed !== last - first + 1) { this._arrayRefused(sheet, a); return false; }
    }
    // Deleting every line: the sheet keeps one line, emptied below, and its default size.
    const everything = lines.runs.length === 1 && lines.runs[0].from === 0 && lines.runs[0].to === total - 1;
    // Deleting a line removes its cells, protected ones included: check every line asked for, the last
    // one too, before the count is trimmed for the survivor. One protected line refuses the whole
    // deletion, so a deletion over many runs never half-lands.
    for (const { from, to } of lines.runs) {
      if (this.lockedIn(sheetId, axis === 'row' ? { r1: from, r2: to, c1: 0, c2: MAX_COL } : { c1: from, c2: to, r1: 0, r2: MAX_ROW })) return false;
    }
    if (everything) lines = deleteMap([{ from: 0, to: total - 2 }]);
    const { runs } = lines;
    // A table's filter belongs to the table and stays when every data row goes; a plain filter would be dropped.
    const filteredTables = axis === 'row' ? sheetFilters(sheet).map(f => filterTable(sheet, f)).filter(Boolean) : [];
    // Formulas, numbers and dates in the row that becomes a table's header turn into the text they showed: header names are text.
    const promoted = [];
    const renamed = [];
    if (axis === 'row') {
      for (const { from, to } of runs) {
        for (const t of sheet.tables) {
          if (t.headerRow === false || !(t.range.r1 >= from && t.range.r1 <= to && t.range.r2 > to)) continue;
          renamed.push({ id: t.id, name: t.name, before: this.tableColumns(sheet.id, t) });
          for (let c = t.range.c1; c <= t.range.c2; c++) {
            const cell = sheet.cells.get(cellKey(to + 1, c));
            if (cell?.f != null || (cell?.v != null && typeof cell.v !== 'string')) promoted.push({ r: lines.move(to + 1), c, cell: { v: this.getDisplay(sheet.id, to + 1, c) || null, f: null, s: cell.s } });
          }
        }
      }
    }
    this._structural(label || (axis === 'row' ? 'Delete rows' : 'Delete columns'), () => {
      this._removeNativePivots((this.nativePivots?.tables || []).filter(p => {
        const ref = p.owner === sheetId && parseRefText(p.ref || '');
        return ref && !adjustRefForDeletedLines(ref, axis, pivotLines);
      }), label || 'Delete lines', true);
      this.nativePivots = mapNativePivotRanges(this.nativePivots, sheetId, ref => adjustRefForDeletedLines(ref, axis, pivotLines));
      if (everything) {
        // The one surviving line must not keep the last line's contents.
        const last = total - 1;
        for (const key of [...sheet.cells.keys()]) { const { r, c } = parseKey(key); if ((axis === 'row' ? r : c) === last) sheet.cells.delete(key); }
        for (const key of [...sheet.notes.keys()]) { const { r, c } = parseKey(key); if ((axis === 'row' ? r : c) === last) sheet.notes.delete(key); }
        sheet.comments = remapComments(sheet.comments, (r, c) => ((axis === 'row' ? r : c) === last ? null : { r, c }));
        (axis === 'row' ? sheet.rowHeights : sheet.colWidths).delete(last);
        if (axis === 'row') sheet.rowHeightModes.delete(last);
        if (axis === 'col' && sheet.nativeWidths) delete sheet.nativeWidths.cols[last];
        (axis === 'row' ? sheet.rowStyles : sheet.colStyles).delete(last);
        (axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols).delete(last);
        // Nor what was merged, ruled, grouped, or filtered there: nothing on the deleted lines is
        // meant to survive. Only a range running past the sheet's end (a whole column) stays, shortened below.
        const end = axis === 'row' ? 'r2' : 'c2';
        const gone = (m) => m[end] <= last;
        sheet.sparklineGroups = mapNativeSparklineDestinations(sheet.sparklineGroups, ref => gone(ref) ? null : ref);
        sheet.merges = sheet.merges.filter((m) => !gone(m));
        sheet.rules = sheet.rules.filter((rule) => !gone(rule.range));
        sheet.validations = sheet.validations.filter((v) => !gone(v.range));
        sheet.styleResets = shiftStyleResets(sheet.styleResets, axis, last, 1, true);
        sheet.ignoredErrors = shiftRangeFlags(sheet.ignoredErrors, axis, last, 1, true);
        sheet.protectedRanges = sheet.protectedRanges.filter((p) => !gone(p.range));
        mapSheetFilters(sheet, f => gone(f.range) ? null : f);
        if (!sheetFilters(sheet).length) sheet.filterHidden = new Set();
        const groupKey = axis === 'row' ? 'rows' : 'cols';
        sheet.groups[groupKey] = sheet.groups[groupKey].filter((g) => g.to > last);
      }
      if (!lines.count) { if (axis === 'row') sheet.rows = DEFAULT_ROWS; else sheet.cols = DEFAULT_COLS; return; }
      // Rules, validations and filters are few: they follow the runs one at a time, from the bottom up so
      // that the runs above keep their numbering, as they would under one deletion after another.
      for (let i = runs.length - 1; i >= 0; i--) this._adjustLineRules(sheet.name, axis, runs[i].from, runs[i].to - runs[i].from + 1, true);
      const moved = new Map();
      for (const [key, cell] of sheet.cells) {
        const { r, c } = parseKey(key);
        const i = lines.move(axis === 'row' ? r : c);
        if (i == null) continue;
        moved.set(axis === 'row' ? cellKey(i, c) : cellKey(r, i), cell);
      }
      sheet.cells = moved;
      const movedNotes = new Map();
      for (const [key, text] of sheet.notes) {
        const { r, c } = parseKey(key);
        const i = lines.move(axis === 'row' ? r : c);
        if (i == null) continue;
        movedNotes.set(axis === 'row' ? cellKey(i, c) : cellKey(r, i), text);
      }
      sheet.notes = movedNotes;
      sheet.comments = remapComments(sheet.comments, (r, c) => {
        const i = lines.move(axis === 'row' ? r : c);
        return i == null ? null : axis === 'row' ? { r: i, c } : { r, c: i };
      });
      const sizes = axis === 'row' ? sheet.rowHeights : sheet.colWidths;
      const shifted = new Map();
      for (const [i, size] of sizes) {
        const j = lines.move(i);
        if (j != null) shifted.set(j, size);
      }
      // A whole line's own format goes with the line, as its size does.
      const lineStyles = axis === 'row' ? sheet.rowStyles : sheet.colStyles;
      const shiftedStyles = new Map();
      for (const [i, st] of lineStyles) {
        const j = lines.move(i);
        if (j != null) shiftedStyles.set(j, st);
      }
      if (axis === 'row') sheet.rowStyles = shiftedStyles; else sheet.colStyles = shiftedStyles;
      const hidden = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
      const shiftedHidden = new Set([...hidden].map((i) => lines.move(i)).filter((i) => i != null));
      const lo = axis === 'row' ? 'r1' : 'c1';
      const hi = axis === 'row' ? 'r2' : 'c2';
      // A range loses the lines deleted inside it; an end inside a run stops at the last line kept before it.
      const shrink = (m) => ({ ...m, [lo]: m[lo] - lines.before(m[lo]), [hi]: m[hi] - lines.before(m[hi] + 1) });
      sheet.merges = sheet.merges.map(shrink).filter((m) => m[hi] >= m[lo] && (m.r1 !== m.r2 || m.c1 !== m.c2));
      mapPrintAreas(sheet, shrink, axis);
      const groupKey = axis === 'row' ? 'rows' : 'cols';
      sheet.groups[groupKey] = sheet.groups[groupKey]
        .map((g) => { const r = shrink({ r1: g.from, c1: g.from, r2: g.to, c2: g.to }); return { ...g, from: r[lo], to: r[hi] }; })
        .filter((g) => g.to >= g.from);
      sheet.protectedRanges = sheet.protectedRanges.map((p) => ({ ...p, range: shrink(p.range) })).filter((p) => p.range[hi] >= p.range[lo]);
      mapScenarioCells(sheet, shrink);
      // A table survives while its header row and at least one column remain.
      sheet.tables = sheet.tables.map((t) => {
        const origin = t.calcRow ?? tableRows(t).dataStart;
        // If the origin is deleted, use the formula for the first surviving
        // row before adjusting references for the deletion itself.
        const shift = axis === 'row' && lines.deleted(origin) ? lines.next(origin) - origin : 0;
        let calc = t.calc, calcArray = t.calcArray;
        if (axis === 'col') {
          // Calculated columns are keyed from the table's first column, so they follow the runs one at a time, right to left.
          let c1 = t.range.c1;
          for (let i = runs.length - 1; i >= 0; i--) {
            const { from, to } = runs[i];
            calc = shiftCalc(calc, c1, from, to - from + 1, true);
            if (calcArray) calcArray = shiftCalc(calcArray, c1, from, to - from + 1, true);
            c1 = c1 > to ? c1 - (to - from + 1) : c1 >= from ? from : c1;
          }
        } else calc = Object.fromEntries(Object.entries(t.calc || {}).map(([c, f]) => [c, shiftFormula(f, shift, 0)]));
        const range = shrink(t.range);
        if (axis === 'col' && t.headerRow === false) t = headerlessDeleteColumns(t, (c) => lines.deleted(c));
        // The totals row goes with its line; and one left as the table's only row is the header now
        // (promoted above), not a header that is its own totals row, which nothing could add a row to.
        const totalsDeleted = axis === 'row' && (lines.deleted(t.range.r2) || range.r2 === range.r1);
        return { ...t, range, calc, ...(calcArray ? { calcArray } : {}), totalsRow: t.totalsRow && !totalsDeleted,
          ...(axis === 'row' ? { calcRow: origin - lines.before(origin) } : {}) };
      })
        .filter((t) => t.range.c2 >= t.range.c1 && t.range.r2 >= t.range.r1);
      for (const { r, c, cell } of promoted) sheet.cells.set(cellKey(r, c), cell);
      // The promoted row's texts are the columns' new names: references follow them, as when a header is retyped.
      if (renamed.length) this._invalidate(); // header displays are read at their moved positions
      for (const { id, name, before } of renamed) {
        const live = sheet.tables.find((t) => t.id === id);
        if (!live) continue;
        const after = this.tableColumns(sheet.id, live);
        // The promoted row may repeat a name across its columns; the later ones are numbered (a, a2), as typed duplicates are.
        const taken = new Set();
        for (let i = 0; i < after.length; i++) {
          const key = cellKey(live.range.r1, live.range.c1 + i);
          const cell = sheet.cells.get(key);
          if (!taken.has(after[i].toLowerCase()) || cell?.v == null) { taken.add(after[i].toLowerCase()); continue; }
          let k = 2, next;
          do next = `${after[i]}${k++}`; while (taken.has(next.toLowerCase()));
          taken.add(next.toLowerCase());
          after[i] = next;
          sheet.cells.set(key, { ...cell, v: next });
          this._invalidate();
        }
        const names = tableColumnRenames(before, after);
        if (!names.size) continue;
        for (const s of this.sheets) {
          for (const [key, cell] of s.cells) {
            if (cell.f == null || !cell.f.includes('[')) continue;
            const { r, c } = parseKey(key);
            cell.f = renameColumnsInFormula(cell.f, name, names, this.tableAt(s.id, r, c)?.name || null);
          }
          s.tables = s.tables.map((t) => ({ ...t, calc: Object.fromEntries(Object.entries(t.calc || {}).map(([k, f]) => [k, renameColumnsInFormula(f, name, names, t.name)])) }));
          // Rules, validations, and filter conditions that name the column follow too; a bare [@Col] is read
          // where each rule sits (a list source from A1, the sheet's address context, as _resolveSource does).
          const owner = (rule) => (rule.type === 'list' && rule.relativeSource !== true ? this.tableAt(s.id, 0, 0) : this.tableAt(s.id, rule.range.r1, rule.range.c1))?.name || null;
          Object.assign(s, this._ruleFormulaUpdates(s, (f, rule) => renameColumnsInFormula(f, name, names, owner(rule))));
        }
        // A defined name that spells out the column (SUM(T[Qty])) follows the rename too.
        this.names = this.names.map((n) => ({ ...n, ref: renameColumnsInFormula(n.ref, name, names, null) }));
      }
      for (const table of filteredTables) {
        const live = sheet.tables.find(t => t.id === table.id);
        if (live && !sheetFilters(sheet).some(f => filterTable(sheet, f) === live)) {
          const f = { range: { r1: live.range.r1, c1: live.range.c1, r2: tableRows(live).dataEnd, c2: live.range.c2 }, criteria: {} };
          if (!sheet.filter) sheet.filter = f; else sheet.otherFilters.push(f);
        }
      }
      sheet.charts = sheet.charts.map((ch) => {
        // A chart whose data is deleted stays, pointing at the cells that took its place.
        const range = shrink(ch.range);
        if (range[hi] < range[lo]) range[hi] = range[lo];
        const anchor = { ...ch.anchor };
        if (ch.anchorMode !== 'absolute') {
          if (axis === 'row') anchor.r -= lines.before(anchor.r); else anchor.c -= lines.before(anchor.c);
        }
        return { ...ch, range, anchor, ...mapCellDrawing(ch, p => {
          const key = axis === 'row' ? 'r' : 'c';
          if (lines.deleted(p[key])) p[axis === 'row' ? 'dy' : 'dx'] = 0;
          p[key] -= lines.before(p[key]); return p;
        }) };
      });
      if (axis === 'row') {
        sheet.rowHeights = shifted;
        sheet.rowHeightModes = new Map([...sheet.rowHeightModes].map(([r, mode]) => [lines.move(r), mode]).filter(([r]) => r != null));
        sheet.hiddenRows = shiftedHidden; sheet.rows -= lines.count;
      }
      else { sheet.colWidths = shifted; sheet.hiddenCols = shiftedHidden; sheet.cols -= lines.count; mapNativeWidths(sheet, lines.move); }
      if (everything) { if (axis === 'row') sheet.rows = Math.max(sheet.rows, DEFAULT_ROWS); else sheet.cols = Math.max(sheet.cols, DEFAULT_COLS); }
      // The extent reached by scrolling is kept through undo and redo (_restore), so it shrinks with the sheet: left
      // where it was, the next structural undo or redo would grow the sheet back to it, the deleted lines' worth and all.
      if (sheet.reachedRows != null) sheet.reachedRows = Math.min(sheet.reachedRows, sheet.rows);
      if (sheet.reachedCols != null) sheet.reachedCols = Math.min(sheet.reachedCols, sheet.cols);
      // Deleting frozen lines shrinks the frozen area by as many of them as were frozen.
      if (axis === 'row') sheet.frozenRows -= lines.before(sheet.frozenRows);
      else sheet.frozenCols -= lines.before(sheet.frozenCols);
      this._adjustFormulas(sheet.name, axis, runs[0].from, lines.count, true, lines);
      this._refreshFilters(this.sheets);
    });
    return true;
  }

  /** Move `count` rows starting at `from` so they sit before row `to` (in current numbering). */
  moveRows(sheetId, from, count, to) {
    return this._moveLines(sheetId, 'row', from, count, to);
  }

  moveCols(sheetId, from, count, to) {
    return this._moveLines(sheetId, 'col', from, count, to);
  }

  /**
   * Reorder rows or columns: the block [from, from+count) lands before `to`.
   * Everything that lives on a line moves with it (cells, sizes, hidden
   * state, notes, merges, rules, charts), and references everywhere are
   * renumbered so formulas keep pointing at the same data. Returns the new
   * first index of the block, or null when nothing moved.
   */
  _moveLines(sheetId, axis, from, count, to) {
    const sheet = this.sheet(sheetId);
    if (!sheet || count < 1) return null;
    if (this._gridLocked(sheet)) return null;
    const total = axis === 'row' ? sheet.rows : sheet.cols;
    if (from < 0 || from + count > total || to < 0 || to > total) return null;
    if (to >= from && to <= from + count) return null;
    // Protected cells stay where they are; lines displaced by the move keep their protection.
    if (this.lockedIn(sheetId, axis === 'row' ? { r1: from, r2: from + count - 1, c1: 0, c2: MAX_COL } : { c1: from, c2: from + count - 1, r1: 0, r2: MAX_ROW })) return null;
    const landing = to > from ? to - count : to;
    const map = (i) => {
      if (i >= from && i < from + count) return landing + (i - from);
      if (to > from && i >= from + count && i < to) return i - count;
      if (to < from && i >= to && i < from) return i + count;
      return i;
    };
    // A span of lines after the move: its new bounds, and whether it is
    // still one unbroken run (a range that swallows the whole block is).
    const mapSpan = (lo, hi) => {
      let mn = Math.min(map(lo), map(hi));
      let mx = Math.max(map(lo), map(hi));
      // Between these boundaries map is an increasing translation. Its
      // extrema are at segment endpoints, even for million-row references.
      for (const boundary of [from, from + count, to]) {
        for (const i of [boundary - 1, boundary]) {
          if (i < lo || i > hi) continue;
          const m = map(i);
          mn = Math.min(mn, m);
          mx = Math.max(mx, m);
        }
      }
      return { lo: mn, hi: mx, contiguous: mx - mn === hi - lo };
    };
    const mapRange = (m) => {
      const lo = axis === 'row' ? 'r1' : 'c1';
      const hi = axis === 'row' ? 'r2' : 'c2';
      const span = mapSpan(m[lo], m[hi]);
      return { ...m, [lo]: span.lo, [hi]: span.hi };
    };
    const straddles = (m) => !mapSpan(axis === 'row' ? m.r1 : m.c1, axis === 'row' ? m.r2 : m.c2).contiguous;
    for (const t of sheet.tables) {
      const range = mapRange(t.range);
      if (straddles(t.range) || (axis === 'row' && (map(t.range.r1) !== range.r1 || (t.totalsRow && map(t.range.r2) !== range.r2)))) return null;
    }
    // A merged block the move would cut through, taking a line out of it or landing lines inside it, is refused, as
    // sorting through one is, rather than dropping the merge; one the moved lines carry whole follows them.
    if (sheet.merges.some(straddles)) return null;
    // Lines landing inside a protected range grow it over cells nobody may then fill, as an insertion inside
    // one does: refuse and say so, the way moving a protected line away is refused just above. A range the
    // move only shifts keeps the lines it had, and is left alone.
    const grown = sheet.protectedRanges.find((p) => {
      const span = mapSpan(axis === 'row' ? p.range.r1 : p.range.c1, axis === 'row' ? p.range.r2 : p.range.c2);
      return span.hi - span.lo > (axis === 'row' ? p.range.r2 - p.range.r1 : p.range.c2 - p.range.c1);
    });
    if (grown) { this._emit('protected', sheet.id, { range: grown.range, description: grown.description }); return null; }
    const label = axis === 'row' ? 'Move rows' : 'Move columns';
    // Rule and filter formulas are rewritten through their own writers; the transaction folds
    // those steps into this one structural undo entry.
    this.transaction(label, () => this._structural(label, () => {
      const moved = new Map();
      for (const [key, cell] of sheet.cells) {
        const { r, c } = parseKey(key);
        moved.set(cellKey(axis === 'row' ? map(r) : r, axis === 'col' ? map(c) : c), cell);
      }
      sheet.cells = moved;
      const notes = new Map();
      for (const [key, text] of sheet.notes) {
        const { r, c } = parseKey(key);
        notes.set(cellKey(axis === 'row' ? map(r) : r, axis === 'col' ? map(c) : c), text);
      }
      sheet.notes = notes;
      sheet.comments = remapComments(sheet.comments, (r, c) => ({ r: axis === 'row' ? map(r) : r, c: axis === 'col' ? map(c) : c }));
      const sizes = axis === 'row' ? sheet.rowHeights : sheet.colWidths;
      const shifted = new Map();
      for (const [i, size] of sizes) shifted.set(map(i), size);
      if (axis === 'row') {
        sheet.rowHeights = shifted;
        sheet.rowHeightModes = new Map([...sheet.rowHeightModes].map(([r, mode]) => [map(r), mode]));
      } else { sheet.colWidths = shifted; mapNativeWidths(sheet, map); }
      // A whole line's own format travels with the line, as its size does.
      const lineStyles = axis === 'row' ? sheet.rowStyles : sheet.colStyles;
      const shiftedStyles = new Map();
      for (const [i, st] of lineStyles) shiftedStyles.set(map(i), st);
      if (axis === 'row') sheet.rowStyles = shiftedStyles; else sheet.colStyles = shiftedStyles;
      const hidden = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
      const shiftedHidden = new Set([...hidden].map(map));
      if (axis === 'row') sheet.hiddenRows = shiftedHidden; else sheet.hiddenCols = shiftedHidden;
      // No merge is cut by the move (refused above): each follows its lines.
      sheet.merges = sheet.merges.map(mapRange);
      mapPrintAreas(sheet, mapRange, axis);
      const groupKey = axis === 'row' ? 'rows' : 'cols';
      sheet.groups[groupKey] = sheet.groups[groupKey]
        .map((g) => { const span = mapSpan(g.from, g.to); return span.contiguous ? { ...g, from: span.lo, to: span.hi } : null; })
        .filter(Boolean);
      const renumber = (formula, ownerSheet) => mapFormulaRefs(formula, (ref) => {
        const target = ref.sheet ?? ownerSheet;
        if (!sameSheetName(target, sheet.name)) return ref;
        if (axis === 'row' && ref.kind === 'cols') return ref;
        if (axis === 'col' && ref.kind === 'rows') return ref;
        if (!straddles(ref)) return mapRange(ref);
        // A range the block partly overlaps loses the lines that leave it and gains those that
        // land inside it, as if they were deleted and inserted, rather than growing to span both.
        const cut = adjustRefForDelete(ref, axis, from, count);
        return cut && adjustRefForInsert(cut, axis, landing, count);
      });
      // A chart, filter, or protected range the block partly overlaps is treated like such a
      // reference: it loses the lines that leave it and gains those that land inside it.
      const moveRect = (m) => {
        if (!straddles(m)) return mapRange(m);
        const cut = adjustRefForDelete(m, axis, from, count);
        return (cut && adjustRefForInsert(cut, axis, landing, count)) || mapRange(m);
      };
      // A rule the block partly overlaps is split where lines leave it and where they land, so each
      // piece keeps covering its own cells; a piece's formula follows those cells as cell formulas do.
      const lo = axis === 'row' ? 'r1' : 'c1';
      const hi = axis === 'row' ? 'r2' : 'c2';
      const absLo = axis === 'row' ? 'absR1' : 'absC1';
      const absHi = axis === 'row' ? 'absR2' : 'absC2';
      const edges = [from, from + count, to];
      sheet.styleResets = moveLineStyleResets(sheet.styleResets, axis, edges, map);
      // A cut does not carry its ignored-error acknowledgements. Other lines merely
      // shift to make room and retain their reviewed state.
      const cut = axis === 'row' ? { ...GRID_RANGE, r1: from, r2: from + count - 1 } : { ...GRID_RANGE, c1: from, c2: from + count - 1 };
      sheet.ignoredErrors = moveLineRangeFlags(removeRangeFlags(sheet.ignoredErrors, cut), axis, edges, map);
      const splitRule = (rule, field) => {
        if (field === 'value') {
          rule = mapConditionalFormulas(rule, (f, key) => key === conditionalPredicateField(rule) ? f : renumber(f, sheet.name));
          field = conditionalPredicateField(rule) || field;
        }
        const origin = rule.range;
        const expression = !!conditionalPredicateField(rule) || (field === 'source' && rule.type === 'list' && isRangeSource(rule.source));
        const relative = !!conditionalPredicateField(rule) || (field === 'source' && rule.type === 'list' && rule.relativeSource === true && isRangeSource(rule.source));
        const formula = expression ? String(rule[field] ?? '') : '';
        const boundaries = new Set([origin[lo], origin[hi] + 1]);
        const add = (n) => { if (n > origin[lo] && n <= origin[hi]) boundaries.add(n); };
        for (const edge of edges) add(edge);
        // A relative reference crosses the move at a different cell than the rule's own range does.
        if (relative) mapFormulaRefs(formula, (ref) => {
          const target = ref.sheet ?? sheet.name;
          if (!sameSheetName(target, sheet.name) || ref.kind === (axis === 'row' ? 'cols' : 'rows')) return ref;
          for (const [coord, absolute] of [[lo, absLo], [hi, absHi]]) if (!ref[absolute]) for (const edge of edges) add(edge - (ref[coord] - origin[lo]));
          return ref;
        });
        const points = [...boundaries].sort((a, b) => a - b);
        const parts = [];
        for (let i = 0; i < points.length - 1; i++) {
          const old = { ...origin, [lo]: points[i], [hi]: points[i + 1] - 1 };
          const part = { ...rule, range: { ...origin, [lo]: map(old[lo]), [hi]: map(old[hi]) } };
          // Lines landing inside the rule join it, as they join a reference they land inside of.
          if (old[hi] === to - 1 && origin[hi] >= to) part.range[hi] += count;
          if (expression) part[field] = renumber(relative ? shiftFormula(formula, old.r1 - origin.r1, old.c1 - origin.c1) : formula, sheet.name);
          parts.push(part);
        }
        parts.sort((a, b) => a.range[lo] - b.range[lo]);
        const merged = [];
        for (const part of parts) {
          const prev = merged.at(-1);
          const joins = prev && prev.range[hi] + 1 === part.range[lo]
            && (!expression || part[field] === (relative ? shiftFormula(prev[field], part.range.r1 - prev.range.r1, part.range.c1 - prev.range.c1) : prev[field]));
          if (joins) prev.range = { ...prev.range, [hi]: part.range[hi] };
          else merged.push(part);
        }
        return merged.map((part, i) => (i ? { ...part, id: newId() } : part));
      };
      sheet.rules = sheet.rules.flatMap((rule) => splitRule(rule, 'value'));
      sheet.validations = sheet.validations.flatMap((rule) => splitRule(rule, 'source'));
      sheet.protectedRanges = sheet.protectedRanges.map((p) => ({ ...p, range: moveRect(p.range) }));
      sheet.charts = sheet.charts.map((ch) => ({ ...ch, ...mapCellDrawing(ch, p => ({ ...p, [axis === 'row' ? 'r' : 'c']: map(p[axis === 'row' ? 'r' : 'c']) })), range: moveRect(ch.range), anchor: ch.anchorMode === 'absolute' ? ch.anchor : { r: axis === 'row' ? map(ch.anchor.r) : ch.anchor.r, c: axis === 'col' ? map(ch.anchor.c) : ch.anchor.c } }));
      sheet.tables = sheet.tables.map((t) => {
        const range = mapRange(t.range);
        return { ...t, range,
          calc: axis === 'col' ? Object.fromEntries(Object.entries(t.calc || {}).map(([c, f]) => [map(t.range.c1 + Number(c)) - range.c1, f])) : t.calc,
          ...(axis === 'col' && t.calcArray ? { calcArray: Object.fromEntries(Object.entries(t.calcArray).map(([c, v]) => [map(t.range.c1 + Number(c)) - range.c1, v])) } : {}),
          ...(axis === 'row' ? { calcRow: map(t.calcRow ?? tableRows(t).dataStart) } : {}) };
      });
      mapSheetFilters(sheet, old => {
        const range = moveRect(old.range);
        if (range.r1 >= range.r2) return null;
        else {
          const criteria = {};
          for (const [key, crit] of Object.entries(old.criteria)) {
            const oldCol = Number(key);
            const col = axis === 'col' ? map(oldCol) : oldCol;
            // A column that left the filter takes its criteria along.
            if (col < range.c1 || col > range.c2) continue;
            if (!crit.formula) { criteria[col] = crit; continue; }
            const rules = filterFormulaRules(crit, old.range, oldCol);
            const mapped = rules.flatMap((rule) => splitRule(rule, 'source'))
              .filter((rule) => rule.range.r1 > range.r1 && rule.range.r2 <= range.r2)
              .sort((a, b) => a.range.r1 - b.range.r1);
            const same = mapped.length === rules.length && mapped.every((rule, i) => rule.source === rules[i].source
              && rule.range.r1 === rules[i].range.r1 && rule.range.r2 === rules[i].range.r2 && rule.range.c1 === rules[i].range.c1);
            criteria[col] = same ? crit : compileFilterFormula(crit, mapped, range, col);
          }
          return { ...old, range, criteria, ...(old.hiddenButtons ? { hiddenButtons: old.hiddenButtons.map(c => axis === 'col' ? map(c) : c).filter(c => c >= range.c1 && c <= range.c2) } : {}) };
        }
      });
      for (const s of this.sheets) {
        s.sparklineGroups = mapNativeSparklineReferences(s.sparklineGroups, f => renumber(f, s.name));
        if (s === sheet) s.sparklineGroups = mapNativeSparklineDestinations(s.sparklineGroups, mapRange);
        for (const cell of s.cells.values()) if (cell.f != null) cell.f = renumber(cell.f, s.name);
        s.tables = s.tables.map((t) => !t.calc ? t : { ...t, calc: Object.fromEntries(
          Object.entries(t.calc).map(([c, f]) => [c, renumber(f, s.name)]),
        ) });
      }
      this.names = this.names.map((n) => ({ ...n, ref: renumber(n.ref, n.sheet || null) }));
      // On other sheets, a conditional-format, validation or filter formula names the moved sheet to
      // read its data: that reference points at the data wherever it now is, so it follows the move
      // however it is spelled, as it follows an insertion, a deletion (adjustBlockRules) and a block
      // move (moveRange), which rewrite the relative form too. A reference into the rule's own sheet
      // is another matter and is left alone: relative, it is read against each cell of the rule's own
      // range, which has not moved. The rules of the moved sheet itself are split above (splitRule).
      const renumberCrossSheet = (formula) => mapFormulaRefs(formula, (ref) => {
        if (ref.sheet == null || !sameSheetName(ref.sheet, sheet.name)) return ref;
        if (axis === 'row' && ref.kind === 'cols') return ref;
        if (axis === 'col' && ref.kind === 'rows') return ref;
        if (!straddles(ref)) return mapRange(ref);
        const cut = adjustRefForDelete(ref, axis, from, count);
        return cut && adjustRefForInsert(cut, axis, landing, count);
      });
      this._rewriteRuleFormulas((formula, owner) => (owner.id === sheet.id ? formula : renumberCrossSheet(formula)), label, { sparklines: false });
      if (sheetFilters(sheet).length) { this._invalidate(); this._applyFilter(sheet); } else sheet.filterHidden = new Set();
    }));
    return landing;
  }

  _adjustLineRules(sheetName, axis, at, count, remove) {
    for (const sheet of this.sheets) {
      const options = { ownerSheet: sheet.name, sheetName, axis, at, count, remove,
        sheetsBetween: (a, b) => this.sheetsBetween(a, b), newId };
      if (sameSheetName(sheet.name, sheetName)) {
        sheet.styleResets = shiftStyleResets(sheet.styleResets, axis, at, count, remove);
        sheet.ignoredErrors = shiftRangeFlags(sheet.ignoredErrors, axis, at, count, remove);
      }
      sheet.rules = adjustLineRules(sheet.rules, 'value', options);
      sheet.validations = adjustLineRules(sheet.validations, 'source', options);
      mapSheetFilters(sheet, f => adjustFilterForEdit(f, options));
      if (!sheetFilters(sheet).length) sheet.filterHidden = new Set();
    }
  }

  /** `lines`: the deleteMap of a deletion over several runs, so every formula is rewritten once for all of them. */
  _adjustFormulas(sheetName, axis, at, count, remove, lines = null) {
    for (const s of this.sheets) {
      const adjust = (f) => adjustFormula(f, { ownerSheet: s.name, sheetName, axis, at, count, remove, lines, sheetsBetween: (a, b) => this.sheetsBetween(a, b) });
      s.charts = s.charts.map(chart => mapChartReferences(chart, adjust));
      s.sparklineGroups = mapNativeSparklineReferences(s.sparklineGroups, adjust);
      if (sameSheetName(s.name, sheetName)) s.sparklineGroups = mapNativeSparklineDestinations(s.sparklineGroups, ref =>
        remove ? lines ? adjustRefForDeletedLines(ref, axis, lines) : adjustRefForDelete(ref, axis, at, count) : adjustRefForInsert(ref, axis, at, count));
      for (const cell of s.cells.values()) {
        if (cell.f == null) continue;
        cell.f = adjust(cell.f);
      }
      s.tables = s.tables.map((t) => ({ ...t, calc: Object.fromEntries(Object.entries(t.calc || {}).map(([c, f]) => [c, adjust(f)])) }));
    }
    // A name without a sheet reads its unqualified references relative to whichever sheet calls it, so no single edit can move them.
    this.names = this.names.map((n) => ({ ...n, ref: adjustFormula(n.ref, { ownerSheet: n.sheet || null, sheetName, axis, at, count, remove, relativeName: n.relative === true, sheetsBetween: (a, b) => this.sheetsBetween(a, b) }) }));
  }

  setColWidth(sheetId, c, width) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this._gridLocked(sheet)) return;
    // A size that is no number would be stored as NaN, which the grid cannot lay out.
    if (!Number.isFinite(width)) return;
    const w = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
    // The stored size, or none for a column at the default; either way a size already shown is no step and no change.
    const prev = sheet.colWidths.get(c);
    if ((prev ?? sheet.defaultColWidth) === w) return;
    const apply = (val) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      if (val == null || val === live.defaultColWidth) live.colWidths.delete(c);
      else live.colWidths.set(c, val);
      this._changed('layout', live.id);
    };
    apply(w);
    this._push({ label: 'Resize column', undo: () => apply(prev), redo: () => apply(w) });
  }

  setRowHeight(sheetId, r, height, { auto = false } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this._gridLocked(sheet)) return;
    if (!Number.isInteger(r) || r < 0 || r > MAX_ROW || !Number.isFinite(height)) return;
    const rounded = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(height)));
    // Resizing to the default's displayed pixel height restores its exact size.
    const h = sheet.defaultRowHeight >= MIN_ROW_HEIGHT && sheet.defaultRowHeight <= MAX_ROW_HEIGHT
      && rounded === Math.round(sheet.defaultRowHeight) ? sheet.defaultRowHeight : rounded;
    const prev = sheet.rowHeights.get(r), previousMode = sheet.rowHeightModes.get(r);
    // null retains the app's legacy content-fit policy, used for merged cells
    // whose fit cannot be expressed by the .xlsx automatic row-height mode.
    const mode = auto == null ? null : auto ? 'auto' : 'fixed';
    if ((prev ?? sheet.defaultRowHeight) === h && (previousMode === mode || !auto && previousMode == null)) return;
    const apply = (val, sizing) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      if (val == null || val === live.defaultRowHeight) live.rowHeights.delete(r);
      else live.rowHeights.set(r, val);
      if (sizing == null) live.rowHeightModes.delete(r); else live.rowHeightModes.set(r, sizing);
      this._changed('layout', live.id);
    };
    apply(h, mode);
    this._push({ label: 'Resize row', undo: () => apply(prev, previousMode), redo: () => apply(h, mode) });
  }


  /** Refresh derived auto-fit caches without creating edits or disturbing formula caches/history. */
  cacheAutoRowHeights(sheetId, heights) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    let changed = false;
    for (const [r, height] of heights) {
      if (sheet.rowHeightModes.get(r) !== 'auto' || !Number.isFinite(height)) continue;
      const h = height === sheet.defaultRowHeight ? height : Math.max(1, Math.min(MAX_STORED_ROW_HEIGHT, Math.ceil(height)));
      if ((sheet.rowHeights.get(r) ?? sheet.defaultRowHeight) === h) continue;
      if (h === sheet.defaultRowHeight) sheet.rowHeights.delete(r); else sheet.rowHeights.set(r, h);
      changed = true;
    }
    if (changed) refreshCellDrawings(sheet);
    return changed;
  }

  /** Color the sheet's tab (null clears). Undoable. */
  /**
   * A protected sheet refuses every change to its cells, layout, and
   * objects; the attempt is announced as a 'protected' change event so the
   * UI can say why nothing happened.
   */
  isProtected(sheetId) {
    return !!this.sheet(sheetId)?.protected;
  }

  /**
   * Protect or unprotect a sheet. An undo step of its own, as the sheet's colour and frozen panes are:
   * protecting decides what the document permits, and the answer to having protected the wrong sheet is
   * Ctrl+Z. A structural undo still leaves it alone (see _restore), so it follows only its own step.
   */
  setSheetProtected(sheetId, on) {
    const sheet = this.sheet(sheetId);
    const next = !!on;
    const prev = sheet?.protected;
    if (!sheet || sheet.externalCache || prev === next) return;
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      live.protected = v;
      this._changed('structure', live.id);
    };
    apply(next);
    this._push({ label: 'Protect sheet', undo: () => apply(prev), redo: () => apply(next) });
  }

  /** True (and announced) when the sheet is protected, so a mutation should stop. */
  _locked(sheet) {
    if (!sheet?.protected && !sheet?.externalCache) return false;
    this._emit('protected', sheet.id);
    return true;
  }

  /** Chartsheets have no cells or row/column layout to mutate. */
  _gridLocked(sheet) {
    return sheet?.kind === 'chart' || this._locked(sheet);
  }

  /* ---------- Protected ranges ---------- */

  _protectedAt(sheet, r, c) {
    return sheet.protectedRanges.find((p) => r >= p.range.r1 && r <= p.range.r2 && c >= p.range.c1 && c <= p.range.c2) || null;
  }

  /** The protected range covering (r, c), or null. */
  protectedRangeAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    return sheet ? this._protectedAt(sheet, r, c) : null;
  }

  /**
   * Would typing into (r, c) be refused? A protected sheet or range says
   * yes, and announces it the way the refused edit itself would, so the UI
   * can explain before anything is typed.
   */
  /**
   * A cell the user unlocked (Format Cells ▸ Protection ▸ Locked off): on a protected sheet its contents may still be
   * edited while its formatting, and every locked cell, stay protected.
   */
  _unlockedCell(sheet, r, c) {
    return !!sheet?.protected && !sheet.externalCache && sheet.kind !== 'chart' && this.styleAt(sheet.id, r, c)?.locked === false;
  }

  /** Is the formula of (r, c) hidden from view? Only while its sheet is protected. */
  formulaHiddenAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    return !!sheet?.protected && this.styleAt(sheetId, r, c)?.formulaHidden === true;
  }

  lockedAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._unlockedCell(sheet, r, c)) {
      const p = this._protectedAt(sheet, r, c);
      if (p) { this._emit('protected', sheet.id, { range: p.range, description: p.description }); return true; }
      return false;
    }
    if (this._gridLocked(sheet)) return true;
    const p = this._protectedAt(sheet, r, c);
    if (p) { this._emit('protected', sheet.id, { range: p.range, description: p.description }); return true; }
    return false;
  }

  /** Refuse an operation when any part of its affected range is protected. */
  lockedIn(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return true;
    const n = normalizeRange(range);
    const p = sheet.protectedRanges.find(({ range: g }) => g.r1 <= n.r2 && g.r2 >= n.r1 && g.c1 <= n.c2 && g.c2 >= n.c1);
    if (!p) return false;
    this._emit('protected', sheet.id, { range: p.range, description: p.description });
    return true;
  }

  /** Is any part of the range protected? The answer alone, with nothing announced: a dialog greying a control out beforehand asks this, lockedIn when it refuses. */
  isLockedIn(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (sheet.kind === 'chart' || sheet.protected) return true;
    const n = normalizeRange(range);
    return sheet.protectedRanges.some(({ range: g }) => g.r1 <= n.r2 && g.r2 >= n.r1 && g.c1 <= n.c2 && g.c2 >= n.c1);
  }

  /** Would writing the new cells after insertCells encounter protection? */
  lockedAfterCellInsertion(sheetId, range, direction = 'down') {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return true;
    const n = normalizeRange(range);
    const lo = direction === 'right' ? 'c1' : 'r1', hi = direction === 'right' ? 'c2' : 'r2';
    const olo = direction === 'right' ? 'r1' : 'c1', ohi = direction === 'right' ? 'r2' : 'c2';
    const count = n[hi] - n[lo] + 1;
    for (const p of sheet.protectedRanges) {
      const moved = { ...p.range };
      // Match insertCells: ranges wholly in the shifted band either move
      // aside or expand. A range straddling the band stays at its address.
      if (moved[olo] >= n[olo] && moved[ohi] <= n[ohi]) {
        if (moved[lo] >= n[lo]) { moved[lo] += count; moved[hi] += count; }
        else if (moved[hi] >= n[lo]) moved[hi] += count;
      }
      if (moved.r1 <= n.r2 && moved.r2 >= n.r1 && moved.c1 <= n.c2 && moved.c2 >= n.c1) {
        this._emit('protected', sheet.id, { range: p.range, description: p.description });
        return true;
      }
    }
    return false;
  }

  _setProtectedRanges(sheet, next, label) {
    const prev = sheet.protectedRanges;
    const apply = (list) => {
      const live = this.sheet(sheet.id);
      if (!live) return;
      live.protectedRanges = list;
      this._changed('layout', live.id);
    };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  /** Lock a range against edits. Returns the new entry's id. */
  protectRange(sheetId, range, description = '') {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const raw = normalizeRange(range);
    // A range reaching past the file grid stops at its edge, where a reference to a whole line stops too;
    // stored bounds beyond it would be dropped by the next reload. A range with no cell in the grid is refused.
    const n = { r1: Math.max(0, raw.r1), c1: Math.max(0, raw.c1), r2: Math.min(MAX_ROW, raw.r2), c2: Math.min(MAX_COL, raw.c2) };
    if (!validStoredRange(n)) return null;
    // The same cells protected twice would take two unprotects to free: keep the entry already there.
    const twin = sheet.protectedRanges.find(({ range: p }) => p.r1 === n.r1 && p.c1 === n.c1 && p.r2 === n.r2 && p.c2 === n.c2);
    if (twin) return twin.id;
    const entry = { id: newId(), range: n, description: String(description || '').slice(0, 200) };
    this._setProtectedRanges(sheet, [...sheet.protectedRanges, entry], 'Protect range');
    return entry.id;
  }

  updateProtectedRange(sheetId, id, patch) {
    const sheet = this.sheet(sheetId);
    const i = sheet?.protectedRanges.findIndex((p) => p.id === id) ?? -1;
    if (i < 0) return;
    const next = sheet.protectedRanges.slice();
    next[i] = { ...next[i], ...patch, id, range: normalizeRange(patch.range || next[i].range) };
    if (JSON.stringify(next[i]) === JSON.stringify(sheet.protectedRanges[i])) return; // nothing changed: no step, as updateChart
    this._setProtectedRanges(sheet, next, 'Edit protected range');
  }

  unprotectRange(sheetId, id) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheet.protectedRanges.some((p) => p.id === id)) return;
    this._setProtectedRanges(sheet, sheet.protectedRanges.filter((p) => p.id !== id), 'Unprotect range');
  }

  /* ---------- Outline groups ---------- */

  /**
   * Group lines from..to (rows when axis is 'row'). Groups nest when one
   * lies inside another; a group that only partly overlaps an existing one
   * is refused. Returns true when a group was added.
   */
  groupLines(sheetId, axis, from, to) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return false;
    const key = axis === 'row' ? 'rows' : 'cols';
    const lo = Math.max(0, Math.min(from, to));
    // A group stops at the grid's edge: collapsing one hides each of its lines, and lines past the grid
    // are never drawn, so a bound far beyond it would only fill the hidden set and the file.
    const hi = Math.min(Math.max(from, to), (axis === 'row' ? Math.max(sheet.rows, MAX_ROWS) : Math.max(sheet.cols, MAX_COLS)) - 1);
    if (!(lo <= hi)) return false;
    const list = sheet.groups[key];
    if (list.some((g) => g.from === lo && g.to === hi)) return false;
    const partial = list.some((g) => (g.from < lo && g.to >= lo && g.to < hi) || (g.from > lo && g.from <= hi && g.to > hi));
    if (partial) return false;
    if (list.filter((g) => g.from <= lo && g.to >= hi).length >= 7) return false; // eight levels, the .xlsx outline limit
    this._structural(axis === 'row' ? 'Group rows' : 'Group columns', () => {
      sheet.groups = normalizeGroups({ ...sheet.groups, [key]: [...list, { from: lo, to: hi, collapsed: false }] });
    });
    return true;
  }

  /**
   * Ungroup: remove the groups inside from..to; when none is, the innermost
   * group around the selection goes. Lines a removed group had hidden come
   * back. Returns how many groups were removed.
   */
  ungroupLines(sheetId, axis, from, to) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    if (this._gridLocked(sheet)) return 0;
    const key = axis === 'row' ? 'rows' : 'cols';
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const list = sheet.groups[key];
    let gone = list.filter((g) => g.from >= lo && g.to <= hi);
    if (!gone.length) {
      const around = list.filter((g) => g.from <= lo && g.to >= hi).sort((a, b) => (a.to - a.from) - (b.to - b.from));
      if (around.length) gone = [around[0]];
    }
    if (!gone.length) return 0;
    this._structural(axis === 'row' ? 'Ungroup rows' : 'Ungroup columns', () => {
      sheet.groups = normalizeGroups({ ...sheet.groups, [key]: list.filter((g) => !gone.includes(g)) });
      const hidden = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
      for (const g of gone) if (g.collapsed) for (let i = g.from; i <= g.to; i++) if (!this._insideCollapsed(sheet, key, i)) hidden.delete(i);
    });
    return gone.length;
  }

  /** Collapse (hide its lines) or expand a group identified by its bounds. */
  toggleGroup(sheetId, axis, from, to) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this._gridLocked(sheet)) return;
    const key = axis === 'row' ? 'rows' : 'cols';
    const group = sheet.groups[key].find((g) => g.from === from && g.to === to);
    if (!group) return;
    const collapse = !group.collapsed;
    this._structural(collapse ? (axis === 'row' ? 'Collapse rows' : 'Collapse columns') : (axis === 'row' ? 'Expand rows' : 'Expand columns'), () => {
      group.collapsed = collapse;
      const hidden = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
      for (let i = group.from; i <= group.to; i++) {
        if (collapse) hidden.add(i);
        else if (!this._insideCollapsed(sheet, key, i)) hidden.delete(i);
      }
      if (sheetFilters(sheet).length) this._applyFilter(sheet);
    });
  }

  /** Collapse or expand every group on an axis at once. */
  setAllGroups(sheetId, axis, collapsed) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this._gridLocked(sheet)) return;
    const key = axis === 'row' ? 'rows' : 'cols';
    const list = sheet.groups[key];
    if (!list.length || list.every((g) => g.collapsed === !!collapsed)) return;
    this._structural(collapsed ? (axis === 'row' ? 'Collapse all rows' : 'Collapse all columns') : (axis === 'row' ? 'Expand all rows' : 'Expand all columns'), () => {
      const hidden = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
      for (const g of list) {
        g.collapsed = !!collapsed;
        for (let i = g.from; i <= g.to; i++) { if (collapsed) hidden.add(i); else hidden.delete(i); }
      }
      if (sheetFilters(sheet).length) this._applyFilter(sheet);
    });
  }

  /** Change a sheet's outline settings (see normalizeOutlineSettings); an undo step of its own. */
  setOutlineSettings(sheetId, patch) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart') return false;
    const prev = sheet.outlineSettings ? { ...sheet.outlineSettings } : null;
    const next = normalizeOutlineSettings({ ...outlineSettingsOf(sheet), ...patch });
    if (JSON.stringify(prev) === JSON.stringify(next)) return false;
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      if (v) live.outlineSettings = { ...v }; else delete live.outlineSettings;
      this._changed('layout', live.id);
    };
    apply(next);
    this._push({ label: 'Outline settings', undo: () => apply(prev), redo: () => apply(next) });
    return true;
  }

  /**
   * Replace every outline group on an axis (or both, when axis is null) with `groups`, as one step: Auto Outline
   * and Clear Outline. Lines a removed group had hidden come back; a new group starts expanded.
   */
  replaceGroups(sheetId, next, label = 'Outline') {
    const sheet = this.sheet(sheetId);
    if (!sheet || this._gridLocked(sheet)) return false;
    const wanted = normalizeGroups({ rows: next.rows ?? sheet.groups.rows, cols: next.cols ?? sheet.groups.cols });
    if (JSON.stringify(wanted) === JSON.stringify(normalizeGroups(sheet.groups))) return false;
    this._structural(label, () => {
      for (const [key, hidden] of [['rows', sheet.hiddenRows], ['cols', sheet.hiddenCols]]) {
        if (!next[key]) continue;
        for (const g of sheet.groups[key]) if (g.collapsed) for (let i = g.from; i <= g.to; i++) hidden.delete(i);
      }
      sheet.groups = wanted;
      if (sheetFilters(sheet).length) this._applyFilter(sheet);
    });
    return true;
  }

  /** Is line i inside some group that is (still) collapsed? */
  _insideCollapsed(sheet, key, i) {
    return sheet.groups[key].some((g) => g.collapsed && g.from <= i && g.to >= i);
  }

  /** How deeply nested the groups on an axis go (0 when there are none). */
  outlineDepth(sheetId, axis) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return 0;
    const list = sheet.groups[axis === 'row' ? 'rows' : 'cols'];
    let depth = 0;
    for (const g of list) depth = Math.max(depth, list.filter((o) => o.from <= g.from && o.to >= g.to).length);
    return depth;
  }

  /** The groups on an axis, each with its nesting level (1 = outermost). */
  outlineGroups(sheetId, axis) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const list = sheet.groups[axis === 'row' ? 'rows' : 'cols'];
    return list.map((g) => ({ ...g, level: list.filter((o) => o.from <= g.from && o.to >= g.to).length }));
  }

  /** Show or hide the faint lines between cells on a sheet (a view setting that is saved). Undoable. */
  setGridlines(sheetId, on) {
    this._setSheetSwitch(sheetId, 'gridlines', on, 'Gridlines');
  }

  /** Row and column headings belong to the worksheet view, independently of printed headings. */
  setHeaders(sheetId, on) {
    this._setSheetSwitch(sheetId, 'headers', on, 'Row and column headers');
  }

  /** Show or hide zero values on a sheet (a hidden zero is still 0 to formulas). Undoable. */
  setZeros(sheetId, on) {
    this._setSheetSwitch(sheetId, 'zeros', on, 'Show zeros');
  }

  setPrintSettings(sheetId, settings, label = 'Page setup') {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const prev = sheet.printSettings, next = normalizePrintSettings(settings);
    if (JSON.stringify(prev) === JSON.stringify(next)) return false;
    const apply = value => {
      const live = this.sheet(sheetId);
      if (!live) return;
      live.printSettings = normalizePrintSettings(value);
      this._changed('layout', sheetId);
    };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
    return true;
  }

  /**
   * Replace the sheet's manual page breaks (see page-breaks.js): `rows` and `cols` list the first line of
   * each new page. One undo step; a sheet without page setup of its own gets the default one.
   */
  setPageBreaks(sheetId, { rows, cols }, label = 'Page breaks') {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart') return false;
    const current = sheet.printSettings || normalizePrintSettings({});
    return this.setPrintSettings(sheetId, { ...current, rowBreaks: rows ?? current.rowBreaks, colBreaks: cols ?? current.colBreaks }, label);
  }

  /** Navigation is included in the next save, but is not a document edit. */
  setSheetSelection(sheetId, value) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart') return;
    const selection = normalizeSheetSelection(value);
    if (selection) sheet.viewSelection = selection;
  }

  /** Save the scrolling pane's origin without dirtying or recalculating the book. */
  setSheetOrigin(sheetId, value) {
    const sheet = this.sheet(sheetId), origin = normalizeSheetOrigin(value);
    if (sheet && sheet.kind !== 'chart' && origin) sheet.viewOrigin = origin;
  }

  /** Sheet view preferences are saved, without becoming cell undo steps. */
  setSheetView(sheetId, patch) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const next = { ...(sheet.kind === 'chart' ? { zoomToFit: typeof patch.zoomToFit === 'boolean' ? patch.zoomToFit : sheet.zoomToFit } : {}),
      viewZoom: Number.isFinite(patch.viewZoom) && patch.viewZoom >= .1 && patch.viewZoom <= 4 ? patch.viewZoom : sheet.viewZoom };
    if (next.zoomToFit === sheet.zoomToFit && next.viewZoom === sheet.viewZoom) return;
    Object.assign(sheet, next);
    this._changed('view', sheetId);
  }

  /**
   * The sheet's view: 'normal', 'pageLayout' (Page Layout view) or 'pageBreak' (Page Break Preview),
   * saved with the sheet as its sheetView's view. Like the zoom, it is not an undo step.
   */
  setSheetViewMode(sheetId, mode) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart' || !SHEET_VIEW_MODES.includes(mode)) return;
    if ((sheet.viewMode || 'normal') === mode) return;
    if (mode === 'normal') delete sheet.viewMode; else sheet.viewMode = mode;
    this._changed('view', sheetId);
  }

  /**
   * Page Layout ▸ Background: a picture tiled behind the sheet's cells on screen (never printed), or null to
   * delete it. One undo step.
   */
  setSheetBackground(sheetId, src) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart' || this._locked(sheet)) return false;
    const next = src == null ? null : normalizeBackground(src);
    if (src != null && !next) return false;
    const prev = sheet.background || null;
    if ((prev?.src || null) === (next?.src || null)) return false;
    const apply = (value) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      if (value) live.background = { ...value }; else delete live.background;
      this._changed('layout', sheetId);
    };
    apply(next);
    this._push({ label: next ? 'Background' : 'Delete background', undo: () => apply(prev), redo: () => apply(next) });
    return true;
  }

  /* ---------- Custom Views ---------- */

  /** Views read from a file, made safe as stored ones are; not an undo step. */
  adoptCustomViews(views) {
    this.customViews = normalizeCustomViews(views, this.sheets.map((s) => s.id), normalizeFilter);
  }

  _setCustomViews(next, label) {
    const prev = this.customViews;
    const apply = (list) => { this.customViews = list; this._changed('view', null); this.dirty = true; };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  /**
   * Add a view of the workbook as it is now, under `name` (replacing a view of that name). `print` keeps the
   * page setup with it, `hidden` the hidden rows and columns and the filters. Returns the view's id, or null.
   */
  addCustomView(name, { print = true, hidden = true } = {}) {
    const text = String(name ?? '').trim();
    if (!text || text.length > CUSTOM_VIEW_NAME_MAX) return null;
    const view = captureCustomView(this, text, { print, hidden, copyFilter });
    const at = this.customViews.findIndex((v) => v.name.toLowerCase() === text.toLowerCase());
    if (at < 0 && this.customViews.length >= MAX_CUSTOM_VIEWS) return null;
    const next = this.customViews.slice();
    if (at >= 0) next[at] = { ...view, id: this.customViews[at].id }; else next.push(view);
    this._setCustomViews(next, 'Add view');
    return next[at >= 0 ? at : next.length - 1].id;
  }

  deleteCustomView(id) {
    if (!this.customViews.some((v) => v.id === id)) return false;
    this._setCustomViews(this.customViews.filter((v) => v.id !== id), 'Delete view');
    return true;
  }

  /**
   * Show a view: each sheet it holds goes back to how it was shown (zoom, selection, scroll, view mode,
   * frozen panes or split, display switches, and with the view's options its hidden lines, filters and page
   * setup), and its active sheet comes to the front. The edits among those are one undo step; zoom,
   * selection and scroll are navigation, as elsewhere. Returns false for an unknown view.
   */
  showCustomView(id) {
    const view = this.customViews.find((v) => v.id === id);
    if (!view) return false;
    const entries = Object.entries(view.sheets).map(([sheetId, state]) => [this.sheet(sheetId), state]).filter(([sheet]) => sheet && !sheet.externalCache);
    const frame = (sheet) => ({
      frozenRows: sheet.frozenRows, frozenCols: sheet.frozenCols, frozenOrigin: sheet.frozenOrigin ? { ...sheet.frozenOrigin } : null,
      split: sheet.split ? { ...sheet.split } : null, gridlines: sheet.gridlines, headers: sheet.headers, zeros: sheet.zeros,
      hiddenRows: [...sheet.hiddenRows], hiddenCols: [...sheet.hiddenCols],
      filter: copyFilter(sheet.filter), otherFilters: (sheet.otherFilters || []).map(copyFilter), filterHidden: [...sheet.filterHidden],
      printSettings: sheet.printSettings ? normalizePrintSettings(sheet.printSettings) : null,
      hidden: !!sheet.hidden,
    });
    const before = new Map(entries.map(([sheet]) => [sheet.id, frame(sheet)]));
    const target = (sheet, state) => {
      const was = before.get(sheet.id);
      const t = { ...was, frozenRows: state.frozenRows, frozenCols: state.frozenCols, frozenOrigin: state.frozenOrigin || null,
        split: state.split || null, gridlines: state.gridlines, headers: state.headers, zeros: state.zeros, hidden: state.sheetHidden };
      if (view.hidden && state.hiddenRows) Object.assign(t, { hiddenRows: state.hiddenRows, hiddenCols: state.hiddenCols, filter: state.filter, otherFilters: state.otherFilters, filterHidden: null });
      if (view.print && 'printSettings' in state && sheet.kind !== 'chart') t.printSettings = state.printSettings;
      return t;
    };
    const after = new Map(entries.map(([sheet, state]) => [sheet.id, target(sheet, state)]));
    // Never every sheet hidden: the view's active sheet stays in view whatever the view says of it.
    const front = this.sheet(view.activeSheetId) && !this.sheet(view.activeSheetId).externalCache ? view.activeSheetId : null;
    if (front && after.has(front)) after.get(front).hidden = false;
    if (this.sheets.every((s) => (after.get(s.id)?.hidden ?? s.hidden))) for (const v of after.values()) { v.hidden = false; break; }
    const apply = (states) => {
      for (const [sheetId, v] of states) {
        const live = this.sheet(sheetId);
        if (!live) continue;
        live.frozenRows = v.frozenRows; live.frozenCols = v.frozenCols;
        if (v.frozenOrigin) live.frozenOrigin = { ...v.frozenOrigin }; else delete live.frozenOrigin;
        if (v.split && !v.frozenRows && !v.frozenCols) live.split = { ...v.split }; else delete live.split;
        live.gridlines = v.gridlines; live.headers = v.headers; live.zeros = v.zeros;
        live.hiddenRows = new Set(v.hiddenRows); live.hiddenCols = new Set(v.hiddenCols);
        live.filter = copyFilter(v.filter); live.otherFilters = (v.otherFilters || []).map(copyFilter);
        if (v.filterHidden) live.filterHidden = new Set(v.filterHidden);
        else { this._applyFilter(live); v.filterHidden = [...live.filterHidden]; }
        if (live.kind !== 'chart') live.printSettings = normalizePrintSettings(v.printSettings);
        live.hidden = v.hidden;
        this._changed('layout', live.id);
      }
      if (this.sheet(this.activeSheetId)?.hidden) this.activeSheetId = this.sheets.find((s) => !s.hidden).id;
      this._changed('structure', null);
    };
    apply(after);
    this._push({ label: `Show view ${view.name}`, undo: () => apply(before), redo: () => apply(after) });
    // Navigation: where each sheet was, as it was zoomed and in which view.
    for (const [sheet, state] of entries) {
      if (sheet.kind !== 'chart') {
        if (state.selection) sheet.viewSelection = normalizeSheetSelection(state.selection);
        if (state.origin) sheet.viewOrigin = { ...state.origin }; else delete sheet.viewOrigin;
        if (state.mode === 'normal') delete sheet.viewMode; else sheet.viewMode = state.mode;
      }
      sheet.viewZoom = state.zoom;
      this._changed('view', sheet.id);
    }
    if (front && !this.sheet(front).hidden && front !== this.activeSheetId) { this.activeSheetId = front; this._emit('active-sheet'); }
    return true;
  }

  /* ---------- Sheet View: named filter views of a sheet, each person in their own ---------- */

  /**
   * The rows the default view's filters hide while this person is in a sheet view: worked out on a stand-in
   * for the sheet, so the sheet shown is left as it is.
   */
  _defaultFilterHidden(sheet) {
    const saved = sheet.personalView?.saved;
    if (!saved) return sheet.filterHidden;
    const stand = { ...sheet, filter: saved.filter, otherFilters: saved.otherFilters || [], filterHidden: new Set() };
    if (sheetFilters(stand).length) this._applyFilter(stand);
    return stand.filterHidden;
  }

  /** One sheet-view step: the views, the view this person is in, and the filters on show, before and after. */
  _sheetViewStep(sheet, label, change, { undoable = true, shared = false } = {}) {
    if (!sheet || sheet.kind === 'chart') return false;
    const state = (s) => JSON.parse(JSON.stringify({ views: s.sheetViews || [], personal: s.personalView || null, filter: s.filter, otherFilters: s.otherFilters || [] }));
    const before = { ...state(sheet), hidden: [...sheet.filterHidden] };
    if (change(sheet) === false) return false;
    const after = state(sheet);
    const apply = (v, hidden) => {
      const live = this.sheet(sheet.id);
      if (!live) return;
      if (v.views.length) live.sheetViews = v.views; else delete live.sheetViews;
      if (v.personal) live.personalView = v.personal; else delete live.personalView;
      live.filter = v.filter; live.otherFilters = v.otherFilters;
      if (hidden) live.filterHidden = new Set(hidden); else this._applyFilter(live);
      // Going into a view or out of one changes what this person sees, not the document everyone shares;
      // naming, copying or deleting a view changes the document.
      const dirty = this.dirty;
      this._changed('layout', live.id);
      if (!shared) this.dirty = dirty;
    };
    apply(after);
    after.hidden = [...this.sheet(sheet.id).filterHidden];
    if (undoable) this._push({ label, undo: () => apply(before, before.hidden), redo: () => apply(after, after.hidden), snapshotCells: before.hidden.length + after.hidden.length });
    return true;
  }

  /** The view's filters kept up to date with the ones on show while this person is in it. */
  _captureSheetView(sheet) {
    const id = sheet.personalView?.id;
    if (!id || !sheet.sheetViews) return;
    sheet.sheetViews = sheet.sheetViews.map((v) => (v.id === id ? { ...v, filter: copyFilter(sheet.filter), otherFilters: (sheet.otherFilters || []).map(copyFilter) } : v));
  }

  /** Go into a sheet view: its filters show for this person, the default view's kept aside for everyone else. */
  enterSheetView(sheetId, viewId, options) {
    const sheet = this.sheet(sheetId), view = sheet?.sheetViews?.find((v) => v.id === viewId);
    if (!view || sheet.personalView?.id === viewId) return false;
    return this._sheetViewStep(sheet, `Switch to ${view.name}`, (s) => {
      this._captureSheetView(s);
      const saved = s.personalView?.saved || { filter: copyFilter(s.filter), otherFilters: (s.otherFilters || []).map(copyFilter) };
      // A temporary view left for another one goes, as it does on Exit.
      if (s.personalView && s.sheetViews.find((v) => v.id === s.personalView.id)?.temporary) s.sheetViews = s.sheetViews.filter((v) => v.id !== s.personalView.id);
      const target = s.sheetViews.find((v) => v.id === viewId);
      s.personalView = { id: viewId, saved };
      s.filter = copyFilter(target.filter); s.otherFilters = (target.otherFilters || []).map(copyFilter);
    }, options);
  }

  /** New: a temporary view starting from the filters on show, which this person goes into; Keep names it. */
  newSheetView(sheetId) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart') return null;
    const id = newId();
    const ok = this._sheetViewStep(sheet, 'New sheet view', (s) => {
      this._captureSheetView(s);
      const saved = s.personalView?.saved || { filter: copyFilter(s.filter), otherFilters: (s.otherFilters || []).map(copyFilter) };
      const views = (s.sheetViews || []).filter((v) => !(v.temporary && v.id === s.personalView?.id));
      s.sheetViews = [...views, { id, name: 'Temporary View', temporary: true, filter: copyFilter(s.filter), otherFilters: (s.otherFilters || []).map(copyFilter) }];
      s.personalView = { id, saved };
    });
    return ok ? id : null;
  }

  /** Keep: the temporary view this person is in gets a name and stays with the workbook. */
  keepSheetView(sheetId, name) {
    const sheet = this.sheet(sheetId), id = sheet?.personalView?.id, text = String(name ?? '').trim().slice(0, 255);
    if (!id || !text || sheet.sheetViews.some((v) => v.id !== id && v.name.toLowerCase() === text.toLowerCase())) return false;
    return this._sheetViewStep(sheet, 'Keep sheet view', (s) => {
      this._captureSheetView(s);
      s.sheetViews = s.sheetViews.map((v) => (v.id === id ? (({ temporary, ...rest }) => ({ ...rest, name: text }))(v) : v));
    }, { shared: true });
  }

  /** Exit: back to the default view; the view keeps its filters (a temporary one is let go). */
  exitSheetView(sheetId, options) {
    const sheet = this.sheet(sheetId);
    if (!sheet?.personalView) return false;
    return this._sheetViewStep(sheet, 'Exit sheet view', (s) => {
      this._captureSheetView(s);
      const { id, saved } = s.personalView;
      if (s.sheetViews.find((v) => v.id === id)?.temporary) s.sheetViews = s.sheetViews.filter((v) => v.id !== id);
      delete s.personalView;
      s.filter = copyFilter(saved.filter); s.otherFilters = (saved.otherFilters || []).map(copyFilter);
    }, options);
  }

  /** Options: rename, duplicate or delete a view (deleting the one this person is in goes back to the default). */
  renameSheetView(sheetId, viewId, name) {
    const sheet = this.sheet(sheetId), text = String(name ?? '').trim().slice(0, 255);
    if (!sheet?.sheetViews?.some((v) => v.id === viewId) || !text || sheet.sheetViews.some((v) => v.id !== viewId && v.name.toLowerCase() === text.toLowerCase())) return false;
    return this._sheetViewStep(sheet, 'Rename sheet view', (s) => {
      s.sheetViews = s.sheetViews.map((v) => (v.id === viewId ? (({ temporary, ...rest }) => ({ ...rest, name: text }))(v) : v));
    }, { shared: true });
  }

  duplicateSheetView(sheetId, viewId) {
    const sheet = this.sheet(sheetId), view = sheet?.sheetViews?.find((v) => v.id === viewId);
    if (!view) return null;
    this._captureSheetView(sheet);
    const source = sheet.sheetViews.find((v) => v.id === viewId);
    let name = `${source.name} (2)`;
    for (let n = 3; sheet.sheetViews.some((v) => v.name.toLowerCase() === name.toLowerCase()); n++) name = `${source.name} (${n})`;
    const id = newId();
    const ok = this._sheetViewStep(sheet, 'Duplicate sheet view', (s) => {
      const at = s.sheetViews.findIndex((v) => v.id === viewId);
      s.sheetViews = [...s.sheetViews.slice(0, at + 1), { ...JSON.parse(JSON.stringify(source)), id, name, temporary: undefined }, ...s.sheetViews.slice(at + 1)]
        .map((v) => (v.temporary === undefined ? (({ temporary, ...rest }) => rest)(v) : v));
    }, { shared: true });
    return ok ? id : null;
  }

  deleteSheetView(sheetId, viewId) {
    const sheet = this.sheet(sheetId);
    if (!sheet?.sheetViews?.some((v) => v.id === viewId)) return false;
    return this._sheetViewStep(sheet, 'Delete sheet view', (s) => {
      if (s.personalView?.id === viewId) {
        const { saved } = s.personalView;
        delete s.personalView;
        s.filter = copyFilter(saved.filter); s.otherFilters = (saved.otherFilters || []).map(copyFilter);
      }
      s.sheetViews = s.sheetViews.filter((v) => v.id !== viewId);
    }, { shared: true });
  }

  /** Normal view's page-break lines (View ▸ Page Breaks): a view setting saved with the sheet, not an undo step. */
  setShowPageBreaks(sheetId, on) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart' || !!sheet.showPageBreaks === !!on) return;
    if (on) sheet.showPageBreaks = true; else delete sheet.showPageBreaks;
    this._changed('view', sheetId);
  }

  /**
   * One of the sheet's saved view switches, as an undo step of its own, the way the tab colour and the
   * frozen panes are. A structural undo leaves them as they are (see _restore), so each follows only
   * the step that flipped it rather than the edit before it.
   */
  _setSheetSwitch(sheetId, field, on, label) {
    const sheet = this.sheet(sheetId);
    const next = !!on;
    const prev = sheet?.[field];
    if (!sheet || sheet.externalCache || prev === next) return;
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      live[field] = v;
      this._changed('layout', live.id);
    };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  setSheetColor(sheetId, color) {
    if (this._structureLocked()) return;
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (color != null && !(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) return;
    const next = color || null;
    const prev = sheet.color;
    if (prev === next) return;
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      live.color = v;
      this._changed('structure', live.id);
    };
    apply(next);
    this._push({ label: 'Sheet color', undo: () => apply(prev), redo: () => apply(next) });
  }

  /** Freeze `rows` and `cols` from the current frozen origin (normally A1); 0 unfreezes. Freezing removes a split. */
  setFrozen(sheetId, rows, cols) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const next = { rows: Math.max(0, Math.min(50, rows | 0)), cols: Math.max(0, Math.min(20, cols | 0)) };
    const prev = { rows: sheet.frozenRows, cols: sheet.frozenCols, origin: sheet.frozenOrigin, split: sheet.split };
    if (prev.rows === next.rows && prev.cols === next.cols) return;
    const origin = { r: next.rows ? Math.min(prev.origin?.r || 0, MAX_ROW - next.rows) : 0, c: next.cols ? Math.min(prev.origin?.c || 0, MAX_COL - next.cols) : 0 };
    if (origin.r || origin.c) next.origin = origin;
    if (!next.rows && !next.cols) next.split = prev.split;
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      live.frozenRows = v.rows;
      live.frozenCols = v.cols;
      if (v.origin) live.frozenOrigin = { ...v.origin }; else delete live.frozenOrigin;
      if (v.split) live.split = v.split; else delete live.split;
      this._changed('layout', live.id);
    };
    apply(next);
    this._push({ label: 'Freeze panes', undo: () => apply(prev), redo: () => apply(next) });
  }

  /**
   * Split the window (View ▸ Split), or remove the split with null; splitting removes frozen panes.
   * The bars' places are pixels at 100% zoom, see split-panes.js.
   */
  setSplit(sheetId, value) {
    const sheet = this.sheet(sheetId);
    if (!sheet || sheet.kind === 'chart') return;
    const next = { split: normalizeSplit(value), rows: 0, cols: 0, origin: undefined };
    const prev = { split: sheet.split || null, rows: sheet.frozenRows, cols: sheet.frozenCols, origin: sheet.frozenOrigin };
    if (!next.split && !prev.split) return;
    if (next.split && prev.split && !prev.rows && !prev.cols && ['x', 'y', 'r', 'c'].every(k => next.split[k] === prev.split[k])) return;
    if (!next.split) Object.assign(next, { rows: prev.rows, cols: prev.cols, origin: prev.origin });
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      live.frozenRows = v.rows;
      live.frozenCols = v.cols;
      if (v.origin) live.frozenOrigin = { ...v.origin }; else delete live.frozenOrigin;
      if (v.split) live.split = { ...v.split }; else delete live.split;
      this._changed('layout', live.id);
    };
    apply(next);
    this._push({ label: next.split ? 'Split' : 'Remove split', undo: () => apply(prev), redo: () => apply(next) });
  }

  /** Where the top-left pane of a split window is scrolled to: navigation, saved without dirtying the book. */
  setSplitOrigin(sheetId, origin) {
    const split = this.sheet(sheetId)?.split, at = normalizeSheetOrigin(origin);
    if (split && at) { split.r = at.r; split.c = at.c; }
  }

  colWidth(sheetId, c) {
    const sheet = this.sheet(sheetId);
    if (sheet?.hiddenCols.has(c)) return 0;
    return sheet?.colWidths.get(c) ?? sheet?.defaultColWidth ?? DEFAULT_COL_WIDTH;
  }

  rowHeight(sheetId, r) {
    const sheet = this.sheet(sheetId);
    if (sheet?.hiddenRows.has(r) || sheet?.filterHidden.has(r)) return 0;
    return sheet?.rowHeights.get(r) ?? sheet?.defaultRowHeight ?? DEFAULT_ROW_HEIGHT;
  }

  /** Rows hidden by the user or by the active filter. */
  isRowHidden(sheetId, r) {
    const sheet = this.sheet(sheetId);
    return !!sheet && (sheet.hiddenRows.has(r) || sheet.filterHidden.has(r));
  }

  /* ---------- Filter ---------- */

  filtersForSheet(sheetId) { return sheetFilters(this.sheet(sheetId)); }

  filterAt(sheetId, r, c) {
    return this.filtersForSheet(sheetId).find(f => r >= f.range.r1 && r <= f.range.r2 && c >= f.range.c1 && c <= f.range.c2) || null;
  }

  /** Select a filter for the menu without altering filtering or undo history. */
  activateFilter(sheetId, filter) {
    const sheet = this.sheet(sheetId);
    const selected = sheetFilters(sheet).find(f => sameFilterRange(f, filter));
    if (!selected || selected === sheet.filter) return;
    sheet.otherFilters = sheetFilters(sheet).filter(f => f !== selected);
    sheet.filter = selected;
    this._emit('layout', sheetId);
  }

  /** `show`: rows the filter leaves in view whatever its criteria say, until it is applied again. */
  _setFilter(sheet, next, label, { show = null, target = sheet.filter, create = false } = {}) {
    if (this._gridLocked(sheet)) return;
    const prev = { filter: copyFilter(sheet.filter), otherFilters: (sheet.otherFilters || []).map(copyFilter), hidden: [...sheet.filterHidden] };
    target = sheetFilters(sheet).find(f => sameFilterRange(f, create ? next : target)) || null;
    const remaining = sheetFilters(sheet).filter(f => f !== target && !sameFilterRange(f, next)
      // There is one ordinary worksheet filter, but each table owns its own.
      && !(create && next && !filterTable(sheet, f) && (!filterTable(sheet, next)
        // A table replaces a worksheet filter crossing its cells; disjoint filters coexist.
        || !(f.range.r2 < next.range.r1 || f.range.r1 > next.range.r2 || f.range.c2 < next.range.c1 || f.range.c1 > next.range.c2))));
    const cleared = sheetFilters(sheet).filter(f => !remaining.includes(f)).map(f => f.range);
    const select = create || target === sheet.filter;
    const after = select ? { filter: copyFilter(next) || remaining.shift() || null, otherFilters: remaining }
      : { filter: sheet.filter, otherFilters: [...remaining.filter(f => f !== sheet.filter), ...(next ? [copyFilter(next)] : [])] };
    const apply = (state) => {
      const live = this.sheet(sheet.id) || sheet;
      live.filter = copyFilter(state.filter);
      live.otherFilters = state.otherFilters.map(copyFilter);
      if (state.hidden) live.filterHidden = new Set(state.hidden);
      else {
        this._applyFilter(live, show ? { filter: next, rows: new Set(show) } : null, { filters: next ? [next] : [], clear: cleared });
        // Undo may run before the enclosing move restores its cells. Restore
        // the saved view instead of testing criteria against those transient cells.
        state.hidden = [...live.filterHidden];
      }
      this._changed('layout', live.id);
    };
    apply(after);
    this._push({ label, undo: () => apply(prev), redo: () => apply(after), snapshotCells: prev.hidden.length + after.hidden.length });
  }

  /** Turn a filter on over a range (first row is the header). */
  setFilterRange(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    const n = normalizeRange(range);
    if (n.r1 >= n.r2) return;
    this._setFilter(sheet, { range: n, criteria: {} }, 'Create filter', { create: true });
  }

  clearFilter(sheetId) {
    const sheet = this.sheet(sheetId);
    if (!sheet?.filter) return;
    this._setFilter(sheet, null, 'Remove filter');
  }

  /**
   * Grow the filter over a list a tool has just written rows at the end of (Subtotal's last group total and
   * its grand total, which land under the range the filter covered), keeping its criteria. `show` names the
   * rows that stay in view until the filter is applied again, as rows added to a filtered table do. Without
   * this the rows inserted inside the list sat under the filter while the ones at its foot sat outside it,
   * and a later filter change hid some of a tool's rows and not the others.
   */
  extendFilterOverRows(sheetId, from, r2, show = [], columns = null) {
    const sheet = this.sheet(sheetId);
    const f = columns ? sheetFilters(sheet).find(f => f.range.r1 <= from && f.range.r2 >= from && f.range.c1 <= columns.c1 && f.range.c2 >= columns.c2) : sheet?.filter;
    // Only the filter those rows joined: one over another block of the sheet is left alone.
    if (!f || f.range.r1 > from || f.range.r2 < from) return false;
    if (r2 <= f.range.r2 && !show.length) return false;
    this._setFilter(sheet, { ...f, range: { ...f.range, r2: Math.max(f.range.r2, r2) } }, 'Filter', { show, target: f });
    return true;
  }

  /**
   * Criteria for one column: { values: ['a', 'b'] } keeps rows whose
   * displayed value is listed (blank as ''; `keys` carries the numbers behind
   * the listed texts, see _filterValueKeys), { text: 'x' } keeps rows whose
   * text contains x, { op, value, value2 } keeps rows meeting a condition
   * (any conditional-formatting comparison: 'gt', 'between', 'contains',
   * 'empty', ...); null clears the column's criteria.
   */
  setFilterCriteria(sheetId, col, criteria, filter = this.sheet(sheetId)?.filter) {
    const sheet = this.sheet(sheetId);
    const target = sheet && sheetFilters(sheet).find(f => sameFilterRange(f, filter));
    if (!target || !Number.isInteger(col) || col < target.range.c1 || col > target.range.c2) return;
    const next = { ...target, criteria: { ...target.criteria } };
    if (criteria) {
      const previous = target.criteria[col];
      if (Array.isArray(criteria.values) && criteria.keys === undefined) criteria = this._filterValueKeys(sheet, col, criteria, target);
      next.criteria[col] = criteria.formula && criteria.formula === previous?.formula && previous.formulaParts && !criteria.formulaParts
        ? { ...criteria, formulaParts: previous.formulaParts } : criteria;
    }
    else delete next.criteria[col];
    this._setFilter(sheet, next, 'Filter', { target });
  }

  /**
   * A value criterion names the texts the menu showed, which is how the menu reads it back and files carry
   * it; but a number's text changes with the regional format (1.5 reads 1,5 in German), and a filter judged
   * by text alone would then hide every row of the column. The numbers behind the chosen texts go along as
   * keys, and _applyFilter keeps a row by either. Text that merely reads as a number has no key.
   */
  _filterValueKeys(sheet, col, criteria, filter = sheet.filter) {
    const wanted = new Set(criteria.values.map(v => filterValueIdentity(v, criteria)));
    const keys = new Set();
    const { r1, r2 } = filter.range;
    for (let r = r1 + 1, last = Math.min(r2, sheet.rows - 1); r <= last; r++) {
      if (!wanted.has(filterValueIdentity(this._filterText(sheet, r, col), criteria))) continue;
      const v = this._compute(sheet, r, col);
      if (typeof v === 'number' && Number.isFinite(v)) keys.add(this._filterKey(sheet, r, col, v));
    }
    return keys.size ? { ...criteria, keys: [...keys] } : criteria;
  }

  /**
   * A number's identity for a value filter: the number with the format it is shown in, so that 2 and 2.00
   * stay the two entries the menu listed while 1.5 and its German 1,5 are one. A plain number is its own key.
   */
  _filterKey(sheet, r, c, v) {
    const s = sheet.cells.get(cellKey(r, c))?.s;
    const format = s ? ['fmt', 'dec', 'cur', 'group', 'code', 'dateStyle', 'sec'].flatMap((k) => (s[k] != null ? [`${k}=${s[k]}`] : [])).join(',') : '';
    return format ? `${v}|${format}` : String(v);
  }

  /**
   * For the filter menu: the keys (see _filterKey) behind each text a filtered column's numbers show, as a
   * Map from text to a Set of keys, so an entry a value filter chose by number reads as chosen after the
   * regional format changed how the number is written. Text that is not a number has no entry.
   */
  filterKeysByText(sheetId, col, filter = this.sheet(sheetId)?.filter) {
    const out = new Map();
    const sheet = this.sheet(sheetId);
    if (!sheet || !filter) return out;
    const { r1, r2 } = filter.range;
    for (let r = r1 + 1, last = Math.min(r2, sheet.rows - 1); r <= last; r++) {
      const v = this._compute(sheet, r, col);
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const text = this._filterText(sheet, r, col);
      if (!out.has(text)) out.set(text, new Set());
      out.get(text).add(this._filterKey(sheet, r, col, v));
    }
    return out;
  }

  /** Displayed value used for filtering a cell (numbers as shown, blanks as ''). */
  _filterText(sheet, r, c) {
    return this.getDisplay(sheet.id, r, c);
  }

  /**
   * The fill a cell was given, for filtering and sorting by colour: its conditional format's, or its own
   * style's, or '' for none. A table's coat and alternating-colour rules are left
   * out of Filter by Color: their bands follow a row's place among the rows in view, so a filter by one
   * would hide different rows on every pass and half of what it kept would then show the other colour.
   */
  _cellFill(sheet, r, c) {
    const cell = sheet.cells.get(cellKey(r, c));
    // Spill children have values even when no raw cell is stored here.
    const cf = sheet.rules.length ? this.conditionalStyle(sheet.id, r, c, this._compute(sheet, r, c), { banding: false }) : null;
    // A fill given to the whole column or row is the cell's fill too, so Filter and Sort by colour
    // find the rows it painted rather than only the cells that happen to carry it themselves.
    const bg = cell?.s && Object.hasOwn(cell.s, 'bg') ? cell.s.bg : this._lineStyle(sheet, r, c)?.bg;
    return (fillColorCss(cf?.bg || bg) || '').toLowerCase();
  }

  /** Distinct fill colors in a filter column with their counts ('' for cells without a fill). */
  filterColors(sheetId, col, filter = this.sheet(sheetId)?.filter) {
    const sheet = this.sheet(sheetId);
    const target = sheet && sheetFilters(sheet).find(f => sameFilterRange(f, filter));
    if (!target || !Number.isInteger(col) || col < target.range.c1 || col > target.range.c2) return [];
    const { r1, r2 } = target.range;
    const counts = new Map();
    for (let r = r1 + 1, last = Math.min(r2, sheet.rows - 1); r <= last; r++) {
      // Every row the filter judges is listed, a row hidden by hand included (see filterValues).
      const fill = this._cellFill(sheet, r, col);
      counts.set(fill, (counts.get(fill) || 0) + 1);
    }
    return [...counts.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => (a.color === '' ? 1 : b.color === '' ? -1 : b.count - a.count));
  }

  /** Distinct displayed values, sorted, with counts. Slicers also request each
   * group's selection and availability under the other column criteria. */
  filterValues(sheetId, col, filter = this.sheet(sheetId)?.filter, { withState = false, caseSensitive } = {}) {
    const sheet = this.sheet(sheetId);
    const target = sheet && sheetFilters(sheet).find(f => sameFilterRange(f, filter));
    if (!target || !Number.isInteger(col) || col < target.range.c1 || col > target.range.c2) return [];
    const { r1, r2 } = target.range;
    const counts = new Map();
    const criterion = target.criteria[col];
    const grouping = caseSensitive == null ? criterion : { caseSensitive };
    const selected = withState && this._filterRowPredicate(sheet, { ...target, criteria: criterion ? { [col]: criterion } : {} });
    const available = withState && this._filterRowPredicate(sheet, target, col);
    // Rows past the sheet's end are never drawn, so a whole-column filter lists the blanks the sheet has.
    for (let r = r1 + 1, last = Math.min(r2, sheet.rows - 1); r <= last; r++) {
      // Every row the filter judges is listed: rows hidden by other columns' criteria, so a value can be
      // re-included, and rows the user hid by hand, whose values would otherwise be missing from the list
      // while the filter still tested them — ticking everything on offer would then filter such a row out
      // for good, since Show rows cannot bring back a row the filter excludes.
      const text = this._filterText(sheet, r, col);
      const identity = filterValueIdentity(text, grouping);
      const seen = counts.get(identity);
      if (seen) seen.count++;
      else {
        // Dates and formatted amounts sort by the number behind the text, not by its spelling. Only plain
        // figures count for text: "1e3" or "0x10" would parse as numbers but read as words.
        const v = this._compute(sheet, r, col);
        const plain = text.trim();
        const shown = /^[-+]?\$?[\d,]*\.?\d+%?$/.test(plain) ? Number(plain.replace(/[,$%]/g, '')) : NaN;
        counts.set(identity, { value: text, count: 1, num: typeof v === 'number' && Number.isFinite(v) ? v : Number.isNaN(shown) ? null : shown, error: isError(v) });
      }
      if (withState) {
        const item = counts.get(identity);
        // One matching row suffices for a displayed value, even when several
        // typed values or case variants share its label.
        item.selected ||= selected(r);
        item.available ||= available(r);
      }
    }
    // Sort keys are worked out once per distinct value, not once per comparison.
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    const keyed = [...counts.values()];
    keyed.sort((a, b) => {
      if (a.value === '') return 1;
      if (b.value === '') return -1;
      // Errors follow the text and precede the blanks.
      if (a.error !== b.error) return a.error ? 1 : -1;
      if (a.num !== null && b.num !== null) return a.num - b.num;
      if (a.num !== null || b.num !== null) return a.num !== null ? -1 : 1;
      return collator.compare(a.value, b.value);
    });
    return keyed.map(({ value, count, selected, available }) => ({ value, count,
      ...(withState ? { selected: !!selected, available: !!available } : {}) }));
  }

  /** New sheets need their visible rows ready before the structural change event. */
  _refreshFilters(sheets, { preserveView = false } = {}) {
    const filtered = sheets.filter(sheet => sheetFilters(sheet).length);
    if (!filtered.length) return;
    // Structural edits need fresh formula positions. Copies instead retain
    // their saved view, including cells edited since filtering was applied.
    this._invalidate();
    if (!preserveView) for (const sheet of filtered) this._applyFilter(sheet);
  }

  /** Compile the same row predicate used by filtering, optionally ignoring one column's selection. */
  _filterRowPredicate(sheet, f, excludeCol = null) {
    const cols = Object.keys(f.criteria).map(Number).filter(c => c !== excludeCol);
    // Build membership indexes once per pass. Searching the selected
    // value list for every row is quadratic for large filter lists.
    const allowed = new Map();
    for (const c of cols) {
      const crit = f.criteria[c];
      if (Array.isArray(crit.values)) allowed.set(c, { texts: new Set(crit.values.map(v => filterValueIdentity(v, crit))), keys: new Set(Array.isArray(crit.keys) ? crit.keys : []) });
    }
    const formulas = new Map();
    for (const c of cols) if (f.criteria[c].formula) formulas.set(c, filterFormulaReader(f.criteria[c], f.range, c));
    // A condition's bounds are read once per column, not once per row.
    const conditions = new Map();
    for (const c of cols) if (f.criteria[c].op) conditions.set(c, this._filterCondition(f.criteria[c]));
    return r => {
      for (const c of cols) {
        const crit = f.criteria[c];
        const text = this._filterText(sheet, r, c);
        let keep = true;
        if (allowed.has(c)) {
          const { texts, keys } = allowed.get(c);
          keep = texts.has(filterValueIdentity(text, crit));
          // A number whose text the regional format has changed is still the number that was chosen.
          if (!keep && keys.size) { const v = this._compute(sheet, r, c); keep = typeof v === 'number' && keys.has(this._filterKey(sheet, r, c, v)); }
        }
        else if (crit.op) {
          // Text conditions read the text on screen (a date shows 2024-01-15, an amount $1,500.00), as the
          // value list does; equality takes either spelling; number and date conditions compare the raw
          // value with the bound as typed (see _filterCondition).
          const rule = conditions.get(c);
          if (crit.op === 'contains' || crit.op === 'notContains' || crit.op === 'beginsWith' || crit.op === 'endsWith') keep = matchesRule(rule, text);
          else if (crit.op === 'eq' || crit.op === 'neq') {
            const same = matchesRule({ ...rule, type: 'eq' }, this._compute(sheet, r, c)) || matchesRule({ type: 'eq', value: crit.value }, text);
            keep = crit.op === 'eq' ? same : !same;
          } else keep = matchesRule(rule, this._compute(sheet, r, c));
        }
        else if (crit.formula) {
          // A custom formula written for the first data row of this column (=C2>100); relative rows follow each row.
          const rule = formulas.get(c)(r);
          const v = this.evalRuleFormula(sheet.id, rule.source, rule.range, r, c);
          keep = v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v.trim().toUpperCase() === 'TRUE');
        }
        else if (crit.color != null) keep = this._cellFill(sheet, r, c) === String(crit.color).toLowerCase();
        else if (crit.text != null) keep = text.toLowerCase().includes(String(crit.text).toLowerCase());
        if (!keep) return false;
      }
      return true;
    };
  }

  /**
   * Values with data under the other criteria in this list. Physical row visibility is deliberately
   * ignored: manual hiding and filters belonging to other tables do not change this list's membership.
   * Reading availability neither activates the list nor reapplies its saved visible rows.
   */
  filterAvailableValues(sheetId, col, filter = this.sheet(sheetId)?.filter) {
    const sheet = this.sheet(sheetId);
    const target = sheet && sheetFilters(sheet).find(f => sameFilterRange(f, filter));
    const values = new Set();
    if (!target || !Number.isInteger(col) || col < target.range.c1 || col > target.range.c2) return values;
    const keep = this._filterRowPredicate(sheet, target, col);
    for (let r = target.range.r1 + 1, last = Math.min(target.range.r2, sheet.rows - 1); r <= last; r++) {
      if (keep(r)) values.add(this._filterText(sheet, r, col));
    }
    return values;
  }

  /** Recompute which rows the filter hides. */
  _applyFilter(sheet, visible = null, changed = null) {
    const hidden = new Set(changed ? sheet.filterHidden : []);
    const clear = range => {
      const last = Math.min(range.r2, sheet.rows - 1);
      if (hidden.size < last - range.r1) { for (const r of hidden) if (r > range.r1 && r <= last) hidden.delete(r); }
      else for (let r = range.r1 + 1; r <= last; r++) hidden.delete(r);
    };
    for (const range of changed?.clear || []) clear(range);
    // A table filter applies to physical rows. It changes visibility
    // inside that list, even when another table covers those same rows; it
    // does not intersect the two tables' saved predicates. Context selection
    // alone leaves the saved view untouched. Reapply-all runs the current list last.
    for (const f of changed?.filters || sheetFilters(sheet).reverse()) {
      clear(f.range);
      if (!Object.keys(f.criteria).length) continue;
      const keep = this._filterRowPredicate(sheet, f);
      // A whole-column filter only judges rows present in the sheet.
      for (let r = f.range.r1 + 1, last = Math.min(f.range.r2, sheet.rows - 1); r <= last; r++) {
        if (visible && sameFilterRange(f, visible.filter) && visible.rows.has(r)) continue;
        if (!keep(r)) hidden.add(r);
      }
    }
    sheet.filterHidden = hidden;
    refreshCellDrawings(sheet);
  }

  /**
   * A condition as a rule for matchesRule, its bounds read as the cell editor reads typed text under the
   * current regional format: 1,5 is one and a half where the decimal mark is a comma, and 1,000, 10%,
   * $1,500 or 2024-01-15 are the numbers they show, as the conditional-formatting dialog reads its bounds.
   * Text that is no number stays text, and the bounds of a text condition (contains, begins with) stay as typed.
   */
  _filterCondition(crit) {
    const textual = crit.op === 'contains' || crit.op === 'notContains' || crit.op === 'beginsWith' || crit.op === 'endsWith';
    const typed = (v) => {
      if (textual || typeof v !== 'string') return v;
      const parsed = parseInput(v.trim());
      return parsed.f == null && typeof parsed.v === 'number' ? parsed.v : v;
    };
    return { type: crit.op, value: typed(crit.value), value2: typed(crit.value2) };
  }

  /** Re-run the active filter against current data (after edits). */
  reapplyFilter(sheetId) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheetFilters(sheet).length) return;
    const before = [...sheet.filterHidden].join(',');
    this._applyFilter(sheet);
    if ([...sheet.filterHidden].join(',') !== before) this._emit('layout', sheet.id);
  }

  /**
   * Rows were rearranged under a filter (a sort, a shuffle, duplicates
   * removed): the hidden set named rows by position, so recompute it and
   * record both states, so that undo and redo show the right rows again.
   */
  _refilterRearranged(sheet, range, label) {
    if (!sheetFilters(sheet).some(f => range.r2 >= f.range.r1 && range.r1 <= f.range.r2)) return;
    const before = sheet.filterHidden;
    this._applyFilter(sheet);
    const after = sheet.filterHidden;
    if (before.size === after.size && [...before].every((r) => after.has(r))) return;
    const apply = (hidden) => {
      const live = this.sheet(sheet.id);
      if (!sheetFilters(live).length) return;
      live.filterHidden = new Set(hidden);
      this._emit('layout', live.id);
    };
    this._emit('layout', sheet.id);
    this._push({ label, undo: () => apply(before), redo: () => apply(after) });
  }

  /* ---------- Charts ---------- */

  _setCharts(sheet, next, label) {
    if (this._locked(sheet)) return;
    const prev = sheet.charts;
    const apply = (list) => { const live = this.sheet(sheet.id) || sheet; live.charts = list; this._changed('layout', live.id); };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  /** Add a chart (see charts.js for the shape); returns its id. */
  addChart(sheetId, chart) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    if (this._locked(sheet)) return null;
    const full = absoluteDrawingAnchor(sheet, normalizeChart({ ...chart, id: newId() }));
    if (!full) return null;
    this._setCharts(sheet, [...sheet.charts, full], `Insert ${objectNoun(full)}`);
    return full.id;
  }

  /** A copy of a chart or image, nudged down and right so both stay visible and anchored to the cell under its corner; returns the new id. */
  duplicateChart(sheetId, id) {
    const sheet = this.sheet(sheetId);
    const ch = sheet?.charts.find((c) => c.id === id);
    if (!ch) return null;
    if (this._locked(sheet)) return null;
    const copy = JSON.parse(JSON.stringify(ch));
    delete copy.id;
    if (copy.type === 'slicer') delete copy.nativeName;
    // The copy sits 24 pixels down and right of the original, inside the sheet, and is anchored again to
    // the cell its corner now lies in, as a drag anchors what it moves: an object's anchor is the cell its
    // top-left corner sits in, so the copy follows the columns and rows it lies in through later edits,
    // rather than those of the original's cell, which after a few duplicates it no longer touched.
    const col = placeAlong((c) => this.colWidth(sheet.id, c), sheet.cols, copy.anchor.c, (copy.dx || 0) + 24, copy.w || 1);
    const row = placeAlong((r) => this.rowHeight(sheet.id, r), sheet.rows, copy.anchor.r, (copy.dy || 0) + 24, copy.h || 1);
    copy.anchor = { r: row.index, c: col.index };
    copy.dx = col.offset;
    copy.dy = row.offset;
    if (copy.title && !['image', 'text', 'slicer', 'smartart'].includes(copy.type)) copy.title = `${copy.title} (copy)`;
    const full = reanchorCellDrawing(sheet, absoluteDrawingAnchor(sheet, normalizeChart({ ...copy, id: newId() })));
    if (!full) return null;
    this._setCharts(sheet, [...sheet.charts, full], `Duplicate ${objectNoun(full)}`);
    return full.id;
  }

  chartById(sheetId, id) {
    return this.sheet(sheetId)?.charts.find((ch) => ch.id === id) || null;
  }

  updateChart(sheetId, id, patch, label = 'Edit chart') {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this._locked(sheet)) return;
    const i = sheet.charts.findIndex((ch) => ch.id === id);
    if (i < 0) return;
    const next = sheet.charts.slice();
    const merged = absoluteDrawingAnchor(sheet, normalizeChart({ ...next[i], ...(patch.src != null && patch.src !== next[i].src ? { nativeSrc: null, nativeDrawing: null } : {}),
      ...patch, id, range: patch.range || next[i].range, anchor: patch.anchor || next[i].anchor }));
    if (!merged) return;
    if (JSON.stringify(merged) === JSON.stringify(next[i])) return;
    next[i] = ['anchor', 'dx', 'dy', 'w', 'h'].some(k => Object.hasOwn(patch, k)) ? reanchorCellDrawing(sheet, merged) : merged;
    this._setCharts(sheet, next, label);
  }

  /**
   * Change a SmartArt diagram (see smartart.js): its outline, layout, colours, style or shapes' formatting.
   * With `merge`, a change following one with the same key within a few seconds joins its undo step, so the
   * words typed into one item of the Text Pane undo together rather than letter by letter.
   */
  updateSmartArt(sheetId, id, patch, label = 'Edit SmartArt', { merge = null } = {}) {
    const before = this._history.at(-1);
    const ch = this.chartById(sheetId, id);
    if (ch?.type !== 'smartart') return false;
    // A diagram another program drew is shown as it left it until it is changed here.
    this.updateChart(sheetId, id, { ...patch, ...(ch.fallback && !Object.hasOwn(patch, 'fallback') ? { fallback: null } : {}) }, label);
    if (this._group) return true;
    const after = this._history.at(-1);
    if (after === before || !after) return false;
    const now = Date.now();
    if (merge && before?.smartArtMerge === `${sheetId}|${id}|${merge}` && now - before.smartArtAt < 4000) {
      this._history.pop();
      before.redo = after.redo;
      before.smartArtAt = now;
    } else if (merge) {
      after.smartArtMerge = `${sheetId}|${id}|${merge}`;
      after.smartArtAt = now;
    }
    return true;
  }

  /** Ignore Error: the error-checking rule `key` is acknowledged for these cells (saved as <ignoredErrors>). One undo step. */
  ignoreErrors(sheetId, ranges, key) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !ranges.length) return false;
    const prev = sheet.ignoredErrors;
    const next = compactRangeFlags([...prev, ...ranges.map((range) => ({ range: normalizeRange(range), keys: [key] }))]);
    const apply = (list) => { const live = this.sheet(sheetId); if (!live) return; live.ignoredErrors = list; this.dirty = true; this._changed('cells', sheetId); };
    apply(next);
    this._push({ label: 'Ignore error', undo: () => apply(prev), redo: () => apply(next) });
    return true;
  }

  /** Bring to Front ('front'), Send to Back ('back'), Bring Forward ('forward') or Send Backward ('backward'). */
  orderChart(sheetId, id, where) {
    const sheet = this.sheet(sheetId);
    const i = sheet ? sheet.charts.findIndex((ch) => ch.id === id) : -1;
    if (i < 0 || this._locked(sheet)) return false;
    const next = sheet.charts.slice();
    const [obj] = next.splice(i, 1);
    const to = { front: next.length, back: 0, forward: Math.min(next.length, i + 1), backward: Math.max(0, i - 1) }[where];
    if (to == null || to === i) return false;
    next.splice(to, 0, obj);
    this._setCharts(sheet, next, where === 'front' || where === 'forward' ? 'Bring to front' : 'Send to back');
    return true;
  }

  /* ---------- Arrange: drawing objects' order, place, groups, visibility and names (see arrange.js) ---------- */

  /** Pixels before line `count` along an axis at 100% zoom, hidden lines counting nothing. */
  _lineOffset(sheet, axis, count) {
    const row = axis === 'row';
    const sizes = row ? sheet.rowHeights : sheet.colWidths, fallback = row ? sheet.defaultRowHeight : sheet.defaultColWidth;
    let pixels = count * fallback;
    for (const [i, size] of sizes) if (i < count) pixels += size - fallback;
    const hidden = row ? new Set([...sheet.hiddenRows, ...sheet.filterHidden]) : sheet.hiddenCols;
    for (const i of hidden) if (i < count) pixels -= sizes.get(i) ?? fallback;
    return pixels;
  }

  /** Where an object sits on its sheet, { id, x, y, w, h } in pixels at 100% zoom from the sheet's corner. */
  objectRect(sheetId, id) {
    const sheet = this.sheet(sheetId), ch = sheet?.charts.find((o) => o.id === id);
    if (!ch) return null;
    if (sheet.kind === 'chart') return { id, x: ch.dx, y: ch.dy, w: ch.w, h: ch.h };
    return { id, x: this._lineOffset(sheet, 'col', ch.anchor.c) + ch.dx, y: this._lineOffset(sheet, 'row', ch.anchor.r) + ch.dy, w: ch.w, h: ch.h };
  }

  /** Apply several objects' patches (place, size, state) as one undo step, as updateChart applies one. */
  _patchObjects(sheet, patches, label) {
    if (this._locked(sheet) || !patches.size) return false;
    let changed = false;
    const next = sheet.charts.map((ch) => {
      const patch = patches.get(ch.id);
      if (!patch) return ch;
      const merged = absoluteDrawingAnchor(sheet, normalizeChart({ ...ch, ...patch, id: ch.id, range: ch.range, anchor: patch.anchor || ch.anchor }));
      if (!merged || JSON.stringify(merged) === JSON.stringify(ch)) return ch;
      changed = true;
      return ['anchor', 'dx', 'dy', 'w', 'h'].some((k) => Object.hasOwn(patch, k)) ? reanchorCellDrawing(sheet, merged) : merged;
    });
    if (!changed) return false;
    this._setCharts(sheet, next, label);
    return true;
  }

  /** Move objects so their top-left corners land at { id, x, y } (pixels at 100% zoom), re-anchored to the cells there. One undo step. */
  placeObjects(sheetId, places, label = 'Move objects') {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const patches = new Map();
    for (const { id, x, y } of places) {
      const ch = sheet.charts.find((o) => o.id === id), at = this.objectRect(sheetId, id);
      if (!ch || !at || (Math.abs(x - at.x) < 1e-6 && Math.abs(y - at.y) < 1e-6)) continue;
      if (sheet.kind === 'chart') { patches.set(id, { dx: Math.max(0, x), dy: Math.max(0, y) }); continue; }
      const col = placeAlong((c) => this.colWidth(sheet.id, c), sheet.cols, ch.anchor.c, ch.dx + (x - at.x), ch.w || 1);
      const row = placeAlong((r) => this.rowHeight(sheet.id, r), sheet.rows, ch.anchor.r, ch.dy + (y - at.y), ch.h || 1);
      patches.set(id, { anchor: { r: row.index, c: col.index }, dx: col.offset, dy: row.offset });
    }
    return this._patchObjects(sheet, patches, label);
  }

  /** Align the objects named (left, center, right, top, middle, bottom) or distribute them ('horizontal', 'vertical'). One undo step. */
  alignObjects(sheetId, ids, how) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    // A group aligns as one unit, the box around its members, which keep their places within it.
    const units = new Map();
    for (const id of withGroups(sheet.charts, ids)) {
      const ch = sheet.charts.find((o) => o.id === id), rect = this.objectRect(sheetId, id);
      if (!rect) continue;
      const key = ch.group || id;
      if (!units.has(key)) units.set(key, []);
      units.get(key).push(rect);
    }
    const boxes = [...units].map(([id, rects]) => ({ id, ...boundsOf(rects) }));
    const moved = new Map((['horizontal', 'vertical'].includes(how) ? distributeRects(boxes, how) : alignRects(boxes, how)).map((p) => [p.id, p]));
    const places = boxes.flatMap((box) => units.get(box.id).map((r) => ({ id: r.id, x: r.x + moved.get(box.id).x - box.x, y: r.y + moved.get(box.id).y - box.y })));
    const labels = { left: 'Align left', center: 'Align center', right: 'Align right', top: 'Align top', middle: 'Align middle', bottom: 'Align bottom', horizontal: 'Distribute horizontally', vertical: 'Distribute vertically' };
    return this.placeObjects(sheetId, places, labels[how] || 'Align');
  }

  /** Bring to Front ('front'), Bring Forward ('forward'), Send Backward ('backward') or Send to Back ('back') several objects at once (whole groups). */
  orderObjects(sheetId, ids, where) {
    const sheet = this.sheet(sheetId);
    if (!sheet || this._locked(sheet)) return false;
    const next = orderObjects(sheet.charts, ids, where);
    if (next.every((ch, i) => ch === sheet.charts[i])) return false;
    this._setCharts(sheet, next, { front: 'Bring to front', forward: 'Bring forward', backward: 'Send backward', back: 'Send to back' }[where]);
    return true;
  }

  /** The Selection Pane's drag: put an object (its whole group) at place `to` in the stacking order, counted from the back. */
  moveObjectInOrder(sheetId, id, to) {
    const sheet = this.sheet(sheetId);
    if (!sheet || this._locked(sheet) || !sheet.charts.some((ch) => ch.id === id)) return false;
    const next = moveObjectTo(sheet.charts, id, to);
    if (next.every((ch, i) => ch === sheet.charts[i])) return false;
    this._setCharts(sheet, next, 'Reorder objects');
    return true;
  }

  /** Group the objects named into one; returns the group's id. One undo step. */
  groupObjects(sheetId, ids) {
    const sheet = this.sheet(sheetId);
    if (!sheet || this._locked(sheet)) return null;
    const group = `g${newId().replace(/[^\w]/g, '').slice(0, 24)}`;
    const next = groupObjects(sheet.charts, ids, group);
    if (!next) return null;
    this._setCharts(sheet, next, 'Group');
    return group;
  }

  /** Ungroup the groups of the objects named, remembering the last one for Regroup. One undo step. */
  ungroupObjects(sheetId, ids) {
    const sheet = this.sheet(sheetId);
    if (!sheet || this._locked(sheet)) return false;
    const groups = new Set(sheet.charts.filter((ch) => ids.includes(ch.id) && ch.group).map((ch) => ch.group));
    const next = ungroupObjects(sheet.charts, ids);
    if (!next) return false;
    const last = [...groups].at(-1);
    (this._ungrouped ||= new Map()).set(sheetId, { group: last, ids: sheet.charts.filter((ch) => ch.group === last).map((ch) => ch.id) });
    this._setCharts(sheet, next, 'Ungroup');
    return true;
  }

  /** Regroup: the group last ungrouped on this sheet, if its objects are all still there and ungrouped. */
  canRegroup(sheetId) {
    const last = this._ungrouped?.get(sheetId), sheet = this.sheet(sheetId);
    return !!last && last.ids.length > 1 && last.ids.every((id) => sheet?.charts.some((ch) => ch.id === id && !ch.group));
  }

  regroupObjects(sheetId) {
    if (!this.canRegroup(sheetId)) return null;
    const { ids } = this._ungrouped.get(sheetId);
    this._ungrouped.delete(sheetId);
    return this.groupObjects(sheetId, ids);
  }

  /** Rotate Right or Left 90°, Flip Vertical or Horizontal the objects named that can turn (pictures, shapes, text boxes). */
  rotateObjects(sheetId, ids, op) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const patches = new Map(sheet.charts.filter((ch) => ids.includes(ch.id) && canRotate(ch)).map((ch) => [ch.id, rotatePatch(ch, op)]));
    return this._patchObjects(sheet, patches, { right: 'Rotate right', left: 'Rotate left', flipH: 'Flip horizontal', flipV: 'Flip vertical' }[op] || 'Rotate');
  }

  /** Show or hide objects (the Selection Pane's eye; Show All and Hide All). One undo step. */
  setObjectsHidden(sheetId, ids, hidden) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const patches = new Map(sheet.charts.filter((ch) => ids.includes(ch.id) && !!ch.hidden !== !!hidden).map((ch) => [ch.id, { hidden: !!hidden }]));
    return this._patchObjects(sheet, patches, hidden ? 'Hide objects' : 'Show objects');
  }

  /** The Selection Pane's rename: an object's own name (empty gives it back its default one). */
  renameObject(sheetId, id, name) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    return this._patchObjects(sheet, new Map([[id, { name: String(name ?? '').trim().slice(0, OBJECT_NAME_MAX) }]]), 'Rename object');
  }

  /** Delete several objects at once, as one undo step. */
  deleteObjects(sheetId, ids) {
    const sheet = this.sheet(sheetId);
    if (!sheet || this._locked(sheet) || !sheet.charts.some((ch) => ids.includes(ch.id))) return false;
    this._setCharts(sheet, sheet.charts.filter((ch) => !ids.includes(ch.id)), ids.length === 1 ? `Delete ${objectNoun(sheet.charts.find((ch) => ch.id === ids[0]))}` : 'Delete objects');
    return true;
  }

  deleteChart(sheetId, id) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheet.charts.some((ch) => ch.id === id)) return false;
    if (this._locked(sheet)) return false;
    this._setCharts(sheet, sheet.charts.filter((ch) => ch.id !== id), `Delete ${objectNoun(sheet.charts.find((ch) => ch.id === id))}`);
    return true;
  }

  /* ---------- Conditional formatting ---------- */

  _setRules(sheet, next, label) {
    if (this._gridLocked(sheet)) return false;
    const prev = sheet.rules;
    const apply = (list) => { const live = this.sheet(sheet.id) || sheet; live.rules = list; this._changed('cells', live.id); };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
    return true;
  }

  /** Add a rule; returns its id. */
  addRule(sheetId, rule) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const id = newId();
    const full = { ...rule, id, range: normalizeRange(rule.range), style: cloneStyle(rule.style) };
    return this._setRules(sheet, [...sheet.rules, full], 'Add rule') ? id : null;
  }

  updateRule(sheetId, id, patch) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const i = sheet.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    const next = sheet.rules.slice();
    const merged = { ...next[i], ...patch, id, range: normalizeRange(patch.range || next[i].range) };
    for (const key of [...BAR_FORMULAS, ...SCALE_FORMULAS, ...ICON_FORMULAS]) if (Object.hasOwn(patch, key) && !Object.hasOwn(patch, `${key}Type`) && patch[key] !== next[i][key]) delete merged[`${key}Type`];
    if (patch.range && [...BAR_FORMULAS, ...SCALE_FORMULAS, ...ICON_FORMULAS].some(key => merged[`${key}Type`])
      && next[i].statisticsRange === duplicateSourceFormula([next[i].range])) merged.statisticsRange = duplicateSourceFormula([merged.range]);
    // A rule that carries no style at all keeps none: writing one in would have been a change of its own.
    const style = patch.style || next[i].style;
    if (style) merged.style = cloneStyle(style); else delete merged.style;
    next[i] = merged;
    if (sameRule(sheet.rules[i], merged, RULE_DEFAULTS)) return true; // nothing changed: no step, as updateChart
    return this._setRules(sheet, next, 'Edit rule');
  }

  /** Edit all adjacent pieces of a logical rule in one reversible operation. */
  setRuleAreas(sheetId, id, patch, areas) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !areas?.length) return false;
    const group = id && conditionalRuleGroups(sheet.rules).find(group => group.rules.some(rule => rule.id === id));
    if (id && !group) return false;
    const originals = group?.rules || [], original = group?.rule;
    const normalized = areas.map(normalizeRange);
    const unchangedAreas = originals.length === normalized.length && originals.every((rule, i) => sameJSON(rule.range, normalized[i]));
    const ranges = unchangedAreas ? normalized : distinctConditionalRanges(normalized);
    const base = { ...original, ...patch, range: ranges[0] };
    if (base.type === 'formula' && original?.type === 'formula'
      && String(base.value).trim().replace(/^=/, '').trim() === String(original.value).trim().replace(/^=/, '').trim()) base.value = original.value;
    for (const key of [...BAR_FORMULAS, ...SCALE_FORMULAS, ...ICON_FORMULAS]) if (Object.hasOwn(patch, key) && !Object.hasOwn(patch, `${key}Type`) && patch[key] !== original?.[key]) delete base[`${key}Type`];
    if (base.style) base.style = cloneStyle(base.style);
    if (original && unchangedAreas && sameRule(original, base, RULE_DEFAULTS)) return true;
    const pieces = conditionalGroupPieces(base, originals, ranges, sheet.name, newId);
    if (originals.length === pieces.length && originals.every((rule, i) => sameRule(rule, pieces[i], RULE_DEFAULTS))) return true;
    const start = original ? sheet.rules.indexOf(original) : sheet.rules.length;
    const next = [...sheet.rules.slice(0, start), ...pieces, ...sheet.rules.slice(start + originals.length)];
    return this._setRules(sheet, next, original ? 'Edit rule' : 'Add rule');
  }

  deleteRuleGroup(sheetId, id) {
    const sheet = this.sheet(sheetId), group = sheet && conditionalRuleGroups(sheet.rules).find(group => group.rules.some(rule => rule.id === id));
    if (!group) return false;
    const ids = new Set(group.rules.map(rule => rule.id));
    return this._setRules(sheet, sheet.rules.filter(rule => !ids.has(rule.id)), 'Delete rule');
  }

  moveRuleGroup(sheetId, id, delta) {
    const sheet = this.sheet(sheetId); if (!sheet) return false;
    const groups = conditionalRuleGroups(sheet.rules), i = groups.findIndex(group => group.rules.some(rule => rule.id === id)), j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= groups.length) return false;
    [groups[i], groups[j]] = [groups[j], groups[i]];
    return this._setRules(sheet, groups.flatMap(group => group.rules), 'Reorder rules');
  }

  deleteRule(sheetId, id) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheet.rules.some((r) => r.id === id)) return false;
    return this._setRules(sheet, sheet.rules.filter((r) => r.id !== id), 'Delete rule');
  }

  /** Move a rule earlier (delta < 0) or later in the list; where rules overlap, the earlier one wins. */
  moveRule(sheetId, id, delta) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const i = sheet.rules.findIndex((r) => r.id === id);
    const j = i + (delta < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= sheet.rules.length) return false;
    const next = [...sheet.rules];
    [next[i], next[j]] = [next[j], next[i]];
    return this._setRules(sheet, next, 'Reorder rules');
  }

  /**
   * Stored and spilled values in a range, without scanning empty grid cells. A whole-column range
   * spans a million rows: it is clamped to the rows and columns holding content, and read by
   * coordinate when that is fewer cells than the sheet stores, so six whole-column rules on a
   * 200,000-cell sheet no longer walk every cell of it six times after every edit.
   */
  *_rangeValues(sheet, range) {
    const inside = (r, c) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
    const bounds = this._cellBounds(sheet);
    const { r1, c1 } = range;
    const r2 = Math.min(range.r2, bounds.r2);
    const c2 = Math.min(range.c2, bounds.c2);
    if (r2 >= r1 && c2 >= c1) {
      if ((r2 - r1 + 1) * (c2 - c1 + 1) < sheet.cells.size) {
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const cell = sheet.cells.get(cellKey(r, c));
            if (cell && (cell.v != null || cell.f != null)) yield this._compute(sheet, r, c);
          }
        }
      } else {
        for (const [key, cell] of sheet.cells) {
          if (cell.v == null && cell.f == null) continue;
          const { r, c } = parseKey(key);
          if (r >= r1 && r <= r2 && c >= c1 && c <= c2) yield this._compute(sheet, r, c);
        }
      }
    }
    for (const { r, c, value } of this.spillEntries(sheet.id)) {
      if (inside(r, c)) yield value;
    }
  }

  /**
   * What a scan of `range` found: from this version when it has been asked for already, from an earlier
   * version when no change since could have reached the values it read, and otherwise by scanning now.
   *
   * A colour scale, data bar, icon set, top/bottom or duplicate rule reads its whole range to paint one
   * cell, and the grid asks for the first cell of every frame after every edit, so a rule down a
   * 19,000-row column re-read 152,000 cells for one keystroke anywhere in the book. Only a range of plain
   * values on a sheet where nothing spills can be judged from the record of changes: what a formula shows
   * depends on cells the record says nothing about, and a spill can reach into a range from anywhere.
   */
  _scanRange(sheet, range, key, scan) {
    if (this._statsCache.has(key)) return this._statsCache.get(key);
    // Kept apart from _statsCache, which every change empties; this record is weighed against changesSince.
    const kept = (this._scanCache ??= new Map()).get(key);
    let value;
    if (kept && kept.constant && this._nothingReached(sheet, range, kept.version)) {
      kept.version = this.version; // weighed up to here, so a later lookup weighs only what comes after
      value = kept.value;
    } else {
      value = scan();
      // One entry per rule range per sheet, so the record stays as small as the book's rules; a book that
      // somehow names more ranges than that starts it again rather than letting it grow without end.
      if (this._scanCache.size > 1024) this._scanCache.clear();
      this._scanCache.set(key, { version: this.version, constant: this._rangeIsConstant(sheet, range), value });
    }
    this._statsCache.set(key, value);
    return value;
  }

  /** Whether no change since `version` could have moved a plain value in `range` on `sheet`. */
  _nothingReached(sheet, range, version) {
    const changes = this.changesSince(version);
    if (!changes) return false; // the record does not reach back that far, or a version moved outside it
    // A layout change — a width, a hidden row, a chart, a sheet grown by scrolling — moves no value.
    // Anything structural, and any name, may; so may a write on this sheet that covers the range, one
    // whose box was not recorded, and any formula written on it, whose result may spill into the range.
    return changes.every((e) => e.type === 'layout' || (e.type === 'cells' && (e.sheetId !== sheet.id
      || (!e.formula && !!e.box && (e.box.r2 < range.r1 || e.box.r1 > range.r2 || e.box.c2 < range.c1 || e.box.c1 > range.c2)))));
  }

  /** Whether `range` holds nothing but plain values, on a sheet where no array formula spills. */
  _rangeIsConstant(sheet, range) {
    if (this._ensureSpills(sheet).anchors.size) return false;
    const bounds = this._cellBounds(sheet);
    const { r1, c1 } = range;
    const r2 = Math.min(range.r2, bounds.r2);
    const c2 = Math.min(range.c2, bounds.c2);
    if (r2 < r1 || c2 < c1) return true;
    // Read by coordinate or off the store's own entries, whichever is the smaller walk, as _rangeValues is.
    if ((r2 - r1 + 1) * (c2 - c1 + 1) < sheet.cells.size) {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (sheet.cells.get(cellKey(r, c))?.f != null) return false;
      return true;
    }
    for (const [key, cell] of sheet.cells) {
      if (cell.f == null) continue;
      const { r, c } = parseKey(key);
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) return false;
    }
    return true;
  }

  /** Min and max of the numbers in a range, kept until a change could have reached them. */
  _rangeStats(sheet, range) {
    const key = `${sheet.id}|${range.r1},${range.c1},${range.r2},${range.c2}`;
    return this._scanRange(sheet, range, key, () => {
      let min = Infinity;
      let max = -Infinity;
      for (const v of this._rangeValues(sheet, range)) {
        if (typeof v === 'number' && Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      }
      return min === Infinity ? null : { min, max };
    });
  }

  /** How often each value occurs in a range (for duplicate rules), kept until a change could have reached it. */
  _rangeCounts(sheet, range) {
    const key = `counts|${sheet.id}|${range.r1},${range.c1},${range.r2},${range.c2}`;
    return this._scanRange(sheet, range, key, () => {
      const counts = new Map();
      for (const value of this._rangeValues(sheet, range)) {
        const id = valueIdentity(value);
        if (id != null) counts.set(id, (counts.get(id) || 0) + 1);
      }
      return counts;
    });
  }

  /** Native duplicates share statistics across every area of their saved sqref,
   * including overlapping/repeated areas. Scan only stored and spilled values.
   */
  _nativeDuplicateCounts(sheet, source) {
    const key = `nativeDuplicates|${sheet.id}|${getLocale()}|${source}`;
    if (!this._statsCache.has(key)) {
      const refs = duplicateSourceAreas(source), areas = [];
      let valid = !!refs?.length;
      for (const ref of refs || []) {
        const target = ref.sheet ? this.sheetByName(ref.sheet) : sheet;
        if (!target) { valid = false; break; }
        const areaKey = `duplicateArea|${target.id}|${ref.r1},${ref.c1},${ref.r2},${ref.c2}`;
        areas.push(this._scanRange(target, ref, areaKey, () => duplicateAreaStats(this._rangeValues(target, ref),
          (ref.r2 - ref.r1 + 1) * (ref.c2 - ref.c1 + 1))));
      }
      this._statsCache.set(key, valid ? new NativeDuplicateCounts(areas) : null);
    }
    return this._statsCache.get(key);
  }

  /** The numbers in a range, largest first (for top/bottom rules), kept until a change could have reached them. */
  _rangeNumbers(sheet, range) {
    const key = `numbers|${sheet.id}|${range.r1},${range.c1},${range.r2},${range.c2}`;
    return this._scanRange(sheet, range, key, () => {
      const list = [];
      for (const v of this._rangeValues(sheet, range)) {
        if (typeof v === 'number' && Number.isFinite(v)) list.push(v);
      }
      list.sort((a, b) => b - a);
      return list;
    });
  }

  /** Split paint regions share the same statistical domain after a partial paste. */
  _conditionalStatistics(sheet, rule, kind = 'stats') {
    const read = (target, range) => kind === 'counts' ? this._rangeCounts(target, range)
      : kind === 'numbers' ? this._rangeNumbers(target, range) : this._rangeStats(target, range);
    if (!rule.statisticsRange) return read(sheet, rule.range);
    const key = `conditionalScope|${sheet.id}|${kind}|${rule.statisticsRange}`;
    if (!this._statsCache.has(key)) {
      const refs = duplicateSourceAreas(rule.statisticsRange) || [], values = [];
      for (const ref of refs) {
        const target = ref.sheet ? this.sheetByName(ref.sheet) : sheet;
        if (target) values.push(read(target, ref));
      }
      let result;
      if (kind === 'counts') {
        result = new Map();
        for (const counts of values) for (const [id, count] of counts) result.set(id, (result.get(id) || 0) + count);
      } else if (kind === 'numbers') result = values.flat().sort((a, b) => b - a);
      else {
        result = null;
        for (const value of values) if (value) result = result ? { min: Math.min(result.min, value.min), max: Math.max(result.max, value.max) } : value;
      }
      this._statsCache.set(key, result);
    }
    return this._statsCache.get(key);
  }

  /**
   * Evaluate a rule's custom formula for a cell. The formula is written for
   * the top-left cell of the range; relative references shift with the cell,
   * as they would when copied.
   */
  evalRuleFormula(sheetId, formula, range, r, c, override = undefined, relativeNames = false) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const body = ruleFormulaBody(formula);
    if (!body) return null;
    const shifted = shiftFormula(body, r - range.r1, c - range.c1);
    const ast = this._astOrNull(shifted);
    if (!ast) return null;
    let ctx = this._context(sheet, r, c, false, relativeNames);
    if (override !== undefined) {
      // Validation of typed input: the formula sees the value about to be entered.
      const base = ctx;
      const mine = (name) => !name || sameSheetName(name, sheet.name);
      ctx = {
        ...base,
        getValue: (sheetName, rr, cc) => (mine(sheetName) && rr === r && cc === c ? override : base.getValue(sheetName, rr, cc)),
        getRangeValues: (ref) => {
          const values = base.getRangeValues(ref);
          if (!mine(ref.sheet) || r < ref.r1 || r > ref.r2 || c < ref.c1 || c > ref.c2) return values;
          // A whole-column or whole-row reference (COUNTIF(A:A,A1)=1, the no-duplicates rule) is read only
          // as far as the used range, and the cell being typed into is usually past it: the copy is padded
          // with blank cells up to that cell before it is patched. Every row is copied, since the empty rows
          // of a large read are one shared, frozen array (see _context).
          const rows = Math.max(values.length, r - ref.r1 + 1);
          const cols = Math.max(values[0]?.length ?? 0, c - ref.c1 + 1);
          const patched = [];
          for (let i = 0; i < rows; i++) {
            const row = values[i] ? values[i].slice() : [];
            while (row.length < cols) row.push(null);
            patched.push(row);
          }
          patched[r - ref.r1][c - ref.c1] = override;
          return patched;
        },
      };
    }
    try {
      if (!this._depth) resetArrayBudget(); // a rule is not charged for what an earlier rule or cell spent
      const v = evaluateFormula(ast, ctx);
      return isRange(v) ? scalar(v) : v;
    } catch {
      return null;
    }
  }

  /**
   * Style overrides from the rules covering (r, c), given its computed value.
   * The first matching app rule wins. Imported .xlsx rules combine styles
   * in priority order until a matching stop rule; a color scale supplies a fill.
   * `banding: false` leaves out the table's coat and alternating-colour rules,
   * whose fills belong to a row's place among the rows in view, not to the cell.
   */
  conditionalStyle(sheetId, r, c, value, { banding = true } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet || (!sheet.rules.length && !sheet.tables.length)) return null;
    // A table's look is the base coat: header colors, banded rows, a totals row; rules paint over it.
    let out = banding && sheet.tables.length ? this._tableStyleAt(sheet, r, c) : null;
    // The coat's own colour: once a rule paints another fill over it, the result is no longer the coat,
    // so the `coat` mark comes off and the cell's own fill no longer shows through.
    let coatBg = out?.bg;
    const done = (res) => {
      if (!res?.coat || sameFillColor(res.bg, coatBg)) return res;
      const { coat, ...rest } = res;
      return rest;
    };
    // What a scale, bar, or icon rule paints stays: a later rule adds only what is still free, so of two
    // rules in conflict the earlier one wins (see moveRule), while the table coat gives way to any rule.
    const painted = new Set();
    const paint = (patch) => { out = { ...(out || {}), ...patch }; for (const key of Object.keys(patch)) painted.add(key); };
    for (const rule of sheet.rules) {
      const g = rule.range;
      if (r < g.r1 || r > g.r2 || c < g.c1 || c > g.c2) continue;
      if (rule.type === 'scale') {
        const stats = this._conditionalStatistics(sheet, rule);
        let limits = null;
        const formulas = SCALE_FORMULAS.map(key => conditionalThresholdFormula(rule, key));
        // Explicit bounds are independent of whether their statistical domain
        // contains numbers. Resolve them (including formula errors) before
        // deciding whether this rule can paint the candidate.
        if (formulas.some(Boolean)) {
          const key = `scale|${sheet.id}|${JSON.stringify([rule.statisticsRange, ...formulas.map((formula, i) => [rule[`${SCALE_FORMULAS[i]}Type`], formula])])}|${g.r1},${g.c1},${g.r2},${g.c2}`;
          if (!this._statsCache.has(key)) {
            const defaults = [stats?.min, scaleMidpoint(stats?.min, stats?.max), stats?.max];
            const resolved = formulas.map((formula, i) => formula
              ? rule[`${SCALE_FORMULAS[i]}Type`] === 'num' && !conditionalThresholdIsFormula(rule, SCALE_FORMULAS[i]) ? Number(rule[SCALE_FORMULAS[i]])
                : this.evalRuleFormula(sheetId, formula, { r1: 0, c1: 0 }, 0, 0, undefined, true) : defaults[i]);
            if (!formulas[1]) resolved[1] = scaleMidpoint(resolved[0], resolved[2]);
            this._statsCache.set(key, resolved);
          }
          limits = this._statsCache.get(key);
        }
        const bg = scaleColor(rule, value, stats?.min, stats?.max, limits);
        if (bg && !painted.has('bg')) paint({ bg });
        continue;
      }
      if (rule.type === 'databar') {
        if (rule.barActiveFormula && !matchesRule({ type: 'formula' }, value, { formulaResult: this.evalRuleFormula(sheetId, rule.barActiveFormula, g, r, c, undefined, rule.relativeNames === true) })) continue;
        const stats = this._conditionalStatistics(sheet, rule);
        let limits = stats ? [stats.min, stats.max] : null;
        if (['legacy', 'extended'].includes(rule.barMode)) {
          const formulas = BAR_FORMULAS.map(key => conditionalThresholdFormula(rule, key));
          const key = `bar|${sheet.id}|${JSON.stringify([rule.statisticsRange, ...formulas.map((formula, i) => [rule[`${BAR_FORMULAS[i]}Type`], formula])])}|${g.r1},${g.c1},${g.r2},${g.c2}`;
          // Native numeric cfvo values can exceed Excel's formula-literal
          // ceiling; they are stored doubles, not expressions to parse.
          if (!this._statsCache.has(key)) this._statsCache.set(key, formulas.map((formula, i) => formula
            ? rule[`${BAR_FORMULAS[i]}Type`] === 'num' && !conditionalThresholdIsFormula(rule, BAR_FORMULAS[i]) ? Number(rule[BAR_FORMULAS[i]])
              : this.evalRuleFormula(sheetId, formula, { r1: 0, c1: 0 }, 0, 0, undefined, true) : limits?.[i]));
          limits = this._statsCache.get(key);
        }
        const bar = limits ? dataBar(rule, value, ...limits, sheet.rightToLeft) : null;
        if (bar && !painted.has('bar')) paint(bar);
        if (bar && ['legacy', 'extended'].includes(rule.barMode) && rule.stopIfTrue === true) break;
        continue;
      }
      if (rule.type === 'icons') {
        if (rule.iconActiveFormula && !matchesRule({ type: 'formula' }, value, { formulaResult: this.evalRuleFormula(sheetId, rule.iconActiveFormula, g, r, c, undefined, rule.relativeNames === true) })) continue;
        const stats = this._conditionalStatistics(sheet, rule);
        let limits = null;
        const nativeSet = NATIVE_ICON_SETS[rule.iconSet];
        if (nativeSet) {
          const keys = ICON_FORMULAS.slice(0, nativeIconCount(rule));
          const cacheKey = `icons|${sheet.id}|${JSON.stringify([rule.statisticsRange, g, ...keys.map(key => [rule[key], rule[`${key}Type`]])])}`;
          if (!this._statsCache.has(cacheKey)) this._statsCache.set(cacheKey, keys.map(key => {
            const type = rule[`${key}Type`], n = Number(rule[key]);
            if (type === 'num' && Number.isFinite(n)) return n;
            if (type === 'percent' && stats && Number.isFinite(n)) {
              const span = stats.max - stats.min;
              return Number.isFinite(span) ? stats.min + span * (n / 100) : NaN;
            }
            const formula = conditionalThresholdFormula(rule, key);
            return formula ? this.evalRuleFormula(sheetId, formula, { r1: 0, c1: 0 }, 0, 0, undefined, true) : null;
          }));
          limits = this._statsCache.get(cacheKey);
        }
        const ic = nativeSet ? nativeIconFor(rule, value, limits) : stats ? iconFor(rule, value, stats.min, stats.max) : null;
        if (ic && !painted.has('icon')) paint(ic);
        if (ic && nativeSet && rule.stopIfTrue === true) break;
        continue;
      }
      if (rule.type === 'bands') {
        // Banding is the base coat: later rules paint over it. It alternates over the visible rows.
        const source = rule.bandOrigin && duplicateSourceAreas(rule.bandOrigin)?.[0] || g;
        const band = banding ? bandColor(rule, r, this._visibleOrdinal(sheet, source.r1, source.r2, r)) : null;
        if (band && !out?.bg) { out = { ...(out || {}), ...band, coat: true }; coatBg = band.bg; }
        continue;
      }
      const ctx = {};
      if (rule.type === 'dup' || rule.type === 'unique') {
        if (rule.duplicateRange != null) ctx.nativeCount = this._nativeDuplicateCounts(sheet, rule.duplicateRange)?.count(value);
        else ctx.counts = this._conditionalStatistics(sheet, rule, 'counts');
      }
      else if (rule.type === 'top' || rule.type === 'bottom') ctx.numbers = this._conditionalStatistics(sheet, rule, 'numbers');
      else if (rule.type === 'formula') ctx.formulaResult = this.evalRuleFormula(sheetId, rule.value, g, r, c, undefined, rule.relativeNames === true);
      if (matchesRule(rule, value, ctx)) {
        const style = { ...rule.style };
        for (const key of painted) delete style[key];
        paint(style);
        // Imported rules combine non-conflicting formats in priority order unless a
        // matching rule stops evaluation. App-authored rules keep first-match behavior.
        if (rule.stopIfTrue !== false) return done(out);
      }
    }
    return done(out);
  }

  /* ---------- Tables ---------- */

  _tableStyleAt(sheet, r, c, own = this.styleAt(sheet.id, r, c), visibleOrdinal = undefined) {
    const t = sheet.tables.find((x) => r >= x.range.r1 && r <= x.range.r2 && c >= x.range.c1 && c <= x.range.c2);
    if (!t || t.style === 'none') return null;
    const look = themedTableLook(t.style, tableStyle(t.style), this);
    const normalColor = this.normalFont ? fontColorInPalette(this.normalFont.color || 'windowtext', this.colorPalette) : DEFAULT_FONT_COLOR;
    const withTextColor = out => {
      if (own && Object.hasOwn(own, 'color')) {
        const color = own.color === null ? 'windowtext' : fontColorInPalette(own.color, this.colorPalette);
        if (!sameFontColor(color, normalColor)) out.color = color;
      }
      return out;
    };
    const rows = tableRows(t);
    if (t.customStyle) {
      const ordinal = t.banded ? visibleOrdinal ?? this._visibleOrdinal(sheet, rows.dataStart, rows.dataEnd, r) : -1;
      const firstSize = t.customStyle.firstRowStripe?.stripeSize || 1, secondSize = t.customStyle.secondRowStripe?.stripeSize || 1;
      const stripe = ordinal < 0 ? 0 : ordinal % (firstSize + secondSize) < firstSize ? 1 : 2;
      // Every table cell has one of a small, bounded set of coats. Share their
      // layered edge paints until the workbook changes, including filtering.
      const position = Number(r === t.range.r1) + 2 * Number(r === t.range.r2)
        + 4 * Number(r === rows.dataStart) + 8 * Number(r === rows.dataEnd);
      const key = position * 12 + (Number(c === t.range.c1) + 2 * Number(c === t.range.c2)) * 3 + stripe;
      const cacheKey = `table-style|${sheet.id}|${t.id}`;
      let cache = this._statsCache.get(cacheKey);
      if (!cache) { cache = new Map(); this._statsCache.set(cacheKey, cache); }
      if (!cache.has(key)) cache.set(key, customTableStyleAt(t, r, c, ordinal));
      const out = { ...cache.get(key), coat: true };
      // Explicit cell text formatting wins over the table's text formatting. Fills carry `coat`
      // so renderers also keep direct fills, while conditional rules can still override either.
      // Null clears an inherited row/column format back to the cell default;
      // it does not turn off the table's differential font. A concrete false
      // still represents an intentional bold override.
      for (const key of ['bold', 'italic', 'underline', 'strike', 'font']) if (own?.[key] != null) out[key] = own[key];
      // A table's text color applies unless the cell font differs from
      // Normal in native color identity, not merely in its resolved RGB paint.
      withTextColor(out);
      for (const key of ['bt', 'bb', 'bl', 'br']) if (own && Object.hasOwn(own, key)) {
        out[key] = own[key];
        out[`${key}Border`] = own[key] ? own[`${key}Border`] || { bs: own.bs, bc: own.bc } : null;
      }
      return out;
    }
    // `coat` marks a fill that is the table's own coat, which a cell's own fill lies over; a rule's fill does not carry it.
    if (r === rows.header) return withTextColor({ bg: look.header, color: look.headerText, bold: true, coat: true });
    if (rows.totals != null && r === rows.totals) return withTextColor({ bg: look.total, bold: true, coat: true });
    const out = {};
    if (t.banded && (visibleOrdinal ?? this._visibleOrdinal(sheet, rows.dataStart, rows.dataEnd, r)) % 2 === 0) out.bg = look.band;
    // Banded Columns: every other column from the first takes the stripe colour too, under the row stripes.
    if (t.bandedColumns && !out.bg && (c - t.range.c1) % 2 === 0) out.bg = look.band;
    if (t.firstColumn && c === t.range.c1 || t.lastColumn && c === t.range.c2) out.bold = own?.bold ?? true;
    return Object.keys(out).length ? withTextColor({ ...out, coat: true }) : null;
  }

  /**
   * A row's place among the visible rows of a span (-1 when it is hidden itself), so bands keep
   * alternating over the rows people see once a filter or hidden rows take some away. The map is
   * built once per version and hidden set, since the grid asks for every cell it draws.
   */
  _visibleOrdinal(sheet, r1, r2, r) {
    if (!sheet.filterHidden.size && !sheet.hiddenRows.size) return r - r1;
    const key = `visible|${sheet.id}|${r1},${r2}`;
    let entry = this._statsCache.get(key);
    if (!entry || entry.hidden !== sheet.filterHidden) {
      const map = new Map();
      let i = 0;
      // Rows past the sheet's end are never drawn, so a whole-column span stops there.
      for (let rr = r1, end = Math.min(r2, sheet.rows - 1); rr <= end; rr++) if (!sheet.filterHidden.has(rr) && !sheet.hiddenRows.has(rr)) map.set(rr, i++);
      entry = { hidden: sheet.filterHidden, map };
      this._statsCache.set(key, entry);
    }
    return entry.map.get(r) ?? -1;
  }

  _setTables(sheet, next, label) {
    if (this._gridLocked(sheet)) return;
    this._writeTables(sheet, next, label);
  }

  /** Record authorized table metadata changes; user edits go through _setTables. */
  _writeTables(sheet, next, label) {
    const prev = sheet.tables;
    const apply = (list) => { const live = this.sheet(sheet.id) || sheet; live.tables = list; this._changed('cells', live.id); };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  tablesOn(sheetId) {
    return this.sheet(sheetId)?.tables || [];
  }

  /** The last row the grid draws: rows a table adds below it must stop there, not at the file format's grid. */
  _lastGridRow(sheet) {
    return Math.max(sheet.rows, MAX_ROWS) - 1;
  }

  tableById(sheetId, id) {
    return this.sheet(sheetId)?.tables.find((t) => t.id === id) || null;
  }

  /** The table by name, anywhere in the workbook: { sheet, table } or null. */
  tableByName(name) {
    const key = String(name ?? '').trim().toLowerCase();
    for (const sheet of this.sheets) {
      const table = sheet.tables.find((t) => t.name.toLowerCase() === key);
      if (table) return { sheet, table };
    }
    return null;
  }

  tableAt(sheetId, r, c) {
    return this.sheet(sheetId)?.tables.find((t) => r >= t.range.r1 && r <= t.range.r2 && c >= t.range.c1 && c <= t.range.c2) || null;
  }

  tableNames() {
    return this.sheets.flatMap((s) => s.tables.map((t) => t.name));
  }

  uniqueTableName() {
    const taken = new Set([...this.tableNames(), ...this.names.map((n) => n.name)].map((n) => n.toLowerCase()));
    for (let i = 1; ; i++) if (!taken.has(`table${i}`)) return `Table${i}`;
  }

  validateTableName(name, exceptName = null) {
    const tables = this.tableNames().filter((n) => n.toLowerCase() !== String(exceptName || '').toLowerCase());
    return validateTableName(name, [...tables, ...this.names.map((n) => n.name)]);
  }

  /** Header text defines a column name; number-format padding is presentation only. */
  _tableHeaderText(sheetId, r, c) {
    const value = this.getValue(sheetId, r, c);
    if (typeof value !== 'string') return this.getDisplay(sheetId, r, c);
    const style = this.styleAt(sheetId, r, c);
    if (style?.fmt !== 'custom' || !style.code) return value;
    // Literal text formats still rename the displayed header. Remove only
    // visual padding/fill directives, preserving quoted/escaped characters
    // and all whitespace belonging to the value or a literal label.
    const code = style.code.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, token => /^[*_]/.test(token) ? '' : token);
    return formatValue(value, { ...style, code });
  }

  /** Column names of a table from its header cells (Column1... when blank); a table with its Header Row off keeps them on itself. */
  tableColumns(sheetId, table) {
    if (table.headerRow === false) return headerlessTableColumns(table);
    const out = [];
    for (let c = table.range.c1; c <= table.range.c2; c++) {
      // Whitespace is significant: "Cost" and "Cost " can be distinct headers.
      const text = this._tableHeaderText(sheetId, table.range.r1, c);
      out.push(text || `Column${c - table.range.c1 + 1}`);
    }
    return out;
  }

  /** `relativeRows`: a [@Column] reference resolves on the formula's own row even in the header or totals row (a rule read row by row). */
  _resolveTableRef(sheet, cell, tableName, spec, { relativeRows = false } = {}) {
    let found;
    if (tableName) found = this.tableByName(tableName);
    else {
      const own = sheet.tables.find((t) => cell.r >= t.range.r1 && cell.r <= t.range.r2 && cell.c >= t.range.c1 && cell.c <= t.range.c2);
      found = own ? { sheet, table: own } : null;
    }
    if (!found) return err(tableName ? '#NAME?' : '#REF!');
    // A qualified table reference uses the caller's row even when its table
    // lives on another worksheet, just like @ on a cross-sheet cell range.
    const own = cell;
    const rows = tableRows(found.table);
    const anyRow = relativeRows && own && !rows.empty && parseTableSpec(spec)?.rows === 'this';
    const rect = resolveTableSpec(found.table, this.tableColumns(found.sheet.id, found.table), spec, anyRow ? { ...own, r: rows.dataStart } : own);
    if (rect.error) return err(rect.error);
    if (anyRow) { rect.r1 = own.r; rect.r2 = own.r; }
    const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
    return { sheet: found.sheet.name, kind: single ? 'cell' : 'range', ...rect };
  }

  /** The cells a structured reference names from a formula at (r, c) on a sheet: a ref with a sheet name, or an error value. */
  resolveTableRef(sheetId, r, c, tableName, spec) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return err('#REF!');
    return this._resolveTableRef(sheet, { r, c }, tableName, spec);
  }

  /**
   * Structured references as A1 text, optionally limited to a single table being converted.
   * `relativeRows`: a [@Column] reference keeps its row relative ($A2), for a rule or validation
   * formula that is read from each row of its range in turn.
   */
  structuredToA1(sheetId, r, c, formula, onlyTable = null, qualify = false, { relativeRows = false } = {}) {
    const tableNames = this.tableNames().filter((name) => !this.namedEntry(name, this.sheet(sheetId)?.name));
    if (!hasTableRefs(formula, tableNames)) return formula;
    const sheet = this.sheet(sheetId);
    return tableRefsToA1(formula, (table, spec) => {
      const ref = this._resolveTableRef(sheet, { r, c }, table, spec, { relativeRows });
      if (isError(ref)) return null;
      return { ...ref, sheet: !qualify && ref.sheet === sheet.name ? null : ref.sheet, relativeRows: relativeRows && parseTableSpec(spec)?.rows === 'this' };
    }, onlyTable ? (table) => (!qualify || !!table) && (table || this.tableAt(sheetId, r, c)?.name || '').toLowerCase() === onlyTable.toLowerCase() : null, tableNames);
  }

  /**
   * A range from text the way people type it into a range box: A1:B10,
   * Sheet2!A1:B10, a named range, a table name (its header and data), or
   * Table[Column]. Returns { sheetId, range } or null.
   */
  rangeFromText(sheetId, text) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const named = this.namedRef(t);
    if (named) { const target = this.sheetByName(named.sheet); return target ? { sheetId: target.id, range: { r1: named.r1, c1: named.c1, r2: named.r2, c2: named.c2 } } : null; }
    const found = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(t) ? this.tableByName(t) : null;
    // A bare table name stands for its header and data: the totals row is never data, so a chart, a pivot or
    // a rule given the name does not take the Total row for a row of it. Table[#All] still names every row.
    if (found) return { sheetId: found.sheet.id, range: { ...found.table.range, r2: tableRows(found.table).dataEnd } };
    try {
      const tokens = tokenize(t.toUpperCase() === t ? t : t);
      if (tokens.length === 1 && tokens[0].type === 'tref') {
        const ref = this._resolveTableRef(sheet, { r: 0, c: 0 }, tokens[0].table, tokens[0].spec);
        if (isError(ref)) return null;
        return { sheetId: this.sheetByName(ref.sheet)?.id ?? sheetId, range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 } };
      }
      if (tokens.length === 1 && tokens[0].type === 'ref') {
        // A:A or 3:5 covers the whole line to the grid's edge, where rules and protection stay anchored as lines come and go.
        const ref = parseRefText(tokens[0].text.toUpperCase(), tokens[0].sheet);
        if (!ref) return null;
        const target = ref.sheet ? this.sheetByName(ref.sheet) : sheet;
        return target ? { sheetId: target.id, range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 } } : null;
      }
    } catch { /* not a reference */ }
    return null;
  }

  /**
   * Make a table of a range. The first row is the header; blank header cells
   * get Column1, Column2, ... names. A filter covers the header and data.
   * opts: { name, totalsRow, style, banded }
   */
  addTable(sheetId, range, opts = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    if (this._gridLocked(sheet)) return null;
    const n = normalizeRange(range);
    if (!validStoredRange(n) || n.r2 <= n.r1 || (opts.totalsRow && n.r2 >= this._lastGridRow(sheet))) return null;
    if (this._tablePivotEditBlocked(sheetId, n)) return null;
    // Totals make space above a report. Preflight that row before creating
    // headers so another report elsewhere cannot leave a partial operation.
    if (opts.totalsRow && this.tableRowOccupied(sheetId, { ...n, r1: n.r2 + 1, r2: n.r2 + 1 })
      && this.pivotLineEditBlocked(sheetId, 'row', n.r2 + 1, 1)) return null;
    const array = this._fixedArrays(sheet).overlapping({ ...n, r2: n.r2 + (opts.totalsRow ? 1 : 0) }).next().value;
    if (array) { this._arrayRefused(sheet, array, 'overlap'); return null; }
    if (sheet.tables.some((t) => !(n.r2 < t.range.r1 || n.r1 > t.range.r2 || n.c2 < t.range.c1 || n.c1 > t.range.c2))) return null;
    if (opts.totalsRow && this.lockedIn(sheetId, { r1: n.r2 + 1, r2: n.r2 + 1, c1: n.c1, c2: n.c2 })) return null;
    // Merged cells have no place in a table, where every row and column is its own: unmerge first.
    if (this.mergesIn(sheetId, n).length) return null;
    const name = opts.name && !this.validateTableName(opts.name) ? opts.name.trim() : this.uniqueTableName();
    const id = newId();
    // Shaped as the loader shapes a table (calc present, empty), so a book equals its reloaded self.
    const table = { id, name, range: n, totalsRow: false, style: typeof opts.style === 'string' ? opts.style : 'blue', banded: opts.banded !== false,
      ...(opts.firstColumn === true ? { firstColumn: true } : {}), ...(opts.lastColumn === true ? { lastColumn: true } : {}), calc: {} };
    // Every column needs a name of its own. A blank header takes the first free ColumnN, a
    // formula, number or date header becomes the text it shows (headers are text, so a
    // column's name does not change with its format or the regional settings), and a name
    // that repeats an earlier column's is numbered (Name, name2), as later renames do.
    const fixes = [];
    const headers = [];
    for (let c = n.c1; c <= n.c2; c++) headers.push({ c, cell: sheet.cells.get(cellKey(n.r1, c)), text: this._tableHeaderText(sheetId, n.r1, c) });
    // A header row an array formula spilled (={"Name","Qty"}) keeps its text: the whole spill becomes values
    // first, the part outside the table included, rather than vanishing when the anchor's formula is replaced.
    const spills = new Map();
    for (const { c, cell } of headers) {
      const anchor = cell?.f != null ? this.spillRangeAt(sheetId, n.r1, c) && { r: n.r1, c } : this.spillAt(sheetId, n.r1, c)?.anchor;
      if (anchor) spills.set(cellKey(anchor.r, anchor.c), anchor);
    }
    for (const { r, c } of spills.values()) {
      const spilled = this.spillRangeAt(sheetId, r, c);
      if (spilled && this.lockedIn(sheetId, spilled)) return null;
    }
    const present = new Set(headers.map(({ text }) => text.toLowerCase()).filter(Boolean));
    const seen = new Set();
    for (const { c, cell, text: shown } of headers) {
      let text = shown;
      const free = (name) => !seen.has(name.toLowerCase()) && !present.has(name.toLowerCase());
      if (!text) { let k = c - n.c1 + 1; while (!free(`Column${k}`)) k++; text = `Column${k}`; }
      else if (seen.has(text.toLowerCase())) { let k = 2; while (!free(`${text}${k}`)) k++; text = `${text}${k}`; }
      seen.add(text.toLowerCase());
      if (text !== shown || cell?.f != null || (cell?.v != null && typeof cell.v !== 'string')) fixes.push({ r: n.r1, c, cell: { v: text, f: null, s: cell?.s } });
    }
    if (fixes.some(({ r, c }) => this.lockedAt(sheetId, r, c))) return null;
    this.transaction('Create table', () => {
      for (const { r, c } of spills.values()) this.formulasToValues(sheetId, { r1: r, c1: c, r2: r, c2: c });
      if (fixes.length) this.setCells(sheetId, fixes, 'Create table');
      this._setTables(sheet, [...sheet.tables, table], 'Create table');
      // A filter already on exactly this range keeps its criteria and the rows it shows when
      // the list becomes a table. Other tables and the worksheet retain their filters.
      const prior = sheetFilters(sheet).find(f => sameFilterRange(f, { range: n }));
      const kept = !!prior && prior.range.r1 === n.r1 && prior.range.c1 === n.c1 && prior.range.r2 === n.r2 && prior.range.c2 === n.c2;
      const show = [];
      if (kept) for (let r = n.r1 + 1; r <= n.r2; r++) if (!sheet.filterHidden.has(r)) show.push(r);
      this._setFilter(sheet, { ...(kept ? prior : {}), range: { ...n }, criteria: kept ? { ...prior.criteria } : {} }, 'Create table', { create: true, ...(kept ? { show } : {}) });
      if (opts.totalsRow) this.setTableTotals(sheetId, id, true);
    });
    return id;
  }

  /** Rename, restyle, or toggle banding. A rename rewrites every formula that mentions the table. */
  updateTable(sheetId, id, patch) {
    const sheet = this.sheet(sheetId);
    const table = sheet?.tables.find((t) => t.id === id);
    if (!table || this._gridLocked(sheet)) return false;
    if (patch.totalsRow !== undefined && !!patch.totalsRow !== table.totalsRow) {
      const r = table.range.r2 + (patch.totalsRow ? 1 : 0);
      if (r > this._lastGridRow(sheet) || this.lockedIn(sheetId, { r1: r, r2: r, c1: table.range.c1, c2: table.range.c2 })) return false;
      if (patch.totalsRow && this.tableRowOccupied(sheetId, { ...table.range, r1: r, r2: r }, id)
        && this.pivotLineEditBlocked(sheetId, 'row', r, 1)) return false;
    }
    const next = { ...table };
    if (patch.style !== undefined) {
      next.style = String(patch.style);
      // An explicit gallery choice replaces an imported theme even when the fallback key matches.
      if (next.style !== table.style || patch.customStyle === null) delete next.customStyle;
    }
    if (patch.banded !== undefined) next.banded = !!patch.banded;
    for (const key of ['firstColumn', 'lastColumn', 'bandedColumns']) if (patch[key] !== undefined) {
      if (patch[key]) next[key] = true; else delete next[key];
    }
    let rename = null;
    if (patch.name !== undefined && patch.name.trim() !== table.name) {
      if (this.validateTableName(patch.name, table.name)) return false;
      rename = [table.name, patch.name.trim()];
      next.name = rename[1];
    }
    const totals = patch.totalsRow !== undefined && !!patch.totalsRow !== table.totalsRow;
    if (!rename && !totals && JSON.stringify(next) === JSON.stringify(table)) return true; // nothing changed: no step, as updateChart
    const previousPivots = this.nativePivots;
    const renamedPivots = rename ? renameNativePivotTableSource(previousPivots, ...rename,
      (name, scope) => !!this.namedEntry(name, scope)) : previousPivots;
    this.transaction('Edit table', () => {
      this._setTables(sheet, sheet.tables.map((t) => (t.id === id ? next : t)), 'Edit table');
      if (rename) {
        if (renamedPivots !== previousPivots) {
          const apply = value => { this.nativePivots = value; this._changed('pivots'); };
          apply(renamedPivots);
          this._push({ label: 'Rename table', undo: () => apply(previousPivots), redo: () => apply(renamedPivots) });
        }
        const includeBare = !this.names.some((n) => n.name.toLowerCase() === rename[0].toLowerCase());
        const bareBySheet = new Map(this.sheets.map((s) => [s.name, !this.namedEntry(rename[0], s.name)]));
        const rewrite = (f, scope) => renameTableInFormula(f, rename[0], rename[1], scope ? bareBySheet.get(scope) : includeBare);
        this._rewriteFormulas((f, s) => rewrite(f, s.name), 'Rename table');
        this._rewriteNamedFormulas((f, n) => rewrite(f, n.sheet), 'Rename table');
        this._rewriteRuleFormulas((f, s) => rewrite(f, s.name), 'Rename table');
      }
      if (patch.totalsRow !== undefined && !!patch.totalsRow !== table.totalsRow) this.setTableTotals(sheetId, id, !!patch.totalsRow);
    });
    return true;
  }

  /** Turn the totals row on (a "Total" label and SUBTOTAL(109, ...) under each numeric column) or off (its cells cleared). */
  setTableTotals(sheetId, id, on) {
    const sheet = this.sheet(sheetId);
    const table = sheet?.tables.find((t) => t.id === id);
    if (!table || this._gridLocked(sheet) || !!on === table.totalsRow) return;
    const targetRow = table.range.r2 + (on ? 1 : 0);
    if (targetRow > this._lastGridRow(sheet) || this.lockedIn(sheetId, { r1: targetRow, r2: targetRow, c1: table.range.c1, c2: table.range.c2 })) return;
    this.transaction(on ? 'Add totals row' : 'Remove totals row', () => {
      if (on) {
        const r = table.range.r2 + 1;
        // A totals row must not consume unrelated cells, a merged block, or another
        // table. Insert a whole row when needed so notes, layout, and references
        // move together, as they do when adding a data row above totals.
        const occupied = this.tableRowOccupied(sheetId, { ...table.range, r1: r, r2: r }, id);
        if (occupied && !this.insertRows(sheetId, r, 1)) return;
        const columns = this.tableColumns(sheetId, table);
        const rows = tableRows(table);
        const counts = new Map();
        const countValue = (c, value, style) => {
          if (value == null || value === '') return;
          const count = counts.get(c) || { filled: 0, numeric: 0 };
          count.filled++;
          // A date or time is a number underneath, but a sum of dates means nothing: a column of them
          // is not numeric here, so it gets no total and, as the first column, keeps the Total label.
          if (typeof value === 'number' && !dateTimeKind(style, value)) count.numeric++;
          counts.set(c, count);
        };
        // Infer numeric columns from actual content, not the possibly
        // enormous rectangle of empty cells in a sparse table.
        for (const [key, cell] of sheet.cells) {
          if (cell.v == null && cell.f == null) continue;
          const { r: rr, c } = parseKey(key);
          if (rr >= rows.dataStart && rr <= rows.dataEnd && c >= table.range.c1 && c <= table.range.c2) countValue(c, this.getValue(sheetId, rr, c), cell.s);
        }
        // Anchors were counted above. Only visit the intersecting part of
        // each spill, without allocating an entry for every spilled cell.
        for (const a of this._ensureSpills(sheet).anchors.values()) {
          const firstRow = Math.max(rows.dataStart, a.r), lastRow = Math.min(rows.dataEnd, a.r + a.rows - 1);
          const firstCol = Math.max(table.range.c1, a.c), lastCol = Math.min(table.range.c2, a.c + a.cols - 1);
          const spilled = a.fixed ? null : sheet.cells.get(cellKey(a.r, a.c))?.s;
          for (let rr = firstRow; rr <= lastRow; rr++) for (let c = firstCol; c <= lastCol; c++) {
            // A spilled cell shows in the anchor's format unless it has one of its own (see getDisplay).
            if (rr !== a.r || c !== a.c) countValue(c, this._arrayValue(a, rr - a.r, c - a.c), { ...(spilled || {}), ...(sheet.cells.get(cellKey(rr, c))?.s || {}) });
          }
        }
        const entries = [];
        for (let c = table.range.c1; c <= table.range.c2; c++) {
          const { numeric = 0, filled = 0 } = counts.get(c) || {};
          const fmt = {};
          const sample = sheet.cells.get(cellKey(rows.dataEnd, c))?.s;
          for (const k of ['fmt', 'dec', 'cur', 'group', 'code']) if (sample?.[k] != null && sample.fmt !== 'date' && sample.fmt !== 'datetime') fmt[k] = sample[k];
          if (c === table.range.c1 && !(filled && numeric >= filled / 2)) entries.push({ r, c, cell: { v: 'Total', f: null, s: undefined } });
          else if (filled && numeric >= filled / 2) {
            const column = columns[c - table.range.c1];
            const spec = renderTableSpec({ rows: 'data', cols: [column, column] });
            entries.push({ r, c, cell: { v: null, f: `SUBTOTAL(109,${table.name}[${spec}])`, s: Object.keys(fmt).length ? fmt : undefined } });
          }
        }
        const grown = { ...this.tableById(sheetId, id), totalsRow: true, range: { ...table.range, r2: r } };
        this._setTables(sheet, sheet.tables.map((t) => (t.id === id ? grown : t)), 'Add totals row');
        if (entries.length) this.setCells(sheetId, entries, 'Add totals row');
      } else {
        const r = table.range.r2;
        this.clearRange(sheetId, { r1: r, c1: table.range.c1, r2: r, c2: table.range.c2 });
        const shrunk = { ...table, totalsRow: false, range: { ...table.range, r2: r - 1 } };
        this._setTables(sheet, sheet.tables.map((t) => (t.id === id ? shrunk : t)), 'Remove totals row');
      }
    });
  }

  /** Convert to a plain range, retaining table formatting and rewriting structured references. */
  deleteTable(sheetId, id) {
    const sheet = this.sheet(sheetId);
    const table = sheet?.tables.find((t) => t.id === id);
    if (!table || this._gridLocked(sheet)) return;
    const appearance = tableConversionStyle(this, sheet, table);
    this.transaction('Convert table to range', () => {
      this._rewriteFormulas((f, s, r, c) => this.structuredToA1(s.id, r, c, f, table.name), 'Convert table to range');
      this._rewriteNamedFormulas((f) => this.structuredToA1(sheetId, tableRows(table).dataStart, table.range.c1, f, table.name, true), 'Convert table to range');
      // Conditional formats, validations, and filter conditions name the table too. Each reads
      // from its own top-left cell, and a [@Column] reference row by row, so those rows stay relative.
      this._rewriteRuleFormulas((f, s, rule) => this.structuredToA1(s.id, rule.range.r1, rule.range.c1, f, table.name, false, { relativeRows: true }), 'Convert table to range');
      this._setStyleResets(sheet, assignStyleExceptionRegions(sheet.styleResets, appearance.regions), 'Convert table to range');
      this._writeCells(sheet, appearance.cells.map(({ r, c, style }) => ({ r, c,
        cell: { ...sheet.cells.get(cellKey(r, c)), s: style } })), 'Convert table to range');
      this._setTables(sheet, sheet.tables.filter((t) => t.id !== id), 'Convert table to range');
      const filter = sheetFilters(sheet).find(f => f.range.r1 === table.range.r1 && f.range.c1 === table.range.c1 && f.range.c2 === table.range.c2);
      if (filter) this._setFilter(sheet, null, 'Convert table to range', { target: filter });
    });
  }

  /** Plan a footer move that preserves the order of the rows it passes. */
  _tableFooterMove(sheet, table, nextRange, onInvalid) {
    const from = table.range.r2, to = nextRange.r2;
    if (!table.totalsRow || from === to) return () => {};
    const c1 = Math.max(table.range.c1, nextRange.c1), c2 = Math.min(table.range.c2, nextRange.c2);
    if (c1 > c2) return () => {};
    const affected = { r1: Math.min(from, to), r2: Math.max(from, to), c1, c2 };
    if (this.lockedIn(sheet.id, affected)) return null;
    const mapRow = (r) => r === from ? to
      : from < to && r > from && r <= to ? r - 1
        : to < from && r >= to && r < from ? r + 1 : r;
    const mapRange = (range) => {
      if (!range || range.c1 < c1 || range.c2 > c2) return range;
      const points = [range.r1, range.r2, from - 1, from, from + 1, to - 1, to, to + 1]
        .filter((r) => r >= range.r1 && r <= range.r2).map(mapRow);
      return { ...range, r1: Math.min(...points), r2: Math.max(...points) };
    };
    const touches = (range) => range.r1 <= affected.r2 && range.r2 >= affected.r1 && range.c1 <= c2 && range.c2 >= c1;
    const staysTogether = (range) => {
      if (!touches(range)) return true;
      const moved = mapRange(range);
      return range.c1 >= c1 && range.c2 <= c2 && moved.r2 - moved.r1 === range.r2 - range.r1 && mapRow(range.r1) === moved.r1;
    };
    // Do not tear apart merges or array results while passing the footer
    // through data. Entire blocks that move together remain supported.
    if (sheet.merges.some((m) => !staysTogether(m))) { onInvalid?.('That resize would split merged cells.'); return null; }
    for (const a of this._ensureSpills(sheet).anchors.values()) {
      if (!staysTogether({ r1: a.r, r2: a.r + a.rows - 1, c1: a.c, c2: a.c + a.cols - 1 })) {
        onInvalid?.('That resize would split an array result.');
        return null;
      }
    }
    const moveRef = (ref) => {
      if (!touches(ref) || ref.kind === 'cols') return ref;
      // A footer passing through an A1 range can split its cells into two
      // areas. Keep those exact areas instead of including the footer in
      // a widened bounding box (which would create a circular reference).
      const cuts = [...new Set([ref.r1, ref.r2 + 1, from, from + 1, to, to + 1])]
        .filter((r) => r >= ref.r1 && r <= ref.r2 + 1).sort((a, b) => a - b);
      const spans = cuts.slice(0, -1).map((r, i) => ({ r1: mapRow(r), r2: mapRow(cuts[i + 1] - 1) }))
        .sort((a, b) => a.r1 - b.r1);
      const spansTogether = [];
      for (const span of spans) {
        const previous = spansTogether.at(-1);
        if (previous && previous.r2 + 1 === span.r1) previous.r2 = span.r2;
        else spansTogether.push(span);
      }
      if (spansTogether.length === 1 && spansTogether[0].r1 === ref.r1 && spansTogether[0].r2 === ref.r2) return ref;
      const areas = [];
      // References can also extend into columns outside the table. Those
      // cells stay in place while only the intersecting strip is moved.
      const kind = ref.kind === 'rows' ? 'range' : ref.kind;
      if (ref.c1 < c1) areas.push({ ...ref, kind, c2: c1 - 1 });
      for (const span of spansTogether) areas.push({ ...ref, kind, ...span, c1: Math.max(ref.c1, c1), c2: Math.min(ref.c2, c2) });
      if (ref.c2 > c2) areas.push({ ...ref, kind, c1: c2 + 1 });
      return areas.length === 1 ? areas[0] : areas;
    };
    const renumber = (formula, ownerSheet) => mapFormulaRefs(formula, (ref) => {
      if (ref.sheetEnd) {
        const names = this.sheetsBetween(ref.sheet, ref.sheetEnd);
        if (!names?.includes(sheet.name) || !touches(ref) || ref.kind === 'cols') return ref;
        return names.flatMap((name) => {
          const one = { ...ref, sheet: name };
          delete one.sheetEnd;
          return name === sheet.name ? moveRef(one) : one;
        });
      }
      const target = ref.sheet ?? ownerSheet;
      return target != null && target.toLowerCase() === sheet.name.toLowerCase() ? moveRef(ref) : ref;
    });
    return () => this._structural('Move totals row', () => {
      // Walk stored content once; a large sparse table must not require
      // allocating its entire rectangle just to relocate one footer.
      const moveEntries = (entries) => {
        const moved = new Map();
        for (const [key, value] of entries) {
          const { r, c } = parseKey(key);
          moved.set(cellKey(c >= c1 && c <= c2 ? mapRow(r) : r, c), value);
        }
        return moved;
      };
      sheet.cells = moveEntries(sheet.cells);
      sheet.notes = moveEntries(sheet.notes);
      sheet.comments = moveEntries(sheet.comments);
      sheet.styleResets = compactStyleResets(mapStyleResets(sheet.styleResets, { ...GRID_RANGE, c1, c2 }, (record) =>
        moveLineStyleResets([record], 'row', [from, from + 1, to, to + 1], mapRow)));
      sheet.ignoredErrors = compactRangeFlags(mapRangeFlags(sheet.ignoredErrors, { ...GRID_RANGE, c1, c2 }, record =>
        moveLineRangeFlags([record], 'row', [from, from + 1, to, to + 1], mapRow)));
      sheet.merges = sheet.merges.map(mapRange);
      sheet.rules = sheet.rules.map((rule) => ({ ...rule, range: mapRange(rule.range) }));
      sheet.validations = sheet.validations.map((rule) => ({ ...rule, range: mapRange(rule.range) }));
      sheet.charts = sheet.charts.map((ch) => ({ ...ch, ...mapCellDrawing(ch, p => ({ ...p, r: p.c >= c1 && p.c <= c2 ? mapRow(p.r) : p.r })), range: mapRange(ch.range),
        anchor: ch.anchorMode === 'absolute' ? ch.anchor : { ...ch.anchor, r: ch.anchor.c >= c1 && ch.anchor.c <= c2 ? mapRow(ch.anchor.r) : ch.anchor.r } }));
      for (const owner of this.sheets) {
        for (const cell of owner.cells.values()) if (cell.f != null) cell.f = renumber(cell.f, owner.name);
        owner.tables = owner.tables.map((t) => ({ ...t,
          ...(owner === sheet && t.id === table.id ? { calcRow: mapRow(t.calcRow ?? tableRows(t).dataStart) } : {}),
          ...(t.calc ? { calc: Object.fromEntries(Object.entries(t.calc).map(([c, f]) => [c, renumber(f, owner.name)])) } : {}),
        }));
      }
      this.names = this.names.map((name) => ({ ...name, ref: renumber(name.ref, name.sheet || null) }));
      sheet.rows = Math.max(sheet.rows, to + 1);
      sheet.cols = Math.max(sheet.cols, c2 + 1);
    });
  }

  /** Resize a table to a new range (the header row stays put); used when typing just beyond its edge. */
  resizeTable(sheetId, id, range, { onInvalid } = {}) {
    const sheet = this.sheet(sheetId);
    const table = sheet?.tables.find((t) => t.id === id);
    if (!table || this._gridLocked(sheet)) return false;
    const n = normalizeRange(range);
    if (!validStoredRange(n) || n.r1 !== table.range.r1 || n.r2 < n.r1 + (table.headerRow === false ? 0 : 1)) {
      onInvalid?.('The resized table must include its original header row, at least one more row, and stay within the sheet limits.');
      return false;
    }
    if (this._tablePivotEditBlocked(sheetId, n)) {
      onInvalid?.('The resized table would overlap a PivotTable.');
      return false;
    }
    const array = this._fixedArrays(sheet).overlapping(n).next().value;
    if (array) {
      this._arrayRefused(sheet, array, 'overlap');
      onInvalid?.('The resized table would cover an array formula.');
      return false;
    }
    if (sheet.tables.some((t) => t.id !== id && !(n.r2 < t.range.r1 || n.r1 > t.range.r2 || n.c2 < t.range.c1 || n.c1 > t.range.c2))) {
      onInvalid?.('That resize would overlap another table.');
      return false;
    }
    const moveFooter = this._tableFooterMove(sheet, table, n, onInvalid);
    if (!moveFooter) return false;
    // Merged cells have no place in a table (see addTable): a resize that would take some in stops, while a
    // merged label already in the totals row keeps moving with the footer.
    const old = table.range;
    if (this.mergesIn(sheetId, n).some((m) => m.r1 < old.r1 || m.r2 > old.r2 || m.c1 < old.c1 || m.c2 > old.c2)) {
      onInvalid?.('The resized table would cover merged cells. Unmerge them first.');
      return false;
    }
    // A column a table grows over is given a name of its own, which rewrites its header cell (see
    // _nameJoinedColumns): a protected header refuses the growth and says so, as Create table does, rather
    // than being written through. Every door a table widens by — typing beside it, a resize from the dialog,
    // a paste or fill that reaches past it — comes through here.
    for (let c = n.c1; c <= n.c2; c++) {
      if (c >= old.c1 && c <= old.c2) continue;
      if (this.lockedAt(sheetId, n.r1, c)) {
        onInvalid?.('The resized table would rename a protected column header. Unprotect it first.');
        return false;
      }
    }
    this.transaction('Resize table', () => {
      moveFooter();
      const live = this.tableById(sheetId, id);
      // A blank header reads as the ColumnN of its place, and a moved left edge changes its place: the name
      // it had is written as text first, so the formulas that used it keep their column.
      if (n.c1 !== old.c1 && live.headerRow !== false) {
        const before = this.tableColumns(sheetId, live);
        const kept = [];
        for (let c = Math.max(old.c1, n.c1); c <= Math.min(old.c2, n.c2); c++) {
          const cell = sheet.cells.get(cellKey(n.r1, c));
          if ((!cell || (cell.v == null && cell.f == null)) && !this.spillAt(sheetId, n.r1, c)) kept.push({ r: n.r1, c, cell: { v: before[c - old.c1], f: null, s: cell?.s } });
        }
        if (kept.length) this.setCells(sheetId, kept, 'Resize table');
      }
      // Calculated columns are keyed by their offset from the left edge: a moved edge re-keys them, and a
      // column cut off takes its template with it.
      const dc = table.range.c1 - n.c1;
      const calc = Object.fromEntries(Object.entries(live.calc || {}).flatMap(([k, f]) => { const o = Number(k) + dc; return o >= 0 && o <= n.c2 - n.c1 ? [[o, f]] : []; }));
      const calcArray = live.calcArray && Object.fromEntries(Object.entries(live.calcArray).flatMap(([k, value]) => { const o = Number(k) + dc; return o >= 0 && o <= n.c2 - n.c1 ? [[o, value]] : []; }));
      const next = { ...live, range: n, calc, ...(calcArray ? { calcArray } : {}), ...headerlessResizeNames(live, n) };
      this._setTables(sheet, sheet.tables.map((t) => (t.id === id ? next : t)), 'Resize table');
      const joined = [];
      for (let c = n.c1; c <= n.c2; c++) if (c < old.c1 || c > old.c2) joined.push(c);
      if (joined.length) this._nameJoinedColumns(sheet, id, joined);
      const oldEnd = tableRows(table).dataEnd;
      const newEnd = tableRows(next).dataEnd;
      const filter = sheetFilters(sheet).find(f => f.range.r1 === table.range.r1 && f.range.c1 === table.range.c1 && f.range.c2 === table.range.c2);
      const wasSelected = filter === sheet.filter;
      if (filter) {
        // Rows that just joined a filtered table stay in view until the filter is applied again, as
        // rows inserted into a filtered list do; otherwise a row typed under it would vanish as it landed.
        const show = [];
        for (let r = oldEnd + 1; r <= newEnd; r++) show.push(r);
        this._setFilter(sheet, { ...filter, range: { r1: n.r1, c1: n.c1, r2: newEnd, c2: n.c2 }, criteria: Object.fromEntries(Object.entries(filter.criteria).filter(([c]) => Number(c) >= n.c1 && Number(c) <= n.c2)), ...(filter.hiddenButtons ? { hiddenButtons: filter.hiddenButtons.filter(c => c >= n.c1 && c <= n.c2) } : {}) }, 'Resize table', { show, target: filter });
      }
      if (!wasSelected && sheet.filter && table.totalsRow && n.r2 !== table.range.r2) this._setFilter(sheet, sheet.filter, 'Resize table');
      this._growTableDependents(sheet, table, oldEnd, newEnd, 'Resize table');
    });
    return true;
  }

  /**
   * Whatever was drawn or ruled over a table's data rows keeps covering them as the table grows: charts,
   * conditional formats, and validation rules inside its columns that ended at the old last data row now
   * end at the new one. `table` supplies the columns; a resize and a row inserted above the totals row
   * both grow the data rows this way, so each later growth finds the ranges still ending at the last row.
   */
  _growTableDependents(sheet, table, oldEnd, newEnd, label) {
    if (newEnd <= oldEnd) return;
    const inside = (g) => g.c1 >= table.range.c1 && g.c2 <= table.range.c2 && g.r1 >= table.range.r1 && g.r2 === oldEnd;
    const grown = (g) => ({ ...g, r2: newEnd });
    if (sheet.rules.some(rule => inside(rule.range))) {
      // Imported pieces can share an explicit statistical domain. Grow that
      // automatic domain with its paint areas, while retaining foreign sources.
      const rules = conditionalRuleGroups(sheet.rules).flatMap(group => group.rules.some(rule => inside(rule.range))
        ? conditionalGroupPieces(group.rule, group.rules, group.rules.map(rule => inside(rule.range) ? grown(rule.range) : rule.range), sheet.name, newId)
        : group.rules);
      this._setRules(sheet, rules, label);
    }
    if (sheet.validations.some((v) => inside(v.range))) this._setValidations(sheet, sheet.validations.map((v) => (inside(v.range) ? { ...v, range: grown(v.range) } : v)), label);
    const reads = (ch) => ch.type !== 'image' && ch.type !== 'smartart' && inside(ch.range);
    if (sheet.charts.some(reads)) this._setCharts(sheet, sheet.charts.map((ch) => (reads(ch) ? { ...ch, range: grown(ch.range) } : ch)), label);
  }

  /**
   * Add one blank row at the bottom of a table's data (above its totals row,
   * when it has one) and give it the calculated columns. Returns the new
   * row's index, or -1.
   */
  addTableRow(sheetId, id) {
    const sheet = this.sheet(sheetId);
    const table = sheet?.tables.find((t) => t.id === id);
    if (!table || this._gridLocked(sheet) || table.range.r2 >= this._lastGridRow(sheet)) return -1;
    const rows = tableRows(table);
    const r = rows.dataEnd + 1;
    // An explicit new row must not absorb unrelated content, a merged block, or
    // another table. Make space, as we already do above an existing totals row.
    const occupied = table.totalsRow || this.tableRowOccupied(sheetId, { ...table.range, r1: r, r2: r }, id);
    let added = false;
    this.transaction('Add table row', () => {
      // Room is made by inserting a row; refused (a protected range in the way, or the sheet's last line),
      // the table must not grow over the content that is there instead.
      if (occupied && !this.insertRows(sheetId, r, 1)) return;
      if (!table.totalsRow && !this.resizeTable(sheetId, id, { ...table.range, r2: r })) return;
      this._fillCalculatedRow(sheet, this.tableById(sheetId, id), r);
      added = true;
    });
    return added ? r : -1;
  }

  /**
   * A block of cells was just written (a paste or a fill). If it reaches past a table's last row without
   * starting above its first data row, and its left edge is inside the table's columns, the table takes the
   * overhanging rows in; they get the calculated columns. A block wholly inside the table
   * grows nothing, and one starting on the header row is a replacement, left alone. A table with a totals
   * row takes nothing in this way: its last row is the totals row, not data. Returns true when a table grew.
   * A block starting immediately to the right instead adds columns, including
   * for tables with totals. It keeps the table's existing row boundaries.
   */
  extendTableToCover(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet?.tables.length || this._gridLocked(sheet)) return false;
    const n = normalizeRange(range);
    const beside = sheet.tables.find(x => n.c1 === x.range.c2 + 1 && n.r1 >= x.range.r1
      && n.r1 <= tableRows(x).dataEnd);
    if (beside) return this.resizeTable(sheetId, beside.id, { ...beside.range, c2: n.c2 });
    const t = sheet.tables.find((x) => !x.totalsRow && n.r2 > x.range.r2 && n.r1 >= x.range.r1 + 1 && n.r1 <= x.range.r2 + 1
      && n.c1 >= x.range.c1 && n.c1 <= x.range.c2);
    if (!t) return false;
    // A block starting below/inside the table only adds rows; its extra columns
    // remain outside. Column growth requires a block starting beside the table.
    const oldEnd = t.range.r2;
    const grown = { ...t.range, r2: n.r2 };
    let extended = false;
    this.transaction('Extend table', () => {
      if (!this.resizeTable(sheetId, t.id, grown)) return;
      const live = this.tableById(sheetId, t.id);
      // Only the rows that just joined: a row already in the table keeps whatever the block wrote over it.
      for (let r = Math.max(n.r1, oldEnd + 1); r <= n.r2; r++) this._fillCalculatedRow(sheet, live, r);
      extended = true;
    });
    return extended;
  }

  /** Column selectors without a table name resolve at each rule candidate cell. */
  _rewriteColumnRuleReferences(ownerSheet, renamed, label) {
    const rewrite = (formula, owner = null) => {
      for (const { table, names } of renamed) formula = renameColumnsInFormula(formula, table.name, names, owner);
      return formula;
    };
    const partsFor = (sheet, range, formula) => {
      let parts = [{ range, owner: null }];
      if (sheet !== ownerSheet) return parts;
      const explicit = rewrite(formula);
      for (const { table } of renamed) {
        if (rewrite(formula, table.name) === explicit) continue;
        const t = table.range;
        parts = parts.flatMap(part => {
          if (part.owner) return [part];
          const g = part.range, r1 = Math.max(g.r1, t.r1), c1 = Math.max(g.c1, t.c1), r2 = Math.min(g.r2, t.r2), c2 = Math.min(g.c2, t.c2);
          if (r1 > r2 || c1 > c2) return [part];
          const out = [], add = (r1, c1, r2, c2, owner = null) => {
            if (r1 <= r2 && c1 <= c2) out.push({ range: { r1, c1, r2, c2 }, owner });
          };
          add(g.r1, g.c1, r1 - 1, g.c2); add(r2 + 1, g.c1, g.r2, g.c2);
          add(r1, g.c1, r2, c1 - 1); add(r1, c2 + 1, r2, g.c2);
          add(r1, c1, r2, c2, table.name);
          return out;
        });
      }
      return parts.sort((a, b) => a.range.r1 - b.range.r1 || a.range.c1 - b.range.c1);
    };
    for (const sheet of this.sheets) {
      const updates = {};
      const charts = sheet.charts.map(chart => mapChartReferences(chart, f => rewrite(f)));
      if (charts.some((chart, i) => chart !== sheet.charts[i])) updates.charts = charts;
      const mapRule = (rule, key) => {
        const formula = String(rule[key] || '');
        const parts = partsFor(sheet, rule.range, formula);
        if (parts.length === 1) {
          const next = rewrite(formula, parts[0].owner);
          return next === formula ? [rule] : [{ ...rule, [key]: next }];
        }
        return parts.map((part, i) => ({ ...rule, id: i ? newId() : rule.id, range: part.range,
          [key]: rewrite(shiftFormula(formula, part.range.r1 - rule.range.r1, part.range.c1 - rule.range.c1), part.owner) }));
      };
      const rules = sheet.rules.flatMap(rule => {
        const predicate = conditionalPredicateField(rule);
        const next = mapConditionalFormulas(rule, (f, key) => key === predicate ? f : rewrite(f));
        return predicate ? mapRule(next, predicate) : [next];
      });
      if (rules.length !== sheet.rules.length || rules.some((rule, i) => rule !== sheet.rules[i])) updates.rules = rules;
      const validations = sheet.validations.flatMap(rule => {
        if (rule.type === 'formula') return mapRule(rule, 'source');
        if (rule.type !== 'list' || !isRangeSource(rule.source)) return [rule];
        if (rule.relativeSource === true) return mapRule(rule, 'source');
        // App-created list sources use the sheet's address context,
        // independent of the dropdown cell. Match _resolveSource.
        const formula = String(rule.source || ''), next = rewrite(formula, this.tableAt(sheet.id, 0, 0)?.name || null);
        return next === formula ? [rule] : [{ ...rule, source: next }];
      });
      if (validations.length !== sheet.validations.length || validations.some((rule, i) => rule !== sheet.validations[i])) updates.validations = validations;
      const filters = { filter: sheet.filter, otherFilters: sheet.otherFilters };
      mapSheetFilters(filters, filter => {
        let changed = false;
        const criteria = Object.fromEntries(Object.entries(filter.criteria).map(([col, criterion]) => {
          if (!criterion.formula) return [col, criterion];
          const rules = filterFormulaRules(criterion, filter.range, Number(col));
          const mapped = rules.flatMap(rule => mapRule(rule, 'source'));
          if (mapped.length === rules.length && mapped.every((rule, i) => rule === rules[i])) return [col, criterion];
          changed = true;
          return [col, compileFilterFormula(criterion, mapped, filter.range, Number(col))];
        }));
        return changed ? { ...filter, criteria } : filter;
      });
      if (filters.filter !== sheet.filter) updates.filter = filters.filter;
      if (filters.otherFilters.some((f, i) => f !== sheet.otherFilters[i])) updates.otherFilters = filters.otherFilters;
      this._writeRuleFormulaUpdates(sheet, updates, label);
    }
  }

  /** Return only rule metadata whose formula references actually changed; `rewrite(formula, rule)` sees the rule (its range) too. */
  _ruleFormulaUpdates(sheet, rewrite, { conditional = true, sparklines = true } = {}) {
    const updates = {};
    const sparklineGroups = sparklines ? mapNativeSparklineReferences(sheet.sparklineGroups, (f, binding) => rewrite(f, { ...binding, range: parseRefText(binding.ref || binding.sparklines[0].ref) })) : sheet.sparklineGroups;
    if (sparklineGroups !== sheet.sparklineGroups) updates.sparklineGroups = sparklineGroups;
    const charts = sheet.charts.map(chart => mapChartReferences(chart, f => rewrite(f, chart)));
    if (charts.some((chart, i) => chart !== sheet.charts[i])) updates.charts = charts;
    const map = (rule, key) => {
      const original = String(rule[key] || ''), next = rewrite(original, rule);
      return next === original ? rule : { ...rule, [key]: next };
    };
    const rules = conditional ? sheet.rules.map(rule => mapConditionalFormulas(rule, f => rewrite(f, rule))) : sheet.rules;
    if (rules.some((rule, i) => rule !== sheet.rules[i])) updates.rules = rules;
    const validations = sheet.validations.map(rule => rule.type === 'formula' || (rule.type === 'list' && isRangeSource(rule.source)) ? map(rule, 'source') : rule);
    if (validations.some((rule, i) => rule !== sheet.validations[i])) updates.validations = validations;
    const filters = { filter: sheet.filter, otherFilters: sheet.otherFilters };
    mapSheetFilters(filters, filter => {
      let changed = false;
      const { range } = filter;
      const criteria = Object.fromEntries(Object.entries(filter.criteria).map(([col, criterion]) => {
        if (!criterion.formula) return [col, criterion];
        // A filter condition reads from the first data row of its column, each stored stretch from its own first row.
        const rules = filterFormulaRules(criterion, range, Number(col));
        if (rules.length === 1 && rules[0].source === criterion.formula) {
          const formula = rewrite(criterion.formula, rules[0]);
          if (formula === criterion.formula) return [col, criterion];
          changed = true;
          return [col, { ...criterion, formula }];
        }
        const mapped = rules.map((rule) => map(rule, 'source'));
        if (mapped.every((rule, i) => rule === rules[i])) return [col, criterion];
        changed = true;
        return [col, compileFilterFormula(criterion, mapped, range, Number(col))];
      }));
      return changed ? { ...filter, criteria } : filter;
    });
    if (filters.filter !== sheet.filter) updates.filter = filters.filter;
    if (filters.otherFilters.some((f, i) => f !== sheet.otherFilters[i])) updates.otherFilters = filters.otherFilters;
    return updates;
  }

  /** Generated reference changes retain rules on protected dependent sheets; `fn(formula, sheet, rule)`. */
  _rewriteRuleFormulas(fn, label, options) {
    for (const sheet of this.sheets) {
      const next = this._ruleFormulaUpdates(sheet, (formula, rule) => fn(formula, sheet, rule), options);
      this._writeRuleFormulaUpdates(sheet, next, label);
    }
  }

  _writeRuleFormulaUpdates(sheet, next, label) {
    const fields = Object.keys(next);
    if (!fields.length) return;
    const prev = Object.fromEntries(fields.map(field => [field, sheet[field]]));
    const apply = state => {
      const live = this.sheet(sheet.id) || sheet;
      Object.assign(live, state);
      // Renaming preserves referenced values, including active filter results.
      this._changed('cells', live.id);
    };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next), snapshotCells: nativeSparklineSize(prev.sparklineGroups) + nativeSparklineSize(next.sparklineGroups) });
  }

  _rewriteNamedFormulas(fn, label) {
    let changed = false;
    const next = this.names.map((n) => {
      const ref = fn(n.ref, n);
      if (ref === n.ref) return n;
      changed = true;
      return { ...n, ref };
    });
    if (changed) this._setNames(next, label);
  }

  /** Apply `fn(formula, sheet, r, c, template)` to formulas and calculated-column templates (undoable). */
  _rewriteFormulas(fn, label) {
    for (const s of this.sheets) {
      const entries = [];
      for (const [key, cell] of s.cells) {
        if (cell.f == null) continue;
        const { r, c } = parseKey(key);
        const next = fn(cell.f, s, r, c);
        if (next !== cell.f) entries.push({ r, c, cell: { ...cell, f: next } });
      }
      // Like structural A1 adjustments, generated reference updates keep
      // protected formulas pointing at the same data without enabling edits.
      if (entries.length) this._writeCells(s, entries, label);
      // New table rows use these templates, so they must follow the same
      // renames as formulas already present in the sheet.
      let changed = false;
      const tables = s.tables.map((t) => ({ ...t, calc: Object.fromEntries(
        Object.entries(t.calc || {}).map(([c, f]) => {
          const next = fn(f, s, t.calcRow ?? tableRows(t).dataStart, t.range.c1 + Number(c), true);
          if (next !== f) changed = true;
          return [c, next];
        })),
      }));
      if (changed) this._writeTables(s, tables, label);
    }
  }

  /**
   * Typing in the row just under a table (or the column just right of it)
   * extends the table over the new cell. Called for single
   * typed edits only.
   */
  _autoExpandTable(sheet, r, c, cell) {
    if (!cell || (cell.v == null && cell.f == null) || !sheet.tables.length) return;
    for (const t of sheet.tables) {
      const rows = tableRows(t);
      if (!t.totalsRow && r === t.range.r2 + 1 && c >= t.range.c1 && c <= t.range.c2 && !this.tableAt(sheet.id, r, c)) {
        if (!this.resizeTable(sheet.id, t.id, { ...t.range, r2: r })) return;
        this._fillCalculatedRow(sheet, this.tableById(sheet.id, t.id), r, c);
        return;
      }
      if (c === t.range.c2 + 1 && r >= t.range.r1 && r <= rows.dataEnd && !this.tableAt(sheet.id, r, c)) {
        // The new column is named as the table grows over it (see _nameJoinedColumns).
        this.resizeTable(sheet.id, t.id, { ...t.range, c2: c });
        return;
      }
    }
  }

  /**
   * Columns a table just grew over (a resize, typing beside it) need names of their own, as at creation:
   * a header an array formula spills into keeps the text it shows, a blank one takes the first free
   * ColumnN, a formula becomes the text it shows, and a name another column has is numbered (Qty, Qty2).
   * No formula named these columns before they joined, so none needs rewriting.
   */
  _nameJoinedColumns(sheet, id, cols) {
    const table = this.tableById(sheet.id, id);
    if (table.headerRow === false) {
      // No header cells to write: the names live on the table (see table-header-row.js).
      this._setTables(sheet, sheet.tables.map((t) => (t.id === id ? headerlessJoinColumns(t, (taken, i) => this._freeColumnName(taken, i)) : t)), 'Resize table');
      for (const c of cols) this._adoptCalculatedColumn(sheet, id, c);
      return;
    }
    const r = table.range.r1;
    for (const c of cols) {
      const cell = sheet.cells.get(cellKey(r, c));
      const anchor = cell?.f != null ? this.spillRangeAt(sheet.id, r, c) && { r, c } : this.spillAt(sheet.id, r, c)?.anchor;
      if (anchor) this.formulasToValues(sheet.id, { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c });
    }
    const names = this.tableColumns(sheet.id, table);
    const blanks = [];
    for (const c of cols) {
      const cell = sheet.cells.get(cellKey(r, c));
      if (cell && (cell.v != null || cell.f != null)) continue;
      const i = c - table.range.c1;
      names[i] = this._freeColumnName(names.filter((_, j) => j !== i), i);
      blanks.push({ r, c, cell: { v: names[i], f: null, s: cell?.s } });
    }
    if (blanks.length) this.setCells(sheet.id, blanks, 'Resize table');
    this._uniqueTableHeaders(sheet, table, new Set(cols.map((c) => c - table.range.c1)));
    for (const c of cols) this._adoptCalculatedColumn(sheet, id, c);
  }

  /**
   * One formula and otherwise nothing in the data rows of a column a table just grew over makes it a
   * calculated column, as a formula typed into an empty column already in the table does: the table
   * reached the cell only now, so setInput's own lookup found no table to fill from and a formula typed
   * straight into the column beside a table filled its own row alone. A column holding anything else, or
   * no formula at all, is left as it is (_calculatedColumn checks the other rows and protection).
   */
  _adoptCalculatedColumn(sheet, id, c) {
    const table = this.tableById(sheet.id, id);
    if (!table || table.calc?.[c - table.range.c1] != null) return;
    const rows = tableRows(table);
    for (let r = rows.dataStart; r <= rows.dataEnd; r++) {
      const cell = sheet.cells.get(cellKey(r, c));
      if (cell?.f != null) { this._calculatedColumn(sheet, table, r, c, cell); return; }
      if (cell && cell.v != null) return; // a value above any formula: the column is data, not a template
    }
  }

  /** The first ColumnN, counting from the column's own position, that none of the other columns is called. */
  _freeColumnName(others, offset) {
    const taken = new Set(others.map((name) => name.toLowerCase()));
    let k = offset + 1;
    while (taken.has(`column${k}`)) k++;
    return `Column${k}`;
  }

  /* ---------- Data validation ---------- */

  _setValidations(sheet, next, label) {
    if (this._gridLocked(sheet)) return false;
    const prev = sheet.validations;
    const apply = (list) => { const live = this.sheet(sheet.id) || sheet; live.validations = list; this._changed('cells', live.id); };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
    return true;
  }

  addValidation(sheetId, rule) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    if (this._gridLocked(sheet)) return null;
    const id = newId();
    const range = normalizeRange(rule.range);
    // A range gets one rule: replace whatever covered exactly the same cells.
    const kept = sheet.validations.filter((v) => !(v.range.r1 === range.r1 && v.range.c1 === range.c1 && v.range.r2 === range.r2 && v.range.c2 === range.c2));
    this._setValidations(sheet, [...kept, { ...rule, id, range }], 'Add validation');
    return id;
  }

  updateValidation(sheetId, id, patch) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const i = sheet.validations.findIndex((v) => v.id === id);
    if (i < 0) return false;
    const range = normalizeRange(patch.range || sheet.validations[i].range);
    // A range gets one rule: moving this rule onto another rule's exact cells replaces that rule, as adding one does.
    const next = sheet.validations.filter((v) => v.id === id || !(v.range.r1 === range.r1 && v.range.c1 === range.c1 && v.range.r2 === range.r2 && v.range.c2 === range.c2));
    const j = next.findIndex((v) => v.id === id);
    next[j] = { ...next[j], ...patch, id, range };
    if (next.length === sheet.validations.length && sameRule(sheet.validations[i], next[j], VALIDATION_DEFAULTS)) return true; // nothing changed: no step
    return this._setValidations(sheet, next, 'Edit validation');
  }

  deleteValidation(sheetId, id) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheet.validations.some((v) => v.id === id)) return false;
    return this._setValidations(sheet, sheet.validations.filter((v) => v.id !== id), 'Delete validation');
  }

  /** The last rule covering (r, c) wins, so newer rules override older ones. */
  validationAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheet.validations.length) return null;
    for (let i = sheet.validations.length - 1; i >= 0; i--) {
      const v = sheet.validations[i];
      if (r >= v.range.r1 && r <= v.range.r2 && c >= v.range.c1 && c <= v.range.c2) return v;
    }
    return null;
  }

  /** Computed values of a reference like Lists!$A$1:$A$9 (unqualified: this sheet). */
  _resolveSource(sheet, source, from = null) {
    // Chip rendering and validation can ask for the same list for every
    // visible cell. Reuse its values until calculation caches are invalidated.
    const key = `validation-source|${sheet.id}|${source}${from ? `|${from.r},${from.c}` : ''}`;
    if (this._statsCache.has(key)) return this._statsCache.get(key);
    const text = String(source || '').trim();
    let ref = null;
    if (text.startsWith('=')) {
      try {
        // Resolve only the address here; the sparse reader below gathers
        // options without materializing large, mostly empty named ranges.
        if (!this._depth) resetArrayBudget();
        const value = evaluate(this._ast(text.slice(1)), this._context(sheet, from?.r ?? 0, from?.c ?? 0, true));
        if (isRange(value) && value.ref && !value.ref.sheetEnd) ref = value.ref;
      } catch { /* Invalid sources have no options. */ }
    } else ref = this.parseNamedRef(source);
    if (!ref && !text.startsWith('=')) {
      try {
        const tokens = tokenize(String(source || ''));
        if (tokens.length === 1 && tokens[0].type === 'ref') ref = { ...parseRefText(tokens[0].text, null), sheet: sheet.name, spill: tokens[0].spill };
        // Sales[Item]: a table column, which keeps up as the table grows.
        if (tokens.length === 1 && tokens[0].type === 'tref') {
          const t = this._resolveTableRef(sheet, { r: 0, c: 0 }, tokens[0].table, tokens[0].spec);
          ref = isError(t) ? null : t;
        }
      } catch { ref = null; }
    }
    if (!ref) { this._statsCache.set(key, null); return null; }
    const target = this.sheetByName(ref.sheet);
    if (!target) return null;
    // B1#: the cells the array formula at B1 spills over, which follow the array as it grows.
    if (ref.spill) ref = { ...ref, ...(this.spillRangeAt(target.id, ref.r1, ref.c1) || {}) };
    const valuesKey = `validation-values|${target.id}|${ref.r1},${ref.c1},${ref.r2},${ref.c2}`;
    if (this._statsCache.has(valuesKey)) {
      const values = this._statsCache.get(valuesKey); this._statsCache.set(key, values); return values;
    }
    // Array results may grow the sheet beyond its current dimensions,
    // including when the dropdown source excludes the formula's anchor.
    const spills = this._ensureSpills(target);
    const out = [];
    // Where each value came from rides along, so an option can read as its cell shows it (see listOptionsFor).
    const cells = [];
    const r2 = Math.min(ref.r2, target.rows - 1);
    const c2 = Math.min(ref.c2, target.cols - 1);
    const area = Math.max(0, r2 - ref.r1 + 1) * Math.max(0, c2 - ref.c1 + 1);
    if (area <= target.cells.size + spills.cover.size) {
      for (let r = ref.r1; r <= r2; r++) for (let c = ref.c1; c <= c2; c++) { out.push(this._compute(target, r, c)); cells.push({ r, c }); }
    } else {
      // Blank cells never become dropdown options. Avoid traversing a large
      // empty rectangle, then restore reading order for labels and chip colors.
      const positions = [];
      const include = (key) => {
        const { r, c } = parseKey(key);
        if (r >= ref.r1 && r <= r2 && c >= ref.c1 && c <= c2) positions.push({ r, c });
      };
      for (const [key, cell] of target.cells) if (cell.v != null || cell.f != null) include(key);
      for (const key of spills.cover.keys()) include(key);
      for (const key of spills.fixed.cells({ r1: ref.r1, c1: ref.c1, r2, c2 })) include(key);
      positions.sort((a, b) => a.r - b.r || a.c - b.c);
      for (const { r, c } of positions) { out.push(this._compute(target, r, c)); cells.push({ r, c }); }
    }
    // Kept off the array's own keys, so the values still compare and serialize as a plain list.
    Object.defineProperty(out, 'source', { value: { sheetId: target.id, cells } });
    this._statsCache.set(valuesKey, out);
    this._statsCache.set(key, out);
    return out;
  }

  _resolveValidationSource(sheet, rule, source, r = rule.range?.r1 ?? 0, c = rule.range?.c1 ?? 0) {
    if (rule.relativeSource !== true) return this._resolveSource(sheet, source);
    return this._resolveSource(sheet, shiftFormula(source, r - rule.range.r1, c - rule.range.c1), { r, c });
  }

  /**
   * Dropdown options for a list rule on this sheet. With `labels`, each option comes as { value, text }:
   * the text is what the source cell shows (a date as a date, an amount with its symbol),
   * or null for an option with no cell behind it (a literal list) or one whose format hides it,
   * which the caller labels itself. Checking a value against the list stays a matter of values.
   */
  listOptionsFor(sheetId, rule, options) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const resolve = (source) => this._resolveValidationSource(sheet, rule, source, options?.r, options?.c);
    const list = listOptions(rule, resolve, options);
    if (!options?.labels) return list;
    const labels = this._listLabels(rule, resolve);
    return list.map((value) => ({ value, text: labels?.byKey.get(optionKey(value)) ?? null }));
  }

  /**
   * What the options of a list drawn from a range read as: the display text of the first source cell holding
   * each value (null when its format hides it), by the value's type and plain text, with the index of the
   * first option reading the same, so a chip on a cell and the swatch in the picker pick one colour. Kept per
   * resolved source, which the calculation caches until the next change; null for a literal list.
   */
  _listLabels(rule, resolve) {
    if (rule.type !== 'list' || Array.isArray(rule.source) || !isRangeSource(rule.source)) return null;
    const values = resolve(rule.source);
    if (!values?.source) return null;
    this._listLabelCache ??= new WeakMap();
    let labels = this._listLabelCache.get(values);
    if (labels) return labels;
    labels = { byKey: new Map(), first: new Map() };
    let i = 0; // the option's place among the typed options, which optionsEntry dedupes by type and text as here
    values.source.cells.forEach(({ r, c }, k) => {
      const v = values[k];
      if (v == null || v === '' || typeof v === 'object') return;
      const key = optionKey(v);
      if (labels.byKey.has(key)) return;
      const shown = this.getDisplay(values.source.sheetId, r, c, v);
      const text = shown.trim() ? shown : null;
      labels.byKey.set(key, text);
      const label = (text ?? key.slice(key.indexOf(':') + 1)).trim().toLowerCase();
      if (!labels.first.has(label)) labels.first.set(label, i);
      i++;
    });
    this._listLabelCache.set(values, labels);
    return labels;
  }

  /** The chip colors ({ bg, color }) a list cell's text is drawn with, or null. */
  chipAt(sheetId, r, c, rule = this.validationAt(sheetId, r, c)) {
    if (!rule || rule.type !== 'list' || !rule.chips) return null;
    const text = this.getDisplay(sheetId, r, c);
    if (!text) return null;
    const sheet = this.sheet(sheetId);
    const resolve = (source) => this._resolveValidationSource(sheet, rule, source, r, c);
    // For a list drawn from a range, the cell's value finds its option and the option's label, as the picker
    // shows it, picks the colour: a date cell and its entry in the picker share one chip whatever the cell's
    // own format, and a colour chosen for the value under its plain spelling still applies.
    const v = this._compute(sheet, r, c);
    const labels = v != null && typeof v !== 'object' ? this._listLabels(rule, resolve) : null;
    const key = labels ? optionKey(v) : null;
    if (labels?.byKey.has(key)) {
      const label = labels.byKey.get(key) ?? text;
      return chipFor(rule, label, labels.first.get(label.trim().toLowerCase()) ?? -1, key.slice(key.indexOf(':') + 1));
    }
    // The value's place in the list comes from the cached lookup, so a long list costs nothing per cell.
    return chipFor(rule, text, listOptionIndex(rule, resolve, text));
  }

  /** Would this typed input be acceptable in the cell? { ok, message, rule }. */
  validateInput(sheetId, r, c, text) {
    const rule = this.validationAt(sheetId, r, c);
    if (!rule) return { ok: true, rule: null };
    const { v, f } = parseInput(text);
    if (f != null) return { ok: true, rule }; // formulas are checked by their results
    const sheet = this.sheet(sheetId);
    return { ...checkValue(rule, v, (source) => this._resolveValidationSource(sheet, rule, source, r, c), (formula) => this.evalRuleFormula(sheetId, formula, rule.range, r, c, v)), rule };
  }

  /** Check an already-typed value without reparsing it in the input locale. */
  validateValue(sheetId, r, c, value) {
    const rule = this.validationAt(sheetId, r, c);
    if (!rule) return { ok: true, rule: null };
    const sheet = this.sheet(sheetId);
    return { ...checkValue(rule, value, (source) => this._resolveValidationSource(sheet, rule, source, r, c), (formula) => this.evalRuleFormula(sheetId, formula, rule.range, r, c, value)), rule };
  }

  /** Is the cell's current value valid under its rule? */
  validateCell(sheetId, r, c) {
    const rule = this.validationAt(sheetId, r, c);
    if (!rule) return { ok: true, rule: null };
    const sheet = this.sheet(sheetId);
    return { ...checkValue(rule, this._compute(sheet, r, c), (source) => this._resolveValidationSource(sheet, rule, source, r, c), (formula) => this.evalRuleFormula(sheetId, formula, rule.range, r, c)), rule };
  }

  /* ---------- Type-ahead ---------- */

  /**
   * Text values in the same column, from the contiguous block of filled
   * cells around (r, c), that start with `prefix` (case-insensitive) and are
   * longer than it. Distinct, nearest first. Used to complete typing.
   */
  suggestValues(sheetId, r, c, prefix, limit = 1000) {
    const sheet = this.sheet(sheetId);
    const p = String(prefix || '');
    if (!sheet || !p.trim()) return [];
    const lower = p.toLowerCase();
    const seen = new Set();
    const out = [];
    const consider = (rr) => {
      const cell = sheet.cells.get(cellKey(rr, c));
      if (!cell || (cell.v == null && cell.f == null)) return false;
      if (cell.f == null && typeof cell.v === 'string') {
        const v = cell.v;
        const key = v.toLowerCase();
        if (v.length > p.length && key.startsWith(lower) && !seen.has(key)) { seen.add(key); out.push(v); }
      }
      return true;
    };
    for (let rr = r - 1, n = 0; rr >= 0 && n < limit && consider(rr); rr--, n++);
    for (let rr = r + 1, n = 0; rr < sheet.rows && n < limit && consider(rr); rr++, n++);
    return out;
  }

  /* ---------- Links ---------- */

  /**
   * The link a cell carries: a native hyperlink, HYPERLINK formula, or plain text that is a
   * web address or an email. Returns { url, label } or null.
   */
  linkAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    const cell = sheet?.cells.get(cellKey(r, c));
    if (!cell) return null;
    if (cell.hyperlink) {
      const url = safeLinkUrl(cell.hyperlink);
      return url ? { url, label: formatValue(this.getValue(sheetId, r, c), this.styleAt(sheetId, r, c)) || url } : null;
    }
    if (cell.f != null) {
      // The parse kept with the cell: an export asks every cell for its link, and the text cache alone
      // thrashes over a column of distinct formulas. One nested too deep to parse is no link.
      let ast;
      try { ast = this._cellAst(cell); } catch (e) { if (e instanceof RangeError) return null; throw e; }
      if (ast?.type !== 'call' || ast.name !== 'HYPERLINK' || !ast.args.length) return null;
      try {
        if (!this._depth) resetArrayBudget(); // not left with what the last address spent
        const url = toText(evaluate(ast.args[0], this._context(sheet, r, c)));
        if (isError(url) || !url) return null;
        const label = formatValue(this._compute(sheet, r, c), cell.s);
        const safe = safeLinkUrl(url);
        return safe ? { url: safe, label } : null;
      } catch { return null; }
    }
    // A typed address is a link unless its link was removed (see removeLink); the mark goes with the next entry.
    if (typeof cell.v === 'string' && !cell.s?.nolink) {
      const url = textUrl(cell.v);
      return url ? { url, label: cell.v } : null;
    }
    return null;
  }

  /**
   * Attach a native hyperlink. An empty label shows the address. False, with nothing
   * recorded, for a table header, which holds text and would turn the formula straight back into its label.
   */
  setLink(sheetId, r, c, url, label = '') {
    const u = String(url ?? '').trim();
    if (!u) return false;
    const sheet = this.sheet(sheetId);
    if (!sheet || !inGrid(r, c, gridLimits(sheet))) return false;
    const table = this.tableAt(sheetId, r, c);
    if ((table && r === tableRows(table).header) || this.lockedAt(sheetId, r, c)) return false;
    if (this.arrayEditBlocked(sheetId, { r1: r, c1: c, r2: r, c2: c })) return false;
    const previous = this.getCell(sheetId, r, c);
    const value = typeof label === 'number' && Number.isFinite(label) || typeof label === 'boolean' ? label : String(label ?? '').trim() || u;
    const s = patchedStyle(this.styleAt(sheetId, r, c), { nolink: null });
    const ast = previous?.f != null ? this._astOrNull(previous.f) : null;
    if (ast?.type === 'call' && ast.name === 'HYPERLINK') {
      // Editing an explicit formula keeps it a formula. When only the address
      // changes, retain the label expression (for example B1), not its cache.
      const quote = text => `"${String(text).replace(/"/g, '""')}"`;
      let expression = typeof value === 'number' ? String(value) : typeof value === 'boolean' ? String(value).toUpperCase() : quote(value);
      if (ast.args.length === 2 && this.getValue(sheetId, r, c) === value) {
        const tokens = tokenize(previous.f);
        const start = tokens.findIndex(token => token.type === 'name' && token.value === 'HYPERLINK') + 1;
        let depth = 0, separator = null;
        for (const token of tokens.slice(start)) {
          if (token.type === 'lparen' || token.type === 'lbrace') depth++;
          else if (token.type === 'rparen' || token.type === 'rbrace') {
            if (--depth === 0) {
              if (separator != null) expression = previous.f.slice(separator, token.start);
              break;
            }
          } else if (token.type === 'comma' && depth === 1) separator = token.end;
        }
      }
      this.setInput(sheetId, r, c, `=HYPERLINK(${quote(u)},${expression})`, { style: s, label: 'Set link' });
      return true;
    }
    const richText = editRichText(previous?.richText, previous?.v, value);
    const cell = { v: value, f: null, s, hyperlink: u, ...(richText ? { richText } : {}) };
    // Adding/changing the link on an unchanged calculated label retains the
    // calculation. A deliberately changed label replaces the value instead.
    if (previous?.f != null && this.getValue(sheetId, r, c) === value) {
      cell.f = previous.f; cell.v = previous.v;
    }
    this.transaction('Set link', () => {
      if (!this.setCells(sheetId, [{ r, c, cell }], 'Set link')) return;
      // Entering a new label retains the ordinary typed-entry table behavior.
      // Merely annotating existing content must not resize nearby tables or
      // turn an unchanged calculation into a calculated-column template.
      if ((previous?.v ?? null) !== (cell.v ?? null) || (previous?.f ?? null) !== cell.f) {
        this._autoExpandTable(sheet, r, c, cell);
      }
    });
    return true;
  }

  /**
   * Links inside the workbook are written "#Sheet!A1", "#'My Sheet'!A1:B3",
   * or "#RangeName" / "#Sheet!RangeName". Resolve one to { sheetId, range }
   * or null; an unqualified "#A1" points into `fromSheetId`.
   */
  resolveLink(url, fromSheetId = this.activeSheetId, fromCell = { r: 0, c: 0 }) {
    const text = String(url || '').trim();
    if (!text.startsWith('#')) return null;
    const body = text.slice(1).trim();
    if (!body) return null;
    const source = this.sheet(fromSheetId);
    const named = source ? this.namedLocation(body, source.name, fromCell) : null;
    if (named) {
      const sheet = this.sheetByName(named.sheet);
      return sheet ? { sheetId: sheet.id, range: this.navigationRange(sheet.id, named) } : null;
    }
    let ref = null;
    try {
      const tokens = tokenize(body);
      if (tokens.length === 1 && tokens[0].type === 'ref') {
        const token = tokens[0];
        ref = parseRefText(token.text, token.sheet, token.sheetEnd);
        if (token.spill) {
          if (!ref || ref.kind !== 'cell' || ref.sheetEnd) return null;
          const sheet = ref.sheet ? this.sheetByName(ref.sheet) : source;
          const range = this.spillRangeAt(sheet?.id, ref.r1, ref.c1);
          ref = range ? { ...ref, ...range } : null;
        }
      }
      else if (tokens.length === 1 && tokens[0].type === 'name' && tokens[0].sheet) {
        const scope = this.sheetByName(tokens[0].sheet);
        if (scope) ref = this.namedLocation(tokens[0].value, scope.name, fromCell);
      }
    } catch { ref = null; }
    if (!ref || (ref.sheetEnd && !this.sheetByName(ref.sheetEnd))) return null;
    const sheet = ref.sheet ? this.sheetByName(ref.sheet) : this.sheet(fromSheetId);
    if (!sheet) return null;
    return { sheetId: sheet.id, range: this.navigationRange(sheet.id, ref) };
  }

  /** Keep explicit endpoints; whole rows/columns reach the grid's far edge. */
  navigationRange(sheetId, ref) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    return { r1: ref.r1, c1: ref.c1,
      r2: ref.kind === 'cols' ? gridLimits(sheet).rows - 1 : ref.r2,
      c2: ref.kind === 'rows' ? gridLimits(sheet).cols - 1 : ref.c2 };
  }

  /** The "#..." address for a range on a sheet, quoted when the name needs it. */
  internalLinkFor(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const n = normalizeRange(range);
    if (!Object.values(n).every(Number.isInteger) || n.r1 < 0 || n.c1 < 0 || n.r2 > MAX_ROW || n.c2 > MAX_COL) return null;
    return `#${refToText({ sheet: sheet.name, kind: n.r1 === n.r2 && n.c1 === n.c2 ? 'cell' : 'range', ...n, absR1: false, absC1: false, absR2: false, absC2: false })}`;
  }

  /**
   * Make a link plain: the cell keeps what the link showed, as the value behind it (a linked 1000 shown as $1,000.00 is the
   * number again), and its style. Text that reads as an address (www.example.com, an e-mail) would be a link again the moment
   * it was plain, so the cell is marked as having no link (nolink) until something else is typed into it, so such
   * text stays plain once its hyperlink is removed.
   */
  removeLink(sheetId, r, c) {
    const link = this.linkAt(sheetId, r, c);
    if (!link) return;
    const cell = this.getCell(sheetId, r, c);
    const value = cell?.f != null ? this.getValue(sheetId, r, c) : cell?.v;
    const v = value == null || isError(value) ? link.label || null : value;
    const s = typeof v === 'string' && textUrl(v) ? { ...(cell?.s || {}), nolink: true } : cell?.s;
    // A native hyperlink is separate from its value/formula and character
    // formatting. Removing it must not freeze a live calculation.
    this.setCells(sheetId, [{ r, c, cell: cell?.hyperlink
      ? { ...cell, hyperlink: undefined, s }
      : { v, f: null, s, ...(cell?.richText ? { richText: normalizeRichText(cell.richText, v) } : {}) } }], 'Remove link');
  }

  /* ---------- Notes ---------- */

  getNote(sheetId, r, c) {
    return this.sheet(sheetId)?.notes.get(cellKey(r, c)) || null;
  }

  /** Attach a note to a cell; empty text removes it. Undoable. A protected sheet or range refuses, and says so. */
  setNote(sheetId, r, c, text) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this.lockedAt(sheetId, r, c)) return;
    const key = cellKey(r, c);
    const value = String(text ?? '').slice(0, 4000);
    const next = value.trim() ? value : null;
    const prev = sheet.notes.get(key) || null;
    if (prev === next) return;
    const apply = (v) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      if (v) live.notes.set(key, v);
      else live.notes.delete(key);
      this._growTo(live, r + 1, c + 1);
      this._changed('cells', live.id);
    };
    apply(next);
    this._push({ label: next ? (prev ? 'Edit note' : 'Add note') : 'Delete note', undo: () => apply(prev), redo: () => apply(next) });
  }

  /* ---------- Named ranges ---------- */

  /** null when the name is acceptable, else a message. */
  validateName(name, exceptName = null, { allowTableName = false, sheet = null } = {}) {
    const t = String(name ?? '').trim();
    if (!t) return 'Enter a name';
    // The .xlsx limit; judged before the spelling, whose pattern would otherwise blame a long name's first letter.
    if ([...t].length > 255) return 'Names are at most 255 characters';
    if (LOOKS_LIKE_REF.test(t)) return 'That looks like a cell reference';
    if (!NAME_RE.test(t)) return 'Names start with a letter, underscore, or backslash and then use letters, numbers, underscores, periods, backslashes, or question marks';
    if (/^(TRUE|FALSE)$/i.test(t)) return 'That name is reserved';
    const scope = sheet == null ? null : this.sheetByName(sheet)?.name;
    if (sheet != null && !scope) return 'That sheet no longer exists';
    if (this.names?.some((n) => (n.sheet || null) === scope && n.name.toLowerCase() === t.toLowerCase() && n.name.toLowerCase() !== String(exceptName || '').toLowerCase())) return 'That name is already used';
    if (!allowTableName && this.tableByName(t)) return 'That name is already used';
    return null;
  }

  /** Parse a stored reference like Budget!$B$5:$B$11 into a ref object, or null. */
  parseNamedRef(text) {
    try {
      const tokens = tokenize(String(text || ''));
      if (tokens.length !== 1 || tokens[0].type !== 'ref') return null;
      const token = tokens[0];
      const ref = parseRefText(token.text, token.sheet, token.sheetEnd);
      if (!ref?.sheet || (token.spill && (ref.sheetEnd || ref.kind !== 'cell'))) return null;
      return token.spill ? { ...ref, spill: true } : ref;
    } catch {
      return null;
    }
  }

  /** Reference text for a range on a sheet, anchored: Budget!$B$5:$B$11. */
  refTextFor(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const n = normalizeRange(range);
    return refToText({ sheet: sheet.name, kind: n.r1 === n.r2 && n.c1 === n.c2 ? 'cell' : 'range', ...n, absR1: true, absC1: true, absR2: true, absC2: true });
  }

  /** A sheet-local definition takes precedence over the workbook definition. */
  namedEntry(name, sheetName = this.sheet(this.activeSheetId)?.name) {
    if (isWorkbookNameScope(sheetName)) sheetName = null;
    if (String(sheetName).startsWith('[')) {
      const sheet = this._externalSheet(sheetName);
      if (!sheet) return undefined;
      sheet.externalNames ||= externalNamedEntries(this.externalWorkbooks, sheetName);
      return sheet.externalNames.get(String(name).toLowerCase());
    }
    if (!this.names.length) return undefined;
    const key = String(name).toLowerCase(), scope = String(sheetName || '').toLowerCase();
    const index = this._nameIndex || this._indexNames();
    return index.local.get(scope)?.get(key) || index.global.get(key);
  }

  _indexNames() {
    const index = { global: new Map(), local: new Map() };
    for (const n of this.names) {
      let entries = index.global;
      if (n.sheet) {
        const scope = n.sheet.toLowerCase();
        if (!index.local.has(scope)) index.local.set(scope, new Map());
        entries = index.local.get(scope);
      }
      entries.set(n.name.toLowerCase(), n);
    }
    this._nameIndex = index;
    return index;
  }

  namesForSheet(sheetId) {
    const scope = this.sheet(sheetId)?.name;
    const locals = new Set(this.names.filter((n) => n.sheet === scope).map((n) => n.name.toLowerCase()));
    return this.names.filter((n) => n.sheet ? n.sheet === scope : !locals.has(n.name.toLowerCase()));
  }

  nameLabel(entry) {
    return entry.sheet ? `${quoteSheet(entry.sheet)}!${entry.name}` : entry.name;
  }

  /** True when a defined name holds a formula rather than a reference. */
  isNamedFormula(name, sheetName) {
    const entry = this.namedEntry(name, sheetName);
    return !!entry && !this.parseNamedRef(entry.ref);
  }

  namedRef(name, sheetName, cell = { r: 0, c: 0 }) {
    const entry = this.namedEntry(name, sheetName);
    const ref = entry && this.parseNamedRef(entry.ref);
    return ref && entry.relative ? this.parseNamedRef(resolveRelativeName(entry.ref, cell.r, cell.c)) : ref || null;
  }

  /** Resolve a name for explicit navigation, including formulas returning references. */
  namedLocation(name, sheetName, cell = { r: 0, c: 0 }) {
    const entry = this.namedEntry(name, sheetName);
    if (!entry) return null;
    const formula = entry.relative ? resolveRelativeName(entry.ref, cell.r, cell.c) : entry.ref;
    return this.formulaLocation(formula, sheetName, cell);
  }

  /** Resolve a reference expression without materializing its cell values. */
  formulaLocation(formula, sheetName, cell = { r: 0, c: 0 }) {
    const direct = this.parseNamedRef(formula);
    if (direct && (!this.sheetByName(direct.sheet) || (direct.sheetEnd && !this.sheetByName(direct.sheetEnd)))) return null;
    // A spill suffix names the current array area, not just its anchor.
    if (direct && !direct.spill) return direct;
    const sheet = sheetName ? this.sheetByName(sheetName) : this.sheet(this.activeSheetId);
    if (!sheet) return null;
    try {
      if (!this._depth) resetArrayBudget();
      const value = evaluate(this._ast(formula), this._context(sheet, cell.r, cell.c, true));
      return isRange(value) && value.ref && !value.ref.sheetEnd
        ? { ...value.ref, sheet: value.ref.sheet || sheet.name } : null;
    } catch { return null; }
  }

  /** The name whose reference is exactly this range on this sheet, if any. */
  nameForRange(sheetId, range) {
    const text = this.refTextFor(sheetId, range);
    return this.namesForSheet(sheetId).find((n) => !n.hidden && n.ref === text)?.name || null;
  }

  _setNames(next, label) {
    const prev = this.names;
    const apply = (list) => { this.names = list.map((n) => ({ ...n })); this._changed('names'); };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  /** Define (or redefine) a name for a reference. Returns an error message or null. */
  defineName(name, refText, sheet = null) {
    const t = String(name).trim();
    const scope = sheet == null ? null : this.sheetByName(sheet)?.name;
    const existing = this.names.find((n) => (n.sheet || null) === scope && n.name.toLowerCase() === t.toLowerCase());
    const bad = this.validateName(t, existing?.name, { sheet });
    if (bad) return bad;
    const text = String(refText ?? '').trim().replace(/^=/, '');
    const badRef = this._namedRefError(text, scope);
    if (badRef) return badRef;
    if (existing && existing.ref === text && existing.name === t) return null; // saved as it was: nothing to undo
    const next = this.names.filter((n) => n !== existing);
    // The spelling as now typed: formulas find the name whatever its case, so a change of case needs no rewrite.
    next.push({ name: t, ref: text, ...(existing?.hidden ? { hidden: true } : {}), ...(scope ? { sheet: scope } : {}), ...(existing?.relative ? { relative: true } : {}) });
    next.sort((a, b) => a.name.localeCompare(b.name));
    this._setNames(next, 'Define name');
    return null;
  }

  /** Why `text` cannot be what a name refers to, or null when it can. */
  _namedRefError(text, scope) {
    const ref = this.parseNamedRef(text);
    if (ref) {
      // The syntax can be right and the sheet still missing; such a name would only ever give #REF!.
      const missing = [ref.sheet, ref.sheetEnd].find((name) => name && !this.sheetByName(name));
      return missing ? `There is no sheet called ${missing}` : null;
    }
    // Not a reference: it may be a formula, but a lone unknown word is a typo, not a formula.
    const ast = this._astOrNull(text);
    const loneWord = ast?.type === 'call' && ast.bare && !FUNCTIONS[ast.name] && !this.namedEntry(ast.name, ast.sheet || scope);
    const bareRef = ast?.type === 'ref'; // a reference without its sheet
    if (!ast || loneWord || bareRef) return 'Enter a reference like Sheet1!$A$1:$B$5, or a formula like =LAMBDA(x, x*2)';
    return null;
  }

  /**
   * Give the name `name` (scoped to `sheet`, or the workbook) the new spelling `newName` and
   * reference `refText`, following the rename in every formula, rule and name that uses it.
   * Returns an error message or null.
   */
  renameName(name, sheet, newName, refText) {
    const scope = sheet == null ? null : this.sheetByName(sheet)?.name;
    const key = String(name).trim().toLowerCase();
    const existing = this.names.find((n) => (n.sheet || null) === scope && n.name.toLowerCase() === key);
    if (!existing) return 'That name no longer exists';
    const to = String(newName).trim();
    if (to.toLowerCase() === key) return this.defineName(to, refText, sheet);
    const bad = this.validateName(to, null, { sheet });
    if (bad) return bad;
    const text = String(refText ?? '').trim().replace(/^=/, '');
    const badRef = this._namedRefError(text, scope);
    if (badRef) return badRef;
    const from = existing.name;
    const label = 'Rename name';
    const rename = (formula, ownerSheet) => {
      const out = this._renameNameIn(formula, ownerSheet, from, scope, to);
      // HYPERLINK("#Name") contains a string the token rewrite does not see;
      // these formulas follow the rename alongside native hyperlink records.
      return out === null ? null : this._renameNameLinks(out, ownerSheet, from, scope, to);
    };
    // Where a formula binds the new spelling as a LET or LAMBDA variable and uses the name, the
    // renamed name would mean that variable instead: such a rename is refused before anything changes.
    let captured = false;
    const check = (formula, ownerSheet) => { if (rename(formula, ownerSheet) === null) captured = true; return formula; };
    this._rewriteFormulas((formula, s) => check(formula, s.name), label);
    this._rewriteNamedFormulas((formula, n) => check(formula, n.sheet || null), label);
    this._rewriteRuleFormulas((formula, owner) => check(formula, owner.name), label);
    if (captured) return `A formula uses ${to} as a LET or LAMBDA variable where ${from} appears`;
    this.transaction(label, () => {
      this._rewriteFormulas((formula, s) => rename(formula, s.name), label);
      this._rewriteNamedFormulas((formula, n) => rename(formula, n.sheet || null), label);
      this._rewriteRuleFormulas((formula, owner) => rename(formula, owner.name), label);
      for (const owner of this.sheets) {
        const entries = [];
        for (const [key, cell] of owner.cells) if (cell.hyperlink) {
          const hyperlink = this._renameNativeNameLink(cell.hyperlink, owner.name, from, scope, to);
          if (hyperlink !== cell.hyperlink) entries.push({ ...parseKey(key), cell: { ...cell, hyperlink } });
        }
        if (entries.length) this._writeCells(owner, entries, label);
        const charts = owner.charts.map(chart => {
          if (!chart.hyperlink) return chart;
          const hyperlink = this._renameNativeNameLink(chart.hyperlink, owner.name, from, scope, to);
          return hyperlink === chart.hyperlink ? chart : { ...chart, hyperlink };
        });
        if (charts.some((chart, i) => chart !== owner.charts[i])) this._setCharts(owner, charts, label);
      }
      const next = this.names.filter((n) => (n.sheet || null) !== scope || n.name.toLowerCase() !== key);
      next.push({ name: to, ref: text, ...(scope ? { sheet: scope } : {}), ...(existing.relative ? { relative: true } : {}) });
      next.sort((a, b) => a.name.localeCompare(b.name));
      this._setNames(next, label);
    });
    return null;
  }

  /**
   * `formula` with each use of the name `from` (scoped to `scope`, or workbook-wide) spelled `to`.
   * Null when `to` is a LET or LAMBDA variable in scope at such a use, which the renamed name would then mean.
   */
  _renameNameIn(formula, ownerSheet, from, scope, to) {
    let tokens;
    try { tokens = tokenize(formula); } catch { return formula; }
    const key = from.toLowerCase();
    const variable = upperName(to);
    let out = '';
    let last = 0;
    // A LET or LAMBDA variable spelled like the name is not a use of it.
    for (const t of freeNameTokens(formula, tokens, { includeCalls: true, includeQualified: true })) {
      if (t.value.toLowerCase() !== key || isExternalFormulaToken(t)) continue;
      // A name reaches the definition on its own sheet first, then the workbook's.
      const on = String(t.sheet ?? ownerSheet ?? '').toLowerCase();
      const local = this.names.some((n) => n.sheet && n.sheet.toLowerCase() === on && n.name.toLowerCase() === key);
      const reaches = scope ? on === scope.toLowerCase() : !local;
      if (!reaches) continue;
      if (t.locals?.has(variable)) return null;
      out += formula.slice(last, t.nameStart ?? t.start) + to;
      last = t.end;
    }
    return out + formula.slice(last);
  }

  /**
   * `formula` with each HYPERLINK("#Name") or HYPERLINK("#Sheet!Name") link that reaches the name `from` (scoped to `scope`,
   * or workbook-wide) pointed at `to`. A link reaches the definition on the sheet it names, or the sheet it sits on, before
   * the workbook's, as resolveLink reads it.
   */
  _renameNameLinks(formula, ownerSheet, from, scope, to) {
    if (!/HYPERLINK/i.test(formula)) return formula;
    const key = from.toLowerCase();
    // The sheet part is one quoteSheet would write: quoted, or letters of any script, marks, digits, _ and .; the name part
    // is a name as NAME_RE spells one. A cell address in that place is no name and is left alone.
    const linkRe = /(HYPERLINK\(\s*")#(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{M}\p{N}_.]*))!)?([\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*)"/giu;
    return formula.replace(linkRe, (m, head, quoted, bare, name) => {
      if (name.toLowerCase() !== key) return m;
      const on = (quoted ? quoted.replace(/''/g, "'") : bare) ?? ownerSheet;
      const local = this.names.some((n) => n.sheet && sameSheetName(n.sheet, on) && n.name.toLowerCase() === key);
      if (!(scope ? sameSheetName(on, scope) : !local)) return m;
      return `${m.slice(0, m.length - name.length - 1)}${to}"`;
    });
  }

  _renameNativeNameLink(url, ownerSheet, from, scope, to) {
    const match = /^#(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{M}\p{N}_.]*))!)?([\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*)$/u.exec(url);
    if (!match || match[3].toLowerCase() !== from.toLowerCase()) return url;
    const on = (match[1] ? match[1].replace(/''/g, "'") : match[2]) ?? ownerSheet;
    const local = this.names.some(n => n.sheet && sameSheetName(n.sheet, on) && n.name.toLowerCase() === from.toLowerCase());
    return (scope ? sameSheetName(on, scope) : !local) ? url.slice(0, -match[3].length) + to : url;
  }

  deleteName(name, sheet = null) {
    const scope = sheet == null ? null : this.sheetByName(sheet)?.name;
    const next = this.names.filter((n) => (n.sheet || null) !== scope || n.name.toLowerCase() !== String(name).toLowerCase());
    if (next.length === this.names.length) return;
    this._setNames(next, 'Delete name');
  }

  /* ---------- Merged cells ---------- */

  /** The merge containing (r, c), or null. */
  mergeAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet || !sheet.merges.length) return null;
    return sheet.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) || null;
  }

  /** Merges that overlap a range. */
  mergesIn(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const n = normalizeRange(range);
    return sheet.merges.filter((m) => !(m.r2 < n.r1 || m.r1 > n.r2 || m.c2 < n.c1 || m.c1 > n.c2));
  }

  /** Grow a range until it fully contains every merge it touches. */
  expandToMerges(sheetId, range) {
    let out = normalizeRange(range);
    for (let guard = 0; guard < 50; guard++) {
      let grew = false;
      for (const m of this.mergesIn(sheetId, out)) {
        const next = { r1: Math.min(out.r1, m.r1), c1: Math.min(out.c1, m.c1), r2: Math.max(out.r2, m.r2), c2: Math.max(out.c2, m.c2) };
        if (next.r1 !== out.r1 || next.c1 !== out.c1 || next.r2 !== out.r2 || next.c2 !== out.c2) { out = next; grew = true; }
      }
      if (!grew) break;
    }
    return out;
  }

  _setMerges(sheet, next, label) {
    if (this._gridLocked(sheet)) return;
    const prev = sheet.merges;
    const apply = (list) => {
      const live = this.sheet(sheet.id);
      if (!live) return;
      live.merges = list.map((m) => ({ ...m }));
      this._changed('structure', live.id);
    };
    apply(next);
    this._push({ label, undo: () => apply(prev), redo: () => apply(next) });
  }

  /**
   * Merge a range into one cell. Only the top-left value survives, as in
   * every spreadsheet; other cells keep their styles. Overlapping merges
   * are replaced. One undo step. False when nothing was merged: a single
   * cell, a range over 20,000 cells, a table's cells, or protected cells.
   * A merge that discarded values announces a 'merged-values-dropped'
   * change, with the range and how many cells were cleared, so a caller
   * that did not count them itself can still say what the merge cost.
   */
  mergeCells(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return false;
    const n = normalizeRange(range);
    const array = this._fixedArrays(sheet).overlapping(n).next().value;
    if (array) { this._arrayRefused(sheet, array, 'overlap'); return false; }
    if (n.r1 === n.r2 && n.c1 === n.c2) return false;
    if ((n.r2 - n.r1 + 1) * (n.c2 - n.c1 + 1) > 20000) return false;
    // A table's header and data cells cannot be merged: each column keeps its own name and each
    // row its own cells. The totals row is a footer whose label may span columns.
    if (sheet.tables.some((t) => !(n.r2 < t.range.r1 || n.r1 > tableRows(t).dataEnd || n.c2 < t.range.c1 || n.c1 > t.range.c2))) return false;
    // Replacing an overlapping merge also changes cells outside the new range.
    if ([n, ...this.mergesIn(sheetId, n)].some((g) => this.lockedIn(sheetId, g))) return false;
    this.transaction('Merge cells', () => {
      const entries = [];
      for (let r = n.r1; r <= n.r2; r++) {
        for (let c = n.c1; c <= n.c2; c++) {
          if (r === n.r1 && c === n.c1) continue;
          const prev = sheet.cells.get(cellKey(r, c));
          if (prev && (prev.v != null || prev.f != null)) entries.push({ r, c, cell: { v: null, f: null, s: prev.s } });
        }
      }
      // A merged block shows its top-left cell alone, so every other value and formula in it is cleared.
      // Said here, once they are, so every door hears it — a script, a template, an import, a menu entry —
      // and not only the one caller that counts the cells itself beforehand. A batch merging several blocks
      // announces the last of them, as a batch does for every kind of change (see _announce).
      const dropped = entries.length ? this.setCells(sheetId, entries, 'Merge cells') : 0;
      if (dropped) this._announce('merged-values-dropped', sheetId, { range: { ...n }, count: dropped });
      const kept = sheet.merges.filter((m) => m.r2 < n.r1 || m.r1 > n.r2 || m.c2 < n.c1 || m.c1 > n.c2);
      this._setMerges(sheet, [...kept, { ...n }], 'Merge cells');
    });
    return true;
  }

  /** Split every merge that touches the range. */
  unmergeCells(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return;
    if (this._gridLocked(sheet)) return;
    const hit = this.mergesIn(sheetId, range);
    if (!hit.length) return;
    if (hit.some((g) => this.lockedIn(sheetId, g))) return;
    this._setMerges(sheet, sheet.merges.filter((m) => !hit.includes(m)), 'Unmerge cells');
  }

  /**
   * Hide or show rows ('row') or columns ('col') by index. Hidden lines keep
   * their cells and their stored size; they only stop taking up space.
   */
  /** Hide or show lines. False when nothing changed: a protected sheet, lines already so, or every line would be hidden. */
  setHidden(sheetId, axis, indices, hidden) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    if (this._gridLocked(sheet)) return false;
    const set = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
    // Any line of the grid can be hidden, reached by scrolling or not.
    const total = axis === 'row' ? gridLimits(sheet).rows : gridLimits(sheet).cols;
    const list = [...new Set(indices)].filter((i) => i >= 0 && i < total && set.has(i) !== hidden);
    if (!list.length) return false;
    // Never hide every line: the sheet must keep something to click on. Lines a collapsed group hid past
    // the sheet's end are not among the ones it shows, so they do not count.
    if (hidden) {
      let shown = total - list.length;
      for (const i of set) if (i < total) shown--;
      if (shown <= 0) return false;
    }
    const apply = (on) => {
      const live = this.sheet(sheetId);
      if (!live) return;
      const target = axis === 'row' ? live.hiddenRows : live.hiddenCols;
      for (const i of list) { if (on) target.add(i); else target.delete(i); }
      this._changed('layout', live.id);
    };
    apply(hidden);
    this._push({ label: hidden ? `Hide ${axis === 'row' ? 'rows' : 'columns'}` : `Show ${axis === 'row' ? 'rows' : 'columns'}`, undo: () => apply(!hidden), redo: () => apply(hidden) });
    return true;
  }

  isHidden(sheetId, axis, index) {
    const sheet = this.sheet(sheetId);
    return !!(axis === 'row' ? sheet?.hiddenRows.has(index) : sheet?.hiddenCols.has(index));
  }

  /** Hidden indices inside a range along one axis. */
  hiddenWithin(sheetId, axis, from, to) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const set = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
    return [...set].filter((i) => i >= from && i <= to).sort((a, b) => a - b);
  }

  /** Grow the grid (never shrink). Not undoable: it changes no content. */
  ensureSize(sheetId, rows, cols, { restoreView = false } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    // A saved viewport can lie beyond the interactive growth limits. Restore
    // enough empty grid to display it, bounded by the file format's grid.
    if (!this._growTo(sheet, rows, cols, true, restoreView)) return false;
    // The extent reached by scrolling or moving out is kept through every undo and redo (it is not saved).
    sheet.reachedRows = sheet.rows;
    sheet.reachedCols = sheet.cols;
    return true;
  }

  /** Whether a requested size fits completely, including already-large imported sheets. */
  canEnsureSize(sheetId, rows, cols) {
    const sheet = this.sheet(sheetId);
    return !!sheet && Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0
      && rows <= Math.max(sheet.rows, MAX_ROWS) && cols <= Math.max(sheet.cols, MAX_COLS);
  }

  _growTo(sheet, rows, cols, emit = false, restoreView = false) {
    // Imported sheets can exceed the interactive growth limits. An edit
    // must keep all of their existing cells visible and included in exports.
    const nr = Math.max(sheet.rows, Math.min(restoreView ? MAX_ROW + 1 : MAX_ROWS, rows || 0));
    const nc = Math.max(sheet.cols, Math.min(restoreView ? MAX_COL + 1 : MAX_COLS, cols || 0));
    if (nr === sheet.rows && nc === sheet.cols) return false;
    sheet.rows = nr;
    sheet.cols = nc;
    if (emit) {
      // Announced through the change path, so a growth inside a transaction is heard with the transaction's other changes,
      // after them, and the version moves on with the layout. Reaching further down a sheet is no edit, though: no value
      // depends on the size, so the calculated values stay, and the document is no dirtier for a scroll.
      this.version++;
      // Recorded as well as announced: a version that moves on without an entry leaves a hole in the log, and
      // changesSince answers "anything may have changed" for every span across it. Growth is the most frequent
      // version bump there is — a flick past the last row fires several — so that hole sent every chart, and
      // anything else built from the book, back over its whole range after a scroll.
      this._changeLog.push({ version: this.version, type: 'layout', sheetId: sheet.id, box: null, formula: false });
      if (this._changeLog.length > CHANGE_LOG * 2) this._changeLog.splice(0, this._changeLog.length - CHANGE_LOG);
      this._announce('layout', sheet.id);
    }
    return true;
  }

  /** Bounding box of every non-empty cell (spilled results included), or null for an empty sheet. */
  /** The last row and column holding a value or formula (-1 when empty); cells do not change within a version. */
  _cellBounds(sheet) {
    let bounds = this._cellBoundsCache.get(sheet.id);
    if (bounds) return bounds;
    let r2 = -1;
    let c2 = -1;
    for (const [key, cell] of sheet.cells) {
      if (cell.v == null && cell.f == null) continue;
      const { r, c } = parseKey(key);
      if (r > r2) r2 = r;
      if (c > c2) c2 = c;
    }
    bounds = { r2, c2 };
    this._cellBoundsCache.set(sheet.id, bounds);
    return bounds;
  }

  /**
   * How far a bounded reference is read: a fixed margin past the cells,
   * and past any spill lying in the rows or columns it covers. Spills
   * elsewhere on the sheet do not count, or a spilled result would keep
   * lengthening the range it was computed from.
   */
  _readExtent(target, ref) {
    const bounds = this._cellBounds(target);
    let r2 = Math.max(bounds.r2, READ_ROWS - 1);
    let c2 = Math.max(bounds.c2, READ_COLS - 1);
    // Only a spill that covers blank cells reaches past the cells that exist; a one-cell anchor is a cell of its own.
    for (const a of this._ensureSpills(target).spread.values()) {
      if (a.c <= ref.c2 && a.c + a.cols - 1 >= ref.c1) r2 = Math.max(r2, a.r + a.rows - 1);
      if (a.r <= ref.r2 && a.r + a.rows - 1 >= ref.r1) c2 = Math.max(c2, a.c + a.cols - 1);
    }
    return { r2: Math.min(ref.r2, r2), c2: Math.min(ref.c2, c2) };
  }

  usedRange(sheetId) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const cached = this._usedCache.get(sheet.id);
    if (cached !== undefined) return cached;
    let { r2, c2 } = this._cellBounds(sheet);
    for (const group of sheet.sparklineGroups) for (const spark of group.sparklines) { const ref = parseRefText(spark.ref); r2 = Math.max(r2, ref.r1); c2 = Math.max(c2, ref.c1); }
    const st = this._ensureSpills(sheet);
    // While spills are being worked out, answer from the cells alone and do
    // not remember it: the answer may grow once the arrays have landed.
    if (st.building) {
      for (const a of st.anchors.values()) { r2 = Math.max(r2, a.r + a.rows - 1); c2 = Math.max(c2, a.c + a.cols - 1); }
      return r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 };
    }
    for (const a of st.anchors.values()) { r2 = Math.max(r2, a.r + a.rows - 1); c2 = Math.max(c2, a.c + a.cols - 1); }
    const out = r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 };
    this._usedCache.set(sheet.id, out);
    return out;
  }

  /**
   * The block of data around (r, c): the rectangle containing the cell
   * that is bounded by empty rows and columns on every side (the
   * current region), with empty edge rows and columns trimmed. Null when
   * the cell and its neighbours are all empty.
   */
  dataRegion(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    const used = sheet && this.usedRange(sheetId);
    if (!used || r < 0 || c < 0) return null;
    const filled = (rr, cc) => {
      if (rr < 0 || cc < 0 || rr > used.r2 || cc > used.c2) return false;
      const cell = sheet.cells.get(cellKey(rr, cc));
      if (cell && (cell.v != null || cell.f != null)) return true;
      return this.spillAt(sheetId, rr, cc)?.value != null;
    };
    let r1 = r, r2 = r, c1 = c, c2 = c;
    const rowFilled = (rr) => { for (let cc = c1 - 1; cc <= c2 + 1; cc++) if (filled(rr, cc)) return true; return false; };
    const colFilled = (cc) => { for (let rr = r1 - 1; rr <= r2 + 1; rr++) if (filled(rr, cc)) return true; return false; };
    // Grow the rows as far as they go, then the columns; a wider block can
    // expose more rows, so repeat until the columns stop moving.
    for (;;) {
      while (r2 < used.r2 && rowFilled(r2 + 1)) r2++;
      while (r1 > 0 && rowFilled(r1 - 1)) r1--;
      const [lo, hi] = [c1, c2];
      while (c2 < used.c2 && colFilled(c2 + 1)) c2++;
      while (c1 > 0 && colFilled(c1 - 1)) c1--;
      if (c1 === lo && c2 === hi) break;
    }
    const rowEmpty = (rr) => { for (let cc = c1; cc <= c2; cc++) if (filled(rr, cc)) return false; return true; };
    const colEmpty = (cc) => { for (let rr = r1; rr <= r2; rr++) if (filled(rr, cc)) return false; return true; };
    while (r1 < r2 && rowEmpty(r1)) r1++;
    while (r2 > r1 && rowEmpty(r2)) r2--;
    while (c1 < c2 && colEmpty(c1)) c1++;
    while (c2 > c1 && colEmpty(c2)) c2--;
    if (r1 === r2 && c1 === c2 && !filled(r1, c1)) return null;
    return { r1, c1, r2, c2 };
  }

  /* ---------- Dynamic arrays (spilling) ---------- */

  /**
   * A formula that can produce a range (an array function, INDIRECT or
   * OFFSET, a bare range in arithmetic, a range passed through IF) is an
   * array candidate: its result may spill into the cells beside it.
   * `sheetName` is the sheet the formula is on, where its bare names resolve.
   *
   * Whatever stands under a consumer cannot spill: SUM(SEQUENCE(3)) and
   * COUNTA(UNIQUE(A:A)) are one value each, whatever their arguments. LET
   * binds each local to the verdict of what it holds, so LET(x,A1,x*2) is one
   * value and LET(x,A1:A3,x*2) spills, and a LAMBDA called on the spot is
   * judged by its body with the parameters bound the same way.
   */
  _isArrayCandidate(ast, sheetName) {
    if (!ast) return false;
    if (ast._arr !== undefined) return ast._arr || this._bareNameSpills(ast, sheetName);
    // Bare names read outside a consumer: a table, a defined name or #NAME?. What one stands for is
    // looked up when asked, since names and tables change without the formula's text changing, so
    // they are remembered beside the AST rather than judged into it.
    const names = [];
    const NONE = { spills: false, names: [] };
    let expansions = 0;
    let depth = 0;
    const isLambda = (node) => node?.type === 'call' && !node.bare && !node.sheet && node.name === 'LAMBDA';
    const paramName = (node) => (node?.type === 'call' && node.bare && !node.sheet ? node.name : null);
    // What a local holds: whether it can spill and the bare names that verdict rests on, or a LAMBDA
    // with the scope it was written in. `scope` maps the locals in force to such verdicts.
    const judge = (node, scope) => {
      if (node.type === 'empty') return NONE;
      if (isLambda(node)) return { lambda: node, scope };
      const alias = paramName(node) && scope?.get(node.name);
      if (alias?.lambda) return alias;
      const held = [];
      const spills = walk(node, false, scope, held);
      return { spills, names: held };
    };
    // A LAMBDA called with arguments answers what its body does with the parameters bound to them.
    const expand = (lambda, captured, args, scope, sink) => {
      if (!lambda.args.length) return false;
      if (++expansions > 256 || depth > 8) return true; // a recursive or sprawling lambda is taken to be able to spill
      const inner = new Map(captured || []);
      for (let i = 0; i < lambda.args.length - 1; i++) {
        // A parameter may be written [x] to say it may be left out; it binds the same name either way.
        const name = paramSpec(lambda.args[i])?.name;
        if (!name) return true; // an invalid parameter: judged the safe way
        inner.set(name, i < args.length ? judge(args[i], scope) : NONE);
      }
      depth++;
      try { return walk(lambda.args[lambda.args.length - 1], false, inner, sink); } finally { depth--; }
    };
    const walk = (node, consumed, scope, sink) => {
      switch (node.type) {
        case 'ref': return (node.ref.kind !== 'cell' || !!node.ref.spill || !!node.ref.sheetEnd) && !consumed;
        case 'tref': {
          if (consumed) return false;
          // @ and #This Row select the same row. A single column from that
          // row (or the header/totals row) is scalar; a multi-column row still
          // returns an array. Use the structured-reference grammar, not spelling.
          const spec = parseTableSpec(node.spec);
          return !(spec && ['this', 'headers', 'totals'].includes(spec.rows) && spec.cols
            && spec.cols[0].toLowerCase() === spec.cols[1].toLowerCase());
        }
        case 'apply': {
          if (consumed) return false;
          // LAMBDA(x,x*2)(A1) is judged by its body; any other called expression may hand back an array.
          if (isLambda(node.fn)) return expand(node.fn, scope, node.args, scope, sink);
          const local = paramName(node.fn) && scope?.get(node.fn.name);
          if (local?.lambda) return expand(local.lambda, local.scope, node.args, scope, sink);
          return true;
        }
        case 'call': {
          const local = !node.sheet && scope?.get(node.name);
          if (local) {
            // A name bound by LET or a LAMBDA parameter shadows everything else.
            if (node.bare) {
              if (consumed || local.lambda) return false; // a LAMBDA read bare is #CALC!
              for (const name of local.names) sink.push(name);
              return local.spills;
            }
            if (local.lambda) return consumed ? false : expand(local.lambda, local.scope, node.args, scope, sink);
            // LET(PI,5,PI()): a local that is no LAMBDA leaves the call form to the built-in of that name.
            if (!FUNCTIONS[node.name]) return false;
          } else if (node.bare) {
            if (!consumed) sink.push(node.sheet ? { name: node.name, sheet: node.sheet } : { name: node.name });
            if (node.sheet || !FUNCTIONS[node.name]) return false;
          } else if (node.sheet || !FUNCTIONS[node.name]) return !consumed; // a called definition (=Seq(3), =S!Double(4)) may hand back an array
          // Under a consumer nothing a call answers can spill: SUM(SEQUENCE(3)), COUNTA(UNIQUE(A:A)),
          // SUM(IF(A1:A3>1,1,0)), INDEX(SORT(A1:B3),1,1) and MAX(OFFSET(A1,0,0,3)) are one value each.
          if (consumed) return false;
          const def = FUNCTIONS[node.name];
          if (node.name === 'LET' && !node.bare) {
            // Each value is judged with the locals before it in force; the result sees them all. The
            // bindings share one scope, as they do when calculated, so a LAMBDA bound here can name itself.
            const args = node.args;
            if (args.length < 3 || args.length % 2 === 0) return false;
            const inner = new Map(scope || []);
            for (let i = 0; i + 1 < args.length - 1; i += 2) {
              const name = paramName(args[i]);
              if (!name) return false;
              inner.set(name, judge(args[i + 1], inner));
            }
            return walk(args[args.length - 1], false, inner, sink);
          }
          if (node.name === 'LAMBDA' && !node.bare) return false; // uncalled, it is #CALC!; called, it is judged where it is called
          if (node.name === 'REDUCE' && !node.bare) {
            // REDUCE answers whatever its lambda leaves in the accumulator: VSTACK there builds an array.
            const fn = node.args[node.args.length - 1];
            if (isLambda(fn)) return expand(fn, scope, [], scope, sink);
            const held = paramName(fn) && scope?.get(fn.name);
            if (held?.lambda) return expand(held.lambda, held.scope, [], scope, sink);
            return false; // a built-in or a defined LAMBDA folds the values to one
          }
          if (node.name === 'SUBTOTAL' && !node.bare) {
            // A vector of OFFSET references yields one subtotal per reference;
            // an ordinary range still collapses to one subtotal.
            return node.args.slice(1).some(a => a.type === 'call' && a.name === 'OFFSET' && !a.bare
              && a.args.slice(1, 3).some(offset => walk(offset, false, scope, sink)));
          }
          if (def.array) {
            // ROW(A1:A4) spills; ROW() and ROW(B7) are single numbers.
            if (node.name === 'ROW' || node.name === 'COLUMN') return !!node.args[0] && walk(node.args[0], false, scope, sink);
            const singleCell = (arg) => arg && (arg.type === 'num' || arg.type === 'str' || arg.type === 'bool'
              || (arg.type === 'ref' && arg.ref.kind === 'cell' && !arg.ref.spill && !arg.ref.sheetEnd));
            const vectorRef = (arg) => arg?.type === 'ref' && !arg.ref.spill && !arg.ref.sheetEnd
              && (arg.ref.r1 === arg.ref.r2 || arg.ref.c1 === arg.ref.c2);
            if (node.name === 'XLOOKUP') {
              // One key looked up in one column (or row) of results is a single value.
              const [key, , returned] = node.args;
              return !(singleCell(key) && vectorRef(returned));
            }
            if (node.name === 'OFFSET') {
              // OFFSET(A1,ROW()-1,0) is one cell: a single-cell base with the height and width left out or 1.
              // An array of offsets, being lifted over, is found by the argument walk below.
              const [base, , , height, width] = node.args;
              const one = (arg) => !arg || arg.type === 'empty' || (arg.type === 'num' && Math.trunc(arg.value) === 1);
              if (!(base?.type === 'ref' && base.ref.kind === 'cell' && !base.ref.spill && !base.ref.sheetEnd && one(height) && one(width))) return true;
            } else if (node.name === 'INDIRECT') {
              // INDIRECT("D1") names one cell for good; text built at run time may name anything.
              const [text, a1] = node.args;
              if (text?.type !== 'str' || !(!a1 || a1.type === 'empty' || (a1.type === 'bool' && a1.value === true))) return true;
              let ref = null;
              try {
                const tokens = tokenize(text.value.trim());
                const token = tokens.length === 1 && tokens[0].type === 'ref' ? tokens[0] : null;
                ref = token && !token.spill ? parseRefText(token.text, token.sheet, token.sheetEnd) : null;
              } catch { ref = null; }
              if (!ref || ref.kind !== 'cell' || ref.sheetEnd) return true;
            } else if (node.name === 'INDEX') {
              // Ordinary scalar INDEX lookups stay lazy. Zero or dynamic
              // indices can select an entire row/column and need spill discovery.
              const [source, row, col] = node.args;
              // The least an index can be, judged from its text: ROW(), MATCH and XMATCH answer with a
              // position from 1 up, or an error, never 0; a count can be 0 until 1 is added to it. An
              // array index, ROW(A1:A3) or MATCH(B1:B3,…), is found by the argument walk below.
              const lower = (arg) => {
                if (!arg) return -Infinity;
                if (arg.type === 'num') return arg.value;
                if (arg.type === 'call' && !arg.bare && !arg.sheet) {
                  if (POSITIVE_CALLS.has(arg.name)) return 1;
                  if (COUNT_CALLS.has(arg.name)) return 0;
                  return -Infinity;
                }
                if (arg.type === 'binary') {
                  const a = lower(arg.left), b = lower(arg.right);
                  if (arg.op === '+') return a + b;
                  if (arg.op === '*') return a >= 0 && b >= 0 ? a * b : -Infinity;
                  if (arg.op === '-') return arg.right.type === 'num' ? a - arg.right.value : -Infinity;
                }
                return -Infinity;
              };
              const nonzero = (arg) => (arg?.type === 'num' && Math.trunc(arg.value) !== 0) || lower(arg) >= 1;
              const vector = vectorRef(source);
              const scalar = nonzero(row) && (nonzero(col) || ((!col || col.type === 'empty') && vector));
              if (!scalar) return true;
            } else return true;
          }
          // Elementwise functions pass through their input shape, and so does the *IF family
          // for its criteria, COUNTIF(A1:A3,A1:A3) answering one count per cell, and a lookup
          // for the arguments it is lifted over, MATCH({1;2},…) answering one position per
          // value. Scalar calls stay lazy, while range arguments can produce a spill. A lazy
          // choice (IF, CHOOSE) may answer with one of its arguments as it stands.
          const criteria = def.fn?.criteriaArgs;
          const lifted = (k) => (criteria && k >= criteria.first && (criteria.repeating ? (k - criteria.first) % 2 === 0 : k === criteria.first))
            || !!def.liftArgs?.includes(k);
          return node.args.some((a, k) => walk(a, !(def.elementwise || def.lazy || lifted(k)), scope, sink));
        }
        // An operator keeps its operands' shape, so SUM(A1:A9*2) is one value: what SUM consumes stays consumed.
        // A chain of operators parses left-deep: its spine is walked as a list, as the evaluator does,
        // so 1+1+… with thousands of terms does not recurse once per term.
        case 'binary': {
          let leftmost = node;
          while (leftmost.type === 'binary') { if (walk(leftmost.right, consumed, scope, sink)) return true; leftmost = leftmost.left; }
          return walk(leftmost, consumed, scope, sink);
        }
        // @A1:A3 takes the one value of the range on the formula's own row, so what @ covers stays
        // consumed, as it does written out as SINGLE(A1:A3): it is the opposite of an array formula.
        case 'unary': return walk(node.arg, consumed || node.op === '@', scope, sink);
        case 'percent': return walk(node.arg, consumed, scope, sink);
        case 'array': return !consumed && (node.rows.length > 1 || node.rows[0].length > 1);
        case 'union': return !consumed; // (A1:A3, C1:C3) is a range of every cell named
        case 'range': return !consumed; // A1:INDEX(A1:A5,3) is the block between two references
        case 'intersection': return !consumed; // The common reference can contain multiple cells.
        default: return false;
      }
    };
    ast._arr = walk(ast, false, null, names);
    if (names.length) ast._bareNames = names;
    return ast._arr || this._bareNameSpills(ast, sheetName);
  }

  /** Does a bare name the formula uses outside an aggregate stand for a table, or for a definition that can spill? */
  _bareNameSpills(ast, sheetName) {
    const names = ast._bareNames;
    if (!names) return false;
    return names.some(({ name, sheet }) => (!sheet && !!this.tableByName(name)) || this._nameSpills(name, sheet || sheetName));
  }

  /**
   * Can what a defined name stands for spill: a range, or a formula that is itself an array
   * candidate? A constant or a single cell cannot, so a column of =A1*Tax is not re-evaluated
   * sheet-wide after every edit to find its spills. The answers live on the name index, which
   * every change to the workbook rebuilds.
   */
  _nameSpills(name, sheetName) {
    const index = this._nameIndex || this._indexNames();
    const memo = (index.spills ??= new Map());
    const key = `${String(sheetName || '').toLowerCase()}|${String(name).toLowerCase()}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false); // a name defined by way of itself is an error, not an array
    let spills = false;
    const entry = this.namedEntry(name, sheetName);
    if (entry) {
      const ref = this.parseNamedRef(entry.ref);
      if (ref) spills = ref.kind !== 'cell' || !!ref.spill || !!ref.sheetEnd;
      else {
        // A named formula's own names resolve where it is used, as the evaluator resolves them. A
        // LAMBDA read bare is #CALC!; called, the call is judged where it is written.
        const ast = this._astOrNull(entry.ref);
        spills = !!ast && !(ast.type === 'call' && !ast.bare && !ast.sheet && ast.name === 'LAMBDA') && this._isArrayCandidate(ast, sheetName);
      }
    }
    memo.set(key, spills);
    return spills;
  }

  /**
   * Work out every spill on a sheet for the current version. Candidates are
   * evaluated in reading order and register their extents as they go; a
   * second pass (and a third if needed) lets formulas that read spilled
   * cells before those had landed see the finished picture.
   */
  _fixedArrays(sheet) {
    let cached = this._fixedArrayIndexes.get(sheet);
    if (!cached || cached.cells !== sheet.cells) {
      cached = { cells: sheet.cells, index: new FixedArrayIndex(sheet.cells) };
      this._fixedArrayIndexes.set(sheet, cached);
    }
    return cached.index;
  }

  /** Fixed array ownership is available without evaluating its formula. */
  fixedArrayAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    return sheet ? this._fixedArrays(sheet).at(r, c) : null;
  }

  _arrayRefused(sheet, range, reason = 'partial') {
    this._emit('array-edit', sheet.id, { range: { r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2 }, reason });
    return true;
  }

  _arrayMoveBlocked(source, src, target, dst) {
    const inside = (a, b) => a.r1 >= b.r1 && a.c1 >= b.c1 && a.r2 <= b.r2 && a.c2 <= b.c2;
    const carried = a => source === target && inside(a, src);
    for (const a of this._fixedArrays(target).overlapping(dst)) {
      if (!carried(a) && !inside(a, dst)) return this._arrayRefused(target, a);
    }
    const dr = dst.r1 - src.r1, dc = dst.c1 - src.c1;
    for (const a of this._fixedArrays(source).overlapping(src)) {
      const moved = { r1: a.r1 + dr, c1: a.c1 + dc, r2: a.r2 + dr, c2: a.c2 + dc };
      if (target.merges.some(m => !carried(m) && intersection(m, moved))
        || target.tables.some(t => !carried(t.range) && intersection(t.range, moved))) return this._arrayRefused(target, moved, 'overlap');
    }
    return false;
  }

  /** Refuse an edit that would change only part of a fixed array. */
  arrayEditBlocked(sheetId, range, { whole = false, skipRow = null } = {}) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return false;
    const area = normalizeRange(range);
    for (const a of this._fixedArrays(sheet).overlapping(area)) {
      if (!whole && a.rows === 1 && a.cols === 1) continue;
      const contains = whole && area.r1 <= a.r1 && area.c1 <= a.c1 && area.r2 >= a.r2 && area.c2 >= a.c2;
      if (!contains) return this._arrayRefused(sheet, a);
      if (skipRow) for (let r = a.r1; r <= a.r2; r++) if (skipRow(r)) return this._arrayRefused(sheet, a);
    }
    return false;
  }

  _fixedWritesBlocked(sheet, entries, arrayRange = null) {
    const index = this._fixedArrays(sheet);
    if (!index.size && !entries.some(e => e.cell?.array)) return false;
    const writes = new Map(entries.map(e => [cellKey(e.r, e.c), e.cell]));
    const checked = new Set();
    for (const { r, c, cell } of entries) {
      const key = cellKey(r, c), prev = sheet.cells.get(key);
      const same = (prev?.f ?? null) === (cell?.f ?? null) && sameJSON(prev?.v ?? null, cell?.v ?? null)
        && sameJSON(fixedArraySize(prev?.array), fixedArraySize(cell?.array));
      const a = !same && index.at(r, c);
      if (a && !checked.has(a.key)) {
        checked.add(a.key);
        // Removing/changing the anchor changes every result, including
        // protected output cells that have no stored cell record.
        if (this.lockedIn(sheet.id, a)) return true;
        const cleared = arrayRange && arrayRange.r1 <= a.r1 && arrayRange.c1 <= a.c1 && arrayRange.r2 >= a.r2 && arrayRange.c2 >= a.c2;
        if (!cleared) {
          if (a.rows * a.cols > writes.size) return this._arrayRefused(sheet, a);
          for (let rr = a.r1; rr <= a.r2; rr++) for (let cc = a.c1; cc <= a.c2; cc++) {
            if (!writes.has(cellKey(rr, cc))) return this._arrayRefused(sheet, a);
          }
        }
      }
    }
    for (const { r, c, cell } of entries) {
      const size = typeof cell?.f === 'string' && fixedArraySize(cell.array);
      if (!size) continue;
      const key = cellKey(r, c), prev = sheet.cells.get(key);
      if (prev?.f === cell.f && sameJSON(prev.array, size) && !checked.has(key)) continue; // formatting alone
      const a = { r1: r, c1: c, r2: r + size.rows - 1, c2: c + size.cols - 1 };
      const limit = gridLimits(sheet);
      if (a.r2 > MAX_ROW || a.c2 > MAX_COL || a.r2 >= limit.rows || a.c2 >= limit.cols) return this._arrayRefused(sheet, a, 'bounds');
      if (this.lockedIn(sheet.id, a)) return true;
      if (sheet.merges.some(m => intersection(a, m)) || sheet.tables.some(t => intersection(a, t.range))) return this._arrayRefused(sheet, a, 'overlap');
      for (const existing of index.overlapping(a)) {
        if (existing.key === key) continue;
        const next = writes.has(existing.key) ? writes.get(existing.key) : sheet.cells.get(existing.key);
        if (next?.array) return this._arrayRefused(sheet, existing, 'overlap');
      }
      // A new fixed array must not silently cover existing data. Whole-array
      // entry/paste clears its output cells in the same authorized write.
      for (const [otherKey, stored] of sheet.cells) {
        if (otherKey === key) continue;
        const p = parseKey(otherKey);
        if (p.r < a.r1 || p.r > a.r2 || p.c < a.c1 || p.c > a.c2) continue;
        const next = writes.has(otherKey) ? writes.get(otherKey) : stored;
        if (next?.v != null || next?.f != null) return this._arrayRefused(sheet, a, 'overlap');
      }
      for (const [otherKey, next] of writes) {
        if (otherKey === key || next?.v == null && next?.f == null) continue;
        const p = parseKey(otherKey);
        if (p.r >= a.r1 && p.r <= a.r2 && p.c >= a.c1 && p.c <= a.c2) return this._arrayRefused(sheet, a, 'overlap');
      }
    }
    return false;
  }

  /** Enter or replace one fixed array as an atomic, undoable operation. */
  /**
   * What-If Analysis ▸ Data Table: the selection holds the formulas along its top row or left column (both, at the
   * corner, for two inputs) and the values to try along the other; the rest fills with {=TABLE(row input, column input)}.
   */
  createDataTable(sheetId, range, rowInput, colInput) {
    const sheet = this.sheet(sheetId), area = normalizeRange(range);
    if (!sheet) return { ok: false, reason: 'No such sheet' };
    if (area.r2 - area.r1 < 1 || area.c2 - area.c1 < 1) return { ok: false, reason: 'Select the formulas, the values to try and the cells for the results: at least two rows and two columns' };
    if (!rowInput && !colInput) return { ok: false, reason: 'Enter a row input cell, a column input cell, or both' };
    for (const input of [rowInput, colInput]) {
      if (input && input.r >= area.r1 && input.r <= area.r2 && input.c >= area.c1 && input.c <= area.c2) return { ok: false, reason: 'Input cell reference is not valid: it lies inside the table' };
    }
    const results = { r1: area.r1 + 1, c1: area.c1 + 1, r2: area.r2, c2: area.c2 };
    const name = (p) => (p ? cellName(p.r, p.c) : '');
    if (this.lockedIn(sheetId, results)) return { ok: false, reason: 'The sheet is protected' };
    return this.setArrayFormula(sheetId, results, `=TABLE(${name(rowInput)},${name(colInput)})`, 'Data table')
      ? { ok: true, range: results } : { ok: false, reason: 'Cannot change part of an array' };
  }

  setArrayFormula(sheetId, range, text, label = 'Edit array formula') {
    const sheet = this.sheet(sheetId), area = normalizeRange(range);
    if (!sheet || !validStoredRange(area) || this.lockedIn(sheetId, area)
      || this.arrayEditBlocked(sheetId, area, { whole: true })) return false;
    const cell = cellFromInput(text, this.styleAt(sheetId, area.r1, area.c1));
    if (cell?.f == null) return !this._arrayRefused(sheet, area, 'formula');
    cell.f = this._closeParentheses(cell.f);
    if (cell.f.length > MAX_FORMULA_LENGTH) return !this._arrayRefused(sheet, area, 'formula');
    cell.array = { rows: area.r2 - area.r1 + 1, cols: area.c2 - area.c1 + 1 };
    const entries = [];
    for (const [key, old] of sheet.cells) {
      const { r, c } = parseKey(key);
      if (r < area.r1 || r > area.r2 || c < area.c1 || c > area.c2 || r === area.r1 && c === area.c1) continue;
      entries.push({ r, c, cell: old.s ? { v: null, f: null, s: old.s } : null });
    }
    entries.push({ r: area.r1, c: area.c1, cell });
    return this.setCells(sheetId, entries, label, { arrayRange: area }) > 0;
  }

  isDynamicArrayFormula(sheetId, r, c) {
    const sheet = this.sheet(sheetId), cell = sheet?.cells.get(cellKey(r, c));
    if (cell?.f == null || cell.array) return false;
    if (savedExternalResult(cell)?.array) return true;
    let ast;
    try { ast = this._cellAst(cell); } catch (e) { if (e instanceof RangeError) return false; throw e; }
    return !!ast && this._isArrayCandidate(ast, sheet.name);
  }

  _arrayValue(a, row, col) {
    if (a.sample && (row || col)) {
      const key = `${row},${col}`;
      if (!a.samples.has(key)) {
        if (a.sampling) return err('#CYCLE!');
        a.sampling = true;
        try { a.samples.set(key, fixedArrayValue(a.sample(), row, col)); }
        catch (e) { a.samples.set(key, err(e instanceof RangeError ? '#VALUE!' : '#ERROR!')); }
        finally { a.sampling = false; }
      }
      return a.samples.get(key);
    }
    return a.fixed ? fixedArrayValue(a.result, row, col) : a.values[row]?.[col] ?? 0;
  }

  _fixedResult(sheet, r, c, result, randomized = false) {
    const key = cellKey(r, c), range = this._fixedArrays(sheet).at(r, c);
    if (!range || range.key !== key) return scalar(result) ?? 0;
    const st = this._spills.get(sheet.id);
    if (st) {
      const anchor = { ...range, fixed: true, result };
      if (randomized && range.rows * range.cols > 1) {
        const ast = this._cellAst(sheet.cells.get(key));
        // Keep the array's ROW/COLUMN context and relative-reference origin
        // while evaluating random expressions independently per output cell.
        // Only requested outputs are sampled; a huge scalar array stays sparse.
        anchor.samples = new Map();
        anchor.sample = () => withArrayBudget(() => evaluateFormula(ast, this._formulaContext(sheet, r, c)));
      }
      st.anchors.set(key, anchor);
      if (range.rows > 1 || range.cols > 1) st.spread.set(key, anchor);
      this._forgetRanges(sheet, range.r1, range.c1, range.r2, range.c2);
      this._usedCache.delete(sheet.id);
      if (this._growTo(sheet, range.r2 + 1, range.c2 + 1)) this._grown.add(sheet.id);
    }
    return fixedArrayValue(result, 0, 0);
  }

  _ensureSpills(sheet) {
    let st = this._spills.get(sheet.id);
    if (st) return st;
    // `anchors` holds every array formula's extent, `spread` those that cover more than their own cell.
    st = { anchors: new Map(), cover: new Map(), spread: new Map(), fixed: this._fixedArrays(sheet), building: true };
    this._spills.set(sheet.id, st);
    const candidates = [];
    for (const [key, cell] of sheet.cells) {
      if (cell.f == null) continue;
      // A formula nested deeper than the parser can follow spills nothing.
      let candidate = !!cell.array || !!savedExternalResult(cell)?.array;
      try { candidate ||= this._isArrayCandidate(this._cellAst(cell), sheet.name); } catch (e) { if (!(e instanceof RangeError)) throw e; }
      if (candidate) candidates.push(parseKey(key));
    }
    if (!candidates.length) { st.building = false; return st; }
    candidates.sort((a, b) => a.r - b.r || a.c - b.c);
    this._spillBuilds.push({ state: st, active: new Set(this._evaluating) });
    try {
      try {
      let signature = '';
      for (let pass = 0; pass < 3; pass++) {
        const from = this._spillComputed.length;
        // What the cells calculated in this pass could have read, judged as each spill lands (see _noteLanding).
        st.reads = { checked: from, box: null, open: false, stale: false };
        for (const { r, c } of candidates) this._compute(sheet, r, c);
        const next = [...st.anchors.values()].map((a) => `${a.r},${a.c}:${a.rows}x${a.cols}`).join('|');
        // A pass whose spills covered nothing that a formula calculated in it could have read while blank
        // left nothing stale behind: its values stand, and the second pass, which evaluated every candidate
        // again (one SORT of 20,000 rows twice per keystroke anywhere), is skipped.
        if (next === signature || !st.reads.stale) break;
        signature = next;
        // A formula calculated during the pass may have read a cell before the spill covering it
        // landed. One calculated before the discovery began could not have, since reading a blank
        // cell of this sheet is what begins it: that one keeps its value, so a RAND() a dependent
        // has already shown is not drawn again for the cell itself.
        for (let k = from; k < this._spillComputed.length; k++) this._cache.delete(this._spillComputed[k]);
        this._spillComputed.length = from;
        this._rangeCache.clear();
        this._usedCache.clear();
        this._statsCache.clear();
      }
      } catch (e) {
        // A candidate's chain overflowed the stack: this half-built state
        // is discarded so the next request rebuilds it from the bottom up.
        if (e instanceof RangeError) this._spills.delete(sheet.id);
        throw e;
      }
    } finally {
      this._spillBuilds.pop();
      st.building = false;
      st.reads = null;
      if (!this._spillBuilds.length && !this._hasDeferredSpills) this._spillComputed.length = 0;
    }
    this._settleDeferredSpills();
    this._announceGrown();
    return st;
  }

  /** Retry discovery that encountered a calculation already in progress. */
  _settleDeferredSpills() {
    if (!this._hasDeferredSpills || this._settlingSpills || this._evaluating.size || this._spillBuilds.length) return false;
    let settled = false;
    this._settlingSpills = true;
    try {
      while (this._hasDeferredSpills) {
        this._hasDeferredSpills = false;
        const pending = [...this._spills].filter(([, st]) => st.pending);
        if (!pending.length) break;
        settled = true;
        for (const [id] of pending) this._spills.delete(id);
        // Whatever was calculated since discovery met a calculation in progress may rest on the
        // half-built picture; what was calculated before it could not.
        for (const key of this._spillComputed) this._cache.delete(key);
        this._spillComputed.length = 0;
        this._rangeCache.clear();
        this._usedCache.clear();
        this._statsCache.clear();
        // Each pass settles at least its first sheet outside any active
        // calculation. Nested discoveries may defer other sheets in turn.
        for (const [id] of pending) { const sheet = this.sheet(id); if (sheet) this._ensureSpills(sheet); }
      }
    } finally {
      this._settlingSpills = false;
    }
    return settled;
  }

  /** Value a blank cell shows because an array formula spilled over it, else null. */
  _spillValue(sheet, r, c) {
    const st = this._ensureSpills(sheet);
    const key = cellKey(r, c);
    const fixed = st.fixed.at(r, c);
    const anchorKey = fixed?.key !== key && fixed?.key || st.cover.get(key);
    if (!anchorKey) return null;
    if (!this._cache.has(`${sheet.id}|${anchorKey}`)) {
      // The values registered here are the anchor's previous result. Calculating the anchor
      // first keeps a chain of spills that settle through covered cells current within one
      // pass, and a cycle closing through a covered cell reads the anchor's #CYCLE!.
      const { r: ar, c: ac } = parseKey(anchorKey);
      const value = this._compute(sheet, ar, ac);
      if (!this._cache.has(`${sheet.id}|${anchorKey}`)) return value; // still calculating: this read is inside its cycle
      return this._spillValue(sheet, r, c); // the anchor may have landed a different shape
    }
    const a = st.anchors.get(anchorKey);
    return a ? this._arrayValue(a, r - a.r, c - a.c) : null;
  }

  /** A recalculated formula must release cells covered by its previous result. */
  _clearSpill(sheet, key, st = this._spills.get(sheet.id)) {
    const prev = st?.anchors.get(key);
    if (!prev) return;
    st.anchors.delete(key);
    if (prev.rows === 1 && prev.cols === 1) return; // a one-cell anchor covered nothing (see _spillResult)
    if (!prev.fixed) for (let i = 0; i < prev.rows; i++) for (let j = 0; j < prev.cols; j++) {
      if (i || j) st.cover.delete(cellKey(prev.r + i, prev.c + j));
    }
    st.spread.delete(key);
    this._usedCache.delete(sheet.id);
    this._forgetRanges(sheet, prev.r, prev.c, prev.r + prev.rows - 1, prev.c + prev.cols - 1);
  }

  /**
   * Drop the shared arrays of ranges on `sheet` that overlap a block whose values just changed
   * (a spill landing or leaving). Ranges elsewhere stay: 300 lookups over the same two columns
   * would otherwise re-read them for every formula that merely could have spilled.
   */
  _forgetRanges(sheet, r1, c1, r2, c2) {
    const prefix = `${sheet.id}|`;
    for (const [key, values] of this._rangeCache) {
      if (!key.startsWith(prefix)) continue;
      const [kr1, kc1, kr2, kc2] = key.slice(prefix.length).split(',').map(Number);
      if (kr1 > r2 || kr2 < r1 || kc1 > c2 || kc2 < c1) continue;
      this._rangeCache.delete(key);
      this._rangeCacheCells -= rangeCost(values);
    }
  }

  /**
   * An array formula answered one value rather than a range of one cell: =A1# copying an array
   * formula that has narrowed to one row is such a formula, since a one-cell spill range is read as
   * a plain cell reference. It is an array formula all the same and has a spill range of its own,
   * the cell itself, so a dashboard built on =C1# and SUM(C1#) a step further along holds when a
   * FILTER or UNIQUE narrows. An error clears the anchor instead, as a blocked #SPILL! does.
   */
  _spillOneValue(sheet, r, c, value) {
    const key = cellKey(r, c);
    const st = this._spills.get(sheet.id);
    this._clearSpill(sheet, key, st);
    if (!st || (value != null && typeof value === 'object')) return; // an error, or a lambda never called
    st.anchors.set(key, { r, c, rows: 1, cols: 1, values: [[value]] }); // covers no neighbour
  }

  /**
   * A formula produced a range: spill it. The anchor shows the top-left
   * value; blank neighbours show the rest. Anything in the way (a cell with
   * content, another spill) blocks it and the anchor shows #SPILL!.
   * `candidate` says whether the formula is an array formula (see
   * _isArrayCandidate): one whose result is a single cell still has a spill
   * range, the cell itself, so A1# refers to it and SUM(A1#) holds when a
   * FILTER narrows to one row. A one-cell reference that is no array formula
   * (=INDEX(A:A,ROW()), =Tax) registers nothing.
   */
  _spillResult(sheet, r, c, range, candidate = false) {
    const values = range.values;
    const rows = values.length;
    const cols = values[0]?.length || 0;
    const st = this._spills.get(sheet.id), key = cellKey(r, c);
    this._clearSpill(sheet, key, st);
    if (rows === 1 && cols === 1) {
      if (st && candidate) st.anchors.set(key, { r, c, rows: 1, cols: 1, values }); // covers no neighbour
      return values[0][0] ?? 0;
    }
    if (!rows || !cols) return err('#VALUE!');
    if (!st) return scalar(range) ?? 0;
    // A spill is all-or-nothing. Imported sheets may already be larger
    // than the scrolling cap, but no result may be silently truncated.
    const rowLimit = Math.min(MAX_ROW + 1, Math.max(sheet.rows, MAX_ROWS));
    const colLimit = Math.min(MAX_COL + 1, Math.max(sheet.cols, MAX_COLS));
    if (r + rows > rowLimit || c + cols > colLimit) return err('#SPILL!');
    if (st.fixed.overlapping({ r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 }).next().value) return err('#SPILL!');
    // A merged block anywhere in the way stops the spill, the anchor's own merge included.
    if (sheet.merges.some((m) => m.r2 >= r && m.r1 <= r + rows - 1 && m.c2 >= c && m.c1 <= c + cols - 1)) return err('#SPILL!');
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (!i && !j) continue;
        const k = cellKey(r + i, c + j);
        const cell = sheet.cells.get(k);
        if ((cell && (cell.v != null || cell.f != null)) || st.cover.has(k)) return err('#SPILL!');
      }
    }
    const anchor = { r, c, rows, cols, values };
    st.anchors.set(key, anchor);
    st.spread.set(key, anchor);
    this._forgetRanges(sheet, r, c, r + rows - 1, c + cols - 1); // ranges read before this spill landed no longer hold
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if (i || j) st.cover.set(cellKey(r + i, c + j), key);
    if (st.reads) this._noteLanding(sheet, st, key, r, c, r + rows - 1, c + cols - 1);
    this._usedCache.delete(sheet.id);
    // Announced once the calculation has finished: a listener reading a dependent of this spill
    // now would see the anchor's provisional #CYCLE!.
    if (this._growTo(sheet, r + rows, c + cols)) this._grown.add(sheet.id);
    return values[0][0] ?? 0;
  }

  /**
   * A spill landed while the sheet's spills were being worked out: a formula calculated earlier in the
   * pass may have read the covered cells while they were still blank. Whether one could have is judged
   * from the formulas' text, each calculated cell once (see staticReads): the pass is stale, and is run
   * again, when the landing lies within what they read, or when what one of them reads cannot be known.
   */
  _noteLanding(sheet, st, key, r1, c1, r2, c2) {
    const reads = st.reads;
    if (reads.stale) return;
    // A nested discovery may have cut the list of calculated cells short; whatever is calculated again is judged again.
    if (reads.checked > this._spillComputed.length) reads.checked = this._spillComputed.length;
    for (; reads.checked < this._spillComputed.length && !reads.open; reads.checked++) this._noteReads(sheet, reads, this._spillComputed[reads.checked]);
    this._noteReads(sheet, reads, `${sheet.id}|${key}`); // the anchor itself read before it landed
    const box = reads.box;
    if (reads.open || (box && box.r1 <= r2 && box.r2 >= r1 && box.c1 <= c2 && box.c2 >= c1)) reads.stale = true;
  }

  /** Fold what the formula at a calculated key can read on `sheet` into a pass's reads (see _noteLanding). */
  _noteReads(sheet, reads, computedKey) {
    if (reads.open) return;
    const bar = computedKey.indexOf('|');
    const owner = this.sheet(computedKey.slice(0, bar));
    const cell = owner?.cells.get(computedKey.slice(bar + 1));
    if (!cell || cell.f == null) return;
    let ast = null;
    // A formula too deep to parse from here is taken to read anything; one that does not parse reads nothing.
    try { ast = this._cellAst(cell); } catch (e) { if (!(e instanceof RangeError)) throw e; reads.open = true; return; }
    if (!ast) return;
    const list = staticReads(ast);
    if (!list) { reads.open = true; return; }
    for (const read of list) {
      const target = read.sheet ? this.sheetByName(read.sheet) : owner;
      if (target !== sheet) continue;
      let { r2, c2 } = read;
      const { r1, c1 } = read;
      if (read.spill) {
        // A1#: the anchor and what it has spilled, which was settled before the reference was read.
        const a = this._spills.get(sheet.id)?.anchors.get(cellKey(r1, c1));
        if (a) { r2 = a.r + a.rows - 1; c2 = a.c + a.cols - 1; }
      }
      reads.box = reads.box
        ? { r1: Math.min(reads.box.r1, r1), c1: Math.min(reads.box.c1, c1), r2: Math.max(reads.box.r2, r2), c2: Math.max(reads.box.c2, c2) }
        : { r1, c1, r2, c2 };
    }
  }

  /** Announce the sheets spills have grown, once no calculation is in progress for a listener to read into. */
  _announceGrown() {
    if (!this._grown.size || this._evaluating.size || this._spillBuilds.length || this._iteration) return;
    const ids = [...this._grown];
    this._grown.clear();
    for (const id of ids) this._emit('layout', id);
  }

  /**
   * For a blank cell covered by a spill: { value, style, anchor: { r, c } },
   * where `style` carries the anchor's number format. Null otherwise.
   */
  spillAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const st = this._ensureSpills(sheet);
    const key = cellKey(r, c), fixed = st.fixed.at(r, c);
    const anchorKey = fixed?.key !== key && fixed?.key || st.cover.get(key);
    if (!anchorKey) return null;
    const a = st.anchors.get(anchorKey);
    if (!a) return null;
    const own = sheet.cells.get(anchorKey)?.s;
    // The anchor can inherit its format without storing a cell style (for example after import).
    // Only its number format travels with the spill; its line's fill and font stay on that line.
    const line = this._lineStyle(sheet, a.r, a.c);
    const s = a.fixed ? null : line ? { ...line, ...own } : own;
    const style = s ? {} : null;
    if (s) {
      // Missing fields must not erase the destination's defaults when only bold/fill/etc. changed.
      // Explicit null resets, zero decimals and disabled grouping still travel with the anchor.
      if (s.fmt !== undefined) style.fmt = s.fmt;
      for (const key of FORMAT_DETAIL_KEYS) if (s[key] !== undefined) style[key] = s[key];
    }
    return { value: this._arrayValue(a, r - a.r, c - a.c), style, anchor: { r: a.r, c: a.c } };
  }

  /** The range an array formula at (r, c) spills over, or null. */
  spillRangeAt(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    const cell = sheet.cells.get(cellKey(r, c));
    if (!cell || cell.f == null) return null;
    this._compute(sheet, r, c);
    const a = this._ensureSpills(sheet).anchors.get(cellKey(r, c));
    return a ? { r1: a.r, c1: a.c, r2: a.r + a.rows - 1, c2: a.c + a.cols - 1 } : null;
  }

  /** Spilled values as { r, c, value } (anchors excluded), optionally restricted to a rectangle. */
  spillEntries(sheetId, range = null) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [];
    const st = this._ensureSpills(sheet);
    const out = [];
    for (const a of st.anchors.values()) {
      const i1 = range ? Math.max(0, range.r1 - a.r) : 0, i2 = range ? Math.min(a.rows, range.r2 - a.r + 1) : a.rows;
      const j1 = range ? Math.max(0, range.c1 - a.c) : 0, j2 = range ? Math.min(a.cols, range.c2 - a.c + 1) : a.cols;
      if (i1 >= i2 || j1 >= j2) continue;
      for (let i = i1; i < i2; i++) for (let j = j1; j < j2; j++) if (i || j) out.push({ r: a.r + i, c: a.c + j, value: this._arrayValue(a, i, j) });
    }
    return out;
  }

  /* ---------- Evaluation ---------- */

  getValue(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return err('#REF!');
    return this._compute(sheet, r, c);
  }

  /** Format a cell, optionally reusing a value already read for a clipboard snapshot. */
  getDisplay(sheetId, r, c, value) {
    const sheet = this.sheet(sheetId);
    const cell = sheet?.cells.get(cellKey(r, c));
    // A cell reads in its own format over the one its column or row carries, as styleAt has it, so a
    // value written into a formatted column shows that format however it arrived and however far down
    // it sits. A sheet with no whole-line format costs nothing for the question.
    const lines = sheet ? this._lineStyle(sheet, r, c) : null;
    if (!cell || (cell.v == null && cell.f == null)) {
      const spill = this.spillAt(sheetId, r, c);
      // The line's format stands under the anchor's, so a spilled value reads as the cell it spilled from does.
      return spill ? formatValue(value === undefined ? spill.value : value, this._pivotDisplayStyle(sheetId, r, c, { ...lines, ...(spill.style || {}), ...(cell?.s || {}) })) : '';
    }
    return formatValue(value === undefined ? this.getValue(sheetId, r, c) : value, this._pivotDisplayStyle(sheetId, r, c, lines ? { ...lines, ...cell.s } : cell.s));
  }

  /** Computed values for a range, as a 2D array. */
  rangeValues(sheetId, range) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return [[]];
    const { r1, c1, r2, c2 } = normalizeRange(range);
    const out = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(this._compute(sheet, r, c));
      out.push(row);
    }
    return out;
  }

  _ast(formula) {
    let ast = this._astCache.get(formula);
    if (ast === undefined) {
      try {
        ast = parseFormula(formula);
      } catch (e) {
        // Parsing deep inside a long chain can overflow the stack; that is
        // not a bad formula and must not be remembered as one.
        if (e instanceof RangeError) throw e;
        ast = null;
      }
      if (this._astCache.size > 5000) this._astCache.clear();
      this._astCache.set(formula, ast);
    }
    return ast;
  }

  /**
   * The parsed formula, or null when it cannot be read. A formula nested
   * deeper than the stack allows is null here too (and stays uncached, since
   * a shallower frame may still parse it): links, rules, names, and the spill
   * scan have no shallower frame to unwind to and treat it as unreadable.
   */
  _astOrNull(formula) {
    try { return this._ast(formula); } catch (e) { if (e instanceof RangeError) return null; throw e; }
  }

  /** The parsed formula of a cell, kept with the cell so distinct formulas in every row are parsed once. */
  _cellAst(cell) {
    const hit = this._astByCell.get(cell);
    if (hit && hit.f === cell.f) return hit.ast;
    const ast = this._ast(cell.f);
    this._astByCell.set(cell, { f: cell.f, ast });
    return ast;
  }

  _externalDependencies(sheet, r, c, formula, options) {
    return callerDependencies(this._astOrNull(formula), (name, scope) => {
      const owner = scope || sheet.name;
      const entry = owner.startsWith('[') && !isWorkbookNameScope(owner) ? externalNamedEntries(this.externalWorkbooks, owner).get(name.toLowerCase()) : this.namedEntry(name, owner);
      if (!entry) return null;
      // Link indexes are package-local. Compare definitions by source identity
      // so clipboard compaction or destination reindexing does not invalidate them.
      const canonical = externalFormulaProvenance(this.externalWorkbooks, entry.ref);
      return { key: `${owner}|${name.toLowerCase()}`, signature: [name.toLowerCase(), canonical, !!entry.relative],
        relative: entry.relative, ast: this._astOrNull(entry.relative ? resolveRelativeName(entry.ref, r, c) : entry.ref) };
    }, options);
  }

  _externalLinks(sheet, r, c, formula) {
    if (!this._astOrNull(formula)) return { linked: externalFormulaHasLinks(formula, this.externalWorkbooks), cached: externalFormulaHasCaches(formula, this.externalWorkbooks) };
    return externalLinksFromDependencies(this._externalDependencies(sheet, r, c, formula, { expandAllNames: true }), this.externalWorkbooks);
  }

  /** Persist only the parts of the caller frame and local inputs this expression can observe. */
  _externalCallerContext(sheet, r, c, formula, inputs = true) {
    const digest = value => Array.from(sha256(new TextEncoder().encode(JSON.stringify(value))), n => n.toString(16).padStart(2, '0')).join('');
    const profile = this._externalDependencies(sheet, r, c, formula);
    const { flags, definitions } = profile, context = {};
    if (inputs) {
      const { signature, sources } = externalInputContext(this, sheet, r, c, formula, profile);
      if (signature) context.inputs = signature;
      if (sources.length) context.sources = [...sources];
    }
    if (definitions.length) {
      const { signature, sources } = externalProvenance(definitions);
      context.names = signature;
      if (sources.length) context.sources = [...(context.sources || []), ...sources];
    }
    if (flags.includes('locale')) context.locale = getLocale();
    if (flags.includes('compatibility')) context.compatibilityVersion = this.calculationCompatibility.version;
    if (flags.includes('row')) context.r = r;
    if (flags.includes('col')) context.c = c;
    if (flags.includes('sheet')) context.sheetName = sheet.name;
    if (flags.includes('count')) context.count = this.sheets.length;
    if (flags.includes('index')) context.index = this.sheets.indexOf(sheet) + 1;
    if (flags.includes('order')) {
      let order = this._statsCache.get(EXTERNAL_CALLER_ORDER);
      if (!order) {
        order = digest(this.sheets.map(s => s.name));
        this._statsCache.set(EXTERNAL_CALLER_ORDER, order);
      }
      context.order = order;
    }
    return context;
  }

  _compute(sheet, r, c) {
    if (this.iteration && !this._iterationReady && !this._iteration && !this._evaluating.size && !this._spillBuilds.length) calculateIteratively(this);
    const cell = sheet.cells.get(cellKey(r, c));
    const fixed = cell?.array && this._fixedArrays(sheet).at(r, c);
    if (fixed && !this._spills.has(sheet.id)) {
      this._ensureSpills(sheet);
      const cached = `${sheet.id}|${r},${c}`;
      if (this._cache.has(cached)) return this._cache.get(cached);
    }
    if (!cell || cell.f == null) {
      if (cell && cell.v != null) return cell.v;
      return this._spillValue(sheet, r, c);
    }
    const key = `${sheet.id}|${r},${c}`;
    if (this._iteration && this._evaluating.size) {
      let reader;
      for (const k of this._evaluating) reader = k;
      let dependents = this._iteration.dependents.get(key);
      if (!dependents) this._iteration.dependents.set(key, dependents = new Set());
      dependents.add(reader);
    }
    if (this._blankKeys !== null && this._blankKeys.has(key)) return null;
    if (this._cache.has(key)) return this._cache.get(key);
    const saved = savedExternalResult(cell);
    const links = saved && this._externalLinks(sheet, r, c, cell.f);
    if (saved && links.linked && !links.cached
      && sameJSON(saved.context, this._externalCallerContext(sheet, r, c, cell.f))) {
      let value = saved.value;
      if (saved.array) {
        if (!fixed && saved.array.rows * saved.array.cols > ARRAY_BUDGET) value = err('#NUM!');
        else {
          this._ensureSpills(sheet);
          const range = savedExternalRange(saved);
          value = fixed ? this._fixedResult(sheet, r, c, range) : this._spillResult(sheet, r, c, range, true);
        }
      }
      this._cache.set(key, value);
      return value;
    }
    if (this._evaluating.has(key)) {
      // Spill discovery can prefetch an unrelated dependent of the caller.
      // Its cycle is provisional until that outer calculation has finished.
      let deferred = false;
      for (const build of this._spillBuilds) if (build.active.has(key)) {
        build.state.pending = true;
        this._hasDeferredSpills = true;
        deferred = true;
      }
      // Otherwise every cell calculating since this one began lies on a circle of references.
      // Whether that is a cycle is settled once the innermost of them, the reader, has its answer.
      if (!deferred) {
        if (this._iteration && !this._iteration.discovery) {
          let inside = false;
          for (const k of this._evaluating) { if (k === key) inside = true; if (inside) this._iteration.members.add(k); }
          return key === this._iteration.current ? this._iteration.prior : cell.v ?? 0;
        }
        if (this._blankProvisional) return null;
        const circle = [];
        let inside = false;
        for (const k of this._evaluating) { if (k === key) inside = true; if (inside) circle.push(k); }
        const reader = circle[circle.length - 1];
        const pending = this._provisional.get(reader);
        if (pending) for (const k of circle) pending.add(k); else this._provisional.set(reader, new Set(circle));
      }
      return err('#CYCLE!');
    }
    let ast;
    let arrayCandidate;
    try {
      ast = this._cellAst(cell);
      arrayCandidate = !!fixed || (ast ? this._isArrayCandidate(ast, sheet.name) : false);
    } catch (e) {
      // Parsing at a deep frame may run out of stack: unwind to a shallower one, which
      // parses again. From a shallow frame the formula itself nests too deep to evaluate.
      if (!(e instanceof RangeError)) throw e;
      if (this._depth > DEEP_FRAMES) throw e;
      ast = null;
    }
    if (!ast) {
      const e = err('#ERROR!');
      if (fixed) this._fixedResult(sheet, r, c, e);
      this._cache.set(key, e);
      return e;
    }
    if (arrayCandidate) {
      // Array formulas are settled sheet-wide first, so that whatever they
      // spill over is known before any cell is read.
      this._ensureSpills(sheet);
      if (this._cache.has(key)) return this._cache.get(key);
    }
    this._evaluating.add(key);
    this._depth++;
    let value;
    let raw;
    let deep = false;
    try {
      // Each cell's own calculation gets a fresh array budget, whatever depth it is read at.
      const ctx = this._formulaContext(sheet, r, c);
      value = withArrayBudget(() => evaluateFormula(ast, ctx));
      raw = value;
      if (fixed) value = this._fixedResult(sheet, r, c, value, ctx.fixedArray.randomized);
      else if (isRange(value)) value = this._spillResult(sheet, r, c, value, arrayCandidate);
      else {
        // Functions can inspect an empty reference; a completed formula instead
        // materializes it as zero. Keep intentional empty strings unchanged.
        value ??= 0;
        if (arrayCandidate) this._spillOneValue(sheet, r, c, value);
      }
      // A lambda that was never called has no value a cell can show.
      if (value != null && typeof value === 'object' && value.lambda) value = err('#CALC!');
      if (this._provisional.has(key)) value = this._settleProvisional(sheet, r, c, key, ast, raw, value);
    } catch (e) {
      // A RangeError is a stack overflow unless it says otherwise (a text or array too long to
      // build). In the frame where the stack ran out even this check may fail: that is the overflow.
      let overflow = e instanceof RangeError;
      if (overflow) try { overflow = /call stack/i.test(e.message); } catch { overflow = true; }
      if (overflow) {
        // The precedents chain deeper than the call stack allows. Unwind
        // to a shallow frame, which evaluates the chain from the bottom up.
        if (this._depth > DEEP_FRAMES) throw e;
        deep = true;
      } else {
        if (arrayCandidate) this._clearSpill(sheet, cellKey(r, c));
        // Any other RangeError is a text or array too long for the engine to build: not a value the cell can have.
        value = err(e instanceof RangeError ? '#VALUE!' : '#ERROR!');
        if (fixed) this._fixedResult(sheet, r, c, value);
      }
    } finally {
      this._depth--;
      this._evaluating.delete(key);
      this._provisional.delete(key);
    }
    if (deep) return this._computeDeep(sheet, r, c);
    if (this._cyclic.delete(key)) value = err('#CYCLE!');
    this._cache.set(key, value);
    if (this._spillBuilds.length || this._hasDeferredSpills) this._spillComputed.push(key);
    if (this._unsettled.length) value = this._judgeCircles(key, value, raw);
    if (fixed && value?.error === '#CYCLE!') this._fixedResult(sheet, r, c, value);
    if (this._settleDeferredSpills()) return this._compute(sheet, r, c);
    this._announceGrown();
    return value;
  }

  /**
   * A formula read a cell still being calculated, closing a circle of references. That is a
   * cycle when the provisional value told in its answer: COUNTA(A:A) in column A counted it,
   * ISERROR and IFERROR swallowed it, a sum carried the #CYCLE! through. It is not when the
   * answer would have been the same with the cell read as blank: INDEX(A1:F1+1:1,1,5) in D1
   * took another cell of its own row, and a table reference failing for another reason failed
   * the same way. Every cell on the circle of a cycle ends as #CYCLE!.
   */
  _settleProvisional(sheet, r, c, key, ast, raw, value) {
    const circle = this._provisional.get(key);
    this._provisional.delete(key);
    let told = isError(value) && value.error === '#CYCLE!';
    if (!told) {
      this._blankProvisional++;
      let again;
      try { again = withArrayBudget(() => evaluateFormula(ast, this._formulaContext(sheet, r, c))); } catch (e) {
        if (e instanceof RangeError) throw e;
        again = err('#ERROR!');
      } finally { this._blankProvisional--; this._provisional.delete(key); }
      told = !sameResult(again, raw);
    }
    if (!told) {
      // The answer stood with the cell read as blank, but the cell may yet end with a value that
      // would have told: the judgement is made again once the outermost cell of the circle has one.
      let outer = key;
      for (const k of this._evaluating) if (circle.has(k)) { outer = k; break; }
      this._unsettled.push({ outer, reader: key, circle, sheet, r, c, ast, raw });
      return value;
    }
    for (const k of circle) { this._cyclic.add(k); this._iteration?.members.add(k); }
    this._cyclic.delete(key);
    return err('#CYCLE!');
  }

  /**
   * A cell has its value, and it is the outermost of a circle whose reader kept its provisional
   * answer: the reader is calculated once more against the real values of the circle, and a
   * different answer makes the circle a cycle after all. B1 = COUNT(A1) read from A1 = B1+1
   * counted nothing while A1 was still being calculated, but A1 ends as 1, which it counts; read
   * from B1 the same pair was a cycle at once, and the verdict must not depend on the order. The
   * outer cell is judged the same way, with the circle's other cells read as blank: A1 = IFNA(B1,0)
   * over B1 = NA()+A1 gave B1 the same #N/A whatever A1 said, but A1 took its 0 from B1, and read
   * from B1 the pair was a cycle at once. Only a circle no cell of which reads another's value is
   * accepted, in whichever order it is read (ROWS(B1:B1) in A1 beside ROWS(A1:A1) in B1). Every
   * cell on the circle of a cycle then ends as #CYCLE!, and the cells calculated while the circle
   * was unsettled, which may have read the answer since withdrawn, are dropped to be calculated again.
   * `raw` is the outer cell's answer before spilling, as `entry.raw` is the reader's.
   */
  _judgeCircles(key, value, raw = value) {
    this._tentative.push(key);
    for (let i = 0; i < this._unsettled.length; i++) {
      const entry = this._unsettled[i];
      if (entry.outer !== key) {
        // An outer cell given its value some other way (marked on a chain too deep for the stack) is not judged.
        if (this._cache.has(entry.outer)) this._unsettled.splice(i--, 1);
        continue;
      }
      let again;
      try { again = withArrayBudget(() => evaluateFormula(entry.ast, this._formulaContext(entry.sheet, entry.r, entry.c))); } catch (e) {
        if (e instanceof RangeError) throw e;
        again = err('#ERROR!');
      }
      this._unsettled.splice(i--, 1);
      let cycle = !sameResult(again, entry.raw);
      if (!cycle && entry.reader !== key) {
        // The outer cell read the reader for real: unless its answer stands with the circle's other cells blank, it rests on them.
        if (isError(value) && value.error === '#CYCLE!') cycle = true;
        else {
          const blank = new Set(entry.circle);
          blank.delete(key);
          const bar = key.indexOf('|');
          const outerSheet = this.sheet(key.slice(0, bar));
          const { r, c } = parseKey(key.slice(bar + 1));
          const outerAst = this._cellAst(outerSheet.cells.get(cellKey(r, c)));
          this._blankKeys = blank;
          let outerAgain;
          try { outerAgain = withArrayBudget(() => evaluateFormula(outerAst, this._formulaContext(outerSheet, r, c))); } catch (e) {
            if (e instanceof RangeError) throw e;
            outerAgain = err('#ERROR!');
          } finally { this._blankKeys = null; }
          cycle = !sameResult(outerAgain, raw);
        }
      }
      if (!cycle) continue;
      for (const k of this._tentative) this._cache.delete(k);
      this._tentative.length = 0;
      for (const k of entry.circle) this._cacheCircular(k);
      value = err('#CYCLE!');
    }
    if (!this._unsettled.length) this._tentative.length = 0;
    return value;
  }

  _cacheCircular(key) {
    const value = err('#CYCLE!');
    this._cache.set(key, value);
    this._iteration?.members.add(key);
    const bar = key.indexOf('|'), sheet = this.sheet(key.slice(0, bar));
    const coordinate = key.slice(bar + 1);
    if (sheet?.cells.get(coordinate)?.array) {
      const { r, c } = parseKey(coordinate);
      this._fixedResult(sheet, r, c, value);
    }
  }

  /**
   * Evaluate a cell whose precedents chain deeper than the call stack
   * allows (a running total over thousands of rows, read from the bottom):
   * walk the chain with an explicit stack and compute the deepest cells
   * first, so every evaluation finds its precedents already cached.
   */
  _computeDeep(sheet, r, c) {
    const rootKey = `${sheet.id}|${r},${c}`;
    // Chains through INDIRECT or OFFSET cannot be traced from the formula text: the walk below made
    // no progress. Settle the cell's own column top down before giving up (see _primeColumn).
    if (this._deepening.has(rootKey)) {
      if (!this._priming && this._primeColumn(sheet, r, c, rootKey)) return this._cache.get(rootKey);
      const e = err('#ERROR!');
      this._cache.set(rootKey, e);
      return e;
    }
    this._deepening.add(rootKey);
    try {
      const stack = [{ sheet, r, c, key: rootKey }];
      const expanded = new Set();
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (this._cache.has(top.key)) { stack.pop(); continue; }
        if (!expanded.has(top.key)) {
          expanded.add(top.key);
          let pushed = false;
          for (const p of this._formulaPrecedents(top.sheet, top.r, top.c)) {
            const key = `${p.sheet.id}|${p.r},${p.c}`;
            // An expanded cell still on the stack is on the path to this one: the reference closes
            // a circle, which _compute settles with its own rules for what makes a cycle.
            if (this._cache.has(key) || expanded.has(key)) continue;
            // A cell waiting on the stack but not yet expanded was pushed by another cell, often a
            // sibling (E = SUM(C:D) beside D = IPMT(…,C)): it is no circle, only needed sooner.
            // Pushed again on top, it is calculated first and the waiting entry is then skipped.
            stack.push({ ...p, key });
            pushed = true;
          }
          if (pushed) continue;
        }
        this._compute(top.sheet, top.r, top.c);
        stack.pop();
      }
      return this._cache.has(rootKey) ? this._cache.get(rootKey) : this._compute(sheet, r, c);
    } finally {
      this._deepening.delete(rootKey);
    }
  }

  /**
   * A chain whose links the formula text does not name — =OFFSET(B2,-1,0)+A2 filled down names only
   * its own address — cannot be walked from the bottom, and the cell ran out of stack a second time.
   * Settle the formula cells of its own column top down instead, which is the order a running total
   * resolves in, so that each finds its precedent already calculated; then the cell itself. Stop at
   * the first cell that cannot be settled: the chain does not run downwards, and going on would
   * settle the rest of the column as #ERROR! for nothing. Read from the bottom such a column used to
   * answer #ERROR! in every cell, and the right numbers only when it happened to be read from the top.
   */
  _primeColumn(sheet, r, c, rootKey) {
    this._priming = true;
    try {
      for (let rr = 0; rr < r; rr++) {
        const cell = sheet.cells.get(cellKey(rr, c));
        if (!cell || cell.f == null) continue;
        const key = `${sheet.id}|${rr},${c}`;
        // A cell whose own calculation is still on the stack would read as a circle of references.
        if (this._cache.has(key) || this._evaluating.has(key)) continue;
        const settled = this._compute(sheet, rr, c);
        if (isError(settled) && settled.error === '#ERROR!') break;
      }
      if (!this._cache.has(rootKey)) this._compute(sheet, r, c);
    } finally {
      this._priming = false;
    }
    return this._cache.has(rootKey);
  }

  /** The formula cells a formula reads directly, within the used area of each sheet it names. */
  *_formulaPrecedents(sheet, r, c) {
    const cell = sheet.cells.get(cellKey(r, c));
    if (!cell || cell.f == null) return;
    for (const { ref } of this._formulaRefs(cell.f, sheet.name, { r, c })) {
      const target = this.sheetByName(ref.sheet);
      if (!target) continue;
      const used = this.usedRange(target.id);
      if (!used) continue;
      const r1 = ref.kind === 'cols' ? 0 : ref.r1;
      const r2 = Math.min(ref.kind === 'cols' ? used.r2 : ref.r2, used.r2);
      const c1 = ref.kind === 'rows' ? 0 : ref.c1;
      const c2 = Math.min(ref.kind === 'rows' ? used.c2 : ref.c2, used.c2);
      if (r2 < r1 || c2 < c1) continue;
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > target.cells.size) {
        for (const [key, other] of target.cells) {
          if (other.f == null) continue;
          const { r: rr, c: cc } = parseKey(key);
          if (rr >= r1 && rr <= r2 && cc >= c1 && cc <= c2) yield { sheet: target, r: rr, c: cc };
        }
      } else {
        for (let rr = r1; rr <= r2; rr++) for (let cc = c1; cc <= c2; cc++) {
          if (target.cells.get(cellKey(rr, cc))?.f != null) yield { sheet: target, r: rr, c: cc };
        }
      }
    }
  }

  /** Evaluate formula text as if it stood in (r, c), without writing it (F9 on part of an entry). */
  evaluateText(sheetId, r, c, text) {
    const ctx = this.contextFor(sheetId, r, c);
    if (!ctx) return { error: '#REF!' };
    let ast;
    try { ast = parseFormula(String(text).replace(/^\s*=/, '')); } catch { return { error: '#NAME?' }; }
    try { return withArrayBudget(() => evaluateFormula(ast, ctx)); } catch { return { error: '#VALUE!' }; }
  }

  /** The evaluator context a formula at (r, c) runs with (for tools that evaluate parts of a formula). */
  contextFor(sheetId, r, c) {
    const sheet = this.sheet(sheetId);
    if (!sheet) return null;
    this._ensureSpills(sheet);
    return this._context(sheet, r, c);
  }

  _formulaContext(sheet, r, c) {
    const fixed = sheet.cells.get(cellKey(r, c))?.array && this._fixedArrays(sheet).at(r, c);
    return this._context(sheet, r, c, false, false, fixed ? { ...fixed } : null);
  }

  _context(sheet, r, c, referenceMode = false, relativeNames = false, fixedArray = null, nameScope = sheet.name) {
    // Looking a sheet up by name walks every sheet and reads its name afresh. A function that asks
    // about a cell of another sheet once per cell of a range — SUBTOTAL and AGGREGATE read the
    // formula text of every cell of theirs to find nested ones, and ask whether each row is hidden —
    // would pay that per cell: 40,000 lookups for one SUBTOTAL over 20,000 rows. Nothing can rename
    // a sheet while one formula is being worked out, so each name is looked up once.
    let named = null;
    const byName = (name) => {
      if (!name) return sheet;
      if (named) { const hit = named.get(name); if (hit !== undefined) return hit; } else named = new Map();
      const target = this.sheetByName(name) ?? null;
      named.set(name, target);
      return target;
    };
    const ctx = {
      compatibilityVersion: this.calculationCompatibility.version,
      referenceMode,
      fixedArray,
      currentSheet: sheet.name,
      cell: { r, c },
      sheetExists: (name) => !!this.sheetByName(name),
      indirectSheetExists: (name) => { const sheet = this.sheetByName(name); return !!sheet && !sheet.externalCache; },
      isWorksheet: (name) => byName(name)?.kind !== 'chart',
      sheetsBetween: (a, b) => this.sheetsBetween(a, b),
      nameContext: (name) => {
        if (isWorkbookNameScope(name)) return this._context(sheet, r, c, referenceMode, relativeNames, fixedArray, '[0]');
        const target = this.sheetByName(name);
        return target ? this._context(target, r, c, referenceMode, relativeNames, fixedArray) : null;
      },
      getNamedRef: (name) => {
        if (!relativeNames) return this.namedRef(name, nameScope, ctx.cell);
        const entry = this.namedEntry(name, nameScope);
        return entry ? this.parseNamedRef(entry.relative ? resolveRelativeName(entry.ref, r, c) : shiftFormula(entry.ref, r, c)) : null;
      },
      // Table1[Amount] → the cells it names, seen from this formula's cell.
      resolveTableRef: (tableName, spec) => this._resolveTableRef(sheet, { r, c }, tableName, spec),
      // A name whose text is not a reference is a formula: its AST, or null.
      getNamedFormula: (name) => {
        const entry = this.namedEntry(name, nameScope);
        if (!entry || this.parseNamedRef(entry.ref)) return null;
        return this._ast(entry.relative ? resolveRelativeName(entry.ref, r, c) : relativeNames ? shiftFormula(entry.ref, r, c) : entry.ref);
      },
      sheetIndex: (name) => this.sheets.findIndex((s) => sheetKey(s.name) === sheetKey(name)) + 1,
      sheetCount: () => this.sheets.length,
      getFormula: (sheetName, rr, cc) => {
        const target = byName(sheetName);
        if (!target) return null;
        const array = this._fixedArrays(target).at(rr, cc);
        return target.cells.get(array?.key ?? cellKey(rr, cc))?.f ?? null;
      },
      isFixedArray: (sheetName, rr, cc) => {
        const target = byName(sheetName);
        return !!target && !!this._fixedArrays(target).at(rr, cc);
      },
      // SUBTOTAL skips filtered rows (and, for 101-111, rows hidden by hand).
      isRowHidden: (sheetName, rr, manual) => {
        const target = byName(sheetName);
        return !!target && (target.filterHidden.has(rr) || (manual && target.hiddenRows.has(rr)));
      },
      getValue: (sheetName, rr, cc) => {
        const target = byName(sheetName);
        if (!target || target.kind === 'chart') return err('#REF!');
        return this._compute(target, rr, cc);
      },
      // TABLE: the results of the What-If data table whose array this formula fills.
      dataTable: (rowInput, colInput) => this._dataTableValues(sheet, r, c, rowInput, colInput),
      // GETPIVOTDATA: the pivot report holding a cell, or the block of data around it (a pivot this app built).
      pivotArea: (sheetName, rr, cc) => {
        const target = byName(sheetName);
        if (!target || target.kind === 'chart') return null;
        for (const pivot of this.nativePivots?.tables || []) {
          if (pivot.owner !== target.id) continue;
          const area = parseRefText(pivot.ref || '');
          if (area && rr >= area.r1 && rr <= area.r2 && cc >= area.c1 && cc <= area.c2) return { r1: area.r1, c1: area.c1, r2: area.r2, c2: area.c2 };
        }
        return this.dataRegion(target.id, rr, cc);
      },
      // AI() and other slow sources: the answer when it has arrived, #BUSY! until then.
      asyncValue: (name, text) => this._asyncValue(name, text),
      // IMAGE(url) asks before fetching from the web in a file from elsewhere.
      externalBlocked: () => (this.externalAllowed ? false : (this._noteBlocked(), true)),
      // A1#: the range the array formula at A1 spills over, or null.
      getSpillRange: (ref) => {
        const target = byName(ref.sheet);
        if (!target) return null;
        return this.spillRangeAt(target.id, ref.r1, ref.c1);
      },
      getRangeValues: (ref) => {
        const target = byName(ref.sheet);
        if (!target || target.kind === 'chart') return [[err('#REF!')]];
        // Whole-column and whole-row refs clamp to the used area so a
        // SUM(A:A) never walks a million empty rows. A bounded reference is
        // read to a fixed distance past the data rather than to the sheet's
        // current height, so answers do not change as the sheet grows; the
        // reference keeps its true extent for functions that count the
        // blank cells past what was read.
        // The same range is read by every formula that names it (SUM(A:A) down a column, say):
        // its array is built once per calculation and shared, since every change empties the cache.
        const cacheKey = `${target.id}|${ref.r1},${ref.c1},${ref.r2},${ref.c2}`;
        // Iteration records each formula's reads, including ranges another
        // formula already visited, to invalidate only circular dependents.
        const cached = !this._iteration && this._rangeCache.get(cacheKey);
        if (cached) return cached;
        const extent = this._readExtent(target, ref);
        const r2 = ref.r2 >= MAX_ROW ? (this.usedRange(target.id)?.r2 ?? -1) : extent.r2;
        const c2 = ref.c2 >= MAX_COL ? (this.usedRange(target.id)?.c2 ?? -1) : extent.c2;
        const rows = Math.max(r2, ref.r1) - ref.r1 + 1;
        const cols = Math.max(c2, ref.c1) - ref.c1 + 1;
        const spills = this._ensureSpills(target);
        let out;
        // A running total names a fresh range in every row ($A$1:A1, $A$1:A2, …), so a column of
        // them used to read its whole prefix again for each: 8,006,000 reads over 4,000 rows,
        // against 12,000 for the same total written as B{r-1}+A{r}. A range that only carries a
        // cached one of the same start and columns further down takes that array and appends the
        // rows it adds, which reads each row once.
        const family = `${target.id}|${ref.r1},${ref.c1},${ref.c2}`;
        const shorter = this._rangeRuns.get(family);
        const prefix = !this._iteration && shorter !== undefined && shorter < ref.r2
          ? this._rangeCache.get(`${target.id}|${ref.r1},${ref.c1},${shorter},${ref.c2}`) : undefined;
        const kept = prefix && prefix.length < rows && prefix.length && prefix[0].length === cols ? prefix : null;
        // Worth it only while appending the missing rows costs no more than reading the range afresh.
        if (kept && (rows - kept.length) * cols <= Math.min(rows * cols, target.cells.size + spills.cover.size)) {
          const blank = Object.freeze(new Array(cols).fill(null));
          out = kept.slice(); // the rows already read are shared, never written to
          for (let rr = ref.r1 + kept.length; rr < ref.r1 + rows; rr++) {
            let row = blank;
            for (let cc = ref.c1; cc < ref.c1 + cols; cc++) {
              const value = this._compute(target, rr, cc);
              if (value === null) continue;
              if (row === blank) row = new Array(cols).fill(null);
              row[cc - ref.c1] = value;
            }
            out.push(row);
          }
        } else if (rows * cols * 2 > target.cells.size + spills.cover.size) {
          // A span emptier than the sheet as a whole (one value at F1000000 under =SUM(F:F)), or
          // covering most of it, is filled from the cells that exist rather than asked for cell
          // by cell, which builds a key per cell asked. Its empty rows are one shared, frozen
          // array: A1 and ZZ20000 filled would otherwise make SUM(A:ZZ) build fourteen million
          // slots. Only a row with content gets its own.
          const blank = Object.freeze(new Array(cols).fill(null));
          out = new Array(rows).fill(blank);
          const place = (key, cell) => {
            const { r: rr, c: cc } = parseKey(key);
            if (rr < ref.r1 || rr >= ref.r1 + rows || cc < ref.c1 || cc >= ref.c1 + cols) return;
            if (out[rr - ref.r1] === blank) out[rr - ref.r1] = new Array(cols).fill(null);
            // A plain value is placed as it is; a formula, or a cell a spill covers, is calculated.
            out[rr - ref.r1][cc - ref.c1] = cell && cell.f == null && cell.v != null ? cell.v : this._compute(target, rr, cc);
          };
          for (const [key, cell] of target.cells) place(key, cell);
          for (const key of spills.cover.keys()) place(key);
          for (const key of spills.fixed.cells({ r1: ref.r1, c1: ref.c1, r2: ref.r1 + rows - 1, c2: ref.c1 + cols - 1 })) place(key);
        } else {
          out = [];
          for (let rr = ref.r1; rr < ref.r1 + rows; rr++) {
            const row = [];
            for (let cc = ref.c1; cc < ref.c1 + cols; cc++) row.push(this._compute(target, rr, cc));
            out.push(row);
          }
        }
        // A cell still being calculated reads as a provisional #CYCLE!; an array holding one is not kept.
        let provisional = false;
        for (const key of this._evaluating) {
          const bar = key.indexOf('|');
          if (key.slice(0, bar) !== target.id) continue;
          const comma = key.indexOf(',', bar);
          const rr = Number(key.slice(bar + 1, comma));
          const cc = Number(key.slice(comma + 1));
          if (rr >= ref.r1 && rr <= Math.max(r2, ref.r1) && cc >= ref.c1 && cc <= Math.max(c2, ref.c1)) { provisional = true; break; }
        }
        // Nor is one read while a circle is unsettled, since it may hold an answer that is withdrawn.
        if (!provisional && !this._hasDeferredSpills && !this._unsettled.length) {
          this._keepRange(cacheKey, out);
          // The longest of a family is the one a longer range carries on from; only its number is
          // held, so an array the budget has evicted simply leaves the next range to read afresh.
          if (shorter === undefined || shorter < ref.r2) {
            if (this._rangeRuns.size >= RANGE_CACHE_RUNS) this._rangeRuns.clear();
            this._rangeRuns.set(family, ref.r2);
          }
        }
        return out;
      },
    };
    // The same window as getRangeValues, each cell as the text its format shows: for a function that hands
    // cells to a reader (AI() describing a range) rather than to a calculation. Null for a missing sheet.
    ctx.getRangeDisplay = (ref) => {
      const target = byName(ref.sheet);
      if (!target) return null;
      return ctx.getRangeValues(ref).map((row, i) => row.map((value, j) => this.getDisplay(target.id, ref.r1 + i, ref.c1 + j, value)));
    };
    return ctx;
  }

  /**
   * Keep a range's array for the other formulas that name it, within a budget on the cells held in
   * all: 20,000 running totals name 20,000 distinct ranges, whose arrays together would exhaust
   * memory. The arrays read longest ago go first.
   */
  _keepRange(key, values) {
    const cost = rangeCost(values);
    if (cost > RANGE_CACHE_CELLS) return;
    if (!this._rangeCache.size) this._rangeCacheCells = 0; // the cache is only ever emptied whole elsewhere
    for (const [k, v] of this._rangeCache) {
      if (this._rangeCacheCells + cost <= RANGE_CACHE_CELLS && this._rangeCache.size < 4000) break;
      this._rangeCache.delete(k);
      this._rangeCacheCells -= rangeCost(v);
    }
    this._rangeCache.set(key, values);
    this._rangeCacheCells += cost;
  }

  /* ---------- Async functions (AI) ---------- */

  setAsyncProvider(name, fn) {
    if (fn) this._asyncProviders.set(name, fn); else this._asyncProviders.delete(name);
    this._asyncCache.clear();
    this._invalidate();
    this._emit('cells');
  }

  /** Forget every answer so the next calculation asks again (F9). */
  clearAsyncCache() {
    if (!this._asyncCache.size) return false;
    this._asyncCache.clear();
    this._invalidate();
    this._emit('recalc'); // every answer is #BUSY! again until it arrives: pictures drawn from them are stale
    return true;
  }

  /**
   * Allow or block content from outside this file: IMPORTRANGE, IMPORTDATA,
   * IMPORTHTML, IMPORTXML, and IMAGE(url). A spreadsheet opened from
   * elsewhere could otherwise send other files' contents to an address of
   * its author's choosing the moment it is displayed.
   */
  setExternalAllowed(on) {
    if (this.externalAllowed === !!on) return;
    this.externalAllowed = !!on;
    this._externalBlocked = false;
    this._asyncCache.clear();
    this._invalidate();
    // Announced with the batch inside a transaction: a write that withdraws trust must not have a listener
    // redraw while the transaction is half done.
    this._announce('cells');
  }

  /** A blocked request was made: tell listeners once, outside the calculation. */
  _noteBlocked() {
    if (this._externalBlocked) return;
    this._externalBlocked = true;
    queueMicrotask(() => this._emit('external-blocked'));
  }

  _asyncValue(name, text) {
    if (!this.externalAllowed && EXTERNAL_PROVIDERS.has(name)) { this._noteBlocked(); return err('#BLOCKED!'); }
    const provider = this._asyncProviders.get(name);
    if (!provider) return err('#N/A');
    const key = `${name}\u0000${text}`;
    const hit = this._asyncCache.get(key);
    if (hit) return hit.status === 'done' ? hit.value : hit.status === 'error' ? err('#N/A') : err('#BUSY!');
    const request = { status: 'pending' };
    this._asyncCache.set(key, request);
    // F9 or a provider change can start another request for the same key.
    // Only the entry still owned by this request may publish its result.
    const current = () => this._asyncCache.get(key) === request;
    Promise.resolve().then(() => provider(text)).then(
      (value) => { if (current()) { request.value = asyncResult(value); request.status = 'done'; } },
      () => { if (current()) request.status = 'error'; },
    // An answer landing changes results without editing anything, so wb.version stands still and a
    // listener that keeps a picture of the values — a chart, the find bar's list of matches — would
    // otherwise keep the one it drew from #BUSY!. 'recalc' is the same news as F9's.
    ).finally(() => { if (current()) { this._invalidate(); this._emit('recalc'); } });
    return err('#BUSY!');
  }

  /**
   * Does any formula, in a cell, a conditional format or validation rule, or behind a defined name,
   * call NOW(), TODAY(), RAND(), or RANDBETWEEN()? The answer is kept until the book next changes:
   * a timer asks once a minute, and walking a hundred thousand formulas for it blocked the main
   * thread for a fifth of a second each time, for a book where nothing is volatile at all.
   */
  hasVolatileFormulas() {
    if (this._volatile !== null) return this._volatile;
    this._volatile = this._findVolatile();
    return this._volatile;
  }

  _findVolatile() {
    for (const s of this.sheets) {
      for (const cell of s.cells.values()) {
        if (cell.f == null) continue;
        try { if (isVolatile(this._cellAst(cell))) return true; } catch (e) { if (!(e instanceof RangeError)) throw e; }
      }
      // A rule of =A1<TODAY() changes what the sheet shows at midnight though no cell's value does.
      for (const rule of s.rules) for (const key of conditionalFormulaFields(rule)) if (isVolatile(this._astOrNull(ruleFormulaBody(rule[key])))) return true;
      for (const rule of s.validations) if (rule.type === 'formula' && isVolatile(this._astOrNull(ruleFormulaBody(rule.source)))) return true;
    }
    // A name defined as =RAND() makes every cell that uses it volatile, though none of them names the function.
    for (const n of this.names) {
      if (this.parseNamedRef(n.ref)) continue;
      if (isVolatile(this._astOrNull(n.ref))) return true;
    }
    return false;
  }

  /**
   * Recompute without editing anything: drops cached values so volatile
   * functions catch up with the clock. Not an edit, so nothing is saved.
   */
  refreshVolatile() {
    // Manual calculation leaves NOW() and RAND() where they were until F9.
    if (this.calcMode === 'manual' || !this.hasVolatileFormulas()) return false;
    this.recalculate();
    this._volatile = true; // recalculating changes no formula, so the answer still stands
    return true;
  }

  /**
   * Compute every formula afresh, as an edit would, without editing anything: for F9, and for a change
   * that alters results while no cell changed, such as the regional format that TEXT, DOLLAR and FIXED
   * write their answers in. Not an edit, so nothing is saved.
   */
  recalculate() {
    this._invalidate();
    this.calcPending = false;
    this._emit('recalc');
  }

  /** Manual calculation: forget the results of the cells written (and everything read from ranges), keep the rest. */
  _invalidateCells(sheetId, box) {
    const area = (box.r2 - box.r1 + 1) * (box.c2 - box.c1 + 1);
    if (area <= 4096) {
      for (let r = box.r1; r <= box.r2; r++) for (let c = box.c1; c <= box.c2; c++) this._cache.delete(`${sheetId}|${r},${c}`);
    } else {
      for (const key of [...this._cache.keys()]) {
        const [id, at] = key.split('|');
        if (id !== String(sheetId) || !at) continue;
        const [r, c] = at.split(',').map(Number);
        if (r >= box.r1 && r <= box.r2 && c >= box.c1 && c <= box.c2) this._cache.delete(key);
      }
    }
    for (const store of [this._rangeCache, this._rangeRuns, this._usedCache, this._cellBoundsCache, this._statsCache, this._spills, this._evaluating, this._cyclic, this._provisional]) store.clear();
    this._hasDeferredSpills = false;
    this._spillComputed = [];
    this._blankKeys = null;
    this._nameIndex = null;
    this.calcPending = true;
  }

  /** Is the workbook's structure protected? If so, say so (once per refusal) and refuse. */
  _structureLocked() {
    if (!this.structureProtected) return false;
    this._emit('protected', null, { structure: true });
    return true;
  }

  /** Protect Workbook: lock the structure of the workbook, or unlock it. Not an undoable edit. */
  setStructureProtected(on) {
    if (this.structureProtected === !!on) return;
    this.structureProtected = !!on;
    this.dirty = true;
    this.version++;
    this._announce('structure', null);
  }

  /**
   * Edit Links: put a new set of supporting-workbook links in place (fresh values, another source, a link
   * dropped). One undo step; every formula is worked out again from the links' cached cells.
   */
  setExternalWorkbooks(next, label = 'Edit links') {
    const prev = this.externalWorkbooks;
    const value = next?.books?.length ? normalizeExternalWorkbooks(next) : null;
    const apply = (v) => { this.externalWorkbooks = v; this._changed('structure'); };
    apply(value);
    this._push({ label, undo: () => apply(prev), redo: () => apply(value) });
  }

  /** Edit Links ▸ Startup Prompt: 'ask' on opening whether to update the links, 'update' them without asking, or 'none'. Not an undoable edit. */
  setLinkStartup(mode) {
    const next = LINK_STARTUP_MODES.includes(mode) ? mode : 'ask';
    if (next === this.linkStartup) return;
    this.linkStartup = next;
    this.dirty = true;
    this.version++;
    this._announce('settings', null);
  }

  /** Watch Window: add cells to watch (once each), or remove watches; the list is saved with the workbook. */
  addWatches(sheetId, cells) {
    const before = this.watches.length;
    for (const { r, c } of cells) {
      if (this.watches.length >= 500) break;
      if (!this.watches.some((w) => w.sheetId === sheetId && w.r === r && w.c === c)) this.watches.push({ sheetId, r, c });
    }
    if (this.watches.length !== before) { this.dirty = true; this.version++; this._announce('watches', sheetId); }
    return this.watches.length - before;
  }

  removeWatches(list) {
    const drop = new Set(list.map((w) => `${w.sheetId}|${w.r}|${w.c}`));
    const kept = this.watches.filter((w) => !drop.has(`${w.sheetId}|${w.r}|${w.c}`));
    if (kept.length === this.watches.length) return;
    this.watches = kept;
    this.dirty = true; this.version++; this._announce('watches', null);
  }

  /** Switch between automatic and manual calculation; switching back to automatic works everything out again. */
  /**
   * Iterative calculation for circular references: { iterate, iterateCount, iterateDelta }, or null to turn it
   * off. A setting of the workbook (saved in it, shared with co-authors), like the calculation mode.
   */
  setIteration(value) {
    const next = normalizeIteration(value);
    if (JSON.stringify(next) === JSON.stringify(this.iteration)) return;
    this.iteration = next;
    this._iterationReady = false;
    this.dirty = true;
    this.version++;
    this._invalidate();
    this._announce('calc', null);
  }

  setCalcMode(mode) {
    const next = mode === 'manual' ? 'manual' : 'automatic';
    if (next === this.calcMode) return;
    this.calcMode = next;
    this.dirty = true;
    this.version++;
    if (next === 'automatic') { this._invalidate(); this.calcPending = false; }
    this._announce('calc', null);
  }

  /**
   * A What-If data table: its results fill the array at (r0, c0); the formulas sit in the row
   * above (input values down the left) or the column to the left (values along the top), or, with two inputs, in the
   * corner. Each result is the formula calculated with the input cell holding that row's or column's value.
   */
  _dataTableValues(sheet, r0, c0, rowInput, colInput) {
    if (this._dataTableDepth) return err('#CALC!'); // a table's formula may not lean on a table's results
    const size = sheet.cells.get(cellKey(r0, c0))?.array || { rows: 1, cols: 1 };
    const top = r0 - 1, left = c0 - 1;
    const local = (ref) => !ref || !ref.sheet || sameSheetName(ref.sheet, sheet.name);
    if (top < 0 || left < 0 || !local(rowInput) || !local(colInput)) return err('#REF!');
    const read = (r, c) => scalar(this._compute(sheet, r, c));
    const values = Array.from({ length: size.rows }, () => new Array(size.cols).fill(0));
    const runs = [];
    if (rowInput && colInput) {
      for (let i = 0; i < size.rows; i++) for (let j = 0; j < size.cols; j++) {
        runs.push({ subs: [[rowInput, read(top, c0 + j)], [colInput, read(r0 + i, left)]], cells: [[i, j, top, left]] });
      }
    } else if (colInput) {
      for (let i = 0; i < size.rows; i++) {
        runs.push({ subs: [[colInput, read(r0 + i, left)]], cells: Array.from({ length: size.cols }, (_, j) => [i, j, top, c0 + j]) });
      }
    } else {
      for (let j = 0; j < size.cols; j++) {
        runs.push({ subs: [[rowInput, read(top, c0 + j)]], cells: Array.from({ length: size.rows }, (_, i) => [i, j, r0 + i, left]) });
      }
    }
    for (const run of runs) this._withSubstitutes(sheet, run.subs, () => {
      for (const [i, j, r, c] of run.cells) {
        const v = this._compute(sheet, r, c);
        values[i][j] = isRange(v) ? scalar(v) : v ?? 0;
      }
    });
    return { range: true, values };
  }

  /** Run `read` with some cells holding other values, in a calculation of its own; the book's own is left as it was. */
  _withSubstitutes(sheet, subs, read) {
    const saved = {};
    for (const key of SUBSTITUTE_STATE) saved[key] = this[key];
    const originals = subs.map(([ref]) => [cellKey(ref.r1, ref.c1), sheet.cells.get(cellKey(ref.r1, ref.c1))]);
    this._dataTableDepth = (this._dataTableDepth || 0) + 1;
    try {
      for (const [ref, value] of subs) {
        const key = cellKey(ref.r1, ref.c1), old = sheet.cells.get(key);
        sheet.cells.set(key, { v: value == null || value === '' ? null : value, f: null, ...(old?.s ? { s: old.s } : {}) });
      }
      Object.assign(this, {
        _iterationReady: false, _cache: new Map(), _rangeCache: new Map(), _rangeCacheCells: 0, _rangeRuns: new Map(), _usedCache: new Map(),
        _cellBoundsCache: new Map(), _statsCache: new Map(), _volatile: null, _spills: new Map(), _spillBuilds: [], _hasDeferredSpills: false,
        _spillComputed: [], _evaluating: new Set(), _cyclic: new Set(), _provisional: new Map(), _blankProvisional: 0, _blankKeys: null,
        _unsettled: [], _tentative: [], _grown: new Set(),
      });
      read();
    } finally {
      for (const [key, old] of originals) if (old) sheet.cells.set(key, old); else sheet.cells.delete(key);
      Object.assign(this, saved);
      this._dataTableDepth--;
    }
  }

  _invalidate() {
    this._iterationReady = false;
    this._nameIndex = null;
    this._cache.clear();
    this._rangeCache.clear();
    this._rangeRuns.clear();
    this._usedCache.clear();
    this._cellBoundsCache.clear();
    this._statsCache.clear();
    this._volatile = null;
    this._spills.clear();
    this._hasDeferredSpills = false;
    this._spillComputed = []; // cells calculated while spills were being worked out, dropped when the picture changes
    this._evaluating.clear();
    this._cyclic.clear();
    this._provisional.clear();
    this._blankProvisional = 0;
    this._blankKeys = null;
    this._unsettled = []; // circles whose reader kept its provisional answer, judged again once their outermost cell has its value
    this._tentative = []; // cells calculated while a circle was unsettled, dropped if it proves a cycle
  }

  /* ---------- Named cell styles ---------- */

  /**
   * Replace the workbook's named cell styles (see custom-cell-styles.js) as an undo step. Inside a transaction the
   * cells a modified style reformats join the same step.
   */
  setCellStyles(next, label = 'Cell styles') {
    const prev = this.cellStyles;
    const value = normalizeCellStyles(next);
    if (JSON.stringify(prev) === JSON.stringify(value)) return false;
    const apply = (v) => { this.cellStyles = v; this._changed('view'); };
    apply(value);
    this._push({ label, undo: () => apply(prev), redo: () => apply(value) });
    return true;
  }

  /* ---------- History ---------- */

  canUndo() { return this._history.length > 0; }
  canRedo() { return this._future.length > 0; }
  undoLabel() { return this._history[this._history.length - 1]?.label ?? null; }
  redoLabel() { return this._future[this._future.length - 1]?.label ?? null; }
  /** The most recent undoable steps, newest first (for an undo history menu). */
  undoLabels(n = 10) { return this._history.slice(-n).reverse().map((e) => e.label); }
  /** The newest undo step, as a mark to find again later (null when there is none). A redone step is the same mark. */
  get historyTop() { return this._history.at(-1) ?? null; }
  /**
   * The undo steps recorded after `mark` (every step when it is null), oldest first; null when the mark is no
   * longer in the history (undone, or evicted past the step limit), so what came after it cannot be told.
   */
  historySince(mark) {
    if (mark == null) return this._history.slice();
    const i = this._history.lastIndexOf(mark);
    return i < 0 ? null : this._history.slice(i + 1);
  }
  /**
   * Fold the steps recorded since `mark` (a historyTop read earlier) into one step called `label`, so a run of edits
   * made as one action (a script's) is undone and redone as one. A mark evicted meanwhile means every step left is
   * newer than it. False when there was nothing to fold.
   */
  squashHistory(mark, label) {
    const at = mark == null ? 0 : this._history.lastIndexOf(mark) + 1;
    const entries = this._history.slice(at);
    if (!entries.length) return false;
    this._history.splice(at);
    const step = {
      label,
      undo: () => { for (let i = entries.length - 1; i >= 0; i--) entries[i].undo(); },
      redo: () => { for (const e of entries) e.redo(); },
      snapshotCells: entries.reduce((cells, e) => cells + (e.snapshotCells || 0), 0),
    };
    this._history.push(step);
    this._emit('history');
    return true;
  }
  redoLabels(n = 10) { return this._future.slice(-n).reverse().map((e) => e.label); }
  /** Undo (or redo) several steps at once. Returns how many were taken. */
  undoSteps(n) { let k = 0; while (k < n && this.undo()) k++; return k; }
  redoSteps(n) { let k = 0; while (k < n && this.redo()) k++; return k; }

  undo() {
    const entry = this._history.pop();
    if (!entry) return false;
    this._snapshotCells -= entry.snapshotCells || 0;
    this._coalesce(() => entry.undo()); // a transaction's step is announced once, as the transaction was
    this._future.push(entry);
    recordStep(this, 'undo', entry.label);
    this._emit('history');
    return true;
  }

  redo() {
    const entry = this._future.pop();
    if (!entry) return false;
    this._coalesce(() => entry.redo());
    this._history.push(entry);
    recordStep(this, 'redo', entry.label);
    this._snapshotCells += entry.snapshotCells || 0;
    // A redone structural step holds its after snapshot as well as its before: the oldest steps make way for it.
    this._evictSnapshots();
    this._emit('history');
    return true;
  }

  clearHistory() {
    this._history = [];
    this._future = [];
    this._snapshotCells = 0;
  }

  markClean() {
    this.dirty = false;
    this._emit('clean');
  }

  _push(entry) {
    if (this._group) { this._group.push(entry); return; }
    this._history.push(entry);
    this._snapshotCells += entry.snapshotCells || 0;
    this._evictSnapshots();
    this._future = [];
    this._emit('history');
  }

  /**
   * The oldest steps go past the step limit, and once the steps hold more cells than the budget between them: a
   * structural step's snapshots, and the clone of every cell a sort, fill, paste or replace-all wrote, before and
   * after. The newest step is always kept, however large, so one sort of a whole table can still be undone.
   */
  _evictSnapshots() {
    while (this._history.length > HISTORY_LIMIT || (this._history.length > 1 && this._snapshotCells > this._snapshotBudget)) {
      this._snapshotCells -= this._history.shift().snapshotCells || 0;
    }
  }

  /**
   * Run several edits as one undo step. Nested transactions fold into the
   * outermost one.
   */
  transaction(label, fn) {
    if (this._group) return fn();
    this._group = [];
    let result;
    try {
      result = this._coalesce(fn); // its changes are announced at the end, before the step is recorded
    } finally {
      let entries = this._group;
      this._group = null;
      const structural = entries.structural;
      // The capture the first structural step opened closes with the transaction: the snapshot of the state before it.
      if (structural) { structural.before = this._settle(structural.capture); structural.capture = null; structural.entry.snapshotCells = structural.before.cells; }
      const steps = entries.length + (structural ? structural.steps - 1 : 0);
      // Steps recorded after the first structural one act on intermediate layouts; the
      // structural snapshots already hold their outcome, so they are not replayed.
      if (structural) entries = entries.slice(0, entries.indexOf(structural.entry) + 1);
      if (steps === 1 && !structural) this._push(entries[0]);
      else if (entries.length >= 1) {
        const step = {
          label: steps === 1 ? entries[0].label : label,
          // The live workbook is the transaction's redo state until it is first undone; the snapshot
          // taken then is a second one the step holds, so it counts against the budget from then on.
          undo: () => {
            if (structural && !structural.after) { structural.after = this._snapshot(structural.before.touched); step.snapshotCells += structural.after.cells; }
            for (let i = entries.length - 1; i >= 0; i--) entries[i].undo();
          },
          redo: () => { for (const e of entries) e.redo(); },
          // What the step holds: the structural snapshots and every cell-level step's before-and-after pair,
          // so a Replace all across a book's sheets is weighed like the single-sheet one (see _evictSnapshots).
          snapshotCells: entries.reduce((cells, e) => cells + (e.snapshotCells || 0), 0),
        };
        this._push(step);
      }
    }
    return result;
  }

  /** Run a structural edit with snapshots, for undo, of the sheets it changes (see _capture). */
  _structural(label, fn) {
    recordStep(this, 'structure', label);
    if (this._group) {
      // Inside a transaction one pair of snapshots serves every structural step: the state
      // before the first step, and the state at the end of the transaction (captured when
      // it is first undone). A tool that inserts a row per group stays linear this way. The
      // capture stays open to the end of the transaction, so the edits between the steps count.
      if (!this._group.structural) {
        const snap = { capture: this._capture(), before: null, after: null, entry: null, steps: 0 };
        snap.entry = { label, undo: () => this._restore(snap.before), redo: () => this._restore(snap.after), snapshotCells: 0 };
        this._group.structural = snap;
        this._group.push(snap.entry);
      }
      this._group.structural.steps++;
      const result = fn();
      this._changed('structure');
      return result;
    }
    const capture = this._capture();
    const snap = { before: null, after: null };
    let result;
    try {
      result = fn();
    } finally {
      snap.before = this._settle(capture);
    }
    this._changed('structure');
    const step = {
      label,
      // Until the step is undone the live workbook is its redo state, so that snapshot waits; once
      // taken, the step holds two snapshots and is weighed against the budget with both.
      undo: () => {
        if (!snap.after) { snap.after = this._snapshot(snap.before.touched); step.snapshotCells += snap.after.cells; }
        this._restore(snap.before);
      },
      redo: () => this._restore(snap.after),
      snapshotCells: snap.before.cells,
    };
    this._push(step);
    return result;
  }

  /**
   * Reload a snapshot for undo or redo: the sheets it holds are rebuilt from their JSON, the rest are the live sheets
   * of those ids, in the snapshot's order (a step that left a sheet alone has nothing to put back on it, and the
   * steps since have been undone or redone into place). Sheet protection, the gridline and zero-value switches and
   * the extent a sheet has been scrolled to are no part of a structural step — the first three are steps of their
   * own — so they keep their live state; the step's own rows and columns are restored exactly.
   */
  _restore(snap) {
    const live = new Map(this.sheets.map((s) => [s.id, s]));
    const sheets = [];
    const refilter = [];
    for (const { id, name, hidden, veryHidden } of snap.order) {
      const json = snap.sheets.get(id);
      const was = live.get(id);
      if (!json) {
        if (!was) continue;
        Object.assign(was, { name, hidden, veryHidden });
        sheets.push(was);
        continue;
      }
      const s = makeSheet(json);
      Object.assign(s, { name, hidden, veryHidden });
      // The rows the filter hid when the snapshot was taken, the rows an insertion had shown among them (see _snapshot).
      if (sheetFilters(s).length) { if (json.filterHidden) s.filterHidden = new Set(json.filterHidden); else refilter.push(s); }
      if (was) {
        s.protected = was.protected;
        s.gridlines = was.gridlines;
        s.headers = was.headers;
        s.zeros = was.zeros;
        // Zoom is a view preference, not part of a row/column undo step.
        if (was.viewZoom != null) s.viewZoom = was.viewZoom; else delete s.viewZoom;
        if (was.viewMode) s.viewMode = was.viewMode; else delete s.viewMode;
        if (was.viewSelection) s.viewSelection = normalizeSheetSelection(was.viewSelection); else delete s.viewSelection;
        if (was.viewOrigin) s.viewOrigin = normalizeSheetOrigin(was.viewOrigin); else delete s.viewOrigin;
        if (s.kind === 'chart' && was.kind === 'chart') s.zoomToFit = was.zoomToFit;
        // A snapshot from before the sheet was scrolled out would leave the viewport past its end.
        if (was.reachedRows != null) { s.reachedRows = was.reachedRows; s.rows = Math.max(s.rows, was.reachedRows); }
        if (was.reachedCols != null) { s.reachedCols = was.reachedCols; s.cols = Math.max(s.cols, was.reachedCols); }
        this._carryAsts(was, s);
      }
      sheets.push(s);
    }
    this.sheets = sheets;
    this.nativePivots = snap.nativePivots;
    this.dataModel = snap.dataModel;
    this.externalWorkbooks = snap.externalWorkbooks;
    this.names = snap.names.map((n) => ({ ...n }));
    // Never every sheet hidden, and never a hidden sheet in front (as _load keeps a file).
    if (this.sheets.every((s) => s.hidden)) this.sheets[0].hidden = false;
    this.activeSheetId = this.sheets.some((s) => s.id === snap.activeSheetId && !s.hidden) ? snap.activeSheetId : this.sheets.find((s) => !s.hidden).id;
    this._invalidate();
    for (const s of refilter) this._applyFilter(s);
    this._changed('structure');
  }

  /**
   * Hand the parsed trees of a sheet's formulas on to its rebuilt copy, for every cell whose text a tree was parsed
   * from (at the same key, or anywhere on the sheet: a step rewrites the formulas it moves in place, so the tree a
   * cell holds is often for the text the undo brings back), so that undoing a step parses only what it changed.
   */
  _carryAsts(was, s) {
    let byText = null;
    for (const [k, c] of s.cells) {
      if (c.f == null) continue;
      const old = was.cells.get(k);
      let hit = old ? this._astByCell.get(old) : undefined;
      if (!hit || hit.f !== c.f) {
        if (!byText) {
          byText = new Map();
          for (const oc of was.cells.values()) { const h = this._astByCell.get(oc); if (h) byText.set(h.f, h); }
        }
        hit = byText.get(c.f);
      }
      if (hit) this._astByCell.set(c, hit);
    }
  }

  /** `detail`, for cells written: the box they lie in and whether a formula is among them (see changesSince). */
  _changed(type, sheetId = null, detail = null) {
    if (type === 'layout' || type === 'structure') for (const sheet of sheetId == null ? this.sheets : [this.sheet(sheetId)]) if (sheet) refreshCellDrawings(sheet);
    this.version++;
    this.dirty = true;
    // View preferences affect saved state, not formulas (including RAND/NOW). Under manual calculation a write to cells
    // drops only those cells' results: what they hold now is read afresh, the formulas reading them keep their old answers
    // until F9. Anything structural moves results about, so everything is worked out again.
    if (type === 'cells' && this.calcMode === 'manual' && sheetId != null && detail?.box) this._invalidateCells(sheetId, detail.box);
    else if (type !== 'view') { this._invalidate(); if (type !== 'cells' || this.calcMode !== 'manual') this.calcPending = false; }
    // A sheet changed while a structural step's capture is open is one its snapshot must hold (see _capture).
    if (sheetId != null) for (const capture of this._captures) capture.announced.add(sheetId);
    this._changeLog.push({ version: this.version, type, sheetId, box: detail?.box || null, formula: !!detail?.formula });
    if (this._changeLog.length > CHANGE_LOG * 2) this._changeLog.splice(0, this._changeLog.length - CHANGE_LOG);
    this._announce(type, sheetId);
  }

  /**
   * What has changed since `version`, oldest first: each change's kind and sheet and, for cells written, the box
   * the write covered and whether a formula was among them. A listener that keeps something built from the book (a
   * chart's picture) asks this before reading the book again, and reads only what a change could have reached. Null
   * when the record does not reach back that far, or a version moved on outside the change path (a file
   * loaded): then anything may have changed.
   */
  changesSince(version) {
    const log = this._changeLog;
    const n = this.version - version;
    if (n === 0) return [];
    if (!(n > 0) || n > log.length || log[log.length - n].version !== version + 1) return null;
    return log.slice(log.length - n);
  }

  /**
   * Announce a change now, or, inside a transaction or an undo or redo of one, once at its end (see
   * _coalesce). `extra` rides along for the kinds that carry detail (the text a write shortened); the
   * batch keeps the last of them, as it keeps one announcement per kind and sheet.
   */
  _announce(type, sheetId = null, extra = null) {
    if (this._pending) { this._pending.set(`${type}|${sheetId ?? ''}`, { type, sheetId, extra }); return; }
    this._emit(type, sheetId, extra);
  }

  /**
   * Run `fn` with its change announcements held back, then announce each kind of change once per
   * sheet, in the order they first came. A listener that redraws on every event (the grid rebuilding
   * its row offsets) would otherwise do so for every one of 20,000 rows fitted in one step, and a sort
   * carrying notes would announce twice per note. Batches nest: the outermost announces for all.
   */
  _coalesce(fn) {
    if (this._pending) return fn();
    const pending = new Map();
    this._pending = pending;
    try {
      return fn();
    } finally {
      // Announced while the batch is still open, so an edit a listener makes in answer joins it, as it
      // did when the events came one by one; each key goes before its event, so such an edit is announced too.
      while (pending.size) {
        const [key, { type, sheetId, extra }] = pending.entries().next().value;
        pending.delete(key);
        this._emit(type, sheetId, extra);
      }
      this._pending = null;
    }
  }

  _emit(type, sheetId = null, extra = null) {
    this.dispatchEvent(new CustomEvent('change', { detail: { type, sheetId, ...(extra || {}) } }));
  }
}

installSheetGroups(Workbook);
