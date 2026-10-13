/**
 * Data ▸ Data Analysis: the statistical analysis tools. Each tool is a pure function of plain numbers
 * (groups of values with their labels) and its options, and returns a layout: the block of cells it
 * writes, counted from the output's top-left corner, with column widths and charts. The numbers come
 * from the sheet's own functions (T.DIST.2T, F.INV.RT, LINEST and the rest), so a tool's answer and the
 * formula a person would type agree to the last digit.
 *
 * layout = { title, cells: [[value | { v, s }]], colWidths?: { [col]: px }, charts?: [chart] }
 * chart  = { type, title, anchor: { r, c }, w, h, series: [{ name, categories, values }], secondaryAxis, ... }
 *          where categories and values are a source: { rel: [r1, c1, r2, c2] } (cells of the output),
 *          { abs: { sheetId, range } } (cells of the input) or { literal: [numbers] }.
 * A cell value is a number, text, null or an error ({ error: '#N/A' }).
 */
import { FUNCTIONS, isError, isRange } from './formula/functions.js';
import { numFmtToStyle } from './format.js';
import { colName } from './cell.js';
import { quoteSheet } from './refs.js';
import { Workbook } from './workbook.js';

/* ---------- The sheet's own functions ---------- */

const fnOf = (name) => {
  let entry = FUNCTIONS[name];
  while (entry?.alias) entry = FUNCTIONS[entry.alias];
  if (!entry) throw new Error(`analysis-tools: no function ${name}`);
  return entry.fn;
};
/** Call a worksheet function with plain arguments; arrays go in as a one-column range. */
const call = (name, ...args) => fnOf(name)(args.map((a) => (Array.isArray(a) ? column(a) : a)));
const column = (values) => ({ range: true, values: values.map((v) => [v == null ? null : v]) });
const matrix = (rows) => ({ range: true, values: rows });

const NA = Object.freeze({ error: '#N/A' });
const NUM = Object.freeze({ error: '#NUM!' });
const DIV0 = Object.freeze({ error: '#DIV/0!' });
/** A result as a cell value: an error stays an error, a number that is not finite is #NUM!. */
const value = (v) => (v == null ? null : isError(v) ? { error: v.error } : typeof v === 'number' && !Number.isFinite(v) ? NUM : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (values) => values.filter(isNum);

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const sqDev = (xs, m = mean(xs)) => xs.reduce((a, x) => a + (x - m) ** 2, 0);
const sampleVar = (xs) => (xs.length < 2 ? DIV0 : sqDev(xs) / (xs.length - 1));

/* ---------- Styles ---------- */

const TITLE = { bold: true };
const HEAD = { italic: true, bt: true, bb: true };
const LAST = { bb: true };
const PERCENT = numFmtToStyle('0.00%');

/** A block of output cells, written by row and column. */
function output(title) {
  const cells = [];
  const put = (r, c, v, s = null) => {
    while (cells.length <= r) cells.push([]);
    const out = value(v);
    cells[r][c] = s ? { v: out, s: { ...(cells[r][c]?.s || {}), ...s } } : out;
  };
  const style = (r, c, s) => {
    const cur = cells[r]?.[c];
    if (cur === undefined) return put(r, c, null, s);
    cells[r][c] = { v: cur && typeof cur === 'object' && 'v' in cur ? cur.v : cur, s: { ...(cur?.s || {}), ...s } };
  };
  /** A table: a header row (italic, ruled above and below), its rows, and a rule under the last. */
  const table = (r, c, header, rows) => {
    header.forEach((h, j) => put(r, c + j, h, HEAD));
    rows.forEach((row, i) => row.forEach((v, j) => put(r + 1 + i, c + j, v)));
    if (rows.length) for (let j = 0; j < header.length; j++) style(r + rows.length, c + j, LAST);
    return r + 1 + rows.length;
  };
  return { title, cells, put, style, table, charts: [], colWidths: {} };
}

const finish = (out) => ({ title: out.title, cells: out.cells, colWidths: out.colWidths, charts: out.charts });

/* ---------- Reading the input ---------- */

/**
 * The values of a range on a sheet as groups: { groups: [{ label, values, ref }] } or { error }. Grouped
 * by columns (each column a group) or rows; with `labels`, the first row (or column) names the groups.
 * A blank cell is null; text, a logical value or an error refuses the range, unless `allowText` (the
 * complex numbers of Fourier Analysis) lets text through.
 */
export function readGroups(wb, sheetId, range, { by = 'columns', labels = false, name = 'Input range', allowText = false, defaultLabel = null } = {}) {
  const { r1, c1, r2, c2 } = range;
  const byRows = by === 'rows';
  const outer = byRows ? r2 - r1 + 1 : c2 - c1 + 1;
  const inner = byRows ? c2 - c1 + 1 : r2 - r1 + 1;
  const first = labels ? 1 : 0;
  if (inner - first < 1) return { error: `${name} has no data${labels ? ' below its labels' : ''}.` };
  const groups = [];
  for (let i = 0; i < outer; i++) {
    const at = (j) => (byRows ? { r: r1 + i, c: c1 + j } : { r: r1 + j, c: c1 + i });
    const values = [];
    for (let j = first; j < inner; j++) {
      const { r, c } = at(j);
      const v = wb.getValue(sheetId, r, c);
      if (v == null || v === '') values.push(null);
      else if (isNum(v)) values.push(v);
      else if (allowText && typeof v === 'string') values.push(v);
      else return { error: `${name} contains non-numeric data (cell ${colName(c)}${r + 1}).` };
    }
    const head = labels ? wb.getValue(sheetId, at(0).r, at(0).c) : null;
    const label = head != null && head !== '' && !isError(head) ? String(head) : defaultLabel ? defaultLabel(i) : `${byRows ? 'Row' : 'Column'} ${i + 1}`;
    const s = at(first), e = at(inner - 1);
    groups.push({ label, values, ref: { sheetId, range: { r1: s.r, c1: s.c, r2: e.r, c2: e.c } } });
  }
  return { groups };
}

/** The raw block of a range (labels included), for the tools that read row and column labels themselves. */
export function readBlock(wb, sheetId, range) {
  const rows = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const row = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const v = wb.getValue(sheetId, r, c);
      row.push(v === '' ? null : v);
    }
    rows.push(row);
  }
  return rows;
}

const checkAlpha = (alpha) => (isNum(alpha) && alpha > 0 && alpha < 1 ? null : 'Alpha must be a number between 0 and 1.');
const fail = (error) => ({ error });

/* ---------- Anova ---------- */

const anovaRow = (name, ss, df, msWithin, alpha, dfWithin) => {
  const ms = ss / df;
  const F = ms / msWithin;
  return [name, ss, df, ms, F, call('F.DIST.RT', F, df, dfWithin), call('F.INV.RT', alpha, df, dfWithin)];
};

