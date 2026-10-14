import { EMU_PER_PX, isPositionedImage, validateImage } from './images.js';
import { positionedImageFrame, positionedImageBounds } from './positioned-images.js';

/**
 * Arrange: where floating drawings sit on their pages and how they stack. Positions are kept in each
 * drawing's own anchor coordinates (§20.4.2.10 positionH, §20.4.2.11 positionV): moving, aligning and
 * distributing work out the page position wanted from the laid-out pages, then write the offset in the
 * drawing's coordinate system, so the anchor paragraph and its reference frame stay as authored.
 */

/** Laid-out floating drawings of the current story: [{ image, start, end, page, x, y, width, height, region }]. */
export function floatingFrames(editor) {
  const layout = editor.selectionLayout || editor.layout;
  return (layout?.floatingObjects || []).filter(f => !f.image.hidden);
}
/** The frame of one drawing (by identity, or by id when the model replaced it). */
export function frameOf(editor, image) {
  const frames = floatingFrames(editor);
  return frames.find(f => f.image === image) || frames.find(f => f.image.id === image.id) || null;
}

function placement(editor, f) {
  const anchor = f.image.anchor;
  const layout = editor.selectionLayout || editor.layout, lines = [...layout.lines, ...(layout.repeatedLines || [])];
  const line = lines.find(l => l.fragments.some(p => p.image && p.start === f.start && p.end === f.end));
  const first = anchor.vertical === 'line' ? line : lines.find(l => l.paragraphId === line?.paragraphId && l.page === f.page);
  if (!first) throw new Error('The drawing\'s anchor paragraph is not laid out.');
  const geometry = editor.layout.pageRegions?.[f.page]?.[f.region]?.geometry || editor.layout.pages[f.page];
  const cell = line?.cellId ? layout.cells.find(c => c.id === line.cellId && c.page === f.page) : null;
  return positionedImageFrame(f, first, { ...geometry, drawingBounds: editor.layout.pageRegions?.[f.page]?.[f.region]?.drawingBounds }, cell);
}

/** The anchor offsets (EMU) that put a drawing's frame at page position (x, y) in pixels. */
export function offsetsFor(editor, f, x, y) {
  const anchor = { ...f.image.anchor, x: 0, y: 0 };
  for (const axis of ['x', 'y']) { delete anchor[axis + 'Align']; delete anchor[axis + 'Percentage']; }
  const zero = placement(editor, { ...f, image: { ...f.image, anchor } });
  const clamp = value => Math.max(-20116800, Math.min(20116800, Math.round(value)));
  return { x: clamp((x - zero.x) * EMU_PER_PX), y: clamp((y - zero.y) * EMU_PER_PX) };
}

/**
 * Move floating drawings in one transaction: moves [{ image, x, y }] with x/y in EMU anchor offsets.
 * Each moved axis loses its alignment or percentage and is written as an offset (§20.4.2.12 posOffset).
 */
export function moveDrawings(model, moves) {
  const changes = new Map();
  for (const { image, x, y } of moves) {
    if (!isPositionedImage(image)) throw new Error('Only floating objects can be positioned.');
    const anchor = { ...image.anchor };
    for (const [axis, value] of [['x', x], ['y', y]]) if (value !== undefined) {
      if (!Number.isInteger(value) || Math.abs(value) > 20116800) throw new Error('Positions must be within 22 inches.');
      if (anchor[axis] === value && !anchor[axis + 'Align'] && anchor[axis + 'Percentage'] === undefined) continue;
      anchor[axis] = value; delete anchor[axis + 'Align']; delete anchor[axis + 'Percentage'];
    }
    if (JSON.stringify(anchor) !== JSON.stringify(image.anchor)) changes.set(image, validateImage({ ...image, anchor, anchorChanged: true }));
  }
  if (!changes.size) return false;
  model.checkpoint();
  for (const p of model.paragraphs) for (const run of p.runs) if (changes.has(run.image)) run.image = changes.get(run.image);
  model.didChange();
  return true;
}

/** The page rectangles drawings align to: the page, its margins, or the selected objects' bounds. */
export function referenceBox(editor, frames, relativeTo) {
  const page = editor.layout.pages[frames[0].page] || editor.layout.page;
  if (relativeTo === 'page') return { x: 0, y: 0, width: page.width, height: page.height };
  if (relativeTo === 'margin') return { x: page.left, y: page.top, width: page.width - page.left - page.right, height: page.height - page.top - page.bottom };
  const boxes = frames.map(positionedImageBounds);
  const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
  return { x: left, y: top, width: Math.max(...boxes.map(b => b.x + b.width)) - left, height: Math.max(...boxes.map(b => b.y + b.height)) - top };
}

/**
 * Align (left, center, right, top, middle, bottom) or distribute (horizontal, vertical) floating
 * drawings. relativeTo: 'page' | 'margin' | 'selected'. Returns the moves for moveDrawings.
 */
