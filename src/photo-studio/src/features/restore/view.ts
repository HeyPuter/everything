// The before/after preview of the Portrait & Restore workspace: a zoomable,
// pannable canvas that shows the result alone, split by a movable divider or
// side by side with the original, a hold-to-compare state, a mask overlay and
// colorize hints. Images come in at any pyramid level and are drawn scaled
// to document coordinates, so a coarse result shows at once and sharper ones
// replace it as they arrive.
import type { Mask8, RGBA8 } from '../../imaging/types';

export type CompareMode = 'split' | 'side' | 'after';
export type ViewHint = { x: number; y: number; color: string; radius: number };
type Pic = { canvas: HTMLCanvasElement; w: number; h: number };

function toPic(img: RGBA8): Pic {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return { canvas: c, w: img.width, h: img.height };
}
function maskPic(m: Mask8, kind: 'tint' | 'gray'): Pic {
  const data = new Uint8ClampedArray(m.data.length * 4);
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i];
    if (kind === 'gray') data.set([v, v, v, 255], i * 4);
    else data.set([255, 40, 60, Math.round(v * 0.55)], i * 4);
  }
  return toPic({ width: m.width, height: m.height, data });
}

export class CompareView {
  readonly canvas: HTMLCanvasElement;
  zoom = 1;
  cx = 0;
  cy = 0;
  mode: CompareMode = 'split';
  split = 0.5;
  // While held, the original is shown in place of the result.
  comparing = false;
  hints: ViewHint[] = [];
  selectedHint = -1;
  // A marker for a focus point (normalized), drawn as a crosshair.
  focus?: { x: number; y: number };
  onZoom?: (z: number) => void;
  onClick?: (x: number, y: number, ev: PointerEvent) => void;
  private after?: Pic;
  private before?: Pic;
  private overlay?: { pic: Pic; kind: 'tint' | 'gray' };
  private observer: ResizeObserver;
  private fitted = false;
  private disposed = false;

