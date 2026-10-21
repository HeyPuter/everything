/**
 * The drawing surface: one WebGL2 canvas shared by every graphical view,
 * a 2D overlay canvas for text and interaction feedback, render scheduling
 * and pointer, wheel and touch input. The active view controller decides
 * what is drawn; the active tool receives pointer events.
 */
import { StateTexture, cssColor } from '../render/gl.js';
import { Renderer2D } from '../render/renderer2d.js';
import { Renderer3D } from '../render/renderer3d.js';
import { ImageRenderer } from '../render/images.js';

export class Viewport {
  constructor(app, wrap, glCanvas, overlay) {
    this.app = app;
    this.wrap = wrap;
    this.canvas = glCanvas;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    const gl = glCanvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.state = new StateTexture(gl);
    this.r2 = new Renderer2D(gl, this.state);
    this.r3 = new Renderer3D(gl, this.state);
    this.images = new ImageRenderer(gl, () => this.requestRender());
    this.controller = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.pending = false;
    this.pointers = new Map();
    // Tiled windows: view ids shown side by side (null: one view).
    this.tileIds = null;
    this.tiles = [];
    this.proxies = new Map();
    this.readTheme();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(wrap);
    this.resize();
    this.bindInput();
    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      app.toast?.('Graphics were reset by the browser. Reload if the view stays blank.', { kind: 'error' });
    });
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => cssColor(cs.getPropertyValue(n), f);
    this.theme = {
      ink: v('--ink', [0.08, 0.1, 0.12]),
      bg: v('--bg-canvas', [1, 1, 1]),
      sel: v('--sel', [0.12, 0.43, 1]),
      hover: v('--hover', [0.18, 0.55, 1]),
      snap: cs.getPropertyValue('--snap').trim() || '#d97706',
      preview: cs.getPropertyValue('--preview').trim() || '#2563eb',
      inkCss: cs.getPropertyValue('--ink').trim() || '#15191f',
      bgCss: cs.getPropertyValue('--bg-canvas').trim() || '#ffffff',
      selCss: cs.getPropertyValue('--sel').trim() || '#1f6fff',
      font: cs.getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif',
    };
    this.requestRender();
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.controller?.resized?.();
    this.render();
  }

  setController(c) {
    if (this.controller === c) return;
    this.controller?.deactivate?.();
    this.controller = c;
    this.app.tool?.viewChanged?.();
    c?.activate?.();
    const graphical = !!c?.graphical;
    this.canvas.hidden = !graphical;
    this.overlay.hidden = !graphical;
    this.requestRender();
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    const c = this.controller;
    const gl = this.gl;
    if (!c || !c.graphical) return;
    if (this.tileIds?.length > 1) return this.renderTiles();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = this.theme.bg;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.app.updateStateFlags(c);
    try {
      c.render(this);
    } catch (err) {
      console.error(err);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    try {
      c.drawOverlay?.(ctx, this);
      this.app.tool?.drawOverlay?.(ctx, c, this);
      this.app.drawSelectionOverlay?.(ctx, c, this);
    } catch (err) {
      console.error(err);
    }
  }

  // Tiles ------------------------------------------------------------------------------

  get tiled() {
    return this.tileIds?.length > 1;
  }

  /** Lay the tiled views out in a grid that fills the canvas. */
  layoutTiles() {
    const ids = this.tileIds || [];
    const n = ids.length;
    const landscape = this.width >= this.height;
    const cols = landscape ? Math.ceil(Math.sqrt(n)) : Math.ceil(n / Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    const gap = 3;
    const w = (this.width - gap * (cols - 1)) / cols;
    const hgt = (this.height - gap * (rows - 1)) / rows;
    this.tiles = ids.map((viewId, i) => {
      const r = Math.floor(i / cols);
      const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      // The last row shares its width among fewer tiles.
      const rw = (this.width - gap * (inRow - 1)) / inRow;
      const c = i - r * cols;
      return { viewId, x: Math.round(c * (rw + gap)), y: Math.round(r * (hgt + gap)), w: Math.round(r === rows - 1 ? rw : w), h: Math.round(hgt) };
    });
    return this.tiles;
  }

  tileAt(x, y) {
    return this.tiles.find((t) => x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) || null;
  }

  /** A stand-in viewport the size of one tile, for the controller drawn in it. */
  proxyFor(t) {
    let p = this.proxies.get(t.viewId);
    if (!p) {
      p = Object.create(this);
      // Drawing is always of the whole canvas.
      p.requestRender = () => this.requestRender();
      p.render = () => this.render();
      this.proxies.set(t.viewId, p);
    }
    p.width = t.w;
    p.height = t.h;
    p.canvas = { width: Math.round(t.w * this.dpr), height: Math.round(t.h * this.dpr) };
    p.tile = t;
    return p;
  }

  /** Show these views side by side (null or one view: back to a single view). */
  setTiles(ids) {
    const app = this.app;
    this.tileIds = ids && ids.length > 1 ? ids : null;
    if (!this.tileIds) {
      for (const c of app.controllers.values()) if (c.vp !== this) c.vp = this;
      this.proxies.clear();
      this.tiles = [];
      this.controller?.resized?.();
    }
    this.requestRender();
  }

  renderTiles() {
    const app = this.app;
    const gl = this.gl;
    const dpr = this.dpr;
    const ctx = this.ctx;
    const tiles = this.layoutTiles();
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const border = this.theme.ink;
    gl.clearColor(border[0] * 0.25 + 0.6, border[1] * 0.25 + 0.6, border[2] * 0.25 + 0.6, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    // The active view last, so picking and element states belong to it.
    const order = [...tiles].sort((a, b) => (a.viewId === app.activeViewId) - (b.viewId === app.activeViewId));
    gl.enable(gl.SCISSOR_TEST);
    for (const t of order) {
      const view = app.doc.get(t.viewId);
      const c = view && app.controllerFor(view);
      if (!c?.graphical) continue;
      const proxy = this.proxyFor(t);
      if (c.vp !== proxy) {
        c.vp = proxy;
        c.resized?.();
      }
      const rect = [Math.round(t.x * dpr), Math.round((this.height - t.y - t.h) * dpr), proxy.canvas.width, proxy.canvas.height];
      gl.scissor(...rect);
      gl.viewport(...rect);
      this.r3.viewportRect = rect;
      const bg = this.theme.bg;
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      app.updateStateFlags(c);
      try {
        c.render(proxy);
      } catch (err) {
        console.error(err);
      }
      gl.viewport(...rect);
      const active = t.viewId === app.activeViewId;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, t.x * dpr, t.y * dpr);
      ctx.beginPath();
      ctx.rect(0, 0, t.w, t.h);
      ctx.clip();
      try {
        c.drawOverlay?.(ctx, proxy);
        if (active) {
          app.tool?.drawOverlay?.(ctx, c, proxy);
          app.drawSelectionOverlay?.(ctx, c, proxy);
        }
      } catch (err) {
        console.error(err);
      }
      // Title and frame; the active view is outlined in the selection colour.
      ctx.font = `600 11px ${this.theme.font}`;
      const label = view.name;
      const lw = ctx.measureText(label).width + 12;
      ctx.fillStyle = active ? this.theme.selCss : 'rgba(110,118,130,0.85)';
      ctx.fillRect(0, 0, lw, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, 6, 13);
      if (active) {
        ctx.strokeStyle = this.theme.selCss;
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, t.w - 2, t.h - 2);
      }
      ctx.restore();
    }
    gl.disable(gl.SCISSOR_TEST);
    this.r3.viewportRect = null;
  }

  // Input -----------------------------------------------------------------------------

  /** Pointer position in the active view (in its tile when views are tiled). */
  local(e) {
    const r = this.overlay.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (this.tiled) {
      const t = this.tiles.find((x) => x.viewId === this.app.activeViewId);
      if (t) return { x: p.x - t.x, y: p.y - t.y };
    }
    return p;
  }

  /** With tiled views, pressing or scrolling in a tile makes its view active. */
  focusTileAt(e) {
    if (!this.tiled) return;
    const r = this.overlay.getBoundingClientRect();
    const t = this.tileAt(e.clientX - r.left, e.clientY - r.top);
    if (t && t.viewId !== this.app.activeViewId) this.app.activateView(t.viewId);
  }

  event(e, kind) {
    const { x, y } = this.local(e);
    const c = this.controller;
    return {
      kind,
      x,
      y,
      p: c?.screenToModel ? c.screenToModel(x, y) : null,
      button: e.button,
      buttons: e.buttons,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      pointerType: e.pointerType || 'mouse',
      detail: e.detail,
      original: e,
    };
  }

  bindInput() {
    const el = this.overlay;
    let pan = null;
    let gesture = null;
    let tapStart = null;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      // Focus explicitly; the default mousedown focus would otherwise take it
      // back from inputs a tool opens during this event.
      el.focus({ preventScroll: true });
      e.preventDefault();
      this.focusTileAt(e);
      const c = this.controller;
      if (!c) return;
      this.pointers.set(e.pointerId, this.local(e));
      el.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch' && this.pointers.size === 2) {
        // Two fingers: pan and zoom; cancel what the first finger started.
        this.app.tool?.cancelGesture?.();
        const pts = [...this.pointers.values()];
        gesture = { mid: midOf(pts), d: distOf(pts) };
        tapStart = null;
        return;
      }
      if (this.pointers.size > 2) return;
      const navOrbit = this.app.navMode === 'orbit' && c.orbit;
      const navPan = this.app.navMode === 'pan';
      if (e.button === 1 || (e.button === 0 && navPan) || (e.button === 0 && navOrbit) || (e.button === 2 && c.orbit && e.shiftKey)) {
        e.preventDefault();
        const orbit = (e.button === 1 && e.shiftKey && c.orbit) || navOrbit || (e.button === 2 && c.orbit);
        pan = { x: e.clientX, y: e.clientY, orbit, start: this.local(e) };
        c.beginNavigate?.(pan.start.x, pan.start.y, orbit);
        return;
      }
      if (e.pointerType === 'touch' && c.orbit && !this.app.toolNeedsTouch()) {
        // One finger orbits the 3D view.
        pan = { x: e.clientX, y: e.clientY, orbit: true, start: this.local(e), touch: true };
        tapStart = { ...this.local(e), t: performance.now() };
        c.beginNavigate?.(pan.start.x, pan.start.y, true);
        return;
      }
      if (e.button === 2) {
        this.app.contextMenu(this.event(e, 'context'));
        return;
      }
      tapStart = { ...this.local(e), t: performance.now() };
      this.app.toolEvent('down', this.event(e, 'down'));
    });
    el.addEventListener('pointermove', (e) => {
      const c = this.controller;
      if (!c) return;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, this.local(e));
      if (gesture && this.pointers.size >= 2) {
        const pts = [...this.pointers.values()];
        const m = midOf(pts);
        const d = distOf(pts);
        c.pan?.(m.x - gesture.mid.x, m.y - gesture.mid.y);
        if (gesture.d > 0 && d > 0) c.zoomAt?.(m.x, m.y, d / gesture.d);
        gesture = { mid: m, d };
        this.requestRender();
        return;
      }
      if (pan) {
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        pan.x = e.clientX;
        pan.y = e.clientY;
        if (pan.orbit) c.orbit(dx, dy);
        else c.pan(dx, dy);
        this.requestRender();
        return;
      }
      this.app.toolEvent('move', this.event(e, 'move'));
    });
    const end = (e) => {
      const c = this.controller;
      this.pointers.delete(e.pointerId);
      if (gesture) {
        if (this.pointers.size < 2) gesture = null;
        return;
      }
      if (pan) {
        const wasTouchTap = pan.touch && tapStart && Math.hypot(this.local(e).x - tapStart.x, this.local(e).y - tapStart.y) < 8 && performance.now() - tapStart.t < 400;
        pan = null;
        c?.endNavigate?.();
        this.app.viewChanged?.();
        if (wasTouchTap) {
          // A tap in a 3D view selects.
          const ev = this.event(e, 'down');
          this.app.toolEvent('down', ev);
          this.app.toolEvent('up', this.event(e, 'up'));
        }
        tapStart = null;
        return;
      }
      if (e.type === 'pointercancel') {
        this.app.tool?.cancelGesture?.();
        return;
      }
      this.app.toolEvent('up', this.event(e, 'up'));
      tapStart = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => this.app.toolEvent('leave', null));
    el.addEventListener('dblclick', (e) => {
      if (e.button !== 0) return;
      this.app.toolEvent('dblclick', this.event(e, 'dblclick'));
    });
    el.addEventListener(
      'wheel',
      (e) => {
        this.focusTileAt(e);
        const c = this.controller;
        if (!c?.zoomAt) return;
        e.preventDefault();
        const { x, y } = this.local(e);
        const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        // Two-finger trackpad scrolling pans; pinches (ctrl) and wheels zoom.
        const trackpadPan = !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5 && Math.abs(e.deltaY) < 50;
        if (trackpadPan && !this.app.settings.wheelZoomOnly) c.pan(-e.deltaX, -e.deltaY);
        else c.zoomAt(x, y, Math.exp((-e.deltaY * scale * (e.ctrlKey ? 0.01 : 0.0018))));
        this.requestRender();
        clearTimeout(this.wheelTimer);
        this.wheelTimer = setTimeout(() => this.app.viewChanged?.(), 250);
        this.app.toolEvent('move', this.event(e, 'move'));
      },
      { passive: false },
    );
  }
}

function midOf(pts) {
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
}

function distOf(pts) {
  return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
}
