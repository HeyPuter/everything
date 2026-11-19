// Develop masks view: add up to four local adjustments (linear gradient,
// radial gradient, brush), place them by dragging on the preview, and give
// each its own Light and Color sliders. Handles and an optional tint show
// the selected mask over the result.
import { svg } from '../../../app/icons';
import { escapeXML } from '../../../model/assets';
import type { NormPath, ParamValues } from '../../../imaging/types';
import {
  MASK_ADJUST,
  MASK_SLOTS,
  developSpec,
  maskKeys,
  type MaskType,
} from '../../../imaging/filters/develop/params';
import {
  brushRaster,
  gradientRow,
  readMask,
  type Mask,
} from '../../../imaging/filters/develop/masks';
import type { FilterPreview } from '../preview';
import { checkHTML, sliderHTML } from './controls';

type Api = {
  params: () => ParamValues;
  set: (v: ParamValues, done: boolean) => void;
  preview: FilterPreview;
  region: () => { width: number; height: number };
  status: (text: string) => void;
};
const TYPE_LABEL: Record<Exclude<MaskType, 'off'>, string> = {
  linear: 'Linear Gradient',
  radial: 'Radial Gradient',
  brush: 'Brush',
};
const HANDLE = 9;

export class MasksView {
  selected = 0;
  brushSize = 60;
  erase = false;
  showTint = true;
  private drag?:
    | {
        kind: 'move';
        handle: 'a' | 'b' | 'rx' | 'ry' | 'both';
        start: { u: number; v: number };
        from: ParamValues;
      }
    | { kind: 'new'; start: { u: number; v: number } }
    | { kind: 'paint'; stroke: NormPath; base: NormPath[] };
  private tint?: { key: string; canvas: HTMLCanvasElement };
  private cursor: HTMLElement;