/** Anova: Single Factor. groups: [{ label, values }]. */
export function anovaSingleFactor(groups, { alpha = 0.05 } = {}) {
  const bad = checkAlpha(alpha); if (bad) return fail(bad);
  const data = groups.map((g) => ({ label: g.label, xs: nums(g.values) }));
  if (data.length < 2) return fail('Single-factor Anova needs at least two groups.');
  if (data.some((g) => !g.xs.length)) return fail('Each group needs at least one number.');
  const all = data.flatMap((g) => g.xs);
  const k = data.length, N = all.length;
  if (N - k < 1) return fail('Single-factor Anova needs more values than groups.');
  const grand = mean(all);
  const ssb = sum(data.map((g) => g.xs.length * (mean(g.xs) - grand) ** 2));
  const ssw = sum(data.map((g) => sqDev(g.xs)));
  const out = output('Anova: Single Factor');
  out.put(0, 0, 'Anova: Single Factor', TITLE);
  out.put(2, 0, 'SUMMARY');
  let r = out.table(3, 0, ['Groups', 'Count', 'Sum', 'Average', 'Variance'],
    data.map((g) => [g.label, g.xs.length, sum(g.xs), mean(g.xs), sampleVar(g.xs)]));
  r += 2;
  out.put(r, 0, 'ANOVA');
  const msw = ssw / (N - k);
  r = out.table(r + 1, 0, ['Source of Variation', 'SS', 'df', 'MS', 'F', 'P-value', 'F crit'], [
    anovaRow('Between Groups', ssb, k - 1, msw, alpha, N - k),
    ['Within Groups', ssw, N - k, msw],
    [],
    ['Total', ssb + ssw, N - 1],
  ]);
  out.colWidths = { 0: 140 };
  return finish(out);
}

/**
 * Anova: Two-Factor With Replication. block: the input with its labels, the first row naming the
 * columns and the first column naming each sample at the first of its `rowsPerSample` rows.
 */
export function anovaTwoFactorReplication(block, { rowsPerSample = 1, alpha = 0.05 } = {}) {
  const bad = checkAlpha(alpha); if (bad) return fail(bad);
  const n = Math.trunc(rowsPerSample);
  if (!(n >= 2)) return fail('Rows per sample must be a whole number of 2 or more.');
  const dataRows = block.length - 1, b = (block[0]?.length || 0) - 1;
  if (b < 2 || dataRows < 2) return fail('Select the labels and at least two columns and two samples of data.');
  if (dataRows % n) return fail(`The data rows must divide evenly into samples of ${n} rows.`);
  const a = dataRows / n;
  if (a < 2) return fail('Two-factor Anova needs at least two samples.');
  const cell = (i, k, j) => block[1 + i * n + k][1 + j];
  for (let i = 0; i < a; i++) for (let k = 0; k < n; k++) for (let j = 0; j < b; j++) {
    if (!isNum(cell(i, k, j))) return fail('Input range must hold a number in every data cell.');
  }
  const colLabels = Array.from({ length: b }, (_, j) => (block[0][1 + j] != null ? String(block[0][1 + j]) : `Column ${j + 1}`));
  const rowLabels = Array.from({ length: a }, (_, i) => (block[1 + i * n][0] != null ? String(block[1 + i * n][0]) : `Sample ${i + 1}`));
  const cellXs = (i, j) => Array.from({ length: n }, (_, k) => cell(i, k, j));
  const rowXs = (i) => Array.from({ length: b }, (_, j) => cellXs(i, j)).flat();
  const colXs = (j) => Array.from({ length: a }, (_, i) => cellXs(i, j)).flat();
  const all = Array.from({ length: a }, (_, i) => rowXs(i)).flat();
  const grand = mean(all);
  const ssRows = b * n * sum(Array.from({ length: a }, (_, i) => (mean(rowXs(i)) - grand) ** 2));
  const ssCols = a * n * sum(Array.from({ length: b }, (_, j) => (mean(colXs(j)) - grand) ** 2));
  let ssWithin = 0;
  for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) ssWithin += sqDev(cellXs(i, j));
  const ssTotal = sqDev(all);
  const ssInter = ssTotal - ssRows - ssCols - ssWithin;
  const dfWithin = a * b * (n - 1);
  const msw = ssWithin / dfWithin;
  const out = output('Anova: Two-Factor With Replication');
  out.put(0, 0, 'Anova: Two-Factor With Replication', TITLE);
  let r = 2;
  out.put(r, 0, 'SUMMARY', HEAD);
  colLabels.forEach((l, j) => out.put(r, 1 + j, l, HEAD));
  out.put(r, 1 + b, 'Total', HEAD);
  r += 1;
  // A block per sample (its cells and its row total), then one for the columns' totals.
  const summaryBlock = (label, groupsOf) => {
    out.put(r++, 0, label, { bold: true });
    for (const [name, f] of [['Count', (xs) => xs.length], ['Sum', sum], ['Average', mean], ['Variance', sampleVar]]) {
      out.put(r, 0, name);
      groupsOf.forEach((xs, j) => out.put(r, 1 + j, f(xs)));
      r++;
    }
    r++;
  };
  for (let i = 0; i < a; i++) summaryBlock(rowLabels[i], [...Array.from({ length: b }, (_, j) => cellXs(i, j)), rowXs(i)]);
  summaryBlock('Total', Array.from({ length: b }, (_, j) => colXs(j)));
  r++;
  out.put(r, 0, 'ANOVA');
  out.table(r + 1, 0, ['Source of Variation', 'SS', 'df', 'MS', 'F', 'P-value', 'F crit'], [
    anovaRow('Sample', ssRows, a - 1, msw, alpha, dfWithin),
    anovaRow('Columns', ssCols, b - 1, msw, alpha, dfWithin),
    anovaRow('Interaction', ssInter, (a - 1) * (b - 1), msw, alpha, dfWithin),
    ['Within', ssWithin, dfWithin, msw],
    [],
    ['Total', ssTotal, a * b * n - 1],
  ]);
  out.colWidths = { 0: 140 };
  return finish(out);
}

/** Anova: Two-Factor Without Replication. rows: the data as rows of numbers; rowLabels, colLabels name them. */
export function anovaTwoFactor(rows, { rowLabels = [], colLabels = [], alpha = 0.05 } = {}) {
  const bad = checkAlpha(alpha); if (bad) return fail(bad);
  const a = rows.length, b = rows[0]?.length || 0;
  if (a < 2 || b < 2) return fail('Two-factor Anova needs at least two rows and two columns of data.');
  if (rows.some((row) => row.length !== b || row.some((v) => !isNum(v)))) return fail('Input range must hold a number in every data cell.');
  const rowXs = (i) => rows[i];
  const colXs = (j) => rows.map((row) => row[j]);
  const all = rows.flat();
  const grand = mean(all);
  const ssRows = b * sum(rows.map((row) => (mean(row) - grand) ** 2));
  const ssCols = a * sum(Array.from({ length: b }, (_, j) => (mean(colXs(j)) - grand) ** 2));
  const ssTotal = sqDev(all);
  const ssErr = ssTotal - ssRows - ssCols;
  const dfErr = (a - 1) * (b - 1);
  const mse = ssErr / dfErr;
  const out = output('Anova: Two-Factor Without Replication');
  out.put(0, 0, 'Anova: Two-Factor Without Replication', TITLE);
  const line = (label, xs) => [label, xs.length, sum(xs), mean(xs), sampleVar(xs)];
  let r = out.table(2, 0, ['SUMMARY', 'Count', 'Sum', 'Average', 'Variance'],
    Array.from({ length: a }, (_, i) => line(rowLabels[i] ?? `Row ${i + 1}`, rowXs(i))));
  r = out.table(r + 1, 0, ['', 'Count', 'Sum', 'Average', 'Variance'],
    Array.from({ length: b }, (_, j) => line(colLabels[j] ?? `Column ${j + 1}`, colXs(j)))) + 2;
  out.put(r, 0, 'ANOVA');
  out.table(r + 1, 0, ['Source of Variation', 'SS', 'df', 'MS', 'F', 'P-value', 'F crit'], [
    anovaRow('Rows', ssRows, a - 1, mse, alpha, dfErr),
    anovaRow('Columns', ssCols, b - 1, mse, alpha, dfErr),
    ['Error', ssErr, dfErr, mse],
    [],
    ['Total', ssTotal, a * b - 1],
  ]);
  out.colWidths = { 0: 140 };
  return finish(out);
}

