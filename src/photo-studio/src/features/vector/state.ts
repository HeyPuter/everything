import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { allLayers, findLayer, layer as newLayer, type Layer, type PhotoDocument } from '../../model/document';
import {
  transformedVectorMask,
  validateVectorShape,
  vectorBounds,
  vectorMatrix,
  vectorPaintMatrix,
  vectorUnbounded,
  type VectorMask,
  type VectorShape,
} from '../../model/vector';
import { gradientFrame, isVectorGradient } from '../../model/vector-gradient';
import { isVectorPattern, patternReferencePoint } from '../../model/vector-pattern';
import { supportedStrokePaths } from '../../model/vector-stroke';
import { layerLock } from '../../model/locks';
import { multiplyMaskMatrix } from '../../model/pixel-mask';
import { cleanMask, scaleLive, type KnotRef } from './geometry';
import type { LiveShape } from '../../model/live-shape';
import { applyAffine, invertAffine, textMatrix } from '../../model/text-layer';

// The type feature refits a text layer after its path changes (layout needs
// fonts and measurement, which live there).
export const textPathHooks: { refit?: (l: Layer) => void } = {};

// Which path the pen, shape (Path mode) and path selection tools edit.
export type TargetKind = 'work' | 'saved' | 'shape' | 'vmask' | 'text';
export type PathTarget = { kind: TargetKind; id: string; name: string; mask: VectorMask };

type VectorSession = {
  // 'work', 'path:<id>', 'vmask:<layer>', 'none' (explicitly deselected) or undefined (default).
  active?: string;
  // Path selection: selected subpath indices; direct selection: selected knots.
  paths: Set<number>;
  knots: KnotRef[];
  // Identity of the mask the selection refers to, so stale indices are dropped.
  selectionKey?: string;
};
const sessions = new WeakMap<DocumentSession, VectorSession>();
export function vstate(e: Editor): VectorSession {
  let s = sessions.get(e.session);
  if (!s) sessions.set(e.session, (s = { paths: new Set(), knots: [] }));
  return s;
}
export function setActive(e: Editor, active: string | undefined) {
  const s = vstate(e);
  // Deselecting hides only the current layer's path; another layer shows its own.
  if (active === 'none') active = `none:${e.selected}`;
  if (s.active !== active) clearSelection(e);
  s.active = active;
}
export function clearSelection(e: Editor) {
  const s = vstate(e);
  s.paths = new Set();
  s.knots = [];
}

/** Document-space path of a path or area text layer. */
export function textDocMask(l: Layer): VectorMask {
  const p = l.textData!.path!;
  const m = textMatrix(l);
  const knots = p.knots.map((k) => {
    const pts: number[] = [];
    for (let i = 0; i < 6; i += 2) pts.push(...applyAffine(m, k[i], k[i + 1]));
    return { linked: smoothPoints(pts), points: pts };
  });
  return { paths: [{ open: !p.closed, operation: 'combine', fillRule: 'non-zero', knots }] };
}
const smoothPoints = (k: number[]) => {
  const ix = k[0] - k[2], iy = k[1] - k[3], ox = k[4] - k[2], oy = k[5] - k[3];
  const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
  return li > 0 && lo > 0 && Math.abs(ix * oy - iy * ox) / (li * lo) < 1e-3 && ix * ox + iy * oy < 0;
};
/** Writes document-space knots back into a text layer's path (first subpath). */
export function setTextMask(l: Layer, mask: VectorMask) {
  const sp = mask.paths[0];
  if (!l.textData?.path || !sp || sp.knots.length < 2) return;
  const inv = invertAffine(textMatrix(l));
  const knots = sp.knots.map((k) => {
    const out: number[] = [];
    for (let i = 0; i < 6; i += 2) out.push(...applyAffine(inv, k.points[i], k.points[i + 1]));
    return out;
  });
  const closed = l.textData.path.kind === 'area' ? true : !sp.open;
  // Arc text keeps its preset while the path only moves.
  const old = l.textData.path, arc = old.arc;
  let shift: [number, number] | undefined;
  if (arc && old.knots.length === knots.length) {
    const dx = knots[0][2] - old.knots[0][2], dy = knots[0][3] - old.knots[0][3];
    if (knots.every((k, i) => k.every((v, j) => Math.abs(v - old.knots[i][j] - (j % 2 ? dy : dx)) < 1e-6))) shift = [dx, dy];
  }
  l.textData = { ...l.textData, path: { ...old, knots, closed, arc: arc && shift ? { ...arc, x: arc.x + shift[0], y: arc.y + shift[1] } : undefined } };
  delete l.asset;
  textPathHooks.refit?.(l);
}
const typePathOf = (l: Layer | undefined) => (l?.kind === 'text' && l.textData?.path ? l : undefined);

