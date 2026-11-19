// Dialog preview: a zoomable, pannable pane showing the filtered region at its
// real scale, plus a debounced full-resolution render that previews on the
// canvas and is reused when OK is pressed. Two worker lanes keep the pane
// responsive while the full render runs.
import type { RGBA8 } from '../../imaging/types';
import { TILE, tileKey, type TileGrid, type TileStore } from '../../model/tiles';
import { stackMargin } from './catalog';
import { Lane, isCancel } from './client';
import { ensureRect, filterContext, resultGrid, runFlags, sessionDoc, type Session } from './apply';
import type { StackEntry } from './stack';

export const zoomSteps = [1 / 16, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 8];
type PaneImage = { canvas: HTMLCanvasElement; img: RGBA8; level: number; x: number; y: number; sig: string };
export type PreviewUI = {
  pane: HTMLCanvasElement;
  progress: HTMLElement;
  zoomLabel?: HTMLElement;
  // Extra drawing over the pane (grid overlay), in pane pixels; `after` is
  // the span of pane columns showing the filtered result.
  // `origin` is the pane column of the result view's left edge.
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number, after: { x: number; width: number; origin: number }) => void;
  // Called with the pane's latest proxy image (histograms).
  onImage?: (img: RGBA8) => void;
  // Largest side of the reduced copy previewed for non-local filters.
  proxyLimit?: number;
  // Pause after the last change before the full-resolution render starts (ms).
  fullDelay?: number;
  // Slow renders of a whole-image preview drop to half the size while
  // settings keep changing, then refine once they pause.
  adaptive?: boolean;
  // A pane tool: return true from 'down' to take the drag instead of panning.
  tool?: (ev: PointerEvent, phase: 'down' | 'move' | 'up' | 'hover') => boolean | void;
};
/** What the pane shows: the result, the original, the two split down the
 * middle, or both side by side. */
export type ViewMode = 'after' | 'before' | 'split' | 'side';

