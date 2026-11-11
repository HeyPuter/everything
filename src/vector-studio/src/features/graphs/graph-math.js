/**
 * Graph data and layout, independent of the document.
 *
 * Data is a grid of cell strings (as typed in the Graph Data window).
 * When the top-left cell is empty, the first row holds series names (the
 * legend) and the first column category labels; otherwise a row or column
 * of text is taken as labels. Text in quotes ("2026") is always a label.
 *
 * Scatter graphs read columns in pairs: y values, then x values, with the
 * series name above the y column.
 *
 * layoutGraph() turns data and options into a scene in the graph's own
 * frame (0, 0)-(w, h), the plot area: marks per series, axis lines, ticks,
 * gridlines, text labels and the legend, which the live renderer maps
 * into the document.
 */

export const GRAPH_TYPES = ['column', 'stacked-column', 'bar', 'stacked-bar', 'line', 'area', 'scatter', 'pie', 'radar'];

export const TYPE_LABELS = {
  column: 'Grouped Column',
  'stacked-column': 'Stacked Column',
  bar: 'Bar',
  'stacked-bar': 'Stacked Bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
  radar: 'Radar',
};

/** Series colors for new graphs (editable per series afterwards). */
export const SERIES_PALETTE = ['#2f5fb3', '#e07a2e', '#3c9a5f', '#c8445f', '#7a5cc4', '#2aa5b5', '#c49a1c', '#6b7685', '#a8c8f0', '#f2b98a'];

export const DEFAULT_OPTIONS = Object.freeze({
  valueAxis: 'left', // left | right | both (bottom | top | both for bar graphs)
  shadow: false,
  legendTop: false,
  firstRowFront: true,
  firstColumnFront: true,
  columnWidth: 90, // percent of the room per column
  clusterWidth: 80, // percent of the room per category
  markPoints: true,
  connectPoints: true,
  edgeToEdge: false,
  filledLines: false,
  lineWidth: 3,
  markerSize: 6,
  pieLegend: 'standard', // standard | wedges | none
  pieSort: 'none', // none | all | first
  piePosition: 'ratio', // ratio | even | stacked
  fontSize: 9,
  value: Object.freeze({ manual: false, min: 0, max: 100, divisions: 5, tickLength: 'short', tickCount: 1, prefix: '', suffix: '' }),
  category: Object.freeze({ tickLength: 'short', tickCount: 1, between: true }),
  series: Object.freeze({}),
});

/** Options with defaults filled in. */
export function graphOptions(o = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...o,
    value: { ...DEFAULT_OPTIONS.value, ...(o.value || {}) },
    category: { ...DEFAULT_OPTIONS.category, ...(o.category || {}) },
    series: { ...(o.series || {}) },
  };
}

/** Starter data for a new graph of a type. */
export function sampleData(type) {
  if (type === 'pie') return [['', 'North', 'South', 'East', 'West'], ['', '4', '3', '2', '1.5']];
  if (type === 'scatter') return [['Series 1', ''], ['2', '1'], ['3.5', '2'], ['3', '3'], ['5', '4']];
  return [['', 'Series 1', 'Series 2'], ['Q1', '3', '2'], ['Q2', '5', '4'], ['Q3', '4', '6'], ['Q4', '6', '5']];
}

const QUOTED = /^\s*"(.*)"\s*$/;

/** Number in a cell, or null for empty/text cells. */
export function cellNumber(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || QUOTED.test(t)) return null;
  const v = Number(t.replace(/,(?=\d{3}\b)/g, ''));
  return Number.isFinite(v) ? v : null;
}

/** Text of a label cell (quotes removed). */
export function cellLabel(s) {
  const t = String(s ?? '').trim();
  const q = QUOTED.exec(t);
  return q ? q[1] : t;
}

const isText = (s) => {
  const t = String(s ?? '').trim();
  return Boolean(t) && cellNumber(t) === null;
};

/** Trim trailing empty rows and columns. */
export function trimCells(cells) {
  const rows = cells.map((r) => (r || []).map((c) => (c == null ? '' : String(c))));
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
  let width = 0;
  for (const r of rows) for (let j = r.length - 1; j >= 0; j--) if (r[j].trim()) {
    width = Math.max(width, j + 1);
    break;
  }
  return rows.map((r) => Array.from({ length: width }, (_, j) => r[j] ?? ''));
}

const MAX_VALUE = 1e300;