/** Document-space knots of a shape layer (its reference knots through the layer transform). */
export function shapeDocMask(l: Layer): VectorMask {
  return transformedVectorMask(l);
}
export function singleSelected(e: Editor, doc: PhotoDocument = e.doc): Layer | undefined {
  if (e.selectedIds.size !== 1) return;
  return findLayer(doc.layers, e.selected);
}
/** The path the editing tools operate on, in document coordinates. */
export function targetPath(e: Editor, doc: PhotoDocument = e.doc): PathTarget | undefined {
  const s = vstate(e);
  const active = s.active;
  if (active?.startsWith('path:')) {
    const p = doc.paths?.find((x) => x.id === active.slice(5));
    if (p) return { kind: 'saved', id: p.id, name: p.name, mask: p.mask };
  }
  if (active === 'work' && doc.workPath) return { kind: 'work', id: 'work', name: 'Work Path', mask: doc.workPath };
  const l = singleSelected(e, doc);
  if (active?.startsWith('vmask:') && l?.id === active.slice(6) && l.vectorMask)
    return { kind: 'vmask', id: l.id, name: `${l.name} Vector Mask`, mask: l.vectorMask.mask };
  if (active?.startsWith('none:') && active.slice(5) === (l?.id ?? e.selected)) return;
  if (l?.kind === 'vector' && l.vector) return { kind: 'shape', id: l.id, name: `${l.name} Shape Path`, mask: shapeDocMask(l) };
  if (typePathOf(l)) return { kind: 'text', id: l!.id, name: `${l!.name} Type Path`, mask: textDocMask(l!) };
  if (l?.vectorMask) return { kind: 'vmask', id: l.id, name: `${l.name} Vector Mask`, mask: l.vectorMask.mask };
  return;
}
/** Every path listed in the Paths panel, in panel order. */
export function listedPaths(e: Editor, doc: PhotoDocument = e.doc): PathTarget[] {
  const out: PathTarget[] = [];
  const l = singleSelected(e, doc);
  if (l?.kind === 'vector' && l.vector) out.push({ kind: 'shape', id: l.id, name: `${l.name} Shape Path`, mask: shapeDocMask(l) });
  if (typePathOf(l)) out.push({ kind: 'text', id: l!.id, name: `${l!.name} Type Path`, mask: textDocMask(l!) });
  if (l?.vectorMask) out.push({ kind: 'vmask', id: l.id, name: `${l.name} Vector Mask`, mask: l.vectorMask.mask });
  if (doc.workPath) out.push({ kind: 'work', id: 'work', name: 'Work Path', mask: doc.workPath });
  for (const p of doc.paths ?? []) out.push({ kind: 'saved', id: p.id, name: p.name, mask: p.mask });
  return out;
}
/** Resolve a target by its key regardless of the current panel selection. */
export function targetByKey(e: Editor, key: string, doc: PhotoDocument = e.doc): PathTarget | undefined {
  if (key === 'work') return doc.workPath ? { kind: 'work', id: 'work', name: 'Work Path', mask: doc.workPath } : undefined;
  if (key.startsWith('path:')) {
    const p = doc.paths?.find((x) => x.id === key.slice(5));
    return p && { kind: 'saved', id: p.id, name: p.name, mask: p.mask };
  }
  const l = findLayer(doc.layers, key.slice(key.indexOf(':') + 1));
  if (!l) return;
  if (key.startsWith('layer:') && l.vector) return { kind: 'shape', id: l.id, name: `${l.name} Shape Path`, mask: shapeDocMask(l) };
  if (key.startsWith('text:') && typePathOf(l)) return { kind: 'text', id: l.id, name: `${l.name} Type Path`, mask: textDocMask(l) };
  if (key.startsWith('vmask:') && l.vectorMask) return { kind: 'vmask', id: l.id, name: `${l.name} Vector Mask`, mask: l.vectorMask.mask };
  return;
}
/** Select knots (direct selection) on a target. */
export function selectKnots(e: Editor, t: PathTarget, knots: KnotRef[]) {
  const s = vstate(e);
  s.selectionKey = activeKey(t);
  s.knots = knots;
  s.paths = new Set(knots.map((k) => k.path));
}
export const activeKey = (t: PathTarget) => (t.kind === 'work' ? 'work' : t.kind === 'saved' ? `path:${t.id}` : t.kind === 'vmask' ? `vmask:${t.id}` : t.kind === 'text' ? `text:${t.id}` : `layer:${t.id}`);

