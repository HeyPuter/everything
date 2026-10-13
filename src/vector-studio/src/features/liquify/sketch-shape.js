/**
 * Sketch Shape tool: draw a rough shape and it becomes a clean, live one
 * (rectangle, square, ellipse, circle, triangle, regular polygon or line).
 * Scribble over artwork to edit it:
 *   - within a single shape: delete the shape
 *   - only over where shapes overlap: punch the overlap out
 *   - from one shape across others: merge them, in the color where the
 *     scribble started
 */
import { Tool } from '../../tools/tool.js';
import { createPath, pickStyle } from '../../model/nodes.js';
import { shapeAnchors } from '../../model/shapes.js';
import { hitNode } from '../../render/hit.js';
import { newPathStyle } from '../../tools/pen.js';
import { recognizeGesture } from './gestures.js';

/** Editable top-level shapes whose fill contains the point, topmost first. */
function shapesAt(editor, x, y) {
  const doc = editor.doc;
  const out = [];
  for (const n of [...doc.leaves()].reverse()) {
    if ((n.type !== 'path' && n.type !== 'compound') || doc.isLocked(n.id) || doc.isHidden(n.id)) continue;
    if (n.type === 'path' && !n.closed) continue;
    if (hitNode(doc, { ...n, fill: n.fill || { type: 'solid', color: '#000000' } }, x, y, 0, { fillOnly: true })) out.push(n);
  }
  return out;
}

export class SketchShapeTool extends Tool {
  static id = 'sketch-shape';
  static label = 'Sketch Shape Tool';
  static shortcut = 'Shift+N';
  static icon = 'tool-sketch-shape';
  static hint = 'Draw a rough rectangle, ellipse, triangle, polygon or line to make a clean shape | Scribble over shapes to delete, punch out or merge them';

  activate() {
    this.setCursor('var(--cursor-pencil)');
    this.status();
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    this.pts = [{ x: e.x, y: e.y }];
  }

  onPointerMove(e) {
    if (!this.pts) return;
    const list = e.native?.getCoalescedEvents?.() || [];
    if (list.length > 1) for (const s of list) this.pts.push(this.app.eventToDoc(s));
    else this.pts.push({ x: e.x, y: e.y });
    this.overlay();
  }

  async onPointerUp() {
    const pts = this.pts;
    this.pts = null;
    this.overlay();
    if (!pts || pts.length < 3) return;
    const g = recognizeGesture(pts);
    if (!g) {
      this.app.notify('Shape not recognized. Draw a rectangle, ellipse, triangle, polygon or line.', { polite: true });
      return;
    }
    if (g.type === 'scribble') await this.scribble(pts);
    else this.place(g);
  }

  cancel() {
    this.pts = null;
    this.overlay();
  }

  place(g) {
    const editor = this.editor;
    const doc = editor.doc;
    const anchors = g.shape ? shapeAnchors(g.shape) : g.anchors;
    if (!anchors?.length) return;
    const style = newPathStyle(editor);
    if (!g.closed) style.fill = null;
    const node = createPath(anchors, g.closed, style, g.shape ? { shape: g.shape } : {});
    doc.transact('Sketch Shape', () => editor.insertDrawn(node));
    editor.select([node.id]);
  }

  async scribble(pts) {
    const editor = this.editor;
    const doc = editor.doc;
    const touched = new Map();
    const counts = [];
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 80))) {
      const under = shapesAt(editor, pts[i].x, pts[i].y);
      counts.push(under.length);
      for (const n of under) touched.set(n.id, n);
    }
    if (!touched.size) return;
    const start = shapesAt(editor, pts[0].x, pts[0].y)[0] || [...touched.values()][0];
    if (touched.size === 1) {
      doc.transact('Delete Shape', () => doc.remove(start.id));
      editor.select([]);
      return;
    }
    const ids = [...touched.keys()];
    // Only over overlaps (every sample inside two or more shapes): punch them out.
    const onlyOverlap = counts.every((c) => c === 0 || c >= 2);
    editor.select(ids);
    if (onlyOverlap) {
      await this.app.commands.run('pathfinder.exclude');
      return;
    }
    // Merged artwork takes the paint of the shape where the scribble started.
    const style = pickStyle(start);
    doc.transact('Merge Shapes', () => ids.forEach((id) => doc.update(id, { fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth })));
    await this.app.commands.run('pathfinder.unite');
  }

  drawOverlay(ctx, editor) {
    const pts = this.pts;
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = editor.view.toScreen(p.x, p.y);
      if (i) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
    });
    ctx.stroke();
    ctx.restore();
  }
}