/**
 * Parse cells: { categories: [label], series: [{ name, values: [number|null], xs? }] }.
 * For scatter, each series also has `xs`.
 */
export function parseGraphData(cellsIn, type = 'column') {
  const cells = trimCells(cellsIn || []);
  if (!cells.length) return { categories: [], series: [], headerRow: false, headerCol: false };
  const corner = String(cells[0][0] ?? '').trim();
  const width = cells[0].length;
  let headerRow;
  let headerCol;
  if (type === 'scatter') {
    // Scatter data has no category column: a row of text on top names the series.
    headerRow = cells[0].some(isText);
    headerCol = false;
  } else if (!corner) {
    headerRow = cells[0].slice(1).some((c) => String(c).trim());
    headerCol = true;
  } else {
    headerRow = cells[0].slice(1).some(isText);
    headerCol = cells.slice(headerRow ? 1 : 0).some((r) => isText(r[0]));
  }
  const body = cells.slice(headerRow ? 1 : 0);
  const c0 = headerCol ? 1 : 0;
  // Values so large that sums and ranges overflow (1e308 - -1e308) are graphed at the largest size that does not.
  const value = (s) => {
    const v = cellNumber(s);
    return v === null ? null : Math.max(-MAX_VALUE, Math.min(MAX_VALUE, v));
  };
  if (type === 'scatter') {
    const series = [];
    for (let j = c0; j < width; j += 2) {
      const ys = body.map((r) => value(r[j]));
      const xs = body.map((r) => value(r[j + 1]));
      series.push({ name: headerRow ? cellLabel(cells[0][j]) : '', values: ys, xs });
    }
    return { categories: [], series, headerRow, headerCol };
  }
  const categories = body.map((r) => (headerCol ? cellLabel(r[0]) : ''));
  const series = [];
  for (let j = c0; j < width; j++) series.push({ name: headerRow ? cellLabel(cells[0][j]) : '', values: body.map((r) => value(r[j])) });
  return { categories, series, headerRow, headerCol };
}

/**
 * What a graph leaves out of its data, for telling the user: { text } cells in
 * the value area that are not numbers, and { negative } values of a pie graph
 * (pies show positive values only).
 */
export function dataNotes(cellsIn, type = 'column') {
  const cells = trimCells(cellsIn || []);
  const d = parseGraphData(cells, type);
  let text = 0;
  for (const r of cells.slice(d.headerRow ? 1 : 0)) {
    for (let j = d.headerCol ? 1 : 0; j < r.length; j++) if (isText(r[j])) text++;
  }
  const negative = type === 'pie' ? d.series.reduce((n, s) => n + s.values.filter((v) => v < 0).length, 0) : 0;
  return { text, negative };
}

/** A sentence about what dataNotes() found, or ''. */
export function dataNotesText({ text, negative }) {
  const parts = [];
  if (text) parts.push(`${text} cell${text === 1 ? ' is' : 's are'} not a number`);
  if (negative) parts.push(`${negative} negative value${negative === 1 ? '' : 's'} (pie graphs show positive values only)`);
  return parts.length ? `Left out: ${parts.join('; ')}.` : '';
}

/** Swap rows and columns. */
export function transposeCells(cells) {
  const t = trimCells(cells);
  const w = t.length ? t[0].length : 0;
  return Array.from({ length: w }, (_, j) => t.map((r) => r[j] ?? ''));
}

/** Scatter: swap each y column with its x column (series names stay on the first). */
export function switchXY(cells) {
  const t = trimCells(cells);
  if (!t.length) return t;
  const headerRow = t[0].some(isText);
  const out = t.map((r) => r.slice());
  for (let i = headerRow ? 1 : 0; i < out.length; i++) {
    for (let j = 0; j + 1 < out[i].length; j += 2) [out[i][j], out[i][j + 1]] = [out[i][j + 1], out[i][j]];
  }
  return out;
}

/**
 * Parse CSV or TSV text (quoted fields, doubled quotes, CRLF). The
 * delimiter is detected from the first line unless given.
 */
export function parseDelimited(text, delimiter = null) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const d = delimiter || (firstLine.includes('\t') ? '\t' : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !field) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === d) {
      row.push(keep(field, wasQuoted));
      field = '';
      wasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(keep(field, wasQuoted));
      rows.push(row);
      row = [];
      field = '';
      wasQuoted = false;
    } else field += ch;
  }
  if (field || row.length || wasQuoted) {
    row.push(keep(field, wasQuoted));
    rows.push(row);
  }
  return trimCells(rows);
}