/* ---------- Correlation and covariance ---------- */

function pairMatrix(groups, title, pair) {
  if (groups.length < 2) return fail(`${title} needs at least two ${'variables'}.`);
  const length = groups[0].values.length;
  if (groups.some((g) => g.values.length !== length)) return fail('Every variable needs the same number of observations.');
  const out = output(title);
  groups.forEach((g, j) => out.put(0, 1 + j, g.label, HEAD));
  out.put(0, 0, '', HEAD);
  groups.forEach((g, i) => {
    out.put(1 + i, 0, g.label);
    for (let j = 0; j <= i; j++) out.put(1 + i, 1 + j, pair(groups[i].values, groups[j].values, i === j));
  });
  for (let j = 0; j <= groups.length; j++) out.style(groups.length, j, LAST);
  out.colWidths = { 0: 110 };
  return finish(out);
}

/** Correlation: the Pearson correlation of every pair of variables, as CORREL works it out. */
export function correlation(groups) {
  return pairMatrix(groups, 'Correlation', (x, y, same) => (same ? 1 : call('CORREL', x, y)));
}

/** Covariance: the population covariance of every pair, as COVARIANCE.P (the diagonal is VAR.P). */
export function covariance(groups) {
  return pairMatrix(groups, 'Covariance', (x, y) => call('COVARIANCE.P', x, y));
}

/* ---------- Descriptive statistics ---------- */

/**
 * Descriptive Statistics. options: { summary, confidence (0..1 or null), kthLargest, kthSmallest }.
 * The confidence level of the mean is T.INV.2T(1 - level, n - 1) times the standard error.
 */
export function descriptiveStatistics(groups, { summary = true, confidence = null, kthLargest = null, kthSmallest = null } = {}) {
  if (!summary && confidence == null && kthLargest == null && kthSmallest == null) return fail('Choose at least one of the statistics to show.');
  if (confidence != null && !(confidence > 0 && confidence < 1)) return fail('The confidence level must be between 0% and 100%.');
  for (const [k, what] of [[kthLargest, 'Kth largest'], [kthSmallest, 'Kth smallest']]) {
    if (k != null && !(Number.isInteger(k) && k >= 1)) return fail(`${what} must be a whole number of 1 or more.`);
  }
  const out = output('Descriptive Statistics');
  groups.forEach((g, gi) => {
    const xs = nums(g.values);
    const c = gi * 2;
    out.put(0, c, g.label, HEAD); out.put(0, c + 1, '', HEAD);
    const rows = [];
    if (summary) {
      const sd = call('STDEV.S', xs);
      rows.push(['Mean', xs.length ? mean(xs) : DIV0], ['Standard Error', isError(sd) ? sd : sd / Math.sqrt(xs.length)],
        ['Median', call('MEDIAN', xs)], ['Mode', call('MODE.SNGL', xs)], ['Standard Deviation', sd], ['Sample Variance', call('VAR.S', xs)],
        ['Kurtosis', call('KURT', xs)], ['Skewness', call('SKEW', xs)], ['Range', xs.length ? Math.max(...xs) - Math.min(...xs) : 0],
        ['Minimum', xs.length ? Math.min(...xs) : 0], ['Maximum', xs.length ? Math.max(...xs) : 0], ['Sum', sum(xs)], ['Count', xs.length]);
    }
    if (kthLargest != null) rows.push([`Largest(${kthLargest})`, call('LARGE', xs, kthLargest)]);
    if (kthSmallest != null) rows.push([`Smallest(${kthSmallest})`, call('SMALL', xs, kthSmallest)]);
    if (confidence != null) {
      const sd = call('STDEV.S', xs);
      const t = xs.length > 1 ? call('T.INV.2T', 1 - confidence, xs.length - 1) : DIV0;
      rows.push([`Confidence Level(${(confidence * 100).toFixed(1)}%)`, isError(sd) ? sd : isError(t) ? t : t * sd / Math.sqrt(xs.length)]);
    }
    rows.forEach(([name, v], i) => { out.put(1 + i, c, name); out.put(1 + i, c + 1, v); });
    out.style(rows.length, c, LAST); out.style(rows.length, c + 1, LAST);
    out.colWidths[c] = 140;
  });
  return finish(out);
}

/* ---------- Smoothing and moving averages ---------- */

const chartSize = { w: 432, h: 260 };

/** The source a chart reads a group's values from: its cells when it came from the sheet, else its numbers. */
const groupSource = (g) => (g.ref ? { abs: g.ref } : { literal: g.values });

/**
 * Exponential Smoothing with a damping factor (1 - the smoothing constant). The first forecast is
 * #N/A, the second the first actual value, each next one damping × the last forecast + (1 − damping)
 * × the last actual. The standard error at a point is the root mean square of the last three
 * forecast errors up to it, from the fourth point on.
 */
export function exponentialSmoothing(group, { damping = 0.3, labels = false, standardErrors = false, chart = false } = {}) {
  if (!(isNum(damping) && damping >= 0 && damping <= 1)) return fail('The damping factor must be between 0 and 1.');
  const xs = group.values;
  if (xs.length < 2 || xs.some((v) => !isNum(v))) return fail(xs.some((v) => v == null) ? 'Input range must not hold blank cells.' : 'Exponential smoothing needs at least two values.');
  const alpha = 1 - damping;
  const f = [NA, xs[0]];
  for (let t = 2; t < xs.length; t++) f.push(alpha * xs[t - 1] + damping * f[t - 1]);
  const out = output('Exponential Smoothing');
  const top = labels ? 1 : 0;
  if (labels) { out.put(0, 0, 'Forecast', HEAD); if (standardErrors) out.put(0, 1, 'Standard Error', HEAD); }
  f.forEach((v, t) => out.put(top + t, 0, v));
  if (standardErrors) {
    for (let t = 0; t < xs.length; t++) {
      if (t < 3) { out.put(top + t, 1, NA); continue; }
      const errs = [t - 2, t - 1, t].map((i) => (xs[i] - f[i]) ** 2);
      out.put(top + t, 1, Math.sqrt(sum(errs) / 3));
    }
  }
  if (chart) out.charts.push(lineChart('Exponential Smoothing', [
    { name: 'Actual', values: groupSource(group) },
    { name: 'Forecast', values: { rel: [top, 0, top + xs.length - 1, 0] } },
  ], { r: 0, c: standardErrors ? 3 : 2 }));
  return finish(out);
}

