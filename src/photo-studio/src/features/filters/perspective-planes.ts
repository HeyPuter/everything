// Perspective Planes workspace: define flat surfaces seen in perspective by
// four corners, then clone, paint and paste on them so content shrinks and
// skews with the surface. Planes are saved with the document; edits apply to
// the current pixel layer as one history step (limited by the selection).
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { findLayer } from '../../model/document';
import { canvasRect, selectionGrid } from '../../model/selection';
import { readMask, readRGBA, writeRect } from '../../model/tiles';
import type { RGBA8 } from '../../imaging/types';
import {
  cloneMapping,
  extendPlaneTo,
  imageToPlane,
  pasteIntoPlane,
  perspectiveStamp,
  planeDab,
  planeGrid,
  planeHomography,
  planeMetrics,
  planeToImage,
  validQuad,
  type PlaneEdge,
  type Quad,
  type Vec2,
} from '../../imaging/filters/perspective-planes';
import { hexRgb, pixelTarget } from '../pixels';
import { setLayerPixels } from '../../model/pixel-layer';
import { copiedImage } from '../core';
import { limitToCoverage } from '../retouch/logic';
import './perspective-planes.css';

type Tool = 'edit' | 'create' | 'stamp' | 'brush' | 'hand';
const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'edit', label: 'Edit Plane: select and drag corners or edges', key: 'V', icon: 'mouse-pointer-2' },
  { id: 'create', label: 'Create Plane: click four corners', key: 'C', icon: 'plane-create' },
  { id: 'stamp', label: 'Stamp: Alt-click a source, then paint', key: 'S', icon: 'stamp' },
  { id: 'brush', label: 'Brush: paint the foreground color in perspective', key: 'B', icon: 'paintbrush' },
  { id: 'hand', label: 'Hand: drag to pan (or hold Space)', key: 'H', icon: 'hand' },
];
type Rect = { x: number; y: number; width: number; height: number };
type Floating = { img: RGBA8; plane: number; cu: number; cv: number; w: number };

export async function perspectivePlanes(e: Editor) {
  const target = await pixelTarget(e, { allowMask: false });
  if (!target || target.kind !== 'pixels') {
    if (target) e.message('Perspective Planes edits pixel layers.');
    return;
  }
  const area = canvasRect(e.doc);
  const orig = readRGBA(e.assets.tiles, target.grid, area);
  const planes = (e.doc.perspectivePlanes ?? []).map((q) => q.map(([x, y]) => [x, y]) as Quad);
  const result = await new Workspace(e, orig, planes).run();
  if (!result) return;
  const { work, planes: next, changed } = result;
  const planesChanged = JSON.stringify(next) !== JSON.stringify(e.doc.perspectivePlanes ?? []);
  if (!changed && !planesChanged) return;
  const sel = selectionGrid(e.doc, e.assets.tiles);
  const final = changed ? limitToCoverage(orig, work, sel ? readMask(e.assets.tiles, sel, area) : null) : orig;
  const layerId = target.layer.id;
  const grid = changed ? writeRect(e.assets.tiles, target.grid, 0, 0, final) : undefined;
  // Pixels and planes in one step.
  e.command('Perspective Planes', (d) => {
    const l = grid && findLayer(d.layers, layerId);
    if (l && grid) setLayerPixels(l, grid, d);
    if (planesChanged) d.perspectivePlanes = next.length ? next : undefined;
  });
  e.update();
}

