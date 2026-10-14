import { fillColorCss } from './fill-color.js';
/**
 * The AI assistant's tools: what the model may read and change in a workbook,
 * described for the model (TOOLS, in the function-calling format Puter's AI
 * takes) and carried out on a Workbook (runTool). Nothing here touches the
 * page; what only the editor can do (select cells, measure columns, withhold
 * trust from formulas that reach out) arrives through `env`.
 *
 * Every change a tool makes is one undo step, so a turn of the conversation can
 * be taken back step by step or as a whole. A tool that cannot do what it was
 * asked throws a ToolError, whose message goes back to the model in plain
 * words so it can try another way; nothing half-done is left behind.
 *
 * The cells a tool reads are the user's data, and may hold text written by
 * anyone (a shared file, an imported page). The model is told to treat them as
 * data, and the tools that could carry them off the sheet (a formula that
 * fetches from the web) are held back until the user allows them, as a paste
 * from a web page is.
 */

import { cellName, colName, colIndex, rangeName, normalizeRange, cellKey, parseKey, MAX_TEXT, cutText } from './cell.js';
import { quoteSheet, shiftFormula, MAX_ROW, MAX_COL } from './refs.js';
import { parseFormula } from './formula/parser.js';
import { evaluateFormula, resetArrayBudget } from './formula/evaluator.js';
import { isError, isRange } from './formula/functions.js';
import { formatValue } from './format.js';
import { CHART_TYPES } from './charts.js';
import { formulaReachesOut } from './reaches-out.js';
import { upperName } from './formula/tokenizer.js';
import { dataBounds } from './aiformula.js';
import { cellFromInput } from './workbook.js';

/** A request the workbook refused, in words the model can act on. */
export class ToolError extends Error {}

/** How much one read or write may cover: enough for real work, not enough to flood the conversation. */
export const MAX_READ_CELLS = 2500;
/** And this much text (some 10,000 tokens): 2,500 cells of long text would otherwise fill the model's whole context. */
export const MAX_READ_CHARS = 40000;
export const MAX_WRITE_CELLS = 10000;
const MAX_CELL_TEXT = 300; // a read quotes this much of each cell
const MAX_FIND = 60;
const MAX_CALC_CELLS = 400;
const MAX_CALC_TEXT = 10000; // a single text result, such as a TEXTJOIN of a column
const MAX_NOTE = 4000; // the most of a note the workbook keeps

const NUMBER_FORMATS = ['general', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'text', 'scientific'];
const RULE_KINDS = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq', 'contains', 'notContains', 'beginsWith', 'endsWith', 'empty', 'notEmpty', 'dup', 'unique', 'top', 'bottom', 'formula', 'scale', 'databar'];
const NUMERIC_RULES = new Set(['gt', 'gte', 'lt', 'lte', 'between', 'top', 'bottom']);
const HEX = /^#[0-9a-f]{6}$/i;

/* ---------- Formulas that reach out ---------- */

/** Does text mention one of these (folded) names as a name of its own, not as part of a longer one? */
function mentionsName(text, names) {
  if (!names.size) return false;
  for (const m of upperName(text).matchAll(/(?<![\p{L}\p{N}_.$\\])[\p{L}_\\][\p{L}\p{N}_.?\\]*/gu)) if (names.has(m[0])) return true;
  return false;
}

/**
 * INDIRECT turns text into a reference, a defined name's as well: INDIRECT("Le"&"ak") runs the name Leak without
 * spelling it. Where some name reaches out, a mention of INDIRECT is counted as one of those names.
 */
const INDIRECT = new Set(['INDIRECT']);
const mentionsReaching = (text, names) => mentionsName(text, names) || (names.size > 0 && mentionsName(text, INDIRECT));

/** The workbook's defined names that reach out: standing for IMPORTDATA, calling it in a LAMBDA, or naming such a name. */
function reachingNames(wb) {
  const defs = (wb.names || []).map((n) => ({ name: upperName(String(n.name ?? '')), ref: String(n.ref ?? '') }));
  const out = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const d of defs) {
      if (!out.has(d.name) && (formulaReachesOut(d.ref) || mentionsReaching(d.ref, out))) { out.add(d.name); grew = true; }
    }
  }
  return out;
}

/**
 * Does a formula the model wrote reach outside the workbook? Directly, or through a defined name that does: the
 * names came with the file, from whoever wrote it, and =GRAB("https://…"&A1) with GRAB standing for
 * LAMBDA(u, IMPORTDATA(u)) carries the cell off as surely as IMPORTDATA itself. A mention of such a name anywhere
 * in the text counts, as the scan counts text that only looks like a call: that costs no more than a question.
 */
function reachesOut(wb, formula) {
  return formulaReachesOut(formula) || mentionsReaching(formula, reachingNames(wb));
}

