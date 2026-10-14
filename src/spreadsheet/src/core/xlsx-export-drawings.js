import { cellAnchorFrame, drawingAxisOffsets, exportCellAnchor } from './drawing-cell-anchor.js';
import { slicerFrameXml, nativePivotSlicerParts } from './xlsx-export-slicers.js';
/** DrawingML charts and pictures for readers which do not know the app's sidecar. */
import { authoredBarGapWidth, chartPointStyle, chartData, textBoxText } from './charts.js';
import { fontName, styleToNumFmt, formatValue, numFmtToStyle } from './format.js';
import { xmlTag as tag, xmlText } from './xlsx-export-styles.js';
import { renderChartSvg, standaloneSvg, seriesColor } from '../ui/chartsvg.js';
import { nativeDrawingXml, normalizeNativeDrawing, validDrawingKey } from './drawingml-native.js';
import { identifyDrawing, drawingBaseline } from './xlsx-drawing-reconcile.js';
import { readXlsxCharts } from './xlsx-charts.js';
import { xlsxAttr } from './xlsx-styles.js';
import { decorativeXml, drawingDescription } from './drawingml-accessibility.js';
import { linkedPictureTarget, rangePicture, svgDataUrl } from './range-picture.js';
import { roundedRadius } from './picture-format.js';
import { equationAnchorXml, equationParagraphs } from './xlsx-equation.js';
import { effectRefStyleXml } from './theme-effects.js';
import { smartArtGroupXml } from './xlsx-smartart.js';
import { workbookTheme } from './workbook-theme.js';
import { CHARTEX_CONTENT_TYPE, CHARTEX_REL, CHARTEX_TYPES, CHART_COLORS_REL, CHART_STYLE_REL, chartExColorsXml, chartExFrame, chartExStyleXml, chartExXml } from './xlsx-chartex.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const C15 = 'http://schemas.microsoft.com/office/drawing/2012/chart';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const emu = px => Math.round(px * 9525);
const pictureRectAttrs = rect => Object.fromEntries(Object.entries(rect || {}).map(([k, v]) => [k, Math.round(v * 100000)]));
const val = (name, value) => tag(`c:${name}`, { val: value });
const rangeLabelVisibility = visible => tag('c:extLst', {}, tag('c:ext', {
  uri: '{CE6537A1-D6FC-4f65-9D91-7224C49458BB}', 'xmlns:c15': C15,
}, tag('c15:showDataLabelsRange', { val: Number(visible) })));
const paint = color => /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color || '') ? tag('a:solidFill', {}, tag('a:srgbClr', { val: color.slice(1, 7).toUpperCase() },
  color.length === 9 ? tag('a:alpha', { val: Math.round(parseInt(color.slice(7), 16) / 255 * 100000) }) : '')) : tag('a:noFill');
const gradientPaint = gradient => gradient?.stops?.length ? tag('a:gradFill', { rotWithShape: 1 },
  tag('a:gsLst', {}, gradient.stops.map(stop => tag('a:gs', { pos: Math.round(stop.offset * 100000) },
    tag('a:srgbClr', { val: stop.color.slice(1, 7).toUpperCase() }, tag('a:alpha', { val: Math.round(stop.opacity * 100000) })))).join(''))
  + tag('a:lin', { ang: Math.round(gradient.angle % 360 * 60000), scaled: Number(gradient.scaled === true) })) : '';
const gridlines = (visible, style) => {
  if (!visible && style?.color !== 'none') return '';
  // Retain an imported no-fill line while disabled. Enabling gridlines in the
  // editor overrides that choice; otherwise retain unspecified automatic paint.
  const color = visible ? style?.color === 'none' ? null : style?.color : 'none';
  const fill = color === 'none' ? tag('a:noFill') : color ? tag('a:solidFill', {}, tag('a:srgbClr', { val: color.slice(1, 7).toUpperCase() },
    color.length === 9 ? tag('a:alpha', { val: Math.round(parseInt(color.slice(7), 16) / 255 * 100000) }) : '')) : '';
  const line = fill || style?.width != null ? tag('a:ln', style?.width == null ? {} : { w: emu(style.width) }, fill) : '';
  return tag('c:majorGridlines', {}, line ? tag('c:spPr', {}, line) : '');
};
const lineShape = (style, background = '') => {
  if (!style || (style.color == null && style.width == null && style.dash == null)) return background ? tag('c:spPr', {}, background) : '';
  const color = style.color;
  return tag('c:spPr', {}, background + tag('a:ln', style.width == null ? {} : { w: emu(style.width) },
    (color == null ? '' : paint(color)) + (style.dash ? tag('a:prstDash', { val: style.dash }) : '')));
};
// The model stores absolute chart-relative positions. In MS-OI29500
// 21.2.3.20, factor x/y are offsets from the automatic position, while edge
// x/y are absolute. Omitted dimensions remain automatic, not empty doubles.
// layoutTarget chooses whether a plot area's bounds include its axes. It does
// not apply to titles, legends or display-unit labels; Excel removes a chart
// whose title carries it, even though CT_ManualLayout permits the element.
const layout = (box, plotArea = false) => tag('c:layout', {}, box ? tag('c:manualLayout', {}, (plotArea ? val('layoutTarget', 'inner') : '') + val('xMode', 'edge') + val('yMode', 'edge')
  + val('wMode', 'factor') + val('hMode', 'factor') + ['x', 'y', 'w', 'h'].filter(k => Number.isFinite(box[k])).map(k => val(k, box[k])).join('')) : '');

/** Format ▸ Shape Effects: a:effectLst for an element's outer shadow or glow. */
const effectList = e => e?.shadow || e?.glow ? tag('a:effectLst', {}, (e.glow ? tag('a:glow', { rad: 63500 }, tag('a:srgbClr', { val: e.glow.slice(1).toUpperCase() }, tag('a:alpha', { val: 60000 }))) : '')
  + (e.shadow ? tag('a:outerShdw', { blurRad: 50800, dist: 38100, dir: 2700000, algn: 'tl', rotWithShape: 0 }, tag('a:srgbClr', { val: '000000' }, tag('a:alpha', { val: 40000 }))) : '')) : '';
/** Put an element's effects at the end of its c:spPr (after the fill and line, as CT_ShapeProperties orders them). */
const withEffects = (spPr, e) => {
  const fx = effectList(e);
  if (!fx) return spPr;
  return spPr ? spPr.replace(/<\/c:spPr>$/, `${fx}</c:spPr>`).replace(/^<c:spPr\/>$/, tag('c:spPr', {}, fx)) : tag('c:spPr', {}, fx);
};
/** A title's or legend's own fill and outline, with its effects. */
const boxShape = (box, e) => withEffects(box && (box.fill || box.stroke) ? tag('c:spPr', {}, (box.fill ? paint(box.fill) : '') + (box.stroke ? tag('a:ln', {}, paint(box.stroke)) : '')) : '', e);

function textStyle(s = {}, name = 'a:defRPr') {
  const fx = s.effects || null;
  // CT_TextCharacterProperties orders the outline, then the fill, then the effects, then the faces.
  const outline = fx?.outline ? tag('a:ln', { w: Math.round(fx.outlineWidth * 9525) }, paint(fx.outline)) : '';
  const shade = (hex, alpha) => tag('a:srgbClr', { val: hex.slice(1).toUpperCase() }, tag('a:alpha', { val: alpha }));
  const effects = fx?.glow || fx?.shadow ? tag('a:effectLst', {}, (fx.glow ? tag('a:glow', { rad: 63500 }, shade(fx.glow, 60000)) : '')
    + (fx.shadow ? tag('a:outerShdw', { blurRad: 38100, dist: 38100, dir: 2700000, algn: 'tl', rotWithShape: 0 }, shade(fx.shadow, 43000)) : '')) : '';
  return tag(name, { sz: Math.round((s.size || 13) * 75), b: Number(!!s.bold), i: Number(!!s.italic) },
    outline + paint(s.color || '#000000') + effects + tag('a:latin', { typeface: fontName(s.font) || 'Calibri' }));
}
const textProps = (s, rotation = 0, wrap) => tag('c:txPr', {}, tag('a:bodyPr', { ...(rotation == null ? {} : { rot: Math.round(rotation * 60000) }), ...(wrap ? { wrap } : {}) }) + tag('a:lstStyle')
  + tag('a:p', {}, tag('a:pPr', {}, textStyle(s)) + tag('a:endParaRPr', { lang: 'en-US' })));
// Point-label text properties remain sparse so later series edits still inherit.
const labelTextProps = s => tag('c:txPr', {}, tag('a:bodyPr') + tag('a:lstStyle')
  + tag('a:p', {}, tag('a:pPr', {}, tag('a:defRPr', {
    ...(s.size != null ? { sz: Math.round(s.size * 75) } : {}),
    ...Object.fromEntries([['bold', 'b'], ['italic', 'i']].filter(([key]) => typeof s[key] === 'boolean').map(([key, attr]) => [attr, Number(s[key])])),
  }, (s.color ? paint(s.color) : '') + (s.font ? tag('a:latin', { typeface: fontName(s.font) }) : '')))));