/** Replace a shape layer's geometry with document-space knots. The layer's
 * transform becomes the identity again (knots are baked); paint that follows
 * the layer is re-anchored so it stays put. */
export function setShapeMask(l: Layer, mask: VectorMask, keepLive = false) {
  const v = l.vector!;
  const before = vectorPaintMatrix(l);
  if (isVectorPattern(v.fill) && v.fill.align !== false) v.fill.referencePoint = patternReferencePoint(v.fill, before);
  v.mask = { ...v.mask, paths: structuredClone(mask.paths) };
  if (v.mask.notLink) delete v.mask.notLink;
  const docW = l.sourceWidth, docH = l.sourceHeight;
  const b = vectorUnbounded(v.mask) ? null : vectorBounds(v.mask);
  const reference = b ? { x: b.x, y: b.y, width: Math.max(b.width, 1e-3), height: Math.max(b.height, 1e-3) } : { x: 0, y: 0, width: docW, height: docH };
  v.reference = reference;
  l.transform = { ...reference, rotation: 0 };
  delete v.psdBounds;
  if (isVectorGradient(v.fill) && v.fill.align !== false) {
    // An untransformed layer's gradient spans its new bounds; a transformed
    // layer keeps its paint where it was (rotation included).
    if (before.every((n, i) => n === [1, 0, 0, 1, 0, 0][i])) {
      v.fill.frame = gradientFrame({ x: 0, y: 0, width: docW, height: docH }, true, undefined, b);
      delete v.fill.matrix;
    } else v.fill.matrix = multiplyMaskMatrix(before, v.fill.matrix ?? [1, 0, 0, 1, 0, 0]);
  }
  if (!keepLive) delete v.live;
  sanitizeStroke(v);
}
/** Keep strokes renderable: open paths need centered strokes, and dashes a single combined path. */
export function sanitizeStroke(v: VectorShape): string | undefined {
  const s = v.stroke;
  if (!s || supportedStrokePaths(v.mask, s)) return;
  let note: string | undefined;
  if (s.lineDashSet?.length && !supportedStrokePaths(v.mask, { ...s, lineDashSet: undefined })) {
    if (v.mask.paths.some((p) => p.open)) s.alignment = 'center';
  }
  if (!supportedStrokePaths(v.mask, s) && s.lineDashSet?.length) {
    delete s.lineDashSet;
    note = 'Dashed strokes need a single path; the stroke is now solid.';
  }
  if (!supportedStrokePaths(v.mask, s) && v.mask.paths.some((p) => p.open)) s.alignment = 'center';
  if (!supportedStrokePaths(v.mask, s)) {
    s.enabled = false;
    note = 'Open paths combined with other paths cannot be stroked; the stroke was turned off.';
  }
  return note;
}
/** The live shape in document space when the layer maps it by an axis-aligned
 * scale and offset (no rotation or skew); otherwise undefined. */
export function docLive(l: Layer): LiveShape | undefined {
  const live = l.vector?.live;
  if (!live) return;
  const m = vectorMatrix(l);
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) return;
  return scaleLive(live, m[0], m[3], m[4], m[5]);
}
/** The common offset when `b` is `a` moved rigidly, else undefined. */
export function translation(a: VectorMask, b: VectorMask): [number, number] | undefined {
  if (a.paths.length !== b.paths.length) return;
  let d: [number, number] | undefined;
  for (let i = 0; i < a.paths.length; i++) {
    const p = a.paths[i], q = b.paths[i];
    if (p.knots.length !== q.knots.length || p.open !== q.open || p.operation !== q.operation) return;
    for (let k = 0; k < p.knots.length; k++)
      for (let j = 0; j < 6; j += 2) {
        const dx = q.knots[k].points[j] - p.knots[k].points[j], dy = q.knots[k].points[j + 1] - p.knots[k].points[j + 1];
        if (!d) d = [dx, dy];
        else if (Math.abs(dx - d[0]) > 1e-6 || Math.abs(dy - d[1]) > 1e-6) return;
      }
  }
  return d ?? [0, 0];
}
/** Write edited knots back to the target inside a command's draft. Vector mask
 * rasters are refreshed separately (see masks.ts) because they are async. */
