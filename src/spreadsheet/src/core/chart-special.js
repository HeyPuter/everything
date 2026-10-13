/**
 * The arithmetic behind the chart types that are not plots of series against an axis, or that read
 * their columns in a fixed order: the hierarchy of a treemap or sunburst and its layouts, the
 * statistics of a box and whisker chart, the price columns of a stock chart, and the value bands
 * and contours of a surface. Pure: numbers in, numbers out, so the renderer and tests share them.
 */

/** Chart types whose categories form a tree of label columns (each a level), sized by one value column. */
export const HIERARCHY_TYPES = new Set(['treemap', 'sunburst']);
export const isHierarchyChart = chart => HIERARCHY_TYPES.has(chart?.type);

/**
 * Rows of label paths, each label column a level. A blank label with a filled label to its right
 * repeats the label above it, as a parent is written once over its group; trailing blanks end the
 * path early, so a row can size a branch rather than a leaf.
 */
export function fillDownLevels(rows) {
  const out = [];
  let previous = [];
  for (const row of rows) {
    const labels = row.map(v => (v == null ? '' : String(v).trim()));
    let last = -1;
    labels.forEach((v, i) => { if (v) last = i; });
    const path = [];
    for (let i = 0; i <= last; i++) path.push(labels[i] || previous[i] || '');
    out.push(path);
    if (path.length) previous = path;
  }
  return out;
}

/**
 * The tree of `paths` (one per row) sized by `values`: each node { name, value, depth, children,
 * rows }, its value the sum of the positive values beneath it. Rows with no label or no positive
 * value are left out. Children are ordered largest first, as both layouts place them.
 */
export function buildHierarchy(paths, values) {
  const root = { name: '', value: 0, depth: 0, children: [], rows: [], path: [] };
  paths.forEach((path, row) => {
    const v = values[row];
    if (!path.length || !(typeof v === 'number' && Number.isFinite(v) && v > 0)) return;
    let node = root;
    for (const [i, name] of path.entries()) {
      let next = node.children.find(c => c.name === name && !c.own);
      if (!next) {
        next = { name, value: 0, depth: i + 1, children: [], rows: [], path: path.slice(0, i + 1), parent: node };
        node.children.push(next);
      }
      next.value += v;
      node = next;
    }
    node.rows.push(row);
    node.ownValue = (node.ownValue || 0) + v;
  });
  root.value = root.children.reduce((sum, c) => sum + c.value, 0);
  // A branch that also has a value of its own keeps it as a leaf of the same name beside its children.
  const settle = node => {
    if (node.children.length && node.ownValue) {
      node.children.push({ name: node.name, value: node.ownValue, depth: node.depth + 1, children: [], rows: node.rows, path: [...node.path, node.name], parent: node, own: true });
    }
    node.children.sort((a, b) => b.value - a.value);
    node.children.forEach(settle);
  };
  settle(root);
  return root;
}