const title = (text, style, box, ref, rotation = 0, shape = '') => tag('c:title', {}, (ref ? vector('tx', ref, [text], false)
  : tag('c:tx', {}, tag('c:rich', {}, tag('a:bodyPr', { rot: rotation * 60000 }) + tag('a:lstStyle')
    + tag('a:p', {}, tag('a:pPr', {}, textStyle(style)) + tag('a:r', {}, tag('a:t', {}, xmlText(text)))))))
  + layout(box) + val('overlay', 0) + shape + (ref ? textProps(style, rotation) : ''));

function vector(kind, ref, values, numeric, format = 'General', pointFormats = null) {
  const points = values.map((v, i) => v == null || (numeric && !Number.isFinite(v)) ? '' : tag('c:pt', { idx: i, ...(numeric && pointFormats?.[i] ? { formatCode: pointFormats[i] } : {}) }, tag('c:v', {}, xmlText(v)))).join('');
  const body = (numeric ? tag('c:formatCode', {}, xmlText(format)) : '') + val('ptCount', values.length) + points;
  const type = numeric ? 'num' : 'str';
  return tag(`c:${kind}`, {}, ref ? tag(`c:${type}Ref`, {}, tag('c:f', {}, xmlText(ref)) + tag(`c:${type}Cache`, {}, body)) : tag(`c:${type}Lit`, {}, body));
}

function pieLabels(labels, series, categories, doughnut) {
  if (!labels) return '';
  const extension = (l, point = false) => {
    const box = (point ? ['w', 'h'] : ['x', 'y', 'w', 'h'])
      .filter(k => Number.isFinite(l.extensionLayout?.[k])).map(k => val(k, l.extensionLayout[k])).join('');
    return box ? tag('c:extLst', {}, tag('c:ext', { uri: '{CE6537A1-D6FC-4f65-9D91-7224C49458BB}' },
      tag('c15:layout', { 'xmlns:c15': 'http://schemas.microsoft.com/office/drawing/2012/chart' }, tag('c:manualLayout', {}, box)))) : '';
  };
  const shared = (l, index = null) => {
    // Excel can rewrite numLit's formatCode to General on save. Keep the
    // displayed value format on labels too, rather than relying on that cache.
    const valueOnly = !l.percent && !l.content?.some(c => c.kind === 'percent') && (l.value || l.content?.some(c => c.kind === 'value'));
    const style = index == null && series.pointStyles ? null : chartPointStyle(series, index);
    const numberFormat = l.numberFormat || (valueOnly && style ? styleToNumFmt(style) : '');
    return (numberFormat ? tag('c:numFmt', { formatCode: numberFormat, sourceLinked: 0 }) : '')
    // Office disallows dLblPos on doughnuts (MS-OI29500 21.2.2.48).
    // Excel repairs the whole drawing even for ctr and group-level positions.
    // Its native placement is centered; explicit per-point offsets still apply.
    + textProps(l.style) + (doughnut ? '' : val('dLblPos', l.position)) + val('showLegendKey', 0)
    + ['value', 'category', 'series', 'percent'].map((key, i) => val(['showVal', 'showCatName', 'showSerName', 'showPercent'][i], Number(!!l[key]))).join('')
    + tag('c:separator', {}, xmlText(l.separator));
  };
  const total = series.values.reduce((sum, v) => sum + (Number.isFinite(v) ? Math.abs(v) : 0), 0);
  const content = (l, index) => {
    if (!l.content) return '';
    const value = series.values[index], style = l.numberFormat ? numFmtToStyle(l.numberFormat) : chartPointStyle(series, index);
    const fields = { category: categories[index] || '', series: series.name, value: formatValue(value, style),
      percent: l.numberFormat ? formatValue(total ? Math.abs(value) / total : 0, style) : `${Math.round(total ? Math.abs(value) / total * 100 : 0)}%` };
    const runs = l.content.map(c => c.kind === 'text' ? c.text.split('\n').map((t, i) => (i ? tag('a:br') : '') + (t ? tag('a:r', {}, tag('a:t', {}, xmlText(t))) : '')).join('')
      : tag('a:fld', { id: `{${crypto.randomUUID().toUpperCase()}}`, type: { category: 'CATEGORYNAME', value: 'VALUE', percent: 'PERCENTAGE', series: 'SERIESNAME' }[c.kind] },
        textStyle(l.style, 'a:rPr') + tag('a:t', {}, xmlText(fields[c.kind])))).join('');
    return tag('c:tx', {}, tag('c:rich', {}, tag('a:bodyPr') + tag('a:lstStyle') + tag('a:p', {}, tag('a:pPr', {}, textStyle(l.style)) + runs)));
  };
  const points = new Map((labels.points || []).map(p => [p.index, p]));
  // Rich text is a per-point property in DrawingML, even when the model uses
  // one field template for the entire series.
  if (labels.content || series.pointStyles && !labels.numberFormat && labels.value) series.values.forEach((_, i) => { if (!points.has(i)) points.set(i, { ...labels, extensionLayout: undefined, index: i }); });
  return tag('c:dLbls', {}, [...points.values()].map(l => tag('c:dLbl', {}, val('idx', l.index)
    + (l.hidden ? val('delete', 1) : (l.dx || l.dy ? tag('c:layout', {}, tag('c:manualLayout', {}, val('xMode', 'factor') + val('yMode', 'factor') + val('x', l.dx || 0) + val('y', l.dy || 0))) : '')
      + content(l, l.index) + shared(l, l.index)) + extension(l, true))).join('')
    + (labels.hidden ? val('delete', 1) : shared(labels) + val('showLeaderLines', Number(labels.leaderLines))) + extension(labels));
}

/** Text annotations are DrawingML chart user-shapes, positioned as fractions
 * of the chart frame independently of the plot area's axes. */
