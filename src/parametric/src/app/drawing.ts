// Drawing workspace: a paper sheet with projected views of the part (hidden
// lines dashed), section, detail and auxiliary views, dimensions measured from
// the model, centre marks, notes and a title block. Views and annotations can be
// dragged, added and removed; the sheet exports to PDF, SVG and DXF.

import type { EdgeInfo, ProjectionResult } from '../kernel/protocol';
import type { DrawingAnnotation, DrawingBom, DrawingCutList, DrawingDimension, DrawingDoc, DrawingRef, DrawingView, DrawingViewKind, HoleFeature, Id, SheetSize } from '../model/types';
import type { Vec3 } from '../math/vec';
import { flatSize } from '../model/flat-pattern';
import { type CutList, cutListRows, memberOfFace, weldmentCutList } from '../model/weldments';
import { type TableSpec, autoBalloons, balloonTip, bomTable, cutListTable, drawBalloon, itemOfEdge, splitTable, tableSize } from '../drawing/tables';
import { ASSEMBLY_SOURCE, EXPLODED_SOURCE, flatSource } from './drawing-sources';
import { UNIT_SYSTEMS, formatNumber } from '../model/units';
import {
  DIM_BELOW, DIM_LEFT, MARGIN, SHEETS, TITLE_H, SHEET_LABELS, STANDARD_SCALES, VIEW_LABELS, buildSheet, freeSpot, placeView, projectedSize, scaleLabel, sheetDims,
  standardLayout, switchProjection, toPdf, toSvg, viewCaption, type Item, type ViewFrame, type ViewPlacement,
} from '../drawing/sheet';
import { type AnnoFormat, type Geo, type HoleSpec, drawDimension, guessKind, holeCount, holeInstance, holeSpecOf, measure, resolveRef } from '../drawing/annotate';
import { toDxf } from '../drawing/dxf';
import type { DrawingSource } from '../drawing/source';
import { type P2, type Prim, type ResolvedView, FLAT_SOURCE, SIDE_VECTORS, besideOrient, dependents, lineNormal, projectionRequest, resolveViews, standardKindOf } from '../drawing/views';
import { download, safeName } from '../platform/files';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { confirmDialog, toast } from '../ui/overlay';
import type { App } from './app';
import { PropertyPanel, checkbox, section, segmented, selectField } from './pm';

/** A sheet metal part (a flat pattern view can be added to its drawing). */
const isSheetMetal = (app: App) => !app.assembly && app.store.doc.features.some((f) => f.type === 'baseFlange');

/** YYYY-MM-DD in the user's time zone (toISOString gives the UTC day, a day off in the evening or morning). */
function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Commands that work on the sheet with the mouse. */
export type DrawingToolKind = 'projected' | 'section' | 'detail' | 'auxiliary' | 'dimension' | 'note' | 'centerMark' | 'centerline' | 'holeCallout' | 'balloon' | 'autoBalloon';

export const TOOL_LABELS: Record<DrawingToolKind, string> = {
  projected: 'Projected View', section: 'Section View', detail: 'Detail View', auxiliary: 'Auxiliary View', dimension: 'Smart Dimension',
  note: 'Note', centerMark: 'Center Mark', centerline: 'Centerline', holeCallout: 'Hole Callout', balloon: 'Balloon', autoBalloon: 'Auto Balloon',
};

/** Commands that start by picking the view they work on. */
const fromView = (k: DrawingToolKind) => k === 'projected' || k === 'section' || k === 'detail' || k === 'auxiliary' || k === 'autoBalloon';

/** Something picked on the sheet: a model edge or point seen in a view (`t`: where on a straight edge a balloon's leader is attached, a fraction of it from its start). */
interface Pick { view: Id; ref: DrawingRef; geo: Geo; q: P2; t?: number }
type ToolOptions = { orient?: ToolState['orient']; leader?: boolean };

interface ToolState {
  kind: DrawingToolKind;
  parent?: Id;
  /** Points clicked so far, in the parent's view coordinates. */
  pts: P2[];
  picks: Pick[];
  /** Section cutting line direction. */
  orient: 'horizontal' | 'vertical' | 'aligned';
  /** Notes: start with the leader's arrow. */
  leader: boolean;
  hover: Pick | null;
  cursor: P2 | null;
}

/** Order of the sheet sizes in the list. */
const SHEET_ORDER: SheetSize[] = ['A4', 'A3', 'A2', 'A1', 'Letter', 'Tabloid', 'ANSI C', 'ANSI D'];

/** The name of a view in lists and messages. */
export function viewName(d: DrawingDoc, v: DrawingView): string {
  const t = v.type ?? 'model';
  if (t === 'model') return v.label ? `${VIEW_LABELS[v.kind]} (${v.label})` : VIEW_LABELS[v.kind];
  const r = resolveViews(d).get(v.id);
  if (!r) return 'View';
  const cap = viewCaption(d, r).replace(/\s+SCALE .*$/, '');
  return cap.charAt(0) + cap.slice(1).toLowerCase().replace(/ ([a-z])-([a-z])$/, (_, a: string, b: string) => ` ${a.toUpperCase()}-${b.toUpperCase()}`).replace(/ ([a-z])$/, (_, a: string) => ` ${a.toUpperCase()}`);
}

/** The next unused view letter (I, O and Q are skipped: they read as numbers). */
export function nextLetter(d: DrawingDoc): string {
  const used = new Set(d.views.filter((v) => v.type && v.type !== 'model' && v.type !== 'projected').map((v) => (v.label ?? '').toUpperCase()));
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (let k = 1; k < 4; k++) {
    for (const c of letters) { const s = c.repeat(k); if (!used.has(s)) return s; }
  }
  return 'X';
}

export class DrawingWorkspace {
  readonly el: HTMLElement;
  private host: HTMLElement;
  private paper: HTMLElement;
  private selBox: HTMLElement;
  private overlay: HTMLElement;
  active = false;
  selected: string | null = null;
  /** The selected annotation. */
  selectedAnno: string | null = null;
  tool: ToolState | null = null;
  private zoom = 1;
  private pan = { x: 0, y: 0 };
  /** Projections by the key of what they show (views that look the same way share one). */
  private cache = new Map<string, { version: number; hidden: boolean; result: ProjectionResult }>();
  private frames: ViewFrame[] = [];
  private placements = new Map<string, ViewPlacement>();
  private annoBoxes: { id: string; box: [number, number, number, number] }[] = [];
  private pending = false;
  /** A refresh was asked for while views were being projected. */
  private refreshAgain = false;
  /** What the drawing PropertyManager shows, to rebuild it only when that changes. */
  private panelKey = '';
  private panelChanging = false;
  private layoutPending = false;
  private sheetW = 297;
  /** The sheet's warnings as last said (a toast says new ones). */
  private warned = '';
  /** Says the views are being projected, when that takes a moment (a large part takes seconds). */
  private busy = h('div', { class: 'drawing-busy', role: 'status' });
  private sheetH = 210;
  /** Where views get their geometry (see src/drawing/source.ts). */
  readonly sources = new Map<string, DrawingSource>();

  constructor(private app: App) {
    this.paper = h('div', { class: 'paper', role: 'img', 'aria-label': 'Drawing sheet' });
    this.selBox = h('div', { class: 'view-sel', hidden: true });
    this.overlay = h('div', { class: 'drw-overlay', 'aria-hidden': 'true' });
    this.host = h('div', { class: 'sheet-host' }, this.paper, this.selBox, this.overlay);
    // An application: screen readers pass it the arrow keys instead of reading on with them
    // (and a label on a plain div is not read at all).
    this.el = h('div', {
      class: 'drawing-ws', hidden: true, tabindex: '0', role: 'application',
      'aria-label': 'Drawing. Drag views to move them, or select one in the Views list (or an annotation in the Annotations list) of the Drawing panel and move it with the arrow keys; Escape deselects it and Delete removes it. With nothing selected the arrow keys move the sheet; plus and minus zoom.',
    }, this.host,
      h('div', { class: 'drawing-empty', hidden: true }, 'There is no solid to draw yet. Build the part in the Model tab first.'),
      this.busy);
    app.shell.viewport.append(this.el);
    this.sources.set('part', {
      version: () => app.geometryVersion,
      bbox: () => app.bbox,
      project: (q) => app.kernel.project(q),
      edges: () => app.edges,
    });
    this.sources.set(FLAT_SOURCE, flatSource(app));
    this.bind();
    // A drawing made before the part had a solid is laid out when the solid exists, even
    // if the drawing was left meanwhile; not once another document replaced that part.
    app.store.on((reason) => {
      if (reason === 'load') { this.layoutPending = false; this.untouched = ''; this.selectedAnno = null; this.tool = null; }
      // Undoing an edit made before the drawing was first shown takes the drawing out of the
      // part with it. A drawing nobody changed was never an edit: on screen, it stays.
      else if ((reason === 'undo' || reason === 'redo') && this.active && !app.store.doc.drawing && this.untouched) {
        app.store.doc.drawing = JSON.parse(this.untouched) as DrawingDoc;
      }
    });
  }

  get doc(): DrawingDoc | null {
    return this.app.store.doc.drawing ?? null;
  }

  /**
   * A source by name; in an assembly, views that name none show the assembly. A name not known
   * here (an assembly's view in a part file, or a damaged one) shows what the document has.
   */
  source(name: string): DrawingSource | undefined {
    const known = this.sources.has(name) ? name : 'part';
    return this.sources.get(known === 'part' && this.app.assembly ? ASSEMBLY_SOURCE : known);
  }

  /** The bounding box of what a view of a source shows (absent: the part's, or the assembly's). */
  bbox(source = 'part'): { min: Vec3; max: Vec3 } | null {
    return this.source(source)?.bbox() ?? null;
  }

  /** The rows a bill of materials or cut list table shows (null: there is nothing to list). */
  tableOf(a: DrawingBom | DrawingCutList): TableSpec | null {
    const app = this.app;
    const doc = app.store.doc;
    if (a.type === 'bom') {
      const d = this.doc;
      const first = d?.views.length ? resolveViews(d).get(d.views[0].id)?.source : undefined;
      const rows = this.source(a.source ?? first ?? 'part')?.bom?.();
      return rows ? bomTable(rows) : null;
    }
    if (app.assembly || !app.weldments.length) return null;
    const r = cutListRows(this.cutList(), doc.units, doc.decimals);
    return cutListTable(r.rows, UNIT_SYSTEMS[doc.units].length);
  }

  private cutListMemo: { build: number; doc: unknown; list: CutList } | null = null;
  /** The weldment's cut list as last built. */
  private cutList(): CutList {
    const app = this.app;
    const m = this.cutListMemo;
    if (m && m.build === app.buildVersion && m.doc === app.store.doc) return m.list;
    const list = weldmentCutList(app.store.doc, app.weldments);
    this.cutListMemo = { build: app.buildVersion, doc: app.store.doc, list };
    return list;
  }

  /**
   * The item number of what an edge of a source belongs to: its component's bill of materials
   * row in an assembly, its structural member's cut list item in a weldment.
   */
  itemOf(source: string, edge: string): number | null {
    const src = this.source(source);
    const rows = src?.bom?.();
    if (rows) return itemOfEdge(edge, rows);
    const app = this.app;
    if (app.assembly || source !== 'part' || !app.weldments.length) return null;
    const e = app.edges.find((x) => x.name === edge);
    if (!e) return null;
    const items = this.cutList().items;
    for (const fi of e.faces) {
      const m = memberOfFace(app.faces[fi]?.name ?? '');
      const it = m && items.find((x) => x.members.some((y) => y.feature === m.feature && y.member === m.member));
      if (it) return it.item;
    }
    return null;
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
    this.warned = '';
    this.panelKey = '';
    this.active = false;
    this.tool = null;
    this.el.classList.remove('drw-tool');
    this.el.hidden = true;
  }

