/**
 * Rotate (R), Reflect (O), Scale (S) and Shear tools.
 *
 * Click to set the reference point (default: the selection's center), or
 * drag its marker to move it, then drag to transform around it. Shift constrains, Alt while dragging leaves
 * the original and transforms a copy. Alt-click sets the reference point and
 * opens the tool's dialog; Enter or double-clicking the tool opens the dialog
 * around the center.
 */
import { Tool } from './tool.js';
import { TransformSession } from './transform-session.js';
import { rotate, scale, shear, multiply, translate } from '../lib/matrix.js';

class OriginTool extends Tool {
  static dialogCommand = '';

  constructor(app) {
    super(app);
    this.origin = null;
    this.drag = null;
  }

  activate() {
    this.origin = null;
    this.setCursor('crosshair');
    this.status();
  }

  deactivate() {
    this.cancel();
    this.origin = null;
  }

  center() {
    const b = this.editor.selectionBounds(false);
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  }

  /** The reference point belongs to the selection it was set for; a new selection starts at its center. */
  selectionKey() {
    return [...this.editor.selection].sort().join(' ');
  }

  setOrigin(x, y) {
    this.origin = { x, y, key: this.selectionKey() };
  }

  /** Open the tool's dialog around a point; the point stays set for the result (a Copy selects the copies). */
  async runDialog(origin) {
    const o = { x: origin.x, y: origin.y };
    await this.app.commands.run(this.constructor.dialogCommand, { origin: o });
    if (this.app.tool === this && this.origin && this.origin.x === o.x && this.origin.y === o.y) this.setOrigin(o.x, o.y);
  }

  currentOrigin() {
    return this.origin && this.origin.key === this.selectionKey() ? this.origin : this.center();
  }

  onHover(e) {
    const o = this.editor.selection.size ? this.currentOrigin() : null;
    const so = o && this.editor.view.toScreen(o.x, o.y);
    this.setCursor(so && Math.hypot(so.x - e.sx, so.y - e.sy) <= 7 ? 'move' : 'crosshair');
  }

  onPointerDown(e) {
    const editor = this.editor;
    if (!editor.selection.size) {
      this.app.notify('Select an object first.');
      return;
    }
    if (e.alt && !this.drag) {
      this.setOrigin(e.x, e.y);
      this.overlay();
      this.runDialog(this.origin);
      return;
    }
    const o = this.currentOrigin();
    // Pressing on the reference point marker drags the point itself.
    const so = o && editor.view.toScreen(o.x, o.y);
    if (so && Math.hypot(so.x - e.sx, so.y - e.sy) <= 7) {
      this.drag = { kind: 'origin', o };
      return;
    }
    this.drag = { o, x0: e.x, y0: e.y, moved: false, clickOnly: true, session: null };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'origin') {
      this.setOrigin(e.x, e.y);
      d.o = this.origin;
      this.overlay();
      return;
    }
    if (!d.moved && Math.hypot(e.x - d.x0, e.y - d.y0) * this.editor.view.zoom < 3) return;
    if (!d.moved) {
      d.moved = true;
      // A drag that starts far from the origin transforms; a click sets the origin.
      d.session = new TransformSession(this.editor, this.constructor.label.replace(' Tool', ''), { duplicate: e.alt });
    } else d.session.setDuplicate(e.alt);
    const m = this.matrixFor(d, e);
    if (m) d.session.apply(m);
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    this.editor.feedback = null;
    if (!d) return;
    if (d.kind === 'origin') {
      this.overlay();
      return;
    }
    if (!d.moved) {
      this.setOrigin(e.x, e.y);
      this.overlay();
      return;
    }
    d.session.commit();
    // The point stays put for the transformed objects (or their copies) to repeat around it.
    if (this.origin) this.setOrigin(d.o.x, d.o.y);
    this.overlay();
  }

  onKeyDown(ev) {
    if (ev.key === 'Enter' && this.editor.selection.size) {
      this.runDialog(this.currentOrigin());
      return true;
    }
    if (ev.key === 'Escape' && this.drag) {
      this.cancel();
      return true;
    }
    return false;
  }

  cancel() {
    if (this.drag?.session) this.drag.session.cancel();
    this.drag = null;
    if (this.editor) this.editor.feedback = null;
  }

  openOptions() {
    if (this.editor?.selection.size) this.runDialog(this.currentOrigin());
  }

  drawOverlay(ctx, editor) {
    if (!editor.selection.size) return;
    const o = this.drag?.o || this.currentOrigin();
    if (!o) return;
    const s = editor.view.toScreen(o.x, o.y);
    // Reference point marker: a small crosshair in a circle.
    ctx.save();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.moveTo(s.x - 9, s.y);
    ctx.lineTo(s.x + 9, s.y);
    ctx.moveTo(s.x, s.y - 9);
    ctx.lineTo(s.x, s.y + 9);
    ctx.stroke();
    ctx.restore();
  }
}

