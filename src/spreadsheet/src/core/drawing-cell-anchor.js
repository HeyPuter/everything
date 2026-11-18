import { MAX_ROW, MAX_COL } from './refs.js';

const marker = p => p && Number.isInteger(p.r) && p.r >= 0 && p.r <= MAX_ROW
  && Number.isInteger(p.c) && p.c >= 0 && p.c <= MAX_COL
  && Number.isFinite(p.dx) && Number.isFinite(p.dy) ? { r: p.r, c: p.c, dx: p.dx, dy: p.dy } : null;

/** Native two-cell anchors. A box retains a flattened group's affine frame. */
export function normalizeCellAnchor(raw) {
  const from = marker(raw?.from), to = marker(raw?.to), box = raw?.box ?? [0, 0, 1, 1];
  if (!from || !to || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
    || box[2] < 0 || box[3] < 0) return null;
  return { from, to, ...(['oneCell', 'absolute'].includes(raw.editAs) ? { editAs: raw.editAs } : {}),
    ...(box.some((v, i) => v !== [0, 0, 1, 1][i]) ? { box: [...box] } : {}) };
}

/** Sparse prefix sums shared by every drawing in a layout pass. */
export function drawingAxisOffsets(sheet, axis) {
  const rows = axis === 'row', sizes = rows ? sheet.rowHeights : sheet.colWidths;
  const fallback = rows ? sheet.defaultRowHeight : sheet.defaultColWidth;
  const hidden = rows ? new Set([...sheet.hiddenRows, ...sheet.filterHidden]) : sheet.hiddenCols;
  const changes = new Map(sizes);
  for (const i of hidden) changes.set(i, 0);
  const entries = [...changes].sort((a, b) => a[0] - b[0]);
  let sum = 0;
  const prefix = entries.map(([i, size]) => [i, sum += size - fallback]);
  return count => {
    let lo = 0, hi = prefix.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (prefix[mid][0] < count) lo = mid + 1; else hi = mid; }
    return count * fallback + (lo ? prefix[lo - 1][1] : 0);
  };
}
export const drawingAxisOffset = (sheet, axis, count) => drawingAxisOffsets(sheet, axis)(count);
const metrics = sheet => ({ col: drawingAxisOffsets(sheet, 'col'), row: drawingAxisOffsets(sheet, 'row') });

export function cellAnchorFrame(sheet, cellAnchor, offsets = metrics(sheet)) {
  const { from, to } = cellAnchor;
  return { anchor: { r: from.r, c: from.c }, dx: from.dx, dy: from.dy,
    w: Math.max(0, offsets.col(to.c) - offsets.col(from.c) + to.dx - from.dx),
    h: Math.max(0, offsets.row(to.r) - offsets.row(from.r) + to.dy - from.dy) };
}

export function resolveCellDrawing(sheet, obj, offsets) {
  if (!obj.cellAnchor || obj.cellAnchor.editAs || obj.anchorMode === 'absolute') return obj;
  const frame = cellAnchorFrame(sheet, obj.cellAnchor, offsets), [x, y, w, h] = obj.cellAnchor.box ?? [0, 0, 1, 1];
  const box = { dx: frame.dx + x * frame.w, dy: frame.dy + y * frame.h, w: w * frame.w, h: h * frame.h };
  return obj.anchor.r === frame.anchor.r && obj.anchor.c === frame.anchor.c && Object.keys(box).every(k => obj[k] === box[k])
    ? obj : { ...obj, anchor: frame.anchor, ...box };
}

/** Preserve native initial markers only while they describe the fixed object. */
export function exportCellAnchor(sheet, obj, offsets) {
  if (!obj.cellAnchor?.editAs) return obj.cellAnchor;
  offsets ??= metrics(sheet);
  const frame = cellAnchorFrame(sheet, obj.cellAnchor, offsets), [x, y, w, h] = obj.cellAnchor.box ?? [0, 0, 1, 1];
  // Readers resolve initial cell markers with their own font metrics. After
  // an edit changes that frame, serialize the fixed pixel bounds instead.
  // Keep the record in the model so a layout undo can recover the original.
  return Math.abs(offsets.col(frame.anchor.c) + frame.dx + x * frame.w - offsets.col(obj.anchor.c) - obj.dx) < 1 / 9525
    && Math.abs(offsets.row(frame.anchor.r) + frame.dy + y * frame.h - offsets.row(obj.anchor.r) - obj.dy) < 1 / 9525
    && Math.abs(w * frame.w - obj.w) < 1 / 9525 && Math.abs(h * frame.h - obj.h) < 1 / 9525 ? obj.cellAnchor : null;
}

export function refreshCellDrawings(sheet) {
  if (!sheet.charts.some(c => c.cellAnchor)) return;
  const offsets = metrics(sheet), charts = sheet.charts.map(c => resolveCellDrawing(sheet, c, offsets));
  if (charts.some((c, i) => c !== sheet.charts[i])) sheet.charts = charts;
}

function atPixel(offset, axis, value) {
  let lo = 0, hi = axis === 'row' ? MAX_ROW : MAX_COL;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (offset(mid) <= value) lo = mid; else hi = mid - 1;
  }
  return [lo, value - offset(lo)];
}

/** The last row and column a drawing lies over: the cell under its far corner. */
export function drawingFarCell(sheet, obj, offsets = metrics(sheet)) {
  const far = (offset, axis, at, size) => atPixel(offset, axis, Math.max(0, offset(at) + size - 0.01))[0];
  return { r: far(offsets.row, 'row', obj.anchor.r, obj.dy + obj.h), c: far(offsets.col, 'col', obj.anchor.c, obj.dx + obj.w) };
}
/** Both axes' offsets, for a pass over several drawings (see drawingAxisOffsets). */
export const drawingOffsets = metrics;

/** A drag/resize creates new markers at the edited object's actual corners. */
export function reanchorCellDrawing(sheet, obj) {
  if (obj.cellAnchor?.editAs) return obj;
  if (!obj.cellAnchor || obj.anchorMode === 'absolute') return obj;
  const offsets = metrics(sheet), x = offsets.col(obj.anchor.c) + obj.dx, y = offsets.row(obj.anchor.r) + obj.dy;
  const [c, dx] = atPixel(offsets.col, 'col', x + obj.w), [r, dy] = atPixel(offsets.row, 'row', y + obj.h);
  return { ...obj, cellAnchor: { from: { ...obj.anchor, dx: obj.dx, dy: obj.dy }, to: { r, c, dx, dy } } };
}

export function mapCellDrawing(obj, map) {
  if (!obj.cellAnchor || obj.anchorMode === 'absolute') return {};
  return { cellAnchor: { ...obj.cellAnchor, from: map({ ...obj.cellAnchor.from }), to: map({ ...obj.cellAnchor.to }) } };
}
