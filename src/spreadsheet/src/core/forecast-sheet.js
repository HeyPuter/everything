/**
 * Data ▸ Forecast Sheet: read a timeline and its values, and build a new sheet holding them with
 * FORECAST.ETS forecasts (and confidence bounds) for the dates that follow, a table of the
 * forecast statistics and a chart of it all, as a spreadsheet's forecast worksheet does.
 */
import { colName } from './cell.js';
import { quoteSheet } from './refs.js';
import { cachedModel, prepareSeries, forecastAt, confidenceAt, statistic } from './forecast-ets.js';
import { numFmtToStyle } from './format.js';
import { maxOf } from './numeric.js';

export const AGGREGATIONS = ['Average', 'Count', 'CountA', 'Max', 'Median', 'Min', 'Sum'];
export const STATISTICS = [['Alpha', 1], ['Beta', 2], ['Gamma', 3], ['MASE', 4], ['SMAPE', 5], ['MAE', 6], ['RMSE', 7]];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The timeline and values a range holds: two columns (or two rows), the first the timeline, with
 * an optional header row of text. Returns { error } with a reason when it is no such range.
 */
export function readForecastSource(wb, sheetId, range) {
  const { r1, c1, r2, c2 } = range;
  const byRows = c2 - c1 === 0 && r2 - r1 === 1; // two rows: the timeline across the first
  if (!byRows && c2 - c1 < 1) return { error: 'Select a timeline column and a column of values beside it' };
  const at = (i, j) => (byRows ? wb.getValue(sheetId, r1 + j, c1 + i) : wb.getValue(sheetId, r1 + i, c1 + j));
  const cellAt = (i, j) => (byRows ? { r: r1 + j, c: c1 + i } : { r: r1 + i, c: c1 + j });
  const length = byRows ? c2 - c1 + 1 : r2 - r1 + 1;
  const header = !isNum(at(0, 0)) && at(0, 0) != null && at(0, 0) !== '' || (!isNum(at(0, 1)) && typeof at(0, 1) === 'string');
  const first = header ? 1 : 0;
  // A timeline in the second column (values first) is read the other way round.
  let tCol = 0, vCol = 1;
  const numericShare = (j) => { let k = 0; for (let i = first; i < length; i++) if (isNum(at(i, j))) k++; return k; };
  if (!byRows && c2 > c1) {
    const a = numericShare(0), b = numericShare(1);
    if (a < (length - first) * 0.7 && b >= (length - first) * 0.7) { tCol = 1; vCol = 0; }
  }
  const points = [];
  for (let i = first; i < length; i++) {
    const x = at(i, tCol), y = at(i, vCol);
    if (x == null || x === '') continue;
    if (!isNum(x)) return { error: 'The timeline must hold dates or numbers' };
    points.push({ x, y: isNum(y) ? y : null, cell: cellAt(i, tCol), valueCell: cellAt(i, vCol) });
  }
  if (points.length < 3) return { error: 'A forecast needs at least three points on its timeline' };
  if (!points.some((p) => p.y != null)) return { error: 'The values must hold numbers' };
  const text = (v, fallback) => (v == null || v === '' ? fallback : String(v));
  return {
    sheetId, range, points,
    timelineHeader: header ? text(at(0, tCol), 'Timeline') : 'Timeline',
    valuesHeader: header ? text(at(0, vCol), 'Values') : 'Values',
    timelineStyle: wb.getCell(sheetId, points[0].cell.r, points[0].cell.c)?.s,
    valuesStyle: wb.getCell(sheetId, points[0].valueCell.r, points[0].valueCell.c)?.s,
  };
}

/** Days since 1899-12-30 for a year, month and day (the day clamped to the month's length). */
function serialOf(y, m, d) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.round((Date.UTC(y, m - 1, Math.min(d, last)) - Date.UTC(1899, 11, 30)) / 864e5);
}
function partsOf(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 864e5);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/**
 * How the timeline steps: { step, next(x, k) } where next is the k-th point after x. Dates a month
 * (or a whole number of months) apart step by calendar months, keeping the day or the month's end.
 */