// A quoted number stays a label, as when typed with quotes.
function keep(field, wasQuoted) {
  return wasQuoted && cellNumber(field) !== null ? `"${field}"` : field;
}

/** Cells as tab-separated text (for copying out of the grid). */
export function toDelimited(cells, delimiter = '\t') {
  return trimCells(cells)
    .map((r) => r.map((c) => (delimiter !== '\t' && /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(delimiter))
    .join('\n');
}

// ---- scales and labels ----

/** A readable axis scale covering [lo, hi] with about `divs` divisions: { min, max, step, divisions }. */
export function niceScale(lo, hi, divs = 5, includeZero = true) {
  let a = Math.min(lo, hi);
  let b = Math.max(lo, hi);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    a = 0;
    b = 1;
  }
  if (includeZero) {
    a = Math.min(a, 0);
    b = Math.max(b, 0);
  }
  if (b - a < 1e-12) {
    if (Math.abs(b) < 1e-12) b = 1;
    else if (b > 0) a = includeZero ? 0 : b - Math.abs(b) / 2;
    else b = includeZero ? 0 : a + Math.abs(a) / 2;
    if (b - a < 1e-12) b = a + 1;
  }
  const raw = (b - a) / Math.max(1, divs);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const min = Math.floor(a / step + 1e-9) * step;
  const max = Math.ceil(b / step - 1e-9) * step;
  return { min: clean(min), max: clean(max), step: clean(step), divisions: Math.max(1, Math.round((max - min) / step)) };
}

// Round off float noise; values this large have no fraction to clean (and v * 1e10 would overflow).
const clean = (v) => (Math.abs(v) < 1e15 ? Math.round(v * 1e10) / 1e10 : v);

/** An axis label for a value: up to two decimals, with prefix and suffix. */
export function formatValue(v, prefix = '', suffix = '') {
  const r = Math.round(v * 100) / 100;
  const s = Number.isInteger(r) ? String(r) : String(r);
  return `${prefix}${s === '-0' ? '0' : s}${suffix}`;
}

/** Value scale from data and options: { min, max, divisions, step }. */
export function valueScale(values, opt, { includeZero = true } = {}) {
  const v = opt.value;
  if (v.manual) {
    const min = Number(v.min) || 0;
    let max = Number(v.max);
    if (!(max > min)) max = min + 1;
    const divisions = Math.max(1, Math.round(v.divisions) || 1);
    return { min, max, divisions, step: (max - min) / divisions };
  }
  const nums = values.filter((x) => Number.isFinite(x));
  if (!nums.length) return { min: 0, max: 1, divisions: 1, step: 1 };
  return niceScale(Math.min(...nums), Math.max(...nums), 5, includeZero);
}

// ---- geometry helpers ----

const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
export const rectAnchors = (x, y, w, h) => [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)];
const polyAnchors = (pts) => pts.map((p) => pt(p.x, p.y));

/** A pie wedge from angle a0 to a1 (radians, clockwise from 12 o'clock on a y-down screen). */
export function wedgeAnchors(cx, cy, r, a0, a1) {
  const full = a1 - a0 >= Math.PI * 2 - 1e-9;
  const pos = (a) => ({ x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) });
  const n = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2) - 1e-9));
  const da = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(da / 4) * r;
  const arc = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + i * da;
    const p = pos(a);
    // Tangent direction for a clockwise sweep.
    const tx = Math.cos(a);
    const ty = Math.sin(a);
    arc.push({ x: p.x, y: p.y, ix: i > 0 ? p.x - tx * k : p.x, iy: i > 0 ? p.y - ty * k : p.y, ox: i < n ? p.x + tx * k : p.x, oy: i < n ? p.y + ty * k : p.y });
  }
  if (full) {
    const first = arc[0];
    const last = arc.pop();
    first.ix = last.ix;
    first.iy = last.iy;
    return arc;
  }
  return [pt(cx, cy), ...arc];
}