/**
 * Moving Average over `interval` points: #N/A until a whole interval is in, then the mean of the last
 * `interval` actual values. The standard error is the root mean square of the last `interval` forecast
 * errors, once that many forecasts exist.
 */
export function movingAverage(group, { interval = 3, labels = false, standardErrors = false, chart = false } = {}) {
  const k = Math.trunc(interval);
  if (!(k >= 2)) return fail('The interval must be a whole number of 2 or more.');
  const xs = group.values;
  if (xs.some((v) => !isNum(v))) return fail('Input range must not hold blank cells.');
  if (xs.length < k) return fail(`The input needs at least ${k} values for an interval of ${k}.`);
  const f = xs.map((_, t) => (t < k - 1 ? NA : mean(xs.slice(t - k + 1, t + 1))));
  const out = output('Moving Average');
  const top = labels ? 1 : 0;
  if (labels) { out.put(0, 0, 'Forecast', HEAD); if (standardErrors) out.put(0, 1, 'Standard Error', HEAD); }
  f.forEach((v, t) => out.put(top + t, 0, v));
  if (standardErrors) {
    for (let t = 0; t < xs.length; t++) {
      if (t < 2 * k - 2) { out.put(top + t, 1, NA); continue; }
      let s = 0;
      for (let i = t - k + 1; i <= t; i++) s += (xs[i] - f[i]) ** 2;
      out.put(top + t, 1, Math.sqrt(s / k));
    }
  }
  if (chart) out.charts.push(lineChart('Moving Average', [
    { name: 'Actual', values: groupSource(group) },
    { name: 'Forecast', values: { rel: [top, 0, top + xs.length - 1, 0] } },
  ], { r: 0, c: standardErrors ? 3 : 2 }));
  return finish(out);
}

function lineChart(title, series, anchor) {
  return { type: 'line', title, anchor, ...chartSize, legend: true, xTitle: 'Data Point', yTitle: 'Value', series };
}

/* ---------- Tests of two samples ---------- */

const twoHeader = (out, g1, g2) => { out.put(2, 0, '', HEAD); out.put(2, 1, g1.label, HEAD); out.put(2, 2, g2.label, HEAD); };
function twoTable(out, rows) {
  rows.forEach((row, i) => row.forEach((v, j) => out.put(3 + i, j, v)));
  for (let j = 0; j < 3; j++) out.style(2 + rows.length, j, LAST);
  out.colWidths = { 0: 190 };
}

/** F-Test Two-Sample for Variances: F = var1 / var2, judged in the tail F falls in. */
export function fTest(g1, g2, { alpha = 0.05 } = {}) {
  const bad = checkAlpha(alpha); if (bad) return fail(bad);
  const x = nums(g1.values), y = nums(g2.values);
  if (x.length < 2 || y.length < 2) return fail('Each variable needs at least two numbers.');
  const v1 = sqDev(x) / (x.length - 1), v2 = sqDev(y) / (y.length - 1);
  if (v2 === 0) return fail('The second variable has no variance, so F cannot be worked out.');
  const F = v1 / v2, d1 = x.length - 1, d2 = y.length - 1;
  const upper = F >= 1;
  const out = output('F-Test Two-Sample for Variances');
  out.put(0, 0, 'F-Test Two-Sample for Variances', TITLE);
  twoHeader(out, g1, g2);
  twoTable(out, [
    ['Mean', mean(x), mean(y)],
    ['Variance', v1, v2],
    ['Observations', x.length, y.length],
    ['df', d1, d2],
    ['F', F],
    ['P(F<=f) one-tail', upper ? call('F.DIST.RT', F, d1, d2) : call('F.DIST', F, d1, d2, true)],
    ['F Critical one-tail', upper ? call('F.INV.RT', alpha, d1, d2) : call('F.INV', alpha, d1, d2)],
  ]);
  return finish(out);
}

const tTails = (t, df, alpha) => {
  const at = Math.abs(t);
  return [
    ['t Stat', t],
    ['P(T<=t) one-tail', call('T.DIST.RT', at, df)],
    ['t Critical one-tail', call('T.INV', 1 - alpha, df)],
    ['P(T<=t) two-tail', call('T.DIST.2T', at, df)],
    ['t Critical two-tail', call('T.INV.2T', alpha, df)],
  ];
};

/**
 * The t-tests. kind: 'paired' | 'equal' | 'unequal'. The unequal-variance test rounds its
 * Welch–Satterthwaite degrees of freedom to a whole number, which it reports and tests against.
 */
export function tTest(g1, g2, { kind = 'paired', difference = 0, alpha = 0.05 } = {}) {
  const bad = checkAlpha(alpha); if (bad) return fail(bad);
  if (!isNum(difference)) return fail('The hypothesized mean difference must be a number.');
  let x, y;
  if (kind === 'paired') {
    if (g1.values.length !== g2.values.length) return fail('A paired test needs two ranges of the same size.');
    const pairs = g1.values.map((v, i) => [v, g2.values[i]]);
    if (pairs.some(([a, b]) => isNum(a) !== isNum(b))) return fail('Each pair needs both of its values: a blank cell in one range must be blank in the other.');
    const kept = pairs.filter(([a]) => isNum(a));
    x = kept.map(([a]) => a); y = kept.map(([, b]) => b);
  } else { x = nums(g1.values); y = nums(g2.values); }
  if (x.length < 2 || y.length < 2) return fail('Each variable needs at least two numbers.');
  const m1 = mean(x), m2 = mean(y), v1 = sqDev(x) / (x.length - 1), v2 = sqDev(y) / (y.length - 1);
  const out = output('');
  const rows = [['Mean', m1, m2], ['Variance', v1, v2], ['Observations', x.length, y.length]];
  let t, df;
  if (kind === 'paired') {
    out.title = 't-Test: Paired Two Sample for Means';
    const d = x.map((a, i) => a - y[i]);
    const sd = Math.sqrt(sqDev(d) / (d.length - 1));
    df = d.length - 1;
    t = (mean(d) - difference) / (sd / Math.sqrt(d.length));
    rows.push(['Pearson Correlation', call('CORREL', x, y)], ['Hypothesized Mean Difference', difference], ['df', df]);
  } else if (kind === 'equal') {
    out.title = 't-Test: Two-Sample Assuming Equal Variances';
    df = x.length + y.length - 2;
    const pooled = ((x.length - 1) * v1 + (y.length - 1) * v2) / df;
    t = (m1 - m2 - difference) / Math.sqrt(pooled * (1 / x.length + 1 / y.length));
    rows.push(['Pooled Variance', pooled], ['Hypothesized Mean Difference', difference], ['df', df]);
  } else {
    out.title = 't-Test: Two-Sample Assuming Unequal Variances';
    const a = v1 / x.length, b = v2 / y.length;
    df = Math.round((a + b) ** 2 / (a * a / (x.length - 1) + b * b / (y.length - 1)));
    t = (m1 - m2 - difference) / Math.sqrt(a + b);
    rows.push(['Hypothesized Mean Difference', difference], ['df', df]);
  }
  if (!Number.isFinite(t)) return fail('The samples have no variance, so t cannot be worked out.');
  out.put(0, 0, out.title, TITLE);
  twoHeader(out, g1, g2);
  twoTable(out, [...rows, ...tTails(t, df, alpha)]);
  return finish(out);
}

