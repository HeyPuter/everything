/**
 * Brush definitions and where they live.
 *
 * A document's brushes are doc.root.brushes (an array, undoable like any
 * root edit); a document that never touched its brushes uses the default
 * set. A path painted with a brush has node.brush = { id, ...overrides }:
 * the brush is looked up by id (in the document, then the built-in
 * libraries so pasted artwork keeps its look) and the overrides (from
 * Options of Selected Object) replace whole parameters.
 *
 * Types and parameters:
 *   calligraphic  angle (deg), roundness (%), size (pt): each a Variable
 *                 { mode: 'fixed' | 'random' | 'pressure' | 'velocity', value,
 *                 variation } (velocity: how fast the stroke was drawn, kept
 *                 on the path as node.brush.velocity [[t, v]])
 *   scatter       art; size / spacing / scatter (%), rotation (deg): Ranges
 *                 { mode, min, max }; rotateRelative 'page' | 'path'; colorize
 *   art           art; direction 'right' | 'left' | 'down' | 'up'; width
 *                 (Variable, %); scaling 'proportional' | 'stretch' | 'guides';
 *                 guides { start, end } (0..1 of the art's length); flipAlong,
 *                 flipAcross; overlap 'adjust' | 'none'; colorize
 *   pattern       tiles { side, outer, inner, start, end } (art, 'auto' for
 *                 the corners, or null); scale (Variable, %); spacing (%);
 *                 flipAlong, flipAcross; fit 'stretch' | 'space' |
 *                 'approximate'; colorize
 *   bristle       shape, size (pt), length, density, thickness, opacity,
 *                 stiffness (%)
 *
 * Art is { items: [{ subpaths: [{ anchors, closed }], fill, stroke,
 * strokeWidth, strokeCap, strokeJoin, miterLimit, fillRule, opacity }],
 * bounds: { x, y, w, h } } in its own coordinates. Colorization is
 * { method: 'none' | 'tints' | 'tintsShades' | 'hueShift', key: '#rrggbb' }.
 */
import { uid } from '../../lib/ids.js';
import { pathBounds } from '../../model/bezier.js';
import { effectiveSubpaths } from '../../model/geom-effects.js';

export const BRUSH_TYPES = {
  calligraphic: { label: 'Calligraphic Brush', short: 'Calligraphic' },
  scatter: { label: 'Scatter Brush', short: 'Scatter' },
  art: { label: 'Art Brush', short: 'Art' },
  pattern: { label: 'Pattern Brush', short: 'Pattern' },
  bristle: { label: 'Bristle Brush', short: 'Bristle' },
};

export const BRISTLE_SHAPES = [
  { value: 'roundPoint', label: 'Round Point' },
  { value: 'roundBlunt', label: 'Round Blunt' },
  { value: 'roundCurve', label: 'Round Curve' },
  { value: 'roundAngle', label: 'Round Angle' },
  { value: 'flatPoint', label: 'Flat Point' },
  { value: 'flatBlunt', label: 'Flat Blunt' },
  { value: 'flatCurve', label: 'Flat Curve' },
  { value: 'flatAngle', label: 'Flat Angle' },
  { value: 'fan', label: 'Fan' },
];

export const COLORIZE_METHODS = [
  { value: 'none', label: 'None' },
  { value: 'tints', label: 'Tints' },
  { value: 'tintsShades', label: 'Tints and Shades' },
  { value: 'hueShift', label: 'Hue Shift' },
];

const v = (value, mode = 'fixed', variation = 0) => ({ mode, value, variation });
const r = (min, max = min, mode = 'fixed') => ({ mode, min, max });

/** Defaults for a new brush of a type. */
export function brushDefaults(type) {
  switch (type) {
    case 'calligraphic':
      return { type, angle: v(0), roundness: v(100), size: v(3) };
    case 'scatter':
      return { type, art: null, size: r(100), spacing: r(100), scatter: r(0), rotation: r(0), rotateRelative: 'page', colorize: { method: 'none', key: '#000000' } };
    case 'art':
      return { type, art: null, direction: 'right', width: v(100), scaling: 'stretch', guides: { start: 0.25, end: 0.75 }, flipAlong: false, flipAcross: false, overlap: 'none', colorize: { method: 'none', key: '#000000' } };
    case 'pattern':
      return { type, tiles: { side: null, outer: 'auto', inner: 'auto', start: null, end: null }, scale: v(100), spacing: 0, flipAlong: false, flipAcross: false, fit: 'stretch', colorize: { method: 'none', key: '#000000' } };
    case 'bristle':
      return { type, shape: 'roundPoint', size: 3, length: 100, density: 40, thickness: 50, opacity: 75, stiffness: 50 };
    default:
      throw new Error(`Unknown brush type ${type}`);
  }
}

/** A complete brush from partial fields (fills in defaults, gives it an id). */
export function makeBrush(fields) {
  const base = brushDefaults(fields.type);
  return { ...base, id: fields.id || uid('br'), name: fields.name || BRUSH_TYPES[fields.type].short, ...fields };
}

// ---- document storage ----

let defaultSet = null;
let libraryIndex = null;
let librarySource = () => ({ defaults: [], libraries: [] });

