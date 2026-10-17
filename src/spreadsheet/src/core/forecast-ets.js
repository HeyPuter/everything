/**
 * Exponential triple smoothing (AAA: additive error, trend and seasonality) behind
 * FORECAST.ETS, FORECAST.ETS.CONFINT, FORECAST.ETS.SEASONALITY and FORECAST.ETS.STAT.
 *
 * What was measured against Excel (see tests/forecast-ets.test.js for the recorded values):
 * - The model is the error-correction form: f = l + b + s[t-m], e = y - f,
 *   l += b + αe, b += βe, s[t] = s[t-m] + γe. Its forecast h steps past the last point is
 *   l + h·b + s, and Excel answers a target inside the timeline from that same line.
 * - Without seasonality the level starts at the first value and the trend at the least-squares
 *   slope of all the points: given the α and β Excel reports, its forecasts and statistics
 *   match to the last digit. With seasonality the trend starts at the slope with a constant per season
 *   and the seasonal offsets at the season means about it, close to (not exactly) Excel's start.
 * - The accuracy statistics (MAE, RMSE, SMAPE) cover the last few one-step errors: all of them up
 *   to 10 points, then 40% of the points up to 10, then 20%; MASE scales MAE by the mean change
 *   between neighbouring points before that window. CONFINT's σ is the root mean square of all
 *   the one-step errors, widened per step by the model's (α + jβ + γ at whole seasons)².
 * - Excel's α, β and γ fall on a handful of values (0.001, 0.1, 0.125, 0.25, 0.5, 0.75, 0.9, 0.999
 *   and those ±0.001); its optimiser is not documented. This one searches the same values for the
 *   smallest squared one-step error.
 * - Seasonality is detected from the peaks of the autocorrelation of the detrended values.
 */

import { maxOf, minOf } from './numeric.js';

const AGGREGATES = [null,
  (v) => v.reduce((a, b) => a + b, 0) / v.length, // 1 AVERAGE
  (v) => v.length, // 2 COUNT
  (v) => v.length, // 3 COUNTA
  (v) => maxOf(v), // 4 MAX
  (v) => { const s = [...v].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }, // 5 MEDIAN
  (v) => minOf(v), // 6 MIN
  (v) => v.reduce((a, b) => a + b, 0), // 7 SUM
];

export const MAX_SEASONALITY = 8760;
const MAX_MISSING = 0.3;

/** Days since 1899-12-30 as [year, month, day]. */
function ymd(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 864e5);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Timeline points on a calendar of months: every date on one day of the month, or every date the
 * month's last day. Returns a position function (months, fractional between two month dates) or null.
 */
function monthCalendar(xs) {
  if (xs.length < 2 || !xs.every((x) => Number.isInteger(x) && x > 0)) return null;
  const parts = xs.map(ymd);
  const months = new Set(parts.map(([y, m]) => y * 12 + m));
  if (months.size < 2 || months.size !== new Set(xs).size) return null;
  const day = parts[0][2];
  const endOfMonth = parts.every(([y, m, d]) => d === daysInMonth(y, m));
  if (!endOfMonth && !parts.every((p) => p[2] === day)) return null;
  const anchor = (y, m) => (endOfMonth ? daysInMonth(y, m) : Math.min(day, daysInMonth(y, m)));
  return (serial) => {
    const [y, m, d] = ymd(serial);
    const index = y * 12 + m;
    const here = anchor(y, m);
    if (d === here) return index;
    // Between this month's date and the next (or the previous) one, by days.
    if (d > here) {
      const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
      const span = daysInMonth(y, m) - here + anchor(ny, nm);
      return index + (d - here) / span;
    }
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const span = daysInMonth(py, pm) - anchor(py, pm) + here;
    return index - (here - d) / span;
  };
}

