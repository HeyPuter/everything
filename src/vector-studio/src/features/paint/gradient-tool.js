/**
 * Gradient tool (G) with an on-canvas gradient annotator.
 *
 * Drag across an object to set its gradient vector (stored as x1, y1, x2,
 * y2 in document space; Shift constrains to 45 degrees). Clicking an
 * object without a gradient selects it and applies the last gradient. With
 * a gradient-filled object selected, the annotator shows the gradient bar:
 * drag the round origin to move the gradient, the square end point to
 * resize it, just outside the end point to rotate it, stops along the bar
 * to move them (drag away from the bar to remove one), midpoint diamonds to
 * skew the blend, click the bar to add a stop, and for radial gradients
 * drag the dot on the dashed ellipse to change the aspect ratio. On a
 * freeform gradient the annotator shows its color points instead: click
 * the object to add a point, drag points to move them, Delete removes the
 * selected one. In lines mode a new point continues the line from the
 * selected point (Shift+click places a point on its own) and clicking a
 * line inserts a point on it.
 * Edits apply to the focused paint (fill or stroke).
 */
import { Tool, tol, constrain45 } from '../../tools/tool.js';
import { hitTest } from '../../render/hit.js';
import { gradientGeometry, nodeBounds } from '../../model/geometry.js';
import { isGradient } from '../../model/gradients.js';
import { paintTargets } from '../../ops/paint-ops.js';
import { setGradientVector, insertStop, moveStop, removeStop, setMidpoint, projectOnVector, DEFAULT_LINEAR } from './gradient-model.js';
import { paintState } from './ui-common.js';
import { isFreeform, addPoint, setPoint, removePoint, sampleFreeform, insertLinePoint, freeformFrame, framePoint, frameFraction } from './freeform.js';
import { rgbToHex } from '../../lib/color.js';

const POINT_R = 7;

const HANDLE = 6;
const ROTATE_RING = 16;
const REMOVE_PX = 28;

export class GradientTool extends Tool {
  static id = 'gradient';
  static label = 'Gradient Tool';
  static shortcut = 'G';
  static icon = 'tool-gradient';
  static hint = 'Drag across an object to set its gradient | Drag stops on the bar, click the bar to add one | Shift constrains to 45 degrees';

  constructor(app) {
    super(app);
    this.drag = null;
    this.hoverPart = null;
  }

  activate() {
    this.setCursor('var(--cursor-gradient)');
    this.status();
    this.overlay();
  }

  deactivate() {
    this.cancel();
  }

  /** Selected paintable objects whose focused paint is a gradient. */
  targets() {
    const ed = this.editor;
    if (!ed) return [];
    const key = ed.focusPaint;
    return paintTargets(ed).filter((n) => isGradient(n[key]));
  }

  /** Resolved annotator geometry for a node (document space). */
  geom(node) {
    const key = this.editor.focusPaint;
    const paint = node[key];
    const b = nodeBounds(this.editor.doc, node) || { x: 0, y: 0, w: 1, h: 1 };
    const g = gradientGeometry(paint, b);
    // Radial gradients without explicit end points follow their angle.
    if (paint.type === 'radial' && paint.x1 === undefined && paint.angle) {
      const a = (-(paint.angle || 0) * Math.PI) / 180;
      g.x2 = g.x1 + Math.cos(a) * g.r;
      g.y2 = g.y1 + Math.sin(a) * g.r;
    }
    return { paint, g, key };
  }