/* ---------- Tool descriptions for the model ---------- */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const RANGE = str('An A1 range such as "B2:D20", "A:A" or a single cell "C5", optionally with a sheet: "Sales!A1:F50" or "\'Q1 Data\'!B2". A named range or a table name works too. Without a sheet it means the active sheet.');
const SHEET = str('Sheet name. Defaults to the active sheet.');
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const TOOLS = [
  fn('get_workbook_info', 'List the sheets (with the range their data occupies, frozen panes, tables and charts), the named ranges, the active sheet and the user\'s selection. Call this first when you need to know what is in the workbook.'),
  fn('read_range', 'Read cells as the user sees them (formatted values), with the formulas behind them. Rows are numbered and columns tab-separated. Read before you change anything, and read again to check your work. Large ranges are cut; read the rest in further calls.', {
    range: RANGE,
    include_formulas: bool('List the formulas behind the cells (default true).'),
    include_formats: bool('Also describe number formats, bold, fills and colors (default false).'),
  }, ['range']),
  fn('calculate', 'Evaluate a formula without writing it to the sheet and return the exact result. Use this for any figure you report (totals, averages, counts, growth rates) instead of doing arithmetic yourself. Arrays such as FILTER or UNIQUE results come back as rows.', {
    formula: str('A formula starting with =, e.g. "=AVERAGEIFS(Sales!D:D, Sales!B:B, \\"West\\")".'),
    sheet: str('The sheet the formula is evaluated on, for references without a sheet. Defaults to the active sheet.'),
  }, ['formula']),
  fn('find', 'Search the workbook for cells whose value (or formula) contains some text. Returns up to 60 matching cells.', {
    query: str('Text to look for.'),
    sheet: str('Search only this sheet. Defaults to every sheet.'),
    in_formulas: bool('Search formula text instead of values (default false).'),
    match_case: bool('Match upper and lower case exactly (default false).'),
  }, ['query']),
  fn('write_cells', 'Write values or formulas into a block of cells, starting at a top-left cell. Each inner array is one row. A string starting with = is a formula; numbers should be JSON numbers; dates as "YYYY-MM-DD" strings; null leaves a cell as it is and "" empties it. Strings are read as if typed into the cell, so "3%" becomes a percent and "1/2" a date: to keep text exactly as written, such as a code or ID with leading zeros, start it with an apostrophe ("\'00123"). Existing formatting is kept. Returns any errors the new formulas produce.', {
    start_cell: str('Top-left cell of the block, e.g. "B2" or "Summary!A1".'),
    values: { type: 'array', description: 'Rows of cell values.', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
  }, ['start_cell', 'values']),
  fn('fill_formula', 'Write one formula into every cell of a range, with relative references adjusted for each cell as Fill down does. Write the formula as it should read in the range\'s top-left cell. Prefer this to write_cells for a column of the same calculation.', {
    range: RANGE,
    formula: str('The formula for the top-left cell, starting with =, e.g. "=C2*D2".'),
  }, ['range', 'formula']),
  fn('clear_range', 'Clear cells: their contents, their formatting, or both.', {
    range: RANGE,
    what: str('"contents" (default), "formats", or "all".', { enum: ['contents', 'formats', 'all'] }),
  }, ['range']),
  fn('format_cells', 'Format a range. Give only the properties to change.', {
    range: RANGE,
    bold: bool('Bold on or off.'),
    italic: bool('Italic on or off.'),
    underline: bool('Underline on or off.'),
    strikethrough: bool('Strikethrough on or off.'),
    font_color: str('Text color as #rrggbb, or "none" for the default.'),
    fill_color: str('Background color as #rrggbb, or "none" for no fill.'),
    font_size: num('Font size in points (6 to 72).'),
    number_format: str('One of general, number, currency, percent, date, time, datetime, text, scientific, or a custom format code such as "#,##0.00" or "mmm yyyy".'),
    decimals: int('Decimal places for number, currency and percent formats (0 to 10).'),
    currency: str('ISO currency code for the currency format, e.g. USD, EUR, GBP, JPY.'),
    align: str('Horizontal alignment.', { enum: ['left', 'center', 'right'] }),
    vertical_align: str('Vertical alignment.', { enum: ['top', 'middle', 'bottom'] }),
    wrap: bool('Wrap text within the cells.'),
    borders: str('Draw borders: "all", "outer", "inner", or "none" to remove them.', { enum: ['all', 'outer', 'inner', 'none'] }),
  }, ['range']),
  fn('insert_rows', 'Insert empty rows. Formulas, charts and ranges below move down with their cells.', {
    sheet: SHEET, before_row: int('Row number (1-based) the new rows go above.'), count: int('How many rows (default 1).'),
  }, ['before_row']),
  fn('insert_columns', 'Insert empty columns. Formulas, charts and ranges to the right move with their cells.', {
    sheet: SHEET, before_column: str('Column letter the new columns go to the left of, e.g. "C".'), count: int('How many columns (default 1).'),
  }, ['before_column']),
  fn('delete_rows', 'Delete whole rows, and everything in them.', {
    sheet: SHEET, start_row: int('First row number to delete (1-based).'), count: int('How many rows (default 1).'),
  }, ['start_row']),
  fn('delete_columns', 'Delete whole columns, and everything in them.', {
    sheet: SHEET, start_column: str('First column letter to delete, e.g. "D".'), count: int('How many columns (default 1).'),
  }, ['start_column']),
  fn('sort_range', 'Sort the rows of a range by one or more columns. Formulas move with their rows.', {
    range: RANGE,
    keys: { type: 'array', description: 'Sort keys, most important first.', items: { type: 'object', properties: { column: str('Column letter within the sheet, e.g. "C".'), ascending: bool('A to Z / smallest first (default true).') }, required: ['column'], additionalProperties: false } },
    has_header: bool('The first row of the range is a header that stays in place (default: guessed).'),
    only_these_columns: bool('Sort these columns on their own although the rows go on into the columns beside them, which pulls each row apart (default false: such a sort is refused, and the whole block should be sorted instead).'),
  }, ['range', 'keys']),
  fn('create_chart', 'Insert a chart drawn from a range. The first row and column are used as series names and categories when they hold text.', {
    data_range: RANGE,
    type: str('Chart type.', { enum: CHART_TYPES.map(([t]) => t) }),
    title: str('Chart title.'),
    anchor_cell: str('Cell where the chart\'s top-left corner sits. Defaults to just right of the data.'),
    x_title: str('Horizontal axis title.'),
    y_title: str('Vertical axis title.'),
    stacked: bool('Stack the series (column, bar, area).'),
    series_in: str('Whether each column or each row of the data is one series (default: guessed).', { enum: ['columns', 'rows'] }),
  }, ['data_range', 'type']),
  fn('create_table', 'Turn a range into a table with a header row, a filter and banded rows. Tables can be referred to by name in formulas (Table1[Amount]).', {
    range: RANGE, name: str('Table name (letters, digits and underscores).'), totals_row: bool('Add a totals row (default false).'),
  }, ['range']),
  fn('add_conditional_format', 'Highlight cells that meet a condition, or shade them with a color scale or data bars.', {
    range: RANGE,
    rule: str('gt, gte, lt, lte, between, eq, neq (numbers or text), contains, notContains, beginsWith, endsWith, empty, notEmpty, dup (duplicates), unique, top / bottom (N values), formula (a custom formula that is TRUE for cells to highlight, written for the range\'s top-left cell), scale (color scale) or databar.', { enum: RULE_KINDS }),
    value: str('The value to compare with, N for top/bottom, or the formula for "formula".'),
    value2: str('Upper bound for "between".'),
    fill_color: str('Highlight fill as #rrggbb (default a soft yellow).'),
    font_color: str('Highlight text color as #rrggbb.'),
    bold: bool('Make matching cells bold.'),
    min_color: str('Color scale: color of the lowest values (#rrggbb).'),
    mid_color: str('Color scale: optional color of the middle values (#rrggbb).'),
    max_color: str('Color scale: color of the highest values (#rrggbb).'),
    bar_color: str('Data bars: bar color (#rrggbb).'),
  }, ['range', 'rule']),
  fn('add_dropdown', 'Give cells a dropdown list of allowed values (data validation).', {
    range: RANGE,
    options: { type: 'array', items: { type: 'string' }, description: 'The choices, when they are listed here.' },
    source_range: str('Or: a range whose cells hold the choices, e.g. "Lists!A2:A20".'),
    strict: bool('Refuse values not in the list (default true); false only warns.'),
  }, ['range']),
  fn('manage_sheet', 'Add, rename, duplicate, delete or show a sheet.', {
    action: str('What to do.', { enum: ['add', 'rename', 'duplicate', 'delete', 'activate'] }),
    sheet: str('The sheet to act on (the name for a new sheet when adding).'),
    new_name: str('The new name, when renaming.'),
  }, ['action']),
  fn('freeze_panes', 'Keep rows at the top and columns at the left in view while scrolling. 0 unfreezes.', {
    sheet: SHEET, rows: int('How many top rows to freeze.'), columns: int('How many left columns to freeze.'),
  }, []),
  fn('set_column_width', 'Set the width of columns in pixels, or fit them to their contents.', {
    sheet: SHEET, columns: str('A column or run of columns, e.g. "B" or "A:F".'), width: str('Width in pixels (24 to 800), or "fit".'),
  }, ['columns', 'width']),
  fn('add_note', 'Attach a note (comment) to a cell, or replace its note. An empty text removes it.', {
    cell: str('The cell, e.g. "D4" or "Sheet2!B7".'), text: str('The note.'),
  }, ['cell', 'text']),
  fn('select_range', 'Select a range in the user\'s view (switching sheets if needed) to point them at something. Changes nothing.', {
    range: RANGE,
  }, ['range']),
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
const READ_TOOLS = new Set(['get_workbook_info', 'read_range', 'calculate', 'find', 'select_range']);

/** Does this tool change the workbook? */
export const changesWorkbook = (name) => TOOL_NAMES.has(name) && !READ_TOOLS.has(name);

/* ---------- Addresses ---------- */

/** "Sheet1!B2:C9", quoting the sheet name when it needs it. */
export function qualified(wb, sheetId, range) {
  return `${quoteSheet(wb.sheet(sheetId)?.name ?? '')}!${lineRangeName(range)}`;
}

/** A1 notation, with whole columns as "A:D" and whole rows as "3:5", as they were most likely written. */
/**
 * Whole columns, whole rows or the whole sheet, as the editor names a selection made from the headers: the workbook
 * draws borders on those as lines that run on past the rows (or columns) the sheet holds so far.
 */
function lineScope(range) {
  const wholeCols = range.r1 === 0 && range.r2 >= MAX_ROW;
  const wholeRows = range.c1 === 0 && range.c2 >= MAX_COL;
  return wholeCols && wholeRows ? 'sheet' : wholeCols ? 'columns' : wholeRows ? 'rows' : undefined;
}

function lineRangeName(range) {
  const wholeCols = range.r1 === 0 && range.r2 >= MAX_ROW;
  const wholeRows = range.c1 === 0 && range.c2 >= MAX_COL;
  if (wholeCols && !wholeRows) return `${colName(range.c1)}:${colName(range.c2)}`;
  if (wholeRows && !wholeCols) return `${range.r1 + 1}:${range.r2 + 1}`;
  return rangeName(range);
}

function sheetNamed(wb, name, fallbackId) {
  if (name == null || name === '') {
    const sheet = wb.sheet(fallbackId);
    if (!sheet) throw new ToolError('There is no active sheet.');
    return sheet;
  }
  const text = String(name).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  const sheet = wb.sheetByName(text);
  if (!sheet) throw new ToolError(`There is no sheet named "${text}". The sheets are: ${wb.sheets.map((s) => `"${s.name}"`).join(', ')}.`);
  return sheet;
}

/** A sheet with cells, named or the active one: a chart sheet has no rows, columns or panes to change. */
function gridSheet(wb, name, fallbackId) {
  const sheet = sheetNamed(wb, name, fallbackId);
  if (sheet.kind === 'chart') throw new ToolError(`"${sheet.name}" is a chart sheet, which has no cells.`);
  return sheet;
}

/** The sheet and cells a range argument names; a ToolError says why when it names none. */
export function resolveRange(wb, text, sheetId) {
  const t = String(text ?? '').trim().replace(/^=/, '');
  if (!t) throw new ToolError('No range was given.');
  const found = wb.rangeFromText(sheetId, t);
  if (!found) {
    const bang = t.lastIndexOf('!');
    if (bang > 0) sheetNamed(wb, t.slice(0, bang), sheetId); // names the missing sheet, when that is the problem
    throw new ToolError(`"${t}" is not a range. Use A1 notation such as "B2:D10", optionally with a sheet: "Data!A1:C20".`);
  }
  const sheet = wb.sheet(found.sheetId);
  if (!sheet) throw new ToolError(`"${t}" is not on any sheet.`);
  if (sheet.kind === 'chart') throw new ToolError(`"${sheet.name}" is a chart sheet, which has no cells.`);
  return { sheetId: found.sheetId, range: normalizeRange(found.range) };
}

/** A whole-column or whole-row range cut down to the part that holds anything, so a read of A:A is the column's data. */
function withinData(wb, sheetId, range) {
  const used = wb.usedRange(sheetId);
  if (!used) return null;
  const r2 = Math.min(range.r2, used.r2);
  const c2 = Math.min(range.c2, used.c2);
  if (r2 < range.r1 || c2 < range.c1) return null;
  return { r1: range.r1, c1: range.c1, r2, c2 };
}

/**
 * Whole columns (or rows) as the data in them, from where it begins: "A:B" over a header in row 3 is A3:B40, not
 * A1:B40, whose blank first row would be taken for the header. Other ranges are as withinData leaves them.
 */
function dataOfLines(wb, sheetId, range) {
  const wholeCols = range.r2 >= MAX_ROW, wholeRows = range.c2 >= MAX_COL;
  if (!wholeCols && !wholeRows) return withinData(wb, sheetId, range);
  const used = dataBounds(wb, sheetId);
  return used && withinData(wb, sheetId, { ...range, r1: wholeCols ? Math.max(range.r1, used.r1) : range.r1, c1: wholeRows ? Math.max(range.c1, used.c1) : range.c1 });
}

function columnArg(text, what = 'column') {
  const c = colIndex(String(text ?? '').trim().replace(/\$/g, ''));
  if (c < 0) throw new ToolError(`"${text}" is not a ${what} letter such as "C".`);
  return c;
}

function count(n, fallback = 1, max = 5000) {
  const v = n == null ? fallback : Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) throw new ToolError('The count must be a whole number of at least 1.');
  if (v > max) throw new ToolError(`At most ${max} at a time.`);
  return v;
}

const holds = (cell) => !!cell && (cell.v != null || cell.f != null);

/** How many cells of a range hold a value or a formula. */
export function filledCells(wb, sheetId, range) {
  const sheet = wb.sheet(sheetId);
  if (!sheet) return 0;
  const { r1, c1, r2, c2 } = range;
  let n = 0;
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > sheet.cells.size) {
    for (const [key, cell] of sheet.cells) {
      if (!holds(cell)) continue;
      const { r, c } = parseKey(key);
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) n++;
    }
    return n;
  }
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (holds(sheet.cells.get(cellKey(r, c)))) n++;
  return n;
}

