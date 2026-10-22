/**
 * Data ▸ Forecast Sheet: the Create Forecast Worksheet dialog. A preview of the history and its
 * forecast, the forecast end, and (under Options) the start, confidence interval, seasonality,
 * ranges and how missing points and duplicates are treated.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { commandIcon } from './command-icons.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { quoteSheet } from '../core/refs.js';
import { formatValue, parseInput } from '../core/format.js';
import { typedNumber, numberShown } from './typed-number.js';
import { maxOf, minOf } from '../core/numeric.js';
import { readForecastSource, forecastDefaults, forecastPreview, createForecastSheet, AGGREGATIONS } from '../core/forecast-sheet.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** Draw the preview: the history, the forecast and its bounds, as lines or columns. */
function drawPreview(host, preview, chartType) {
  host.replaceChildren();
  const W = 520, H = 200, L = 44, R = 10, T = 10, B = 24;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': 'Forecast preview' });
  host.append(root);
  if (!preview || preview.error) {
    const t = svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'fs-preview-note' });
    t.textContent = preview?.error || 'No preview';
    root.append(t);
    return;
  }
  const pts = preview.points;
  const ys = pts.flatMap((p) => [p.value, p.forecast, p.lower, p.upper]).filter((v) => typeof v === 'number');
  let lo = minOf(ys), hi = maxOf(ys);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (i) => L + ((W - L - R) * (pts.length === 1 ? 0.5 : i / (pts.length - 1)));
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'fs-grid' }));
    const t = svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'fs-axis' });
    t.textContent = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : +v.toPrecision(3);
    root.append(t);
  }
  const line = (key, cls) => {
    const d = pts.map((p, i) => (typeof p[key] === 'number' ? `${x(i)},${y(p[key])}` : null));
    let path = '', pen = false;
    for (const q of d) { if (q) { path += `${pen ? 'L' : 'M'}${q}`; pen = true; } else pen = false; }
    if (path) root.append(svg('path', { d: path, class: cls }));
  };
  if (chartType === 'column') {
    const w = Math.max(1, ((W - L - R) / pts.length) * 0.35);
    const base = y(Math.max(lo, Math.min(0, hi)));
    pts.forEach((p, i) => {
      const v = typeof p.value === 'number' ? p.value : p.forecast;
      if (typeof v !== 'number') return;
      const top = Math.min(base, y(v));
      root.append(svg('rect', { x: x(i) - w, y: top, width: w * 2, height: Math.max(1, Math.abs(base - y(v))), class: typeof p.value === 'number' ? 'fs-col' : 'fs-col fs-col-forecast' }));
    });
    line('lower', 'fs-bound'); line('upper', 'fs-bound');
  } else {
    line('lower', 'fs-bound'); line('upper', 'fs-bound');
    line('value', 'fs-history'); line('forecast', 'fs-forecast');
  }
}