/** Outline of a polyline drawn `width` wide, as a closed polygon (miter joins, butt ends). */
export function thickLine(points, width) {
  if (points.length < 2) return [];
  const hw = width / 2;
  const normals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const l = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / l, y: dx / l });
  }
  const side = (sign) => {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = normals[Math.max(0, i - 1)];
      const b = normals[Math.min(normals.length - 1, i)];
      let nx = a.x + b.x;
      let ny = a.y + b.y;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const cos = nx * b.x + ny * b.y;
      const scale = hw / Math.max(0.25, cos);
      out.push({ x: points[i].x + sign * nx * scale, y: points[i].y + sign * ny * scale });
    }
    return out;
  };
  return [...side(1), ...side(-1).reverse()];
}

// ---- layout ----

/**
 * The scene of a graph in its frame. `measure(text, size)` gives a label's
 * width. Returns {
 *   marks:  [{ series, category, anchors, closed, role: 'fill'|'line'|'marker', rect? }],
 *   shadow: [{ anchors, closed }],
 *   lines:  [{ anchors, role: 'axis'|'tick'|'grid' }],
 *   texts:  [{ text, x, y, align, role }],
 *   legend: [{ series, rect, label: { text, x, y, align } }],
 *   keys:   [rect per series],
 *   scale,  bars: [{ series, category, rect, value }] (for column designs)
 * }
 */