/** The most common positive difference between consecutive (sorted, distinct) points. */
function commonStep(sorted) {
  const counts = new Map();
  for (let i = 1; i < sorted.length; i++) {
    const d = +(sorted[i] - sorted[i - 1]).toPrecision(12);
    if (d > 0) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = 0, bestCount = 0;
  for (const [d, c] of counts) if (c > bestCount || (c === bestCount && d < best)) { best = d; bestCount = c; }
  return best;
}

/**
 * The series on an even timeline: { y, step, stepStat, toIndex(x) } or { error }.
 * `points` are [x, y] pairs, y null where the value is missing (blank or text).
 */
export function prepareSeries(points, { completion = 1, aggregation = 1 } = {}) {
  if (!(completion === 0 || completion === 1)) return { error: '#NUM!' };
  if (!AGGREGATES[aggregation]) return { error: '#NUM!' };
  if (points.length < 2) return { error: '#VALUE!' };
  const xs = points.map((p) => p[0]);
  const months = monthCalendar(xs);
  const pos = months || ((x) => x);
  const located = points.map(([x, y]) => [pos(x), y]);
  const distinct = [...new Set(located.map((p) => p[0]))].sort((a, b) => a - b);
  if (distinct.length < 2) return { error: '#NUM!' };
  const step = commonStep(distinct);
  if (!(step > 0)) return { error: '#NUM!' };
  const origin = distinct[0];
  const toIndex = (x) => (pos(x) - origin) / step;
  const buckets = new Map();
  for (const [x, y] of located) {
    const k = Math.round((x - origin) / step);
    if (!buckets.has(k)) buckets.set(k, []);
    if (y != null) buckets.get(k).push(y);
  }
  const count = maxOf(buckets.keys()) + 1;
  const raw = new Array(count).fill(null);
  for (const [k, v] of buckets) if (v.length) raw[k] = AGGREGATES[aggregation](v);
  const missing = raw.filter((v) => v == null).length;
  if (missing > MAX_MISSING * count) return { error: '#NUM!' };
  if (raw[0] == null || raw[count - 1] == null) {
    // A blank at either end has one neighbour: it takes that value.
    if (raw[0] == null) raw[0] = completion ? raw.find((v) => v != null) : 0;
    if (raw[count - 1] == null) raw[count - 1] = completion ? [...raw].reverse().find((v) => v != null) : 0;
  }
  const y = raw.slice();
  for (let i = 1; i < count - 1; i++) {
    if (y[i] != null) continue;
    let j = i; while (raw[j] == null) j++;
    // A run of missing points is drawn on the straight line between its neighbours (or set to zero).
    for (let k = i; k < j; k++) y[k] = completion ? y[i - 1] + (raw[j] - y[i - 1]) * (k - i + 1) / (j - i + 1) : 0;
    i = j;
  }
  const stepStat = months ? (step % 12 === 0 ? 365 * step / 12 : 31 * step) : step;
  return { y, step, stepStat, toIndex, monthly: !!months };
}

/* ---------- Seasonality ---------- */

function slopeOf(y) {
  const n = y.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  let my = 0; for (const v of y) my += v; my /= n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (y[i] - my); sxx += (i - mx) ** 2; }
  return sxx ? sxy / sxx : 0;
}

/** The season length the values repeat over, or 0: the strongest autocorrelation peak of the detrended values. */
export function detectSeasonality(y) {
  const n = y.length;
  if (n < 4) return 0;
  const b = slopeOf(y), mean = y.reduce((a, v) => a + v, 0) / n;
  const z = y.map((v, i) => v - mean - b * (i - (n - 1) / 2));
  let den = 0; for (const v of z) den += v * v;
  if (!(den > 1e-12 * n * (Math.abs(mean) + 1) ** 2)) return 0;
  const maxLag = Math.floor((n - 1) / 3); // a pattern has to repeat three times to count
  const acf = [];
  for (let k = 1; k <= maxLag + 1; k++) {
    let num = 0; for (let i = 0; i + k < n; i++) num += z[i] * z[i + k];
    acf[k] = num / den;
  }
  let best = 0, bestValue = 0.3;
  for (let k = 2; k <= maxLag; k++) {
    const peak = acf[k] > acf[k - 1] && acf[k] >= (acf[k + 1] ?? -Infinity);
    if (peak && acf[k] > bestValue) { best = k; bestValue = acf[k]; }
  }
  return Math.min(best, MAX_SEASONALITY);
}

