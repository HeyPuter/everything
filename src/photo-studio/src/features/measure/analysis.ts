// Image > Analysis: the measurement scale (pixels to real-world units, with
// saved presets), the data points to record, Record Measurements (of the
// ruler line, counts or selection regions) into the Measurement Log panel,
// and Place Scale Marker (a scale bar and caption as layers in a group).
import type { Editor } from '../../editor';
import { commands, registerCommand, registerPanel } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { formatShortcut } from '../../app/shortcuts';
import { layer as newLayer, type Layer } from '../../model/document';
import { selectionGrid, canvasRect } from '../../model/selection';
import { readMask } from '../../model/tiles';
import { syncLegacyFields } from '../../model/text-layer';
import { vectorHexColor } from '../../color/vector';
import { download } from '../../persistence/puter';
import { defaultScale, isDefaultScale, short, rulerMetrics, scaleFactor, scaledArea, scaledLength, validScale, type MeasurementScale } from '../../imaging/measure/geometry';
import { grayValues, measureRegions, summarize, toCSV, type RegionStats } from '../../imaging/measure/regions';
import { defaultCharStyle, defaultParagraphStyle, fromPlainText, type TextLayerData } from '../../imaging/text/model';
import { compositeRGBA } from '../pixels';
import { insertAboveSelection } from '../layers/insert';
import { openDialog } from '../transform/dialog';
import { annotationsOf, editAnnotations, rulerLine } from './state';
import { countGroups } from './count';

// ----- Data points -----
export type DataPoint = { id: string; label: string; group: 'General' | 'Selection' | 'Ruler' | 'Count'; numeric?: boolean };
export const DATA_POINTS: DataPoint[] = [
  { id: 'label', label: 'Label', group: 'General' },
  { id: 'date', label: 'Date and Time', group: 'General' },
  { id: 'document', label: 'Document', group: 'General' },
  { id: 'source', label: 'Source', group: 'General' },
  { id: 'scale', label: 'Scale', group: 'General' },
  { id: 'scaleUnits', label: 'Scale Units', group: 'General' },
  { id: 'scaleFactor', label: 'Scale Factor', group: 'General', numeric: true },
  { id: 'count', label: 'Count', group: 'Count', numeric: true },
  { id: 'area', label: 'Area', group: 'Selection', numeric: true },
  { id: 'perimeter', label: 'Perimeter', group: 'Selection', numeric: true },
  { id: 'circularity', label: 'Circularity', group: 'Selection', numeric: true },
  { id: 'height', label: 'Height', group: 'Selection', numeric: true },
  { id: 'width', label: 'Width', group: 'Selection', numeric: true },
  { id: 'intDensity', label: 'Integrated Density', group: 'Selection', numeric: true },
  { id: 'grayMean', label: 'Gray Mean', group: 'Selection', numeric: true },
  { id: 'grayMedian', label: 'Gray Median', group: 'Selection', numeric: true },
  { id: 'grayMin', label: 'Gray Minimum', group: 'Selection', numeric: true },
  { id: 'grayMax', label: 'Gray Maximum', group: 'Selection', numeric: true },
  { id: 'grayStd', label: 'Gray Std. Deviation', group: 'Selection', numeric: true },
  { id: 'length', label: 'Length', group: 'Ruler', numeric: true },
  { id: 'angle', label: 'Angle', group: 'Ruler', numeric: true },
];
const defaultPoints = DATA_POINTS.map((d) => d.id).filter((id) => !['date', 'scale', 'scaleFactor', 'grayStd'].includes(id));
function storedList(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* Optional. */
  }
}
let dataPoints: string[] = (() => {
  const v = storedList('photo-studio-data-points');
  return Array.isArray(v) ? v.filter((id) => DATA_POINTS.some((d) => d.id === id)) : defaultPoints;
})();
export const enabledPoints = () => DATA_POINTS.filter((d) => d.id === 'label' || dataPoints.includes(d.id));

// ----- Measurement log (shared by all documents, like a lab notebook) -----
export type LogRow = { id: number; values: Record<string, string | number> };
export const log: { rows: LogRow[]; next: number; selected: Set<number>; sort?: { key: string; dir: 1 | -1 } } = { rows: [], next: 1, selected: new Set() };

