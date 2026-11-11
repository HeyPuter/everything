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
  // Extra drawing over the pane (grid overlay), in pane pixels.
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  // Called with the pane's latest proxy image (histograms).
  onImage?: (img: RGBA8) => void;
};

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
  // Before/after split: the left part of the pane shows the unfiltered source.
  split = false;
  private paneLane = new Lane('pane');
  private fullLane = new Lane('full');
  private entries: StackEntry[] = [];
  private sig = '';
  private paneImg?: PaneImage;
  private fullRes?: { sig: string; grid: TileGrid };
  // The full-resolution render in progress, so OK can wait for it.
  private fullRun?: { sig: string; promise: Promise<TileGrid> };
  private fullTimer = 0;
  private paneBusy = false;
  private paneDirty = false;
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
  fitZoom() {
    const { w, h } = this.size;
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
    const { w, h } = this.size;
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
      if (Math.max(d.w, d.h) <= 1200) break;
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
    this.schedulePane();
    this.scheduleFull();
    this.draw();
  }
  setCanvasPreview(on: boolean) {
    this.canvasPreview = on;
    if (on) {
      if (this.fullRes?.sig === this.sig) this.s.e.preview(sessionDoc(this.s, this.fullRes.grid));
      else this.scheduleFull(0);
    } else {
      delete this.s.e.settings.quickMaskPreview;
      this.s.e.preview(this.s.e.doc);
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
    pane.addEventListener('pointerdown', (ev) => {
      pane.setPointerCapture(ev.pointerId);
      drag = { x: ev.clientX, y: ev.clientY, fx: this.focus.x, fy: this.focus.y };
      pane.classList.add('dragging');
    });
    pane.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const k = pane.width / pane.getBoundingClientRect().width;
      this.focus = { x: drag.fx - ((ev.clientX - drag.x) * k) / this.zoom, y: drag.fy - ((ev.clientY - drag.y) * k) / this.zoom };
      this.draw();
    });
    const end = () => {
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
  private schedulePane() {
    if (this.disposed || (this.fullRes?.sig === this.sig && this.fullRes)) return;
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
    try {
      const res = await this.paneLane.run(
        { type: 'run', job: 0, key: this.s.key, filters: entries, ctx: filterContext(this.s.e, this.s), ...runFlags(this.s), view, output: 'image' },
        [this.s.key],
        (f) => this.progressBusy.has('pane') && this.showProgress(f),
      );
      if (this.disposed) return;
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
    const store = this.s.e.assets.tiles;
    const R = this.s.rect;
    const splitX = this.split ? Math.round(w / 2) : 0;
    if (this.fullRes?.sig === this.sig) {
      const out = ctx.createImageData(w, h);
      sampleGrid(store, this.fullRes.grid, R.x + v.x, R.y + v.y, this.zoom, out, splitX, w);
      ctx.putImageData(out, 0, 0, splitX, 0, w - splitX, h);
    } else if (this.paneImg) {
      const p = this.paneImg,
        f = 2 ** p.level;
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, w - splitX, h);
      ctx.clip();
      ctx.imageSmoothingEnabled = !(p.level === 0 && this.zoom >= 1);
      ctx.drawImage(p.canvas, (p.x * f - v.x) * this.zoom, (p.y * f - v.y) * this.zoom, p.img.width * f * this.zoom, p.img.height * f * this.zoom);
      ctx.restore();
    }
    if (this.split) {
      const out = ctx.createImageData(w, h);
      sampleGrid(store, this.s.base, R.x + v.x, R.y + v.y, this.zoom, out, 0, splitX);
      ctx.putImageData(out, 0, 0, 0, 0, splitX, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(splitX - 0.5, 0, 1, h);
    }
    this.ui.overlay?.(ctx, w, h);
  }
  // ----- Full resolution -----
  private scheduleFull(delay = 350) {
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
      this.fullRes = { sig, grid };
      if (sig === this.sig) {
        if (this.canvasPreview) this.s.e.preview(sessionDoc(this.s, grid));
        this.draw();
      }
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
  dispose() {
    this.disposed = true;
    clearTimeout(this.fullTimer);
    clearTimeout(this.watchdog);
    this.paneLane.dispose();
    this.fullLane.dispose();
  }
}
