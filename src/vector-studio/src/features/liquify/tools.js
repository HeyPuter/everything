/**
 * The liquify tools: Warp, Twirl, Pucker, Bloat, Scallop, Crystallize and
 * Wrinkle. Each drags an elliptical brush over paths and distorts them
 * where it passes (the selection, or every unlocked path under the brush
 * when nothing is selected). Twirl, Pucker, Bloat, Scallop, Crystallize
 * and Wrinkle keep working while the pointer is held still. One stroke is
 * one undo step.
 *
 * The brush size, angle and intensity are shared by all seven tools;
 * Option-drag before pressing resizes the brush (Shift keeps it round).
 * Double-click a tool for its options.
 */
import { Tool } from '../../tools/tool.js';
import { deformAnchors, densify, detailLength, pathTouchesBrush, simplifyAnchors } from './liquify-math.js';

export const DEFAULT_BRUSH = Object.freeze({ w: 100, h: 100, angle: 0, intensity: 50, pressure: false, show: true });

const DEFAULTS = {
  warp: { detailOn: true, detail: 2, simplifyOn: true, simplify: 50 },
  twirl: { rate: 40, detailOn: true, detail: 2, simplifyOn: true, simplify: 50 },
  pucker: { detailOn: true, detail: 2, simplifyOn: true, simplify: 50 },
  bloat: { detailOn: true, detail: 2, simplifyOn: true, simplify: 50 },
  scallop: { complexity: 1, detailOn: true, detail: 2, anchors: true, inHandles: false, outHandles: false },
  crystallize: { complexity: 1, detailOn: true, detail: 2, anchors: true, inHandles: false, outHandles: false },
  wrinkle: { horizontal: 0, vertical: 100, complexity: 1, detailOn: true, detail: 2, anchors: true, inHandles: true, outHandles: false },
};

/** Paths a stroke may distort: the selection's paths, or all editable ones. */
function targetPaths(editor) {
  const doc = editor.doc;
  const out = [];
  const add = (n) => {
    if (!n || n.hidden) return;
    if (n.type === 'path') out.push(n);
    else if (n.children && n.type !== 'layer') for (const c of n.children) add(doc.get(c));
  };
  if (editor.selection.size) {
    for (const id of editor.topSelection()) if (!doc.isLocked(id) && !doc.isHidden(id)) add(doc.get(id));
  } else {
    for (const n of doc.leaves()) {
      if (doc.isLocked(n.id) || doc.isHidden(n.id)) continue;
      if (n.type === 'path') out.push(n);
      else if (n.type === 'compound') add(n);
    }
  }
  return out;
}

function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

class LiquifyTool extends Tool {
  static op = 'warp';
  static hint = 'Drag over paths to distort them | Option+drag before pressing resizes the brush | Double-click the tool for options';
  /** Whether the tool keeps distorting while the pointer is still. */
  static continuous = true;

  activate() {
    this.setCursor('none');
    this.status();
  }

  deactivate() {
    this.stopTimer();
    this.cursorPt = null;
    this.overlay();
  }

  get brush() {
    return { ...DEFAULT_BRUSH, ...(this.app.prefs.get('liquifyBrush') || {}) };
  }

  set brush(b) {
    this.app.prefs.set('liquifyBrush', { ...this.brush, ...b });
  }

  get options() {
    const op = this.constructor.op;
    return { ...DEFAULTS[op], ...(this.app.prefs.get(`liquify.${op}`) || {}) };
  }

  set options(o) {
    this.app.prefs.set(`liquify.${this.constructor.op}`, { ...this.options, ...o });
  }

  brushAt(x, y) {
    const b = this.brush;
    return { cx: x, cy: y, w: b.w, h: b.h, angle: b.angle };
  }

