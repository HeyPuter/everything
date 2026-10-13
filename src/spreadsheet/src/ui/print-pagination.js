/** Page fragments of an already laid-out worksheet. Preserve the layout of
 * merged cells, overflow labels and drawings instead of reflowing each page. */
import { el } from './dom.js';
import { cellPrintBorders, clipPrintBorderEdges, printBorderInkBounds, copyMergedPrintBorders } from './print-borders.js';

// Source-line identities are kept outside the DOM. They describe titles even
// when the print area starts below/right of them or hidden lines are omitted.
const titleAxes = new WeakMap();
export function setPrintTitleAxes(table, axes) { titleAxes.set(table, axes); }
// Manual page breaks, as the table's own line indices (heading lines counted) that start a new page.
const breakAxes = new WeakMap();
export function setPrintBreakAxes(table, axes) { breakAxes.set(table, axes); }

/** Worksheets fit at whole percentages, with a 10% minimum. Keep an
 * exact percentage stable when binary arithmetic puts it just below its
 * integer representation; this tolerance is not a physical layout allowance. */
export function quantizePrintScale(scale) {
  const percent = scale * 100;
  return Math.max(10, Math.floor(percent + Number.EPSILON * Math.abs(percent) * 2)) / 100;
}

export function printTitleBands(sizes, capacity, { bodyStart = 0, repeat = null, heading = 0 } = {}, forced = null) {
  if (!(capacity > 0) || !Number.isFinite(capacity)) return null;
  const offsets = prefix(sizes), bands = [];
  let start = Math.max(heading, bodyStart);
  while (start < sizes.length) {
    const segments = [], append = (from, to, room = Infinity) => {
      if (to > from) segments.push({ offset: offsets[from], size: Math.min(room, offsets[to] - offsets[from]) });
    };
    append(0, heading);
    if (repeat && start > repeat[0]) {
      // Repeat only title lines already reached. When a title crosses a page
      // break, its remaining lines are still body content. Oversized titles
      // therefore grow one source line per page, rather than skipping ahead.
      append(repeat[0], Math.min(repeat[1], start));
    }
    const repeated = segments.reduce((n, s) => n + s.size, 0), room = Math.max(0, capacity - repeated);
    let end = start, extent = 0;
    while (end < sizes.length) {
      if (end > start && forced?.has(end)) break;
      const next = extent + sizes[end], tolerance = Number.EPSILON * Math.max(room, next) * (end - start + 2);
      if (end > start && next > room + tolerance) break;
      extent = next; end++;
      if (extent >= room - tolerance) break;
    }
    const clipped = repeated + extent > capacity + Number.EPSILON * capacity * (end - start + 2);
    append(start, end, clipped ? Infinity : room);
    bands.push({ segments, size: Math.min(capacity, repeated + extent),
      paintSize: clipped ? repeated + extent : Math.min(capacity, repeated + extent), clipped });
    start = end;
  }
  if (!bands.length && sizes.length) bands.push({ segments: [{ offset: 0, size: Math.min(capacity, offsets.at(-1)) }], size: Math.min(capacity, offsets.at(-1)), clipped: offsets.at(-1) > capacity });
  return bands;
}

/** Pages break between columns/rows. An oversized line occupies one page.
 * Keep its full extent apart from its reserved content size so the renderer
 * can clip paint at the physical edge. Sizes are unscaled. */
