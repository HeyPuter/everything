import { niceScale } from './charts.js';

const clamp = v => Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, v));

/** Where `v` lies along an axis from `min` (0) to `max` (1). An axis wider than a double
 * can hold (data near ±9e307 rounds out to ±1e308) is measured in halves, so the
 * fraction stays finite instead of Infinity / Infinity = NaN. Other axes are unchanged. */
export function axisFraction(v, min, max) {
  const span = max - min;
  return Number.isFinite(span) ? (v - min) / (span || 1) : (v / 2 - min / 2) / (max / 2 - min / 2);
}

function axisBounds(dataMin, dataMax, min, max) {
  const fixedMin = Number.isFinite(min);
  // A malformed reversed/equal pair cannot describe an axis. Retain the
  // minimum and recompute the upper bound, as with an automatic maximum.
  const fixedMax = Number.isFinite(max) && (!fixedMin || max > min);
  const finiteData = Number.isFinite(dataMin) && Number.isFinite(dataMax);
  let lo = fixedMin ? min : finiteData ? dataMin : fixedMax ? Math.min(0, max) : 0;
  let hi = fixedMax ? max : finiteData ? dataMax : fixedMin ? Math.max(0, min) : 1;
  let fallback = !finiteData;
  if (hi <= lo) {
    if (fixedMin && !fixedMax) hi = clamp(lo + Math.max(Math.abs(lo), 1));
    else if (fixedMax && !fixedMin) lo = clamp(hi - Math.max(Math.abs(hi), 1));
    else if (!fixedMin && !fixedMax) {
      if (lo > 0) lo = 0;
      else if (hi < 0) hi = 0;
      else { lo = 0; hi = 1; fallback = true; }
    }
  }
  return { lo, hi, fixedMin, fixedMax, fallback };
}

/** Range contributed by a deleted primary value axis to a surviving secondary
 * axis. The transfer carries unrounded bounds with 5% padding before the secondary
 * axis computes its own range. This is not the primary tick range: narrow
 * ranges use 5% at both ends, and neither major units nor category half-span
 * margins participate. The positive zero threshold also applies
 * here without its negative mirror; a negative maximum can cross zero during
 * this stage. An endpoint already at zero stays at zero. Keep that transfer
 * policy separate from ordinary visible-axis scaling below. */
export function chartAxisTransferBounds(dataMin, dataMax, { min = null, max = null, percent = false } = {}) {
  let { lo, hi, fixedMin, fixedMax } = axisBounds(dataMin, dataMax, min, max);
  // Percentage stacks transfer actual normalized extents, not the synthetic
  // range used to display an empty or constant value axis.
  if (percent) return [Math.min(0, fixedMin ? min : Number.isFinite(dataMin) ? dataMin : 0),
    Math.max(0, fixedMax ? max : Number.isFinite(dataMax) ? dataMax : 0)];
  // For this transfer a constant zero series counts as nonpositive,
  // unlike an empty series's positive default range. Both defaults receive
  // transfer headroom, just like a nonzero constant series's expanded range.
  if (!fixedMin && !fixedMax && Number.isFinite(dataMin) && dataMin === dataMax && dataMax <= 0) {
    lo = dataMin || -1; hi = 0;
  }
  if (lo >= 0 && lo <= hi * (5 / 6)) lo = 0;
  const headroom = hi / 20 - lo / 20;
  return [lo === 0 ? 0 : clamp(lo - headroom), hi === 0 ? 0 : clamp(hi + headroom)];
}

/** Automatic linear value-axis bounds. Keep range policy separate from the
 * renderer's tick-density policy. Microsoft KB214075 documents 5% headroom,
 * the five-sixths zero threshold and the half-span category-axis lower margin;
 * scatter/bubble ranges also get 5% at their exposed near end.
 * Fixed bounds anchor the tick lattice; automatic rounding must not move them.
 * https://www.betaarchive.com/wiki/index.php/Microsoft_KB_Archive/214075 */
export function chartAxisScale(dataMin, dataMax, { min = null, max = null, step = null, ticks = 5, numeric = false, percent = false } = {}) {
  const { lo, hi, fixedMin, fixedMax, fallback } = axisBounds(dataMin, dataMax, min, max);
  // The zero threshold applies before measuring the headroom span. A
  // fixed near bound and the narrow-range margins do not extend that span.
  const zeroMin = !fixedMin && lo >= 0 && lo <= hi * (5 / 6);
  const zeroMax = !fixedMax && hi <= 0 && hi >= lo * (5 / 6);
  // Divide before subtracting: mixed-sign double extremes can have an infinite
  // span even though each endpoint and its headroom are representable.
  const headroom = fallback || percent ? 0 : (zeroMax ? 0 : hi / 20) - (zeroMin ? 0 : lo / 20);
  let lower = lo, upper = hi, stepLo = lo, stepHi = hi;
  if (percent) {
    if (!fixedMin) lower = stepLo = Math.min(0, lo);
    if (!fixedMax) upper = stepHi = Math.max(0, hi);
  } else if (lo >= 0) {
    if (!fixedMin) {
      if (zeroMin) lower = stepLo = 0;
      else if (numeric) lower = clamp(lo - headroom);
      else lower = stepLo = clamp(lo - (hi / 2 - lo / 2));
    }
    if (!fixedMax) upper = clamp(hi + headroom);
  } else if (hi <= 0) {
    if (!fixedMax) {
      if (zeroMax) upper = stepHi = 0;
      else if (numeric) upper = clamp(hi + headroom);
      else upper = stepHi = clamp(hi + (hi / 2 - lo / 2));
    }
    if (!fixedMin) lower = clamp(lo - headroom);
  } else {
    if (!fixedMin) lower = clamp(lo - headroom);
    if (!fixedMax) upper = clamp(hi + headroom);
  }
  const unit = Number.isFinite(step) && step > 0 ? step : niceScale(stepLo, stepHi, ticks).step;
  const round = (value, anchor, up) => {
    const offset = (value - anchor) / unit;
    // Divide first if subtraction overflowed. Extremely small explicit units
    // cannot resolve a tick at huge magnitudes; retain the finite endpoint.
    const q = Number.isFinite(offset) ? offset : value / unit - anchor / unit;
    if (!Number.isFinite(q)) return value;
    const n = up ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9);
    const result = anchor + n * unit;
    return Number.isFinite(result) ? result : clamp((anchor / unit + n) * unit);
  };
  return { min: fixedMin ? min : round(lower, fixedMax ? max : 0, false),
    max: fixedMax ? max : round(upper, fixedMin ? min : 0, true), step: unit };
}
