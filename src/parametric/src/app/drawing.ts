// Drawing workspace: a paper sheet with projected views of the part (hidden
// lines dashed), overall dimensions and a title block. Views can be dragged,
// added and removed; the sheet exports to PDF and SVG.

import type { ProjectionResult } from '../kernel/protocol';
import type { DrawingDoc, DrawingView, DrawingViewKind, SheetSize } from '../model/types';
import { UNIT_SYSTEMS, formatNumber } from '../model/units';
import { DIM_BELOW, DIM_LEFT, MARGIN, SHEET_LABELS, STANDARD_SCALES, VIEW_DIRS, VIEW_LABELS, buildSheet, placeView, projectedSize, scaleLabel, sheetDims, standardLayout, toPdf, toSvg, type ViewFrame } from '../drawing/sheet';
import { download, safeName } from '../platform/files';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/overlay';
import type { App } from './app';
import { PropertyPanel, checkbox, section, selectField } from './pm';

/** YYYY-MM-DD in the user's time zone (toISOString gives the UTC day, a day off in the evening or morning). */
function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  /** What the drawing PropertyManager shows, to rebuild it only when that changes. */
  private panelKey = '';
  private panelChanging = false;
  private layoutPending = false;
  private sheetW = 297;
  private sheetH = 210;

  constructor(private app: App) {
    this.paper = h('div', { class: 'paper', role: 'img', 'aria-label': 'Drawing sheet' });
    this.selBox = h('div', { class: 'view-sel', hidden: true });
    this.host = h('div', { class: 'sheet-host' }, this.paper, this.selBox);
    this.el = h('div', { class: 'drawing-ws', hidden: true, tabindex: '0', 'aria-label': 'Drawing. Drag views to move them, use the wheel or plus and minus to zoom. Arrow keys move the selected view, or else the sheet, and Delete removes the view.' }, this.host,
      h('div', { class: 'drawing-empty', hidden: true }, 'There is no solid to draw yet. Build the part in the Model tab first.'));
    app.shell.viewport.append(this.el);
    this.bind();
    // A drawing made before the part had a solid is laid out when the solid exists, even
    // if the drawing was left meanwhile; not once another document replaced that part.
    app.store.on((reason) => { if (reason === 'load') this.layoutPending = false; });
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
    this.refreshAgain = false;
    this.panelKey = '';
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
    // Only looking at the drawing does not edit the part: it is neither marked edited nor
    // given an undo step until the drawing is changed (and is saved with the part from then).
    const drawing: DrawingDoc = {
      sheet: size, landscape: true, scale: layout.scale,
      views: layout.views.map((v, i) => ({ ...v, id: `v${i + 1}` })), title: '', drawnBy: '', notes: '',
    };
    this.app.store.doc.drawing = drawing;
    this.untouched = JSON.stringify(drawing);
  }

  /** The drawing as created, until it is changed. */
  private untouched = '';

  /** Re-lays out the standard views (keeps sheet settings). */
  relayout() {
    const b = this.app.bbox;
    const d = this.doc;
    if (!b || !d) return;
    const layout = standardLayout(sheetDims(d), b.min, b.max);
    const arrange = (x: DrawingDoc) => {
      x.scale = layout.scale;
      x.views = layout.views.map((v, i) => ({ ...v, id: `v${i + 1}` }));
    };
    // A drawing nobody changed yet is still not an edit of the part.
    if (JSON.stringify(d) === this.untouched) {
      arrange(d);
      this.untouched = JSON.stringify(d);
      void this.refresh();
    } else this.app.store.change('Arrange views', (doc) => arrange(doc.drawing!));
  }

  update(fn: (d: DrawingDoc) => void, label = 'Edit drawing') {
    this.app.store.change(label, (doc) => { if (doc.drawing) fn(doc.drawing); });
  }

  /**
   * A change made with a control of the drawing PropertyManager, which already
   * shows it: the panel is not rebuilt, so focus stays (Tab moves on normally).
   */
  updateFromPanel(fn: (d: DrawingDoc) => void, label: string) {
    this.panelChanging = true;
    try {
      this.update(fn, label);
    } finally {
      this.panelChanging = false;
    }
  }

  /** Rebuilds the PropertyManager if what it shows changed (not when a view only moved). */
  private syncPanel() {
    const d = this.doc;
    const key = d ? JSON.stringify([this.selected, this.app.store.doc.name, d.sheet, d.landscape, d.scale, d.title, d.drawnBy, d.notes, d.views.map((v) => [v.id, v.kind, v.hidden, v.dims])]) : '';
    if (key === this.panelKey) return;
    this.panelKey = key;
    if (this.panelChanging) return;
    // Keyboard focus in the panel stays on the same control in the rebuilt one; from a
    // deleted view's row it moves to the row that took its place, else the one above, else Add view.
    const body = this.app.shell.lpBody;
    const was = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement : null;
    const name = (el: Element) => el.getAttribute('aria-label') ?? el.textContent;
    const row = was ? [...body.querySelectorAll('.relations-list > *')].findIndex((r) => r.contains(was)) : -1;
    this.app.refreshPanel();
    if (!was || was.isConnected) return;
    const rows = body.querySelectorAll('.relations-list > *');
    const controls = [...body.querySelectorAll<HTMLElement>('button, input, select')];
    const same = controls.find((el) => name(el) === name(was));
    const near = row >= 0 ? rows[Math.min(row, rows.length - 1)]?.querySelector<HTMLElement>('button[aria-label^="Delete"]') ?? controls.find((el) => name(el) === 'Add view') : null;
    (same ?? near ?? body.querySelector<HTMLElement>('.pm-head .title'))?.focus();
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
      date: localDate(doc.modified || Date.now()),
      formatLength: (mm: number) => formatNumber(mm / u.scale, doc.decimals),
    };
  }

  private sheet() {
    const d = this.doc!;
    const projections = new Map<string, ProjectionResult>();
    for (const v of d.views) {
      const c = this.cache.get(v.id);
      if (this.app.bbox && c?.version === this.app.buildVersion && c.kind === v.kind) projections.set(v.id, c.result);
    }
    return buildSheet(d, projections, this.info());
  }

  render() {
    const d = this.doc;
    if (!d || !this.active) return;
    const s = this.sheet();
    this.frames = s.frames;
    // A new sheet size or orientation is refitted, or only part of it shows.
    const resized = s.w !== this.sheetW || s.h !== this.sheetH;
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
    if (resized) this.fit();
    else this.applyTransform();
    this.drawSelection();
    this.syncPanel();
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

  /** Zooms the sheet by f about the middle of the view. */
  zoomBy(f: number) {
    const r = this.el.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    const nz = Math.max(0.1, Math.min(40, this.zoom * f));
    this.pan = { x: mx - ((mx - this.pan.x) * nz) / this.zoom, y: my - ((my - this.pan.y) * nz) / this.zoom };
    this.zoom = nz;
    this.applyTransform();
  }

  /** Fits the sheet into the visible area. */
  fit() {
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    // The document's sheet, which the views being projected may not have rendered yet.
    if (this.doc) ({ w: this.sheetW, h: this.sheetH } = sheetDims(this.doc));
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
        this.syncPanel();
        drag = { kind: 'view', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, id, moved: false };
      } else {
        if (e.button === 0 && this.selected) { this.selected = null; this.drawSelection(); this.syncPanel(); }
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
      if (!drag.moved && drag.kind === 'view') this.app.store.beginBatch('Move view', () => { drag = null; });
      drag.moved = true;
      if (drag.kind === 'pan') {
        this.pan = { x: drag.ox + dx, y: drag.oy + dy };
        this.applyTransform();
      } else {
        const id = drag.id!;
        const [nx, ny] = this.onSheet(id, drag.ox + dx / this.zoom, drag.oy + dy / this.zoom);
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
    this.el.addEventListener('lostpointercapture', end);
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
    // A held arrow key is one undo step: its auto-repeats join the step of the first press
    // (one step each filled the bounded history within seconds and dropped older steps).
    let nudge: { id: string; mark: number; last: number } | null = null;
    this.el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      const move = (dx: number, dy: number) => {
        const id = this.selected;
        if (!id) return;
        e.preventDefault();
        const store = this.app.store;
        const join = e.repeat && nudge?.id === id && nudge.last === store.undoMark ? nudge : null;
        const mark = join ? join.mark : store.undoMark;
        const v = this.doc?.views.find((q) => q.id === id);
        if (!v) return;
        // Held against the edge of the sheet: nothing to move (and no empty undo step).
        const [nx, ny] = this.onSheet(id, v.x + dx, v.y + dy);
        if (nx === v.x && ny === v.y) return;
        this.update((d) => { const q = d.views.find((x) => x.id === id); if (q) { q.x = nx; q.y = ny; } }, 'Move view');
        if (join) store.squash(mark, 'Move view');
        nudge = { id, mark, last: store.undoMark };
      };
      const pan = (dx: number, dy: number) => {
        e.preventDefault();
        this.pan = { x: this.pan.x + dx, y: this.pan.y + dy };
        this.applyTransform();
      };
      // Arrow keys move the selected view, else the sheet; + and - zoom it (as the wheel does).
      const d = this.selected ? null : 40 * (e.shiftKey ? 4 : 1);
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === 'ArrowLeft') d ? pan(d, 0) : move(-step, 0);
      else if (e.key === 'ArrowRight') d ? pan(-d, 0) : move(step, 0);
      else if (e.key === 'ArrowUp') d ? pan(0, d) : move(0, -step);
      else if (e.key === 'ArrowDown') d ? pan(0, -d) : move(0, step);
      else if (plain && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.zoomBy(1.25); }
      else if (plain && (e.key === '-' || e.key === '_')) { e.preventDefault(); this.zoomBy(0.8); }
    });
    new ResizeObserver(() => { if (this.active) this.applyTransform(); }).observe(this.el);
  }

  /**
   * Where a view moved to (x, y) stays: with its dimensions inside the sheet's border, where it
   * shows and is exported (the sheet clips what lies off it, so a view
   * dragged off could not be seen or found again). A view larger than the
   * border slides until its edges reach it.
   */
  private onSheet(id: string, x: number, y: number, d = this.doc, k = 1): [number, number] {
    const v = d?.views.find((q) => q.id === id);
    if (!d || !v) return [x, y];
    const { w, h } = sheetDims(d);
    // The view's reach from its centre (none while it is still being projected), at k times the scale drawn.
    const f = this.frames.find((q) => q.id === id);
    const [l, r, t, b] = f ? [v.x - f.x0, f.x1 - v.x, v.y - f.y0, f.y1 - v.y].map((q) => q * k) : [0, 0, 0, 0];
    // Its dimensions, left of and below it, stay on the sheet too.
    const [dl, db] = v.dims && v.kind !== 'isometric' ? [DIM_LEFT, DIM_BELOW] : [0, 0];
    const fit = (c: number, lo: number, hi: number) => Math.min(Math.max(c, Math.min(lo, hi)), Math.max(lo, hi));
    return [fit(x, MARGIN + l + dl, w - MARGIN - r), fit(y, MARGIN + t, h - MARGIN - b - db)];
  }

  /**
   * After the scale changed from `old` to d.scale: views stay on the sheet. Growing, the
   * layout grows from its top left corner, so the views move apart as they grow instead
   * of running into each other; shrinking, each view keeps its place.
   */
  rescaleViews(d: DrawingDoc, old: number) {
    const k = d.scale / old;
    if (!(k > 0) || k === 1) return;
    const fs = this.frames.filter((f) => d.views.some((v) => v.id === f.id));
    const ax = Math.min(...fs.map((f) => f.x0)), ay = Math.min(...fs.map((f) => f.y0));
    const moved = d.views.map((v) => {
      const [x, y] = k > 1 && fs.length ? [ax + (v.x - ax) * k, ay + (v.y - ay) * k] : [v.x, v.y];
      return this.onSheet(v.id, x, y, d, k);
    });
    d.views.forEach((v, i) => { [v.x, v.y] = moved[i]; });
  }

  /** After the sheet got smaller or turned: views that would hang off it move back on. */
  keepOnSheet(d: DrawingDoc) {
    for (const v of d.views) [v.x, v.y] = this.onSheet(v.id, v.x, v.y, d);
  }

  /** Selects a view from the keyboard (the Views list) and focuses the sheet so arrow keys move it. */
  select(id: string) {
    this.selected = id;
    this.drawSelection();
    this.syncPanel();
    this.el.focus({ preventScroll: true });
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
    const dims = kind !== 'isometric';
    // In free room on the sheet, not on top of the other views or their dimensions
    // (a view still being projected takes the room of its bounding box's projection).
    const others = d.views.map((v) => {
      let frame = this.frames.find((f) => f.id === v.id);
      if (!frame) {
        const [vw, vh] = projectedSize(v.kind, b.min, b.max).map((k) => (k * d.scale) / 2);
        frame = { id: v.id, x0: v.x - vw, y0: v.y - vh, x1: v.x + vw, y1: v.y + vh };
      }
      return { frame, dims: v.dims && v.kind !== 'isometric' };
    });
    const [x, y] = placeView(sheetDims(d), w * d.scale, hh * d.scale, dims, others);
    let n = d.views.length + 1;
    while (d.views.some((v) => v.id === `v${n}`)) n++;
    const id = `v${n}`;
    this.selected = id;
    this.update((dd) => { dd.views.push({ id, kind, x, y, hidden: dims, dims }); }, 'Add view');
  }

  // ---------- export ----------

  /** Waits for both queued model edits and their projections before exporting. */
  private async projected(): Promise<boolean> {
    const drawing = this.doc;
    const stillOpen = () => this.active && this.doc === drawing;
    if (!drawing || !stillOpen()) return false;
    for (;;) {
      await this.app.whenBuilt();
      if (!stillOpen()) return false;
      const version = this.app.buildVersion;
      await this.refresh();
      while (this.pending || this.refreshAgain) {
        await new Promise((r) => setTimeout(r, 50));
        if (!stillOpen()) return false;
      }
      // Another edit may have arrived while the projection was running.
      await this.app.whenBuilt();
      if (!stillOpen()) return false;
      if (version === this.app.buildVersion) return true;
    }
  }

  async exportPdf() {
    if (!(await this.projected())) return;
    const s = this.sheet();
    download(toPdf(s.items, s.w, s.h, this.app.store.doc.name) as BlobPart, `${safeName(this.app.store.doc.name)}.pdf`, 'application/pdf');
  }

  async exportSvg() {
    if (!(await this.projected())) return;
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
    const sheet = selectField<SheetSize>('Sheet size', d.sheet, (Object.keys(SHEET_LABELS) as SheetSize[]).map((k) => ({ value: k, label: SHEET_LABELS[k] })), (v) => ws.updateFromPanel((x) => { x.sheet = v; ws.keepOnSheet(x); }, 'Sheet size'));
    const scales = STANDARD_SCALES.map((s) => ({ value: String(s), label: scaleLabel(s) }));
    if (!scales.some((s) => Number(s.value) === d.scale)) scales.push({ value: String(d.scale), label: scaleLabel(d.scale) });
    const scale = selectField('Scale', String(d.scale), scales, (v) => ws.updateFromPanel((x) => { const old = x.scale; x.scale = Number(v); ws.rescaleViews(x, old); }, 'Sheet scale'));
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
        checkbox('Landscape', d.landscape, (v) => ws.updateFromPanel((x) => { x.landscape = v; ws.keepOnSheet(x); }, 'Sheet orientation')),
        scale,
        h('button', { class: 'btn small', type: 'button', onclick: () => ws.relayout() }, icon('reset', 14), 'Arrange standard views'),
      ]),
      section('Views', [views, h('div', { class: 'row' }, h('div', { class: 'grow' }, addSel), add)]),
      section('Title Block', [
        field('Title', d.title || this.app.store.doc.name, (v) => ws.updateFromPanel((x) => { x.title = v; }, 'Title')),
        field('Drawn by', d.drawnBy, (v) => ws.updateFromPanel((x) => { x.drawnBy = v; }, 'Drawn by')),
        field('Notes', d.notes, (v) => ws.updateFromPanel((x) => { x.notes = v; }, 'Notes')),
      ]),
      section('Export', [
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: () => void ws.exportPdf() }, icon('download', 14), 'PDF'),
          h('button', { class: 'btn small', type: 'button', onclick: () => void ws.exportSvg() }, icon('download', 14), 'SVG')),
      ]),
    ];
  }

  private viewRow(v: DrawingView): HTMLElement {
    const ws = this.ws;
    const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${VIEW_LABELS[v.kind]} view` }, icon('trash', 14));
    del.addEventListener('click', () => { ws.selected = v.id; ws.deleteSelected(); });
    const hidden = h('input', { type: 'checkbox', 'aria-label': `Hidden lines in ${VIEW_LABELS[v.kind]} view` }) as HTMLInputElement;
    hidden.checked = v.hidden;
    hidden.addEventListener('change', () => ws.updateFromPanel((d) => { const x = d.views.find((q) => q.id === v.id); if (x) x.hidden = hidden.checked; }, 'Hidden lines'));
    const dims = h('input', { type: 'checkbox', 'aria-label': `Dimensions in ${VIEW_LABELS[v.kind]} view` }) as HTMLInputElement;
    dims.checked = v.dims;
    dims.addEventListener('change', () => ws.updateFromPanel((d) => { const x = d.views.find((q) => q.id === v.id); if (x) x.dims = dims.checked; }, 'Dimensions'));
    const name = h('button', {
      class: 'grow', type: 'button', 'aria-pressed': String(ws.selected === v.id), title: 'Select the view; arrow keys then move it',
      style: { background: 'none', border: '0', padding: '0', textAlign: 'left' },
    }, VIEW_LABELS[v.kind]);
    name.addEventListener('click', () => ws.select(v.id));
    const row = h('div', { class: `rel-btn${ws.selected === v.id ? ' on' : ''}`, style: { cursor: 'default' } },
      name,
      h('label', { class: 'check', title: 'Hidden lines' }, hidden, h('span', { class: 'field-label' }, 'Hidden')),
      h('label', { class: 'check', title: 'Overall dimensions' }, dims, h('span', { class: 'field-label' }, 'Dims')),
      del);
    return row;
  }
}
