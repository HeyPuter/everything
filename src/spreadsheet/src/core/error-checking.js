/**
 * Background error checking: a small triangle in the corner of a cell that breaks one of the
 * rules below, and the smart tag beside the active cell that names the problem and offers its fixes. A rule
 * can be turned off for the app (Error Checking Options) or ignored for a cell (Ignore Error, saved in the
 * file as <ignoredErrors>). The keys are SpreadsheetML's CT_IgnoredError attributes.
 */
import { shiftFormula, mapFormulaRefs } from './refs.js';
import { isError } from './formula/functions.js';

export const ERROR_RULES = [
  ['evalError', 'Cells containing formulas that result in an error', true],
  ['calculatedColumn', 'Inconsistent calculated column formula in tables', true],
  ['twoDigitTextYear', 'Cells containing years represented as 2 digits', true],
  ['numberStoredAsText', 'Numbers formatted as text or preceded by an apostrophe', true],
  ['formula', 'Formulas inconsistent with other formulas in the region', true],
  ['formulaRange', 'Formulas which omit cells in a region', true],
  ['unlockedFormula', 'Unlocked cells containing formulas', true],
  ['emptyCellReference', 'Formulas referring to empty cells', false],
  ['listDataValidation', 'Data entered in a table is invalid', true],
];

const OPTIONS_KEY = 'spreadsheet:error-checking';
let cachedOptions = null; // read once: the grid asks for every cell it draws
/** The app-wide choices: background checking on or off, and each rule. */
export function errorCheckingOptions() {
  if (cachedOptions) return cachedOptions;
  const out = { enabled: true, ...Object.fromEntries(ERROR_RULES.map(([key, , on]) => [key, on])) };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) || 'null');
    if (saved && typeof saved === 'object') for (const key of Object.keys(out)) if (typeof saved[key] === 'boolean') out[key] = saved[key];
  } catch { /* optional storage */ }
  cachedOptions = out;
  return out;
}
export function setErrorCheckingOptions(options) {
  cachedOptions = { ...options };
  try { globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(cachedOptions)); } catch { /* optional storage */ }
}

const ERROR_TITLES = {
  '#DIV/0!': 'Divide by Zero Error', '#VALUE!': 'Error in Value', '#NAME?': 'Invalid Name Error', '#REF!': 'Invalid Cell Reference Error',
  '#N/A': 'Value Not Available Error', '#NUM!': 'Invalid Number Error', '#NULL!': 'Null Error', '#SPILL!': 'Spill range isn\'t blank',
  '#CALC!': 'Calculation Error', '#GETTING_DATA': 'Getting Data', '#FIELD!': 'Field Error', '#BLOCKED!': 'Blocked Error', '#CONNECT!': 'Connection Error',
};
const TITLES = {
  calculatedColumn: 'Inconsistent Calculated Column Formula', twoDigitTextYear: 'Text Date with 2-Digit Year', numberStoredAsText: 'Number Stored as Text',
  formula: 'Inconsistent Formula', formulaRange: 'Formula Omits Adjacent Cells', unlockedFormula: 'Unprotected Formula',
  emptyCellReference: 'Formula Refers to Empty Cells', listDataValidation: 'Data Validation Error',
};