/** How many cells of a range have a note: the user's writing, as much as a value is. */
function notesIn(wb, sheetId, range) {
  const notes = wb.sheet(sheetId)?.notes;
  if (!notes?.size) return 0;
  let n = 0;
  for (const key of notes.keys()) {
    const { r, c } = parseKey(key);
    if (r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) n++;
  }
  return n;
}

/**
 * The array formulas whose spilled results a write would land on: a value written there blocks the whole spill, and
 * the formula shows #SPILL! in place of every result. `writes(r, c)` says whether a cell of the range is written. A
 * formula whose own cell is written is replaced, not blocked, and is counted with the values replaced.
 */
function spillsHit(wb, sheetId, range, writes = () => true) {
  const anchors = new Map();
  for (const { r, c } of wb.spillEntries?.(sheetId, range) || []) {
    if (!writes(r, c)) continue;
    const anchor = wb.spillAt(sheetId, r, c)?.anchor;
    if (!anchor) continue;
    const inRange = anchor.r >= range.r1 && anchor.r <= range.r2 && anchor.c >= range.c1 && anchor.c <= range.c2;
    if (!(inRange && writes(anchor.r, anchor.c))) anchors.set(cellKey(anchor.r, anchor.c), anchor);
  }
  return [...anchors.values()];
}

/** What a write did to the spills it landed on, for the model: which formulas now show #SPILL!. */
function blockedSpills(wb, sheetId, anchors) {
  return anchors.filter(({ r, c }) => wb.getValue(sheetId, r, c)?.error === '#SPILL!')
    .map(({ r, c }) => `${qualified(wb, sheetId, { r1: r, c1: c, r2: r, c2: c })} now shows #SPILL!: cells it spilled its results into were written over. Clear them, or write elsewhere, to bring its results back.`);
}

/* ---------- Reading ---------- */

const plain = (text) => String(text ?? '').replace(/[\t\r\n]+/g, ' ');
const clip = (text, max = MAX_CELL_TEXT) => (text.length > max ? `${cutText(text, max)}…` : text);
const clipped = (v, max) => (typeof v === 'string' ? clip(v, max) : v);

/** A value for the model: numbers and booleans as they are, errors by their code, text as it is. */
function modelValue(v) {
  if (isError(v)) return v.error;
  if (v == null) return null;
  if (typeof v === 'object') return '(picture)';
  return v;
}

/**
 * The formulas of a block, a run of cells down a column that repeat one formula (each relative
 * reference a row further on) named once: "D2:D500: =B2*C2 (and so on down)". A block of a
 * thousand filled-down formulas reads as one line instead of a thousand.
 */
function formulaLines(wb, sheetId, range, limit = 400) {
  const lines = [];
  let listed = 0;
  for (let c = range.c1; c <= range.c2 && listed < limit; c++) {
    let run = null; // { r1, r2, f }
    const flush = () => {
      if (!run) return;
      lines.push(run.r2 > run.r1
        ? `${cellName(run.r1, c)}:${cellName(run.r2, c)}: =${run.f} (and so on down)`
        : `${cellName(run.r1, c)}: =${run.f}`);
      listed++;
      run = null;
    };
    for (let r = range.r1; r <= range.r2; r++) {
      const f = wb.getCell(sheetId, r, c)?.f;
      if (f == null) { flush(); continue; }
      if (run && r === run.r2 + 1 && shiftFormula(run.f, r - run.r1, 0) === f) { run.r2 = r; continue; }
      flush();
      run = { r1: r, r2: r, f };
      if (listed >= limit) break;
    }
    flush();
  }
  return lines;
}

function formatLines(wb, sheetId, range, limit = 150) {
  const lines = [];
  for (let r = range.r1; r <= range.r2 && lines.length < limit; r++) {
    for (let c = range.c1; c <= range.c2 && lines.length < limit; c++) {
      const s = wb.styleAt(sheetId, r, c);
      if (!s) continue;
      const parts = [];
      if (s.fmt && s.fmt !== 'general') parts.push(s.fmt === 'custom' ? `format "${s.code}"` : `${s.fmt}${s.dec != null ? ` ${s.dec}dp` : ''}${s.cur ? ` ${s.cur}` : ''}`);
      for (const k of ['bold', 'italic', 'underline', 'strike', 'wrap']) if (s[k]) parts.push(k);
      if (s.bg) parts.push(`fill ${fillColorCss(s.bg)}`);
      if (s.color && typeof s.color === 'string') parts.push(`color ${s.color}`);
      if (s.size) parts.push(`${s.size}pt`);
      if (s.align) parts.push(`align ${s.align}`);
      if (parts.length) lines.push(`${cellName(r, c)}: ${parts.join(', ')}`);
    }
  }
  return lines;
}

function readRange(wb, args, env) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, env.sheetId());
  const name = wb.sheet(sheetId).name;
  const data = withinData(wb, sheetId, asked);
  if (!data) return `${qualified(wb, sheetId, asked)} is empty.`;
  const width = data.c2 - data.c1 + 1;
  const maxRows = Math.max(1, Math.floor(MAX_READ_CELLS / width));
  const shown = { ...data, r2: Math.min(data.r2, data.r1 + maxRows - 1), c2: Math.min(data.c2, data.c1 + Math.max(0, MAX_READ_CELLS - 1)) };
  const lines = [`\t${Array.from({ length: shown.c2 - shown.c1 + 1 }, (_, i) => colName(shown.c1 + i)).join('\t')}`];
  let size = lines[0].length;
  for (let r = shown.r1; r <= shown.r2; r++) {
    if (wb.isRowHidden?.(sheetId, r) && filledCells(wb, sheetId, { r1: r, c1: shown.c1, r2: r, c2: shown.c2 }) === 0) continue;
    const cells = [];
    for (let c = shown.c1; c <= shown.c2; c++) cells.push(clip(plain(wb.getDisplay(sheetId, r, c))));
    if (!cells.some((t) => t !== '')) continue;
    const line = `${r + 1}${wb.isRowHidden?.(sheetId, r) ? ' (hidden)' : ''}\t${cells.join('\t')}`;
    // Past the text budget the read ends at the row before, which is where the rest is said to begin.
    if (lines.length > 1 && size + line.length > MAX_READ_CHARS) { shown.r2 = r - 1; break; }
    lines.push(line);
    size += line.length + 1;
  }
  const out = [`${quoteSheet(name)}!${rangeName(shown)} (values as displayed; row numbers first, then columns, tab-separated; blank rows left out):`, ...lines];
  if (shown.r2 < data.r2 || shown.c2 < data.c2) {
    // The rest lies below when rows were cut, or else to the right.
    const rest = shown.r2 < data.r2 ? { r1: shown.r2 + 1, c1: data.c1 } : { r1: data.r1, c1: shown.c2 + 1 };
    out.push(`(Cut short: the data goes on to ${cellName(data.r2, data.c2)}. Read ${quoteSheet(name)}!${cellName(rest.r1, rest.c1)}:${cellName(data.r2, data.c2)} for the rest, or use calculate for totals.)`);
  }
  if (args.include_formulas !== false) {
    const formulas = formulaLines(wb, sheetId, shown);
    // Long formulas are held to the same budget as the values.
    let room = Math.max(4000, MAX_READ_CHARS - size);
    const kept = formulas.filter((f) => (room -= f.length + 1) >= 0);
    if (kept.length) out.push('Formulas:', ...kept);
    if (kept.length < formulas.length) out.push(`(${formulas.length - kept.length} more formulas left out; read a smaller range to see them.)`);
  }
  if (args.include_formats) {
    const formats = formatLines(wb, sheetId, shown);
    if (formats.length) out.push('Formats:', ...formats);
  }
  return out.join('\n');
}

function workbookInfo(wb, env) {
  const sel = env.selection?.();
  return {
    active_sheet: wb.sheet(env.sheetId())?.name,
    selection: sel ? qualified(wb, sel.sheetId, sel.range) : undefined,
    sheets: wb.sheets.map((s) => {
      const used = s.kind === 'chart' ? null : dataBounds(wb, s.id);
      return {
        name: s.name,
        ...(s.kind === 'chart' ? { kind: 'chart sheet' } : {}),
        data: used ? rangeName(used) : 'empty',
        ...(s.hidden ? { hidden: true } : {}),
        ...(s.frozenRows || s.frozenCols ? { frozen: { rows: s.frozenRows || 0, columns: s.frozenCols || 0 } } : {}),
        ...(s.protected ? { protected: true } : {}),
        ...(s.tables?.length ? { tables: s.tables.map((t) => ({ name: t.name, range: rangeName(t.range), columns: wb.tableColumns(s.id, t) })) } : {}),
        ...(s.charts?.length ? { charts: s.charts.filter((c) => c.type !== 'image' && c.type !== 'text' && c.type !== 'smartart').map((c) => ({ type: c.type, title: c.title || undefined, data: c.range ? rangeName(c.range) : undefined })) } : {}),
      };
    }),
    named_ranges: (wb.names || []).slice(0, 100).map((n) => ({ name: n.name, refers_to: n.ref, ...(n.sheet ? { scope: n.sheet } : {}) })),
  };
}