export function printBands(sizes, capacity, repeat = 0, forced = null) {
  if (!(capacity > 0) || !Number.isFinite(capacity)) return null;
  // Overfull repeat ranges can occlude the body entirely. Keep the
  // largest repeating prefix that leaves page space; the remaining rows print
  // as body rows. Unlike silently shrinking the worksheet or dropping rows,
  // this preserves the selected scale and guarantees forward progress.
  let repeated = 0, count = 0;
  while (count < Math.min(repeat, sizes.length) && repeated + sizes[count] < capacity) repeated += sizes[count++];
  repeat = count;
  const room = capacity - repeated;
  const bands = [];
  let start = repeat, offset = repeated, extent = 0;
  const push = end => { bands.push({ start, end, offset, extent, size: Math.min(extent, room) }); offset += extent; start = end; extent = 0; };
  for (let i = repeat; i < sizes.length; i++) {
    // Bound accumulated floating-point error, not physical pixel rounding.
    const tolerance = Number.EPSILON * Math.max(room, extent + sizes[i]) * (i - start + 2);
    // A manual break starts a page whatever room is left on the one before it.
    if (i > start && forced?.has(i)) push(i);
    else if (extent && extent + sizes[i] > room + tolerance) push(i);
    extent += sizes[i];
    if (extent >= room - tolerance) push(i + 1);
  }
  if (start < sizes.length || !bands.length && repeat) push(sizes.length);
  return { repeated, bands };
}

/** Largest supported scale whose whole lines fit the requested page counts.
 * Input sizes are measured at `scale`; repeated titles consume space on every
 * page. Search whole percentages, the same precision used by printLayout, without
 * allocating fragments or doing repeated DOM layout for each candidate.
 * Native Excel can choose a smaller automatic scale than its own fixed-scale
 * pagination requires. Keep the maximum that satisfies the requested counts;
 * OOXML specifies those counts, not the application's scale-search heuristic.
 */
export function fitPrintPageScale(axes, scale) {
  const fits = candidate => axes.every(({ sizes, capacity, pages, repeat = 0, titles }) => {
    if (!pages || !sizes.length) return true;
    const limit = capacity * scale / candidate;
    if (titles) {
      const bands = printTitleBands(sizes, limit, titles);
      return bands.length <= pages && bands.every(b => !b.clipped);
    }
    let repeated = 0;
    for (let i = 0; i < repeat; i++) repeated += sizes[i];
    // Match the fragmenter's arithmetic tolerance. Decimal line measurements
    // can sum just above an exact boundary; that must not cost a whole percent.
    // Bound only accumulated floating-point error, never physical page space.
    const exceeds = (extent, lines) => extent - limit > Number.EPSILON * Math.max(limit, extent) * (lines + 2);
    if (exceeds(repeated, repeat)) return false;
    let count = 1, extent = repeated, lines = repeat;
    for (let i = repeat; i < sizes.length; i++) {
      if (exceeds(repeated + sizes[i], repeat + 1)) return false; // fitting must not clip a line
      if (exceeds(extent + sizes[i], lines + 1)) {
        if (++count > pages) return false;
        extent = repeated; lines = repeat;
      }
      extent += sizes[i]; lines++;
    }
    return true;
  });
  const ceiling = quantizePrintScale(scale);
  if (fits(ceiling)) return ceiling;
  let lo = 10, hi = Math.round(ceiling * 100);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid / 100)) lo = mid; else hi = mid - 1;
  }
  return lo / 100;
}

/** Measure only line geometry for multi-page fitting. The rendered table frame
 * includes collapsed borders which cannot be inferred from model dimensions. */
