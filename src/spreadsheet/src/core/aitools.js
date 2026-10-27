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
import { quoteSheet, shiftFormula, mapFormulaRefs, MAX_ROW, MAX_COL } from './refs.js';
import { parseFormula } from './formula/parser.js';
import { evaluateFormula, resetArrayBudget } from './formula/evaluator.js';
import { isError, isRange } from './formula/functions.js';
import { formatValue, fontKeyFor, parseTime, ymdToSerial, parseInput, editText } from './format.js';
import { CHART_TYPES, CHART_MIN_W, CHART_MIN_H } from './charts.js';
import { subtypeOf, chartSubtype, changeSubtypePatch } from './chart-subtypes.js';
import { effectiveFontTheme } from './font-theme.js';
import { findAll, replaceCells, replaceInText, compilePattern, cellMatches, searchBudget } from './search.js';
import { copyMergeLayout } from './clipboard.js';
import { composePaste } from './paste-special.js';
import { formulaReachesOut } from './reaches-out.js';
import { upperName } from './formula/tokenizer.js';
import { dataBounds } from './aiformula.js';
import { cellFromInput, objectNoun, safeLinkUrl } from './workbook.js';
import { getThread, copyThreads, pasteThreads } from './comments.js';
import { tableRows } from './tables.js';
import { tableFilterButtonOn } from './table-header-row.js';
import { sheetFilters, filterTable, sameFilterRange } from './sheet-filters.js';
import { conditionalRuleGroups, clearRules } from './conditional-groups.js';
import { eachStoredCell } from './sparse-range.js';
import { describeRule } from './condformat.js';
import { VALIDATION_OPERATORS, describeValidation } from './validation.js';
import { pivotDefinitionState, readPivotDefinition, buildPivot, previewPivot, pivotFields, pivotFieldValues, pivotRangeProblem, hasPivotDefinition, writePivotSheet, writePivotAt, pivotSheetName, PivotSizeError, PIVOT_AGGS } from './pivot.js';
import { detectDelimiter, splitSourceText } from './text-split.js';
import { ENGINES, RELATIONS, MAX_VARIABLES, emptyModel, hasSolverModel, readSolverModel, solverNameEntries, parseRanges, prepareSolver, runSolver, applySolverResult, availableReports } from './solver.js';

/** A request the workbook refused, in words the model can act on. */
export class ToolError extends Error {}

/** How much one read or write may cover: enough for real work, not enough to flood the conversation. */
export const MAX_READ_CELLS = 2500;
/** And this much text (some 10,000 tokens): 2,500 cells of long text would otherwise fill the model's whole context. */
export const MAX_READ_CHARS = 40000;
export const MAX_WRITE_CELLS = 10000;
const MAX_CELL_TEXT = 300; // a read quotes this much of each cell
const MAX_FIND = 60;
const MAX_FIND_SPILLS = 1e6; // spilled values a find looks at on one sheet: an array over the whole sheet spills billions
const MAX_CALC_CELLS = 400;
const MAX_CALC_TEXT = 10000; // a single text result, such as a TEXTJOIN of a column
const MAX_NOTE = 4000; // the most of a note the workbook keeps
const SOLVE_SECONDS = 30; // a solve's time limit unless the call gives one; the chat waits for it
const SOLVE_MAX_SECONDS = 120;
const MAX_CONSTRAINTS = 200;
const MAX_LISTED = 50; // variable cells a solve's result lists by value

const NUMBER_FORMATS = ['general', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'text', 'scientific'];
const RULE_KINDS = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq', 'contains', 'notContains', 'beginsWith', 'endsWith', 'empty', 'notEmpty', 'dup', 'unique', 'top', 'bottom', 'formula', 'scale', 'databar'];
const NUMERIC_RULES = new Set(['gt', 'gte', 'lt', 'lte', 'between', 'top', 'bottom']);
const HEX = /^#[0-9a-f]{6}$/i;
const FILTER_CONDITIONS = ['gt', 'gte', 'lt', 'lte', 'between', 'eq', 'neq', 'contains', 'notContains', 'beginsWith', 'endsWith', 'empty', 'notEmpty', 'top', 'bottom', 'above_average', 'below_average', 'formula'];
const COPY_WHAT = ['all', 'values', 'formulas', 'formats'];
const MAX_COPY_CELLS = 200000; // as much as the editor copies at once

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
  fn('get_workbook_info', 'List the sheets (with the range their data occupies, frozen panes, tables, charts, filters, pivot tables and how many rules and notes each has), the named ranges, the active sheet and the user\'s selection. Call this first when you need to know what is in the workbook.'),
  fn('get_sheet_details', 'List what a sheet holds besides its values: conditional formatting and data validation rules, charts and their settings (with the ids the tools that change or remove them take), pivot tables, filters, merged cells, hidden rows and columns, sparklines, protected ranges, and which cells have notes or comments.', { sheet: SHEET }),
  fn('read_range', 'Read cells as the user sees them (formatted values), with the formulas behind them, and their notes, comments, merged cells, links and hidden columns. Rows are numbered and columns tab-separated. Read before you change anything, and read again to check your work. Large ranges are cut; read the rest in further calls.', {
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
  fn('clear_range', 'Clear cells: their contents, their formatting, or both. Clearing formats also takes conditional formatting off the cells and unmerges them, as Clear Formats does.', {
    range: RANGE,
    what: str('"contents" (default), "formats", or "all".', { enum: ['contents', 'formats', 'all'] }),
  }, ['range']),
  fn('copy_range', 'Copy cells to another place, as copy and paste does: relative references in formulas shift with the copy, and notes, merged cells, conditional formats and validation come along. Hidden and filtered-out rows and columns are left out, as a copy leaves them, unless include_hidden is set. A destination range that is a multiple of the source\'s size is filled with repeated copies. Replaces what is at the destination.', {
    source: RANGE,
    destination: str('Where the copy goes: its top-left cell, e.g. "F2" or "Summary!A1", or a range to repeat the copy across. Without a sheet it means the active sheet.'),
    what: str('"all" (default), "values" (what the cells show, without formulas, keeping the destination\'s formatting), "formulas" (keeping the destination\'s formatting) or "formats".', { enum: COPY_WHAT }),
    transpose: bool('Turn the rows into columns (default false).'),
    include_hidden: bool('Copy hidden and filtered-out rows and columns too (default false).'),
  }, ['source', 'destination']),
  fn('move_range', 'Move cells to another place, as cut and paste does: they leave the source with their formulas, formatting, notes and merges, and formulas elsewhere that refer to them follow them. Replaces what is at the destination.', {
    source: RANGE,
    destination: str('Top-left cell of where the cells go, e.g. "H2" or "Archive!A1". Without a sheet it means the active sheet.'),
  }, ['source', 'destination']),
  fn('find_replace', 'Replace text in cells, as Find & Replace\'s Replace all does. Searches the active sheet unless given a range, a sheet or all_sheets; hidden rows, columns and sheets are left alone. Returns how many cells changed and which.', {
    find: str('The text to find.'),
    replace: str('The text to put in its place; "" removes it.'),
    range: str('Search only this range, e.g. "B2:B200" or "Data!A:A".'),
    sheet: str('Search only this sheet. Defaults to the active sheet.'),
    all_sheets: bool('Search every sheet (default false).'),
    match_case: bool('Match upper and lower case exactly (default false).'),
    whole_cell: bool('Only cells whose whole content is the text (default false).'),
    in_formulas: bool('Replace inside formula text too, such as a sheet name or a constant a formula uses (default true). False leaves formulas alone.'),
    regex: bool('find is a regular expression, and $1, $2… in replace insert its groups (default false).'),
  }, ['find', 'replace']),
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
  fn('filter_range', 'Filter a list so only the rows that meet the criteria show (Data ▸ Filter); rows are hidden, not deleted. Filters an existing filter or table at the range, or turns a filter on over the range (its first row the header). Also clears every criterion ("clear") or removes the filter ("remove"). Returns how many rows show.', {
    range: str('The list: its range, a cell inside it, or a table name, e.g. "A1:F200", "Sales!B5" or "Orders".'),
    action: str('"apply" (default) sets the criteria given; "clear" shows every row again; "remove" turns the filter off.', { enum: ['apply', 'clear', 'remove'] }),
    columns: {
      type: 'array',
      description: 'Criteria by column. An entry with neither values nor condition clears that column\'s criteria; columns not listed keep theirs.',
      items: {
        type: 'object',
        properties: {
          column: str('Column letter, e.g. "C", or the header text, e.g. "Region".'),
          values: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, description: 'Keep rows showing one of these values, as shown in the cells; "" keeps blank rows.' },
          condition: str('Or keep rows meeting a condition. top/bottom keep the N largest/smallest (value N, default 10); formula keeps rows for which a formula written for the first data row is TRUE (value "=C2>100").', { enum: FILTER_CONDITIONS }),
          value: { type: ['string', 'number'], description: 'What the condition compares with: a number, a date as "YYYY-MM-DD", text, N for top/bottom, or the formula.' },
          value2: { type: ['string', 'number'], description: 'The upper bound for between.' },
          percent: bool('top/bottom: N is a percentage of the rows.'),
        },
        required: ['column'],
        additionalProperties: false,
      },
    },
    clear_others: bool('Also clear the criteria of columns not listed (default false).'),
  }, ['range']),
  fn('create_pivot_table', 'Summarize a list as a pivot table, as Insert ▸ PivotTable builds it: one field down the rows, optionally one across the columns, one value field summarized, with totals, and optionally a filter cell above it. Its cells are live formulas over the data; the user\'s Refresh rebuilds it to pick up new categories. Goes on a new sheet unless a destination is given.', {
    data_range: str('The list, its first row the field names: a range, a cell inside it, or a table name.'),
    rows: str('The field whose values become the rows: its header text, or its column letter.'),
    columns: str('Optional field whose values become the columns.'),
    values: str('The field to summarize.'),
    summarize: str('How to summarize the values (default sum).', { enum: PIVOT_AGGS.map(([k]) => k) }),
    filter: str('Optional field to filter the table by: a cell above it picks one of its values.'),
    filter_value: { type: ['string', 'number', 'boolean'], description: 'The value the filter starts on (default all).' },
    destination: str('Top-left cell to put it at on an existing sheet, e.g. "Summary!A1". Default: a new sheet.'),
    new_sheet_name: str('Name for the new sheet (default "Pivot of <source sheet>").'),
  }, ['data_range', 'rows', 'values']),
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
  fn('update_chart', 'Change a chart: its type, data, titles, stacking, legend, position or size. Give only what changes; an empty title removes it.', {
    chart: str('The chart\'s id from get_sheet_details or get_workbook_info, or its title or name when no other chart shares it.'),
    type: str('New chart type.', { enum: CHART_TYPES.map(([t]) => t) }),
    data_range: str('New data range, on the chart\'s sheet, read as create_chart reads it.'),
    series_in: str('Whether each column or each row of the data is one series.', { enum: ['columns', 'rows', 'auto'] }),
    title: str('Chart title.'), x_title: str('Horizontal axis title.'), y_title: str('Vertical axis title.'),
    stacked: bool('Stack the series (column, bar, line, area).'),
    legend: str('Where the legend goes, or none.', { enum: ['bottom', 'top', 'right', 'none'] }),
    anchor_cell: str('Cell to move the chart\'s top-left corner to.'),
    width: num('Width in pixels.'), height: num('Height in pixels.'),
  }, ['chart']),
  fn('delete_chart', 'Delete a chart.', {
    chart: str('The chart\'s id from get_sheet_details or get_workbook_info, or its title or name when no other chart shares it.'),
  }, ['chart']),
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
  fn('remove_conditional_format', 'Remove conditional formatting: one rule by its id, every rule from some cells (a rule reaching past them keeps the rest of its range), or every rule on a sheet.', {
    rule_id: str('The rule\'s id from get_sheet_details.'),
    range: str('Or: the cells to clear of rules, e.g. "B2:B50".'),
    sheet: str('Or: a sheet to clear of every rule, with whole_sheet.'),
    whole_sheet: bool('Remove every rule on the sheet.'),
  }),
  fn('add_dropdown', 'Give cells a dropdown list of allowed values (data validation).', {
    range: RANGE,
    options: { type: 'array', items: { type: 'string' }, description: 'The choices, when they are listed here.' },
    source_range: str('Or: a range whose cells hold the choices, e.g. "Lists!A2:A20".'),
    strict: bool('Refuse values not in the list (default true); false only warns.'),
  }, ['range']),
  fn('add_validation', 'Limit what cells may hold (data validation other than a dropdown): whole or decimal numbers, dates or times in bounds, text of some length, a custom formula that must be TRUE, or checkboxes. Replaces the rule on exactly the same cells. Dates as "YYYY-MM-DD", times as "HH:MM".', {
    range: RANGE,
    type: str('What the cells may hold.', { enum: ['whole', 'decimal', 'date', 'time', 'text_length', 'custom', 'checkbox'] }),
    operator: str('How values compare with min (and max). Default between.', { enum: VALIDATION_OPERATORS.map(([k]) => k) }),
    min: { type: ['number', 'string'], description: 'The bound to compare with (the lower one for between).' },
    max: { type: ['number', 'string'], description: 'The upper bound, for between and notBetween.' },
    formula: str('For custom: a formula written for the range\'s top-left cell, TRUE for allowed values, e.g. "=COUNTIF($A:$A,A2)=1".'),
    strict: bool('Refuse values that break the rule (default true); false only warns.'),
    allow_blank: bool('Blank cells are allowed (default true).'),
    prompt: str('A message shown beside a selected cell.'),
    error_message: str('The message shown when a value is refused.'),
  }, ['range', 'type']),
  fn('remove_validation', 'Remove data validation (dropdowns included): one rule by its id, or every rule from some cells (a rule reaching past them keeps the rest of its range).', {
    rule_id: str('The rule\'s id from get_sheet_details.'),
    range: str('Or: the cells to clear of validation, e.g. "C2:C100".'),
  }),
  fn('manage_sheet', 'Add, rename, duplicate, delete or show a sheet.', {
    action: str('What to do.', { enum: ['add', 'rename', 'duplicate', 'delete', 'activate'] }),
    sheet: str('The sheet to act on (the name for a new sheet when adding).'),
    new_name: str('The new name, when renaming.'),
  }, ['action']),
  fn('freeze_panes', 'Keep rows at the top and columns at the left in view while scrolling. 0 unfreezes.', {
    sheet: SHEET, rows: int('How many top rows to freeze.'), columns: int('How many left columns to freeze.'),
  }, []),
  fn('remove_duplicates', 'Delete the rows of a range that repeat an earlier row (matched by the text the cells show, ignoring case); the first of each stays and the rows below move up within the range. In a table, its rows go from the table.', {
    range: RANGE,
    columns: { type: 'array', items: { type: 'string' }, description: 'Column letters that decide whether two rows are the same, e.g. ["A", "C"]. Default: every column of the range.' },
    has_header: bool('The first row is a header that stays (default: guessed). A table\'s header is always kept.'),
  }, ['range']),
  fn('split_text_to_columns', 'Split the text of one column into several columns (Text to Columns), by separators or at fixed character positions. The pieces go over the text and into the columns to its right, unless a destination is given.', {
    range: str('The column of text to split, e.g. "A2:A200" or "Data!C:C". One column only.'),
    delimiters: { type: 'array', items: { type: 'string' }, description: 'Separator characters, e.g. [","] or [";", " "]; "\\t" for tab. Default: detected (tab, comma, semicolon, pipe, then space).' },
    consecutive_as_one: bool('Treat repeated separators as one (default false).'),
    text_qualifier: str('Quote character that keeps separators inside a piece (default ").', { enum: ['"', '\'', 'none'] }),
    fixed_widths: { type: 'array', items: { type: 'integer' }, description: 'Split at fixed widths instead: the character positions to cut before, e.g. [4, 6] cuts "20240115" into 2024, 01, 15.' },
    piece_formats: { type: 'array', items: { type: 'string', enum: ['general', 'text', 'skip'] }, description: 'Per piece, in order: "general" (read as typed), "text" (kept exactly, e.g. leading zeros) or "skip" (left out). Default general.' },
    destination: str('Cell where the first row\'s first piece goes, e.g. "D2". Default: over the text itself.'),
  }, ['range']),
  fn('add_sparklines', 'Draw small charts inside cells, one per row or column of data: a line, columns, or win/loss bars. The cells keep their values. Or remove the sparklines in a range.', {
    data_range: str('The data, e.g. "B2:M10": one sparkline per row (or column) of it. A named range works for one sparkline.'),
    location: str('The cells the sparklines go in: one row or one column of cells, as many as the data has rows (or columns), e.g. "N2:N10".'),
    type: str('Sparkline type (default line).', { enum: ['line', 'column', 'win_loss'] }),
    series_in: str('Whether each row or each column of the data is one sparkline (default: guessed from the shapes).', { enum: ['rows', 'columns'] }),
    markers: bool('Line sparklines: mark every point.'),
    highlight: { type: 'array', items: { type: 'string', enum: ['high', 'low', 'first', 'last', 'negative'] }, description: 'Points to show in an accent color.' },
    remove: bool('Remove the sparklines in location instead (data_range is then not needed).'),
  }, ['location']),
  fn('set_link', 'Put a hyperlink on a cell, to a web address, an email address or a place in this workbook, or remove it. Without text, the cell keeps what it shows (an empty cell shows the address).', {
    cell: str('The cell, e.g. "B4" or "Index!A2".'),
    url: str('A web address (https://…) or an email address.'),
    location: str('Or a place in this workbook: a cell or range ("Summary!A1"; without a sheet, on the cell\'s own sheet) or a named range.'),
    text: str('Text the cell shows. It replaces what the cell holds.'),
    remove: bool('Remove the cell\'s link instead; the cell keeps what it shows.'),
  }, ['cell']),
  fn('set_column_width', 'Set the width of columns in pixels, or fit them to their contents.', {
    sheet: SHEET, columns: str('A column or run of columns, e.g. "B" or "A:F".'), width: str('Width in pixels (24 to 800), or "fit".'),
  }, ['columns', 'width']),
  fn('set_row_height', 'Set the height of rows in pixels, or fit them to their contents (wrapped text, larger fonts).', {
    sheet: SHEET, rows: str('A row, a run of rows or several, e.g. "3", "2:20" or "1,4:6".'), height: str('Height in pixels (18 to 400; a default row is about 20), or "fit".'),
  }, ['rows', 'height']),
  fn('set_hidden', 'Hide whole rows or columns, or show hidden ones again. Their contents stay as they are. Give rows or columns, not both.', {
    sheet: SHEET,
    rows: str('Rows, e.g. "5", "3:8" or "2,4,10:12".'),
    columns: str('Columns, e.g. "C", "B:D" or "A,C:E".'),
    hidden: bool('true hides them, false shows them again.'),
  }, ['hidden']),
  fn('merge_cells', 'Merge cells into one, or unmerge them. A merged cell keeps only its top-left value: the other values in it are deleted.', {
    range: RANGE,
    action: str('"merge" makes the range one cell (default), "merge_across" merges each row of it on its own, "unmerge" splits every merged cell the range touches.', { enum: ['merge', 'merge_across', 'unmerge'] }),
    center: bool('Center the text, as Merge & Center does (default true for merge, false for merge_across).'),
  }, ['range']),
  fn('manage_name', 'Define, redefine, rename or delete a named range or named formula. Formulas that use a renamed name follow the rename.', {
    action: str('"define" adds a name, or changes what an existing one refers to; "rename"; "delete".', { enum: ['define', 'rename', 'delete'] }),
    name: str('The name, e.g. "TaxRate".'),
    refers_to: str('What it stands for: a range such as "Sales!B2:B20" (anchored with $ for you) or a formula such as "=0.2" or "=LAMBDA(x, x*1.2)". Needed to define; for rename, only to change it too.'),
    new_name: str('The new name, when renaming.'),
    scope: str('A sheet name, for a name only that sheet\'s formulas see. Defaults to the whole workbook.'),
  }, ['action', 'name']),
  fn('add_note', 'Attach a note (comment) to a cell, or replace its note. An empty text removes it.', {
    cell: str('The cell, e.g. "D4" or "Sheet2!B7".'), text: str('The note.'),
  }, ['cell', 'text']),
  fn('goal_seek', 'Goal Seek: find the number for one input cell that makes a formula cell show a target value, and write it into the input cell. Both cells are on one sheet; the input must hold a number or be blank.', {
    set_cell: str('The formula cell that should reach the value, e.g. "B10" or "Loan!B10".'),
    to_value: num('The value it should reach.'),
    by_changing: str('The input cell to change, on the same sheet, e.g. "B3".'),
  }, ['set_cell', 'to_value', 'by_changing']),
  fn('solve', `Solver: change several variable cells so a formula cell (the objective) is as large or small as it can be, or equals a value, while constraints hold. The model is saved on the sheet, where Data ▸ Solver opens it. Omit objective to run the model already saved on the sheet. Runs for up to ${SOLVE_SECONDS} seconds by default.`, {
    objective: str('One formula cell, e.g. "B10" or "Plan!B10". The variables and constraints are on its sheet.'),
    goal: str('Maximize, minimize, or reach value (default max).', { enum: ['max', 'min', 'value'] }),
    value: num('For goal "value": the number the objective should equal.'),
    variables: str('The cells Solver changes: ranges separated by commas, e.g. "B2:B5,D2". They must hold numbers or be blank.'),
    constraints: { type: 'array', description: 'Constraints. int, bin (0 or 1) and dif (all different whole numbers 1 to N) apply to variable cells and take no value.', items: { type: 'object', properties: {
      cell: str('A cell or range, e.g. "C10" or "B2:B5".'),
      relation: str('How it compares.', { enum: RELATIONS.map(([r]) => r) }),
      value: { type: ['number', 'string'], description: 'The right side for <=, = and >=: a number, a cell, a range the size of the left side, or a formula.' },
    }, required: ['cell', 'relation'], additionalProperties: false } },
    method: str('simplex for linear models (exact, fast), grg for smooth nonlinear ones (default), evolutionary for non-smooth ones (needs bounds on every variable).', { enum: ENGINES.map(([e]) => e) }),
    non_negative: bool('Variables without a lower bound of their own cannot go below 0 (default true).'),
    max_seconds: num(`Time limit in seconds (default ${SOLVE_SECONDS}, at most ${SOLVE_MAX_SECONDS}).`),
    keep: bool('Keep the solution in the variable cells (default true). false reports it and leaves the cells as they were.'),
    keep_best_found: bool('Also keep the best values found when Solver stops at a limit without a solution (default false: they are restored).'),
    reports: { type: 'array', description: 'Report sheets to add before the model\'s sheet.', items: { type: 'string', enum: ['answer', 'sensitivity', 'limits'] } },
    sheet: str('For a saved model, without objective: its sheet. Defaults to the active sheet.'),
  }),
  fn('select_range', 'Select a range in the user\'s view (switching sheets if needed) to point them at something. Changes nothing.', {
    range: RANGE,
  }, ['range']),
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));
const READ_TOOLS = new Set(['get_workbook_info', 'get_sheet_details', 'read_range', 'calculate', 'find', 'select_range']);

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