/** z-Test: Two Sample for Means, with the two variances known. */
export function zTest(g1, g2, { difference = 0, variance1, variance2, alpha = 0.05 } = {}) {
  const bad = checkAlpha(alpha); if (bad) return fail(bad);
  if (!(isNum(variance1) && variance1 > 0) || !(isNum(variance2) && variance2 > 0)) return fail('Enter each known variance as a number greater than 0.');
  if (!isNum(difference)) return fail('The hypothesized mean difference must be a number.');
  const x = nums(g1.values), y = nums(g2.values);
  if (!x.length || !y.length) return fail('Each variable needs at least one number.');
  const z = (mean(x) - mean(y) - difference) / Math.sqrt(variance1 / x.length + variance2 / y.length);
  const tail = 1 - call('NORM.S.DIST', Math.abs(z), true);
  const out = output('z-Test: Two Sample for Means');
  out.put(0, 0, out.title, TITLE);
  twoHeader(out, g1, g2);
  twoTable(out, [
    ['Mean', mean(x), mean(y)], ['Known Variance', variance1, variance2], ['Observations', x.length, y.length],
    ['Hypothesized Mean Difference', difference], ['z', z],
    ['P(Z<=z) one-tail', tail], ['z Critical one-tail', call('NORM.S.INV', 1 - alpha)],
    ['P(Z<=z) two-tail', 2 * tail], ['z Critical two-tail', call('NORM.S.INV', 1 - alpha / 2)],
  ]);
  return finish(out);
}

/* ---------- Fourier analysis ---------- */

/** A value as a complex number { re, im }: a number, or text such as 3+2i read as IMREAL and IMAGINARY do. */
function complexOf(v) {
  if (isNum(v)) return { re: v, im: 0 };
  const re = call('IMREAL', v), im = call('IMAGINARY', v);
  return isError(re) || isError(im) ? null : { re, im };
}

/**
 * Fourier Analysis: the discrete Fourier transform of 2^k values (k up to 12) by a radix-2 FFT, or
 * with `inverse` the inverse transform (divided by n). Results are written as complex text, the way
 * COMPLEX writes them.
 */
export function fourier(group, { inverse = false, labels = false } = {}) {
  const raw = group.values;
  const n = raw.length;
  if (n < 2 || n > 4096 || (n & (n - 1))) return fail('Fourier analysis needs 2, 4, 8, … up to 4096 values (a power of 2).');
  const zs = raw.map(complexOf);
  if (zs.some((z) => !z)) return fail('Input range must hold numbers or complex numbers such as 3+2i in every cell.');
  const re = zs.map((z) => z.re), im = zs.map((z) => z.im);
  // Bit-reversal order, then butterflies.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  const scale = inverse ? 1 / n : 1;
  const big = Math.max(...re.map(Math.abs), ...im.map(Math.abs)) * scale;
  const clean = (v) => (Math.abs(v * scale) <= big * 1e-13 ? 0 : Number((v * scale).toPrecision(15)));
  const out = output(inverse ? 'Inverse Fourier Analysis' : 'Fourier Analysis');
  const top = labels ? 1 : 0;
  if (labels) out.put(0, 0, inverse ? 'Inverse Transform' : 'Fourier Transform', HEAD);
  for (let k = 0; k < n; k++) out.put(top + k, 0, call('COMPLEX', clean(re[k]), clean(im[k])));
  out.colWidths = { 0: 160 };
  return finish(out);
}

/* ---------- Histogram ---------- */

/**
 * Histogram: counts per bin. A value goes in the first bin whose bound it does not exceed; values past
 * the last bound go in More. Without bins the range from the minimum to the maximum is cut into
 * round(√n) equal intervals, whose bounds (the minimum first) are the bins.
 */
export function histogram(group, { bins = null, binLabel = null, pareto = false, cumulative = false, chart = false } = {}) {
  const xs = nums(group.values);
  if (!xs.length) return fail('Input range holds no numbers.');
  let edges;
  if (bins && bins.length) {
    edges = nums(bins).sort((a, b) => a - b);
    if (!edges.length) return fail('Bin range holds no numbers.');
  } else {
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const m = Math.max(1, Math.round(Math.sqrt(xs.length)));
    edges = Array.from({ length: m + 1 }, (_, i) => (i === m ? hi : lo + ((hi - lo) * i) / m));
    if (lo === hi) edges = [lo];
  }
  const counts = new Array(edges.length + 1).fill(0);
  for (const x of xs) {
    let i = edges.findIndex((e) => x <= e);
    if (i < 0) i = edges.length;
    counts[i]++;
  }
  const labelsOut = [...edges, 'More'];
  const total = xs.length;
  const out = output('Histogram');
  const header = [binLabel || 'Bin', 'Frequency', ...(cumulative ? ['Cumulative %'] : [])];
  let run = 0;
  const rows = labelsOut.map((b, i) => { run += counts[i]; return [b, counts[i], ...(cumulative ? [run / total] : [])]; });
  out.table(0, 0, header, rows);
  if (cumulative) rows.forEach((_, i) => out.style(1 + i, 2, PERCENT));
  const width = header.length;
  if (pareto) {
    const order = labelsOut.map((b, i) => ({ b, n: counts[i], i })).sort((p, q) => q.n - p.n || p.i - q.i);
    let acc = 0;
    out.table(0, width + 1, header, order.map((p) => { acc += p.n; return [p.b, p.n, ...(cumulative ? [acc / total] : [])]; }));
    if (cumulative) order.forEach((_, i) => out.style(1 + i, width + 3, PERCENT));
  }
  if (chart) {
    const last = labelsOut.length;
    // Charted from the sorted table when there is one, as a Pareto chart reads.
    const c0 = pareto ? width + 1 : 0;
    const series = [{ name: 'Frequency', categories: { rel: [1, c0, last, c0] }, values: { rel: [1, c0 + 1, last, c0 + 1] } }];
    if (cumulative) series.push({ name: 'Cumulative %', categories: { rel: [1, c0, last, c0] }, values: { rel: [1, c0 + 2, last, c0 + 2] } });
    out.charts.push({ type: cumulative ? 'combo' : 'column', title: 'Histogram', anchor: { r: 0, c: (pareto ? 2 * width + 1 : width) + 1 }, ...chartSize,
      legend: true, xTitle: binLabel || 'Bin', yTitle: 'Frequency', secondaryAxis: cumulative, series });
  }
  return finish(out);
}

/* ---------- Random numbers and sampling ---------- */