export function timelineStep(points) {
  const xs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
  const series = prepareSeries(points.map((p) => [p.x, p.y]));
  if (series.error) return { error: 'The timeline needs a constant step between its points' };
  if (series.monthly) {
    const months = series.step;
    const parts = xs.map(partsOf);
    const endOfMonth = parts.every(([y, m, d]) => d === new Date(Date.UTC(y, m, 0)).getUTCDate());
    return {
      step: months, monthly: true,
      next: (x, k) => {
        const [y, m, d] = partsOf(x);
        const total = y * 12 + (m - 1) + months * k;
        const ny = Math.floor(total / 12), nm = (total % 12) + 1;
        return serialOf(ny, nm, endOfMonth ? 31 : d);
      },
    };
  }
  return { step: series.step, monthly: false, next: (x, k) => x + series.step * k };
}

/** Forecast choices a dialog starts from: the end a third of the history past the last point. */
export function forecastDefaults(source) {
  const steps = timelineStep(source.points);
  if (steps.error) return { error: steps.error };
  const last = maxOf(source.points.map((p) => p.x));
  const ahead = Math.max(1, Math.ceil(new Set(source.points.map((p) => p.x)).size / 3));
  return { start: last, end: steps.next(last, ahead), last, steps };
}

/**
 * The rows of the forecast table: history, then the forecast points up to `end`. The forecast is
 * fitted to the history up to `start` (the last point when start is not earlier).
 */
export function forecastRows(source, options) {
  const steps = timelineStep(source.points);
  if (steps.error) return { error: steps.error };
  const history = [...source.points].sort((a, b) => a.x - b.x);
  const last = history[history.length - 1].x;
  const start = Math.min(options.start ?? last, last);
  const fitted = history.filter((p) => p.x <= start);
  if (fitted.length < 3) return { error: 'The forecast must start after at least three points of history' };
  if (!(options.end > start)) return { error: 'The forecast must end after it starts' };
  const future = [];
  for (let k = 1; k <= 10000; k++) {
    const x = steps.next(last, k);
    if (x > options.end + 1e-9) break;
    future.push(x);
  }
  if (!future.length && start === last) return { error: 'The forecast end must be at least one step past the last point' };
  return { history, fitted, future, start, steps };
}

/** Numbers for the dialog's preview chart: history, forecast and bounds per point. */
export function forecastPreview(source, options) {
  const rows = forecastRows(source, options);
  if (rows.error) return rows;
  const opts = { completion: options.completion ?? 1, aggregation: options.aggregation ?? 1 };
  const model = cachedModel(rows.fitted.map((p) => [p.x, p.y]), opts, options.seasonality ?? 1);
  if (model.error) return { error: 'These values cannot be forecast: the timeline needs a constant step' };
  const level = options.confidence ?? 0.95;
  const points = [];
  for (const p of rows.history) points.push({ x: p.x, value: p.y });
  const startIndex = points.findIndex((p) => p.x >= rows.start);
  if (startIndex >= 0) Object.assign(points[startIndex], { forecast: points[startIndex].value, lower: points[startIndex].value, upper: points[startIndex].value });
  const forecastOf = (x, into) => {
    const f = forecastAt(model, x);
    if (typeof f !== 'number') return;
    into.forecast = f;
    if (options.showConfidence !== false) {
      const c = confidenceAt(model, x, level);
      if (typeof c === 'number') { into.lower = f - c; into.upper = f + c; }
    }
  };
  for (const p of points) if (p.x > rows.start) forecastOf(p.x, p);
  for (const x of rows.future) { const p = { x, value: null }; forecastOf(x, p); points.push(p); }
  return { points, model, rows };
}

/**
 * Build the forecast worksheet as one undo step. options: { start, end, confidence (0..1),
 * showConfidence, seasonality (1 automatic, else a length), completion (1 interpolate, 0 zeros),
 * aggregation (1..7), statistics, chartType: 'line' | 'column' }. Returns { sheetId } or { error }.
 */
