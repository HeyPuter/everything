/**
 * Drawing pattern paints.
 *
 * Canvas: the definition's repeating cell is rendered once into a bitmap at
 * the device scale it is shown at (in half-octave steps, so zooming reuses
 * bitmaps) and filled through a CanvasPattern whose matrix maps the bitmap
 * onto the pattern's place in the document.
 *
 * Export: SVG writes a native <pattern> holding the cell's copies of the art
 * (<use> references to one copy). Other writers (PDF, print) get the pattern
 * baked through the export view: the fill becomes the tile copies covering
 * the object, clipped by its shape, so the output stays vector.
 */
import { drawNode, imageFor, drawHooks } from '../../render/draw.js';
import { exportBakers, svgPaintHooks } from '../io/hooks.js';
import { multiply, invert, translate, IDENTITY } from '../../lib/matrix.js';
import { visualBounds, transformRect, transformPatches } from '../../model/geometry.js';
import { virtualId } from '../../model/live.js';
import { stackPaints } from '../../model/appearance.js';
import { lattice, copiesIn, artBounds, patternView, findPattern, patternsOf } from './model.js';

/** Largest side of a cell bitmap in device pixels. */
const MAX_CELL_PX = 2048;
/** Most tile copies baked into one exported object before falling back to a flat color. */
export const MAX_BAKED_COPIES = 4000;

const cellCache = new WeakMap(); // dependency context -> Map(scaleKey -> entry)
const contexts = new WeakMap();
let depth = 0;

