// Preview region: shows the sequencer output at the current frame (GPU composite), with zoom/pan,
// selection outlines and image transforms of the selected strips.
import { drawShape, type SelectShape } from './shapes';
import { app } from '../app/app';
import { withCompositor, SequencerRender, Cancelled } from './render';
import { renderScenePreview } from './scene';
import { pauseIdleMovies } from './media';
import { stripImageCorners, previewStrips, pointInPoly } from './transform';
import { activeStrip, hasEditor } from './context';
import type { Strip } from './types';
import { editedText, drawTextEditOverlay } from './textedit';
import { cursorPoint } from './pvtransform';
import { T } from './theme';

/** The frame-overlay reference frame (null when the overlay is off). */
export function overlayRefFrame(ed: { show_overlay_frame?: boolean; overlay_frame?: number; use_overlay_frame_lock?: boolean; overlay_frame_type?: string }, current: number): number | null {
  if (!ed.show_overlay_frame || ed.overlay_frame_type === 'CURRENT') return null;
  return ed.use_overlay_frame_lock ? (ed.overlay_frame ?? 0) : current + (ed.overlay_frame ?? 0);
}

export type PreviewSize = 'AUTO' | 'SCENE' | 'PROXY_75' | 'PROXY_50' | 'PROXY_25';

export class PreviewRegion {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  /** last composited frame */
  private frame: HTMLCanvasElement;
  /** frame overlay: the reference frame */
  private refFrame: HTMLCanvasElement = document.createElement('canvas');
  private hasRef = false;
  private hasFrame = false;
  zoom = 1;
  panX = 0;
  panY = 0;
  /** zoom 1 = fit the region */
  fitted = true;
  size: PreviewSize = 'AUTO';
  scale = 1;
  renderMs = 0;
  private dirty = true;
  private busy = false;
  private gen = 0;
  private disposed = false;
  showOverlays = true;
  /** preview overlay options */
  opts = { safeAreas: false, cursor: true, outline: true };
  boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  shape: SelectShape | null = null;
  /** Sample tool readout: region-local position, output pixel and its colour (0..1) */
  sampleInfo: { x: number; y: number; px: [number, number]; rgba: number[] } | null = null;

  constructor(private onRendered: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'seq-pv';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'seq-pv-canvas';
    this.el.append(this.canvas);
    this.frame = document.createElement('canvas');
    new ResizeObserver(() => !this.disposed && this.draw()).observe(this.el);
  }

  dispose() {
    this.disposed = true;
    this.gen++;
  }

  // ------------------------------------------------------------------ geometry

  private res(): [number, number] {
    const r = app.doc.scene.render;
    return [Math.max(1, r.resolution_x), Math.max(1, r.resolution_y)];
  }

  /** Display px per output px and the frame's top-left corner (CSS px, region-local). */
  layout() {
    const [W, H] = this.res();
    const w = this.el.clientWidth,
      h = this.el.clientHeight;
    const aspect = (app.doc.scene.render.pixel_aspect_x || 1) / (app.doc.scene.render.pixel_aspect_y || 1);
    const fit = Math.min((w - 16) / (W * aspect), (h - 16) / H);
    const s = Math.max(1e-4, fit * this.zoom);
    const left = (w - W * aspect * s) / 2 + this.panX;
    const top = (h - H * s) / 2 + this.panY;
    return { s, sx: s * aspect, left, top, W, H, fit };
  }

  /** client px → output px (y up) */
  toFrame(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    const L = this.layout();
    return [(clientX - r.left - L.left) / L.sx, L.H - (clientY - r.top - L.top) / L.s];
  }

  toLocal(fx: number, fy: number): [number, number] {
    const L = this.layout();
    return [L.left + fx * L.sx, L.top + (L.H - fy) * L.s];
  }

  fit() {
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.fitted = true;
    this.draw();
    this.request();
  }

