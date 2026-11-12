/**
 * Artboard operations. Artboards live in `doc.root.artboards` as plain
 * { id, name, x, y, w, h } records (plus optional display flags), so every
 * change is a root update inside a transaction and undoes like any edit.
 *
 * "Artwork on an artboard" means the top-level objects (direct children of
 * unlocked, visible layers) whose bounds overlap that artboard more than any
 * other artboard; those move with the artboard when "Move/Copy Artwork with
 * Artboard" is on.
 */
import { uid } from '../../lib/ids.js';
import { nodeBounds, visualBounds, unionRect, transformNodes } from '../../model/geometry.js';
import { translate } from '../../lib/matrix.js';

/**
 * The largest artboard size and position in points. Imports cap artboards at the same size; far
 * beyond it the view's coordinates lose too much precision to draw or edit.
 */
export const ARTBOARD_MAX = 1e6;
const size = (v) => Math.min(ARTBOARD_MAX, Math.max(1, v));
const place = (v) => Math.min(ARTBOARD_MAX, Math.max(-ARTBOARD_MAX, v));

/** Common artboard size presets in points (portrait where it applies). */
export const ARTBOARD_PRESETS = [
  { id: 'letter', label: 'Letter', w: 612, h: 792 },
  { id: 'legal', label: 'Legal', w: 612, h: 1008 },
  { id: 'tabloid', label: 'Tabloid', w: 792, h: 1224 },
  { id: 'a5', label: 'A5', w: 419.528, h: 595.276 },
  { id: 'a4', label: 'A4', w: 595.276, h: 841.89 },
  { id: 'a3', label: 'A3', w: 841.89, h: 1190.551 },
  { id: 'b5', label: 'B5', w: 498.898, h: 708.661 },
  { id: 'b4', label: 'B4', w: 708.661, h: 1000.63 },
  { id: 'web-1280', label: 'Web 1280 x 800', w: 1280, h: 800 },
  { id: 'web-1366', label: 'Web 1366 x 768', w: 1366, h: 768 },
  { id: 'web-1920', label: 'Web 1920 x 1080', w: 1920, h: 1080 },
  { id: 'phone', label: 'Phone 390 x 844', w: 390, h: 844 },
  { id: 'phone-l', label: 'Phone Large 430 x 932', w: 430, h: 932 },
  { id: 'tablet', label: 'Tablet 820 x 1180', w: 820, h: 1180 },
  { id: 'square', label: 'Square Post 1080 x 1080', w: 1080, h: 1080 },
  { id: 'story', label: 'Story 1080 x 1920', w: 1080, h: 1920 },
  { id: 'hd', label: 'HD Video 1920 x 1080', w: 1920, h: 1080 },
  { id: 'icon-512', label: 'Icon 512 x 512', w: 512, h: 512 },
];

/** Preset id matching a size in either orientation, or 'custom'. */
export function presetFor(w, h) {
  const eq = (a, b) => Math.abs(a - b) < 0.01;
  const p = ARTBOARD_PRESETS.find((p) => (eq(p.w, w) && eq(p.h, h)) || (eq(p.w, h) && eq(p.h, w)));
  return p ? p.id : 'custom';
}

export function boardRect(a) {
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w >= 0 && h >= 0 ? Math.max(w * h, 1e-9) : 0;
}

/** Top-level, unlocked, visible objects (layer children). */
export function topLevelObjects(doc) {
  const out = [];
  const visit = (layer) => {
    if (!layer || layer.hidden || layer.locked) return;
    for (const id of layer.children) {
      const n = doc.get(id);
      if (!n || n.hidden || n.locked) continue;
      if (n.type === 'layer') visit(n);
      else out.push(n);
    }
  };
  for (const id of doc.root.children) visit(doc.get(id));
  return out;
}

/** Ids of the top-level objects that belong to artboard `index`. */
export function artworkOnArtboard(doc, index, boards = doc.artboards) {
  const board = boards[index];
  if (!board) return [];
  const out = [];
  for (const n of topLevelObjects(doc)) {
    const b = nodeBounds(doc, n);
    if (!b) continue;
    const r = { x: b.x, y: b.y, w: Math.max(b.w, 1e-6), h: Math.max(b.h, 1e-6) };
    const mine = overlapArea(r, board);
    if (!mine) continue;
    // Owned by the artboard it overlaps most; ties go to the later (topmost) board.
    let best = -1;
    let bestArea = 0;
    boards.forEach((a, i) => {
      const area = overlapArea(r, a);
      if (area >= bestArea && area > 0) {
        best = i;
        bestArea = area;
      }
    });
    if (best === index) out.push(n.id);
  }
  return out;
}