export function fitPrintTableScale(table, { width, height, widthPages, heightPages, headers, scale }) {
  const axes = [], frame = table.getBoundingClientRect();
  const add = (nodes, dimension, capacity, pages, repeat, titles) => {
    const lines = [...nodes].map(n => n.getBoundingClientRect()), sizes = lines.map(rect => rect[dimension]);
    if (!sizes.length || !(sum(sizes) > 0)) return;
    // The two outer half-borders consume the frame space not owned by lines.
    // Keep their measured placement, including asymmetric border weights.
    const start = dimension === 'width' ? 'left' : 'top';
    const before = Math.max(0, lines[0][start] - frame[start]);
    const after = Math.max(0, frame[dimension] - sum(sizes) - before);
    sizes[0] += before; sizes[sizes.length - 1] += after;
    axes.push({ sizes, capacity, pages, repeat, titles });
  };
  const titles = titleAxes.get(table);
  if (widthPages) add(table.querySelector('colgroup')?.children || [], 'width', width, widthPages, headers ? 1 : 0, titles?.cols);
  if (heightPages) add(table.rows, 'height', height, heightPages, table.tHead?.rows.length || 0, titles?.rows);
  const ceiling = fitPrintPageScale(axes, scale);
  const sheet = table.closest('.print-sheet');
  if (!table.classList.contains('has-print-borders') || !sheet) return ceiling;
  const geometry = sheetGeometry(sheet, scale, table, frame);
  if (!geometry) return ceiling;
  const fits = candidate => {
    const pages = printPageGeometry(geometry, { width, height, headers, scale: candidate, titles });
    return pages && pages.every(page => (!widthPages || page.col < widthPages) && (!heightPages || page.row < heightPages));
  };
  if (fits(ceiling)) return ceiling;
  let lo = 10, hi = Math.round(ceiling * 100);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid / 100)) lo = mid; else hi = mid - 1;
  }
  return lo / 100;
}

const sum = values => values.reduce((a, b) => a + b, 0);
const prefix = values => { const out = [0]; for (const n of values) out.push(out.at(-1) + n); return out; };
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const box = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });

/** Read geometry once, before changing the DOM. No workbook state is mutated. */
function sheetGeometry(sheet, scale, table, frame) {
  if (!(frame.width > 0 && frame.height > 0)) return null;
  const local = node => {
    const r = node.getBoundingClientRect();
    return box((r.left - frame.left) / scale, (r.top - frame.top) / scale, r.width / scale, r.height / scale);
  };
  const cols = [...table.querySelector('colgroup').children].map(local), rows = [...table.rows];
  const widths = cols.map(c => c.width), heights = rows.map(row => local(row).height);
  if (!widths.length || !heights.length || !(sum(widths) > 0 && sum(heights) > 0)) return null;
  const xs = prefix(widths), ys = prefix(heights), active = new Array(cols.length).fill(0), cells = [];
  rows.forEach((row, r) => {
    let c = 0;
    for (const node of row.cells) {
      while (active[c] > r) c++;
      const end = Math.min(cols.length, c + node.colSpan), bottom = Math.min(rows.length, r + node.rowSpan);
      const rect = local(node), spill = node.classList.contains('spill') && node.querySelector('.print-cell');
      const paint = spill ? local(spill) : rect;
      cells.push({ node, r, bottom, c, end, rect, paint,
        ...(table.classList.contains('has-print-borders') ? { borders: cellPrintBorders(node, rect) } : {}) });
      for (let j = c; j < end; j++) active[j] = bottom;
      c = end;
    }
  });
  return { table, rows, widths, heights, xs, ys, cells, width: frame.width / scale, height: frame.height / scale,
    insetX: cols[0]?.left || 0, insetY: local(rows[0]).top,
    headRows: table.tHead?.rows.length || 0,
    objects: [...sheet.children].filter(n => n !== table).map(node => ({ node, rect: local(node) })) };
}

/** Keep only painted cells in a fragment, collapsing unused rows/columns into
 * spacers. A crossing cell retains its complete original span and dimensions.
 * This avoids copying the entire sheet for each page. */