/** How many cells of a range have a note (or, with `kind` 'comments', a comment thread): the user's writing, as much as a value is. */
function notesIn(wb, sheetId, range, kind = 'notes') {
  const notes = wb.sheet(sheetId)?.[kind];
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

/**
 * The table data cells, outside the block written, of the columns a write's formulas land in: a new formula typed into
 * a table's calculated column is written down the whole column, as Excel overwrites it. Each with its formula now.
 */
function calculatedColumnCells(wb, sheetId, range, planned) {
  const out = [];
  const seen = new Set();
  for (const { r, c, input } of planned) {
    if (typeof input !== 'string' || !input.startsWith('=')) continue;
    const table = wb.tableAt?.(sheetId, r, c);
    if (!table || seen.has(`${table.id}|${c}`)) continue;
    seen.add(`${table.id}|${c}`);
    const rows = tableRows(table);
    if (r < rows.dataStart || r > rows.dataEnd) continue;
    for (let rr = rows.dataStart; rr <= rows.dataEnd; rr++) {
      if (rr >= range.r1 && rr <= range.r2) continue;
      out.push({ r: rr, c, f: wb.getCell(sheetId, rr, c)?.f ?? null });
    }
  }
  return out;
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
      // A formula the sheet's protection hides stays hidden from the model too, as from the formula bar.
      const f = wb.formulaHiddenAt?.(sheetId, r, c) ? null : wb.getCell(sheetId, r, c)?.f;
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
  // Whole columns (or rows) from where their data begins: A:Z over data from row 300 read 96 empty rows from A1, each
  // read "cut short" and pointing on to the next.
  const data = dataOfLines(wb, sheetId, asked);
  if (!data) {
    // Cells with no values may still hold notes, comments or links.
    const extras = cellExtras(wb, sheetId, asked);
    return extras.length ? [`${qualified(wb, sheetId, asked)} holds no values.`, ...extras].join('\n') : `${qualified(wb, sheetId, asked)} is empty.`;
  }
  const width = data.c2 - data.c1 + 1;
  const maxRows = Math.max(1, Math.floor(MAX_READ_CELLS / width));
  const shown = { ...data, r2: Math.min(data.r2, data.r1 + maxRows - 1), c2: Math.min(data.c2, data.c1 + Math.max(0, MAX_READ_CELLS - 1)) };
  const lines = [`\t${Array.from({ length: shown.c2 - shown.c1 + 1 }, (_, i) => colName(shown.c1 + i)).join('\t')}`];
  let size = lines[0].length;
  for (let r = shown.r1; r <= shown.r2; r++) {
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
  // Notes and the like over the whole range asked, which may reach past its values; over what was shown when the read was cut.
  out.push(...cellExtras(wb, sheetId, shown.r2 < data.r2 || shown.c2 < data.c2 ? shown : asked));
  return out.join('\n');
}

/** "C, E:G" or "5:7, 20": sorted line numbers as runs, columns by letter. */
function lineRuns(indices, axis, limit = 40) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs = [];
  for (const i of sorted) {
    const last = runs.at(-1);
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  const name = (i) => (axis === 'col' ? colName(i) : String(i + 1));
  const text = runs.slice(0, limit).map(([a, b]) => (a === b ? name(a) : `${name(a)}:${name(b)}`)).join(', ');
  return runs.length > limit ? `${text} and ${runs.length - limit} more` : text;
}

const overlaps = (a, b) => a.r1 <= b.r2 && a.r2 >= b.r1 && a.c1 <= b.c2 && a.c2 >= b.c1;

/** The cells of a sheet's map (notes, comment threads) that lie in a range, row by row. */
function keyedIn(map, range) {
  if (!map?.size) return [];
  return [...map.keys()].map((key) => ({ key, ...parseKey(key) }))
    .filter(({ r, c }) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2)
    .sort((a, b) => a.r - b.r || a.c - b.c);
}

/** A comment thread as one line: who wrote what, its replies after. */
function threadText(thread, most = 6) {
  const items = thread.items.slice(0, most).map((i) => `${plain(i.author || 'Someone')}: ${clip(plain(i.text), 600)}`);
  const more = thread.items.length - most;
  return `${items.join(' / ')}${more > 0 ? ` / (${more} more replies)` : ''}`;
}

/**
 * What a read shows besides values and formulas, as the user sees it on the cells: their notes and comment threads
 * (the user's own writing), merged blocks, links, hidden columns, and whether rules apply there. Without these the
 * model could not answer "what do the comments say", wrote a note over one it never saw, and took a merged title for
 * a value in each of its cells.
 */
function cellExtras(wb, sheetId, range) {
  const sheet = wb.sheet(sheetId);
  const out = [];
  const name = (r, c) => cellName(r, c);
  const notes = keyedIn(sheet.notes, range);
  if (notes.length) {
    out.push('Notes:', ...notes.slice(0, 100).map(({ key, r, c }) => `${name(r, c)}: ${clip(plain(sheet.notes.get(key)), 1000)}`));
    if (notes.length > 100) out.push(`(${notes.length - 100} more notes; read a smaller range to see them.)`);
  }
  const threads = keyedIn(sheet.comments, range);
  if (threads.length) {
    out.push('Comments:', ...threads.slice(0, 60).map(({ key, r, c }) => {
      const t = sheet.comments.get(key);
      return `${name(r, c)}${t.done ? ' (resolved)' : ''}: ${threadText(t)}`;
    }));
    if (threads.length > 60) out.push(`(${threads.length - 60} more comment threads; read a smaller range to see them.)`);
  }
  const merges = (wb.mergesIn?.(sheetId, range) || []).slice(0, 60);
  if (merges.length) out.push(`Merged cells (each shows its top-left cell's value): ${merges.map(rangeName).join(', ')}`);
  const links = [];
  for (const [key, cell] of sheet.cells) {
    if (!cell?.hyperlink || links.length >= 60) continue;
    const { r, c } = parseKey(key);
    if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) continue;
    const link = wb.linkAt(sheetId, r, c);
    if (link) links.push(`${name(r, c)} → ${clip(plain(link.url), 300)}`);
  }
  if (links.length) out.push('Links:', ...links.sort());
  const hiddenCols = [];
  for (let c = range.c1; c <= range.c2; c++) if (wb.isHidden?.(sheetId, 'col', c)) hiddenCols.push(c);
  if (hiddenCols.length) out.push(`Hidden columns: ${lineRuns(hiddenCols, 'col')}`);
  const ruled = [(sheet.rules || []).some((rule) => overlaps(rule.range, range)) && 'conditional formatting', (sheet.validations || []).some((v) => overlaps(v.range, range)) && 'data validation'].filter(Boolean);
  if (ruled.length) out.push(`(Part of this range has ${ruled.join(' and ')}; get_sheet_details lists the rules.)`);
  return out;
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
        ...(chartsOf(s).length ? { charts: chartsOf(s).map((c) => ({ id: c.id, type: c.type, title: c.title || undefined, data: c.range ? rangeName(c.range) : undefined })) } : {}),
        ...(sheetFilters(s).length ? { filtered: sheetFilters(s).map((f) => rangeName(f.range)).join(', ') } : {}),
        ...(pivotsOf(wb, s).length ? { pivot_tables: pivotsOf(wb, s).map((p) => p.name) } : {}),
        ...(s.rules?.length ? { conditional_formats: conditionalRuleGroups(s.rules).length } : {}),
        ...(s.validations?.length ? { validation_rules: s.validations.length } : {}),
        ...(s.notes?.size || s.comments?.size ? { notes: s.notes?.size || 0, comment_threads: s.comments?.size || 0 } : {}),
      };
    }),
    // Hidden names are the app's own bookkeeping (a pivot table's or Solver's definition), not the user's names.
    named_ranges: (wb.names || []).filter((n) => !n.hidden).slice(0, 100).map((n) => ({ name: n.name, refers_to: n.ref, ...(n.sheet ? { scope: n.sheet } : {}) })),
  };
}

/** A sheet's charts: the objects that are not pictures, shapes, text, SmartArt, slicers or controls. */
const chartsOf = (sheet) => (sheet.charts || []).filter((c) => objectNoun(c) === 'chart');

/**
 * A sheet's pivot tables: those read from a file (kept as Excel wrote them) and the one Insert ▸ PivotTable built,
 * whose definition its sheet keeps for Refresh.
 */
function pivotsOf(wb, sheet) {
  const out = (wb.nativePivots?.tables || []).filter((p) => p.owner === sheet.id).map((p) => ({ name: p.name, location: p.ref }));
  const built = sheet.kind === 'chart' ? null : readPivotDefinition(wb, sheet.id);
  if (built) {
    const { row, col, value, agg, filter } = built.fields;
    out.push({ name: 'PivotTable', location: built.area, source: built.source, fields: { rows: row ?? undefined, columns: col ?? undefined, values: value ? `${agg || 'sum'} of ${value}` : undefined, filter: filter ?? undefined },
      ...(pivotDefinitionState(wb, sheet.id) === 'changed' ? { note: 'Its cells have been changed since it was built, so Refresh leaves it alone.' } : {}) });
  }
  return out;
}

/** A cell style a rule paints, in words. */
function ruleStyleText(style) {
  if (!style) return undefined;
  const parts = [style.bg && `fill ${fillColorCss(style.bg)}`, typeof style.color === 'string' && `text ${style.color}`, style.bold && 'bold', style.italic && 'italic', style.strike && 'strikethrough', style.underline && 'underline'].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

/** A validation rule in words: what the cells may hold (dates as dates). */
function validationText(v) {
  if (v.type === 'list' && Array.isArray(v.source)) return `List: ${v.source.slice(0, 50).map((o) => clip(String(o), 80)).join(', ')}${v.source.length > 50 ? ', …' : ''}`;
  return clip(describeValidation(v), 400);
}

/**
 * Everything on a sheet besides its cells' values: what read_range does not show. Each list is held to a length,
 * and says when there is more. Ids are what update_chart, delete_chart, remove_conditional_format and
 * remove_validation take.
 */
function sheetDetails(wb, args, env) {
  const sheet = sheetNamed(wb, args.sheet, env.sheetId());
  const most = 80;
  const list = (items, map) => {
    const shown = items.slice(0, most).map(map);
    if (items.length > most) shown.push(`(${items.length - most} more)`);
    return shown;
  };
  const charts = chartsOf(sheet);
  const chartInfo = list(charts, (c) => ({
    id: c.id, type: c.type, ...(c.name ? { name: c.name } : {}), ...(c.title ? { title: c.title } : {}),
    ...(c.range ? { data: rangeName(c.range) } : {}),
    ...(sheet.kind !== 'chart' && c.anchor ? { placed_at: cellName(c.anchor.r, c.anchor.c), size: `${Math.round(c.w)}×${Math.round(c.h)}px` } : {}),
    ...(c.xTitle ? { x_title: c.xTitle } : {}), ...(c.yTitle ? { y_title: c.yTitle } : {}),
    ...(c.stacked ? { stacked: true } : {}), ...(c.seriesIn && c.seriesIn !== 'auto' ? { series_in: c.seriesIn === 'cols' ? 'columns' : 'rows' } : {}),
    ...(c.hidden ? { hidden: true } : {}),
  }));
  if (sheet.kind === 'chart') return { sheet: sheet.name, kind: 'chart sheet', charts: chartInfo };
  const used = dataBounds(wb, sheet.id);
  const groups = conditionalRuleGroups(sheet.rules || []);
  const hiddenRows = [...(sheet.hiddenRows || [])];
  const filterRows = [...(sheet.filterHidden || [])];
  const out = {
    sheet: sheet.name,
    data: used ? rangeName(used) : 'empty',
    ...(sheet.protected ? { protected: true } : {}),
    ...(sheet.protectedRanges?.length ? { protected_ranges: list(sheet.protectedRanges, (p) => rangeName(p.range)) } : {}),
    ...(sheet.tables?.length ? { tables: list(sheet.tables, (t) => ({ name: t.name, range: rangeName(t.range), ...(t.totalsRow ? { totals_row: true } : {}) })) } : {}),
    ...(groups.length ? {
      // In priority order: where rules overlap, the earlier one wins.
      conditional_formats: list(groups, ({ rule, rules }) => ({
        id: rule.id, applies_to: rules.map((p) => rangeName(p.range)).join(', '), rule: describeRule(rule),
        ...(ruleStyleText(rule.style) ? { format: ruleStyleText(rule.style) } : {}),
        ...(rule.type === 'scale' ? { colors: [rule.from, rule.mid, rule.to].filter(Boolean).join(' → ') } : {}),
      })),
    } : {}),
    ...(sheet.validations?.length ? {
      data_validation: list(sheet.validations, (v) => ({
        id: v.id, range: rangeName(v.range), allows: validationText(v), ...(v.strict === false ? { strict: false } : {}),
        ...(v.prompt ? { prompt: clip(plain(v.prompt), 200) } : {}),
      })),
    } : {}),
    ...(sheet.merges?.length ? { merged_cells: lineList(sheet.merges.map(rangeName), 120) } : {}),
    ...(hiddenRows.length ? { hidden_rows: lineRuns(hiddenRows, 'row') } : {}),
    ...(sheet.hiddenCols?.size ? { hidden_columns: lineRuns([...sheet.hiddenCols], 'col') } : {}),
    ...(sheetFilters(sheet).length ? {
      filters: sheetFilters(sheet).map((f) => ({
        range: rangeName(f.range), ...(filterTable(sheet, f) ? { table: filterTable(sheet, f).name } : {}),
        ...(Object.keys(f.criteria || {}).length ? { filtered_columns: Object.keys(f.criteria).map((c) => colName(Number(c))).join(', ') } : {}),
        rows_hidden: filterRows.filter((r) => r > f.range.r1 && r <= f.range.r2).length,
      })),
    } : {}),
    ...(pivotsOf(wb, sheet).length ? { pivot_tables: pivotsOf(wb, sheet) } : {}),
    ...(charts.length ? { charts: chartInfo } : {}),
    ...(sheet.sparklineGroups?.length ? { sparklines: list(sheet.sparklineGroups, (g) => ({ type: g.type === 'stacked' ? 'win/loss' : g.type, cells: lineList(g.sparklines.map((s) => `${s.ref} ← ${s.formula ?? ''}`), 20) })) } : {}),
    ...(sheet.notes?.size ? { notes: lineList(keyedIn(sheet.notes, FULL).map(({ r, c }) => cellName(r, c)), 120) } : {}),
    ...(sheet.comments?.size ? { comment_threads: lineList(keyedIn(sheet.comments, FULL).map(({ r, c }) => cellName(r, c)), 120) } : {}),
    ...(sheet.frozenRows || sheet.frozenCols ? { frozen: { rows: sheet.frozenRows || 0, columns: sheet.frozenCols || 0 } } : {}),
  };
  return out;
}

const FULL = { r1: 0, c1: 0, r2: MAX_ROW, c2: MAX_COL };
/** Addresses joined, held to a count. */
const lineList = (items, most) => `${items.slice(0, most).join(', ')}${items.length > most ? ` and ${items.length - most} more` : ''}`;

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
    ...(typeof value === 'number' ? { display: formatValue(value, impliedStyle(wb, sheet.id, body)) } : {}),
    ...(long ? { note: `The text is ${shown.length.toLocaleString('en-US')} characters long; only the first ${MAX_CALC_TEXT.toLocaleString('en-US')} are shown.` } : {}),
  };
}

/**
 * The format the result would show in, typed into a cell with none of its own: =MAX(B:B) over a column of dates reads
 * as a date and =A2*B2 over prices as money, as on the sheet. Shown as a bare number, the latest order date came back
 * as 45293, which the model was left to turn into a date itself or to report as it was.
 */
