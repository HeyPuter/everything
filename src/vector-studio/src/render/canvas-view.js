/**
 * CanvasView: the document canvas for one editor.
 *
 * Two stacked canvases: `art` holds the pasteboard, artboards and artwork
 * and only redraws when the document or view changes; `overlay` holds
 * selection, anchors, guides, alignment guides and tool feedback and redraws on
 * pointer moves without touching the artwork. Redraws are coalesced into
 * one requestAnimationFrame.
 *
 * Pan/zoom fast path: when a full artwork render takes longer than a frame,
 * continuous view changes (wheel, pinch, Hand tool) composite the last
 * rendered bitmap with the view delta and schedule a crisp re-render once
 * the gesture settles.
 */
import { drawArtwork, drawNode, LayerPool, imageEvents } from './draw.js';
import { drawOverlay } from './overlay.js';
import { multiply, invert } from '../lib/matrix.js';
import { liveDef } from '../model/live.js';

const SETTLE_MS = 140;

/**
 * View-only extension points for feature modules (exports never see them):
 *   artOptions   [(editor, opts) -> opts]   adjust the drawArtwork options
 *                                           (layer filters for modes that show part of the document)
 *   clipArt      [(editor) -> Path2D|null]  clip the artwork (document space), e.g. to the artboards
 *   afterArt     [(ctx, editor, view, opts)] draw above the artwork in document space on full renders
 *                                           (previews such as pattern tile copies)
 *   dimIsolation [(editor) -> bool]         false skips fading the artwork outside isolation mode
 *   postArt      [(ctx, editor, view) -> void] rework the finished art canvas in device pixels
 *                                           (separation and proof previews)
 */
export const viewHooks = { artOptions: [], clipArt: [], afterArt: [], dimIsolation: [], postArt: [] };

/** The bleed area around an artboard (bleed: number or { top, bottom, left, right }), or null without bleed. */
export function bleedRect(a, bleed) {
  const b = typeof bleed === 'number' ? { top: bleed, bottom: bleed, left: bleed, right: bleed } : bleed || {};
  const v = (k) => (Number.isFinite(b[k]) && b[k] > 0 ? b[k] : 0);
  const [t, bo, l, r] = [v('top'), v('bottom'), v('left'), v('right')];
  if (!t && !bo && !l && !r) return null;
  return { x: a.x - l, y: a.y - t, w: a.w + l + r, h: a.h + t + bo };
}

export class CanvasView {
  constructor(host, editor, { theme }) {
    this.host = host;
    this.editor = editor;
    this.theme = theme;
    this.art = document.createElement('canvas');
    this.art.className = 'canvas-art';
    this.art.setAttribute('aria-hidden', 'true');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'canvas-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    host.append(this.art, this.overlay);
    this.actx = this.art.getContext('2d', { alpha: false });
    this.octx = this.overlay.getContext('2d');
    this.layerPool = new LayerPool(1, 1);
    this.artDirty = true;
    this.overlayDirty = true;
    this.frame = 0;
    this.lastRenderMs = 0;
    this.snapshot = null; // { canvas, matrix }
    this.settleTimer = 0;
    this.fastMode = false;
    this.skip = null; // ids not drawn on the art canvas (e.g. text being edited)
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.unsubs = [
      editor.on('doc-change', () => this.invalidate()),
      editor.on('invalidate', () => this.invalidate()),
      editor.on('view', () => this.viewChanged()),
      editor.on('selection', () => this.invalidateOverlay()),
      editor.on('overlay', () => this.invalidateOverlay()),
      editor.on('view-options', () => this.invalidate()),
    ];
    imageEvents.onReady = () => this.invalidate();
    this.resize();
  }