export class RotateTool extends OriginTool {
  static id = 'rotate';
  static label = 'Rotate Tool';
  static shortcut = 'R';
  static icon = 'tool-rotate';
  static hint = 'Click to set the reference point | Drag to rotate | Shift for 45 degrees | Option+Click for exact values';
  static dialogCommand = 'object.transform.rotate';

  matrixFor(d, e) {
    const a0 = Math.atan2(d.y0 - d.o.y, d.x0 - d.o.x);
    const a1 = Math.atan2(e.y - d.o.y, e.x - d.o.x);
    let deg = ((a1 - a0) * 180) / Math.PI;
    if (e.shift) deg = Math.round(deg / 45) * 45;
    this.editor.feedback = { sx: e.sx, sy: e.sy, text: `${Number((-deg).toFixed(1))}°` };
    return rotate(deg, d.o.x, d.o.y);
  }
}

export class ReflectTool extends OriginTool {
  static id = 'reflect';
  static label = 'Reflect Tool';
  static shortcut = 'O';
  static icon = 'tool-reflect';
  static hint = 'Click to set the axis point | Drag to reflect across an axis | Shift for 45 degrees | Option+Click for exact values';
  static dialogCommand = 'object.transform.reflect';

  matrixFor(d, e) {
    let a = Math.atan2(e.y - d.o.y, e.x - d.o.x);
    if (e.shift) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    return reflectAcross(d.o.x, d.o.y, (a * 180) / Math.PI);
  }
}

/** Reflection across a line through (ox, oy) at `deg` degrees. */
export function reflectAcross(ox, oy, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(2 * a);
  const s = Math.sin(2 * a);
  return multiply(translate(ox, oy), multiply([c, s, s, -c, 0, 0], translate(-ox, -oy)));
}

export class ScaleTool extends OriginTool {
  static id = 'scale';
  static label = 'Scale Tool';
  static shortcut = 'S';
  static icon = 'tool-scale';
  static hint = 'Click to set the reference point | Drag to scale | Shift scales proportionally | Option+Click for exact values';
  static dialogCommand = 'object.transform.scale';

  matrixFor(d, e) {
    const dx0 = d.x0 - d.o.x;
    const dy0 = d.y0 - d.o.y;
    let sx = Math.abs(dx0) > 1e-6 ? (e.x - d.o.x) / dx0 : 1;
    let sy = Math.abs(dy0) > 1e-6 ? (e.y - d.o.y) / dy0 : 1;
    if (e.shift) {
      const s = Math.hypot(e.x - d.o.x, e.y - d.o.y) / Math.max(1e-6, Math.hypot(dx0, dy0));
      sx = sy = s;
    }
    if (Math.abs(sx) < 1e-3) sx = 1e-3;
    if (Math.abs(sy) < 1e-3) sy = 1e-3;
    this.editor.feedback = { sx: e.sx, sy: e.sy, text: `W: ${Number((sx * 100).toFixed(1))}%\nH: ${Number((sy * 100).toFixed(1))}%` };
    return scale(sx, sy, d.o.x, d.o.y);
  }
}

export class ShearTool extends OriginTool {
  static id = 'shear';
  static label = 'Shear Tool';
  static shortcut = '';
  static icon = 'tool-shear';
  static hint = 'Click to set the reference point | Drag to shear | Shift constrains to the horizontal or vertical axis';
  static dialogCommand = 'object.transform.shear';

  matrixFor(d, e) {
    const dx = e.x - d.x0;
    const dy = e.y - d.y0;
    const h = d.y0 - d.o.y || 1;
    const w = d.x0 - d.o.x || 1;
    if (Math.abs(dx) >= Math.abs(dy) || e.shift) {
      const deg = (Math.atan2(dx, h) * 180) / Math.PI;
      return shear(deg, 0, d.o.x, d.o.y);
    }
    const deg = (Math.atan2(dy, w) * 180) / Math.PI;
    return shear(0, deg, d.o.x, d.o.y);
  }
}