  /**
   * Creates a drawing with the standard views laid out on an A4 (or, for inch parts, Letter)
   * sheet. An assembly's goes on an A3 (or Tabloid) sheet, with its bill of materials on the
   * title block.
   */
  create() {
    const b = this.bbox();
    const asm = !!this.app.assembly;
    const ips = this.app.store.doc.units === 'IPS';
    const size: SheetSize = asm ? (ips ? 'Tabloid' : 'A3') : ips ? 'Letter' : 'A4';
    const sheet = sheetDims({ sheet: size, landscape: true });
    const annotations: DrawingAnnotation[] | undefined = asm ? [{ id: 'a1', type: 'bom', at: [sheet.w - MARGIN, sheet.h - MARGIN - TITLE_H], anchor: 'bottomRight' }] : undefined;
    const layout = b ? standardLayout(sheet, b.min, b.max, this.layoutBottom(annotations, sheet)) : { scale: 1, views: [] };
    // Opened before the first rebuild finished: lay out once the solid exists.
    this.layoutPending = !b;
    // Only looking at the drawing does not edit the part: it is neither marked edited nor
    // given an undo step until the drawing is changed (and is saved with the part from then).
    const drawing: DrawingDoc = {
      sheet: size, landscape: true, scale: layout.scale,
      views: layout.views.map((v, i) => ({ ...v, id: `v${i + 1}`, centerMarks: true, ...(asm ? { source: ASSEMBLY_SOURCE } : {}) })), title: '', drawnBy: '', notes: '',
      titleBlock: 'full', revision: '',
      ...(annotations ? { annotations } : {}),
    };
    this.app.store.doc.drawing = drawing;
    this.untouched = JSON.stringify(drawing);
  }

  /** The drawing as created, until it is changed. */
  private untouched = '';

  /**
   * The height the standard views leave free along the bottom of the sheet: the title block's,
   * and a table's standing on it.
   */
  private layoutBottom(annotations: DrawingAnnotation[] | undefined, sheet: { w: number; h: number }): number {
    let bottom = TITLE_H;
    for (const a of annotations ?? []) {
      if ((a.type !== 'bom' && a.type !== 'cutList') || a.anchor !== 'bottomRight') continue;
      const t = this.tableOf(a);
      // As tall as its tallest column, when it is split to stay on the sheet.
      const box = t && splitTable(t, a.at, a.anchor, { top: MARGIN, bottom: sheet.h - MARGIN, left: MARGIN, right: sheet.w - MARGIN }).box;
      if (box) bottom = Math.max(bottom, TITLE_H + (box[3] - box[1]) + 6);
    }
    return bottom;
  }

  /**
   * Arrange standard views from a button or command: first asks when it would delete views
   * made since (sections, details...) or annotations on views. Resolves whether it arranged.
   */
  async arrange(): Promise<boolean> {
    const d = this.doc;
    if (!d) return false;
    const views = d.views.filter((v) => (v.type ?? 'model') !== 'model').length;
    const annos = (d.annotations ?? []).filter((a) => a.view).length;
    if (views || annos) {
      const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
      const lost = [views && n(views, 'section, detail or other added view', 'section, detail and other added views'), annos && n(annos, 'annotation on a view', 'annotations on views')].filter(Boolean).join(' and ');
      const ok = await confirmDialog('Arrange standard views', `This replaces the views on the sheet with the standard ones, so the ${lost} will be deleted.`, 'Arrange', true);
      if (!ok || !this.doc) return false;
    }
    this.relayout();
    return true;
  }