function impliedStyle(wb, sheetId, body) {
  const cell = { f: body, s: null };
  wb._applyImpliedStyle?.(sheetId, cell);
  return cell.s || {};
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
  let more = false, cut = false;
  for (const sheet of sheets) {
    const keys = [...sheet.cells.keys()].filter((key) => holds(sheet.cells.get(key))).map(parseKey);
    // What a formula spills into the cells below and beside it shows on the sheet as a typed value does: a search of
    // the values that left it out said "No cells match" of text in plain view. They are taken one at a time, and only
    // so many, since listing every value of an array over the whole sheet ran the tab out of memory.
    if (!args.in_formulas) {
      const own = new Set(keys.map(({ r, c }) => cellKey(r, c)));
      let seen = 0;
      for (const { r, c } of wb.eachSpill(sheet.id)) {
        if (++seen > MAX_FIND_SPILLS) { cut = true; break; }
        if (!own.has(cellKey(r, c))) keys.push({ r, c });
      }
    }
    keys.sort((a, b) => a.r - b.r || a.c - b.c);
    for (const { r, c } of keys) {
      const cell = sheet.cells.get(cellKey(r, c));
      const hay = args.in_formulas ? (cell.f != null && !wb.formulaHiddenAt?.(sheet.id, r, c) ? `=${cell.f}` : '') : wb.getDisplay(sheet.id, r, c);
      if (!hay || !fold(hay).includes(needle)) continue;
      if (matches.length >= MAX_FIND) { more = true; break; }
      matches.push({ cell: qualified(wb, sheet.id, { r1: r, c1: c, r2: r, c2: c }), text: clip(plain(hay), 120) });
    }
    if (more) break;
  }
  const notes = [
    ...(more ? [`More than ${MAX_FIND} cells match; search a single sheet or a longer text.`] : []),
    ...(matches.length ? [] : ['No cells match.']),
    ...(cut ? [`Only the first ${MAX_FIND_SPILLS.toLocaleString('en-US')} values an array formula spills on a sheet were searched.`] : []),
  ];
  return { matches, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

/* ---------- Writing ---------- */

/** Refuse a change to cells the sheet or a protected range locks, before anything is written. */
function assertWritable(wb, sheetId, range, { contents = false } = {}) {
  const sheet = wb.sheet(sheetId);
  // New contents for cells formatted as unlocked go in on a protected sheet (a form's fields), as the user types them.
  const unlocked = contents && range && wb.isProtected(sheetId) && unlockedCells(wb, sheetId, range);
  if (wb.isProtected(sheetId) && !unlocked) throw new ToolError(`${sheet.name} is protected. The user can unprotect it from the sheet tab's menu.`);
  const inProtectedRange = (rg) => (sheet.protectedRanges || []).some(({ range: g }) => g.r1 <= rg.r2 && g.r2 >= rg.r1 && g.c1 <= rg.c2 && g.c2 >= rg.c1);
  if (range && (unlocked ? inProtectedRange(normalizeRange(range)) : wb.isLockedIn(sheetId, range))) throw new ToolError(`Part of ${qualified(wb, sheetId, range)} is a protected range and cannot be changed.`);
}

/** Is every cell of a (writable-sized) range formatted as unlocked? */
function unlockedCells(wb, sheetId, range) {
  const { r1, c1, r2, c2 } = normalizeRange(range);
  if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_WRITE_CELLS) return false;
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (wb.styleAt(sheetId, r, c)?.locked !== false) return false;
  return true;
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
  assertWritable(wb, sheetId, range, { contents: true });
  if (wb.arrayEditBlocked(sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} crosses part of an array formula's result. Write around it, or replace the whole array.`);
  const refused = [];
  const planned = [];
  let reached = false;
  let kept = 0;
  const hidden = []; // cells under a merged cell's top-left one
  rows.forEach((row, i) => row.forEach((value, j) => {
    const input = inputFor(value);
    if (input === undefined) return;
    const r = range.r1 + i;
    const c = range.c1 + j;
    // A merged cell shows its top-left cell alone: a value written under the rest of it would be stored where no one
    // sees it, so those cells are left out, as a paste leaves them, and said to be.
    const merge = wb.mergeAt?.(sheetId, r, c);
    if (merge && (merge.r1 !== r || merge.c1 !== c)) {
      if (input !== '') hidden.push(`${cellName(r, c)} (inside the merged cell ${rangeName(merge)}; write to ${cellName(merge.r1, merge.c1)})`);
      return;
    }
    const verdict = typeof input === 'string' ? wb.validateInput(sheetId, r, c, input) : wb.validateValue?.(sheetId, r, c, input) ?? { ok: true };
    if (!verdict.ok && verdict.rule?.strict !== false) { refused.push(`${cellName(r, c)} (${verdict.message || 'not allowed by its validation rule'})`); return; }
    if (typeof input === 'string' && input.startsWith('=') && reachesOut(wb, input.slice(1))) reached = true;
    // A cell written back with what it already holds (a block the model read and rewrites) is left as it is: written
    // again, it lost the link and the mixed formatting of its text that it had, though nothing was asked about.
    const cell = wb.getCell(sheetId, r, c);
    if (holds(cell) && (typeof input === 'string' ? keepsValue(wb, sheetId, r, c, cell, input) : cell.f == null && cell.v === input)) { kept++; return; }
    planned.push({ r, c, input });
  }));
  if (!planned.length && kept && !refused.length && !hidden.length) return { written: qualified(wb, sheetId, range), cells: 0, unchanged: kept };
  if (!planned.length) throw new ToolError(refused.length || hidden.length ? `Nothing was written: ${[...refused, ...hidden].slice(0, 5).join('; ')}.` : 'Every value was null, so nothing was written.');
  const note = reachingNote(env, reached);
  const written = new Set(planned.filter(({ input }) => input !== '').map(({ r, c }) => cellKey(r, c)));
  const hit = spillsHit(wb, sheetId, range, (r, c) => written.has(cellKey(r, c)));
  const column = calculatedColumnCells(wb, sheetId, range, planned);
  wb.ensureSize(sheetId, range.r2 + 1, range.c2 + 1);
  wb.transaction('AI edit', () => { for (const { r, c, input } of planned) writeOne(wb, sheetId, r, c, input); });
  // The rows of a calculated column the write rewrote beyond its own block, which the model must know of.
  const rewrote = column.filter(({ r, c, f }) => (wb.getCell(sheetId, r, c)?.f ?? null) !== f).map(({ r, c }) => cellName(r, c));
  const errors = formulaErrors(wb, sheetId, range);
  const blocked = blockedSpills(wb, sheetId, hit);
  return {
    written: qualified(wb, sheetId, range),
    cells: planned.length,
    ...(kept ? { unchanged: kept } : {}),
    ...(refused.length ? { refused_by_validation: refused.slice(0, 10) } : {}),
    ...(hidden.length ? { not_written_inside_merged_cells: hidden.slice(0, 10) } : {}),
    ...(rewrote.length ? { calculated_column: `The formula went into a table's calculated column, so it was written to the column's other rows as well: ${rewrote.length} more cell${rewrote.length === 1 ? '' : 's'} (${rewrote.slice(0, 6).join(', ')}${rewrote.length > 6 ? ', …' : ''}).` } : {}),
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
  assertWritable(wb, sheetId, range, { contents: true });
  if (wb.arrayEditBlocked(sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} crosses part of an array formula's result.`);
  if (!wb.canEnsureSize(sheetId, range.r2 + 1, range.c2 + 1)) throw new ToolError('The range runs past the edge of the sheet.');
  const note = reachingNote(env, reachesOut(wb, text.slice(1)));
  const hit = spillsHit(wb, sheetId, range);
  wb.ensureSize(sheetId, range.r2 + 1, range.c2 + 1);
  // The fill passes over rows a filter hides and the cells under a merged cell's top-left one, as the user's own fill
  // does: the count says what was filled, and what was left out is said, or the model takes the column for complete.
  const hiddenRows = wb.sheet(sheetId).filterHidden;
  let filtered = 0, merged = 0;
  for (let r = range.r1; r <= range.r2; r++) {
    if (hiddenRows?.has(r)) { filtered++; continue; }
    for (let c = range.c1; c <= range.c2; c++) if (wb._coveredByMerge?.(sheetId, r, c)) merged++;
  }
  const skipped = filtered * (range.c2 - range.c1 + 1) + merged;
  wb.transaction('AI edit', () => wb.fillInput(sheetId, range, text, { r: range.r1, c: range.c1 }));
  const errors = formulaErrors(wb, sheetId, range);
  const blocked = blockedSpills(wb, sheetId, hit);
  const left = [filtered && `${filtered} row${filtered === 1 ? '' : 's'} hidden by a filter`, merged && `${merged} cell${merged === 1 ? '' : 's'} inside merged cells`].filter(Boolean);
  return {
    filled: qualified(wb, sheetId, range), cells: cells - skipped,
    ...(left.length ? { left_out: `${left.join(' and ')} ${skipped === 1 ? 'was' : 'were'} not filled, as a fill passes over them.` } : {}),
    ...(errors.length ? { formula_errors: errors } : {}), ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}), ...(note ? { note } : {}),
  };
}

function clearRange(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  const what = args.what || 'contents';
  if (!['contents', 'formats', 'all'].includes(what)) throw new ToolError('what must be "contents", "formats" or "all".');
  assertWritable(wb, sheetId, range);
  const before = wb.version;
  wb.transaction('AI edit', () => {
    wb.clearRange(sheetId, range, { contents: what !== 'formats', styles: what !== 'contents' });
    // Conditional formats and merged blocks are formatting too, which Clear Formats and Clear All take off with the
    // rest (see the editor's clearRulesAndMerges): left on, the cleared cells stayed highlighted, or merged.
    const refused = wb.version === before && what === 'all' && filledCells(wb, sheetId, range);
    if (what !== 'contents' && !refused) { clearRules(wb, sheetId, [range]); wb.unmergeCells(sheetId, range); }
  });
  if (wb.version === before && filledCells(wb, sheetId, range)) throw new ToolError(`${qualified(wb, sheetId, range)} could not be cleared (it may cross part of an array formula or a pivot table).`);
  return { cleared: qualified(wb, sheetId, range), what };
}

/* ---------- Copying, moving and replacing ---------- */

const isWholeLines = (range) => range.r2 >= MAX_ROW || range.c2 >= MAX_COL;

/** Whole columns or rows as far as the sheet's content goes, as a copy takes them; null when they hold nothing. */
function usedExtent(wb, sheetId, range) {
  if (!isWholeLines(range)) return range;
  const used = wb.usedRange(sheetId);
  if (!used) return null;
  const r2 = range.r2 >= MAX_ROW ? Math.min(range.r2, used.r2) : range.r2;
  const c2 = range.c2 >= MAX_COL ? Math.min(range.c2, used.c2) : range.c2;
  return r2 < range.r1 || c2 < range.c1 ? null : { ...range, r2, c2 };
}

/** Do the lines a copy of the range takes hold a note (kind "notes") or a comment thread ("comments")? */
function copiesAny(wb, sheetId, range, includeHidden, kind) {
  const map = wb.sheet(sheetId)?.[kind];
  if (!map?.size) return false;
  for (const key of map.keys()) {
    const { r, c } = parseKey(key);
    if (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2) continue;
    if (includeHidden || (!wb.isRowHidden(sheetId, r) && !wb.isHidden(sheetId, 'col', c))) return true;
  }
  return false;
}

const cellsIn = (range) => (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
const overlapping = (a, b) => !(a.r2 < b.r1 || a.r1 > b.r2 || a.c2 < b.c1 || a.c1 > b.c2);
const within = (inner, outer) => inner.r1 >= outer.r1 && inner.r2 <= outer.r2 && inner.c1 >= outer.c1 && inner.c2 <= outer.c2;

/**
 * What a copy of the range carries, as the editor's copy gathers it for a paste in this workbook: the cells (formulas
 * and styles), the values they show, notes, comment threads, merges, conditional formats, validation, sparklines and
 * pivot tables. Hidden and filtered-out lines are left out unless `includeHidden`, as a copy of what is on screen.
 */
function copySnapshot(wb, sheetId, range, includeHidden) {
  const sheet = wb.sheet(sheetId);
  const lines = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const { rows, cols, all } = includeHidden ? { rows: lines(range.r1, range.r2), cols: lines(range.c1, range.c2), all: true } : wb.visibleIndices(sheetId, range);
  if (!rows.length || !cols.length) throw new ToolError(`Every row or column of ${qualified(wb, sheetId, range)} is hidden, so nothing is on show to copy. Set include_hidden to copy them anyway.`);
  const cells = all ? wb.copyRange(sheetId, range, { sameBook: true }) : wb.copyCells(sheetId, rows, cols, { sameBook: true });
  // The values as copied for Paste Values: errors as errors, a picture in a cell as nothing.
  const values = rows.map((r) => cols.map((c) => {
    const v = wb.getValue(sheetId, r, c);
    if (v && typeof v === 'object') return typeof v.error === 'string' ? { error: v.error } : null;
    if (typeof v === 'number' && !Number.isFinite(v)) return { error: '#NUM!' };
    return v ?? null;
  }));
  let notes = sheet.notes.size ? rows.map((r) => cols.map((c) => wb.getNote(sheetId, r, c))) : null;
  if (notes && !notes.some((row) => row.some(Boolean))) notes = null;
  return {
    cells, values, notes, rows, cols, all,
    origin: { r: range.r1, c: range.c1, sheetId, ...(all ? {} : { rows, cols }) },
    merges: copyMergeLayout(sheet.merges, rows, cols).ranges,
    conditionalFormats: wb.copyConditionalFormats(sheetId, rows, cols),
    validations: wb.copyValidations(sheetId, rows, cols),
    nativeSparklines: wb.copyNativeSparklines(sheetId, rows, cols),
    nativePivots: wb.copyNativePivots(sheetId, rows, cols),
    threads: copyThreads(wb, sheetId, rows, cols),
  };
}

/** The workbook's refusals of a paste, in words the model can act on. */
const PASTE_REFUSALS = {
  protected: 'part of the destination is protected',
  'array-edit': 'it would land on part of an array formula, or a copied array formula would not fit there',
  'pivot-edit': 'it would land on part of a pivot table',
  'merge-paste': 'it would land on part of a merged cell',
};

/** Run `fn`, gathering the refusals the workbook announces for this sheet while it runs. */
function collectRefusals(wb, sheetId, fn) {
  const refused = [];
  const hear = ({ detail }) => { if (PASTE_REFUSALS[detail?.type] && (detail.sheetId == null || detail.sheetId === sheetId)) refused.push(detail.type); };
  wb.addEventListener('change', hear);
  try { fn(() => refused.length > 0); } finally { wb.removeEventListener('change', hear); }
  return refused;
}

/** Where a copy lands: the block it fills, how often it repeats, and the range it repeats over (null for once). */
function copyPlacement(wb, args, h, w, env) {
  const dest = resolveRange(wb, args.destination, env.sheetId());
  const transpose = !!args.transpose;
  // A whole column or row as the destination is its first cell: repeated down a million rows, one row would freeze the tab.
  const repeatOver = !transpose && !isWholeLines(dest.range) && cellsIn(dest.range) > 1 ? dest.range : null;
  const reps = transpose ? { rows: 1, cols: 1 } : wb.pasteReps(h, w, repeatOver);
  const H = transpose ? w : h * reps.rows, W = transpose ? h : w * reps.cols;
  const block = { r1: dest.range.r1, c1: dest.range.c1, r2: dest.range.r1 + H - 1, c2: dest.range.c1 + W - 1 };
  const once = repeatOver && reps.rows * reps.cols === 1 && (dest.range.r2 !== block.r2 || dest.range.c2 !== block.c2);
  return { sheetId: dest.sheetId, block, repeatOver, reps, transpose, once };
}

function copyRangeTool(wb, args, env) {
  const what = args.what ?? 'all';
  if (!COPY_WHAT.includes(what)) throw new ToolError(`what must be one of ${COPY_WHAT.join(', ')}.`);
  const { sheetId, range: asked } = resolveRange(wb, args.source, env.sheetId());
  const range = usedExtent(wb, sheetId, asked);
  if (!range) throw new ToolError(`${qualified(wb, sheetId, asked)} holds nothing to copy.`);
  if (cellsIn(range) > MAX_COPY_CELLS) throw new ToolError(`At most ${MAX_COPY_CELLS.toLocaleString('en-US')} cells can be copied at once.`);
  const snap = copySnapshot(wb, sheetId, range, !!args.include_hidden);
  const h = snap.cells.length, w = snap.cells[0].length;
  const at = copyPlacement(wb, args, h, w, env);
  const { sheetId: dstId, block } = at;
  if (cellsIn(block) > MAX_COPY_CELLS) throw new ToolError(`The copy would fill more than ${MAX_COPY_CELLS.toLocaleString('en-US')} cells; copy to a smaller range.`);
  if (!wb.canEnsureSize(dstId, block.r2 + 1, block.c2 + 1)) throw new ToolError('The copy would run past the edge of the sheet.');
  const contents = what !== 'formats';
  // On a protected sheet, values and formulas may go into the cells formatted as unlocked, as typing may; formatting may not.
  if (wb.isProtected(dstId) && (what === 'all' || what === 'formats') && unlockedCells(wb, dstId, block)) {
    throw new ToolError(`${wb.sheet(dstId).name} is protected, so its formatting cannot change. Copy with what "values" or "formulas" to fill its unlocked cells.`);
  }
  assertWritable(wb, dstId, block, { contents: what === 'values' || what === 'formulas' });
  if (contents && wb.arrayEditBlocked(dstId, block)) throw new ToolError(`${qualified(wb, dstId, block)} crosses part of an array formula's result. Copy around it, or clear the array first.`);
  if (!contents && wb.nativePivotOverlap?.(dstId, block)) throw new ToolError(`${qualified(wb, dstId, block)} is part of a pivot table, whose formatting a copy cannot change.`);
  const formulas = what === 'all' || what === 'formulas';
  const reached = formulas && snap.cells.some((row) => row.some((cell) => cell?.f != null && reachesOut(wb, cell.f)));
  const note = reachingNote(env, reached);
  const hit = contents ? spillsHit(wb, dstId, block) : [];
  // Values a merged cell at the destination hides take nothing, as a paste leaves them out (unless the copy brings its own merges).
  let lost = 0;
  if (contents && !(what === 'all' && snap.merges.length)) {
    for (let r = block.r1; r <= block.r2; r++) for (let c = block.c1; c <= block.c2; c++) {
      if (!wb._coveredByMerge(dstId, r, c)) continue;
      const i = at.transpose ? c - block.c1 : (r - block.r1) % h, j = at.transpose ? r - block.r1 : (c - block.c1) % w;
      if (holds(snap.cells[i]?.[j])) lost++;
    }
  }
  const { r1: r, c1: c } = block;
  let pasted = null;
  const refused = collectRefusals(wb, dstId, (wasRefused) => {
    wb.ensureSize(dstId, block.r2 + 1, block.c2 + 1);
    wb.transaction('AI edit', () => {
      if (at.transpose) {
        const sheet = wb.sheet(dstId);
        pasted = composePaste(wb, dstId, snap, r, c, null, { what, transpose: true }, { rows: sheet.rows, cols: sheet.cols })?.pasted;
      } else if (what === 'all') {
        pasted = wb.pasteCells(dstId, snap.cells, r, c, snap.origin, at.repeatOver, {
          notes: snap.notes, merges: snap.merges, conditionalFormats: snap.conditionalFormats, validations: snap.validations,
          nativeSparklines: snap.nativeSparklines, nativePivots: snap.nativePivots,
        });
        if (!wasRefused()) pasteThreads(wb, dstId, snap.threads, r, c);
      } else if (what === 'formulas') {
        pasted = wb.pasteCells(dstId, snap.cells, r, c, snap.origin, at.repeatOver, { keepStyles: true, nativeSparklines: snap.nativeSparklines });
      } else if (what === 'values') {
        wb.pasteLiteralValues(dstId, snap.values, r, c, at.repeatOver);
      } else {
        wb.pasteStyles(dstId, snap.cells, r, c, at.repeatOver, { merges: snap.merges, conditionalFormats: snap.conditionalFormats });
      }
      // Rows or columns pasted beside a table join it, as they do after a paste; formatting alone does not.
      if (contents && !wasRefused() && !snap.nativePivots) wb.extendTableToCover(dstId, block);
    });
  });
  if (refused.length) throw new ToolError(`Nothing was copied: ${PASTE_REFUSALS[refused[0]]}.`);
  const losses = pasted?.mergeLosses ?? lost;
  const hiddenRows = range.r2 - range.r1 + 1 - snap.rows.length, hiddenCols = range.c2 - range.c1 + 1 - snap.cols.length;
  const left = [hiddenRows && `${hiddenRows} hidden row${hiddenRows === 1 ? '' : 's'}`, hiddenCols && `${hiddenCols} hidden column${hiddenCols === 1 ? '' : 's'}`].filter(Boolean);
  const errors = formulas ? formulaErrors(wb, dstId, block) : [];
  const blocked = blockedSpills(wb, dstId, hit);
  return {
    copied: qualified(wb, sheetId, range), to: qualified(wb, dstId, block), what,
    ...(at.transpose ? { transposed: true } : {}),
    ...(at.reps.rows * at.reps.cols > 1 ? { copies: at.reps.rows * at.reps.cols } : {}),
    ...(at.once ? { note_on_destination: `The destination is not a multiple of the source's size, so the copy went in once, at ${cellName(r, c)}.` } : {}),
    ...(left.length ? { left_out: `${left.join(' and ')} of the source ${left.length > 1 || hiddenRows + hiddenCols > 1 ? 'were' : 'was'} not copied. Set include_hidden to copy them.` } : {}),
    ...(losses ? { not_pasted_under_merged_cells: `${losses} value${losses === 1 ? '' : 's'} fell under merged cells at the destination and ${losses === 1 ? 'was' : 'were'} left out.` } : {}),
    ...(errors.length ? { formula_errors: errors } : {}),
    ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}),
    ...(note ? { note } : {}),
  };
}

/** Why a move was refused, as near as the workbook's own checks say. */
function moveProblem(wb, srcId, src, dstId, dst) {
  const source = wb.sheet(srcId), target = wb.sheet(dstId);
  const where = qualified(wb, srcId, src);
  if (wb.arrayEditBlocked(srcId, src, { whole: true }) || wb._splitsSpill?.(source, src)) return `${where} takes part of an array formula's results without the formula, or part of an array. Move the whole array with its formula.`;
  const torn = source.merges.find((m) => overlapping(m, src) && !within(m, src));
  if (torn) return `${where} takes part of the merged cell ${rangeName(torn)}. Include all of it, or unmerge it first.`;
  const landing = target.merges.find((m) => overlapping(m, dst) && !within(m, dst) && !(dstId === srcId && within(m, src)));
  if (landing) return `The cells would land on part of the merged cell ${rangeName(landing)}.`;
  const tornTable = source.tables.find((t) => overlapping(t.range, src) && !within(t.range, src) && !within(src, t.range));
  if (tornTable) return `${where} takes part of the table ${tornTable.name} along with cells outside it. Move the whole table, or only cells inside it.`;
  const moving = source.tables.filter((t) => within(t.range, src));
  const shift = (g) => ({ r1: g.r1 + dst.r1 - src.r1, c1: g.c1 + dst.c1 - src.c1, r2: g.r2 + dst.r1 - src.r1, c2: g.c2 + dst.c1 - src.c1 });
  const struck = moving.length && target.tables.find((o) => (dstId !== srcId || !moving.includes(o)) && moving.some((t) => overlapping(shift(t.range), o.range)));
  if (struck) return `The table the cells carry would land on the table ${struck.name}.`;
  if (wb.pivotMoveEditBlocked?.(srcId, src, dstId, dst)) return 'A pivot table is in the way: a move cannot take part of one, or land on one.';
  return `${where} could not be moved to ${qualified(wb, dstId, dst)}: it would run past the edge of the sheet, or a table, merged cells, a pivot table or an array formula is in the way.`;
}

/**
 * The cells a move takes and where they land. Whole columns or rows move whole within their sheet, their formatting
 * and rules with them; to another sheet the cells go as far as the sheet's content reaches, as a cut and paste takes
 * them. `src` is null when that is nothing.
 */
function movePlacement(wb, args, env) {
  const { sheetId, range: asked } = resolveRange(wb, args.source, env.sheetId());
  const dest = resolveRange(wb, args.destination, env.sheetId());
  const dstId = dest.sheetId;
  const across = dstId !== sheetId;
  const src = across ? usedExtent(wb, sheetId, asked) : asked;
  if (!src) return { sheetId, asked, src: null, dstId, across };
  const whole = isWholeLines(src);
  const r0 = whole && src.r2 >= MAX_ROW ? 0 : dest.range.r1, c0 = whole && src.c2 >= MAX_COL ? 0 : dest.range.c1;
  const dst = { r1: r0, c1: c0, r2: r0 + src.r2 - src.r1, c2: c0 + src.c2 - src.c1 };
  return { sheetId, asked, src, dstId, dst, across, whole };
}

/** Where a copy or a move would land: { sheetId, range } of the block it fills, or null. Throws when it names no place. */
function landing(wb, name, args, env) {
  if (name === 'move_range') {
    const at = movePlacement(wb, args, env);
    return at.src ? { sheetId: at.dstId, range: at.dst } : null;
  }
  const { sheetId, range: asked } = resolveRange(wb, args.source, env.sheetId());
  const range = usedExtent(wb, sheetId, asked);
  if (!range || cellsIn(range) > MAX_COPY_CELLS) return null;
  const shown = args.include_hidden ? { rows: [range.r1], cols: [range.c1] } : wb.visibleIndices(sheetId, range);
  const h = args.include_hidden ? range.r2 - range.r1 + 1 : shown.rows.length, w = args.include_hidden ? range.c2 - range.c1 + 1 : shown.cols.length;
  if (!h || !w) return null;
  const at = copyPlacement(wb, args, h, w, env);
  return { sheetId: at.sheetId, range: at.block };
}

function moveRangeTool(wb, args, env) {
  const { sheetId, asked, src, dstId, dst, across, whole } = movePlacement(wb, args, env);
  if (!src) throw new ToolError(`${qualified(wb, sheetId, asked)} holds nothing to move.`);
  if (!whole && cellsIn(src) > MAX_COPY_CELLS) throw new ToolError(`At most ${MAX_COPY_CELLS.toLocaleString('en-US')} cells can be moved at once.`);
  const { r1: r0, c1: c0 } = dst;
  if (!across && r0 === src.r1 && c0 === src.c1) throw new ToolError(`${qualified(wb, sheetId, src)} is already there.`);
  if (!whole && !wb.canEnsureSize(dstId, dst.r2 + 1, dst.c2 + 1)) throw new ToolError('The cells would run past the edge of the sheet.');
  assertWritable(wb, sheetId, src);
  assertWritable(wb, dstId, dst);
  const hit = whole ? [] : spillsHit(wb, dstId, dst).filter((a) => across || !within({ r1: a.r, c1: a.c, r2: a.r, c2: a.c }, src));
  let done = null;
  wb.transaction('AI edit', () => {
    if (!across) { done = wb.moveRange(sheetId, src, r0, c0); return; }
    wb.ensureSize(dstId, dst.r2 + 1, dst.c2 + 1);
    done = wb.placeMoved(dstId, r0, c0, wb.copyRange(sheetId, src, { sameBook: true }), { sheetId, range: src });
  });
  if (!done) throw new ToolError(moveProblem(wb, sheetId, src, dstId, dst));
  const errors = whole ? [] : formulaErrors(wb, dstId, dst);
  const blocked = blockedSpills(wb, dstId, hit);
  return { moved: qualified(wb, sheetId, src), to: qualified(wb, dstId, dst), ...(errors.length ? { formula_errors: errors } : {}), ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}) };
}

/** Why Replace leaves a match alone, as Find & Replace says it. */
const LEFT_ALONE = {
  protected: 'protected', formula: 'formula results (the text is in what the formula shows, not in the formula)',
  spill: 'values spilled by an array formula', display: 'only in how the number is formatted',
};

/** The sheets and range a find_replace searches. */
function replaceScope(wb, args, env) {
  if (args.range) {
    const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
    return { sheets: [wb.sheet(sheetId)], range, hiddenSheets: [] };
  }
  if (args.all_sheets) {
    const grids = wb.sheets.filter((s) => s.kind !== 'chart');
    return { sheets: grids.filter((s) => !s.hidden), range: null, hiddenSheets: grids.filter((s) => s.hidden) };
  }
  return { sheets: [gridSheet(wb, args.sheet, env.sheetId())], range: null, hiddenSheets: [] };
}

const replaceOptions = (args) => ({ matchCase: !!args.match_case, wholeCell: !!args.whole_cell, formulas: args.in_formulas !== false, regex: !!args.regex });

/** The matching cells of each sheet searched, as Find & Replace finds them. */
function replaceMatches(wb, args, env, budget) {
  const needle = String(args.find ?? '');
  if (!needle) throw new ToolError('Nothing to find.');
  const opts = replaceOptions(args);
  if (opts.regex && !compilePattern(needle, opts)) throw new ToolError(`"${needle}" is not a regular expression that can be searched with (or it nests one repeat inside another, such as (a+)+, which can take too long).`);
  const scope = replaceScope(wb, args, env);
  const found = scope.sheets.map((sheet) => ({ sheet, matches: findAll(wb, sheet.id, needle, { ...opts, range: scope.range, budget }) }));
  return { needle, opts, scope, found };
}

/** How many cells match in the rows and columns a search passes over: hidden ones, and those a filter hides. */
function hiddenMatches(wb, sheet, needle, opts, range) {
  if (!sheet.hiddenRows.size && !sheet.hiddenCols.size && !sheet.filterHidden?.size) return 0;
  let n = 0;
  for (const [key, cell] of sheet.cells) {
    if (cell.v == null && cell.f == null) continue;
    const { r, c } = parseKey(key);
    if (range && (r < range.r1 || r > range.r2 || c < range.c1 || c > range.c2)) continue;
    if (!sheet.hiddenRows.has(r) && !sheet.filterHidden?.has(r) && !sheet.hiddenCols.has(c)) continue;
    const hiddenFormula = cell.f != null && wb.formulaHiddenAt(sheet.id, r, c);
    if (cellMatches(cell, formatValue(wb.getValue(sheet.id, r, c), cell.s), needle, hiddenFormula ? { ...opts, formulas: false } : opts)) n++;
  }
  return n;
}

/**
 * Does the replacement leave one of these cells holding a formula that reaches outside the workbook? One that reached
 * out before counts too, as a formula written in its place does: rewritten, it may fetch from another address, or
 * send other cells there.
 */
function replacementReaches(wb, sheetId, matches, needle, replacement, opts) {
  for (const { r, c } of matches) {
    const cell = wb.getCell(sheetId, r, c);
    if (!cell || (cell.v == null && cell.f == null)) continue;
    // A formula Replace leaves alone (formulas left out, or hidden on a protected sheet) is not rewritten.
    if (cell.f != null && (opts.formulas === false || wb.formulaHiddenAt(sheetId, r, c))) continue;
    // Text that would read as a formula keeps its apostrophe through a replace (see replaceCells), and stays text.
    const isText = cell.f == null && typeof cell.v === 'string';
    if (isText && editText(cell).startsWith("'")) continue;
    const display = formatValue(wb.getValue(sheetId, r, c), cell.s);
    for (const source of [isText ? cell.v : editText(cell), display]) {
      const next = replaceInText(source, needle, replacement, opts);
      if (next != null && /^\s*=/.test(next) && reachesOut(wb, next.replace(/^\s*=/, ''))) return true;
    }
  }
  return false;
}