export function layoutGraph(graph, measure = (t, s) => String(t).length * s * 0.55) {
  const type = graph.type || 'column';
  const opt = graphOptions(graph.options);
  const W = Math.max(1, graph.frame?.w || 200);
  const H = Math.max(1, graph.frame?.h || 150);
  const data = parseGraphData(graph.data, type);
  const fs = opt.fontSize;
  const scene = { marks: [], shadow: [], lines: [], texts: [], legend: [], keys: [], bars: [], scale: null, type };
  const nS = data.series.length;
  const label = (text, x, y, align, role = 'label') => {
    if (text !== '' && text != null) scene.texts.push({ text: String(text), x, y, align, role });
  };
  const line = (pts, role) => scene.lines.push({ anchors: polyAnchors(pts), role });
  const tickLen = 4;

  // Series order: the first series in front draws last.
  const seriesOrder = [...Array(nS).keys()];
  if (opt.firstColumnFront) seriesOrder.reverse();
  const nC = data.categories.length;
  const catOrder = [...Array(nC).keys()];
  if (opt.firstRowFront) catOrder.reverse();

  const hasNames = data.series.some((s) => s.name);
  const legendOn = type === 'pie' ? opt.pieLegend === 'standard' && hasNames : hasNames;

  const valueAxisSides = (horizontal) => {
    const v = opt.valueAxis;
    if (horizontal) return v === 'both' ? ['bottom', 'top'] : v === 'right' || v === 'top' ? ['top'] : ['bottom'];
    return v === 'both' ? ['left', 'right'] : v === 'right' ? ['right'] : ['left'];
  };

  /** Value axis along y (columns, lines, areas) or x (bars). */
  const valueAxis = (scale, horizontal) => {
    const { min, max, divisions } = scale;
    const v = opt.value;
    const per = Math.max(1, Math.round(v.tickCount) || 1);
    const toPos = (val) => (horizontal ? ((val - min) / (max - min)) * W : H - ((val - min) / (max - min)) * H);
    for (const side of valueAxisSides(horizontal)) {
      if (horizontal) {
        const y = side === 'bottom' ? H : 0;
        line([{ x: 0, y }, { x: W, y }], 'axis');
      } else {
        const x = side === 'left' ? 0 : W;
        line([{ x, y: 0 }, { x, y: H }], 'axis');
      }
      for (let d = 0; d <= divisions * per; d++) {
        const val = min + ((max - min) * d) / (divisions * per);
        const p = toPos(val);
        const major = d % per === 0;
        if (v.tickLength !== 'none') {
          if (v.tickLength === 'full' && d > 0 && d < divisions * per) {
            if (side === (horizontal ? 'bottom' : 'left') || valueAxisSides(horizontal).length === 1) line(horizontal ? [{ x: p, y: 0 }, { x: p, y: H }] : [{ x: 0, y: p }, { x: W, y: p }], 'grid');
          } else {
            const len = major ? tickLen : tickLen / 2;
            if (horizontal) line(side === 'bottom' ? [{ x: p, y: H }, { x: p, y: H + len }] : [{ x: p, y: 0 }, { x: p, y: -len }], 'tick');
            else line(side === 'left' ? [{ x: -len, y: p }, { x: 0, y: p }] : [{ x: W, y: p }, { x: W + len, y: p }], 'tick');
          }
        }
        if (!major) continue;
        const text = formatValue(val, v.prefix, v.suffix);
        if (horizontal) {
          if (side === 'bottom') label(text, p, H + tickLen + 3 + fs * 0.8, 'center', 'value');
          else label(text, p, -tickLen - 4, 'center', 'value');
        } else if (side === 'left') label(text, -tickLen - 3, p + fs * 0.35, 'right', 'value');
        else label(text, W + tickLen + 3, p + fs * 0.35, 'left', 'value');
      }
    }
    return toPos;
  };

  /** Category axis along x (columns, lines) or y (bars). */
  const categoryAxis = (horizontalBars, centers, slot) => {
    const c = opt.category;
    const per = Math.max(1, Math.round(c.tickCount) || 1);
    if (horizontalBars) line([{ x: 0, y: 0 }, { x: 0, y: H }], 'axis');
    else line([{ x: 0, y: H }, { x: W, y: H }], 'axis');
    if (c.tickLength !== 'none' && nC > 0) {
      const marks = [];
      if (c.between) {
        for (let i = 0; i <= nC * per; i++) marks.push((i * slot) / per);
      } else {
        for (const p of centers) marks.push(p);
      }
      for (const m of marks) {
        if (c.tickLength === 'full') {
          if (m > 1e-6 && m < (horizontalBars ? H : W) - 1e-6) line(horizontalBars ? [{ x: 0, y: m }, { x: W, y: m }] : [{ x: m, y: 0 }, { x: m, y: H }], 'grid');
        } else if (horizontalBars) line([{ x: -tickLen, y: m }, { x: 0, y: m }], 'tick');
        else line([{ x: m, y: H }, { x: m, y: H + tickLen }], 'tick');
      }
    }
    data.categories.forEach((name, i) => {
      if (horizontalBars) label(name, -tickLen - 3, centers[i] + fs * 0.35, 'right', 'category');
      else label(name, centers[i], H + tickLen + 3 + fs * 0.8, 'center', 'category');
    });
  };

  const pushMark = (series, category, anchors, closed = true, role = 'fill', extra = {}) => {
    scene.marks.push({ series, category, anchors, closed, role, ...extra });
    if (opt.shadow && role === 'fill') scene.shadow.push({ anchors, closed });
  };
  const marker = (series, category, x, y) => {
    const s = opt.markerSize;
    scene.marks.push({ series, category, anchors: rectAnchors(x - s / 2, y - s / 2, s, s), closed: true, role: 'marker', rect: { x: x - s / 2, y: y - s / 2, w: s, h: s } });
  };

  if (type === 'column' || type === 'stacked-column' || type === 'bar' || type === 'stacked-bar') {
    const horizontal = type === 'bar' || type === 'stacked-bar';
    const stacked = type.startsWith('stacked');
    const all = [];
    if (stacked) {
      for (let c = 0; c < nC; c++) {
        let pos = 0;
        let neg = 0;
        for (const s of data.series) {
          const v = s.values[c];
          if (v > 0) pos += v;
          else if (v < 0) neg += v;
        }
        all.push(pos, neg);
      }
    } else for (const s of data.series) all.push(...s.values);
    const scale = valueScale(all, opt);
    scene.scale = scale;
    const len = horizontal ? H : W;
    const slot = nC ? len / nC : len;
    const centers = data.categories.map((_, i) => (i + 0.5) * slot);
    const toPos = valueAxis(scale, horizontal);
    categoryAxis(horizontal, centers, slot);
    const cluster = slot * (opt.clusterWidth / 100);
    const colRoom = stacked ? cluster : cluster / Math.max(1, nS);
    const colW = colRoom * (opt.columnWidth / 100);
    const bar = (s, c, v0, v1, offset) => {
      const p0 = toPos(Math.max(scale.min, Math.min(scale.max, v0)));
      const p1 = toPos(Math.max(scale.min, Math.min(scale.max, v1)));
      const center = centers[c] - cluster / 2 + offset + colRoom / 2;
      const rect = horizontal
        ? { x: Math.min(p0, p1), y: center - colW / 2, w: Math.abs(p1 - p0), h: colW }
        : { x: center - colW / 2, y: Math.min(p0, p1), w: colW, h: Math.abs(p1 - p0) };
      scene.bars.push({ series: s, category: c, rect, value: v1 - v0, horizontal, negative: v1 < v0 });
      pushMark(s, c, rectAnchors(rect.x, rect.y, rect.w, rect.h), true, 'fill', { rect });
    };
    for (const c of catOrder) {
      if (stacked) {
        // Stacks build outward from zero; the order of the series in the stack stays fixed.
        const segs = [];
        let pos = 0;
        let neg = 0;
        data.series.forEach((s, si) => {
          const v = s.values[c];
          if (!Number.isFinite(v) || v === 0) return;
          if (v > 0) {
            segs.push([si, pos, pos + v]);
            pos += v;
          } else {
            segs.push([si, neg, neg + v]);
            neg += v;
          }
        });
        const order = opt.firstColumnFront ? segs.slice().reverse() : segs;
        for (const [si, a, b] of order) bar(si, c, a, b, 0);
      } else {
        for (const si of seriesOrder) {
          const v = data.series[si].values[c];
          if (!Number.isFinite(v)) continue;
          bar(si, c, 0, v, si * colRoom);
        }
      }
    }
  } else if (type === 'line' || type === 'area') {
    const area = type === 'area';
    const all = [];
    if (area) {
      for (let c = 0; c < nC; c++) {
        let acc = 0;
        for (const s of data.series) {
          acc += Number.isFinite(s.values[c]) ? s.values[c] : 0;
          all.push(acc);
        }
      }
    } else for (const s of data.series) all.push(...s.values);
    const scale = valueScale(all, opt, { includeZero: area || opt.value.manual });
    scene.scale = scale;
    const toPos = valueAxis(scale, false);
    const edge = area || opt.edgeToEdge;
    const slot = nC ? W / nC : W;
    const xs = data.categories.map((_, i) => (edge ? (nC > 1 ? (i * W) / (nC - 1) : W / 2) : (i + 0.5) * slot));
    categoryAxis(false, xs, slot);
    if (area) {
      const cum = data.categories.map(() => 0);
      const layers = [];
      data.series.forEach((s, si) => {
        const lower = cum.slice();
        for (let c = 0; c < nC; c++) cum[c] += Number.isFinite(s.values[c]) ? s.values[c] : 0;
        const top = xs.map((x, c) => ({ x, y: toPos(Math.max(scale.min, Math.min(scale.max, cum[c]))) }));
        const bottom = xs.map((x, c) => ({ x, y: toPos(Math.max(scale.min, Math.min(scale.max, lower[c]))) })).reverse();
        layers.push([si, polyAnchors([...top, ...bottom])]);
      });
      // Areas stack upward; later series sit on top of earlier ones and never overlap.
      for (const [si, anchors] of layers) pushMark(si, -1, anchors, true, 'fill');
    } else {
      for (const si of seriesOrder) {
        const s = data.series[si];
        const pts = [];
        s.values.forEach((v, c) => {
          if (Number.isFinite(v)) pts.push({ x: xs[c], y: toPos(Math.max(scale.min, Math.min(scale.max, v))), c });
        });
        if (opt.connectPoints && pts.length > 1) {
          if (opt.filledLines) pushMark(si, -1, polyAnchors(thickLine(pts, opt.lineWidth)), true, 'fill');
          else scene.marks.push({ series: si, category: -1, anchors: polyAnchors(pts), closed: false, role: 'line' });
        }
        if (opt.markPoints) for (const p of pts) marker(si, p.c, p.x, p.y);
      }
    }
  } else if (type === 'scatter') {
    const ys = [];
    const xsAll = [];
    for (const s of data.series) {
      s.values.forEach((v, i) => {
        if (Number.isFinite(v) && Number.isFinite(s.xs[i])) {
          ys.push(v);
          xsAll.push(s.xs[i]);
        }
      });
    }
    const yScale = valueScale(ys, opt, { includeZero: false });
    const xScale = niceScale(xsAll.length ? Math.min(...xsAll) : 0, xsAll.length ? Math.max(...xsAll) : 1, 5, false);
    scene.scale = yScale;
    const toY = valueAxis(yScale, false);
    const toX = (x) => ((x - xScale.min) / (xScale.max - xScale.min)) * W;
    line([{ x: 0, y: H }, { x: W, y: H }], 'axis');
    const c = opt.category;
    for (let d = 0; d <= xScale.divisions; d++) {
      const val = xScale.min + d * xScale.step;
      const x = toX(val);
      if (c.tickLength === 'full') {
        if (d > 0 && d < xScale.divisions) line([{ x, y: 0 }, { x, y: H }], 'grid');
      } else if (c.tickLength !== 'none') line([{ x, y: H }, { x, y: H + tickLen }], 'tick');
      label(formatValue(val), x, H + tickLen + 3 + fs * 0.8, 'center', 'category');
    }
    for (const si of seriesOrder) {
      const s = data.series[si];
      const pts = [];
      s.values.forEach((v, i) => {
        if (Number.isFinite(v) && Number.isFinite(s.xs[i])) pts.push({ x: toX(s.xs[i]), y: toY(v), c: i });
      });
      if (opt.connectPoints && pts.length > 1) {
        if (opt.filledLines) pushMark(si, -1, polyAnchors(thickLine(pts, opt.lineWidth)), true, 'fill');
        else scene.marks.push({ series: si, category: -1, anchors: polyAnchors(pts), closed: false, role: 'line' });
      }
      if (opt.markPoints || !opt.connectPoints) for (const p of pts) marker(si, p.c, p.x, p.y);
    }
  } else if (type === 'pie') {
    layoutPies(data, opt, W, H, scene, pushMark, label);
  } else if (type === 'radar') {
    const all = [];
    for (const s of data.series) all.push(...s.values);
    const scale = valueScale(all, opt);
    scene.scale = scale;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) / 2;
    const n = Math.max(3, nC);
    const ang = (i) => (i / n) * Math.PI * 2;
    const at = (i, v) => {
      const r = ((Math.max(scale.min, Math.min(scale.max, v)) - scale.min) / (scale.max - scale.min)) * R;
      return { x: cx + r * Math.sin(ang(i)), y: cy - r * Math.cos(ang(i)) };
    };
    // Spokes, rings and value labels up the first spoke.
    for (let i = 0; i < nC; i++) line([{ x: cx, y: cy }, at(i, scale.max)], 'axis');
    const v = opt.value;
    for (let d = 1; d <= scale.divisions; d++) {
      const val = scale.min + d * scale.step;
      if (v.tickLength === 'full') {
        const ring = [];
        for (let i = 0; i < nC; i++) ring.push(at(i, val));
        if (ring.length > 2) scene.lines.push({ anchors: polyAnchors(ring), closed: true, role: 'grid' });
      } else if (v.tickLength !== 'none') {
        const p = at(0, val);
        line([{ x: p.x - tickLen, y: p.y }, { x: p.x + tickLen, y: p.y }], 'tick');
      }
      const p = at(0, val);
      label(formatValue(val, v.prefix, v.suffix), p.x - tickLen - 3, p.y + fs * 0.35, 'right', 'value');
    }
    data.categories.forEach((name, i) => {
      const p = at(i, scale.max);
      const a = ang(i);
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      const align = Math.abs(dx) < 0.2 ? 'center' : dx > 0 ? 'left' : 'right';
      label(name, p.x + dx * 6, p.y + dy * 6 + fs * (dy > 0.2 ? 0.9 : dy < -0.2 ? -0.1 : 0.35), align, 'category');
    });
    for (const si of seriesOrder) {
      const s = data.series[si];
      const pts = [];
      s.values.forEach((val, i) => {
        if (Number.isFinite(val)) pts.push({ ...at(i, val), c: i });
      });
      if (opt.connectPoints && pts.length > 1) {
        if (opt.filledLines) pushMark(si, -1, polyAnchors(pts), true, 'fill');
        else scene.marks.push({ series: si, category: -1, anchors: polyAnchors(pts), closed: pts.length === nC, role: 'line' });
      }
      if (opt.markPoints) for (const p of pts) marker(si, p.c, p.x, p.y);
    }
  }

  // Legend: down the right side, or across the top.
  if (legendOn) {
    const sw = Math.max(6, fs);
    const gap = fs * 0.6;
    if (opt.legendTop) {
      let x = 0;
      const y = -fs * 2.2 - (valueAxisSides(true).includes('top') && (type === 'bar' || type === 'stacked-bar') ? fs * 1.6 : 0);
      data.series.forEach((s, i) => {
        const rect = { x, y: y - sw / 2, w: sw, h: sw };
        scene.legend.push({ series: i, rect, label: { text: s.name, x: x + sw + gap, y: y + fs * 0.35, align: 'left' } });
        x += sw + gap + measure(s.name, fs) + fs * 1.5;
      });
    } else {
      const rightAxis = valueAxisSides(false).includes('right') && type !== 'bar' && type !== 'stacked-bar' && type !== 'pie' && type !== 'radar';
      const x = W + fs * 1.5 + (rightAxis ? measure('0000', fs) + 8 : 0);
      data.series.forEach((s, i) => {
        const y = i * (sw + gap) + sw / 2;
        const rect = { x, y: y - sw / 2, w: sw, h: sw };
        scene.legend.push({ series: i, rect, label: { text: s.name, x: x + sw + gap, y: y + fs * 0.35, align: 'left' } });
      });
    }
  }
  // Series keys: the legend swatch, else the series' first mark.
  for (let i = 0; i < nS; i++) {
    const lg = scene.legend.find((l) => l.series === i);
    if (lg) {
      scene.keys.push(lg.rect);
      continue;
    }
    const m = scene.marks.find((mk) => mk.series === i);
    if (m) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const a of m.anchors) {
        x0 = Math.min(x0, a.x);
        y0 = Math.min(y0, a.y);
        x1 = Math.max(x1, a.x);
        y1 = Math.max(y1, a.y);
      }
      scene.keys.push({ x: x0, y: y0, w: Math.max(x1 - x0, 0.01), h: Math.max(y1 - y0, 0.01) });
    } else scene.keys.push({ x: 0, y: 0, w: 1, h: 1 });
  }
  return scene;
}

