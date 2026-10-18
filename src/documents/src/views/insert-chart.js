/**
 * Insert → Chart: a chart type, a small data grid and a live preview. The chart is written as a
 * chart part (c:chartSpace, ECMA-376 Part 1 §21.2) with its data inline, referenced from an inline
 * drawing; editing the data writes a new chart part and replaces the drawing in one undo step.
 */
import { el } from '../ui/dom.js';
import { formDialog } from './insert-dialogs.js';
import { CHART_TYPES, CHART_PALETTE, CHART_CONTENT_TYPE, CHART_RELATIONSHIP_TYPE, chartSpaceXml, defaultChartData, chartDataFromXml } from '../engine/chart-builder.js';
import { drawingFrame, freshPart, readDrawingFragment, carriedFrame, EMU_PER_INCH } from '../engine/inserted-drawings.js';

/** A chart drawing fragment: the chart part and the inline frame that references it. */
export async function chartFragment(model, packageParts, data, { id, width = 5.5 * EMU_PER_INCH, height = 3.2 * EMU_PER_INCH }) {
  const xml = chartSpaceXml(data), part = freshPart(model, packageParts, 'charts', 'canvas-chart', 'xml');
  const graphic = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="${part.relId}"/></a:graphicData></a:graphic>`;
  try {
    return await readDrawingFragment(drawingFrame({ id, name: `Chart ${id}`, descr: data.title ? `Chart: ${data.title}` : '', width, height, graphic }),
      { parts: [{ ...part, bytes: xml, contentType: CHART_CONTENT_TYPE, relType: CHART_RELATIONSHIP_TYPE }] });
  } catch (e) {
    throw new Error(/mixed-script/.test(e.message) ? 'Chart labels must use Latin script in this version. Rename the categories or series and try again.' : e.message);
  }
}

/** The chart XML behind a chart image: its inserted part, or the opened document's part. */
export function chartXml(image, assets, packageParts) {
  const parts = assets[image.assetId]?.packageParts;
  const bytes = parts?.find(p => p.path === image.assetId)?.bytes || packageParts?.[image.assetId];
  return bytes ? (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)) : null;
}

/** Chart dialog: type, title, legend and a data grid of categories × series, with a preview. */
export function openChartDialog({ initial = null, onInsert, onClose }) {
  const data = structuredClone(initial || defaultChartData('column-clustered'));
  let type = data.type;
  const groups = [...new Set(CHART_TYPES.map(t => t.group))];
  const typeList = el('div.insert-chart-types', { role: 'listbox', 'aria-label': 'Chart type' });
  const options = CHART_TYPES.map(t => el('button.insert-chart-type', { type: 'button', role: 'option', 'aria-selected': String(t.id === type), dataset: { type: t.id }, onclick: () => setType(t.id) }, t.label));
  for (const group of groups) typeList.append(el('div.menu-header', {}, group), ...options.filter(o => CHART_TYPES.find(t => t.id === o.dataset.type).group === group));
  const title = el('input.input', { type: 'text', value: data.title || '', 'aria-label': 'Chart title' });
  const legend = el('select.input', { 'aria-label': 'Legend' }, el('option', { value: 'r' }, 'Right'), el('option', { value: 'b' }, 'Bottom'), el('option', { value: '' }, 'None'));
  legend.value = data.legend ?? '';
  const grid = el('table.insert-chart-grid', { 'aria-label': 'Chart data' });
  const preview = el('canvas.insert-chart-preview', { width: 440, height: 260, 'aria-hidden': 'true' });
  const status = el('p.field-hint', { 'aria-live': 'polite' });
  const single = () => ['pie', 'doughnut'].includes(type);
  function setType(next) {
    type = next;
    for (const o of options) o.setAttribute('aria-selected', String(o.dataset.type === type));
    if (single() && data.series.length > 1) data.series = data.series.slice(0, 1);
    drawGrid(); render();
  }
  // A value cell holds what was typed; one that is not a number ("1,200", "12%", "$5") is marked, and Insert
  // says which, rather than saving it as 0.
  const numberOf = value => { const text = String(value ?? '').trim(); return text === '' ? 0 : Number(text); };
  const cellInput = (value, label, onInput, numeric = false) => el('input.input', { type: 'text', inputMode: numeric ? 'decimal' : 'text', value: String(value ?? ''), 'aria-label': label,
    oninput: e => { onInput(e.target.value); if (numeric) { if (Number.isFinite(numberOf(e.target.value))) e.target.removeAttribute('aria-invalid'); else e.target.setAttribute('aria-invalid', 'true'); } render(); } });
  function drawGrid() {
    const head = el('tr', {}, el('th', {}, ''), ...data.series.map((s, j) => el('th', {}, cellInput(s.name, `Series ${j + 1} name`, v => { s.name = v; }))),
      el('th', {}, el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: single() || data.series.length >= 20, title: 'Add a series', onclick: () => { data.series.push({ name: `Series ${data.series.length + 1}`, values: data.categories.map(() => 0), color: CHART_PALETTE[data.series.length % CHART_PALETTE.length] }); drawGrid(); render(); } }, '+ Series')));
    const body = data.categories.map((category, i) => el('tr', {}, el('th', {}, cellInput(category, `Category ${i + 1}`, v => { data.categories[i] = v; })),
      ...data.series.map((s, j) => el('td', {}, cellInput(s.values[i], `${s.name || `Series ${j + 1}`}, ${category}`, v => { s.values[i] = v; }, true))),
      el('td', {}, el('button.icon-btn.insert-chart-remove', { type: 'button', 'aria-label': `Remove ${category || `row ${i + 1}`}`, title: 'Remove row', disabled: data.categories.length <= 1, onclick: () => { data.categories.splice(i, 1); for (const s of data.series) s.values.splice(i, 1); drawGrid(); render(); } }, '×'))));
    const foot = el('tr', {}, el('td', { colSpan: data.series.length + 2 },
      el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: data.categories.length >= 100, onclick: () => { data.categories.push(type.startsWith('scatter') ? String(data.categories.length + 1) : `Category ${data.categories.length + 1}`); for (const s of data.series) s.values.push(0); drawGrid(); render(); } }, '+ Row'),
      data.series.length > 1 ? el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { data.series.pop(); drawGrid(); render(); } }, '− Series') : null));
    grid.replaceChildren(el('thead', {}, head), el('tbody', {}, ...body, foot));
  }
  const current = () => ({ type, title: title.value.trim(), legend: legend.value || null, categories: data.categories.map(c => String(c)), series: data.series.map((s, j) => ({ name: s.name || `Series ${j + 1}`, values: s.values.map(v => Number.isFinite(numberOf(v)) ? numberOf(v) : 0), color: s.color || CHART_PALETTE[j % CHART_PALETTE.length], ...(s.colors ? { colors: s.colors } : {}) })) });
  let pending = 0;
  async function render() {
    const ticket = ++pending;
    try {
      const { chart, fragmentAsset } = await previewChart(current());
      if (ticket !== pending) return;
      const ctx = preview.getContext('2d'), ratio = window.devicePixelRatio || 1;
      preview.width = 440 * ratio; preview.height = 260 * ratio; preview.style.width = '440px'; preview.style.height = '260px';
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, 440, 260);
      const { paintChart } = await import('../engine/canvas-charts.js');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 440, 260); paintChart(ctx, chart, 440, 260);
      status.textContent = ''; void fragmentAsset;
    } catch (e) { if (ticket === pending) status.textContent = e.message; }
  }
  title.addEventListener('input', render); legend.addEventListener('change', render);
  const dialog = formDialog({ title: initial ? 'Edit Chart' : 'Insert Chart', submit: initial ? 'Update' : 'Insert', wide: true, className: 'insert-chart', onClose, content: [
    el('div.insert-chart-layout', {}, typeList, el('div.insert-chart-editor', {}, el('div.insert-chart-meta', {}, el('label.field', {}, el('span.field-label', {}, 'Title'), title), el('label.field', {}, el('span.field-label', {}, 'Legend'), legend)),
      preview, status, el('div.insert-chart-data', {}, grid)))],
  onSubmit: () => {
    for (const [j, s] of data.series.entries()) for (const [i, v] of s.values.entries()) {
      if (!Number.isFinite(numberOf(v))) throw new Error(`“${String(v).trim()}” (${s.name || `Series ${j + 1}`}, ${data.categories[i]}) is not a number. Enter numbers such as 1200 or 1.5, without separators, signs or units.`);
    }
    return onInsert(current());
  } });
  drawGrid(); render(); options.find(o => o.dataset.type === type)?.focus();
  return dialog.modal;
}

/** The decoded chart model for data, read through the same reader the document uses. */
async function previewChart(data) {
  const fragment = await chartFragment({ assets: {} }, {}, data, { id: 1, width: 440 * 9525, height: 260 * 9525 });
  return { chart: fragment.assets[fragment.image.assetId].chart, fragmentAsset: fragment.assets[fragment.image.assetId] };
}

/** Chart commands for the Insert tab, on top of the hub's drawing insertion. */
export function chartCommands({ hub, pkg, editor }) {
  const selectedChart = () => { const image = hub.ready()?.model.selectedImage; return image?.kind === 'chart' ? image : null; };
  function open(edit) {
    const engine = hub.ready(); if (!engine) return;
    const image = edit ? selectedChart() : null;
    let initial = null;
    if (image) {
      const xml = chartXml(image, engine.model.assets, pkg().parts);
      try { initial = xml ? chartDataFromXml(xml) : null; } catch { initial = null; }
      if (!initial) { hub.fail(new Error('This chart’s data cannot be edited here. It is kept as it is.')); return; }
    }
    openChartDialog({ initial, onClose: () => queueMicrotask(() => editor()?.focus()), onInsert: data => hub.insertDrawing(async (engine, id) => {
      const width = image ? image.width : Math.min(hub.textWidth(engine), 5.5 * EMU_PER_INCH), height = image ? image.height : Math.round(width * 0.58);
      const fragment = await chartFragment(engine.model, pkg().parts, data, { id, width, height });
      if (!image) return fragment;
      // An edited chart keeps its frame (position, wrapping, title, decorative mark) and the alt text the
      // reader wrote; alt text made from the old title follows the new one.
      const generated = image.alt === (initial.title ? `Chart: ${initial.title}` : '');
      const alt = generated ? fragment.image.alt : image.alt;
      let shell = carriedFrame(image.shell, fragment.image.shell, new Set());
      if (generated) shell = shell.replace(/(<wp:docPr\b[^>]*?)\sdescr="[^"]*"/, '$1').replace(/<wp:docPr\b/, alt ? `$& descr="${alt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}"` : '$&');
      return { ...fragment, image: { ...fragment.image, ...(image.anchor ? { anchor: image.anchor } : {}), ...(image.title !== undefined ? { title: image.title } : {}), ...(image.decorative !== undefined ? { decorative: image.decorative } : {}), name: image.name, alt, shell } };
    }, { replace: image }) });
  }
  return { insertChart: () => open(!!selectedChart()), editChart: () => open(true), selectedChart };
}
