/**
 * Auto Fill Options, chosen after a fill-handle drag: the fill done again as Copy Cells, Fill
 * Series, Fill Formatting Only, Fill Without Formatting, or (for dates) by days, weekdays, months or
 * years. `refill` writes the chosen fill over a target the caller has just restored (by undoing the
 * drag's fill), as one step. Fill ▸ Justify's line breaking lives here too.
 */
import { normalizeRange } from './cell.js';
import { dateTimeKind, serialToYMD, ymdToSerial } from './format.js';

export const AUTOFILL_CHOICES = [
  ['copy', 'Copy Cells'], ['series', 'Fill Series'], ['formats', 'Fill Formatting Only'], ['values', 'Fill Without Formatting'],
  ['days', 'Fill Days'], ['weekdays', 'Fill Weekdays'], ['months', 'Fill Months'], ['years', 'Fill Years'], ['flash', 'Flash Fill'],
];
const DATE_KINDS = new Set(['days', 'weekdays', 'months', 'years']);

/** Is the fill from `source` to `target` down/up (true) or across (false)? */
export const fillsVertically = (source, target) => {
  const s = normalizeRange(source), t = normalizeRange(target);
  return t.r1 !== s.r1 || t.r2 !== s.r2;
};

/** The source's cells, one list per line in the fill's direction: columns when filling down, rows when across. */
function sourceLines(wb, sheetId, source, vertical) {
  const s = normalizeRange(source);
  const lines = [];
  if (vertical) for (let c = s.c1; c <= s.c2; c++) { const line = []; for (let r = s.r1; r <= s.r2; r++) line.push({ r, c, cell: wb.getCell(sheetId, r, c) }); lines.push(line); }
  else for (let r = s.r1; r <= s.r2; r++) { const line = []; for (let c = s.c1; c <= s.c2; c++) line.push({ r, c, cell: wb.getCell(sheetId, r, c) }); lines.push(line); }
  return lines;
}

const isDateCell = (wb, sheetId, { r, c, cell }) => cell?.f == null && typeof cell?.v === 'number'
  && ['date', 'datetime'].includes(dateTimeKind(cell.s || wb.styleAt?.(sheetId, r, c), cell.v));
const isPlainNumber = (wb, sheetId, entry) => entry.cell?.f == null && typeof entry.cell?.v === 'number' && !isDateCell(wb, sheetId, entry);

/** Which options the button offers for this source: the date units for dates, Flash Fill for text. */
export function autoFillChoices(wb, sheetId, source, target) {
  const lines = sourceLines(wb, sheetId, source, fillsVertically(source, target));
  const filled = lines.flat().filter((e) => e.cell && (e.cell.v != null || e.cell.f != null));
  const dates = filled.length > 0 && filled.some((e) => isDateCell(wb, sheetId, e));
  const text = filled.some((e) => e.cell.f == null && typeof e.cell.v === 'string');
  return AUTOFILL_CHOICES.filter(([kind]) => (DATE_KINDS.has(kind) ? dates : kind === 'flash' ? text && fillsVertically(source, target) : true));
}

/** What the drag did by default, so the button shows it chosen: lone plain numbers copy, everything else continues. */
export function defaultAutoFill(wb, sheetId, source, target, inverted = false) {
  const vertical = fillsVertically(source, target);
  const lines = sourceLines(wb, sheetId, source, vertical);
  const lone = lines.every((line) => line.length === 1 && isPlainNumber(wb, sheetId, line[0]));
  const datesOnly = lines.every((line) => line.every((e) => isDateCell(wb, sheetId, e)));
  if (datesOnly && !inverted && lines.every((line) => line.length === 1)) return 'days';
  return lone !== inverted ? 'copy' : 'series';
}

const MONTH = (p) => p.y * 12 + (p.m - 1);
function addMonths(serial, months) {
  const base = serialToYMD(serial);
  const total = MONTH(base) + months;
  const y = Math.floor(total / 12), m = ((total % 12) + 12) % 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ymdToSerial(y, m, Math.min(base.d, last)) + (serial - Math.floor(serial));
}
function addWeekdays(serial, n) {
  let d = Math.floor(serial);
  const sign = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d += sign;
    const wd = serialToYMD(d).weekday;
    if (wd !== 0 && wd !== 6) {
      left--;
      // From a weekday, five working days always span seven calendar days: whole weeks are skipped at once,
      // so a long fill does not walk every day to each of its cells.
      d += sign * Math.floor(left / 5) * 7;
      left %= 5;
    }
  }
  return d + (serial - Math.floor(serial));
}
const stepDate = (serial, unit, k) => (unit === 'days' ? serial + k : unit === 'weekdays' ? addWeekdays(serial, k)
  : addMonths(serial, (unit === 'years' ? 12 : 1) * k));
