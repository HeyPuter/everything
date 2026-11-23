import { tableBorderColor } from './colors.js';
import { borderWidth } from './paragraph-borders.js';
import { rowGrid, spanWidth } from './tables.js';
import { effectiveCellBorders, resolveCellBorders, rowTableBorder } from './cell-borders.js';
import { joinTableBorderCorner, joinTableBorderCrossing } from './table-border-corners.js';
import { borderBands } from './border-patterns.js';

export const tableBorderWidth = border => borderWidth(border) * (border?.style === 'double' ? 3 : border?.style === 'triple' ? 5 : 1);

// Horizontal single/compound borders are allocated in whole twips before paint.
// Keep fractional authored stroke widths for ink and horizontal writing insets.
// Large/small gaps reserve 45/30 fixed twips plus the truncated authored width.
// Medium gaps double that truncated width (not separately truncated halves).
// Repeated minimum-height rows expose drift when paint widths reserve space.
export const tableBorderLayoutWidth = border => border?.style === 'single'
  ? Math.floor(border.size * 2.5) / 15
  : border?.style === 'thinThickLargeGap'
  ? (45 + Math.floor(border.size * 2.5)) / 15
  : ['thinThickSmallGap', 'thickThinSmallGap'].includes(border?.style) ? (30 + Math.floor(border.size * 2.5)) / 15
  : ['thinThickMediumGap', 'thickThinMediumGap'].includes(border?.style) ? 2 * Math.floor(border.size * 2.5) / 15
  : tableBorderWidth(border);

// A none border can reserve space without painting ink. Keep that extent
// separate from stroke width, including inherited conditional declarations.
export function cellBorderLayoutWidth(cell, side, border) {
  const source = border ?? cell.borders?.[side] ?? cell.directBorders?.[side];
  const width = border?.style === 'single' && (side === 'left' || side === 'right')
    ? tableBorderWidth(border) : tableBorderLayoutWidth(border);
  return Math.max(width, source?.style === 'none' ? (source.space || 0) * 4 / 3 : 0);
}

// Resolve logical horizontal boundaries before row height is known. Grid units
// suffice for overlap tests; final page fragments are resolved by the same rules.
export function tableRowBorderWidths(block, cellBorders, geometry, cellBottomWidths) {
  const cells = block.rows.flatMap((row, index) => rowGrid(row).map(({cell,column,span}) => {
    // Borders are reserved at each physical row boundary, including borders
    // whose ink is hidden inside a vertical merge.
    const rowSpan = 1;
    const borders = effectiveCellBorders(block.table,cell,index,column,span,rowSpan);
    cellBorders?.set(cell.id, borders);
    return { id:cell.id,tableId:block.table.id,page:0,x:geometry ? geometry.lefts[index] + spanWidth(geometry.widths,0,column) : column,y:index,width:geometry ? spanWidth(geometry.widths,column,span) : span,height:rowSpan,fill:cell.fill,borders };
  }));
  cellBottomWidths?.clear();
  if (cellBottomWidths) for (const cell of cells) cellBottomWidths.set(cell.id, { boundary: cell.y + 1, width: 0 });
  const widths = Array(block.rows.length + 1).fill(0);
  for (const stroke of layoutTableBorders(cells, true)) if (!stroke.guide) {
    const boundary = Math.round(stroke.y + stroke.height / 2);
    const extent = tableBorderLayoutWidth(stroke.border);
    widths[boundary] = Math.max(widths[boundary], extent);
    // Reuse the resolved segment's owners: a border in another column must
    // not add to this cell's padding, but an opposing winner still participates.
    if (cellBottomWidths) for (const id of stroke.cellIds) {
      const bottom = cellBottomWidths.get(id);
      if (bottom.boundary === boundary) bottom.width = Math.max(bottom.width, extent);
    }
  }
  for (const [index, row] of block.rows.entries()) for (const cell of row.cells) {
    widths[index] = Math.max(widths[index], cellBorderLayoutWidth(cell, 'top'));
    widths[index + 1] = Math.max(widths[index + 1], cellBorderLayoutWidth(cell, 'bottom'));
  }
  return widths;
}