export function openForecastSheet(ctx) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const sel = ctx.range();
  const range = sel.r1 === sel.r2 && sel.c1 === sel.c2 ? ctx.dataRange() : sel;
  let source = range ? readForecastSource(wb, sheetId, range) : { error: 'Select the dates and values to forecast' };
  if (source.error) { toast(source.error, { icon: 'info', duration: 4000 }); return null; }
  let defaults = forecastDefaults(source);
  if (defaults.error) { toast(defaults.error, { icon: 'info', duration: 4000 }); return null; }

  const sheetName = quoteSheet(wb.sheet(sheetId)?.name || '');
  const show = (v) => formatValue(v, source.timelineStyle);
  // A date box shows its date in the timeline's format and reads back what is typed; while it still holds the text
  // it was given, it stands for that date. Read back, a month-year format's "Apr-24" was 24 April of this year.
  const given = new Map();
  const dateBox = (id, value) => { const input = el('input.input', { type: 'text', id, value: show(value), autocomplete: 'off', spellcheck: false }); given.set(input, { text: input.value, value }); return input; };
  const read = (input) => {
    const text = input.value.trim();
    if (given.get(input)?.text === text) return given.get(input).value;
    const v = parseInput(text).v;
    return typeof v === 'number' ? v : null;
  };
  let chartType = 'line';

  const id = (name) => fieldId(`fs-${name}`);
  const endInput = dateBox(id('end'), defaults.end);
  const startInput = dateBox(id('start'), defaults.start);
  const confOn = el('input', { type: 'checkbox', id: id('conf-on'), checked: true });
  const confInput = el('input.input.fs-narrow', { type: 'text', id: id('conf'), value: `${numberShown(95)}%`, 'aria-label': 'Confidence Interval', autocomplete: 'off' });
  const seasonAuto = el('input', { type: 'radio', name: id('season'), id: id('season-auto'), checked: true });
  const seasonManual = el('input', { type: 'radio', name: id('season'), id: id('season-manual') });
  const seasonInput = el('input.input.fs-narrow', { type: 'number', min: 2, max: 8760, step: 1, 'aria-label': 'Seasonality length', disabled: true });
  const statsOn = el('input', { type: 'checkbox', id: id('stats') });
  const columnText = (part) => {
    const pts = source.points;
    const cells = pts.map((p) => (part === 'timeline' ? p.cell : p.valueCell));
    const r1 = minOf(cells.map((c) => c.r)), r2 = maxOf(cells.map((c) => c.r));
    const c1 = minOf(cells.map((c) => c.c)), c2 = maxOf(cells.map((c) => c.c));
    return `${sheetName}!${rangeName({ r1, c1, r2, c2 }).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`;
  };
  const timelineInput = el('input.input', { type: 'text', id: id('timeline'), value: columnText('timeline'), autocomplete: 'off', spellcheck: false });
  const valuesInput = el('input.input', { type: 'text', id: id('values'), value: columnText('values'), autocomplete: 'off', spellcheck: false });
  const fillSelect = el('select.select', { id: id('fill') }, el('option', { value: '1' }, 'Interpolation'), el('option', { value: '0' }, 'Zeros'));
  const aggSelect = el('select.select', { id: id('agg') }, ...AGGREGATIONS.map((name, i) => el('option', { value: String(i + 1) }, name)));
  const preview = el('div.fs-preview');
  const { alert, refuse, clear } = fieldAlert('forecast-sheet');

  const confidence = () => {
    const n = typedNumber(confInput.value.trim().replace(/\s*%$/, ''));
    return n != null && n > 0 && n < 100 ? n / 100 : null;
  };
  const options = () => ({
    end: read(endInput), start: read(startInput),
    showConfidence: confOn.checked, confidence: confidence() ?? 0.95,
    seasonality: seasonManual.checked ? Math.round(Number(seasonInput.value)) : 1,
    completion: Number(fillSelect.value), aggregation: Number(aggSelect.value),
    statistics: statsOn.checked, chartType,
  });
  const refresh = () => {
    clear();
    const o = options();
    drawPreview(preview, o.end == null ? { error: 'Enter the forecast end' } : forecastPreview(source, o), chartType);
  };
  const typeButton = (type, label, glyph) => el('button.btn.fs-type', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': String(type === chartType), html: commandIcon(glyph, 20),
    onclick: (e) => { chartType = type; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); refresh(); } });

  // New ranges typed under Options read the source afresh.
  const rereadRanges = () => {
    const t = ctx.resolveRange(timelineInput.value.trim()), v = ctx.resolveRange(valuesInput.value.trim());
    if (!t || !v || t.sheetId !== v.sheetId) return refuse(timelineInput, 'Enter the timeline and values as ranges such as A2:A25 and B2:B25');
    const rows = (r) => r.range.r2 - r.range.r1 + 1;
    if (rows(t) !== rows(v) || t.range.c1 !== t.range.c2 || v.range.c1 !== v.range.c2) return refuse(valuesInput, 'The timeline and values ranges must be single columns of the same size');
    const merged = { r1: t.range.r1, r2: t.range.r2, c1: Math.min(t.range.c1, v.range.c1), c2: Math.max(t.range.c1, v.range.c1) };
    const next = readForecastSource(wb, t.sheetId, merged);
    if (next.error) return refuse(timelineInput, next.error);
    source = { ...next, timelineHeader: source.timelineHeader, valuesHeader: source.valuesHeader };
    defaults = forecastDefaults(source);
    refresh();
  };

  for (const input of [endInput, startInput, confInput, seasonInput]) input.addEventListener('input', refresh);
  for (const input of [confOn, statsOn, fillSelect, aggSelect]) input.addEventListener('change', refresh);
  for (const radio of [seasonAuto, seasonManual]) radio.addEventListener('change', () => { seasonInput.disabled = !seasonManual.checked; if (seasonManual.checked && !seasonInput.value) seasonInput.value = '12'; refresh(); });
  confOn.addEventListener('change', () => { confInput.disabled = !confOn.checked; });
  for (const input of [timelineInput, valuesInput]) input.addEventListener('change', rereadRanges);

  const submit = (e) => {
    e.preventDefault();
    const o = options();
    if (o.end == null) return refuse(endInput, 'Enter the date the forecast ends');
    if (o.start == null) return refuse(startInput, 'Enter the date the forecast starts');
    if (confOn.checked && confidence() == null) return refuse(confInput, 'Enter a confidence interval between 0% and 100%');
    if (seasonManual.checked && !(o.seasonality >= 2 && o.seasonality <= 8760)) return refuse(seasonInput, 'Enter a season length from 2 to 8760');
    const out = createForecastSheet(wb, source, o);
    if (out.error) return refuse(null, out.error);
    modal.close();
    wb.setActiveSheet(out.sheetId);
    toast('Forecast worksheet created', { icon: 'check' });
  };

  const field = (label, control, forId = control.id) => el('div.field', {}, el('label.field-label', { for: forId }, label), control);
  const content = el('form.fs-dialog', { onsubmit: submit },
    el('div.fs-types', { role: 'group', 'aria-label': 'Chart type' }, typeButton('line', 'Create a line chart', 'chartLine'), typeButton('column', 'Create a column chart', 'chartColumn')),
    preview,
    field('Forecast End', endInput),
    el('details.fs-options', {},
      el('summary', {}, 'Options'),
      el('div.fs-grid', {},
        el('div', {},
          field('Forecast Start', startInput),
          el('div.fs-inline', {}, el('label.check', { for: confOn.id }, confOn, el('span', {}, 'Confidence Interval')), confInput),
          el('fieldset.fs-season', {}, el('legend.field-label', {}, 'Seasonality'),
            el('label.check', { for: seasonAuto.id }, seasonAuto, el('span', {}, 'Detect Automatically')),
            el('div.fs-inline', {}, el('label.check', { for: seasonManual.id }, seasonManual, el('span', {}, 'Set Manually')), seasonInput)),
          el('label.check', { for: statsOn.id }, statsOn, el('span', {}, 'Include forecast statistics'))),
        el('div', {},
          field('Timeline Range', timelineInput),
          field('Values Range', valuesInput),
          field('Fill Missing Points Using', el('div.select-wrap', {}, fillSelect), fillSelect.id),
          field('Aggregate Duplicates Using', el('div.select-wrap', {}, aggSelect), aggSelect.id)))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Create')));
  const modal = openModal({ title: 'Create Forecast Worksheet', content, wide: true, initialFocus: endInput, onClose: () => ctx.grid?.focus?.() });
  refresh();
  return modal;
}