function findReplace(wb, args, env) {
  if (args.replace == null) throw new ToolError('Give the replacement text in replace, or "" to remove the text found.');
  const replacement = String(args.replace);
  const budget = searchBudget(args.regex ? 1000 : 3000);
  const { needle, opts, scope, found } = replaceMatches(wb, args, env, budget);
  const hidden = [];
  for (const { sheet } of found) { const n = hiddenMatches(wb, sheet, needle, opts, scope.range); if (n) hidden.push(`${n} in hidden rows or columns of ${quoteSheet(sheet.name)}`); }
  for (const sheet of scope.hiddenSheets) { const n = findAll(wb, sheet.id, needle, opts).length; if (n) hidden.push(`${n} on the hidden sheet ${quoteSheet(sheet.name)}`); }
  const total = found.reduce((n, f) => n + f.matches.length, 0);
  const notes = [
    ...(hidden.length ? [`Matches left alone because they are hidden: ${hidden.join('; ')}.`] : []),
    ...(budget.exceeded ? ['The search ran out of time before it reached every cell, so more matches may remain.'] : []),
  ];
  if (!total) return { replaced: 0, note: ['No cells match.', ...notes].join(' ') };
  const reached = found.some(({ sheet, matches }) => replacementReaches(wb, sheet.id, matches, needle, replacement, opts));
  const distrusted = reachingNote(env, reached);
  // What each matched cell holds now, to say afterwards which ones the replacement changed.
  const before = found.map(({ sheet, matches }) => matches.map(({ r, c }) => wb.getCell(sheet.id, r, c)));
  const skipped = [];
  let n = 0;
  wb.transaction('AI edit', () => {
    for (const { sheet, matches } of found) if (matches.length) n += replaceCells(wb, sheet.id, matches, needle, replacement, { ...opts, skipped });
  });
  const changed = [];
  found.forEach(({ sheet, matches }, k) => matches.forEach(({ r, c }, i) => {
    if (wb.getCell(sheet.id, r, c) !== before[k][i]) changed.push(qualified(wb, sheet.id, { r1: r, c1: c, r2: r, c2: c }));
  }));
  const counts = new Map();
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) || 0) + 1);
  const alone = [...counts].map(([reason, k]) => `${k} ${LEFT_ALONE[reason] || reason}`);
  if (!n && alone.length) throw new ToolError(`Nothing was replaced: the ${total} match${total === 1 ? '' : 'es'} could not be changed (${alone.join('; ')}).${notes.length ? ` ${notes.join(' ')}` : ''}`);
  const errors = [];
  for (const { sheet, matches } of found) {
    for (const { r, c } of matches) {
      if (errors.length >= 8) break;
      if (wb.getCell(sheet.id, r, c)?.f == null) continue;
      const shown = formulaErrors(wb, sheet.id, { r1: r, c1: c, r2: r, c2: c }, 1);
      if (shown.length) errors.push(`${quoteSheet(sheet.name)}!${shown[0]}`);
    }
  }
  return {
    replaced: n,
    cells: changed.slice(0, 20),
    ...(changed.length > 20 ? { more: `and ${changed.length - 20} more` } : {}),
    ...(alone.length ? { left_alone: alone.join('; ') } : {}),
    ...(errors.length ? { formula_errors: errors } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
    ...(distrusted ? { blocked_note: distrusted } : {}),
  };
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
  // Cells past the sheet's present size are formatted as written cells are: the sheet grows to them (a new sheet's 100
  // rows formatted B95:B105 as far as B100 alone, and A150 not at all). Whole lines are formatted as lines, below.
  if (!lineScope(range)) {
    if (!wb.canEnsureSize(sheetId, range.r2 + 1, range.c2 + 1)) throw new ToolError('The range runs past the edge of the sheet.');
    wb.ensureSize(sheetId, range.r2 + 1, range.c2 + 1);
  }
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

/* ---------- Filters ---------- */

/** The rows a filter judges: those under its header, as far as the sheet goes. */
function filterDataRows(wb, sheetId, range) {
  return { r1: range.r1 + 1, r2: Math.min(range.r2, wb.sheet(sheetId).rows - 1) };
}

/** How many of a filter's rows show, and how many it judges. */
function filterShown(wb, sheetId, range) {
  const { r1, r2 } = filterDataRows(wb, sheetId, range);
  const hidden = wb.sheet(sheetId).filterHidden;
  let shown = 0;
  for (let r = r1; r <= r2; r++) if (!hidden.has(r)) shown++;
  return { shown, rows: Math.max(0, r2 - r1 + 1) };
}
const shownCounts = (wb, sheetId, range) => { const { shown, rows } = filterShown(wb, sheetId, range); return { rows_shown: shown, data_rows: rows }; };

/** A column of a filter, by letter or by its header's text. */
function filterColumn(wb, sheetId, range, text) {
  const t = String(text ?? '').trim();
  const c = colIndex(t.replace(/\$/g, ''));
  if (c >= range.c1 && c <= range.c2) return c;
  for (let col = range.c1; col <= range.c2; col++) if (wb.getDisplay(sheetId, range.r1, col).trim().toLowerCase() === t.toLowerCase() && t) return col;
  const headers = [];
  for (let col = range.c1; col <= range.c2 && headers.length < 30; col++) headers.push(`${colName(col)} "${clip(wb.getDisplay(sheetId, range.r1, col), 40)}"`);
  throw new ToolError(`"${t}" is not a column of the filter over ${rangeName(range)}. Its columns are ${headers.join(', ')}.`);
}

const NUMERIC_FILTERS = new Set(['gt', 'gte', 'lt', 'lte', 'between']);

/** A condition's number (a date as "YYYY-MM-DD" too), read as the filter menu reads what is typed; null when it is none. */
function filterNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const parsed = parseInput(String(v).trim());
  return parsed.f == null && typeof parsed.v === 'number' ? parsed.v : null;
}

/**
 * The criterion for one column, as the filter menu stores it: a value list matched to the texts the column shows,
 * a condition, a formula, or a top N / average kept as Excel writes it. Null clears the column. `missing` collects
 * the values asked for that no row shows.
 */
function filterCriterion(wb, sheetId, range, col, spec, missing) {
  const sheet = wb.sheet(sheetId);
  const header = wb.getDisplay(sheetId, range.r1, col) || colName(col);
  if (Array.isArray(spec.values) && spec.condition) throw new ToolError(`Give either values or a condition for column ${colName(col)}, not both.`);
  if (Array.isArray(spec.values)) {
    if (!spec.values.length) throw new ToolError(`values for column ${colName(col)} is empty; leave it out to clear the column's criteria.`);
    // The texts the column shows, by their folded spelling and by the number behind them.
    const byText = new Map(), byNumber = new Map();
    const { r1, r2 } = filterDataRows(wb, sheetId, range);
    for (let r = r1; r <= r2; r++) {
      const text = wb.getDisplay(sheetId, r, col);
      const key = text.toLowerCase();
      if (!byText.has(key)) byText.set(key, new Set());
      byText.get(key).add(text);
      const v = wb.getValue(sheetId, r, col);
      if (typeof v === 'number' && Number.isFinite(v)) { if (!byNumber.has(v)) byNumber.set(v, new Set()); byNumber.get(v).add(text); }
    }
    const kept = new Set();
    for (const given of spec.values) {
      const text = given == null ? '' : typeof given === 'boolean' ? (given ? 'TRUE' : 'FALSE') : String(given);
      let found = byText.get(text.toLowerCase());
      if (!found && text !== '') { const n = filterNumber(given); if (n != null) found = byNumber.get(n); }
      if (found) for (const t of found) kept.add(t);
      else missing.push(`${header}: ${text === '' ? '(blanks)' : `"${clip(text, 60)}"`}`);
    }
    if (!kept.size) {
      const shown = [...byText.values()].map((s) => [...s][0]).filter((t) => t !== '').slice(0, 20).map((t) => `"${clip(t, 40)}"`);
      throw new ToolError(`No row of column ${colName(col)} ("${header}") shows ${spec.values.length === 1 ? 'that value' : 'any of those values'}. Values are matched as the cells show them; some it holds: ${shown.join(', ') || 'none'}.`);
    }
    return wb._filterValueKeys(sheet, col, { values: [...kept] }, { range });
  }
  const op = spec.condition;
  if (op == null || op === '') return null;
  if (!FILTER_CONDITIONS.includes(op)) throw new ToolError(`condition must be one of ${FILTER_CONDITIONS.join(', ')}.`);
  if (op === 'empty' || op === 'notEmpty') return { op };
  if (op === 'above_average' || op === 'below_average') return { native: `<dynamicFilter type="${op === 'above_average' ? 'aboveAverage' : 'belowAverage'}"/>` };
  if (op === 'top' || op === 'bottom') {
    const n = spec.value == null || spec.value === '' ? 10 : Number(spec.value);
    if (!Number.isInteger(n) || n < 1 || n > (spec.percent ? 100 : 500)) throw new ToolError(`For ${op}, value is how many rows to keep: a whole number from 1 to ${spec.percent ? '100 (percent)' : 500}.`);
    return { native: `<top10${op === 'bottom' ? ' top="0"' : ''}${spec.percent ? ' percent="1"' : ''} val="${n}"/>` };
  }
  if (op === 'formula') {
    const f = String(spec.value ?? '').trim();
    if (!f) throw new ToolError(`A formula condition needs its formula in value, written for the first data row, e.g. "=${colName(col)}${range.r1 + 2}>100".`);
    const body = f.replace(/^=/, '');
    try { parseFormula(body); } catch (e) { throw new ToolError(`The formula could not be read: ${e?.message || 'syntax error'}.`); }
    if (reachesOut(wb, body)) throw new ToolError('A filter\'s formula cannot reach outside the workbook.');
    return { formula: `=${body}` };
  }
  if (spec.value == null || spec.value === '') throw new ToolError(`The "${op}" condition needs a value.`);
  if (NUMERIC_FILTERS.has(op)) {
    const value = filterNumber(spec.value);
    const value2 = op === 'between' ? filterNumber(spec.value2) : undefined;
    if (value == null || (op === 'between' && value2 == null)) throw new ToolError(`The "${op}" condition needs ${op === 'between' ? 'two numbers, value and value2' : 'a number'} (a date as "YYYY-MM-DD").`);
    return { op, value, ...(op === 'between' ? { value2 } : {}) };
  }
  // Equal and not equal take the number when the value reads as one, as the menu does; the text conditions the text.
  if (op === 'eq' || op === 'neq') { const n = filterNumber(spec.value); return { op, value: n ?? String(spec.value) }; }
  return { op, value: String(spec.value) };
}

/** One column's criterion in words, for the model and the chat. */
function criterionText(crit) {
  const q = (v) => (v === '' ? '(blanks)' : typeof v === 'number' ? String(v) : `"${clip(String(v), 40)}"`);
  if (Array.isArray(crit.values)) return `one of ${crit.values.slice(0, 8).map(q).join(', ')}${crit.values.length > 8 ? ` and ${crit.values.length - 8} more` : ''}`;
  if (crit.op) {
    const ops = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', neq: '<>' };
    if (ops[crit.op]) return `${ops[crit.op]} ${q(crit.value)}`;
    if (crit.op === 'between') return `between ${q(crit.value)} and ${q(crit.value2)}`;
    if (crit.op === 'empty' || crit.op === 'notEmpty') return crit.op === 'empty' ? 'blank' : 'not blank';
    return `${{ contains: 'contains', notContains: 'does not contain', beginsWith: 'begins with', endsWith: 'ends with' }[crit.op] || crit.op} ${q(crit.value)}`;
  }
  if (crit.formula) return `formula ${crit.formula}`;
  if (crit.color != null) return crit.color ? `fill ${crit.color}` : 'no fill';
  if (crit.text != null) return `contains ${q(crit.text)}`;
  if (typeof crit.native === 'string') {
    const top = crit.native.match(/^<top10\b([^>]*)>/);
    if (top) return `${/\btop="(0|false)"/.test(top[1]) ? 'bottom' : 'top'} ${top[1].match(/\bval="([^"]*)"/)?.[1] ?? 10}${/\bpercent="(1|true)"/.test(top[1]) ? '%' : ''}`;
    const dyn = crit.native.match(/^<dynamicFilter\b[^>]*\btype="([^"]*)"/);
    if (dyn) return dyn[1] === 'aboveAverage' ? 'above average' : dyn[1] === 'belowAverage' ? 'below average' : `dynamic filter ${dyn[1]}`;
    return 'a condition kept from the file';
  }
  return 'a criterion';
}

/** The filters on a sheet, as the model is told of them: range, table, criteria by column, rows shown. */
export function filterSummaries(wb, sheetId) {
  const sheet = wb.sheet(sheetId);
  if (!sheet || sheet.kind === 'chart') return [];
  return sheetFilters(sheet).map((f) => {
    const table = filterTable(sheet, f);
    const { shown, rows } = filterShown(wb, sheetId, f.range);
    const criteria = Object.keys(f.criteria).map(Number).sort((a, b) => a - b)
      .map((c) => `${colName(c)} ("${clip(wb.getDisplay(sheetId, f.range.r1, c), 40)}"): ${criterionText(f.criteria[c])}`);
    return { range: rangeName(f.range), ...(table ? { table: table.name } : {}), criteria, rows_shown: `${shown} of ${rows}` };
  });
}

/**
 * The filter a call is about: the one over the list's first cell, or its table's, with the range a new one would
 * take. Whole columns mean their data; a single cell the block of data around it, as Data ▸ Filter takes them.
 */
function filterTarget(wb, sheetId, asked) {
  const sheet = wb.sheet(sheetId);
  const whole = asked.r2 >= MAX_ROW || asked.c2 >= MAX_COL;
  const area = whole ? dataOfLines(wb, sheetId, asked) : asked;
  const at = area || asked;
  const filter = wb.filterAt(sheetId, at.r1, at.c1);
  const table = (filter && filterTable(sheet, filter)) || wb.tableAt?.(sheetId, at.r1, at.c1) || null;
  if (table) {
    if (table.headerRow === false) throw new ToolError(`The table ${table.name} has no header row, so it cannot be filtered. The user can turn on its Header Row from Table Design.`);
    const range = { r1: table.range.r1, c1: table.range.c1, r2: tableRows(table).dataEnd, c2: table.range.c2 };
    return { filter: sheetFilters(sheet).find((f) => filterTable(sheet, f)?.id === table.id) || null, table, range };
  }
  if (filter) return { filter, table: null, range: filter.range };
  const single = asked.r1 === asked.r2 && asked.c1 === asked.c2;
  const range = single ? wb.dataRegion(sheetId, asked.r1, asked.c1) : area;
  if (!range) throw new ToolError(`${qualified(wb, sheetId, asked)} holds no data to filter.`);
  if (range.r1 >= range.r2) throw new ToolError(`${qualified(wb, sheetId, range)} needs a header row and at least one row under it to be filtered.`);
  const crossed = (sheet.tables || []).find((t) => t.range.r1 <= range.r2 && t.range.r2 >= range.r1 && t.range.c1 <= range.c2 && t.range.c2 >= range.c1);
  if (crossed) throw new ToolError(`${qualified(wb, sheetId, range)} crosses the table ${crossed.name}. Filter the table by its name, or a range clear of it.`);
  return { filter: null, table: null, range };
}

function filterRange(wb, args, env) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, env.sheetId());
  const sheet = wb.sheet(sheetId);
  assertWritable(wb, sheetId, null);
  const action = args.action || 'apply';
  if (!['apply', 'clear', 'remove'].includes(action)) throw new ToolError('action must be "apply", "clear" or "remove".');
  const { filter, table, range } = filterTarget(wb, sheetId, asked);
  const where = qualified(wb, sheetId, range);
  if (action !== 'apply') {
    if (!filter) throw new ToolError(`There is no filter on ${where} to ${action}.`);
    if (action === 'clear') {
      if (Object.keys(filter.criteria).length) wb._setFilter(sheet, { ...filter, criteria: {} }, 'AI edit', { target: filter });
      return { cleared: where, ...shownCounts(wb, sheetId, range) };
    }
    // A table keeps its filter with the buttons hidden, as Data ▸ Filter leaves it: removed outright, its slicers would go too.
    if (table) {
      if (!Object.keys(filter.criteria).length && !tableFilterButtonOn(wb, sheetId, table)) throw new ToolError(`The filter on ${table.name} is already off.`);
      wb.transaction('AI edit', () => {
        if (Object.keys(filter.criteria).length) wb._setFilter(sheet, { ...filter, criteria: {} }, 'AI edit', { target: filter });
        const live = sheetFilters(wb.sheet(sheetId)).find((f) => filterTable(sheet, f)?.id === table.id);
        if (live && live.showButtons !== false) wb._setFilter(sheet, { ...live, showButtons: false }, 'AI edit', { target: live });
      });
    } else wb._setFilter(sheet, null, 'AI edit', { target: filter });
    return { removed: `the filter on ${where}`, rows_shown: 'all' };
  }
  const specs = Array.isArray(args.columns) ? args.columns : [];
  if (!specs.length && filter) throw new ToolError(`${where} already has a filter. Give columns with criteria, or use action "clear" or "remove".`);
  const criteria = filter && !args.clear_others ? { ...filter.criteria } : {};
  const missing = [];
  const seen = new Set();
  for (const spec of specs) {
    const col = filterColumn(wb, sheetId, range, spec?.column);
    if (seen.has(col)) throw new ToolError(`Column ${colName(col)} is listed twice.`);
    seen.add(col);
    const crit = filterCriterion(wb, sheetId, range, col, spec || {}, missing);
    if (crit) criteria[col] = crit; else delete criteria[col];
  }
  // A table's own filter is filtered in place; a list without one gets the sheet's filter, which takes the place of
  // any other one on the sheet (a sheet has one besides its tables' own), as Data ▸ Filter does.
  const next = { ...(filter || { range }), range: { ...range }, criteria };
  // A table whose filter buttons are hidden (Table Design ▸ Filter Button off, or the filter removed) has its filter off:
  // filtering it shows them again, as Data ▸ Filter does, or rows went missing with nothing in the header to say why.
  if (table && filter && Object.keys(criteria).length && !tableFilterButtonOn(wb, sheetId, table)) { delete next.showButtons; delete next.hiddenButtons; }
  const replaced = !filter && !table ? sheetFilters(sheet).find((f) => !filterTable(sheet, f)) : null;
  wb._setFilter(sheet, next, 'AI edit', filter ? { target: filter } : { create: true });
  const after = sheetFilters(wb.sheet(sheetId)).find((f) => sameFilterRange(f, next));
  if (!after) throw new ToolError(`The filter on ${where} could not be set.`);
  return {
    filtered: where, ...(table ? { table: table.name } : {}),
    criteria: Object.keys(after.criteria).map(Number).sort((a, b) => a - b).map((c) => `${colName(c)} ("${clip(wb.getDisplay(sheetId, range.r1, c), 40)}"): ${criterionText(after.criteria[c])}`),
    ...shownCounts(wb, sheetId, range),
    ...(replaced ? { note: `The filter that was on ${qualified(wb, sheetId, replaced.range)} was removed: a sheet has one filter besides its tables' own.` } : {}),
    ...(missing.length ? { values_not_found: missing.slice(0, 20) } : {}),
  };
}

/* ---------- Pivot tables ---------- */

/** The list a pivot summarizes: a range, whole columns as their data, or a single cell as the block of data around it. */
function pivotSource(wb, text, sheetId) {
  const { sheetId: s, range: asked } = resolveRange(wb, text, sheetId);
  const single = asked.r1 === asked.r2 && asked.c1 === asked.c2;
  const range = single ? wb.dataRegion(s, asked.r1, asked.c1) : asked.r2 >= MAX_ROW || asked.c2 >= MAX_COL ? dataOfLines(wb, s, asked) : asked;
  if (!range) throw new ToolError(`${qualified(wb, s, asked)} holds no data to summarize.`);
  return { sheetId: s, range };
}

/** A field of the source by its header (any case) or its column letter, as its offset in the range. */
function pivotField(fields, range, text, what) {
  if (text == null || text === '') return null;
  const t = String(text).trim();
  const byLabel = fields.find((f) => f.label.trim().toLowerCase() === t.toLowerCase());
  if (byLabel) return byLabel.index;
  const c = colIndex(t.replace(/\$/g, ''));
  if (c >= range.c1 && c <= range.c2) return c - range.c1;
  throw new ToolError(`"${t}" (${what}) is not a field of ${rangeName(range)}. Its fields are ${fields.slice(0, 40).map((f) => `"${clip(f.label, 40)}"`).join(', ')}.`);
}

/**
 * The spec the PivotTable dialog builds from its choices, checked as the dialog checks them, and the destination:
 * { spec, fields, source, dest: { sheetId, at } | null }.
 */
function pivotPlan(wb, args, env) {
  const source = pivotSource(wb, args.data_range, env.sheetId());
  const problem = pivotRangeProblem(wb, source.sheetId, source.range);
  if (problem) throw new ToolError(`${qualified(wb, source.sheetId, source.range)} cannot be summarized: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}.`);
  const fields = pivotFields(wb, source.sheetId, source.range);
  const rowField = pivotField(fields, source.range, args.rows, 'rows');
  const valueField = pivotField(fields, source.range, args.values, 'values');
  if (rowField == null || valueField == null) throw new ToolError('Give the field for the rows and the field to summarize.');
  const colField = pivotField(fields, source.range, args.columns, 'columns');
  const filterField = pivotField(fields, source.range, args.filter, 'filter');
  if (colField != null && colField === rowField) throw new ToolError('The rows and columns must be different fields.');
  if (filterField != null && (filterField === rowField || filterField === colField)) throw new ToolError('The filter must be a field other than the rows and columns.');
  const agg = args.summarize || 'sum';
  if (!PIVOT_AGGS.some(([k]) => k === agg)) throw new ToolError(`summarize must be one of ${PIVOT_AGGS.map(([k]) => k).join(', ')}.`);
  // A sum of a field that holds no number is a table of zeros: said, so the model counts it instead.
  if (agg !== 'count') {
    const col = source.range.c1 + valueField;
    let numbers = false;
    for (let r = source.range.r1 + 1, last = Math.min(source.range.r2, wb.usedRange(source.sheetId)?.r2 ?? source.range.r2); r <= last && !numbers; r++) numbers = typeof wb.getValue(source.sheetId, r, col) === 'number';
    if (!numbers) throw new ToolError(`"${fields[valueField].label}" holds no numbers to ${agg === 'sum' ? 'add up' : `take the ${agg} of`}. Use summarize "count" to count its rows.`);
  }
  if (filterField == null && args.filter_value != null && args.filter_value !== '') throw new ToolError('filter_value needs a filter field to pick it from.');
  const filters = [];
  if (filterField != null) {
    let value = null;
    if (args.filter_value != null && args.filter_value !== '') {
      const values = pivotFieldValues(wb, source.sheetId, source.range, filterField);
      const given = args.filter_value;
      const n = typeof given === 'number' ? given : filterNumber(given);
      value = values.find((v) => (typeof v === 'string' ? v.toLowerCase() === String(given).toLowerCase() : v === given || (n != null && v === n)));
      if (value === undefined) throw new ToolError(`"${fields[filterField].label}" has no value ${JSON.stringify(given)}. Some it has: ${values.slice(0, 20).map((v) => JSON.stringify(v)).join(', ')}.`);
    }
    filters.push({ field: filterField, value });
  }
  const spec = { range: source.range, rowField, colField, valueField, agg, filters };
  let dest = null;
  if (args.destination) {
    const found = resolveRange(wb, args.destination, env.sheetId());
    dest = { sheetId: found.sheetId, at: { r: found.range.r1, c: found.range.c1 } };
  }
  return { spec, fields, source, dest };
}

/** The block a pivot of `built` takes at a destination, and why it cannot go there (or null). */
function pivotDestinationProblem(wb, source, dest, built) {
  const area = { r1: dest.at.r, c1: dest.at.c, r2: dest.at.r + built.rows - 1, c2: dest.at.c + built.cols - 1 };
  const where = qualified(wb, dest.sheetId, area);
  const sheet = wb.sheet(dest.sheetId);
  if (!wb.canEnsureSize(dest.sheetId, area.r2 + 1, area.c2 + 1)) return { area, problem: `The pivot table needs ${where}, which runs past the edge of the sheet.` };
  if (hasPivotDefinition(wb, dest.sheetId)) return { area, problem: `${quoteSheet(sheet.name)} already holds a pivot table built here, and a sheet keeps one for Refresh. Put this one on a new sheet (leave out destination) or on another sheet.` };
  const s = source.range;
  if (source.sheetId === dest.sheetId && s.r1 <= area.r2 && s.r2 >= area.r1 && s.c1 <= area.c2 && s.c2 >= area.c1) return { area, problem: `The pivot table would take ${where}, over its own data. Put it beside the data or on a new sheet.` };
  const table = (sheet.tables || []).find((t) => t.range.r1 <= area.r2 && t.range.r2 >= area.r1 && t.range.c1 <= area.c2 && t.range.c2 >= area.c1);
  if (table) return { area, problem: `The pivot table would take ${where}, which crosses the table ${table.name}.` };
  if (wb.mergesIn(dest.sheetId, area).length) return { area, problem: `The pivot table would take ${where}, which holds merged cells.` };
  if (wb.arrayEditBlocked(dest.sheetId, area) || wb.nativePivotOverlap?.(dest.sheetId, area)) return { area, problem: `The pivot table would take ${where}, which crosses an array formula's results or another pivot table.` };
  return { area, problem: null };
}

function createPivotTable(wb, args, env) {
  const { spec, fields, source, dest } = pivotPlan(wb, args, env);
  if (dest) assertWritable(wb, dest.sheetId, null);
  else if (wb.structureProtected) throw new ToolError('The workbook\'s structure is protected, so no sheet can be added for the pivot table. Give a destination cell on an existing sheet, or the user can turn this off with Review ▸ Protect Workbook.');
  const name = args.new_sheet_name ? String(args.new_sheet_name).trim() : null;
  if (dest && name) throw new ToolError('Give either a destination or a new_sheet_name, not both.');
  if (name) { const problem = wb.validateSheetName(name); if (problem) throw new ToolError(`"${name}" cannot name a sheet: ${problem}`); }
  let built;
  try { built = buildPivot(wb, source.sheetId, spec); } catch (e) { if (e instanceof PivotSizeError) throw new ToolError(e.message); throw e; }
  if (!built.rowCount) throw new ToolError(`"${fields[spec.rowField].label}" has no values to group the rows by.`);
  let sheetId, area;
  if (dest) {
    const checked = pivotDestinationProblem(wb, source, dest, built);
    if (checked.problem) throw new ToolError(checked.problem);
    assertWritable(wb, dest.sheetId, checked.area);
    sheetId = dest.sheetId;
    area = writePivotAt(wb, source.sheetId, built, sheetId, dest.at, { label: 'AI edit' });
  } else {
    const sheet = writePivotSheet(wb, source.sheetId, built, { name, label: 'AI edit' });
    if (!sheet) throw new ToolError('No sheet could be added for the pivot table.');
    sheetId = sheet.id;
    area = { r1: 0, c1: 0, r2: built.rows - 1, c2: built.cols - 1 };
  }
  const label = (i) => fields[i].label;
  const aggLabel = PIVOT_AGGS.find(([k]) => k === spec.agg)[1];
  const filterAt = built.filterCells[0];
  return {
    pivot_table: qualified(wb, sheetId, area),
    ...(dest ? {} : { new_sheet: wb.sheet(sheetId).name }),
    summarizes: `${aggLabel} of ${label(spec.valueField)} by ${label(spec.rowField)}${spec.colField != null ? ` and ${label(spec.colField)}` : ''}`,
    row_labels: built.rowCount, ...(spec.colField != null ? { column_labels: built.colCount } : {}),
    ...(filterAt ? { filter: `${label(spec.filters[0].field)}: the cell ${qualified(wb, sheetId, { r1: area.r1 + filterAt.r, c1: area.c1 + filterAt.c, r2: area.r1 + filterAt.r, c2: area.c1 + filterAt.c })} picks the value (now ${JSON.stringify(wb.getValue(sheetId, area.r1 + filterAt.r, area.c1 + filterAt.c))}).` } : {}),
    note: 'The totals are live formulas over the source; new categories in the source appear after the user refreshes the pivot table.',
  };
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
  return { chart: `${type} chart of ${qualified(wb, sheetId, data)}`, id, placed_at: cellName(anchor.r, anchor.c) };
}