export function alignmentMoves(editor, images, mode, relativeTo = images.length > 1 ? 'selected' : 'margin') {
  const frames = images.map(image => frameOf(editor, image)).filter(Boolean);
  if (!frames.length) throw new Error('Select a floating object to align it.');
  if (frames.some(f => f.page !== frames[0].page)) throw new Error('The objects are on different pages.');
  const box = referenceBox(editor, frames, relativeTo);
  const moves = [];
  const bounds = f => positionedImageBounds(f);
  // Rotated drawings align by their visible bounds; the frame moves by the same amount.
  const to = (f, x, y) => { const b = bounds(f); const at = offsetsFor(editor, f, f.x + (x ?? b.x) - b.x, f.y + (y ?? b.y) - b.y); moves.push({ image: f.image, x: x === undefined ? undefined : at.x, y: y === undefined ? undefined : at.y }); };
  if (mode === 'distributeHorizontal' || mode === 'distributeVertical') {
    const horizontal = mode === 'distributeHorizontal', key = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
    const sorted = [...frames].sort((a, b) => bounds(a)[key] - bounds(b)[key]);
    if (sorted.length < 2) return [];
    // Within the selection the outer objects stay put; against the page or margin they span it.
    const spanStart = relativeTo === 'selected' || frames.length > 2 && relativeTo === 'selected' ? bounds(sorted[0])[key] : box[key];
    const spanEnd = relativeTo === 'selected' ? bounds(sorted.at(-1))[key] + bounds(sorted.at(-1))[size] : box[key] + box[size];
    const total = sorted.reduce((sum, f) => sum + bounds(f)[size], 0);
    const gap = (spanEnd - spanStart - total) / (sorted.length - 1);
    let at = spanStart;
    for (const f of sorted) { to(f, horizontal ? at : undefined, horizontal ? undefined : at); at += bounds(f)[size] + gap; }
    return moves;
  }
  for (const f of frames) {
    const b = bounds(f);
    if (mode === 'left') to(f, box.x);
    else if (mode === 'center') to(f, box.x + (box.width - b.width) / 2);
    else if (mode === 'right') to(f, box.x + box.width - b.width);
    else if (mode === 'top') to(f, undefined, box.y);
    else if (mode === 'middle') to(f, undefined, box.y + (box.height - b.height) / 2);
    else if (mode === 'bottom') to(f, undefined, box.y + box.height - b.height);
    else throw new Error('Choose an alignment.');
  }
  return moves;
}

/** The nine square-wrapped page positions: [id, label, horizontal (0..1), vertical (0..1)]. */
export const POSITION_PRESETS = [
  ['topLeft', 'Top Left', 0, 0], ['topCenter', 'Top Center', 0.5, 0], ['topRight', 'Top Right', 1, 0],
  ['middleLeft', 'Middle Left', 0, 0.5], ['middleCenter', 'Middle Center', 0.5, 0.5], ['middleRight', 'Middle Right', 1, 0.5],
  ['bottomLeft', 'Bottom Left', 0, 1], ['bottomCenter', 'Bottom Center', 0.5, 1], ['bottomRight', 'Bottom Right', 1, 1],
];

/** Where a position preset puts a drawing of this size inside the page margins, in page pixels. */
export function presetPosition(page, frame, [, , h, v]) {
  const left = page.left, top = page.top, width = page.width - page.left - page.right, height = page.height - page.top - page.bottom;
  return { x: left + (width - frame.width) * h, y: top + (height - frame.height) * v };
}

/** Bring Forward, Send Backward, to Front/Back, in Front of/Behind Text (§20.4.2.3 relativeHeight, behindDoc). */
export const ORDER_COMMANDS = ['forward', 'backward', 'front', 'back', 'inFront', 'behind'];

/**
 * Restack floating drawings in the given order (front first) in one transaction. Drawings behind the
 * text stay behind it and in-front drawings in front; the order within each layer follows the list.
 */
export function reorderDrawings(model, frontToBack) {
  const listed = frontToBack.filter(isPositionedImage);
  const runs = model.paragraphs.flatMap(p => p.runs).filter(r => isPositionedImage(r.image));
  const rank = new Map(listed.map((image, i) => [image, listed.length - i]));
  const layers = [true, false].map(behind => runs.filter(r => !!r.image.anchor.behind === behind)
    .sort((a, b) => (rank.get(a.image) ?? -1) - (rank.get(b.image) ?? -1) || a.image.anchor.order - b.image.anchor.order));
  const next = new Map();
  let order = 1;
  for (const layer of layers) for (const run of layer) { if (run.image.anchor.order !== order) next.set(run, { ...run.image, anchor: { ...run.image.anchor, order }, anchorChanged: true }); order++; }
  if (!next.size) return false;
  model.checkpoint();
  for (const [run, image] of next) run.image = image;
  model.didChange();
  return true;
}
