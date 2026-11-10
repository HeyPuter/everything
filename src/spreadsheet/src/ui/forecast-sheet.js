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
import { t, formatNumber } from '../i18n/index.js';

/** How each of AGGREGATIONS (by position) reads in the interface. */
const AGGREGATION_LABELS = ['forecastSheet.agg.average', 'forecastSheet.agg.count', 'forecastSheet.agg.countA', 'forecastSheet.agg.max', 'forecastSheet.agg.median', 'forecastSheet.agg.min', 'forecastSheet.agg.sum'];

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
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': t('forecastSheet.previewLabel') });
  host.append(root);
  if (!preview || preview.error) {
    const note = svg('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'fs-preview-note' });
    note.textContent = preview?.error || t('forecastSheet.noPreview');
    root.append(note);
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
    const tick = svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'fs-axis' });
    tick.textContent = Math.abs(v) >= 1000 ? formatNumber(Math.round(v)) : +v.toPrecision(3);
    root.append(tick);
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
  let source = range ? readForecastSource(wb, sheetId, range) : { error: t('forecastSheet.errors.selectData') };
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
  const confInput = el('input.input.fs-narrow', { type: 'text', id: id('conf'), value: `${numberShown(95)}%`, 'aria-label': t('forecastSheet.confidenceInterval'), autocomplete: 'off' });
  const seasonAuto = el('input', { type: 'radio', name: id('season'), id: id('season-auto'), checked: true });
  const seasonManual = el('input', { type: 'radio', name: id('season'), id: id('season-manual') });
  const seasonInput = el('input.input.fs-narrow', { type: 'number', min: 2, max: 8760, step: 1, 'aria-label': t('forecastSheet.seasonLength'), disabled: true });
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
  const fillSelect = el('select.select', { id: id('fill') }, el('option', { value: '1' }, t('forecastSheet.fill.interpolation')), el('option', { value: '0' }, t('forecastSheet.fill.zeros')));
  const aggSelect = el('select.select', { id: id('agg') }, ...AGGREGATIONS.map((name, i) => el('option', { value: String(i + 1) }, AGGREGATION_LABELS[i] ? t(AGGREGATION_LABELS[i]) : name)));
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
    drawPreview(preview, o.end == null ? { error: t('forecastSheet.errors.enterEnd') } : forecastPreview(source, o), chartType);
  };
  const typeButton = (type, label, glyph) => el('button.btn.fs-type', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': String(type === chartType), html: commandIcon(glyph, 20),
    onclick: (e) => { chartType = type; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); refresh(); } });

  // New ranges typed under Options read the source afresh.
  const rereadRanges = () => {
    const tl = ctx.resolveRange(timelineInput.value.trim()), v = ctx.resolveRange(valuesInput.value.trim());
    if (!tl || !v || tl.sheetId !== v.sheetId) return refuse(timelineInput, t('forecastSheet.errors.ranges'));
    const rows = (r) => r.range.r2 - r.range.r1 + 1;
    if (rows(tl) !== rows(v) || tl.range.c1 !== tl.range.c2 || v.range.c1 !== v.range.c2) return refuse(valuesInput, t('forecastSheet.errors.sameSize'));
    const merged = { r1: tl.range.r1, r2: tl.range.r2, c1: Math.min(tl.range.c1, v.range.c1), c2: Math.max(tl.range.c1, v.range.c1) };
    const next = readForecastSource(wb, tl.sheetId, merged);
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
    if (o.end == null) return refuse(endInput, t('forecastSheet.errors.enterEndDate'));
    if (o.start == null) return refuse(startInput, t('forecastSheet.errors.enterStartDate'));
    if (confOn.checked && confidence() == null) return refuse(confInput, t('forecastSheet.errors.confidenceRange'));
    if (seasonManual.checked && !(o.seasonality >= 2 && o.seasonality <= 8760)) return refuse(seasonInput, t('forecastSheet.errors.seasonRange'));
    const out = createForecastSheet(wb, source, o);
    if (out.error) return refuse(null, out.error);
    modal.close();
    wb.setActiveSheet(out.sheetId);
    toast(t('forecastSheet.created'), { icon: 'check' });
  };

  const field = (label, control, forId = control.id) => el('div.field', {}, el('label.field-label', { for: forId }, label), control);
  const content = el('form.fs-dialog', { onsubmit: submit },
    el('div.fs-types', { role: 'group', 'aria-label': t('forecastSheet.chartType') }, typeButton('line', t('forecastSheet.lineChart'), 'chartLine'), typeButton('column', t('forecastSheet.columnChart'), 'chartColumn')),
    preview,
    field(t('forecastSheet.forecastEnd'), endInput),
    el('details.fs-options', {},
      el('summary', {}, t('common.options')),
      el('div.fs-grid', {},
        el('div', {},
          field(t('forecastSheet.forecastStart'), startInput),
          el('div.fs-inline', {}, el('label.check', { for: confOn.id }, confOn, el('span', {}, t('forecastSheet.confidenceInterval'))), confInput),
          el('fieldset.fs-season', {}, el('legend.field-label', {}, t('forecastSheet.seasonality')),
            el('label.check', { for: seasonAuto.id }, seasonAuto, el('span', {}, t('forecastSheet.detectAutomatically'))),
            el('div.fs-inline', {}, el('label.check', { for: seasonManual.id }, seasonManual, el('span', {}, t('forecastSheet.setManually'))), seasonInput)),
          el('label.check', { for: statsOn.id }, statsOn, el('span', {}, t('forecastSheet.includeStatistics')))),
        el('div', {},
          field(t('forecastSheet.timelineRange'), timelineInput),
          field(t('forecastSheet.valuesRange'), valuesInput),
          field(t('forecastSheet.fillUsing'), el('div.select-wrap', {}, fillSelect), fillSelect.id),
          field(t('forecastSheet.aggregateUsing'), el('div.select-wrap', {}, aggSelect), aggSelect.id)))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('forecastSheet.create'))));
  const modal = openModal({ title: t('forecastSheet.title'), content, wide: true, initialFocus: endInput, onClose: () => ctx.grid?.focus?.() });
  refresh();
  return modal;
}