/** Paint a tile grid into a pane image with box sampling (2x2 when reduced). */
function sampleGrid(store: TileStore, grid: TileGrid, ox: number, oy: number, zoom: number, out: ImageData, x0 = 0, x1 = out.width) {
  const { width: W, height: H, data } = out;
  const n = zoom < 1 ? 2 : 1;
  const c = grid.channels;
  let lastKey = '',
    tile: Uint8ClampedArray | undefined;
  const px = (dx: number, dy: number, acc: Float64Array) => {
    const gx = Math.floor(dx) - grid.x,
      gy = Math.floor(dy) - grid.y;
    const tx = Math.floor(gx / TILE),
      ty = Math.floor(gy / TILE);
    const key = tileKey(tx, ty);
    if (key !== lastKey) {
      lastKey = key;
      const id = grid.tiles[key];
      tile = id ? store.get(id) : undefined;
    }
    const lx = gx - tx * TILE,
      ly = gy - ty * TILE;
    if (c === 1) {
      const v = tile ? tile[ly * TILE + lx] : (grid.fill ?? 0);
      acc[0] += v * 255;
      acc[1] += v * 255;
      acc[2] += v * 255;
      acc[3] += 255;
      return;
    }
    if (!tile) return;
    const i = (ly * TILE + lx) * 4,
      a = tile[i + 3];
    acc[0] += tile[i] * a;
    acc[1] += tile[i + 1] * a;
    acc[2] += tile[i + 2] * a;
    acc[3] += a;
  };
  const acc = new Float64Array(4);
  for (let y = 0; y < H; y++)
    for (let x = x0; x < x1; x++) {
      acc.fill(0);
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) px(ox + (x + (sx + 0.5) / n) / zoom, oy + (y + (sy + 0.5) / n) / zoom, acc);
      const o = (y * W + x) * 4,
        a = acc[3];
      if (a <= 0) {
        data[o + 3] = 0;
        continue;
      }
      data[o] = acc[0] / a;
      data[o + 1] = acc[1] / a;
      data[o + 2] = acc[2] / a;
      data[o + 3] = a / (n * n);
    }
}
/** Draw the whole unfiltered region into `canvas`, resized to its aspect within the canvas size. */
export function regionThumbnail(s: Session, canvas: HTMLCanvasElement) {
  const R = s.rect;
  const z = Math.min(canvas.width / R.width, canvas.height / R.height);
  canvas.width = Math.max(1, Math.round(R.width * z));
  canvas.height = Math.max(1, Math.round(R.height * z));
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(canvas.width, canvas.height);
  sampleGrid(s.e.assets.tiles, s.base, R.x, R.y, z, out);
  ctx.putImageData(out, 0, 0);
}
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.save();
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = '#000a';
  ctx.fillRect(x, y, w, 18);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 6, y + 9.5);
  ctx.restore();
}
export function toCanvas(img: RGBA8) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export class FilterPreview {
  zoom = 1;
  focus = { x: 0, y: 0 };
  canvasPreview = true;
  viewMode: ViewMode = 'after';
  // Before/after split: the left part of the pane shows the unfiltered source.
  get split() {
    return this.viewMode === 'split';
  }
  set split(on: boolean) {
    this.viewMode = on ? 'split' : 'after';
  }
  private beforeCache?: { key: string; data: ImageData };
  private paneLane = new Lane('pane');
  private fullLane = new Lane('full');
  private entries: StackEntry[] = [];
  private sig = '';
  private paneImg?: PaneImage;
  private fullRes?: { sig: string; grid: TileGrid };
  // Tiles each full-resolution result added (beyond the source's), released
  // once the result is neither the latest nor shown on the canvas.
  private results = new Map<TileGrid, string[]>();
  private shown?: TileGrid;
  // The full-resolution render in progress, so OK can wait for it.
  private fullRun?: { sig: string; promise: Promise<TileGrid> };
  private fullTimer = 0;
  private paneBusy = false;
  private paneDirty = false;
  private coarse = false;
  private refineTimer = 0;
  private watchdog = 0;
  private disposed = false;
  private progressBusy = new Set<string>();
  constructor(
    readonly s: Session,
    private ui: PreviewUI,
  ) {
    this.focus = { x: s.rect.width / 2, y: s.rect.height / 2 };
    this.bindPane();
  }
  get local() {
    return stackMargin(this.entries) !== undefined;
  }
  get size() {
    return { w: this.ui.pane.width, h: this.ui.pane.height };
  }
  /** Pane size of one view (half the width side by side). */
  get viewSize() {
    const { w, h } = this.size;
    // Side by side leaves a gap between the two views.
    return { w: this.viewMode === 'side' ? Math.max(1, Math.floor((w - 8) / 2)) : w, h };
  }
  /** Resize the pane (workspaces that fill their window). */
  resize(w: number, h: number) {
    const pane = this.ui.pane;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (pane.width === w && pane.height === h) return;
    pane.width = w;
    pane.height = h;
    this.refreshView();
  }
  setViewMode(mode: ViewMode) {
    this.viewMode = mode;
    this.refreshView();
  }
  /** Region coordinates under a client point, and whether it is over the
   * result (false over the original's half or outside the image). */
  regionPoint(clientX: number, clientY: number) {
    const pane = this.ui.pane,
      r = pane.getBoundingClientRect();
    const px = ((clientX - r.left) * pane.width) / Math.max(1, r.width),
      py = ((clientY - r.top) * pane.height) / Math.max(1, r.height);
    const { w } = this.size,
      half = this.viewSize.w;
    let off = 0,
      after = this.viewMode !== 'before';
    if (this.viewMode === 'side') {
      if (px >= w - half) off = w - half;
      else after = false;
    } else if (this.viewMode === 'split' && px < Math.round(w / 2)) after = false;
    const v = this.viewRect();
    const x = v.x + (px - off) / this.zoom,
      y = v.y + py / this.zoom;
    const inside = x >= 0 && y >= 0 && x < this.s.rect.width && y < this.s.rect.height;
    return { x, y, after, inside };
  }
  fitZoom() {
    const { w, h } = this.viewSize;
    return Math.min(1, w / this.s.rect.width, h / this.s.rect.height);
  }
  setZoom(z: number) {
    this.zoom = Math.max(1 / 64, Math.min(16, z));
    if (this.ui.zoomLabel) this.ui.zoomLabel.textContent = `${Math.round(this.zoom * 1000) / 10}%`;
    this.refreshView();
  }
  stepZoom(dir: 1 | -1) {
    const z = this.zoom;
    const next = dir > 0 ? zoomSteps.find((s) => s > z + 1e-6) : [...zoomSteps].reverse().find((s) => s < z - 1e-6);
    this.setZoom(next ?? z);
  }
  /** Pane view in region coordinates (clamped so the image fills it if it can). */
  viewRect() {
    const { w, h } = this.viewSize;
    const vw = w / this.zoom,
      vh = h / this.zoom;
    const R = this.s.rect;
    const x = vw >= R.width ? (R.width - vw) / 2 : Math.max(0, Math.min(R.width - vw, this.focus.x - vw / 2));
    const y = vh >= R.height ? (R.height - vh) / 2 : Math.max(0, Math.min(R.height - vh, this.focus.y - vh / 2));
    this.focus = { x: x + vw / 2, y: y + vh / 2 };
    return { x, y, width: vw, height: vh };
  }
  private levelDims(k: number) {
    let w = this.s.rect.width,
      h = this.s.rect.height;
    for (let i = 0; i < k; i++) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
    return { w, h };
  }
  private proxyLevel() {
    let k = 0;
    while (k < 12) {
      const d = this.levelDims(k);
      if (Math.max(d.w, d.h) <= (this.ui.proxyLimit ?? 1200)) break;
      k++;
    }
    return k;
  }
  setEntries(entries: StackEntry[]) {
    const old = { ...this.s.rect };
    if (ensureRect(this.s, entries)) {
      this.focus = { x: this.focus.x + old.x - this.s.rect.x, y: this.focus.y + old.y - this.s.rect.y };
      this.fullRes = undefined;
      this.paneImg = undefined;
    }
    this.entries = entries;
    this.sig = JSON.stringify(entries);
    if (this.ui.adaptive) {
      clearTimeout(this.refineTimer);
      this.refineTimer = window.setTimeout(() => {
        if (!this.coarse) return;
        this.coarse = false;
        this.schedulePane(true);
      }, 280);
    }
    this.schedulePane();
    this.scheduleFull();
    this.draw();
  }
  setCanvasPreview(on: boolean) {
    this.canvasPreview = on;
    if (on) {
      if (this.fullRes?.sig === this.sig) this.show(this.fullRes.grid);
      else this.scheduleFull(0);
    } else {
      delete this.s.e.settings.quickMaskPreview;
      this.s.e.preview(this.s.e.doc);
      this.shown = undefined;
      this.release();
    }
  }
  private refreshView() {
    if (this.local && this.fullRes?.sig !== this.sig) this.schedulePane();
    this.draw();
  }
  // ----- Pane -----
  private bindPane() {
    const pane = this.ui.pane;
    let drag: { x: number; y: number; fx: number; fy: number } | undefined;
    let toolDrag = false;
    pane.addEventListener('pointerdown', (ev) => {
      pane.setPointerCapture(ev.pointerId);
      if (this.ui.tool?.(ev, 'down')) {
        toolDrag = true;
        return;
      }
      drag = { x: ev.clientX, y: ev.clientY, fx: this.focus.x, fy: this.focus.y };
      pane.classList.add('dragging');
    });
    pane.addEventListener('pointermove', (ev) => {
      if (toolDrag) {
        this.ui.tool?.(ev, 'move');
        return;
      }
      if (!drag) {
        this.ui.tool?.(ev, 'hover');
        return;
      }
      const k = pane.width / pane.getBoundingClientRect().width;
      this.focus = { x: drag.fx - ((ev.clientX - drag.x) * k) / this.zoom, y: drag.fy - ((ev.clientY - drag.y) * k) / this.zoom };
      this.draw();
    });
    const end = (ev: PointerEvent) => {
      if (toolDrag) {
        toolDrag = false;
        this.ui.tool?.(ev, 'up');
        return;
      }
      if (!drag) return;
      drag = undefined;
      pane.classList.remove('dragging');
      this.refreshView();
    };
    pane.addEventListener('pointerup', end);
    pane.addEventListener('pointercancel', end);
    pane.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) return;
        ev.preventDefault();
        this.stepZoom(ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }
  private schedulePane(refine = false) {
    if (this.disposed || (this.fullRes?.sig === this.sig && this.fullRes)) return;
    // Refining: the latest settings were only rendered at the coarse size.
    if (refine && this.paneImg?.sig === this.sig && this.paneImg.level <= this.proxyLevel()) return;
    if (this.paneBusy) {
      this.paneDirty = true;
      return;
    }
    void this.runPane();
  }
  private async runPane() {
    this.paneBusy = true;
    this.paneDirty = false;
    const sig = this.sig,
      entries = this.entries;
    const v = this.viewRect();
    let k: number, x0: number, y0: number, x1: number, y1: number;
    if (this.local) {
      k = this.zoom >= 1 ? 0 : Math.min(this.proxyLevel() + 2, Math.floor(Math.log2(1 / this.zoom) + 1e-9));
      const f = 2 ** -k,
        d = this.levelDims(k),
        m = stackMargin(entries, f) ?? 0;
      x0 = Math.max(0, Math.floor(v.x * f) - m);
      y0 = Math.max(0, Math.floor(v.y * f) - m);
      x1 = Math.min(d.w, Math.ceil((v.x + v.width) * f) + m);
      y1 = Math.min(d.h, Math.ceil((v.y + v.height) * f) + m);
    } else {
      k = this.proxyLevel();
      if (this.coarse && Math.max(this.levelDims(k + 1).w, this.levelDims(k + 1).h) >= 256) k++;
      const d = this.levelDims(k);
      [x0, y0, x1, y1] = [0, 0, d.w, d.h];
    }
    const view = { level: k, x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
    clearTimeout(this.watchdog);
    // Slow pane renders show progress; superseded ones are abandoned.
    this.watchdog = window.setTimeout(() => {
      if (this.paneDirty) this.paneLane.cancel();
      else {
        this.progressBusy.add('pane');
        this.showProgress(0);
      }
    }, 600);
    const t0 = performance.now();
    try {
      const res = await this.paneLane.run(
        { type: 'run', job: 0, key: this.s.key, filters: entries, ctx: filterContext(this.s.e, this.s), ...runFlags(this.s), view, output: 'image' },
        [this.s.key],
        (f) => this.progressBusy.has('pane') && this.showProgress(f),
      );
      if (this.disposed) return;
      // Changes arrived during a slow render: keep up at the coarse size.
      if (this.ui.adaptive && !this.local && this.paneDirty && performance.now() - t0 > 120) this.coarse = true;
      this.paneImg = { canvas: toCanvas(res.image!), img: res.image!, level: k, x: view.x, y: view.y, sig };
      if (sig === this.sig) this.ui.onImage?.(res.image!);
      this.draw();
    } catch (error) {
      if (!isCancel(error)) this.s.e.message(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(this.watchdog);
      this.progressBusy.delete('pane');
      this.hideProgress();
      this.paneBusy = false;
      if (this.paneDirty && !this.disposed) this.schedulePane();
    }
  }
  draw() {
    if (this.disposed) return;
    const pane = this.ui.pane;
    const ctx = pane.getContext('2d')!;
    const { w, h } = this.size;
    const v = this.viewRect();
    ctx.clearRect(0, 0, w, h);
    const R = this.s.rect;
    const mode = this.viewMode;
    // Pane columns of the result [ax, w) and of the original [0, bx), and
    // where each view's left edge sits.
    const half = this.viewSize.w;
    let ax = 0,
      aOff = 0,
      bx = 0;
    if (mode === 'split') ax = bx = Math.round(w / 2);
    else if (mode === 'side') {
      ax = aOff = w - half;
      bx = half;
    } else if (mode === 'before') {
      ax = w;
      bx = w;
    }
    if (ax < w) this.drawAfter(ctx, v, ax, aOff, w, h);
    if (bx > 0) {
      const key = `${mode},${w},${h},${this.zoom},${v.x},${v.y}`;
      if (this.beforeCache?.key !== key) {
        const out = ctx.createImageData(w, h);
        sampleGrid(this.s.e.assets.tiles, this.s.base, R.x + v.x, R.y + v.y, this.zoom, out, 0, bx);
        this.beforeCache = { key, data: out };
      }
      ctx.putImageData(this.beforeCache.data, 0, 0, 0, 0, bx, h);
    }
    if (mode === 'split') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(bx - 0.5, 0, 1, h);
    }
    if (mode === 'split' || mode === 'side') {
      label(ctx, 'Before', 8, 8);
      label(ctx, 'After', ax + 8, 8);
    }
    this.ui.overlay?.(ctx, w, h, { x: ax, width: w - ax, origin: aOff });
  }
  /** The filtered result in pane columns [x0, x1), its view's left edge at `off`. */
  private drawAfter(ctx: CanvasRenderingContext2D, v: { x: number; y: number }, x0: number, off: number, x1: number, h: number) {
    const R = this.s.rect;
    if (this.fullRes?.sig === this.sig) {
      const out = ctx.createImageData(x1, h);
      sampleGrid(this.s.e.assets.tiles, this.fullRes.grid, R.x + v.x - off / this.zoom, R.y + v.y, this.zoom, out, x0, x1);
      ctx.putImageData(out, 0, 0, x0, 0, x1 - x0, h);
    } else if (this.paneImg) {
      const p = this.paneImg,
        f = 2 ** p.level;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, h);
      ctx.clip();
      ctx.imageSmoothingEnabled = !(p.level === 0 && this.zoom >= 1);
      ctx.drawImage(p.canvas, off + (p.x * f - v.x) * this.zoom, (p.y * f - v.y) * this.zoom, p.img.width * f * this.zoom, p.img.height * f * this.zoom);
      ctx.restore();
    }
  }
  // ----- Full resolution -----
  private scheduleFull(delay = this.ui.fullDelay ?? 350) {
    clearTimeout(this.fullTimer);
    if (this.disposed || this.fullRes?.sig === this.sig || this.fullRun?.sig === this.sig) return;
    if (!this.canvasPreview && this.local) return;
    this.fullTimer = window.setTimeout(() => void this.runFull().catch(() => undefined), delay);
  }
  private runFull(): Promise<TileGrid> {
    const sig = this.sig;
    const promise = this.renderFull(sig);
    this.fullRun = { sig, promise };
    const done = () => {
      if (this.fullRun?.promise === promise) this.fullRun = undefined;
    };
    promise.then(done, done);
    return promise;
  }
  private async renderFull(sig: string): Promise<TileGrid> {
    this.progressBusy.add('full');
    this.showProgress(0);
    try {
      const res = await this.fullLane.run(
        { type: 'run', job: 0, key: this.s.key, filters: this.entries, ctx: filterContext(this.s.e, this.s), ...runFlags(this.s), output: 'tiles' },
        [this.s.key],
        (f) => this.showProgress(f),
      );
      const grid = resultGrid(this.s, res.tiles!);
      if (this.disposed) return grid;
      const base = new Set(Object.values(this.s.base.tiles));
      this.results.set(
        grid,
        Object.values(grid.tiles).filter((id) => !base.has(id)),
      );
      this.fullRes = { sig, grid };
      if (sig === this.sig) {
        if (this.canvasPreview) this.show(grid);
        this.draw();
      }
      this.release();
      return grid;
    } catch (error) {
      if (!isCancel(error)) this.s.e.message(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.progressBusy.delete('full');
      this.hideProgress();
    }
  }
  /** The full-resolution result for the current settings. */
  async finish(): Promise<TileGrid> {
    clearTimeout(this.fullTimer);
    if (this.fullRes?.sig === this.sig) return this.fullRes.grid;
    // A render of these settings is already running: wait for it rather
    // than cancelling it and starting over.
    if (this.fullRun?.sig === this.sig) return this.fullRun.promise;
    return this.runFull();
  }
  cancel() {
    clearTimeout(this.fullTimer);
    this.fullLane.cancel();
    this.paneLane.cancel();
  }
  private showProgress(f: number) {
    const el = this.ui.progress;
    el.hidden = false;
    el.querySelector('progress')?.setAttribute('value', String(f));
  }
  private hideProgress() {
    if (!this.progressBusy.size) this.ui.progress.hidden = true;
  }
  private show(grid: TileGrid) {
    this.s.e.preview(sessionDoc(this.s, grid));
    this.shown = grid;
  }
  /** Free the tiles of results that are no longer the latest or shown, once
   * a render of them still in progress has finished. `keep` is the result
   * to hold on to (all others go). */
  private release(
    keep: (grid: TileGrid) => boolean = (g) => g === this.fullRes?.grid || g === this.shown,
  ) {
    const ids: string[] = [];
    for (const [grid, created] of this.results)
      if (!keep(grid)) {
        ids.push(...created);
        this.results.delete(grid);
      }
    if (!ids.length) return;
    const store = this.s.e.assets.tiles;
    const done = () => {
      for (const id of ids) store.delete(id);
    };
    const r = this.s.e.renderer;
    if (r) void r.settle().then(() => requestAnimationFrame(() => void r.settle().then(done)));
    else done();
  }
  /** Stop rendering. A cancelled preview frees its results' tiles; an applied
   * one keeps the latest result, which OK commits. */
  dispose(applied = false) {
    if (!this.disposed) {
      const latest = applied ? this.fullRes?.grid : undefined;
      this.release((g) => g === latest);
    }
    this.disposed = true;
    clearTimeout(this.fullTimer);
    clearTimeout(this.refineTimer);
    clearTimeout(this.watchdog);
    this.paneLane.dispose();
    this.fullLane.dispose();
  }
}