/** Every node of a tree in drawing order (parents before their children), the root left out. */
export function hierarchyNodes(root) {
  const out = [];
  const walk = node => { for (const c of node.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}
export const hierarchyDepth = root => Math.max(0, ...hierarchyNodes(root).map(n => n.depth));
/** The level-1 ancestor a node takes its colour from. */
export function topAncestor(node) {
  let n = node;
  while (n.parent && n.parent.depth > 0) n = n.parent;
  return n;
}

/**
 * Squarified treemap (Bruls, Huizing and van Wijk): `values` (largest first) laid into `rect`
 * { x, y, w, h } as rectangles of matching area whose sides stay as close to square as the order
 * allows. Returns one rect per value, in the same order.
 */
export function squarify(values, rect) {
  const out = new Array(values.length);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (!total || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const items = values.map((v, i) => ({ i, area: Math.max(0, v) * scale }));
  let { x, y, w, h } = rect;
  const worst = (row, side) => {
    const sum = row.reduce((s, it) => s + it.area, 0);
    if (!sum) return Infinity;
    let max = 0, min = Infinity;
    for (const it of row) { max = Math.max(max, it.area); min = Math.min(min, it.area); }
    return Math.max(side * side * max / (sum * sum), sum * sum / (side * side * Math.max(min, 1e-12)));
  };
  const place = row => {
    const sum = row.reduce((s, it) => s + it.area, 0);
    if (w >= h) {
      // A column down the left of the free space.
      const colW = h ? sum / h : 0;
      let yy = y;
      for (const it of row) { const hh = colW ? it.area / colW : 0; out[it.i] = { x, y: yy, w: colW, h: hh }; yy += hh; }
      x += colW; w -= colW;
    } else {
      const rowH = w ? sum / w : 0;
      let xx = x;
      for (const it of row) { const ww = rowH ? it.area / rowH : 0; out[it.i] = { x: xx, y, w: ww, h: rowH }; xx += ww; }
      y += rowH; h -= rowH;
    }
  };
  let row = [];
  for (const it of items) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
    else { place(row); row = [it]; }
  }
  if (row.length) place(row);
  return out;
}

/**
 * The treemap of a hierarchy within `rect`: { node, x, y, w, h, header } for every node, parents
 * first. `labels` is the parent label layout: 'banner' keeps a strip of `bannerHeight` along a
 * parent's top for its name; 'overlapping' and 'none' give its children the whole rectangle.
 * `gap` separates siblings.
 */
export function treemapLayout(root, rect, { labels = 'overlapping', bannerHeight = 16, gap = 1 } = {}) {
  const out = [];
  const lay = (node, box) => {
    const kids = node.children;
    if (!kids.length) return;
    const rects = squarify(kids.map(k => k.value), box);
    kids.forEach((k, i) => {
      const r = rects[i];
      const inset = { x: r.x + gap / 2, y: r.y + gap / 2, w: Math.max(0, r.w - gap), h: Math.max(0, r.h - gap) };
      const header = labels === 'banner' && k.children.length && inset.h > bannerHeight * 2 ? bannerHeight : 0;
      out.push({ node: k, ...inset, header });
      if (k.children.length) lay(k, { x: inset.x, y: inset.y + header, w: inset.w, h: Math.max(0, inset.h - header) });
    });
  };
  lay(root, rect);
  return out;
}

/**
 * The rings of a sunburst: { node, depth, a0, a1 } in radians clockwise from the top, each node's
 * span its share of its parent's, level 1 innermost.
 */
export function sunburstLayout(root) {
  const out = [];
  const lay = (node, a0, a1) => {
    let at = a0;
    const total = node.children.reduce((s, c) => s + c.value, 0) || 1;
    // A parent's own value as a leaf already counts among its children, so the spans fill the parent.
    for (const c of node.children) {
      const span = (a1 - a0) * c.value / total;
      out.push({ node: c, depth: c.depth, a0: at, a1: at + span });
      lay(c, at, at + span);
      at += span;
    }
  };
  lay(root, 0, Math.PI * 2);
  return out;
}

/* ---------- Box and whisker ---------- */

/**
 * A quartile of sorted numbers. 'exclusive' interpolates at rank (n + 1)·p (as QUARTILE.EXC does),
 * 'inclusive' at (n − 1)·p + 1 (as QUARTILE.INC does); a rank outside the data is held to its ends,
 * so two points still draw a box.
 */
export function quartile(sorted, p, method = 'exclusive') {
  const n = sorted.length;
  if (!n) return null;
  const rank = method === 'inclusive' ? (n - 1) * p + 1 : (n + 1) * p;
  const k = Math.min(n, Math.max(1, rank));
  const lo = Math.floor(k), frac = k - lo;
  return lo >= n ? sorted[n - 1] : sorted[lo - 1] + frac * (sorted[lo] - sorted[lo - 1]);
}

/**
 * The statistics a box draws from `values`: the quartiles, the mean, whiskers to the furthest points
 * within 1.5 interquartile ranges of the box, the points beyond them (outliers) and those within
 * (inner points). Null for no numbers.
 */
export function boxStats(values, method = 'exclusive') {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const q1 = quartile(nums, .25, method), median = quartile(nums, .5, method), q3 = quartile(nums, .75, method);
  const iqr = q3 - q1, lowFence = q1 - 1.5 * iqr, highFence = q3 + 1.5 * iqr;
  const inside = nums.filter(v => v >= lowFence && v <= highFence);
  let sum = 0;
  for (const v of nums) sum += v;
  return { n: nums.length, min: nums[0], max: nums[nums.length - 1], q1, median, q3, mean: sum / nums.length,
    // The whiskers end at real points; with every point outside the fences (a box of equal values) at the box.
    low: inside.length ? Math.min(inside[0], q1) : q1, high: inside.length ? Math.max(inside[inside.length - 1], q3) : q3,
    outliers: nums.filter(v => v < lowFence || v > highFence), inner: inside };
}

/**
 * Box and whisker data: each series' values grouped by category, rows sharing a category label
 * pooled. Without a category column every row is one group. Returns { categories, series: [{ name,
 * groups: [values[]] }] }.
 */
export function boxGroups(data) {
  const grouped = data.sourceLayout ? data.sourceLayout.categoryLine != null : data.series.some(s => s.categories?.some((c, i) => c !== String(i + 1)));
  const categories = [], index = new Map();
  const rows = data.categories.map(c => {
    const key = grouped ? String(c ?? '') : '';
    if (!index.has(key)) { index.set(key, categories.length); categories.push(key); }
    return index.get(key);
  });
  return { categories, series: data.series.map(s => {
    const groups = categories.map(() => []);
    s.values.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v) && rows[i] != null) groups[rows[i]].push(v); });
    return { name: s.name, style: s.style, groups };
  }) };
}

/* ---------- Stock ---------- */

