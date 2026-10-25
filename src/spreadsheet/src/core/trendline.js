/**
 * Chart trendlines, as Format Trendline offers them: the fit of each kind, its R², its forecast and the
 * equation written beside it on the chart. Pure: points in, a fit out.
 *
 * trend = {
 *   type: 'linear' | 'exp' | 'log' | 'poly' | 'power' | 'movingAvg',
 *   order: 2–6,                      a polynomial's degree
 *   period: 2–255,                   how many points a moving average takes
 *   forward, backward: number,       forecast past the last x and before the first, in x units
 *   intercept: number | null,        the value at x = 0 the fit is forced through (linear, exponential, polynomial)
 *   dispEq, dispRSqr: boolean,       write the equation and R² beside the line
 *   name: string,                    the trendline's own name ('' names it for its kind and series)
 *   labelFormat?: string,            the label's number format (General when absent)
 *   color?, width?, dash?,           the line's own colour, width (px) and dash; else the series' colour, dashed
 * }
 *
 * A chart keeps `trendline: boolean` (it draws trendlines) and `trendlines`, one trend per series: absent
 * draws a linear one, false none on that series.
 */
import { maxOf, minOf } from './numeric.js';

export const TREND_TYPES = Object.freeze([['linear', 'Linear'], ['exp', 'Exponential'], ['log', 'Logarithmic'], ['poly', 'Polynomial'],
  ['power', 'Power'], ['movingAvg', 'Moving Average']]);
const TYPES = new Set(TREND_TYPES.map(([t]) => t));
// The kinds whose fit can be forced through an intercept, as Excel offers Set Intercept.
export const INTERCEPT_TYPES = new Set(['linear', 'exp', 'poly']);
// The names a trendline takes in the legend, as Excel gives them: "Linear (Sales)", "2 per. Mov. Avg. (Sales)".
const SHORT_NAMES = { linear: 'Linear', exp: 'Expon.', log: 'Log.', poly: 'Poly.', power: 'Power' };
const HEX = /^#[0-9a-f]{6}$/i;
// The line dashes DrawingML names (CHART_LINE_DASHES draws them).
const DASHES = new Set(['solid', 'dot', 'dash', 'lgDash', 'dashDot', 'lgDashDot', 'lgDashDotDot', 'sysDash', 'sysDot', 'sysDashDot', 'sysDashDotDot']);

const between = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

/** A trend with every option in range; anything else stays at Excel's default. */
export function normalizeTrend(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    type: TYPES.has(t.type) ? t.type : 'linear',
    order: Number.isInteger(t.order) && t.order >= 2 && t.order <= 6 ? t.order : 2,
    period: Number.isInteger(t.period) && t.period >= 2 && t.period <= 255 ? t.period : 2,
    forward: between(t.forward, 0, 1e15) ? t.forward : 0,
    backward: between(t.backward, 0, 1e15) ? t.backward : 0,
    intercept: Number.isFinite(t.intercept) ? t.intercept : null,
    dispEq: t.dispEq === true,
    dispRSqr: t.dispRSqr === true,
    name: typeof t.name === 'string' ? t.name.slice(0, 255) : '',
    ...(typeof t.labelFormat === 'string' && t.labelFormat.trim() && t.labelFormat !== 'General' ? { labelFormat: t.labelFormat.slice(0, 255) } : {}),
    ...(HEX.test(t.color || '') ? { color: t.color.toLowerCase() } : {}),
    ...(between(t.width, 0.25, 20) ? { width: t.width } : {}),
    ...(DASHES.has(t.dash) ? { dash: t.dash } : {}),
  };
}

export const DEFAULT_TREND = Object.freeze(normalizeTrend({}));

/** A chart's per-series trends: a normalized trend, or false for a series that has none. */
export function normalizeTrendlines(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.slice(0, 255).map(t => (t === false || t === null ? false : normalizeTrend(t)));
}

/** The trend drawn on series `j`, or null when it draws none. */
export function trendFor(chart, j) {
  if (!chart?.trendline) return null;
  const t = chart.trendlines?.[j];
  return t === false ? null : t || DEFAULT_TREND;
}