function chartAnnotationsXml(annotations) {
  const coord = (name, x, y) => tag(`cdr:${name}`, {}, tag('cdr:x', {}, xmlText(x)) + tag('cdr:y', {}, xmlText(y)));
  return HEADER + tag('c:userShapes', { 'xmlns:c': C, 'xmlns:a': A,
    'xmlns:cdr': 'http://schemas.openxmlformats.org/drawingml/2006/chartDrawing' }, annotations.map((note, i) => {
    const { x, y } = note.box, w = note.box.w ?? .2, h = note.box.h ?? .1;
    return tag('cdr:relSizeAnchor', {}, coord('from', x, y) + coord('to', x + w, y + h)
      + tag('cdr:sp', {}, tag('cdr:nvSpPr', {}, tag('cdr:cNvPr', { id: i + 1, name: `Annotation ${i + 1}` }) + tag('cdr:cNvSpPr', { txBox: 1 }))
        + tag('cdr:spPr', {}, tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')) + paint(note.fill) + tag('a:ln', { w: emu(1) }, paint(note.stroke)))
        + tag('cdr:txBody', {}, tag('a:bodyPr', { wrap: 'square', anchor: 't', lIns: emu(4), rIns: emu(4), tIns: emu(2), bIns: emu(2) }) + tag('a:lstStyle')
          + note.text.split(/\r?\n/).map(line => tag('a:p', {}, tag('a:pPr', { algn: { left: 'l', center: 'ctr', right: 'r' }[note.align] || 'l' }, textStyle(note.style))
            + tag('a:r', {}, textStyle(note.style, 'a:rPr') + tag('a:t', {}, xmlText(line))))).join(''))));
  }).join(''));
}

function bubbleLabelsXml(labels, visible) {
  return tag('c:dLbls', {}, (labels?.points || []).map(point => tag('c:dLbl', {}, val('idx', point.index) + val('delete', Number(point.hidden)))).join('')
    + (labels ? textProps(labels.style) + val('dLblPos', labels.position) : '')
    + val('showLegendKey', 0) + ['value', 'category', 'series', 'size'].map((key, i) => val(['showVal', 'showCatName', 'showSerName', 'showBubbleSize'][i],
      Number(visible && (labels ? labels[key] : key === 'value')))).join(''));
}

/** Keep range-authored charts linked to worksheet cells, as imported sourceRefs already are. */
function sourceRefs(X, wb, sheet, ch, data) {
  if (ch.sourceRefs?.length) return ch.sourceRefs;
  const range = ch.range, horizontal = data.orientation === 'rows';
  const indices = (start, end, hidden) => Array.from({ length: end - start + 1 }, (_, i) => start + i).filter(i => ch.includeHidden || !hidden(i));
  const rows = indices(range.r1, Math.min(range.r2, sheet.rows - 1), r => wb.isRowHidden(sheet.id, r));
  const cols = indices(range.c1, Math.min(range.c2, sheet.cols - 1), c => sheet.hiddenCols.has(c));
  const lines = horizontal ? rows : cols, points = (horizontal ? cols : rows).slice(Number(data.hasHeaders));
  if (!points.length) return [];
  const ref = (line, start, end = start) => `'${sheet.name.replace(/'/g, "''")}'!` + X.utils.encode_range({
    s: { r: horizontal ? line : start, c: horizontal ? start : line }, e: { r: horizontal ? line : end, c: horizontal ? end : line },
  });
  const xy = ch.type === 'scatter' || ch.type === 'bubble', offset = xy ? 1 : Math.max(0, lines.length - data.series.length);
  return data.series.map((s, i) => ({ name: s.name, nameRef: data.hasHeaders ? ref(lines[offset + i], horizontal ? cols[0] : rows[0]) : '',
    categories: offset ? ref(lines[0], points[0], points.at(-1)) : '', values: ref(lines[offset + i], points[0], points.at(-1)),
    sizes: ch.type === 'bubble' && lines[2] != null ? ref(lines[2], points[0], points.at(-1)) : '',
  }));
}

function chartXml(X, wb, sheet, ch) {
  const data = chartData(wb, sheet.id, ch), refs = sourceRefs(X, wb, sheet, ch, data);
  // Authored horizontal bars read top-to-bottom with the value axis below. Materialize those defaults in native axis terms;
  // imported appearance already carries its own orientation and crossings.
  const ap = ch.appearance || (ch.type === 'bar'
    ? { reverseCategories: true, axisCrossings: { y: 'max' } } : {});
  const groups = new Map(), circular = ['pie', 'donut'].includes(ch.type);
  // A stock chart with volume draws it as columns on the primary axis and its prices on a secondary one.
  const stockVolume = ch.type === 'stock' && ['vhlc', 'vohlc'].includes(ch.stock);
  const stockFields = ch.type === 'stock' ? { hlc: 3, ohlc: 4, vhlc: 4, vohlc: 5 }[ch.stock] || 3 : Infinity;
  data.series.forEach((series, i) => {
    if (circular && i) return;
    if (i >= stockFields) return;
    const type = ch.type === 'combo' ? ap.seriesTypes?.[i] || (i === data.series.length - 1 ? 'line' : 'column') : stockVolume && i === 0 ? 'column' : ch.type;
    const secondary = ch.secondaryAxis && ch.type === 'combo' && type === 'line' || stockVolume && type === 'stock';
    const sourceGroup = ap.seriesGroups?.[i];
    const key = `${type}:${secondary}:${sourceGroup?.id ?? ''}`, group = groups.get(key) || { type, secondary, grouping: sourceGroup?.grouping, series: '', count: 0 };
    const color = seriesColor(ch, i), line = ap.lines?.[i] || ap.lineDefault, pie = circular ? ap.pie : null;
    const isBar = ['column', 'bar'].includes(type), bar = isBar ? ap.bars?.[i] : null;
    const bubble = type === 'bubble' ? ap.bubble?.series?.[i] : null;
    const radar = type === 'radar' ? ap.radar?.series?.[i] : null;
    // Stock prices are drawn by the group's high-low lines and up/down bars, their own lines hidden; a surface by its bands.
    const props = type === 'surface' ? '' : type === 'stock' ? tag('c:spPr', {}, tag('a:ln', { w: 19050 }, tag('a:noFill')))
      : circular ? tag('c:spPr', {}, (pie?.color ? paint(pie.color) : '')
      + tag('a:ln', { w: emu(pie?.strokeWidth ?? 1.5) }, pie ? pie.stroke == null ? '' : paint(pie.stroke) : paint('#ffffff')))
      : radar ? lineShape({ color: line?.visible === false ? 'none' : (ap.radar.style === 'filled' ? radar.stroke : ch.colors?.[i] || radar.stroke) || line?.color || color, width: line?.width, dash: radar.dash },
        !ch.colors?.[i] && gradientPaint(radar.gradient) || paint(ch.colors?.[i] || radar.fill || color))
      : bubble ? lineShape({ color: bubble.stroke, width: bubble.strokeWidth }, !ch.colors?.[i] && gradientPaint(bubble.gradient) || paint(color))
      : bar ? lineShape({ color: bar.stroke, width: bar.strokeWidth, dash: bar.strokeDash }, !ch.colors?.[i] && gradientPaint(bar.gradient) || paint(color))
      : isBar ? tag('c:spPr', {}, paint(color) + tag('a:ln', {}, paint(null)))
      : tag('c:spPr', {}, (type === 'line' || type === 'scatter' ? '' : paint(color))
        + tag('a:ln', { w: emu(line?.width || 2), ...(type === 'line' && ap.excelLayout ? { cap: 'rnd' } : {}) },
          (type === 'area' && ap.excelLayout && !line?.color ? paint(null) : paint(line?.visible === false ? null : line?.color || color))
          + (line?.dash ? tag('a:prstDash', { val: line.dash }) : '') + (type === 'line' && ap.excelLayout ? tag('a:round') : '')));
    let body = val('idx', i) + val('order', i) + (refs[i]?.nameRef ? vector('tx', refs[i].nameRef, [series.name], false)
      : !ch.sourceRefs || refs[i]?.name || ch.pivotSource && typeof refs[i]?.pivotName === 'string'
        ? tag('c:tx', {}, tag('c:v', {}, xmlText(series.name))) : '') + withEffects(props, ap.effects?.[`series:${i}`]);
    // App-authored bars keep their ordinary fill for negative values. Native
    // series retain both explicit booleans and the omitted (true) default.
    if (isBar && (!bar || typeof bar.invertIfNegative === 'boolean')) body += val('invertIfNegative', Number(bar?.invertIfNegative ?? false));
    if (circular && ch.explosion) body += val('explosion', Math.round(ch.explosion));
    if (type === 'stock') {
      // A high-low-close chart marks each close with a dash; prices with up/down bars need no markers.
      const close = !['ohlc', 'vohlc'].includes(ch.stock) && i === stockFields - 1;
      body += tag('c:marker', {}, val('symbol', close ? 'dash' : 'none') + (close ? val('size', 5) + tag('c:spPr', {}, paint('#404040') + tag('a:ln', {}, paint('#404040'))) : ''));
    }
    if (['line', 'scatter', 'radar'].includes(type)) body += tag('c:marker', {}, val('symbol', line?.marker === false ? 'none' : radar?.markerSymbol || line?.markerSymbol || 'circle')
      + val('size', Math.min(72, Math.max(2, Math.round(line?.markerSize ?? 5))))
      + tag('c:spPr', {}, paint(line?.markerFill || color) + tag('a:ln', {}, paint(line?.markerStroke || color))));
    if (circular) {
      const colors = new Map((ap.pointColors?.[0] || []).map(p => [p.index, p.color]));
      const borders = new Map((pie?.points || []).map(p => [p.index, p]));
      const count = Math.max(series.values.length, refs[i]?.literal?.values?.length || 0);
      const indices = new Set([...Array.from({ length: count }, (_, j) => j), ...colors.keys(), ...borders.keys()]);
      for (const index of indices) {
        const fill = ch.colors?.[index] || colors.get(index) || (pie?.varyColors === false && pie.color) || seriesColor(ch, index);
        const border = borders.get(index);
        body += tag('c:dPt', {}, val('idx', index) + tag('c:spPr', {}, paint(fill)
          + (border ? tag('a:ln', border.strokeWidth == null ? {} : { w: emu(border.strokeWidth) }, border.stroke == null ? '' : paint(border.stroke)) : '')));
      }
    } else if (type !== 'surface') {
      const colors = new Map((ap.pointColors?.[i] || []).map(p => [p.index, p.color]));
      const points = new Map((bar?.points || []).map(p => [p.index, p]));
      for (const index of new Set([...colors.keys(), ...points.keys()])) {
        const point = points.get(index), color = colors.get(index);
        const inversion = typeof point?.invertIfNegative === 'boolean' ? val('invertIfNegative', Number(point.invertIfNegative))
          : isBar && !bar ? val('invertIfNegative', 0) : '';
        const props = lineShape({ color: point?.stroke, width: point?.strokeWidth, dash: point?.strokeDash }, color ? paint(color) : gradientPaint(point?.gradient))
          || (point?.shape ? tag('c:spPr') : '');
        if (inversion || props || points.has(index)) body += tag('c:dPt', {}, val('idx', index) + inversion + props);
      }
    }
    const labels = ap.valueLabels?.[i], rangeLabels = refs[i]?.labels ? ap.dataLabels?.[i] : null;
    const showRange = refs[i]?.labels ? rangeLabelVisibility(rangeLabels?.showRange !== false) : '';
    if (type === 'bubble') body += bubbleLabelsXml(bubble?.labels, ch.labels);
    else if ((ch.labels || showRange) && !pie && type !== 'surface') {
      const overrides = new Map((labels?.points || []).map(p => [p.index, p]));
      const rangePoints = new Map((rangeLabels?.points || []).map(p => [p.index, p]));
      const points = [...new Set([...(labels?.hidden || []), ...overrides.keys(), ...rangePoints.keys()])].sort((a, b) => a - b).map(index => {
        const point = overrides.get(index), rangePoint = rangePoints.get(index);
        const hidden = rangePoint?.hidden ?? point?.hidden ?? (labels?.hidden?.includes(index) ? true : null);
        return tag('c:dLbl', {}, val('idx', index) + (hidden != null ? val('delete', Number(hidden)) : '')
          // Cell-label offsets are relative to the automatic label position.
          + (rangePoint && (rangePoint.dx || rangePoint.dy) ? tag('c:layout', {}, tag('c:manualLayout', {},
            val('xMode', 'factor') + val('yMode', 'factor') + val('x', rangePoint.dx) + val('y', rangePoint.dy))) : '')
          + (point?.numberFormat != null ? tag('c:numFmt', { formatCode: point.numberFormat, sourceLinked: 0 }) : '')
          + (point?.style ? labelTextProps(point.style) : '') + (rangePoint?.position || point?.position ? val('dLblPos', rangePoint?.position || point.position) : '')
          + (typeof point?.show === 'boolean' ? val('showVal', Number(point.show)) : '')
          + (typeof rangePoint?.showRange === 'boolean' ? rangeLabelVisibility(rangePoint.showRange) : ''));
      }).join('');
      body += tag('c:dLbls', {}, points
        + (labels?.numberFormat ? tag('c:numFmt', { formatCode: labels.numberFormat, sourceLinked: 0 }) : '')
        + (rangeLabels || labels ? textProps((rangeLabels || labels).style) : '')
        + (rangeLabels?.position || labels?.position ? val('dLblPos', rangeLabels?.position || labels.position) : '')
        + val('showVal', Number(ch.labels && (labels ? labels.show : true))) + showRange);
    }
    if (ch.trendline && !circular && ['column', 'bar', 'line', 'area', 'scatter'].includes(type)) body += tag('c:trendline', {}, val('trendlineType', 'linear'));
    if (bubble) for (const error of bubble.errors || []) body += tag('c:errBars', {},
      val('errDir', error.axis) + val('errBarType', error.direction) + val('errValType', error.type)
      + val('noEndCap', Number(!error.caps)) + (error.type === 'stdErr' ? '' : val('val', error.value))
      + lineShape({ color: error.color, width: error.width }));
    const xy = type === 'scatter' || type === 'bubble';
    const cats = xy ? series.x || data.x || data.categories.map((_, j) => j + 1) : ap.dateAxis ? series.x || data.x || [] : series.categories || data.categories;
    const source = refs[i], literals = source?.literal;
    // Embedded vectors must retain their original indices, trailing blanks and
    // numeric/string types. Display data may have been trimmed or formatted.
    const formattedNumbers = !xy && !ap.dateAxis && !!(source?.categoryFormat || source?.categoryPointFormats) && series.categoryValues?.some(v => typeof v === 'number')
      && series.categoryValues.every(v => v == null || typeof v === 'number');
    const categoryValues = !source?.categories && literals?.categories || (formattedNumbers ? series.categoryValues : cats);
    const numericCategories = xy || !!ap.dateAxis || formattedNumbers || !!literals?.categories?.some(v => typeof v === 'number')
      && literals.categories.every(v => v == null || typeof v === 'number');
    // An absent category vector means numeric ordinal categories. Writing its
    // display labels as strLit would turn numbers into text on reopening.
    if (xy || !ch.sourceRefs || source?.categories || literals?.categories) body += vector(xy ? 'xVal' : 'cat', source?.categories, categoryValues, numericCategories, source?.categoryFormat || ap.xFormat || 'General', !source?.categories && literals?.categories ? source?.categoryPointFormats : series.categoryPointFormats);
    body += vector(xy ? 'yVal' : 'val', source?.values, !source?.values && literals?.values || series.values, true, source?.valueFormat || styleToNumFmt(series.style) || 'General', !source?.values && literals?.values ? source?.valuePointFormats : series.pointStyles?.map(style => style ? styleToNumFmt(style) : null));
    if (type === 'bubble') body += vector('bubbleSize', refs[i]?.sizes, !source?.sizes && literals?.sizes || series.sizes || data.sizes || [], true, source?.sizeFormat || styleToNumFmt(series.sizeStyle || data.sizeStyle) || 'General', !source?.sizes && literals?.sizes ? source?.sizePointFormats : (series.sizePointStyles || data.sizePointStyles)?.map(style => style ? styleToNumFmt(style) : null));
    if (type === 'line' || type === 'scatter') body += val('smooth', Number(line?.smooth ?? ch.smooth));
    let extensions = bar?.negativeColor ? tag('c:ext', {
      uri: '{6F2FDCE9-48DA-4B69-8628-5D25D57E5C99}', 'xmlns:c14': 'http://schemas.microsoft.com/office/drawing/2007/8/2/chart',
    }, tag('c14:invertSolidFillFmt', {}, tag('c14:spPr', {}, paint(bar.negativeColor)))) : '';
    // MS-ODRAWXML 2.2.1.1: keep the live formula and refresh its indexed text
    // cache from the same formatted cells used by the renderer.
    if (source?.labels) extensions += tag('c:ext', { uri: '{02D57815-91ED-43cb-92C2-25804820EDAC}', 'xmlns:c15': C15 },
      tag('c15:datalabelsRange', {}, tag('c15:f', {}, xmlText(source.labels)) + tag('c15:dlblRangeCache', {},
        val('ptCount', series.labels?.length || 0) + (series.labels || []).map((value, index) => tag('c:pt', { idx: index }, tag('c:v', {}, xmlText(value)))).join(''))));
    if (extensions) body += tag('c:extLst', {}, extensions);
    group.series += tag('c:ser', {}, body); group.count++; groups.set(key, group);
  });
  let plots = '';
  const surfaceView = ch.type === 'surface' ? ch.surfaceView || 'surface3d' : null;
  for (const { type, series, secondary, grouping, count } of groups.values()) {
    const kind = { column: 'bar', bar: 'bar', donut: 'doughnut' }[type] || (type === 'pie' && ch.ofPie ? 'ofPie' : type);
    if (kind === 'stock') {
      const ink = paint('#404040');
      plots += tag('c:stockChart', {}, series + tag('c:hiLowLines', {}, tag('c:spPr', {}, tag('a:ln', { w: 9525 }, ink)))
        + (['ohlc', 'vohlc'].includes(ch.stock) ? tag('c:upDownBars', {}, val('gapWidth', 150)
          + tag('c:upBars', {}, tag('c:spPr', {}, paint('#ffffff') + tag('a:ln', { w: 9525 }, ink))) + tag('c:downBars', {}, tag('c:spPr', {}, ink + tag('a:ln', { w: 9525 }, ink)))) : '')
        + val('axId', 1) + val('axId', secondary ? 3 : 2));
      continue;
    }
    if (kind === 'surface') {
      plots += tag(surfaceView.endsWith('ontour') ? 'c:surfaceChart' : 'c:surface3DChart', {}, val('wireframe', Number(surfaceView.startsWith('wireframe')))
        + series + val('axId', 1) + val('axId', 2) + val('axId', 4));
      continue;
    }
    let body = '';
    if (kind === 'ofPie') body += val('ofPieType', ch.ofPie.kind === 'bar' ? 'bar' : 'pie');
    if (kind === 'bar') body += val('barDir', type === 'bar' ? 'bar' : 'col');
    // The combo's stack controls apply to its columns. Its ordinary line keeps
    // raw values, including alongside percentage columns. Explicit per-group
    // settings still take precedence for imported layered charts.
    const stack = ch.type !== 'combo' || kind !== 'line';
    if (['bar', 'line', 'area'].includes(kind)) body += val('grouping', grouping || (stack && ch.stack100 ? 'percentStacked' : stack && ch.stacked ? 'stacked' : kind === 'bar' ? 'clustered' : 'standard'));
    if (kind === 'scatter') body += val('scatterStyle', 'lineMarker');
    if (kind === 'radar') body += val('radarStyle', ap.radar?.style || 'marker');
    body += val('varyColors', Number(circular && ap.pie?.varyColors !== false)) + series;
    if (circular && ap.pie) body += pieLabels(ap.pie.labels, data.series[0], data.categories, kind === 'doughnut');
    if (kind === 'bubble') body += val('bubbleScale', Math.round(ap.bubble?.scale ?? 100))
      + val('showNegBubbles', Number(!!ap.bubble?.showNegative)) + val('sizeRepresents', ap.bubble?.sizeRepresents || 'area');
    if (kind === 'bar') body += val('gapWidth', ap.gapWidth ?? authoredBarGapWidth(ch.stacked || ch.stack100 ? 1 : count)) + val('overlap', ch.stacked || ch.stack100 ? 100 : ap.overlap || 0);
    if (kind === 'ofPie') body += val('gapWidth', Math.round(ch.ofPie.gap)) + val('splitType', 'pos') + val('splitPos', ch.ofPie.split)
      + val('secondPieSize', Math.round(ch.ofPie.secondSize)) + tag('c:serLines', {}, tag('c:spPr', {}, tag('a:ln', { w: 9525 }, paint('#7f7f7f'))));
    else if (circular) body += val('firstSliceAng', Math.round(ap.pie?.firstSliceAngle || 0));
    if (kind === 'doughnut') body += val('holeSize', Math.round(ap.pie?.holeSize ?? 58));
    if (!circular) body += val('axId', 1) + val('axId', secondary ? 3 : 2);
    plots += tag(`c:${kind}Chart`, {}, body);
  }
  const axis = (id, horizontal, secondary = false) => {
    const numeric = !horizontal || ch.type === 'scatter' || ch.type === 'bubble', date = horizontal && ap.dateAxis;
    const kind = numeric ? 'valAx' : date ? 'dateAx' : 'catAx';
    const min = horizontal ? ap.xMin : secondary ? ap.y2Min : ch.yMin, max = horizontal ? ap.xMax : secondary ? ap.y2Max : ch.yMax;
    const reversed = horizontal ? ap.reverseCategories : secondary ? ap.reverseSecondaryValues : ap.reverseValues;
    let body = val('axId', id) + tag('c:scaling', {}, val('orientation', reversed ? 'maxMin' : 'minMax') + (max != null ? val('max', max) : '') + (min != null ? val('min', min) : ''));
    const position = horizontal ? (ch.type === 'bar' ? 'l' : 'b') : secondary ? 'r' : ap.yPosition || (ch.type === 'bar' ? 'b' : 'l');
    body += val('delete', Number(!!(horizontal ? ap.hideXAxis : secondary ? ap.hideY2Axis : ap.hideYAxis))) + val('axPos', position);
    const gridKey = horizontal ? 'x' : secondary ? 'y2' : 'y';
    body += gridlines(horizontal ? ap.xGridlines ?? ap.bubble?.xGrid : secondary ? ap.y2Gridlines : ch.gridlines,
      ap.gridlineStyles?.[gridKey] || (ap.bubble && !secondary ? { color: horizontal ? ap.bubble.xGridColor : ap.bubble.yGridColor } : !horizontal && !secondary ? { color: '#d9d9d9' } : null));
    const titleKey = horizontal ? 'xTitle' : secondary ? 'y2Title' : 'yTitle', label = data.titles?.[titleKey] ?? ch[titleKey];
    // Linked and literal titles use the same physical axis orientation. An
    // explicit zero rotation in a linked title otherwise overrides Excel's
    // automatic vertical title orientation.
    const titleRotation = horizontal === (ch.type === 'bar') ? -90 : 0;
    if (label || ch[`${titleKey}Ref`]) body += title(label, horizontal ? ap.xStyle : secondary ? ap.y2Style : ap.yStyle, null, ch[`${titleKey}Ref`], titleRotation);
    // An unformatted category axis displays its source labels. An unlinked
    // General code would instead strip their numeric cell/display formatting.
    const sourceLinked = horizontal && (ap.xSourceLinked || !ap.xFormat && !numeric && !date);
    body += tag('c:numFmt', { formatCode: (horizontal ? ap.xFormat : secondary ? ap.y2Format : ap.yFormat) || (ch.stack100 && !horizontal && !secondary ? '0%' : 'General'), sourceLinked: Number(!!sourceLinked) });
    const axisStyle = ap.axisStyles?.[gridKey] || (ap.bubble ? { color: horizontal ? ap.bubble.xAxisColor : ap.bubble.yAxisColor } : null);
    const majorTick = axisStyle?.majorTick ?? (!horizontal && !secondary && ap.valueTicks ? 'out' : null);
    if (majorTick) body += val('majorTickMark', majorTick);
    if (axisStyle?.minorTick) body += val('minorTickMark', axisStyle.minorTick);
    body += val('tickLblPos', (horizontal ? ap.xLabelPosition : secondary ? ap.y2LabelPosition : ap.yLabelPosition) || 'nextTo') + lineShape(axisStyle) + textProps(horizontal ? ap.xStyle : secondary ? ap.y2Style : ap.yStyle,
      horizontal ? ap.xRotation || (ap.xRotationAuto === false ? 0 : null) : 0, horizontal ? ap.xWrap : undefined);
    // Reversing the categories exchanges the edge at which their maximum
    // meets the value axis. Excel uses crosses as well as axPos for placement.
    const farEdge = !horizontal && ap.yPosition && ((ch.type === 'bar' ? position === 't' : position === 'r') !== !!ap.reverseCategories);
    const crossing = ap.axisCrossings?.[gridKey] ?? (secondary || farEdge ? 'max' : 'autoZero');
    body += val('crossAx', horizontal ? 2 : 1) + val(Number.isFinite(crossing) ? 'crossesAt' : 'crosses', crossing);
    if (kind === 'catAx' && ap.xLabelSkip) body += val('tickLblSkip', ap.xLabelSkip);
    if (kind === 'catAx' && axisStyle?.tickSkip) body += val('tickMarkSkip', axisStyle.tickSkip);
    if (numeric) body += val('crossBetween', ap.categoryBetween === false || ch.type === 'surface' ? 'midCat' : 'between');
    if (date) body += val('baseTimeUnit', ap.xBaseTimeUnit || 'days');
    const step = horizontal ? ap.xStep : secondary ? ap.y2Step : ap.yStep;
    if ((numeric || date) && step > 0) body += val('majorUnit', step);
    if (date) body += val('majorTimeUnit', ap.xTimeUnit || 'days');
    if ((numeric || date) && axisStyle?.minorUnit) body += val('minorUnit', axisStyle.minorUnit);
    if (date && axisStyle?.minorTimeUnit) body += val('minorTimeUnit', axisStyle.minorTimeUnit);
    const units = horizontal ? ap.xUnits : secondary ? ap.y2Units : ap.yUnits;
    if (numeric && units) body += tag('c:dispUnits', {}, (units.builtIn ? val('builtInUnit', units.builtIn) : val('custUnit', units.divisor))
      + (units.label ? tag('c:dispUnitsLbl', {}, layout(units.layout)
        + tag('c:tx', {}, tag('c:rich', {}, tag('a:bodyPr', { rot: Math.round(units.rotation * 60000) }) + tag('a:lstStyle')
          + tag('a:p', {}, tag('a:pPr', {}, textStyle(units.style)) + tag('a:r', {}, tag('a:t', {}, xmlText(units.label))))))
        + textProps(units.style, units.rotation)) : ''));
    return tag(`c:${kind}`, {}, body);
  };
  // A surface also has a series axis, running back from the categories (hidden on a contour, seen from above).
  const seriesAxis = surfaceView ? tag('c:serAx', {}, val('axId', 4) + tag('c:scaling', {}, val('orientation', 'minMax')) + val('delete', Number(surfaceView.endsWith('ontour')))
    + val('axPos', 'b') + val('majorTickMark', 'out') + val('minorTickMark', 'none') + val('tickLblPos', 'nextTo') + textProps(ap.xStyle || {}) + val('crossAx', 2) + val('crosses', 'autoZero')) : '';
  const axes = circular ? '' : axis(1, true) + axis(2, false) + ([...groups.values()].some(g => g.secondary) ? axis(3, false, true) : '') + seriesAxis;
  const view3D = surfaceView ? tag('c:view3D', {}, surfaceView.endsWith('ontour') ? val('rotX', 90) + val('rotY', 0) + val('rAngAx', 0) + val('perspective', 0)
    : val('rotX', 15) + val('rotY', 20) + val('rAngAx', 0) + val('perspective', 30)) : '';
  const table = ap.dataTable;
  const tableXml = table ? tag('c:dTable', {}, val('showHorzBorder', Number(table.horizontal)) + val('showVertBorder', Number(table.vertical))
    + val('showOutline', Number(table.outline)) + val('showKeys', Number(table.keys))
    + tag('c:spPr', {}, paint(table.fill) + tag('a:ln', { w: emu(table.width) }, paint(table.stroke))) + textProps(table.style)) : '';
  const plot = tag('c:plotArea', {}, layout(ap.plot, true) + plots + axes + tableXml
    + withEffects(lineShape({ color: ap.plotStroke, width: ap.plotStrokeWidth, dash: ap.plotStrokeDash }, paint(ap.plotFill)), ap.effects?.plotArea));
  const legend = ch.legend ? tag('c:legend', {}, val('legendPos', { top: 't', bottom: 'b', left: 'l', right: 'r' }[ch.legendPos] || 'b')
    + (ap.legendHidden || []).map(i => tag('c:legendEntry', {}, val('idx', i) + val('delete', 1))).join('') + layout(ap.legend) + val('overlay', 0)
    + boxShape(ap.legendBox, ap.effects?.legend) + textProps(ap.legendStyle)) : '';
  const pivot = ch.pivotSource;
  const pivotSource = prefix => tag(`${prefix}:pivotSource`, {}, tag(`${prefix}:name`, {}, xmlText(pivot.name))
    + tag(`${prefix}:fmtId`, { val: pivot.formatId }));
  const pivotExtension = pivot?.standalone ? tag('c:extLst', {}, tag('c:ext', { uri: '{723BEF56-08C2-4564-9609-F4CBC75E7E54}' },
    tag('c15:pivotSource', { 'xmlns:c15': 'http://schemas.microsoft.com/office/drawing/2012/chart' },
      tag('c15:name', {}, xmlText(pivot.name)) + tag('c15:fmtId', { val: pivot.formatId })))) : '';
  return HEADER + tag('c:chartSpace', { 'xmlns:c': C, 'xmlns:a': A, 'xmlns:r': R.slice(0, -1) },
    (typeof ap.roundedCorners === 'boolean' ? val('roundedCorners', Number(ap.roundedCorners)) : '')
    + (pivot && !pivot.standalone ? pivotSource('c') : '')
    + tag('c:chart', {}, (ch.title || ch.titleRef ? title(data.titles?.title ?? ch.title, ap.titleStyle, ap.title, ch.titleRef, 0, boxShape(ap.titleBox, ap.effects?.title)) : val('autoTitleDeleted', 1)) + view3D + plot + legend + val('plotVisOnly', Number(!ch.includeHidden)) + val('dispBlanksAs', ap.radar?.blanks || ap.blanks || 'gap'))
    + withEffects(tag('c:spPr', {}, paint(ap.background || '#ffffff') + tag('a:ln', ap.borderWidth != null ? { w: emu(ap.borderWidth) } : {},
      paint(ap.border === false || ap.borderColor === 'none' ? null : ap.borderColor || '#cccccc'))), ap.effects?.chartArea)
    + (ap.textStyle ? textProps(ap.textStyle) : '') + (ap.annotations?.length ? tag('c:userShapes', { 'r:id': 'chartAnnotations' }) : '') + pivotExtension);
}

/** SVG shapes can contain HTML text; rasterize that text in the browser before giving it to Excel. */
const CAMERA_URI = '{84589F7E-364E-4C9E-8A38-B11213B215E9}';
const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
/**
 * A picture's Picture Format in DrawingML: corrections as a:lum, grayscale as a:grayscl and
 * transparency as a:alphaModFix inside the blip; a rounded or oval outline as the preset geometry,
 * the frame as a:ln and the shadow as an outer shadow on the shape.
 */
export function pictureFormatXml(obj) {
  const pct = n => Math.round(n * 100000);
  const blip = (obj.transparency ? tag('a:alphaModFix', { amt: pct(1 - obj.transparency) }) : '')
    + (obj.recolor === 'grayscale' ? tag('a:grayscl') : '')
    + (obj.adjust ? tag('a:lum', { bright: obj.adjust.brightness ? pct(obj.adjust.brightness) : null, contrast: obj.adjust.contrast ? pct(obj.adjust.contrast) : null }) : '');
  const radius = obj.shape === 'roundRect' ? Math.min(50000, Math.round(roundedRadius(obj.w, obj.h) / Math.max(1, Math.min(obj.w, obj.h)) * 100000)) : null;
  const geometry = tag('a:prstGeom', { prst: obj.shape || 'rect' }, radius != null ? tag('a:avLst', {}, tag('a:gd', { name: 'adj', fmla: `val ${radius}` })) : tag('a:avLst'));
  const line = obj.outline ? tag('a:ln', { w: Math.round(obj.outline.width * 9525) }, tag('a:solidFill', {}, tag('a:srgbClr', { val: obj.outline.color.slice(1).toUpperCase() }))) : '';
  const shadow = obj.shadow ? tag('a:effectLst', {}, tag('a:outerShdw', { blurRad: 95250, dist: 38100, dir: 2700000, algn: 'tl', rotWithShape: 0 }, tag('a:srgbClr', { val: '000000' }, tag('a:alpha', { val: 38000 })))) : '';
  return { blip, shape: geometry + line + shadow };
}

async function pictureBytes(src, width, height) {
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/is.exec(src);
  if (!match) throw new Error('The workbook contains an unreadable picture');
  let [, type, data] = match;
  if (!['png', 'jpeg', 'gif', 'x-emf'].includes(type) && typeof Image !== 'undefined' && typeof document !== 'undefined') {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('A workbook picture could not be exported')); image.src = src; });
    const canvas = document.createElement('canvas'), scale = Math.min(2, 4096 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    data = canvas.toDataURL('image/png').split(',')[1]; type = 'png';
  }
  return { type, extension: type === 'svg+xml' ? 'svg' : type === 'jpeg' ? 'jpg' : type === 'x-emf' ? 'emf' : type, bytes: Uint8Array.from(atob(data), c => c.charCodeAt(0)) };
}