  /** Zoom and pan so the selected strips' images fill the region (fit the frame if none). */
  frameSelected() {
    const [W, H] = this.res();
    const sel = previewStrips(app.doc.scene.frame_current).filter((s) => s.select);
    if (!sel.length) return this.fit();
    const pts = sel.flatMap((s) => stripImageCorners(s, W, H));
    const x0 = Math.min(...pts.map((p) => p[0])),
      x1 = Math.max(...pts.map((p) => p[0])),
      y0 = Math.min(...pts.map((p) => p[1])),
      y1 = Math.max(...pts.map((p) => p[1]));
    this.zoom = 1;
    this.panX = this.panY = 0;
    const L = this.layout();
    const w = this.el.clientWidth - 16,
      h = this.el.clientHeight - 16;
    this.zoom = Math.max(0.05, Math.min(40, Math.min(w / Math.max(1, (x1 - x0) * L.sx), h / Math.max(1, (y1 - y0) * L.s))));
    // centre the box: pan by the offset of its centre from the frame centre at the new zoom
    const L2 = this.layout();
    this.panX = -((x0 + x1) / 2 - W / 2) * L2.sx;
    this.panY = ((y0 + y1) / 2 - H / 2) * L2.s;
    this.fitted = false;
    this.draw();
    this.request();
  }

  /** zoom ratio relative to 1 output pixel per display pixel */
  setRatio(r: number) {
    const L = this.layout();
    this.zoom = r / L.fit;
    this.panX = this.panY = 0;
    this.fitted = false;
    this.draw();
    this.request();
  }

  zoomAt(factor: number, clientX: number, clientY: number) {
    const r = this.el.getBoundingClientRect();
    const mx = clientX - r.left - this.el.clientWidth / 2,
      my = clientY - r.top - this.el.clientHeight / 2;
    const nz = Math.max(0.05, Math.min(40, this.zoom * factor));
    const k = nz / this.zoom;
    this.panX = mx - (mx - this.panX) * k;
    this.panY = my - (my - this.panY) * k;
    this.zoom = nz;
    this.fitted = false;
    this.draw();
    this.request();
  }

  /** composite scale: output px → composited px */
  private compositeScale(): number {
    switch (this.size) {
      case 'SCENE':
        return 1;
      case 'PROXY_75':
        return 0.75;
      case 'PROXY_50':
        return 0.5;
      case 'PROXY_25':
        return 0.25;
    }
    const L = this.layout();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const need = L.s * dpr;
    for (const k of [0.125, 0.25, 0.375, 0.5, 0.75]) if (need <= k) return k;
    return 1;
  }

  // ------------------------------------------------------------------ rendering

  request() {
    this.dirty = true;
    if (!this.busy) void this.loop();
  }