/** A seeded generator of numbers in [0, 1) (mulberry32); without a seed, one drawn at random. */
export function seededRandom(seed) {
  let a = (seed == null || seed === '' ? Math.floor(Math.random() * 2 ** 32) : Math.trunc(Number(seed))) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalDraw(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function poissonDraw(rand, lambda) {
  if (lambda > 500) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalDraw(rand)));
  const u = rand();
  let k = 0, p = Math.exp(-lambda), cdf = p;
  while (u > cdf && k < 100000) { k++; p *= lambda / k; cdf += p; }
  return k;
}

export const DISTRIBUTIONS = ['uniform', 'normal', 'bernoulli', 'binomial', 'poisson', 'patterned', 'discrete'];

/**
 * Random Number Generation. options: { variables, count, distribution, seed, params } with params by
 * distribution: uniform { from, to }; normal { mean, sd }; bernoulli { p }; binomial { p, trials };
 * poisson { lambda }; patterned { from, to, step, repeatEach, repeatSequence }; discrete { values, probabilities }.
 */
export function randomNumbers({ variables = 1, count = 1, distribution = 'uniform', seed = null, params = {} } = {}) {
  const cols = Math.trunc(variables);
  if (!(cols >= 1 && cols <= 1000)) return fail('The number of variables must be a whole number from 1 to 1000.');
  const rand = seededRandom(seed);
  let draw;
  let rows = Math.trunc(count);
  const P = params;
  switch (distribution) {
    case 'uniform':
      if (!isNum(P.from) || !isNum(P.to)) return fail('Enter the two numbers the values fall between.');
      draw = () => P.from + (P.to - P.from) * rand();
      break;
    case 'normal':
      if (!isNum(P.mean) || !(isNum(P.sd) && P.sd >= 0)) return fail('Enter a mean and a standard deviation of 0 or more.');
      draw = () => P.mean + P.sd * normalDraw(rand);
      break;
    case 'bernoulli':
      if (!(isNum(P.p) && P.p >= 0 && P.p <= 1)) return fail('The p value must be between 0 and 1.');
      draw = () => (rand() < P.p ? 1 : 0);
      break;
    case 'binomial': {
      const n = Math.trunc(P.trials);
      if (!(isNum(P.p) && P.p >= 0 && P.p <= 1)) return fail('The p value must be between 0 and 1.');
      if (!(n >= 1 && n <= 1e6)) return fail('The number of trials must be a whole number of 1 or more.');
      draw = () => { let k = 0; for (let i = 0; i < n; i++) if (rand() < P.p) k++; return k; };
      break;
    }
    case 'poisson':
      if (!(isNum(P.lambda) && P.lambda > 0)) return fail('Lambda must be a number greater than 0.');
      draw = () => poissonDraw(rand, P.lambda);
      break;
    case 'patterned': {
      const { from, to, step } = P;
      const each = Math.trunc(P.repeatEach ?? 1), times = Math.trunc(P.repeatSequence ?? 1);
      if (!isNum(from) || !isNum(to) || !isNum(step) || step <= 0) return fail('Enter the first and last numbers and a step greater than 0.');
      if (to < from) return fail('The last number must not be less than the first.');
      if (!(each >= 1) || !(times >= 1)) return fail('The repeat counts must be whole numbers of 1 or more.');
      const seq = [];
      for (let i = 0; ; i++) {
        const v = Number((from + i * step).toPrecision(15));
        if (v > to + Math.abs(step) * 1e-9 || seq.length > 1e6) break;
        for (let k = 0; k < each; k++) seq.push(v);
      }
      const all = Array.from({ length: times }, () => seq).flat();
      rows = all.length;
      let i = -1;
      draw = (col) => { if (col === 0) i++; return all[i]; };
      break;
    }
    case 'discrete': {
      const vals = P.values || [], probs = P.probabilities || [];
      if (!vals.length || vals.length !== probs.length) return fail('The value and probability range needs two columns: values and their probabilities.');
      if (vals.some((v) => !isNum(v)) || probs.some((p) => !isNum(p) || p < 0)) return fail('The value and probability range must hold numbers, with no negative probability.');
      const total = sum(probs);
      if (Math.abs(total - 1) > 1e-9) return fail('The probabilities must add up to 1.');
      const cdf = []; let acc = 0;
      for (const p of probs) { acc += p; cdf.push(acc); }
      draw = () => { const u = rand(); const i = cdf.findIndex((c) => u < c); return vals[i < 0 ? vals.length - 1 : i]; };
      break;
    }
    default: return fail('Choose a distribution.');
  }
  if (distribution !== 'patterned' && !(rows >= 1 && rows <= 1048576)) return fail('The number of random numbers must be a whole number of 1 or more.');
  if (rows * cols > 1e6) return fail('That is more than a million numbers; ask for fewer.');
  const out = output('Random Number Generation');
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.put(r, c, draw(c));
  return finish(out);
}

/** Sampling: every `period`-th value (periodic) or `count` values drawn at random with replacement. */
export function sampling(values, { method = 'periodic', period = 1, count = 1, seed = null, label = null } = {}) {
  const xs = nums(values);
  if (!xs.length) return fail('Input range holds no numbers.');
  let picked;
  if (method === 'periodic') {
    const p = Math.trunc(period);
    if (!(p >= 1)) return fail('The period must be a whole number of 1 or more.');
    if (p > xs.length) return fail(`The period cannot be more than the ${xs.length} values in the input.`);
    picked = xs.filter((_, i) => (i + 1) % p === 0);
  } else {
    const n = Math.trunc(count);
    if (!(n >= 1 && n <= 1048576)) return fail('The number of samples must be a whole number of 1 or more.');
    const rand = seededRandom(seed);
    picked = Array.from({ length: n }, () => xs[Math.floor(rand() * xs.length)]);
  }
  const out = output('Sampling');
  const top = label ? 1 : 0;
  if (label) out.put(0, 0, label, HEAD);
  picked.forEach((v, i) => out.put(top + i, 0, v));
  return finish(out);
}

/* ---------- Rank and percentile ---------- */

/** Rank and Percentile: each value's position, rank (RANK.EQ, largest first) and PERCENTRANK.INC. */
export function rankAndPercentile(groups) {
  const out = output('Rank and Percentile');
  groups.forEach((g, gi) => {
    const c = gi * 4;
    const pts = g.values.map((v, i) => ({ v, i })).filter((p) => isNum(p.v));
    const xs = pts.map((p) => p.v);
    pts.sort((p, q) => q.v - p.v || p.i - q.i);
    out.table(0, c, ['Point', g.label, 'Rank', 'Percent'], pts.map((p) => [p.i + 1, p.v, call('RANK.EQ', p.v, xs), call('PERCENTRANK.INC', xs, p.v)]));
    pts.forEach((_, i) => out.style(1 + i, c + 3, PERCENT));
  });
  return finish(out);
}

/* ---------- Regression ---------- */

/**
 * Regression of y on one or more x columns by least squares (LINEST with its statistics).
 * options: { confidence (0..1), constantZero, residuals, standardized, residualPlots, lineFitPlots,
 * normalPlot, yLabel, xLabels, yRef, xRefs }. Standardized residuals are the residuals divided by
 * their sample standard deviation, √(SS residual / (n − 1)).
 */