export async function exportDrawings(X, wb, sheet, index, { set, binary, contentType, recordDrawing, recordGroup, slicers }) {
  // A chartsheet requires a drawing relationship even after its last object
  // has been removed. An empty drawing is still a valid drawing part.
  // Form controls and timelines are written elsewhere (a timeline travels in the app's own data).
  const appOnly = c => c.type === 'scroll' || c.type === 'timeline' || c.type === 'slicer' && c.pivotCache != null && !nativePivotSlicerParts.enabled;
  if (!sheet.charts.some(c => !appOnly(c)) && sheet.kind !== 'chart') return null;
  const relationships = [], anchors = [];
  const cellOffsets = sheet.charts.some(c => c.cellAnchor) ? { col: drawingAxisOffsets(sheet, 'col'), row: drawingAxisOffsets(sheet, 'row') } : null;
  let nextDrawingId = sheet.charts.length + 1;
  const drawingIds = new Map(), objectIds = new Map();
  const hasKeys = (n, depth = 0) => depth <= 24 && (validDrawingKey(n?.key) || n?.name === 'grpSp' && Array.isArray(n.children) && n.children.some(c => hasKeys(c, depth + 1)));
  for (const [i, obj] of sheet.charts.entries()) {
    const root = hasKeys(obj.nativeDrawing?.node) ? normalizeNativeDrawing(obj.nativeDrawing)?.node : null, ids = new Map();
    const reserve = (node, top = false) => {
      if (['sp', 'cxnSp', 'grpSp'].includes(node.name) && node.key) {
        const id = top && node.name === 'grpSp' ? i + 1 : nextDrawingId++;
        ids.set(node.key, id);
        if (!drawingIds.has(node.key)) drawingIds.set(node.key, id);
      }
      node.children.forEach(n => reserve(n));
    };
    if (root) reserve(root, true);
    objectIds.set(obj.id, ids);
    if (obj.drawingKey && !drawingIds.has(obj.drawingKey)) drawingIds.set(obj.drawingKey, i + 1);
  }
  // Arrange ▸ Group: a group of objects written whole becomes one grpSp in one anchor. Only groups of plain
  // one-cell objects qualify; any other group's members are written one by one (the app's record keeps the group).
  const members = new Map();
  for (const obj of sheet.charts) if (obj.group) members.set(obj.group, [...(members.get(obj.group) || []), obj]);
  const nativeGroups = new Set([...members].filter(([, list]) => list.length > 1 && sheet.kind !== 'chart' && list.every(o => !appOnly(o)
    && o.type !== 'slicer' && o.type !== 'smartart' && !o.cellAnchor && o.anchorMode !== 'absolute' && !o.equation && !(o.type === 'image' && o.nativeDrawing))).map(([group]) => group));
  const pending = new Map();
  for (const [i, obj] of sheet.charts.entries()) {
    if (appOnly(obj)) continue;
    const id = i + 1, key = `${index}_${id}`, relId = `rId${id}`;
    const cellAnchor = exportCellAnchor(sheet, obj, cellOffsets);
    let shape, placement = obj, equation = null;
    const link = obj.hyperlink ? { url: obj.hyperlink } : obj.drawingShape && wb.linkAt(sheet.id, obj.anchor.r, obj.anchor.c);
    if (link) relationships.push(tag('Relationship', { Id: `${relId}Link`, Type: `${R}hyperlink`, Target: link.url, TargetMode: 'External' }));
    const native = obj.type === 'image' && nativeDrawingXml(obj, id, () => nextDrawingId++, null, objectIds.get(obj.id), drawingIds);
    if (obj.type === 'slicer') {
      const view = slicers?.records.get(obj);
      if (!view) throw new Error('Missing native slicer export plan');
      shape = slicerFrameXml(obj, id, view.name);
    } else if (native) shape = native;
    else if (obj.type === 'smartart') {
      // A SmartArt graphic: a group of ordinary shapes as the app draws it (the app's record keeps the diagram), or,
      // for one another program drew and nobody has changed here, the shapes that program drew.
      const theme = workbookTheme(wb);
      shape = (obj.fallback?.nativeDrawing && nativeDrawingXml({ ...obj, nativeDrawing: obj.fallback.nativeDrawing, title: obj.name || 'Diagram', rotation: 0, flipH: false, flipV: false },
        id, () => nextDrawingId++, null, objectIds.get(obj.id), drawingIds))
        || smartArtGroupXml(obj, id, () => nextDrawingId++, { colors: theme.colors, font: theme.minor });
    } else if (obj.type === 'text') {
      const s = obj.style || {};
      const text = textBoxText(wb, sheet.id, obj);
      // WordArt carries its effects on each run as well, where every reader applies them.
      const run = value => tag('a:r', {}, (s.effects ? textStyle(s, 'a:rPr') : '') + tag('a:t', {}, xmlText(value)));
      // An equation is Office Math in an a14:m paragraph; readers without it get its linear text.
      equation = obj.equation ? equationParagraphs(obj) : null;
      const content = equation ? equation.math : obj.textRef ? tag('a:p', {}, tag('a:pPr', { algn: { left: 'l', center: 'ctr', right: 'r' }[s.align] || 'l' }, textStyle(s))
        + run(obj.textPrefix || '') + tag('a:fld', { id: '{00000000-0000-0000-0000-000000000001}', type: 'TxLink' }, textStyle(s, 'a:rPr')
          + tag('a:t', {}, xmlText(text.slice((obj.textPrefix || '').length, obj.textSuffix ? -obj.textSuffix.length : undefined)))) + run(obj.textSuffix || ''))
        : text.split('\n').map(line => tag('a:p', {}, tag('a:pPr', { algn: { left: 'l', center: 'ctr', right: 'r' }[s.align] || 'l' }, textStyle(s)) + run(line))).join('');
      shape = tag('xdr:sp', { textlink: obj.textRef || null }, tag('xdr:nvSpPr', {}, tag('xdr:cNvPr', { id, name: `Text ${id}`, descr: obj.decorative ? null : obj.description || null }, decorativeXml(obj.decorative) || undefined) + tag('xdr:cNvSpPr', { txBox: 1 }))
        + tag('xdr:spPr', {}, tag('a:xfrm', { rot: obj.rotation ? Math.round(obj.rotation * 60000) : null, flipH: obj.flipH ? 1 : null, flipV: obj.flipV ? 1 : null }, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: emu(obj.w), cy: emu(obj.h) }))
          + tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')) + paint(s.bg) + tag('a:ln', {}, paint(s.border ? '#cccccc' : null)))
        + effectRefStyleXml(s.effectRef)
        + tag('xdr:txBody', {}, tag('a:bodyPr', { anchor: { top: 't', middle: 'ctr', bottom: 'b' }[s.valign] || 'ctr', ...(equation ? { wrap: 'none' } : {}),
          ...(s.padding ? Object.fromEntries(['tIns', 'rIns', 'bIns', 'lIns'].map((k, i) => [k, emu(s.padding[i])])) : {}) }) + tag('a:lstStyle') + content));
    } else if (CHARTEX_TYPES.has(obj.type)) {
      // Treemaps, sunbursts, box and whisker and funnel charts are extended chart parts with their own style parts.
      const path = `/xl/charts/chartEx${key}.xml`;
      set(path, chartExXml(X, wb, sheet, obj));
      set(`/xl/charts/style${key}.xml`, chartExStyleXml());
      set(`/xl/charts/colors${key}.xml`, chartExColorsXml());
      set(`/xl/charts/_rels/chartEx${key}.xml.rels`, HEADER + tag('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
        tag('Relationship', { Id: 'rId1', Type: CHART_STYLE_REL, Target: `style${key}.xml` }) + tag('Relationship', { Id: 'rId2', Type: CHART_COLORS_REL, Target: `colors${key}.xml` })));
      contentType(path, CHARTEX_CONTENT_TYPE);
      contentType(`/xl/charts/style${key}.xml`, 'application/vnd.ms-office.chartstyle+xml');
      contentType(`/xl/charts/colors${key}.xml`, 'application/vnd.ms-office.chartcolorstyle+xml');
      relationships.push(tag('Relationship', { Id: relId, Type: CHARTEX_REL, Target: `../charts/chartEx${key}.xml` }));
      shape = chartExFrame(obj, id, relId, tag('xdr:cNvPr', { id, name: obj.title || `Chart ${id}`, descr: obj.decorative ? null : obj.description }, decorativeXml(obj.decorative) || undefined));
    } else if (!['image', 'histogram', 'waterfall'].includes(obj.type) && !obj.pareto) {
      const path = `/xl/charts/chart${key}.xml`;
      set(path, chartXml(X, wb, sheet, obj));
      if (obj.appearance?.annotations?.length) {
        const annotationsPath = `/xl/drawings/chartAnnotations${key}.xml`;
        set(annotationsPath, chartAnnotationsXml(obj.appearance.annotations));
        contentType(annotationsPath, 'application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml');
        set(`/xl/charts/_rels/chart${key}.xml.rels`, HEADER + tag('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
          tag('Relationship', { Id: 'chartAnnotations', Type: `${R}chartUserShapes`, Target: `../drawings/chartAnnotations${key}.xml` })));
      }
      contentType(path, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml');
      relationships.push(tag('Relationship', { Id: relId, Type: `${R}chart`, Target: `../charts/chart${key}.xml` }));
      shape = tag('xdr:graphicFrame', { macro: '' }, tag('xdr:nvGraphicFramePr', {}, tag('xdr:cNvPr', { id, name: obj.title || `Chart ${id}`, descr: obj.decorative ? null : obj.description }, decorativeXml(obj.decorative) || undefined) + tag('xdr:cNvGraphicFramePr'))
        + tag('xdr:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: 0, cy: 0 }))
        + tag('a:graphic', {}, tag('a:graphicData', { uri: C }, tag('c:chart', { 'xmlns:c': C, 'r:id': relId }))));
    } else {
      let src = obj.nativeSrc || obj.src;
      // A linked picture is saved as the picture of its cells as they are now.
      const linked = obj.type === 'image' && obj.pictureRef ? linkedPictureTarget(wb, sheet.id, obj.pictureRef) : null;
      const live = linked && rangePicture(wb, linked.sheetId, linked.range);
      if (live) src = svgDataUrl(live.svg);
      if (obj.type !== 'image') {
        // Complex chart artwork uses the same renderer as the sheet. Keep the
        // editable chart in metadata, and its visible result in a native picture.
        const colors = { '--surface': '#ffffff', '--ink': '#0b0b0b', '--ink-2': '#4f4e4b', '--ink-3': '#6b6964', '--grid': '#e4e3dd' };
        const svg = standaloneSvg(renderChartSvg(chartData(wb, sheet.id, obj), obj, obj.w, obj.h), key => colors[key], 'Calibri, Arial, sans-serif');
        src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      }
      const drawing = obj.drawingShape && await (await import('./drawingml-raster.js')).drawingRasterSource(src, obj);
      if (drawing) {
        src = drawing.src;
        placement = { ...obj, w: drawing.w, h: drawing.h, dx: obj.dx - (drawing.w - obj.w) / 2, dy: obj.dy - (drawing.h - obj.h) / 2 };
      }
      const image = await pictureBytes(src, placement.w, placement.h), path = `/xl/media/image${key}.${image.extension}`;
      binary(path, image.bytes); contentType(path, `image/${image.type}`);
      relationships.push(tag('Relationship', { Id: relId, Type: `${R}image`, Target: `../media/image${key}.${image.extension}` }));
      let svgExtension = '';
      if (image.type === 'png' && /^data:image\/svg\+xml;base64,/i.test(src)) {
        const vector = Uint8Array.from(atob(src.split(',')[1]), c => c.charCodeAt(0));
        // Office's SVG profile does not support foreignObject HTML. Those
        // views need the rendered PNG; ordinary SVG keeps its vector source
        // through the standard svgBlip extension and a PNG fallback.
        if (!/<(?:[\w.-]+:)?foreignObject\b/i.test(new TextDecoder().decode(vector))) {
          binary(`/xl/media/image${key}.svg`, vector); contentType(`/xl/media/image${key}.svg`, 'image/svg+xml');
          relationships.push(tag('Relationship', { Id: `${relId}Svg`, Type: `${R}image`, Target: `../media/image${key}.svg` }));
          svgExtension = tag('a:extLst', {}, tag('a:ext', { uri: '{96DAC541-7B7A-43D3-8B79-37D633B846F1}' },
            tag('asvg:svgBlip', { 'xmlns:asvg': 'http://schemas.microsoft.com/office/drawing/2016/SVG/main', 'r:embed': `${relId}Svg` })));
        }
      }
      // Picture Format: corrections, grayscale and transparency go on the blip; style on the shape (pictureFormatXml).
      const format = pictureFormatXml(obj);
      // A linked picture names the cells it shows (MS-ODRAWXML cameraTool), so other programs keep it live.
      const camera = obj.type === 'image' && obj.pictureRef ? tag('a:extLst', {}, tag('a:ext', { uri: CAMERA_URI }, tag('a14:cameraTool', { 'xmlns:a14': A14, cellRange: obj.pictureRef }))) : '';
      shape = tag('xdr:pic', {}, tag('xdr:nvPicPr', {}, tag('xdr:cNvPr', { id, name: obj.title || `Picture ${id}`, descr: drawingDescription(obj) },
        decorativeXml(obj.decorative)) + tag('xdr:cNvPicPr', {}, (obj.type === 'image' && obj.lockAspect !== false ? tag('a:picLocks', { noChangeAspect: 1 }) : '') + camera || undefined))
        + tag('xdr:blipFill', {}, tag('a:blip', { 'r:embed': relId }, (format.blip + (svgExtension || '')) || undefined) + (obj.srcRect && !live ? tag('a:srcRect', pictureRectAttrs(obj.srcRect)) : '') + tag('a:stretch', {}, tag('a:fillRect', pictureRectAttrs(live ? null : obj.fillRect))))
        + tag('xdr:spPr', {}, tag('a:xfrm', { rot: Math.round((obj.rotation || 0) * 60000), flipH: Number(!!obj.flipH), flipV: Number(!!obj.flipV) }, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: emu(placement.w), cy: emu(placement.h) }))
          + format.shape));
    }
    // The Selection Pane's name and eye: cNvPr@name and cNvPr@hidden of the object's own drawing.
    if (obj.name || obj.hidden) shape = shape.replace(/<xdr:cNvPr\b([^>]*?)(\/?)>/, (_, attrs, closed) =>
      `<xdr:cNvPr${obj.name ? attrs.replace(/\sname="[^"]*"/, ` name="${xmlText(obj.name)}"`) : attrs}${obj.hidden && !/\shidden=/.test(attrs) ? ' hidden="1"' : ''}${closed}>`);
    if (link) shape = shape.replace(/<xdr:cNvPr\b([^>]*?)(\/?)>/, (_, attrs, closed) =>
      `<xdr:cNvPr${attrs}>${tag('a:hlinkClick', { 'r:id': `${relId}Link`, tooltip: obj.hyperlinkTooltip || null })}${closed ? '</xdr:cNvPr>' : ''}`);
    let identified;
    if (cellAnchor?.box) {
      const frame = cellAnchorFrame(sheet, cellAnchor, cellOffsets);
      const [x, y, w, h] = cellAnchor.box;
      // A normalized internal coordinate space remains nonzero even when all
      // anchor rows/columns are hidden; unhide must recover the same fractions.
      const unit = 1e9;
      // Keep a flattened group's affine relationship to its cell frame in native
      // DrawingML too. Each child can have its own group with the same frame.
      const transform = tag('a:off', { x: Math.round(x * unit), y: Math.round(y * unit) })
        + tag('a:ext', { cx: Math.round(w * unit), cy: Math.round(h * unit) });
      shape = shape.replace(/<(a|xdr):xfrm([^>]*)>[\s\S]*?<\/\1:xfrm>/, (whole, prefix, attrs) => {
        const childFrame = whole.match(/<a:chOff\b[^>]*\/>/)?.[0] || '';
        const childSize = whole.match(/<a:chExt\b[^>]*\/>/)?.[0] || '';
        return `<${prefix}:xfrm${attrs}>${transform}${childFrame}${childSize}</${prefix}:xfrm>`;
      });
      const split = /<cx?:chart\b|<a:fld\b[^>]*type="TxLink"/.test(shape);
      if (split) { identified = identifyDrawing(shape); shape = identified.xml; }
      shape = tag('xdr:grpSp', {}, tag('xdr:nvGrpSpPr', {}, tag('xdr:cNvPr', { id: nextDrawingId++, name: obj.title || `Drawing frame ${id}`, descr: drawingDescription(obj) },
        decorativeXml(obj.decorative) + (link ? tag('a:hlinkClick', { 'r:id': `${relId}Link`, tooltip: obj.hyperlinkTooltip || null }) : '')) + tag('xdr:cNvGrpSpPr'))
        + tag('xdr:grpSpPr', {}, tag('a:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: emu(frame.w), cy: emu(frame.h) })
          + tag('a:chOff', { x: 0, y: 0 }) + tag('a:chExt', { cx: unit, cy: unit }))) + shape);
    }
    if (!identified) { identified = identifyDrawing(shape); shape = identified.xml; }
    if (obj.type !== 'slicer') recordDrawing?.(sheet.name, obj.id, identified.key);
    if (obj.group && nativeGroups.has(obj.group)) {
      pending.set(obj.group, [...(pending.get(obj.group) || []), { obj, shape, placement }]);
      // The group's last member writes the group: one anchor at the box around them, each member placed in it.
      if (pending.get(obj.group).length === members.get(obj.group).length) anchors.push(groupAnchorXml(sheet, obj.group, pending.get(obj.group), nextDrawingId++, recordGroup));
      continue;
    }
    const from = tag('xdr:from', {}, tag('xdr:col', {}, obj.anchor.c) + tag('xdr:colOff', {}, emu(placement.dx)) + tag('xdr:row', {}, obj.anchor.r) + tag('xdr:rowOff', {}, emu(placement.dy)));
    const absolute = sheet.kind === 'chart' || obj.anchorMode === 'absolute';
    if (cellAnchor && sheet.kind !== 'chart') {
      const marker = (name, p) => tag(`xdr:${name}`, {}, tag('xdr:col', {}, p.c) + tag('xdr:colOff', {}, emu(p.dx)) + tag('xdr:row', {}, p.r) + tag('xdr:rowOff', {}, emu(p.dy)));
      anchors.push(equationAnchorXml(tag('xdr:twoCellAnchor', { editAs: cellAnchor.editAs }, marker('from', cellAnchor.from) + marker('to', cellAnchor.to) + shape + tag('xdr:clientData')), equation));
      continue;
    }
    anchors.push(equationAnchorXml(tag(absolute ? 'xdr:absoluteAnchor' : 'xdr:oneCellAnchor', {},
      (absolute ? tag('xdr:pos', { x: emu(placement.dx), y: emu(placement.dy) }) : from)
      + tag('xdr:ext', { cx: emu(placement.w), cy: emu(placement.h) }) + shape + tag('xdr:clientData', obj.type === 'slicer' ? { fPrintsWithSheet: Number(obj.print) } : {})), equation));
  }
  const path = `/xl/drawings/drawing${index}.xml`;
  set(path, HEADER + tag('xdr:wsDr', { 'xmlns:xdr': XDR, 'xmlns:a': A, 'xmlns:r': R.slice(0, -1) }, anchors.join('')));
  set(`/xl/drawings/_rels/drawing${index}.xml.rels`, HEADER + tag('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' }, relationships.join('')));
  contentType(path, 'application/vnd.openxmlformats-officedocument.drawing+xml');
  return `../drawings/drawing${index}.xml`;
}

