/**
 * Overlay drawing: artboard labels, guides, hover highlight, selection
 * outlines, anchors and handles, the bounding box, alignment guides, cursor
 * feedback labels and tool previews. Drawn in CSS pixels on the overlay
 * canvas so lines stay one pixel wide at every zoom.
 */
import { shapePathOf, tracePath } from './draw.js';
import { hasIn, hasOut } from '../model/bezier.js';
import { nodeBounds, localCorners, frameToDoc } from '../model/geometry.js';
import { layoutText } from '../model/text-layout.js';
import { multiply } from '../lib/matrix.js';
import { liveDef } from '../model/live.js';
import { rectangle } from '../model/shapes.js';

export const ANCHOR_SIZE = 6;
export const HANDLE_RADIUS = 3;
export const BOX_HANDLE = 7;

export function layerColor(editor, id) {
  const layer = editor.doc.layerOf(id);
  return layer?.color || '#4f80ff';
}

/**
 * Leaves under a node (paths, compounds' paths, text, images). Contents of
 * live objects kept in their own space (objects in perspective) are left
 * out: they do not draw where they are stored, so their feature outlines them.
 */
export function leafNodes(doc, node, out = []) {
  if (!node) return out;
  for (let a = node; a; a = a.parent ? doc.get(a.parent) : null) if (a.type === 'group' && liveDef(a)?.ownSpace) return out;
  collectLeaves(doc, node, out);
  return out;
}

function collectLeaves(doc, node, out) {
  if (!node) return;
  if (node.type === 'group' || node.type === 'layer') {
    if (node.type === 'group' && liveDef(node)?.ownSpace) return;
    for (const c of node.children) collectLeaves(doc, doc.get(c), out);
  } else out.push(node);
}

/**
 * Leaves to outline for a selection highlight: like leafNodes, but a live
 * object whose sources do not draw as themselves (a traced image) shows
 * its box instead (a stand-in path, never edited).
 */
function highlightLeaves(doc, node) {
  if (node?.type === 'group' && liveDef(node)?.highlight === 'bounds') {
    const b = nodeBounds(doc, node);
    return b ? [{ id: `${node.id}~box`, type: 'path', anchors: rectangle(b.x, b.y, b.w, b.h), closed: true, standIn: true }] : [];
  }
  return leafNodes(doc, node);
}

function withDocTransform(ctx, view, fn) {
  ctx.save();
  const m = multiply([view.dpr, 0, 0, view.dpr, 0, 0], view.matrix);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  fn();
  ctx.restore();
}