/** The step between a line's first two dates in the unit chosen: 1 for a lone date, or when they share the unit. */
function unitStep(values, unit) {
  if (values.length < 2) return 1;
  const [a, b] = values.map((v) => serialToYMD(v));
  const n = unit === 'days' ? Math.round(values[1] - values[0]) : unit === 'months' ? MONTH(b) - MONTH(a) : unit === 'years' ? b.y - a.y : null;
  return n || 1;
}

/** The target's cells outside the source, each with its offset from the source's near edge (negative before it). */
function filledPositions(source, target, vertical) {
  const s = normalizeRange(source), t = normalizeRange(target);
  const [lo, hi] = vertical ? [t.r1, t.r2] : [t.c1, t.c2];
  const [s1, s2] = vertical ? [s.r1, s.r2] : [s.c1, s.c2];
  const out = [];
  for (let p = lo; p <= hi; p++) if (p < s1 || p > s2) out.push({ p, offset: p < s1 ? p - s1 : p - s2 });
  return out;
}

/**
 * Fill `target` from `source` the way `kind` says, as one undo step. The caller has restored the
 * target (undone the default fill) first, so formatting-only and without-formatting read what was there.
 */
export function refill(wb, sheetId, source, target, kind) {
  const s = normalizeRange(source), t = normalizeRange(target);
  const vertical = fillsVertically(s, t);
  const lines = sourceLines(wb, sheetId, s, vertical);
  const positions = filledPositions(s, t, vertical);
  const at = (k, p) => (vertical ? { r: p, c: s.c1 + k } : { r: s.r1 + k, c: p });
  const label = 'Fill';
  if (kind === 'copy') { wb.fill(sheetId, s, t, { series: false }); return true; }
  if (kind === 'series') {
    // Each line on its own terms: a lone number counts up, which a default drag would have copied.
    wb.transaction(label, () => lines.forEach((line, k) => {
      const lineSource = vertical ? { r1: s.r1, c1: s.c1 + k, r2: s.r2, c2: s.c1 + k } : { r1: s.r1 + k, c1: s.c1, r2: s.r1 + k, c2: s.c2 };
      const lineTarget = vertical ? { ...lineSource, r1: t.r1, r2: t.r2 } : { ...lineSource, c1: t.c1, c2: t.c2 };
      wb.fill(sheetId, lineSource, lineTarget, { invert: line.length === 1 && isPlainNumber(wb, sheetId, line[0]) });
    }));
    return true;
  }
  if (kind === 'formats') {
    const entries = [];
    lines.forEach((line, k) => positions.forEach(({ p, offset }) => {
      const { r, c } = at(k, p);
      if (wb._coveredByMerge?.(sheetId, r, c)) return;
      const n = line.length, base = line[((offset < 0 ? offset : offset - 1) % n + n) % n];
      const prev = wb.getCell(sheetId, r, c);
      const style = wb.replacedCellStyle(sheetId, r, c, base.cell?.s);
      entries.push({ r, c, cell: { ...(prev || {}), v: prev?.v ?? null, f: prev?.f ?? null, ...(style ? { s: style } : {}) } });
      if (!style) delete entries.at(-1).cell.s;
    }));
    return wb.setCellsWithTableHeaders(sheetId, entries, label) > 0;
  }
  if (kind === 'values') {
    // The contents of the default fill, with each cell keeping the formatting it had.
    const before = new Map();
    lines.forEach((_, k) => positions.forEach(({ p }) => { const { r, c } = at(k, p); before.set(`${r},${c}`, wb.getCell(sheetId, r, c)?.s); }));
    wb.transaction(label, () => {
      wb.fill(sheetId, s, t);
      const entries = [];
      for (const [key, style] of before) {
        const [r, c] = key.split(',').map(Number);
        const cell = wb.getCell(sheetId, r, c);
        if (!cell && !style) continue;
        const next = { ...(cell || { v: null, f: null }) };
        if (style) next.s = style; else delete next.s;
        entries.push({ r, c, cell: next });
      }
      wb.setCellsWithTableHeaders(sheetId, entries, label);
    });
    return true;
  }
  if (DATE_KINDS.has(kind)) {
    const entries = [];
    lines.forEach((line, k) => {
      const dates = line.filter((e) => isDateCell(wb, sheetId, e));
      if (!dates.length) return;
      const values = dates.map((e) => e.cell.v);
      const step = unitStep(values, kind);
      const first = values[0], last = values.at(-1);
      // A regular run of months or years counts on from its first date, so a day a short month cut short
      // (January 31, February 29) comes back (March 31), as one date's fill already did.
      const fromFirst = (kind === 'months' || kind === 'years') && values.every((v, i) => v === stepDate(first, kind, step * i));
      positions.forEach(({ p, offset }) => {
        const { r, c } = at(k, p);
        if (wb._coveredByMerge?.(sheetId, r, c)) return;
        const n = line.length, base = line[((offset < 0 ? offset : offset - 1) % n + n) % n];
        const v = offset > 0 ? fromFirst ? stepDate(first, kind, step * (values.length - 1 + offset)) : stepDate(last, kind, step * offset)
          : stepDate(first, kind, step * offset);
        const style = wb.replacedCellStyle(sheetId, r, c, base.cell?.s);
        entries.push({ r, c, cell: { v, f: null, ...(style ? { s: style } : {}) } });
      });
    });
    return wb.setCellsWithTableHeaders(sheetId, entries, label) > 0;
  }
  return false;
}