export function regression(y, xs, options = {}) {
  const { confidence = 0.95, constantZero = false, residuals = false, standardized = false, residualPlots = false,
    lineFitPlots = false, normalPlot = false, yLabel = 'Y', xLabels = [], yRef = null, xRefs = [] } = options;
  if (!(confidence > 0 && confidence < 1)) return fail('The confidence level must be between 0% and 100%.');
  const n = y.length, k = xs.length;
  if (!k) return fail('Select at least one X column.');
  if (k > 64) return fail('Regression takes at most 64 X columns.');
  if (xs.some((col) => col.length !== n)) return fail('The Y range and the X range must have the same number of rows.');
  if (y.some((v) => !isNum(v)) || xs.some((col) => col.some((v) => !isNum(v)))) return fail('Regression needs a number in every row of the Y and X ranges.');
  const minRows = k + (constantZero ? 1 : 2);
  if (n < minRows) return fail(`Regression with ${k} X column${k === 1 ? '' : 's'} needs at least ${minRows} rows of data.`);
  const X = matrix(y.map((_, i) => xs.map((col) => col[i])));
  const fit = fnOf('LINEST')([column(y), X, !constantZero, true]);
  if (isError(fit) || !isRange(fit)) return fail('The regression could not be worked out for this data.');
  const s = fit.values;
  const coef = s[0].slice(0, k).reverse(), se = s[1].slice(0, k).reverse();
  const b = s[0][k], seB = s[1][k];
  const [r2, sey] = s[2], [F, df] = s[3], [ssReg, ssRes] = s[4];
  const regDf = k, totalDf = regDf + df;
  const out = output('Regression');
  out.put(0, 0, 'Regression Summary', TITLE);
  let r = out.table(2, 0, ['Regression Statistics', ''], [
    ['Multiple R', Math.sqrt(r2)],
    ['R Square', r2],
    ['Adjusted R Square', 1 - ((1 - r2) * (n - (constantZero ? 0 : 1))) / df],
    ['Standard Error', sey],
    ['Observations', n],
  ]) + 1;
  out.put(r, 0, 'ANOVA');
  r = out.table(r + 1, 0, ['', 'df', 'SS', 'MS', 'F', 'Significance F'], [
    ['Regression', regDf, ssReg, ssReg / regDf, F, call('F.DIST.RT', F, regDf, df)],
    ['Residual', df, ssRes, ssRes / df],
    ['Total', totalDf, ssReg + ssRes],
  ]) + 1;
  const levels = [0.95, ...(Math.abs(confidence - 0.95) > 1e-12 ? [confidence] : [])];
  const pct = (c) => `${+(c * 100).toFixed(4)}%`;
  const header = ['', 'Coefficients', 'Standard Error', 't Stat', 'P-value', ...levels.flatMap((c) => [`Lower ${pct(c)}`, `Upper ${pct(c)}`])];
  const coefRow = (name, c, e) => {
    if (isError(e) || !isNum(e)) return [name, c, NA, NA, NA, ...levels.flatMap(() => [NA, NA])];
    const t = c / e;
    return [name, c, e, t, call('T.DIST.2T', Math.abs(t), df),
      ...levels.flatMap((lv) => { const w = call('T.INV.2T', 1 - lv, df) * e; return [c - w, c + w]; })];
  };
  const coefRows = [constantZero ? ['Intercept', 0, NA, NA, NA, ...levels.flatMap(() => [NA, NA])] : coefRow('Intercept', b, seB),
    ...coef.map((c, j) => coefRow(xLabels[j] || `X Variable ${k === 1 ? '' : j + 1}`.trim(), c, se[j]))];
  r = out.table(r, 0, header, coefRows);
  out.colWidths = Object.fromEntries(header.map((_, c) => [c, c ? 104 : 140]));
  const predicted = y.map((_, i) => (constantZero ? 0 : b) + sum(coef.map((c, j) => c * xs[j][i])));
  const resid = y.map((v, i) => v - predicted[i]);
  const charts = [];
  const chartCol = header.length + 1;
  let residTop = null;
  const wantResiduals = residuals || standardized || residualPlots || lineFitPlots;
  if (wantResiduals) {
    r += 2;
    out.put(r, 0, 'Residual Analysis', TITLE);
    residTop = r + 2;
    const sdRes = Math.sqrt(ssRes / (n - 1));
    out.table(residTop, 0, ['Observation', `Predicted ${yLabel}`, 'Residuals', ...(standardized ? ['Standard Residuals'] : [])],
      y.map((_, i) => [i + 1, predicted[i], resid[i], ...(standardized ? [sdRes ? resid[i] / sdRes : DIV0] : [])]));
  }
  if (normalPlot) {
    const top = residTop ?? r + 4;
    const c0 = wantResiduals ? (standardized ? 5 : 4) : 0;
    out.put(top - 2, c0, 'Normal Probability Data', TITLE);
    const sorted = [...y].sort((p, q) => p - q);
    out.table(top, c0, ['Percentile', yLabel], sorted.map((v, i) => [(100 * (i + 0.5)) / n, v]));
    charts.push({ type: 'scatter', title: 'Normal Probability Plot', ...chartSize, legend: false, xTitle: 'Sample Percentile', yTitle: yLabel,
      series: [{ name: yLabel, categories: { rel: [top + 1, c0, top + n, c0] }, values: { rel: [top + 1, c0 + 1, top + n, c0 + 1] } }] });
  }
  const xSource = (j) => (xRefs[j] ? { abs: xRefs[j] } : { literal: xs[j] });
  const name = (j) => xLabels[j] || `X Variable ${k === 1 ? '' : j + 1}`.trim();
  if (residualPlots) {
    for (let j = 0; j < k; j++) charts.push({ type: 'scatter', title: `${name(j)} Residual Plot`, ...chartSize, legend: false, xTitle: name(j), yTitle: 'Residuals',
      series: [{ name: 'Residuals', categories: xSource(j), values: { rel: [residTop + 1, 2, residTop + n, 2] } }] });
  }
  if (lineFitPlots) {
    for (let j = 0; j < k; j++) charts.push({ type: 'scatter', title: `${name(j)} Line Fit Plot`, ...chartSize, legend: true, xTitle: name(j), yTitle: yLabel,
      series: [{ name: yLabel, categories: xSource(j), values: yRef ? { abs: yRef } : { literal: y } },
        { name: `Predicted ${yLabel}`, categories: xSource(j), values: { rel: [residTop + 1, 1, residTop + n, 1] } }] });
  }
  // Charts stand in a column to the right of the tables, one under the other.
  charts.forEach((ch, i) => { ch.anchor = { r: i * 14, c: chartCol }; out.charts.push(ch); });
  return finish(out);
}

/* ---------- The tools, by name ---------- */