// Nested tables and compatibility mode 15 and later align the first row's outer ink edge to the
// writing area. Wider borders in later rows can extend beyond that edge.
// Legacy top-level tables with a resolved indent align their writing edges;
// legacy tables without an indent declaration retain grid alignment (native legacy-table controls).
export function tableHorizontalInsets(block, cellBorders, page) {
  const legacy = !block.table.parentCellId && (page.compatibilityMode ?? 12) < 15;
  const alignment = {};
  if (legacy) {
    let firstLeft = 0, automaticLeft = 0;
    for (const { cell, column } of rowGrid(block.rows[0])) {
      const borders = cellBorders.get(cell.id);
      if (column === 0) {
        firstLeft = Math.max(cell.margins.left / 15, cellBorderLayoutWidth(cell, 'left', borders.left) / 2);
        // An omitted indent is established from direct/table borders before
        // conditional cell styles change the painted edge and writing inset.
        const direct = resolveCellBorders({}, cell.directBorders).left;
        const base = direct ?? rowTableBorder(block.table, 0, 'left');
        automaticLeft = Math.max(cell.margins.left / 15, cellBorderLayoutWidth(cell, 'left', base) / 2);
      }
    }
    alignment.alignmentLeft = block.table.indentDeclared || block.table.indentChanged ? -firstLeft : automaticLeft - firstLeft;
    // Native asymmetric controls: right justification uses the leading inset,
    // while centered legacy tables keep their grid centered.
    alignment.alignmentRight = -firstLeft;
    alignment.alignmentCenter = 0;
  }
  if (legacy && block.table.width?.type !== 'pct' && block.table.layout !== 'autofit') return { left: 0, right: 0, widthAdjustment: 0, ...alignment };
  let left = 0, right = 0, leftMargin = 0, rightMargin = 0;
  for (const row of legacy ? block.rows : block.rows.slice(0, 1)) for (const { cell, column, end } of rowGrid(row)) {
    const borders = cellBorders.get(cell.id);
    if (column === 0) {
      left = Math.max(left, cellBorderLayoutWidth(cell, 'left', borders.left) / 2);
      leftMargin = Math.max(leftMargin, cell.margins.left / 15, cellBorderLayoutWidth(cell, 'left', borders.left) / 2);
    }
    if (end === block.table.grid.length) {
      right = Math.max(right, cellBorderLayoutWidth(cell, 'right', borders.right) / 2);
      rightMargin = Math.max(rightMargin, cell.margins.right / 15, cellBorderLayoutWidth(cell, 'right', borders.right) / 2);
    }
  }
  // Legacy percentage preferences include the exterior cells' writing insets.
  // Absolute AutoFit preferences keep their size, but the page-width limit
  // permits the exterior insets when content needs additional space. A left
  // table with no indent declaration keeps its grid at the writing edge, so
  // only the trailing inset contributes extra width in that case.
  return legacy ? { left: 0, right: 0, ...alignment, widthAdjustment: block.table.width?.type === 'pct' ? leftMargin + rightMargin : 0,
    overflowWidthAdjustment: block.table.width?.type === 'pct' ? 0 : rightMargin +
      (block.rows.some(row => (row.alignment ?? block.table.alignment ?? 'left') !== 'left') ? leftMargin : -alignment.alignmentLeft) } : { left, right, widthAdjustment: 0 };
}

// MS-OI29500 §17.4.66: width-weighted conflict resolution, with its
// exceptions for dotted/dashed and ordered color tie breaks. Independent native
// probes show a visible opposing edge wins over nil, despite the nil-suppression
// wording in the published implementation note.
const rank = { single: 1, thick: 2, double: 3, dotted: 4, dashed: 5, dotDash: 8, dotDotDash: 9, triple: 10, thinThickSmallGap: 11, thickThinSmallGap: 12, thinThickMediumGap: 14, thickThinMediumGap: 15, thinThickLargeGap: 17, dashSmallGap: 22 };
const weight = b => ['dotted', 'dashed'].includes(b.style) ? 1 : b.size * rank[b.style];
const brightness = edge => {
  const [r, g, b] = tableBorderColor(edge.border.color).slice(1).match(/../g).map(v => parseInt(v, 16));
  return [r + b + 2 * g, b + 2 * g, g];
};
export function winningTableBorder(first, second) {
  if (!first) return second;
  const a = first.border, b = second.border;
  if (a?.style === 'nil') return second;
  if (b?.style === 'nil') return first;
  if (!borderWidth(a)) return second;
  if (!borderWidth(b)) return first;
  // Shared definitions have equal paint colors regardless of cell shading.
  if (a === b) return first.order <= second.order ? first : second;
  const difference = weight(a) - weight(b);
  if (difference) return difference > 0 ? first : second;
  if (a.style !== b.style) return rank[a.style] < rank[b.style] ? first : second;
  const av = brightness(first), bv = brightness(second);
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return av[i] < bv[i] ? first : second;
  return first.order <= second.order ? first : second;
}