/* ---------- The model ---------- */

/** Initial trend and seasonal offsets (summing to zero) for season length m. */
function initialState(y, m) {
  const n = y.length;
  if (!m) return { b: slopeOf(y), S: null };
  let sxy = 0, sxx = 0;
  const mt = [], my = [];
  for (let ph = 0; ph < m; ph++) {
    let st = 0, sy = 0, c = 0;
    for (let t = ph; t < n; t += m) { st += t; sy += y[t]; c++; }
    mt[ph] = c ? st / c : ph; my[ph] = c ? sy / c : y[n - 1];
    for (let t = ph; t < n; t += m) { sxy += (t - mt[ph]) * (y[t] - my[ph]); sxx += (t - mt[ph]) ** 2; }
  }
  const b = sxx ? sxy / sxx : slopeOf(y);
  const S = my.map((v, ph) => v - b * mt[ph]);
  const mu = S.reduce((a, v) => a + v, 0) / m;
  return { b, S: S.map((v) => v - mu) };
}

/** Run the smoothing over the values; returns the final state and the one-step errors and forecasts. */
function smooth(y, m, alpha, beta, gamma, init) {
  const n = y.length;
  const seas = m ? new Array(n) : null;
  let b = init.b;
  let l = y[0] - (m ? init.S[0] : 0);
  if (m) seas[0] = init.S[0];
  const errors = new Array(n), fitted = new Array(n);
  errors[0] = 0; fitted[0] = y[0];
  let sse = 0;
  for (let t = 1; t < n; t++) {
    const sp = m ? (t >= m ? seas[t - m] : init.S[t % m]) : 0;
    const f = l + b + sp, e = y[t] - f;
    fitted[t] = f; errors[t] = e; sse += e * e;
    l = f - sp + alpha * e;
    b += beta * e;
    if (m) seas[t] = sp + gamma * e;
  }
  return { l, b, seas, errors, fitted, sse };
}

const GRID = [0.002, 0.1, 0.125, 0.126, 0.25, 0.251, 0.5, 0.501, 0.75, 0.751, 0.9, 0.998];
const TREND_GRID = [0.001, 0.1, 0.25, 0.5];
const SEASON_GRID = [0.001, 0.125, 0.25, 0.5, 0.75];

/** The number of final one-step errors the accuracy statistics cover. */
export function statWindow(n) {
  if (n <= 10) return n;
  return Math.max(Math.min(Math.floor(0.4 * n), 10), Math.ceil(0.2 * n));
}

/**
 * Fit the model. `seasonality`: 1 (or undefined) detects it, 0 means none, otherwise the season length.
 * Returns the model or { error }.
 */