function layoutPies(data, opt, W, H, scene, pushMark, label) {
  const nPies = data.categories.length;
  if (!nPies) return;
  const fs = opt.fontSize;
  const totals = data.categories.map((_, c) => data.series.reduce((acc, s) => acc + (s.values[c] > 0 ? s.values[c] : 0), 0));
  const maxTotal = Math.max(...totals, 1e-9);
  // Slice order per pie.
  const orderFor = (c) => {
    const idx = data.series.map((_, i) => i);
    if (opt.pieSort === 'all') return idx.sort((a, b) => (data.series[b].values[c] || 0) - (data.series[a].values[c] || 0));
    if (opt.pieSort === 'first') return idx.sort((a, b) => (data.series[b].values[0] || 0) - (data.series[a].values[0] || 0));
    return idx;
  };
  const labelRoom = data.categories.some((n) => n) ? fs * 2 : 0;
  const pies = [];
  if (opt.piePosition === 'stacked') {
    const R = Math.min(W, H - labelRoom) / 2;
    data.categories.forEach((_, c) => pies.push({ c, cx: W / 2, cy: (H - labelRoom) / 2, r: R * Math.sqrt(totals[c] / maxTotal) }));
    // Largest at the back.
    pies.sort((a, b) => b.r - a.r);
  } else {
    const cols = Math.max(1, Math.round(Math.sqrt((nPies * W) / Math.max(1, H))));
    const rowsN = Math.ceil(nPies / cols);
    const cw = W / Math.min(cols, nPies);
    const ch = H / rowsN;
    const R = Math.max(1, Math.min(cw, ch - labelRoom) / 2 - fs * 0.4);
    data.categories.forEach((name, c) => {
      const col = c % cols;
      const row = Math.floor(c / cols);
      const r = opt.piePosition === 'even' ? R : R * Math.sqrt(totals[c] / maxTotal);
      const cx = col * cw + cw / 2;
      const cy = row * ch + (ch - labelRoom) / 2;
      pies.push({ c, cx, cy, r });
      label(name, cx, row * ch + ch - labelRoom / 2 + fs * 0.35, 'center', 'category');
    });
  }
  for (const { c, cx, cy, r } of pies) {
    const total = totals[c];
    if (!(total > 0) || r <= 0) continue;
    let a = 0;
    for (const si of orderFor(c)) {
      const v = data.series[si].values[c];
      if (!(v > 0)) continue;
      const da = (v / total) * Math.PI * 2;
      pushMark(si, c, wedgeAnchors(cx, cy, r, a, a + da), true, 'fill');
      if (opt.pieLegend === 'wedges' && data.series[si].name) {
        const mid = a + da / 2;
        label(data.series[si].name, cx + Math.sin(mid) * r * 0.62, cy - Math.cos(mid) * r * 0.62 + fs * 0.35, 'center', 'wedge');
      }
      a += da;
    }
  }
}
