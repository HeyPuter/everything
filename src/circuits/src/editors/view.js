// Base class for the design canvases: owns the WebGL renderer, turns pointer
// and keyboard input into world-space events for the active tool, and renders
// only when something changed.
//
// Navigation: right or middle drag pans; the wheel pans (Ctrl+wheel and
// trackpad pinch zoom) or zooms, per the user's setting; PageUp/PageDown
// zoom at the cursor; two fingers pan and pinch on touch screens; a long
// press opens the context menu.

import { h, announce } from '../ui/dom.js';
import { Renderer2D } from '../render/renderer2d.js';
import { Batch } from '../render/batch.js';
import { Emitter } from '../core/emitter.js';
import { snap } from '../core/units.js';

const DRAG_THRESHOLD = 4;
const LONG_PRESS_MS = 550;

export class CanvasView extends Emitter {
  constructor(app, { label }) {
    super();
    this.app = app;
    this.wrap = h('div.canvas-wrap');
    this.canvas = h('canvas.view', { tabindex: 0, role: 'application', 'aria-label': label, 'aria-roledescription': 'design canvas' });
    this.hud = h('div.hud', { 'aria-hidden': 'true' });
    this.hint = h('div.tool-hint', { hidden: true, 'aria-hidden': 'true' });
    this.wrap.append(this.canvas, this.hud, this.hint);
    this.el = h('div.editor', this.wrap);
    this.overlay = new Batch();       // tool previews, rebuilt on demand
    this.cursorBatch = new Batch();   // crosshair
    this.cursor = { x: 0, y: 0, sx: 0, sy: 0, inside: false };
    this.tool = null;
    this._frame = 0;
    this._dirtyOverlay = true;
    this.disposed = false;
    try {
      this.renderer = new Renderer2D(this.canvas);
      this.renderer.onRestore = () => { this.onContextRestored?.(); this.requestRender(); };
    } catch (err) {
      this.renderer = null;
      this.wrap.append(h('div.panel-empty', { role: 'alert', style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center' } },
        'This view needs WebGL2, which is not available in this browser or is turned off. Try an up-to-date browser with hardware acceleration enabled.'));
      console.error(err);
    }
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.wrap);
    // Moving the window to a screen with another pixel ratio does not resize
    // the canvas element, so watch the ratio itself or the drawing buffer
    // stays at the old density (blurry, or needlessly large).
    this._onDpr = () => { this._watchDpr(); this._resize(); };
    this._watchDpr();
    this._offSettings = app.settings?.on?.('change', ({ key }) => {
      if (key === 'schCrosshair' || key === 'pcbCrosshair') this.requestRender(true);
    });
    this._bindInput();
  }

  get grid() { return 0; }