/** The module that holds the built-in brushes registers them here (keeps this file free of artwork). */
export function setBrushSource(fn) {
  librarySource = fn;
  defaultSet = null;
  libraryIndex = null;
}

export function defaultBrushes() {
  if (!defaultSet) defaultSet = Object.freeze(librarySource().defaults);
  return defaultSet;
}

export function brushLibraries() {
  return librarySource().libraries;
}

function libraryBrush(id) {
  if (!libraryIndex) {
    libraryIndex = new Map();
    for (const b of defaultBrushes()) libraryIndex.set(b.id, b);
    for (const lib of brushLibraries()) for (const b of lib.brushes) libraryIndex.set(b.id, b);
  }
  return libraryIndex.get(id) || null;
}

/** The document's brushes (the default set until the document changes them). */
export function docBrushes(doc) {
  return doc.root?.brushes || defaultBrushes();
}

/** Replace the document's brush list (inside a transaction). */
export function setDocBrushes(doc, list) {
  doc.updateRoot({ brushes: list });
}

/** A brush definition by id: the document's, else a built-in one. */
export function brushById(doc, id) {
  if (!id) return null;
  return docBrushes(doc).find((b) => b.id === id) || libraryBrush(id);
}

const KEEP = new Set(['id', 'type', 'name', 'art', 'tiles']);

/** The effective brush for a path: its definition with the path's overrides. */
export function resolveBrush(doc, node) {
  const ref = node?.brush;
  if (!ref) return null;
  const def = brushById(doc, ref.id);
  if (!def) return null;
  let out = def;
  for (const [k, val] of Object.entries(ref)) {
    if (KEEP.has(k) || val === undefined) continue;
    if (out === def) out = { ...def };
    out[k] = val;
  }
  return out;
}

/** Whether a path or compound path is painted with a brush. */
export function hasBrush(node) {
  return Boolean(node && (node.type === 'path' || node.type === 'compound') && node.brush?.id);
}

// ---- art from selected objects ----

const ART_STYLE = ['fill', 'stroke', 'strokeWidth', 'strokeCap', 'strokeJoin', 'miterLimit', 'fillRule', 'opacity'];

/**
 * Brush art from document objects (paths, compound paths, and groups of
 * them; effects and live shapes baked). Returns { art, skipped } where
 * skipped counts objects that cannot be brush art (type, images).
 */
export function artFromNodes(doc, nodes) {
  const items = [];
  let skipped = 0;
  const visit = (n, opacity) => {
    if (!n || n.hidden) return;
    if (n.type === 'group') {
      const kids = n.clip ? n.children.slice(0, -1) : n.children;
      for (const c of kids) visit(doc.get(c), opacity * (n.opacity ?? 1));
      return;
    }
    if (n.type !== 'path' && n.type !== 'compound') {
      skipped++;
      return;
    }
    const subpaths = effectiveSubpaths(doc, n).filter((s) => s.anchors.length > 1).map((s) => ({ anchors: s.anchors.map((a) => ({ ...a })), closed: s.closed }));
    if (!subpaths.length || (!n.fill && !(n.stroke && n.strokeWidth > 0))) return;
    const item = { subpaths };
    for (const k of ART_STYLE) if (n[k] !== undefined) item[k] = n[k];
    item.opacity = (n.opacity ?? 1) * opacity;
    items.push(item);
  };
  for (const n of nodes) visit(n, 1);
  return { art: items.length ? { items, bounds: artBounds(items) } : null, skipped };
}

/** Bounds of art items including half their stroke widths. */
export function artBounds(items) {
  let b = null;
  for (const it of items) {
    const pad = it.stroke && it.strokeWidth > 0 ? it.strokeWidth / 2 : 0;
    for (const s of it.subpaths) {
      const r0 = pathBounds(s.anchors, s.closed);
      if (!r0) continue;
      const r1 = { x: r0.x - pad, y: r0.y - pad, w: r0.w + 2 * pad, h: r0.h + 2 * pad };
      if (!b) b = r1;
      else {
        const x = Math.min(b.x, r1.x);
        const y = Math.min(b.y, r1.y);
        b = { x, y, w: Math.max(b.x + b.w, r1.x + r1.w) - x, h: Math.max(b.y + b.h, r1.y + r1.h) - y };
      }
    }
  }
  return b || { x: 0, y: 0, w: 1, h: 1 };
}

/** Brushes using art need some; the error message when a selection cannot make one. */
export function newBrushProblem(type, art) {
  if (type === 'calligraphic' || type === 'bristle') return null;
  if (!art) return `Select artwork (paths or groups of paths) to make a ${BRUSH_TYPES[type].label.toLowerCase()}.`;
  return null;
}

/** Ids of document objects that use a brush. */
export function brushUsers(doc, brushId) {
  const out = [];
  doc.walk((n) => {
    if (n.brush?.id === brushId) out.push(n.id);
    return true;
  });
  return out;
}

/** A fresh copy of a brush definition (new id, "copy" name) for Duplicate Brush or adding a library brush. */
export function copyBrush(def, name = def.name) {
  return { ...JSON.parse(JSON.stringify(def)), id: uid('br'), name };
}

/** Next free "<base> n" name among the document's brushes. */
export function uniqueBrushName(doc, base) {
  const names = new Set(docBrushes(doc).map((b) => b.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
