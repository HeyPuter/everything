import { normalizeCellAnchor } from './drawing-cell-anchor.js';
import { linkedChartText, normalizeLinkedChartText } from './chart-linked-text.js';
/**
 * Charts: the model of a chart placed on a sheet, and the pure step that
 * turns a range of cells into categories and series for drawing.
 *
 * chart = {
 *   id, type: 'column' | 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'combo' | 'histogram' | 'waterfall' | 'radar' | 'bubble'
 *     | 'treemap' | 'sunburst' | 'boxWhisker' | 'funnel' | 'stock' | 'surface',
 *   range: { r1, c1, r2, c2 },       the cells charted (on the chart's own sheet)
 *   title: string,
 *   titleRef?, xTitleRef?, yTitleRef?, y2TitleRef?: string, live worksheet references for chart/axis titles
 *   anchor: { r, c }, dx, dy,        the cell the top-left corner sits in, and the offset inside it
 *   anchorMode?: 'absolute',         fixed sheet coordinates: anchor is A1, dx/dy are the position
 *   cellAnchor?: { from, to, box?, editAs? }, native cell markers; box is a child's affine fraction
 *   w, h,                            size in unzoomed pixels (derived for move-and-size cellAnchor)
 *   seriesIn: 'auto' | 'cols' | 'rows',
 *   headers: 'auto' | true | false,  is the first row (or column) a header?
 *   legend: boolean, stacked: boolean, stack100: boolean (stacked to 100%), trendline: boolean,
 *   labels: boolean,                 write each value on its bar or point
 *   xTitle, yTitle, y2Title: string,          axis titles
 *   colors: (string|null)[],         a hex color per series (per slice for pies); null keeps the palette color
 *   legendPos: 'bottom' | 'top' | 'right',
 *   gridlines: boolean,              value-axis gridlines (default true)
 *   smooth: boolean,                 curved lines (line and area)
 *   yMin, yMax: number | null,       fixed value-axis bounds; null fits the data
 *   bins: number | null,             histogram bin count; null picks one from the data
 *   includeHidden: boolean,          chart hidden and filtered-out rows and columns too (default false)
 *   sourceRefs?: [{ name, nameRef, pivotName, categories, values, labels, categoryFormat, valueFormat }],
 *                                    imported series with their own cross-sheet source references
 *   appearance?: object,             imported chart's DrawingML layout, fonts, axes and markers
 *   pareto?: boolean,                aggregate/sort the single imported source and derive its cumulative line
 *   explosion?: number,              pie and doughnut: how far every slice is pulled out, in percent of the radius
 *   ofPie?: { kind: 'pie' | 'bar', split, secondSize, gap },  pie of pie / bar of pie: the last `split`
 *                                    values drawn again in a second, smaller plot beside an Other slice
 *   box?: { quartiles: 'exclusive' | 'inclusive', meanMarkers, meanLine, innerPoints, outliers, gapWidth },
 *   treemapLabels?: 'overlapping' | 'banner' | 'none',   where a treemap names its parents
 *   stock?: 'hlc' | 'ohlc' | 'vhlc' | 'vohlc',          which price (and volume) columns follow the dates
 *   surfaceView?: 'surface3d' | 'wireframe3d' | 'contour' | 'wireframeContour',
 * }
 * A combo chart draws every series but the last as columns and the last as a
 * line. A histogram counts every number in the range into equal bins. A
 * waterfall reads the first series as changes and floats each bar from the
 * running total, ending with a total bar. A radar chart draws each series as a
 * polygon around the categories. A bubble chart is a scatter chart whose
 * third numeric column sizes the points. A treemap or sunburst reads its
 * leading label columns as the levels of a hierarchy sized by the first numeric
 * column after them; a box and whisker chart pools each series' values by
 * category; a funnel draws one series as centred bars; a stock chart reads its
 * columns as (volume,) (open,) high, low and close; a surface treats the range
 * as a grid of heights (see chart-special.js).
 */
import { normalizeScrollControl } from './scroll-control.js';
import { normalizeSlicer } from './slicer.js';
import { normalizeTimeline } from './timeline.js';
import { normalizeNativeDrawing, validDrawingKey } from './drawingml-native.js';
import { pictureRect } from './picture-geometry.js';
import { normalizePictureFormat } from './picture-format.js';
import { normalizeSmartArt, SMARTART_MIN } from './smartart.js';

import { normalizeRange } from './cell.js';
import { HIERARCHY_TYPES, STOCK_KINDS, fillDownLevels } from './chart-special.js';
import { externalWorkbookScope } from './external-workbooks.js';
import { rebaseWorkbookTarget } from './workbook-location.js';
import { MAX_ROW, MAX_COL, refToText } from './refs.js';
import { formatValue, dateTimeKind, numFmtToStyle, styleToNumFmt, fontKeyFor, fontName, fontStack } from './format.js';
import { isError, isRange } from './formula/functions.js';
import { parseFormula } from './formula/parser.js';
import { evaluate, withArrayBudget } from './formula/evaluator.js';

const CHART_MARKER_SYMBOLS = ['auto', 'circle', 'dash', 'diamond', 'dot', 'none', 'plus', 'square', 'star', 'triangle', 'x'];
// DrawingML preset dash/gap lengths, in multiples of the line width.
export const CHART_LINE_DASHES = Object.freeze({ solid: [], dot: [1, 3], dash: [4, 3], lgDash: [8, 3],
  dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDash: [3, 1], sysDot: [1, 1], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1] });

export const CHART_DISPLAY_UNITS = Object.freeze({ hundreds: 1e2, thousands: 1e3, tenThousands: 1e4, hundredThousands: 1e5,
  millions: 1e6, tenMillions: 1e7, hundredMillions: 1e8, billions: 1e9, trillions: 1e12 });

export const CHART_TYPES = [
  ['column', 'Column'],
  ['bar', 'Bar'],
  ['line', 'Line'],
  ['area', 'Area'],
  ['pie', 'Pie'],
  ['donut', 'Donut'],
  ['scatter', 'Scatter'],
  ['combo', 'Combo'],
  ['histogram', 'Histogram'],
  ['waterfall', 'Waterfall'],
  ['radar', 'Radar'],
  ['bubble', 'Bubble'],
  ['treemap', 'Treemap'],
  ['sunburst', 'Sunburst'],
  ['boxWhisker', 'Box & Whisker'],
  ['funnel', 'Funnel'],
  ['stock', 'Stock'],
  ['surface', 'Surface'],
];

/** Authored charts reserve 20% of a category slot between clusters. DrawingML
 * measures that gap in single-bar widths, capped at 500% (ST_GapAmount).
 * Share the conversion with rendering so dense groups honor the same limit. */
export function authoredBarGapWidth(groups) {
  const categoryGap = .2;
  return Math.min(500, 100 * categoryGap / (1 - categoryGap) * Math.max(1, groups));
}

export const CHART_MIN_W = 160;
export const CHART_MIN_H = 120;

export function defaultChart(range, anchor) {
  return {
    type: 'column', range: normalizeRange(range), title: '', anchor: { r: anchor.r, c: anchor.c }, dx: 8, dy: 6,
    w: 480, h: 300, seriesIn: 'auto', headers: 'auto', legend: true, stacked: false, stack100: false, trendline: false, labels: false, xTitle: '', yTitle: '', y2Title: '',
    colors: [], legendPos: 'bottom', gridlines: true, smooth: false, yMin: null, yMax: null, bins: null, includeHidden: false,
  };
}

export const IMAGE_MIN = 24;

/** An image floating over the sheet shares the chart object model: anchor, offset, size. */
export function isImage(obj) {
  return obj?.type === 'image';
}

export function imageTransform(obj) {
  return [obj.rotation ? `rotate(${obj.rotation}deg)` : '',
    obj.flipH || obj.flipV ? `scale(${obj.flipH ? -1 : 1}, ${obj.flipV ? -1 : 1})` : ''].filter(Boolean).join(' ');
}

export const TEXT_MIN = 40;
export const TEXT_MAX_LENGTH = 4000;
export const CHART_DESCRIPTION_MAX_LENGTH = 32767;
export const TEXT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48];

/** A SmartArt diagram floating over the sheet (see smartart.js). */
export const isSmartArt = (obj) => obj?.type === 'smartart';

/** A text box floating over the sheet: a label, a note, a title for a dashboard. */
export function isTextBox(obj) {
  return obj?.type === 'text';
}

export function textBoxText(wb, sheetId, obj) {
  if (!obj.textRef) return obj.text;
  const ref = wb.rangeFromText(sheetId, obj.textRef);
  let value = '#REF!';
  if (ref) value = wb.getDisplay(ref.sheetId, ref.range.r1, ref.range.c1);
  return `${obj.textPrefix || ''}${value}${obj.textSuffix || ''}`;
}

/** Linked titles use the first cell, including references to a merged range.
 * Resolve the current display value; a saved chart cache must not mask edits or
 * broken references. Hidden cells still supply title text.
 */
export function chartTitles(wb, sheetId, chart) {
  return Object.fromEntries(['title', 'xTitle', 'yTitle', 'y2Title'].filter(key => chart[`${key}Ref`]).map(key => {
    const ref = wb.rangeFromText(sheetId, chart[`${key}Ref`]);
    return [key, linkedChartText(wb, sheetId, chart, key, chart[`${key}Ref`], ref ? wb.getDisplay(ref.sheetId, ref.range.r1, ref.range.c1) : '#REF!')];
  }));
}

/** The CSS a text box's body is drawn with, on screen and in print. */
export function textBoxStyle(obj, scale = 1) {
  const st = obj?.style || {};
  return {
    fontSize: `${(st.size || 13) * scale}px`,
    ...(st.font ? { fontFamily: fontStack(st.font) } : {}),
    ...(st.padding ? { padding: st.padding.map(n => `${n * scale}px`).join(' '), lineHeight: '1.2' } : {}),
    ...(obj.textRef ? { whiteSpace: 'pre', wordBreak: 'normal' } : {}),
    fontWeight: st.bold ? '600' : '400',
    fontStyle: st.italic ? 'italic' : 'normal',
    color: st.color || '',
    backgroundColor: st.bg || '',
    textAlign: st.align || 'left',
    alignItems: st.valign === 'middle' ? 'center' : st.valign === 'bottom' ? 'flex-end' : 'flex-start',
    ...textEffectsCss(st.effects, scale),
  };
}

/** WordArt's text effects (Insert ▸ Text ▸ WordArt): an outline round the letters, a shadow and a glow. */
export function normalizeTextEffects(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (HEX.test(raw.outline || '')) {
    out.outline = raw.outline.toLowerCase();
    const w = Number(raw.outlineWidth);
    out.outlineWidth = Number.isFinite(w) && w > 0 && w <= 10 ? w : 1;
  }
  if (HEX.test(raw.shadow || '')) out.shadow = raw.shadow.toLowerCase();
  if (HEX.test(raw.glow || '')) out.glow = raw.glow.toLowerCase();
  return Object.keys(out).length ? out : null;
}