function cropSheet(source, g, rect, cells, objects, scale) {
  const colEdges = new Set([0, g.widths.length]), rowEdges = new Set([0, g.rows.length]);
  for (const cell of cells) { colEdges.add(cell.c); colEdges.add(cell.end); rowEdges.add(cell.r); rowEdges.add(cell.bottom); }
  const cs = [...colEdges].sort((a, b) => a - b), rs = [...rowEdges].sort((a, b) => a - b);
  const ci = new Map(cs.map((c, i) => [c, i])), ri = new Map(rs.map((r, i) => [r, i]));
  const table = g.table.cloneNode(false);
  // Column minima plus collapsed outer borders determine the original frame.
  // Transparent frame borders retain that geometry even when outside cells
  // have become spacers; visible cell borders still win border conflict rules.
  Object.assign(table.style, { width: `${g.width}px`, borderLeft: `${g.insetX * 2}px solid transparent`,
    borderRight: `${Math.max(0, g.width - g.xs.at(-1) - g.insetX) * 2}px solid transparent`,
    borderTop: `${g.insetY * 2}px solid transparent`,
    borderBottom: `${Math.max(0, g.height - g.ys.at(-1) - g.insetY) * 2}px solid transparent` });
  table.append(el('colgroup', {}, cs.slice(0, -1).map((c, i) => el('col', { style: { width: `${g.xs[cs[i + 1]] - g.xs[c]}px` } }))));
  const byRow = new Map();
  for (const cell of cells) { const list = byRow.get(cell.r) || []; list.push(cell); byRow.set(cell.r, list); }
  const active = new Array(cs.length - 1).fill(0), body = el('tbody');
  for (let r = 0; r < rs.length - 1; r++) {
    const row = g.rows[rs[r]].cloneNode(false);
    row.style.height = `${g.ys[rs[r + 1]] - g.ys[rs[r]]}px`;
    const at = new Map((byRow.get(rs[r]) || []).map(cell => [ci.get(cell.c), cell]));
    for (let c = 0; c < cs.length - 1;) {
      if (active[c] > r) { c++; continue; }
      const cell = at.get(c);
      if (cell) {
        const node = cell.node.cloneNode(true), end = ci.get(cell.end), bottom = ri.get(cell.bottom);
        copyMergedPrintBorders(cell.node, node);
        node.colSpan = end - c; node.rowSpan = bottom - r;
        for (let j = c; j < end; j++) active[j] = bottom;
        row.append(node); c = end;
      } else {
        let end = c + 1;
        while (end < cs.length - 1 && active[end] <= r && !at.has(end)) end++;
        row.append(el('td', { colSpan: end - c, style: { border: 'none', padding: '0', height: '0' } })); c = end;
      }
    }
    body.append(row);
  }
  table.append(body);
  const inner = source.cloneNode(false);
  Object.assign(inner.style, { width: `${g.width}px`, zoom: String(scale), marginLeft: `${-rect.left}px`, marginTop: `${-rect.top}px` });
  inner.append(table, ...objects.map(obj => obj.node.cloneNode(true)));
  return el('div.print-page-clip', { style: { width: `${rect.width * scale}px`, height: `${rect.height * scale}px` } }, inner);
}