/** Does any of the chart's `seriesCount` series draw a trendline? */
export const hasTrendlines = (chart, seriesCount) => !!chart?.trendline && Array.from({ length: Math.max(1, seriesCount) }, (_, j) => trendFor(chart, j)).some(Boolean);

/** The trendline's name in the legend and tooltips: its own, or its kind's and its series'. */
export function trendName(trend, seriesName) {
  if (trend.name) return trend.name;
  const kind = trend.type === 'movingAvg' ? `${trend.period} per. Mov. Avg.` : SHORT_NAMES[trend.type];
  return `${kind} (${seriesName})`;
}

/**
 * Solve the least-squares problem A·c ≈ y by Householder QR: c, or null where the columns are not
 * independent (fewer distinct x than coefficients). A is given by its columns.
 */
function leastSquares(columns, y) {
  const m = y.length, k = columns.length;
  if (m < k || !k) return null;
  const A = columns.map(col => Float64Array.from(col)), b = Float64Array.from(y);
  const diag = new Float64Array(k);
  let scale = 0;
  for (const col of A) for (const v of col) scale = Math.max(scale, Math.abs(v));
  for (let j = 0; j < k; j++) {
    const col = A[j];
    let norm = 0;
    for (let i = j; i < m; i++) norm = Math.hypot(norm, col[i]);
    if (!(norm > scale * 1e-12)) return null;
    const alpha = col[j] > 0 ? -norm : norm;
    // v = x − alpha·e₁, kept in col[j..]; R's diagonal entry is alpha.
    col[j] -= alpha;
    let vv = 0;
    for (let i = j; i < m; i++) vv += col[i] * col[i];
    const reflect = target => {
      let dot = 0;
      for (let i = j; i < m; i++) dot += col[i] * target[i];
      const s = 2 * dot / vv;
      for (let i = j; i < m; i++) target[i] -= s * col[i];
    };
    for (let c = j + 1; c < k; c++) reflect(A[c]);
    reflect(b);
    diag[j] = alpha;
  }
  const c = new Float64Array(k);
  for (let j = k - 1; j >= 0; j--) {
    let s = b[j];
    for (let q = j + 1; q < k; q++) s -= A[q][j] * c[q];
    c[j] = s / diag[j];
  }
  return [...c].every(Number.isFinite) ? [...c] : null;
}

// Binomial coefficients up to the sixth power.
const binomial = (n, r) => { let out = 1; for (let i = 1; i <= r; i++) out = out * (n - r + i) / i; return out; };

/**
 * A polynomial of `degree` through the points (degree 1 is a line), forced through `intercept` at
 * x = 0 when one is given: { coefficients (ascending powers of x), predict }, or null.
 * The fit is made over x scaled to about [-1, 1], which keeps the sixth power of a date in range;
 * the curve is drawn from that form, the equation from its coefficients in x.
 */
function polyFit(xs, ys, degree, intercept) {
  const forced = intercept != null;
  const lo = minOf(xs), hi = maxOf(xs);
  // A forced intercept is the value at x = 0, so x is only scaled, not moved.
  const centre = forced ? 0 : (lo + hi) / 2;
  const half = forced ? Math.max(Math.abs(lo), Math.abs(hi)) || 1 : (hi - lo) / 2 || 1;
  const ts = xs.map(x => (x - centre) / half);
  const first = forced ? 1 : 0;
  const columns = [];
  for (let p = first; p <= degree; p++) columns.push(ts.map(t => t ** p));
  const solved = leastSquares(columns, forced ? ys.map(y => y - intercept) : ys);
  if (!solved) return null;
  const d = forced ? [intercept, ...solved] : solved;
  const predict = x => { const t = (x - centre) / half; let v = 0; for (let p = degree; p >= 0; p--) v = v * t + d[p]; return v; };
  // Σ d_p ((x − centre) / half)^p, expanded into powers of x.
  const coefficients = new Array(degree + 1).fill(0);
  for (let p = 0; p <= degree; p++) {
    for (let q = 0; q <= p; q++) coefficients[q] += d[p] / half ** p * binomial(p, q) * (-centre) ** (p - q);
  }
  if (forced) coefficients[0] = intercept;
  // A term that moves the curve by less than rounding does over these points is rounding: y = -x, not -x + 4E-16.
  const reach = maxOf(xs.map(Math.abs)), size = maxOf(ys.map(Math.abs));
  coefficients.forEach((c, p) => { if (Math.abs(c) * reach ** p < size * 1e-12 && !(forced && p === 0)) coefficients[p] = 0; });
  return coefficients.every(Number.isFinite) ? { coefficients, predict } : null;
}

