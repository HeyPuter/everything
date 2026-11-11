// Liquify workspace: a full-screen view of the layer (or selection region)
// with warp brushes acting on a displacement field. Strokes re-render only the
// screen area they changed, from a reduced copy of the image when zoomed out;
// OK renders the field at full resolution in the worker as one history step.
import type { Editor } from '../../editor';
import { LiquifyField, type LiquifyTool } from '../../imaging/filters/liquify';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { readRect } from '../../model/tiles';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { closeSession, commitSession, isLiveLayer, openSession, resultGrid, setRegion, type Session } from './apply';
import { Lane, isCancel } from './client';
import { halveRGBA, maskToRGBA } from './stack';

type Tool = LiquifyTool | 'freeze' | 'thaw' | 'hand' | 'zoom';
const toolList: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'forward-warp', label: 'Forward Warp', key: 'W', icon: 'liquify-forward' },
  { id: 'reconstruct', label: 'Reconstruct', key: 'R', icon: 'history-brush' },
  { id: 'smooth', label: 'Smooth', key: 'E', icon: 'waves' },
  { id: 'twirl-cw', label: 'Twirl Clockwise (Alt: counterclockwise)', key: 'C', icon: 'rotate-cw' },
  { id: 'pucker', label: 'Pucker', key: 'S', icon: 'liquify-pucker' },
  { id: 'bloat', label: 'Bloat', key: 'B', icon: 'liquify-bloat' },
  { id: 'push-left', label: 'Push Left', key: 'O', icon: 'arrow-left-right' },
  { id: 'freeze', label: 'Freeze Mask', key: 'F', icon: 'lock' },
  { id: 'thaw', label: 'Thaw Mask', key: 'D', icon: 'lock-open' },
  { id: 'hand', label: 'Hand', key: 'H', icon: 'hand' },
  { id: 'zoom', label: 'Zoom (Alt: zoom out)', key: 'Z', icon: 'zoom-in' },
];
const applyLane = new Lane('liquify');

export async function liquify(e: Editor) {
  if (isLiveLayer(e.layer) && !e.editingMask && !e.settings.quickMask) {
    e.message('Liquify edits pixels. Rasterize the layer’s Live Filters first (paint on it or use Layer → Rasterize).');
    return;
  }
  const s = await openSession(e, 'liquify', {});
  if (!s) return;
  if (s.selBounds) setRegion(s, s.selBounds);
  const raw = readRect(e.assets.tiles, s.base, s.rect);
  const src: RGBA8 = s.base.channels === 1 ? maskToRGBA(raw as Mask8) : (raw as RGBA8);
  try {
    await new LiquifyWorkspace(e, s, src).run();
  } finally {
    closeSession(s);
  }
}