/** Calculate complete page ink bounds without allocating DOM fragments. */
function printPageGeometry(g, { width, height, overflowRight = 0, overflowBottom = 0, headers = false, pageOrder, scale, titles, breaks }) {
  // Include collapsed outer borders in the first/last line, so exact page
  // fits neither discard the frame nor cause a spurious trailing page.
  const framed = (sizes, inset, extent) => {
    const out = [...sizes];
    out[0] += inset;
    out[out.length - 1] += Math.max(0, extent - sum(sizes) - inset);
    return out;
  };
  const bands = (sizes, capacity, repeat, titles, forced) => {
    if (titles) return printTitleBands(sizes, capacity, titles, forced);
    const result = printBands(sizes, capacity, repeat, forced);
    return result?.bands.map(b => {
      // Keep accumulated binary rounding at an exact boundary from turning
      // an ordinary page into an oversized paint region.
      const extent = b.extent - b.size > Number.EPSILON * Math.max(capacity, b.extent) * (b.end - b.start + 2) ? b.extent : b.size;
      return { size: result.repeated + b.size, paintSize: result.repeated + extent, segments: [
        ...(result.repeated ? [{ offset: 0, size: result.repeated }] : []),
        ...(extent ? [{ offset: b.offset, size: extent }] : []),
      ] };
    });
  };
  const bordered = g.cells.some(cell => cell.borders);
  const fragments = (capacityWidth, capacityHeight) => {
    const x = bands(framed(g.widths, g.insetX, g.width), capacityWidth / scale, headers ? 1 : 0, titles?.cols, breaks?.cols);
    const y = bands(framed(g.heights, g.insetY, g.height), capacityHeight / scale, g.headRows, titles?.rows, breaks?.rows);
    if (!x?.length || !y?.length) return null;
    const pages = [];
    for (let col = 0; col < x.length; col++) for (let row = 0; row < y.length; row++) {
      const a = x[col], b = y[row], regions = [];
      // Page breaking uses the content box, but a forced oversized line (or an
      // overfull repeated title) paints into the trailing margin. Clip
      // that paint at the physical page edge while reserving only content space.
      const paintWidth = Math.min(a.paintSize ?? a.size, (width + overflowRight) / scale);
      const paintHeight = Math.min(b.paintSize ?? b.size, (height + overflowBottom) / scale);
      let dy = 0;
      for (const vertical of b.segments) {
        let dx = 0;
        for (const horizontal of a.segments) {
          const w = Math.min(horizontal.size, paintWidth - dx), h = Math.min(vertical.size, paintHeight - dy);
          if (w > 0 && h > 0) regions.push({ rect: box(horizontal.offset, vertical.offset, w, h), dx, dy, cells: [], objects: [] });
          dx += horizontal.size;
        }
        dy += vertical.size;
      }
      pages.push({ col, row, width: a.size * scale, height: b.size * scale, overflow: paintWidth > a.size || paintHeight > b.size,
        rightOverflow: paintWidth > a.size, bottomOverflow: paintHeight > b.size, regions });
    }
    // Distribute once per row/column band rather than cloning a full table per
    // page. Only content actually crossing a page boundary is duplicated.
    const index = new Map();
    for (const region of pages.flatMap(p => p.regions)) {
      const key = `${region.rect.top}:${region.rect.bottom}`;
      const row = index.get(key) || { start: region.rect.top, end: region.rect.bottom, columns: new Map() };
      const xkey = `${region.rect.left}:${region.rect.right}`;
      const col = row.columns.get(xkey) || { start: region.rect.left, end: region.rect.right, regions: [] };
      col.regions.push(region); row.columns.set(xkey, col); index.set(key, row);
    }
    const rows = [...index.values()].sort((a, b) => a.start - b.start);
    for (const row of rows) row.columns = [...row.columns.values()].sort((a, b) => a.start - b.start);
    // Interior titles overlap the first page's body interval. Prefix maxima
    // keep bisection valid for these nested intervals as well as disjoint bands.
    for (const list of [rows, ...rows.map(r => r.columns)]) {
      let end = 0;
      for (const item of list) item.endMax = end = Math.max(end, item.end);
    }
    const each = (list, lo, hi, visit) => {
      let a = 0, b = list.length;
      while (a < b) { const m = (a + b) >> 1; if (list[m].endMax <= lo) a = m + 1; else b = m; }
      for (let i = a; i < list.length && list[i].start < hi; i++) visit(list[i]);
    };
    const distribute = (item, key) => {
      const rect = item.rect, paint = item.paint || rect;
      each(rows, Math.min(rect.top, paint.top), Math.max(rect.bottom, paint.bottom), row =>
        each(row.columns, Math.min(rect.left, paint.left), Math.max(rect.right, paint.right), col => {
          for (const region of col.regions) if (overlap(rect, region.rect) || overlap(paint, region.rect)) region[key].push(item);
        }));
    };
    for (const cell of g.cells) distribute(cell, 'cells');
    for (const object of g.objects) distribute(object, 'objects');
    if (bordered) {
      let excessWidth = 0, excessHeight = 0;
      for (const page of pages) {
        const ink = { left: 0, top: 0, right: page.width / scale, bottom: page.height / scale };
        for (const region of page.regions) {
          const bounds = printBorderInkBounds(clipPrintBorderEdges(region.cells.flatMap(c => c.borders), region.rect));
          ink.left = Math.min(ink.left, bounds.left - region.rect.left + region.dx);
          ink.right = Math.max(ink.right, bounds.right - region.rect.left + region.dx);
          ink.top = Math.min(ink.top, bounds.top - region.rect.top + region.dy);
          ink.bottom = Math.max(ink.bottom, bounds.bottom - region.rect.top + region.dy);
        }
        page.insetX = -ink.left; page.insetY = -ink.top;
        // Border ink belongs to the page's geometry. In particular, negative
        // overflow at a page start is otherwise printed on the preceding page.
        const inkWidth = (ink.right - ink.left) * scale, inkHeight = (ink.bottom - ink.top) * scale;
        if (!page.rightOverflow) excessWidth = Math.max(excessWidth, inkWidth - width);
        if (!page.bottomOverflow) excessHeight = Math.max(excessHeight, inkHeight - height);
        page.width = page.rightOverflow ? Math.min(width, page.width - ink.left * scale) : inkWidth;
        page.height = page.bottomOverflow ? Math.min(height, page.height - ink.top * scale) : inkHeight;
      }
      // Rebreak only if actual ink exceeds the budget. Every retry reduces the
      // capacity by a measured overhang; oversized single lines retain the
      // existing margin-overflow policy rather than causing an endless retry.
      const tolerance = Number.EPSILON * Math.max(width, height) * (g.cells.length + 2);
      if (excessWidth > tolerance || excessHeight > tolerance) return fragments(
        capacityWidth - (excessWidth > tolerance ? excessWidth : 0),
        capacityHeight - (excessHeight > tolerance ? excessHeight : 0));
    }
    if (pageOrder === 'overThenDown') pages.sort((a, b) => a.row - b.row || a.col - b.col);
    return pages;
  };
  return fragments(width, height);
}