export function fitEts(series, seasonality = 1, fixed = null) {
  const { y } = series;
  const n = y.length;
  let m = seasonality === 1 ? detectSeasonality(y) : seasonality;
  if (m >= n || m < 2) m = 0;
  const init = initialState(y, m);
  let best = null;
  if (fixed) {
    best = { ...fixed, run: smooth(y, m, fixed.alpha, fixed.beta, fixed.gamma, init) };
  } else if (n <= 2) {
    best = { alpha: 0.9, beta: 0.001, gamma: 0, run: smooth(y, 0, 0.9, 0.001, 0, init) };
  } else {
    for (const alpha of GRID) for (const beta of TREND_GRID) for (const gamma of m ? SEASON_GRID : [0]) {
      const run = smooth(y, m, alpha, beta, gamma, init);
      if (!best || run.sse < best.run.sse - 1e-12 * (1 + best.run.sse)) best = { alpha, beta, gamma, run };
    }
  }
  // Values the model fits exactly (constant, or on a straight line) leave every choice equal: α is then reported as 0.9.
  if (!fixed && n > 2 && !(best.run.sse > 1e-20 * (1 + y.reduce((a, v) => a + v * v, 0)))) {
    best = { alpha: 0.9, beta: 0.001, gamma: 0.001, run: smooth(y, m, 0.9, 0.001, 0.001, init) };
  }
  const { run } = best;
  const L = statWindow(n);
  let sae = 0, sse = 0, sape = 0;
  for (let t = n - L; t < n; t++) {
    const e = run.errors[t];
    sae += Math.abs(e); sse += e * e;
    const d = Math.abs(y[t]) + Math.abs(run.fitted[t]);
    if (d) sape += 2 * Math.abs(e) / d;
  }
  // MASE scales by the naive one-step error over the points before the statistics window.
  const train = L < n ? n - L : n;
  let naive = 0; for (let t = 1; t < train; t++) naive += Math.abs(y[t] - y[t - 1]);
  naive = train > 1 ? naive / (train - 1) : 0;
  const mae = sae / L;
  let sseAll = 0; for (const e of run.errors) sseAll += e * e;
  return {
    m, n, alpha: best.alpha, beta: best.beta, gamma: m ? best.gamma : 2.220446049250313e-16,
    l: run.l, b: run.b, seas: run.seas,
    mae, rmse: Math.sqrt(sse / L), smape: sape / L, mase: naive ? mae / naive : 0,
    sigma: Math.sqrt(sseAll / n),
    step: series.stepStat, toIndex: series.toIndex, last: n - 1,
  };
}

/** The forecast h steps (any real number) past the last point. */
function lineAt(model, h) {
  const { l, b, m, seas, n } = model;
  if (!m) return l + h * b;
  const at = (k) => { const phase = (((k - 1) % m) + m) % m; return seas[n - m + phase]; };
  const k = Math.floor(h), frac = h - k;
  const base = l + h * b;
  return frac ? base + at(k) + frac * (at(k + 1) - at(k)) : base + at(k);
}

/** FORECAST.ETS for one target, or { error }. */
export function forecastAt(model, target) {
  const h = model.toIndex(target) - model.last;
  if (model.toIndex(target) < -1e-9) return { error: '#NUM!' };
  return lineAt(model, h);
}

/** Inverse of the standard normal distribution (rational approximation, refined once by Newton). */
function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5, r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const erfc = (z) => { // Numerical Recipes erfc, ample for one Newton step
    const t = 1 / (1 + 0.5 * Math.abs(z));
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return z >= 0 ? r : 2 - r;
  };
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

/** FORECAST.ETS.CONFINT: half the width of the prediction interval at `level`. */
export function confidenceAt(model, target, level = 0.95, quantile = normalQuantile) {
  if (!(level >= 0 && level < 1)) return { error: '#NUM!' };
  const idx = model.toIndex(target);
  if (idx < -1e-9) return { error: '#NUM!' };
  if (level === 0) return 0;
  const h = Math.max(1, Math.ceil(idx - model.last - 1e-9));
  let v = 1;
  for (let j = 1; j < h; j++) {
    const c = model.alpha + model.beta * j + (model.m && j % model.m === 0 ? model.gamma : 0);
    v += c * c;
  }
  return quantile(0.5 + level / 2) * model.sigma * Math.sqrt(v);
}

/** FORECAST.ETS.STAT for type 1–8, or { error }. */
export function statistic(model, type) {
  switch (type) {
    case 1: return model.alpha;
    case 2: return model.beta;
    case 3: return model.gamma;
    case 4: return model.mase;
    case 5: return model.smape;
    case 6: return model.mae;
    case 7: return model.rmse;
    case 8: return model.step;
    default: return { error: '#NUM!' };
  }
}

/** Fitted models keyed by their inputs, so a column of FORECAST.ETS over one range fits once. */
const cache = new Map();
export function cachedModel(points, opts, seasonality) {
  const key = JSON.stringify([points, opts.completion, opts.aggregation, seasonality]);
  if (cache.has(key)) return cache.get(key);
  const series = prepareSeries(points, opts);
  const model = series.error ? series : fitEts(series, seasonality);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  cache.set(key, model);
  return model;
}