  destroy() {
    this.ro.disconnect();
    for (const u of this.unsubs) u();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.settleTimer);
    this.art.remove();
    this.overlay.remove();
  }

  resize() {
    const rect = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const view = this.editor.view;
    const first = !this.editor.viewInitialized;
    if (view.width === w && view.height === h && view.dpr === dpr && !first) return;
    // Keep the document point at the center fixed while the canvas resizes.
    const center = view.width > 1 ? view.toDoc(view.width / 2, view.height / 2) : null;
    view.set({ width: w, height: h, dpr });
    for (const c of [this.art, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    this.layerPool.resize(this.art.width, this.art.height);
    if (first && w > 10 && h > 10) {
      this.editor.viewInitialized = true;
      this.editor.fitArtboard();
    } else if (center) view.centerOn(center.x, center.y);
    this.snapshot = null;
    this.invalidate();
    // Rulers and other view-dependent chrome follow the new size.
    this.editor.viewChanged();
  }

  /** Re-read theme colors (theme switch, document preferences). */
  refreshColors() {
    this.colorCache = null;
    this.invalidate();
  }

  invalidate() {
    this.artDirty = true;
    this.overlayDirty = true;
    this.#schedule();
  }

  invalidateOverlay() {
    this.overlayDirty = true;
    this.#schedule();
  }

  /** View moved: use the bitmap fast path when full renders are slow. */
  viewChanged() {
    this.overlayDirty = true;
    if (this.lastRenderMs > 14 && this.snapshot) {
      this.fastMode = true;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.fastMode = false;
        this.invalidate();
      }, SETTLE_MS);
    } else this.artDirty = true;
    this.#schedule();
  }

  #schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderNow();
    });
  }

  renderNow() {
    if (this.fastMode && this.snapshot) this.#drawFast();
    else if (this.artDirty) this.#drawArt();
    if (this.overlayDirty || this.fastMode) this.#drawOverlay();
    this.artDirty = false;
    this.overlayDirty = false;
  }

  colors() {
    const cs = getComputedStyle(this.host);
    return {
      pasteboard: cs.getPropertyValue('--pasteboard').trim() || '#535353',
      artboardBorder: cs.getPropertyValue('--artboard-border').trim() || '#000000',
      artboardLabel: cs.getPropertyValue('--artboard-label').trim() || '#bbbbbb',
      selection: cs.getPropertyValue('--selection-color').trim() || '#4f80ff',
      guide: cs.getPropertyValue('--guide-color').trim() || '#4ad5ff',
      alignment: cs.getPropertyValue('--alignment-guide-color').trim() || '#ff3fbf',
      grid: cs.getPropertyValue('--grid-color').trim() || 'rgba(128,128,128,0.35)',
      guideDots: cs.getPropertyValue('--guide-style').trim() === 'dots',
      bleed: cs.getPropertyValue('--danger').trim() || '#e5484d',
    };
  }

  #drawArt() {
    const t0 = performance.now();
    const { editor } = this;
    const { view, doc } = editor;
    // Theme colors are read once per theme change: getComputedStyle every frame forces style recalculation.
    if (!this.colorCache) this.colorCache = this.colors();
    const opts = editor.viewOptions;
    // While a drag edits a few objects inside an open transaction, keep the
    // unchanged artwork below and above them as bitmaps and redraw only the
    // objects in between: dragging stays cheap in very large documents.
    if (editor.dragPreview && !opts.pixelPreview && this.#drawDragPreview(editor.dragPreview)) {
      this.#postArt();
      this.lastRenderMs = performance.now() - t0;
      return;
    }
    this.previewCache = null;
    if (doc.tx && this.slowScene && !opts.pixelPreview && this.#drawInteraction(doc.tx)) {
      this.#postArt();
      this.lastRenderMs = performance.now() - t0;
      return;
    }
    this.interaction = null;
    this.#paint(this.actx, { background: true, borders: true });
    if (editor.isolation && doc.has(editor.isolation) && viewHooks.dimIsolation.every((f) => f(editor) !== false)) this.#dimOutsideIsolation();
    if (opts.pixelPreview) drawPixelPreview(this.actx, this.art, view);
    this.#postArt();
    this.lastRenderMs = performance.now() - t0;
    this.slowScene = this.lastRenderMs > 8;
    this.#captureSnapshot();
  }

  #postArt() {
    for (const f of viewHooks.postArt) {
      this.actx.save();
      f(this.actx, this.editor, this.editor.view);
      this.actx.restore();
    }
  }

  /** Isolation mode: fade everything, then redraw the isolated group at full strength. */
  #dimOutsideIsolation() {
    const { view, doc, isolation } = this.editor;
    const ctx = this.actx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(0, 0, this.art.width, this.art.height);
    const dpr = view.dpr;
    const m = multiply([dpr, 0, 0, dpr, 0, 0], view.matrix);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    drawNode(ctx, doc, doc.get(isolation), {
      viewRect: view.visibleRect(4),
      outline: this.editor.viewOptions.mode === 'outline',
      hairline: 1 / view.zoom,
      outlineColor: '#000000',
      scale: view.zoom * dpr,
      layerPool: this.layerPool,
      skip: this.skip,
    });
    ctx.restore();
  }

  /** Paint the scene (or a slice of it) into a context with the view transform. */
  #paint(ctx, { background = false, borders = false, leafFilter = null, clear = true } = {}) {
    const { editor } = this;
    const { view, doc } = editor;
    const dpr = view.dpr;
    const colors = this.colorCache;
    const opts = editor.viewOptions;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (background) {
      ctx.fillStyle = colors.pasteboard;
      ctx.fillRect(0, 0, this.art.width, this.art.height);
    } else if (clear) ctx.clearRect(0, 0, this.art.width, this.art.height);
    const m = multiply([dpr, 0, 0, dpr, 0, 0], view.matrix);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (background && opts.artboards) {
      const tg = doc.root.transparencyGrid;
      for (const a of doc.artboards) {
        if (opts.transparencyGrid) drawChecker(ctx, a, view.zoom, tg);
        else {
          ctx.fillStyle = tg?.simulatePaper ? tg.color1 || '#ffffff' : '#ffffff';
          ctx.fillRect(a.x, a.y, a.w, a.h);
        }
      }
    }
    if (background && opts.grid && !opts.gridInFront) drawGrid(ctx, editor, colors);
    let artOpts = {
      viewRect: view.visibleRect(4),
      outline: opts.mode === 'outline',
      hairline: 1 / view.zoom,
      outlineColor: '#000000',
      scale: view.zoom * dpr,
      layerPool: this.layerPool,
      skip: this.skip,
      leafFilter,
      imagesInOutline: Boolean(doc.root.showImagesInOutline),
    };
    for (const f of viewHooks.artOptions) artOpts = f(editor, artOpts) || artOpts;
    const clip = viewHooks.clipArt.map((f) => f(editor)).find(Boolean);
    if (clip) {
      ctx.save();
      ctx.clip(clip);
    }
    drawArtwork(ctx, doc, artOpts);
    if (!leafFilter) for (const f of viewHooks.afterArt) f(ctx, editor, view, artOpts);
    if (clip) ctx.restore();
    if (borders && opts.grid && opts.gridInFront) drawGrid(ctx, editor, colors);
    // Artboard borders on top so artwork bleeding off the edge stays readable.
    if (borders && opts.artboards) {
      ctx.lineWidth = 1 / view.zoom;
      ctx.strokeStyle = colors.artboardBorder;
      ctx.setLineDash([]);
      for (const a of doc.artboards) ctx.strokeRect(a.x, a.y, a.w, a.h);
      // The document bleed shows as a red guide outside every artboard.
      ctx.strokeStyle = colors.bleed;
      for (const a of doc.artboards) {
        const r = bleedRect(a, doc.root.bleed);
        if (r) ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
    }
  }

  #layerCanvas(key) {
    let c = this.interactionCanvases?.[key];
    if (!c || c.width !== this.art.width || c.height !== this.art.height) {
      // Regular canvases stay GPU-backed, so blitting them each frame is cheap.
      c = Object.assign(document.createElement('canvas'), { width: this.art.width, height: this.art.height });
      this.interactionCanvases = { ...(this.interactionCanvases || {}), [key]: c };
    }
    return c;
  }

  /**
   * Large-selection drags: the static artwork below and above the moving
   * objects and the moving objects themselves are rendered once into
   * bitmaps; each frame composites them, transforming the moving bitmap by
   * the drag matrix. The real geometry is written on release.
   */
  #drawDragPreview(pv) {
    const { doc, view } = this.editor;
    let cache = this.previewCache;
    const valid = cache && cache.session === pv.session && cache.size === pv.ids.size && cache.width === this.art.width && cache.height === this.art.height && matEq(cache.matrix, view.matrix);
    if (!valid) {
      const order = doc.paintOrder();
      const moving = pv.ids;
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of moving.values()) {
        if (n.type !== 'path' && n.type !== 'compound' && n.type !== 'text' && n.type !== 'image') continue;
        const o = order.get(n.id);
        if (o == null) continue;
        lo = Math.min(lo, o);
        hi = Math.max(hi, o);
      }
      if (!Number.isFinite(lo)) return false;
      const isMoving = (id) => moving.has(id) || moving.has(doc.get(id)?.parent);
      const below = this.#layerCanvas('pv-below');
      const above = this.#layerCanvas('pv-above');
      const mov = this.#layerCanvas('pv-moving');
      this.#paint(below.getContext('2d'), { background: true, leafFilter: (id) => !isMoving(id) && (order.get(id) ?? 0) < lo });
      this.#paint(above.getContext('2d'), { borders: true, leafFilter: (id) => !isMoving(id) && (order.get(id) ?? 0) > hi });
      this.#paint(mov.getContext('2d'), { leafFilter: (id) => isMoving(id) });
      cache = this.previewCache = { session: pv.session, size: pv.ids.size, width: this.art.width, height: this.art.height, matrix: view.matrix.slice(), order, lo, hi, below, above, mov, isMoving };
    }
    const ctx = this.actx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cache.below, 0, 0);
    // Static objects stacked between the moving ones still draw live.
    if (cache.hi > cache.lo) {
      this.#paint(ctx, { clear: false, leafFilter: (id) => {
        if (cache.isMoving(id)) return false;
        const o = cache.order.get(id);
        return o != null && o > cache.lo && o < cache.hi;
      } });
    }
    // Device transform of the drag: D * M * D^-1, D = dpr * view.
    const dpr = view.dpr;
    const D = multiply([dpr, 0, 0, dpr, 0, 0], view.matrix);
    const T = multiply(D, multiply(pv.matrix, invert(D)));
    ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cache.mov, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cache.above, 0, 0);
    return true;
  }

  /** Returns false when the interaction cannot use the split cache. */
  #drawInteraction(tx) {
    const { doc, view } = this.editor;
    let cache = this.interaction;
    const valid = cache && cache.tx === tx && cache.size === tx.changed.size && cache.width === this.art.width && cache.height === this.art.height && matEq(cache.matrix, view.matrix);
    if (!valid) {
      const order = doc.paintOrder();
      let lo = Infinity;
      let hi = -Infinity;
      for (const id of tx.changed) {
        let n = doc.get(id);
        if (!n || n.type === 'layer' || n.type === 'root' || n.type === 'group') continue;
        // Text wrap objects and threaded frames re-flow type elsewhere in the stack: no split.
        if (n.textWrap || n.threadNext || n.threadPrev) return false;
        const parent = n.parent ? doc.get(n.parent) : null;
        if (parent?.type === 'compound') n = parent;
        // Isolated ancestors (opacity, blending, effects, clipping) composite as a unit: no split.
        for (const a of doc.ancestors(n.id)) {
          if ((a.opacity ?? 1) < 1 || (a.blendMode && a.blendMode !== 'normal') || a.effects?.length || a.clip) return false;
          // Live artwork made from a changing object redraws with it.
          if (liveDef(a) && order.has(a.id)) lo = Math.min(lo, order.get(a.id));
        }
        const o = order.get(n.id);
        if (o == null) continue;
        lo = Math.min(lo, o);
        hi = Math.max(hi, o);
      }
      if (!Number.isFinite(lo)) return false;
      const below = this.#layerCanvas('below');
      const above = this.#layerCanvas('above');
      this.#paint(below.getContext('2d'), { background: true, leafFilter: (id) => (order.get(id) ?? 0) < lo });
      this.#paint(above.getContext('2d'), { borders: true, leafFilter: (id) => (order.get(id) ?? 0) > hi });
      cache = this.interaction = { tx, size: tx.changed.size, width: this.art.width, height: this.art.height, matrix: view.matrix.slice(), order, lo, hi, below, above };
    }
    const ctx = this.actx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cache.below, 0, 0);
    this.#paint(ctx, { clear: false, leafFilter: (id) => {
      const o = cache.order.get(id);
      // Nodes created during the drag are not in the order map: draw them live.
      return o == null || (o >= cache.lo && o <= cache.hi);
    } });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cache.above, 0, 0);
    return true;
  }

  #captureSnapshot() {
    if (this.lastRenderMs <= 14) {
      this.snapshot = null;
      return;
    }
    let snap = this.snapshot?.canvas;
    if (!snap || snap.width !== this.art.width || snap.height !== this.art.height) {
      snap = document.createElement('canvas');
      snap.width = this.art.width;
      snap.height = this.art.height;
    }
    snap.getContext('2d').drawImage(this.art, 0, 0);
    this.snapshot = { canvas: snap, matrix: this.editor.view.matrix.slice() };
  }

  #drawFast() {
    const ctx = this.actx;
    const view = this.editor.view;
    const dpr = view.dpr;
    const delta = multiply(view.matrix, invert(this.snapshot.matrix));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.colorCache?.pasteboard || '#535353';
    ctx.fillRect(0, 0, this.art.width, this.art.height);
    const m = multiply([dpr, 0, 0, dpr, 0, 0], multiply(delta, [1 / dpr, 0, 0, 1 / dpr, 0, 0]));
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(this.snapshot.canvas, 0, 0);
  }

  #drawOverlay() {
    const ctx = this.octx;
    const view = this.editor.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawOverlay(ctx, this.editor, this.colorCache || this.colors());
  }
}

