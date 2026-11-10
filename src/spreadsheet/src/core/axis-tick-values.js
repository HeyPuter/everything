/**
 * Custom tick values for a chart's value axis (Format Axis ▸ Custom values): the axis draws its major ticks,
 * gridlines and labels at these values instead of at steps of the major unit. They are written as a list,
 * the way pages are picked for printing: "1, 2, 5, 8, 12", with "1-5" for every whole step from 1 to 5.
 * The lists live on the chart's appearance as yTickValues, xTickValues and y2TickValues.
 */

/** The most values one axis keeps, so a range like 1-100000 cannot bury the chart in labels. */
import { t } from '../i18n/index.js';

export const AXIS_TICK_VALUES_MAX = 200;

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?`;
const SINGLE = new RegExp(`^${NUMBER}$`, 'i');
const RANGE = new RegExp(`^(${NUMBER})\\s*[-–]\\s*(${NUMBER})$`, 'i');

const numberOf = text => (text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text));
// Values are kept to 12 significant digits, so 0.1 + 0.2 and 0.3 are one tick.
const tidy = v => Number(v.toPrecision(12));

/** A sorted list without repeats, or undefined when nothing usable is left. */
export function normalizeAxisTickValues(raw) {
  if (!Array.isArray(raw)) return undefined;
  const values = [...new Set(raw.filter(v => Number.isFinite(v) && Math.abs(v) <= 1e100).map(tidy))]
    .sort((p, q) => p - q).slice(0, AXIS_TICK_VALUES_MAX);
  return values.length ? values : undefined;
}

/**
 * Reads what was typed in the Custom values box: { values } (undefined when the box is empty, which means
 * automatic ticks again) or { error } naming what could not be read.
 */
export function parseAxisTickValues(text) {
  const parts = String(text ?? '').split(/[,;]/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { values: undefined };
  const values = [];
  for (const part of parts) {
    if (SINGLE.test(part)) { values.push(numberOf(part)); continue; }
    const range = RANGE.exec(part);
    if (!range) return { error: t('axisTickValues.notNumber', { part }) };
    const from = numberOf(range[1]), to = numberOf(range[2]);
    if (!(Number.isFinite(from) && Number.isFinite(to))) return { error: t('axisTickValues.notNumber', { part }) };
    if (from > to) return { error: t('axisTickValues.lowToHigh', { part }) };
    if (to - from >= AXIS_TICK_VALUES_MAX) return { error: t('axisTickValues.tooMany', { max: AXIS_TICK_VALUES_MAX }) };
    for (let i = 0; from + i <= to + 1e-9; i++) values.push(tidy(from + i));
  }
  if (values.some(v => !Number.isFinite(v) || Math.abs(v) > 1e100)) return { error: t('axisTickValues.tooLarge') };
  if (new Set(values.map(tidy)).size > AXIS_TICK_VALUES_MAX) return { error: t('axisTickValues.tooMany', { max: AXIS_TICK_VALUES_MAX }) };
  return { values: normalizeAxisTickValues(values) };
}

/** The list as the box shows it: runs of three or more whole steps read as a range, 1-5. */
export function formatAxisTickValues(values) {
  if (!values?.length) return '';
  const out = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && Number.isInteger(values[i]) && Math.abs(values[j + 1] - values[j] - 1) < 1e-9) j++;
    if (j - i >= 2) { out.push(`${values[i]}-${values[j]}`); i = j + 1; } else { out.push(String(values[i])); i++; }
  }
  return out.join(', ');
}

/**
 * The custom values that fall on an axis from `min` to `max` (on a logarithmic axis, only the positive
 * ones), or null when the axis has none and keeps its automatic ticks.
 */
export function axisTickValuesIn(values, { min, max, log = false }) {
  if (!values?.length) return null;
  const slack = Math.abs(max - min) * 1e-9;
  return values.filter(v => v >= min - slack && v <= max + slack && (!log || v > 0));
}