  /** What the pointer is over on the annotator (screen space test). */
  partAt(e) {
    // View > Hide Gradient Annotator: dragging always draws a new gradient vector.
    if (this.editor.viewOptions.gradientAnnotator === false) return null;
    const t = this.targets();
    if (t.length !== 1) return null;
    const node = t[0];
    const { paint, g } = this.geom(node);
    const v = this.editor.view;
    const s1 = v.toScreen(g.x1, g.y1);
    const s2 = v.toScreen(g.x2, g.y2);
    const d = (p) => Math.hypot(e.sx - p.x, e.sy - p.y);
    // Stops first (they sit on the bar).
    const len = Math.hypot(s2.x - s1.x, s2.y - s1.y);
    for (let i = paint.stops.length - 1; i >= 0; i--) {
      const p = stopScreen(s1, s2, paint.stops[i].offset);
      if (d(p) <= HANDLE + 1 && len > 12) return { kind: 'stop', index: i, node };
    }
    for (let i = 0; i < paint.stops.length - 1; i++) {
      const a = paint.stops[i];
      const b = paint.stops[i + 1];
      const o = a.offset + (b.offset - a.offset) * (a.midpoint ?? 0.5);
      const p = midpointScreen(s1, s2, o);
      if (d(p) <= HANDLE && len > 20) return { kind: 'mid', index: i, node };
    }
    if (d(s2) <= HANDLE + 1) return { kind: 'end', node };
    if (d(s1) <= HANDLE + 1) return { kind: 'origin', node };
    if (paint.type === 'radial') {
      const ap = aspectHandle(g, paint, v);
      if (d(ap) <= HANDLE) return { kind: 'aspect', node };
    }
    if (d(s2) <= ROTATE_RING) return { kind: 'rotate', node };
    // On the bar itself: add a stop.
    const f = projectOnVector({ x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y }, e.sx, e.sy);
    if (f > 0 && f < 1) {
      const px = s1.x + (s2.x - s1.x) * f;
      const py = s1.y + (s2.y - s1.y) * f;
      if (Math.hypot(e.sx - px, e.sy - py) <= 4) return { kind: 'bar', offset: f, node };
    }
    return null;
  }

  /** The single selected object whose focused paint is a freeform gradient, or null. */
  freeformTarget() {
    const ed = this.editor;
    if (!ed || ed.viewOptions.gradientAnnotator === false) return null;
    const t = paintTargets(ed).filter((n) => isFreeform(n[ed.focusPaint]));
    return t.length === 1 && paintTargets(ed).length === 1 ? t[0] : null;
  }

  /** The frame freeform points are placed in (turns with the object). */
  frame(node) {
    return freeformFrame(this.editor.doc, node) || { x: 0, y: 0, w: 1, h: 1, angle: 0 };
  }

  /** Screen position of a freeform point. */
  pointScreen(node, pt) {
    const p = framePoint(this.frame(node), pt.x, pt.y);
    return this.editor.view.toScreen(p.x, p.y);
  }