  _watchDpr() {
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    this._dprQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) || null;
    this._dprQuery?.addEventListener?.('change', this._onDpr);
  }

  _resize() {
    if (!this.renderer) return;
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const first = !this._sized;
    this._sized = true;
    const cleared = this.renderer.resize(r.width, r.height);
    if (first) {
      if (this._pendingFit) { this.fitBox(this._pendingFit, false); this._pendingFit = null; } else this.fitAll?.(false);
    }
    // Resizing clears the drawing buffer, and the browser paints right after
    // the resize observer runs: draw now, or every step of a window or panel
    // resize shows a black canvas until the next frame.
    if (cleared) { cancelAnimationFrame(this._frame); this._render(); } else this.requestRender();
  }

  requestRender(overlay = false) {
    if (overlay) this._dirtyOverlay = true;
    if (this._frame || this.disposed || !this.renderer) return;
    this._frame = requestAnimationFrame(() => this._render());
  }

  _render() {
    this._frame = 0;
    if (this.disposed || !this.el.isConnected) return;
    if (this._dirtyOverlay) { this._dirtyOverlay = false; this.buildOverlay(); }
    this.draw();
    this.emit('rendered');
  }

  /** Subclasses rebuild previews into this.overlay. */
  buildOverlay() {
    this.overlay.clear();
    this.tool?.drawOverlay?.(this.overlay);
    this.drawCursor(this.overlay);
    this.overlay.touch();
  }

  drawCursor() {}

  /**
   * Full-view crosshair through the (snapped) cursor, for the crosshair
   * cursor preferences. Two lines in the overlay, which is rebuilt on pointer
   * moves anyway, so it costs nothing extra and nothing at all when off.
   */
  drawFullCrosshair(b, color) {
    if (!this.renderer || !this.cursor.inside) return;
    const v = this.renderer.visibleBox(2);
    const { x, y } = this.cursor;
    b.line(v.minX, y, v.maxX, y, 0, color);
    b.line(x, v.minY, x, v.maxY, 0, color);
  }

  draw() {}

  // ---- Coordinates and snapping ----

  /** Raw world position of a client point. */
  worldAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    const [x, y] = this.renderer ? this.renderer.screenToWorld(sx, sy) : [0, 0];
    return { x, y, sx, sy };
  }

  /** Snaps to the grid, or to an object hotspot within reach when enabled. */
  snapPoint(x, y, { grid = this.grid, objects = true, exclude } = {}) {
    if (objects && this.snapTargets) {
      const reach = 8 * this.nmPerPx;
      const t = this.snapTargets(x, y, reach, exclude);
      if (t) return { x: t.x, y: t.y, target: t };
    }
    return { x: snap(x, grid), y: snap(y, grid), target: null };
  }

  get nmPerPx() { return this.renderer ? this.renderer.nmPerPx : 1000; }

  _event(e, extra = {}) {
    const w = this.worldAt(e.clientX, e.clientY);
    const s = this.tool?.noSnap || e.altKey ? { x: Math.round(w.x), y: Math.round(w.y), target: null } : this.snapPoint(w.x, w.y, { exclude: this.tool?.snapExclude });
    return {
      x: s.x, y: s.y, target: s.target, rawX: w.x, rawY: w.y, sx: w.sx, sy: w.sy,
      button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey,
      pointerType: e.pointerType || 'mouse', clientX: e.clientX, clientY: e.clientY, original: e, ...extra,
    };
  }

  // ---- Tools ----

  setTool(tool) {
    if (this.tool === tool) return;
    this.tool?.deactivate?.();
    this.tool = tool;
    tool?.activate?.();
    this.canvas.style.cursor = tool?.cursor || 'default';
    this.updateHint();
    this.emit('tool', tool);
    this.requestRender(true);
  }

  updateHint() {
    const text = this.tool?.hint?.();
    this.hint.hidden = !text;
    if (text) this.hint.textContent = text;
  }

  // ---- Input ----

  _bindInput() {
    const c = this.canvas;
    const pointers = new Map();
    let pan = null;          // { x, y, button }
    let press = null;        // pending left press for click/drag disambiguation
    let pinch = null;
    let longTimer = null;

    const clearLong = () => { clearTimeout(longTimer); longTimer = null; };

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        // Second finger: switch to pinch, cancel any tool gesture in progress.
        clearLong();
        if (press?.dragging) this.tool?.cancelDrag?.();
        press = null;
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        return;
      }
      if (e.button === 1 || e.button === 2) {
        pan = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const ev = this._event(e);
      press = { x: e.clientX, y: e.clientY, ev, dragging: false, pointerType: e.pointerType };
      if (e.pointerType === 'touch') {
        longTimer = setTimeout(() => {
          if (press && !press.dragging) { const p = press; press = null; this.onContextMenu(p.ev, e); }
        }, LONG_PRESS_MS);
      }
      this.tool?.down?.(ev);
      this.requestRender(true);
    });

    c.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const r = c.getBoundingClientRect();
        this.renderer.panBy(cx - pinch.cx, cy - pinch.cy);
        if (pinch.d > 0) this.renderer.zoomAt(cx - r.left, cy - r.top, d / pinch.d);
        pinch = { d, cx, cy };
        this.onViewChanged();
        return;
      }
      if (pan) {
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (!pan.moved) { pan.moved = true; c.style.cursor = 'grabbing'; }
        this.renderer.panBy(dx, dy);
        pan.x = e.clientX; pan.y = e.clientY;
        this.onViewChanged();
        return;
      }
      const ev = this._event(e);
      this.cursor = { x: ev.x, y: ev.y, sx: ev.sx, sy: ev.sy, inside: true, target: ev.target };
      if (press) {
        const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_THRESHOLD;
        if (moved) { clearLong(); press.moved = true; }
        // Tools without a drag gesture (wires, placing) keep the press a
        // click, at the release point the preview followed, so a hand that
        // moves a few pixels does not lose it.
        const draggable = typeof this.tool?.dragStart === 'function';
        if (draggable && !press.dragging && moved) {
          press.dragging = true;
          this.tool.dragStart(press.ev, ev);
        }
        if (press.dragging) this.tool?.drag?.(ev, press.ev);
        else if (!draggable && typeof this.tool?.move === 'function') this.tool.move(ev);
      } else this.tool?.move?.(ev);
      this.emit('cursor', this.cursor);
      this.requestRender(true);
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      clearLong();
      if (pinch) { if (pointers.size < 2) pinch = null; return; }
      if (pan) {
        const wasClick = !pan.moved && pan.button === 2;
        pan = null;
        c.style.cursor = this.tool?.cursor || 'default';
        if (wasClick && e.type === 'pointerup') {
          // Right click: tools may consume it (finish a wire), else context menu.
          const ev = this._event(e);
          if (!this.tool?.rightClick?.(ev)) this.onContextMenu(ev, e);
          this.requestRender(true);
        }
        return;
      }
      if (!press) return;
      const p = press;
      press = null;
      if (e.type === 'pointercancel') { if (p.dragging) this.tool?.cancelDrag?.(); return; }
      const ev = this._event(e);
      if (p.dragging) this.tool?.dragEnd?.(ev, p.ev);
      else this.tool?.click?.(p.moved ? ev : p.ev, e.detail);
      this.tool?.up?.(ev);
      this.requestRender(true);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => { this.tool?.dblclick?.(this._event(e)); this.requestRender(true); });
    c.addEventListener('pointerleave', () => { this.cursor.inside = false; this.requestRender(true); });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.renderer) return;
      const r = c.getBoundingClientRect();
      const zoomMode = this.app.settings.get('wheel') === 'zoom';
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * scale, dy = e.deltaY * scale;
      if (e.ctrlKey || e.metaKey || (zoomMode && !e.shiftKey)) {
        this.renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey && Math.abs(dy) < 50 ? 0.01 : 0.0018)));
      } else if (e.shiftKey) {
        // Shift scrolls sideways. macOS already turns a Shift+wheel into
        // deltaX, so use whichever axis carries the scroll.
        this.renderer.panBy(-(Math.abs(dx) > Math.abs(dy) ? dx : dy), 0);
      } else this.renderer.panBy(-dx, -dy);
      this.onViewChanged();
      // Keep the snapped cursor in sync with the new view, and anything being
      // dragged under it (the select tool's `move` is its move session, not a
      // handler, so only call functions).
      const ev = this._event(e);
      this.cursor = { ...this.cursor, x: ev.x, y: ev.y, sx: ev.sx, sy: ev.sy };
      if (press) {
        if (press.dragging) this.tool?.drag?.(ev, press.ev);
      } else if (typeof this.tool?.move === 'function') this.tool.move(ev);
    }, { passive: false });

    // Safari trackpad pinch.
    let gestureScale = 1;
    c.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
    c.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, e.scale / gestureScale);
      gestureScale = e.scale;
      this.onViewChanged();
    });
  }

  onViewChanged() {
    this.requestRender(true);
    this.emit('view');
  }

  onContextMenu() {}

  // ---- View commands ----

  zoomBy(factor, atCursor = true) {
    if (!this.renderer || !this._sized) return;
    const sx = atCursor && this.cursor.inside ? this.cursor.sx : this.renderer.cssW / 2;
    const sy = atCursor && this.cursor.inside ? this.cursor.sy : this.renderer.cssH / 2;
    this.renderer.zoomAt(sx, sy, factor);
    this.onViewChanged();
  }

  fitBox(box, animate = true) {
    if (!this.renderer || !box || !(box.minX <= box.maxX)) return;
    // Before the first layout the view has no size; the first resize fits anyway.
    if (!this._sized) { this._pendingFit = box; return; }
    const pad = { minX: box.minX, minY: box.minY, maxX: Math.max(box.maxX, box.minX + 1e5), maxY: Math.max(box.maxY, box.minY + 1e5) };
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.renderer.fitBox(pad, 32);
      this.onViewChanged();
      return;
    }
    const v = this.renderer.view, from = { ...v };
    this.renderer.fitBox(pad, 32);
    const to = { ...v };
    Object.assign(v, from);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 180), e = 1 - (1 - k) ** 3;
      v.cx = from.cx + (to.cx - from.cx) * e;
      v.cy = from.cy + (to.cy - from.cy) * e;
      v.scale = from.scale * (to.scale / from.scale) ** e;
      this.onViewChanged();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Centers the view on a world point at a comfortable zoom. */
  zoomTo(x, y, sizeNm = 10_000_000) {
    this.fitBox({ minX: x - sizeNm / 2, minY: y - sizeNm / 2, maxX: x + sizeNm / 2, maxY: y + sizeNm / 2 });
  }

  announce(text) { announce(text); }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._frame);
    this._ro.disconnect();
    this._offSettings?.();
    this._dprQuery?.removeEventListener?.('change', this._onDpr);
    this.tool?.deactivate?.();
    this.renderer?.dispose();
    this.el.remove();
  }
}