/** R² of predictions against values: around their mean, or (with a forced intercept) around that intercept. */
function rSquared(ys, predicted, about = null) {
  const mean = about ?? ys.reduce((a, y) => a + y, 0) / ys.length;
  let sse = 0, sst = 0;
  ys.forEach((y, i) => { sse += (y - predicted[i]) ** 2; sst += (y - mean) ** 2; });
  if (!sst) return sse ? null : 1;
  const r2 = 1 - sse / sst;
  return Number.isFinite(r2) ? r2 : null;
}

/**
 * The trend through [[x, y], ...]: { type, predict, points? (a moving average's), terms (for the equation),
 * r2, lo, hi (the x it spans, its forecast included) }, or null where the kind cannot fit these points:
 * too few of them, an exponential or power fit over a value at or below zero, a logarithmic or power fit
 * over an x at or below zero, as Excel declines them.
 */
export function fitTrend(points, trend = DEFAULT_TREND) {
  const pts = (points || []).filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const { type } = trend;
  if (type === 'movingAvg') {
    const period = trend.period;
    if (pts.length < period) return null;
    const out = [];
    let sum = 0;
    pts.forEach(([x, y], i) => {
      sum += y;
      if (i >= period) sum -= pts[i - period][1];
      if (i >= period - 1) out.push([x, sum / period]);
    });
    if (!out.every(p => Number.isFinite(p[1]))) return null;
    return { type, points: out, terms: null, r2: null, lo: minOf(out.map(p => p[0])), hi: maxOf(out.map(p => p[0])) };
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const degree = type === 'poly' ? trend.order : 1;
  if (pts.length < degree + 1) return null;
  const logX = type === 'log' || type === 'power', logY = type === 'exp' || type === 'power';
  if (logX && xs.some(x => x <= 0) || logY && ys.some(y => y <= 0)) return null;
  const fx = logX ? xs.map(Math.log) : xs, fy = logY ? ys.map(Math.log) : ys;
  // A forced intercept is the curve's value at x = 0: an exponential's a, fitted as ln a.
  let intercept = INTERCEPT_TYPES.has(type) ? trend.intercept : null;
  if (intercept != null && type === 'exp') {
    if (!(intercept > 0)) return null;
    intercept = Math.log(intercept);
  }
  const fit = polyFit(fx, fy, degree, intercept);
  if (!fit) return null;
  const r2 = rSquared(fy, fx.map(fit.predict), intercept);
  const [c0, c1] = fit.coefficients;
  let predict, terms;
  if (type === 'exp') { predict = x => Math.exp(c0) * Math.exp(c1 * x); terms = { form: 'exp', a: Math.exp(c0), b: c1 }; }
  else if (type === 'power') { predict = x => Math.exp(c0) * x ** c1; terms = { form: 'power', a: Math.exp(c0), b: c1 }; }
  else if (type === 'log') { predict = x => c1 * Math.log(x) + c0; terms = { form: 'log', a: c1, b: c0 }; }
  else { predict = fit.predict; terms = { form: 'poly', coefficients: fit.coefficients }; }
  if (!Number.isFinite(terms.a ?? 0) || !Number.isFinite(terms.b ?? 0)) return null;
  const first = minOf(xs), last = maxOf(xs);
  // A logarithmic or power curve has nothing at or before x = 0: its backward forecast stops short of it.
  const back = first - trend.backward;
  return { type, predict, terms, r2, lo: logX && back <= 0 ? first : back, hi: last + trend.forward };
}

/**
 * Points along the fit to draw it by: a moving average's own points; a line's two ends where `straight`
 * (both axes linear); otherwise `count` steps across its span.
 */
export function trendPoints(fit, { straight = true, count = 96 } = {}) {
  if (fit.points) return fit.points;
  const steps = fit.type === 'linear' && straight ? 1 : count;
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const x = k === steps ? fit.hi : fit.lo + (fit.hi - fit.lo) * k / steps;
    out.push([x, fit.predict(x)]);
  }
  return out;
}