/** Split shared physical edges at every T-junction after pagination. Paint each
 * winning segment once, including merged rectangles and repeated header copies. */
export function layoutTableBorders(cells, horizontalOnly = false) {
  return placeTableBorders(cells, horizontalOnly, !horizontalOnly && needsBorderOutsets(cells)).strokes;
}

const needsBorderOutsets = cells => cells.some(cell => cell.borderInsets &&
  (cell.pageBottomBorder || cell.borderInsets.top || tableBorderWidth(cell.borders.bottom) - cell.borderInsets.bottom));

// The strokes of `cells` (layoutTableBorders), and where the caps of hidden merged rules begin among them.
function placeTableBorders(cells, horizontalOnly, needsOutsets) {
  const groups = new Map(), quantum = value => Math.round(value * 1e6) / 1e6;
  const fragments = new Map();
  // Borderless fragments have no exterior ink to extend. Avoid constructing
  // page-edge lookup data when every vertical endpoint remains unchanged.
  if (needsOutsets) for (const cell of cells) {
    const key = `${cell.tableId}:${cell.page}:${cell.column ?? 0}`, top = quantum(cell.y), bottom = quantum(cell.y + cell.height);
    const extent = fragments.get(key);
    if (extent) { extent.top = Math.min(extent.top, top); extent.bottom = Math.max(extent.bottom, bottom); }
    else fragments.set(key, { top, bottom });
  }
  for (const [order, cell] of cells.entries()) {
    const left = quantum(cell.x), right = quantum(cell.x + cell.width);
    const top = quantum(cell.y), bottom = quantum(cell.y + cell.height);
    const extent = fragments.get(`${cell.tableId}:${cell.page}:${cell.column ?? 0}`);
    const borders = cell.pageBottomBorder && bottom === extent?.bottom ? { ...cell.borders, bottom: cell.pageBottomBorder } : cell.borders;
    let verticalStart = top, verticalEnd = bottom;
    // A cell shares these coordinates across both vertical sides. Horizontal
    // prepasses need neither the physical-fragment lookup nor its outsets.
    if (needsOutsets && cell.borderInsets) {
      const topOutset = top === extent.top ? cell.borderInsets.top : 0;
      const bottomOutset = bottom === extent.bottom ? tableBorderWidth(borders.bottom) - cell.borderInsets.bottom : 0;
      verticalStart = quantum(cell.y - topOutset);
      verticalEnd = quantum(cell.y + cell.height + bottomOutset);
    }
    for (const side of horizontalOnly ? ['top', 'bottom'] : ['top', 'left', 'bottom', 'right']) {
      const horizontal = side === 'top' || side === 'bottom';
      const position = horizontal ? side === 'top' ? top : bottom : side === 'left' ? left : right;
      const key = `${cell.tableId}:${cell.page}:${cell.column ?? 0}:${horizontal}:${position}`;
      if (!groups.has(key)) groups.set(key, { tableId: cell.tableId, page: cell.page, column: cell.column, horizontal, position, edges: [] });
      const segments = !horizontal && cell.sideBorders ? cell.sideBorders.map(segment => ({
        start: segment.start === 0 ? verticalStart : quantum(cell.y + segment.start),
        end: Math.abs(segment.end - cell.height) < 1e-6 ? verticalEnd : quantum(cell.y + segment.end),
        border: segment[side],
      })) : [{start: horizontal ? left : verticalStart, end: horizontal ? right : verticalEnd, border: borders[side]}];
      for (const {start, end, border} of segments) groups.get(key).edges.push({ start, end, logicalStart: horizontal ? left : start === verticalStart ? top : start, logicalEnd: horizontal ? right : end === verticalEnd ? bottom : end, side, border, inset: cell.borderInsets?.[side], background: cell.fill || '#FFFFFF', cellId: cell.id, ...(cell.cellClip ? { cellClip: cell.cellClip } : {}), order: [cell.y, cell.x, order] });
    }
  }
  const result = [], corners = new Map();
  for (const { tableId, page, column, horizontal, position, edges } of groups.values()) {
    // Coordinate order is reading order, independent of header-copy insertion.
    edges.sort((a,b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]); edges.forEach((e,i) => { e.order = i; });
    const events = new Map();
    for (const edge of edges) for (const [at, begin] of [[edge.start, true], [edge.end, false]]) {
      if (!events.has(at)) events.set(at, []); events.get(at).push({ edge, begin });
    }
    const stops = [...events.keys()].sort((a,b) => a-b), active = new Set();
    for (let i = 0; i < stops.length - 1; i++) {
      const at = stops[i], length = stops[i + 1] - at;
      for (const { edge, begin } of events.get(at)) { if (begin) active.add(edge); else active.delete(edge); }
      if (!active.size || !length) continue;
      const candidates = [...active], winner = candidates.reduce(winningTableBorder, null), border = winner.border, inkWidth = tableBorderWidth(border), thickness = inkWidth || .5;
      // Keep paint inside the reserved outer edges, including when compound
      // band quantization differs from layout width. An explicit zero reserve
      // is meaningful; the horizontal prepass still uses centered ink.
      let inset = thickness / 2;
      const exposedBottom = horizontal && winner.side === 'bottom' && !candidates.some(edge => edge.side === 'top');
      if (!horizontalOnly && horizontal && inkWidth) {
        const reservedInset = Math.max(...candidates.map(edge => edge.inset ?? thickness / 2));
        // Shared row boundaries align to the leading edge of the row reserve,
        // even when the winning declaration comes from the preceding cell.
        // Only an exposed bottom edge aligns ink to the trailing reserve.
        inset = exposedBottom ? thickness - reservedInset : reservedInset;
      }
      const stroke = { tableId, page, ...(column !== undefined ? { column } : {}), horizontal, side: winner.side, ...(exposedBottom ? { exposedBottom: true } : {}), border, background: winner.background, guide: !inkWidth, cellIds: candidates.map(e => e.cellId), ...(winner.cellClip ? { cellClip: winner.cellClip } : {}),
        ...(!horizontal && ['thinThickLargeGap', 'thinThickSmallGap', 'thickThinSmallGap', 'thinThickMediumGap', 'thickThinMediumGap'].includes(border?.style) ? { bodyBands: borderBands(border, thickness, 'right') } : {}),
        x: horizontal ? at : position - thickness / 2, y: horizontal ? position - inset : at, width: horizontal ? length : thickness, height: horizontal ? thickness : length };
      result.push(stroke);
      if (!horizontalOnly && inkWidth) for (const [first, coordinate] of [[true, at === winner.start ? winner.logicalStart : at], [false, stops[i + 1] === winner.end ? winner.logicalEnd : stops[i + 1]]]) {
        const key = `${tableId}:${page}:${column ?? 0}:${horizontal ? coordinate : position}:${horizontal ? position : coordinate}`;
        if (!corners.has(key)) corners.set(key, []);
        corners.get(key).push({ stroke, first, y: horizontal ? position : coordinate });
        // Relative logical junctions survive header/footer translation. The
        // screen painter can rebuild joins after quantizing device widths.
        (stroke.junctions ||= []).push({ first, x: (horizontal ? coordinate : position) - stroke.x, y: (horizontal ? position : coordinate) - stroke.y });
      }
    }
  }
  for (const edges of corners.values()) {
    // An exposed leading cap is extended on a solid outer bottom edge by
    // one CSS pixel. Top/internal edges and joined corners retain their geometry.
    // Keep this paint-only, including when a parent cell clips the extra ink.
    const edge = edges[0], stroke = edge.stroke;
    if (edges.length === 1 && edge.first && stroke.horizontal && stroke.side === 'bottom' && stroke.border.style === 'single' && edge.y === fragments.get(`${stroke.tableId}:${stroke.page}:${stroke.column ?? 0}`)?.bottom) {
      stroke.bandEnds = [[-1, stroke.width]];
    }
    joinTableBorderCorner(edges);
    joinTableBorderCrossing(edges);
  }
  const capsStart = result.length;
  // A merge hides interior horizontal rules, but their short caps remain
  // where an exposed vertical side changes format. Visible T-junctions above
  // already own those intersections; only add caps on otherwise hidden rules.
  if (!horizontalOnly) for (const cell of cells) for (let i = 1; i < (cell.sideBorders?.length || 0); i++) {
    const before = cell.sideBorders[i - 1], after = cell.sideBorders[i];
    if (Math.abs(before.end - after.start) > 1e-6) continue;
    const y = quantum(cell.y + after.start);
    for (const side of ['left', 'right']) {
      const a = before[side], b = after[side];
      if (['style','size','color','frame','shadow'].every(key=>a?.[key]===b?.[key])) continue;
      const x = quantum(cell.x + (side === 'right' ? cell.width : 0));
      const key = `${cell.tableId}:${cell.page}:${cell.column ?? 0}:${x}:${y}`;
      if (corners.get(key)?.some(e=>e.stroke.horizontal)) continue;
      const candidate = (border, order) => ({border,order,background:cell.fill || '#FFFFFF'});
      const border = winningTableBorder(candidate(before.bottom,0),candidate(after.top,1)).border;
      const height = tableBorderWidth(border), width = Math.max(tableBorderWidth(a),tableBorderWidth(b));
      if (!height || !width) continue;
      const cap = {tableId:cell.tableId,page:cell.page,column:cell.column,horizontal:true,side:'top',border,guide:false,
        background:cell.fill || '#FFFFFF',cellIds:[cell.id],x:x-width/2,
        y:y-Math.max(height/2,before.bottomInset || 0,after.topInset || 0),width,height,
        ...(cell.cellClip ? {cellClip:cell.cellClip} : {})};
      cap.junctionCap = { x: x - cap.x, y: y - cap.y };
      for (const {stroke} of corners.get(key) || []) if (!stroke.horizontal)
        (stroke.crossingCuts ||= []).push({x:cap.x-stroke.x,y:cap.y-stroke.y,width,height});
      result.push(cap);
    }
  }
  return { strokes: result, capsStart };
}

