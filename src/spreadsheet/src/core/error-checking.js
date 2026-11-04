/**
 * Background error checking: a small triangle in the corner of a cell that breaks one of the
 * rules below, and the smart tag beside the active cell that names the problem and offers its fixes. A rule
 * can be turned off for the app (Error Checking Options) or ignored for a cell (Ignore Error, saved in the
 * file as <ignoredErrors>). The keys are SpreadsheetML's CT_IgnoredError attributes.
 */
import { shiftFormula, mapFormulaRefs } from './refs.js';
import { isError } from './formula/functions.js';
import { t } from '../i18n/index.js';

/** [key, label, on by default]: the label is read in the interface language each time it is read. */
const rule = (key, label, on) => Object.defineProperty([key, label, on], 1, { get: () => t(label), enumerable: true });

export const ERROR_RULES = [
  rule('evalError', 'errorChecking.rule.evalError', true),
  rule('calculatedColumn', 'errorChecking.rule.calculatedColumn', true),
  rule('twoDigitTextYear', 'errorChecking.rule.twoDigitTextYear', true),
  rule('numberStoredAsText', 'errorChecking.rule.numberStoredAsText', true),
  rule('formula', 'errorChecking.rule.formula', true),
  rule('formulaRange', 'errorChecking.rule.formulaRange', true),
  rule('unlockedFormula', 'errorChecking.rule.unlockedFormula', true),
  rule('emptyCellReference', 'errorChecking.rule.emptyCellReference', false),
  rule('listDataValidation', 'errorChecking.rule.listDataValidation', true),
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

/** The catalog keys of the titles the smart tag gives each error value and each rule. */
const ERROR_TITLES = {
  '#DIV/0!': 'errorChecking.error.div0',
  '#VALUE!': 'errorChecking.error.value',
  '#NAME?': 'errorChecking.error.name',
  '#REF!': 'errorChecking.error.ref',
  '#N/A': 'errorChecking.error.na',
  '#NUM!': 'errorChecking.error.num',
  '#NULL!': 'errorChecking.error.null',
  '#SPILL!': 'errorChecking.error.spill',
  '#CALC!': 'errorChecking.error.calc',
  '#GETTING_DATA': 'errorChecking.error.gettingData',
  '#FIELD!': 'errorChecking.error.field',
  '#BLOCKED!': 'errorChecking.error.blocked',
  '#CONNECT!': 'errorChecking.error.connect',
};
const TITLES = {
  calculatedColumn: 'errorChecking.title.calculatedColumn',
  twoDigitTextYear: 'errorChecking.title.twoDigitTextYear',
  numberStoredAsText: 'errorChecking.title.numberStoredAsText',
  formula: 'errorChecking.title.formula',
  formulaRange: 'errorChecking.title.formulaRange',
  unlockedFormula: 'errorChecking.title.unlockedFormula',
  emptyCellReference: 'errorChecking.title.emptyCellReference',
  listDataValidation: 'errorChecking.title.listDataValidation',
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
      return { key: 'evalError', title: Object.hasOwn(ERROR_TITLES, code) ? t(ERROR_TITLES[code]) : t('errorChecking.error.other'), error: code };
    }
    if (on('formula') && inconsistentFormula(sheet, r, c, cell.f)) return { key: 'formula', title: t(TITLES.formula) };
    if (on('formulaRange') && omitsAdjacent(wb, sheet, r, c, cell.f)) return { key: 'formulaRange', title: t(TITLES.formulaRange) };
    if (on('unlockedFormula') && wb.styleAt(sheetId, r, c)?.locked === false) return { key: 'unlockedFormula', title: t(TITLES.unlockedFormula) };
    if (on('emptyCellReference') && refersToEmpty(wb, sheet, cell.f)) return { key: 'emptyCellReference', title: t(TITLES.emptyCellReference) };
    return null;
  }
  if (typeof cell.v === 'string') {
    // A number kept as text: typed after an apostrophe, or into a cell formatted as Text.
    if (on('numberStoredAsText') && cell.v.trim() !== '' && NUMBER_TEXT.test(cell.v) && /\d/.test(cell.v)) return { key: 'numberStoredAsText', title: t(TITLES.numberStoredAsText) };
    if (on('twoDigitTextYear') && TWO_DIGIT_DATE.test(cell.v)) return { key: 'twoDigitTextYear', title: t(TITLES.twoDigitTextYear) };
  }
  if (on('listDataValidation') && wb.tableAt?.(sheetId, r, c) && wb.validationAt(sheetId, r, c) && !wb.validateCell(sheetId, r, c).ok) {
    return { key: 'listDataValidation', title: t(TITLES.listDataValidation) };
  }
  return null;
}

/** The number a number stored as text stands for (Convert to Number). */
export function textToNumber(text) {
  const s = String(text).trim().replace(/,/g, '');
  const pct = s.endsWith('%');
  const n = Number(pct ? s.slice(0, -1) : s);
  return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
}