function outlineNode(ctx, editor, node, color, width = 1) {
  const { view, doc } = editor;
  if (node.type === 'path' || node.type === 'compound') {
    const p = shapePathOf(doc, node);
    withDocTransform(ctx, view, () => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width / view.zoom;
      ctx.setLineDash([]);
      ctx.stroke(p);
    });
  } else if (node.type === 'text') {
    // Baselines for point type, the frame for area type.
    const lay = layoutText(node);
    const m = multiply(view.matrix, node.transform);
    ctx.save();
    ctx.setTransform(view.dpr * m[0], view.dpr * m[1], view.dpr * m[2], view.dpr * m[3], view.dpr * m[4], view.dpr * m[5]);
    const s = Math.hypot(m[0], m[1]) || 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = width / s;
    ctx.beginPath();
    if (lay.kind === 'area' && node.areaPath?.length > 2 && !node.vertical) tracePath(ctx, node.areaPath, true);
    else if (lay.kind === 'area') ctx.rect(node.x, node.y, node.width, node.height);
    if (lay.kind === 'path') tracePath(ctx, node.pathAnchors, Boolean(node.pathClosed));
    else {
      for (const l of lay.lines) {
        const a = lay.toLocal(l.x, l.y);
        const b = lay.toLocal(l.x + Math.max(l.width, 1), l.y);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
    ctx.restore();
  } else if (node.type === 'image') {
    const pts = localCorners({ x: 0, y: 0, w: node.width, h: node.height }, node.transform).map((p) => view.toScreen(p.x, p.y));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.moveTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.stroke();
  }
}

export function drawAnchor(ctx, x, y, color, filled, size = ANCHOR_SIZE) {
  const h = size / 2;
  ctx.fillStyle = filled ? color : '#ffffff';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const px = Math.round(x - h) + 0.5;
  const py = Math.round(y - h) + 0.5;
  ctx.fillRect(px, py, size, size);
  ctx.strokeRect(px, py, size, size);
}

function drawHandle(ctx, ax, ay, hx, hy, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(hx, hy, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Collects anchor squares and path outlines so a large selection draws in a
 * few canvas calls per color instead of several per object.
 */
export class OverlayBatch {
  anchors = new Map(); // `${color}|${filled}|${size}` -> Path2D in screen space
  outlines = new Map(); // color -> Path2D in document space

  /** The Path2D collecting anchor squares of one color, fill state and size. */
  anchorPath(color, filled, size = ANCHOR_SIZE) {
    const key = `${color}|${filled ? 1 : 0}|${size}`;
    let p = this.anchors.get(key);
    if (!p) this.anchors.set(key, (p = new Path2D()));
    return p;
  }

  anchor(x, y, color, filled, size = ANCHOR_SIZE) {
    const h = size / 2;
    this.anchorPath(color, filled, size).rect(Math.round(x - h) + 0.5, Math.round(y - h) + 0.5, size, size);
  }

  outline(path, color) {
    let p = this.outlines.get(color);
    if (!p) this.outlines.set(color, (p = new Path2D()));
    p.addPath(path);
  }

  flushOutlines(ctx, view, width = 1) {
    if (!this.outlines.size) return;
    withDocTransform(ctx, view, () => {
      ctx.lineWidth = width / view.zoom;
      ctx.setLineDash([]);
      for (const [color, p] of this.outlines) {
        ctx.strokeStyle = color;
        ctx.stroke(p);
      }
    });
    this.outlines.clear();
  }

  flushAnchors(ctx) {
    ctx.lineWidth = 1;
    for (const [key, p] of this.anchors) {
      const [color, filled] = key.split('|');
      ctx.fillStyle = filled === '1' ? color : '#ffffff';
      ctx.strokeStyle = color;
      ctx.fill(p);
      ctx.stroke(p);
    }
    this.anchors.clear();
  }
}

/** Anchors (and handles of selected anchors) for one path. */
function drawPathAnchors(ctx, editor, node, color, mode, batch = null) {
  const { view } = editor;
  const anchorAt = batch ? (x, y, c, filled, size) => batch.anchor(x, y, c, filled, size) : (x, y, c, filled, size) => drawAnchor(ctx, x, y, c, filled, size);
  if (mode === 'object') {
    // Whole objects: every anchor is a small filled square, no handles.
    if (batch) {
      const p = batch.anchorPath(color, true, 4);
      const m = view.matrix;
      for (const a of node.anchors) p.rect(Math.round(m[0] * a.x + m[2] * a.y + m[4] - 2) + 0.5, Math.round(m[1] * a.x + m[3] * a.y + m[5] - 2) + 0.5, 4, 4);
      return;
    }
    for (const a of node.anchors) {
      const s = view.toScreen(a.x, a.y);
      anchorAt(s.x, s.y, color, true, 4);
    }
    return;
  }
  const sel = editor.selectedAnchors(node.id);
  const partial = editor.anchors.has(node.id);
  const n = node.anchors.length;
  if (mode === 'direct') {
    // Handles of selected anchors and of the neighbors on segments touching them.
    const show = new Set();
    // Several selected anchors show their handles only when Preferences say so.
    const handles = sel.size <= 1 || editor.prefs?.get('showMultiHandles') !== false;
    for (const i of handles ? sel : []) {
      show.add(i);
      if (partial) {
        show.add(i - 1 >= 0 ? i - 1 : node.closed ? n - 1 : -1);
        show.add(i + 1 < n ? i + 1 : node.closed ? 0 : -1);
      }
    }
    for (const i of show) {
      if (i < 0 || i >= n) continue;
      const a = node.anchors[i];
      const s = view.toScreen(a.x, a.y);
      const showIn = sel.has(i) || (partial && sel.has(i - 1 >= 0 ? i - 1 : n - 1));
      const showOut = sel.has(i) || (partial && sel.has((i + 1) % n));
      if (hasIn(a) && showIn && (node.closed || i > 0)) {
        const h = view.toScreen(a.ix, a.iy);
        drawHandle(ctx, s.x, s.y, h.x, h.y, color);
      }
      if (hasOut(a) && showOut && (node.closed || i < n - 1)) {
        const h = view.toScreen(a.ox, a.oy);
        drawHandle(ctx, s.x, s.y, h.x, h.y, color);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const a = node.anchors[i];
    const s = view.toScreen(a.x, a.y);
    const filled = mode === 'object' ? true : sel.has(i) && (partial || mode === 'direct') ? true : !partial && mode !== 'direct';
    anchorAt(s.x, s.y, color, mode === 'direct' ? sel.has(i) : filled, mode === 'object' ? 4 : editor.prefs?.get('anchorSize') || ANCHOR_SIZE);
  }
}

/**
 * Corner points of the selection bounding box in screen space, plus mid
 * handles. `b` may be a frame (selectionFrame) with an angle: its x, y, w, h
 * are then in frame space and `fx`, `fy` keep the frame-space position.
 */
export function boxHandles(editor, b) {
  const { view } = editor;
  const pts = {
    nw: [b.x, b.y],
    n: [b.x + b.w / 2, b.y],
    ne: [b.x + b.w, b.y],
    e: [b.x + b.w, b.y + b.h / 2],
    se: [b.x + b.w, b.y + b.h],
    s: [b.x + b.w / 2, b.y + b.h],
    sw: [b.x, b.y + b.h],
    w: [b.x, b.y + b.h / 2],
  };
  const out = {};
  for (const [k, [fx, fy]] of Object.entries(pts)) {
    const { x, y } = b.angle ? frameToDoc(b, fx, fy) : { x: fx, y: fy };
    out[k] = { ...view.toScreen(x, y), dx: x, dy: y, fx, fy };
  }
  return out;
}

function drawBoundingBox(ctx, editor, b, color) {
  if (!b) return;
  const h = boxHandles(editor, b);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const order = ['nw', 'ne', 'se', 'sw'];
  order.forEach((k, i) => (i ? ctx.lineTo(h[k].x, h[k].y) : ctx.moveTo(h[k].x, h[k].y)));
  ctx.closePath();
  ctx.stroke();
  const tiny = b.w * editor.view.zoom < 16 || b.h * editor.view.zoom < 16;
  for (const [k, p] of Object.entries(h)) {
    if (tiny && k.length === 1) continue;
    const s = BOX_HANDLE;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(p.x - s / 2) + 0.5, Math.round(p.y - s / 2) + 0.5, s - 1, s - 1);
    ctx.strokeRect(Math.round(p.x - s / 2) + 0.5, Math.round(p.y - s / 2) + 0.5, s - 1, s - 1);
  }
}

function drawGuides(ctx, editor, colors) {
  const { view, doc } = editor;
  const guides = doc.root.guides || [];
  if (!guides.length || !editor.viewOptions.guides) return;
  ctx.save();
  ctx.lineWidth = 1;
  if (colors.guideDots) ctx.setLineDash([1, 3]);
  for (const g of guides) {
    ctx.strokeStyle = g.selected ? colors.selection : colors.guide;
    ctx.beginPath();
    if (g.axis === 'x') {
      // Vertical guide at x = pos.
      const a = view.toScreen(g.pos, -1e6);
      const b = view.toScreen(g.pos, 1e6);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    } else {
      const a = view.toScreen(-1e6, g.pos);
      const b = view.toScreen(1e6, g.pos);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Artboard name labels are rasterized once per text/weight/color and blitted each frame. */
const labelCache = new Map();

function labelBitmap(text, weight, color, dpr) {
  const key = `${text}|${weight}|${color}|${dpr}`;
  let c = labelCache.get(key);
  if (c) return c;
  if (labelCache.size > 200) labelCache.clear();
  const font = `${weight} 11px Inter, system-ui, sans-serif`;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 2;
  c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * dpr));
  c.height = Math.ceil(16 * dpr);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 15);
  c.cssWidth = w;
  labelCache.set(key, c);
  return c;
}

function drawArtboardLabels(ctx, editor, colors) {
  const { view, doc } = editor;
  if (!editor.viewOptions.artboards || view.rotation || editor.prefs?.get('showArtboardNames') === false) return;
  const dpr = view.dpr || 1;
  doc.artboards.forEach((a, i) => {
    const p = view.toScreen(a.x, a.y);
    if (p.x > view.width || p.y < 0 || p.y > view.height + 20) return;
    const label = `${String(i + 1).padStart(2, '0')} - ${a.name}`;
    const bmp = labelBitmap(label, i === editor.activeArtboard ? 600 : 400, colors.artboardLabel, dpr);
    ctx.drawImage(bmp, Math.round(p.x), Math.round(p.y - 4 - 15), bmp.cssWidth, 16);
  });
}

function drawAlignmentGuides(ctx, editor, colors) {
  const sg = editor.alignmentGuides;
  if (!sg) return;
  const { view } = editor;
  ctx.save();
  ctx.strokeStyle = colors.alignment;
  ctx.fillStyle = colors.alignment;
  ctx.lineWidth = 1;
  for (const l of sg.lines || []) {
    const a = view.toScreen(l.x1, l.y1);
    const b = view.toScreen(l.x2, l.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.font = '10px Inter, system-ui, sans-serif';
  for (const label of editor.prefs?.get('alignmentGuideLabels') === false ? [] : sg.labels || []) {
    const p = view.toScreen(label.x, label.y);
    const w = ctx.measureText(label.text).width + 8;
    ctx.fillStyle = colors.alignment;
    ctx.fillRect(p.x + 6, p.y + 6, w, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label.text, p.x + 10, p.y + 18);
  }
  ctx.restore();
}

function drawFeedback(ctx, editor) {
  const f = editor.feedback;
  if (!f || !f.text) return;
  ctx.save();
  ctx.font = '11px Inter, system-ui, sans-serif';
  const lines = f.text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
  const h = lines.length * 14 + 8;
  const x = Math.min(f.sx + 14, editor.view.width - w - 4);
  const y = Math.min(f.sy + 14, editor.view.height - h - 4);
  ctx.fillStyle = 'rgba(40, 40, 40, 0.92)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + 6, y + 5 + i * 14));
  ctx.restore();
}

/**
 * Feature overlays (key object outline, guides, dialog previews), drawn
 * above the selection and below alignment guides: fn(ctx, editor, colors).
 */
export const overlayHooks = new Set();

export function drawOverlay(ctx, editor, colors) {
  const { doc } = editor;
  drawArtboardLabels(ctx, editor, colors);
  drawGuides(ctx, editor, colors);
  const tool = editor.tool;
  const mode = tool?.selectionMode || 'object';

  // Hover highlight.
  if (editor.hover && editor.prefs?.get('alignmentGuideHighlight') !== false && !editor.selection.has(editor.hover) && doc.has(editor.hover)) {
    const node = doc.get(editor.hover);
    for (const leaf of highlightLeaves(doc, node)) outlineNode(ctx, editor, leaf, layerColor(editor, leaf.id), 1.5);
  }

  // Selection outlines and anchors: path outlines and anchor squares are
  // batched per color (outlines first, anchors on top) so selecting
  // thousands of objects stays a handful of draw calls.
  if (editor.viewOptions.edges && !editor.textEdit && !editor.dragPreview) {
    const batch = new OverlayBatch();
    for (const id of editor.selection) {
      const node = doc.get(id);
      if (!node || doc.isHidden(id)) continue;
      const color = layerColor(editor, id);
      for (const leaf of highlightLeaves(doc, node)) {
        if (leaf.type === 'path' || leaf.type === 'compound') {
          const p = shapePathOf(doc, leaf);
          if (p) batch.outline(p, color);
        } else outlineNode(ctx, editor, leaf, color, 1);
        if (leaf.type === 'path' && !leaf.standIn) drawPathAnchors(ctx, editor, leaf, color, mode, batch);
        else if (leaf.type === 'compound') {
          for (const c of leaf.children) {
            const cn = doc.get(c);
            if (cn) drawPathAnchors(ctx, editor, cn, color, mode, batch);
          }
        } else if (leaf.type === 'text' && mode !== 'direct') {
          const s = editor.view.toScreen(...anchorOfText(leaf));
          batch.anchor(s.x, s.y, color, true, 5);
        }
      }
    }
    // Paths partially selected inside compounds.
    for (const id of editor.anchors.keys()) {
      if (editor.selection.has(id)) continue;
      const n = doc.get(id);
      if (n) drawPathAnchors(ctx, editor, n, layerColor(editor, id), mode, batch);
    }
    batch.flushOutlines(ctx, editor.view);
    batch.flushAnchors(ctx);
  }

  // Bounding box for the Selection tool family (transformed with a bitmap drag preview).
  if (editor.dragPreview) {
    const b = editor.selectionBounds(false);
    if (b) {
      const m = editor.dragPreview.matrix;
      const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => editor.view.toScreen(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
      ctx.save();
      ctx.strokeStyle = layerColor(editor, editor.topSelection()[0]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  } else if (tool?.showsBoundingBox && editor.viewOptions.boundingBox && editor.selection.size && !editor.textEdit) {
    const b = editor.selectionFrame();
    const first = editor.topSelection()[0];
    if (b) drawBoundingBox(ctx, editor, b, layerColor(editor, first));
  }

  for (const hook of overlayHooks) hook(ctx, editor, colors);
  drawAlignmentGuides(ctx, editor, colors);
  tool?.drawOverlay?.(ctx, editor, colors);
  drawFeedback(ctx, editor);
}

function anchorOfText(node) {
  const m = node.transform;
  let x = node.x;
  let y = node.y;
  if (node.kind === 'path' && node.pathAnchors?.length) ({ x, y } = node.pathAnchors[0]);
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function selectionColor(editor) {
  const first = editor.topSelection()[0];
  return first ? layerColor(editor, first) : '#4f80ff';
}

export { nodeBounds };