/** Track nested patterns and decoded images while retaining caches for unrelated edits. */
function cacheContext(doc, def) {
  const patterns = doc?.root?.patterns;
  const assets = doc?.assets;
  const previous = contexts.get(def);
  if (previous && previous.assets === assets && [...previous.images].every(([id, image]) => imageFor(doc, id) === image)) {
    if (previous.patterns === patterns) return previous.key;
    if ([...previous.dependencies].every(([id, value]) => findPattern(doc, id) === value)) {
      previous.patterns = patterns;
      return previous.key;
    }
  }
  const dependencies = new Map();
  const images = new Map();
  const seen = new Set([def]);
  const pending = [def];
  const visit = (paint) => {
    if (paint?.type !== 'pattern' || dependencies.has(paint.id)) return;
    const nested = findPattern(doc, paint.id);
    dependencies.set(paint.id, nested);
    if (nested && !seen.has(nested)) { seen.add(nested); pending.push(nested); }
  };
  while (pending.length) patternView(doc, pending.pop()).walk((node) => {
    if (node.type === 'image' && !images.has(node.asset)) images.set(node.asset, imageFor(doc, node.asset));
    visit(node.fill);
    visit(node.stroke);
    for (const paint of stackPaints(node)) visit(paint);
    if (Array.isArray(node.runs)) for (const run of node.runs) { visit(run.fill); visit(run.stroke); }
  });
  const key = {};
  contexts.set(def, { patterns, assets, dependencies, images, key });
  return key;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

/** Half-octave scale bucket at or above s (crisp, and few distinct bitmaps while zooming). */
export function scaleBucket(s) {
  if (!(s > 0) || !Number.isFinite(s)) return 1;
  return 2 ** (Math.ceil(Math.log2(s) * 2 - 1e-9) / 2);
}

/** True when every image in the art has decoded (otherwise the bitmap is not kept). */
function imagesReady(doc, def) {
  let ready = true;
  patternView(doc, def).walk((node) => { if (node.type === 'image' && !imageFor(doc, node.asset)) ready = false; });
  return ready;
}

/**
 * The cell bitmap of a definition at `s` device pixels per pattern unit:
 * { canvas, cell, pw, ph } or null (empty art, nested too deep).
 */
export function cellBitmap(doc, def, s) {
  const art = artBounds(def, doc);
  if (!art || depth > 3) return null;
  const { cell } = lattice(def);
  const sb = scaleBucket(s);
  const context = cacheContext(doc, def);
  let byScale = cellCache.get(context);
  const key = String(sb);
  const hit = byScale?.get(key);
  if (hit) return hit;
  let pw = Math.max(1, Math.round(cell.w * sb));
  let ph = Math.max(1, Math.round(cell.h * sb));
  const k = Math.min(1, MAX_CELL_PX / Math.max(pw, ph));
  pw = Math.max(1, Math.round(pw * k));
  ph = Math.max(1, Math.round(ph * k));
  const canvas = makeCanvas(pw, ph);
  const ctx = canvas.getContext('2d');
  const sx = pw / cell.w;
  const sy = ph / cell.h;
  const v = patternView(doc, def);
  depth++;
  try {
    for (const c of copiesIn(def, cell, art)) {
      ctx.setTransform(sx, 0, 0, sy, (c.dx - cell.x) * sx, (c.dy - cell.y) * sy);
      for (const id of v.roots) drawNode(ctx, v, v.get(id), { viewRect: null, outline: false, hairline: 1 / Math.max(sx, sy), scale: Math.max(sx, sy) });
    }
  } finally {
    depth--;
  }
  const entry = { canvas, cell, pw, ph };
  if (imagesReady(doc, def)) {
    if (!byScale) cellCache.set(context, (byScale = new Map()));
    // A few scales per definition are plenty (the view moves between neighbouring buckets).
    if (byScale.size >= 6) byScale.delete(byScale.keys().next().value);
    byScale.set(key, entry);
  }
  return entry;
}

/** The definition a pattern paint refers to in a document (or document view). */
export function patternDef(doc, paint) {
  if (!paint || paint.type !== 'pattern') return null;
  return (doc?.root?.patterns || []).find((p) => p.id === paint.id) || null;
}

/**
 * Canvas style for a pattern paint (drawHooks.paintStyle). Type is drawn in
 * its own transform (times the run placement `seg`), so the pattern matrix
 * is moved into that space.
 */
export function patternStyle(ctx, doc, node, paint, seg = null) {
  if (paint?.type !== 'pattern') return null;
  const def = patternDef(doc, paint);
  if (!def) return null;
  let local = paint.transform || IDENTITY;
  if (node?.type === 'text' && node.transform) local = multiply(invert(seg ? multiply(node.transform, seg) : node.transform), local);
  const t = ctx.getTransform ? ctx.getTransform() : null;
  const dev = t ? multiply([t.a, t.b, t.c, t.d, t.e, t.f], local) : local;
  const s = Math.max(Math.hypot(dev[0], dev[1]), Math.hypot(dev[2], dev[3]), 1e-6);
  const bmp = cellBitmap(doc, def, s);
  if (!bmp) return null;
  const pat = ctx.createPattern?.(bmp.canvas, 'repeat');
  if (!pat) return null;
  const m = multiply(local, [bmp.cell.w / bmp.pw, 0, 0, bmp.cell.h / bmp.ph, bmp.cell.x, bmp.cell.y]);
  if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix(m));
  return pat;
}

// ---- swatch previews ----

const known = new Map(); // pattern id -> latest definition seen
const knownDocument = { root: { patterns: [] }, assets: new Map() };
const thumbCache = new WeakMap(); // dependency context -> css

/** Remember the definitions of a document so swatch previews (which only see the paint) can find them. */
export function rememberPatterns(list) {
  let changed = false;
  for (const def of list || []) if (known.get(def.id) !== def) { known.set(def.id, def); changed = true; }
  if (changed) knownDocument.root.patterns = [...known.values()];
}

export function knownPattern(id) {
  return known.get(id) || null;
}

const isJsdom = () => typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent || '');

/** CSS background previewing a pattern paint (tiles about 14 px wide), or null. */
export function patternCss(paint, doc = null) {
  const def = (doc && patternDef(doc, paint)) || known.get(paint?.id);
  if (!def) return null;
  const owner = doc || knownDocument;
  const context = cacheContext(owner, def);
  let css = thumbCache.get(context);
  if (css !== undefined) return css;
  css = null;
  const { cell } = lattice(def);
  const s = 14 / Math.max(1, Math.max(def.width || 1, def.height || 1));
  if (!isJsdom()) {
    try {
      const bmp = cellBitmap(owner, def, s * 2);
      if (bmp && bmp.canvas.toDataURL) css = `url("${bmp.canvas.toDataURL()}") 0 0 / ${(cell.w * s).toFixed(2)}px ${(cell.h * s).toFixed(2)}px repeat, #ffffff`;
    } catch {
      css = null;
    }
  }
  thumbCache.set(context, css || '#ffffff');
  return css || '#ffffff';
}