export function createForecastSheet(wb, source, options) {
  const rows = forecastRows(source, options);
  if (rows.error) return rows;
  const season = options.seasonality ?? 1, fill = options.completion ?? 1, agg = options.aggregation ?? 1;
  const level = options.confidence ?? 0.95, withBounds = options.showConfidence !== false;
  const { history, future, start } = rows;
  const total = history.length + future.length;
  const lastRow = total; // the header is row 0
  const fittedEnd = history.filter((p) => p.x <= start).length; // rows 1..fittedEnd hold the fitted history
  const V = `$B$2:$B$${fittedEnd + 1}`, T = `$A$2:$A$${fittedEnd + 1}`;
  const tail = `${season},${fill},${agg}`;
  const valuesName = source.valuesHeader;
  const headers = [source.timelineHeader, valuesName, `Forecast(${valuesName})`];
  if (withBounds) headers.push(`Lower Confidence Bound(${valuesName})`, `Upper Confidence Bound(${valuesName})`);
  const entries = [];
  const put = (r, c, cell) => entries.push({ r, c, cell });
  headers.forEach((h, c) => put(0, c, { v: h }));
  const tStyle = source.timelineStyle, vStyle = source.valuesStyle;
  history.forEach((p, i) => {
    const r = i + 1;
    put(r, 0, { v: p.x, ...(tStyle ? { s: tStyle } : {}) });
    if (p.y != null) put(r, 1, { v: p.y, ...(vStyle ? { s: vStyle } : {}) });
  });
  future.forEach((x, i) => put(history.length + 1 + i, 0, { v: x, ...(tStyle ? { s: tStyle } : {}) }));
  // The forecast columns start on the last fitted point, where they meet the history.
  const join = fittedEnd;
  const joinValue = history[join - 1].y;
  if (joinValue != null) {
    put(join, 2, { v: joinValue, ...(vStyle ? { s: vStyle } : {}) });
    if (withBounds) { put(join, 3, { v: joinValue, ...(vStyle ? { s: vStyle } : {}) }); put(join, 4, { v: joinValue, ...(vStyle ? { s: vStyle } : {}) }); }
  }
  for (let r = join + 1; r <= lastRow; r++) {
    const a = `A${r + 1}`;
    put(r, 2, { f: `FORECAST.ETS(${a},${V},${T},${tail})`, ...(vStyle ? { s: vStyle } : {}) });
    if (withBounds) {
      const ci = `FORECAST.ETS.CONFINT(${a},${V},${T},${level},${tail})`;
      put(r, 3, { f: `C${r + 1}-${ci}`, ...(vStyle ? { s: vStyle } : {}) });
      put(r, 4, { f: `C${r + 1}+${ci}`, ...(vStyle ? { s: vStyle } : {}) });
    }
  }
  const lastCol = headers.length - 1;
  const statsCol = lastCol + 2;
  if (options.statistics) {
    put(0, statsCol, { v: 'Statistic' });
    put(0, statsCol + 1, { v: 'Value' });
    STATISTICS.forEach(([name, type], i) => {
      put(i + 1, statsCol, { v: name });
      put(i + 1, statsCol + 1, { f: `FORECAST.ETS.STAT(${V},${T},${type},${tail})`, s: numFmtToStyle('0.000') });
    });
  }
  let sheetId = null;
  wb.transaction('Create forecast worksheet', () => {
    const sheet = wb.addSheet();
    if (!sheet) return;
    sheetId = sheet.id;
    wb.setCells(sheetId, entries, 'Create forecast worksheet');
    wb.addTable?.(sheetId, { r1: 0, c1: 0, r2: lastRow, c2: lastCol }, { style: 'blue' });
    if (options.statistics) wb.addTable?.(sheetId, { r1: 0, c1: statsCol, r2: STATISTICS.length, c2: statsCol + 1 }, { style: 'blue' });
    wb.setColWidth(sheetId, 0, 96);
    for (let c = 1; c <= lastCol; c++) wb.setColWidth(sheetId, c, c === 1 ? 88 : 150);
    if (options.statistics) wb.setColWidth(sheetId, statsCol, 80);
    const name = quoteSheet(sheet.name);
    const cats = `${name}!$A$2:$A$${lastRow + 1}`;
    const series = headers.slice(1).map((h, i) => ({ name: h, nameRef: `${name}!$${colName(i + 1)}$1`, categories: cats, values: `${name}!$${colName(i + 1)}$2:$${colName(i + 1)}$${lastRow + 1}` }));
    wb.addChart(sheetId, {
      type: options.chartType === 'column' ? 'column' : 'line',
      range: { r1: 0, c1: 0, r2: lastRow, c2: lastCol },
      seriesIn: 'cols', headers: true, legend: true, legendPos: 'bottom', title: '',
      anchor: { r: options.statistics ? STATISTICS.length + 2 : 1, c: statsCol }, dx: 0, dy: 0, w: 480, h: 288,
      sourceRefs: series,
      ...(options.chartType === 'column' ? {} : { colors: ['#4472c4', '#ed7d31', '#a5a5a5', '#a5a5a5'] }),
    });
  });
  return sheetId ? { sheetId } : { error: 'The workbook would not take a new sheet' };
}

export { statistic };
