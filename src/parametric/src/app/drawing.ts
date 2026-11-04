// Drawing workspace: a paper sheet with projected views of the part (hidden
// lines dashed), overall dimensions and a title block. Views can be dragged,
// added and removed; the sheet exports to PDF and SVG.

import type { ProjectionResult } from '../kernel/protocol';
import type { DrawingDoc, DrawingView, DrawingViewKind, SheetSize } from '../model/types';
import { UNIT_SYSTEMS, formatNumber } from '../model/units';
import { SHEET_LABELS, STANDARD_SCALES, VIEW_DIRS, VIEW_LABELS, buildSheet, projectedSize, scaleLabel, sheetDims, standardLayout, toPdf, toSvg, type ViewFrame } from '../drawing/sheet';
import { download, safeName } from '../platform/files';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/overlay';
import type { App } from './app';
import { PropertyPanel, checkbox, section, selectField } from './pm';

export class DrawingWorkspace {
  readonly el: HTMLElement;
  private host: HTMLElement;
  private paper: HTMLElement;
  private selBox: HTMLElement;
  active = false;
  selected: string | null = null;
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  private cache = new Map<string, { kind: DrawingViewKind; version: number; result: ProjectionResult }>();
  private frames: ViewFrame[] = [];
  private pending = false;
  /** A refresh was asked for while views were being projected. */
  private refreshAgain = false;
  private layoutPending = false;
  private sheetW = 297;
  private sheetH = 210;

  constructor(private app: App) {
    this.paper = h('div', { class: 'paper', role: 'img', 'aria-label': 'Drawing sheet' });
    this.selBox = h('div', { class: 'view-sel', hidden: true });
    this.host = h('div', { class: 'sheet-host' }, this.paper, this.selBox);
    this.el = h('div', { class: 'drawing-ws', hidden: true, tabindex: '0', 'aria-label': 'Drawing. Drag views to move them, use the wheel to zoom.' }, this.host,
      h('div', { class: 'drawing-empty', hidden: true }, 'There is no solid to draw yet. Build the part in the Model tab first.'));
    app.shell.viewport.append(this.el);
    this.bind();
  }

  get doc(): DrawingDoc | null {
    return this.app.store.doc.drawing ?? null;
  }

  // ---------- lifecycle ----------

  open() {
    if (!this.doc) this.create();
    this.active = true;
    this.el.hidden = false;
    void this.refresh();
    requestAnimationFrame(() => this.fit());
  }

  close() {
    this.layoutPending = false;
    this.refreshAgain = false;
    this.active = false;
    this.el.hidden = true;
  }

  /** Creates a drawing with the standard views laid out on an A4 (or, for inch parts, Letter) sheet. */
  create() {
    const b = this.app.bbox;
    const size: SheetSize = this.app.store.doc.units === 'IPS' ? 'Letter' : 'A4';
    const layout = b ? standardLayout(sheetDims({ sheet: size, landscape: true }), b.min, b.max) : { scale: 1, views: [] };
    // Opened before the first rebuild finished: lay out once the solid exists.
    this.layoutPending = !b;
    this.app.store.change('Create drawing', (d) => {
      d.drawing = {
        sheet: size, landscape: true, scale: layout.scale,
        views: layout.views.map((v, i) => ({ ...v, id: `v${i + 1}` })), title: '', drawnBy: '', notes: '',
      };
    });
  }

  /** Re-lays out the standard views (keeps sheet settings). */
  relayout() {
    const b = this.app.bbox;
    const d = this.doc;
    if (!b || !d) return;
    const layout = standardLayout(sheetDims(d), b.min, b.max);
    this.app.store.change('Arrange views', (doc) => {
      doc.drawing!.scale = layout.scale;
      doc.drawing!.views = layout.views.map((v, i) => ({ ...v, id: `v${i + 1}` }));
    });
  }

  update(fn: (d: DrawingDoc) => void, label = 'Edit drawing') {
    this.app.store.change(label, (doc) => { if (doc.drawing) fn(doc.drawing); });
  }

  // ---------- projections and rendering ----------