/** A name like "Artboard 3" that is not used yet. */
export function nextArtboardName(boards) {
  const used = new Set(boards.map((b) => b.name));
  let i = boards.length + 1;
  while (used.has(`Artboard ${i}`)) i++;
  return `Artboard ${i}`;
}

function setBoards(doc, boards) {
  doc.updateRoot({ artboards: boards });
}

/** Add an artboard (inside a transaction). Returns its index. */
export function addArtboard(doc, rect, { name, index, ...extra } = {}) {
  const boards = doc.artboards.slice();
  const board = {
    id: uid('a'),
    name: name || nextArtboardName(boards),
    x: place(rect.x),
    y: place(rect.y),
    w: size(rect.w),
    h: size(rect.h),
    ...extra,
  };
  const at = index == null ? boards.length : Math.max(0, Math.min(boards.length, index));
  boards.splice(at, 0, board);
  setBoards(doc, boards);
  return at;
}

/** Patch one artboard by index. */
export function updateArtboard(doc, index, patch) {
  const boards = doc.artboards.slice();
  if (!boards[index]) return;
  const next = { ...boards[index], ...patch };
  next.w = size(next.w);
  next.h = size(next.h);
  next.x = place(next.x);
  next.y = place(next.y);
  boards[index] = next;
  setBoards(doc, boards);
}

/**
 * Move artboard `index` by (dx, dy), optionally with its artwork (ids
 * computed before the move unless given).
 */
export function moveArtboard(doc, index, dx, dy, { withArtwork = false, artwork = null } = {}) {
  const board = doc.artboards[index];
  if (!board) return;
  const ids = withArtwork ? artwork || artworkOnArtboard(doc, index) : [];
  updateArtboard(doc, index, { x: board.x + dx, y: board.y + dy });
  if (ids.length && (dx || dy)) transformNodes(doc, ids, translate(dx, dy));
}