/** The chart a call names: by its id, or by a title or name no other chart shares. With the sheet it is on. */
function chartNamed(wb, text) {
  const t = String(text ?? '').trim();
  if (!t) throw new ToolError('Name the chart by the id get_sheet_details gives it.');
  const all = wb.sheets.flatMap((sheet) => chartsOf(sheet).map((chart) => ({ sheet, chart })));
  const byId = all.find(({ chart }) => chart.id === t);
  if (byId) return byId;
  const fold = t.toLocaleLowerCase();
  const named = all.filter(({ chart }) => [chart.name, chart.title].some((n) => typeof n === 'string' && n.trim().toLocaleLowerCase() === fold));
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new ToolError(`${named.length} charts are called "${t}"; give the id of the one you mean (get_sheet_details lists them).`);
  const listed = all.slice(0, 12).map(({ sheet, chart }) => `${chart.id} (${chart.type}${chart.title ? ` "${clip(chart.title, 40)}"` : ''} on ${sheet.name})`);
  throw new ToolError(`There is no chart "${t}". ${all.length ? `The charts are: ${listed.join(', ')}${all.length > 12 ? ', …' : ''}.` : 'The workbook has no charts.'}`);
}

const STACKABLE = new Set(['column', 'bar', 'line', 'area']);
// The Change Chart Type subtype a type (and stacking) means, so a type change keeps what both types share as the
// dialog does. A type missing here is a subtype of its own name.
const SUBTYPES = {
  column: (stacked) => (stacked ? 'columnStacked' : 'columnClustered'),
  bar: (stacked) => (stacked ? 'barStacked' : 'barClustered'),
  area: (stacked) => (stacked ? 'areaStacked' : 'area'),
  line: (stacked, markers) => `line${stacked ? 'Stacked' : ''}${markers ? 'Markers' : ''}`,
  donut: () => 'doughnut', combo: () => 'comboColumnLine', stock: () => 'stockHlc', surface: () => 'surface3d',
};

/** The theme's body font, which a chart's text takes when it changes type (as the editor's Change Chart Type). */
function themeChartFont(wb) {
  const name = effectiveFontTheme(wb.fontTheme)?.minor?.latin?.typeface || 'Calibri';
  return fontKeyFor(name, { literal: true }) || 'calibri';
}

function updateChart(wb, args, env) {
  const { sheet, chart } = chartNamed(wb, args.chart);
  assertWritable(wb, sheet.id, null);
  const patch = {};
  const changes = [];
  const kept = [];
  if (args.type != null || args.stacked != null) {
    const type = String(args.type ?? chart.type);
    if (!CHART_TYPES.some(([t]) => t === type)) throw new ToolError(`type must be one of ${CHART_TYPES.map(([t]) => t).join(', ')}.`);
    if (args.stacked && !STACKABLE.has(type)) throw new ToolError(`A ${type} chart cannot be stacked; only column, bar, line and area charts can.`);
    const stacked = args.stacked ?? (type === chart.type ? !!chart.stacked : false);
    const now = subtypeOf(chart);
    const markers = chart.type === 'line' ? /Markers$/.test(now || '') : true;
    const subtype = (SUBTYPES[type] || (() => type))(stacked, markers);
    // Stacked to 100% stays so while only the type changes between charts that stack.
    const same = subtype === now || (type === chart.type && args.stacked == null);
    if (same) kept.push(`It is already a ${stacked && STACKABLE.has(type) ? 'stacked ' : ''}${type} chart.`);
    else {
      const typed = chartSubtype(subtype) ? changeSubtypePatch(chart, subtype, { font: themeChartFont(wb) }) : { type, stacked };
      if (!typed) throw new ToolError(`The chart could not be made a ${type} chart.`);
      Object.assign(patch, typed);
      changes.push(stacked && STACKABLE.has(type) ? `type: stacked ${type}` : `type: ${type}`);
    }
  }
  if (args.data_range != null) {
    if (sheet.kind === 'chart') throw new ToolError(`The chart on the chart sheet "${sheet.name}" reads its series from references of its own; the user can change them with Select Data.`);
    const { sheetId, range } = resolveRange(wb, args.data_range, sheet.id);
    if (sheetId !== sheet.id) throw new ToolError(`The chart is on ${sheet.name}; its data must be on that sheet too.`);
    const data = dataOfLines(wb, sheetId, range);
    if (!data) throw new ToolError(`${qualified(wb, sheetId, range)} holds no data to chart.`);
    // As Select Data takes a plain range: the series' own references, if it had any, give way to it.
    Object.assign(patch, { range: data, sourceRefs: undefined });
    changes.push(`data: ${rangeName(data)}`);
  }
  if (args.series_in != null) {
    if (!['columns', 'rows', 'auto'].includes(args.series_in)) throw new ToolError('series_in must be columns, rows or auto.');
    patch.seriesIn = args.series_in === 'columns' ? 'cols' : args.series_in;
    changes.push(`series in ${args.series_in}`);
  }
  // A title typed here replaces one linked to a cell, as typing it in the chart does.
  if (args.title != null) { patch.title = cutText(String(args.title), 200); patch.titleRef = undefined; changes.push('title'); }
  if (args.x_title != null) { patch.xTitle = cutText(String(args.x_title), 80); patch.xTitleRef = undefined; changes.push('horizontal axis title'); }
  if (args.y_title != null) { patch.yTitle = cutText(String(args.y_title), 80); patch.yTitleRef = undefined; changes.push('vertical axis title'); }
  if (args.legend != null) {
    if (!['bottom', 'top', 'right', 'none'].includes(args.legend)) throw new ToolError('legend must be bottom, top, right or none.');
    Object.assign(patch, args.legend === 'none' ? { legend: false } : { legend: true, legendPos: args.legend });
    changes.push(`legend ${args.legend}`);
  }
  if (args.anchor_cell != null) {
    if (sheet.kind === 'chart') throw new ToolError('A chart sheet\'s chart fills its sheet; it has no cell to move to.');
    const at = resolveRange(wb, args.anchor_cell, sheet.id);
    if (at.sheetId !== sheet.id) throw new ToolError(`The chart is on ${sheet.name}; it can only move within that sheet.`);
    Object.assign(patch, { anchor: { r: at.range.r1, c: at.range.c1 }, dx: 0, dy: 0 });
    changes.push(`moved to ${cellName(at.range.r1, at.range.c1)}`);
  }
  for (const [key, field, min] of [['width', 'w', CHART_MIN_W], ['height', 'h', CHART_MIN_H]]) {
    if (args[key] == null) continue;
    const n = Math.round(Number(args[key]));
    if (!(n >= min && n <= 4000)) throw new ToolError(`${key} must be ${min} to 4000 pixels.`);
    patch[field] = n;
    changes.push(`${key} ${n}px`);
  }
  if (!changes.length) {
    if (kept.length) return { chart: chart.id, unchanged: kept.join(' ') };
    throw new ToolError('Nothing to change was given.');
  }
  wb.transaction('AI edit', () => wb.updateChart(sheet.id, chart.id, patch, 'AI edit'));
  const after = wb.chartById(sheet.id, chart.id);
  return { chart: chart.id, sheet: sheet.name, changed: changes, ...(after ? { type: after.type, ...(after.range ? { data: rangeName(after.range) } : {}) } : {}) };
}

function deleteChart(wb, args) {
  const { sheet, chart } = chartNamed(wb, args.chart);
  assertWritable(wb, sheet.id, null);
  if (sheet.kind === 'chart') throw new ToolError(`That chart is the chart sheet "${sheet.name}"; delete the sheet with manage_sheet instead.`);
  let ok = false;
  wb.transaction('AI edit', () => { ok = wb.deleteChart(sheet.id, chart.id); });
  if (!ok) throw new ToolError('The chart could not be deleted (its sheet may be protected).');
  return { deleted: `${chart.type} chart${chart.title ? ` "${chart.title}"` : ''} on ${sheet.name}` };
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
  return { rule: `${type} on ${qualified(wb, sheetId, range)}`, id };
}

/** The sheet whose rules (conditional formats, or with `kind` 'validations' validation rules) hold the id given. */
function ruleSheet(wb, id, kind = 'rules') {
  const t = String(id ?? '').trim();
  const sheet = wb.sheets.find((s) => (s[kind] || []).some((r) => r.id === t));
  if (!sheet) throw new ToolError(`There is no ${kind === 'rules' ? 'conditional formatting rule' : 'validation rule'} with the id "${t}"; get_sheet_details lists each sheet's rules and their ids.`);
  return { sheet, id: t };
}

/**
 * What a remove_conditional_format call takes away, before it does: the sheet, the rule groups it touches (the rules
 * Manage Rules lists), and how. Shared with describeCall, which asks about it.
 */
function conditionalRemoval(wb, args, env) {
  if (args.rule_id) {
    const { sheet, id } = ruleSheet(wb, args.rule_id);
    const group = conditionalRuleGroups(sheet.rules).find((g) => g.rules.some((r) => r.id === id));
    return { sheet, how: 'rule', id, touched: 1, label: `the rule ${describeRule(group.rule)} on ${group.rules.map((p) => rangeName(p.range)).join(', ')}` };
  }
  if (args.range) {
    const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
    const sheet = wb.sheet(sheetId);
    const touched = conditionalRuleGroups(sheet.rules || []).filter((g) => g.rules.some((r) => overlaps(r.range, range))).length;
    return { sheet, how: 'range', range, touched, label: `the rules on ${qualified(wb, sheetId, range)}` };
  }
  if (args.whole_sheet) {
    const sheet = gridSheet(wb, args.sheet, env.sheetId());
    return { sheet, how: 'sheet', touched: conditionalRuleGroups(sheet.rules || []).length, label: `every rule on ${sheet.name}` };
  }
  throw new ToolError('Give rule_id, a range, or whole_sheet with a sheet.');
}

function removeConditionalFormat(wb, args, env) {
  const plan = conditionalRemoval(wb, args, env);
  assertWritable(wb, plan.sheet.id, null);
  if (!plan.touched) return { removed: 0, note: `${plan.how === 'sheet' ? plan.sheet.name : qualified(wb, plan.sheet.id, plan.range)} has no conditional formatting.` };
  let touched = 0;
  wb.transaction('AI edit', () => {
    if (plan.how === 'rule') touched = wb.deleteRuleGroup(plan.sheet.id, plan.id) ? 1 : 0;
    else touched = clearRules(wb, plan.sheet.id, plan.how === 'range' ? [plan.range] : null);
  });
  if (!touched) throw new ToolError('The rules could not be removed (the sheet may be protected).');
  const left = conditionalRuleGroups(plan.sheet.rules || []).length;
  return { removed: plan.how === 'rule' ? plan.label : `${touched} rule${touched === 1 ? '' : 's'} from ${plan.how === 'sheet' ? plan.sheet.name : qualified(wb, plan.sheet.id, plan.range)}`, rules_left_on_sheet: left };
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

const VALIDATION_KINDS = { whole: 'whole', decimal: 'number', date: 'date', time: 'time', text_length: 'text', custom: 'formula', checkbox: 'checkbox' };

/** A bound as the rule keeps it: a number, a date as its serial, a time as a fraction of a day. */
function validationBound(value, type, what) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ToolError(`${what} must be a finite number.`);
    return value;
  }
  const t = String(value).trim();
  if (type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (!m) throw new ToolError(`${what} must be a date as "YYYY-MM-DD".`);
    const serial = ymdToSerial(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!Number.isFinite(serial)) throw new ToolError(`${what} is not a date.`);
    return serial;
  }
  if (type === 'time') {
    const v = parseTime(t);
    if (v == null || !Number.isFinite(v)) throw new ToolError(`${what} must be a time as "HH:MM".`);
    return v;
  }
  const n = Number(t.replace(/,/g, ''));
  if (!t || !Number.isFinite(n)) throw new ToolError(`${what} must be a number.`);
  return n;
}

/** Cells of a range already holding values its new rule refuses, held to a count: Excel leaves them as they are. */
function breakingCells(wb, sheetId, range, most = 8) {
  const found = [];
  let n = 0;
  eachStoredCell(wb.sheet(sheetId), range, (r, c, cell) => {
    if (cell.v == null && cell.f == null) return;
    const v = wb.getValue(sheetId, r, c);
    if (v == null || v === '' || wb.validateCell(sheetId, r, c).ok) return;
    if (n++ < most) found.push(cellName(r, c));
  });
  return { n, found };
}

function addValidation(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
  assertWritable(wb, sheetId, null);
  const type = VALIDATION_KINDS[args.type];
  if (!type) throw new ToolError(`type must be one of ${Object.keys(VALIDATION_KINDS).join(', ')}.`);
  const rule = { range, type, strict: args.strict !== false, allowBlank: args.allow_blank !== false };
  if (type === 'formula') {
    const f = String(args.formula ?? '').trim();
    if (!f) throw new ToolError('A custom rule needs its formula.');
    const text = f.startsWith('=') ? f : `=${f}`;
    if (reachesOut(wb, text.slice(1))) throw new ToolError('A rule\'s formula cannot reach outside the workbook.');
    try { parseFormula(text.slice(1)); } catch (e) { throw new ToolError(`The formula could not be read: ${e?.message || 'syntax error'}.`); }
    // As the dialog refuses it: an unknown name or a broken reference fails on every cell alike.
    const result = wb.evalRuleFormula(sheetId, text, range, range.r1, range.c1);
    const code = result && typeof result === 'object' ? result.error : null;
    if (code === '#NAME?' || code === '#REF!') throw new ToolError(`For ${cellName(range.r1, range.c1)} the formula gives ${code} (${explainedError(wb, { error: code })}), so the rule would refuse every value.`);
    rule.source = text;
  } else if (type !== 'checkbox') {
    const op = args.operator || 'between';
    if (!VALIDATION_OPERATORS.some(([k]) => k === op)) throw new ToolError(`operator must be one of ${VALIDATION_OPERATORS.map(([k]) => k).join(', ')}.`);
    const dual = op === 'between' || op === 'notBetween';
    let min = validationBound(args.min, type, 'min');
    let max = dual ? validationBound(args.max, type, 'max') : undefined;
    // As the dialog asks: one bound for a comparison; between may leave one open, except for whole numbers and times.
    if ((!dual || op === 'notBetween' || type === 'whole' || type === 'time') && min == null) throw new ToolError(`A ${op} rule needs min.`);
    if ((op === 'notBetween' || (dual && (type === 'whole' || type === 'time'))) && max == null) throw new ToolError(`A ${op} rule needs max.`);
    if (dual && min == null && max == null) throw new ToolError('Give min, max or both.');
    if (type === 'text' && [min, max].some((n) => n != null && (n < 0 || !Number.isInteger(n)))) throw new ToolError('Text lengths are whole numbers of 0 or more.');
    if (dual && min != null && max != null && min > max) throw new ToolError('min must not be more than max.');
    rule.min = min;
    if (dual) rule.max = max;
    if (op !== 'between') rule.operator = op;
  } else {
    rule.allowBlank = true;
  }
  if (args.prompt) rule.prompt = cutText(String(args.prompt).trim(), 255);
  if (args.error_message) rule.message = cutText(String(args.error_message).trim(), 255);
  const replaced = sameRangeValidation(wb, sheetId, range);
  let id;
  wb.transaction('AI edit', () => { id = wb.addValidation(sheetId, rule); });
  if (id == null) throw new ToolError('The rule could not be added (the sheet may be protected).');
  const broken = type === 'checkbox' ? { n: 0, found: [] } : breakingCells(wb, sheetId, range);
  return {
    validation: qualified(wb, sheetId, range), allows: validationText(rule), id,
    ...(replaced ? { replaced: `the ${replaced.type === 'list' ? 'dropdown' : 'rule'} these cells had before` } : {}),
    ...(broken.n ? { note: `${broken.n} cell${broken.n === 1 ? ' already holds a value' : 's already hold values'} the rule does not allow (${broken.found.join(', ')}${broken.n > broken.found.length ? ', …' : ''}); they are kept as they are, as in Excel.` } : {}),
  };
}

/** What a remove_validation call takes away, before it does (shared with describeCall). */
function validationRemoval(wb, args, env) {
  if (args.rule_id) {
    const { sheet, id } = ruleSheet(wb, args.rule_id, 'validations');
    const rule = sheet.validations.find((v) => v.id === id);
    return { sheet, how: 'rule', id, rules: [rule], label: `the ${rule.type === 'list' ? 'dropdown' : 'validation rule'} on ${quoteSheet(sheet.name)}!${rangeName(rule.range)}` };
  }
  if (args.range) {
    const { sheetId, range } = resolveRange(wb, args.range, env.sheetId());
    const sheet = wb.sheet(sheetId);
    const rules = (sheet.validations || []).filter((v) => overlaps(v.range, range));
    return { sheet, how: 'range', range, rules, label: `the validation on ${qualified(wb, sheetId, range)}` };
  }
  throw new ToolError('Give rule_id, or the range to clear of validation.');
}

function removeValidation(wb, args, env) {
  const plan = validationRemoval(wb, args, env);
  assertWritable(wb, plan.sheet.id, null);
  if (!plan.rules.length) return { removed: 0, note: `${qualified(wb, plan.sheet.id, plan.range)} has no data validation.` };
  let ok = false;
  wb.transaction('AI edit', () => { ok = plan.how === 'rule' ? wb.deleteValidation(plan.sheet.id, plan.id) : wb.clearValidations(plan.sheet.id, plan.range); });
  if (!ok) throw new ToolError('The validation could not be removed (the sheet may be protected).');
  return { removed: plan.label, rules_left_on_sheet: plan.sheet.validations.length };
}

function manageSheet(wb, args, env) {
  const action = args.action;
  // The workbook refuses these without a reason under Protect Workbook: an add read as done, a delete as the last sheet.
  if (wb.structureProtected && ['add', 'rename', 'duplicate', 'delete'].includes(action)) {
    throw new ToolError('The workbook\'s structure is protected, so sheets cannot be added, deleted, renamed or copied. The user can turn this off with Review ▸ Protect Workbook.');
  }
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

/* ---------- Duplicates ---------- */

/** What a remove_duplicates call asks for, read the same way by the runner and by the question put before it. */
function duplicatesArgs(wb, args, fallbackId) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, fallbackId);
  // Whole columns mean their data, from where it begins, as a sort reads them.
  const range = asked.r2 >= MAX_ROW || asked.c2 >= MAX_COL ? dataOfLines(wb, sheetId, asked) : asked;
  if (!range) throw new ToolError(`${qualified(wb, sheetId, asked)} holds no data.`);
  // A range inside a table takes in the table's other columns, so those may be compared too.
  const table = wb.tableAt?.(sheetId, range.r1, range.c1);
  const span = table && range.c1 >= table.range.c1 && range.c2 <= table.range.c2 ? table.range : range;
  let columns = null;
  if (Array.isArray(args.columns) && args.columns.length) {
    columns = [...new Set(args.columns.map((c) => columnArg(c)))];
    const outside = columns.find((c) => c < span.c1 || c > span.c2);
    if (outside != null) throw new ToolError(`Column ${colName(outside)} is outside ${rangeName(range)}.`);
  }
  const header = !!(args.has_header ?? looksLikeHeaderRow(wb, sheetId, range));
  return { sheetId, range, header, columns };
}

function removeDuplicates(wb, args, env) {
  const { sheetId, range, header, columns } = duplicatesArgs(wb, args, env.sheetId());
  assertWritable(wb, sheetId, range);
  const rows = header ? { ...range, r1: range.r1 + 1 } : range;
  if (rows.r1 > rows.r2) throw new ToolError('There are no rows under the header.');
  const blocker = wb.rearrangeBlocker?.(sheetId, rows, 'row');
  if (blocker) throw new ToolError(`The rows of ${qualified(wb, sheetId, rows)} cannot be rearranged (${SORT_BLOCKERS[blocker] || 'merged cells, a table\'s edge, a pivot table or an array formula is in the way'}).`);
  const plan = wb.duplicatesPlan(sheetId, range, { header, columns });
  if (plan === false) throw new ToolError(`Duplicates cannot be removed from ${qualified(wb, sheetId, range)}.`);
  let removed;
  wb.transaction('AI edit', () => { removed = wb.removeDuplicates(sheetId, range, { header, columns }); });
  if (removed === false) throw new ToolError(`Duplicates cannot be removed from ${qualified(wb, sheetId, range)}.`);
  const span = plan ? plan.range : range;
  const total = plan ? span.r2 - plan.start + 1 : 0;
  const compared = columns || Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i);
  return {
    range: qualified(wb, sheetId, span),
    compared_columns: compared.map(colName),
    header_kept: !!plan?.table || header,
    removed_rows: removed,
    remaining_rows: removed ? plan.kept.length : total,
    ...(removed ? {} : { note: 'No duplicate rows were found.' }),
  };
}

/* ---------- Text to columns ---------- */

const PIECE_FORMATS = ['general', 'text', 'skip'];

/** What a split_text_to_columns call asks for: the text's column, the Text to Columns options (null to detect) and where the pieces go. */
function splitArgs(wb, args, fallbackId) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, fallbackId);
  if (asked.c1 !== asked.c2) throw new ToolError(`Text is split one column at a time: give a single column, such as ${colName(asked.c1)}${asked.r2 >= MAX_ROW ? `:${colName(asked.c1)}` : `${asked.r1 + 1}:${colName(asked.c1)}${asked.r2 + 1}`}.`);
  const range = asked.r2 >= MAX_ROW ? dataOfLines(wb, sheetId, asked) : asked;
  if (!range) throw new ToolError(`${qualified(wb, sheetId, asked)} holds no text to split.`);
  const delimiters = (Array.isArray(args.delimiters) ? args.delimiters : []).map((d) => {
    const t = String(d);
    const one = t === '\\t' || /^tab$/i.test(t) ? '\t' : /^space$/i.test(t) ? ' ' : t;
    if (one.length !== 1) throw new ToolError(`"${t}" is not one character: each delimiter is a single character, such as "," or "\\t" for tab.`);
    return one;
  });
  const widths = (Array.isArray(args.fixed_widths) ? args.fixed_widths : []).map((w) => {
    const n = Number(w);
    if (!Number.isInteger(n) || n < 1 || n > 32767) throw new ToolError('fixed_widths are character positions: whole numbers of at least 1.');
    return n;
  });
  if (delimiters.length && widths.length) throw new ToolError('Give delimiters or fixed_widths, not both.');
  const formats = (Array.isArray(args.piece_formats) ? args.piece_formats : []).map((f) => {
    if (!PIECE_FORMATS.includes(f)) throw new ToolError('Each of piece_formats is "general", "text" or "skip".');
    return f;
  });
  const qualifier = args.text_qualifier == null ? '"' : args.text_qualifier === 'none' ? '' : args.text_qualifier;
  if (!['"', '\'', ''].includes(qualifier)) throw new ToolError('text_qualifier is ", \' or "none".');
  let dest = null;
  if (args.destination != null && String(args.destination).trim()) {
    const at = resolveRange(wb, args.destination, sheetId);
    if (at.sheetId !== sheetId) throw new ToolError('The pieces go on the same sheet as the text: give a destination cell on that sheet.');
    dest = { r: at.range.r1, c: at.range.c1 };
  }
  // Plain text split by a separator found in it is the quick split; anything more is Text to Columns' choices.
  if (!delimiters.length && !widths.length && !formats.length && !dest && args.consecutive_as_one == null && args.text_qualifier == null) {
    return { sheetId, range, options: null, dest: null };
  }
  let options;
  if (widths.length) options = { mode: 'fixed', delimiters: [], consecutive: false, qualifier: '', breaks: widths };
  else {
    let list = delimiters;
    let consecutive = !!args.consecutive_as_one;
    if (!list.length) {
      const found = detectDelimiter(splitTexts(wb, sheetId, range));
      if (!found) throw new ToolError(`No text in ${qualified(wb, sheetId, range)} holds a tab, comma, semicolon, pipe or space to split on; give the delimiters.`);
      list = [found];
      // Detected spaces split on runs of them, as the quick split does.
      if (found === ' ' && args.consecutive_as_one == null) consecutive = true;
    }
    options = { mode: 'delimited', delimiters: list, consecutive, qualifier, breaks: [] };
  }
  if (formats.length) options.formats = formats;
  if (dest) options.dest = dest;
  return { sheetId, range, options, dest };
}