// ---- SVG ----

/** Inner parts of an exported SVG: { defs, body } (strings). */
function svgParts(text) {
  const open = text.indexOf('<svg');
  const start = text.indexOf('>', open) + 1;
  const end = text.lastIndexOf('</svg>');
  let inner = text.slice(start, end);
  inner = inner.replace(/^\s*<title>[\s\S]*?<\/title>/, '');
  const d0 = inner.indexOf('<defs>');
  if (d0 < 0) return { defs: '', body: inner };
  const d1 = inner.lastIndexOf('</defs>');
  return { defs: inner.slice(d0 + 6, d1), body: inner.slice(0, d0) + inner.slice(d1 + 7) };
}

/**
 * SVG paint server for a pattern paint (svgPaintHooks.pattern): a
 * <pattern> over the cell holding <use> copies of the art, which is written
 * once into <defs>, written by `writeSVG` (the exporter, passed in by it).
 */
export function svgPattern(writer, paint, node, mapped, writeSVG) {
  const def = patternDef(writer.doc, paint);
  if (!def || depth > 3) return null;
  const art = artBounds(def, writer.doc);
  if (!art) return null;
  writer.patternArt ||= new Map();
  let artId = writer.patternArt.get(def);
  if (!artId) {
    const prefix = `${writer.o.idPrefix || ''}${writer.newId('pt')}_`;
    depth++;
    let text;
    try {
      text = writeSVG(patternView(writer.doc, def), { rect: { x: 0, y: 0, w: 1, h: 1 }, cull: false, minify: writer.o.minify, precision: writer.o.precision, idPrefix: prefix, writeIds: false, textMode: writer.o.textMode, outlines: writer.o.outlines });
    } finally {
      depth--;
    }
    const { defs, body } = svgParts(text);
    if (defs.trim()) writer.defs.push(defs);
    artId = writer.def('pa', (id) => `${writer.nl(2)}<g id="${id}">${body}${writer.nl(2)}</g>`);
    writer.patternArt.set(def, artId);
  }
  const { cell } = lattice(def);
  const T = paint.transform || IDENTITY;
  const space = mapped === true ? translate(-writer.ox, -writer.oy) : invert(Array.isArray(mapped) ? multiply(node.transform, mapped) : node.transform);
  const P = multiply(multiply(space, T), translate(cell.x, cell.y));
  const n = (v) => writer.n(v);
  const nl = writer.nl(3);
  writer.needsXlink = true;
  const uses = copiesIn(def, cell, art)
    .map((c) => `${nl}<use xlink:href="#${artId}" href="#${artId}"${c.dx || c.dy ? ` x="${n(c.dx - cell.x)}" y="${n(c.dy - cell.y)}"` : ''}/>`)
    .join('');
  const shift = cell.x || cell.y ? ` transform="translate(${n(-cell.x)} ${n(-cell.y)})"` : '';
  const tf = P.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12) ? '' : ` patternTransform="matrix(${P.map((v) => Number(v.toFixed(6))).join(' ')})"`;
  // Copies are positioned relative to the cell, so the extra shift is only needed when it does not start at 0,0.
  return writer.def('pat', (id) => `${writer.nl(2)}<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(cell.w)}" height="${n(cell.h)}"${tf}>${shift ? `${writer.nl(3)}<g${shift}>` : ''}${uses}${shift ? `${writer.nl(3)}</g>` : ''}${writer.nl(2)}</pattern>`);
}

// ---- baked export (PDF, print) ----

/** A flat color standing in for a pattern where tiles cannot be used (pattern strokes, huge fills). */
export function patternColor(def) {
  for (const n of def?.art?.nodes || []) {
    if (n.fill?.type === 'solid') return n.fill.color;
    if (n.stroke?.type === 'solid' && n.strokeWidth > 0) return n.stroke.color;
  }
  return '#808080';
}