/** The columns each stock subtype reads, in the order they must stand after the dates. */
export const STOCK_KINDS = Object.freeze({
  hlc: ['high', 'low', 'close'],
  ohlc: ['open', 'high', 'low', 'close'],
  vhlc: ['volume', 'high', 'low', 'close'],
  vohlc: ['volume', 'open', 'high', 'low', 'close'],
});
export const STOCK_FIELD_NAMES = { volume: 'Volume', open: 'Open', high: 'High', low: 'Low', close: 'Close' };

/**
 * The price (and volume) columns of a stock chart, read in order from the series: { categories,
 * high, low, close, open?, volume?, names } or { missing } naming the columns a subtype needs when
 * there are too few series.
 */
export function stockSeries(data, kind = 'hlc') {
  const fields = STOCK_KINDS[kind] || STOCK_KINDS.hlc;
  if (data.series.length < fields.length) return { missing: fields.map(f => STOCK_FIELD_NAMES[f]) };
  const out = { kind, categories: data.categories, names: {}, styles: {} };
  fields.forEach((field, i) => {
    const s = data.series[i];
    out[field] = s.values;
    out.names[field] = s.name;
    out.styles[field] = s.style ?? data.valueStyle ?? null;
  });
  return out;
}

/* ---------- Surface ---------- */

/** A surface's grid: rows are the categories, columns the series; z[r][c] null where blank. */
export function surfaceGrid(data) {
  const rows = data.categories.length, cols = data.series.length;
  const z = Array.from({ length: rows }, (_, r) => data.series.map(s => (Number.isFinite(s.values[r]) ? s.values[r] : null)));
  return { rows, cols, z, rowNames: data.categories, colNames: data.series.map(s => s.name) };
}

/**
 * The value bands a surface is coloured in: one band per major step of its value axis, from
 * `min` to `max` (rounded out to the step), at most `limit` of them.
 */
export function surfaceBands(lo, hi, { min = null, max = null, step = null, niceScale, limit = 24 } = {}) {
  let scale = niceScale(min ?? lo, max ?? hi, 6);
  if (min != null) scale.min = min;
  if (max != null) scale.max = max;
  if (step > 0) scale.step = step;
  if (!(scale.max > scale.min) || !(scale.step > 0)) scale = { min: Number.isFinite(lo) ? lo : 0, max: (Number.isFinite(lo) ? lo : 0) + 1, step: 1 };
  if ((scale.max - scale.min) / scale.step > limit) scale.step = (scale.max - scale.min) / limit;
  const bands = [];
  for (let i = 0; scale.min + i * scale.step < scale.max - scale.step * 1e-9 && i < limit; i++) {
    bands.push({ lo: scale.min + i * scale.step, hi: Math.min(scale.max, scale.min + (i + 1) * scale.step) });
  }
  return { ...scale, bands };
}

/** The triangles of a grid: each cell with all four corners split along a diagonal; points are [category, series, z] (row and column indices and the height). */
export function surfaceTriangles(grid) {
  const tris = [];
  for (let r = 0; r + 1 < grid.rows; r++) {
    for (let c = 0; c + 1 < grid.cols; c++) {
      const p = (rr, cc) => (grid.z[rr][cc] == null ? null : [rr, cc, grid.z[rr][cc]]);
      const a = p(r, c), b = p(r, c + 1), d = p(r + 1, c), e = p(r + 1, c + 1);
      if (a && b && e) tris.push([a, b, e]);
      if (a && e && d) tris.push([a, e, d]);
      // A cell missing one corner still draws the triangle the other three make.
      if (!a && b && d && e) tris.push([b, e, d]);
      if (!e && a && b && d) tris.push([a, b, d]);
    }
  }
  return tris;
}

/** Clip a polygon of [x, y, z] points to z ≥ level (keep 'above') or z ≤ level ('below'), interpolating linearly. */
function clipZ(poly, level, keep) {
  const inside = p => (keep === 'above' ? p[2] >= level : p[2] <= level);
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib && b[2] !== a[2]) {
      const t = (level - a[2]) / (b[2] - a[2]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), level]);
    }
  }
  return out;
}

/** The part of a triangle whose values lie within [lo, hi]: a polygon of up to five points, or null. */
export function bandPolygon(tri, lo, hi) {
  let poly = clipZ(tri, lo, 'above');
  if (poly.length < 3) return null;
  poly = clipZ(poly, hi, 'below');
  return poly.length >= 3 ? poly : null;
}

/** Where a triangle crosses `level`: the segment [[x, y], [x, y]] of its contour line, or null. */
export function isoSegment(tri, level) {
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3];
    if ((a[2] - level) * (b[2] - level) < 0 || (a[2] === level && b[2] !== level)) {
      const t = (level - a[2]) / (b[2] - a[2]);
      pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return pts.length >= 2 ? [pts[0], pts[1]] : null;
}