/** Pixels before line `count` along an axis, hidden lines counting nothing. */
function lineOffset(sheet, axis, count) {
  const row = axis === 'row', sizes = row ? sheet.rowHeights : sheet.colWidths, fallback = row ? sheet.defaultRowHeight : sheet.defaultColWidth;
  let pixels = count * fallback;
  for (const [i, size] of sizes) if (i < count) pixels += size - fallback;
  for (const i of row ? new Set([...sheet.hiddenRows, ...sheet.filterHidden]) : sheet.hiddenCols) if (i < count) pixels -= sizes.get(i) ?? fallback;
  return pixels;
}

/**
 * One grpSp holding a group's members, in a one-cell anchor at the box around them: the group's frame and its
 * child coordinate space are both that box in EMUs, and each member's own transform places it inside.
 */
function groupAnchorXml(sheet, group, items, id, recordGroup) {
  const at = items.map(({ obj, placement }) => ({ x: lineOffset(sheet, 'col', obj.anchor.c) + placement.dx, y: lineOffset(sheet, 'row', obj.anchor.r) + placement.dy, w: placement.w, h: placement.h }));
  const gx = Math.min(...at.map(r => r.x)), gy = Math.min(...at.map(r => r.y));
  const gw = Math.max(...at.map(r => r.x + r.w)) - gx, gh = Math.max(...at.map(r => r.y + r.h)) - gy;
  const left = items[at.findIndex(r => r.x === gx)], top = items[at.findIndex(r => r.y === gy)];
  const body = items.map(({ shape }, i) => shape.replace(/<(a|xdr):xfrm([^>]*)>[\s\S]*?<\/\1:xfrm>/, (whole, prefix, attrs) =>
    `<${prefix}:xfrm${attrs}>${tag('a:off', { x: emu(at[i].x - gx), y: emu(at[i].y - gy) })}${tag('a:ext', { cx: emu(at[i].w), cy: emu(at[i].h) })}</${prefix}:xfrm>`)).join('');
  const hidden = items.every(({ obj }) => obj.hidden);
  const identified = identifyDrawing(tag('xdr:grpSp', {}, tag('xdr:nvGrpSpPr', {}, tag('xdr:cNvPr', { id, name: `Group ${id}`, hidden: hidden ? 1 : null }) + tag('xdr:cNvGrpSpPr'))
    + tag('xdr:grpSpPr', {}, tag('a:xfrm', {}, tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx: emu(gw), cy: emu(gh) })
      + tag('a:chOff', { x: 0, y: 0 }) + tag('a:chExt', { cx: emu(gw), cy: emu(gh) }))) + body));
  recordGroup?.(sheet.name, identified.key);
  const from = tag('xdr:from', {}, tag('xdr:col', {}, left.obj.anchor.c) + tag('xdr:colOff', {}, emu(left.placement.dx)) + tag('xdr:row', {}, top.obj.anchor.r) + tag('xdr:rowOff', {}, emu(top.placement.dy)));
  return tag('xdr:oneCellAnchor', {}, from + tag('xdr:ext', { cx: emu(gw), cy: emu(gh) }) + identified.xml + tag('xdr:clientData'));
}