function calculate(wb, args, env) {
  const sheet = sheetNamed(wb, args.sheet, env.sheetId());
  const text = String(args.formula ?? '').trim();
  const body = text.replace(/^=/, '');
  if (!body) throw new ToolError('No formula was given.');
  if (reachesOut(wb, body)) throw new ToolError('calculate does not run functions that reach outside the workbook (AI, IMPORT*, IMAGE, TRANSLATE), or names that call them.');
  let ast;
  try { ast = parseFormula(body); } catch (e) { throw new ToolError(`The formula could not be read: ${e?.message || 'syntax error'}.`); }
  let value;
  try {
    resetArrayBudget();
    value = evaluateFormula(ast, wb.contextFor(sheet.id, 0, 0));
  } catch (e) {
    throw new ToolError(`The formula could not be evaluated: ${e?.message || 'error'}.`);
  }
  if (isRange(value)) {
    const rows = value.values.length;
    const cols = value.values[0]?.length ?? 0;
    const most = Math.max(1, Math.min(rows, Math.floor(MAX_CALC_CELLS / Math.max(1, cols))));
    // Each text quoted as a read quotes it, and the rows held to a read's length: 400 cells of long text are megabytes.
    const values = [];
    let size = 0;
    for (const row of value.values.slice(0, most)) {
      const out = row.slice(0, MAX_CALC_CELLS).map((v) => clipped(modelValue(v), MAX_CELL_TEXT));
      size += JSON.stringify(out).length + 1;
      if (values.length && size > MAX_READ_CHARS) break;
      values.push(out);
    }
    return {
      rows, columns: cols, values,
      ...(values.length < rows ? { note: `Only the first ${values.length} of ${rows} rows are shown.` } : {}),
    };
  }
  if (isError(value)) return { error: value.error, explanation: explainedError(wb, value) };
  const shown = modelValue(value);
  const long = typeof shown === 'string' && shown.length > MAX_CALC_TEXT;
  return {
    value: clipped(shown, MAX_CALC_TEXT),
    ...(typeof value === 'number' ? { display: formatValue(value, {}) } : {}),
    ...(long ? { note: `The text is ${shown.length.toLocaleString('en-US')} characters long; only the first ${MAX_CALC_TEXT.toLocaleString('en-US')} are shown.` } : {}),
  };
}

function explainedError(wb, v) {
  // The error names its own kind; the workbook's plain-language help needs a cell, so a code alone gets a short gloss.
  return {
    '#DIV/0!': 'division by zero or by an empty cell',
    '#NAME?': 'an unknown function or name',
    '#REF!': 'a reference to a cell or sheet that does not exist',
    '#VALUE!': 'a value of the wrong type (text where a number was expected)',
    '#N/A': 'a lookup found no match',
    '#NUM!': 'an impossible number',
    '#SPILL!': 'the result has no room to spill into',
    '#CALC!': 'a calculation with no result, such as an empty FILTER',
  }[v.error] || 'the formula has an error';
}

function find(wb, args) {
  const query = String(args.query ?? '');
  if (!query) throw new ToolError('Nothing to search for.');
  const fold = (t) => (args.match_case ? t : t.toLocaleLowerCase());
  const needle = fold(query);
  const sheets = args.sheet ? [sheetNamed(wb, args.sheet, wb.activeSheetId)] : wb.sheets.filter((s) => s.kind !== 'chart');
  const matches = [];
  let more = false;
  for (const sheet of sheets) {
    const keys = [...sheet.cells.keys()].filter((key) => holds(sheet.cells.get(key))).map(parseKey);
    // What a formula spills into the cells below and beside it shows on the sheet as a typed value does: a search of
    // the values that left it out said "No cells match" of text in plain view.
    if (!args.in_formulas) {
      const own = new Set(keys.map(({ r, c }) => cellKey(r, c)));
      for (const { r, c } of wb.spillEntries?.(sheet.id) || []) if (!own.has(cellKey(r, c))) keys.push({ r, c });
    }
    keys.sort((a, b) => a.r - b.r || a.c - b.c);
    for (const { r, c } of keys) {
      const cell = sheet.cells.get(cellKey(r, c));
      const hay = args.in_formulas ? (cell.f != null ? `=${cell.f}` : '') : wb.getDisplay(sheet.id, r, c);
      if (!hay || !fold(hay).includes(needle)) continue;
      if (matches.length >= MAX_FIND) { more = true; break; }
      matches.push({ cell: qualified(wb, sheet.id, { r1: r, c1: c, r2: r, c2: c }), text: clip(plain(hay), 120) });
    }
    if (more) break;
  }
  return { matches, ...(more ? { note: `More than ${MAX_FIND} cells match; search a single sheet or a longer text.` } : {}), ...(matches.length ? {} : { note: 'No cells match.' }) };
}

/* ---------- Writing ---------- */

/** Refuse a change to cells the sheet or a protected range locks, before anything is written. */
function assertWritable(wb, sheetId, range) {
  const sheet = wb.sheet(sheetId);
  if (wb.isProtected(sheetId)) throw new ToolError(`${sheet.name} is protected. The user can unprotect it from the sheet tab's menu.`);
  if (range && wb.isLockedIn(sheetId, range)) throw new ToolError(`Part of ${qualified(wb, sheetId, range)} is a protected range and cannot be changed.`);
}