  /** Projects missing or outdated views, then renders. */
  async refresh() {
    if (!this.active) return;
    if (this.pending) { this.refreshAgain = true; return; }
    const d = this.doc;
    if (!d) return;
    if (this.layoutPending && this.app.bbox) {
      this.layoutPending = false;
      if (!d.views.length) { this.relayout(); return; }
    }
    const version = this.app.buildVersion;
    const need = d.views.filter((v) => {
      const c = this.cache.get(v.id);
      return !c || c.kind !== v.kind || c.version !== version;
    });
    if (need.length && this.app.bbox) {
      this.pending = true;
      try {
        const res = await this.app.kernel.project(need.map((v) => ({ id: v.id, ...VIEW_DIRS[v.kind] })));
        for (const r of res) {
          const v = need.find((x) => x.id === r.id)!;
          this.cache.set(r.id, { kind: v.kind, version, result: r });
        }
      } catch (e) {
        toast({ kind: 'error', title: 'Could not project the views', message: (e as Error).message });
      } finally {
        this.pending = false;
      }
      // The model or the views may have changed while projecting.
      if (version !== this.app.buildVersion || this.refreshAgain) { this.refreshAgain = false; void this.refresh(); return; }
    }
    this.render();
  }

  private info() {
    const doc = this.app.store.doc;
    const u = UNIT_SYSTEMS[doc.units];
    return {
      partName: doc.name,
      material: doc.material?.name ?? 'Not specified',
      units: u.length,
      date: new Date(doc.modified || Date.now()).toISOString().slice(0, 10),
      formatLength: (mm: number) => formatNumber(mm / u.scale, doc.decimals),
    };
  }

  private sheet() {
    const d = this.doc!;
    const projections = new Map<string, ProjectionResult>();
    for (const v of d.views) {
      const c = this.cache.get(v.id);
      if (c) projections.set(v.id, c.result);
    }
    return buildSheet(d, projections, this.info());
  }

  render() {
    const d = this.doc;
    if (!d || !this.active) return;
    const s = this.sheet();
    this.frames = s.frames;
    this.sheetW = s.w;
    this.sheetH = s.h;
    this.paper.innerHTML = toSvg(s.items, s.w, s.h);
    const svg = this.paper.firstElementChild as SVGSVGElement | null;
    if (svg) {
      svg.setAttribute('width', `${s.w}`);
      svg.setAttribute('height', `${s.h}`);
    }
    this.paper.style.width = `${s.w}px`;
    this.paper.style.height = `${s.h}px`;
    (this.el.querySelector('.drawing-empty') as HTMLElement).hidden = !!this.app.bbox;
    this.applyTransform();
    this.drawSelection();
    this.app.refreshPanel();
  }

  private applyTransform() {
    this.host.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }

  private drawSelection() {
    const f = this.frames.find((x) => x.id === this.selected);
    this.selBox.hidden = !f;
    if (!f) return;
    const pad = 3;
    Object.assign(this.selBox.style, { left: `${f.x0 - pad}px`, top: `${f.y0 - pad}px`, width: `${f.x1 - f.x0 + 2 * pad}px`, height: `${f.y1 - f.y0 + 2 * pad}px` });
  }

  /** Fits the sheet into the visible area. */
  fit() {
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    const m = 24;
    this.zoom = Math.min((r.width - 2 * m) / this.sheetW, (r.height - 2 * m) / this.sheetH);
    this.pan = { x: (r.width - this.sheetW * this.zoom) / 2, y: (r.height - this.sheetH * this.zoom) / 2 };
    this.applyTransform();
  }

  // ---------- interaction ----------

