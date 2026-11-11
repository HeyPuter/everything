// Wide Angle Correction workspace: a full-screen view where constraint lines
// are drawn along edges that should be straight. Each constraint follows the
// lens model (a curve on the original image) and becomes straight in the
// result, optionally horizontal or vertical. The preview solves and renders a
// reduced copy; OK renders the full image in the filter worker (the operation
// is in the catalog, so it records into actions and works as a Live Filter).
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { readRect } from '../../model/tiles';
import { findLayer } from '../../model/document';
import type { Mask8, NormPath, ParamValues, RGBA8 } from '../../imaging/types';
import { defaults } from '../../imaging/types';
import { cameraFor, fitConstraintArc, focalLengthToPixels, meshMap, renderWideAngle, solveWideAngle, type Vec2, type WideAngleMesh } from '../../imaging/filters/wide-angle';
import { toWideAngleParams } from '../../imaging/filters/wide-angle-op';
import { downscaleImage, fitSize } from '../retouch/logic';
import { applyDirect, closeSession, isLiveLayer, openSession } from './apply';
import { commandId, filterOp, normalizeFor } from './catalog';
import { customDialogs, lastUsed, type DialogOptions } from './dialog';
import { recordStep } from './record';
import { maskToRGBA } from './stack';
import './wide-angle.css';

const OP = 'adaptive-wide-angle';
const COLORS = ['#3d8bfd', '#f5b800', '#2ecc71'];
type Constraint = { a: Vec2; b: Vec2; orient: number };

async function readSource(e: Editor, params: ParamValues, edit?: DialogOptions['edit']): Promise<RGBA8 | undefined> {
  const s = await openSession(e, OP, params, edit);
  if (!s) return;
  try {
    const raw = readRect(e.assets.tiles, s.base, s.rect);
    return s.base.channels === 1 ? maskToRGBA(raw as Mask8) : (raw as RGBA8);
  } finally {
    closeSession(s);
  }
}

async function wideAngleWorkspace(e: Editor, opts: DialogOptions): Promise<boolean> {
  const op = filterOp(OP)!;
  let start: ParamValues;
  if (opts.edit) {
    const l = findLayer(e.doc.layers, opts.edit.layerId);
    const f = isLiveLayer(l) ? l.liveFilters[opts.edit.index] : undefined;
    if (!f) return false;
    start = normalizeFor(OP, f.params);
  } else start = normalizeFor(OP, opts.initial ?? lastUsed.get(OP) ?? defaults(op));
  const src = await readSource(e, start, opts.edit);
  if (!src) return false;
  const [pw, ph] = fitSize(src.width, src.height, 1100);
  const proxy = downscaleImage(src, pw, ph);
  const params = await new Workspace(e, proxy, start).run();
  if (!params) return false;
  const ok = await applyDirect(e, OP, params, opts.edit);
  if (ok && !opts.edit) {
    lastUsed.set(OP, params);
    if (opts.record !== false) recordStep(e, commandId(OP), { params });
  }
  return !!ok;
}