  onHover(e) {
    this.cursorPt = { x: e.x, y: e.y };
    this.overlay();
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    this.cursorPt = { x: e.x, y: e.y };
    if (e.alt) {
      // Resize the brush instead of distorting.
      this.resize = { x: e.x, y: e.y, b: this.brush };
      return;
    }
    this.stroke = { last: { x: e.x, y: e.y }, touched: new Set(), seed: (Math.random() * 2 ** 31) | 0, step: 0, pressure: e.pressure || 0.5 };
    this.tx = this.doc.begin(this.constructor.label.replace(' Tool', ''));
    this.applyAt(e.x, e.y, 0, 0, 1);
    if (this.constructor.continuous) {
      this.timer = setInterval(() => {
        if (this.stroke && this.cursorPt) this.applyAt(this.cursorPt.x, this.cursorPt.y, 0, 0, 1);
      }, 40);
    }
  }

  onPointerMove(e) {
    this.cursorPt = { x: e.x, y: e.y };
    if (this.resize) {
      const r = this.resize;
      let w = Math.max(1, Math.abs(e.x - r.x) * 2);
      let hgt = Math.max(1, Math.abs(e.y - r.y) * 2);
      if (e.shift) w = hgt = Math.max(w, hgt);
      this.brush = { w, h: hgt };
      this.overlay();
      return;
    }
    if (!this.stroke) return;
    this.stroke.pressure = e.pressure || this.stroke.pressure;
    const dx = e.x - this.stroke.last.x;
    const dy = e.y - this.stroke.last.y;
    // Long moves are split so a fast drag still distorts smoothly.
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, Math.min(this.brush.w, this.brush.h) / 8)));
    // The brush grabs what is under it before each step and carries it along.
    for (let i = 0; i < steps; i++) {
      const x = this.stroke.last.x + (dx * i) / steps;
      const y = this.stroke.last.y + (dy * i) / steps;
      this.applyAt(x, y, dx / steps, dy / steps, this.constructor.continuous ? 0.5 / steps : 1);
    }
    this.stroke.last = { x: e.x, y: e.y };
    this.overlay();
  }

  onPointerUp() {
    if (this.resize) {
      this.resize = null;
      return;
    }
    this.stopTimer();
    if (!this.stroke) return;
    const o = this.options;
    if (o.simplifyOn && this.stroke.touched.size) {
      // Simplify removes the extra anchors the stroke added, within a tolerance
      // that shrinks as Simplify goes up (0.2 = keep nearly everything).
      const tolPx = Math.max(0.05, ((o.simplify ?? 50) / 100) * Math.min(this.brush.w, this.brush.h) * 0.02);
      for (const id of this.stroke.touched) {
        const n = this.doc.get(id);
        if (!n) continue;
        const anchors = simplifyAnchors(n.anchors, n.closed, tolPx, this.stroke.region);
        if (anchors !== n.anchors) this.doc.update(id, { anchors });
      }
    }
    if (this.stroke.touched.size) this.tx.commit();
    else this.tx.cancel();
    this.tx = null;
    this.stroke = null;
    this.overlay();
  }

  cancel() {
    this.stopTimer();
    this.resize = null;
    this.tx?.cancel();
    this.tx = null;
    this.stroke = null;
    this.overlay();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  /** One distortion step at (x, y) with a drag of (dx, dy). */
  applyAt(x, y, dx, dy, k) {
    const editor = this.editor;
    if (!editor || !this.stroke) return;
    const doc = editor.doc;
    const b = this.brush;
    const o = this.options;
    const brush = this.brushAt(x, y);
    // The area the stroke covered, where Simplify may remove anchors (warp carries them along the drag).
    const r = Math.max(b.w, b.h) / 2 + Math.hypot(dx, dy);
    const box = { x: x - r, y: y - r, w: 2 * r, h: 2 * r };
    const reg = this.stroke.region;
    this.stroke.region = reg ? unionBox(reg, box) : box;
    const intensity = (b.intensity / 100) * (b.pressure ? Math.max(0.1, this.stroke.pressure * 2) : 1);
    const op = this.constructor.op;
    const params = { ...o, dx, dy, horizontal: (o.horizontal ?? 0) / 100, vertical: (o.vertical ?? 100) / 100 };
    const maxLen = o.detailOn ? detailLength(brush, o.detail) : Infinity;
    for (const n of targetPaths(editor)) {
      if (!pathTouchesBrush(n.anchors, n.closed, brush)) continue;
      const dense = Number.isFinite(maxLen) ? densify(n.anchors, n.closed, brush, maxLen) : n.anchors;
      const seed = this.stroke.seed + ++this.stroke.step * 7919;
      const strength = op === 'warp' ? 1 : intensity * k * 4;
      const anchors = deformAnchors(dense, n.closed, op, brush, strength, { ...params, intensity: Math.min(1, intensity) }, seed);
      // Densified but not moved (the brush only grazed it): leave the path alone.
      if (anchors === dense) continue;
      doc.update(n.id, { anchors, shape: undefined });
      this.stroke.touched.add(n.id);
    }
  }

  onKeyDown(ev) {
    if (ev.key === '[' || ev.key === ']') {
      const b = this.brush;
      const f = ev.key === ']' ? 1.1 : 1 / 1.1;
      this.brush = { w: Math.max(1, b.w * f), h: Math.max(1, b.h * f) };
      this.overlay();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, editor) {
    const c = this.cursorPt;
    if (!c || !this.brush.show) return;
    const b = this.brush;
    const z = editor.view.zoom;
    const s = editor.view.toScreen(c.x, c.y);
    const rot = ((editor.view.rotation || 0) - (b.angle || 0)) * (Math.PI / 180);
    ctx.save();
    ctx.lineWidth = 1;
    for (const [color, pad] of [['#ffffff', 1], ['#000000', 0]]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, Math.max(2, (b.w * z) / 2) + pad, Math.max(2, (b.h * z) / 2) + pad, rot, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#000000';
    ctx.fillRect(s.x - 0.5, s.y - 3, 1, 6);
    ctx.fillRect(s.x - 3, s.y - 0.5, 6, 1);
    ctx.restore();
  }

  /** Tool-specific option fields after the shared brush settings. */
  extraFields() {
    return [];
  }

  async openOptions() {
    const label = this.constructor.label;
    const b = this.brush;
    const o = this.options;
    const op = this.constructor.op;
    const affects = op === 'scallop' || op === 'crystallize' || op === 'wrinkle';
    const v = await this.app.dialogs.form({
      title: `${label} Options`,
      fields: [
        { type: 'heading', label: 'Brush (all liquify tools)' },
        { key: 'w', label: 'Width', type: 'length', value: b.w, min: 0.1, max: 5000 },
        { key: 'h', label: 'Height', type: 'length', value: b.h, min: 0.1, max: 5000 },
        { key: 'angle', label: 'Angle', type: 'angle', value: b.angle, min: -360, max: 360 },
        { key: 'intensity', label: 'Intensity', type: 'percent', value: b.intensity, min: 1, max: 100 },
        { key: 'pressure', label: 'Use pen pressure', type: 'checkbox', value: b.pressure },
        { type: 'heading', label: `${label.replace(' Tool', '')} options` },
        ...this.extraFields(o),
        ...(affects
          ? [
              { key: 'anchors', label: 'Brush moves anchor points', type: 'checkbox', value: o.anchors },
              { key: 'inHandles', label: 'Brush moves incoming handles', type: 'checkbox', value: o.inHandles },
              { key: 'outHandles', label: 'Brush moves outgoing handles', type: 'checkbox', value: o.outHandles },
            ]
          : []),
        { key: 'detailOn', label: 'Add detail where the brush passes', type: 'checkbox', value: o.detailOn },
        { key: 'detail', label: 'Detail', type: 'range', value: o.detail, min: 1, max: 10, step: 1 },
        ...(affects ? [] : [
          { key: 'simplifyOn', label: 'Simplify after each stroke', type: 'checkbox', value: o.simplifyOn },
          { key: 'simplify', label: 'Simplify', type: 'range', value: o.simplify, min: 0, max: 100, step: 1 },
        ]),
        { key: 'show', label: 'Show brush size', type: 'checkbox', value: b.show },
      ],
      extraButtons: [{ label: 'Reset', action: 'reset' }],
    });
    if (v?.__action === 'reset') {
      this.app.prefs.set('liquifyBrush', { ...DEFAULT_BRUSH });
      this.app.prefs.set(`liquify.${op}`, { ...DEFAULTS[op] });
      return;
    }
    if (!v || typeof v !== 'object') return;
    this.brush = { w: v.w, h: v.h, angle: v.angle, intensity: v.intensity, pressure: v.pressure, show: v.show };
    const { w, h, angle, intensity, pressure, show, __action, ...rest } = v;
    this.options = rest;
  }
}

export class WarpTool extends LiquifyTool {
  static id = 'warp';
  static label = 'Warp Tool';
  static shortcut = 'Shift+R';
  static icon = 'tool-warp';
  static op = 'warp';
  static continuous = false;
  static hint = 'Drag to push paths along with the brush | Option+drag before pressing resizes the brush | Double-click the tool for options';
}

export class TwirlTool extends LiquifyTool {
  static id = 'twirl';
  static label = 'Twirl Tool';
  static icon = 'tool-twirl';
  static op = 'twirl';
  static hint = 'Hold or drag to swirl paths under the brush | Option+drag before pressing resizes the brush | Double-click the tool for options';

  extraFields(o) {
    return [{ key: 'rate', label: 'Twirl rate', type: 'angle', value: o.rate, min: -180, max: 180 }];
  }
}

export class PuckerTool extends LiquifyTool {
  static id = 'pucker';
  static label = 'Pucker Tool';
  static icon = 'tool-pucker';
  static op = 'pucker';
  static hint = 'Hold or drag to pull paths toward the brush center | Option+drag before pressing resizes the brush';
}

export class BloatTool extends LiquifyTool {
  static id = 'bloat';
  static label = 'Bloat Tool';
  static icon = 'tool-bloat';
  static op = 'bloat';
  static hint = 'Hold or drag to push paths away from the brush center | Option+drag before pressing resizes the brush';
}

export class ScallopTool extends LiquifyTool {
  static id = 'scallop';
  static label = 'Scallop Tool';
  static icon = 'tool-scallop';
  static op = 'scallop';
  static hint = 'Hold or drag to add curved scallops toward the brush center | Option+drag before pressing resizes the brush';

  extraFields(o) {
    return [{ key: 'complexity', label: 'Complexity', type: 'range', value: o.complexity, min: 0, max: 15, step: 1 }];
  }
}

export class CrystallizeTool extends LiquifyTool {
  static id = 'crystallize';
  static label = 'Crystallize Tool';
  static icon = 'tool-crystallize';
  static op = 'crystallize';
  static hint = 'Hold or drag to add spikes pointing away from the brush center | Option+drag before pressing resizes the brush';

  extraFields(o) {
    return [{ key: 'complexity', label: 'Complexity', type: 'range', value: o.complexity, min: 0, max: 15, step: 1 }];
  }
}

export class WrinkleTool extends LiquifyTool {
  static id = 'wrinkle';
  static label = 'Wrinkle Tool';
  static icon = 'tool-wrinkle';
  static op = 'wrinkle';
  static hint = 'Hold or drag to add wrinkles to paths under the brush | Option+drag before pressing resizes the brush';

  extraFields(o) {
    return [
      { key: 'horizontal', label: 'Horizontal', type: 'percent', value: o.horizontal, min: 0, max: 100 },
      { key: 'vertical', label: 'Vertical', type: 'percent', value: o.vertical, min: 0, max: 100 },
      { key: 'complexity', label: 'Complexity', type: 'range', value: o.complexity, min: 0, max: 15, step: 1 },
    ];
  }
}

export const LIQUIFY_TOOLS = [WarpTool, TwirlTool, PuckerTool, BloatTool, ScallopTool, CrystallizeTool, WrinkleTool];