/** Resize to a rect. */
export function resizeArtboard(doc, index, rect) {
  updateArtboard(doc, index, { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
}

/**
 * Duplicate artboard `index` offset by (dx, dy), copying its artwork when
 * asked. Returns { index, ids } (the new artboard index and artwork copies).
 */
export function duplicateArtboard(doc, index, dx, dy, { withArtwork = false } = {}) {
  const src = doc.artboards[index];
  if (!src) return { index: -1, ids: [] };
  const ids = withArtwork ? artworkOnArtboard(doc, index) : [];
  const { id: _id, name: _name, x: _x, y: _y, w: _w, h: _h, ...rest } = src;
  const at = addArtboard(doc, { x: src.x + dx, y: src.y + dy, w: src.w, h: src.h }, { ...rest, name: `${src.name} copy` });
  const copies = [];
  for (const id of doc.sortByPaintOrder(ids)) {
    const n = doc.get(id);
    const parent = doc.get(n.parent);
    const { node, descendants } = doc.cloneSubtree(id);
    doc.insert(node, parent.id, parent.children.indexOf(id) + 1, descendants);
    copies.push(node.id);
  }
  if (copies.length && (dx || dy)) transformNodes(doc, copies, translate(dx, dy));
  return { index: at, ids: copies };
}

/** Delete artboard `index` (a document keeps at least one). Returns false when refused. */
export function deleteArtboard(doc, index) {
  const boards = doc.artboards.slice();
  if (boards.length <= 1 || !boards[index]) return false;
  boards.splice(index, 1);
  setBoards(doc, boards);
  return true;
}

/** Move artboard `from` to position `to` in the list (renumbers). */
export function reorderArtboard(doc, from, to) {
  const boards = doc.artboards.slice();
  if (!boards[from]) return;
  const [b] = boards.splice(from, 1);
  boards.splice(Math.max(0, Math.min(boards.length, to)), 0, b);
  setBoards(doc, boards);
}

/**
 * Rearrange all artboards. layout: 'gridRow' | 'gridColumn' | 'row' | 'column'.
 * `columns` is the number of columns (grid by row) or rows (grid by column).
 * Returns the new rects (also applied when `doc` is in a transaction).
 */
export function rearrangeArtboards(doc, { layout = 'gridRow', columns = 2, spacing = 20, moveArtwork = true, rtl = false } = {}) {
  const boards = doc.artboards;
  if (!boards.length) return [];
  const art = moveArtwork ? boards.map((_, i) => artworkOnArtboard(doc, i)) : [];
  const ox = Math.min(...boards.map((b) => b.x));
  const oy = Math.min(...boards.map((b) => b.y));
  const n = boards.length;
  const per = Math.max(1, Math.round(columns));
  const pos = [];
  if (layout === 'row' || layout === 'gridRow') {
    const cols = layout === 'row' ? n : per;
    let y = oy;
    for (let start = 0; start < n; start += cols) {
      const row = boards.slice(start, start + cols);
      const rowH = Math.max(...row.map((b) => b.h));
      const widths = row.reduce((s, b) => s + b.w, 0) + spacing * (row.length - 1);
      let x = rtl ? ox + widths : ox;
      for (const b of row) {
        if (rtl) {
          x -= b.w;
          pos.push({ x, y });
          x -= spacing;
        } else {
          pos.push({ x, y });
          x += b.w + spacing;
        }
      }
      y += rowH + spacing;
    }
  } else {
    const rows = layout === 'column' ? n : per;
    let x = ox;
    const colStarts = [];
    for (let start = 0; start < n; start += rows) colStarts.push(start);
    const colWidths = colStarts.map((s) => Math.max(...boards.slice(s, s + rows).map((b) => b.w)));
    const total = colWidths.reduce((s, w) => s + w, 0) + spacing * (colWidths.length - 1);
    if (rtl) x = ox + total;
    colStarts.forEach((start, ci) => {
      const col = boards.slice(start, start + rows);
      if (rtl) x -= colWidths[ci];
      let y = oy;
      for (const b of col) {
        pos.push({ x, y });
        y += b.h + spacing;
      }
      if (rtl) x -= spacing;
      else x += colWidths[ci] + spacing;
    });
  }
  const next = boards.map((b, i) => ({ ...b, x: pos[i].x, y: pos[i].y }));
  setBoards(doc, next);
  if (moveArtwork) {
    boards.forEach((b, i) => {
      const dx = next[i].x - b.x;
      const dy = next[i].y - b.y;
      if ((dx || dy) && art[i].length) transformNodes(doc, art[i], translate(dx, dy));
    });
  }
  return next.map(boardRect);
}

/** Visual bounds of a set of ids (what renders, including strokes and effects). */
export function idsBounds(doc, ids, visual = true) {
  let r = null;
  for (const id of ids) {
    const n = doc.get(id);
    if (!n) continue;
    r = unionRect(r, visual ? visualBounds(doc, n) : nodeBounds(doc, n));
  }
  return r;
}

/** Fit artboard `index` to its artwork (all artwork when it is the only artboard). */
export function fitArtboardToArtwork(doc, index) {
  const ids = doc.artboards.length === 1 ? topLevelObjects(doc).map((n) => n.id) : artworkOnArtboard(doc, index);
  const r = idsBounds(doc, ids);
  if (!r || r.w <= 0 || r.h <= 0) return false;
  resizeArtboard(doc, index, r);
  return true;
}

/** Fit artboard `index` to the given objects' bounds. */
export function fitArtboardToIds(doc, index, ids) {
  const r = idsBounds(doc, ids);
  if (!r || r.w <= 0 || r.h <= 0) return false;
  resizeArtboard(doc, index, r);
  return true;
}

/** Is a node an axis-aligned rectangle (live rectangle or four straight corners)? */
export function isRectangle(node) {
  if (!node || node.type !== 'path' || !node.closed) return false;
  if (node.shape?.kind === 'rect' && !node.shape.angle) return true;
  const a = node.anchors;
  if (a.length !== 4) return false;
  const straight = a.every((p) => p.ix === p.x && p.iy === p.y && p.ox === p.x && p.oy === p.y);
  if (!straight) return false;
  for (let i = 0; i < 4; i++) {
    const p = a[i];
    const q = a[(i + 1) % 4];
    if (Math.abs(p.x - q.x) > 1e-6 && Math.abs(p.y - q.y) > 1e-6) return false;
  }
  return true;
}

/** Convert rectangles to artboards (they are removed). Returns the new artboard indices. */
export function convertToArtboards(doc, ids) {
  const rects = doc.sortByPaintOrder(ids).map((id) => doc.get(id)).filter(isRectangle);
  const out = [];
  for (const r of rects) {
    const b = nodeBounds(doc, r);
    if (!b || b.w <= 0 || b.h <= 0) continue;
    out.push(addArtboard(doc, b, r.name ? { name: r.name } : {}));
    doc.remove(r.id);
  }
  return out;
}

/** Handle positions of an artboard rect: nw, n, ne, e, se, s, sw, w. */
export function boardHandles(a) {
  return {
    nw: { x: a.x, y: a.y },
    n: { x: a.x + a.w / 2, y: a.y },
    ne: { x: a.x + a.w, y: a.y },
    e: { x: a.x + a.w, y: a.y + a.h / 2 },
    se: { x: a.x + a.w, y: a.y + a.h },
    s: { x: a.x + a.w / 2, y: a.y + a.h },
    sw: { x: a.x, y: a.y + a.h },
    w: { x: a.x, y: a.y + a.h / 2 },
  };
}

/**
 * New rect when dragging handle `handle` of rect `r` to (x, y).
 * shift keeps the aspect ratio, alt resizes about the center.
 */
export function resizeRect(r, handle, x, y, { shift = false, alt = false, min = 1 } = {}) {
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (handle.includes('w')) x0 = x;
  if (handle.includes('e')) x1 = x;
  if (handle.includes('n')) y0 = y;
  if (handle.includes('s')) y1 = y;
  if (alt) {
    if (handle.includes('w')) x1 = 2 * cx - x0;
    if (handle.includes('e')) x0 = 2 * cx - x1;
    if (handle.includes('n')) y1 = 2 * cy - y0;
    if (handle.includes('s')) y0 = 2 * cy - y1;
  }
  let nx = Math.min(x0, x1);
  let ny = Math.min(y0, y1);
  let nw = Math.max(min, Math.abs(x1 - x0));
  let nh = Math.max(min, Math.abs(y1 - y0));
  if (shift && r.w > 0 && r.h > 0) {
    const ratio = r.w / r.h;
    const horiz = handle === 'e' || handle === 'w';
    const vert = handle === 'n' || handle === 's';
    if (horiz) nh = nw / ratio;
    else if (vert) nw = nh * ratio;
    else if (nw / nh > ratio) nh = nw / ratio;
    else nw = nh * ratio;
    // Keep the fixed edge (or center) in place.
    if (alt) {
      nx = cx - nw / 2;
      ny = cy - nh / 2;
    } else {
      if (handle.includes('w')) nx = r.x + r.w - nw;
      else if (handle.includes('e')) nx = r.x;
      else nx = cx - nw / 2;
      if (handle.includes('n')) ny = r.y + r.h - nh;
      else if (handle.includes('s')) ny = r.y;
      else ny = cy - nh / 2;
    }
  }
  return { x: nx, y: ny, w: nw, h: nh };
}

/**
 * Artboard reference point: the 9-point index (row by row, 4 = center) that
 * artboard X/Y refer to and that resizing keeps in place. Shared by Artboard
 * Options and the Artboard tool's controls; center by default.
 */
export const artboardRef = { index: 4 };
const REF_FRACTIONS = [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]];

/** The reference point of rect `r`. */
export function refPoint(r, index = artboardRef.index) {
  const [fx, fy] = REF_FRACTIONS[index] || REF_FRACTIONS[4];
  return { x: r.x + r.w * fx, y: r.y + r.h * fy };
}

/** A w x h rect whose reference point is at (px, py). */
export function rectAtRef(w, h, px, py, index = artboardRef.index) {
  const [fx, fy] = REF_FRACTIONS[index] || REF_FRACTIONS[4];
  return { x: px - w * fx, y: py - h * fy, w, h };
}

/** `r` resized to w x h with its reference point kept in place. */
export function resizeAtRef(r, w, h, index = artboardRef.index) {
  const p = refPoint(r, index);
  return rectAtRef(w, h, p.x, p.y, index);
}