// The digits before an exponent are required: E49 alone is a label, not a number.
const NUMBER_TEXT = /^\s*[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?%?\s*$/i;
const TWO_DIGIT_DATE = /^\s*\d{1,2}[/-]\d{1,2}[/-]\d{2}\s*$|^\s*\d{1,2}[/-][a-z]{3}[/-]\d{2}\s*$/i;

const ignored = (sheet, r, c, key) => (sheet.ignoredErrors || []).some((rec) => rec.keys.includes(key)
  && r >= rec.range.r1 && r <= rec.range.r2 && c >= rec.range.c1 && c <= rec.range.c2);

/** The formula another cell would hold if this one were consistent with it: its formula moved by the offset. */
const movedFormula = (cell, dr, dc) => (cell?.f != null ? shiftFormula(cell.f, dr, dc) : null);

function inconsistentFormula(sheet, r, c, f) {
  const at = (rr, cc) => (rr < 0 || cc < 0 ? null : sheet.cells.get(`${rr},${cc}`));
  for (const [dr, dc] of [[0, 1], [1, 0]]) {
    const before = at(r - dr, c - dc), after = at(r + dr, c + dc);
    if (before?.f == null || after?.f == null) continue;
    const fromBefore = movedFormula(before, dr, dc), fromAfter = movedFormula(after, -dr, -dc);
    if (fromBefore === fromAfter && fromBefore !== f) return true;
  }
  return false;
}

/** A total over a run of numbers that stops short of the run, e.g. =SUM(A1:A3) under A1:A4. */
function omitsAdjacent(wb, sheet, r, c, f) {
  let omits = false;
  mapFormulaRefs(f, (ref) => {
    if (omits || ref.sheet || ref.kind === 'rows' || ref.kind === 'cols') return ref;
    const number = (rr, cc) => typeof wb.getValue(sheet.id, rr, cc) === 'number';
    if (ref.c1 === ref.c2 && ref.c1 === c && ref.r2 > ref.r1 && ref.r2 + 1 < r) {
      let rr = ref.r2 + 1;
      while (rr < r && number(rr, c)) rr++;
      omits = rr === r;
    } else if (ref.r1 === ref.r2 && ref.r1 === r && ref.c2 > ref.c1 && ref.c2 + 1 < c) {
      let cc = ref.c2 + 1;
      while (cc < c && number(r, cc)) cc++;
      omits = cc === c;
    }
    return ref;
  });
  return omits;
}

function refersToEmpty(wb, sheet, f) {
  let empty = false;
  mapFormulaRefs(f, (ref) => {
    if (!empty && !ref.sheet && ref.r1 === ref.r2 && ref.c1 === ref.c2 && ref.kind !== 'rows' && ref.kind !== 'cols') {
      const cell = sheet.cells.get(`${ref.r1},${ref.c1}`);
      if (!cell || (cell.v == null && cell.f == null)) empty = true;
    }
    return ref;
  });
  return empty;
}

/**
 * The first rule the cell breaks, or null: { key, title }. `options` comes from errorCheckingOptions();
 * a cell's ignored rules and the rules turned off are passed over.
 */
export function errorCheckAt(wb, sheetId, r, c, options = errorCheckingOptions()) {
  if (!options.enabled) return null;
  const sheet = wb.sheet(sheetId);
  const cell = sheet?.cells.get(`${r},${c}`);
  if (!cell || (cell.v == null && cell.f == null)) return null;
  const on = (key) => options[key] && !ignored(sheet, r, c, key);
  const value = wb.getValue(sheetId, r, c);
  if (cell.f != null) {
    if (on('evalError') && isError(value)) {
      const code = typeof value === 'object' ? value.error : String(value);
      return { key: 'evalError', title: ERROR_TITLES[code] || 'Error in Formula', error: code };
    }
    if (on('formula') && inconsistentFormula(sheet, r, c, cell.f)) return { key: 'formula', title: TITLES.formula };
    if (on('formulaRange') && omitsAdjacent(wb, sheet, r, c, cell.f)) return { key: 'formulaRange', title: TITLES.formulaRange };
    if (on('unlockedFormula') && wb.styleAt(sheetId, r, c)?.locked === false) return { key: 'unlockedFormula', title: TITLES.unlockedFormula };
    if (on('emptyCellReference') && refersToEmpty(wb, sheet, cell.f)) return { key: 'emptyCellReference', title: TITLES.emptyCellReference };
    return null;
  }
  if (typeof cell.v === 'string') {
    // A number kept as text: typed after an apostrophe, or into a cell formatted as Text.
    if (on('numberStoredAsText') && cell.v.trim() !== '' && NUMBER_TEXT.test(cell.v) && /\d/.test(cell.v)) return { key: 'numberStoredAsText', title: TITLES.numberStoredAsText };
    if (on('twoDigitTextYear') && TWO_DIGIT_DATE.test(cell.v)) return { key: 'twoDigitTextYear', title: TITLES.twoDigitTextYear };
  }
  if (on('listDataValidation') && wb.tableAt?.(sheetId, r, c) && wb.validationAt(sheetId, r, c) && !wb.validateCell(sheetId, r, c).ok) {
    return { key: 'listDataValidation', title: TITLES.listDataValidation };
  }
  return null;
}

/** The number a number stored as text stands for (Convert to Number). */
export function textToNumber(text) {
  const t = String(text).trim().replace(/,/g, '');
  const pct = t.endsWith('%');
  const n = Number(pct ? t.slice(0, -1) : t);
  return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
}