// Everything placing a table's borders reads of one of its cells, exactly (exactText).
const CELL_BORDER_INPUTS = ['id', 'tableId', 'page', 'column', 'x', 'y', 'width', 'height', 'fill', 'borders', 'borderInsets', 'pageBottomBorder', 'sideBorders', 'cellClip'];

/**
 * A short, exact name for `value`: equal names only for equal values (numbers by their exact text, so NaN,
 * infinities and -0 stay apart). Objects are named once per placing (`seen`), and the texts' names
 * (`names`) last as long as the cache's remembered tables.
 */
function exactText(value, seen, names) {
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? JSON.stringify(value) : Object.is(value, -0) ? '-0' : String(value);
  let name = seen.get(value);
  if (name !== undefined) return name;
  const text = Array.isArray(value) ? `[${value.map(item => exactText(item, seen, names)).join(',')}]`
    : `{${Object.keys(value).map(key => `${JSON.stringify(key)}:${exactText(value[key], seen, names)}`).join(',')}}`;
  name = names.get(text);
  if (name === undefined) names.set(text, name = `#${names.size}`);
  seen.set(value, name);
  return name;
}

/** Table borders (layoutTableBorders) remembered across layouts for each table whose cells are as before. */
export class TableBorderCache {
  constructor(limit = 50000) { this.limit = limit; this.names = new Map(); this.tables = new Map(); }
  clear() { this.names.clear(); this.tables.clear(); }
}