  /** Re-lays out the standard views (keeps sheet settings). */
  relayout() {
    const b = this.bbox();
    const d = this.doc;
    if (!b || !d) return;
    const layout = standardLayout(sheetDims(d), b.min, b.max, this.layoutBottom(d.annotations, sheetDims(d)));
    const source = this.app.assembly ? { source: ASSEMBLY_SOURCE } : {};
    const first = d.projection === 'first';
    const arrange = (x: DrawingDoc) => {
      x.scale = layout.scale;
      const centerMarks = x.titleBlock === 'full' ? true : undefined;
      // First angle: the top view goes below the front view, and the view right of it is the left view.
      x.views = layout.views.map((v, i) => {
        const nv: DrawingView = { ...v, id: `v${i + 1}`, ...source };
        if (centerMarks) nv.centerMarks = true;
        if (first && v.kind === 'top') nv.y = layout.views[0].y + (layout.views[0].y - v.y);
        if (first && v.kind === 'right') nv.kind = 'left';
        if (first && v.kind === 'isometric') nv.y = layout.views[0].y + (layout.views[0].y - v.y);
        return nv;
      });
      if (first) {
        // Mirrored about the front view's row: keep the whole layout on the sheet.
        const { h: sh } = sheetDims(x);
        const dy = Math.max(0, Math.max(...x.views.map((v) => v.y)) - (sh - MARGIN - 40));
        for (const v of x.views) v.y -= dy;
      }
      x.annotations = (x.annotations ?? []).filter((a) => !a.view);
    };
    // A drawing nobody changed yet is still not an edit of the part.
    if (JSON.stringify(d) === this.untouched) {
      arrange(d);
      this.untouched = JSON.stringify(d);
      // Not a document change, which would re-enable the commands that need views.
      this.app.commands.changed();
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
    const key = d ? JSON.stringify([
      this.selected, this.selectedAnno, this.tool && [this.tool.kind, this.tool.parent, this.tool.orient, this.tool.leader, this.tool.pts.length, this.tool.picks.length],
      this.app.store.doc.name, d.sheet, d.landscape, d.scale, d.title, d.drawnBy, d.notes, d.revision, d.projection, d.titleBlock,
      d.views.map((v) => [v.id, v.kind, v.hidden, v.dims, v.type, v.label, v.scale, v.tangent, v.centerMarks, v.source]),
      (d.annotations ?? []).map((a) => [a.id, a.type, a.type === 'note' ? a.text : '', a.type === 'note' ? a.size : '', a.type === 'dimension' ? [a.decimals, a.prefix, this.dangling(a)] : '']),
    ]) : '';
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
    const controls = [...body.querySelectorAll<HTMLElement>('button, input, select, textarea')];
    const same = controls.find((el) => name(el) === name(was));
    const near = row >= 0 ? rows[Math.min(row, rows.length - 1)]?.querySelector<HTMLElement>('button[aria-label^="Delete"]') ?? controls.find((el) => name(el) === 'Add view') : null;
    (same ?? near ?? body.querySelector<HTMLElement>('.pm-head .title'))?.focus();
  }

  /** The source a view's geometry comes from (projected, section and detail views: their parent's). */
  viewSource(id: Id): string | undefined {
    const d = this.doc;
    return d ? resolveViews(d).get(id)?.source : undefined;
  }

  /** A dimension whose model geometry is gone. */
  dangling(a: DrawingAnnotation): boolean {
    if (a.type !== 'dimension' && a.type !== 'centerMark' && a.type !== 'centerline' && a.type !== 'holeCallout' && a.type !== 'balloon') return false;
    const p = this.placements.get(a.view);
    if (!p) return false;
    const refs = a.type === 'dimension' || a.type === 'centerline' ? a.refs : [a.ref];
    return refs.some((r) => !p.prims.some((q) => q.edge === r.edge));
  }

  // ---------- projections and rendering ----------

  /** Projects missing or outdated views, then renders. */
  async refresh() {
    if (!this.active) return;
    if (this.pending) { this.refreshAgain = true; return; }
    const d = this.doc;
    if (!d) return;
    if (this.layoutPending && this.bbox()) {
      this.layoutPending = false;
      if (!d.views.length) { this.relayout(); return; }
    }
    const resolved = resolveViews(d);
    // One request per projection key, with hidden lines if any view sharing it shows them.
    const want = new Map<string, { r: ResolvedView; hidden: boolean }>();
    for (const v of d.views) {
      const r = resolved.get(v.id);
      if (!r) continue;
      const w = want.get(r.key);
      want.set(r.key, { r, hidden: (w?.hidden ?? false) || v.hidden });
    }
    const bySource = new Map<string, { key: string; r: ResolvedView; hidden: boolean }[]>();
    for (const [key, w] of want) {
      const src = this.source(w.r.source);
      if (!src || !src.bbox()) continue;
      const c = this.cache.get(key);
      // A view whose hidden lines are turned on needs them projected; turned off, they are just not drawn.
      if (c && c.version === src.version() && (!w.hidden || c.hidden)) continue;
      const list = bySource.get(w.r.source) ?? [];
      list.push({ key, ...w });
      bySource.set(w.r.source, list);
    }
    if (bySource.size) {
      this.pending = true;
      const versions = new Map([...bySource.keys()].map((s) => [s, this.source(s)!.version()]));
      // A sheet opened for the first time shows its border and title block meanwhile, not nothing.
      if (!this.paper.firstChild) this.render();
      const slow = setTimeout(() => { this.busy.textContent = 'Projecting the views…'; }, 300);
      try {
        for (const [name, list] of bySource) {
          const res = await this.source(name)!.project(list.map((x) => projectionRequest(x.r, x.hidden)));
          for (const r of res) {
            const x = list.find((q) => q.key === r.id);
            if (x) this.cache.set(x.key, { version: versions.get(name)!, hidden: x.hidden, result: r });
          }
        }
      } catch (e) {
        toast({ kind: 'error', title: 'Could not project the views', message: (e as Error).message });
      } finally {
        this.pending = false;
        clearTimeout(slow);
        this.busy.textContent = '';
      }
      // The model or the views may have changed while projecting.
      const changed = [...versions].some(([s, ver]) => this.source(s)?.version() !== ver);
      if (changed || this.refreshAgain) { this.refreshAgain = false; void this.refresh(); return; }
    }
    this.render();
  }

  private fmt(): AnnoFormat {
    const doc = this.app.store.doc;
    const u = UNIT_SYSTEMS[doc.units];
    return {
      length: (mm, dec) => formatNumber(mm / u.scale, dec ?? doc.decimals),
      angle: (deg, dec) => `${formatNumber(deg, dec ?? Math.min(doc.decimals, 2))}°`,
    };
  }

  private info() {
    const doc = this.app.store.doc;
    const u = UNIT_SYSTEMS[doc.units];
    return {
      partName: doc.name,
      material: this.app.assembly ? 'See bill of materials' : doc.material?.name ?? 'Not specified',
      units: u.length,
      date: localDate(doc.modified || Date.now()),
      formatLength: (mm: number) => formatNumber(mm / u.scale, doc.decimals),
      edges: (src: string): EdgeInfo[] => this.source(src)?.edges() ?? [],
      format: this.fmt(),
      holeOf: (edge: string) => this.holeOf(edge),
      table: (a: DrawingBom | DrawingCutList) => this.tableOf(a),
      itemOf: (source: string, edge: string) => this.itemOf(source, edge),
    };
  }

  /**
   * The hole feature a circular edge was made by, with its sizes and how many holes it made
   * (pattern and mirror copies of it too: their faces' names trace back to it).
   */
  private holeOf(edge: string): HoleSpec | null {
    const app = this.app;
    const e = app.edges.find((x) => x.name === edge);
    if (!e || e.type !== 'circle' || !e.radius) return null;
    const fid = e.faces.map((i) => holeInstance(app.faces[i]?.name ?? '')?.feature).find((id) => app.store.feature(id ?? '')?.type === 'hole');
    if (!fid) return null;
    const f = app.store.resolve().features.find((x) => x.id === fid) as HoleFeature | undefined;
    if (!f) return null;
    return holeSpecOf(f, holeCount(app.faces.map((x) => x.name), fid));
  }

  private sheet() {
    const d = this.doc!;
    const projections = new Map<string, ProjectionResult>();
    const resolved = resolveViews(d);
    for (const v of d.views) {
      const r = resolved.get(v.id);
      const src = r && this.source(r.source);
      const c = r && this.cache.get(r.key);
      if (src?.bbox() && c?.version === src.version()) projections.set(v.id, c.result);
    }
    return buildSheet(d, projections, this.info());
  }

  render() {
    const d = this.doc;
    if (!d || !this.active) return;
    const s = this.sheet();
    this.frames = s.frames;
    this.placements = s.placements;
    this.annoBoxes = s.annos;
    // What does not fit on the sheet is said once (and stays in red on the sheet).
    const warn = s.warnings.join('\n');
    if (warn && warn !== this.warned) toast({ kind: 'warning', title: 'Drawing', message: warn });
    this.warned = warn;
    if (this.selectedAnno && !(d.annotations ?? []).some((a) => a.id === this.selectedAnno)) this.selectedAnno = null;
    if (this.selected && !d.views.some((v) => v.id === this.selected)) this.selected = null;
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
    (this.el.querySelector('.drawing-empty') as HTMLElement).hidden = !!this.bbox();
    if (resized) this.fit();
    else this.applyTransform();
    this.drawSelection();
    this.drawOverlay();
    this.syncPanel();
  }

  private applyTransform() {
    this.host.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }

  private drawSelection() {
    const f = this.frames.find((x) => x.id === this.selected);
    const a = this.annoBoxes.find((x) => x.id === this.selectedAnno);
    const b = f ? [f.x0, f.y0, f.x1, f.y1] : a ? a.box : null;
    this.selBox.hidden = !b;
    if (!b) return;
    const pad = f ? 3 : 0.8;
    Object.assign(this.selBox.style, { left: `${b[0] - pad}px`, top: `${b[1] - pad}px`, width: `${b[2] - b[0] + 2 * pad}px`, height: `${b[3] - b[1] + 2 * pad}px` });
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

  // ---------- tools ----------

  /** Starts a sheet command; a view selected beforehand is the one it works from. */
  startTool(kind: DrawingToolKind) {
    if (!this.doc) return;
    const needsParent = fromView(kind);
    let parent = needsParent && this.selected && this.placements.has(this.selected) ? this.selected : undefined;
    if (parent && !this.parentAllowed(kind, parent)) parent = undefined;
    if (kind === 'autoBalloon' && parent) { this.autoBalloon(parent); return; }
    this.tool = { kind, parent, pts: [], picks: [], orient: 'horizontal', leader: false, hover: null, cursor: null };
    this.el.classList.add('drw-tool');
    this.selectedAnno = null;
    this.drawSelection();
    this.drawOverlay();
    this.syncPanel();
    this.app.setStatus(this.toolPrompt());
    this.app.commands.changed();
    this.el.focus({ preventScroll: true });
  }

  /** Only a detail view can be made from a flat pattern view (it has no direction to project from). */
  private parentAllowed(kind: DrawingToolKind, id: Id): boolean {
    const v = this.doc?.views.find((q) => q.id === id);
    return !(v?.type === 'flat' && kind !== 'detail' && kind !== 'autoBalloon');
  }

  cancelTool(): boolean {
    if (!this.tool) return false;
    this.tool = null;
    this.el.classList.remove('drw-tool');
    this.drawOverlay();
    this.syncPanel();
    this.app.setStatus('Drawing. Drag views to arrange them; export to PDF, SVG or DXF from the Drafting tab.');
    // The command's ribbon button shows it is no longer on.
    this.app.commands.changed();
    return true;
  }

  setToolOption(o: ToolOptions) {
    if (!this.tool) return;
    Object.assign(this.tool, o);
    this.tool.pts = [];
    this.drawOverlay();
    this.syncPanel();
    this.app.setStatus(this.toolPrompt());
  }

  /** What the active command asks for next. */
  toolPrompt(): string {
    const t = this.tool;
    if (!t) return '';
    if (t.kind === 'autoBalloon') return 'Click the view to add balloons to.';
    if (fromView(t.kind) && !t.parent) return 'Click the view to make it from.';
    switch (t.kind) {
      case 'projected': return 'Move the pointer to the side of the view to project to, and click to place the view.';
      case 'section':
        if (t.orient === 'aligned') return t.pts.length === 0 ? 'Click the first end of the cutting line.' : t.pts.length === 1 ? 'Click the other end of the cutting line.' : 'Click on the side to look from to place the section view.';
        return t.pts.length === 0 ? `Click where the ${t.orient} cutting line goes (it snaps to centres and corners).` : 'Click on the side to look from to place the section view.';
      case 'detail': return t.pts.length === 0 ? 'Click the centre of the detail circle.' : t.pts.length === 1 ? 'Click to set the size of the circle.' : 'Click where the detail view goes.';
      case 'auxiliary': return t.pts.length === 0 ? 'Click a straight edge to look square to.' : 'Click on a side of the edge to place the auxiliary view.';
      case 'dimension': return t.picks.length === 0 ? 'Click an edge, circle or point of a view to dimension.' : t.picks.length === 1 ? 'Click a second edge or point, or click where the dimension goes.' : 'Click where the dimension goes.';
      case 'note': return t.leader && t.pts.length === 0 ? 'Click where the leader arrow points.' : 'Click where the note goes.';
      case 'centerMark': return 'Click a circle or arc of a view.';
      case 'centerline': return t.picks.length === 0 ? 'Click the first of two parallel edges.' : 'Click the second edge.';
      case 'holeCallout': return t.picks.length === 0 ? 'Click a hole (a circle seen end on).' : 'Click where the callout goes.';
      case 'balloon': return t.picks.length === 0 ? 'Click an edge of a component (or member) in a view.' : 'Click where the balloon goes.';
    }
  }

  /** View coordinates of a sheet point in a placed view. */
  private toView(p: ViewPlacement, x: number, y: number): P2 {
    return [(x - p.tx) / p.s, (y - p.ty) / p.s];
  }

  /** The model edge or point of a view under a sheet point, within a few pixels. */
  private pick(x: number, y: number, want: 'any' | 'point' | 'line' | 'circle', only?: Id): Pick | null {
    const order = only ? [only] : [...this.frames].reverse().map((f) => f.id);
    for (const id of order) {
      const p = this.placements.get(id);
      if (!p) continue;
      const f = p.frame;
      if (!only && !(x >= f.x0 - 3 && x <= f.x1 + 3 && y >= f.y0 - 3 && y <= f.y1 + 3)) continue;
      const q = this.toView(p, x, y);
      const tol = 7 / this.zoom / p.s;
      let best: Pick | null = null, bd = tol;
      const consider = (d: number, mk: () => Pick) => { if (d < bd) { bd = d; best = mk(); } };
      const dist = (a: P2) => Math.hypot(a[0] - q[0], a[1] - q[1]);
      if (want === 'any' || want === 'point') {
        for (const pr of p.prims) {
          if (pr.kind === 'arc') {
            consider(dist(pr.c), () => ({ view: id, ref: { edge: pr.edge, at: 'center' }, geo: { kind: 'point', p: pr.c }, q: pr.c }));
            if (pr.full) continue;
          }
          consider(dist(pr.a), () => ({ view: id, ref: { edge: pr.edge, at: 'start' }, geo: { kind: 'point', p: pr.a }, q: pr.a }));
          consider(dist(pr.b), () => ({ view: id, ref: { edge: pr.edge, at: 'end' }, geo: { kind: 'point', p: pr.b }, q: pr.b }));
        }
        if (best || want === 'point') return best;
      }
      for (const pr of p.prims) {
        if (pr.kind === 'line' && (want === 'any' || want === 'line')) {
          const dx = pr.b[0] - pr.a[0], dy = pr.b[1] - pr.a[1], L = dx * dx + dy * dy;
          const t = L > 0 ? Math.max(0, Math.min(1, ((q[0] - pr.a[0]) * dx + (q[1] - pr.a[1]) * dy) / L)) : 0;
          consider(Math.hypot(pr.a[0] + dx * t - q[0], pr.a[1] + dy * t - q[1]), () => ({ view: id, ref: { edge: pr.edge, at: 'edge' }, geo: { kind: 'line', a: pr.a, b: pr.b }, q }));
        }
        if (pr.kind === 'arc' && (want === 'any' || want === 'circle')) {
          consider(Math.abs(dist(pr.c) - pr.r), () => ({ view: id, ref: { edge: pr.edge, at: 'edge' }, geo: { kind: 'circle', c: pr.c, r: pr.r, full: pr.full, a: pr.a, b: pr.b, m: pr.m }, q }));
        }
      }
      if (best) return best;
      if (!only) return null;
    }
    return null;
  }

  /** Snaps a sheet point in a view to a nearby corner or centre (else keeps it), in view coordinates. */
  private snap(p: ViewPlacement, x: number, y: number): P2 {
    const hit = this.pick(x, y, 'point', p.r.v.id);
    return hit ? hit.q : this.toView(p, x, y);
  }

  private newViewId(d: DrawingDoc): string {
    let n = d.views.length + 1;
    while (d.views.some((v) => v.id === `v${n}`)) n++;
    return `v${n}`;
  }

  private newAnnoId(d: DrawingDoc): string {
    const list = d.annotations ?? [];
    let n = list.length + 1;
    while (list.some((a) => a.id === `a${n}`)) n++;
    return `a${n}`;
  }

  /** A section or auxiliary view's line through the parent, oriented so the view is on the side of `to`. */
  private orientLine(l: [number, number, number, number], to: P2): [number, number, number, number] {
    const n = lineNormal(l);
    const side = (to[0] - l[0]) * n[0] + (to[1] - l[1]) * n[1];
    return side >= 0 ? l : [l[2], l[3], l[0], l[1]];
  }

  /** The cutting line of the section tool so far (parent view coordinates). */
  private sectionLine(t: ToolState, p: ViewPlacement, cursorView: P2 | null): [number, number, number, number] | null {
    const pr = this.projectionOf(p.r.v.id);
    const b = pr?.bounds;
    if (!b) return null;
    const m = Math.max(b[2] - b[0], b[3] - b[1]) * 0.08 + 3 / p.s;
    if (t.orient === 'horizontal' && t.pts[0]) return [b[0] - m, t.pts[0][1], b[2] + m, t.pts[0][1]];
    if (t.orient === 'vertical' && t.pts[0]) return [t.pts[0][0], b[3] + m, t.pts[0][0], b[1] - m];
    if (t.orient === 'aligned' && t.pts[0]) {
      const e = t.pts[1] ?? cursorView;
      if (!e || Math.hypot(e[0] - t.pts[0][0], e[1] - t.pts[0][1]) < 1e-6) return null;
      return [t.pts[0][0], t.pts[0][1], e[0], e[1]];
    }
    return null;
  }

  private projectionOf(id: Id): ProjectionResult | undefined {
    const d = this.doc;
    if (!d) return undefined;
    const r = resolveViews(d).get(id);
    return r ? this.cache.get(r.key)?.result : undefined;
  }

  /** A sheet click with a command active. */
  private toolClick(x: number, y: number) {
    const t = this.tool!;
    const d = this.doc!;
    const needsParent = fromView(t.kind);
    if (needsParent && !t.parent) {
      const id = this.viewAt(x, y);
      if (id && this.placements.has(id) && !this.parentAllowed(t.kind, id)) { toast({ kind: 'info', message: 'A flat pattern view can only have detail views made from it.' }); return; }
      if (id && this.placements.has(id) && t.kind === 'autoBalloon') { this.cancelTool(); this.autoBalloon(id); return; }
      if (id && this.placements.has(id)) { t.parent = id; this.selected = id; this.drawSelection(); this.syncPanel(); }
      this.app.setStatus(this.toolPrompt());
      this.drawOverlay();
      return;
    }
    const p = t.parent ? this.placements.get(t.parent) : undefined;
    if (needsParent && !p) { this.cancelTool(); return; }
    const finish = (label: string, fn: (dd: DrawingDoc) => void, keep = false) => {
      this.update(fn, label);
      if (keep) { t.pts = []; t.picks = []; this.drawOverlay(); this.syncPanel(); this.app.setStatus(this.toolPrompt()); }
      else this.cancelTool();
    };
    switch (t.kind) {
      case 'projected': {
        const side = this.sideOf(p!, x, y);
        const id = this.newViewId(d);
        const o = besideOrient(p!.r.o, SIDE_VECTORS[side], d.projection === 'first');
        const kind = (standardKindOf(o) ?? p!.r.v.kind) as DrawingViewKind;
        const cx = (p!.frame.x0 + p!.frame.x1) / 2, cy = (p!.frame.y0 + p!.frame.y1) / 2;
        const [nx, ny] = side === 'left' || side === 'right' ? [x, cy] : [cx, y];
        this.selected = id;
        finish('Projected view', (dd) => { dd.views.push({ id, kind, type: 'projected', parent: t.parent, side, x: nx, y: ny, hidden: kind !== 'isometric', dims: false, centerMarks: true }); this.placeOnSheet(dd, id); });
        return;
      }
      case 'section': {
        const q = this.toView(p!, x, y);
        const need = t.orient === 'aligned' ? 2 : 1;
        if (t.pts.length < need) {
          t.pts.push(this.snap(p!, x, y));
          if (t.orient === 'aligned' && t.pts.length === 2 && Math.hypot(t.pts[1][0] - t.pts[0][0], t.pts[1][1] - t.pts[0][1]) < 1e-6) t.pts.pop();
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        const raw = this.sectionLine(t, p!, null);
        if (!raw) return;
        const line = this.orientLine(raw, q);
        const id = this.newViewId(d);
        const label = nextLetter(d);
        const n = lineNormal(line);
        const aligned = Math.abs(n[0]) < 1e-9 || Math.abs(n[1]) < 1e-9;
        const cx = (p!.frame.x0 + p!.frame.x1) / 2, cy = (p!.frame.y0 + p!.frame.y1) / 2;
        const [nx, ny] = !aligned ? [x, y] : Math.abs(n[0]) < 1e-9 ? [cx, y] : [x, cy];
        this.selected = id;
        finish('Section view', (dd) => { dd.views.push({ id, kind: p!.r.v.kind, type: 'section', parent: t.parent, line: line.map((v) => +v.toFixed(6)) as [number, number, number, number], label, x: nx, y: ny, hidden: false, dims: false, centerMarks: true }); this.placeOnSheet(dd, id); });
        return;
      }
      case 'detail': {
        if (t.pts.length === 0) { t.pts.push(this.snap(p!, x, y)); this.app.setStatus(this.toolPrompt()); this.drawOverlay(); return; }
        if (t.pts.length === 1) {
          const q = this.toView(p!, x, y);
          const r = Math.hypot(q[0] - t.pts[0][0], q[1] - t.pts[0][1]);
          if (r * p!.s < 1) return;
          t.pts.push([r, 0]);
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        const id = this.newViewId(d);
        const label = nextLetter(d);
        const c = t.pts[0], r = t.pts[1][0];
        const scale = detailScale(p!.s);
        this.selected = id;
        finish('Detail view', (dd) => { dd.views.push({ id, kind: p!.r.v.kind, type: 'detail', parent: t.parent, circle: [+c[0].toFixed(6), +c[1].toFixed(6), +r.toFixed(6)], scale, label, x, y, hidden: false, dims: false, centerMarks: true }); this.placeOnSheet(dd, id); });
        return;
      }
      case 'auxiliary': {
        if (t.pts.length === 0) {
          const hit = this.pick(x, y, 'line', t.parent);
          if (hit?.geo.kind !== 'line') return;
          t.pts.push(hit.geo.a, hit.geo.b);
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        const q = this.toView(p!, x, y);
        const line = this.orientLine([t.pts[0][0], t.pts[0][1], t.pts[1][0], t.pts[1][1]], q);
        const id = this.newViewId(d);
        const label = nextLetter(d);
        this.selected = id;
        finish('Auxiliary view', (dd) => { dd.views.push({ id, kind: p!.r.v.kind, type: 'auxiliary', parent: t.parent, line: line.map((v) => +v.toFixed(6)) as [number, number, number, number], label, x, y, hidden: false, dims: false, centerMarks: true }); this.placeOnSheet(dd, id); });
        return;
      }
      case 'dimension': {
        const first = t.picks[0];
        const hit = t.picks.length < 2 ? this.pick(x, y, 'any', first?.view) : null;
        if (hit && (!first || !(hit.ref.edge === first.ref.edge && hit.ref.at === first.ref.at))) {
          t.picks.push(hit);
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        // A single point measures nothing: it waits for a second one.
        if (!first || (t.picks.length === 1 && first.geo.kind === 'point')) return;
        const pv = this.placements.get(first.view);
        if (!pv) return;
        const at = this.toView(pv, x, y);
        const gs = t.picks.map((k) => k.geo);
        const kind = guessKind(gs, at);
        if (!measure(kind, gs)) { toast({ kind: 'info', message: 'These cannot be dimensioned together. Pick other edges or points.' }); t.picks = []; this.drawOverlay(); return; }
        const id = this.newAnnoId(d);
        const refs = t.picks.map((k) => k.ref);
        finish('Dimension', (dd) => { (dd.annotations ??= []).push({ id, type: 'dimension', view: first.view, kind, refs, at: [+at[0].toFixed(4), +at[1].toFixed(4)] }); }, true);
        return;
      }
      case 'note': {
        const vid = this.viewAt(x, y);
        const pv = vid ? this.placements.get(vid) : undefined;
        if (t.leader && t.pts.length === 0) {
          const hit = this.pick(x, y, 'any');
          const vp = hit ? this.placements.get(hit.view) : pv;
          t.parent = vp?.r.v.id;
          t.pts.push(vp ? (hit ? hit.q : this.toView(vp, x, y)) : [x, y]);
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        const owner = t.leader ? (t.parent ? this.placements.get(t.parent) : undefined) : pv;
        const at: P2 = owner ? this.toView(owner, x, y) : [x, y];
        const id = this.newAnnoId(d);
        this.selectedAnno = id;
        const leader = t.leader ? t.pts[0] : undefined;
        finish('Note', (dd) => {
          const n: DrawingAnnotation = { id, type: 'note', text: 'NOTE', at: [+at[0].toFixed(4), +at[1].toFixed(4)] };
          if (owner) n.view = owner.r.v.id;
          if (leader) n.leader = [+leader[0].toFixed(4), +leader[1].toFixed(4)];
          (dd.annotations ??= []).push(n);
        });
        requestAnimationFrame(() => (this.app.shell.lpBody.querySelector('textarea[aria-label="Note text"]') as HTMLTextAreaElement | null)?.select());
        return;
      }
      case 'centerMark': {
        const hit = this.pick(x, y, 'circle');
        if (hit?.geo.kind !== 'circle') return;
        const id = this.newAnnoId(d);
        finish('Center mark', (dd) => { (dd.annotations ??= []).push({ id, type: 'centerMark', view: hit.view, ref: hit.ref }); }, true);
        return;
      }
      case 'centerline': {
        const hit = this.pick(x, y, 'line', t.picks[0]?.view);
        if (hit?.geo.kind !== 'line') return;
        if (!t.picks.length) { t.picks.push(hit); this.app.setStatus(this.toolPrompt()); this.drawOverlay(); return; }
        const a = t.picks[0];
        const g1 = a.geo as Extract<Geo, { kind: 'line' }>, g2 = hit.geo;
        const u1 = [g1.b[0] - g1.a[0], g1.b[1] - g1.a[1]], u2 = [g2.b[0] - g2.a[0], g2.b[1] - g2.a[1]];
        if (Math.abs(u1[0] * u2[1] - u1[1] * u2[0]) > 1e-6 * Math.hypot(...u1) * Math.hypot(...u2) || hit.ref.edge === a.ref.edge) {
          toast({ kind: 'info', message: 'A centerline goes between two parallel edges.' });
          return;
        }
        const id = this.newAnnoId(d);
        finish('Centerline', (dd) => { (dd.annotations ??= []).push({ id, type: 'centerline', view: a.view, refs: [a.ref, hit.ref] }); }, true);
        return;
      }
      case 'holeCallout': {
        if (!t.picks.length) {
          const hit = this.pick(x, y, 'circle');
          if (hit?.geo.kind !== 'circle') return;
          t.picks.push(hit);
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        const a = t.picks[0];
        const pv = this.placements.get(a.view);
        if (!pv) return;
        const at = this.toView(pv, x, y);
        const id = this.newAnnoId(d);
        finish('Hole callout', (dd) => { (dd.annotations ??= []).push({ id, type: 'holeCallout', view: a.view, ref: a.ref, at: [+at[0].toFixed(4), +at[1].toFixed(4)] }); }, true);
        return;
      }
      case 'balloon': {
        if (!t.picks.length) {
          const hit = this.pick(x, y, 'any');
          if (!hit) return;
          const pv = this.placements.get(hit.view);
          if (!pv || this.itemOf(pv.r.source, hit.ref.edge) === null) {
            toast({ kind: 'info', message: this.app.assembly ? 'Click an edge of a component listed in the bill of materials.' : 'Click an edge of a structural member listed in the cut list.' });
            return;
          }
          // The leader ends where the edge was clicked (a vertex: that end of it).
          const ref: DrawingRef = { edge: hit.ref.edge, at: 'edge' };
          const geo = resolveRef(pv.prims, ref) ?? hit.geo;
          let along: number | undefined;
          if (geo.kind === 'line') {
            const dx = geo.b[0] - geo.a[0], dy = geo.b[1] - geo.a[1], L = dx * dx + dy * dy;
            along = L > 0 ? +Math.max(0, Math.min(1, ((hit.q[0] - geo.a[0]) * dx + (hit.q[1] - geo.a[1]) * dy) / L)).toFixed(4) : undefined;
          }
          t.picks.push({ ...hit, ref, geo, ...(along !== undefined ? { t: along } : {}) });
          this.app.setStatus(this.toolPrompt());
          this.drawOverlay();
          return;
        }
        const a = t.picks[0];
        const pv = this.placements.get(a.view);
        if (!pv) return;
        const at = this.toView(pv, x, y);
        const id = this.newAnnoId(d);
        finish('Balloon', (dd) => { (dd.annotations ??= []).push({ id, type: 'balloon', view: a.view, ref: a.ref, at: [+at[0].toFixed(4), +at[1].toFixed(4)], ...(a.t !== undefined ? { t: a.t } : {}) }); }, true);
        return;
      }
      case 'autoBalloon': return;
    }
  }

  /** A view just added where it was clicked: kept on the sheet (a click beside the paper would put it out of sight). */
  private placeOnSheet(d: DrawingDoc, id: Id) {
    const v = d.views.find((q) => q.id === id);
    if (v) [v.x, v.y] = this.onSheet(id, v.x, v.y, d);
  }

  /** On which side of a view a sheet point is. */
  private sideOf(p: ViewPlacement, x: number, y: number): 'left' | 'right' | 'above' | 'below' {
    const f = p.frame;
    const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
    const dx = (x - cx) / Math.max(f.x1 - f.x0, 1), dy = (y - cy) / Math.max(f.y1 - f.y0, 1);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'below' : 'above';
  }

  /** Previews of the active command and highlights of what it would pick. */
  private drawOverlay() {
    const t = this.tool;
    if (!t || !this.active) { this.overlay.innerHTML = ''; return; }
    const items: Item[] = [];
    const accent = '#1e88e5';
    const p = t.parent ? this.placements.get(t.parent) : undefined;
    const T = (pl: ViewPlacement, q: P2): P2 => [pl.tx + q[0] * pl.s, pl.ty + q[1] * pl.s];
    const mark = (k: Pick) => {
      const pl = this.placements.get(k.view);
      if (!pl) return;
      const g = k.geo;
      if (g.kind === 'point') { const c = T(pl, g.p); items.push({ t: 'circle', cx: c[0], cy: c[1], r: 1, w: 0.4 }); }
      else if (g.kind === 'line') { const a = T(pl, g.a), b = T(pl, g.b); items.push({ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: 0.6 }); }
      else { const c = T(pl, g.c); items.push({ t: 'circle', cx: c[0], cy: c[1], r: g.r * pl.s, w: 0.6 }); }
    };
    if (p) { const f = p.frame; items.push({ t: 'rect', x: f.x0 - 2, y: f.y0 - 2, w: f.x1 - f.x0 + 4, h: f.y1 - f.y0 + 4, sw: 0.3 }); }
    for (const k of t.picks) mark(k);
    if (t.hover) mark(t.hover);
    const cur = t.cursor;
    if (p && cur) {
      const qv = this.toView(p, cur[0], cur[1]);
      if (t.kind === 'projected') {
        const side = this.sideOf(p, cur[0], cur[1]);
        const f = p.frame, w = f.x1 - f.x0, hh = f.y1 - f.y0;
        const o = besideOrient(p.r.o, SIDE_VECTORS[side], this.doc?.projection === 'first');
        const bb = this.source(p.r.source)?.bbox();
        const size = bb && p.r.type !== 'flat' ? sizeIn(o, bb.min, bb.max).map((v) => v * p.s) : [w, hh];
        const [cx, cy] = side === 'left' || side === 'right' ? [cur[0], (f.y0 + f.y1) / 2] : [(f.x0 + f.x1) / 2, cur[1]];
        items.push({ t: 'rect', x: cx - size[0] / 2, y: cy - size[1] / 2, w: size[0], h: size[1], sw: 0.3 });
      } else if (t.kind === 'section') {
        const pts = t.pts.length ? t : { ...t, pts: [this.snap(p, cur[0], cur[1])] };
        const l = this.sectionLine(pts, p, qv);
        if (l) {
          const a = T(p, [l[0], l[1]]), b = T(p, [l[2], l[3]]);
          items.push({ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: 0.5, dash: [4, 1, 1, 1] });
          const ready = t.orient === 'aligned' ? t.pts.length >= 2 : t.pts.length >= 1;
          if (ready) {
            const n = lineNormal(this.orientLine(l, qv));
            const first = this.doc?.projection === 'first';
            const w: P2 = first ? n : [-n[0], -n[1]];
            for (const e of [a, b]) {
              const tip: P2 = [e[0] + w[0] * 7, e[1] + w[1] * 7];
              items.push({ t: 'line', x1: e[0], y1: e[1], x2: tip[0], y2: tip[1], w: 0.4 });
            }
          }
        }
      } else if (t.kind === 'detail') {
        const c = t.pts[0] ?? this.snap(p, cur[0], cur[1]);
        const r = t.pts[1] ? t.pts[1][0] : t.pts[0] ? Math.hypot(qv[0] - c[0], qv[1] - c[1]) : 0;
        const sc = T(p, c);
        if (r > 0) items.push({ t: 'circle', cx: sc[0], cy: sc[1], r: r * p.s, w: 0.4 });
        else items.push({ t: 'circle', cx: sc[0], cy: sc[1], r: 1, w: 0.4 });
        if (t.pts[1]) items.push({ t: 'circle', cx: cur[0], cy: cur[1], r: r * detailScale(p.s), w: 0.3, dash: [2, 1] });
      } else if (t.kind === 'auxiliary' && t.pts.length === 2) {
        const a = T(p, t.pts[0]), b = T(p, t.pts[1]);
        items.push({ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: 0.6 });
        items.push({ t: 'circle', cx: cur[0], cy: cur[1], r: 2, w: 0.3 });
      }
    }
    if (cur && t.kind === 'dimension' && t.picks.length) {
      const pl = this.placements.get(t.picks[0].view);
      if (pl) {
        const at = this.toView(pl, cur[0], cur[1]);
        const gs = t.picks.map((k) => k.geo);
        const kind = guessKind(gs, at);
        const dim: DrawingDimension = { id: 'preview', type: 'dimension', view: pl.r.v.id, kind, refs: t.picks.map((k) => k.ref), at };
        drawDimension(items, dim, measure(kind, gs), { T: (q) => T(pl, q), s: pl.s }, this.fmt());
      }
    }
    if (cur && t.kind === 'holeCallout' && t.picks.length) items.push({ t: 'circle', cx: cur[0], cy: cur[1], r: 1, w: 0.3 });
    if (cur && t.kind === 'balloon' && t.picks.length) {
      const k = t.picks[0], pl = this.placements.get(k.view);
      if (pl) {
        const n = this.itemOf(pl.r.source, k.ref.edge);
        drawBalloon(items, n === null ? '?' : String(n), cur, T(pl, balloonTip(k.geo, this.toView(pl, cur[0], cur[1]), k.t)));
      }
    }
    if (cur && t.kind === 'note' && t.leader && t.pts.length) {
      const pl = t.parent ? this.placements.get(t.parent) : undefined;
      const tip = pl ? T(pl, t.pts[0]) : t.pts[0];
      items.push({ t: 'line', x1: tip[0], y1: tip[1], x2: cur[0], y2: cur[1], w: 0.3 });
    }
    const svg = toSvg(items, this.sheetW, this.sheetH, { background: 'none', ink: accent });
    this.overlay.innerHTML = svg;
    const el = this.overlay.firstElementChild as SVGSVGElement | null;
    if (el) { el.setAttribute('width', `${this.sheetW}`); el.setAttribute('height', `${this.sheetH}`); }
  }

  /** Pointer moved with a command active: what it would pick, and its preview. */
  private toolMove(x: number, y: number) {
    const t = this.tool!;
    t.cursor = [x, y];
    t.hover = null;
    switch (t.kind) {
      case 'dimension': if (t.picks.length < 2) t.hover = this.pick(x, y, 'any', t.picks[0]?.view); break;
      case 'centerMark': t.hover = this.pick(x, y, 'circle'); break;
      case 'holeCallout': if (!t.picks.length) t.hover = this.pick(x, y, 'circle'); break;
      case 'balloon': if (!t.picks.length) t.hover = this.pick(x, y, 'any'); break;
      case 'centerline': t.hover = this.pick(x, y, 'line', t.picks[0]?.view); break;
      case 'auxiliary': if (t.parent && !t.pts.length) t.hover = this.pick(x, y, 'line', t.parent); break;
      case 'section': case 'detail': if (t.parent) t.hover = this.pick(x, y, 'point', t.parent); break;
      case 'note': if (t.leader && !t.pts.length) t.hover = this.pick(x, y, 'any'); break;
    }
    this.drawOverlay();
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

  private annoAt(x: number, y: number): string | null {
    for (const a of [...this.annoBoxes].reverse()) if (x >= a.box[0] - 1 && x <= a.box[2] + 1 && y >= a.box[1] - 1 && y <= a.box[3] + 1) return a.id;
    return null;
  }

  /** Views that move with a view: those aligned to it, and theirs. */
  private followers(d: DrawingDoc, id: Id): Id[] {
    const rs = resolveViews(d);
    const out: Id[] = [];
    const walk = (p: Id) => {
      for (const v of d.views) {
        const r = rs.get(v.id);
        if (v.parent === p && r?.align && !out.includes(v.id)) { out.push(v.id); walk(v.id); }
      }
    };
    walk(id);
    return out;
  }

  private bind() {
    type Drag = { kind: 'pan' | 'view' | 'anno'; sx: number; sy: number; ox: number; oy: number; id?: string; moved: boolean; follow?: { id: Id; x: number; y: number }[]; align?: 'x' | 'y'; s?: number };
    let drag: Drag | null = null;
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
        if ((drag?.kind === 'view' || drag?.kind === 'anno') && drag.moved) this.app.store.endBatch();
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
      if (this.tool && e.button === 0) {
        this.toolClick(x, y);
        return;
      }
      const anno = e.button === 0 ? this.annoAt(x, y) : null;
      const id = e.button === 0 && !anno ? this.viewAt(x, y) : null;
      this.el.setPointerCapture(e.pointerId);
      if (anno) {
        const a = this.doc!.annotations!.find((q) => q.id === anno)!;
        this.selectedAnno = anno;
        this.selected = null;
        this.drawSelection();
        this.syncPanel();
        const at = 'at' in a ? a.at : [0, 0];
        const p = a.view ? this.placements.get(a.view) : undefined;
        drag = { kind: 'anno', sx: e.clientX, sy: e.clientY, ox: at[0], oy: at[1], id: anno, moved: false, s: p?.s ?? 1 };
      } else if (id) {
        const d = this.doc!;
        const v = d.views.find((q) => q.id === id)!;
        this.selected = id;
        this.selectedAnno = null;
        this.drawSelection();
        this.syncPanel();
        const follow = this.followers(d, id).map((f) => { const q = d.views.find((w) => w.id === f)!; return { id: f, x: q.x, y: q.y }; });
        drag = { kind: 'view', sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, id, moved: false, follow, align: this.placements.get(id)?.r.align };
      } else {
        if (e.button === 0 && (this.selected || this.selectedAnno)) { this.selected = null; this.selectedAnno = null; this.drawSelection(); this.syncPanel(); }
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
      if (!drag) {
        if (this.tool) { const [x, y] = this.toSheet(e.clientX, e.clientY); this.toolMove(x, y); }
        return;
      }
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved && drag.kind !== 'pan') this.app.store.beginBatch(drag.kind === 'view' ? 'Move view' : 'Move annotation', () => { drag = null; });
      drag.moved = true;
      if (drag.kind === 'pan') {
        this.pan = { x: drag.ox + dx, y: drag.oy + dy };
        this.applyTransform();
      } else if (drag.kind === 'anno') {
        const id = drag.id!, k = (drag.s ?? 1) * this.zoom;
        const nx = drag.ox + dx / k, ny = drag.oy + dy / k;
        this.update((d) => { const a = d.annotations?.find((q) => q.id === id); if (a && 'at' in a) a.at = [+nx.toFixed(4), +ny.toFixed(4)]; }, 'Move annotation');
      } else {
        const id = drag.id!;
        // A view aligned with its parent moves only along the axis they do not share.
        const mx = drag.align === 'x' ? 0 : dx, my = drag.align === 'y' ? 0 : dy;
        const follow = drag.follow ?? [];
        const [ddx, ddy] = this.groupMove(id, drag.ox, drag.oy, drag.ox + mx / this.zoom, drag.oy + my / this.zoom, follow);
        const nx = drag.ox + ddx, ny = drag.oy + ddy;
        // The change re-renders the sheet (App refreshes the drawing on every document change).
        this.update((d) => {
          const v = d.views.find((q) => q.id === id);
          if (v) { v.x = nx; v.y = ny; }
          for (const f of follow) { const q = d.views.find((w) => w.id === f.id); if (q) { q.x = f.x + ddx; q.y = f.y + ddy; } }
        }, 'Move view');
      }
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) pinch = null; return; }
      if ((drag?.kind === 'view' || drag?.kind === 'anno') && drag.moved) this.app.store.endBatch();
      drag = null;
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('lostpointercapture', end);
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      // As in the 3D view: line and page deltas from wheels, the zoom direction setting for the
      // wheel only (a trackpad pinch arrives with Ctrl and follows the fingers).
      let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      if (this.app.viewport.invertZoom && !e.ctrlKey) dy = -dy;
      const f = Math.exp(-Math.max(-0.5, Math.min(0.5, dy * (e.ctrlKey ? 0.01 : 0.0018))));
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const nz = Math.max(0.1, Math.min(40, this.zoom * f));
      this.pan = { x: mx - ((mx - this.pan.x) * nz) / this.zoom, y: my - ((my - this.pan.y) * nz) / this.zoom };
      this.zoom = nz;
      this.applyTransform();
      if (this.tool) this.drawOverlay();
    }, { passive: false });
    // A held arrow key is one undo step: its auto-repeats join the step of the first press
    // (one step each filled the bounded history within seconds and dropped older steps).
    let nudge: { id: string; mark: number; last: number } | null = null;
    this.el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      // The selected annotation that has a place of its own (a dimension's value, a note...).
      const anno = !this.selected && this.selectedAnno ? this.doc?.annotations?.find((q) => q.id === this.selectedAnno && 'at' in q) : undefined;
      const moveAnno = (dx: number, dy: number) => {
        if (!anno || !('at' in anno)) return;
        e.preventDefault();
        const id = anno.id;
        const store = this.app.store;
        const join = e.repeat && nudge?.id === id && nudge.last === store.undoMark ? nudge : null;
        const mark = join ? join.mark : store.undoMark;
        // A step is a millimetre on the sheet (an annotation of a view has its place in the view's coordinates).
        const s = (anno.view && this.placements.get(anno.view)?.s) || 1;
        const at: [number, number] = [+(anno.at[0] + dx / s).toFixed(4), +(anno.at[1] + dy / s).toFixed(4)];
        this.update((d) => { const q = d.annotations?.find((x) => x.id === id); if (q && 'at' in q) q.at = at; }, 'Move annotation');
        if (join) store.squash(mark, 'Move annotation');
        nudge = { id, mark, last: store.undoMark };
      };
      const move = (dx: number, dy: number) => {
        const id = this.selected;
        if (!id) { moveAnno(dx, dy); return; }
        e.preventDefault();
        const store = this.app.store;
        const join = e.repeat && nudge?.id === id && nudge.last === store.undoMark ? nudge : null;
        const mark = join ? join.mark : store.undoMark;
        const d0 = this.doc;
        const v = d0?.views.find((q) => q.id === id);
        if (!d0 || !v) return;
        const align = this.placements.get(id)?.r.align;
        if (align === 'x') dx = 0;
        if (align === 'y') dy = 0;
        // Held against the edge of the sheet: nothing to move (and no empty undo step).
        const follow = this.followers(d0, id);
        const [ddx, ddy] = this.groupMove(id, v.x, v.y, v.x + dx, v.y + dy, follow.map((f) => { const q = d0.views.find((w) => w.id === f)!; return { id: f, x: q.x, y: q.y }; }));
        if (!ddx && !ddy) return;
        const nx = v.x + ddx, ny = v.y + ddy;
        this.update((d) => {
          const q = d.views.find((x) => x.id === id);
          if (q) { q.x = nx; q.y = ny; }
          for (const f of follow) { const w = d.views.find((x) => x.id === f); if (w) { w.x += ddx; w.y += ddy; } }
        }, 'Move view');
        if (join) store.squash(mark, 'Move view');
        nudge = { id, mark, last: store.undoMark };
      };
      const pan = (dx: number, dy: number) => {
        e.preventDefault();
        this.pan = { x: this.pan.x + dx, y: this.pan.y + dy };
        this.applyTransform();
      };
      // Arrow keys move the selected view or annotation, else the sheet; + and - zoom it (as the wheel does).
      const d = this.selected || anno ? null : 40 * (e.shiftKey ? 4 : 1);
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
    // The view's reach from its centre, at k times the scale drawn.
    const f = this.frameOf(v, d.scale / k, d);
    const [l, r, t, b] = f ? [v.x - f.x0, f.x1 - v.x, v.y - f.y0, f.y1 - v.y].map((q) => q * k) : [0, 0, 0, 0];
    // Its dimensions, left of and below it, stay on the sheet too.
    const [dl, db] = v.dims && v.kind !== 'isometric' && v.type !== 'detail' ? [DIM_LEFT, DIM_BELOW] : [0, 0];
    const fit = (c: number, lo: number, hi: number) => Math.min(Math.max(c, Math.min(lo, hi)), Math.max(lo, hi));
    return [fit(x, MARGIN + l + dl, w - MARGIN - r), fit(y, MARGIN + t, h - MARGIN - b - db)];
  }

  /**
   * How far a view at (ox, oy) moved toward (x, y) goes, with the views that follow it (at
   * their positions then): as far as keeps it and every one of them on the sheet.
   */
  private groupMove(id: string, ox: number, oy: number, x: number, y: number, follow: { id: Id; x: number; y: number }[]): [number, number] {
    const [nx, ny] = this.onSheet(id, x, y);
    let dx = nx - ox, dy = ny - oy;
    // Each limit holds where the move started, so narrowing the move for one keeps it within the others'.
    for (const f of follow) {
      const [fx, fy] = this.onSheet(f.id, f.x + dx, f.y + dy);
      dx = fx - f.x;
      dy = fy - f.y;
    }
    return [dx, dy];
  }

  /**
   * After the scale changed from `old` to d.scale: views stay on the sheet. Growing, the
   * layout grows from its top left corner, so the views move apart as they grow instead
   * of running into each other; shrinking, each view keeps its place.
   */
  rescaleViews(d: DrawingDoc, old: number) {
    const k = d.scale / old;
    if (!(k > 0) || k === 1) return;
    const fs = d.views.map((v) => this.frameOf(v, old, d)).filter((f) => !!f);
    const ax = Math.min(...fs.map((f) => f.x0)), ay = Math.min(...fs.map((f) => f.y0));
    const moved = d.views.map((v) => {
      const [x, y] = k > 1 && fs.length ? [ax + (v.x - ax) * k, ay + (v.y - ay) * k] : [v.x, v.y];
      return this.onSheet(v.id, x, y, d, k);
    });
    d.views.forEach((v, i) => { [v.x, v.y] = moved[i]; });
  }

  /**
   * A view's frame as last drawn, centred on where the view is now (an aligned view's frame
   * is not centred on its position) or, while it is still being projected (a drawing just
   * opened), the projection of the part's bounding box drawn at `scale`.
   */
  private frameOf(v: DrawingView, scale: number, d = this.doc): ViewFrame | undefined {
    const f = this.frames.find((q) => q.id === v.id);
    const b = this.bbox(v.source);
    if (f) {
      const p = this.placements.get(v.id);
      if (!p?.r.align) return f;
      const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
      return { id: f.id, x0: f.x0 - cx + v.x, x1: f.x1 - cx + v.x, y0: f.y0 - cy + v.y, y1: f.y1 - cy + v.y };
    }
    if (!b) return f;
    const r = d ? resolveViews(d).get(v.id) : undefined;
    const vs = r && r.type !== 'model' ? r.scale * (scale / (d?.scale || scale)) : scale;
    // A detail view shows its circle.
    if (r?.clip) { const R = r.clip.r * vs; return { id: v.id, x0: v.x - R, y0: v.y - R, x1: v.x + R, y1: v.y + R }; }
    const [vw, vh] = (r && r.type !== 'model' ? sizeIn(r.o, b.min, b.max) : projectedSize(v.kind, b.min, b.max)).map((q) => (q * vs) / 2);
    return { id: v.id, x0: v.x - vw, y0: v.y - vh, x1: v.x + vw, y1: v.y + vh };
  }

  /** A new projection angle: the views keep what they show and move to their side for it (see switchProjection). */
  setProjection(d: DrawingDoc, to: 'first' | 'third') {
    switchProjection(d, to, (v) => this.frameOf(v, d.scale, d));
  }

  /** After the sheet got smaller or turned: views that would hang off it move back on. */
  keepOnSheet(d: DrawingDoc, was?: { w: number; h: number }) {
    for (const v of d.views) [v.x, v.y] = this.onSheet(v.id, v.x, v.y, d);
    // A table that stood on the title block stays on it; any other stays on the sheet.
    const { w, h } = sheetDims(d);
    for (const a of d.annotations ?? []) {
      if (a.type !== 'bom' && a.type !== 'cutList') continue;
      if (a.anchor === 'bottomRight' && was && Math.abs(a.at[0] - (was.w - MARGIN)) < 1e-6 && Math.abs(a.at[1] - (was.h - MARGIN - TITLE_H)) < 1e-6) {
        a.at = [w - MARGIN, h - MARGIN - TITLE_H];
        continue;
      }
      const t = this.tableOf(a);
      const size = t ? tableSize(t) : { w: 0, h: 0 };
      const [ox, oy] = a.anchor === 'bottomRight' ? [size.w, size.h] : [0, 0];
      const fit = (c: number, lo: number, hi: number) => Math.min(Math.max(c, Math.min(lo, hi)), Math.max(lo, hi));
      a.at = [fit(a.at[0], MARGIN + ox, w - MARGIN - size.w + ox), fit(a.at[1], MARGIN + oy, h - MARGIN - size.h + oy)];
    }
  }

  /** Selects a view from the keyboard (the Views list) and focuses the sheet so arrow keys move it. */
  select(id: string) {
    this.selected = id;
    this.selectedAnno = null;
    this.drawSelection();
    this.syncPanel();
    this.el.focus({ preventScroll: true });
  }

  /** Selects an annotation (from the Annotations list too) and focuses the sheet so arrow keys move it. */
  selectAnno(id: string) {
    this.selectedAnno = id;
    this.selected = null;
    this.drawSelection();
    this.syncPanel();
    this.el.focus({ preventScroll: true });
  }

  /** Esc: ends the command, else the arrow keys go back to moving the sheet. */
  deselect(): boolean {
    if (this.cancelTool()) return true;
    if (!this.selected && !this.selectedAnno) return false;
    this.selected = null;
    this.selectedAnno = null;
    this.drawSelection();
    this.syncPanel();
    return true;
  }

  deleteSelected(): boolean {
    const anno = this.selectedAnno;
    if (anno) { this.deleteAnno(anno); return true; }
    const id = this.selected;
    if (!id) return false;
    this.deleteView(id);
    return true;
  }

  deleteAnno(anno: Id) {
    if (this.selectedAnno === anno) this.selectedAnno = null;
    this.update((d) => { d.annotations = (d.annotations ?? []).filter((a) => a.id !== anno); }, 'Delete annotation');
  }

  /** Deletes a view with its annotations; the views made from it go too, after a warning. */
  deleteView(id: Id) {
    const d = this.doc;
    const deps = d ? dependents(d, id) : [];
    const remove = () => {
      const gone = [id, ...deps];
      if (this.selected && gone.includes(this.selected)) this.selected = null;
      this.update((x) => {
        x.views = x.views.filter((v) => !gone.includes(v.id));
        if (x.annotations) x.annotations = x.annotations.filter((a) => !a.view || !gone.includes(a.view));
      }, 'Delete view');
    };
    if (!deps.length || !d) { if (this.selected === id) this.selected = null; remove(); return; }
    const names = deps.map((q) => viewName(d, d.views.find((v) => v.id === q)!)).join(', ');
    const v = d.views.find((q) => q.id === id)!;
    void confirmDialog('Delete view', `Deleting the ${viewName(d, v)} view also deletes the views made from it: ${names}.`, 'Delete', true).then((ok) => { if (ok) remove(); });
  }

  addView(kind: DrawingViewKind) {
    const d = this.doc;
    const b = this.bbox();
    if (!d || !b) return;
    const [w, hh] = projectedSize(kind, b.min, b.max);
    const dims = kind !== 'isometric';
    // In free room on the sheet, not on top of the other views or their dimensions
    // (a view still being projected takes the room of its bounding box's projection).
    const others = d.views.map((v) => ({ frame: this.frameOf(v, d.scale)!, dims: v.dims && v.kind !== 'isometric' && v.type !== 'detail' }));
    const [x, y] = placeView(sheetDims(d), w * d.scale, hh * d.scale, dims, others);
    const id = this.newViewId(d);
    this.selected = id;
    const full = d.titleBlock === 'full';
    const source = this.app.assembly ? { source: ASSEMBLY_SOURCE } : {};
    this.update((dd) => { dd.views.push({ id, kind, x, y, hidden: dims, dims, ...(full ? { centerMarks: true } : {}), ...source }); }, 'Add view');
  }

  /**
   * Adds the flat pattern of the sheet metal part as a view, with its bend lines and notes
   * and its overall size, where there is room (at a smaller scale when it does not fit).
   */
  async addFlatView() {
    const d0 = this.doc;
    if (!d0) return;
    let res;
    try {
      res = await this.app.kernel.flatPattern(0);
    } catch (e) {
      toast({ kind: 'error', title: 'Flat pattern view', message: (e as Error).message });
      return;
    }
    const d = this.doc;
    if (!d || d !== d0 || !this.active) return;
    if (!res.pattern) { toast({ kind: 'error', title: 'Flat pattern view', message: res.error ?? 'The part cannot be flattened.' }); return; }
    const [fw, fh] = flatSize(res.pattern);
    const sheet = sheetDims(d);
    const fit = Math.min((sheet.w - 2 * MARGIN - 2 * DIM_LEFT) / Math.max(fw, 1e-6), (sheet.h - 2 * MARGIN - TITLE_H - 2 * DIM_BELOW) / Math.max(fh, 1e-6));
    let own = d.scale <= fit ? undefined : STANDARD_SCALES.find((q) => q <= fit) ?? STANDARD_SCALES[STANDARD_SCALES.length - 1];
    const others = d.views.map((v) => ({ frame: this.frameOf(v, d.scale)!, dims: v.dims && v.kind !== 'isometric' && v.type !== 'detail' })).filter((o) => !!o.frame);
    // In free room on the sheet, down to a quarter of the scale it would have; else at that scale in the middle.
    const first = own ?? d.scale;
    let spot = freeSpot(sheet, fw * first, fh * first, true, others);
    for (const q of STANDARD_SCALES) {
      if (spot || q < first / 4 - 1e-9) break;
      if (q >= first - 1e-9) continue;
      spot = freeSpot(sheet, fw * q, fh * q, true, others);
      if (spot) own = q;
    }
    const [x, y] = spot ?? placeView(sheet, fw * first, fh * first, true, others);
    if (!spot) own = first === d.scale ? undefined : first;
    const id = this.newViewId(d);
    this.selected = id;
    this.update((dd) => { dd.views.push({ id, kind: 'front', type: 'flat', x, y, hidden: false, dims: true, ...(own ? { scale: own } : {}) }); }, 'Flat pattern view');
  }

  /** Puts the bill of materials (an assembly) or the cut list (a weldment) on the title block, or selects the one there. */
  addTable(type: 'bom' | 'cutList') {
    const d = this.doc;
    if (!d) return;
    const there = d.annotations?.find((a) => a.type === type);
    if (there) { this.selectAnno(there.id); toast({ message: `The ${type === 'bom' ? 'bill of materials' : 'cut list'} is already on the sheet (selected).` }); return; }
    const { w, h: sh } = sheetDims(d);
    const id = this.newAnnoId(d);
    this.selectedAnno = id;
    this.update((dd) => { (dd.annotations ??= []).push({ id, type, at: [w - MARGIN, sh - MARGIN - TITLE_H], anchor: 'bottomRight' }); }, type === 'bom' ? 'Bill of materials' : 'Cut list');
  }

  /** Balloons on every component of the bill of materials a view shows that has none there yet. */
  autoBalloon(viewId: Id) {
    const d = this.doc;
    const p = this.placements.get(viewId);
    const pr = this.projectionOf(viewId);
    if (!d) return;
    if (!p || !pr?.bounds) {
      // Still being projected (a drawing just opened, or the assembly still building), or empty.
      const busy = this.pending || !pr;
      toast({ kind: 'info', message: busy ? 'Wait for the view to finish updating, then use Auto Balloon again.' : 'This view shows no components to balloon.' });
      return;
    }
    const rows = this.source(p.r.source)?.bom?.();
    if (!rows) { toast({ kind: 'info', message: 'Auto Balloon numbers the components of an assembly drawing.' }); return; }
    const skip = new Set<number>();
    for (const a of d.annotations ?? []) {
      if (a.type !== 'balloon' || a.view !== viewId) continue;
      const n = a.item ?? this.itemOf(p.r.source, a.ref.edge);
      if (n !== null) skip.add(n);
    }
    let prims = p.prims, bounds = pr.bounds;
    if (p.r.clip) {
      const { c, r } = p.r.clip;
      const inside = (q: P2) => Math.hypot(q[0] - c[0], q[1] - c[1]) <= r;
      prims = prims.filter((q) => inside(q.a) || inside(q.b));
      bounds = [c[0] - r, c[1] - r, c[0] + r, c[1] + r];
    }
    // Past the view's dimensions (left and below) and its label (below).
    const v = p.r.v;
    const dims = v.dims && v.kind !== 'isometric' && v.type !== 'detail';
    const plan = autoBalloons(prims, rows, bounds, p.s, skip, dims ? [DIM_LEFT + 4, 6, 6, DIM_BELOW + 10] : [6, 6, 6, 12]);
    if (!plan.length) { toast({ message: skip.size ? 'Every component this view shows has a balloon already.' : 'This view shows no components to balloon.' }); return; }
    this.update((dd) => {
      for (const b of plan) (dd.annotations ??= []).push({ id: this.newAnnoId(dd), type: 'balloon', view: viewId, ref: b.ref, at: b.at });
    }, 'Auto balloon');
    this.app.setStatus(`Added ${plan.length} balloon${plan.length === 1 ? '' : 's'}. Drag them to arrange them.`);
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
      const version = this.app.geometryVersion;
      await this.refresh();
      while (this.pending || this.refreshAgain) {
        await new Promise((r) => setTimeout(r, 50));
        if (!stillOpen()) return false;
      }
      // Another edit may have arrived while the projection was running.
      await this.app.whenBuilt();
      if (!stillOpen()) return false;
      if (version === this.app.geometryVersion) return true;
    }
  }

  /** The title the exported document carries: the title block's, as on the sheet. */
  private exportTitle(): string {
    return this.doc?.title || this.app.store.doc.name;
  }

  async exportPdf() {
    if (!(await this.projected())) return;
    const s = this.sheet();
    download(toPdf(s.items, s.w, s.h, this.exportTitle()) as BlobPart, `${safeName(this.app.store.doc.name)}.pdf`, 'application/pdf');
  }

  async exportSvg() {
    if (!(await this.projected())) return;
    const s = this.sheet();
    download(toSvg(s.items, s.w, s.h, { title: this.exportTitle() }), `${safeName(this.app.store.doc.name)}.svg`, 'image/svg+xml');
  }

  async exportDxf() {
    if (!(await this.projected())) return;
    const s = this.sheet();
    download(toDxf(s.items, s.w, s.h), `${safeName(this.app.store.doc.name)}.dxf`, 'application/dxf');
  }
}

/** Size (paper width, height) of a box seen from a direction. */
function sizeIn(o: { dir: [number, number, number]; x: [number, number, number]; up: [number, number, number] }, min: [number, number, number], max: [number, number, number]): [number, number] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const u = p[0] * o.x[0] + p[1] * o.x[1] + p[2] * o.x[2], v = p[0] * o.up[0] + p[1] * o.up[1] + p[2] * o.up[2];
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  return [x1 - x0, y1 - y0];
}

/** A detail view's scale: the standard scale at least twice its parent's. */
export function detailScale(parent: number): number {
  const want = parent * 2;
  const up = [...STANDARD_SCALES].reverse().find((s) => s >= want - 1e-9);
  return up ?? want;
}

/** PropertyManager for the drawing: sheet, scale, views, annotations and title block. */
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
    const sheet = selectField<SheetSize>('Sheet size', d.sheet, SHEET_ORDER.filter((k) => k in SHEETS).map((k) => ({ value: k, label: SHEET_LABELS[k] })), (v) => ws.updateFromPanel((x) => { const was = sheetDims(x); x.sheet = v; ws.keepOnSheet(x, was); }, 'Sheet size'));
    const scales = STANDARD_SCALES.map((s) => ({ value: String(s), label: scaleLabel(s) }));
    if (!scales.some((s) => Number(s.value) === d.scale)) scales.push({ value: String(d.scale), label: scaleLabel(d.scale) });
    const scale = selectField('Scale', String(d.scale), scales, (v) => ws.updateFromPanel((x) => { const old = x.scale; x.scale = Number(v); ws.rescaleViews(x, old); }, 'Sheet scale'));
    const views = h('div', { class: 'relations-list' });
    for (const v of d.views) views.append(this.viewRow(d, v));
    const addSel = h('select', { class: 'input', 'aria-label': 'View to add' }) as HTMLSelectElement;
    for (const k of Object.keys(VIEW_LABELS) as DrawingViewKind[]) addSel.append(h('option', { value: k }, VIEW_LABELS[k]));
    if (isSheetMetal(this.app)) addSel.append(h('option', { value: 'flat' }, 'Flat pattern'));
    const add = h('button', { class: 'btn small', type: 'button' }, icon('plus', 14), 'Add view');
    add.addEventListener('click', () => (addSel.value === 'flat' ? void ws.addFlatView() : ws.addView(addSel.value as DrawingViewKind)));
    const field = (label: string, value: string, set: (v: string) => void) => {
      const input = h('input', { class: 'input', value, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('change', () => set(input.value));
      return h('div', {}, h('div', { class: 'field-label' }, label), input);
    };
    const toolButton = (kind: DrawingToolKind, ic: string) =>
      h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(ws.tool?.kind === kind), onclick: () => ws.startTool(kind) }, icon(ic, 14), TOOL_LABELS[kind]);
    const out: HTMLElement[] = [];
    const tool = this.toolSection();
    if (tool) out.push(tool);
    out.push(
      section('Sheet', [
        sheet,
        checkbox('Landscape', d.landscape, (v) => ws.updateFromPanel((x) => { const was = sheetDims(x); x.landscape = v; ws.keepOnSheet(x, was); }, 'Sheet orientation')),
        scale,
        selectField('Projection angle', d.projection ?? 'third', [{ value: 'third', label: 'Third angle (ASME)' }, { value: 'first', label: 'First angle (ISO)' }], (v) => ws.updateFromPanel((x) => ws.setProjection(x, v), 'Projection angle')),
        h('button', { class: 'btn small', type: 'button', onclick: () => void ws.arrange() }, icon('reset', 14), 'Arrange standard views'),
      ]),
      section('Views', [
        views, h('div', { class: 'row' }, h('div', { class: 'grow' }, addSel), add),
        h('div', { class: 'row wrap drw-tools' }, toolButton('projected', 'drawingProjected'), toolButton('section', 'drawingSection'), toolButton('detail', 'drawingDetail'), toolButton('auxiliary', 'drawingAuxiliary')),
      ]),
    );
    const sel = ws.selected ? d.views.find((v) => v.id === ws.selected) : undefined;
    if (sel) out.push(this.viewSection(d, sel));
    out.push(this.annotationsSection(d));
    const anno = ws.selectedAnno ? d.annotations?.find((a) => a.id === ws.selectedAnno) : undefined;
    if (anno) out.push(this.annotationSection(anno));
    out.push(
      section('Title Block', [
        field('Title', d.title || this.app.store.doc.name, (v) => ws.updateFromPanel((x) => { x.title = v; }, 'Title')),
        field('Drawn by', d.drawnBy, (v) => ws.updateFromPanel((x) => { x.drawnBy = v; }, 'Drawn by')),
        field('Notes', d.notes, (v) => ws.updateFromPanel((x) => { x.notes = v; }, 'Notes')),
        field('Revision', d.revision ?? '', (v) => ws.updateFromPanel((x) => { x.revision = v; }, 'Revision')),
        checkbox('Full title block (projection symbol, revision, sheet number)', d.titleBlock === 'full', (v) => ws.updateFromPanel((x) => { x.titleBlock = v ? 'full' : 'basic'; }, 'Title block')),
      ]),
      section('Export', [
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: () => void ws.exportPdf() }, icon('download', 14), 'PDF'),
          h('button', { class: 'btn small', type: 'button', onclick: () => void ws.exportSvg() }, icon('download', 14), 'SVG'),
          h('button', { class: 'btn small', type: 'button', onclick: () => void ws.exportDxf() }, icon('download', 14), 'DXF')),
      ]),
    );
    return out;
  }

  /** The active sheet command: what it asks for, its options, and Cancel. */
  private toolSection(): HTMLElement | null {
    const ws = this.ws;
    const t = ws.tool;
    if (!t) return null;
    const parts: HTMLElement[] = [h('div', { class: 'pm-msg info', role: 'status' }, ws.toolPrompt())];
    if (t.kind === 'section') parts.push(segmented('Cutting line', t.orient, [{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }, { value: 'aligned', label: 'Aligned' }], (v) => ws.setToolOption({ orient: v })));
    if (t.kind === 'note') parts.push(checkbox('With a leader arrow', t.leader, (v) => ws.setToolOption({ leader: v })));
    parts.push(h('button', { class: 'btn small', type: 'button', onclick: () => ws.cancelTool() }, icon('close', 14), 'Cancel command'));
    return section(TOOL_LABELS[t.kind], parts);
  }

  private viewSection(d: DrawingDoc, v: DrawingView): HTMLElement {
    const ws = this.ws;
    const set = (label: string, fn: (x: DrawingView) => void) => ws.updateFromPanel((dd) => { const x = dd.views.find((q) => q.id === v.id); if (x) fn(x); }, label);
    const type = v.type ?? 'model';
    const parts: HTMLElement[] = [];
    const label = h('input', { class: 'input', value: v.label ?? '', 'aria-label': type === 'section' || type === 'detail' || type === 'auxiliary' ? 'View letter' : 'View caption' }) as HTMLInputElement;
    label.addEventListener('change', () => set('View label', (x) => { const s = label.value.trim(); if (s) x.label = s; else if (type === 'model' || type === 'projected') delete x.label; }));
    parts.push(h('div', {}, h('div', { class: 'field-label' }, type === 'model' || type === 'projected' ? 'Caption (empty: the view’s name)' : 'Letter'), label));
    if (type === 'model' && v.source && (v.source === ASSEMBLY_SOURCE || v.source === EXPLODED_SOURCE) && this.app.assembly?.doc.explode.length) {
      parts.push(checkbox('Exploded (the assembly’s exploded view steps)', v.source === EXPLODED_SOURCE, (val) => set('Exploded view', (x) => { x.source = val ? EXPLODED_SOURCE : ASSEMBLY_SOURCE; })));
    }
    if (type === 'model' || type === 'detail' || type === 'flat') {
      const own = v.scale;
      const opts = [{ value: '', label: type === 'detail' ? 'Twice the parent’s' : `Sheet scale (${scaleLabel(d.scale)})` }, ...STANDARD_SCALES.map((s) => ({ value: String(s), label: scaleLabel(s) }))];
      if (own !== undefined && !STANDARD_SCALES.includes(own)) opts.push({ value: String(own), label: scaleLabel(own) });
      parts.push(selectField('View scale', own === undefined ? '' : String(own), opts, (val) => set('View scale', (x) => { if (val) x.scale = Number(val); else delete x.scale; })));
    }
    // A flat pattern has neither hidden lines nor tangent edges.
    if (type !== 'flat') {
      parts.push(
        checkbox('Show hidden lines', v.hidden, (val) => set('Hidden lines', (x) => { x.hidden = val; })),
        checkbox('Show tangent edges', v.tangent !== false, (val) => set('Tangent edges', (x) => { if (val) delete x.tangent; else x.tangent = false; })),
      );
    }
    parts.push(checkbox('Center marks and hole centerlines', !!v.centerMarks, (val) => set('Center marks', (x) => { x.centerMarks = val; })));
    if (type !== 'detail') parts.push(checkbox('Overall dimensions', v.dims, (val) => set('Dimensions', (x) => { x.dims = val; })));
    const deps = dependents(d, v.id);
    parts.push(h('button', { class: 'btn small', type: 'button', onclick: () => ws.deleteView(v.id) }, icon('trash', 14), deps.length ? `Delete view and ${deps.length} made from it` : 'Delete view'));
    return section(`View: ${viewName(d, v)}`, parts);
  }

  private annotationsSection(d: DrawingDoc): HTMLElement {
    const ws = this.ws;
    const list = h('div', { class: 'drw-anno-list' });
    const names: Record<DrawingAnnotation['type'], string> = { dimension: 'Dimension', note: 'Note', centerMark: 'Center mark', centerline: 'Centerline', holeCallout: 'Hole callout', balloon: 'Balloon', bom: 'Bill of materials', cutList: 'Cut list' };
    for (const a of d.annotations ?? []) {
      const dangling = ws.dangling(a);
      const item = a.type === 'balloon' ? a.item ?? (a.view && ws.viewSource(a.view) ? ws.itemOf(ws.viewSource(a.view)!, a.ref.edge) : null) : null;
      const text = a.type === 'balloon' ? `Balloon ${item ?? '?'}` : a.type === 'note' ? `Note: ${a.text.split('\n')[0]}` : a.type === 'dimension' ? `${{ horizontal: 'Horizontal', vertical: 'Vertical', aligned: 'Aligned', radius: 'Radius', diameter: 'Diameter', angle: 'Angle' }[a.kind]} dimension` : names[a.type];
      const name = h('button', { class: 'grow', type: 'button', 'aria-pressed': String(ws.selectedAnno === a.id), style: { background: 'none', border: '0', padding: '0', textAlign: 'left' } }, text, dangling ? h('span', { class: 'drw-missing' }, ' (geometry missing)') : null);
      name.addEventListener('click', () => ws.selectAnno(a.id));
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${text}` }, icon('trash', 14));
      del.addEventListener('click', () => ws.deleteAnno(a.id));
      list.append(h('div', { class: `rel-btn${ws.selectedAnno === a.id ? ' on' : ''}`, style: { cursor: 'default' } }, name, del));
    }
    const tool = (kind: DrawingToolKind, ic: string) => h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(ws.tool?.kind === kind), onclick: () => ws.startTool(kind) }, icon(ic, 14), TOOL_LABELS[kind]);
    return section('Annotations', [
      (d.annotations ?? []).length ? list : h('div', { class: 'field-label' }, 'No annotations yet.'),
      h('div', { class: 'row wrap drw-tools' }, tool('dimension', 'smartDimension'), tool('centerMark', 'drawingCenterMark'), tool('centerline', 'centerline'), tool('note', 'text'), tool('holeCallout', 'drawingHoleCallout'),
        ...(this.app.assembly || this.app.weldments.length ? [tool('balloon', 'balloon')] : []),
        ...(this.app.assembly ? [tool('autoBalloon', 'autoBalloon'), h('button', { class: 'btn small', type: 'button', onclick: () => ws.addTable('bom') }, icon('bom', 14), 'Bill of Materials')] : []),
        ...(!this.app.assembly && this.app.weldments.length ? [h('button', { class: 'btn small', type: 'button', onclick: () => ws.addTable('cutList') }, icon('cutList', 14), 'Cut List')] : [])),
    ]);
  }

  private annotationSection(a: DrawingAnnotation): HTMLElement {
    const ws = this.ws;
    const set = (label: string, fn: (x: DrawingAnnotation) => void) => ws.updateFromPanel((dd) => { const x = dd.annotations?.find((q) => q.id === a.id); if (x) fn(x); }, label);
    const parts: HTMLElement[] = [];
    if (a.type === 'note') {
      const ta = h('textarea', { class: 'input', rows: '3', 'aria-label': 'Note text' }) as HTMLTextAreaElement;
      ta.value = a.text;
      ta.addEventListener('change', () => set('Note text', (x) => { if (x.type === 'note') x.text = ta.value; }));
      parts.push(h('div', {}, h('div', { class: 'field-label' }, 'Text'), ta));
      parts.push(selectField('Text height', String(a.size ?? 3.5), ['2.5', '3.5', '5', '7'].map((s) => ({ value: s, label: `${s} mm` })), (v) => set('Note size', (x) => { if (x.type === 'note') x.size = Number(v); })));
    }
    if (a.type === 'dimension') {
      const doc = this.app.store.doc;
      parts.push(selectField('Decimals', a.decimals === undefined ? '' : String(a.decimals), [{ value: '', label: `Document (${doc.decimals})` }, ...[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))], (v) => set('Decimals', (x) => { if (x.type === 'dimension') { if (v === '') delete x.decimals; else x.decimals = Number(v); } })));
      const pre = h('input', { class: 'input', value: a.prefix ?? '', 'aria-label': 'Text before the value' }) as HTMLInputElement;
      pre.addEventListener('change', () => set('Dimension prefix', (x) => { if (x.type === 'dimension') { if (pre.value) x.prefix = pre.value; else delete x.prefix; } }));
      parts.push(h('div', {}, h('div', { class: 'field-label' }, 'Text before the value (e.g. 2X)'), pre));
      if (ws.dangling(a)) parts.push(h('div', { class: 'pm-msg warn', role: 'status' }, 'The model edge this dimension measured is gone. Delete it and dimension the new geometry.'));
    }
    parts.push(h('button', { class: 'btn small', type: 'button', onclick: () => ws.deleteAnno(a.id) }, icon('trash', 14), 'Delete annotation'));
    return section('Selected annotation', parts);
  }

  private viewRow(d: DrawingDoc, v: DrawingView): HTMLElement {
    const ws = this.ws;
    const vn = viewName(d, v);
    const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${vn} view` }, icon('trash', 14));
    del.addEventListener('click', () => ws.deleteView(v.id));
    const flat = v.type === 'flat';
    const hidden = h('input', { type: 'checkbox', 'aria-label': `Hidden lines in ${vn} view`, ...(flat ? { disabled: true } : {}) }) as HTMLInputElement;
    hidden.checked = v.hidden && !flat;
    hidden.addEventListener('change', () => ws.updateFromPanel((dd) => { const x = dd.views.find((q) => q.id === v.id); if (x) x.hidden = hidden.checked; }, 'Hidden lines'));
    const dims = h('input', { type: 'checkbox', 'aria-label': `Dimensions in ${vn} view` }) as HTMLInputElement;
    dims.checked = v.dims;
    dims.addEventListener('change', () => ws.updateFromPanel((dd) => { const x = dd.views.find((q) => q.id === v.id); if (x) x.dims = dims.checked; }, 'Dimensions'));
    const name = h('button', {
      class: 'grow', type: 'button', 'aria-pressed': String(ws.selected === v.id), title: 'Select the view; arrow keys then move it',
      style: { background: 'none', border: '0', padding: '0', textAlign: 'left' },
    }, vn);
    name.addEventListener('click', () => ws.select(v.id));
    const row = h('div', { class: `rel-btn${ws.selected === v.id ? ' on' : ''}`, style: { cursor: 'default' } },
      name,
      h('label', { class: 'check', title: flat ? 'A flat pattern has no hidden lines' : 'Hidden lines' }, hidden, h('span', { class: 'field-label' }, 'Hidden')),
      h('label', { class: 'check', title: 'Overall dimensions' }, dims, h('span', { class: 'field-label' }, 'Dims')),
      del);
    return row;
  }
}

export type { Prim };