/** The errors a block's formulas now show, with the workbook's own explanation of each. */
function formulaErrors(wb, sheetId, range, limit = 8) {
  const out = [];
  for (let r = range.r1; r <= range.r2 && out.length < limit; r++) {
    for (let c = range.c1; c <= range.c2 && out.length < limit; c++) {
      if (wb.getCell(sheetId, r, c)?.f == null) continue;
      const v = wb.getValue(sheetId, r, c);
      if (!isError(v) || v.error === '#BUSY!' || v.error === '#BLOCKED!') continue;
      const help = wb.errorHelpAt(sheetId, r, c);
      out.push(`${cellName(r, c)} shows ${v.error}${typeof help === 'string' && help ? ` (${help.replace(/^#[A-Z/0!?]+:?\s*/, '')})` : ''}`);
    }
  }
  return out;
}

/**
 * Does writing `value` leave the cell holding what it holds now? The model writes a date as "2024-01-05" and may
 * write 1200 as "1,200": rewriting a block it read, its unchanged cells replace nothing, and must not be asked about
 * as data replaced. Read as writeOne writes it, in the cell's own format (a Plain text cell keeps "00123").
 */
function keepsValue(wb, sheetId, r, c, cell, value) {
  if (typeof value !== 'string') return false;
  let next;
  try { next = cellFromInput(value, wb.styleAt(sheetId, r, c)); } catch { return false; }
  if (next?.f != null || cell.f != null) return next?.f === cell.f;
  const a = next?.v ?? null, b = cell.v ?? null;
  return a === b || (isError(a) && isError(b) && a.error === b.error);
}

/** The text a cell is written with: a number or boolean as itself, anything else as typed. */
function inputFor(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ToolError('Numbers must be finite.');
    return value;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = String(value);
  if (text.length > MAX_TEXT) throw new ToolError(`A cell holds at most ${MAX_TEXT} characters.`);
  return text;
}

/** Write one cell as the user would type it; a JS number is stored as that number, whatever the regional format. */
function writeOne(wb, sheetId, r, c, input) {
  if (typeof input === 'number') wb.setInput(sheetId, r, c, input, { literal: true, label: 'AI edit' });
  else wb.setInput(sheetId, r, c, input, { label: 'AI edit' });
}

function reachingNote(env, reached) {
  if (!reached) return null;
  env.distrust?.();
  return 'Formulas that fetch from outside the workbook (IMPORT*, AI, IMAGE, TRANSLATE) show #BLOCKED! until the user chooses Allow in the notice above the sheet.';
}

function writeCells(wb, args, env) {
  const { sheetId, range: start } = resolveRange(wb, args.start_cell, env.sheetId());
  const rows = args.values;
  if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new ToolError('values must be an array of rows, each an array of cell values.');
  const width = Math.max(...rows.map((row) => row.length));
  if (!width) throw new ToolError('values holds no cells.');
  const range = { r1: start.r1, c1: start.c1, r2: start.r1 + rows.length - 1, c2: start.c1 + width - 1 };
  if (rows.length * width > MAX_WRITE_CELLS) throw new ToolError(`At most ${MAX_WRITE_CELLS} cells per call; write in smaller blocks, or use fill_formula for a repeated formula.`);
  if (!wb.canEnsureSize(sheetId, range.r2 + 1, range.c2 + 1)) throw new ToolError('The block runs past the edge of the sheet.');
  assertWritable(wb, sheetId, range);
  if (wb.arrayEditBlocked(sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} crosses part of an array formula's result. Write around it, or replace the whole array.`);
  const refused = [];
  const planned = [];
  let reached = false;
  rows.forEach((row, i) => row.forEach((value, j) => {
    const input = inputFor(value);
    if (input === undefined) return;
    const r = range.r1 + i;
    const c = range.c1 + j;
    const verdict = typeof input === 'string' ? wb.validateInput(sheetId, r, c, input) : wb.validateValue?.(sheetId, r, c, input) ?? { ok: true };
    if (!verdict.ok && verdict.rule?.strict !== false) { refused.push(`${cellName(r, c)} (${verdict.message || 'not allowed by its validation rule'})`); return; }
    if (typeof input === 'string' && input.startsWith('=') && reachesOut(wb, input.slice(1))) reached = true;
    planned.push({ r, c, input });
  }));
  if (!planned.length) throw new ToolError(refused.length ? `Nothing was written: ${refused.slice(0, 5).join('; ')}.` : 'Every value was null, so nothing was written.');
  const note = reachingNote(env, reached);
  const written = new Set(planned.filter(({ input }) => input !== '').map(({ r, c }) => cellKey(r, c)));
  const hit = spillsHit(wb, sheetId, range, (r, c) => written.has(cellKey(r, c)));
  wb.ensureSize(sheetId, range.r2 + 1, range.c2 + 1);
  wb.transaction('AI edit', () => { for (const { r, c, input } of planned) writeOne(wb, sheetId, r, c, input); });
  const errors = formulaErrors(wb, sheetId, range);
  const blocked = blockedSpills(wb, sheetId, hit);
  return {
    written: qualified(wb, sheetId, range),
    cells: planned.length,
    ...(refused.length ? { refused_by_validation: refused.slice(0, 10) } : {}),
    ...(errors.length ? { formula_errors: errors } : {}),
    ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}),
    ...(note ? { note } : {}),
  };
}

function fillFormula(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  const text = String(args.formula ?? '').trim();
  if (!text.startsWith('=')) throw new ToolError('The formula must start with =.');
  const cells = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
  if (cells > MAX_WRITE_CELLS) throw new ToolError(`At most ${MAX_WRITE_CELLS} cells per call.`);
  try { parseFormula(text.slice(1)); } catch (e) { throw new ToolError(`The formula could not be read: ${e?.message || 'syntax error'}.`); }
  assertWritable(wb, sheetId, range);
  if (wb.arrayEditBlocked(sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} crosses part of an array formula's result.`);
  if (!wb.canEnsureSize(sheetId, range.r2 + 1, range.c2 + 1)) throw new ToolError('The range runs past the edge of the sheet.');
  const note = reachingNote(env, reachesOut(wb, text.slice(1)));
  const hit = spillsHit(wb, sheetId, range);
  wb.ensureSize(sheetId, range.r2 + 1, range.c2 + 1);
  wb.transaction('AI edit', () => wb.fillInput(sheetId, range, text, { r: range.r1, c: range.c1 }));
  const errors = formulaErrors(wb, sheetId, range);
  const blocked = blockedSpills(wb, sheetId, hit);
  return { filled: qualified(wb, sheetId, range), cells, ...(errors.length ? { formula_errors: errors } : {}), ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}), ...(note ? { note } : {}) };
}

function clearRange(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  const what = args.what || 'contents';
  if (!['contents', 'formats', 'all'].includes(what)) throw new ToolError('what must be "contents", "formats" or "all".');
  assertWritable(wb, sheetId, range);
  const before = wb.version;
  wb.transaction('AI edit', () => wb.clearRange(sheetId, range, { contents: what !== 'formats', styles: what !== 'contents' }));
  if (wb.version === before && filledCells(wb, sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} could not be cleared (it may cross part of an array formula or a pivot table).`);
  return { cleared: qualified(wb, sheetId, range), what };
}

function colorArg(value, what) {
  if (value == null) return undefined;
  const v = String(value).trim();
  if (v === 'none' || v === '') return null;
  if (!HEX.test(v)) throw new ToolError(`${what} must be a color like "#1f6feb", or "none".`);
  return v.toLowerCase();
}

function formatCells(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  assertWritable(wb, sheetId, range);
  const patch = {};
  if (args.bold != null) patch.bold = !!args.bold || null;
  if (args.italic != null) patch.italic = !!args.italic || null;
  if (args.underline != null) patch.underline = !!args.underline || null;
  if (args.strikethrough != null) patch.strike = !!args.strikethrough || null;
  if (args.font_color !== undefined) patch.color = colorArg(args.font_color, 'font_color');
  if (args.fill_color !== undefined) patch.bg = colorArg(args.fill_color, 'fill_color');
  if (args.font_size != null) {
    const size = Number(args.font_size);
    if (!(size >= 6 && size <= 72)) throw new ToolError('font_size must be between 6 and 72.');
    patch.size = Math.round(size * 2) / 2;
  }
  if (args.number_format != null) {
    const f = String(args.number_format).trim();
    if (NUMBER_FORMATS.includes(f.toLowerCase())) { patch.fmt = f.toLowerCase(); patch.code = null; }
    else if (f && f.length <= 255) { patch.fmt = 'custom'; patch.code = f; }
    else throw new ToolError('number_format is not a format.');
  }
  if (args.decimals != null) {
    const d = Math.trunc(Number(args.decimals));
    if (!(d >= 0 && d <= 10)) throw new ToolError('decimals must be 0 to 10.');
    patch.dec = d;
  }
  if (args.currency != null) {
    const cur = String(args.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new ToolError('currency must be a three-letter code such as USD.');
    patch.cur = cur;
    if (!patch.fmt) patch.fmt = 'currency';
  }
  if (args.align != null) {
    if (!['left', 'center', 'right'].includes(args.align)) throw new ToolError('align must be left, center or right.');
    patch.align = args.align;
  }
  if (args.vertical_align != null) {
    if (!['top', 'middle', 'bottom'].includes(args.vertical_align)) throw new ToolError('vertical_align must be top, middle or bottom.');
    patch.valign = args.vertical_align === 'middle' ? null : args.vertical_align;
  }
  if (args.wrap != null) { patch.wrap = !!args.wrap || null; if (args.wrap) patch.clip = null; }
  const borders = args.borders;
  if (borders != null && !['all', 'outer', 'inner', 'none'].includes(borders)) throw new ToolError('borders must be all, outer, inner or none.');
  if (!Object.keys(patch).length && borders == null) throw new ToolError('No formatting was given.');
  // Whole columns and rows are formatted as lines (the way the toolbar formats them), not cell by cell.
  wb.transaction('AI edit', () => {
    if (Object.keys(patch).length) wb.applyStyle(sheetId, range, patch);
    if (borders != null) wb.applyBorders(sheetId, range, borders, { scope: lineScope(range) });
  });
  return { formatted: qualified(wb, sheetId, range), changes: [...Object.keys(patch), ...(borders != null ? [`${borders} borders`] : [])] };
}

function lines(wb, args, env, { axis, remove }) {
  const sheet = gridSheet(wb, args.sheet, env.sheetId());
  assertWritable(wb, sheet.id, null);
  const at = axis === 'row'
    ? (remove ? args.start_row : args.before_row)
    : columnArg(remove ? args.start_column : args.before_column);
  const index = axis === 'row' ? Math.trunc(Number(at)) - 1 : at;
  if (!(index >= 0)) throw new ToolError('Row numbers start at 1.');
  const n = count(args.count);
  const label = axis === 'row' ? `row${n === 1 ? '' : 's'} ${index + 1}${n > 1 ? `–${index + n}` : ''}` : `column${n === 1 ? '' : 's'} ${colName(index)}${n > 1 ? `–${colName(index + n - 1)}` : ''}`;
  let ok;
  if (remove) ok = wb.deleteLines(sheet.id, axis, [{ from: index, to: index + n - 1 }], 'AI edit');
  else ok = axis === 'row' ? wb.insertRows(sheet.id, index, n) : wb.insertCols(sheet.id, index, n);
  if (!ok) throw new ToolError(`Could not ${remove ? 'delete' : 'insert'} ${label} on ${sheet.name}: ${remove ? 'they may be protected, or split a table, pivot table or array formula.' : 'the data would be pushed past the edge of the sheet, or a table, pivot table or array formula is in the way.'}`);
  return { [remove ? 'deleted' : 'inserted']: `${label} on ${sheet.name}` };
}

function sortRange(wb, args, env) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, env.sheetId());
  // Whole columns (or rows) mean their data, from where it begins: sorted from row 1, the blank rows above a header
  // were taken for the top row, the header was sorted in among the data, and the data moved up into the blank rows.
  const whole = asked.r2 >= MAX_ROW || asked.c2 >= MAX_COL;
  const range = whole ? dataOfLines(wb, sheetId, asked) : asked;
  if (!range) throw new ToolError(`${qualified(wb, sheetId, asked)} holds no data to sort.`);
  assertWritable(wb, sheetId, range);
  const keys = Array.isArray(args.keys) ? args.keys : [];
  if (!keys.length) throw new ToolError('Give at least one sort key.');
  const parsed = keys.map((k) => {
    const col = columnArg(k?.column);
    if (col < range.c1 || col > range.c2) throw new ToolError(`Column ${colName(col)} is outside ${rangeName(range)}.`);
    return { col, ascending: k?.ascending !== false };
  });
  const header = args.has_header ?? looksLikeHeaderRow(wb, sheetId, range);
  const rows = header ? { ...range, r1: range.r1 + 1 } : range;
  if (rows.r1 > rows.r2) throw new ToolError('There are no rows to sort under the header.');
  // Rows that go on into the columns beside the range are records: sorted without those columns, each would be left
  // with another row's values there (a list of names sorted away from their amounts). Rather than only warn of it, here the
  // model is told the block to sort, unless it means the columns to be sorted on their own.
  if (!args.only_these_columns) {
    const beside = (c) => c >= 0 && c <= MAX_COL && filledCells(wb, sheetId, { r1: rows.r1, c1: c, r2: rows.r2, c2: c }) > 0;
    let c1 = range.c1, c2 = range.c2;
    while (c1 > 0 && range.c1 - c1 < 200 && beside(c1 - 1)) c1--;
    while (c2 < MAX_COL && c2 - range.c2 < 200 && beside(c2 + 1)) c2++;
    if (c1 < range.c1 || c2 > range.c2) {
      const cols = (a, b) => (a === b ? `column ${colName(a)}` : `columns ${colName(a)}:${colName(b)}`);
      const into = [c1 < range.c1 && cols(c1, range.c1 - 1), c2 > range.c2 && cols(range.c2 + 1, c2)].filter(Boolean).join(' and ');
      throw new ToolError(`The rows of ${qualified(wb, sheetId, rows)} go on into ${into}: sorting only these columns would separate each row from its values there. Sort the whole block, ${qualified(wb, sheetId, { ...range, c1, c2 })}, or set only_these_columns to true if these columns are meant to be sorted on their own.`);
    }
  }
  const blocker = wb.rearrangeBlocker?.(sheetId, rows, 'row');
  if (blocker) throw new ToolError(`The rows of ${qualified(wb, sheetId, rows)} cannot be rearranged (${SORT_BLOCKERS[blocker] || 'merged cells, a table\'s edge, a pivot table or an array formula is in the way'}).`);
  let ok;
  wb.transaction('AI edit', () => { ok = wb.sortRangeBy(sheetId, rows, parsed); });
  if (!ok) throw new ToolError(`${qualified(wb, sheetId, rows)} could not be sorted.`);
  return { sorted: qualified(wb, sheetId, rows), by: parsed.map((k) => `${colName(k.col)} ${k.ascending ? 'ascending' : 'descending'}`), header_kept: !!header };
}

const SORT_BLOCKERS = { protected: 'they are protected', merged: 'merged cells are in the way', table: 'the range cuts across a table', pivot: 'a pivot table is in the way', array: 'an array formula is in the way' };

/** A first row of text over a second row that holds a number somewhere: a header, as the sort dialog guesses one. */
function looksLikeHeaderRow(wb, sheetId, range) {
  if (range.r2 <= range.r1) return false;
  let text = 0, numbers = 0;
  for (let c = range.c1; c <= range.c2; c++) {
    const top = wb.getValue(sheetId, range.r1, c);
    const next = wb.getValue(sheetId, range.r1 + 1, c);
    if (typeof top === 'string' && top) text++;
    if (typeof next === 'number') numbers++;
    if (typeof top === 'number') return false;
  }
  return text > 0 && (numbers > 0 || text === range.c2 - range.c1 + 1);
}

function createChart(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.data_range, env.sheetId());
  assertWritable(wb, sheetId, null);
  // Whole columns from where their data begins: from row 1, blank rows above the header were charted as the header.
  const data = dataOfLines(wb, sheetId, range);
  if (!data) throw new ToolError(`${qualified(wb, sheetId, range)} holds no data to chart.`);
  const type = String(args.type || 'column');
  if (!CHART_TYPES.some(([t]) => t === type)) throw new ToolError(`type must be one of ${CHART_TYPES.map(([t]) => t).join(', ')}.`);
  // Beside everything on the sheet, not only the charted cells, so the chart covers none of the data.
  let anchor = { r: data.r1, c: (dataBounds(wb, sheetId)?.c2 ?? data.c2) + 2 };
  if (args.anchor_cell) {
    const at = resolveRange(wb, args.anchor_cell, sheetId);
    if (at.sheetId !== sheetId) throw new ToolError('The chart must sit on the same sheet as its data.');
    anchor = { r: at.range.r1, c: at.range.c1 };
  }
  const id = wb.addChart(sheetId, {
    type, range: data, title: cutText(args.title || '', 200), anchor, dx: 4, dy: 4, w: 480, h: 300,
    xTitle: cutText(args.x_title || '', 80), yTitle: cutText(args.y_title || '', 80),
    stacked: !!args.stacked, seriesIn: args.series_in === 'rows' ? 'rows' : args.series_in === 'columns' ? 'cols' : 'auto',
  });
  if (id == null) throw new ToolError('The chart could not be added.');
  return { chart: `${type} chart of ${qualified(wb, sheetId, data)}`, placed_at: cellName(anchor.r, anchor.c) };
}

/**
 * The cells a table over a range takes. Whole columns or rows ("A:C", "1:40") mean their data, as a chart's do: a
 * table over A:C would run to the sheet's last row, and a formula written beside it would fill every one of those
 * rows. The table begins where the data does, not at row 1 above it.
 */
function tableRange(wb, sheetId, asked) {
  const whole = asked.r2 >= MAX_ROW || asked.c2 >= MAX_COL;
  const used = whole ? dataBounds(wb, sheetId) : null;
  return !whole ? asked : used && withinData(wb, sheetId, { ...asked, r1: Math.max(asked.r1, used.r1), c1: Math.max(asked.c1, used.c1) });
}

/**
 * How many formulas a table's header row turns into the text they show, as the workbook makes every header text: the
 * header cells' own, and those of the array formulas spilling into them (whose whole spill becomes values).
 */
function headerFormulas(wb, sheetId, range) {
  const found = new Set();
  for (let c = range.c1; c <= range.c2; c++) {
    if (wb.getCell(sheetId, range.r1, c)?.f != null) found.add(cellKey(range.r1, c));
    else {
      const anchor = wb.spillAt(sheetId, range.r1, c)?.anchor;
      if (anchor) found.add(cellKey(anchor.r, anchor.c));
    }
  }
  return found.size;
}

function createTable(wb, args, env) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, env.sheetId());
  const range = tableRange(wb, sheetId, asked);
  if (!range) throw new ToolError(`${qualified(wb, sheetId, asked)} holds no data to make a table of.`);
  assertWritable(wb, sheetId, range);
  const name = args.name ? String(args.name).trim() : null;
  if (name) {
    const problem = wb.validateTableName(name);
    if (problem) throw new ToolError(`"${name}" cannot name a table: ${problem}`);
  }
  const formulas = headerFormulas(wb, sheetId, range);
  let id;
  wb.transaction('AI edit', () => { id = wb.addTable(sheetId, range, { ...(name ? { name } : {}), totalsRow: !!args.totals_row }); });
  if (id == null) throw new ToolError(`${qualified(wb, sheetId, range)} cannot become a table: it needs a header row and at least one row under it, and must not overlap another table, a pivot table, merged cells or an array formula.`);
  const table = wb.tableById(sheetId, id);
  return {
    table: table?.name, range: table ? qualified(wb, sheetId, table.range) : undefined, columns: table ? wb.tableColumns(sheetId, table) : undefined,
    ...(formulas ? { note: `A table's headers are text: ${formulas === 1 ? 'the formula in its header row was' : `the ${formulas} formulas in its header row were`} turned into the text ${formulas === 1 ? 'it showed' : 'they showed'}.` } : {}),
  };
}

function addConditionalFormat(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  assertWritable(wb, sheetId, null);
  const type = String(args.rule || '');
  if (!RULE_KINDS.includes(type)) throw new ToolError(`rule must be one of ${RULE_KINDS.join(', ')}.`);
  const rule = { range, type, style: {} };
  const numeric = (v, what) => {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) throw new ToolError(`${what} must be a number for a "${type}" rule.`);
    return n;
  };
  if (type === 'scale') {
    rule.from = colorArg(args.min_color, 'min_color') || '#ffffff';
    rule.to = colorArg(args.max_color, 'max_color') || '#4a8dff';
    const mid = colorArg(args.mid_color, 'mid_color');
    if (mid) rule.mid = mid;
  } else if (type === 'databar') {
    rule.barColor = colorArg(args.bar_color, 'bar_color') || '#8fb8ff';
  } else {
    if (NUMERIC_RULES.has(type)) rule.value = numeric(args.value, 'value');
    else if (type === 'formula') {
      const f = String(args.value ?? '').trim();
      if (!f) throw new ToolError('A "formula" rule needs its formula in value.');
      if (reachesOut(wb, f.replace(/^=/, ''))) throw new ToolError('A rule\'s formula cannot reach outside the workbook.');
      rule.value = f.startsWith('=') ? f : `=${f}`;
    } else if (!['empty', 'notEmpty', 'dup', 'unique'].includes(type)) {
      if (args.value == null || args.value === '') throw new ToolError(`A "${type}" rule needs a value.`);
      const n = Number(args.value);
      rule.value = (type === 'eq' || type === 'neq') && String(args.value).trim() !== '' && Number.isFinite(n) ? n : String(args.value);
    }
    if (type === 'between') rule.value2 = numeric(args.value2, 'value2');
    const fill = colorArg(args.fill_color, 'fill_color');
    const color = colorArg(args.font_color, 'font_color');
    rule.style = { ...(fill ? { bg: fill } : {}), ...(color ? { color } : {}), ...(args.bold ? { bold: true } : {}) };
    if (!rule.style.bg && !rule.style.color && !rule.style.bold) rule.style.bg = '#fef3c7';
  }
  let id;
  wb.transaction('AI edit', () => { id = wb.addRule(sheetId, rule); });
  if (id == null) throw new ToolError('The rule could not be added.');
  return { rule: `${type} on ${qualified(wb, sheetId, range)}` };
}

/** The validation rule on exactly these cells, which a new one replaces (a range has one rule). */
function sameRangeValidation(wb, sheetId, range) {
  return (wb.sheet(sheetId)?.validations || []).find((v) => v.range.r1 === range.r1 && v.range.c1 === range.c1 && v.range.r2 === range.r2 && v.range.c2 === range.c2) || null;
}

function addDropdown(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  assertWritable(wb, sheetId, null);
  const replaced = !!sameRangeValidation(wb, sheetId, range);
  let source;
  if (Array.isArray(args.options) && args.options.length) {
    source = args.options.map((o) => String(o)).filter((o) => o !== '').slice(0, 500);
    if (!source.length) throw new ToolError('options holds no choices.');
  } else if (args.source_range) {
    const src = resolveRange(wb, args.source_range, sheetId);
    source = `=${qualified(wb, src.sheetId, src.range)}`;
  } else throw new ToolError('Give the choices in options, or a source_range that holds them.');
  let id;
  wb.transaction('AI edit', () => { id = wb.addValidation(sheetId, { range, type: 'list', source, strict: args.strict !== false }); });
  if (id == null) throw new ToolError('The dropdown could not be added.');
  return { dropdown: qualified(wb, sheetId, range), choices: Array.isArray(source) ? source.length : source, ...(replaced ? { replaced: 'the rule these cells had before' } : {}) };
}

function manageSheet(wb, args, env) {
  const action = args.action;
  if (action === 'add') {
    const name = args.sheet ? String(args.sheet).trim() : null;
    if (name) { const problem = wb.validateSheetName(name); if (problem) throw new ToolError(`"${name}" cannot name a sheet: ${problem}`); }
    const sheet = wb.addSheet(name);
    return { added: sheet?.name };
  }
  const sheet = sheetNamed(wb, args.sheet, env.sheetId());
  if (action === 'activate') {
    // A hidden sheet is not shown: reported as active, it would have the model's ranges without a sheet name land on
    // the sheet still in view.
    if (sheet.hidden) throw new ToolError(`${quoteSheet(sheet.name)} is hidden, so it cannot be shown. The user can unhide it from a sheet tab's menu; ranges can still name it, e.g. ${quoteSheet(sheet.name)}!A1.`);
    env.showSheet?.(sheet.id);
    return { active_sheet: sheet.name };
  }
  if (action === 'rename') {
    const name = String(args.new_name ?? '').trim();
    const problem = wb.validateSheetName(name, sheet.id);
    if (problem) throw new ToolError(`"${name}" cannot name a sheet: ${problem}`);
    const old = sheet.name;
    if (!wb.renameSheet(sheet.id, name)) throw new ToolError(`${old} could not be renamed.`);
    return { renamed: old, to: name };
  }
  if (action === 'duplicate') {
    const copy = wb.duplicateSheet(sheet.id);
    if (!copy) throw new ToolError(`${sheet.name} could not be duplicated.`);
    return { duplicated: sheet.name, as: copy.name ?? wb.sheet(copy)?.name };
  }
  if (action === 'delete') {
    const name = sheet.name;
    if (!wb.deleteSheet(sheet.id)) throw new ToolError(`${name} could not be deleted: a workbook keeps at least one visible sheet.`);
    return { deleted: name };
  }
  throw new ToolError('action must be add, rename, duplicate, delete or activate.');
}

function freezePanes(wb, args, env) {
  const sheet = gridSheet(wb, args.sheet, env.sheetId());
  const rows = Math.max(0, Math.trunc(Number(args.rows ?? sheet.frozenRows ?? 0)) || 0);
  const cols = Math.max(0, Math.trunc(Number(args.columns ?? sheet.frozenCols ?? 0)) || 0);
  if (rows > 50 || cols > 20) throw new ToolError('At most 50 rows and 20 columns can be frozen.');
  wb.setFrozen(sheet.id, rows, cols);
  return { sheet: sheet.name, frozen_rows: rows, frozen_columns: cols };
}

function setColumnWidth(wb, args, env) {
  const sheet = gridSheet(wb, args.sheet, env.sheetId());
  // A protected sheet keeps its column widths: said so, rather than a resize reported that did not happen.
  assertWritable(wb, sheet.id, null);
  const [a, b = a] = String(args.columns ?? '').split(':');
  const c1 = columnArg(a), c2 = columnArg(b);
  const lo = Math.min(c1, c2), hi = Math.max(c1, c2);
  if (hi - lo > 200) throw new ToolError('At most 200 columns at once.');
  if (String(args.width).trim().toLowerCase() === 'fit') {
    if (!env.autofit) throw new ToolError('Columns cannot be fitted here; give a width in pixels.');
    wb.transaction('AI edit', () => env.autofit(sheet.id, lo, hi));
    return { fitted: `${colName(lo)}${hi > lo ? `:${colName(hi)}` : ''} on ${sheet.name}` };
  }
  const width = Math.round(Number(args.width));
  if (!(width >= 24 && width <= 800)) throw new ToolError('width must be 24 to 800 pixels, or "fit".');
  wb.transaction('AI edit', () => { for (let c = lo; c <= hi; c++) wb.setColWidth(sheet.id, c, width); });
  return { resized: `${colName(lo)}${hi > lo ? `:${colName(hi)}` : ''} on ${sheet.name}`, width };
}

function addNote(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.cell, env.sheetId());
  assertWritable(wb, sheetId, { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 });
  // Blank text removes the note, as the workbook takes it; a longer note is kept to its limit, and said to be.
  const given = String(args.text ?? '');
  const text = given.trim() ? cutText(given, MAX_NOTE) : '';
  wb.transaction('AI edit', () => wb.setNote(sheetId, range.r1, range.c1, text));
  return {
    [text ? 'note_added' : 'note_removed']: qualified(wb, sheetId, { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 }),
    ...(given.length > MAX_NOTE && text ? { note: `A note holds at most ${MAX_NOTE.toLocaleString('en-US')} characters; the text was cut to that.` } : {}),
  };
}