/** The texts a column offers to be split, as the workbook reads them. */
function splitTexts(wb, sheetId, range) {
  const out = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const cell = wb.getCell(sheetId, r, range.c1);
    const text = splitSourceText(cell, typeof cell?.v === 'number' ? wb.styleAt(sheetId, r, range.c1) : cell?.s);
    if (text != null) out.push(text);
  }
  return out;
}

/**
 * The cells a split writes, by the workbook's own plan: the rows a filter shows when the pieces go over the text, as
 * the editor's split passes over hidden rows; the whole column when they go elsewhere. { runs: [{ run, plan }], entries }.
 */
function splitPlans(wb, t) {
  const hidden = wb.sheet(t.sheetId).filterHidden;
  const runs = [];
  if (t.dest || !hidden?.size) runs.push(t.range);
  else {
    let start = null;
    for (let r = t.range.r1; r <= t.range.r2 + 1; r++) {
      const shown = r <= t.range.r2 && !hidden.has(r);
      if (shown && start == null) start = r;
      if (!shown && start != null) { runs.push({ ...t.range, r1: start, r2: r - 1 }); start = null; }
    }
  }
  const plans = runs.map((run) => ({ run, plan: wb.splitTextPlan(t.sheetId, run, t.options) }));
  return { plans, entries: plans.flatMap(({ plan }) => plan.entries || []) };
}

/** The cells a split writes over that hold something else now: not the text being split, where its first piece goes back in. */
function splitReplaces(wb, t, entries) {
  const inPlace = !t.dest || (t.dest.r === t.range.r1 && t.dest.c === t.range.c1);
  let n = 0;
  for (const { r, c, cell } of entries) {
    if (inPlace && c === t.range.c1) continue;
    const now = wb.getCell(t.sheetId, r, c);
    if (!holds(now)) continue;
    if (now.f == null && cell?.f == null && (now.v ?? null) === (cell?.v ?? null)) continue;
    n++;
  }
  return n;
}

const boundsOf = (entries) => entries.reduce((b, { r, c }) => ({ r1: Math.min(b.r1, r), c1: Math.min(b.c1, c), r2: Math.max(b.r2, r), c2: Math.max(b.c2, c) }), { r1: Infinity, c1: Infinity, r2: -1, c2: -1 });

function splitTextToColumns(wb, args, env) {
  const t = splitArgs(wb, args, env.sheetId());
  const { sheetId } = t;
  assertWritable(wb, sheetId, null);
  const { plans, entries } = splitPlans(wb, t);
  if (plans.some(({ plan }) => plan.reason === 'room')) throw new ToolError('The pieces would run past the last column of the sheet. Split into a destination further left, or skip some pieces.');
  if (!entries.length) {
    const what = t.options?.mode === 'fixed' ? 'is long enough to cut at those positions' : t.options ? 'holds those delimiters' : 'holds a tab, comma, semicolon, pipe or space to split on';
    throw new ToolError(`No text in ${qualified(wb, sheetId, t.range)} ${what}, so nothing was split.`);
  }
  if (entries.length > MAX_WRITE_CELLS * 10) throw new ToolError(`The split would write ${entries.length.toLocaleString('en-US')} cells; split fewer rows at a time.`);
  // Refused whole, before anything is written, where the workbook would refuse a part of it.
  const merged = entries.find(({ r, c }) => wb._coveredByMerge?.(sheetId, r, c));
  if (merged) throw new ToolError(`A piece would land in ${cellName(merged.r, merged.c)}, inside a merged cell. Unmerge it, or give another destination.`);
  const locked = entries.find(({ r, c }) => wb.isLockedIn(sheetId, { r1: r, c1: c, r2: r, c2: c }));
  if (locked) throw new ToolError(`A piece would land in ${cellName(locked.r, locked.c)}, which is a protected range.`);
  const bounds = boundsOf(entries);
  const blockedArray = plans.find(({ plan }) => plan.entries && wb.arrayEditBlocked(sheetId, boundsOf(plan.entries)));
  if (blockedArray) throw new ToolError(`The pieces would land on part of an array formula's result in ${qualified(wb, sheetId, boundsOf(blockedArray.plan.entries))}. Give another destination.`);
  const written = new Set(entries.map(({ r, c }) => cellKey(r, c)));
  const hit = spillsHit(wb, sheetId, bounds, (r, c) => written.has(cellKey(r, c)));
  let rows = 0, cols = 0, reason = null;
  wb.transaction('AI edit', () => {
    for (const { run, plan } of plans) {
      if (!plan.entries) continue;
      const out = wb.splitTextToColumns(sheetId, run, t.options);
      rows += out.rows;
      cols = Math.max(cols, out.cols);
      reason ??= out.reason;
    }
  });
  if (!rows) throw new ToolError(reason === 'merged' ? 'The pieces would land inside merged cells.' : reason === 'protected' ? 'The pieces would land in a protected range.' : `${qualified(wb, sheetId, t.range)} could not be split.`);
  const blocked = blockedSpills(wb, sheetId, hit);
  return {
    split: qualified(wb, sheetId, t.range), cells_split: rows, columns: cols, written: qualified(wb, sheetId, bounds),
    ...(t.options?.delimiters?.length ? { delimiters: t.options.delimiters } : {}),
    ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}),
  };
}

/* ---------- Sparklines ---------- */

const SPARKLINE_TYPES = { line: 'line', column: 'column', win_loss: 'stacked' };
const SPARKLINE_POINTS = ['high', 'low', 'first', 'last', 'negative'];

/** How many sparklines sit in a range's cells. */
function sparklinesIn(wb, sheetId, range) {
  let n = 0;
  for (const group of wb.sheet(sheetId)?.sparklineGroups || []) {
    for (const { ref } of group.sparklines) {
      const at = wb.rangeFromText(sheetId, ref)?.range;
      if (at && at.r1 >= range.r1 && at.r1 <= range.r2 && at.c1 >= range.c1 && at.c1 <= range.c2) n++;
    }
  }
  return n;
}

/** A defined name the user can see, as written (no sheet), that the text names: kept as a name, so the target follows it. */
function visibleName(wb, text) {
  const t = String(text ?? '').trim();
  if (!t || t.includes('!')) return null;
  return (wb.names || []).find((n) => !n.hidden && String(n.name).toLowerCase() === t.toLowerCase()) || null;
}

function addSparklines(wb, args, env) {
  const { sheetId, range: loc } = resolveRange(wb, args.location, env.sheetId());
  assertWritable(wb, sheetId, loc);
  if (args.remove) {
    const n = sparklinesIn(wb, sheetId, loc);
    if (!n) throw new ToolError(`There are no sparklines in ${qualified(wb, sheetId, loc)}.`);
    let removed;
    wb.transaction('AI edit', () => { removed = wb.clearNativeSparklines(sheetId, [loc]); });
    if (removed == null || removed === 0) throw new ToolError(`The sparklines in ${qualified(wb, sheetId, loc)} could not be removed: a cell of theirs is protected.`);
    return { removed_sparklines: removed, from: qualified(wb, sheetId, loc) };
  }
  if (loc.r2 >= MAX_ROW || loc.c2 >= MAX_COL) throw new ToolError('location must be cells such as "N2:N10", not whole rows or columns.');
  const kind = args.type ?? 'line';
  const type = SPARKLINE_TYPES[kind];
  if (!type) throw new ToolError('type must be line, column or win_loss.');
  if (args.data_range == null || !String(args.data_range).trim()) throw new ToolError('Give the data_range the sparklines are drawn from.');
  const raw = String(args.data_range).trim().replace(/^=/, '');
  let source;
  const name = visibleName(wb, raw);
  if (name) source = name.name;
  else {
    const data = resolveRange(wb, raw, env.sheetId());
    // Whole columns or rows mean their data, as a chart's do.
    const cells = data.range.r2 >= MAX_ROW || data.range.c2 >= MAX_COL ? dataOfLines(wb, data.sheetId, data.range) : data.range;
    if (!cells) throw new ToolError(`${qualified(wb, data.sheetId, data.range)} holds no data.`);
    source = qualified(wb, data.sheetId, cells);
  }
  const flags = {};
  if (args.markers) {
    if (type !== 'line') throw new ToolError('Markers are for line sparklines only.');
    flags.markers = true;
  }
  for (const p of Array.isArray(args.highlight) ? args.highlight : []) {
    if (!SPARKLINE_POINTS.includes(p)) throw new ToolError(`highlight takes ${SPARKLINE_POINTS.join(', ')}.`);
    flags[p] = true;
  }
  const orientation = args.series_in === 'rows' ? 'rows' : args.series_in === 'columns' ? 'columns' : 'auto';
  let error;
  wb.transaction('AI edit', () => { error = wb.createNativeSparklines(sheetId, { source, location: rangeName(loc), type, orientation, flags }); });
  if (error) throw new ToolError(`The sparklines could not be added: ${error.message}`);
  return { sparklines: sparklinesIn(wb, sheetId, loc), type: kind, in: qualified(wb, sheetId, loc), data: source };
}

/* ---------- Links ---------- */

/** The address a set_link call links to: a web or email address, or "#…" for a place in the workbook. */
function linkTarget(wb, args, sheetId) {
  const url = args.url != null ? String(args.url).trim() : '';
  const place = args.location != null ? String(args.location).trim().replace(/^#/, '') : '';
  if (url && place) throw new ToolError('Give url or location, not both.');
  if (place) {
    const name = visibleName(wb, place);
    if (name) return `#${wb.nameLabel ? wb.nameLabel(name) : name.name}`;
    const at = resolveRange(wb, place, sheetId);
    const address = wb.internalLinkFor(at.sheetId, at.range);
    if (!address) throw new ToolError(`"${place}" is not a place in this workbook that can be linked to.`);
    return address;
  }
  if (!url) throw new ToolError('Give the url (a web or email address) or the location in this workbook to link to.');
  if (url.startsWith('#')) return linkTarget(wb, { location: url }, sheetId);
  // Only web pages and email: no scripts, data, files or other programs.
  const safe = safeLinkUrl(url);
  if (!safe || !/^(?:https?:\/\/[^/]|mailto:.)/i.test(safe)) throw new ToolError(`"${clip(url, 80)}" is not a web address (http or https) or an email address. Only those, and places in this workbook, can be linked to.`);
  return safe;
}

/** What a linked cell shows when the call gives no text: what it shows now, its value kept (a number stays a number, a formula its formula). */
function keptLabel(wb, sheetId, r, c) {
  const cell = wb.getCell(sheetId, r, c);
  if (!holds(cell)) return null;
  const v = cell.f != null ? wb.getValue(sheetId, r, c) : cell.v;
  return v != null && typeof v !== 'object' ? v : undefined;
}

function setLink(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.cell, env.sheetId());
  const { r1: r, c1: c } = range;
  const one = { r1: r, c1: c, r2: r, c2: c };
  const at = qualified(wb, sheetId, one);
  assertWritable(wb, sheetId, one, { contents: true });
  const merge = wb.mergeAt?.(sheetId, r, c);
  if (merge && (merge.r1 !== r || merge.c1 !== c)) throw new ToolError(`${at} is inside the merged cell ${rangeName(merge)}; put the link on ${cellName(merge.r1, merge.c1)}.`);
  const existing = wb.linkAt(sheetId, r, c);
  if (args.remove) {
    if (!existing) throw new ToolError(`${at} has no link.`);
    wb.transaction('AI edit', () => wb.removeLink(sheetId, r, c));
    if (wb.linkAt(sheetId, r, c)) throw new ToolError(`The link on ${at} could not be removed.`);
    return { link_removed: at, shows: wb.getDisplay(sheetId, r, c) };
  }
  const url = linkTarget(wb, args, sheetId);
  const table = wb.tableAt?.(sheetId, r, c);
  if (table && r === tableRows(table).header) throw new ToolError(`${at} is a table's header, which holds its column's name and cannot hold a link.`);
  if (wb.arrayEditBlocked(sheetId, one)) throw new ToolError(`${at} is part of an array formula's result.`);
  const text = args.text != null && String(args.text).trim() ? cutText(String(args.text).trim(), MAX_TEXT) : null;
  let label = text;
  if (label == null) {
    const kept = keptLabel(wb, sheetId, r, c);
    if (kept === undefined) throw new ToolError(`${at} shows an error, which a link cannot show; give the text it should show.`);
    // An empty cell shows a place by its address, without the #.
    label = kept ?? (url.startsWith('#') ? url.slice(1).replace(/'/g, '') : '');
  }
  if (!wb.canEnsureSize(sheetId, r + 1, c + 1)) throw new ToolError('The cell is past the edge of the sheet.');
  wb.ensureSize(sheetId, r + 1, c + 1);
  let ok;
  wb.transaction('AI edit', () => { ok = wb.setLink(sheetId, r, c, url, label); });
  if (!ok) throw new ToolError(`A link could not be put on ${at}.`);
  return { linked: at, to: url, shows: wb.getDisplay(sheetId, r, c), ...(existing && existing.url !== url ? { replaced: `the link to ${existing.url}` } : {}) };
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

/* ---------- Rows and columns: height, hiding ---------- */

/**
 * Rows ("3", "2:20", "1,4:6") or columns ("C", "B:D", "A,C:E") as sorted runs of 0-based indices that do not
 * overlap, so "2:5,4:8" is counted (and hidden) once.
 */
function lineRunsArg(text, axis) {
  const parts = String(text ?? '').split(',').map((p) => p.trim().replace(/\$/g, '')).filter(Boolean);
  if (!parts.length) throw new ToolError(axis === 'row' ? 'No rows were given, e.g. "3:5".' : 'No columns were given, e.g. "B:D".');
  const at = (t) => {
    if (axis === 'col') return columnArg(t);
    const n = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!(n >= 1 && n <= MAX_ROW + 1)) throw new ToolError(`"${t}" is not a row number such as 5.`);
    return n - 1;
  };
  const runs = parts.map((p) => {
    const [a, b = a, extra] = p.split(':');
    if (extra != null) throw new ToolError(`"${p}" is not a ${axis === 'row' ? 'row' : 'column'} or a run of them.`);
    const i = at(a.trim()), j = at(b.trim());
    return { from: Math.min(i, j), to: Math.max(i, j) };
  }).sort((x, y) => x.from - y.from);
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && run.from <= last.to + 1) last.to = Math.max(last.to, run.to);
    else out.push({ ...run });
  }
  return out;
}

const runLength = (runs) => runs.reduce((n, { from, to }) => n + to - from + 1, 0);

/** "rows 3–5, 9" or "columns B–D": the lines a step acts on, as the chat names them. */
function linesLabel(axis, runs) {
  const one = (i) => (axis === 'row' ? String(i + 1) : colName(i));
  const many = runs.length > 1 || runs[0].to > runs[0].from;
  const listed = runs.slice(0, 6).map(({ from, to }) => (to > from ? `${one(from)}–${one(to)}` : one(from))).join(', ');
  return `${axis === 'row' ? 'row' : 'column'}${many ? 's' : ''} ${listed}${runs.length > 6 ? ', …' : ''}`;
}

function setRowHeight(wb, args, env) {
  const sheet = gridSheet(wb, args.sheet, env.sheetId());
  assertWritable(wb, sheet.id, null);
  const runs = lineRunsArg(args.rows, 'row');
  const where = `${linesLabel('row', runs)} on ${sheet.name}`;
  if (String(args.height ?? '').trim().toLowerCase() === 'fit') {
    if (!env.autofitRows) throw new ToolError('Rows cannot be fitted here; give a height in pixels.');
    // Rows past the last one holding anything (or a height of its own) have nothing to fit: a run to the sheet's
    // end stops there, as Fit rows does over whole columns.
    let last = wb.usedRange(sheet.id)?.r2 ?? -1;
    for (const r of sheet.rowHeights.keys()) if (r > last) last = r;
    const fit = runs.map(({ from, to }) => ({ from, to: Math.min(to, Math.max(from, last)) }));
    if (runLength(fit) > 5000) throw new ToolError('At most 5,000 rows can be fitted at once.');
    let ok = true;
    // The editor measures text on the sheet in view alone; it says so before fitting anything.
    wb.transaction('AI edit', () => { for (const { from, to } of fit) if (ok) ok = env.autofitRows(sheet.id, from, to) !== false; });
    if (!ok) throw new ToolError(`Rows can be fitted only on the sheet the user is looking at. Show ${quoteSheet(sheet.name)} first (manage_sheet with action "activate"), or give a height in pixels.`);
    return { fitted: where };
  }
  const height = Math.round(Number(args.height));
  if (!(height >= MIN_ROW_PX && height <= MAX_ROW_PX)) throw new ToolError(`height must be ${MIN_ROW_PX} to ${MAX_ROW_PX} pixels, or "fit".`);
  // Every row of the sheet is the sheet's default height, as Row Height… over the whole sheet sets it.
  if (runs.length === 1 && runs[0].from === 0 && runs[0].to >= MAX_ROW) {
    wb.transaction('AI edit', () => wb.setDefaultLineSize(sheet.id, 'row', height));
    return { resized: `every row on ${sheet.name}`, height };
  }
  if (runLength(runs) > 20000) throw new ToolError('At most 20,000 rows at once; to size every row, give rows "1:1048576".');
  wb.transaction('AI edit', () => { for (const { from, to } of runs) for (let r = from; r <= to; r++) wb.setRowHeight(sheet.id, r, height); });
  return { resized: where, height };
}

// The sizes the Row height dialog takes.
const MIN_ROW_PX = 18, MAX_ROW_PX = 400;

function setHidden(wb, args, env) {
  const sheet = gridSheet(wb, args.sheet, env.sheetId());
  const hasRows = args.rows != null && args.rows !== '', hasCols = args.columns != null && args.columns !== '';
  if (hasRows === hasCols) throw new ToolError('Give rows or columns (not both).');
  // A protected sheet keeps its rows and columns as they are: said so, rather than a change reported that did not happen.
  assertWritable(wb, sheet.id, null);
  const axis = hasRows ? 'row' : 'col';
  const runs = lineRunsArg(hasRows ? args.rows : args.columns, axis);
  const hide = args.hidden !== false;
  const where = `${linesLabel(axis, runs)} on ${sheet.name}`;
  const n = runLength(runs);
  if (n > 100000) throw new ToolError('At most 100,000 rows or columns at once.');
  const set = axis === 'row' ? sheet.hiddenRows : sheet.hiddenCols;
  const indices = [];
  if (hide) for (const { from, to } of runs) for (let i = from; i <= to; i++) indices.push(i);
  else for (const { from, to } of runs) indices.push(...wb.hiddenWithin(sheet.id, axis, from, to));
  // Rows a filter hides stay hidden when shown by hand, as in the app: the filter decides them.
  let filtered = 0;
  if (!hide && axis === 'row') for (const i of sheet.filterHidden) if (!set.has(i) && runs.some(({ from, to }) => i >= from && i <= to)) filtered++;
  const byFilter = filtered ? `${filtered.toLocaleString('en-US')} row${filtered === 1 ? ' is' : 's are'} hidden by a filter, not by hand: change or clear the filter to show ${filtered === 1 ? 'it' : 'them'}.` : null;
  const pending = indices.filter((i) => set.has(i) !== hide);
  if (!pending.length) return { [hide ? 'hidden' : 'shown']: where, changed: 0, note: hide ? 'They were hidden already.' : byFilter || 'None of them was hidden.' };
  let ok;
  wb.transaction('AI edit', () => { ok = wb.setHidden(sheet.id, axis, pending, hide); });
  if (!ok) throw new ToolError(`${where} cannot all be hidden: a sheet keeps at least one ${axis === 'row' ? 'row' : 'column'} showing.`);
  return { [hide ? 'hidden' : 'shown']: where, changed: pending.length, ...(byFilter ? { note: byFilter } : {}) };
}

/* ---------- Merged cells ---------- */

/**
 * The cells a merge takes: whole columns or rows as far as the sheet's data goes (not a million rows), grown to take in
 * the whole of every merged cell they touch, as a selection over part of one takes it in.
 */
function mergeArea(wb, sheetId, asked) {
  const used = wb.usedRange(sheetId);
  const range = { ...asked };
  if (range.r2 >= MAX_ROW) range.r2 = Math.max(range.r1, Math.min(range.r2, used?.r2 ?? range.r1));
  if (range.c2 >= MAX_COL) range.c2 = Math.max(range.c1, Math.min(range.c2, used?.c2 ?? range.c1));
  return wb.expandToMerges(sheetId, range);
}

/** The blocks a merge makes of its range: the range itself, or each row of it. */
function mergeBlocksOf(range, across) {
  if (!across) return [range];
  const blocks = [];
  for (let r = range.r1; r <= range.r2; r++) blocks.push({ r1: r, c1: range.c1, r2: r, c2: range.c2 });
  return blocks;
}

/** How many cells of the blocks, past each block's top-left one, hold a value or a formula: what a merge deletes. */
function mergeDrops(wb, sheetId, blocks) {
  let n = 0;
  for (const b of blocks) n += filledCells(wb, sheetId, b) - (holds(wb.getCell(sheetId, b.r1, b.c1)) ? 1 : 0);
  return n;
}

/** The table whose header or data cells a range overlaps, which cannot be merged; its totals row can. */
function tableInMerge(wb, sheetId, range) {
  return (wb.sheet(sheetId)?.tables || []).find((t) => !(range.r2 < t.range.r1 || range.r1 > tableRows(t).dataEnd || range.c2 < t.range.c1 || range.c1 > t.range.c2)) || null;
}

