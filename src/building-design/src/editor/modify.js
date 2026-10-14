/**
 * Modify tools working on the selection: move, copy, rotate, mirror, array,
 * align, offset, trim/extend, split, measure, match type.
 */
import { Tool, isNumericStart } from './tool.js';
import { add, sub, scale, dot, norm, perp, dist, len, angleOf, closestOnSegment, cross } from '../core/geom.js';
import {
  transformElements,
  copyElements,
  translation,
  rotation,
  mirrorAcross,
  splitWall,
  cornerWalls,
  extendToLine,
  offsetElement,
  arrayLinear,
  moveElements,
} from '../core/ops.js';
import { formatAngle, parseAngle } from '../core/units.js';
import { strokeModel, drawTempDim, drawTag } from '../views/overlay.js';
import { previewGraphics } from './draw.js';
import { h } from '../ui/dom.js';

function selectionIds(app) {
  return [...app.selection].filter((id) => {
    const el = app.doc.get(id);
    return el && el.id !== 'project' && el.kind !== 'level';
  });
}

function checkbox(label, value, onChange) {
  const c = h('input', { type: 'checkbox', checked: value });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label.ob-group', c, h('span.ob-label', label));
}

/** Tools that need a selection first. */
class SelectionTool extends Tool {
  start() {
    this.ids = selectionIds(this.app);
    if (!this.ids.length) {
      this.app.toast('Select elements first, then choose this tool.', { kind: 'error' });
      this.app.cancelTool();
      return false;
    }
    this.exclude = new Set(this.ids);
    return true;
  }

  /** Preview the transformed selection on the overlay. */
  preview(ctx, vc, vp, xf) {
    for (const id of this.ids.slice(0, 200)) {
      const el = this.doc.get(id);
      if (!el || el.hostId) continue;
      const moved = { ...el };
      const patch = this.patchFor(el, xf);
      Object.assign(moved, patch);
      previewGraphics(this.app, vc, moved, ctx, vp.theme.preview, 0.08);
    }
  }

  patchFor(el, xf) {
    const holder = { patch: {} };
    // Reuse the transform without touching the document.
    const fakeDoc = { update: (_id, p) => (holder.patch = p), get: (id) => this.doc.get(id), all: (...k) => this.doc.all(...k) };
    transformElements(fakeDoc, [el.id], xf);
    return holder.patch;
  }
}

export class MoveTool extends SelectionTool {
  constructor(app, opts) {
    super(app, opts);
    this.copy = !!opts.copy;
    this.multiple = !!opts.copy;
  }

  get title() {
    return this.copy ? 'Copy' : 'Move';
  }

  get prompt() {
    return this.base ? 'Click the destination, or type a distance' : 'Click the start point (base point) of the move';
  }

  options() {
    return [
      checkbox('Copy', this.copy, (v) => {
        this.copy = v;
        this.app.renderOptions();
      }),
      this.copy ? checkbox('Multiple', this.multiple, (v) => (this.multiple = v)) : null,
    ];
  }