  constructor(
    private host: HTMLElement,
    private api: Api,
    view: HTMLElement,
  ) {
    this.cursor = document.createElement('div');
    this.cursor.className = 'dv-brush-cursor';
    this.cursor.hidden = true;
    view.append(this.cursor);
    host.addEventListener('click', (ev) => this.click(ev));
    host.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.classList.contains('dv-brush-size')) {
        this.brushSize = Number(t.value);
        host.querySelector<HTMLElement>('.dv-brush-size-value')!.textContent =
          `${this.brushSize} px`;
      }
      if (t.classList.contains('dv-mask-tint')) {
        this.showTint = t.checked;
        this.api.preview.draw();
      }
      if (t.classList.contains('dv-brush-erase')) this.erase = t.checked;
    });
  }
  private mask(n = this.selected): Mask | undefined {
    return n ? readMask(this.api.params(), n) : undefined;
  }
  get editing() {
    return !this.host.hidden && !!this.mask();
  }

  render() {
    const p = this.api.params();
    const used = Array.from({ length: MASK_SLOTS }, (_, i) => i + 1).filter((n) => readMask(p, n));
    if (this.selected && !used.includes(this.selected)) this.selected = used[0] ?? 0;
    const full = used.length >= MASK_SLOTS;
    const add = (t: Exclude<MaskType, 'off'>, icon: string) =>
      `<button type="button" data-mask-add="${t}" ${full ? 'disabled title="Up to four masks"' : `title="Add a ${TYPE_LABEL[t].toLowerCase()} mask"`}>${svg(icon, 14)} ${t === 'brush' ? 'Brush' : t === 'linear' ? 'Linear' : 'Radial'}</button>`;
    const m = this.mask();
    const on = p.masksOn !== false;
    let editor = '';
    if (m) {
      const n = m.n,
        k = (s: string) => `mask${n}${s}`;
      editor = `<div class="dv-mask-editor"><h4>${escapeXML(`Mask ${n}: ${TYPE_LABEL[m.type]}`)}</h4>
<p class="dv-note">${m.type === 'brush' ? 'Paint on the preview; hold Alt to erase.' : m.type === 'linear' ? 'Drag on the preview from where the effect is full to where it ends; drag the handles to adjust.' : 'Drag on the preview from the center outward; drag the handles to adjust; Shift keeps it round.'}</p>
<label class="dv-check"><input type="checkbox" class="dv-mask-tint" ${this.showTint ? 'checked' : ''}> Show mask overlay</label>
${
  m.type === 'brush'
    ? `<div class="dv-slider"><div class="dv-slider-head"><label for="dv-brush-size">Brush size</label><span class="dv-brush-size-value">${this.brushSize} px</span></div><input type="range" id="dv-brush-size" class="dv-range dv-brush-size" min="2" max="600" step="1" value="${this.brushSize}"></div><label class="dv-check"><input type="checkbox" class="dv-brush-erase" ${this.erase ? 'checked' : ''}> Erase</label><button type="button" class="dv-mask-clear">Clear Strokes</button>`
    : ''
}
${checkHTML(k('Invert'), 'Invert')}${sliderHTML(k('Feather'), { label: 'Feather' })}${sliderHTML(k('Amount'), { label: 'Amount' })}
<h4>Adjustments</h4>${MASK_ADJUST.map(([s, label]) => sliderHTML(k(s), { label, track: s === 'Temperature' ? 'linear-gradient(90deg, #3f7fe0, #d8d8d8, #e8b830)' : s === 'Tint' ? 'linear-gradient(90deg, #3fae4a, #d8d8d8, #c84cc8)' : undefined })).join('')}</div>`;
    }
    this.host.innerHTML = `<div class="dv-masks-head"><h3>Masks</h3><button type="button" class="icon-button dv-eye" data-eye="masks" aria-pressed="${on}" title="Show or hide the mask adjustments" aria-label="Masks effect">${svg(on ? 'eye' : 'eye-off', 15)}</button></div>
<div class="dv-mask-add" role="group" aria-label="Add a mask">${add('linear', 'gradient')}${add('radial', 'circle-dashed')}${add('brush', 'brush')}</div>
${used.length ? `<ul class="dv-mask-list">${used.map((n) => `<li><button type="button" data-mask-select="${n}" aria-pressed="${n === this.selected}">${escapeXML(`Mask ${n}`)} <small>${TYPE_LABEL[readMask(p, n)!.type]}</small></button><button type="button" class="icon-button" data-mask-delete="${n}" title="Delete mask ${n}" aria-label="Delete mask ${n}">${svg('trash-2', 14)}</button></li>`).join('')}</ul>` : '<p class="dv-note">Masks limit adjustments to part of the image.</p>'}
${editor}`;
  }

  private click(ev: MouseEvent) {
    const t = ev.target as HTMLElement;
    const add = t.closest<HTMLElement>('[data-mask-add]');
    if (add) return this.add(add.dataset.maskAdd as Exclude<MaskType, 'off'>);
    const sel = t.closest<HTMLElement>('[data-mask-select]');
    if (sel) {
      this.selected = Number(sel.dataset.maskSelect);
      this.render();
      this.api.set({}, false);
      this.api.preview.draw();
      return;
    }
    const del = t.closest<HTMLElement>('[data-mask-delete]');
    if (del) {
      const n = Number(del.dataset.maskDelete);
      const reset: ParamValues = {};
      for (const key of maskKeys(n)) {
        const s = developSpec(key)!;
        reset[key] = Array.isArray(s.default) ? [] : (s.default as ParamValues[string]);
      }
      if (this.selected === n) this.selected = 0;
      this.api.set(reset, true);
      this.render();
      return;
    }
    if (t.closest('.dv-mask-clear') && this.selected)
      this.api.set({ [`mask${this.selected}Strokes`]: [] }, true);
  }
  private add(type: Exclude<MaskType, 'off'>) {
    const p = this.api.params();
    let n = 0;
    for (let i = 1; i <= MASK_SLOTS && !n; i++) if (!readMask(p, i)) n = i;
    if (!n) return;
    const k = (s: string) => `mask${n}${s}`;
    const geo =
      type === 'linear'
        ? { Ax: 0.5, Ay: 0.2, Bx: 0.5, By: 0.6 }
        : type === 'radial'
          ? { Ax: 0.5, Ay: 0.5, Bx: 0.75, By: 0.75 }
          : { Ax: 0.5, Ay: 0.5, Bx: 0.5, By: 0.5 };
    const v: ParamValues = {
      [k('Type')]: type,
      [k('Strokes')]: [],
      [k('Feather')]: 50,
      [k('Amount')]: 100,
      [k('Invert')]: false,
      masksOn: true,
    };
    for (const [s, val] of Object.entries(geo)) v[k(s)] = val;
    for (const [s] of MASK_ADJUST) v[k(s)] = 0;
    this.selected = n;
    this.showTint = true;
    this.api.set(v, true);
    this.render();
    this.api.status(
      type === 'brush'
        ? 'Paint on the preview to make the mask.'
        : 'Drag on the preview to place the mask, then adjust its sliders.',
    );
  }

  // ---------- Pane ----------
  /** Region-normalized point under the pointer and the pane mapping. */
  private norm(ev: PointerEvent) {
    const pt = this.api.preview.regionPoint(ev.clientX, ev.clientY);
    const R = this.api.region();
    return { u: pt.x / R.width, v: pt.y / R.height, after: pt.after };
  }
  private toPane(u: number, v: number, origin: number) {
    const pv = this.api.preview,
      vr = pv.viewRect(),
      R = this.api.region();
    return { x: origin + (u * R.width - vr.x) * pv.zoom, y: (v * R.height - vr.y) * pv.zoom };
  }
  private paneScale() {
    const pane = this.api.preview.size.w,
      r = (
        this.host.ownerDocument.querySelector('.dv-pane') as HTMLElement | null
      )?.getBoundingClientRect();
    return r ? pane / Math.max(1, r.width) : 1;
  }
  /** Handle a pane pointer event; true when the masks took it. */
  pointer(ev: PointerEvent, phase: 'down' | 'move' | 'up' | 'hover'): boolean {
    const m = this.mask();
    if (!this.editing || !m) {
      this.cursor.hidden = true;
      return false;
    }
    if (m.type === 'brush') this.moveCursor(ev);
    if (phase === 'hover') return false;
    const q = this.norm(ev);
    const k = (s: string) => `mask${m.n}${s}`;
    if (phase === 'down') {
      if (m.type === 'brush') {
        const long = Math.max(this.api.region().width, this.api.region().height);
        const t = (this.brushSize / 2 / long) * (this.erase || ev.altKey ? -1 : 1);
        const stroke: NormPath = [{ x: clamp(q.u), y: clamp(q.v), t }];
        this.drag = { kind: 'paint', stroke, base: m.strokes };
        this.api.set({ [k('Strokes')]: [...m.strokes, stroke] }, false);
        return true;
      }
      const handle = this.hit(m, ev);
      this.drag = handle
        ? { kind: 'move', handle, start: q, from: { ...this.api.params() } }
        : { kind: 'new', start: q };
      return true;
    }
    const d = this.drag;
    if (!d) return true;
    const done = phase === 'up';
    if (d.kind === 'paint') {
      const last = d.stroke[d.stroke.length - 1];
      const R = this.api.region();
      if (
        Math.hypot((q.u - last.x) * R.width, (q.v - last.y) * R.height) * this.api.preview.zoom >=
        2
      )
        d.stroke.push({ x: clamp(q.u), y: clamp(q.v), t: last.t });
      this.api.set({ [k('Strokes')]: [...d.base, d.stroke.slice()] }, done);
    } else if (d.kind === 'new') {
      if (m.type === 'linear')
        this.api.set(
          {
            [k('Ax')]: clamp(d.start.u),
            [k('Ay')]: clamp(d.start.v),
            [k('Bx')]: clamp(q.u),
            [k('By')]: clamp(q.v),
          },
          done,
        );
      else {
        let rx = Math.abs(q.u - d.start.u),
          ry = Math.abs(q.v - d.start.v);
        if (ev.shiftKey) {
          // Round in image pixels.
          const R = this.api.region();
          const r = Math.max(rx * R.width, ry * R.height);
          rx = r / R.width;
          ry = r / R.height;
        }
        if (rx < 0.005 && ry < 0.005 && !done) return true;
        this.api.set(
          {
            [k('Ax')]: clamp(d.start.u),
            [k('Ay')]: clamp(d.start.v),
            [k('Bx')]: clamp(d.start.u + Math.max(0.006, rx)),
            [k('By')]: clamp(d.start.v + Math.max(0.006, ry)),
          },
          done,
        );
      }
    } else {
      const du = q.u - d.start.u,
        dv = q.v - d.start.v,
        f = d.from;
      const g = (s: string) => Number(f[k(s)]);
      const v: ParamValues = {};
      if (d.handle === 'a' || d.handle === 'both') {
        v[k('Ax')] = clamp(g('Ax') + du);
        v[k('Ay')] = clamp(g('Ay') + dv);
      }
      // Moving a radial mask's center moves the whole ellipse.
      if (d.handle === 'b' || d.handle === 'both' || (m.type === 'radial' && d.handle === 'a')) {
        v[k('Bx')] = clamp(g('Bx') + du);
        v[k('By')] = clamp(g('By') + dv);
      }
      if (d.handle === 'rx') v[k('Bx')] = clamp(g('Bx') + du);
      if (d.handle === 'ry') v[k('By')] = clamp(g('By') + dv);
      this.api.set(v, done);
    }
    if (done) this.drag = undefined;
    return true;
  }
  private moveCursor(ev: PointerEvent) {
    const view = this.cursor.parentElement!.getBoundingClientRect();
    const d = (this.brushSize * this.api.preview.zoom) / this.paneScale();
    Object.assign(this.cursor.style, {
      width: `${d}px`,
      height: `${d}px`,
      left: `${ev.clientX - view.left - d / 2}px`,
      top: `${ev.clientY - view.top - d / 2}px`,
    });
    this.cursor.classList.toggle('erase', this.erase || ev.altKey);
    this.cursor.hidden = false;
  }
  hideCursor() {
    this.cursor.hidden = true;
  }
  private handles(m: Mask, origin: number): Record<string, { x: number; y: number }> {
    const a = this.toPane(m.ax, m.ay, origin),
      b = this.toPane(m.bx, m.by, origin);
    if (m.type === 'linear') return { a, b, both: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    const rx = this.toPane(m.ax + Math.abs(m.bx - m.ax), m.ay, origin),
      ry = this.toPane(m.ax, m.ay + Math.abs(m.by - m.ay), origin);
    return { a, rx, ry };
  }
  private lastOrigin = 0;
  private hit(m: Mask, ev: PointerEvent): 'a' | 'b' | 'rx' | 'ry' | 'both' | undefined {
    const pane = this.host.ownerDocument.querySelector<HTMLCanvasElement>('.dv-pane')!;
    const r = pane.getBoundingClientRect(),
      s = pane.width / Math.max(1, r.width);
    const x = (ev.clientX - r.left) * s,
      y = (ev.clientY - r.top) * s;
    const hs = this.handles(m, this.lastOrigin);
    let best: string | undefined,
      bd = HANDLE * 1.6 * s;
    for (const [name, p] of Object.entries(hs)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = name;
      }
    }
    return best as 'a' | 'b' | 'rx' | 'ry' | 'both' | undefined;
  }

  overlay(
    ctx: CanvasRenderingContext2D,
    h: number,
    after: { x: number; width: number; origin: number },
  ) {
    this.lastOrigin = after.origin;
    const m = this.mask();
    if (!this.editing || !m || after.width <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(after.x, 0, after.width, h);
    ctx.clip();
    if (this.showTint) this.drawTint(ctx, m, after.origin);
    if (m.type !== 'brush') {
      const hs = this.handles(m, after.origin);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 2;
      if (m.type === 'linear') {
        const { a, b } = hs;
        // Lines across the gradient at its start and end.
        const dx = b.x - a.x,
          dy = b.y - a.y,
          len = Math.max(1, Math.hypot(dx, dy)),
          nx = (-dy / len) * 4000,
          ny = (dx / len) * 4000;
        ctx.beginPath();
        for (const p of [a, b]) {
          ctx.moveTo(p.x - nx, p.y - ny);
          ctx.lineTo(p.x + nx, p.y + ny);
        }
        ctx.stroke();
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        const { a, rx, ry } = hs;
        const ex = Math.abs(rx.x - a.x),
          ey = Math.abs(ry.y - a.y);
        ctx.beginPath();
        ctx.ellipse(a.x, a.y, Math.max(1, ex), Math.max(1, ey), 0, 0, Math.PI * 2);
        ctx.stroke();
        const inner = 1 - Math.max(0.02, m.feather);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.ellipse(a.x, a.y, Math.max(1, ex * inner), Math.max(1, ey * inner), 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.shadowBlur = 0;
      for (const [name, p] of Object.entries(hs)) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, name === 'both' ? 4 : 5, 0, Math.PI * 2);
        ctx.fillStyle = name === 'a' ? '#3d8bfd' : '#fff';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  private drawTint(ctx: CanvasRenderingContext2D, m: Mask, origin: number) {
    const R = this.api.region();
    const s = Math.min(1, 512 / Math.max(R.width, R.height));
    const w = Math.max(1, Math.round(R.width * s)),
      h = Math.max(1, Math.round(R.height * s));
    const key = JSON.stringify(m) + w;
    if (this.tint?.key !== key) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      const img = g.createImageData(w, h);
      const raster = m.type === 'brush' ? brushRaster(m, w, h) : undefined;
      const row = new Float32Array(w);
      for (let y = 0; y < h; y++) {
        if (!raster) gradientRow(m, y, w, h, row);
        for (let x = 0; x < w; x++) {
          let v = raster ? raster[y * w + x] / 255 : row[x];
          if (m.invert) v = 1 - v;
          v *= m.amount;
          const o = (y * w + x) * 4;
          img.data[o] = 255;
          img.data[o + 1] = 40;
          img.data[o + 2] = 40;
          img.data[o + 3] = Math.round(v * 120);
        }
      }
      g.putImageData(img, 0, 0);
      this.tint = { key, canvas: c };
    }
    const pv = this.api.preview,
      vr = pv.viewRect();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.tint.canvas,
      origin - vr.x * pv.zoom,
      -vr.y * pv.zoom,
      R.width * pv.zoom,
      R.height * pv.zoom,
    );
  }
}
const clamp = (v: number) => Math.min(1, Math.max(0, v));