  constructor(
    readonly host: HTMLElement,
    readonly docW: number,
    readonly docH: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pr-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Before and after preview. Drag to pan; Ctrl or Command with the wheel zooms.');
    host.append(this.canvas);
    this.cx = docW / 2;
    this.cy = docH / 2;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.bind();
    this.resize();
  }
  get width() {
    return this.canvas.clientWidth || this.host.clientWidth || 400;
  }
  get height() {
    return this.canvas.clientHeight || this.host.clientHeight || 300;
  }
  private resize() {
    if (this.disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(50, this.host.clientWidth), h = Math.max(50, this.host.clientHeight);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (!this.fitted && this.host.clientWidth > 0) {
      this.fitted = true;
      this.fit();
    } else this.draw();
  }
  /** Longest side in device pixels the preview can show at the current zoom. */
  neededResolution() {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(this.docW, this.docH) * this.zoom * dpr;
  }
  fitZoom() {
    const w = this.mode === 'side' ? this.width / 2 : this.width;
    return Math.min(w / this.docW, this.height / this.docH) * 0.96;
  }
  fit() {
    this.cx = this.docW / 2;
    this.cy = this.docH / 2;
    this.setZoom(this.fitZoom());
  }
  setZoom(z: number, anchor?: { x: number; y: number }) {
    const nz = Math.max(1 / 64, Math.min(32, z));
    if (anchor) {
      // Keep the document point under the anchor (view coordinates) in place.
      const [dx, dy] = this.toDoc(anchor.x, anchor.y);
      this.zoom = nz;
      const [nx, ny] = this.toDoc(anchor.x, anchor.y);
      this.cx += dx - nx;
      this.cy += dy - ny;
    } else this.zoom = nz;
    this.onZoom?.(this.zoom);
    this.draw();
  }
  step(dir: 1 | -1, anchor?: { x: number; y: number }) {
    this.setZoom(dir > 0 ? this.zoom * 1.25 : this.zoom / 1.25, anchor);
  }
  setAfter(img: RGBA8 | undefined) {
    this.after = img && toPic(img);
    this.draw();
  }
  setBefore(img: RGBA8 | undefined) {
    this.before = img && toPic(img);
    this.draw();
  }
  get hasBefore() {
    return !!this.before;
  }
  setOverlay(m: Mask8 | undefined, kind: 'tint' | 'gray' = 'tint') {
    this.overlay = m && { pic: maskPic(m, kind), kind };
    this.draw();
  }
  /** The viewport rectangles (view pixels) and what each shows. */
  private panes(): { x: number; w: number; show: 'before' | 'after' | 'split' }[] {
    const W = this.width;
    if (this.comparing) return [{ x: 0, w: W, show: 'before' }];
    if (this.mode === 'side') return [{ x: 0, w: W / 2, show: 'before' }, { x: W / 2, w: W - W / 2, show: 'after' }];
    if (this.mode === 'split') return [{ x: 0, w: W, show: 'split' }];
    return [{ x: 0, w: W, show: 'after' }];
  }
  /** Document point for a view position (in the pane under it). */
  toDoc(vx: number, vy: number): [number, number] {
    const pane = this.panes().find((p) => vx >= p.x && vx < p.x + p.w) ?? this.panes()[0];
    const ox = pane.x + pane.w / 2, oy = this.height / 2;
    return [(vx - ox) / this.zoom + this.cx, (vy - oy) / this.zoom + this.cy];
  }
  private drawPic(ctx: CanvasRenderingContext2D, pic: Pic, ox: number, oy: number) {
    // Whole device pixels at the edges, so no checkerboard shows through.
    const dpr = window.devicePixelRatio || 1, snap = (v: number) => Math.round(v * dpr) / dpr;
    const x = snap(ox - this.cx * this.zoom), y = snap(oy - this.cy * this.zoom);
    const w = snap(ox - this.cx * this.zoom + this.docW * this.zoom) - x, h = snap(oy - this.cy * this.zoom + this.docH * this.zoom) - y;
    ctx.imageSmoothingEnabled = this.zoom * (this.docW / pic.w) < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pic.canvas, x, y, w, h);
  }
  draw() {
    if (this.disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.width, H = this.height;
    ctx.clearRect(0, 0, W, H);
    for (const pane of this.panes()) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(pane.x, 0, pane.w, H);
      ctx.clip();
      const ox = pane.x + pane.w / 2, oy = H / 2;
      // Checkerboard under the image so transparency reads as such.
      const snap = (v: number) => Math.round(v * dpr) / dpr;
      const x0 = snap(ox - this.cx * this.zoom), y0 = snap(oy - this.cy * this.zoom), iw = snap(ox - this.cx * this.zoom + this.docW * this.zoom) - x0, ih = snap(oy - this.cy * this.zoom + this.docH * this.zoom) - y0;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, y0, iw, ih);
      ctx.fillStyle = '#d6d6d6';
      const s = 8;
      for (let y = Math.max(y0, 0) - ((Math.max(y0, 0) - y0) % s); y < Math.min(y0 + ih, H); y += s)
        for (let x = Math.max(x0, pane.x) - ((Math.max(x0, pane.x) - x0) % s); x < Math.min(x0 + iw, pane.x + pane.w); x += s)
          if ((Math.floor((x - x0) / s) + Math.floor((y - y0) / s)) % 2) ctx.fillRect(x, y, Math.min(s, x0 + iw - x), Math.min(s, y0 + ih - y));
      const showAfter = pane.show === 'after' || pane.show === 'split';
      if (pane.show === 'before' && this.before) this.drawPic(ctx, this.before, ox, oy);
      if (showAfter && (this.after ?? this.before)) this.drawPic(ctx, (this.after ?? this.before)!, ox, oy);
      if (showAfter && this.overlay) this.drawPic(ctx, this.overlay.pic, ox, oy);
      if (pane.show === 'split' && this.before) {
        const sx = pane.x + this.split * pane.w;
        ctx.save();
        ctx.beginPath();
        ctx.rect(pane.x, 0, sx - pane.x, H);
        ctx.clip();
        ctx.clearRect(pane.x, 0, sx - pane.x, H);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0, y0, iw, ih);
        this.drawPic(ctx, this.before, ox, oy);
        ctx.restore();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx - 1, 0, 2, H);
        ctx.strokeStyle = 'rgba(0,0,0,.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx - 1.5, -1, 3, H + 2);
        // Divider handle.
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(sx, H / 2, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#333';
        ctx.beginPath();
        ctx.moveTo(sx - 4, H / 2 - 4);
        ctx.lineTo(sx - 7, H / 2);
        ctx.lineTo(sx - 4, H / 2 + 4);
        ctx.moveTo(sx + 4, H / 2 - 4);
        ctx.lineTo(sx + 7, H / 2);
        ctx.lineTo(sx + 4, H / 2 + 4);
        ctx.stroke();
      }
      if (showAfter) this.drawMarks(ctx, ox, oy);
      ctx.restore();
    }
    if (this.mode === 'side' && !this.comparing) {
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(W / 2 - 1, 0, 2, H);
    }
    this.labels(ctx);
  }
  private labels(ctx: CanvasRenderingContext2D) {
    const tags: [string, number][] = [];
    const W = this.width;
    if (this.comparing) tags.push(['Before', 10]);
    else if (this.mode === 'side') tags.push(['Before', 10], ['After', W / 2 + 10]);
    else if (this.mode === 'split') tags.push(['Before', 10], ['After', W - 10]);
    ctx.font = '600 11px system-ui, sans-serif';
    for (const [t, x] of tags) {
      const right = x > W - 20;
      const tw = ctx.measureText(t).width + 12;
      const bx = right ? x - tw : x;
      ctx.fillStyle = 'rgba(0,0,0,.66)';
      ctx.fillRect(bx, 8, tw, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(t, bx + 6, 21);
    }
  }
  private drawMarks(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    const map = (x: number, y: number): [number, number] => [ox + (x * this.docW - this.cx) * this.zoom, oy + (y * this.docH - this.cy) * this.zoom];
    this.hints.forEach((h, i) => {
      const [x, y] = map(h.x, h.y);
      const r = Math.max(5, h.radius * this.zoom);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = h.color;
      ctx.fill();
      ctx.lineWidth = i === this.selectedHint ? 3 : 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000000';
      ctx.beginPath();
      ctx.arc(x, y, r + (i === this.selectedHint ? 2 : 1.2), 0, Math.PI * 2);
      ctx.stroke();
    });
    if (this.focus) {
      const [x, y] = map(this.focus.x, this.focus.y);
      for (const [c, w] of [
        ['#000000', 3],
        ['#ffffff', 1.5],
      ] as const) {
        ctx.strokeStyle = c;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.moveTo(x - 15, y);
        ctx.lineTo(x - 5, y);
        ctx.moveTo(x + 5, y);
        ctx.lineTo(x + 15, y);
        ctx.moveTo(x, y - 15);
        ctx.lineTo(x, y - 5);
        ctx.moveTo(x, y + 5);
        ctx.lineTo(x, y + 15);
        ctx.stroke();
      }
    }
  }
  /** Index of the hint under a view point, or -1. */
  hintAt(vx: number, vy: number) {
    const [dx, dy] = this.toDoc(vx, vy);
    let best = -1, bd = Infinity;
    this.hints.forEach((h, i) => {
      const d = Math.hypot(h.x * this.docW - dx, h.y * this.docH - dy) * this.zoom;
      if (d <= Math.max(8, h.radius * this.zoom + 4) && d < bd) (bd = d), (best = i);
    });
    return best;
  }
  private bind() {
    const c = this.canvas;
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean; divider: boolean } | undefined;
    const local = (ev: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const p = local(ev);
      const divider = this.mode === 'split' && !this.comparing && Math.abs(p.x - this.split * this.width) < 14;
      drag = { x: p.x, y: p.y, cx: this.cx, cy: this.cy, moved: false, divider };
      c.setPointerCapture(ev.pointerId);
    });
    c.addEventListener('pointermove', (ev) => {
      const p = local(ev);
      if (!drag) {
        const nearDivider = this.mode === 'split' && !this.comparing && Math.abs(p.x - this.split * this.width) < 14;
        c.style.cursor = nearDivider ? 'ew-resize' : 'grab';
        return;
      }
      if (Math.hypot(p.x - drag.x, p.y - drag.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.divider) this.split = Math.max(0.02, Math.min(0.98, p.x / this.width));
      else {
        this.cx = drag.cx - (p.x - drag.x) / this.zoom;
        this.cy = drag.cy - (p.y - drag.y) / this.zoom;
        c.style.cursor = 'grabbing';
      }
      this.draw();
    });
    const end = (ev: PointerEvent) => {
      if (!drag) return;
      const d = drag;
      drag = undefined;
      c.style.cursor = 'grab';
      if (!d.moved && !d.divider) {
        const [x, y] = this.toDoc(d.x, d.y);
        if (x >= 0 && y >= 0 && x <= this.docW && y <= this.docH) this.onClick?.(x, y, ev);
      }
      this.onZoom?.(this.zoom);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => (drag = undefined));
    c.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        if (ev.ctrlKey || ev.metaKey || ev.altKey) this.setZoom(this.zoom * Math.exp(-ev.deltaY * 0.0025), local(ev));
        else {
          this.cx += ev.deltaX / this.zoom;
          this.cy += ev.deltaY / this.zoom;
          this.draw();
        }
      },
      { passive: false },
    );
  }
  dispose() {
    this.disposed = true;
    this.observer.disconnect();
  }
}