export const TOOLS = [
  ['anova1', 'Anova: Single Factor'],
  ['anova2rep', 'Anova: Two-Factor With Replication'],
  ['anova2', 'Anova: Two-Factor Without Replication'],
  ['correlation', 'Correlation'],
  ['covariance', 'Covariance'],
  ['descriptive', 'Descriptive Statistics'],
  ['smoothing', 'Exponential Smoothing'],
  ['ftest', 'F-Test Two-Sample for Variances'],
  ['fourier', 'Fourier Analysis'],
  ['histogram', 'Histogram'],
  ['moving', 'Moving Average'],
  ['random', 'Random Number Generation'],
  ['rank', 'Rank and Percentile'],
  ['regression', 'Regression'],
  ['sampling', 'Sampling'],
  ['tpaired', 't-Test: Paired Two Sample for Means'],
  ['tequal', 't-Test: Two-Sample Assuming Equal Variances'],
  ['tunequal', 't-Test: Two-Sample Assuming Unequal Variances'],
  ['ztest', 'z-Test: Two Sample for Means'],
];

/* ---------- Writing the output ---------- */

/** The rows and columns a layout covers. */
export function layoutSize(layout) {
  const rows = layout.cells.length;
  const cols = Math.max(1, ...layout.cells.map((row) => row.length));
  return { rows: Math.max(1, rows), cols };
}

/** Whether any cell of the box at (r, c) the layout would cover holds something. */
export function outputOccupied(wb, sheetId, layout, r, c) {
  const { rows, cols } = layoutSize(layout);
  const sheet = wb.sheet(sheetId);
  if (!sheet) return false;
  for (const key of sheet.cells.keys()) {
    const [rr, cc] = key.split(',').map(Number);
    if (rr >= r && rr < r + rows && cc >= c && cc < c + cols) {
      const cell = sheet.cells.get(key);
      if (cell && (cell.v != null && cell.v !== '' || cell.f != null)) return true;
    }
  }
  return false;
}

const absRef = (sheetName, { r1, c1, r2, c2 }) => {
  const a = (r, c) => `$${colName(c)}$${r + 1}`;
  return `${quoteSheet(sheetName)}!${a(r1, c1)}${r1 === r2 && c1 === c2 ? '' : `:${a(r2, c2)}`}`;
};

/** A chart of the layout as the workbook stores it, its sources made references (or literals). */
function chartSpec(wb, sourceWb, chart, sheetName, r0, c0) {
  const rel = ([r1, c1, r2, c2]) => ({ r1: r0 + r1, c1: c0 + c1, r2: r0 + r2, c2: c0 + c2 });
  const literals = {};
  const refOf = (src, key, i) => {
    if (!src) return '';
    if (src.rel) return absRef(sheetName, rel(src.rel));
    if (src.abs && sourceWb === wb) {
      const sheet = wb.sheet(src.abs.sheetId);
      if (sheet) return absRef(sheet.name, src.abs.range);
    }
    // Values from another workbook (the output went to a new one) or given as numbers travel with the chart.
    const values = src.literal || (src.abs ? readRangeColumn(sourceWb, src.abs) : []);
    (literals[i] ||= {})[key] = values.map((v) => (isNum(v) ? v : null));
    return '';
  };
  const sourceRefs = chart.series.map((s, i) => {
    const categories = refOf(s.categories, 'categories', i), values = refOf(s.values, 'values', i);
    return { name: s.name, categories, values, ...(literals[i] ? { literal: literals[i] } : {}) };
  });
  const first = chart.series.find((s) => s.values?.rel)?.values.rel;
  return {
    // The chart's title says what it shows, for people who cannot see it as well.
    type: chart.type, title: chart.title || '', ...(chart.title ? { description: chart.title } : {}), range: first ? rel(first) : { r1: r0, c1: c0, r2: r0, c2: c0 },
    seriesIn: 'cols', headers: false, legend: chart.legend !== false, legendPos: 'bottom',
    xTitle: chart.xTitle || '', yTitle: chart.yTitle || '', ...(chart.secondaryAxis ? { secondaryAxis: true } : {}),
    anchor: { r: r0 + chart.anchor.r, c: c0 + chart.anchor.c }, dx: 0, dy: 0, w: chart.w || 432, h: chart.h || 260, sourceRefs,
  };
}

function readRangeColumn(wb, { sheetId, range }) {
  const out = [];
  for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) out.push(wb.getValue(sheetId, r, c));
  return out;
}

/**
 * Write a layout as one undo step. target: { kind: 'range', sheetId, r, c } or { kind: 'sheet', name }
 * (a new sheet before the active one, the output at A1). `sourceWb` is the workbook the charts' input
 * references point into (another one turns them into literal values). Returns { sheetId, range } or { error }.
 */
export function writeAnalysisOutput(wb, layout, target, { label = layout.title || 'Data analysis', sourceWb = wb } = {}) {
  const { rows, cols } = layoutSize(layout);
  let result = null;
  let problem = null;
  wb.transaction(label, () => {
    let sheetId, r0 = 0, c0 = 0, fresh = false;
    if (target.kind === 'sheet') {
      const name = String(target.name || '').trim();
      if (name && wb.validateSheetName(name)) { problem = wb.validateSheetName(name); return; }
      const index = Math.max(0, wb.sheets.findIndex((s) => s.id === wb.activeSheetId));
      const sheet = wb.addSheet(name || null, index);
      if (!sheet) { problem = 'The workbook would not take a new sheet.'; return; }
      sheetId = sheet.id; fresh = true;
    } else {
      sheetId = target.sheetId; r0 = target.r; c0 = target.c;
    }
    const entries = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cell = layout.cells[r]?.[c];
      if (cell === undefined && fresh) continue;
      const v = cell && typeof cell === 'object' && 'v' in cell ? cell.v : cell ?? null;
      const s = cell && typeof cell === 'object' && 's' in cell ? cell.s : null;
      entries.push({ r: r0 + r, c: c0 + c, cell: v == null && !s ? null : { v, ...(s ? { s } : {}) } });
    }
    wb.ensureSize?.(sheetId, r0 + rows, c0 + cols);
    if (entries.length && !wb.setCells(sheetId, entries, label) && entries.some((e) => e.cell)) {
      const sheet = wb.sheet(sheetId);
      if (sheet?.protected) { problem = 'The output range is on a protected sheet.'; return; }
    }
    if (fresh) for (const [c, w] of Object.entries(layout.colWidths || {})) wb.setColWidth(sheetId, Number(c), w);
    const sheetName = wb.sheet(sheetId).name;
    for (const chart of layout.charts || []) wb.addChart(sheetId, chartSpec(wb, sourceWb, chart, sheetName, r0, c0));
    result = { sheetId, range: { r1: r0, c1: c0, r2: r0 + rows - 1, c2: c0 + cols - 1 } };
  });
  return problem ? { error: problem } : result || { error: 'The output could not be written.' };
}

/** A new workbook of one sheet named `sheetName` holding the layout, for the New Workbook output. */
export function analysisWorkbook(sourceWb, layout, sheetName = 'Sheet1') {
  const book = new Workbook();
  const id = book.activeSheetId;
  if (sheetName && !book.validateSheetName(sheetName, id)) book.renameSheet(id, sheetName);
  for (const [c, w] of Object.entries(layout.colWidths || {})) book.setColWidth(id, Number(c), w);
  const out = writeAnalysisOutput(book, layout, { kind: 'range', sheetId: id, r: 0, c: 0 }, { sourceWb });
  book.clearHistory();
  return out.error ? null : book;
}