function drawChecker(ctx, a, zoom, tg = null) {
  const size = (tg?.size || 8) / zoom;
  ctx.save();
  ctx.beginPath();
  ctx.rect(a.x, a.y, a.w, a.h);
  ctx.clip();
  ctx.fillStyle = tg?.color1 || '#ffffff';
  ctx.fillRect(a.x, a.y, a.w, a.h);
  ctx.fillStyle = tg?.color2 || '#d9d9d9';
  const cols = Math.ceil(a.w / size);
  const rows = Math.ceil(a.h / size);
  if (cols * rows < 200000) {
    for (let j = 0; j < rows; j++) for (let i = j % 2; i < cols; i += 2) ctx.fillRect(a.x + i * size, a.y + j * size, size, size);
  }
  ctx.restore();
}

function drawGrid(ctx, editor, colors) {
  const { view, doc } = editor;
  const grid = doc.root.grid || { spacing: 72, subdivisions: 8 };
  const r = view.visibleRect(0);
  let step = grid.spacing / grid.subdivisions;
  // Thin out subdivisions when they would be denser than 6 px apart.
  while (step * view.zoom < 6) step *= 2;
  const major = grid.spacing;
  ctx.save();
  ctx.lineWidth = 1 / view.zoom;
  const x0 = Math.floor(r.x / step) * step;
  const y0 = Math.floor(r.y / step) * step;
  if (editor.prefs?.get('gridStyle') === 'dots') {
    // Dots at the gridline crossings (larger on major lines).
    const px = 1 / view.zoom;
    ctx.fillStyle = colors.grid;
    for (let x = x0; x <= r.x + r.w; x += step) {
      const mx = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      for (let y = y0; y <= r.y + r.h; y += step) {
        const big = mx && Math.abs(y / major - Math.round(y / major)) < 1e-6;
        const d = (big ? 3 : 1.5) * px;
        ctx.fillRect(x - d / 2, y - d / 2, d, d);
      }
    }
    ctx.restore();
    return;
  }
  for (const pass of ['minor', 'major']) {
    ctx.beginPath();
    for (let x = x0; x <= r.x + r.w; x += step) {
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      if ((pass === 'major') !== isMajor) continue;
      ctx.moveTo(x, r.y);
      ctx.lineTo(x, r.y + r.h);
    }
    for (let y = y0; y <= r.y + r.h; y += step) {
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
      if ((pass === 'major') !== isMajor) continue;
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
    }
    ctx.strokeStyle = colors.grid;
    ctx.globalAlpha = pass === 'major' ? 1 : 0.45;
    ctx.stroke();
  }
  ctx.restore();
}

/** Pixel Preview: re-render the canvas through a 72-ppi pixel grid at the current zoom. */
function drawPixelPreview(ctx, canvas, view) {
  if (view.zoom <= 1) return;
  const w = Math.ceil(canvas.width / (view.zoom * view.dpr));
  const h = Math.ceil(canvas.height / (view.zoom * view.dpr));
  const tmp = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const t = tmp.getContext('2d');
  t.imageSmoothingQuality = 'high';
  t.drawImage(canvas, 0, 0, w, h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w, h, 0, 0, w * view.zoom * view.dpr, h * view.zoom * view.dpr);
  ctx.restore();
}

function matEq(a, b) {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}