  private async loop() {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      this.busy = true;
      const my = ++this.gen;
      const t0 = performance.now();
      try {
        await this.renderOnce(my);
      } catch (e) {
        if (!(e instanceof Cancelled)) console.error('sequencer preview', e);
      }
      this.renderMs = performance.now() - t0;
      this.busy = false;
      if (my === this.gen) {
        this.draw();
        this.onRendered();
      }
      if (app.playing) await new Promise((r) => requestAnimationFrame(r));
    }
    pauseIdleMovies();
  }

  private async renderOnce(my: number) {
    const ed = app.doc.scene.sequence_editor;
    const [W, H] = this.res();
    const k = this.compositeScale();
    this.scale = k;
    const s = app.doc.scene;
    if (!ed || !ed.strips.length) {
      this.hasFrame = false;
      return;
    }
    const frame = s.frame_current;
    await withCompositor(async (comp) => {
      if (my !== this.gen) throw new Cancelled();
      const sr = new SequencerRender(comp, {
        W,
        H,
        k,
        live: !!app.playing,
        fps: s.render.fps / (s.render.fps_base || 1),
        sceneStart: s.frame_start,
        sceneImage: renderScenePreview,
        cancelled: () => my !== this.gen || this.disposed,
      });
      const t = await sr.render(ed, frame);
      comp.present(t);
      comp.release(t);
      const f = this.frame;
      if (f.width !== comp.canvas.width || f.height !== comp.canvas.height) {
        f.width = comp.canvas.width;
        f.height = comp.canvas.height;
      }
      const g = f.getContext('2d')!;
      g.clearRect(0, 0, f.width, f.height);
      g.drawImage(comp.canvas, 0, 0);
      this.hasFrame = true;
      // frame overlay: render the reference frame too
      const rf = overlayRefFrame(ed, frame);
      this.hasRef = false;
      if (rf !== null && !app.playing) {
        const t2 = await sr.render(ed, rf);
        comp.present(t2);
        comp.release(t2);
        const r = this.refFrame;
        if (r.width !== comp.canvas.width || r.height !== comp.canvas.height) {
          r.width = comp.canvas.width;
          r.height = comp.canvas.height;
        }
        const rg = r.getContext('2d')!;
        rg.clearRect(0, 0, r.width, r.height);
        rg.drawImage(comp.canvas, 0, 0);
        this.hasRef = true;
      }
    });
  }

  // ------------------------------------------------------------------ display

  draw() {
    const c = this.canvas;
    const w = this.el.clientWidth,
      h = this.el.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.previewBack;
    g.fillRect(0, 0, w, h);
    const L = this.layout();
    const fw = L.W * L.sx,
      fh = L.H * L.s;
    if (this.hasFrame) {
      g.imageSmoothingEnabled = L.s < 2;
      g.imageSmoothingQuality = 'high';
      const ed = app.doc.scene.sequence_editor;
      const type = ed?.overlay_frame_type ?? 'RECTANGLE';
      const ref = this.hasRef && ed?.show_overlay_frame ? this.refFrame : null;
      g.drawImage(ref && type === 'REFERENCE' ? ref : this.frame, L.left, L.top, fw, fh);
      if (ref && type === 'RECTANGLE') {
        // the reference frame inside the overlay rectangle
        const [x0, y0, x1, y1] = ed!.overlay_frame_rect ?? [0.25, 0.25, 0.75, 0.75];
        const sx = ref.width,
          sy = ref.height;
        g.drawImage(ref, x0 * sx, (1 - y1) * sy, (x1 - x0) * sx, (y1 - y0) * sy, L.left + x0 * fw, L.top + (1 - y1) * fh, (x1 - x0) * fw, (y1 - y0) * fh);
        g.save();
        g.setLineDash([5, 4]);
        g.strokeStyle = 'rgba(255,255,255,0.8)';
        g.strokeRect(L.left + x0 * fw + 0.5, L.top + (1 - y1) * fh + 0.5, (x1 - x0) * fw, (y1 - y0) * fh);
        g.restore();
      }
    }
    // frame border
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.strokeRect(Math.round(L.left) - 0.5, Math.round(L.top) - 0.5, Math.round(fw) + 1, Math.round(fh) + 1);
    if (this.showOverlays && hasEditor()) this.drawOverlays(g);
    if (this.boxRect) {
      const b = this.boxRect;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.setLineDash([4, 3]);
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.setLineDash([]);
    }
    drawShape(g, this.shape);
    if (this.sampleInfo) this.drawSample(g, this.sampleInfo);
  }

  /** Colour of the shown frame under a client point (null outside the frame). */
  sample(clientX: number, clientY: number): { px: [number, number]; rgba: number[] } | null {
    if (!this.hasFrame) return null;
    const [W, H] = this.res();
    const [fx, fy] = this.toFrame(clientX, clientY);
    if (fx < 0 || fy < 0 || fx >= W || fy >= H) return null;
    const f = this.frame;
    const x = Math.min(f.width - 1, Math.floor((fx / W) * f.width)),
      y = Math.min(f.height - 1, Math.floor(((H - fy) / H) * f.height));
    const d = f.getContext('2d')!.getImageData(x, y, 1, 1).data;
    return { px: [Math.floor(fx), Math.floor(fy)], rgba: [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255] };
  }

  private drawSample(g: CanvasRenderingContext2D, info: { x: number; y: number; px: [number, number]; rgba: number[] }) {
    const [r, gg, b, a] = info.rgba;
    const lines = [`X ${info.px[0]}  Y ${info.px[1]}`, `R ${r.toFixed(3)}  G ${gg.toFixed(3)}  B ${b.toFixed(3)}  A ${a.toFixed(3)}`, `#${[r, gg, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`];
    g.save();
    g.font = '11px Inter, system-ui, sans-serif';
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 40,
      h = lines.length * 15 + 10;
    const x = Math.min(this.el.clientWidth - w - 4, info.x + 14),
      y = Math.min(this.el.clientHeight - h - 4, info.y + 14);
    g.fillStyle = 'rgba(30,30,30,0.92)';
    g.fillRect(x, y, w, h);
    g.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`;
    g.fillRect(x + 6, y + 6, 22, h - 12);
    g.fillStyle = '#e6e6e6';
    lines.forEach((l, i) => g.fillText(l, x + 34, y + 17 + i * 15));
    g.restore();
  }

  private drawOverlays(g: CanvasRenderingContext2D) {
    const [W, H] = this.res();
    const act = activeStrip();
    const editing = editedText();
    if (this.opts.safeAreas) this.drawSafeAreas(g);
    if (editing) drawTextEditOverlay(g, (x, y) => this.toLocal(x, y));
    if (this.opts.cursor) this.drawCursor(g);
    for (const s of previewStrips(app.doc.scene.frame_current)) {
      if (!this.opts.outline || !s.select || s === editing) continue;
      const pts = stripImageCorners(s, W, H).map(([x, y]) => this.toLocal(x, y));
      g.strokeStyle = s === act ? T.active : T.selected;
      g.lineWidth = s === act ? 2 : 1.5;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
    }
  }

  /** Title-safe and action-safe frames (inset by a share of the frame size) and a centre cross. */
  private drawSafeAreas(g: CanvasRenderingContext2D) {
    const [W, H] = this.res();
    const rect = (mx: number, my: number) => {
      const [x0, y0] = this.toLocal(W * mx, H * my),
        [x1, y1] = this.toLocal(W * (1 - mx), H * (1 - my));
      g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    };
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.setLineDash([5, 4]);
    rect(0.1, 0.05);
    rect(0.035, 0.035);
    g.setLineDash([]);
    const [cx, cy] = this.toLocal(W / 2, H / 2);
    g.beginPath();
    g.moveTo(cx - 8, cy);
    g.lineTo(cx + 8, cy);
    g.moveTo(cx, cy - 8);
    g.lineTo(cx, cy + 8);
    g.stroke();
    g.restore();
  }

  /** The 2D cursor: a ring with tick marks. */
  private drawCursor(g: CanvasRenderingContext2D) {
    const [x, y] = this.toLocal(...cursorPoint());
    g.save();
    g.lineWidth = 1.5;
    g.setLineDash([3, 3]);
    g.strokeStyle = '#ffffff';
    g.beginPath();
    g.arc(x, y, 8, 0, Math.PI * 2);
    g.stroke();
    g.lineDashOffset = 3;
    g.strokeStyle = '#e04040';
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.moveTo(x + dx * 11, y + dy * 11);
      g.lineTo(x + dx * 16, y + dy * 16);
    }
    g.stroke();
    g.restore();
  }

  /** Topmost visible strip whose image contains the client point. */
  stripAt(clientX: number, clientY: number) {
    const [W, H] = this.res();
    const [fx, fy] = this.toFrame(clientX, clientY);
    const list = previewStrips(app.doc.scene.frame_current);
    // selected strips under the cursor win when cycling is not needed
    for (const s of list) if (pointInPoly(fx, fy, stripImageCorners(s, W, H))) return s;
    return null;
  }

  /** Visible strips whose image bounds (client pixels) pass a test. */
  stripsWhere(test: (r: { x0: number; y0: number; x1: number; y1: number }) => boolean): Strip[] {
    const [W, H] = this.res();
    const r = this.el.getBoundingClientRect();
    return previewStrips(app.doc.scene.frame_current).filter((s) => {
      const c = stripImageCorners(s, W, H).map(([x, y]) => this.toLocal(x, y));
      const xs = c.map((p) => p[0] + r.left),
        ys = c.map((p) => p[1] + r.top);
      return test({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    });
  }

  /** Strips whose image centre lies inside a client rectangle. */
  stripsInRect(x0: number, y0: number, x1: number, y1: number) {
    const [W, H] = this.res();
    const r = this.el.getBoundingClientRect();
    return previewStrips(app.doc.scene.frame_current).filter((s) => {
      const c = stripImageCorners(s, W, H).map(([x, y]) => this.toLocal(x, y));
      const cx = c.reduce((a, p) => a + p[0], 0) / 4 + r.left,
        cy = c.reduce((a, p) => a + p[1], 0) / 4 + r.top;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
  }
}