export function writeTarget(d: PhotoDocument, t: PathTarget, mask: VectorMask) {
  const clean = cleanMask(structuredClone(mask));
  if (t.kind === 'work') d.workPath = clean;
  else if (t.kind === 'saved') {
    const p = d.paths?.find((x) => x.id === t.id);
    if (p) p.mask = clean;
  } else {
    const l = findLayer(d.layers, t.id);
    if (!l) return;
    if (t.kind === 'shape' && l.vector) {
      // Moving a live shape keeps it live; any other edit makes it a plain path.
      const live = docLive(l), delta = live && translation(shapeDocMask(l), clean);
      setShapeMask(l, clean, false);
      if (live && delta) l.vector.live = scaleLive(live, 1, 1, delta[0], delta[1]);
    }
    if (t.kind === 'vmask' && l.vectorMask) l.vectorMask.mask = { ...l.vectorMask.mask, paths: clean.paths };
    if (t.kind === 'text') setTextMask(l, clean);
  }
}
/** A shallow preview document with the target replaced (no history entry). */
export function previewTarget(e: Editor, t: PathTarget, mask: VectorMask, doc: PhotoDocument = e.doc): PhotoDocument {
  if (t.kind === 'work') return { ...doc, workPath: mask };
  if (t.kind === 'saved') return { ...doc, paths: doc.paths?.map((p) => (p.id === t.id ? { ...p, mask } : p)) };
  const replace = (layers: Layer[]): Layer[] =>
    layers.map((l) => {
      if (l.id === t.id) {
        if (t.kind === 'shape' && l.vector) {
          const copy = { ...l, vector: { ...l.vector, mask: l.vector.mask, fill: structuredClone(l.vector.fill), stroke: l.vector.stroke && { ...l.vector.stroke } } };
          setShapeMask(copy, mask, true);
          try {
            validateVectorShape(copy.vector);
          } catch {
            return l;
          }
          return copy;
        }
        if (t.kind === 'vmask' && l.vectorMask) return { ...l, vectorMask: { ...l.vectorMask, mask } };
        if (t.kind === 'text' && l.textData?.path) {
          const copy = { ...l };
          setTextMask(copy, mask);
          return copy;
        }
      }
      return l.children.length ? { ...l, children: replace(l.children) } : l;
    });
  return { ...doc, layers: replace(doc.layers) };
}
export function targetLocked(e: Editor, t: PathTarget) {
  if ((t.kind === 'shape' || t.kind === 'vmask' || t.kind === 'text') && layerLock(e.doc.layers, t.id, 'all')) {
    e.message('Unlock this layer to edit its path.');
    return true;
  }
  return false;
}
/** "Path N" for a new saved path, not already used by one. */
export function nextPathName(doc: PhotoDocument) {
  const names = new Set((doc.paths ?? []).map((p) => p.name));
  let n = (doc.paths?.length ?? 0) + 1;
  while (names.has(`Path ${n}`)) n++;
  return `Path ${n}`;
}
export function nextName(doc: PhotoDocument, base: string) {
  const names = new Set([...allLayers(doc.layers).map((l) => l.name), ...(doc.paths ?? []).map((p) => p.name)]);
  let n = 1;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
/** A new shape layer whose knots are in document space (identity transform). */
export function shapeLayer(doc: PhotoDocument, name: string, mask: VectorMask, fill: VectorShape['fill'], stroke: VectorShape['stroke'], live?: VectorShape['live'], color = '#000000'): Layer {
  const l = newLayer('vector', name, doc.width, doc.height);
  l.sourceWidth = doc.width;
  l.sourceHeight = doc.height;
  l.color = color;
  l.vector = { mask: { paths: [] }, reference: { x: 0, y: 0, width: doc.width, height: doc.height }, fill, ...(stroke ? { stroke } : {}) };
  setShapeMask(l, mask, false);
  if (live) l.vector.live = live;
  validateVectorShape(l.vector);
  return l;
}
/** Where Path-mode drawing goes: the active path, or a fresh work path that
 * replaces an unselected one. */
export function drawingTarget(e: Editor): PathTarget {
  const t = targetPath(e);
  if (t && t.kind !== 'shape' && t.kind !== 'text') return t;
  return { kind: 'work', id: 'work', name: 'Work Path', mask: { paths: [] } };
}