  down(ev) {
    const p = this.snap(ev, this.base, { exclude: this.exclude });
    if (!p) return;
    if (!this.base) {
      this.base = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    this.apply(sub(p, this.base));
  }

  apply(d) {
    if (this.copy) {
      let ids;
      this.app.commit('Copy', () => (ids = copyElements(this.doc, this.ids, translation(d))));
      if (!this.multiple) {
        this.app.select(ids);
        this.app.cancelTool();
      }
    } else {
      this.app.commit('Move', () => moveElements(this.doc, this.ids, d));
      this.app.cancelTool();
    }
  }

  move(ev) {
    this.cursor = this.snap(ev, this.base, { exclude: this.exclude });
    this.app.requestRender();
  }

  key(e) {
    if (this.base && isNumericStart(e)) {
      e.preventDefault();
      const s = this.vc.modelToScreen(this.cursor || this.base);
      const input = this.openInput(s.x, s.y, {
        label: 'Distance',
        onSubmit: (v) => {
          const L = this.parseLen(v);
          if (!Number.isFinite(L)) return false;
          const d = norm(sub(this.cursor || add(this.base, [1, 0]), this.base));
          this.apply(scale(len(d) ? d : [1, 0], L));
          return true;
        },
      });
      input.value = e.key;
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.base && this.cursor) {
      const d = sub(this.cursor, this.base);
      this.preview(ctx, vc, vp, translation(d));
      const S = (p) => vc.modelToScreen(p);
      strokeModel(ctx, [this.base, this.cursor], S, vp.theme.preview, 1.2, [5, 4]);
      drawTempDim(ctx, S(this.base), S(this.cursor), this.fmt(len(d)), vp.theme.preview, vp.theme, -18);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class RotateTool extends SelectionTool {
  start() {
    if (!super.start()) return false;
    const b = this.vc.extents?.(new Set(this.ids));
    this.center = b ? [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] : [0, 0];
    this.copy = false;
    return true;
  }

  get title() {
    return 'Rotate';
  }

  get prompt() {
    if (this.placing) return 'Click the center of rotation';
    return this.ray ? 'Click to end the rotation, or type an angle' : 'Click the start ray, or type an angle. Click "Place center" to move the center.';
  }

  options() {
    const ang = h('input.input.sm.num', { type: 'text', placeholder: '90°', 'aria-label': 'Angle in degrees' });
    ang.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const a = parseAngle(ang.value);
        if (Number.isFinite(a)) this.apply(a);
      }
    });
    return [
      checkbox('Copy', this.copy, (v) => (this.copy = v)),
      h('button.btn.sm', { type: 'button', onClick: () => ((this.placing = true), this.app.setPrompt(this.prompt)) }, 'Place center'),
      h('div.ob-group', h('label', 'Angle'), ang),
    ];
  }

  down(ev) {
    const p = this.snap(ev, this.center, { exclude: this.exclude });
    if (!p) return;
    if (this.placing) {
      this.center = p;
      this.placing = false;
    } else if (!this.ray) this.ray = p;
    else {
      const a = angleOf(sub(p, this.center)) - angleOf(sub(this.ray, this.center));
      this.apply(a);
      return;
    }
    this.app.setPrompt(this.prompt);
  }

  apply(a) {
    const xf = rotation(this.center, a);
    if (this.copy) this.app.commit('Rotate copy', () => copyElements(this.doc, this.ids, xf));
    else this.app.commit('Rotate', () => transformElements(this.doc, this.ids, xf));
    this.app.cancelTool();
  }

  move(ev) {
    this.cursor = this.snap(ev, this.center, { exclude: this.exclude });
    this.app.requestRender();
  }

  key(e) {
    if (isNumericStart(e)) {
      e.preventDefault();
      const s = this.vc.modelToScreen(this.cursor || this.center);
      const input = this.openInput(s.x, s.y, {
        label: 'Angle',
        onSubmit: (v) => {
          const a = parseAngle(v);
          if (!Number.isFinite(a)) return false;
          this.apply(a);
          return true;
        },
      });
      input.value = e.key;
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    const c = S(this.center);
    ctx.save();
    ctx.strokeStyle = vp.theme.preview;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
    ctx.moveTo(c.x - 11, c.y);
    ctx.lineTo(c.x + 11, c.y);
    ctx.moveTo(c.x, c.y - 11);
    ctx.lineTo(c.x, c.y + 11);
    ctx.stroke();
    ctx.restore();
    if (this.ray) strokeModel(ctx, [this.center, this.ray], S, vp.theme.preview, 1.2);
    if (this.ray && this.cursor) {
      const a = angleOf(sub(this.cursor, this.center)) - angleOf(sub(this.ray, this.center));
      strokeModel(ctx, [this.center, this.cursor], S, vp.theme.preview, 1.2, [5, 4]);
      this.preview(ctx, vc, vp, rotation(this.center, a));
      const s = S(this.cursor);
      let deg = a;
      while (deg > Math.PI) deg -= Math.PI * 2;
      while (deg < -Math.PI) deg += Math.PI * 2;
      drawTag(ctx, s.x + 30, s.y + 20, formatAngle(deg, 1), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class MirrorTool extends SelectionTool {
  constructor(app, opts) {
    super(app, opts);
    this.draw = !!opts.draw;
    this.copy = true;
  }

  get title() {
    return this.draw ? 'Mirror - Draw Axis' : 'Mirror - Pick Axis';
  }

  get prompt() {
    if (!this.draw) return 'Click a line, wall or grid to mirror about';
    return this.start ? 'Click the end of the mirror axis' : 'Click the start of the mirror axis';
  }

  options() {
    return [checkbox('Copy', this.copy, (v) => (this.copy = v))];
  }

  axisFrom(ev) {
    this.snap(ev, this.start, { exclude: this.exclude });
    const line = this.snapRes?.ref?.line || this.snapRes?.line;
    return line ? [line.a, line.b] : null;
  }

  down(ev) {
    if (!this.draw) {
      const ax = this.axisFrom(ev);
      if (!ax) return;
      return this.apply(ax[0], ax[1]);
    }
    const p = this.snap(ev, this.start, { exclude: this.exclude });
    if (!p) return;
    if (!this.start) {
      this.start = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (dist(p, this.start) < 1) return;
    this.apply(this.start, p);
  }

  apply(a, b) {
    const xf = mirrorAcross(a, b);
    if (this.copy) this.app.commit('Mirror', () => copyElements(this.doc, this.ids, xf));
    else this.app.commit('Mirror', () => transformElements(this.doc, this.ids, xf));
    this.app.cancelTool();
  }

  move(ev) {
    if (this.draw) this.cursor = this.snap(ev, this.start, { exclude: this.exclude });
    else this.hoverAxis = this.axisFrom(ev);
    this.app.requestRender();
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    const ax = this.draw ? (this.start && this.cursor && dist(this.start, this.cursor) > 1 ? [this.start, this.cursor] : null) : this.hoverAxis;
    if (ax) {
      const d = norm(sub(ax[1], ax[0]));
      const L = 1e5;
      strokeModel(ctx, [add(ax[0], scale(d, -L)), add(ax[0], scale(d, L))], S, vp.theme.preview, 1.2, [10, 4, 2, 4]);
      this.preview(ctx, vc, vp, mirrorAcross(ax[0], ax[1]));
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class ArrayTool extends SelectionTool {
  constructor(app, opts) {
    super(app, opts);
    this.count = app.toolOptions('array', { count: 3 }).count;
  }

  get title() {
    return 'Array';
  }

  get prompt() {
    return this.base ? 'Click the position of the second item' : 'Click the start point';
  }

  options() {
    const o = this.app.toolOptions('array', { count: 3 });
    const inp = h('input.input.sm.num', { type: 'number', min: 2, max: 200, value: o.count, 'aria-label': 'Number of items' });
    inp.addEventListener('change', () => (o.count = this.count = Math.max(2, Math.min(200, Math.round(+inp.value || 2)))));
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return [h('div.ob-group', h('label', 'Number of items'), inp)];
  }

  down(ev) {
    const p = this.snap(ev, this.base, { exclude: this.exclude });
    if (!p) return;
    if (!this.base) {
      this.base = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    const d = sub(p, this.base);
    this.app.commit('Array', () => arrayLinear(this.doc, this.ids, d, this.count));
    this.app.cancelTool();
  }

  move(ev) {
    this.cursor = this.snap(ev, this.base, { exclude: this.exclude });
    this.app.requestRender();
  }

  drawOverlay(ctx, vc, vp) {
    if (this.base && this.cursor) {
      const d = sub(this.cursor, this.base);
      for (let i = 1; i < Math.min(this.count, 30); i++) this.preview(ctx, vc, vp, translation(scale(d, i)));
      const S = (p) => vc.modelToScreen(p);
      drawTempDim(ctx, S(this.base), S(this.cursor), this.fmt(len(d)), vp.theme.preview, vp.theme, -18);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

/** Pick an element's line feature near a pointer (walls: faces and centerline). */
function lineUnder(tool, ev, filter) {
  const vc = tool.vc;
  const p = ev.p;
  const feats = vc.snapFeaturesNear(p, 12 * vc.mmPerPx());
  let best = null;
  for (const f of feats)
    for (const l of f.lines) {
      if (filter && !filter(tool.doc.get(l.id), l)) continue;
      const c = closestOnSegment(p, l.a, l.b);
      const d = dist(c.point, p);
      if (d < 12 * vc.mmPerPx() && (!best || d < best.d)) best = { d, l, point: c.point };
    }
  return best;
}

export class AlignTool extends Tool {
  get title() {
    return 'Align';
  }

  get prompt() {
    return this.ref ? 'Click the edge of the element to align to the reference' : 'Click the reference line or face to align to';
  }

  down(ev) {
    const hit = lineUnder(this, ev);
    if (!hit) return;
    if (!this.ref) {
      this.ref = hit.l;
      this.app.setPrompt(this.prompt);
      return;
    }
    const target = hit.l;
    const d1 = norm(sub(this.ref.b, this.ref.a));
    const d2 = norm(sub(target.b, target.a));
    if (Math.abs(cross(d1, d2)) > 0.01) return this.app.toast('The edges must be parallel to align.', { kind: 'error' });
    const n = perp(d1);
    const off = dot(sub(this.ref.a, target.a), n);
    const el = this.doc.get(target.id);
    if (!el) return;
    if (el.pinned) return this.app.toast('That element is pinned.', { kind: 'error' });
    this.app.commit('Align', () => moveElements(this.doc, [el.id], scale(n, off)));
    this.ref = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.hover = ev.p ? lineUnder(this, ev) : null;
    this.app.requestRender();
  }

  cancel() {
    if (this.ref) {
      this.ref = null;
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    if (this.ref) strokeModel(ctx, [this.ref.a, this.ref.b], S, vp.theme.selCss, 2.5);
    if (this.hover) strokeModel(ctx, [this.hover.l.a, this.hover.l.b], S, vp.theme.preview, 2, [6, 3]);
  }
}

export class OffsetTool extends Tool {
  constructor(app, opts) {
    super(app, opts);
    this.o = app.toolOptions('offset', { distance: 1000, copy: true });
  }

  get title() {
    return 'Offset';
  }

  get prompt() {
    return 'Click a wall or line; the copy goes to the side of the cursor';
  }

  options() {
    const field = h('input.input.sm.num', { type: 'text', value: this.fmt(this.o.distance), 'aria-label': 'Offset distance' });
    field.addEventListener('change', () => {
      const v = this.parseLen(field.value);
      if (Number.isFinite(v) && v > 0) this.o.distance = v;
      field.value = this.fmt(this.o.distance);
    });
    field.addEventListener('keydown', (e) => e.stopPropagation());
    return [h('div.ob-group', h('label', 'Offset'), field), checkbox('Copy', this.o.copy, (v) => (this.o.copy = v))];
  }

  target(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y)) {
      const el = this.doc.get(id);
      if (el && ['wall', 'detailLine', 'roomSeparator', 'grid', 'beam'].includes(el.kind)) return el;
    }
    return null;
  }

  move(ev) {
    this.hover = this.target(ev);
    this.cursor = ev.p;
    this.app.setHover(this.hover?.id ?? null);
    this.app.requestRender();
  }

  down(ev) {
    const el = this.target(ev);
    if (!el || !ev.p) return;
    if (this.o.copy) this.app.commit('Offset', () => offsetElement(this.doc, el, this.o.distance, ev.p));
    else {
      const n = perp(norm(sub(el.b, el.a)));
      const s = dot(sub(ev.p, el.a), n) >= 0 ? 1 : -1;
      this.app.commit('Offset', () => moveElements(this.doc, [el.id], scale(n, s * this.o.distance)));
    }
  }

  drawOverlay(ctx, vc, vp) {
    if (this.hover && this.cursor) {
      const el = this.hover;
      const n = perp(norm(sub(el.b, el.a)));
      const s = dot(sub(this.cursor, el.a), n) >= 0 ? 1 : -1;
      const off = scale(n, s * this.o.distance);
      strokeModel(ctx, [add(el.a, off), add(el.b, off)], (p) => vc.modelToScreen(p), vp.theme.preview, 2, [6, 4]);
    }
  }
}

export class TrimTool extends Tool {
  constructor(app, opts) {
    super(app, opts);
    this.mode = opts.mode || 'corner';
  }

  get title() {
    return this.mode === 'corner' ? 'Trim/Extend to Corner' : 'Trim/Extend Single Element';
  }

  get prompt() {
    if (this.mode === 'corner') return this.first ? 'Click the second wall or line (on the part to keep)' : 'Click the first wall or line (on the part to keep)';
    return this.ref ? 'Click the wall or line to trim or extend (on the part to keep)' : 'Click the reference to trim or extend to';
  }

  target(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y)) {
      const el = this.doc.get(id);
      if (el && ['wall', 'detailLine', 'roomSeparator', 'beam', 'grid'].includes(el.kind)) return el;
    }
    return null;
  }

  down(ev) {
    if (this.mode === 'single' && !this.ref) {
      const hit = lineUnder(this, ev);
      if (!hit) return;
      this.ref = hit.l;
      this.app.setPrompt(this.prompt);
      return;
    }
    const el = this.target(ev);
    if (!el) return;
    if (this.mode === 'single') {
      this.app.commit('Extend', () => extendToLine(this.doc, el, ev.p, this.ref.a, this.ref.b));
      return;
    }
    if (!this.first) {
      this.first = { el, p: ev.p };
      this.app.select([el.id]);
      this.app.setPrompt(this.prompt);
      return;
    }
    if (el.id === this.first.el.id) return;
    const ok = this.app.commit('Corner', () => cornerWalls(this.doc, this.doc.get(this.first.el.id), this.first.p, el, ev.p));
    if (ok === false) this.app.toast('These elements are parallel.', { kind: 'error' });
    this.first = null;
    this.app.select([]);
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    const t = this.mode === 'single' && !this.ref ? null : this.target(ev);
    this.app.setHover(t?.id ?? null);
    this.hover = this.mode === 'single' && !this.ref ? lineUnder(this, ev) : null;
    this.app.requestRender();
  }

  cancel() {
    if (this.first || this.ref) {
      this.first = null;
      this.ref = null;
      this.app.setPrompt(this.prompt);
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    if (this.ref) strokeModel(ctx, [this.ref.a, this.ref.b], S, vp.theme.selCss, 2.5);
    if (this.hover) strokeModel(ctx, [this.hover.l.a, this.hover.l.b], S, vp.theme.preview, 2, [6, 3]);
  }
}

export class SplitTool extends Tool {
  get title() {
    return 'Split Element';
  }

  get prompt() {
    return 'Click on a wall or line where it should be split';
  }

  target(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y)) {
      const el = this.doc.get(id);
      if (el && ['wall', 'detailLine', 'roomSeparator', 'beam'].includes(el.kind)) return el;
    }
    return null;
  }

  move(ev) {
    this.hoverEl = this.target(ev);
    this.cursor = this.snap(ev);
    this.app.setHover(this.hoverEl?.id ?? null);
    this.app.requestRender();
  }

  down(ev) {
    const el = this.target(ev);
    if (!el) return;
    const p = this.snap(ev) || ev.p;
    const c = closestOnSegment(p, el.a, el.b).point;
    if (el.kind === 'wall') {
      const r = this.app.commit('Split wall', () => splitWall(this.doc, el, c));
      if (r === null) this.app.toast('Click away from the ends of the wall.', { kind: 'error' });
    } else {
      if (dist(c, el.a) < 1 || dist(c, el.b) < 1) return;
      this.app.commit('Split', () => {
        const { id: _id, ...rest } = el;
        void _id;
        this.doc.update(el.id, { b: c });
        this.doc.add({ ...rest, a: c });
      });
    }
  }

  drawOverlay(ctx, vc, vp) {
    if (this.hoverEl && this.cursor) {
      const c = closestOnSegment(this.cursor, this.hoverEl.a, this.hoverEl.b).point;
      const n = perp(norm(sub(this.hoverEl.b, this.hoverEl.a)));
      const S = (p) => vc.modelToScreen(p);
      const k = 14 * vc.mmPerPx();
      strokeModel(ctx, [add(c, scale(n, -k)), add(c, scale(n, k))], S, vp.theme.snap, 2);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class MeasureTool extends Tool {
  get title() {
    return 'Measure';
  }

  get viewKinds() {
    return ['plan', 'ceilingPlan', 'elevation', 'section'];
  }

  get prompt() {
    return this.a ? 'Click the second point' : 'Click the first point to measure between two points';
  }

  down(ev) {
    const p = this.snap(ev, this.a && !this.b ? this.a : null);
    if (!p) return;
    if (!this.a || this.b) {
      this.a = p;
      this.b = null;
    } else {
      this.b = p;
      const d = dist(this.a, this.b);
      this.app.setPrompt(`Distance ${this.fmt(d)}   ΔX ${this.fmt(Math.abs(this.b[0] - this.a[0]))}   ΔY ${this.fmt(Math.abs(this.b[1] - this.a[1]))}`);
      return;
    }
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.a && !this.b ? this.a : null);
    this.app.requestRender();
  }

  cancel() {
    if (this.a) {
      this.a = this.b = null;
      this.app.setPrompt(this.prompt);
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    const b = this.b || this.cursor;
    if (this.a && b && dist(this.a, b) > 0.5) {
      strokeModel(ctx, [this.a, b], S, vp.theme.snap, 1.5);
      drawTempDim(ctx, S(this.a), S(b), this.fmt(dist(this.a, b)), vp.theme.snap, vp.theme, -18);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class MatchTypeTool extends Tool {
  get title() {
    return 'Match Type';
  }

  get viewKinds() {
    return null;
  }

  get prompt() {
    return this.source ? `Click elements to give them the type of the source (${this.app.describe(this.source)})` : 'Click the element whose type to copy';
  }

  down(ev) {
    const id = this.vc.hitTest(ev.x, ev.y)[0];
    const el = id && this.doc.get(id);
    if (!el || !el.typeId) return;
    if (!this.source) {
      this.source = el;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (el.kind !== this.source.kind) return this.app.toast('Pick an element of the same category.', { kind: 'error' });
    this.app.commit('Match type', () => this.doc.update(el.id, { typeId: this.source.typeId }));
  }

  move(ev) {
    const id = this.vc.hitTest(ev.x, ev.y)[0];
    this.app.setHover(id ?? null);
  }

  cancel() {
    if (this.source) {
      this.source = null;
      this.app.setPrompt(this.prompt);
      return false;
    }
    return true;
  }
}

export class ZoomRegionTool extends Tool {
  get title() {
    return 'Zoom in Region';
  }

  get viewKinds() {
    return ['plan', 'ceilingPlan', 'elevation', 'section'];
  }

  get prompt() {
    return 'Drag a rectangle to zoom into';
  }

  down(ev) {
    this.a = { x: ev.x, y: ev.y };
  }

  move(ev) {
    if (this.a) {
      this.b = { x: ev.x, y: ev.y };
      this.app.requestRender();
    }
  }

  up(ev) {
    if (!this.a) return;
    const vc = this.vc;
    const b = { x: ev.x, y: ev.y };
    if (Math.abs(b.x - this.a.x) > 8 && Math.abs(b.y - this.a.y) > 8) {
      const p = vc.screenToModel(Math.min(this.a.x, b.x), Math.max(this.a.y, b.y));
      const q = vc.screenToModel(Math.max(this.a.x, b.x), Math.min(this.a.y, b.y));
      if (vc.zoomToBox) vc.zoomToBox({ x0: p[0], y0: p[1], x1: q[0], y1: q[1] });
      else {
        const f = Math.min(this.app.viewport.width / Math.abs(b.x - this.a.x), this.app.viewport.height / Math.abs(b.y - this.a.y));
        vc.zoomAt((this.a.x + b.x) / 2, (this.a.y + b.y) / 2, 1);
        vc.pan(this.app.viewport.width / 2 - (this.a.x + b.x) / 2, this.app.viewport.height / 2 - (this.a.y + b.y) / 2);
        vc.zoomAt(this.app.viewport.width / 2, this.app.viewport.height / 2, f);
      }
    }
    this.app.cancelTool();
  }

  drawOverlay(ctx, vc, vp) {
    if (this.a && this.b) {
      ctx.save();
      ctx.strokeStyle = vp.theme.preview;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(Math.min(this.a.x, this.b.x), Math.min(this.a.y, this.b.y), Math.abs(this.b.x - this.a.x), Math.abs(this.b.y - this.a.y));
      ctx.restore();
    }
  }
}