const num = (v: number, digits = 4) => Number(v.toFixed(digits));
function scaleText(s: MeasurementScale | undefined) {
  return isDefaultScale(s) ? '1 pixel = 1 pixel' : `${short(s!.pixels, 2)} pixels = ${short(s!.length, 4)} ${s!.units}`;
}
function baseValues(e: Editor, source: string, label: string): Record<string, string | number> {
  const s = annotationsOf(e.doc).scale ?? defaultScale;
  return { label, date: new Date().toLocaleString(), document: e.doc.name, source, scale: scaleText(s), scaleUnits: s.units, scaleFactor: num(scaleFactor(s), 6) };
}
function regionValues(r: RegionStats, s: MeasurementScale | undefined, count: number): Record<string, number> {
  return {
    count,
    area: num(scaledArea(r.area, s)),
    perimeter: num(scaledLength(r.perimeter, s)),
    circularity: num(r.circularity),
    height: num(scaledLength(r.height, s)),
    width: num(scaledLength(r.width, s)),
    intDensity: num(scaledArea(r.area, s) * r.mean, 2),
    grayMean: num(r.mean, 2),
    grayMedian: r.median,
    grayMin: r.min,
    grayMax: r.max,
    grayStd: num(r.std, 2),
  };
}

/** Rows describing what to measure now: the ruler line or counts when
 * their tool is active, else the selection, else the ruler line, else the
 * counts, else the whole image. */
export async function measurementRows(e: Editor): Promise<Record<string, string | number>[]> {
  const s = annotationsOf(e.doc).scale;
  const ruler = rulerLine(e);
  const counts = countGroups(e).filter((g) => g.points.length);
  const sel = !!(e.doc.selection || e.doc.selectionMask);
  const source = e.tool === 'ruler' && ruler ? 'ruler' : e.tool === 'count' && counts.length ? 'count' : sel ? 'selection' : ruler ? 'ruler' : counts.length ? 'count' : 'document';
  if (source === 'ruler') {
    const m = rulerMetrics(ruler!);
    return [{ ...baseValues(e, 'Ruler', m.l2 !== undefined ? 'Protractor' : 'Ruler'), length: num(scaledLength(m.length, s)), angle: num(m.angle, 2) }];
  }
  if (source === 'count') {
    const rows = counts.map((g) => ({ ...baseValues(e, 'Count', g.name), count: g.points.length }));
    if (rows.length > 1) rows.push({ ...baseValues(e, 'Count', 'All Groups'), count: counts.reduce((n, g) => n + g.points.length, 0) });
    return rows;
  }
  const area = canvasRect(e.doc);
  let mask;
  if (source === 'selection') mask = readMask(e.assets.tiles, selectionGrid(e.doc, e.assets.tiles)!, area);
  else mask = { width: area.width, height: area.height, data: new Uint8Array(area.width * area.height).fill(255) };
  const gray = grayValues(await compositeRGBA(e));
  const regions = measureRegions(mask, gray);
  if (!regions.length) throw new Error('The selection is empty.');
  const label = source === 'document' ? 'Image' : 'Selection';
  const rows: Record<string, string | number>[] = [];
  if (regions.length > 1) regions.forEach((r, i) => rows.push({ ...baseValues(e, label, `${label} ${i + 1}`), ...regionValues(r, s, 1) }));
  rows.push({ ...baseValues(e, label, regions.length > 1 ? 'Summary' : label), ...regionValues(summarize(regions)!, s, regions.length) });
  return rows;
}
export async function recordMeasurements(e: Editor) {
  const rows = await measurementRows(e);
  log.selected.clear();
  for (const values of rows) {
    const id = log.next++;
    log.rows.push({ id, values });
    log.selected.add(id);
  }
  if (!e.dock.isVisible('measurement-log')) e.dock.show('measurement-log');
  else e.dock.update();
  e.message(`Recorded ${rows.length} measurement${rows.length === 1 ? '' : 's'}.`);
}

