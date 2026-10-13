/**
 * Putting generated vector art into the document: placed to fit the
 * selection or the artboard, clipped into a shape (Generative Shape Fill),
 * swapped for another variation in place, or saved as a pattern swatch.
 * Each operation is one undo step.
 */
import { UserError } from '../../lib/errors.js';
import { createGroup } from '../../model/nodes.js';
import { nodeBounds, selectionBounds } from '../../model/geometry.js';
import { addPattern, patternPaint, newPatternId, PATTERN_DEFAULTS } from '../patterns/model.js';
import { addSwatch } from '../paint/swatch-model.js';
import { nextPatternName } from '../patterns/edit.js';
import { resultToNodes, fitMatrix } from './vectorize.js';
import { promptTitle } from './prompts.js';

/** Closed paths and compound paths that can hold a shape fill. */
export function isFillableShape(node) {
  return Boolean(node && ((node.type === 'path' && node.closed && node.anchors.length > 2) || node.type === 'compound'));
}

/** The one selected closed shape (Generative Shape Fill target), or null. */
export function selectedShape(editor) {
  if (!editor) return null;
  const top = editor.topSelection();
  if (top.length !== 1) return null;
  const n = editor.doc.get(top[0]);
  return isFillableShape(n) ? n : null;
}

/**
 * Where new art goes: { rect, mode, parentId, index }. With a selection it
 * fits the selection's bounds and goes above it; otherwise it fits the
 * active artboard (scenes fill it, other content takes its middle).
 */
export function placementTarget(editor, contentType = 'subject') {
  const doc = editor.doc;
  const top = editor.topSelection();
  if (top.length) {
    const b = selectionBounds(doc, top);
    if (b && b.w > 0.5 && b.h > 0.5) {
      const last = doc.get(top[top.length - 1]);
      const parent = doc.get(last.parent);
      if (parent && parent.type !== 'compound' && !doc.isLocked(parent.id)) {
        return { rect: { x: b.x, y: b.y, w: b.w, h: b.h }, mode: 'contain', parentId: parent.id, index: parent.children.indexOf(last.id) + 1 };
      }
    }
  }
  if (!editor.canDrawInTarget()) throw new UserError('The target layer is locked or hidden.');
  const layer = editor.targetLayer();
  const a = editor.artboard() || { x: 0, y: 0, w: 612, h: 792 };
  let rect = { x: a.x, y: a.y, w: a.w, h: a.h };
  if (contentType !== 'scene') {
    const s = Math.min(a.w, a.h) * 0.6;
    rect = { x: a.x + (a.w - s) / 2, y: a.y + (a.h - s) / 2, w: s, h: s };
  }
  return { rect, mode: 'contain', parentId: layer.id, index: Infinity };
}

/** Picture shape (for the image model) that suits a placement target. */
export function targetAspect(target) {
  return { w: target.rect.w, h: target.rect.h };
}

/**
 * Insert a traced result fitted to target (inside a transaction).
 * Returns { id, placedBounds }.
 */
export function insertArt(doc, result, target, name) {
  const m = fitMatrix(result.w, result.h, target.rect, target.mode);
  const { node, descendants } = resultToNodes(result, m, { name });
  doc.insert(node, target.parentId, target.index, descendants);
  return { id: node.id, placedBounds: nodeBounds(doc, doc.get(node.id)) };
}

/** Place a variation as new art: one undo step. Returns a placement record. */
export function placeArt(editor, result, target, { prompt = '', label = 'Generate Vectors' } = {}) {
  const doc = editor.doc;
  let out = null;
  doc.transact(label, () => {
    out = insertArt(doc, result, target, `Generated: ${promptTitle(prompt, 32)}`);
  });
  editor.select([out.id]);
  return { kind: 'art', doc, id: out.id, target, placedBounds: out.placedBounds, prompt };
}

/**
 * The target rect for a swap: the original rect, moved and scaled the way
 * the placed art has been moved and scaled since.
 */
function followedRect(rect, before, now) {
  if (!before || !now || before.w <= 0 || before.h <= 0) return rect;
  const sx = now.w / before.w;
  const sy = now.h / before.h;
  return { x: now.x + (rect.x - before.x) * sx, y: now.y + (rect.y - before.y) * sy, w: rect.w * sx, h: rect.h * sy };
}

/** True when a placement record still points at art in its document. */
export function placementAlive(rec) {
  if (!rec) return false;
  if (rec.kind === 'clip') return Boolean(rec.doc.get(rec.clipId) && rec.doc.get(rec.artId)?.parent === rec.clipId);
  return Boolean(rec.doc.get(rec.id));
}

/**
 * Replace placed art with another variation, in place (one undo step).
 * Returns the updated placement record.
 */