function mergeCells(wb, args, env) {
  const { sheetId, range: asked } = resolveRange(wb, args.range, env.sheetId());
  const action = args.action || 'merge';
  if (!['merge', 'merge_across', 'unmerge'].includes(action)) throw new ToolError('action must be merge, merge_across or unmerge.');
  if (action === 'unmerge') {
    const hit = wb.mergesIn(sheetId, asked);
    if (!hit.length) throw new ToolError(`${qualified(wb, sheetId, asked)} holds no merged cells.`);
    for (const g of hit) assertWritable(wb, sheetId, g);
    wb.transaction('AI edit', () => wb.unmergeCells(sheetId, asked));
    return { unmerged: hit.slice(0, 20).map((g) => qualified(wb, sheetId, g)), ...(hit.length > 20 ? { more: hit.length - 20 } : {}) };
  }
  const across = action === 'merge_across';
  const range = mergeArea(wb, sheetId, asked);
  if (across ? range.c1 === range.c2 : range.r1 === range.r2 && range.c1 === range.c2) {
    throw new ToolError(across ? 'merge_across needs at least two columns.' : 'A single cell cannot be merged; give a range of two or more cells.');
  }
  if ((range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > 20000) throw new ToolError('At most 20,000 cells can be merged at once.');
  assertWritable(wb, sheetId, range);
  const table = tableInMerge(wb, sheetId, range);
  if (table) throw new ToolError(`${qualified(wb, sheetId, range)} overlaps the table ${table.name}, whose header and data cells cannot be merged.`);
  const blocks = mergeBlocksOf(range, across);
  const dropped = mergeDrops(wb, sheetId, blocks);
  // A merged cell shows its top-left cell alone, so results a formula spilled into the rest of it are blocked.
  const firsts = new Set(blocks.map((b) => cellKey(b.r1, b.c1)));
  const hit = spillsHit(wb, sheetId, range, (r, c) => !firsts.has(cellKey(r, c)));
  const center = args.center ?? !across;
  let merged = [];
  wb.transaction('AI edit', () => {
    // Merged cells already inside the range give way to the new blocks, as Merge Across replaces them.
    if (across) wb.unmergeCells(sheetId, range);
    merged = wb.mergeBlocks(sheetId, blocks);
    if (!center) return;
    for (const [i, b] of blocks.entries()) {
      // Asked for, the text is centred; by default only a cell with no alignment of its own is, as the toolbar does.
      if (merged[i] && (args.center === true || !wb.styleAt(sheetId, b.r1, b.c1)?.align)) wb.applyStyle(sheetId, { r1: b.r1, c1: b.c1, r2: b.r1, c2: b.c1 }, { align: 'center' });
    }
  });
  const done = merged.filter(Boolean).length;
  // The workbook refuses a block over an array formula entered with Ctrl+Shift+Enter (the checks above cover the rest).
  if (!done) throw new ToolError(`${qualified(wb, sheetId, range)} could not be merged: an array formula is in the way.`);
  const refused = blocks.filter((b, i) => !merged[i]);
  const blocked = blockedSpills(wb, sheetId, hit);
  return {
    merged: across ? `each row of ${qualified(wb, sheetId, range)}` : qualified(wb, sheetId, range),
    ...(rangeName(range) !== rangeName(asked) && !(asked.r2 >= MAX_ROW || asked.c2 >= MAX_COL) ? { note: `Grown to ${rangeName(range)} to take in the merged cells it overlapped.` } : {}),
    ...(dropped ? { values_deleted: `Only the top-left value${across ? ' of each row' : ''} was kept: ${dropped} other cell${dropped === 1 ? '' : 's'} of data ${dropped === 1 ? 'was' : 'were'} cleared.` } : {}),
    ...(refused.length ? { not_merged: `${refused.length} row${refused.length === 1 ? '' : 's'} (${refused.slice(0, 5).map((b) => rangeName(b)).join(', ')}) could not be merged: an array formula is in the way.` } : {}),
    ...(blocked.length ? { spills_blocked: blocked.slice(0, 8) } : {}),
  };
}

/* ---------- Named ranges and formulas ---------- */

/** The sheet a name is scoped to (its name as the workbook spells it), or null for the workbook. */
function nameScope(wb, scope, env) {
  if (scope == null || String(scope).trim() === '') return null;
  return sheetNamed(wb, scope, env.sheetId()).name;
}

/** The name defined in exactly this scope, or null. */
function nameIn(wb, name, scope) {
  const key = String(name ?? '').trim().toLowerCase();
  return (wb.names || []).find((n) => (n.sheet || null) === scope && n.name.toLowerCase() === key) || null;
}

const BARE_REF = /^(?:\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)$/i;

/**
 * What a name refers to, as the workbook keeps it: a range anchored on its sheet ("B2:B20" from the active sheet is
 * Sheet1!$B$2:$B$20, as Define Name fills it in), whole columns as $B:$B; anything else, a formula, as it was given.
 */
function nameRefText(wb, text, env) {
  const t = String(text ?? '').trim().replace(/^=/, '');
  if (!t) throw new ToolError('Give refers_to: a range such as "Sheet1!B2:B20" or a formula such as "=0.2".');
  const ref = wb.parseNamedRef(t);
  if (!BARE_REF.test(t) && (!ref || ref.spill || ref.sheetEnd)) return t;
  let found;
  try { found = resolveRange(wb, t, env.sheetId()); } catch { return t; }
  const sheet = quoteSheet(wb.sheet(found.sheetId).name);
  const { r1, c1, r2, c2 } = found.range;
  const scope = lineScope(found.range);
  if (scope === 'columns') return `${sheet}!$${colName(c1)}:$${colName(c2)}`;
  if (scope === 'rows') return `${sheet}!$${r1 + 1}:$${r2 + 1}`;
  return wb.refTextFor(found.sheetId, { r1, c1, r2, c2 });
}

/** How many formulas use a name (cells on the sheets it reaches, and other names): what a delete leaves at #NAME?. */
function nameUses(wb, entry) {
  const names = new Set([upperName(entry.name)]);
  const key = entry.name.toLowerCase();
  let n = 0;
  for (const s of wb.sheets) {
    if (s.kind === 'chart') continue;
    // A sheet with a name of that spelling of its own reaches that one, not the workbook's.
    if (entry.sheet ? s.name !== entry.sheet : (wb.names || []).some((m) => m.sheet === s.name && m.name.toLowerCase() === key)) continue;
    for (const cell of s.cells.values()) if (cell.f != null && mentionsName(cell.f, names)) n++;
  }
  for (const m of wb.names || []) if (m !== entry && mentionsName(String(m.ref ?? ''), names)) n++;
  return n;
}

function manageName(wb, args, env) {
  const action = args.action;
  if (!['define', 'rename', 'delete'].includes(action)) throw new ToolError('action must be define, rename or delete.');
  const name = String(args.name ?? '').trim();
  if (!name) throw new ToolError('No name was given.');
  const scope = nameScope(wb, args.scope, env);
  const existing = nameIn(wb, name, scope);
  const label = scope ? `${quoteSheet(scope)}!${existing?.name ?? name}` : existing?.name ?? name;
  // Names the workbook keeps for itself (a print area, a pivot table's settings) are hidden: not the user's to change.
  if (existing?.hidden) throw new ToolError(`${label} is a hidden name the workbook keeps for itself; it cannot be changed here.`);
  if (action !== 'define' && !existing) {
    const elsewhere = (wb.names || []).filter((n) => !n.hidden && n.name.toLowerCase() === name.toLowerCase()).map((n) => (n.sheet ? `${quoteSheet(n.sheet)}!${n.name} (scope ${n.sheet})` : `${n.name} (workbook scope)`));
    throw new ToolError(`There is no name ${label}${scope ? '' : ' in the workbook scope'}.${elsewhere.length ? ` There is ${elsewhere.join(' and ')}.` : ''}`);
  }
  if (action === 'delete') {
    const uses = nameUses(wb, existing);
    wb.transaction('AI edit', () => wb.deleteName(existing.name, scope));
    return { deleted: label, ...(uses ? { note: `${uses} formula${uses === 1 ? ' uses' : 's use'} it and now show${uses === 1 ? 's' : ''} #NAME?.` } : {}) };
  }
  const refText = action === 'rename' && (args.refers_to == null || args.refers_to === '') ? existing.ref : nameRefText(wb, args.refers_to, env);
  const note = reachingNote(env, reachesOut(wb, refText));
  let problem;
  if (action === 'define') {
    wb.transaction('AI edit', () => { problem = wb.defineName(name, refText, scope); });
    if (problem) throw new ToolError(`${label} could not be defined: ${problem}.`);
    return {
      defined: scope ? `${quoteSheet(scope)}!${name}` : name, refers_to: refText, scope: scope || 'workbook',
      ...(existing && existing.ref !== refText ? { replaced: `It referred to ${existing.ref} before.` } : {}),
      ...(note ? { note } : {}),
    };
  }
  const to = String(args.new_name ?? '').trim();
  if (!to) throw new ToolError('Give new_name, the name to rename it to.');
  wb.transaction('AI edit', () => { problem = wb.renameName(existing.name, scope, to, refText); });
  if (problem) throw new ToolError(`${label} could not be renamed to ${to}: ${problem}.`);
  return { renamed: label, to, refers_to: refText, ...(note ? { note } : {}) };
}

function addNote(wb, args, env) {
  const { sheetId, range } = resolveRange(wb, args.cell, env.sheetId());
  assertWritable(wb, sheetId, { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 });
  // Blank text removes the note, as the workbook takes it; a longer note is kept to its limit, and said to be.
  const given = String(args.text ?? '');
  const text = given.trim() ? cutText(given, MAX_NOTE) : '';
  // A cell holds a note or a comment thread, not both, as in Excel: a note put beside a thread was reported as
  // added, then lost when the file was saved, where the thread's own note takes the cell's one place.
  if (text && getThread(wb, sheetId, range.r1, range.c1)) {
    throw new ToolError(`${qualified(wb, sheetId, { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 })} holds a comment thread, and a cell holds a note or a comment, not both. Put the note on another cell, or leave it to the user to reply to the thread.`);
  }
  wb.transaction('AI edit', () => wb.setNote(sheetId, range.r1, range.c1, text));
  return {
    [text ? 'note_added' : 'note_removed']: qualified(wb, sheetId, { r1: range.r1, c1: range.c1, r2: range.r1, c2: range.c1 }),
    ...(given.length > MAX_NOTE && text ? { note: `A note holds at most ${MAX_NOTE.toLocaleString('en-US')} characters; the text was cut to that.` } : {}),
  };
}

/* ---------- What-if: Goal Seek and Solver ---------- */

const oneCellRange = ({ r, c }) => ({ r1: r, c1: c, r2: r, c2: c });

/** One cell a call names, with its sheet; a range of more than one cell is refused. */
function oneCell(wb, text, sheetId, what) {
  const { sheetId: s, range } = resolveRange(wb, text, sheetId);
  const merge = wb.mergeAt?.(s, range.r1, range.c1);
  // A merged cell named by its whole area is that one cell.
  const single = (range.r1 === range.r2 && range.c1 === range.c2) || (merge && merge.r1 === range.r1 && merge.c1 === range.c1 && merge.r2 === range.r2 && merge.c2 === range.c2);
  if (!single) throw new ToolError(`${what} must be one cell, not ${qualified(wb, s, range)}.`);
  return { sheetId: s, r: range.r1, c: range.c1 };
}

/** The cell a Goal Seek changes: by_changing, read on the sheet of the cell it sets. */
function goalSeekCells(wb, args, env) {
  const target = oneCell(wb, args.set_cell, env.sheetId(), 'set_cell');
  const variable = oneCell(wb, args.by_changing, target.sheetId, 'by_changing');
  return { target, variable };
}

/** Refuse a cell under a merged cell's top-left one: a value written there is stored where no one sees it. */
function assertNotUnderMerge(wb, sheetId, { r, c }, what) {
  const merge = wb.mergeAt?.(sheetId, r, c);
  if (merge && (merge.r1 !== r || merge.c1 !== c)) throw new ToolError(`${what} ${cellName(r, c)} is inside the merged cell ${rangeName(merge)}; use ${cellName(merge.r1, merge.c1)}.`);
}

function goalSeek(wb, args, env) {
  const { target, variable } = goalSeekCells(wb, args, env);
  if (variable.sheetId !== target.sheetId) throw new ToolError('by_changing must be on the same sheet as set_cell.');
  const goal = typeof args.to_value === 'string' ? Number(args.to_value.trim()) : Number(args.to_value);
  if (args.to_value == null || args.to_value === '' || !Number.isFinite(goal)) throw new ToolError('to_value must be a number.');
  const sheetId = target.sheetId;
  const name = (p) => qualified(wb, sheetId, oneCellRange(p));
  assertWritable(wb, sheetId, oneCellRange(variable), { contents: true });
  assertNotUnderMerge(wb, sheetId, variable, 'by_changing');
  const from = wb.getDisplay(sheetId, variable.r, variable.c);
  const before = wb.version;
  const res = wb.goalSeek(sheetId, target, goal, variable, { label: 'AI edit' });
  if (!res.ok) {
    const hint = {
      'The cell to set must contain a formula': `${name(target)} holds no formula. set_cell must be a formula that depends on by_changing.`,
      'The cell to change must hold a number, not a formula': `${name(variable)} holds a formula. by_changing must be an input cell that holds a number or is blank.`,
      'Choose a different cell to change': 'set_cell and by_changing are the same cell.',
      'The cell to change shows part of an array formula\'s result': `${name(variable)} shows part of an array formula's result, so it cannot take a number.`,
      'The sheet is protected': `${wb.sheet(sheetId).name} is protected. The user can unprotect it from the sheet tab's menu.`,
      'The cell to change is protected': `${name(variable)} is locked on a protected sheet.`,
      'The formula does not produce a number': `${name(target)} does not show a number (it shows ${wb.getDisplay(sheetId, target.r, target.c) || 'nothing'}), whatever ${name(variable)} holds.`,
      'Could not find a value that reaches the goal': `No value of ${name(variable)} makes ${name(target)} reach ${goal}: the formula may never reach it, or may not depend on that cell. Nothing was changed.`,
    }[res.reason] || `${res.reason}.`;
    throw new ToolError(hint);
  }
  const result = modelValue(res.result);
  const shows = wb.getDisplay(sheetId, target.r, target.c);
  if (wb.version === before) return { set_cell: name(target), already: `${name(target)} already shows ${shows}, so ${name(variable)} was left as it is.` };
  return {
    changed: name(variable), from: from || '(blank)', to: wb.getDisplay(sheetId, variable.r, variable.c), value: res.value,
    set_cell: name(target), now_shows: shows, ...(typeof result === 'number' && result !== goal ? { exact_result: result } : {}),
  };
}

/**
 * The model a solve call describes, on the objective's sheet: the one saved there, with what the call gives in its
 * place, or a new one from the call. Options the user set in the Solver dialog are kept. Throws a ToolError.
 */
function solverModel(wb, args, env) {
  let sheetId;
  if (args.objective != null && String(args.objective).trim()) sheetId = oneCell(wb, args.objective, env.sheetId(), 'objective').sheetId;
  else sheetId = gridSheet(wb, args.sheet, env.sheetId()).id;
  const saved = hasSolverModel(wb, sheetId) ? readSolverModel(wb, sheetId) : null;
  const fresh = args.objective != null && String(args.objective).trim() !== '';
  if (!fresh && !saved) throw new ToolError(`No Solver model is saved on ${wb.sheet(sheetId).name}. Give the objective, the variables and any constraints.`);
  const model = fresh ? { ...emptyModel(), options: { ...(saved?.options || emptyModel().options) } } : saved;
  const text = (v) => String(v ?? '').trim().replace(/^=/, '');
  // Saved as Solver saves its references, absolute ($B$4): a relative one in a defined name moves with the cell
  // another spreadsheet reads it from.
  const anchored = (v) => mapFormulaRefs(text(v), (ref) => ({ ...ref, absR1: true, absC1: true, absR2: true, absC2: true }));
  if (fresh) model.objective = anchored(args.objective);
  if (args.goal != null) {
    if (!['max', 'min', 'value'].includes(args.goal)) throw new ToolError('goal must be max, min or value.');
    model.goal = args.goal;
  }
  if (args.value != null) model.value = Number(args.value);
  if (model.goal === 'value' && (args.value == null && fresh || !Number.isFinite(Number(model.value)))) throw new ToolError('Give the number the objective should equal in value.');
  if (args.variables != null) model.variables = anchored(args.variables);
  if (!model.variables) throw new ToolError('Give the variable cells Solver may change.');
  if (args.constraints != null) {
    if (!Array.isArray(args.constraints)) throw new ToolError('constraints must be a list.');
    if (args.constraints.length > MAX_CONSTRAINTS) throw new ToolError(`At most ${MAX_CONSTRAINTS} constraints.`);
    model.constraints = args.constraints.map((k, i) => {
      const rel = k?.relation;
      if (!RELATIONS.some(([r]) => r === rel)) throw new ToolError(`Constraint ${i + 1}: relation must be one of ${RELATIONS.map(([r]) => r).join(', ')}.`);
      const lhs = anchored(k.cell);
      if (!lhs) throw new ToolError(`Constraint ${i + 1} names no cell.`);
      if (['int', 'bin', 'dif'].includes(rel)) return { lhs, rel, rhs: { int: 'integer', bin: 'binary', dif: 'AllDifferent' }[rel] };
      if (k.value == null || text(k.value) === '') throw new ToolError(`Constraint ${i + 1} (${rel}) needs a value: a number, a cell or a formula.`);
      if (typeof k.value === 'number' && !Number.isFinite(k.value)) throw new ToolError(`Constraint ${i + 1}: the value must be finite.`);
      return { lhs, rel, rhs: typeof k.value === 'number' ? String(k.value) : anchored(k.value) };
    });
  } else if (fresh) model.constraints = [];
  if (args.method != null) {
    if (!ENGINES.some(([e]) => e === args.method)) throw new ToolError(`method must be one of ${ENGINES.map(([e]) => e).join(', ')}.`);
    model.engine = args.method;
  }
  if (args.non_negative != null) model.nonNegative = !!args.non_negative;
  return { sheetId, model, saved };
}

/** Do two models say the same, read as the names they are saved in (references compared without $ or case)? */
function sameModel(wb, sheetId, a, b) {
  const flat = (m) => solverNameEntries(wb, sheetId, m).map((n) => `${n.name}=${String(n.ref).replace(/\$/g, '').toUpperCase()}`).sort().join('\n');
  return flat(a) === flat(b);
}

async function solve(wb, args, env) {
  const { sheetId, model } = solverModel(wb, args, env);
  const sheet = wb.sheet(sheetId);
  const seconds = args.max_seconds == null ? SOLVE_SECONDS : Number(args.max_seconds);
  if (!(seconds > 0 && seconds <= SOLVE_MAX_SECONDS)) throw new ToolError(`max_seconds must be more than 0 and at most ${SOLVE_MAX_SECONDS}.`);
  const reports = Array.isArray(args.reports) ? [...new Set(args.reports.map(String))] : [];
  if (reports.some((r) => !['answer', 'sensitivity', 'limits'].includes(r))) throw new ToolError('reports may be answer, sensitivity and limits.');
  if (reports.length && wb.structureProtected) throw new ToolError('The workbook\'s structure is protected, so report sheets cannot be added. Leave reports out.');
  // Protected ranges and merged cells are the tools' checks; the rest (formulas, text, locked cells, sizes) Solver's own.
  const ranges = parseRanges(wb, sheetId, model.variables);
  if (ranges) {
    for (const g of ranges) {
      if ((g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1) > MAX_VARIABLES) throw new ToolError(`A model can have at most ${MAX_VARIABLES} variable cells.`);
      assertWritable(wb, sheetId, g, { contents: true });
      for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) assertNotUnderMerge(wb, sheetId, { r, c }, 'The variable cell');
    }
  }
  const p = prepareSolver(wb, sheetId, model);
  if (p.error) {
    const field = { objective: 'objective', variables: 'variables', value: 'value', constraint: 'constraints' }[p.field];
    throw new ToolError(`${field ? `${field}: ` : ''}${p.error} (the model is on ${quoteSheet(sheet.name)}).`);
  }
  // The time limit bounds this run only; the model is saved with the options it had.
  p.options = { ...p.options, maxTime: Math.min(seconds, p.options.maxTime ?? Infinity) };
  // A change made meanwhile (the user typing, a co-author's edit) would be overwritten by values worked out without it.
  const version = wb.version;
  const halt = () => { if (env.stopped?.() || wb.version !== version) p.cancelled = true; };
  const result = await runSolver(p, { onProgress: halt });
  if (env.stopped?.()) return { stopped: 'The user stopped the assistant; nothing was changed.' };
  if (wb.version !== version) throw new ToolError('The workbook changed while Solver was running, so nothing was changed. Run it again.');
  const keep = args.keep !== false && !!result.x && (result.solved || args.keep_best_found === true);
  const allowed = availableReports(p, result);
  const built = reports.filter((r) => allowed.includes(r));
  const { reportSheetIds: added } = applySolverResult(wb, p, result, { keep, reports: built, label: 'AI edit' });
  const at = (v) => qualified(wb, sheetId, oneCellRange(v));
  const values = p.vars.slice(0, MAX_LISTED).map((v, j) => ({ cell: at(v), value: keep ? wb.getDisplay(sheetId, v.r, v.c) : result.x?.[j] ?? null }));
  const kept = keep ? 'The solution was kept in the variable cells.'
    : !result.x ? 'There is no solution to keep; the variable cells were left as they were.'
    : args.keep === false ? 'The values found were not kept: the variable cells were left as they were.'
    : 'Solver stopped before it found a solution, so the variable cells were left as they were. Run again with keep_best_found to keep the best values found.';
  return {
    status: result.status, message: result.message,
    objective: { cell: at(p.objective), value: keep ? wb.getDisplay(sheetId, p.objective.r, p.objective.c) : modelValue(Number.isFinite(result.objective) ? result.objective : null), before: modelValue(Number.isFinite(p.objectiveBefore) ? p.objectiveBefore : null) },
    [keep ? 'variables' : 'values_found']: result.x || keep ? values : undefined,
    ...(p.vars.length > MAX_LISTED ? { more_variables: p.vars.length - MAX_LISTED } : {}),
    kept, method: ENGINES.find(([e]) => e === model.engine)?.[1], seconds: Math.round(result.seconds * 10) / 10,
    ...(result.status === 'localOptimal' ? { note: 'GRG Nonlinear finds a local optimum; another starting point may find a better one.' } : {}),
    ...(result.status === 'timeLimit' && args.max_seconds == null ? { note: `Stopped at the ${seconds}-second limit; a larger max_seconds may get further.` } : {}),
    ...(added.length ? { reports_added: added.map((id) => wb.sheet(id)?.name) } : {}),
    ...(built.length < reports.length ? { reports_not_added: reports.filter((r) => !built.includes(r)).map((r) => `${r} (not available for this result)`) } : {}),
    saved_model: `Saved on ${quoteSheet(sheet.name)}, where Data ▸ Solver opens it.`,
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
  get_sheet_details: sheetDetails,
  read_range: readRange,
  calculate,
  find: (wb, args) => find(wb, args),
  write_cells: writeCells,
  fill_formula: fillFormula,
  clear_range: clearRange,
  copy_range: copyRangeTool,
  move_range: moveRangeTool,
  find_replace: findReplace,
  format_cells: formatCells,
  insert_rows: (wb, args, env) => lines(wb, args, env, { axis: 'row', remove: false }),
  insert_columns: (wb, args, env) => lines(wb, args, env, { axis: 'col', remove: false }),
  delete_rows: (wb, args, env) => lines(wb, args, env, { axis: 'row', remove: true }),
  delete_columns: (wb, args, env) => lines(wb, args, env, { axis: 'col', remove: true }),
  sort_range: sortRange,
  filter_range: filterRange,
  create_pivot_table: createPivotTable,
  create_chart: createChart,
  update_chart: updateChart,
  delete_chart: deleteChart,
  create_table: createTable,
  add_conditional_format: addConditionalFormat,
  remove_conditional_format: removeConditionalFormat,
  add_dropdown: addDropdown,
  add_validation: addValidation,
  remove_validation: removeValidation,
  manage_sheet: manageSheet,
  freeze_panes: freezePanes,
  remove_duplicates: removeDuplicates,
  split_text_to_columns: splitTextToColumns,
  add_sparklines: addSparklines,
  set_link: setLink,
  set_column_width: setColumnWidth,
  set_row_height: setRowHeight,
  set_hidden: setHidden,
  merge_cells: mergeCells,
  manage_name: manageName,
  add_note: addNote,
  goal_seek: goalSeek,
  solve,
  select_range: selectRange,
};

/**
 * Carry out one tool call. Returns { ok, content (the text the model reads), changed (the
 * workbook moved on), target ({ sheetId, range } the call acted on, for the user to jump to) },
 * or a promise of it for a tool that takes a while (solve), which gives the page its frames back as it works.
 * `env`: sheetId() the active sheet, selection() → { sheetId, range }, select(sheetId, range),
 * showSheet(sheetId), autofit(sheetId, c1, c2), autofitRows(sheetId, r1, r2) (false when it cannot measure that
 * sheet's rows), distrust() when a formula that reaches out is written,
 * stopped() when the user has stopped the assistant (a long tool then gives up, changing nothing).
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
  const failed = (e) => {
    if (!(e instanceof ToolError)) console.error(e);
    return { ok: false, content: `Error: ${e instanceof ToolError ? e.message : `something went wrong (${e?.message || e}).`}`, changed: wb.version !== before, target: null };
  };
  let result;
  try {
    // A tool writes on the sheet its call names alone: with that sheet grouped with others (several tabs selected),
    // the cells it wrote, cleared or formatted were changed on every other sheet of the group too, unannounced.
    result = wb._withoutGroup ? wb._withoutGroup(() => run(wb, args || {}, env)) : run(wb, args || {}, env);
  } catch (e) {
    return failed(e);
  }
  if (typeof result?.then === 'function') return result.then(finished, failed);
  return finished(result);

  function finished(result) {
    const changed = wb.version !== before;
    let content = typeof result === 'string' ? result : JSON.stringify(result);
    // A change the workbook quietly declined (a locked cell, an edit it would not make) must not read as made,
    // or the model tells the user it did something that is not there. Showing a sheet changes the view only.
    if (changesWorkbook(name) && !changed && !(name === 'manage_sheet' && args?.action === 'activate')) content += '\nNote: nothing in the workbook changed. It may already have been this way, or the cells may be locked.';
    // A new sheet, a deleted one or a selection elsewhere changes which sheet a range without a sheet name means.
    const sheetAfter = env.sheetId();
    if (sheetAfter !== sheetBefore && wb.sheet(sheetAfter)) content += `\nNote: the active sheet is now "${wb.sheet(sheetAfter).name}"; ranges without a sheet name now refer to it.`;
    return { ok: true, content, changed, target };
  }
}

/** The cells a call is about, when it names some: what the step in the chat links to. Throws when it names none. */
export function callTarget(wb, name, args, env) {
  // A pivot table put at a cell is about where it goes; one on a new sheet, about its data.
  if (name === 'create_pivot_table' && args.destination) return resolveRange(wb, args.destination, env.sheetId());
  // Sparklines are about the cells they go in; a link about its one cell.
  if (name === 'add_sparklines' && args.location != null) return resolveRange(wb, args.location, env.sheetId());
  if (name === 'set_link' && args.cell != null) { const found = resolveRange(wb, args.cell, env.sheetId()); return { ...found, range: { r1: found.range.r1, c1: found.range.c1, r2: found.range.r1, c2: found.range.c1 } }; }
  // A Goal Seek changes its input cell, which is what the step links to.
  if (name === 'goal_seek') { const { variable: v } = goalSeekCells(wb, args, env); return { sheetId: v.sheetId, range: oneCellRange(v) }; }
  // Goal Seek and Solver change their input cells, which is what the step links to.
  if (name === 'solve') { const { sheetId, model } = solverModel(wb, args, env); const ranges = parseRanges(wb, sheetId, model.variables); return ranges ? { sheetId, range: ranges[0] } : null; }
  const text = args.range ?? args.start_cell ?? args.data_range ?? args.cell ?? args.destination;
  if (text == null) return null;
  const found = resolveRange(wb, text, env.sheetId());
  // A copy or a move is about where it lands: the block the source fills there.
  if (name === 'copy_range' || name === 'move_range') {
    const block = landing(wb, name, args, env);
    if (block) return block;
  }
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
    case 'get_sheet_details': return { label: `Look over the sheet ${sheetName(args.sheet)}` };
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
      // A formula into a table's calculated column may be written down the whole column: its other rows holding formulas are named.
      const formulas = [];
      if (range && start.s != null) rows.forEach((row, i) => (Array.isArray(row) ? row : []).forEach((v, j) => formulas.push({ r: range.r1 + i, c: range.c1 + j, input: v })));
      const column = range && start.s != null ? calculatedColumnCells(wb, start.s, range, formulas).filter(({ f }) => f != null).length : 0;
      const detail = [replaced && `Replaces ${holding(replaced)}.`, column && `It goes into a table's calculated column, so it may replace the formulas in ${plural(column, 'other row')} of that column too.`,
        spills && blocksSpills(spills)].filter(Boolean).join(' ');
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
    case 'copy_range': case 'move_range': {
      const move = name === 'move_range';
      const src = at(args.source);
      let to = null;
      try { to = landing(wb, name, args, env); } catch { /* the runner explains */ }
      const dest = to ? qualified(wb, to.sheetId, to.range) : String(args.destination ?? '');
      const what = move ? 'all' : args.what || 'all';
      let replaced = 0, notes = 0, threads = 0, spills = 0;
      if (to && what !== 'formats') {
        // Where a move's old and new places overlap, its own cells are not data it replaces.
        const both = move && src.s === to.sheetId && src.range && overlapping(src.range, to.range) ? {
          r1: Math.max(src.range.r1, to.range.r1), c1: Math.max(src.range.c1, to.range.c1), r2: Math.min(src.range.r2, to.range.r2), c2: Math.min(src.range.c2, to.range.c2),
        } : null;
        replaced = filled(to.sheetId, to.range) - (both ? filled(to.sheetId, both) : 0);
        if (move) {
          // A move takes the notes and comment threads off where it lands.
          notes = notesIn(wb, to.sheetId, to.range) - (both ? notesIn(wb, to.sheetId, both) : 0);
          threads = notesIn(wb, to.sheetId, to.range, 'comments') - (both ? notesIn(wb, to.sheetId, both, 'comments') : 0);
        } else if (what === 'all') {
          // A copy replaces the destination's notes only when it brings notes, and its comment threads (over the first
          // block, and not when transposed) only when it brings threads, as Paste All does.
          const range = usedExtent(wb, src.s, src.range);
          const lines = !range ? null : args.include_hidden ? { rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1 } : (({ rows, cols }) => ({ rows: rows.length, cols: cols.length }))(wb.visibleIndices(src.s, range));
          if (lines && copiesAny(wb, src.s, range, !!args.include_hidden, 'notes')) notes = notesIn(wb, to.sheetId, to.range);
          if (lines && !args.transpose && copiesAny(wb, src.s, range, !!args.include_hidden, 'comments')) {
            threads = notesIn(wb, to.sheetId, { r1: to.range.r1, c1: to.range.c1, r2: to.range.r1 + lines.rows - 1, c2: to.range.c1 + lines.cols - 1 }, 'comments');
          }
        }
        // An array formula moving with the cells takes its results along: it blocks nothing.
        spills = spillsHit(wb, to.sheetId, to.range).filter((a) => !(move && src.s === to.sheetId && within({ r1: a.r, c1: a.c, r2: a.r, c2: a.c }, src.range))).length;
      }
      const annotations = [notes && plural(notes, 'note'), threads && plural(threads, 'comment thread')].filter(Boolean);
      const detail = [replaced && `Replaces ${holding(replaced)}.`, annotations.length && `Replaces ${annotations.join(' and ')} there.`, spills && blocksSpills(spills)].filter(Boolean).join(' ');
      const label = move ? `Move ${src.text} to ${dest}` : `Copy ${what === 'all' ? '' : `the ${what} of `}${src.text} to ${dest}`;
      return { label, destructive: !!detail, detail: detail || null };
    }
    case 'find_replace': {
      let n = 0, place = '';
      try {
        const { needle, opts, found, scope } = replaceMatches(wb, args, env, searchBudget(1000));
        // The cells the replacement rewrites, as the runner's replaceCells finds them: a match it leaves alone (a
        // formula found by its result, a protected cell, a spilled value) changes nothing and is not asked about.
        const replacement = String(args.replace ?? '');
        if (args.replace != null) for (const { sheet, matches } of found) if (matches.length) n += replaceCells(wb, sheet.id, matches, needle, replacement, { ...opts, dryRun: true });
        place = scope.range ? `in ${qualified(wb, scope.sheets[0].id, scope.range)}` : args.all_sheets ? 'on every sheet' : `on ${scope.sheets[0].name}`;
      } catch { place = args.range ? `in ${args.range}` : `on ${sheetName(args.sheet)}`; }
      const label = `Replace “${clip(String(args.find ?? ''), 40)}” with “${clip(String(args.replace ?? ''), 40)}” ${place}`;
      return { label, destructive: n > 0, detail: n ? `Changes the ${plural(n, 'cell')} that match${n === 1 ? 'es' : ''}.` : null };
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
      const threads = range && range.r1 >= 0 ? notesIn(wb, s, range, 'comments') : 0;
      const which = rows ? `row${n === 1 ? '' : 's'} ${lineNumber(args.start_row)}${n > 1 ? `–${lineNumber(args.start_row) + n - 1}` : ''}` : `column${n === 1 ? '' : 's'} ${String(args.start_column).toUpperCase()}${n > 1 && range ? `–${colName(range.c2)}` : ''}`;
      const removes = [data && `${plural(data, 'cell')} of data`, notes && plural(notes, 'note'), threads && plural(threads, 'comment thread')].filter(Boolean);
      return { label: `Delete ${which} on ${sheetName(args.sheet)}`, destructive: removes.length > 0, detail: removes.length ? `Removes ${removes.join(' and ')}.` : null };
    }
    case 'sort_range': return { label: `Sort ${at(args.range).text}` };
    case 'filter_range': {
      // Named by the list the filter is over, as the runner finds it (a table, a filter around the cell, the data block).
      const t = at(args.range);
      let where = t.text;
      try { const found = filterTarget(wb, t.s, t.range); where = found.table ? found.table.name : qualified(wb, t.s, found.range); } catch { /* the runner explains */ }
      if (args.action === 'clear') return { label: `Show every row of the filter on ${where}` };
      if (args.action === 'remove') return { label: `Remove the filter from ${where}` };
      const cols = (Array.isArray(args.columns) ? args.columns : []).map((c) => String(c?.column ?? '')).filter(Boolean);
      return { label: `Filter ${where}${cols.length ? ` by ${clip(cols.join(', '), 60)}` : ''}` };
    }
    case 'create_pivot_table': {
      // Where it goes, and, at a destination, the data the block it takes would replace: that is asked about first.
      let plan = null;
      try { plan = pivotPlan(wb, args, env); } catch { /* the runner explains */ }
      const what = `${args.summarize || 'sum'} of ${args.values} by ${args.rows}${args.columns ? ` and ${args.columns}` : ''}`;
      if (!plan) return { label: `Add a pivot table (${clip(what, 80)})` };
      const src = qualified(wb, plan.source.sheetId, plan.source.range);
      if (!plan.dest) return { label: `Add a pivot table of ${src} (${clip(what, 80)}) on a new sheet${args.new_sheet_name ? ` named ${args.new_sheet_name}` : ` "${pivotSheetName(wb, plan.source.sheetId)}"`}` };
      let size = null;
      try { size = previewPivot(wb, plan.source.sheetId, plan.spec); } catch { /* the runner explains */ }
      const area = size && { r1: plan.dest.at.r, c1: plan.dest.at.c, r2: plan.dest.at.r + size.rows - 1, c2: plan.dest.at.c + size.cols - 1 };
      const n = area ? filledCells(wb, plan.dest.sheetId, area) : 0;
      const at = area ? qualified(wb, plan.dest.sheetId, area) : qualified(wb, plan.dest.sheetId, { r1: plan.dest.at.r, c1: plan.dest.at.c, r2: plan.dest.at.r, c2: plan.dest.at.c });
      return { label: `Add a pivot table of ${src} (${clip(what, 80)}) at ${at}`, destructive: n > 0, detail: n ? `Replaces ${holding(n)}.` : null };
    }
    case 'create_chart': return { label: `Add a ${args.type || 'column'} chart of ${at(args.data_range).text}` };
    case 'update_chart': case 'delete_chart': {
      let named = null;
      try { named = chartNamed(wb, args.chart); } catch { /* the runner explains */ }
      const what = named ? `the ${named.chart.type} chart${named.chart.title ? ` “${clip(named.chart.title, 40)}”` : ''} on ${named.sheet.name}` : `the chart ${String(args.chart ?? '')}`;
      if (name === 'delete_chart') return { label: `Delete ${what}`, destructive: !!named, detail: named ? 'Removes the chart and its formatting.' : null };
      return { label: `Change ${what}` };
    }
    case 'create_table': {
      // Its header formulas become the text they show, and the result says so.
      const t = at(args.range);
      const range = t.s != null && t.range ? tableRange(wb, t.s, t.range) : null;
      const n = range ? headerFormulas(wb, t.s, range) : 0;
      return { label: `Make ${t.text} a table`, destructive: n > 0, detail: n ? `Turns ${plural(n, 'formula')} in the header row into the text ${n === 1 ? 'it shows' : 'they show'}.` : null };
    }
    case 'add_conditional_format': return { label: `Highlight ${at(args.range).text} (${args.rule})` };
    case 'remove_conditional_format': {
      let plan = null;
      try { plan = conditionalRemoval(wb, args, env); } catch { /* the runner explains */ }
      if (!plan) return { label: 'Remove conditional formatting' };
      const n = plan.touched;
      return { label: `Remove ${plan.label}`, destructive: n > 0, detail: n ? `${plan.how === 'range' ? 'Takes' : 'Removes'} ${n === 1 ? 'a conditional formatting rule' : `${n} conditional formatting rules`}${plan.how === 'range' ? ' off these cells' : ''}.` : null };
    }
    case 'add_dropdown': {
      // A range has one rule: the one on exactly these cells (the user's list of choices, or a rule of their own) goes.
      const t = at(args.range);
      const had = t.s != null && t.range ? sameRangeValidation(wb, t.s, t.range) : null;
      if (!had) return { label: `Add a dropdown to ${t.text}` };
      const list = had.type === 'list';
      return { label: `Replace the ${list ? 'dropdown' : 'validation rule'} on ${t.text}`, destructive: true, detail: list ? 'Replaces the dropdown these cells have, and its choices.' : 'Replaces the rule these cells have for what they may hold.' };
    }
    case 'add_validation': {
      const t = at(args.range);
      const had = t.s != null && t.range ? sameRangeValidation(wb, t.s, t.range) : null;
      if (!had) return { label: `Limit what ${t.text} may hold` };
      const list = had.type === 'list';
      return { label: `Replace the ${list ? 'dropdown' : 'validation rule'} on ${t.text}`, destructive: true, detail: list ? 'Replaces the dropdown these cells have, and its choices.' : 'Replaces the rule these cells have for what they may hold.' };
    }
    case 'remove_validation': {
      let plan = null;
      try { plan = validationRemoval(wb, args, env); } catch { /* the runner explains */ }
      if (!plan) return { label: 'Remove data validation' };
      const n = plan.rules.length, lists = plan.rules.filter((v) => v.type === 'list').length;
      const kinds = lists === n ? (n === 1 ? 'a dropdown' : `${n} dropdowns`) : n === 1 ? 'a validation rule' : `${n} validation rules`;
      return { label: `Remove ${plan.label}`, destructive: n > 0, detail: n ? `${plan.how === 'range' ? 'Takes' : 'Removes'} ${kinds}${plan.how === 'range' ? ' off these cells' : ''}.` : null };
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
    case 'remove_duplicates': {
      // The rows that go, by the workbook's own plan: data taken away, so asked about.
      let t = null, plan = null;
      try { t = duplicatesArgs(wb, args, sheetId); plan = wb.duplicatesPlan(t.sheetId, t.range, t); } catch { /* the runner explains */ }
      const n = plan && plan.changed ? plan.removed : 0;
      return { label: `Remove duplicate rows from ${t ? qualified(wb, t.sheetId, t.range) : at(args.range).text}`, destructive: n > 0, detail: n ? `Deletes ${plural(n, 'row')} that repeat an earlier row; ${plural(plan.kept.length, 'row')} stay.` : null };
    }
    case 'split_text_to_columns': {
      let t = null, replaced = 0, spills = 0;
      try {
        t = splitArgs(wb, args, sheetId);
        const { entries } = splitPlans(wb, t);
        replaced = splitReplaces(wb, t, entries);
        const written = new Set(entries.map(({ r, c }) => cellKey(r, c)));
        spills = entries.length ? spillsHit(wb, t.sheetId, boundsOf(entries), (r, c) => written.has(cellKey(r, c))).length : 0;
      } catch { /* the runner explains */ }
      const detail = [replaced && `Replaces ${holding(replaced)}.`, spills && blocksSpills(spills)].filter(Boolean).join(' ');
      return { label: `Split the text in ${t ? qualified(wb, t.sheetId, t.range) : at(args.range).text} into columns`, destructive: !!detail, detail: detail || null };
    }
    case 'add_sparklines': {
      const t = at(args.location);
      if (args.remove) {
        // The user's sparklines go: asked about, as removing a note is.
        const n = t.range ? sparklinesIn(wb, t.s, t.range) : 0;
        return { label: `Remove the sparklines in ${t.text}`, destructive: n > 0, detail: n ? `Removes ${plural(n, 'sparkline')}.` : null };
      }
      return { label: `Add ${{ column: 'column', win_loss: 'win/loss' }[args.type] || 'line'} sparklines to ${t.text}` };
    }
    case 'set_link': {
      // A link the cell has, and what it shows, are the user's: replacing or removing them asks.
      const t = at(args.cell);
      if (t.range) { t.range = { r1: t.range.r1, c1: t.range.c1, r2: t.range.r1, c2: t.range.c1 }; t.text = qualified(wb, t.s, t.range); }
      const had = t.range ? wb.linkAt(t.s, t.range.r1, t.range.c1) : null;
      if (args.remove) return { label: `Remove the link from ${t.text}`, destructive: !!had, detail: had ? `Removes the link to ${clip(had.url, 80)}.` : null };
      let url = null;
      try { url = t.range ? linkTarget(wb, args, t.s) : null; } catch { /* the runner explains */ }
      const text = args.text != null && String(args.text).trim() ? String(args.text).trim() : null;
      const cell = t.range ? wb.getCell(t.s, t.range.r1, t.range.c1) : null;
      const shown = cell?.f != null ? wb.getValue(t.s, t.range.r1, t.range.c1) : cell?.v;
      const replacesText = text != null && holds(cell) && String(shown ?? '') !== text;
      const replacesLink = !!had && url != null && had.url !== url;
      const detail = [replacesLink && `Replaces its link to ${clip(had.url, 80)}.`, replacesText && `Replaces what the cell holds${cell.f != null ? ' (a formula)' : ''} with "${clip(text, 60)}".`].filter(Boolean).join(' ');
      return { label: `Link ${t.text} to ${clip(url ?? String(args.url ?? args.location ?? ''), 80)}`, destructive: !!detail, detail: detail || null };
    }
    case 'set_column_width': {
      // The columns as the runner reads them ("b:d" is B:D, a run given backwards is the same run).
      let lo = null, hi = null;
      try { const [a, b = a] = String(args.columns ?? '').split(':'); const c1 = columnArg(a), c2 = columnArg(b); lo = Math.min(c1, c2); hi = Math.max(c1, c2); } catch { /* the runner explains */ }
      const many = lo != null ? hi > lo : String(args.columns).includes(':');
      const cols = lo != null ? `${colName(lo)}${many ? `:${colName(hi)}` : ''}` : String(args.columns ?? '');
      return { label: String(args.width).trim().toLowerCase() === 'fit' ? `Fit column${many ? 's' : ''} ${cols} to ${many ? 'their' : 'its'} contents` : `Set column${many ? 's' : ''} ${cols} to ${args.width}px` };
    }
    case 'set_row_height': {
      let rows = String(args.rows ?? '');
      try { rows = linesLabel('row', lineRunsArg(args.rows, 'row')); } catch { /* the runner explains */ }
      const fit = String(args.height ?? '').trim().toLowerCase() === 'fit';
      return { label: fit ? `Fit ${rows} on ${sheetName(args.sheet)} to their contents` : `Set ${rows} on ${sheetName(args.sheet)} to ${args.height}px` };
    }
    case 'set_hidden': {
      const axis = args.rows != null && args.rows !== '' ? 'row' : 'col';
      let which = String((axis === 'row' ? args.rows : args.columns) ?? '');
      try { which = linesLabel(axis, lineRunsArg(axis === 'row' ? args.rows : args.columns, axis)); } catch { /* the runner explains */ }
      return { label: `${args.hidden === false ? 'Show' : 'Hide'} ${which} on ${sheetName(args.sheet)}` };
    }
    case 'merge_cells': {
      const t = at(args.range);
      const action = args.action || 'merge';
      if (action === 'unmerge') return { label: `Unmerge the merged cells in ${t.text}` };
      // Merging keeps the top-left value alone: the other values the blocks hold are deleted, and asked about.
      const across = action === 'merge_across';
      let dropped = 0, spills = 0, text = t.text;
      if (t.range) {
        const range = mergeArea(wb, t.s, t.range);
        const blocks = mergeBlocksOf(range, across);
        dropped = mergeDrops(wb, t.s, blocks);
        const firsts = new Set(blocks.map((b) => cellKey(b.r1, b.c1)));
        spills = spillsHit(wb, t.s, range, (r, c) => !firsts.has(cellKey(r, c))).length;
        text = qualified(wb, t.s, range);
      }
      const detail = [dropped && `Keeps only the top-left value${across ? ' of each row' : ''}: deletes ${plural(dropped, 'other cell')} of data.`, spills && blocksSpills(spills)].filter(Boolean).join(' ');
      return { label: across ? `Merge each row of ${text}` : `Merge ${text}`, destructive: !!detail, detail: detail || null };
    }
    case 'manage_name': {
      // A name is the user's work as a cell is: changing what one refers to, or deleting one, asks.
      const name = String(args.name ?? '').trim();
      let scope = null;
      try { scope = nameScope(wb, args.scope, env); } catch { /* the runner explains */ }
      const had = nameIn(wb, name, scope);
      const label = scope ? `${quoteSheet(scope)}!${had?.name ?? name}` : had?.name ?? name;
      if (args.action === 'delete') {
        const uses = had && !had.hidden ? nameUses(wb, had) : 0;
        return { label: `Delete the name ${label}`, destructive: !!had, detail: had ? (uses ? `Formulas that use it (${uses}) will show #NAME?.` : 'Removes the name.') : null };
      }
      if (args.action === 'rename') return { label: `Rename ${label} to ${String(args.new_name ?? '').trim()}` };
      let ref = String(args.refers_to ?? '').trim();
      try { ref = nameRefText(wb, args.refers_to, env); } catch { /* the runner explains */ }
      if (had && ref && had.ref !== ref) {
        const uses = nameUses(wb, had);
        return { label: `Change ${label} to refer to ${clip(ref, 60)}`, destructive: true, detail: `It refers to ${clip(had.ref, 80)} now${uses ? `, and ${plural(uses, 'formula')} that use${uses === 1 ? 's' : ''} it will change with it` : ''}.` };
      }
      return { label: `Define the name ${label} as ${clip(ref, 60)}` };
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
    case 'goal_seek': {
      // The input cell is read on the sheet of the cell it sets, as the runner reads it.
      let cells = null;
      try { cells = goalSeekCells(wb, args, env); } catch { /* the runner explains */ }
      const name = (p) => qualified(wb, p.sheetId, oneCellRange(p));
      const set = cells ? name(cells.target) : String(args.set_cell ?? '');
      const by = cells ? name(cells.variable) : String(args.by_changing ?? '');
      const label = `Goal seek: set ${set} to ${args.to_value} by changing ${by}`;
      const v = cells?.variable;
      const shown = v && holds(wb.getCell(v.sheetId, v.r, v.c)) ? wb.getDisplay(v.sheetId, v.r, v.c) : null;
      return { label, destructive: shown != null, detail: shown != null ? `Replaces the value in ${by} (now ${shown}).` : null };
    }
    case 'solve': {
      let built = null;
      try { built = solverModel(wb, args, env); } catch { /* the runner explains */ }
      if (!built) return { label: args.objective ? `Solve for ${args.objective}` : 'Run the Solver model' };
      const { sheetId: s, model, saved } = built;
      const goal = { max: 'maximize', min: 'minimize' }[model.goal] || `set to ${model.value}`;
      const objective = parseRanges(wb, s, model.objective)?.[0];
      const ranges = parseRanges(wb, s, model.variables) || [];
      const label = `Solve: ${goal} ${objective ? qualified(wb, s, objective) : model.objective} by changing ${ranges.length ? ranges.map((g) => qualified(wb, s, g)).join(', ') : model.variables}`;
      const data = ranges.reduce((n, g) => n + filledCells(wb, s, g), 0);
      const replacesModel = !!saved && !sameModel(wb, s, saved, model);
      const reports = Array.isArray(args.reports) ? new Set(args.reports).size : 0;
      const detail = [
        data && args.keep !== false && `Replaces the values in ${plural(data, 'variable cell')} with the solution, if one is found.`,
        replacesModel && `Replaces the Solver model saved on ${wb.sheet(s).name}.`,
        reports && `Adds ${plural(reports, 'report sheet')}.`,
      ].filter(Boolean).join(' ');
      return { label, destructive: !!(data && args.keep !== false) || replacesModel, detail: detail || null };
    }
    default: return { label: name };
  }
}