class Workspace {
  private tool: Tool = 'create';
  private selected = -1;
  private creating: Vec2[] = [];
  private view = { s: 1, ox: 0, oy: 0 };
  private dialog!: HTMLDialogElement;
  private canvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private full!: OffscreenCanvas;
  private size = 60;
  private hardness = 0.7;
  private opacity = 1;
  private grid = 8;
  private source?: { plane: number; at: Vec2 };
  private anchor?: { plane: number; at: Vec2 };
  private stroke?: { last?: Vec2; mapping?: (x: number, y: number) => Vec2; plane: number; dirty: Rect | null; before: RGBA8 };
  private drag?: { kind: 'corner' | 'edge' | 'plane' | 'pan' | 'paste'; index: number; start: Vec2; quad?: Quad; pan?: Vec2; paste?: Floating };
  private floating?: Floating;
  private undo: { rect: Rect; pixels: RGBA8 }[] = [];
  private changed = false;
  private spaceDown = false;
  private hover?: Vec2;
  private frame = 0;
  constructor(
    private e: Editor,
    private orig: RGBA8,
    private planes: Quad[],
  ) {
    if (planes.length) {
      this.tool = 'edit';
      this.selected = 0;
    }
    this.work = { width: orig.width, height: orig.height, data: new Uint8ClampedArray(orig.data) };
  }
  private work: RGBA8;
  run(): Promise<{ work: RGBA8; planes: Quad[]; changed: boolean } | null> {
    this.build();
    return new Promise((resolve) => {
      const close = (ok: boolean) => {
        if (ok) this.commitPaste();
        window.removeEventListener('resize', this.onResize);
        cancelAnimationFrame(this.frame);
        this.dialog.close();
        this.dialog.remove();
        this.e.update();
        resolve(ok ? { work: this.work, planes: this.planes, changed: this.changed } : null);
      };
      this.dialog.querySelector('.pp-cancel')!.addEventListener('click', () => close(false));
      this.dialog.querySelector('.pp-ok')!.addEventListener('click', () => close(true));
      this.dialog.addEventListener('cancel', (ev) => {
        ev.preventDefault();
        if (this.creating.length) {
          this.creating = [];
          this.draw();
        } else if (this.floating) {
          this.floating = undefined;
          this.sync();
          this.draw();
        } else close(false);
      });
    });
  }
  private build() {
    const d = document.createElement('dialog');
    d.className = 'liquify-dialog perspective-dialog';
    const num = (key: string, label: string, min: number, max: number, value: number, unit = '') =>
      `<div class="fp-row fp-number"><label for="pp-${key}">${label}</label><input id="pp-${key}" type="number" data-opt="${key}" min="${min}" max="${max}" value="${value}"><span class="fp-unit">${unit}</span></div>`;
    d.innerHTML = `<div class="lq-head"><h2>Perspective Planes</h2><span class="lq-hint pp-hint" aria-live="polite"></span><div class="lq-actions"><button type="button" class="pp-cancel">Cancel</button><button type="button" class="primary pp-ok">OK</button></div></div>
<div class="lq-body">
  <div class="lq-tools" role="toolbar" aria-label="Perspective Planes tools">${TOOLS.map((t) => `<button type="button" class="icon-button" data-tool="${t.id}" aria-pressed="${t.id === this.tool}" title="${escapeXML(t.label)} (${t.key})" aria-label="${escapeXML(t.label)}">${svg(t.icon, 18)}</button>`).join('')}</div>
  <div class="lq-stage pp-stage"><canvas class="lq-canvas pp-canvas"></canvas><canvas class="lq-overlay pp-overlay"></canvas></div>
  <aside class="lq-props">
    <section><h3>Planes</h3><div class="pp-list" role="listbox" aria-label="Planes"></div><div class="lq-row"><button type="button" data-act="delete-plane">Delete Plane</button></div>${num('grid', 'Grid Size', 1, 40, this.grid, 'cells')}</section>
    <section><h3>Brush</h3>${num('size', 'Diameter', 1, 2000, this.size, 'px')}${num('hardness', 'Hardness', 0, 100, this.hardness * 100, '%')}${num('opacity', 'Opacity', 1, 100, this.opacity * 100, '%')}</section>
    <section><h3>Paste</h3><p class="hint">Pastes the last copied pixels (Edit → Copy) onto the selected plane; drag to move, adjust the size, then apply.</p><div class="lq-row"><button type="button" data-act="paste">Paste</button><button type="button" data-act="paste-apply" disabled>Apply Paste</button></div>${num('paste-size', 'Size', 1, 100, 50, '%')}</section>
    <section><h3>History</h3><div class="lq-row"><button type="button" data-act="undo" title="Undo the last edit (Mod+Z)">Undo</button></div></section>
  </aside>
</div>`;
    document.body.append(d);
    this.dialog = d;
    this.canvas = d.querySelector('.pp-canvas')!;
    this.overlay = d.querySelector('.pp-overlay')!;
    this.full = new OffscreenCanvas(this.work.width, this.work.height);
    this.full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(this.work.data), this.work.width, this.work.height), 0, 0);
    d.showModal();
    this.fit();
    window.addEventListener('resize', this.onResize);
    d.querySelector('.lq-tools')!.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-tool]');
      if (b) this.setTool(b.dataset.tool as Tool);
    });
    d.querySelector('.lq-props')!.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      // A cleared or invalid entry keeps the value in use.
      const v = t.value.trim() === '' ? NaN : Number(t.value);
      if (Number.isFinite(v)) {
        if (t.dataset.opt === 'size') this.size = Math.max(1, Math.min(2000, v));
        else if (t.dataset.opt === 'hardness') this.hardness = Math.max(0, Math.min(1, v / 100));
        else if (t.dataset.opt === 'opacity') this.opacity = Math.max(0.01, Math.min(1, v / 100));
        else if (t.dataset.opt === 'grid') this.grid = Math.max(1, Math.min(40, Math.round(v)));
        else if (t.dataset.opt === 'paste-size' && this.floating) this.floating.w = Math.max(0.01, Math.min(1, v / 100));
      }
      // Show the value in use (clamped).
      const shown: Record<string, number | undefined> = { size: this.size, hardness: this.hardness * 100, opacity: this.opacity * 100, grid: this.grid, 'paste-size': this.floating && this.floating.w * 100 };
      const cur = shown[t.dataset.opt ?? ''];
      if (cur !== undefined) t.value = String(Math.round(cur));
      else if (t.dataset.opt === 'paste-size') t.value = String(Math.max(1, Math.min(100, Number.isFinite(v) ? Math.round(v) : 50)));
      this.draw();
    });
    d.querySelector('.lq-props')!.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const row = t.closest<HTMLElement>('[data-plane]');
      if (row) {
        this.selected = Number(row.dataset.plane);
        this.sync();
        this.draw();
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'delete-plane') this.deletePlane();
      else if (act === 'paste') this.startPaste();
      else if (act === 'paste-apply') this.commitPaste();
      else if (act === 'undo') this.undoLast();
    });
    d.addEventListener('keydown', (ev) => {
      if ((ev.target as HTMLElement).matches('input,select')) return;
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        this.undoLast();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'v') {
        ev.preventDefault();
        this.startPaste();
        return;
      }
      if (ev.key === ' ') {
        this.spaceDown = true;
        ev.preventDefault();
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.tool === 'edit') {
        ev.preventDefault();
        this.deletePlane();
        return;
      }
      if (ev.key === 'Enter' && this.floating) {
        this.commitPaste();
        return;
      }
      if (ev.code === 'BracketRight' || ev.code === 'BracketLeft') {
        this.size = Math.max(1, Math.min(2000, this.size * (ev.code === 'BracketRight' ? 1.2 : 1 / 1.2)));
        this.dialog.querySelector<HTMLInputElement>('#pp-size')!.value = String(Math.round(this.size));
        this.draw();
        return;
      }
      const t = TOOLS.find((x) => x.key.toLowerCase() === ev.key.toLowerCase());
      if (t && !ev.metaKey && !ev.ctrlKey && !ev.altKey) this.setTool(t.id);
    });
    d.addEventListener('keyup', (ev) => {
      if (ev.key === ' ') this.spaceDown = false;
    });
    this.bindCanvas();
    this.sync();
    this.draw();
  }
  private onResize = () => {
    this.fit();
    this.draw();
  };
  private fit() {
    const r = this.dialog.querySelector<HTMLElement>('.pp-stage')!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    }
    const s = Math.min((this.canvas.width - 40 * dpr) / this.work.width, (this.canvas.height - 40 * dpr) / this.work.height);
    this.view = { s, ox: (this.canvas.width - this.work.width * s) / 2, oy: (this.canvas.height - this.work.height * s) / 2 };
  }
  private setTool(t: Tool) {
    if (t !== 'create') this.creating = [];
    this.tool = t;
    for (const b of this.dialog.querySelectorAll<HTMLElement>('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    this.sync();
    this.draw();
  }
  private docPoint(ev: PointerEvent | WheelEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return [((ev.clientX - r.left) * dpr - this.view.ox) / this.view.s, ((ev.clientY - r.top) * dpr - this.view.oy) / this.view.s];
  }
  private planeAt(p: Vec2): number {
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const [u, v] = imageToPlane(planeHomography(this.planes[i]), p[0], p[1]);
      if (u >= 0 && v >= 0 && u <= 1 && v <= 1) return i;
    }
    return -1;
  }
  private tolerance() {
    return (8 * (window.devicePixelRatio || 1)) / this.view.s;
  }
  private bindCanvas() {
    const c = this.overlay;
    c.style.pointerEvents = 'auto';
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = this.docPoint(ev);
      const k = Math.exp(-ev.deltaY * 0.0015);
      const s = Math.max(0.02, Math.min(16, this.view.s * k));
      this.view = { s, ox: this.view.ox + p[0] * (this.view.s - s), oy: this.view.oy + p[1] * (this.view.s - s) };
      this.draw();
    });
    c.addEventListener('pointerdown', (ev) => {
      c.setPointerCapture(ev.pointerId);
      const p = this.docPoint(ev);
      if (this.tool === 'hand' || this.spaceDown || ev.button === 1) {
        this.drag = { kind: 'pan', index: -1, start: p, pan: [ev.clientX, ev.clientY] };
        return;
      }
      if (this.floating) {
        const f = this.floating;
        const quad = this.pasteQuad(f);
        if (quad && this.inside(quad, p)) {
          this.drag = { kind: 'paste', index: f.plane, start: p, paste: { ...f } };
          return;
        }
      }
      if (this.tool === 'create') return this.addCorner(p);
      if (this.tool === 'edit') return this.editDown(p);
      const plane = this.planeAt(p);
      if (plane < 0) {
        this.hint('Paint inside a plane. Create one with the Create Plane tool (C).');
        return;
      }
      if (this.tool === 'stamp' && ev.altKey) {
        this.source = { plane, at: p };
        this.anchor = undefined;
        this.hint('Source set. Paint on any plane to clone in perspective.');
        this.draw();
        return;
      }
      if (this.tool === 'stamp' && !this.source) {
        this.hint('Alt-click (Option-click) inside a plane to set the stamp source.');
        return;
      }
      this.beginStroke(plane, p);
    });
    c.addEventListener('pointermove', (ev) => {
      const p = this.docPoint(ev);
      this.hover = p;
      const d = this.drag;
      if (d?.kind === 'pan') {
        const dpr = window.devicePixelRatio || 1;
        this.view.ox += (ev.clientX - d.pan![0]) * dpr;
        this.view.oy += (ev.clientY - d.pan![1]) * dpr;
        d.pan = [ev.clientX, ev.clientY];
        this.draw();
        return;
      }
      if (d?.kind === 'corner' && d.quad) {
        const q = d.quad.map((x) => [...x]) as Quad;
        q[d.index % 4] = p;
        if (validQuad(q)) this.planes[this.selected] = q;
        this.draw();
        return;
      }
      if (d?.kind === 'edge' && d.quad) {
        const q = extendPlaneTo(d.quad, (d.index % 4) as PlaneEdge, p[0], p[1]);
        if (validQuad(q)) this.planes[this.selected] = q;
        this.draw();
        return;
      }
      if (d?.kind === 'plane' && d.quad) {
        const dx = p[0] - d.start[0],
          dy = p[1] - d.start[1];
        this.planes[this.selected] = d.quad.map(([x, y]) => [x + dx, y + dy]) as Quad;
        this.draw();
        return;
      }
      if (d?.kind === 'paste' && d.paste && this.floating) {
        const map = planeHomography(this.planes[d.paste.plane]);
        const [u0, v0] = imageToPlane(map, d.start[0], d.start[1]);
        const [u1, v1] = imageToPlane(map, p[0], p[1]);
        this.floating.cu = d.paste.cu + u1 - u0;
        this.floating.cv = d.paste.cv + v1 - v0;
        this.draw();
        return;
      }
      if (this.stroke) for (const q of ev.getCoalescedEvents?.() ?? [ev]) this.strokeTo(this.docPoint(q));
      this.drawOverlaySoon();
    });
    c.addEventListener('pointerup', () => {
      this.drag = undefined;
      if (this.stroke) this.endStroke();
      this.sync();
      this.draw();
    });
    c.addEventListener('pointerleave', () => {
      this.hover = undefined;
      this.drawOverlaySoon();
    });
  }
  private inside(q: Quad, p: Vec2) {
    const [u, v] = imageToPlane(planeHomography(q), p[0], p[1]);
    return u >= 0 && v >= 0 && u <= 1 && v <= 1;
  }
  private addCorner(p: Vec2) {
    this.creating.push(p);
    if (this.creating.length === 4) {
      const q = this.creating.slice() as Quad;
      this.creating = [];
      if (!validQuad(q)) {
        this.hint('Those corners do not make a convex plane. Click four corners in order around the surface.');
      } else {
        this.planes.push(q);
        this.selected = this.planes.length - 1;
        this.setTool('edit');
        this.hint('Plane created. Drag corners to adjust, edges to extend it.');
      }
    }
    this.sync();
    this.draw();
  }
  private editDown(p: Vec2) {
    const tol = this.tolerance();
    const order = this.selected >= 0 ? [this.selected, ...this.planes.map((_, i) => i).filter((i) => i !== this.selected)] : this.planes.map((_, i) => i);
    for (const i of order) {
      const q = this.planes[i];
      const corner = q.findIndex(([x, y]) => Math.hypot(x - p[0], y - p[1]) <= tol);
      if (corner >= 0) {
        this.selected = i;
        this.drag = { kind: 'corner', index: corner, start: p, quad: q.map((x) => [...x]) as Quad };
        this.sync();
        return;
      }
      for (let k = 0; k < 4; k++) {
        const a = q[k],
          b = q[(k + 1) % 4];
        if (Math.hypot((a[0] + b[0]) / 2 - p[0], (a[1] + b[1]) / 2 - p[1]) <= tol) {
          this.selected = i;
          this.drag = { kind: 'edge', index: k, start: p, quad: q.map((x) => [...x]) as Quad };
          this.sync();
          return;
        }
      }
    }
    const hit = this.planeAt(p);
    this.selected = hit;
    if (hit >= 0) this.drag = { kind: 'plane', index: hit, start: p, quad: this.planes[hit].map((x) => [...x]) as Quad };
    this.sync();
    this.draw();
  }
  private deletePlane() {
    if (this.selected < 0) return;
    this.planes.splice(this.selected, 1);
    if (this.source?.plane === this.selected) this.source = undefined;
    this.selected = this.planes.length ? Math.min(this.selected, this.planes.length - 1) : -1;
    this.sync();
    this.draw();
  }
  // ----- painting -----
  private beginStroke(plane: number, p: Vec2) {
    this.stroke = { plane, dirty: null, before: { width: this.work.width, height: this.work.height, data: new Uint8ClampedArray(this.work.data) } };
    if (this.tool === 'stamp' && this.source) {
      // Aligned: the first stroke fixes the offset in plane units; later strokes keep it.
      if (!this.anchor) this.anchor = { plane, at: p };
      const map = cloneMapping(this.planes[this.source.plane], this.source.at, this.planes[this.anchor.plane], this.anchor.at);
      // Strokes on another plane map through that plane at the same position.
      this.stroke.mapping = plane === this.anchor.plane ? map : cloneMapping(this.planes[this.source.plane], map(p[0], p[1]), this.planes[plane], p);
    }
    this.dab(p);
    this.stroke.last = p;
  }
  private strokeTo(p: Vec2) {
    const st = this.stroke!;
    const last = st.last!;
    const quad = this.planes[st.plane];
    const step = Math.max(1, planeDab(quad, p[0], p[1], this.size).mask.width * 0.15);
    const dist = Math.hypot(p[0] - last[0], p[1] - last[1]);
    if (dist < step) return;
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) this.dab([last[0] + ((p[0] - last[0]) * i) / n, last[1] + ((p[1] - last[1]) * i) / n]);
    st.last = p;
  }
  private dab(p: Vec2) {
    const st = this.stroke!;
    const quad = this.planes[st.plane];
    if (!this.inside(quad, p)) return;
    const { mask, x, y } = planeDab(quad, p[0], p[1], this.size, this.hardness);
    // Keep paint on the plane: clear coverage outside it.
    const map = planeHomography(quad);
    for (let j = 0; j < mask.height; j++)
      for (let i = 0; i < mask.width; i++) {
        const k = j * mask.width + i;
        if (!mask.data[k]) continue;
        const [u, v] = imageToPlane(map, x + i + 0.5, y + j + 0.5);
        if (u < 0 || v < 0 || u > 1 || v > 1) mask.data[k] = 0;
      }
    if (this.tool === 'stamp' && st.mapping) perspectiveStamp(this.work, this.orig, st.mapping, mask, x, y, this.opacity * 0.6);
    else if (this.tool === 'brush') {
      const [r, g, b] = hexRgb(this.e.color);
      const d = this.work.data;
      for (let j = 0; j < mask.height; j++) {
        const yy = y + j;
        if (yy < 0 || yy >= this.work.height) continue;
        for (let i = 0; i < mask.width; i++) {
          const xx = x + i;
          const cov = mask.data[j * mask.width + i];
          if (!cov || xx < 0 || xx >= this.work.width) continue;
          const a = (cov / 255) * this.opacity * 0.5;
          const o = (yy * this.work.width + xx) * 4,
            ba = d[o + 3] / 255,
            oa = a + ba * (1 - a);
          d[o] = (r * a + d[o] * ba * (1 - a)) / oa;
          d[o + 1] = (g * a + d[o + 1] * ba * (1 - a)) / oa;
          d[o + 2] = (b * a + d[o + 2] * ba * (1 - a)) / oa;
          d[o + 3] = oa * 255;
        }
      }
    }
    this.touch({ x, y, width: mask.width, height: mask.height });
  }
  private touch(r: Rect) {
    const x0 = Math.max(0, r.x),
      y0 = Math.max(0, r.y),
      x1 = Math.min(this.work.width, r.x + r.width),
      y1 = Math.min(this.work.height, r.y + r.height);
    if (x1 <= x0 || y1 <= y0) return;
    const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    if (this.stroke) {
      const d = this.stroke.dirty;
      this.stroke.dirty = d ? union(d, rect) : rect;
    }
    const img = new ImageData(rect.width, rect.height);
    for (let j = 0; j < rect.height; j++) img.data.set(this.work.data.subarray(((rect.y + j) * this.work.width + rect.x) * 4, ((rect.y + j) * this.work.width + rect.x + rect.width) * 4), j * rect.width * 4);
    this.full.getContext('2d')!.putImageData(img, rect.x, rect.y);
    this.changed = true;
    this.drawSoon();
  }
  private endStroke() {
    const st = this.stroke!;
    this.stroke = undefined;
    if (st.dirty) this.pushUndo(st.dirty, st.before);
  }
  private pushUndo(r: Rect, before: RGBA8) {
    const pixels = new Uint8ClampedArray(r.width * r.height * 4);
    for (let j = 0; j < r.height; j++) pixels.set(before.data.subarray(((r.y + j) * before.width + r.x) * 4, ((r.y + j) * before.width + r.x + r.width) * 4), j * r.width * 4);
    this.undo.push({ rect: r, pixels: { width: r.width, height: r.height, data: pixels } });
    if (this.undo.length > 30) this.undo.shift();
  }
  private undoLast() {
    const u = this.undo.pop();
    if (!u) return;
    for (let j = 0; j < u.rect.height; j++) this.work.data.set(u.pixels.data.subarray(j * u.rect.width * 4, (j + 1) * u.rect.width * 4), ((u.rect.y + j) * this.work.width + u.rect.x) * 4);
    this.touch(u.rect);
    this.changed = this.undo.length > 0 || this.changed;
  }
  // ----- paste -----
  private startPaste() {
    const img = copiedImage();
    if (!img) {
      this.hint('Copy pixels first (Edit → Copy), then paste them onto a plane.');
      return;
    }
    if (this.selected < 0) {
      this.hint('Select a plane to paste onto.');
      return;
    }
    this.commitPaste();
    const w = Number(this.dialog.querySelector<HTMLInputElement>('#pp-paste-size')!.value) / 100 || 0.5;
    this.floating = { img, plane: this.selected, cu: 0.5, cv: 0.5, w };
    this.hint('Drag the pasted image along the plane; change its size, then Apply Paste (Enter).');
    this.sync();
    this.draw();
  }
  /** Quad of the floating paste: a rectangle in plane units keeping the image's aspect. */
  private pasteQuad(f: Floating): Quad | undefined {
    const quad = this.planes[f.plane];
    if (!quad) return;
    const map = planeHomography(quad);
    const { aspect } = planeMetrics(quad, { principal: [this.work.width / 2, this.work.height / 2] });
    const hu = f.w / 2,
      hv = (f.w * aspect) / (f.img.width / Math.max(1, f.img.height)) / 2;
    const corners: Vec2[] = [
      [f.cu - hu, f.cv - hv],
      [f.cu + hu, f.cv - hv],
      [f.cu + hu, f.cv + hv],
      [f.cu - hu, f.cv + hv],
    ];
    return corners.map(([u, v]) => planeToImage(map, u, v)) as Quad;
  }
  private commitPaste() {
    const f = this.floating;
    if (!f) return;
    this.floating = undefined;
    const q = this.pasteQuad(f);
    if (!q || !validQuad(q)) return;
    const xs = q.map((p) => p[0]),
      ys = q.map((p) => p[1]);
    const r = { x: Math.floor(Math.min(...xs)) - 1, y: Math.floor(Math.min(...ys)) - 1, width: 0, height: 0 };
    r.width = Math.ceil(Math.max(...xs)) + 2 - r.x;
    r.height = Math.ceil(Math.max(...ys)) + 2 - r.y;
    const before = { width: this.work.width, height: this.work.height, data: new Uint8ClampedArray(this.work.data) };
    pasteIntoPlane(f.img, q, this.work, { fit: 'fill', opacity: this.opacity });
    const clipped = clip(r, this.work.width, this.work.height);
    if (clipped) {
      this.pushUndo(clipped, before);
      this.touch(clipped);
    }
    this.sync();
  }
  // ----- drawing -----
  private hint(text: string) {
    this.dialog.querySelector('.pp-hint')!.textContent = text;
  }
  private sync() {
    const names = this.planes.map((q, i) => {
      const { aspect } = planeMetrics(q, { principal: [this.work.width / 2, this.work.height / 2] });
      return `<div class="pp-item" role="option" data-plane="${i}" aria-selected="${i === this.selected}">Plane ${i + 1}<span>${aspect >= 1 ? `${aspect.toFixed(2)} : 1` : `1 : ${(1 / aspect).toFixed(2)}`}</span></div>`;
    });
    this.dialog.querySelector('.pp-list')!.innerHTML = names.join('') || '<p class="hint">No planes yet.</p>';
    this.dialog.querySelector<HTMLButtonElement>('[data-act="delete-plane"]')!.disabled = this.selected < 0;
    this.dialog.querySelector<HTMLButtonElement>('[data-act="paste-apply"]')!.disabled = !this.floating;
    this.dialog.querySelector<HTMLButtonElement>('[data-act="undo"]')!.disabled = !this.undo.length;
    if (!this.dialog.querySelector('.pp-hint')!.textContent || this.creating.length === 0) {
      const tips: Record<Tool, string> = {
        create: this.creating.length ? `Click corner ${this.creating.length + 1} of 4.` : 'Click four corners of a flat surface (Escape cancels).',
        edit: 'Drag corners to reshape, edge handles to extend, inside to move. Delete removes the plane.',
        stamp: this.source ? 'Paint to clone in perspective; Alt-click sets a new source.' : 'Alt-click (Option-click) inside a plane to set the stamp source.',
        brush: 'Paint the foreground color; the brush shrinks with distance on the plane.',
        hand: 'Drag to pan; the wheel zooms.',
      };
      if (!this.floating) this.hint(tips[this.tool]);
    }
  }
  private drawSoon() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }
  private drawOverlaySoon() {
    if (this.stroke) return this.drawSoon();
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.drawOverlay());
  }
  private draw() {
    const ctx = this.canvas.getContext('2d')!;
    const { s, ox, oy } = this.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.full, ox, oy, this.work.width * s, this.work.height * s);
    // Floating paste preview at view resolution.
    const f = this.floating;
    const q = f && this.pasteQuad(f);
    if (f && q && validQuad(q)) {
      const vw = this.canvas.width,
        vh = this.canvas.height;
      const vq = q.map(([x, y]) => [x * s + ox, y * s + oy]) as Quad;
      const xs = vq.map((p) => p[0]),
        ys = vq.map((p) => p[1]);
      const r = clip({ x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)), width: Math.ceil(Math.max(...xs) - Math.min(...xs)) + 2, height: Math.ceil(Math.max(...ys) - Math.min(...ys)) + 2 }, vw, vh);
      if (r) {
        const tmp: RGBA8 = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height * 4) };
        pasteIntoPlane(f.img, vq.map(([x, y]) => [x - r.x, y - r.y]) as Quad, tmp, { fit: 'fill', opacity: this.opacity });
        ctx.putImageData(new ImageData(new Uint8ClampedArray(tmp.data), r.width, r.height), r.x, r.y, 0, 0, r.width, r.height);
      }
    }
    this.drawOverlay();
  }
  private drawOverlay() {
    const ctx = this.overlay.getContext('2d')!;
    const { s, ox, oy } = this.view;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(s, 0, 0, s, ox, oy);
    const lw = dpr / s;
    this.planes.forEach((q, i) => {
      const sel = i === this.selected;
      const ok = validQuad(q);
      ctx.lineWidth = lw;
      ctx.strokeStyle = ok ? (sel ? 'rgba(61,139,253,0.9)' : 'rgba(61,139,253,0.5)') : 'rgba(230,60,60,0.9)';
      ctx.beginPath();
      for (const [a, b] of planeGrid(q, this.grid)) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      ctx.lineWidth = 2 * lw;
      ctx.beginPath();
      q.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      if (sel && this.tool === 'edit') {
        const h = 4 * lw;
        ctx.fillStyle = '#fff';
        for (const [x, y] of q) ctx.fillRect(x - h, y - h, 2 * h, 2 * h);
        for (let k = 0; k < 4; k++) {
          const a = q[k],
            b = q[(k + 1) % 4];
          ctx.beginPath();
          ctx.arc((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, h, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    if (this.creating.length) {
      ctx.strokeStyle = '#3d8bfd';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 1.5 * lw;
      ctx.beginPath();
      [...this.creating, ...(this.hover ? [this.hover] : [])].forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      for (const [x, y] of this.creating) ctx.fillRect(x - 3 * lw, y - 3 * lw, 6 * lw, 6 * lw);
    }
    const f = this.floating;
    const fq = f && this.pasteQuad(f);
    if (fq) {
      ctx.setLineDash([4 * lw, 3 * lw]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = lw;
      ctx.beginPath();
      fq.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.source && this.tool === 'stamp') {
      const [x, y] = this.source.at;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * lw;
      ctx.beginPath();
      ctx.arc(x, y, 6 * lw, 0, Math.PI * 2);
      ctx.moveTo(x - 10 * lw, y);
      ctx.lineTo(x + 10 * lw, y);
      ctx.moveTo(x, y - 10 * lw);
      ctx.lineTo(x, y + 10 * lw);
      ctx.stroke();
    }
    // Brush footprint follows the plane under the pointer.
    const p = this.hover;
    if (p && (this.tool === 'stamp' || this.tool === 'brush')) {
      const plane = this.planeAt(p);
      if (plane >= 0) {
        const { mask, x, y } = planeDab(this.planes[plane], p[0], p[1], this.size, 0);
        let rx = 0,
          ry = 0;
        for (let j = 0; j < mask.height; j++) for (let i = 0; i < mask.width; i++) if (mask.data[j * mask.width + i]) {
          rx = Math.max(rx, Math.abs(x + i + 0.5 - p[0]));
          ry = Math.max(ry, Math.abs(y + j + 0.5 - p[1]));
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.ellipse(p[0], p[1], Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function clip(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, r.x),
    y0 = Math.max(0, r.y),
    x1 = Math.min(w, r.x + r.width),
    y1 = Math.min(h, r.y + r.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export function installPerspectivePlanes() {
  registerCommand({
    id: 'filter.vanishing-point',
    label: 'Perspective Planes…',
    shortcut: 'Mod+Alt+V',
    enabled: (e) => e.hasDocument && !!e.layer,
    description: 'Clone, paint and paste on surfaces in perspective.',
    run: (e) => perspectivePlanes(e),
  });
}