/** Save projections of the emitted drawings, without another ZIP/cell parse. */
export async function updateDrawingMetadata(X, zip, book, wb, records, { get, set, groups = new Map() }) {
  const meta = book.PuterExportMeta;
  if (!meta) return;
  const files = Object.create(null), root = zip.FullPaths[0];
  zip.FullPaths.forEach((path, i) => { files[path.slice(root.length)] = zip.FileIndex[i]; });
  const sheets = [...get('/xl/workbook.xml').matchAll(/<sheet\b[^>]*\/>/g)].map(m => ({ name: xlsxAttr(m[0], 'name'), id: xlsxAttr(m[0], 'r:id') }));
  const native = await readXlsxCharts({ files, Workbook: { Sheets: sheets }, Styles: { Fonts: [wb.normalFont || { sz: 12 }] } }, [], new Map(),
    { splitGroups: (name) => (groups.has(name) ? new Set(groups.get(name)) : null) });
  // The groups written whole are named in the record, so reading the file again takes them apart into their objects.
  for (const [name, keys] of groups) if (meta.data.sheets[name]) meta.data.sheets[name].nativeGroups = keys;
  for (const [name, entries] of records) {
    const byKey = new Map((native.get(name) || []).map(c => [c.xlsxDrawingIdentity?.key, c]));
    const baseline = [];
    for (const entry of entries) {
      const obj = byKey.get(entry.key);
      if (obj) baseline.push({ ...entry, baseline: await drawingBaseline(obj) });
    }
    // Do not enable deletion reconciliation for an incompletely represented
    // export. Existing unsupported objects still keep their editable metadata.
    if (baseline.length === entries.length) meta.data.sheets[name].nativeDrawings = baseline;
  }
}