  private toSheet(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.pan.x) / this.zoom, (clientY - r.top - this.pan.y) / this.zoom];
  }

  private viewAt(x: number, y: number): string | null {
    for (const f of [...this.frames].reverse()) if (x >= f.x0 - 3 && x <= f.x1 + 3 && y >= f.y0 - 3 && y <= f.y1 + 3) return f.id;
    return null;
  }

  private bind() {
    let drag: { kind: 'pan' | 'view'; sx: number; sy: number; ox: number; oy: number; id?: string; moved: boolean } | null = null;
    // Two fingers pinch to zoom and pan (touch screens have no wheel).
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; sx: number; sy: number; zoom: number } | null = null;
    const pinchState = () => {
      const [a, b] = [...pointers.values()];
      const r = this.el.getBoundingClientRect();
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        // A second finger ends any drag (closing its undo step) and starts a pinch.
        if (drag?.kind === 'view' && drag.moved) this.app.store.endBatch();
        drag = null;
        if (pointers.size === 2) {
          const p = pinchState();
          pinch = { d: p.d, sx: (p.mx - this.pan.x) / this.zoom, sy: (p.my - this.pan.y) / this.zoom, zoom: this.zoom };
        }
        this.el.setPointerCapture(e.pointerId);
        return;
      }
      this.el.focus({ preventScroll: true });
      const [x, y] = this.toSheet(e.clientX, e.clientY);
      const id = e.button === 0 ? this.viewAt(x, y) : null;
      this.el.setPointerCapture(e.pointerId);
      if (id) {
        const v = this.doc!.views.find((q) => q.id === id)!;
        this.selected = id;
        this.drawSelection();
        this.app.refreshPanel();
        drag = { kind: 'view', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, id, moved: false };
      } else {
        if (e.button === 0 && this.selected) { this.selected = null; this.drawSelection(); this.app.refreshPanel(); }
        drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.pan.x, oy: this.pan.y, moved: false };
      }
    });
    this.el.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch) {
        if (pointers.size < 2) return;
        // Keep the sheet point first under the fingers' midpoint under it.
        const p = pinchState();
        this.zoom = Math.max(0.1, Math.min(40, (pinch.zoom * p.d) / pinch.d));
        this.pan = { x: p.mx - pinch.sx * this.zoom, y: p.my - pinch.sy * this.zoom };
        this.applyTransform();
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved && drag.kind === 'view') this.app.store.beginBatch('Move view');
      drag.moved = true;
      if (drag.kind === 'pan') {
        this.pan = { x: drag.ox + dx, y: drag.oy + dy };
        this.applyTransform();
      } else {
        const id = drag.id!, nx = drag.ox + dx / this.zoom, ny = drag.oy + dy / this.zoom;
        // The change re-renders the sheet (App refreshes the drawing on every document change).
        this.update((d) => { const v = d.views.find((q) => q.id === id); if (v) { v.x = nx; v.y = ny; } }, 'Move view');
      }
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) pinch = null; return; }
      if (drag?.kind === 'view' && drag.moved) this.app.store.endBatch();
      drag = null;
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const f = Math.exp(-Math.max(-0.5, Math.min(0.5, e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))));
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const nz = Math.max(0.1, Math.min(40, this.zoom * f));
      this.pan = { x: mx - ((mx - this.pan.x) * nz) / this.zoom, y: my - ((my - this.pan.y) * nz) / this.zoom };
      this.zoom = nz;
      this.applyTransform();
    }, { passive: false });
    this.el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      const move = (dx: number, dy: number) => {
        const id = this.selected;
        if (!id) return;
        e.preventDefault();
        this.update((d) => { const v = d.views.find((q) => q.id === id); if (v) { v.x += dx; v.y += dy; } }, 'Move view');
      };
      if (e.key === 'ArrowLeft') move(-step, 0);
      else if (e.key === 'ArrowRight') move(step, 0);
      else if (e.key === 'ArrowUp') move(0, -step);
      else if (e.key === 'ArrowDown') move(0, step);
    });
    new ResizeObserver(() => { if (this.active) this.applyTransform(); }).observe(this.el);
  }

  deleteSelected(): boolean {
    const id = this.selected;
    if (!id) return false;
    this.selected = null;
    this.update((d) => { d.views = d.views.filter((v) => v.id !== id); }, 'Delete view');
    return true;
  }

  addView(kind: DrawingViewKind) {
    const d = this.doc;
    const b = this.app.bbox;
    if (!d || !b) return;
    const [w, hh] = projectedSize(kind, b.min, b.max);
    const sheet = sheetDims(d);
    // Place it in the first free spot along the top row.
    let x = 40 + (w * d.scale) / 2, y = 30 + (hh * d.scale) / 2;
    for (let tries = 0; tries < 20 && this.frames.some((f) => x + (w * d.scale) / 2 > f.x0 && x - (w * d.scale) / 2 < f.x1 && y + (hh * d.scale) / 2 > f.y0 && y - (hh * d.scale) / 2 < f.y1); tries++) {
      x += 30;
      if (x > sheet.w - 30) { x = 40; y += 30; }
    }
    let n = d.views.length + 1;
    while (d.views.some((v) => v.id === `v${n}`)) n++;
    const id = `v${n}`;
    this.update((dd) => { dd.views.push({ id, kind, x, y, hidden: kind !== 'isometric', dims: kind !== 'isometric' }); }, 'Add view');
    this.selected = id;
  }

  // ---------- export ----------

  exportPdf() {
    if (!this.doc) return;
    const s = this.sheet();
    download(toPdf(s.items, s.w, s.h, this.app.store.doc.name) as BlobPart, `${safeName(this.app.store.doc.name)}.pdf`, 'application/pdf');
  }

  exportSvg() {
    if (!this.doc) return;
    const s = this.sheet();
    download(toSvg(s.items, s.w, s.h), `${safeName(this.app.store.doc.name)}.svg`, 'image/svg+xml');
  }
}

/** PropertyManager for the drawing: sheet, scale, views and title block. */
export class DrawingPanel extends PropertyPanel {
  title = 'Drawing';
  icon = 'file';
  confirm = false;