/** Split a worksheet after fitting, with repeated headings in independent
 * clipped regions. The returned page bodies have explicit physical dimensions,
 * preventing the browser's automatic shrink-to-fit of horizontal overflow. */
export function paginatePrintColumns(sheet, { width, height, overflowRight = 0, overflowBottom = 0, headers = false, pageOrder = 'downThenOver', force = false }) {
  const table = sheet.querySelector('.print-table');
  if (!table) return null;
  const frame = table.getBoundingClientRect();
  // Ordinary narrow sheets still use the browser's table pagination. A single
  // oversized row needs explicit fragments so its paint can enter the margin
  // without introducing a second page for the remainder of that row.
  const titles = titleAxes.get(table), breaks = breakAxes.get(table);
  if (!force && !(frame.width > width) && !titles && !breaks && !(frame.height > height
    && Array.from(table.rows).some(row => row.getBoundingClientRect().height > height))) return null;
  const scale = Number(sheet.style.zoom) || 1, g = sheetGeometry(sheet, scale, table, frame);
  if (!g) return null;
  const pages = printPageGeometry(g, { width, height, overflowRight, overflowBottom, headers, pageOrder, scale, titles, breaks });
  if (!pages) return null;
  return pages.map(page => {
    const node = el('div.print-page', { style: { width: `${page.width}px`, height: `${page.height}px` } });
    if (page.overflow) {
      node.classList.add('print-page-overflow');
      node.classList.toggle('print-page-overflow-bottom', page.bottomOverflow);
      node.classList.toggle('print-page-overflow-right', page.rightOverflow);
      node.style.setProperty('--print-overflow-margin', `${Math.max(overflowRight, overflowBottom)}px`);
    }
    for (const region of page.regions) {
      const clip = cropSheet(sheet, g, region.rect, region.cells, region.objects, scale);
      clip.style.left = `${(region.dx + (page.insetX || 0)) * scale}px`; clip.style.top = `${(region.dy + (page.insetY || 0)) * scale}px`; node.append(clip);
    }
    return node;
  });
}