// ----- Measurement Log panel -----
function sortedRows() {
  const s = log.sort;
  if (!s) return log.rows;
  return log.rows.slice().sort((a, b) => {
    const x = s.key === 'id' ? a.id : a.values[s.key],
      y = s.key === 'id' ? b.id : b.values[s.key];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * s.dir;
  });
}
/** Columns that have a value in at least one row. */
function logColumns() {
  return enabledPoints().filter((d) => log.rows.some((r) => r.values[d.id] !== undefined));
}
/** Record Measurements' shortcut as this platform shows it (it can be changed). */
const recordKeys = () => {
  const keys = formatShortcut(commands.get('analysis.record')?.shortcut);
  return keys ? ` (${keys})` : '';
};
function logHtml() {
  if (!log.rows.length) return `<p class="muted log-empty">Measure with a selection, the Ruler tool or the Count tool, then choose Image › Analysis › Record Measurements${escapeXML(recordKeys())}.</p>`;
  const cols = logColumns();
  const arrow = (k: string) => (log.sort?.key === k ? (log.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  const head = `<tr><th scope="col"><button data-log-sort="id">#${arrow('id')}</button></th>${cols.map((c) => `<th scope="col"><button data-log-sort="${c.id}">${escapeXML(c.label)}${arrow(c.id)}</button></th>`).join('')}</tr>`;
  const body = sortedRows()
    .map((r) => `<tr data-log-row="${r.id}" aria-selected="${log.selected.has(r.id)}"><th scope="row">${r.id}</th>${cols.map((c) => `<td class="${c.numeric ? 'num' : ''}">${escapeXML(String(r.values[c.id] ?? ''))}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="log-scroll"><table class="measure-log"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}
function exportCSV(onlySelected: boolean) {
  const rows = sortedRows().filter((r) => !onlySelected || log.selected.has(r.id));
  const cols = [{ id: 'id', label: 'ID' }, ...logColumns()];
  const csv = toCSV(cols, rows.map((r) => ({ id: r.id, ...r.values })));
  download(new Blob([csv], { type: 'text/csv' }), 'measurements.csv');
}
function deleteRows(e: Editor, ids: Set<number>) {
  log.rows = log.rows.filter((r) => !ids.has(r.id));
  log.selected.clear();
  e.dock.update();
}

// ----- Measurement scale -----
type Preset = MeasurementScale & { name: string };
function presets(): Preset[] {
  const v = storedList('photo-studio-scale-presets');
  return Array.isArray(v) ? v.filter((p) => validScale(p) && typeof (p as Preset).name === 'string') : [];
}
function savePresets(list: Preset[]) {
  store('photo-studio-scale-presets', list);
  registerPresetCommands();
}
function setScale(e: Editor, s: MeasurementScale | undefined, label = 'Set Measurement Scale') {
  editAnnotations(e, label, (a) => {
    a.scale = s && !isDefaultScale(s) ? s : undefined;
  });
}
let presetIds: string[] = [];
function registerPresetCommands() {
  for (const id of presetIds) commands.delete(id);
  presetIds = presets().map((p, i) => {
    const id = `analysis.scale-preset-${i}`;
    registerCommand({
      id,
      label: p.name,
      menu: 'image.analysis-scale',
      order: 10 + i,
      enabled: (e) => e.hasDocument,
      checked: (e) => {
        const s = annotationsOf(e.doc).scale;
        return !!s && s.pixels === p.pixels && s.length === p.length && s.units === p.units;
      },
      run: (e) => setScale(e, { pixels: p.pixels, length: p.length, units: p.units }),
    });
    return id;
  });
}

async function scaleDialog(e: Editor) {
  const current = annotationsOf(e.doc).scale ?? defaultScale;
  const ruler = rulerLine(e);
  const rulerLength = ruler ? rulerMetrics(ruler).length : 0;
  let list = presets();
  const presetOptions = () => `<option value="">Custom</option>${list.map((p, i) => `<option value="${i}">${escapeXML(p.name)}</option>`).join('')}`;
  let result: MeasurementScale | undefined;
  const ok = await openDialog(
    `<form method="dialog" class="scale-dialog"><h2>Measurement Scale</h2><p class="muted">How many image pixels correspond to a known real-world length. Recorded measurements and the Ruler tool (with Use Measurement Scale) report in these units.</p>
    <label class="dialog-field">Preset <span class="scale-row"><select name="preset">${presetOptions()}</select><button type="button" data-scale-delete disabled>Delete</button></span></label>
    <label class="dialog-field">Save as preset <span class="scale-row"><input name="presetName" maxlength="64" placeholder="Preset name"><button type="button" data-scale-save>Save</button></span></label>
    <label class="dialog-field">Pixel length <span class="scale-row"><input name="pixels" type="number" min="0.0001" step="any" required value="${short(current.pixels, 4)}">${ruler ? `<button type="button" data-scale-ruler title="Use the length of the current Ruler tool line">Use Ruler (${short(rulerLength, 1)} px)</button>` : ''}</span></label>
    <label class="dialog-field">Logical length <input name="length" type="number" min="0.0001" step="any" required value="${short(current.length, 6)}"></label>
    <label class="dialog-field">Logical units <input name="units" required maxlength="32" value="${escapeXML(current.units)}" list="scale-units"></label>
    <datalist id="scale-units">${['pixels', 'nm', 'µm', 'mm', 'cm', 'm', 'km', 'in', 'ft', 'yd', 'mi'].map((u) => `<option value="${u}">`).join('')}</datalist>
    <p class="scale-summary muted"></p>
    <div class="dialog-actions"><button type="button" data-scale-default>Default</button><span class="dialog-spacer"></span><button type="button" data-dialog-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`,
    'scale-dialog-host',
    (form) => {
      const input = (n: string) => form.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
      const presetSel = form.querySelector<HTMLSelectElement>('[name="preset"]')!;
      const summary = () => {
        const p = Number(input('pixels').value),
          l = Number(input('length').value);
        form.querySelector('.scale-summary')!.textContent = p > 0 && l > 0 ? `1 pixel = ${short(l / p, 6)} ${input('units').value || 'units'}; 1 ${input('units').value || 'unit'} = ${short(p / l, 4)} pixels.` : '';
        const i = list.findIndex((x) => x.pixels === p && x.length === l && x.units === input('units').value);
        presetSel.value = i >= 0 ? String(i) : '';
        form.querySelector<HTMLButtonElement>('[data-scale-delete]')!.disabled = i < 0;
      };
      form.addEventListener('input', (ev) => {
        const name = (ev.target as HTMLElement).getAttribute('name');
        if (name !== 'preset' && name !== 'presetName') summary();
      });
      presetSel.addEventListener('change', () => {
        const p = list[Number(presetSel.value)];
        if (!p) return;
        input('pixels').value = String(p.pixels);
        input('length').value = String(p.length);
        input('units').value = p.units;
        summary();
      });
      form.querySelector('[data-scale-ruler]')?.addEventListener('click', () => {
        input('pixels').value = short(rulerLength, 4);
        summary();
      });
      form.querySelector('[data-scale-default]')!.addEventListener('click', () => {
        input('pixels').value = '1';
        input('length').value = '1';
        input('units').value = 'pixels';
        summary();
      });
      form.querySelector('[data-scale-save]')!.addEventListener('click', () => {
        const s = { pixels: Number(input('pixels').value), length: Number(input('length').value), units: input('units').value.trim() };
        if (!validScale(s)) return;
        const name = input('presetName').value.trim() || `${short(s.pixels, 2)} px = ${short(s.length, 4)} ${s.units}`;
        input('presetName').value = '';
        list = [...list.filter((p) => p.name !== name), { name: name.slice(0, 64), ...s }];
        savePresets(list);
        presetSel.innerHTML = presetOptions();
        summary();
      });
      form.querySelector('[data-scale-delete]')!.addEventListener('click', () => {
        const i = Number(presetSel.value);
        if (!(i >= 0)) return;
        list = list.filter((_, j) => j !== i);
        savePresets(list);
        presetSel.innerHTML = presetOptions();
        summary();
      });
      form.addEventListener('submit', () => {
        const s = { pixels: Number(input('pixels').value), length: Number(input('length').value), units: input('units').value.trim() };
        if (validScale(s)) result = s;
      }, { capture: true });
      summary();
    },
  );
  if (ok && result) setScale(e, result);
}

async function dataPointsDialog(e: Editor) {
  const groups: DataPoint['group'][] = ['General', 'Selection', 'Ruler', 'Count'];
  let chosen: string[] | undefined;
  const ok = await openDialog(
    `<form method="dialog" class="data-points-dialog"><h2>Data Points</h2><p class="muted">Columns recorded in the Measurement Log. Values that do not apply to a measurement stay empty.</p><div class="data-point-groups">${groups
      .map((g) => `<fieldset><legend>${g}</legend>${DATA_POINTS.filter((d) => d.group === g && d.id !== 'label').map((d) => `<label class="checkbox-field"><input type="checkbox" name="dp" value="${d.id}" ${dataPoints.includes(d.id) ? 'checked' : ''}>${escapeXML(d.label)}</label>`).join('')}</fieldset>`)
      .join('')}</div><div class="dialog-actions"><button type="button" data-dp-all>Select All</button><button type="button" data-dp-none>Select None</button><span class="dialog-spacer"></span><button type="button" data-dialog-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`,
    'data-points-host',
    (form) => {
      const boxes = () => [...form.querySelectorAll<HTMLInputElement>('input[name="dp"]')];
      form.querySelector('[data-dp-all]')!.addEventListener('click', () => boxes().forEach((b) => (b.checked = true)));
      form.querySelector('[data-dp-none]')!.addEventListener('click', () => boxes().forEach((b) => (b.checked = false)));
      form.addEventListener('submit', () => (chosen = boxes().filter((b) => b.checked).map((b) => b.value)), { capture: true });
    },
  );
  if (!ok || !chosen) return;
  dataPoints = chosen;
  store('photo-studio-data-points', dataPoints);
  e.dock.update();
}

// ----- Scale marker -----
function niceLength(target: number) {
  const p = 10 ** Math.floor(Math.log10(target));
  return ([1, 2, 5, 10].map((n) => n * p).filter((v) => v <= target).at(-1) ?? p);
}
export async function placeScaleMarker(e: Editor) {
  const s = annotationsOf(e.doc).scale ?? defaultScale;
  const f = scaleFactor(s);
  const suggested = niceLength((e.doc.width / 5) * f);
  let v: Record<string, string> | undefined;
  const ok = await openDialog(
    `<form method="dialog" class="scale-marker-dialog"><h2>Scale Marker</h2><p class="muted">${isDefaultScale(s) ? 'The document uses the default scale (1 pixel = 1 pixel). Set a measurement scale first to show real-world units.' : `Scale: ${escapeXML(scaleText(s))}.`}</p>
    <label class="dialog-field">Length (${escapeXML(s.units)}) <input name="length" type="number" min="0.0001" step="any" required value="${suggested}"></label>
    <label class="dialog-field">Bar height (px) <input name="bar" type="number" min="1" max="200" step="1" required value="${Math.max(2, Math.round(e.doc.height / 150))}"></label>
    <label class="dialog-field">Font size (px) <input name="font" type="number" min="4" max="400" step="1" required value="${Math.max(10, Math.round(e.doc.height / 40))}"></label>
    <label class="dialog-field checkbox-field"><input type="checkbox" name="caption" checked>Show caption</label>
    <label class="dialog-field">Caption <select name="captionAt"><option value="above">Above the bar</option><option value="below">Below the bar</option></select></label>
    <label class="dialog-field">Color <select name="color"><option value="#000000">Black</option><option value="#ffffff">White</option><option value="fg">Foreground color</option></select></label>
    <label class="dialog-field">Position <select name="corner"><option value="bl">Bottom left</option><option value="br">Bottom right</option><option value="tl">Top left</option><option value="tr">Top right</option></select></label>
    <div class="dialog-actions"><button type="button" data-dialog-cancel>Cancel</button><button type="submit" class="primary">Place</button></div></form>`,
    'scale-marker-host',
    (form) => {
      form.addEventListener('submit', () => {
        v = {};
        for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')) v[el.name] = el.type === 'checkbox' ? ((el as HTMLInputElement).checked ? 'yes' : 'no') : el.value;
      }, { capture: true });
    },
  );
  if (!ok || !v) return;
  const length = Number(v.length);
  const barPx = length / f;
  if (!(barPx >= 1) || barPx > e.doc.width) {
    e.message(`A ${short(length, 4)} ${s.units} bar would be ${Math.round(barPx)} pixels; choose a length that fits the image.`);
    return;
  }
  const color = v.color === 'fg' ? e.color : v.color;
  await createScaleMarker(e, { barPx, barHeight: Number(v.bar), fontPx: Number(v.font), caption: v.caption === 'yes' ? `${short(length, 4)} ${s.units}` : '', captionAbove: v.captionAt !== 'below', color, corner: v.corner as 'bl' | 'br' | 'tl' | 'tr' });
}
export async function createScaleMarker(
  e: Editor,
  o: { barPx: number; barHeight: number; fontPx: number; caption: string; captionAbove: boolean; color: string; corner: 'bl' | 'br' | 'tl' | 'tr' },
) {
  const { shapeLayer } = await import('../vector/state');
  const { closedPath, liveKnots } = await import('../vector/geometry');
  const { prepareFonts } = await import('../../imaging/text/fonts');
  const { layoutOf, localBounds, ppiOf } = await import('../type/text-utils');
  const doc = e.doc;
  const margin = Math.round(Math.min(doc.width, doc.height) * 0.04);
  const ppi = ppiOf(e);
  // Caption layout first: its height decides where the bar sits.
  let text: Layer | undefined;
  let textBox = { x: 0, y: 0, width: 0, height: 0 };
  if (o.caption) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(o.color.slice(i, i + 2), 16));
    const style = { ...defaultCharStyle(), size: (o.fontPx * 72) / ppi, color: [r, g, b] as [number, number, number] };
    const data: TextLayerData = { content: fromPlainText(o.caption, style, defaultParagraphStyle()), mode: 'point', origin: { x: 0, y: 0 }, orientation: 'horizontal', antiAlias: 'smooth' };
    await prepareFonts(data);
    textBox = localBounds(data, layoutOf(data, ppi));
    text = newLayer('text', o.caption, 1, 1);
    text.textData = data;
    text.color = o.color;
  }
  const gap = Math.round(o.fontPx * 0.35);
  const total = o.barHeight + (text ? gap + textBox.height : 0);
  const left = o.corner.endsWith('l') ? margin : doc.width - margin - o.barPx;
  const top = o.corner.startsWith('t') ? margin : doc.height - margin - total;
  const barY = text && o.captionAbove ? top + textBox.height + gap : top;
  const live = { kind: 'rect' as const, x: left, y: barY, width: o.barPx, height: o.barHeight, radii: [0, 0, 0, 0] as [number, number, number, number] };
  const bar = shapeLayer(doc, 'Scale Bar', { paths: [closedPath(liveKnots(live))] }, vectorHexColor(o.color), undefined, live, o.color);
  const group = newLayer('group', 'Measurement Scale Marker', doc.width, doc.height);
  group.children = [bar];
  if (text) {
    const cx = left + o.barPx / 2;
    const ty = o.captionAbove ? top : barY + o.barHeight + gap;
    // Move the caption so its bounds center over the bar (a new data object:
    // layouts are cached by identity).
    const data: TextLayerData = { ...text.textData!, origin: { x: cx - (textBox.x + textBox.width / 2), y: ty - textBox.y } };
    text.textData = data;
    const b = localBounds(data, layoutOf(data, ppi));
    text.textFrame = { ...b, width: Math.max(1, b.width), height: Math.max(1, b.height) };
    text.transform = { ...text.textFrame, rotation: 0 };
    syncLegacyFields(text);
    group.children.push(text);
  }
  insertAboveSelection(e, group, 'Place Scale Marker');
}

export function installAnalysis(_e: Editor) {
  registerCommand(
    { id: 'analysis.scale-default', label: 'Default', menu: 'image.analysis-scale', order: 0, enabled: (e) => e.hasDocument, checked: (e) => isDefaultScale(annotationsOf(e.doc).scale), run: (e) => setScale(e, undefined, 'Default Measurement Scale') },
    { id: 'analysis.scale-custom', label: 'Custom…', menu: 'image.analysis-scale', order: 1, enabled: (e) => e.hasDocument, run: (e) => scaleDialog(e) },
    { id: 'analysis.data-points', label: 'Select Data Points…', run: (e) => dataPointsDialog(e), recordable: false },
    { id: 'analysis.record', label: 'Record Measurements', shortcut: 'Mod+Shift+M', enabled: (e) => e.hasDocument, run: (e) => recordMeasurements(e), recordable: false },
    { id: 'analysis.ruler-tool', label: 'Ruler Tool', run: (e) => e.setTool('ruler'), recordable: false },
    { id: 'analysis.count-tool', label: 'Count Tool', run: (e) => e.setTool('count'), recordable: false },
    { id: 'analysis.scale-marker', label: 'Place Scale Marker…', enabled: (e) => e.hasDocument, run: (e) => placeScaleMarker(e) },
    { id: 'log.export', label: 'Export Measurements', enabled: () => log.rows.length > 0, run: () => exportCSV(log.selected.size > 0), recordable: false },
    { id: 'log.delete', label: 'Delete Selected Measurements', enabled: () => log.selected.size > 0, run: (e) => deleteRows(e, new Set(log.selected)), recordable: false },
    { id: 'log.clear', label: 'Clear Measurement Log', enabled: () => log.rows.length > 0, run: (e) => deleteRows(e, new Set(log.rows.map((r) => r.id))), recordable: false },
    { id: 'log.select-all', label: 'Select All Measurements', enabled: () => log.rows.length > 0, run: (e) => { log.selected = new Set(log.rows.map((r) => r.id)); e.dock.update(); }, recordable: false },
  );
  registerPresetCommands();
  registerPanel({
    id: 'measurement-log',
    title: 'Measurement Log',
    icon: 'list-ordered',
    location: 'strip',
    hidden: true,
    mount: (e, el) => {
      el.classList.add('log-panel');
      el.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const sort = t.closest<HTMLElement>('[data-log-sort]');
        if (sort) {
          const key = sort.dataset.logSort!;
          log.sort = log.sort?.key === key ? (log.sort.dir > 0 ? { key, dir: -1 } : undefined) : { key, dir: 1 };
          e.dock.update();
          return;
        }
        const row = t.closest<HTMLElement>('[data-log-row]');
        if (row) {
          const id = Number(row.dataset.logRow);
          if (ev.shiftKey && log.selected.size) {
            const ids = sortedRows().map((r) => r.id);
            const last = [...log.selected].at(-1)!;
            const [a, b] = [ids.indexOf(last), ids.indexOf(id)].sort((x, y) => x - y);
            for (const x of ids.slice(a, b + 1)) log.selected.add(x);
          } else if (ev.metaKey || ev.ctrlKey) {
            if (log.selected.has(id)) log.selected.delete(id);
            else log.selected.add(id);
          } else log.selected = new Set([id]);
          e.dock.update();
        }
      });
      el.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Backspace' || ev.key === 'Delete') && log.selected.size) {
          ev.preventDefault();
          ev.stopPropagation();
          deleteRows(e, new Set(log.selected));
        }
      });
    },
    update: (_e, el) => {
      const scroll = el.querySelector('.log-scroll');
      const left = scroll?.scrollLeft ?? 0,
        top = scroll?.scrollTop ?? 0;
      const n = log.rows.length,
        sel = log.selected.size;
      el.innerHTML = `<div class="log-toolbar"><button data-command="analysis.record" title="Record Measurements${escapeXML(recordKeys())}">${svg('plus', 14)} Record</button><span class="muted">${n} row${n === 1 ? '' : 's'}${sel ? `, ${sel} selected` : ''}</span><span class="panel-tabs-spacer"></span><button class="icon-button" data-command="log.export" ${n ? '' : 'disabled'} title="${sel ? 'Export selected rows as CSV' : 'Export all rows as CSV'}" aria-label="Export CSV">${svg('download', 14)}</button><button class="icon-button" data-command="log.delete" ${sel ? '' : 'disabled'} title="Delete selected rows" aria-label="Delete selected rows">${svg('trash-2', 14)}</button></div>${logHtml()}`;
      el.tabIndex = -1;
      const next = el.querySelector('.log-scroll');
      if (next) {
        next.scrollLeft = left;
        next.scrollTop = top;
      }
    },
    menu: () => ['analysis.record', 'analysis.data-points', '-', 'log.select-all', 'log.delete', 'log.clear', '-', 'log.export'],
  });
}