class LiquifyWorkspace {
  private field: LiquifyField;
  private levels: RGBA8[];
  private freeze?: Mask8;
  private tool: Tool = 'forward-warp';
  private size = 100;
  private density = 50;
  private pressure = 100;
  private rate = 80;
  private stylus = true;
  private showMesh = false;
  private showMask = true;
  private zoom = 1;
  private ox = 0;
  private oy = 0;
  private history: { dx: Float32Array; dy: Float32Array; freeze?: Uint8Array }[] = [];
  private dialog!: HTMLDialogElement;
  private canvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private cursor!: HTMLElement;
  private image?: ImageData;
  private dirty: IRect | null = null;
  private frame = 0;
  private spaceHand = false;
  private altDown = false;
  constructor(
    private e: Editor,
    private s: Session,
    private src: RGBA8,
  ) {
    const px = src.width * src.height;
    this.field = new LiquifyField(src.width, src.height, px > 8e6 ? 6 : 4);
    this.levels = [src];
    this.size = Math.max(10, Math.min(400, Math.round(Math.min(src.width, src.height) / 8)));
  }
  private level(k: number) {
    while (this.levels.length <= k) this.levels.push(halveRGBA(this.levels[this.levels.length - 1]));
    return this.levels[k];
  }
  run(): Promise<void> {
    this.build();
    return new Promise((resolve) => {
      const close = () => {
        cancelAnimationFrame(this.frame);
        applyLane.cancel();
        window.removeEventListener('resize', this.onResize);
        this.dialog.close();
        this.dialog.remove();
        this.e.update();
        resolve();
      };
      this.dialog.querySelector('.lq-cancel')!.addEventListener('click', close);
      this.dialog.addEventListener('cancel', (ev) => {
        ev.preventDefault();
        close();
      });
      this.dialog.querySelector('.lq-ok')!.addEventListener('click', async (ev) => {
        const ok = ev.currentTarget as HTMLButtonElement;
        if (this.field.isIdentity()) return close();
        ok.disabled = true;
        const bar = this.dialog.querySelector<HTMLElement>('.lq-progress')!;
        bar.hidden = false;
        try {
          const res = await applyLane.run({ type: 'liquify', job: 0, key: this.s.key, field: this.field.serialize(), useSelection: !!this.s.selection }, [this.s.key], (f) => bar.querySelector('progress')!.setAttribute('value', String(f)));
          commitSession(this.s, resultGrid(this.s, res.tiles!), 'liquify', {}, 'Liquify');
          close();
        } catch (error) {
          ok.disabled = false;
          bar.hidden = true;
          if (!isCancel(error)) this.e.message(error instanceof Error ? error.message : String(error));
        }
      });
      this.dialog.querySelector('.lq-progress button')!.addEventListener('click', () => applyLane.cancel());
    });
  }
  private build() {
    const d = document.createElement('dialog');
    d.className = 'liquify-dialog';
    const num = (key: string, label: string, min: number, max: number, value: number) =>
      `<div class="fp-row fp-number"><label for="lq-${key}">${label}</label><input id="lq-${key}" type="number" data-opt="${key}" min="${min}" max="${max}" value="${value}"><input type="range" data-opt="${key}" min="${min}" max="${max}" value="${value}" aria-label="${label}"></div>`;
    d.innerHTML = `<div class="lq-head"><h2>Liquify</h2><span class="lq-hint" aria-live="polite"></span><div class="lq-actions"><button type="button" class="lq-cancel">Cancel</button><button type="button" class="primary lq-ok">OK</button></div></div>
<div class="lq-body">
  <div class="lq-tools" role="toolbar" aria-label="Liquify tools">${toolList.map((t) => `<button type="button" class="icon-button" data-tool="${t.id}" aria-pressed="${t.id === this.tool}" title="${escapeXML(t.label)} (${t.key})" aria-label="${escapeXML(t.label)}">${svg(t.icon, 18)}</button>`).join('')}</div>
  <div class="lq-stage"><canvas class="lq-canvas"></canvas><canvas class="lq-overlay"></canvas><div class="lq-cursor" hidden></div></div>
  <aside class="lq-props">
    <section><h3>Brush Tool Options</h3>${num('size', 'Size', 1, 1500, this.size)}${num('density', 'Density', 0, 100, this.density)}${num('pressure', 'Pressure', 1, 100, this.pressure)}${num('rate', 'Rate', 0, 100, this.rate)}<label class="lq-check"><input type="checkbox" data-opt="stylus" checked> Stylus Pressure</label></section>
    <section><h3>Reconstruct Options</h3><div class="lq-row"><button type="button" data-act="reconstruct">Reconstruct…</button><button type="button" data-act="restore">Restore All</button></div><div class="lq-reconstruct" hidden><div class="fp-row fp-number"><label for="lq-amount">Amount</label><input id="lq-amount" type="number" min="0" max="100" value="100"><input type="range" id="lq-amount-range" min="0" max="100" value="100" aria-label="Reconstruct amount"></div><div class="lq-row"><button type="button" data-act="reconstruct-cancel">Cancel</button><button type="button" class="primary" data-act="reconstruct-ok">OK</button></div></div></section>
    <section><h3>Mask Options</h3><div class="lq-row"><button type="button" data-act="mask-none">None</button><button type="button" data-act="mask-all">Mask All</button><button type="button" data-act="mask-invert">Invert All</button></div></section>
    <section><h3>View Options</h3><label class="lq-check"><input type="checkbox" data-opt="mesh"> Show Mesh</label><label class="lq-check"><input type="checkbox" data-opt="mask" checked> Show Mask</label><div class="lq-row lq-zoom"><button type="button" class="icon-button" data-act="zoom-out" aria-label="Zoom out">${svg('minus', 14)}</button><span class="lq-zoom-label"></span><button type="button" class="icon-button" data-act="zoom-in" aria-label="Zoom in">${svg('plus', 14)}</button><button type="button" data-act="fit">Fit</button><button type="button" data-act="undo" title="Undo stroke (Mod+Z)">Undo</button></div></section>
  </aside>
</div>
<div class="lq-progress" hidden><span>Liquify…</span><progress max="1" value="0"></progress><button type="button">Cancel</button></div>`;
    document.body.append(d);
    this.dialog = d;
    this.canvas = d.querySelector('.lq-canvas')!;
    this.overlay = d.querySelector('.lq-overlay')!;
    this.cursor = d.querySelector('.lq-cursor')!;
    d.showModal();
    this.resize();
    this.fit();
    window.addEventListener('resize', this.onResize);
    this.bind();
    this.hint();
  }
  private onResize = () => {
    this.resize();
    this.redraw();
  };
  private resize() {
    const stage = this.dialog.querySelector<HTMLElement>('.lq-stage')!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(stage.clientWidth * dpr)),
      h = Math.max(1, Math.round(stage.clientHeight * dpr));
    for (const c of [this.canvas, this.overlay]) {
      c.width = w;
      c.height = h;
    }
    this.image = undefined;
  }
  private get dpr() {
    return window.devicePixelRatio || 1;
  }
  private fit() {
    const W = this.canvas.width / this.dpr,
      H = this.canvas.height / this.dpr;
    this.zoom = Math.min(1, (W - 40) / this.src.width, (H - 40) / this.src.height);
    this.ox = this.src.width / 2 - W / 2 / this.zoom;
    this.oy = this.src.height / 2 - H / 2 / this.zoom;
    this.redraw();
  }
  private zoomAt(z: number, cx?: number, cy?: number) {
    const W = this.canvas.width / this.dpr,
      H = this.canvas.height / this.dpr;
    const sx = cx ?? W / 2,
      sy = cy ?? H / 2;
    const ix = this.ox + sx / this.zoom,
      iy = this.oy + sy / this.zoom;
    this.zoom = Math.max(1 / 32, Math.min(32, z));
    this.ox = ix - sx / this.zoom;
    this.oy = iy - sy / this.zoom;
    this.redraw();
  }
  private hint() {
    const t = toolList.find((x) => x.id === this.tool)!;
    this.dialog.querySelector('.lq-hint')!.textContent = `${t.label.replace(/ \(.*\)/, '')} · brush ${Math.round(this.size)} px · [ ] change size`;
    this.dialog.querySelector('.lq-zoom-label')!.textContent = `${Math.round(this.zoom * 1000) / 10}%`;
    for (const b of this.dialog.querySelectorAll<HTMLElement>('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
  }
  private setOpt(key: string, v: number) {
    if (key === 'size') this.size = Math.max(1, Math.min(1500, v));
    else if (key === 'density') this.density = Math.max(0, Math.min(100, v));
    else if (key === 'pressure') this.pressure = Math.max(1, Math.min(100, v));
    else if (key === 'rate') this.rate = Math.max(0, Math.min(100, v));
    for (const i of this.dialog.querySelectorAll<HTMLInputElement>(`[data-opt="${key}"]`)) if (document.activeElement !== i) i.value = String(Math.round(key === 'size' ? this.size : v));
    this.hint();
  }
  // ----- Coordinates -----
  private toImage(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    return { x: this.ox + (clientX - r.left) / this.zoom, y: this.oy + (clientY - r.top) / this.zoom, sx: clientX - r.left, sy: clientY - r.top };
  }
  // ----- Rendering -----
  private redraw() {
    this.dirty = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };
    this.schedule();
    this.hint();
  }
  private invalidate(r: IRect | null) {
    if (!r) return;
    const d = this.dirty;
    if (!d) this.dirty = r;
    else {
      const x = Math.min(d.x, r.x),
        y = Math.min(d.y, r.y);
      this.dirty = { x, y, width: Math.max(d.x + d.width, r.x + r.width) - x, height: Math.max(d.y + d.height, r.y + r.height) - y };
    }
    this.schedule();
  }
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }
  /** Render the dirty image rectangle at screen resolution. */
  private paint() {
    const d = this.dirty;
    this.dirty = null;
    if (!d) return;
    const W = this.canvas.width,
      H = this.canvas.height;
    const scr = this.zoom * this.dpr;
    if (!this.image || this.image.width !== W || this.image.height !== H) this.image = new ImageData(W, H);
    const sx0 = Math.max(0, Math.floor((d.x - this.ox) * scr) - 2),
      sy0 = Math.max(0, Math.floor((d.y - this.oy) * scr) - 2),
      sx1 = Math.min(W, Math.ceil((d.x + d.width - this.ox) * scr) + 2),
      sy1 = Math.min(H, Math.ceil((d.y + d.height - this.oy) * scr) + 2);
    if (sx1 <= sx0 || sy1 <= sy0) return;
    const k = Math.max(0, Math.min(8, Math.floor(Math.log2(1 / scr) + 1e-9)));
    const lv = this.level(k),
      f = 2 ** -k;
    const lw = lv.width,
      lh = lv.height,
      ld = lv.data;
    const out = this.image.data;
    const field = this.field;
    const iw = this.src.width,
      ih = this.src.height;
    const freeze = this.showMask ? this.freeze : undefined;
    const t = new Float64Array(2);
    // Displacement is sampled every G screen pixels and interpolated between.
    const G = 4;
    const cols = Math.ceil((sx1 - sx0) / G) + 2;
    const rowA = new Float32Array(cols * 2),
      rowB = new Float32Array(cols * 2);
    const sampleRow = (row: Float32Array, sy: number) => {
      const qy = this.oy + (sy + 0.5) / scr;
      for (let c = 0; c < cols; c++) {
        field.displacementAt(this.ox + (sx0 + c * G + 0.5) / scr, qy, t);
        row[c * 2] = t[0];
        row[c * 2 + 1] = t[1];
      }
    };
    const smooth = scr > 1.5;
    for (let gy = sy0; gy < sy1; gy += G) {
      sampleRow(rowA, gy);
      sampleRow(rowB, gy + G);
      const yEnd = Math.min(sy1, gy + G);
      for (let sy = gy; sy < yEnd; sy++) {
        const fy = (sy - gy) / G;
        const qy = this.oy + (sy + 0.5) / scr;
        let o = (sy * W + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, o += 4) {
          const qx = this.ox + (sx + 0.5) / scr;
          if (qx < 0 || qy < 0 || qx >= iw || qy >= ih) {
            out[o + 3] = 0;
            continue;
          }
          const c = ((sx - sx0) / G) | 0,
            fx = (sx - sx0 - c * G) / G;
          const a0 = rowA[c * 2] + (rowA[c * 2 + 2] - rowA[c * 2]) * fx,
            b0 = rowB[c * 2] + (rowB[c * 2 + 2] - rowB[c * 2]) * fx;
          const a1 = rowA[c * 2 + 1] + (rowA[c * 2 + 3] - rowA[c * 2 + 1]) * fx,
            b1 = rowB[c * 2 + 1] + (rowB[c * 2 + 3] - rowB[c * 2 + 1]) * fx;
          let px = (qx + a0 + (b0 - a0) * fy) * f - 0.5,
            py = (qy + a1 + (b1 - a1) * fy) * f - 0.5;
          px = px < 0 ? 0 : px > lw - 1 ? lw - 1 : px;
          py = py < 0 ? 0 : py > lh - 1 ? lh - 1 : py;
          let r: number, g: number, b: number, al: number;
          if (smooth) {
            const x0 = px | 0,
              y0 = py | 0,
              x1 = x0 + 1 < lw ? x0 + 1 : x0,
              y1 = y0 + 1 < lh ? y0 + 1 : y0,
              ax = px - x0,
              ay = py - y0;
            const i00 = (y0 * lw + x0) * 4,
              i10 = (y0 * lw + x1) * 4,
              i01 = (y1 * lw + x0) * 4,
              i11 = (y1 * lw + x1) * 4;
            const w00 = (1 - ax) * (1 - ay),
              w10 = ax * (1 - ay),
              w01 = (1 - ax) * ay,
              w11 = ax * ay;
            r = ld[i00] * w00 + ld[i10] * w10 + ld[i01] * w01 + ld[i11] * w11;
            g = ld[i00 + 1] * w00 + ld[i10 + 1] * w10 + ld[i01 + 1] * w01 + ld[i11 + 1] * w11;
            b = ld[i00 + 2] * w00 + ld[i10 + 2] * w10 + ld[i01 + 2] * w01 + ld[i11 + 2] * w11;
            al = ld[i00 + 3] * w00 + ld[i10 + 3] * w10 + ld[i01 + 3] * w01 + ld[i11 + 3] * w11;
          } else {
            const i = ((py + 0.5) | 0) * lw * 4 + ((px + 0.5) | 0) * 4;
            r = ld[i];
            g = ld[i + 1];
            b = ld[i + 2];
            al = ld[i + 3];
          }
          if (freeze) {
            const m = freeze.data[(qy | 0) * iw + (qx | 0)];
            if (m) {
              // Frozen areas show a translucent red tint (opaque over transparency).
              const k2 = (m / 255) * 0.5;
              r = r * (1 - k2) + 230 * k2;
              g = g * (1 - k2) + 40 * k2;
              b = b * (1 - k2) + 40 * k2;
              al = al + (255 - al) * k2;
            }
          }
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = al;
        }
      }
    }
    this.canvas.getContext('2d')!.putImageData(this.image, 0, 0, sx0, sy0, sx1 - sx0, sy1 - sy0);
    this.drawMesh();
  }
  private drawMesh() {
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.showMesh) return;
    const scr = this.zoom * this.dpr;
    const cs = this.field.cellSize;
    const step = cs * Math.max(1, Math.ceil(28 / (cs * scr)));
    const t = new Float64Array(2);
    const iw = this.src.width,
      ih = this.src.height;
    const x0 = Math.max(0, Math.floor(this.ox / step) * step),
      y0 = Math.max(0, Math.floor(this.oy / step) * step);
    const x1 = Math.min(iw, this.ox + this.overlay.width / scr),
      y1 = Math.min(ih, this.oy + this.overlay.height / scr);
    // Mesh lines are drawn where the source grid moved to (approximately q - d(q)).
    const pt = (x: number, y: number): [number, number] => {
      this.field.displacementAt(x, y, t);
      return [(x - t[0] - this.ox) * scr, (y - t[1] - this.oy) * scr];
    };
    ctx.strokeStyle = 'rgba(120,170,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const fine = Math.max(1, step / 4);
    for (let y = y0; y <= y1; y += step) {
      let first = true;
      for (let x = x0; x <= x1 + fine; x += fine) {
        const [px, py] = pt(Math.min(x, iw), y);
        if (first) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        first = false;
      }
    }
    for (let x = x0; x <= x1; x += step) {
      let first = true;
      for (let y = y0; y <= y1 + fine; y += fine) {
        const [px, py] = pt(x, Math.min(y, ih));
        if (first) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        first = false;
      }
    }
    ctx.stroke();
  }
  // ----- Masks -----
  private dabMask(x: number, y: number, add: boolean, strength: number) {
    const iw = this.src.width,
      ih = this.src.height;
    if (!this.freeze) {
      if (!add) return null;
      this.freeze = { width: iw, height: ih, data: new Uint8Array(iw * ih) };
    }
    const R = this.size / 2,
      hard = this.density / 100;
    const x0 = Math.max(0, Math.floor(x - R)),
      x1 = Math.min(iw - 1, Math.ceil(x + R)),
      y0 = Math.max(0, Math.floor(y - R)),
      y1 = Math.min(ih - 1, Math.ceil(y + R));
    const m = this.freeze.data;
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const dist = Math.hypot(px + 0.5 - x, py + 0.5 - y) / R;
        if (dist >= 1) continue;
        const w = ((1 - hard) * 0.5 * (1 + Math.cos(Math.PI * dist)) + hard * Math.min(1, (1 - dist) * 4)) * strength;
        const i = py * iw + px;
        m[i] = add ? Math.max(m[i], Math.round(255 * w)) : Math.max(0, Math.round(m[i] - 255 * w));
      }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }
  private snapshot() {
    this.history.push({ dx: new Float32Array(this.field.dx), dy: new Float32Array(this.field.dy), freeze: this.freeze ? new Uint8Array(this.freeze.data) : undefined });
    // Field snapshots can be large; keep the most recent few.
    if (this.history.length > 8) this.history.shift();
  }
  private undo() {
    this.endReconstruct();
    const h = this.history.pop();
    if (!h) return;
    this.field.dx.set(h.dx);
    this.field.dy.set(h.dy);
    // The step may have removed the mask (Mask None), so restore it as a whole.
    this.freeze = h.freeze && { width: this.src.width, height: this.src.height, data: h.freeze };
    this.redraw();
  }
  // ----- Input -----
  private activeTool(): Tool {
    if (this.spaceHand) return 'hand';
    if (this.tool === 'twirl-cw' && this.altDown) return 'twirl-ccw';
    return this.tool;
  }
  private bind() {
    const d = this.dialog;
    d.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const tool = t.closest<HTMLElement>('[data-tool]')?.dataset.tool as Tool | undefined;
      if (tool) {
        this.tool = tool;
        this.hint();
        return;
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act) this.action(act);
    });
    d.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      const key = t.dataset.opt;
      if (key === 'stylus') this.stylus = t.checked;
      else if (key === 'mesh') {
        this.showMesh = t.checked;
        this.drawMesh();
      } else if (key === 'mask') {
        this.showMask = t.checked;
        this.redraw();
      } else if (key && t.value !== '') this.setOpt(key, Number(t.value));
      else if (t.id === 'lq-amount' || t.id === 'lq-amount-range') {
        const v = Math.max(0, Math.min(100, Number(t.value) || 0));
        d.querySelector<HTMLInputElement>(t.id === 'lq-amount' ? '#lq-amount-range' : '#lq-amount')!.value = String(v);
        this.previewReconstruct(v / 100);
      }
    });
    d.addEventListener('keydown', (ev) => this.key(ev, true));
    d.addEventListener('keyup', (ev) => this.key(ev, false));
    const c = this.canvas;
    let stroke: { x: number; y: number; tool: Tool; sx: number; sy: number; ox: number; oy: number; pressure: number; timer: number } | undefined;
    const pressureOf = (ev: PointerEvent) => (this.pressure / 100) * (this.stylus && ev.pointerType === 'pen' ? Math.max(0.05, ev.pressure) : 1);
    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      c.setPointerCapture(ev.pointerId);
      const p = this.toImage(ev.clientX, ev.clientY);
      const tool = this.activeTool();
      if (tool === 'zoom') {
        this.zoomAt(this.zoom * (ev.altKey ? 0.5 : 2), p.sx, p.sy);
        return;
      }
      if (tool !== 'hand') {
        this.endReconstruct();
        this.snapshot();
      }
      stroke = { x: p.x, y: p.y, tool, sx: ev.clientX, sy: ev.clientY, ox: this.ox, oy: this.oy, pressure: pressureOf(ev), timer: 0 };
      if (tool !== 'hand') {
        this.dab(stroke.tool, p.x, p.y, 0, 0, stroke.pressure);
        // Stationary tools keep working while the button is held.
        if (!['forward-warp', 'push-left'].includes(tool)) {
          const tick = () => {
            if (!stroke) return;
            this.dab(stroke.tool, stroke.x, stroke.y, 0, 0, stroke.pressure);
            stroke.timer = window.setTimeout(tick, 33);
          };
          stroke.timer = window.setTimeout(tick, 33);
        }
      }
    });
    c.addEventListener('pointermove', (ev) => {
      this.moveCursor(ev);
      if (!stroke) return;
      if (stroke.tool === 'hand') {
        this.ox = stroke.ox - (ev.clientX - stroke.sx) / this.zoom;
        this.oy = stroke.oy - (ev.clientY - stroke.sy) / this.zoom;
        this.redraw();
        return;
      }
      const events = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [ev];
      for (const ce of events.length ? events : [ev]) {
        const p = this.toImage(ce.clientX, ce.clientY);
        stroke.pressure = pressureOf(ce);
        const dx = p.x - stroke.x,
          dy = p.y - stroke.y;
        const dist = Math.hypot(dx, dy);
        // Dabs every ~10% of the brush keep strokes even at any speed.
        const spacing = Math.max(1, this.size * 0.1);
        if (dist < spacing && ['forward-warp', 'push-left'].includes(stroke.tool)) continue;
        const n = Math.max(1, Math.ceil(dist / spacing));
        for (let i = 1; i <= n; i++) {
          const x = stroke.x + (dx * i) / n,
            y = stroke.y + (dy * i) / n;
          this.dab(stroke.tool, x, y, dx / n, dy / n, stroke.pressure);
        }
        stroke.x = p.x;
        stroke.y = p.y;
      }
    });
    const end = () => {
      if (stroke) clearTimeout(stroke.timer);
      stroke = undefined;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => (this.cursor.hidden = true));
    c.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const p = this.toImage(ev.clientX, ev.clientY);
        if (ev.ctrlKey || ev.metaKey || ev.altKey) this.zoomAt(this.zoom * (ev.deltaY < 0 ? 1.25 : 0.8), p.sx, p.sy);
        else {
          this.ox += ev.deltaX / this.zoom;
          this.oy += ev.deltaY / this.zoom;
          this.redraw();
        }
      },
      { passive: false },
    );
  }
  private moveCursor(ev: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const tool = this.activeTool();
    const brush = tool !== 'hand' && tool !== 'zoom';
    this.cursor.hidden = !brush;
    this.canvas.style.cursor = tool === 'hand' ? 'grab' : tool === 'zoom' ? 'zoom-in' : 'none';
    if (!brush) return;
    const dpx = this.size * this.zoom;
    Object.assign(this.cursor.style, { width: `${dpx}px`, height: `${dpx}px`, left: `${ev.clientX - r.left - dpx / 2}px`, top: `${ev.clientY - r.top - dpx / 2}px` });
  }
  private dab(tool: Tool, x: number, y: number, dx: number, dy: number, pressure: number) {
    if (tool === 'freeze' || tool === 'thaw') {
      this.invalidate(this.dabMask(x, y, tool === 'freeze', pressure));
      return;
    }
    if (tool === 'hand' || tool === 'zoom') return;
    const r = this.field.applyBrush(tool, x, y, dx, dy, this.size, pressure, this.density, this.rate, this.freeze);
    this.invalidate(r);
  }
  private key(ev: KeyboardEvent, down: boolean) {
    this.altDown = ev.altKey;
    if (ev.target instanceof HTMLInputElement && ev.target.type !== 'checkbox' && ev.target.type !== 'range') return;
    if (ev.code === 'Space') {
      this.spaceHand = down;
      ev.preventDefault();
      return;
    }
    if (!down) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      this.undo();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === '=' || ev.key === '+' || ev.key === '-')) {
      ev.preventDefault();
      this.zoomAt(this.zoom * (ev.key === '-' ? 0.5 : 2));
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === '0') {
      ev.preventDefault();
      this.fit();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === '[' || ev.key === ']') {
      this.setOpt('size', this.size * (ev.key === ']' ? 1.15 : 1 / 1.15));
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.dialog.querySelector<HTMLButtonElement>('.lq-ok')!.click();
      return;
    }
    const t = toolList.find((x) => x.key === ev.key.toUpperCase());
    if (t) {
      this.tool = t.id;
      this.hint();
      ev.preventDefault();
    }
  }
  private reconstructBase?: { dx: Float32Array; dy: Float32Array };
  /** Keep the reconstruction being previewed (its OK): later edits build on
   * it, so the Amount slider can no longer rewind them. */
  private endReconstruct() {
    if (!this.reconstructBase) return;
    this.reconstructBase = undefined;
    this.dialog.querySelector<HTMLElement>('.lq-reconstruct')!.hidden = true;
  }
  private action(act: string) {
    const box = this.dialog.querySelector<HTMLElement>('.lq-reconstruct')!;
    if (!act.startsWith('reconstruct-') && !act.startsWith('zoom') && act !== 'fit') this.endReconstruct();
    switch (act) {
      case 'reconstruct':
        this.snapshot();
        this.reconstructBase = { dx: new Float32Array(this.field.dx), dy: new Float32Array(this.field.dy) };
        box.hidden = false;
        this.previewReconstruct(Number(this.dialog.querySelector<HTMLInputElement>('#lq-amount')!.value) / 100);
        break;
      case 'reconstruct-ok':
        this.endReconstruct();
        break;
      case 'reconstruct-cancel':
        if (this.reconstructBase) {
          this.field.dx.set(this.reconstructBase.dx);
          this.field.dy.set(this.reconstructBase.dy);
          this.history.pop();
        }
        this.reconstructBase = undefined;
        box.hidden = true;
        this.redraw();
        break;
      case 'restore':
        this.snapshot();
        this.field.dx.fill(0);
        this.field.dy.fill(0);
        this.redraw();
        break;
      case 'mask-none':
        this.snapshot();
        this.freeze = undefined;
        this.redraw();
        break;
      case 'mask-all':
        this.snapshot();
        this.freeze = { width: this.src.width, height: this.src.height, data: new Uint8Array(this.src.width * this.src.height).fill(255) };
        this.redraw();
        break;
      case 'mask-invert':
        this.snapshot();
        if (!this.freeze) this.freeze = { width: this.src.width, height: this.src.height, data: new Uint8Array(this.src.width * this.src.height).fill(255) };
        else for (let i = 0; i < this.freeze.data.length; i++) this.freeze.data[i] = 255 - this.freeze.data[i];
        this.redraw();
        break;
      case 'zoom-in':
        this.zoomAt(this.zoom * 2);
        break;
      case 'zoom-out':
        this.zoomAt(this.zoom / 2);
        break;
      case 'fit':
        this.fit();
        break;
      case 'undo':
        this.undo();
        break;
    }
  }
  /** Reconstruct toward the original by `amount`, sparing frozen areas. */
  private previewReconstruct(amount: number) {
    const base = this.reconstructBase;
    if (!base) return;
    this.field.dx.set(base.dx);
    this.field.dy.set(base.dy);
    let region: Mask8 | undefined;
    if (this.freeze) {
      region = { width: this.freeze.width, height: this.freeze.height, data: new Uint8Array(this.freeze.data.length) };
      for (let i = 0; i < region.data.length; i++) region.data[i] = 255 - this.freeze.data[i];
    }
    this.field.reconstruct(amount, region);
    this.redraw();
  }
}