function textEffectsCss(effects, scale) {
  if (!effects) return {};
  const rgba = (hex, a) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${a})`;
  const shadows = [effects.glow && `0 0 ${6 * scale}px ${rgba(effects.glow, 0.85)}`, effects.shadow && `${2 * scale}px ${2 * scale}px ${3 * scale}px ${rgba(effects.shadow, 0.45)}`].filter(Boolean);
  return {
    ...(effects.outline ? { WebkitTextStroke: `${effects.outlineWidth * scale}px ${effects.outline}`, paintOrder: 'stroke fill' } : {}),
    ...(shadows.length ? { textShadow: shadows.join(', ') } : {}),
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
function normalizeTextStyle(raw) {
  const st = raw && typeof raw === 'object' ? raw : {};
  const size = Number(st.size);
  return {
    size: Number.isFinite(size) && size >= 6 && size <= 400 ? size : 13,
    ...(typeof st.font === 'string' && fontKeyFor(fontName(st.font), { literal: true }) ? { font: fontKeyFor(fontName(st.font), { literal: true }) } : {}),
    ...(Array.isArray(st.padding) && st.padding.length === 4 && st.padding.every(n => Number.isFinite(n) && n >= 0 && n <= 1000) ? { padding: [...st.padding] } : {}),
    bold: !!st.bold,
    italic: !!st.italic,
    color: typeof st.color === 'string' && HEX.test(st.color) ? st.color.toLowerCase() : null,
    bg: typeof st.bg === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(st.bg) ? st.bg.toLowerCase() : null,
    align: ['left', 'center', 'right'].includes(st.align) ? st.align : 'left',
    valign: ['top', 'middle', 'bottom'].includes(st.valign) ? st.valign : 'top',
    border: st.border !== false,
    ...(normalizeTextEffects(st.effects) ? { effects: normalizeTextEffects(st.effects) } : {}),
    // A theme effect (Subtle, Moderate or Intense), drawn with the workbook's effect scheme.
    ...([1, 2, 3].includes(st.effectRef) ? { effectRef: st.effectRef } : {}),
  };
}

/** The longest name a drawing object keeps (the Selection Pane's name, cNvPr@name in a file). */
export const OBJECT_NAME_MAX = 255;

/**
 * Bring a stored chart (from a file or JSON) back to a well-formed one, or null. Every kind of object also
 * keeps its Arrange state: a name given in the Selection Pane, whether it is hidden, the group it belongs
 * to, and for a text box its rotation and flips (a picture keeps its own).
 */
export function normalizeChart(raw) {
  const body = normalizeChartBody(raw);
  if (!body) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, OBJECT_NAME_MAX) : '';
  if (name) body.name = name; else delete body.name;
  if (raw.hidden === true) body.hidden = true; else if (body.type !== 'slicer') delete body.hidden;
  if (typeof raw.group === 'string' && /^[\w{}-]{1,64}$/.test(raw.group)) body.group = raw.group; else delete body.group;
  if (body.type === 'text') {
    if (Number.isFinite(raw.rotation) && raw.rotation % 360) body.rotation = ((raw.rotation % 360) + 360) % 360;
    if (raw.flipH === true) body.flipH = true;
    if (raw.flipV === true) body.flipV = true;
  }
  return body;
}

function normalizeChartBody(raw) {
  if (!raw || !raw.anchor) return null;
  if (raw.type === 'scroll') return normalizeScrollControl(raw);
  if (raw.type === 'slicer') return normalizeSlicer(raw);
  if (raw.type === 'timeline') return normalizeTimeline(raw);
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const cellAnchor = (raw.anchorMode !== 'absolute' || raw.cellAnchor?.editAs === 'absolute') && normalizeCellAnchor(raw.cellAnchor);
  const common = { ...(cellAnchor ? { cellAnchor } : {}), ...(validDrawingKey(raw.drawingKey) ? { drawingKey: raw.drawingKey } : {}), ...(raw.anchorMode === 'absolute' ? { anchorMode: 'absolute' } : {}),
    ...(raw.decorative === true ? { decorative: true } : {}),
    // Alternative text (Edit Alt Text…), for pictures and text boxes as for charts.
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description.slice(0, CHART_DESCRIPTION_MAX_LENGTH) } : {}),
    ...(typeof raw.hyperlink === 'string' && raw.hyperlink && raw.hyperlink.length <= 32767
      ? { hyperlink: raw.hyperlink, ...(typeof raw.hyperlinkTooltip === 'string' ? { hyperlinkTooltip: raw.hyperlinkTooltip.slice(0, 1024) } : {}) } : {}) };
  if (raw.type === 'image') {
    if (typeof raw.src !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw.src)) return null;
    const anchor = { r: Math.max(0, num(raw.anchor.r, 0) | 0), c: Math.max(0, num(raw.anchor.c, 0) | 0) };
    const nativeDrawing = raw.drawingShape && normalizeNativeDrawing(raw.nativeDrawing);
    return {
      id: raw.id,
      type: 'image',
      ...common,
      src: raw.src,
      ...(pictureRect(raw.srcRect) ? { srcRect: pictureRect(raw.srcRect) } : {}),
      ...(pictureRect(raw.fillRect) ? { fillRect: pictureRect(raw.fillRect) } : {}),
      ...(typeof raw.nativeSrc === 'string' && raw.nativeSrc.length <= 22400000 && raw.nativeSrc.startsWith('data:image/x-emf;base64,')
        && raw.src.startsWith('data:image/svg+xml;base64,') ? { nativeSrc: raw.nativeSrc } : {}),
      range: { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c },
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
      anchor,
      dx: num(raw.dx, 0),
      dy: num(raw.dy, 0),
      // Native pictures can be smaller than the interactive insertion minimum,
      // including thin artwork saved as a picture by another spreadsheet reader.
      w: Math.max(raw.drawingShape ? 1 / 9525 : raw.nativeSize ? 1 : IMAGE_MIN, num(raw.w, 240)),
      h: Math.max(raw.drawingShape ? 1 / 9525 : raw.nativeSize ? 1 : IMAGE_MIN, num(raw.h, 160)),
      ...(raw.drawingShape ? { drawingShape: true } : {}),
      ...(nativeDrawing ? { nativeDrawing } : {}),
      ...(raw.nativeSize ? { nativeSize: true } : {}),
      ...(raw.flipH ? { flipH: true } : {}),
      ...(raw.flipV ? { flipV: true } : {}),
      ...(Number.isFinite(raw.rotation) && raw.rotation % 360 ? { rotation: ((raw.rotation % 360) + 360) % 360 } : {}),
      ...(raw.border === false ? { border: false } : {}),
      // Picture Format: crop is srcRect above; corrections, colour, transparency, style and the size lock here.
      ...normalizePictureFormat(raw),
      // A linked picture (Paste Special ▸ Linked Picture) shows the cells this reference names, live; `src` is its last picture.
      ...(typeof raw.pictureRef === 'string' && raw.pictureRef.trim() && raw.pictureRef.length <= 8192 ? { pictureRef: raw.pictureRef.trim().replace(/^=/, '') } : {}),
    };
  }
  if (raw.type === 'smartart') {
    // A SmartArt diagram (see smartart.js): its outline, layout, colours and style; drawn from them each time.
    const anchor = { r: Math.max(0, num(raw.anchor.r, 0) | 0), c: Math.max(0, num(raw.anchor.c, 0) | 0) };
    const min = raw.nativeSize ? 1 : SMARTART_MIN;
    return {
      id: raw.id,
      type: 'smartart',
      ...common,
      ...normalizeSmartArt(raw),
      ...(raw.nativeSize ? { nativeSize: true } : {}),
      range: { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c },
      title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
      anchor,
      dx: num(raw.dx, 0),
      dy: num(raw.dy, 0),
      w: Math.max(min, num(raw.w, 480)),
      h: Math.max(min, num(raw.h, 300)),
    };
  }
  if (raw.type === 'text') {
    const anchor = { r: Math.max(0, num(raw.anchor.r, 0) | 0), c: Math.max(0, num(raw.anchor.c, 0) | 0) };
    const text = typeof raw.text === 'string' ? raw.text.slice(0, TEXT_MAX_LENGTH) : '';
    const style = normalizeTextStyle(raw.style);
    // Empty, filled boxes also carry imported rectangle artwork. The text
    // editing minimum must not enlarge those decorations on load or move.
    const min = raw.nativeSize || !text.trim() && style.bg && !style.border ? 1 : TEXT_MIN;
    return {
      id: raw.id,
      type: 'text',
      ...common,
      text,
      // An equation (Insert ▸ Equation): its linear source; `text` holds its linear text.
      ...(typeof raw.equation === 'string' && raw.equation.trim() ? { equation: raw.equation.slice(0, TEXT_MAX_LENGTH) } : {}),
      ...(raw.nativeSize ? { nativeSize: true } : {}),
      ...(typeof raw.textRef === 'string' && raw.textRef.length <= 8192 ? { textRef: raw.textRef,
        textPrefix: typeof raw.textPrefix === 'string' ? raw.textPrefix.slice(0, TEXT_MAX_LENGTH) : '',
        textSuffix: typeof raw.textSuffix === 'string' ? raw.textSuffix.slice(0, TEXT_MAX_LENGTH) : '' } : {}),
      style,
      range: { r1: anchor.r, c1: anchor.c, r2: anchor.r, c2: anchor.c },
      title: '',
      anchor,
      dx: num(raw.dx, 0),
      dy: num(raw.dy, 0),
      w: Math.max(min, num(raw.w, 220)),
      h: Math.max(min, num(raw.h, 80)),
    };
  }
  if (!raw.range) return null;
  // Chart ranges drive cell-by-cell loops. Reject malformed file metadata
  // before normalizing it, including negative bounds that never increment.
  if (!['r1', 'r2'].every((key) => Number.isInteger(raw.range[key]) && raw.range[key] >= 0 && raw.range[key] <= MAX_ROW)
    || !['c1', 'c2'].every((key) => Number.isInteger(raw.range[key]) && raw.range[key] >= 0 && raw.range[key] <= MAX_COL)) return null;
  const type = CHART_TYPES.some(([t]) => t === raw.type) ? raw.type : 'column';
  const linkedText = normalizeLinkedChartText(raw.linkedText);
  return {
    id: raw.id,
    type,
    ...common,
    range: normalizeRange(raw.range),
    // Alternative text is independent of the visible title and its 200-character limit.
    ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, CHART_DESCRIPTION_MAX_LENGTH) } : {}),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    anchor: { r: Math.max(0, num(raw.anchor.r, 0) | 0), c: Math.max(0, num(raw.anchor.c, 0) | 0) },
    dx: num(raw.dx, 0),
    dy: num(raw.dy, 0),
    w: Math.max(cellAnchor ? 0 : CHART_MIN_W, num(raw.w, 480)),
    // Imported progress charts can be shorter than the interactive resize limit.
    h: Math.max(cellAnchor ? 0 : raw.appearance ? 24 : CHART_MIN_H, num(raw.h, 300)),
    seriesIn: raw.seriesIn === 'cols' || raw.seriesIn === 'rows' ? raw.seriesIn : 'auto',
    headers: raw.headers === true || raw.headers === false ? raw.headers : 'auto',
    legend: raw.legend !== false,
    stacked: !!raw.stacked,
    stack100: !!raw.stack100,
    trendline: !!raw.trendline,
    labels: !!raw.labels,
    xTitle: typeof raw.xTitle === 'string' ? raw.xTitle.slice(0, 80) : '',
    yTitle: typeof raw.yTitle === 'string' ? raw.yTitle.slice(0, 80) : '',
    y2Title: typeof raw.y2Title === 'string' ? raw.y2Title.slice(0, 80) : '',
    ...Object.fromEntries(['titleRef', 'xTitleRef', 'yTitleRef', 'y2TitleRef'].filter(key => typeof raw[key] === 'string' && raw[key].trim())
      .map(key => [key, raw[key].trim().slice(0, 8192)])),
    ...(raw.pivotSource && typeof raw.pivotSource.name === 'string' && raw.pivotSource.name ? { pivotSource: {
      name: raw.pivotSource.name.slice(0, 32767), standalone: raw.pivotSource.standalone === true,
      formatId: Number.isInteger(raw.pivotSource.formatId) && raw.pivotSource.formatId >= 0 && raw.pivotSource.formatId <= 4294967295 ? raw.pivotSource.formatId : 0,
    } } : {}),
    ...(linkedText ? { linkedText } : {}),
    colors: normalizeColors(raw.colors),
    legendPos: raw.legendPos === 'top' || raw.legendPos === 'right' ? raw.legendPos : 'bottom',
    gridlines: raw.gridlines !== false,
    smooth: !!raw.smooth,
    secondaryAxis: !!raw.secondaryAxis, // combo: the line reads against its own axis on the right
    ...(type === 'combo' && raw.pareto && raw.sourceRefs?.length === 1 ? { pareto: true } : {}),
    yMin: Number.isFinite(raw.yMin) && (!Number.isFinite(raw.yMax) || raw.yMin < raw.yMax) ? raw.yMin : null,
    yMax: Number.isFinite(raw.yMax) && (!Number.isFinite(raw.yMin) || raw.yMin < raw.yMax) ? raw.yMax : null,
    bins: Number.isInteger(raw.bins) && raw.bins >= 2 && raw.bins <= 100 ? raw.bins : null,
    includeHidden: !!raw.includeHidden,
    ...normalizeSpecialOptions(type, raw),
    ...(Array.isArray(raw.sourceRefs) && raw.sourceRefs.length ? {
      sourceRefs: raw.sourceRefs.slice(0, 60).map(s => ({ ...Object.fromEntries(
        ['name', 'nameRef', 'categories', 'values', 'sizes', 'labels', 'categoryFormat', 'valueFormat', 'sizeFormat', 'labelFormat', 'categoryMode'].map(k => [k, typeof s?.[k] === 'string' ? s[k].slice(0, k === 'name' ? 32767 : 8192) : ''])),
        ...(typeof s?.pivotName === 'string' ? { pivotName: s.pivotName.slice(0, 32767) } : {}),
        ...Object.fromEntries(['categoryPointFormats', 'valuePointFormats', 'sizePointFormats', 'labelPointFormats'].filter(key => Array.isArray(s?.[key]))
          .map(key => [key, s[key].slice(0, 5000).map(code => typeof code === 'string' ? code.slice(0, 8192) : null)])),
        ...Object.fromEntries(['categoryDisplayCache', 'labelDisplayCache'].filter(key => Array.isArray(s?.[key])).map(key => [key, s[key].slice(0, 5000).map(point =>
          point && Number.isFinite(point.value) && typeof point.source === 'string' && point.source.length <= 65536 && typeof point.text === 'string'
            ? { value: point.value, source: point.source, text: point.text.slice(0, 32767) } : null)])),
        ...(s?.literal && typeof s.literal === 'object' ? { literal: Object.fromEntries(['categories', 'values', 'sizes'].filter(k => Array.isArray(s.literal[k]))
          .map(k => [k, s.literal[k].slice(0, 5000).map(v => Number.isFinite(v) ? v : k === 'categories' && typeof v === 'string' ? v.slice(0, 512) : null)])) } : {}),
      })),
    } : {}),
    ...(raw.appearance ? { appearance: normalizeAppearance(raw.appearance) } : {}),
  };
}

/** The options of the pie variants and the newer chart types, kept only on the type they belong to. */
function normalizeSpecialOptions(type, raw) {
  const out = {};
  const between = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  if ((type === 'pie' || type === 'donut') && between(raw.explosion, 0, 400) && raw.explosion > 0) out.explosion = raw.explosion;
  if (type === 'pie' && raw.ofPie && typeof raw.ofPie === 'object') {
    const o = raw.ofPie;
    out.ofPie = { kind: o.kind === 'bar' ? 'bar' : 'pie', split: Number.isInteger(o.split) && o.split >= 1 && o.split <= 1000 ? o.split : 3,
      secondSize: between(o.secondSize, 5, 200) ? o.secondSize : 75, gap: between(o.gap, 0, 500) ? o.gap : 100 };
  }
  if (type === 'boxWhisker') {
    const b = raw.box && typeof raw.box === 'object' ? raw.box : {};
    out.box = { quartiles: b.quartiles === 'inclusive' ? 'inclusive' : 'exclusive', meanMarkers: b.meanMarkers !== false, meanLine: !!b.meanLine,
      innerPoints: !!b.innerPoints, outliers: b.outliers !== false, gapWidth: between(b.gapWidth, 0, 500) ? b.gapWidth : 100 };
  }
  if (type === 'treemap') out.treemapLabels = ['banner', 'none'].includes(raw.treemapLabels) ? raw.treemapLabels : 'overlapping';
  if (type === 'stock') out.stock = Object.hasOwn(STOCK_KINDS, raw.stock) ? raw.stock : 'hlc';
  if (type === 'surface') out.surfaceView = ['wireframe3d', 'contour', 'wireframeContour'].includes(raw.surfaceView) ? raw.surfaceView : 'surface3d';
  return out;
}

function normalizeAppearance(raw) {
  const mixedSeries = Array.isArray(raw.seriesTypes) && raw.seriesTypes.length > 0
    && raw.seriesTypes.every(t => ['area', 'column', 'line', 'scatter'].includes(t));
  // Older mixed-series charts stored CSS pixels; all other charts stored points.
  // Tag normalized values so repeated JSON/copy/import normalization is idempotent.
  const markerPoints = line => (Number.isFinite(line?.markerSize) ? line.markerSize : 5)
    * (line?.markerSizeUnit === 'pt' ? 1 : line?.markerSizeUnit === 'px' || mixedSeries ? 3 / 4 : 1);
  const color = c => typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : null;
  const n = (v, min, max, fallback) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  // Text body rotation is DrawingML ST_Angle (signed 32-bit, 1/60000 degree),
  // not ST_FixedAngle. Keep its sign and full turns: Excel uses them for alignment.
  const rotation = v => Number.isFinite(v) && v >= -2147483648 / 60000 && v <= 2147483647 / 60000 ? v : 0;
  const style = s => ({ font: fontKeyFor(fontName(s?.font), { literal: true }) || 'arial', size: n(s?.size, 6, 96, 16), color: color(s?.color) || '#000000', ...(s?.bold ? { bold: true } : {}), ...(s?.italic ? { italic: true } : {}) });
  const position = p => ['ctr', 't', 'b', 'l', 'r'].includes(p) ? p : null;
  const layout = l => l && Number.isFinite(l.x) && Number.isFinite(l.y) ? {
    x: n(l.x, 0, 1, 0), y: n(l.y, 0, 1, 0), w: n(l.w, .01, 1, null), h: n(l.h, .01, 1, null),
  } : null;
  const points = list => (Array.isArray(list) ? list : []).slice(0, 5000)
    .filter(p => Number.isInteger(p?.index) && p.index >= 0 && p.index < 5000);
  const paint = c => c === 'none' ? 'none' : color(c);
  const gridColor = c => c === 'none' ? 'none' : typeof c === 'string' && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(c) ? c.toLowerCase() : null;
  const labelExtension = (l, point) => {
    const box = Object.fromEntries((point ? ['w', 'h'] : ['x', 'y', 'w', 'h'])
      .filter(k => Number.isFinite(l?.extensionLayout?.[k])).map(k => [k, l.extensionLayout[k]]));
    return Object.keys(box).length ? { extensionLayout: box } : {};
  };
  const pieLabel = (l, point = false) => ({ style: style(l?.style), category: !!l?.category, value: !!l?.value, percent: !!l?.percent, series: !!l?.series,
    hidden: !!l?.hidden, leaderLines: !!l?.leaderLines, position: ['ctr', 'inEnd', 'outEnd', 'bestFit'].includes(l?.position) ? l.position : 'bestFit',
    separator: typeof l?.separator === 'string' ? l.separator.slice(0, 100) : ', ',
    numberFormat: typeof l?.numberFormat === 'string' ? l.numberFormat.slice(0, 512) : '',
    ...labelExtension(l, point),
    ...(Array.isArray(l?.content) ? { content: l.content.slice(0, 100).filter(c => ['text', 'category', 'value', 'percent', 'series'].includes(c?.kind))
      .map(c => ({ kind: c.kind, ...(c.kind === 'text' ? { text: typeof c.text === 'string' ? c.text.slice(0, 1000) : '' } : {}) })) } : {}),
  });
  const gradient = g => g && Array.isArray(g.stops) ? { angle: n(g.angle, 0, 360, 90), ...(typeof g.scaled === 'boolean' ? { scaled: g.scaled } : {}), stops: g.stops.slice(0, 32)
    .filter(s => Number.isFinite(s?.offset) && color(s?.color)).map(s => ({ offset: n(s.offset, 0, 1, 0), color: color(s.color), opacity: n(s.opacity, 0, 1, 1) })).sort((a, b) => a.offset - b.offset) } : null;
  const chartLine = l => ({ width: n(l?.width, .25, 20, 2),
    ...(typeof l?.smooth === 'boolean' ? { smooth: l.smooth } : {}),
    ...(l?.visible === false ? { visible: false } : {}), ...(color(l?.color) ? { color: color(l.color) } : {}),
    ...(Object.hasOwn(CHART_LINE_DASHES, l?.dash) && l.dash !== 'solid' ? { dash: l.dash } : {}),
    ...(CHART_MARKER_SYMBOLS.includes(l?.markerSymbol) ? { markerSymbol: l.markerSymbol } : {}),
    marker: l?.marker !== false, markerSize: n(markerPoints(l), 2, 72, 5), markerSizeUnit: 'pt', markerFill: gridColor(l?.markerFill), markerStroke: gridColor(l?.markerStroke) });
  return {
    ...(raw.radar && typeof raw.radar === 'object' ? { radar: {
      style: ['standard', 'marker', 'filled'].includes(raw.radar.style) ? raw.radar.style : 'standard',
      blanks: ['gap', 'span', 'zero'].includes(raw.radar.blanks) ? raw.radar.blanks : 'gap',
      series: (Array.isArray(raw.radar.series) ? raw.radar.series : []).slice(0, 60).map(s => ({
        fill: gridColor(s?.fill), gradient: gradient(s?.gradient),
        stroke: gridColor(s?.stroke), dash: Object.hasOwn(CHART_LINE_DASHES, s?.dash) ? s.dash : null,
        markerSymbol: CHART_MARKER_SYMBOLS.includes(s?.markerSymbol) ? s.markerSymbol : 'circle',
      })),
    } } : {}),
    ...(raw.textStyle && typeof raw.textStyle === 'object' ? { textStyle: style(raw.textStyle) } : {}),
    ...(typeof raw.roundedCorners === 'boolean' ? { roundedCorners: raw.roundedCorners } : {}),
    // The default chart look (chart-subtypes.js): its automatic layout, the chart area's outline,
    // the line a series starts with, how blank cells plot, and Format ▸ Shape Fill/Outline/Effects.
    ...(raw.excelLayout === true ? { excelLayout: true } : {}),
    ...(gridColor(raw.borderColor) ? { borderColor: gridColor(raw.borderColor) } : {}),
    ...(Number.isFinite(raw.borderWidth) ? { borderWidth: n(raw.borderWidth, 0, 20, 1) } : {}),
    ...(raw.lineDefault && typeof raw.lineDefault === 'object' ? { lineDefault: chartLine(raw.lineDefault) } : {}),
    ...(['gap', 'zero', 'span'].includes(raw.blanks) ? { blanks: raw.blanks } : {}),
    ...Object.fromEntries(['titleBox', 'legendBox'].filter(k => raw[k] && typeof raw[k] === 'object')
      .map(k => [k, { fill: paint(raw[k].fill), stroke: paint(raw[k].stroke) }])),
    ...(raw.effects && typeof raw.effects === 'object' ? { effects: Object.fromEntries(Object.entries(raw.effects).slice(0, 200)
      .filter(([k, e]) => /^(chartArea|plotArea|title|legend|series:\d{1,2})$/.test(k) && e && typeof e === 'object')
      .map(([k, e]) => [k, { shadow: e.shadow === true, glow: color(e.glow) }])
      .filter(([, e]) => e.shadow || e.glow)) } : {}),
    background: raw.background === 'none' ? 'none' : color(raw.background) || '#ffffff', border: raw.border !== false, plot: layout(raw.plot), title: layout(raw.title), legend: layout(raw.legend),
    ...Object.fromEntries(['xUnits', 'yUnits', 'y2Units'].flatMap(key => {
      const u = raw[key], builtIn = Object.hasOwn(CHART_DISPLAY_UNITS, u?.builtIn) ? u.builtIn : null;
      const divisor = builtIn ? CHART_DISPLAY_UNITS[builtIn] : u?.divisor;
      return Number.isFinite(divisor) && divisor > 0 ? [[key, { builtIn, divisor: n(divisor, 1e-100, 1e100, 1),
        label: typeof u?.label === 'string' ? u.label.slice(0, 512) : '', style: style(u?.style), layout: layout(u?.layout), rotation: rotation(u?.rotation) }]] : [];
    })),
    legendPos: ['top', 'right', 'bottom'].includes(raw.legendPos) ? raw.legendPos : 'bottom',
    legendHidden: (Array.isArray(raw.legendHidden) ? raw.legendHidden : []).slice(0, 60).filter(i => Number.isInteger(i) && i >= 0 && i < 60),
    titleStyle: style(raw.titleStyle), legendStyle: style(raw.legendStyle), xStyle: style(raw.xStyle), yStyle: style(raw.yStyle),
    ...(raw.dataTable && typeof raw.dataTable === 'object' ? { dataTable: {
      horizontal: !!raw.dataTable.horizontal, vertical: !!raw.dataTable.vertical,
      outline: !!raw.dataTable.outline, keys: !!raw.dataTable.keys,
      style: style(raw.dataTable.style), fill: paint(raw.dataTable.fill) || 'none',
      stroke: paint(raw.dataTable.stroke) || '#000000', width: n(raw.dataTable.width, 0, 20, 1),
    } } : {}),
    ...(Array.isArray(raw.annotations) ? { annotations: raw.annotations.slice(0, 100).filter(a => layout(a?.box))
      .map(a => ({ box: layout(a.box), text: typeof a.text === 'string' ? a.text.slice(0, 4000) : '', style: style(a.style),
        align: ['center', 'right'].includes(a.align) ? a.align : 'left', fill: paint(a.fill) || 'none', stroke: paint(a.stroke) || 'none' })) } : {}),
    hideXAxis: !!raw.hideXAxis, hideYAxis: !!raw.hideYAxis, hideY2Axis: !!raw.hideY2Axis, reverseCategories: !!raw.reverseCategories, valueTicks: !!raw.valueTicks,
    reverseValues: raw.reverseValues === true, reverseSecondaryValues: raw.reverseSecondaryValues === true,
    ...(raw.axisStyles && typeof raw.axisStyles === 'object' ? { axisStyles: Object.fromEntries(['x', 'y', 'y2']
      .filter(k => raw.axisStyles[k] && typeof raw.axisStyles[k] === 'object').map(k => {
        const s = raw.axisStyles[k];
        return [k, { color: gridColor(s.color), width: n(s.width, 0, 100, null),
          dash: Object.hasOwn(CHART_LINE_DASHES, s.dash) ? s.dash : null,
          majorTick: ['none', 'in', 'out', 'cross'].includes(s.majorTick) ? s.majorTick : null,
          minorTick: ['none', 'in', 'out', 'cross'].includes(s.minorTick) ? s.minorTick : null,
          minorUnit: Number.isFinite(s.minorUnit) && s.minorUnit > 0 ? s.minorUnit : null,
          minorTimeUnit: ['days', 'months', 'years'].includes(s.minorTimeUnit) ? s.minorTimeUnit : null,
          tickSkip: Number.isInteger(s.tickSkip) && s.tickSkip > 0 && s.tickSkip <= 4294967295 ? s.tickSkip : null }];
      })) } : {}),
    ...Object.fromEntries(['xGridlines', 'y2Gridlines'].filter(k => typeof raw[k] === 'boolean').map(k => [k, raw[k]])),
    ...(raw.gridlineStyles && typeof raw.gridlineStyles === 'object' ? { gridlineStyles: Object.fromEntries(['x', 'y', 'y2']
      .filter(k => raw.gridlineStyles[k] && typeof raw.gridlineStyles[k] === 'object')
      .map(k => [k, { color: gridColor(raw.gridlineStyles[k].color),
        width: n(raw.gridlineStyles[k].width, 0, 100, null) }])) } : {}),
    yPosition: ['l', 'r', 't', 'b'].includes(raw.yPosition) ? raw.yPosition : null,
    ...(raw.axisCrossings && typeof raw.axisCrossings === 'object' ? { axisCrossings: Object.fromEntries(['x', 'y', 'y2']
      .filter(k => Number.isFinite(raw.axisCrossings[k]) || ['autoZero', 'min', 'max'].includes(raw.axisCrossings[k]))
      .map(k => [k, raw.axisCrossings[k]])) } : {}),
    xLabelPosition: ['high', 'low', 'none'].includes(raw.xLabelPosition) ? raw.xLabelPosition : 'nextTo',
    yLabelPosition: ['high', 'low', 'none'].includes(raw.yLabelPosition) ? raw.yLabelPosition : 'nextTo',
    y2LabelPosition: ['high', 'low', 'none'].includes(raw.y2LabelPosition) ? raw.y2LabelPosition : 'nextTo',
    plotFill: gridColor(raw.plotFill) || 'none', plotStroke: gridColor(raw.plotStroke), plotStrokeWidth: n(raw.plotStrokeWidth, 0, 100, null),
    plotStrokeDash: Object.hasOwn(CHART_LINE_DASHES, raw.plotStrokeDash) ? raw.plotStrokeDash : null,
    pointColors: (Array.isArray(raw.pointColors) ? raw.pointColors : []).slice(0, 60).map(points => (Array.isArray(points) ? points : []).slice(0, 5000)
      .filter(p => Number.isInteger(p?.index) && p.index >= 0 && p.index < 5000 && (color(p.color) || p.color === 'none'))
      .map(p => ({ index: p.index, color: color(p.color) || 'none' }))),
    // A native bar style also records the omitted invertIfNegative default (true).
    // Charts authored here have no bar style and keep their ordinary signed fill.
    ...(Array.isArray(raw.bars) ? { bars: raw.bars.slice(0, 60).map(b => b && typeof b === 'object' ? {
      ...(typeof b.invertIfNegative === 'boolean' ? { invertIfNegative: b.invertIfNegative } : {}),
      ...(b.gradient ? { gradient: gradient({ ...b.gradient, scaled: b.gradient.scaled === true }) } : {}),
      negativeColor: color(b.negativeColor), stroke: paint(b.stroke), strokeWidth: n(b.strokeWidth, 0, 100, null),
      strokeDash: Object.hasOwn(CHART_LINE_DASHES, b.strokeDash) ? b.strokeDash : null,
      points: points(b.points).map(p => ({ index: p.index,
        ...(p.shape === true ? { shape: true } : {}),
        ...(p.gradient ? { gradient: gradient({ ...p.gradient, scaled: p.gradient.scaled === true }) } : {}),
        ...(typeof p.invertIfNegative === 'boolean' ? { invertIfNegative: p.invertIfNegative } : {}),
        stroke: paint(p.stroke), strokeWidth: n(p.strokeWidth, 0, 100, null),
        strokeDash: Object.hasOwn(CHART_LINE_DASHES, p.strokeDash) ? p.strokeDash : null })),
    } : null) } : {}),
    ...(raw.pie && typeof raw.pie === 'object' ? { pie: {
      holeSize: n(raw.pie.holeSize, 10, 90, 50), firstSliceAngle: n(raw.pie.firstSliceAngle, 0, 360, 0),
      color: paint(raw.pie.color), varyColors: raw.pie.varyColors !== false,
      stroke: paint(raw.pie.stroke), strokeWidth: n(raw.pie.strokeWidth, 0, 20, 1),
      points: points(raw.pie.points).map(p => ({ index: p.index, stroke: paint(p.stroke), strokeWidth: n(p.strokeWidth, 0, 20, null) })),
      labels: { ...pieLabel(raw.pie.labels), points: points(raw.pie.labels?.points)
        .map(p => ({ ...pieLabel(p, true), index: p.index, dx: n(p.dx, -1, 1, 0), dy: n(p.dy, -1, 1, 0) })) },
    } } : {}),
    ...(raw.bubble && typeof raw.bubble === 'object' ? { bubble: {
      scale: n(raw.bubble.scale, 0, 300, 100), sizeRepresents: raw.bubble.sizeRepresents === 'w' ? 'w' : 'area', showNegative: !!raw.bubble.showNegative,
      xGrid: !!raw.bubble.xGrid, xGridColor: color(raw.bubble.xGridColor), yGridColor: color(raw.bubble.yGridColor),
      xAxisColor: paint(raw.bubble.xAxisColor), yAxisColor: paint(raw.bubble.yAxisColor),
      series: (Array.isArray(raw.bubble.series) ? raw.bubble.series : []).slice(0, 60).map(s => ({
        gradient: gradient(s?.gradient), stroke: paint(s?.stroke) || 'none', strokeWidth: n(s?.strokeWidth, 0, 20, 1),
        labels: { style: style(s?.labels?.style), value: !!s?.labels?.value, size: !!s?.labels?.size, category: !!s?.labels?.category,
          series: !!s?.labels?.series, position: position(s?.labels?.position) || 'ctr',
          points: points(s?.labels?.points).map(p => ({ index: p.index, hidden: !!p.hidden })) },
        errors: (Array.isArray(s?.errors) ? s.errors : []).slice(0, 2).filter(e => ['x', 'y'].includes(e?.axis) && ['stdErr', 'stdDev', 'percentage', 'fixedVal'].includes(e?.type))
          .map(e => ({ axis: e.axis, type: e.type, direction: ['plus', 'minus'].includes(e.direction) ? e.direction : 'both',
            value: n(e.value, 0, 1e100, 1), caps: e.caps !== false, color: color(e.color) || '#000000', width: n(e.width, 0, 20, 1) })),
      })),
    } } : {}),
    dateAxis: !!raw.dateAxis, xStep: n(raw.xStep, .000001, 1e6, null), yStep: n(raw.yStep, .000001, 1e100, null),
    categoryBetween: raw.categoryBetween == null ? !mixedSeries : !!raw.categoryBetween,
    xTimeUnit: ['months', 'years'].includes(raw.xTimeUnit) ? raw.xTimeUnit : 'days', xRotation: rotation(raw.xRotation),
    xBaseTimeUnit: ['months', 'years'].includes(raw.xBaseTimeUnit) ? raw.xBaseTimeUnit : 'days',
    xRotationAuto: raw.xRotationAuto !== false,
    xWrap: raw.xWrap === 'none' ? 'none' : 'square',
    ...(Number.isInteger(raw.xLabelSkip) && raw.xLabelSkip >= 1 && raw.xLabelSkip <= 4294967295 ? { xLabelSkip: raw.xLabelSkip } : {}),
    xMin: n(raw.xMin, -1e100, 1e100, null), xMax: n(raw.xMax, -1e100, 1e100, null),
    ...(raw.xSourceLinked === true ? { xSourceLinked: true } : {}),
    xFormat: typeof raw.xFormat === 'string' ? raw.xFormat.slice(0, 512) : '', yFormat: typeof raw.yFormat === 'string' ? raw.yFormat.slice(0, 512) : '',
    gapWidth: n(raw.gapWidth, 0, 500, 150),
    overlap: n(raw.overlap, -100, 100, 0),
    ...(Array.isArray(raw.valueLabels) ? { valueLabels: raw.valueLabels.slice(0, 60).map(l => ({ show: !!l?.show, style: style(l?.style),
      position: ['ctr', 'inBase', 'inEnd', 'outEnd', 't', 'b', 'l', 'r'].includes(l?.position) ? l.position : null,
      numberFormat: typeof l?.numberFormat === 'string' ? l.numberFormat.slice(0, 512) : '',
      hidden: (Array.isArray(l?.hidden) ? l.hidden : []).filter(i => Number.isInteger(i) && i >= 0 && i < 5000).slice(0, 5000),
      ...(Array.isArray(l?.points) ? { points: points(l.points).map(p => ({ index: p.index,
        ...(p.style && typeof p.style === 'object' ? { style: {
          ...(p.style.font ? { font: style(p.style).font } : {}),
          ...(Number.isFinite(p.style.size) ? { size: n(p.style.size, 6, 96, 16) } : {}),
          ...(color(p.style.color) ? { color: color(p.style.color) } : {}),
          ...Object.fromEntries(['bold', 'italic'].filter(key => typeof p.style[key] === 'boolean').map(key => [key, p.style[key]])),
        } } : {}),
        ...Object.fromEntries(['show', 'hidden'].filter(key => typeof p[key] === 'boolean').map(key => [key, p[key]])),
        ...(['ctr', 'inBase', 'inEnd', 'outEnd'].includes(p.position) ? { position: p.position } : {}),
        ...(typeof p.numberFormat === 'string' ? { numberFormat: p.numberFormat.slice(0, 512) } : {}),
      })) } : {}) })) } : {}),
    y2Min: n(raw.y2Min, -1e100, 1e100, null), y2Max: n(raw.y2Max, -1e100, 1e100, null), y2Step: n(raw.y2Step, .000001, 1e100, null),
    y2Style: style(raw.y2Style), y2Format: typeof raw.y2Format === 'string' ? raw.y2Format.slice(0, 512) : '',
    ...(mixedSeries ? {
      seriesTypes: raw.seriesTypes.slice(0, 60),
      ...(Array.isArray(raw.seriesGroups) && raw.seriesGroups.length === raw.seriesTypes.length ? {
        seriesGroups: raw.seriesGroups.slice(0, 60).map((g, i) => ({ id: Number.isInteger(g?.id) && g.id >= 0 && g.id < 60 ? g.id : i,
          grouping: ['standard', 'clustered', 'stacked', 'percentStacked'].includes(g?.grouping) ? g.grouping : 'standard' })),
      } : {}),
      dataLabels: (Array.isArray(raw.dataLabels) ? raw.dataLabels : []).slice(0, 60).map(l => ({
        style: style(l?.style), position: position(l?.position) || 'ctr',
        ...(typeof l?.showRange === 'boolean' ? { showRange: l.showRange } : {}),
        points: (Array.isArray(l?.points) ? l.points : []).slice(0, 5000)
          .filter(p => Number.isInteger(p?.index) && p.index >= 0 && p.index < 5000)
          .map(p => ({ index: p.index, position: position(p.position), hidden: !!p.hidden,
            ...(typeof p.showRange === 'boolean' ? { showRange: p.showRange } : {}), dx: n(p.dx, -1, 1, 0), dy: n(p.dy, -1, 1, 0) })),
      })),
    } : {}),
    lines: (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 60).map(chartLine),
  };
}

/** Keep imported chart sources following the same structural edits as cell formulas. */
export function mapChartReferences(chart, rewrite) {
  for (const key of ['tableRef', 'linkRef', 'textRef', 'pictureRef', 'titleRef', 'xTitleRef', 'yTitleRef', 'y2TitleRef']) if (chart[key]) {
    const ref = rewrite(chart[key]);
    if (ref !== chart[key]) chart = { ...chart, [key]: ref };
  }
  if (!chart.sourceRefs) return chart;
  let changed = false;
  const sourceRefs = chart.sourceRefs.map(s => {
    const next = { ...s };
    for (const key of ['nameRef', 'categories', 'values', 'sizes', 'labels']) if (s[key]) {
      next[key] = rewrite(s[key]);
      changed ||= next[key] !== s[key];
    }
    return next;
  });
  return changed ? { ...chart, sourceRefs } : chart;
}

/**
 * Where a point lies along one axis of a sheet: the row or column whose span holds the point `offset`
 * pixels past the start of line `from`, and the offset into it. The point is held within the sheet so
 * a box of `size` starting there ends inside it, as the grid clamps a dragged object, and hidden lines,
 * of no width, are passed over as the grid's own placing passes them. `sizeOf(i)` is a line's width or
 * height and `count` the sheet's lines; the walk starts at `from`, so a sheet of a million rows costs
 * only the lines between. This is the arithmetic that anchors a dragged object to the cell under its
 * corner, for every other way an object is placed.
 */
export function placeAlong(sizeOf, count, from, offset, size) {
  let i = Math.min(Math.max(0, from | 0), Math.max(0, count - 1));
  let off = offset;
  while (i < count - 1 && off >= sizeOf(i)) { off -= sizeOf(i); i++; }
  // The room from this line to the sheet's end, measured only as far as the box needs.
  let room = 0;
  for (let k = i; k < count && room < off + size; k++) room += sizeOf(k);
  if (room < off + size) off -= off + size - room;
  while (off < 0 && i > 0) { i--; off += sizeOf(i); }
  // Lines can be fractional (a 19.5 px default row), so the offset is kept as found: rounding it would
  // move the object off the position asked for, a little more with each placement. Export rounds to EMUs.
  return { index: i, offset: Math.max(0, off) };
}

/**
 * Equal-width bins for a histogram: `{ categories, counts }`. `bins` is the
 * wanted count, given exactly, over the data's range; null
 * picks a count by Sturges' rule and puts the bin edges on round numbers.
 * `style` is the number format of the cells counted, which labels the bin
 * edges: a priced column reads $5–$16.75 and a column of
 * dates reads dates rather than their serial numbers. The counts themselves
 * are plain numbers whatever the cells hold.
 */
export function histogramBins(values, bins = null, style = null) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return { categories: [], counts: [] };
  // A histogram can combine hundreds of thousands of cells across series.
  // Passing those values as arguments exceeds the engine's argument limit.
  let min = Infinity;
  let max = -Infinity;
  for (const value of nums) { min = Math.min(min, value); max = Math.max(max, value); }
  if (min === max) return { categories: [axisLabel(min, style)], counts: [nums.length] };
  if (bins) return equalBins(nums, min, max, bins, style);
  const k = Math.min(30, Math.max(3, Math.ceil(Math.log2(nums.length) + 1)));
  const { step } = niceScale(min, max, k);
  const start = Math.floor(min / step) * step;
  // A value on the top edge belongs to the last bin (so 10 goes in 5–10, not a bin of its own).
  const n = Math.max(1, Math.ceil((max - start) / step - 1e-9));
  // Finite data can still overflow its span or underflow the rounded step: then k equal bins between the endpoints.
  if (!Number.isFinite(n) || !Number.isFinite(start) || !Number.isFinite(start + n * step) || step <= 0) return equalBins(nums, min, max, k, style);
  const counts = new Array(n).fill(0);
  for (const v of nums) counts[Math.min(n - 1, Math.floor((v - start) / step + 1e-9))]++;
  const categories = counts.map((_, i) => `${axisLabel(start + i * step, style, step)}–${axisLabel(start + (i + 1) * step, style, step)}`);
  return { categories, counts };
}

/**
 * Exactly `k` bins of equal width from min to max. The edges are interpolated
 * between the endpoints (never min + i × width, which can overflow the span or
 * land off max) and a value on the top edge belongs to the last bin; edges that
 * round together, as subnormal values' do, merge. Each edge is labelled to one
 * decimal more than the width has, so 1–2.2 and 0.1–0.167 read as the bins they are.
 */
function equalBins(nums, min, max, k, style = null) {
  const edges = [min];
  for (let i = 1; i < k; i++) {
    const edge = min * (1 - i / k) + max * (i / k);
    if (edge > edges[edges.length - 1] && edge < max) edges.push(edge);
  }
  edges.push(max);
  const counts = new Array(edges.length - 1).fill(0);
  for (const value of nums) {
    let lo = 0;
    let hi = edges.length - 1;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (value >= edges[mid]) lo = mid;
      else hi = mid;
    }
    counts[lo]++;
  }
  const width = Number.isFinite(max - min) ? (max - min) / k : null;
  // Edges are labelled in the decimals the width and the first edge have, when those are few (a width
  // of 3.25 from -5 gives -1.75 and 4.75), else to one decimal more than the width's magnitude (0.1–0.167).
  let dec = null;
  if (width >= 1e-6) {
    const fine = Math.min(6, Math.max(0, -Math.floor(Math.log10(width) + 1e-9)) + 1);
    const exact = Math.max(exactDecimals(width, 6), exactDecimals(min, 6));
    dec = exact <= fine + 1 ? exact : fine;
  }
  const label = (edge) => {
    if (dec == null) return axisLabel(edge, style, width);
    // Each edge in the decimals it needs and no more: 0.1–0.167, not 0.10–0.167.
    const rounded = Math.round(edge * 10 ** dec) / 10 ** dec;
    return axisLabel(rounded, style, 10 ** -exactDecimals(rounded, dec));
  };
  return { categories: counts.map((_, i) => `${label(edges[i])}–${label(edges[i + 1])}`), counts };
}

/** Waterfall steps for a run of changes: each bar's from/to on the running total, then the total bar. */
export function waterfallSteps(values) {
  let total = 0;
  const steps = [];
  for (const v of values) {
    const d = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    steps.push({ from: total, to: total + d, delta: d, kind: d < 0 ? 'decrease' : 'increase' });
    total += d;
  }
  steps.push({ from: 0, to: total, delta: total, kind: 'total' });
  return steps;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Series paint overrides: hex colors or explicit no-fill, trailing gaps dropped; at most 50. */
function normalizeColors(list) {
  if (!Array.isArray(list)) return [];
  const out = list.slice(0, 50).map((c) => (typeof c === 'string' && (HEX_RE.test(c.trim()) || c.trim() === 'none') ? c.trim().toLowerCase() : null));
  while (out.length && out[out.length - 1] == null) out.pop();
  return out;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBlank = (v) => v == null || v === '';
// A cell beyond the sheet's used range, as chartData reads one: nothing lies there but blanks.
const BLANK = Object.freeze({ v: null, text: '', dateLike: false, dateKind: null, style: null });

function chartIncludesHidden(chart) {
  return !!chart.includeHidden || !!chart.pivotSource?.name;
}

/**
 * A treemap's or sunburst's range: its leading label columns are the levels, and the first numeric
 * column after them sizes each row. Null when the first column is not labels.
 */
function hierarchyFromCells(cells, body, hasHeaders, C) {
  const labelColumn = j => {
    const filled = body.map(row => row[j]).filter(x => !isBlank(x.v));
    return filled.length > 0 && filled.filter(x => !isNum(x.v) || x.dateLike).length >= filled.length / 2;
  };
  let levelCount = 0;
  while (levelCount < C - 1 && labelColumn(levelCount)) levelCount++;
  if (!levelCount) return null;
  let column = levelCount;
  while (column < C - 1 && !body.some(row => isNum(row[column].v))) column++;
  const values = body.map(row => (isNum(row[column].v) ? row[column].v : null));
  const header = hasHeaders ? cells[0][column] : null;
  const levels = fillDownLevels(body.map(row => row.slice(0, levelCount).map(x => (isBlank(x.v) ? '' : x.text))));
  return { levelCount, column, levels, categories: levels.map(path => path.at(-1) || ''),
    series: [{ name: header && !isBlank(header.v) ? header.text : 'Series 1', values, style: columnStyle(body, column), ...mixedPointStyles(body.map(row => row[column])) }] };
}

/**
 * Categories and series for a chart, read from its range.
 *
 * Returns { categories: string[], series: [{ name, values: (number|null)[], style }],
 *           x: (number|null)[] | null, sizes: (number|null)[] | null, hasHeaders, orientation,
 *           valueStyle, xStyle, sizeStyle }.
 * `x` is only set for scatter and bubble charts (the first numeric column);
 * `sizes` for bubble charts (the third). The styles are the number formats (a date,
 * currency or percent, or null) of a series' cells, of the values as a whole (the
 * first series with one, for the axis), of the x column and of the size column.
 * A treemap or sunburst also has `levels`: each row's path of labels, outermost first.
 */
export function chartData(wb, sheetId, chart) {
  const sheet = wb.sheet(sheetId);
  const empty = { categories: [], series: [], x: null, sizes: null, hasHeaders: false, orientation: 'cols', valueStyle: null, xStyle: null, sizeStyle: null };
  if (!sheet) return empty;
  if (chart.titleRef || chart.xTitleRef || chart.yTitleRef || chart.y2TitleRef) empty.titles = chartTitles(wb, sheetId, chart);
  if (chart.sourceRefs?.length) {
    if (HIERARCHY_TYPES.has(chart.type)) return referencedHierarchyData(wb, sheetId, chart, empty);
    const data = referencedChartData(wb, sheetId, chart, empty);
    return chart.pareto ? paretoChartData(data) : data;
  }
  const range = normalizeRange(chart.range);
  const r2 = Math.min(range.r2, sheet.rows - 1);
  const c2 = Math.min(range.c2, sheet.cols - 1);
  if (r2 < range.r1 || c2 < range.c1) return empty;
  // Cells as { v, text } so categories can show dates and formatted labels. Hidden and
  // filtered-out lines stay out of the picture by default, unless asked for.
  // A PivotChart plots the pivot report, not the worksheet's visible-cell subset.
  // Hiding report rows/columns is presentation; pivot item filters already change
  // the materialized report and its series references.
  const all = chartIncludesHidden(chart);
  // Nothing lies beyond the sheet's used range (its values, formulas and their spills) but blank cells,
  // which are filled in without a read: a chart over a range far larger than its data (the dialog admits
  // 5,000 × 200) costs the cells it has, not the million of the range, on each read the dialog makes.
  // Every row of the range is still a category.
  const used = wb.usedRange(sheetId);
  const readR2 = Math.min(r2, used?.r2 ?? -1);
  const readC2 = Math.min(c2, used?.c2 ?? -1);
  // A format applied to a whole column or row is kept on the line, not copied into every cell, so a
  // column formatted as currency gives its numbers that format wherever they were written. Sheets with
  // no such format — almost all of them — read the cell's own style as before, at no cost.
  const lineFormats = !!(wb.normalStyle || sheet.colStyles?.size || sheet.rowStyles?.size || sheet.styleResets?.length);
  const columns = [];
  for (let c = range.c1; c <= c2; c++) if (all || !sheet.hiddenCols.has(c)) columns.push(c);
  let cells = [];
  const rowLines = [];
  for (let r = range.r1; r <= r2; r++) {
    if (!all && wb.isRowHidden(sheetId, r)) continue;
    rowLines.push(r);
    const row = [];
    for (const c of columns) {
      if (r > readR2 || c > readC2) { row.push(BLANK); continue; }
      const v = wb.getValue(sheetId, r, c);
      const cell = wb.getCell(sheetId, r, c);
      // A spilled cell holds no style of its own: its anchor's number format shows it, under any the cell
      // carries, as the grid shows it. Without it a spilled column of dates would be plain numbers.
      const spill = !cell || (cell.v == null && cell.f == null) ? wb.spillAt(sheetId, r, c) : null;
      // The anchor's number format stands over line defaults, while a cell's own override wins.
      const style = spill ? { ...(lineFormats ? wb._lineStyle(sheet, r, c) : null), ...spill.style, ...cell?.s }
        : (lineFormats ? wb.styleAt(sheetId, r, c) : cell?.s) || null;
      // A custom code (m/d/yyyy, as dates arrive from files) makes a date as much as the presets do.
      const dateKind = dateTimeKind(style, isNum(v) ? v : 0);
      row.push({ v: isError(v) ? null : v, text: wb.getDisplay(sheetId, r, c, v), dateLike: !!dateKind, dateKind, style });
    }
    cells.push(row);
  }
  if (!cells.length || !cells[0].length) return empty;
  const rows = cells.length;
  const cols = cells[0].length;
  // Stock prices and a hierarchy's levels are columns by their nature, however few the rows.
  const fieldColumns = chart.type === 'stock' || HIERARCHY_TYPES.has(chart.type);
  const orientation = chart.seriesIn === 'rows' || chart.seriesIn === 'cols' ? chart.seriesIn : rows >= cols || fieldColumns ? 'cols' : 'rows';
  if (orientation === 'rows') cells = cells[0].map((_, j) => cells.map((row) => row[j]));
  const R = cells.length;
  const C = cells[0].length;

  // Headers: the first row is labels when its cells are text over numbers.
  let hasHeaders;
  if (chart.headers === true || chart.headers === false) hasHeaders = chart.headers;
  else {
    const first = cells[0];
    const labelish = first.every((x) => isBlank(x.v) || !isNum(x.v) || x.dateLike);
    const numbersBelow = R > 1 && first.some((x, j) => cells.slice(1).some((row) => isNum(row[j].v)));
    hasHeaders = R > 1 && labelish && numbersBelow;
  }
  const body = hasHeaders ? cells.slice(1) : cells;
  if (!body.length) return { ...empty, hasHeaders, orientation };

  const lineAt0 = orientation === 'rows' ? rowLines : columns, pointAt0 = orientation === 'rows' ? columns : rowLines;
  if (HIERARCHY_TYPES.has(chart.type) && C >= 2) {
    const hierarchy = hierarchyFromCells(cells, body, hasHeaders, C);
    if (hierarchy) {
      const { levelCount, column } = hierarchy;
      return { ...empty, categories: hierarchy.categories, series: hierarchy.series, levels: hierarchy.levels, hasHeaders, orientation,
        valueStyle: hierarchy.series[0]?.style || null,
        sourceLayout: { orientation, categoryLine: lineAt0[0], levelLines: lineAt0.slice(0, levelCount), nameLine: hasHeaders ? pointAt0[0] : null,
          points: pointAt0.slice(hasHeaders ? 1 : 0), xLine: null, sizeLine: null, lines: [lineAt0[column]] } };
    }
  }
  // A first column of text (or dates) names the categories.
  let categoryCol = false;
  if (C >= 2) {
    const firstCol = body.map((row) => row[0]);
    const filled = firstCol.filter((x) => !isBlank(x.v));
    const textish = filled.filter((x) => !isNum(x.v) || x.dateLike).length;
    categoryCol = filled.length > 0 && textish >= filled.length / 2;
    if (chart.type === 'scatter' || chart.type === 'bubble') categoryCol = false;
  }
  const categories = body.map((row, i) => (categoryCol ? row[0].text || `${i + 1}` : `${i + 1}`));
  const from = categoryCol ? 1 : 0;
  const series = [];
  // Where each part sits on the sheet (Select Data, Move Chart): the line (column or row) of each series,
  // of the categories and of the names, and the first and last point.
  const lineAt = orientation === 'rows' ? rowLines : columns, pointAt = orientation === 'rows' ? columns : rowLines;
  const keptLines = [];
  for (let j = from; j < C; j++) {
    const values = body.map((row) => (isNum(row[j].v) ? row[j].v : null));
    if (values.every((v) => v === null) && C - from > 1) continue;
    const header = hasHeaders ? cells[0][j] : null;
    const name = header && !isBlank(header.v) ? header.text : `Series ${series.length + 1}`;
    // Each series keeps its own cells' number format, so its tooltips read as the cells do.
    series.push({ name, values, style: columnStyle(body, j), ...mixedPointStyles(body.map(row => row[j])) });
    keptLines.push(lineAt[j]);
  }
  // A scatter chart's first kept series is its x values, whose format is that of its own axis; a bubble
  // chart's third sizes the points. Each style is the series' own, not the format of the column at its
  // position: a text column left out of the series (a Name column before When and Amount) would otherwise
  // put the dates' format on the value axis and none on the x axis.
  const hasX = (chart.type === 'scatter' || chart.type === 'bubble') && series.length >= 2;
  let x = null;
  let xStyle = null;
  let sizes = null;
  let sizeStyle = null, sizePointStyles;
  const source = { orientation, categoryLine: categoryCol ? lineAt[0] : null, nameLine: hasHeaders ? pointAt[0] : null,
    points: pointAt.slice(hasHeaders ? 1 : 0), xLine: null, sizeLine: null, lines: keptLines };
  if (hasX) { ({ values: x, style: xStyle } = series.shift()); source.xLine = keptLines.shift(); }
  if (chart.type === 'bubble' && series.length >= 2) {
    ({ values: sizes, style: sizeStyle, pointStyles: sizePointStyles } = series[1]);
    series.splice(1);
    source.sizeLine = keptLines[1]; keptLines.splice(1);
  }
  // The number format of the values (currency, percent, a date), from the first series with one, so axis and value labels can show it.
  const valueStyle = series.find((s) => s.style)?.style || null;
  return { ...empty, categories, series, x, sizes, hasHeaders, orientation, valueStyle, xStyle, sizeStyle, ...(sizePointStyles ? { sizePointStyles } : {}),
    sourceLayout: source,
    ...(chart.appearance?.xFormat ? { categoryValues: body.map((row, i) => categoryCol && !isBlank(row[0].v) ? row[0].v : i + 1) } : {}) };
}

/** ChartEx Pareto lines derive from their owning columns, not a separate cell cache. */
function paretoChartData(data) {
  const source = data.series[0];
  if (!source) return data;
  const totals = new Map(), categoryValues = new Map(), styles = new Map();
  source.values.forEach((value, i) => {
    if (Number.isFinite(value)) {
      if (!totals.has(data.categories[i])) categoryValues.set(data.categories[i], data.categoryValues?.[i]);
      if (!styles.has(data.categories[i])) styles.set(data.categories[i], chartPointStyle(source, i));
      else if (styleToNumFmt(styles.get(data.categories[i])) !== styleToNumFmt(chartPointStyle(source, i))) styles.set(data.categories[i], {});
      totals.set(data.categories[i], (totals.get(data.categories[i]) || 0) + value);
    }
  });
  const entries = [...totals].sort((a, b) => b[1] - a[1]);
  const categories = entries.map(([category]) => category), values = entries.map(([, value]) => value);
  const total = values.reduce((sum, value) => sum + value, 0);
  let running = 0;
  const cumulative = values.map(value => { running += value; return total ? running / total : null; });
  return { ...data, categories,
    ...(data.categoryValues ? { categoryValues: categories.map(category => categoryValues.get(category)) } : {}),
    series: [{ ...source, categories, values, ...(source.pointStyles ? { pointStyles: categories.map(category => styles.get(category)) } : {}) },
    { name: 'Cumulative percent', categories, values: cumulative, style: { fmt: 'percent', dec: 0 } }] };
}

/**
 * A treemap or sunburst whose source references were read from a file: its categories reference is
 * a block of label columns (or rows), one per level, and its values reference one column beside it.
 */
function referencedHierarchyData(wb, sheetId, chart, empty) {
  const source = chart.sourceRefs[0];
  const cats = source.categories && wb.rangeFromText(sheetId, source.categories);
  const vals = source.values && wb.rangeFromText(sheetId, source.values);
  const all = chartIncludesHidden(chart);
  const vertical = r => r.range.r2 - r.range.r1 >= r.range.c2 - r.range.c1;
  const literalValues = source.literal?.values || [];
  const count = vals ? Math.min(5000, vertical(vals) ? vals.range.r2 - vals.range.r1 + 1 : vals.range.c2 - vals.range.c1 + 1)
    : cats ? Math.min(5000, vertical(cats) ? cats.range.r2 - cats.range.r1 + 1 : cats.range.c2 - cats.range.c1 + 1) : literalValues.length;
  const cellAt = (ref, i, level = 0) => {
    const down = vertical(ref), r = down ? ref.range.r1 + i : ref.range.r1 + level, c = down ? ref.range.c1 + level : ref.range.c1 + i;
    const sheet = wb.sheet(ref.sheetId);
    const hidden = !all && (sheet.hiddenCols.has(c) || wb.isRowHidden(ref.sheetId, r));
    const v = wb.getValue(ref.sheetId, r, c);
    return { hidden, v: isError(v) ? null : v, text: wb.getDisplay(ref.sheetId, r, c, v), style: wb.styleAt(ref.sheetId, r, c) };
  };
  const levelCount = cats ? (vertical(cats) ? cats.range.c2 - cats.range.c1 + 1 : cats.range.r2 - cats.range.r1 + 1) : 1;
  const rows = [], values = [], styles = [];
  for (let i = 0; i < count; i++) {
    const value = vals ? cellAt(vals, i) : { v: literalValues[i] ?? null, hidden: false, style: null };
    const labels = cats ? Array.from({ length: Math.min(levelCount, 32) }, (_, k) => cellAt(cats, i, k)) : [{ v: source.literal?.categories?.[i] ?? '', text: String(source.literal?.categories?.[i] ?? ''), hidden: false }];
    if (value.hidden || labels.some(l => l.hidden)) continue;
    rows.push(labels.map(l => (isBlank(l.v) ? '' : l.text)));
    values.push(isNum(value.v) ? value.v : null);
    styles.push(value.style);
  }
  const levels = fillDownLevels(rows);
  const nameCell = source.nameRef && wb.rangeFromText(sheetId, source.nameRef);
  const name = linkedChartText(wb, sheetId, chart, 'name:0', source.nameRef, nameCell ? wb.getDisplay(nameCell.sheetId, nameCell.range.r1, nameCell.range.c1) : undefined)
    || source.name || 'Series1';
  const style = source.valueFormat ? numFmtToStyle(source.valueFormat) : styles.find((st, i) => st && isNum(values[i])) || null;
  return { ...empty, categories: levels.map(path => path.at(-1) || ''), levels, series: [{ name, values, style }], valueStyle: style };
}

function referencedChartData(wb, sheetId, chart, empty, sourceFormats = null) {
  const cache = new Map();
  const read = ref => {
    if (cache.has(ref)) return cache.get(ref);
    const resolved = ref && wb.rangeFromText(sheetId, ref);
    if (!resolved) {
      // Charts can plot unions and named formula vectors without a single range.
      // Read them live; never substitute a saved chart cache.
      let values = [];
      try {
        const ast = parseFormula(ref || '');
        if (ast.type === 'union') {
          // Charts in workbook files can concatenate separated cells/ranges. Read each area
          // through the same bounded path so formats and hidden rows still apply.
          const areas = [];
          const collect = node => {
            if (node.type === 'union') return node.parts.every(collect);
            if (node.type !== 'ref' || node.ref.sheetEnd) return false;
            areas.push(refToText(node.ref));
            return true;
          };
          if (collect(ast)) for (const area of areas) {
            values.push(...read(area).slice(0, 5000 - values.length));
            if (values.length >= 5000) break;
          }
        } else if (ast.type === 'call' && ast.bare && wb.namedEntry(ast.name, ast.sheet || wb.sheet(sheetId).name)) {
          const value = withArrayBudget(() => evaluate(ast, wb.contextFor(sheetId, 0, 0)));
          const rows = isRange(value) ? value.values : [[value]];
          if (rows.length === 1 || rows.every(row => row.length === 1)) values = rows.slice(0, 5000).flat().slice(0, 5000)
            .map(v => ({ v: isError(v) ? null : v, text: isError(v) ? '' : formatValue(v), hidden: false, style: null }));
        }
      } catch { /* Missing or invalid names leave a gap in the chart. */ }
      cache.set(ref, values);
      return values;
    }
    const { range, sheetId: id } = resolved, sheet = wb.sheet(id);
    // Chart series are vectors. Bound reads even for full-column or malformed file references.
    if (range.r1 !== range.r2 && range.c1 !== range.c2) return [];
    const horizontal = range.r1 === range.r2, start = horizontal ? range.c1 : range.r1;
    const end = Math.min(horizontal ? range.c2 : range.r2, start + 4999);
    const values = [];
    const external = sheet.externalCache && externalWorkbookScope(wb.externalWorkbooks, sheet.name);
    const source = external && typeof external.book.target === 'string' ? [external.book.target, external.sheet?.name] : null;
    for (let i = start; i <= end; i++) {
      const r = horizontal ? range.r1 : i, c = horizontal ? i : range.c1;
      const hidden = !chartIncludesHidden(chart) && (sheet.hiddenCols.has(c) || wb.isRowHidden(id, r));
      const v = hidden ? null : wb.getValue(id, r, c);
      values.push({ v: isError(v) ? null : v, hidden, text: hidden ? '' : wb.getDisplay(id, r, c, v), style: wb.styleAt(id, r, c), externalCache: !!sheet.externalCache,
        ...(source ? { displaySource: JSON.stringify([...source, r, c]) } : {}) });
    }
    cache.set(ref, values);
    return values;
  };
  const refs = chart.sourceRefs.slice(0, 60);
  const circular = chart.type === 'pie' || chart.type === 'donut';
  const layered = chart.type === 'combo' && chart.appearance?.seriesTypes?.length === refs.length;
  // numLit/strLit are the chart's data, not cached copies of a worksheet range.
  // A broken reference must never fall back to saved values.
  const vector = (s, key) => {
    const styleAt = i => {
      const prefix = { categories: 'category', values: 'value', sizes: 'size', labels: 'label' }[key];
      const code = s[`${prefix}PointFormats`]?.[i] || s[`${prefix}Format`];
      return code ? numFmtToStyle(code) : null;
    };
    if (s[key]) return read(s[key]).map((cell, i) => {
      const style = styleAt(i);
      const saved = (key === 'categories' ? s.categoryDisplayCache : key === 'labels' ? s.labelDisplayCache : null)?.[i];
      // String caches carry rendered labels, not a number format. Use them only
      // for the same numeric supporting cell/value when its format is unavailable.
      if (cell.externalCache && !cell.hidden && (!style || styleToNumFmt(style) === 'General')
        && saved && saved.value === cell.v && saved.source === cell.displaySource) return { ...cell, text: saved.text };
      return cell.externalCache && style && typeof cell.v === 'number'
        ? { ...cell, style, text: cell.hidden ? '' : formatValue(cell.v, style) } : cell;
    });
    return (s.literal?.[key] || []).map((v, i) => {
      const style = styleAt(i);
      return { v, text: v == null ? '' : typeof v === 'number' && style ? formatValue(v, style) : String(v), hidden: false, style };
    });
  };
  const bubble = chart.type === 'bubble';
  const categoryColumns = refs.map(s => vector(s, 'categories')), categories = categoryColumns[0], columns = refs.map(s => vector(s, 'values'));
  const sizeColumns = bubble ? refs.map(s => vector(s, 'sizes')) : [];
  const labelColumns = layered ? refs.map(s => vector(s, 'labels')) : [];
  // Workbook templates often reserve many blank rows after the actual dates and values.
  let length = Math.max(...categoryColumns.map(c => c.length), ...columns.map(c => c.length));
  // A layered chart uses its whole category span as coordinates, including blank end points.
  // A pie legend has an entry for each source point, including trailing blank
  // points. Trimming them changes both its labels and point-style indices.
  while (!circular && (!layered || chart.appearance.seriesGroups) && length && ![...categoryColumns, ...columns].some(c => c[length - 1]?.v != null && c[length - 1]?.v !== '')) length--;
  const categoryText = (column, i) => circular && column.length ? column[i]?.text || '' : column[i]?.text || String(i + 1);
  const indices = Array.from({ length }, (_, i) => i).filter(i => layered || bubble || (!categories[i]?.hidden && !columns.every(c => c[i]?.hidden)));
  // Native unnamed series use an automatic display label. Keep it out of the
  // source model so export does not turn a generated label into an explicit name.
  const series = refs.map((s, j) => ({ name: chart.pivotSource && typeof s.pivotName === 'string' ? s.pivotName
    : linkedChartText(wb, sheetId, chart, `name:${j}`, s.nameRef, read(s.nameRef)[0]?.text) || s.name || `Series${j + 1}`,
    values: indices.map(i => !categoryColumns[j][i]?.hidden && isNum(columns[j][i]?.v) ? columns[j][i].v : null),
    ...(layered ? { x: indices.map(i => (chart.appearance.seriesTypes[j] === 'scatter' ? s.categoryMode === 'ordinal' : !chart.appearance.dateAxis)
      ? i + 1 : isNum(categoryColumns[j][i]?.v) ? categoryColumns[j][i].v : null),
      labels: indices.map(i => labelColumns[j][i]?.text || '') } : chart.type === 'scatter' || bubble || chart.appearance?.dateAxis
      ? { x: indices.map(i => chart.type === 'scatter' && s.categoryMode === 'ordinal' ? i + 1 : isNum(categoryColumns[j][i]?.v) ? categoryColumns[j][i].v : null) } : {}),
    categories: indices.map(i => categoryText(categoryColumns[j], i)),
    ...((s.categoryFormat || s.categoryPointFormats) ? { categoryValues: indices.map(i => categoryColumns[j][i]?.v ?? null),
      ...(s.categoryPointFormats ? { categoryPointFormats: indices.map(i => isNum(categoryColumns[j][i]?.v)
        ? styleToNumFmt(categoryColumns[j][i].style || {}) : s.categoryPointFormats[i] || null) } : {}) } : {}),
    style: s.valueFormat ? numFmtToStyle(s.valueFormat) : columns[j].find(c => isNum(c.v))?.style || null,
    ...mixedPointStyles(indices.map(i => columns[j][i]), 'pointStyles', !!s.valuePointFormats),
    ...(bubble ? { sizes: indices.map(i => isNum(sizeColumns[j][i]?.v) ? sizeColumns[j][i].v : null),
      sizeStyle: s.sizeFormat ? numFmtToStyle(s.sizeFormat) : sizeColumns[j].find(c => isNum(c.v))?.style || null,
      ...mixedPointStyles(indices.map(i => sizeColumns[j][i]), 'sizePointStyles', !!s.sizePointFormats) } : {}),
  }));
  if (sourceFormats) {
    const categoryFormat = column => {
      const formats = new Set(column.filter(cell => isNum(cell.v)).map(cell => styleToNumFmt(cell.style || {})));
      return formats.size === 1 ? [...formats][0] : null;
    };
    refs.forEach((source, i) => sourceFormats.push({
      categoryCells: categoryColumns[i],
      labelCells: labelColumns[i],
      labelFormat: layered ? categoryFormat(labelColumns[i]) || source.labelFormat : null,
      labelPointFormats: layered && categoryFormat(labelColumns[i]) == null
        ? labelColumns[i].map(cell => isNum(cell.v) ? styleToNumFmt(cell.style || {}) : null) : null,
      categoryFormat: categoryFormat(categoryColumns[i]) || source.categoryFormat,
      categoryPointFormats: categoryFormat(categoryColumns[i]) == null
        ? categoryColumns[i].map(cell => isNum(cell.v) ? styleToNumFmt(cell.style || {}) : null) : null,
      valuePointFormats: mixedPointStyles(columns[i], 'pointStyles', !!source.valuePointFormats).pointStyles?.map(style => style ? styleToNumFmt(style) : null),
      sizePointFormats: bubble ? mixedPointStyles(sizeColumns[i], 'pointStyles', !!source.sizePointFormats).pointStyles?.map(style => style ? styleToNumFmt(style) : null) : null,
      valueFormat: (series[i].style ? styleToNumFmt(series[i].style) : null) || source.valueFormat,
      sizeFormat: (series[i].sizeStyle ? styleToNumFmt(series[i].sizeStyle) : null) || source.sizeFormat,
    }));
  }
  const xStyle = refs[0].categoryFormat ? numFmtToStyle(refs[0].categoryFormat) : categories.find(c => isNum(c.v))?.style || null;
  return { ...empty, categories: indices.map(i => categoryText(categories, i)), series,
    ...(chart.appearance?.xFormat ? { categoryValues: indices.map(i => !isBlank(categories[i]?.v) ? categories[i].v : i + 1) } : {}),
    x: chart.type === 'scatter' || bubble ? series[0]?.x || [] : chart.appearance?.dateAxis ? indices.map(i => isNum(categories[i]?.v) ? categories[i].v : null) : null,
    ...(bubble ? { sizes: series[0]?.sizes || [], sizeStyle: series[0]?.sizeStyle || null,
      ...(series[0]?.sizePointStyles ? { sizePointStyles: series[0].sizePointStyles } : {}) } : {}),
    xStyle, valueStyle: series[0]?.style || null };
}

/** Bind freshly imported native display strings once, never when loading JSON or
 * rendering. A later source/value change invalidates a label rather than freezing
 * a live numeric reference or guessing its absent number-format code. */
export function bindImportedChartCategoryText(wb, sheetId, chart, texts, prefix = 'category') {
  if (!wb.externalWorkbooks?.books.length || !chart.sourceRefs?.length || !texts.some(Array.isArray)) return;
  const resolved = [];
  referencedChartData(wb, sheetId, chart, {}, resolved);
  chart.sourceRefs.forEach((source, j) => {
    if (!Array.isArray(texts[j])) return;
    const points = resolved[j]?.[`${prefix}Cells`]?.map((cell, i) => cell.externalCache && cell.displaySource
      && Number.isFinite(cell.v) && typeof texts[j][i] === 'string'
      ? { source: cell.displaySource, value: cell.v, text: texts[j][i] } : null) || [];
    if (points.some(Boolean)) source[`${prefix}DisplayCache`] = points;
  });
}

/** Source-cell formatting is not part of native external workbook caches.
 * Retain the chart's numeric formats when a sheet copy moves a vector there,
 * while keeping both the source references and their values live. */
export function preserveCopiedChartFormats(wb, sheetId, original, copied, sourceWorkbook = null) {
  if (!original.sourceRefs?.length || !copied.sourceRefs?.length) return copied;
  let changed = false, formats = null;
  const sourceRefs = copied.sourceRefs.map((source, i) => {
    const before = original.sourceRefs[i];
    if (!before) return source;
    const fields = [['categories','categoryFormat'], ['values','valueFormat'], ['sizes','sizeFormat'], ['labels','labelFormat']]
      .filter(([key, format]) => before[key] && before[key] !== source[key]);
    const displayKeys = ['category', 'label'].filter(prefix => sourceWorkbook && source[`${prefix}DisplayCache`]);
    const rebaseDisplay = displayKeys.length > 0;
    if (!fields.length && !rebaseDisplay) return source;
    // Resolve all vectors once through the same reader used by rendering.
    // Numeric caches can retain a different formatCode on each point.
    if (!formats) { formats = []; referencedChartData(wb, sheetId, original, {}, formats); }
    let next = source;
    for (const prefix of displayKeys) {
      const displayKey = `${prefix}DisplayCache`;
      const points = source[displayKey].map((saved, j) => {
        const cell = formats[i]?.[`${prefix}Cells`]?.[j];
        if (!saved || saved.value !== cell?.v || saved.source !== cell?.displaySource) return saved;
        const identity = JSON.parse(cell.displaySource);
        identity[0] = rebaseWorkbookTarget(identity[0], sourceWorkbook);
        const target = JSON.stringify(identity);
        return target === saved.source ? saved : { ...saved, source: target };
      });
      if (points.some((point, j) => point !== source[displayKey][j])) {
        next = { ...next, [displayKey]: points }; changed = true;
      }
    }
    for (const [, format] of fields) {
      const code = formats[i]?.[format];
      {
        if (next === source) next = { ...source };
        const pointKey = format.replace('Format', 'PointFormats');
        const points = formats[i]?.[pointKey];
        if (points?.some(Boolean)) next[pointKey] = points; else delete next[pointKey];
        changed = true;
      }
      if (code) { if (next === source) next = { ...source }; next[format] = code; changed = true; }
    }
    return next;
  });
  return changed ? { ...copied, sourceRefs } : copied;
}

/** Freeze the resolved chart vectors before their source report is removed.
 * These are native literal series, not a raster image or stale cache fallback. */
export function snapshotChartData(wb, sheetId, chart) {
  const data = chartData(wb, sheetId, { ...chart, pareto: false });
  const next = { ...chart, ...data.titles, sourceRefs: data.series.map((series, i) => {
    const source = chart.sourceRefs?.[i] || {};
    const numeric = chart.type === 'scatter' || chart.type === 'bubble' || chart.appearance?.dateAxis
      || chart.type === 'combo' && chart.appearance?.seriesTypes?.[i] === 'scatter';
    const sizes = series.sizes || (chart.type === 'bubble' ? data.sizes : null);
    const sizeStyles = series.sizePointStyles || (chart.type === 'bubble' ? data.sizePointStyles : null);
    return { name: series.name,
      categoryFormat: source.categoryFormat || (numeric && data.xStyle ? styleToNumFmt(data.xStyle) : undefined),
      valueFormat: (series.style ? styleToNumFmt(series.style) : undefined) || source.valueFormat,
      ...(series.pointStyles ? { valuePointFormats: series.pointStyles.map(style => style ? styleToNumFmt(style) : null) } : {}),
      ...(sizeStyles ? { sizePointFormats: sizeStyles.map(style => style ? styleToNumFmt(style) : null) } : {}),
      sizeFormat: series.sizeStyle || data.sizeStyle ? styleToNumFmt(series.sizeStyle || data.sizeStyle) : source.sizeFormat,
      literal: { categories: [...(numeric ? series.x || data.x || [] : series.categories || data.categories)],
        values: [...series.values], ...(sizes ? { sizes: [...sizes] } : {}) } };
  }) };
  for (const key of ['title', 'xTitle', 'yTitle', 'y2Title']) delete next[`${key}Ref`];
  return next;
}

/** Per-point styles are needed only when numeric cells have different formats.
 * General is an explicit empty style here, so it cannot inherit a neighbour's units. */
function mixedPointStyles(cells, key = 'pointStyles', force = false) {
  const codes = new Set(cells.filter(cell => isNum(cell?.v)).map(cell => styleToNumFmt(cell.style || {})));
  return force || codes.size > 1 ? { [key]: cells.map(cell => isNum(cell?.v) ? cell.style || {} : null) } : {};
}

export function chartPointStyle(series, index, fallback = null, key = 'pointStyles') {
  const shared = key === 'sizePointStyles' ? series.sizeStyle : series.style;
  return series[key]?.[index] ?? (shared === undefined ? fallback : shared);
}

/** The first explicit numeric format in column `j` of the body, or null. */
function columnStyle(body, j) {
  for (const row of body) {
    const cell = row[j];
    if (!isNum(cell.v)) continue;
    const fmt = cell.style?.fmt;
    if (cell.dateLike) return { fmt, code: cell.style.code, dateStyle: cell.style.dateStyle || null, sec: !!cell.style.sec, dateKind: cell.dateKind };
    if (fmt === 'currency' || fmt === 'percent') return { fmt, cur: cell.style.cur || null, dec: cell.style.dec ?? null };
    if (fmt === 'custom') return { fmt, code: cell.style.code };
  }
  return null;
}

/** Round axis bounds and a step to "nice" numbers (1, 2, 5 × 10^n). */
export function niceScale(min, max, ticks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25 };
  if (max < min) [min, max] = [max, min];
  if (min === max) { if (min === 0) { max = 1; } else if (min > 0) { min = 0; } else { max = 0; } }
  // Bounds near the limits of a double: halve before subtracting so the span stays finite,
  // and keep the step's magnitude above zero so subnormal spans do not divide by it.
  const rough = Number.isFinite(max - min) ? (max - min) / Math.max(1, ticks) : (max / 2 - min / 2) / Math.max(1, ticks) * 2;
  const mag = Math.max(Number.MIN_VALUE, 10 ** Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  // Sums carry floating-point noise (0.1 + 0.2, shares of a 100% stack adding to 100.00000000000001):
  // a bound a hair past a step must not open a whole extra step, so snap within a relative epsilon.
  const EPS = 1e-9;
  const step = (norm <= 1 + EPS ? 1 : norm <= 2 + EPS ? 2 : norm <= 5 + EPS ? 5 : 10) * mag;
  const lo = Math.max(-Number.MAX_VALUE, Math.floor(min / step + EPS) * step);
  const hi = Math.min(Number.MAX_VALUE, Math.ceil(max / step - EPS) * step);
  return { min: lo, max: hi === lo ? lo + step : hi, step };
}

/**
 * Axis label for a value: short, with compact thousands and millions, in the
 * data's number format when it is currency or percent ($1.5K, 12%).
 */
/** The decimals (up to `most`) that write `n` exactly, ignoring floating-point noise. */
function exactDecimals(n, most) {
  for (let d = 0; d < most; d++) if (Math.abs(Math.round(n * 10 ** d) / 10 ** d - n) <= 1e-9 * Math.max(1, Math.abs(n))) return d;
  return most;
}

export const DATE_FORMATS = new Set(['date', 'datetime', 'time']);

/** 'date', 'time' or 'datetime' when a value style (a chart's, or a cell's) reads its numbers as such, else null. */
export function dateKindOf(style) {
  if (DATE_FORMATS.has(style?.fmt)) return style.fmt;
  return style?.fmt === 'custom' ? style.dateKind ?? dateTimeKind(style) : null;
}

export function axisLabel(v, style = null, step = null) {
  if (!Number.isFinite(v)) return '';
  // Dates and times read as such, not as compact serial numbers, in the cells' own code.
  if (dateKindOf(style)) return formatValue(v, style.fmt === 'custom' ? { fmt: 'custom', code: style.code } : { fmt: style.fmt, dateStyle: style.dateStyle || undefined, sec: !!style.sec });
  // Ticks a step apart need as many decimals as the step has, or neighbours read the same;
  // a tick off the step's grid (from a fixed axis bound) needs as many as its own value has,
  // or its label names a value it does not sit at.
  const stepDec = step > 0 && Number.isFinite(step) ? Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9))) : null;
  // Below a millionth six decimals run out and every tick would read 0.000000: the exponent form names
  // each tick, as it does past what trillions can say, with the decimals that set it apart from its step.
  const scale = style?.fmt === 'percent' ? 100 : 1;
  const shown = v * scale;
  const tinyStep = stepDec != null && step * scale < 1e-6;
  if (tinyStep || (shown !== 0 && Math.abs(shown) < 1e-6)) {
    if (shown === 0) return scale === 100 ? '0%' : formatValue(0, style?.fmt === 'currency' ? { fmt: 'currency', cur: style.cur || 'USD', dec: 0 } : { fmt: 'number', dec: 0 });
    const power = (n) => Math.floor(Math.log10(Math.abs(n)) + 1e-9);
    const dec = tinyStep ? Math.min(4, Math.max(0, power(shown) - power(step * scale))) : 2;
    return `${formatValue(shown, { fmt: 'scientific', dec }).replace(/(\.\d*?)0+E/, '$1E').replace(/\.E/, 'E')}${scale === 100 ? '%' : ''}`;
  }
  if (style?.fmt === 'percent') {
    const pct = v * 100;
    const dec = stepDec != null ? Math.max(0, stepDec - 2, exactDecimals(pct, 4)) : Number.isInteger(Math.round(pct * 100) / 100) ? 0 : 1;
    return formatValue(v, { fmt: 'percent', dec });
  }
  const money = style?.fmt === 'currency';
  const show = (n, dec) => formatValue(n, money ? { fmt: 'currency', cur: style.cur || 'USD', dec } : { fmt: 'number', dec });
  const abs = Math.abs(v);
  // Past what trillions can say in a few digits, the exponent form is shorter than a row of commas.
  if (abs >= 1e15) return formatValue(v, { fmt: 'scientific', dec: 1 }).replace(/\.0E/, 'E');
  // Compact thousands, millions, billions and trillions, each rolling over on the rounded figure of
  // the unit below, so 999,999 reads 1M rather than 1,000K and 999,999,999 reads 1B rather than 1,000M.
  const inUnit = (unit) => Math.round(v / (unit / 10)) / 10;
  const compact = (n, suffix) => `${show(n, 1).replace(/\.0(?=\D*$)/, '')}${suffix}`;
  const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M']];
  for (const [i, [unit, suffix]] of UNITS.entries()) {
    const below = UNITS[i + 1]?.[0] ?? 1e3;
    if (abs >= unit || Math.abs(inUnit(below)) >= 1000) return compact(inUnit(unit), suffix);
  }
  if (abs >= 1e4) return compact(inUnit(1e3), 'K');
  const dec = stepDec != null ? Math.max(stepDec, exactDecimals(v, 6)) : abs >= 100 || Number.isInteger(v) ? 0 : abs >= 1 ? 1 : 2;
  return show(Math.round(v * 10 ** dec) / 10 ** dec, dec);
}