/**
 * Fill ▸ Justify: the text of a column's cells rejoined and broken again into lines no wider than
 * `width`, as `measure(text)` reads widths. A blank cell ends a paragraph and stays as a blank line
 * between them. A word longer than the width keeps a line to itself.
 */
export function justifyLines(texts, width, measure) {
  const paragraphs = [];
  let words = null;
  for (const t of texts) {
    const text = t == null ? '' : String(t).trim();
    if (!text) { if (words) { paragraphs.push(words); words = null; } continue; }
    (words ??= []).push(...text.split(/\s+/));
  }
  if (words) paragraphs.push(words);
  const out = [];
  paragraphs.forEach((list, i) => {
    if (i) out.push('');
    let line = '';
    for (const word of list) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
  });
  return out;
}

/** The lines of `range` a series fills: its columns when filling down, its rows when across. */
function seriesLines(range, direction) {
  const n = normalizeRange(range), out = [];
  if (direction === 'down') for (let c = n.c1; c <= n.c2; c++) out.push({ r1: n.r1, c1: c, r2: n.r2, c2: c });
  else for (let r = n.r1; r <= n.r2; r++) out.push({ r1: r, c1: n.c1, r2: r, c2: n.c2 });
  return out;
}

/** Least-squares fit through `ys` at positions 0 … n-1, straight (linear) or exponential (growth); null when it cannot be fitted. */
export function trendFit(ys, growth = false) {
  const points = ys.map((y, x) => [x, y]).filter(([, y]) => typeof y === 'number' && Number.isFinite(y) && (!growth || y > 0));
  if (!points.length) return null;
  const tx = (y) => (growth ? Math.log(y) : y);
  if (points.length === 1) return growth ? null : () => points[0][1];
  const n = points.length;
  const mx = points.reduce((a, [x]) => a + x, 0) / n, my = points.reduce((a, [, y]) => a + tx(y), 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of points) { sxy += (x - mx) * (tx(y) - my); sxx += (x - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0, intercept = my - slope * mx;
  return (x) => { const v = intercept + slope * x; return growth ? Math.exp(v) : v; };
}

/**
 * The Series dialog over every row or column of the selection, as one step: Linear, Growth and Date
 * series from each line's first cell (fillSeries), AutoFill from each line's leading cells as the fill
 * handle would, and Trend, which replaces the whole line with the best-fit line (or growth curve) through
 * the values it starts with. Returns how many cells were written.
 */
export function fillSeriesLines(wb, sheetId, range, { type = 'linear', step = 1, stop = null, unit = 'day', direction = 'down', trend = false } = {}) {
  const n = normalizeRange(range);
  const single = n.r1 === n.r2 && n.c1 === n.c2;
  let count = 0;
  wb.transaction(type === 'autofill' ? 'Fill' : 'Fill series', () => {
    for (const line of seriesLines(n, direction)) {
      const cells = [];
      const down = direction === 'down';
      const len = down ? line.r2 - line.r1 + 1 : line.c2 - line.c1 + 1;
      for (let k = 0; k < len; k++) cells.push(down ? { r: line.r1 + k, c: line.c1 } : { r: line.r1, c: line.c1 + k });
      const filled = (e) => { const cell = wb.getCell(sheetId, e.r, e.c); return !!cell && (cell.v != null || cell.f != null); };
      if (type === 'autofill' || (trend && (type === 'linear' || type === 'growth'))) {
        let lead = 0;
        while (lead < len && filled(cells[lead])) lead++;
        if (!lead || lead === len) continue;
        if (type === 'autofill') {
          const source = down ? { ...line, r2: line.r1 + lead - 1 } : { ...line, c2: line.c1 + lead - 1 };
          wb.fill(sheetId, source, line);
          count += len - lead;
          continue;
        }
        const ys = cells.slice(0, lead).map((e) => wb.getValue(sheetId, e.r, e.c));
        const fit = trendFit(ys, type === 'growth');
        if (!fit) continue;
        const entries = cells.map((e, x) => {
          const value = fit(x);
          const prev = wb.getCell(sheetId, e.r, e.c);
          return { r: e.r, c: e.c, cell: { v: Number.isInteger(value) ? value : Number(value.toPrecision(15)), f: null, s: prev?.s ?? wb.getCell(sheetId, cells[0].r, cells[0].c)?.s } };
        }).filter((e) => Number.isFinite(e.cell.v) && !wb._coveredByMerge?.(sheetId, e.r, e.c));
        count += wb.setCellsWithTableHeaders(sheetId, entries, 'Fill series') ? entries.length : 0;
        continue;
      }
      count += wb.fillSeries(sheetId, single ? n : line, { type, step, stop, unit, direction }) || 0;
    }
  });
  return count;
}