function selectRange(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  if (!env.select) throw new ToolError('Nothing can be selected here.');
  // Refused here rather than by the editor, which would tell the user, who asked for nothing, to unhide the sheet.
  const sheet = wb.sheet(sheetId);
  if (sheet.hidden) throw new ToolError(`${quoteSheet(sheet.name)} is hidden, so nothing on it can be selected. The user can unhide it from a sheet tab's menu.`);
  if (!env.select(sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} could not be selected (its sheet may be hidden).`);
  return { selected: qualified(wb, sheetId, range) };
}

const RUNNERS = {
  get_workbook_info: (wb, args, env) => workbookInfo(wb, env),
  read_range: readRange,
  calculate,
  find: (wb, args) => find(wb, args),
  write_cells: writeCells,
  fill_formula: fillFormula,
  clear_range: clearRange,
  format_cells: formatCells,
  insert_rows: (wb, args, env) => lines(wb, args, env, { axis: 'row', remove: false }),
  insert_columns: (wb, args, env) => lines(wb, args, env, { axis: 'col', remove: false }),
  delete_rows: (wb, args, env) => lines(wb, args, env, { axis: 'row', remove: true }),
  delete_columns: (wb, args, env) => lines(wb, args, env, { axis: 'col', remove: true }),
  sort_range: sortRange,
  create_chart: createChart,
  create_table: createTable,
  add_conditional_format: addConditionalFormat,
  add_dropdown: addDropdown,
  manage_sheet: manageSheet,
  freeze_panes: freezePanes,
  set_column_width: setColumnWidth,
  add_note: addNote,
  select_range: selectRange,
};

/**
 * Carry out one tool call. Returns { ok, content (the text the model reads), changed (the
 * workbook moved on), target ({ sheetId, range } the call acted on, for the user to jump to) }.
 * `env`: sheetId() the active sheet, selection() → { sheetId, range }, select(sheetId, range),
 * showSheet(sheetId), autofit(sheetId, c1, c2), distrust() when a formula that reaches out is written.
 */
export function runTool(wb, name, args, env) {
  const run = RUNNERS[name];
  if (!run) return { ok: false, content: `There is no tool called ${name}.`, changed: false };
  const before = wb.version;
  const sheetBefore = env.sheetId();
  let target = null;
  try {
    target = callTarget(wb, name, args || {}, env);
  } catch { /* the runner says what is wrong with the address */ }
  try {
    const result = run(wb, args || {}, env);
    const changed = wb.version !== before;
    let content = typeof result === 'string' ? result : JSON.stringify(result);
    // A change the workbook quietly declined (a locked cell, an edit it would not make) must not read as made,
    // or the model tells the user it did something that is not there. Showing a sheet changes the view only.
    if (changesWorkbook(name) && !changed && !(name === 'manage_sheet' && args?.action === 'activate')) content += '\nNote: nothing in the workbook changed. It may already have been this way, or the cells may be locked.';
    // A new sheet, a deleted one or a selection elsewhere changes which sheet a range without a sheet name means.
    const sheetAfter = env.sheetId();
    if (sheetAfter !== sheetBefore && wb.sheet(sheetAfter)) content += `\nNote: the active sheet is now "${wb.sheet(sheetAfter).name}"; ranges without a sheet name now refer to it.`;
    return { ok: true, content, changed, target };
  } catch (e) {
    if (!(e instanceof ToolError)) console.error(e);
    return { ok: false, content: `Error: ${e instanceof ToolError ? e.message : `something went wrong (${e?.message || e}).`}`, changed: wb.version !== before, target: null };
  }
}

/** The cells a call is about, when it names some: what the step in the chat links to. Throws when it names none. */
export function callTarget(wb, name, args, env) {
  const text = args.range ?? args.start_cell ?? args.data_range ?? args.cell;
  if (text == null) return null;
  const found = resolveRange(wb, text, env.sheetId());
  // A note goes on one cell, the range's first.
  if (name === 'add_note') found.range = { r1: found.range.r1, c1: found.range.c1, r2: found.range.r1, c2: found.range.c1 };
  if (name === 'write_cells' && Array.isArray(args.values)) {
    const w = Math.max(1, ...args.values.map((row) => (Array.isArray(row) ? row.length : 1)));
    found.range = { ...found.range, r2: found.range.r1 + Math.max(1, args.values.length) - 1, c2: found.range.c1 + w - 1 };
  }
  return found;
}

/**
 * What a call would do, for the chat to show and, when it takes away data, to ask about first:
 * { label: "Write 12 cells to Sheet1!B2:D5", destructive: bool, detail? }. Every label is what
 * the step does, a read ("Read Sheet1!A1:F50") as much as a change, so it reads the same running and done.
 */
// A count and a row number as the runner reads them, whole: "Insert 2.5 rows" inserted 2.
const lineCount = (n) => { const v = n == null ? 1 : Math.trunc(Number(n)); return Number.isFinite(v) && v >= 1 ? v : 1; };
const lineNumber = (n) => Math.trunc(Number(n));

export function describeCall(wb, name, args = {}, env) {
  const sheetId = env.sheetId();
  const at = (text) => {
    try { const { sheetId: s, range } = resolveRange(wb, text, sheetId); return { s, range, text: qualified(wb, s, range) }; } catch { return { s: null, range: null, text: String(text ?? '') }; }
  };
  const sheetName = (n) => { try { return sheetNamed(wb, n, sheetId).name; } catch { return String(n ?? ''); } };
  const filled = (s, range) => (s != null && range ? filledCells(wb, s, range) : 0);
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const holding = (n) => `${plural(n, 'cell')} that already ${n === 1 ? 'holds' : 'hold'} data`;
  const blocksSpills = (n) => `Blocks the results ${n === 1 ? 'a formula spills' : `${n} formulas spill`} into these cells: ${n === 1 ? 'it' : 'they'} will show #SPILL!.`;
  switch (name) {
    case 'get_workbook_info': return { label: 'Look over the workbook' };
    case 'read_range': return { label: `Read ${at(args.range).text}` };
    case 'calculate': return { label: `Calculate ${clip(String(args.formula ?? ''), 80)}` };
    case 'find': return { label: `Search for “${clip(String(args.query ?? ''), 40)}”` };
    case 'select_range': return { label: `Select ${at(args.range).text}` };
    case 'write_cells': {
      const start = at(args.start_cell);
      const rows = Array.isArray(args.values) ? args.values : [];
      const w = Math.max(1, ...rows.map((row) => (Array.isArray(row) ? row.length : 1)));
      const range = start.range && { ...start.range, r2: start.range.r1 + Math.max(1, rows.length) - 1, c2: start.range.c1 + w - 1 };
      let replaced = 0;
      if (range && start.s != null) {
        rows.forEach((row, i) => (Array.isArray(row) ? row : []).forEach((v, j) => {
          if (v === null || v === undefined) return;
          const cell = wb.getCell(start.s, range.r1 + i, range.c1 + j);
          if (!holds(cell)) return;
          // A string is read as typed, so the same text can still replace what the cell holds: its text "00123" or
          // "1/2" written back becomes a number or a date. A number or a boolean is kept as itself.
          if (typeof v === 'string' ? !keepsValue(wb, start.s, range.r1 + i, range.c1 + j, cell, v) : cell.f != null || cell.v !== v) replaced++;
        }));
      }
      const n = rows.reduce((sum, row) => sum + (Array.isArray(row) ? row.filter((v) => v !== null && v !== undefined).length : 0), 0);
      const writes = (r, c) => { const v = rows[r - range.r1]?.[c - range.c1]; return v !== null && v !== undefined && v !== ''; };
      const spills = range && start.s != null ? spillsHit(wb, start.s, range, writes).length : 0;
      const detail = [replaced && `Replaces ${holding(replaced)}.`, spills && blocksSpills(spills)].filter(Boolean).join(' ');
      return { label: `Write ${plural(n, 'cell')} to ${range ? qualified(wb, start.s, range) : start.text}`, destructive: !!detail, detail: detail || null };
    }
    case 'fill_formula': {
      const t = at(args.range);
      const n = filled(t.s, t.range);
      const spills = t.s != null && t.range ? spillsHit(wb, t.s, t.range).length : 0;
      const detail = [n && `Replaces ${holding(n)}.`, spills && blocksSpills(spills)].filter(Boolean).join(' ');
      return { label: `Fill ${t.text} with ${clip(String(args.formula ?? ''), 60)}`, destructive: !!detail, detail: detail || null };
    }
    case 'clear_range': {
      const t = at(args.range);
      const what = args.what || 'contents';
      const n = what === 'formats' ? 0 : filled(t.s, t.range);
      return { label: `Clear ${what === 'all' ? 'everything in' : what === 'formats' ? 'the formatting of' : ''} ${t.text}`.replace(/\s+/g, ' '), destructive: n > 0, detail: n ? `Removes ${plural(n, 'cell')} of data.` : null };
    }
    case 'format_cells': return { label: `Format ${at(args.range).text}` };
    case 'insert_rows': return { label: `Insert ${plural(lineCount(args.count), 'row')} above row ${lineNumber(args.before_row)} on ${sheetName(args.sheet)}` };
    case 'insert_columns': return { label: `Insert ${plural(lineCount(args.count), 'column')} left of ${args.before_column} on ${sheetName(args.sheet)}` };
    case 'delete_rows': case 'delete_columns': {
      const rows = name === 'delete_rows';
      const n = lineCount(args.count);
      let range = null, s = null;
      try {
        s = sheetNamed(wb, args.sheet, sheetId).id;
        if (rows) { const r = lineNumber(args.start_row) - 1; range = { r1: r, r2: r + n - 1, c1: 0, c2: 16383 }; }
        else { const c = columnArg(args.start_column); range = { r1: 0, r2: 1048575, c1: c, c2: c + n - 1 }; }
      } catch { /* the runner explains */ }
      const data = range && range.r1 >= 0 ? filled(s, range) : 0;
      // The notes in them go too: removing a note on its own asks, and so does removing it with its row.
      const notes = range && range.r1 >= 0 ? notesIn(wb, s, range) : 0;
      const which = rows ? `row${n === 1 ? '' : 's'} ${lineNumber(args.start_row)}${n > 1 ? `–${lineNumber(args.start_row) + n - 1}` : ''}` : `column${n === 1 ? '' : 's'} ${String(args.start_column).toUpperCase()}${n > 1 && range ? `–${colName(range.c2)}` : ''}`;
      const removes = [data && `${plural(data, 'cell')} of data`, notes && plural(notes, 'note')].filter(Boolean);
      return { label: `Delete ${which} on ${sheetName(args.sheet)}`, destructive: removes.length > 0, detail: removes.length ? `Removes ${removes.join(' and ')}.` : null };
    }
    case 'sort_range': return { label: `Sort ${at(args.range).text}` };
    case 'create_chart': return { label: `Add a ${args.type || 'column'} chart of ${at(args.data_range).text}` };
    case 'create_table': {
      // Its header formulas become the text they show, and the result says so.
      const t = at(args.range);
      const range = t.s != null && t.range ? tableRange(wb, t.s, t.range) : null;
      const n = range ? headerFormulas(wb, t.s, range) : 0;
      return { label: `Make ${t.text} a table`, destructive: n > 0, detail: n ? `Turns ${plural(n, 'formula')} in the header row into the text ${n === 1 ? 'it shows' : 'they show'}.` : null };
    }
    case 'add_conditional_format': return { label: `Highlight ${at(args.range).text} (${args.rule})` };
    case 'add_dropdown': {
      // A range has one rule: the one on exactly these cells (the user's list of choices, or a rule of their own) goes.
      const t = at(args.range);
      const had = t.s != null && t.range ? sameRangeValidation(wb, t.s, t.range) : null;
      if (!had) return { label: `Add a dropdown to ${t.text}` };
      const list = had.type === 'list';
      return { label: `Replace the ${list ? 'dropdown' : 'validation rule'} on ${t.text}`, destructive: true, detail: list ? 'Replaces the dropdown these cells have, and its choices.' : 'Replaces the rule these cells have for what they may hold.' };
    }
    case 'manage_sheet': {
      // A sheet not named is the active one, which the runner acts on: the question says which sheet it is.
      const n = sheetName(args.sheet);
      if (args.action === 'delete') {
        let data = 0;
        try { const s = sheetNamed(wb, args.sheet, sheetId); data = s.cells.size ? filledCells(wb, s.id, { r1: 0, c1: 0, r2: 1048575, c2: 16383 }) : 0; } catch { /* the runner explains */ }
        return { label: `Delete the sheet ${n}`, destructive: true, detail: data ? `Removes ${plural(data, 'cell')} of data and everything else on the sheet.` : 'The sheet is removed with everything on it.' };
      }
      return { label: { add: `Add a sheet${args.sheet ? ` named ${args.sheet}` : ''}`, rename: `Rename ${n} to ${args.new_name}`, duplicate: `Duplicate ${n}`, activate: `Show ${n}` }[args.action] || 'Change a sheet' };
    }
    case 'freeze_panes': {
      // The panes as the runner leaves them: what the call does not give stays as it is, so { rows: 0 } on a sheet with
      // two columns frozen keeps those, which "Unfreeze" would have said were let go.
      let sheet = null;
      try { sheet = sheetNamed(wb, args.sheet, sheetId); } catch { /* the runner explains */ }
      const panes = (given, now) => Math.max(0, Math.trunc(Number(given ?? now ?? 0)) || 0);
      const rows = panes(args.rows, sheet?.frozenRows), cols = panes(args.columns, sheet?.frozenCols);
      return { label: rows || cols ? `Freeze ${[rows && plural(rows, 'row'), cols && plural(cols, 'column')].filter(Boolean).join(' and ')} on ${sheetName(args.sheet)}` : `Unfreeze ${sheetName(args.sheet)}` };
    }
    case 'set_column_width': {
      // The columns as the runner reads them ("b:d" is B:D, a run given backwards is the same run).
      let lo = null, hi = null;
      try { const [a, b = a] = String(args.columns ?? '').split(':'); const c1 = columnArg(a), c2 = columnArg(b); lo = Math.min(c1, c2); hi = Math.max(c1, c2); } catch { /* the runner explains */ }
      const many = lo != null ? hi > lo : String(args.columns).includes(':');
      const cols = lo != null ? `${colName(lo)}${many ? `:${colName(hi)}` : ''}` : String(args.columns ?? '');
      return { label: String(args.width).trim().toLowerCase() === 'fit' ? `Fit column${many ? 's' : ''} ${cols} to ${many ? 'their' : 'its'} contents` : `Set column${many ? 's' : ''} ${cols} to ${args.width}px` };
    }
    case 'add_note': {
      // A note the cell already has is the user's writing: replacing or removing it asks, as replacing a value does.
      // Given a range, the note goes on its first cell, which is what is named.
      const t = at(args.cell);
      if (t.range) { t.range = { r1: t.range.r1, c1: t.range.c1, r2: t.range.r1, c2: t.range.c1 }; t.text = qualified(wb, t.s, t.range); }
      const had = t.s != null && t.range ? wb.getNote(t.s, t.range.r1, t.range.c1) : null;
      const text = String(args.text ?? '');
      if (!text.trim()) return { label: `Remove the note from ${t.text}`, destructive: !!had, detail: had ? 'Removes the note the cell has.' : null };
      const replaces = !!had && had !== cutText(text, MAX_NOTE);
      return { label: `${replaces ? 'Replace the note on' : 'Add a note to'} ${t.text}`, destructive: replaces, detail: replaces ? 'Replaces the note the cell has.' : null };
    }
    default: return { label: name };
  }
}