/** Copy art roots into `extra` transformed by m (fresh virtual ids). Returns the new root ids. */
function cloneArt(pv, m, parent, extra) {
  const patches = new Map();
  for (const id of pv.roots) transformPatches(pv, pv.get(id), m, {}, patches);
  const copy = (id, parentId) => {
    const n = pv.get(id);
    if (!n) return null;
    const nid = virtualId(id);
    const out = { ...n, ...patches.get(id), id: nid, parent: parentId };
    if (n.children) out.children = n.children.map((c) => copy(c, nid)).filter(Boolean);
    extra.set(nid, out);
    return nid;
  };
  return pv.roots.map((id) => copy(id, parent)).filter(Boolean);
}

export function hasPatternPaint(n) {
  return Boolean(n && (n.type === 'path' || n.type === 'compound' || n.type === 'text') && (n.fill?.type === 'pattern' || n.stroke?.type === 'pattern'));
}

/**
 * Export baker: a pattern-filled object becomes a group of
 * [clip group (tile copies + the object's shape as the clipping path), the
 * object's stroke]. Pattern strokes and type use the pattern's main color.
 */
export function bakePattern(n, view, extra) {
  const flat = (p) => (p?.type === 'pattern' ? { type: 'solid', color: patternColor(patternDef(view, p)) } : p);
  const def = patternDef(view, n.fill);
  const region = visualBounds(view, { ...n, stroke: flat(n.stroke) });
  const T = n.fill?.transform || IDENTITY;
  let copies = [];
  if (def && region && n.type !== 'text' && artBounds(def, view)) copies = copiesIn(def, transformRect(region, invert(T)), artBounds(def, view), MAX_BAKED_COPIES);
  if (!def || n.type === 'text' || !copies.length || copies.length > MAX_BAKED_COPIES) {
    // A missing or empty pattern draws nothing (as on screen); type and very dense fills get the main color.
    const solid = def && artBounds(def, view) && (n.type === 'text' || copies.length > MAX_BAKED_COPIES);
    return { ...n, fill: n.fill?.type === 'pattern' ? (solid ? flat(n.fill) : null) : n.fill, stroke: flat(n.stroke) };
  }
  const pv = patternView(view, def);
  const groupId = n.id;
  const clipId = virtualId(n.id);
  const tilesId = virtualId(n.id);
  const maskId = virtualId(n.id);
  const tiles = { id: tilesId, type: 'group', parent: clipId, children: [], clip: false, hidden: false, locked: false };
  for (const c of copies) tiles.children.push(...cloneArt(pv, multiply(T, translate(c.dx, c.dy)), tilesId, extra));
  extra.set(tilesId, tiles);
  extra.set(maskId, { ...n, id: maskId, parent: clipId, fill: { type: 'solid', color: '#000000' }, stroke: null, opacity: 1, blendMode: 'normal', effects: [] });
  extra.set(clipId, { id: clipId, type: 'group', parent: groupId, children: [tilesId, maskId], clip: true, hidden: false, locked: false });
  const kids = [clipId];
  if (n.stroke && n.strokeWidth > 0) {
    const strokeId = virtualId(n.id);
    extra.set(strokeId, { ...n, id: strokeId, parent: groupId, fill: null, stroke: flat(n.stroke), opacity: 1, blendMode: 'normal', effects: [] });
    kids.push(strokeId);
  }
  const out = { id: groupId, type: 'group', parent: n.parent, name: n.name || '', children: kids, clip: false, hidden: false, locked: false };
  for (const k of ['opacity', 'blendMode', 'effects']) if (n[k] !== undefined) out[k] = n[k];
  return out;
}

export { findPattern, patternsOf };

// Pattern paints draw, export and bake wherever this module is loaded.
drawHooks.paintStyle = (ctx, doc, node, paint, seg) => (paint?.type === 'pattern' ? patternStyle(ctx, doc, node, paint, seg) : null);
svgPaintHooks.pattern = svgPattern;
if (!exportBakers.some((b) => b.key === 'pattern')) exportBakers.push({ key: 'pattern', test: hasPatternPaint, bake: bakePattern });