class Workspace {
  private model: string;
  private focal: number;
  private crop: number;
  private scale: number;
  private constraints: Constraint[];
  private selected = -1;
  private preview = true;
  private showConstraints = true;
  private showMesh = false;
  private mesh?: WideAngleMesh;
  private result?: ImageData;
  private source: ImageData;
  private dialog!: HTMLDialogElement;
  private canvas!: HTMLCanvasElement;
  private view = { s: 1, ox: 0, oy: 0 };
  private drag?: { kind: 'new' | 'a' | 'b'; index: number };
  private solveTimer = 0;
  constructor(
    private e: Editor,
    private img: RGBA8,
    start: ParamValues,
  ) {
    this.model = String(start.model);
    this.focal = Number(start.focalLength);
    this.crop = Number(start.cropFactor);
    this.scale = Number(start.scale);
    this.constraints = (start.constraints as NormPath[]).filter((c) => c.length >= 2).map((c) => ({ a: [c[0].x, c[0].y], b: [c[c.length - 1].x, c[c.length - 1].y], orient: c[0].t ?? 0 }));
    this.source = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  }
  params(): ParamValues {
    return {
      model: this.model,
      focalLength: this.focal,
      cropFactor: this.crop,
      scale: this.scale,
      constraints: this.constraints.map((c) => [{ x: c.a[0], y: c.a[1], t: c.orient }, { x: c.b[0], y: c.b[1] }]),
    };
  }
  private camera() {
    return cameraFor({ model: this.model as 'auto', focalLength: this.focal, cropFactor: this.crop }, this.img.width, this.img.height);
  }
  run(): Promise<ParamValues | null> {
    this.build();
    this.solve();
    return new Promise((resolve) => {
      const close = (v: ParamValues | null) => {
        clearTimeout(this.solveTimer);
        window.removeEventListener('resize', this.onResize);
        this.dialog.close();
        this.dialog.remove();
        this.e.update();
        resolve(v);
      };
      this.dialog.querySelector('.wa-cancel')!.addEventListener('click', () => close(null));
      this.dialog.querySelector('.wa-ok')!.addEventListener('click', () => close(this.params()));
      this.dialog.addEventListener('cancel', (ev) => {
        ev.preventDefault();
        close(null);
      });
    });
  }
  private build() {
    const d = document.createElement('dialog');
    d.className = 'liquify-dialog wide-angle-dialog';
    const num = (key: string, label: string, min: number, max: number, step: number, value: number, unit = '') =>
      `<div class="fp-row fp-number"><label for="wa-${key}">${label}</label><input id="wa-${key}" type="number" data-opt="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><span class="fp-unit">${unit}</span></div>`;
    const spherical = Math.abs(this.img.width / this.img.height - 2) < 0.05;
    d.innerHTML = `<div class="lq-head"><h2>Wide Angle Correction</h2><span class="lq-hint" aria-live="polite">Drag along an edge that should be straight. Shift-drag makes it horizontal or vertical. Select a constraint to change or delete it.</span><div class="lq-actions"><button type="button" class="wa-cancel">Cancel</button><button type="button" class="primary wa-ok">OK</button></div></div>
<div class="lq-body">
  <div class="lq-tools" role="toolbar" aria-label="Wide Angle Correction tools"><button type="button" class="icon-button" aria-pressed="true" title="Constraint (C)" aria-label="Constraint tool">${svg('spline', 18)}</button></div>
  <div class="lq-stage wa-stage"><canvas class="lq-canvas wa-canvas"></canvas></div>
  <aside class="lq-props">
    <section><h3>Lens</h3><div class="fp-row"><label for="wa-model">Correction</label><select id="wa-model" data-opt="model">${[['auto', 'Auto'], ['fisheye', 'Fisheye'], ['perspective', 'Perspective'], ['spherical', 'Full Spherical']].map(([v, l]) => `<option value="${v}" ${v === this.model ? 'selected' : ''} ${v === 'spherical' && !spherical ? 'disabled' : ''}>${l}</option>`).join('')}</select></div>
    ${num('focal', 'Focal Length', 1, 200, 0.5, this.focal, 'mm')}${num('crop', 'Crop Factor', 0.1, 10, 0.1, this.crop)}${num('scale', 'Scale', 50, 150, 1, this.scale, '%')}
    ${spherical ? '' : '<p class="hint">Full Spherical needs a 2:1 panorama.</p>'}</section>
    <section><h3>Constraints</h3><div class="wa-list" role="listbox" aria-label="Constraints"></div>
    <div class="lq-row"><label for="wa-orient">Orientation</label><select id="wa-orient"><option value="0">Any</option><option value="1">Horizontal</option><option value="2">Vertical</option></select></div>
    <div class="lq-row"><button type="button" data-act="delete">Delete</button><button type="button" data-act="clear">Remove All</button></div></section>
    <section><h3>View</h3><label class="lq-check"><input type="checkbox" data-view="preview" checked> Preview</label><label class="lq-check"><input type="checkbox" data-view="constraints" checked> Show Constraints</label><label class="lq-check"><input type="checkbox" data-view="mesh"> Show Mesh</label></section>
  </aside>
</div>`;
    document.body.append(d);
    this.dialog = d;
    this.canvas = d.querySelector('.wa-canvas')!;
    d.showModal();
    this.fit();
    window.addEventListener('resize', this.onResize);
    d.querySelector('.lq-props')!.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      const v = t.value.trim() === '' ? NaN : Number(t.value);
      if (t.dataset.view === 'preview') this.preview = t.checked;
      else if (t.dataset.view === 'constraints') this.showConstraints = t.checked;
      else if (t.dataset.view === 'mesh') this.showMesh = t.checked;
      else if (t.id === 'wa-orient') {
        const c = this.constraints[this.selected];
        if (c) c.orient = Number(t.value);
        this.solve();
      } else if (t.dataset.opt === 'model') {
        this.model = t.value;
        this.solve();
      } else if (t.dataset.opt) {
        const clamp = (lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
        if (Number.isFinite(v)) {
          if (t.dataset.opt === 'focal') this.focal = clamp(1, 200);
          else if (t.dataset.opt === 'crop') this.crop = clamp(0.1, 10);
          else if (t.dataset.opt === 'scale') this.scale = clamp(50, 150);
          this.solve();
        }
        // A cleared or out-of-range entry shows the value in use.
        const cur = ({ focal: this.focal, crop: this.crop, scale: this.scale } as Record<string, number>)[t.dataset.opt];
        if (cur !== undefined) t.value = String(cur);
      }
      this.draw();
    });
    d.querySelector('.lq-props')!.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-constraint]');
      if (row) this.select(Number(row.dataset.constraint));
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'delete') this.remove(this.selected);
      else if (act === 'clear') {
        this.constraints = [];
        this.selected = -1;
        this.solve();
      }
    });
    d.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && !(ev.target as HTMLElement).matches('input,select')) {
        ev.preventDefault();
        this.remove(this.selected);
      }
    });
    this.bindCanvas();
    this.list();
  }
  private onResize = () => {
    this.fit();
    this.draw();
  };
  private fit() {
    const stage = this.dialog.querySelector<HTMLElement>('.wa-stage')!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(stage.width * dpr));
    this.canvas.height = Math.max(1, Math.round(stage.height * dpr));
    const s = Math.min((this.canvas.width - 40 * dpr) / this.img.width, (this.canvas.height - 40 * dpr) / this.img.height);
    this.view = { s, ox: (this.canvas.width - this.img.width * s) / 2, oy: (this.canvas.height - this.img.height * s) / 2 };
  }
  // Proxy-pixel coordinates of a pointer event (in the view being shown).
  private viewPoint(ev: PointerEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return [((ev.clientX - r.left) * dpr - this.view.ox) / this.view.s, ((ev.clientY - r.top) * dpr - this.view.oy) / this.view.s];
  }
  /** Shown coordinates (result when previewing) <-> source coordinates (proxy pixels). */
  private toSource(p: Vec2): Vec2 | null {
    if (!this.preview || !this.mesh) return p;
    return meshMap(this.mesh, p[0], p[1], false);
  }
  private toShown(p: Vec2): Vec2 | null {
    if (!this.preview || !this.mesh) return p;
    return meshMap(this.mesh, p[0], p[1], true);
  }
  private norm = (p: Vec2): Vec2 => [Math.min(1, Math.max(0, p[0] / this.img.width)), Math.min(1, Math.max(0, p[1] / this.img.height))];
  private px = (p: Vec2): Vec2 => [p[0] * this.img.width, p[1] * this.img.height];
  private bindCanvas() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => {
      const shown = this.viewPoint(ev);
      const near = (q: Vec2) => {
        const s = this.toShown(this.px(q));
        return s ? Math.hypot(s[0] - shown[0], s[1] - shown[1]) * this.view.s <= 10 * (window.devicePixelRatio || 1) : false;
      };
      // Endpoints of existing constraints can be dragged.
      for (let i = this.constraints.length - 1; i >= 0; i--) {
        const k = this.constraints[i];
        const end = near(k.a) ? 'a' : near(k.b) ? 'b' : undefined;
        if (end) {
          this.select(i);
          this.drag = { kind: end, index: i };
          c.setPointerCapture(ev.pointerId);
          return;
        }
      }
      const hit = this.hitConstraint(shown);
      if (hit >= 0) {
        this.select(hit);
        return;
      }
      const at = this.toSource(shown);
      if (!at || at[0] < 0 || at[1] < 0 || at[0] > this.img.width || at[1] > this.img.height) return;
      const n = this.norm(at);
      this.constraints.push({ a: n, b: n, orient: 0 });
      this.selected = this.constraints.length - 1;
      this.drag = { kind: 'new', index: this.selected };
      c.setPointerCapture(ev.pointerId);
      this.draw();
    });
    c.addEventListener('pointermove', (ev) => {
      const d = this.drag;
      if (!d) return;
      const at = this.toSource(this.viewPoint(ev));
      if (!at) return;
      const k = this.constraints[d.index];
      if (d.kind === 'a') k.a = this.norm(at);
      else k.b = this.norm(at);
      if (d.kind === 'new') k.orient = ev.shiftKey ? (Math.abs(k.b[0] - k.a[0]) * this.img.width >= Math.abs(k.b[1] - k.a[1]) * this.img.height ? 1 : 2) : 0;
      this.draw();
    });
    c.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = undefined;
      if (!d) return;
      const k = this.constraints[d.index];
      // A click without a drag adds nothing.
      if (Math.hypot((k.b[0] - k.a[0]) * this.img.width, (k.b[1] - k.a[1]) * this.img.height) < 4) {
        this.remove(d.index);
        return;
      }
      this.list();
      this.solve();
    });
  }
  private hitConstraint(shown: Vec2) {
    const cam = this.camera();
    const tol = 6 / this.view.s * (window.devicePixelRatio || 1);
    for (let i = this.constraints.length - 1; i >= 0; i--) {
      const k = this.constraints[i];
      const arc = fitConstraintArc(cam, this.px(k.a), this.px(k.b), 24).map((p) => this.toShown(p)).filter((p): p is Vec2 => !!p);
      for (let j = 0; j + 1 < arc.length; j++) {
        const [ax, ay] = arc[j],
          [bx, by] = arc[j + 1];
        const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = l2 ? Math.max(0, Math.min(1, ((shown[0] - ax) * (bx - ax) + (shown[1] - ay) * (by - ay)) / l2)) : 0;
        if (Math.hypot(shown[0] - ax - t * (bx - ax), shown[1] - ay - t * (by - ay)) <= tol) return i;
      }
    }
    return -1;
  }
  private select(i: number) {
    this.selected = i;
    const sel = this.dialog.querySelector<HTMLSelectElement>('#wa-orient')!;
    sel.value = String(this.constraints[i]?.orient ?? 0);
    this.list();
    this.draw();
  }
  private remove(i: number) {
    if (i < 0 || i >= this.constraints.length) return;
    this.constraints.splice(i, 1);
    this.selected = Math.min(this.selected, this.constraints.length - 1);
    this.list();
    this.solve();
  }
  private list() {
    const names = ['Any', 'Horizontal', 'Vertical'];
    this.dialog.querySelector('.wa-list')!.innerHTML = this.constraints.length
      ? this.constraints.map((k, i) => `<div class="wa-item" role="option" data-constraint="${i}" aria-selected="${i === this.selected}"><span class="wa-swatch" style="background:${COLORS[k.orient] ?? COLORS[0]}"></span>Constraint ${i + 1}<span class="wa-orient">${escapeXML(names[k.orient] ?? 'Any')}</span></div>`).join('')
      : '<p class="hint">No constraints yet.</p>';
    const disabled = this.selected < 0;
    this.dialog.querySelector<HTMLSelectElement>('#wa-orient')!.disabled = disabled;
    this.dialog.querySelector<HTMLButtonElement>('[data-act="delete"]')!.disabled = disabled;
  }
  /** Solve and render the reduced preview (debounced while typing). */
  private solve() {
    clearTimeout(this.solveTimer);
    this.solveTimer = window.setTimeout(() => {
      const W = this.img.width,
        H = this.img.height;
      const p = toWideAngleParams(this.params());
      this.mesh = solveWideAngle({
        width: W,
        height: H,
        model: p.model,
        focalPx: focalLengthToPixels(p.focalLength, p.cropFactor, W, H),
        scale: p.scale,
        constraints: p.constraints.map((c) => ({ a: [c.a[0] * W, c.a[1] * H], b: [c.b[0] * W, c.b[1] * H], orient: c.orient })),
        cols: 40,
      });
      const out = renderWideAngle(this.img, this.mesh);
      this.result = new ImageData(new Uint8ClampedArray(out.data), out.width, out.height);
      this.list();
      this.draw();
    }, 30);
    this.draw();
  }
  private draw() {
    const ctx = this.canvas.getContext('2d')!;
    const { s, ox, oy } = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const img = this.preview && this.result ? this.result : this.source;
    const tmp = new OffscreenCanvas(img.width, img.height);
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, ox, oy, img.width * s, img.height * s);
    ctx.setTransform(s, 0, 0, s, ox, oy);
    const dpr = window.devicePixelRatio || 1;
    if (this.showMesh && this.mesh && this.preview) {
      const m = this.mesh,
        nx = m.cols + 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = dpr / s;
      ctx.beginPath();
      for (let r = 0; r <= m.rows; r++)
        for (let c = 0; c < m.cols; c++) {
          const i = r * nx + c;
          ctx.moveTo(m.dst[i * 2], m.dst[i * 2 + 1]);
          ctx.lineTo(m.dst[i * 2 + 2], m.dst[i * 2 + 3]);
        }
      for (let c = 0; c <= m.cols; c++)
        for (let r = 0; r < m.rows; r++) {
          const i = r * nx + c;
          ctx.moveTo(m.dst[i * 2], m.dst[i * 2 + 1]);
          ctx.lineTo(m.dst[(i + nx) * 2], m.dst[(i + nx) * 2 + 1]);
        }
      ctx.stroke();
    }
    if (!this.showConstraints) return;
    const cam = this.camera();
    this.constraints.forEach((k, i) => {
      const arc = fitConstraintArc(cam, this.px(k.a), this.px(k.b), 32).map((p) => this.toShown(p)).filter((p): p is Vec2 => !!p);
      if (arc.length < 2) return;
      const sel = i === this.selected;
      for (const [w, color] of [[(sel ? 4 : 3) * dpr, 'rgba(0,0,0,0.55)'], [(sel ? 2.2 : 1.4) * dpr, COLORS[k.orient] ?? COLORS[0]]] as const) {
        ctx.lineWidth = w / s;
        ctx.strokeStyle = color;
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        arc.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
      for (const p of [arc[0], arc[arc.length - 1]]) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = COLORS[k.orient] ?? COLORS[0];
        ctx.lineWidth = (1.5 * dpr) / s;
        ctx.beginPath();
        ctx.arc(p[0], p[1], ((sel ? 5 : 4) * dpr) / s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    });
  }
}

export function installWideAngle() {
  customDialogs.set(OP, wideAngleWorkspace);
}
