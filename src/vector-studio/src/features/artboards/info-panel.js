/**
 * Info panel (F8): pointer X/Y (artboard ruler coordinates), the selection's
 * W/H (or the drag's distance and angle while dragging), the Measure tool's
 * result, and the fill and stroke color values of the selection.
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { paintSwatch, updatePaintSwatch } from '../../ui/widgets.js';
import { formatLength } from '../../lib/units.js';
import { hexToRgb, cmykEngine } from '../../lib/color.js';
import { commonStyle } from '../../ops/paint-ops.js';
import { measureValues } from './measure-reshape.js';

/**
 * Text description of a paint for the Info panel (CMYK percentages in CMYK
 * documents); a spot color shows its name and tint.
 */
export function paintInfo(p, mode = 'RGB', doc = null) {
  if (p === 'mixed') return 'Mixed';
  if (!p) return 'None';
  const spot = p.swatchId && (doc?.root.swatches || []).find((sw) => sw.id === p.swatchId && sw.spot);
  if (spot) return `${spot.name} ${Math.round((p.tint ?? 1) * 100)}%`;
  if (p.type === 'solid') {
    const c = hexToRgb(p.color);
    if (mode === 'CMYK') {
      // Converted colors keep their CMYK numbers; others go through the document's CMYK profile.
      const k = p.cmyk || cmykEngine.toCmyk(c);
      const r = (v) => Math.round(v);
      return `C ${r(k.c)}%  M ${r(k.m)}%  Y ${r(k.y)}%  K ${r(k.k)}%`;
    }
    return `R ${c.r}  G ${c.g}  B ${c.b}  ${p.color.toUpperCase()}`;
  }
  if (p.type === 'linear' || p.type === 'radial') return `${p.type === 'linear' ? 'Linear' : 'Radial'} gradient, ${p.stops.length} stops`;
  return p.type;
}

export class InfoPanel extends Panel {
  static id = 'info';
  static title = 'Info';
  static icon = 'info';
  static placement = 'strip';
  static shortcut = 'F8';

  menu() {
    const on = this.app.prefs.get('infoShowOptions') !== false;
    return [{ label: on ? 'Hide Options' : 'Show Options', run: () => (this.app.prefs.set('infoShowOptions', !on), this.update()) }];
  }

  build() {
    const cell = (label) => {
      const v = h('output.info-val');
      return { el: h('div.info-cell', h('span.info-key', label), v), v };
    };
    this.x = cell('X');
    this.y = cell('Y');
    this.w = cell('W');
    this.hh = cell('H');
    this.d = cell('D');
    this.a = cell('∠');
    this.fillSw = paintSwatch(null);
    this.strokeSw = paintSwatch(null, { className: 'stroke-swatch' });
    this.fillTxt = h('span.info-paint');
    this.strokeTxt = h('span.info-paint');
    this.empty = emptyState('Open a document to see measurements.');
    this.grid = h('div.info-grid', this.x.el, this.w.el, this.y.el, this.hh.el, this.d.el, this.a.el);
    this.paints = h('div.info-paints', h('div.info-paint-row', this.fillSw, h('span.info-key', 'Fill'), this.fillTxt), h('div.info-paint-row', this.strokeSw, h('span.info-key', 'Stroke'), this.strokeTxt));
    this.paintSection = h('section.panel-section', this.paints);
    this.el.append(this.empty, h('section.panel-section', this.grid), this.paintSection);
    this.pointer = null;
    this.dragStart = null;
    this.frame = 0;
    const app = this.app;
    const prev = app.setPointerStatus;
    app.setPointerStatus = (ev) => {
      prev?.(ev);
      this.onPointer(ev);
    };
    app.on('measure', () => this.visible && this.schedule());
  }

  onPointer(ev) {
    const pressed = Boolean(ev.native?.buttons & 1);
    if (pressed && !this.dragStart) this.dragStart = { x: ev.x, y: ev.y };
    if (!pressed) this.dragStart = null;
    this.pointer = { x: ev.x, y: ev.y };
    if (this.visible) this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  update() {
    const app = this.app;
    const ed = app.editor;
    this.empty.hidden = Boolean(ed);
    for (const c of this.el.children) if (c !== this.empty) c.hidden = !ed;
    if (!ed) return;
    // Hide Options hides the fill and stroke rows.
    this.paintSection.hidden = this.app.prefs.get('infoShowOptions') === false;
    const unit = ed.doc.root.units || 'pt';
    const f = (v) => (v == null || !Number.isFinite(v) ? '' : formatLength(v, unit));
    const o = this.app.rulerOrigin?.(ed) || ed.artboard() || { x: 0, y: 0 };
    const p = this.pointer;
    this.x.v.textContent = p ? f(p.x - o.x) : '';
    this.y.v.textContent = p ? f(p.y - o.y) : '';
    const m = app.toolId === 'measure' ? app.measure : null;
    let dist = null;
    let angle = null;
    if (m) {
      const v = measureValues(m);
      dist = v.d;
      angle = v.angle;
      this.w.v.textContent = f(Math.abs(v.dx));
      this.hh.v.textContent = f(Math.abs(v.dy));
    } else {
      // W and H of a turned selection are measured along its own axes, like the Transform panel.
      const b = ed.selectionFrame();
      if (this.dragStart && p) {
        const dx = p.x - this.dragStart.x;
        const dy = p.y - this.dragStart.y;
        dist = Math.hypot(dx, dy);
        angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
      }
      this.w.v.textContent = b ? f(b.w) : '';
      this.hh.v.textContent = b ? f(b.h) : '';
    }
    this.d.v.textContent = dist != null ? f(dist) : '';
    this.a.v.textContent = angle != null ? `${Number((Math.abs(angle) < 1e-9 ? 0 : angle).toFixed(2))}°` : '';
    const fill = commonStyle(ed, 'fill');
    const stroke = commonStyle(ed, 'stroke');
    updatePaintSwatch(this.fillSw, fill === 'mixed' ? null : fill, fill === 'mixed');
    updatePaintSwatch(this.strokeSw, stroke === 'mixed' ? null : stroke, stroke === 'mixed');
    const mode = ed.doc.root.colorMode === 'CMYK' ? 'CMYK' : 'RGB';
    this.fillTxt.textContent = paintInfo(fill, mode, ed.doc);
    const sw = commonStyle(ed, 'strokeWidth');
    this.strokeTxt.textContent = paintInfo(stroke, mode, ed.doc) + (stroke && stroke !== 'mixed' && sw !== 'mixed' && sw != null ? `, ${f(sw)}` : '');
  }
}