/**
 * layoutTableBorders(cells), reusing `cache`'s strokes for every table whose cells read the same as in an earlier
 * layout: typing outside a long document's tables places none of their borders again. A table's strokes depend
 * only on its own cells (and whether any cell of the layout needs outsets), and its caps follow every table's
 * other strokes; the same order holds whenever each table's cells are together, as pagination places them.
 */
export function cachedTableBorders(cells, cache, generation) {
  if (!cache) return layoutTableBorders(cells);
  const tables = [], seenTables = new Set();
  for (const cell of cells) {
    if (tables.at(-1)?.tableId !== cell.tableId) {
      if (seenTables.has(cell.tableId)) return layoutTableBorders(cells);
      seenTables.add(cell.tableId);
      tables.push({ tableId: cell.tableId, cells: [] });
    }
    tables.at(-1).cells.push(cell);
  }
  if (cache.names.size > cache.limit) cache.clear();
  const needsOutsets = needsBorderOutsets(cells), seen = new WeakMap();
  const strokes = [], caps = [];
  for (const table of tables) {
    const key = `${needsOutsets}\n${table.cells.map(cell => CELL_BORDER_INPUTS.map(input => exactText(cell[input], seen, cache.names)).join('|')).join('\n')}`;
    let entry = cache.tables.get(key);
    if (!entry) {
      const placed = placeTableBorders(table.cells, false, needsOutsets);
      cache.tables.set(key, entry = { strokes: placed.strokes.slice(0, placed.capsStart), caps: placed.strokes.slice(placed.capsStart) });
    }
    entry.used = generation;
    for (const stroke of entry.strokes) strokes.push(stroke);
    for (const cap of entry.caps) caps.push(cap);
  }
  // Tables the last few layouts (`generation`, as the measured paragraphs count them) did not use are forgotten.
  for (const [key, entry] of cache.tables) if (entry.used < generation - 4) cache.tables.delete(key);
  for (const cap of caps) strokes.push(cap);
  return strokes;
}