export function swapArt(editor, rec, result, { label = 'Generate Vectors' } = {}) {
  const doc = rec.doc;
  if (!placementAlive(rec)) throw new UserError('The generated art is no longer in the document.');
  if (rec.kind === 'clip') return swapShapeFill(editor, rec, result, { label });
  const old = doc.get(rec.id);
  const parent = doc.get(old.parent);
  const index = parent.children.indexOf(old.id);
  const rect = followedRect(rec.target.rect, rec.placedBounds, nodeBounds(doc, old));
  const target = { ...rec.target, rect, parentId: parent.id, index };
  let out = null;
  doc.transact(label, () => {
    doc.remove(old.id);
    out = insertArt(doc, result, target, old.name);
  });
  editor.select([out.id]);
  return { ...rec, id: out.id, target, placedBounds: out.placedBounds };
}

// ---- Generative Shape Fill ----

/**
 * Fill a closed shape with art: a clipping group holding the art (scaled to
 * cover the shape) and the shape as its clipping path. One undo step.
 */
export function shapeFill(editor, shapeId, result, { prompt = '', label = 'Generative Shape Fill' } = {}) {
  const doc = editor.doc;
  const shape = doc.get(shapeId);
  if (!isFillableShape(shape)) throw new UserError('Select a closed shape to fill.');
  const b = nodeBounds(doc, shape);
  const target = { rect: { x: b.x, y: b.y, w: b.w, h: b.h }, mode: 'cover' };
  let clipId = null;
  let artId = null;
  doc.transact(label, () => {
    const parent = doc.get(shape.parent);
    const index = parent.children.indexOf(shape.id);
    const g = createGroup([], { clip: true, name: `Shape Fill: ${promptTitle(prompt, 28)}` });
    doc.insert(g, parent.id, index);
    clipId = g.id;
    artId = insertArt(doc, result, { ...target, parentId: g.id, index: 0 }, `Generated: ${promptTitle(prompt, 32)}`).id;
    doc.move(shape.id, g.id);
    // The clipping path only defines the clip.
    doc.update(shape.id, { fill: null, stroke: null });
  });
  editor.select([clipId]);
  return { kind: 'clip', doc, clipId, artId, shapeId, prompt };
}

function swapShapeFill(editor, rec, result, { label }) {
  const doc = rec.doc;
  const shape = doc.get(rec.shapeId);
  const b = shape ? nodeBounds(doc, shape) : nodeBounds(doc, doc.get(rec.clipId));
  let artId = null;
  doc.transact(label, () => {
    const old = doc.get(rec.artId);
    const index = doc.get(rec.clipId).children.indexOf(old.id);
    doc.remove(old.id);
    artId = insertArt(doc, result, { rect: { x: b.x, y: b.y, w: b.w, h: b.h }, mode: 'cover', parentId: rec.clipId, index }, old.name).id;
  });
  editor.select([rec.clipId]);
  return { ...rec, artId };
}

// ---- Generate Patterns ----

export const PATTERN_TILE = 72;

/**
 * A pattern swatch from a traced tile (inside a transaction): the art is
 * scaled to a tile of `size` points. Returns { patternId, swatchId, name }.
 */
export function addGeneratedPattern(doc, result, { prompt = '', size = PATTERN_TILE } = {}) {
  const w = size;
  const h = Math.max(1, (size * result.h) / result.w);
  const m = fitMatrix(result.w, result.h, { x: 0, y: 0, w, h }, 'cover');
  const { node, descendants } = resultToNodes(result, m, { name: '' });
  const name = nextPatternName(doc, promptTitle(prompt, 28));
  const def = addPattern(doc, { ...PATTERN_DEFAULTS, id: newPatternId(), name, width: w, height: h, art: { roots: [node.id], nodes: [{ ...node, parent: null }, ...descendants] } });
  const swatchId = addSwatch(doc, { name, paint: patternPaint(def.id) });
  return { patternId: def.id, swatchId, name };
}

/** Paintable objects in the selection a pattern fill applies to. */
export function patternTargets(editor) {
  const doc = editor.doc;
  const out = [];
  const visit = (n) => {
    if (!n) return;
    if (n.type === 'group' && !n.live) n.children.forEach((c) => visit(doc.get(c)));
    else if (isFillableShape(n) || (n.type === 'path' && n.closed) || n.type === 'text') out.push(n);
  };
  editor.topSelection().forEach((id) => visit(doc.get(id)));
  return out;
}

/** Add a generated pattern swatch and fill the selected shapes with it (one undo step). */
export function applyGeneratedPattern(editor, result, { prompt = '' } = {}) {
  const doc = editor.doc;
  const targets = patternTargets(editor);
  let info = null;
  doc.transact('Generate Patterns', () => {
    info = addGeneratedPattern(doc, result, { prompt });
    for (const n of targets) doc.update(n.id, { fill: patternPaint(info.patternId) });
  });
  return { ...info, applied: targets.length };
}