  constructor(private app: App, private ws: DrawingWorkspace) {
    super();
    this.closeLabel = 'Back to Model';
    this.onCloseClick = () => app.closeDrawing();
  }

  ok() {
    return true;
  }

  render(): HTMLElement[] {
    const ws = this.ws;
    const d = ws.doc;
    if (!d) return [];
    const sheet = selectField<SheetSize>('Sheet size', d.sheet, (Object.keys(SHEET_LABELS) as SheetSize[]).map((k) => ({ value: k, label: SHEET_LABELS[k] })), (v) => ws.update((x) => { x.sheet = v; }, 'Sheet size'));
    const scales = STANDARD_SCALES.map((s) => ({ value: String(s), label: scaleLabel(s) }));
    if (!scales.some((s) => Number(s.value) === d.scale)) scales.push({ value: String(d.scale), label: scaleLabel(d.scale) });
    const scale = selectField('Scale', String(d.scale), scales, (v) => ws.update((x) => { x.scale = Number(v); }, 'Sheet scale'));
    const views = h('div', { class: 'relations-list' });
    for (const v of d.views) views.append(this.viewRow(v));
    const addSel = h('select', { class: 'input', 'aria-label': 'View to add' }) as HTMLSelectElement;
    for (const k of Object.keys(VIEW_LABELS) as DrawingViewKind[]) addSel.append(h('option', { value: k }, VIEW_LABELS[k]));
    const add = h('button', { class: 'btn small', type: 'button' }, icon('plus', 14), 'Add view');
    add.addEventListener('click', () => ws.addView(addSel.value as DrawingViewKind));
    const field = (label: string, value: string, set: (v: string) => void) => {
      const input = h('input', { class: 'input', value, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('change', () => set(input.value));
      return h('div', {}, h('div', { class: 'field-label' }, label), input);
    };
    return [
      section('Sheet', [
        sheet,
        checkbox('Landscape', d.landscape, (v) => ws.update((x) => { x.landscape = v; }, 'Sheet orientation')),
        scale,
        h('button', { class: 'btn small', type: 'button', onclick: () => ws.relayout() }, icon('reset', 14), 'Arrange standard views'),
      ]),
      section('Views', [views, h('div', { class: 'row' }, h('div', { class: 'grow' }, addSel), add)]),
      section('Title Block', [
        field('Title', d.title || this.app.store.doc.name, (v) => ws.update((x) => { x.title = v; }, 'Title')),
        field('Drawn by', d.drawnBy, (v) => ws.update((x) => { x.drawnBy = v; }, 'Drawn by')),
        field('Notes', d.notes, (v) => ws.update((x) => { x.notes = v; }, 'Notes')),
      ]),
      section('Export', [
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: () => ws.exportPdf() }, icon('download', 14), 'PDF'),
          h('button', { class: 'btn small', type: 'button', onclick: () => ws.exportSvg() }, icon('download', 14), 'SVG')),
      ]),
    ];
  }

  private viewRow(v: DrawingView): HTMLElement {
    const ws = this.ws;
    const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${VIEW_LABELS[v.kind]} view` }, icon('trash', 14));
    del.addEventListener('click', () => { ws.selected = v.id; ws.deleteSelected(); });
    const hidden = h('input', { type: 'checkbox', 'aria-label': `Hidden lines in ${VIEW_LABELS[v.kind]} view` }) as HTMLInputElement;
    hidden.checked = v.hidden;
    hidden.addEventListener('change', () => ws.update((d) => { const x = d.views.find((q) => q.id === v.id); if (x) x.hidden = hidden.checked; }, 'Hidden lines'));
    const dims = h('input', { type: 'checkbox', 'aria-label': `Dimensions in ${VIEW_LABELS[v.kind]} view` }) as HTMLInputElement;
    dims.checked = v.dims;
    dims.addEventListener('change', () => ws.update((d) => { const x = d.views.find((q) => q.id === v.id); if (x) x.dims = dims.checked; }, 'Dimensions'));
    const row = h('div', { class: `rel-btn${ws.selected === v.id ? ' on' : ''}`, style: { cursor: 'default' } },
      h('span', { class: 'grow' }, VIEW_LABELS[v.kind]),
      h('label', { class: 'check', title: 'Hidden lines' }, hidden, h('span', { class: 'field-label' }, 'Hidden')),
      h('label', { class: 'check', title: 'Overall dimensions' }, dims, h('span', { class: 'field-label' }, 'Dims')),
      del);
    return row;
  }
}