/**
 * A number as a trendline label writes it in General: four decimals at most, and powers of ten for
 * the very small or very large ("6E-05", "1.2346E+12"). A format code of the label's own takes over.
 */
export function trendNumber(v, format = null) {
  if (format) return format(v);
  if (v === 0 || Object.is(v, -0)) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e-4 && abs < 1e11) {
    const text = String(Math.round(v * 1e4) / 1e4);
    return /e/i.test(text) ? v.toFixed(4).replace(/\.?0+$/, '') : text;
  }
  const [mantissa, exponent] = v.toExponential(4).split('e');
  const e = Number(exponent);
  return `${mantissa.replace(/\.?0+$/, '')}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

/**
 * The equation as runs of text, each { text, sup }: a superscript run is an exponent ("x²" is
 * [{ text: 'x' }, { text: '2', sup: true }]). Terms whose coefficient is zero are left out, and a
 * negative one joins with a minus: "y = 0.5x² - 2x + 1", "y = 1.5e^0.3x", "y = 2ln(x) - 1", "y = 3x^1.5".
 */
export function trendEquation(fit, format = null) {
  const num = v => trendNumber(v, format);
  const t = fit.terms;
  if (!t) return null;
  const runs = [{ text: 'y = ' }];
  const add = (text, sup = false) => { const last = runs.at(-1); if (!!last.sup === sup) last.text += text; else runs.push({ text, sup }); };
  if (t.form === 'exp') { add(`${num(t.a)}e`); add(`${num(t.b)}x`, true); return runs; }
  if (t.form === 'power') { add(`${num(t.a)}x`); add(num(t.b), true); return runs; }
  // A polynomial (a line is one of degree one) and a logarithmic fit: highest power first.
  const terms = t.form === 'log' ? [[t.a, 'ln(x)', null], [t.b, '', null]]
    : t.coefficients.map((c, p) => [c, p ? 'x' : '', p > 1 ? String(p) : null]).reverse();
  let any = false;
  for (const [c, unit, power] of terms) {
    const text = num(Math.abs(c));
    if (text === '0') continue;
    add(any ? (c < 0 ? ' - ' : ' + ') : c < 0 ? '-' : '');
    // A coefficient of one is left off its x, as Excel writes "y = x + 1".
    add(`${text === '1' && unit ? '' : text}${unit}`);
    if (power) add(power, true);
    any = true;
  }
  if (!any) add('0');
  return runs;
}

/** The equation as plain text, exponents after a caret: for tooltips and screen readers. */
export const trendEquationText = (fit, format = null) => (trendEquation(fit, format) || []).map(r => (r.sup ? `^${r.text}` : r.text)).join('');

/** The R² line of a trendline's label. */
export const trendRSquaredText = (fit, format = null) => (fit.r2 == null ? null : `R² = ${trendNumber(fit.r2, format)}`);

/** Why the trend draws nothing through these points, as a sentence for the Format pane; null where it fits them. */
export function trendProblem(points, trend) {
  if (fitTrend(points, trend)) return null;
  const pts = (points || []).filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const { type } = trend;
  if (type === 'movingAvg') return `A moving average over ${trend.period} points needs at least ${trend.period} of them.`;
  if ((type === 'exp' || type === 'power') && pts.some(p => p[1] <= 0)) return `${type === 'exp' ? 'An exponential' : 'A power'} trendline needs every value above zero.`;
  if ((type === 'log' || type === 'power') && pts.some(p => p[0] <= 0)) return `A ${type === 'log' ? 'logarithmic' : 'power'} trendline needs every x value above zero.`;
  if (type === 'exp' && trend.intercept != null && !(trend.intercept > 0)) return 'An exponential trendline can only be set to cross above zero.';
  const need = type === 'poly' ? trend.order + 1 : 2;
  return `This trendline needs at least ${need} points with different x values.`;
}