  /**
   * The freeform part under the pointer: { kind: 'point', index, node },
   * { kind: 'segment', line, k, t, node } on a line (lines mode), or null.
   */
  freeformPartAt(e) {
    const node = this.freeformTarget();
    if (!node) return null;
    const paint = node[this.editor.focusPaint];
    const pts = paint.points;
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = this.pointScreen(node, pts[i]);
      if (Math.hypot(e.sx - p.x, e.sy - p.y) <= POINT_R + 2) return { kind: 'point', index: i, node };
    }
    if (paint.mode === 'lines') {
      for (let li = 0; li < (paint.lines || []).length; li++) {
        const line = paint.lines[li];
        for (let k = 0; k + 1 < line.length; k++) {
          const a = this.pointScreen(node, pts[line[k]]);
          const b = this.pointScreen(node, pts[line[k + 1]]);
          const t = projectOnVector({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }, e.sx, e.sy);
          if (t <= 0 || t >= 1) continue;
          if (Math.hypot(e.sx - (a.x + (b.x - a.x) * t), e.sy - (a.y + (b.y - a.y) * t)) <= 4) return { kind: 'segment', line: li, k, t, node };
        }
      }
    }
    return null;
  }

  /** Press on a freeform gradient: pick a point, or add one where the object was clicked. */
  freeformDown(e) {
    const ed = this.editor;
    const doc = ed.doc;
    const node = this.freeformTarget();
    if (!node) return false;
    const key = ed.focusPaint;
    let part = this.freeformPartAt(e);
    const b = freeformFrame(doc, node);
    if (part?.kind === 'segment') {
      // Clicking a line puts a point on it, ready to drag.
      const tx = doc.begin('Add Color Point');
      let index = 0;
      this.setFreeform(node, (p) => {
        const r = insertLinePoint(p, part.line, part.k, part.t);
        if (!r) return p;
        index = r.index;
        return r.paint;
      });
      paintState.setStop(index);
      this.drag = { part: { kind: 'point', index, node }, tx, node, b, moved: true };
      this.overlay();
      return true;
    }
    if (!part) {
      const hit = hitTest(doc, e.x, e.y, tol(ed, 3));
      const inside = hit && (hit.id === node.id || doc.isAncestor(node.id, hit.id) || doc.isAncestor(hit.id, node.id));
      if (!inside || !b) return false;
      const { u, v } = frameFraction(b, e.x, e.y);
      const c = sampleFreeform(node[key], u, v, b.w / b.h);
      const tx = doc.begin('Add Color Point');
      let index = 0;
      const selected = node[key].points.length ? Math.min(paintState.stop, node[key].points.length - 1) : null;
      this.setFreeform(node, (p) => {
        // Lines mode continues the line from the selected point unless Shift places a point on its own.
        const r = addPoint(p, u, v, rgbToHex(c), { after: e.shift ? null : selected });
        index = r.index;
        return r.paint;
      });
      paintState.setStop(index);
      this.drag = { part: { kind: 'point', index, node }, tx, node, b, moved: true };
      this.overlay();
      return true;
    }
    paintState.setStop(part.index);
    this.drag = { part, tx: doc.begin('Move Color Point'), node, b, x0: e.x, y0: e.y, moved: false };
    this.overlay();
    return true;
  }

  setFreeform(node, fn) {
    const doc = this.editor.doc;
    const key = this.editor.focusPaint;
    const cur = doc.get(node.id);
    if (!cur || !isFreeform(cur[key])) return;
    const next = { ...fn(cur[key]) };
    delete next.swatchId;
    doc.update(node.id, { [key]: next });
  }

  onHover(e) {
    if (this.freeformTarget()) {
      const part = this.freeformPartAt(e);
      const prev = this.hoverPart;
      this.hoverPart = part;
      this.setCursor(part?.kind === 'point' ? 'move' : 'copy');
      if (prev?.index !== part?.index) this.overlay();
      return;
    }
    const part = this.partAt(e);
    const prev = this.hoverPart?.kind;
    this.hoverPart = part;
    const cursor = !part ? 'var(--cursor-gradient)' : part.kind === 'rotate' ? 'var(--cursor-rotate)' : part.kind === 'bar' ? 'copy' : part.kind === 'origin' ? 'move' : 'pointer';
    this.setCursor(cursor);
    if (prev !== part?.kind) this.overlay();
  }

  /** Update the focused paint on the target nodes (inside the open transaction). */
  setPaint(nodes, fn) {
    const ed = this.editor;
    const key = ed.focusPaint;
    for (const n of nodes) {
      const cur = ed.doc.get(n.id);
      if (!cur || !isGradient(cur[key])) continue;
      const next = fn(cur[key], cur);
      if (next) {
        const out = { ...next };
        delete out.swatchId;
        ed.doc.update(n.id, { [key]: out });
      }
    }
  }

  onPointerDown(e) {
    if (this.freeformDown(e)) return;
    const ed = this.editor;
    const doc = ed.doc;
    const part = this.partAt(e);
    const key = ed.focusPaint;
    if (part) {
      const node = part.node;
      const { paint, g } = this.geom(node);
      if (part.kind === 'bar') {
        doc.transact('Add Gradient Stop', () => {
          this.setPaint([node], (p) => {
            const r = insertStop(p, part.offset);
            paintState.setStop(r.index);
            return r.paint;
          });
        });
        return;
      }
      if (part.kind === 'stop') paintState.setStop(part.index);
      this.drag = { part, tx: doc.begin(gradLabel(part.kind)), node, paint0: paint, g0: { ...g }, x0: e.x, y0: e.y, sx0: e.sx, sy0: e.sy, index: part.index };
      this.overlay();
      return;
    }
    // Not on the annotator: hit an object to target it, then drag a new vector.
    let nodes = this.targets();
    const hit = hitTest(doc, e.x, e.y, tol(ed, 3));
    if (hit) {
      const target = ed.selectionTarget(hit.id);
      const isSelected = [...ed.selection].some((id) => id === target.id || doc.isAncestor(id, hit.id));
      if (!isSelected) {
        ed.select([target.id]);
        nodes = [];
      }
    }
    const all = paintTargets(ed);
    if (!all.length) return;
    if (!nodes.length) {
      // Apply the last gradient to objects that do not have one yet.
      const last = paintState.lastGradient || ed.lastGradient || DEFAULT_LINEAR;
      const without = all.filter((n) => !isGradient(n[key]));
      if (without.length) {
        doc.transact('Apply Gradient', () => {
          for (const n of without) doc.update(n.id, { [key]: structuredClone(stripVector(last)) });
        });
      }
      nodes = this.targets();
    }
    this.drag = { part: { kind: 'vector' }, tx: null, nodes, x0: e.x, y0: e.y, sx0: e.sx, sy0: e.sy, moved: false };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    const ed = this.editor;
    const doc = ed.doc;
    const kind = d.part.kind;
    if (kind === 'point') {
      d.moved = true;
      const f = frameFraction(d.b, e.x, e.y);
      const u = Math.max(0, Math.min(1, f.u));
      const v = Math.max(0, Math.min(1, f.v));
      this.setFreeform(d.node, (p) => setPoint(p, d.part.index, { x: u, y: v }));
      this.overlay();
      return;
    }
    if (kind === 'vector') {
      if (!d.moved && Math.hypot(e.sx - d.sx0, e.sy - d.sy0) < 3) return;
      d.moved = true;
      if (!d.tx) d.tx = doc.begin('Gradient');
      const p = e.shift ? constrain45(d.x0, d.y0, e.x, e.y) : { x: e.x, y: e.y };
      d.cur = p;
      this.setPaint(d.nodes, (paint) => setGradientVector(paint, d.x0, d.y0, p.x, p.y));
      this.overlay();
      return;
    }
    const node = d.node;
    const g = d.g0;
    if (kind === 'origin') {
      const dx = e.x - d.x0;
      const dy = e.y - d.y0;
      this.setPaint([node], (paint) => setGradientVector(paint, g.x1 + dx, g.y1 + dy, g.x2 + dx, g.y2 + dy));
    } else if (kind === 'end') {
      const p = e.shift ? constrain45(g.x1, g.y1, e.x, e.y) : { x: e.x, y: e.y };
      this.setPaint([node], (paint) => setGradientVector(paint, g.x1, g.y1, p.x, p.y));
    } else if (kind === 'rotate') {
      const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
      let a = Math.atan2(e.y - g.y1, e.x - g.x1);
      if (e.shift) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
      this.setPaint([node], (paint) => setGradientVector(paint, g.x1, g.y1, g.x1 + Math.cos(a) * len, g.y1 + Math.sin(a) * len));
    } else if (kind === 'stop') {
      const v = ed.view;
      const s1 = v.toScreen(g.x1, g.y1);
      const s2 = v.toScreen(g.x2, g.y2);
      const f = projectOnVector({ x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y }, e.sx, e.sy);
      const px = s1.x + (s2.x - s1.x) * Math.min(1, Math.max(0, f));
      const py = s1.y + (s2.y - s1.y) * Math.min(1, Math.max(0, f));
      const away = Math.hypot(e.sx - px, e.sy - py) > REMOVE_PX + STOP_OFFSET && d.paint0.stops.length > 2;
      d.removing = away;
      if (away) {
        this.setPaint([node], () => removeStop(d.paint0, d.part.index));
      } else {
        this.setPaint([node], () => {
          const r = moveStop(d.paint0, d.part.index, f);
          d.index = r.index;
          return r.paint;
        });
      }
    } else if (kind === 'mid') {
      const v = ed.view;
      const s1 = v.toScreen(g.x1, g.y1);
      const s2 = v.toScreen(g.x2, g.y2);
      const f = projectOnVector({ x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y }, e.sx, e.sy);
      const a = d.paint0.stops[d.part.index];
      const b = d.paint0.stops[d.part.index + 1];
      if (b.offset - a.offset > 1e-6) this.setPaint([node], () => setMidpoint(d.paint0, d.part.index, (f - a.offset) / (b.offset - a.offset)));
    } else if (kind === 'aspect') {
      const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 1;
      const nx = -(g.y2 - g.y1) / len;
      const ny = (g.x2 - g.x1) / len;
      const dist = Math.abs((e.x - g.x1) * nx + (e.y - g.y1) * ny);
      const aspect = Math.max(0.005, Math.min(327.67, dist / len));
      this.setPaint([node], (paint) => ({ ...setGradientVector(paint, g.x1, g.y1, g.x2, g.y2), aspect }));
    }
    this.overlay();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.part.kind === 'stop') {
      if (d.removing) paintState.setStop(Math.max(0, d.part.index - 1));
      else paintState.setStop(d.index ?? d.part.index);
    }
    if (d.tx) {
      // A click on a point only selects it.
      if (d.part.kind === 'point' && !d.moved) d.tx.cancel();
      else d.tx.commit();
    }
    const ed = this.editor;
    const ff = this.freeformTarget();
    if (ff) {
      paintState.lastGradient = ff[ed.focusPaint];
      this.overlay();
      return;
    }
    const first = this.targets()[0];
    if (first) {
      const p = first[ed.focusPaint];
      paintState.lastGradient = p;
      ed.lastGradient = stripVector(p);
    }
    this.overlay();
  }

  onDoubleClick() {
    this.app.openPanel('gradient');
  }

  onKeyDown(e) {
    if (e.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    // Delete removes the selected freeform point (the object stays).
    const node = (e.key === 'Delete' || e.key === 'Backspace') && !this.drag ? this.freeformTarget() : null;
    if (node && node[this.editor.focusPaint].points.length > 1) {
      const i = Math.min(paintState.stop, node[this.editor.focusPaint].points.length - 1);
      this.editor.doc.transact('Delete Color Point', () => this.setFreeform(node, (p) => removePoint(p, i)));
      paintState.setStop(Math.max(0, i - 1));
      this.overlay();
      return true;
    }
    return false;
  }

  cancel() {
    const d = this.drag;
    this.drag = null;
    if (d?.tx) d.tx.cancel();
    this.overlay();
  }

  commit() {
    if (this.drag) this.onPointerUp();
  }

  /** Freeform annotator: each color point as a swatch dot; the selected one ringed, with its spread. */
  drawFreeform(ctx, node) {
    const ed = this.editor;
    const paint = node[ed.focusPaint];
    const b = freeformFrame(ed.doc, node);
    const sel = Math.min(paintState.stop, paint.points.length - 1);
    ctx.save();
    // Lines mode: the lines the colors spread along.
    if (paint.mode === 'lines') {
      for (const line of paint.lines || []) {
        ctx.beginPath();
        line.forEach((j, k) => {
          const p = this.pointScreen(node, paint.points[j] || { x: 0, y: 0 });
          if (k) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
        });
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.stroke();
      }
    }
    paint.points.forEach((pt, i) => {
      const p = this.pointScreen(node, pt);
      const selected = i === sel;
      if (selected && pt.spread > 0 && b) {
        // The spread is a fraction of the frame's diagonal.
        const a = this.pointScreen(node, { x: 0, y: 0 });
        const c = this.pointScreen(node, { x: 1, y: 1 });
        const r = pt.spread * Math.hypot(c.x - a.x, c.y - a.y);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, POINT_R, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.fill();
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeStyle = selected ? '#3d7bfd' : this.hoverPart?.index === i ? '#000' : '#fff';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, POINT_R + 1.5, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.stroke();
    });
    ctx.restore();
  }

  drawOverlay(ctx, editor) {
    const v = editor.view;
    const d = this.drag;
    if (d && d.part.kind === 'vector' && d.moved && d.cur) {
      const a = v.toScreen(d.x0, d.y0);
      const b = v.toScreen(d.cur.x, d.cur.y);
      ctx.save();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
    const ff = this.freeformTarget();
    if (ff) {
      this.drawFreeform(ctx, ff);
      return;
    }
    const targets = this.targets();
    if (targets.length !== 1 || editor.viewOptions.gradientAnnotator === false) return;
    const node = targets[0];
    const { paint, g } = this.geom(node);
    const s1 = v.toScreen(g.x1, g.y1);
    const s2 = v.toScreen(g.x2, g.y2);
    ctx.save();
    if (paint.type === 'radial') {
      // Dashed ellipse showing the radius and aspect ratio.
      const r = Math.hypot(s2.x - s1.x, s2.y - s1.y);
      const ang = Math.atan2(s2.y - s1.y, s2.x - s1.x);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(s1.x, s1.y, Math.max(r, 0.5), Math.max(r * (paint.aspect ?? 1), 0.5), ang, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const ap = aspectHandle(g, paint, v);
      ctx.fillStyle = '#000';
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Bar: white core with a dark outline so it reads on any artwork.
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Midpoints.
    for (let i = 0; i < paint.stops.length - 1; i++) {
      const a = paint.stops[i];
      const b = paint.stops[i + 1];
      if (b.offset - a.offset < 0.03) continue;
      const p = midpointScreen(s1, s2, a.offset + (b.offset - a.offset) * (a.midpoint ?? 0.5));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = this.hoverPart?.kind === 'mid' && this.hoverPart.index === i ? '#3d7bfd' : '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.strokeRect(-2.5, -2.5, 5, 5);
      ctx.restore();
    }
    // Origin (round) and end point (square).
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s1.x, s1.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.fillRect(s2.x - 4, s2.y - 4, 8, 8);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(s2.x - 4.5, s2.y - 4.5, 9, 9);
    if (this.hoverPart?.kind === 'rotate') {
      ctx.strokeStyle = 'rgba(61,123,253,0.9)';
      ctx.beginPath();
      ctx.arc(s2.x, s2.y, ROTATE_RING - 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Stops.
    paint.stops.forEach((s, i) => {
      const p = stopScreen(s1, s2, s.offset);
      const selected = i === paintState.stop;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.bx, p.by);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, selected ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = selected ? '#3d7bfd' : '#000';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, (selected ? 6 : 5) + 1.5, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });
    ctx.restore();
  }
}

const STOP_OFFSET = 13;

/** Screen position of a stop marker: on the bar's track, offset to the side below it. */
function stopScreen(s1, s2, o) {
  const dx = s2.x - s1.x;
  const dy = s2.y - s1.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (ny < 0 || (Math.abs(ny) < 1e-6 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  return { x: s1.x + dx * o + nx * STOP_OFFSET, y: s1.y + dy * o + ny * STOP_OFFSET, bx: s1.x + dx * o, by: s1.y + dy * o };
}

function midpointScreen(s1, s2, o) {
  return { x: s1.x + (s2.x - s1.x) * o, y: s1.y + (s2.y - s1.y) * o };
}

function aspectHandle(g, paint, v) {
  const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 1;
  const nx = -(g.y2 - g.y1) / len;
  const ny = (g.x2 - g.x1) / len;
  const r = len * (paint.aspect ?? 1);
  return v.toScreen(g.x1 + nx * r, g.y1 + ny * r);
}

function stripVector(p) {
  const out = { ...p };
  delete out.x1;
  delete out.y1;
  delete out.x2;
  delete out.y2;
  delete out.swatchId;
  return out;
}

function gradLabel(kind) {
  return { origin: 'Move Gradient', end: 'Gradient', rotate: 'Rotate Gradient', stop: 'Move Gradient Stop', mid: 'Gradient Midpoint', aspect: 'Gradient Aspect Ratio' }[kind] || 'Gradient';
}
