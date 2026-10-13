/**
 * Navigator panel: a thumbnail of the document (artboards and artwork,
 * re-rendered lazily after edits settle), the view rectangle you can drag
 * or click to pan, and zoom controls (out, slider, in, percentage field).
 * The panel menu has View Artboard Only (the thumbnail shows just the
 * active artboard) and Panel Options (view box color, outline thumbnail).
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { drawArtwork } from '../../render/draw.js';
import { visualBounds, unionRect } from '../../model/geometry.js';
import { MIN_ZOOM, MAX_ZOOM } from '../../render/viewport.js';

const THUMB_W = 240;
const THUMB_H = 170;
const LOG_MIN = Math.log(MIN_ZOOM);
const LOG_MAX = Math.log(MAX_ZOOM);

/** Document rect shown in the navigator: artboards plus artwork (or one artboard), padded. */
export function navigatorExtent(doc, { artboard = null } = {}) {
  let r = null;
  if (artboard) {
    const pad = Math.max(artboard.w, artboard.h) * 0.04 + 1;
    return { x: artboard.x - pad, y: artboard.y - pad, w: artboard.w + pad * 2, h: artboard.h + pad * 2 };
  }
  for (const a of doc.artboards) r = unionRect(r, a);
  for (const id of doc.root.children) {
    const l = doc.get(id);
    if (l && !l.hidden) r = unionRect(r, visualBounds(doc, l));
  }
  if (!r) r = { x: 0, y: 0, w: 612, h: 792 };
  const pad = Math.max(r.w, r.h) * 0.04 + 1;
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export class NavigatorPanel extends Panel {
  static id = 'navigator';
  static title = 'Navigator';
  static icon = 'compass';
  static placement = 'strip';

  menu() {
    const o = this.options;
    return [
      { label: 'View Artboard Only', checked: o.artboardOnly, run: () => this.setOptions({ artboardOnly: !o.artboardOnly }) },
      '-',
      'view.zoomIn',
      'view.zoomOut',
      'view.fitArtboard',
      'view.fitAll',
      '-',
      { label: 'Panel Options...', run: () => this.panelOptions() },
    ];
  }

  get options() {
    return { artboardOnly: false, boxColor: '#e5484d', outline: false, ...(this.app.prefs.get('navigator') || {}) };
  }

  setOptions(patch) {
    this.app.prefs.set('navigator', { ...this.options, ...patch });
    this.thumbFor = null;
    if (this.visible) this.renderThumb();
  }

  async panelOptions() {
    const o = this.options;
    const v = await this.app.dialogs.form({
      title: 'Navigator Options',
      fields: [
        { key: 'boxColor', label: 'View box color', type: 'color', value: o.boxColor },
        { key: 'outline', label: 'Show artwork as outlines', type: 'checkbox', value: o.outline },
        { key: 'artboardOnly', label: 'View Artboard Only', type: 'checkbox', value: o.artboardOnly },
      ],
    });
    if (v) this.setOptions(v);
  }

  build() {
    const app = this.app;
    this.canvas = h('canvas.nav-thumb', { 'aria-hidden': 'true' });
    this.viewBox = h('div.nav-view', { 'aria-hidden': 'true' });
    this.stage = h('div.nav-stage', { role: 'group', tabindex: '0', 'aria-label': 'Document overview: drag the view box or use the arrow keys to pan' }, this.canvas, this.viewBox);
    this.stage.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const ed = this.app.editor;
      if (!d || !ed) return;
      e.preventDefault();
      e.stopPropagation();
      const step = (e.shiftKey ? 0.5 : 0.1) * Math.min(ed.view.width, ed.view.height);
      ed.view.set({ panX: ed.view.panX - d[0] * step, panY: ed.view.panY - d[1] * step });
      ed.viewChanged();
    });
    this.slider = h('input.nav-slider', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': 'Zoom', oninput: () => this.setZoom(Math.exp(LOG_MIN + (Number(this.slider.value) / 1000) * (LOG_MAX - LOG_MIN))) });
    this.zoomField = h('input.nav-zoom', {
      type: 'text',
      inputmode: 'decimal',
      'aria-label': 'Zoom level',
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const v = parseFloat(this.zoomField.value);
          if (Number.isFinite(v) && v > 0) this.setZoom(v / 100);
          this.zoomField.select();
        }
        if (e.key === 'Escape') this.zoomField.blur();
      },
      onblur: () => this.update(),
    });
    const out = iconButton('zoom-out', 'Zoom Out', () => this.step(-1), { size: 14 });
    const inn = iconButton('zoom-in', 'Zoom In', () => this.step(1), { size: 14 });
    this.controls = h('div.nav-controls', this.zoomField, out, this.slider, inn);
    this.empty = emptyState('No document open.');
    this.el.append(this.empty, this.stage, this.controls);
    this.thumbTimer = 0;
    this.thumbFor = null;
    this.stage.addEventListener('pointerdown', (e) => this.startDrag(e));
    this.listeners = [];
    app.on('active-editor', () => this.attach());
    this.attach();
  }

  attach() {
    for (const off of this.listeners) off?.();
    this.listeners = [];
    const ed = this.app.editor;
    if (!ed) return;
    this.listeners.push(
      ed.on('view', () => this.visible && this.updateView()),
      ed.on('doc-change', (e) => this.visible && e.commit && this.scheduleThumb()),
      // The active artboard changes what View Artboard Only shows.
      ed.on('artboard', () => this.visible && this.scheduleThumb(this.options.artboardOnly ? 0 : 350)),
    );
    this.thumbFor = null;
  }

  scheduleThumb(delay = 350) {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => this.renderThumb(), delay);
  }

  /** Map between document and thumbnail coordinates. */
  mapping() {
    const ed = this.app.editor;
    const ext = navigatorExtent(ed.doc, { artboard: this.options.artboardOnly ? ed.artboard() : null });
    const s = Math.min(THUMB_W / ext.w, THUMB_H / ext.h);
    const ox = (THUMB_W - ext.w * s) / 2 - ext.x * s;
    const oy = (THUMB_H - ext.h * s) / 2 - ext.y * s;
    return { s, ox, oy };
  }

  renderThumb() {
    const ed = this.app.editor;
    if (!ed || !this.visible) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = this.canvas;
    c.width = THUMB_W * dpr;
    c.height = THUMB_H * dpr;
    c.style.width = `${THUMB_W}px`;
    c.style.height = `${THUMB_H}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const m = (this.map = this.mapping());
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cs = getComputedStyle(this.stage);
    ctx.fillStyle = cs.getPropertyValue('--pasteboard').trim() || '#d8d8d8';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(m.s * dpr, 0, 0, m.s * dpr, m.ox * dpr, m.oy * dpr);
    const o = this.options;
    const only = o.artboardOnly ? ed.artboard() : null;
    const boards = only ? [only] : ed.doc.artboards;
    for (const a of boards) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(a.x, a.y, a.w, a.h);
    }
    if (only) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(only.x, only.y, only.w, only.h);
      ctx.clip();
    }
    try {
      drawArtwork(ctx, ed.doc, { viewRect: only ? { ...only } : null, outline: o.outline || ed.viewOptions.mode === 'outline', hairline: 1 / (m.s * dpr), outlineColor: '#000000', scale: m.s * dpr });
    } catch {
      // A thumbnail is best effort; the canvas view reports real render errors.
    }
    if (only) ctx.restore();
    ctx.lineWidth = 1 / (m.s * dpr);
    ctx.strokeStyle = cs.getPropertyValue('--artboard-border').trim() || '#2b2b2b';
    for (const a of boards) ctx.strokeRect(a.x, a.y, a.w, a.h);
    this.viewBox.style.borderColor = o.boxColor;
    this.thumbFor = ed;
    this.updateView();
  }

  updateView() {
    const ed = this.app.editor;
    if (!ed || !this.map) return;
    const m = this.map;
    const r = ed.view.visibleRect(0);
    const x = r.x * m.s + m.ox;
    const y = r.y * m.s + m.oy;
    const w = r.w * m.s;
    const hh = r.h * m.s;
    // Clip the box to the stage so it stays visible when zoomed far out.
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(THUMB_W, x + w);
    const y1 = Math.min(THUMB_H, y + hh);
    Object.assign(this.viewBox.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.max(2, x1 - x0)}px`, height: `${Math.max(2, y1 - y0)}px` });
    this.viewBox.hidden = x1 <= 0 || y1 <= 0 || x0 >= THUMB_W || y0 >= THUMB_H;
    const z = ed.view.zoom;
    if (document.activeElement !== this.slider) this.slider.value = String(Math.round(((Math.log(z) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000));
    this.slider.setAttribute('aria-valuetext', `${Number((z * 100).toFixed(2))}%`);
    if (document.activeElement !== this.zoomField) this.zoomField.value = `${Number((z * 100).toFixed(2))}%`;
  }

  setZoom(z) {
    const ed = this.app.editor;
    if (!ed) return;
    ed.view.zoomAt(z, ed.view.width / 2, ed.view.height / 2);
    ed.viewChanged();
  }

  step(dir) {
    const ed = this.app.editor;
    if (!ed) return;
    ed.view.stepZoom(dir);
    ed.viewChanged();
  }

  /** Center the view on a thumbnail point. */
  panTo(tx, ty) {
    const ed = this.app.editor;
    if (!ed || !this.map) return;
    const m = this.map;
    ed.view.centerOn((tx - m.ox) / m.s, (ty - m.oy) / m.s);
    ed.viewChanged();
  }

  startDrag(e) {
    if (e.button !== 0 || !this.map) return;
    e.preventDefault();
    const rect = this.stage.getBoundingClientRect();
    const vb = this.viewBox.getBoundingClientRect();
    const inside = e.clientX >= vb.left && e.clientX <= vb.right && e.clientY >= vb.top && e.clientY <= vb.bottom;
    // Dragging the box keeps the grab offset; clicking elsewhere centers the view there.
    const offX = inside ? e.clientX - (vb.left + vb.width / 2) : 0;
    const offY = inside ? e.clientY - (vb.top + vb.height / 2) : 0;
    const move = (ev) => this.panTo(ev.clientX - rect.left - offX, ev.clientY - rect.top - offY);
    if (!inside) move(e);
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already-released pointers cannot be captured.
    }
    const up = () => {
      this.stage.removeEventListener('pointermove', move);
      this.stage.removeEventListener('pointerup', up);
    };
    this.stage.addEventListener('pointermove', move);
    this.stage.addEventListener('pointerup', up);
  }

  update() {
    const ed = this.app.editor;
    this.empty.hidden = Boolean(ed);
    this.stage.hidden = this.controls.hidden = !ed;
    if (!ed) return;
    if (this.thumbFor !== ed || !this.map) this.renderThumb();
    else this.updateView();
  }

  shown() {
    super.shown();
    this.scheduleThumb(0);
  }
}
