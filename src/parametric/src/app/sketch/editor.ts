// Sketch editing mode. Owns the active sketch's interaction (selection,
// dragging with the solver, box selection, drawing tools), its rendering in
// the viewport (definition-state colours, relation badges, dimensions) and
// the modify box for editing dimension values.

import type { Frame, Vec2, Vec3 } from '../../math/vec';
import { dist2, toLocal, toWorld } from '../../math/vec';
import type { Id, Param, SkConstraint, SkCurve, SkDimension, SkEntity, SketchFeature } from '../../model/types';
import { isDimension } from '../../model/types';
import { UNIT_SYSTEMS, formatNumber } from '../../model/units';
import { evaluate } from '../../model/expr';
import { ORIGIN_ID, SketchIndex, distanceToCurve, pointIdsOf, sketchBounds, tessellate } from '../../sketch/geom';
import { type SolveResult, solveSketch } from '../../sketch/solver';
import { RELATION_LABELS, availableRelations, cleanupConstraints, deleteItems, idFactory, makeRelations, measureDimension, nextDimName, usedPoints } from '../../sketch/ops';
import { h } from '../../ui/dom';
import { icon, relationGlyph } from '../../ui/icons';
import { toast } from '../../ui/overlay';
import type { App } from '../app';
import type { VPEvent, ViewportTool } from '../viewport';
import { dimGraphics } from './dimgfx';
import { type Snap, SNAP_GLYPH, snapPoint } from './inference';

export interface SkTool {
  id: string;
  label: string;
  hint: string;
  /** Called with the snapped cursor position. */
  down?(s: Snap, e: VPEvent): boolean;
  move?(s: Snap, e: VPEvent, dragging: boolean): void;
  up?(s: Snap, e: VPEvent): void;
  click?(s: Snap, e: VPEvent): boolean;
  dbl?(s: Snap, e: VPEvent): boolean;
  /** Point the cursor snaps relative to (for horizontal/vertical inference). */
  from?(): Vec2 | null;
  /** Ids excluded from snapping (e.g. the point being placed). */
  exclude?(): Set<Id>;
  /** Esc: abort the current operation. Return true if something was aborted. */
  cancel(): boolean;
  /** Tool options for the PropertyManager. */
  options?(): HTMLElement[];
  /** Whether the cursor should snap at all. */
  snaps?: boolean;
  /** Pick entities instead of snapping (trim, dimension...). */
  picks?: boolean;
}

type Pickable = { kind: 'point'; id: Id } | { kind: 'curve'; id: Id };

interface DragState {
  kind: 'points' | 'radius' | 'box' | 'label';
  ids?: Id[];
  start?: Vec2[];
  grab?: Vec2;
  circle?: Id;
  boxStart?: { x: number; y: number };
  dimId?: Id;
  moved: boolean;
}

const STATUS_TEXT: Record<SolveResult['status'], string> = { under: 'Under Defined', full: 'Fully Defined', over: 'Over Defined' };

export class SketchEditor implements ViewportTool {
  readonly sketchId: Id;
  frame: Frame;
  solve: SolveResult | null = null;
  tool: SkTool | null = null;
  hovered: Pickable | null = null;
  private preview: { lines: Vec2[][]; points: Vec2[]; dashed: Vec2[][]; guides: Vec2[][] } = { lines: [], points: [], dashed: [], guides: [] };
  private drag: DragState | null = null;
  private boxEl: HTMLElement | null = null;
  private tipEl: HTMLElement;
  private labels = new Map<Id, HTMLElement>();
  private badges = new Map<Id, HTMLElement[]>();
  private modify: HTMLElement | null = null;
  showRelations = true;
  showDimensions = true;
  /** Cursor position in sketch coordinates. */
  cursorPt: Vec2 | null = null;
  private lastSnap: Snap | null = null;
  private renderQueued = 0;

  constructor(readonly app: App, sketchId: Id, frame: Frame) {
    this.sketchId = sketchId;
    this.frame = frame;
    this.tipEl = h('div', { class: 'cursor-tip', hidden: true, 'aria-hidden': 'true' });
    this.app.viewport.root.append(this.tipEl);
    this.resolve(false);
  }

  get sketch(): SketchFeature {
    return this.app.store.feature<SketchFeature>(this.sketchId)!;
  }

  get px(): number {
    return this.app.renderer.camera.pixelSize;
  }


  // ---------- model changes ----------

  dimValue = (d: SkDimension): number => this.app.store.dimensionValue(d);

  /** Re-solves the sketch in the document (no undo step). */
  resolve(render = true) {
    const sk = this.sketch;
    if (!sk) return;
    try {
      this.solve = solveSketch(sk.entities, sk.constraints, { value: this.dimValue });
    } catch (e) {
      console.error(e);
    }
    if (render) this.render();
  }

  /** Applies a sketch change as one undo step and re-solves. */
  edit(label: string, fn: (sk: SketchFeature, newId: (p: string) => Id) => void, opts: { select?: Id[]; solve?: boolean } = {}) {
    this.app.store.change(label, (doc) => {
      const sk = doc.features.find((f) => f.id === this.sketchId) as SketchFeature;
      fn(sk, idFactory(sk));
      cleanupConstraints(sk);
      if (opts.solve !== false) this.solve = solveSketch(sk.entities, sk.constraints, { value: this.dimValue });
    }, 'sketch');
    if (opts.select) this.app.selection.set(opts.select.map((id) => this.selItem(id)));
    this.render();
    this.app.refreshSketchPanel();
  }

  private selItem(id: Id) {
    const sk = this.sketch;
    const c = sk.constraints.find((x) => x.id === id);
    if (c) return isDimension(c) ? { kind: 'skdim' as const, id } : { kind: 'skrel' as const, id };
    return { kind: 'sk' as const, id };
  }

  selectedIds(kinds: ('sk' | 'skdim' | 'skrel')[] = ['sk']): Id[] {
    return this.app.selection.items.filter((x) => (kinds as string[]).includes(x.kind)).map((x) => (x as { id: Id }).id);
  }

  /** Snaps a raw sketch point using the active tool's context. */
  snap(raw: Vec2, e?: { ctrl?: boolean }): Snap {
    const t = this.tool;
    return snapPoint(this.sketch, raw, {
      from: t?.from?.() ?? null,
      exclude: t?.exclude?.(),
      disabled: !!e?.ctrl || t?.snaps === false,
      tol: this.px * 9,
    });
  }

  /** Creates (or reuses) a point for a snap result, adding relations. */
  commitPoint(sk: SketchFeature, s: Snap, newId: (p: string) => Id): Id {
    if ((s.kind === 'point' || s.kind === 'center') && s.pointId) return s.pointId;
    const id = newId('p');
    sk.entities.push({ id, t: 'point', x: s.p[0], y: s.p[1] });
    if (s.kind === 'origin') sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, ORIGIN_ID] });
    else if (s.kind === 'on' && s.curveId) sk.constraints.push({ id: newId('r'), type: 'coincident', refs: [id, s.curveId] });
    else if (s.kind === 'mid' && s.curveId) sk.constraints.push({ id: newId('r'), type: 'midpoint', refs: [id, s.curveId] });
    return id;
  }

  setTool(tool: SkTool | null) {
    this.tool?.cancel();
    this.tool = tool;
    this.preview = { lines: [], points: [], dashed: [], guides: [] };
    this.tipEl.hidden = true;
    this.app.viewport.canvas.style.cursor = tool ? 'crosshair' : 'default';
    this.app.setStatus(tool ? tool.hint : 'Select sketch entities, drag them, or pick a sketch tool.');
    this.app.refreshSketchPanel();
    this.app.commands.changed();
    this.render();
  }

  setPreview(lines: Vec2[][], points: Vec2[] = [], dashed: Vec2[][] = []) {
    this.preview = { lines, points, dashed, guides: this.preview.guides };
    this.queueRender();
  }

  // ---------- picking ----------

  toSketch(e: { x: number; y: number }): Vec2 | null {
    return this.app.viewport.planePoint(this.frame, e.x, e.y);
  }

  toScreen(p: Vec2): [number, number] {
    return this.app.viewport.project(toWorld(this.frame, p));
  }

  pickAt(p: Vec2, tolPx = 7): Pickable | null {
    const sk = this.sketch;
    const tol = this.px * tolPx;
    let best: Pickable | null = null;
    let bd = tol;
    if (dist2(p, [0, 0]) < bd) { bd = dist2(p, [0, 0]); best = { kind: 'point', id: ORIGIN_ID }; }
    for (const e of sk.entities) {
      if (e.t !== 'point') continue;
      const d = dist2(p, [e.x, e.y]);
      if (d < bd) { bd = d; best = { kind: 'point', id: e.id }; }
    }
    if (best) return best;
    const ix = new SketchIndex(sk.entities);
    bd = tol;
    for (const e of sk.entities) {
      if (e.t === 'point') continue;
      const r = distanceToCurve(ix, e as SkCurve, p);
      if (r.d < bd) { bd = r.d; best = { kind: 'curve', id: e.id }; }
    }
    return best;
  }

  // ---------- ViewportTool ----------

  pointerDown(e: VPEvent): boolean {
    const raw = this.toSketch(e);
    if (!raw) return false;
    if (this.tool) {
      const s = this.tool.picks ? { p: raw, raw, kind: 'none' as const } : this.snap(raw, e);
      return this.tool.down?.(s, e) ?? false;
    }
    // Select tool: drag points/curves, else box select.
    const hit = this.pickAt(raw);
    const sk = this.sketch;
    if (hit && !(hit.kind === 'point' && hit.id === ORIGIN_ID)) {
      const ix = new SketchIndex(sk.entities);
      const ent = ix.get(hit.id)!;
      if (!this.app.selection.has({ kind: 'sk', id: hit.id }) && !e.shift && !e.ctrl) this.app.selection.set([{ kind: 'sk', id: hit.id }]);
      if (ent.t === 'circle' && hit.kind === 'curve') {
        this.drag = { kind: 'radius', circle: ent.id, moved: false };
      } else {
        // Drag every selected point (and curves' points) together.
        const ids = new Set<Id>();
        for (const sid of this.selectedIds()) {
          const se = ix.get(sid);
          if (se) for (const p of pointIdsOf(se)) ids.add(p);
        }
        ids.delete(ORIGIN_ID);
        const list = [...ids];
        this.drag = { kind: 'points', ids: list, start: list.map((id) => ix.pt(id)), grab: raw, moved: false };
      }
      this.app.store.beginBatch('Drag sketch geometry');
      return true;
    }
    this.drag = { kind: 'box', boxStart: { x: e.x, y: e.y }, moved: false };
    return true;
  }

  pointerMove(e: VPEvent, dragging: boolean) {
    const raw = this.toSketch(e);
    if (!raw) return;
    this.cursorPt = raw;
    if (this.tool) {
      const s = this.tool.picks ? { p: raw, raw, kind: 'none' as const } : this.snap(raw, e);
      this.lastSnap = s;
      this.tool.move?.(s, e, dragging);
      this.updateGuides(s);
      this.showTip(e, s);
      return;
    }
    if (!dragging || !this.drag) {
      this.hoverAt(raw);
      this.showTip(e, null);
      return;
    }
    const d = this.drag;
    d.moved = true;
    if (d.kind === 'box') {
      this.drawBox(d.boxStart!, { x: e.x, y: e.y });
      return;
    }
    const sk = this.sketch;
    if (d.kind === 'radius') {
      const ix = new SketchIndex(sk.entities);
      const c = sk.entities.find((x) => x.id === d.circle)!;
      if (c.t !== 'circle') return;
      const r = dist2(ix.pt(c.c), raw);
      this.app.store.change('Drag', (doc) => {
        const s2 = doc.features.find((f) => f.id === this.sketchId) as SketchFeature;
        this.solve = solveSketch(s2.entities, s2.constraints, { value: this.dimValue, drag: { kind: 'radius', id: c.id, r }, analyze: false });
      }, 'sketch');
    } else if (d.kind === 'points' && d.ids!.length) {
      const dx = raw[0] - d.grab![0], dy = raw[1] - d.grab![1];
      const targets = d.start!.map((p) => [p[0] + dx, p[1] + dy] as Vec2);
      this.app.store.change('Drag', (doc) => {
        const s2 = doc.features.find((f) => f.id === this.sketchId) as SketchFeature;
        this.solve = solveSketch(s2.entities, s2.constraints, { value: this.dimValue, drag: { kind: 'points', ids: d.ids!, targets }, analyze: false });
      }, 'sketch');
    }
    this.queueRender();
  }

  pointerUp(e: VPEvent) {
    if (this.tool) {
      const raw = this.toSketch(e);
      if (raw) this.tool.up?.(this.tool.picks ? { p: raw, raw, kind: 'none' } : this.snap(raw, e), e);
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'box') {
      this.boxEl?.remove();
      this.boxEl = null;
      if (d.moved) this.boxSelect(d.boxStart!, { x: e.x, y: e.y }, e.shift || e.ctrl);
      else if (!e.shift && !e.ctrl) this.app.selection.clear();
      return;
    }
    this.app.store.endBatch();
    if (d.moved) {
      this.resolve();
      this.app.refreshSketchPanel();
    }
  }

  click(e: VPEvent): boolean {
    // A press that did not move ends any drag that pointerDown started.
    const d = this.drag;
    this.drag = null;
    if (d && (d.kind === 'points' || d.kind === 'radius')) this.app.store.endBatch();
    const raw = this.toSketch(e);
    if (!raw) return true;
    if (this.tool) {
      const s = this.tool.picks ? { p: raw, raw, kind: 'none' as const } : this.snap(raw, e);
      this.tool.click?.(s, e);
      return true;
    }
    const hit = this.pickAt(raw);
    if (hit) {
      const it = { kind: 'sk' as const, id: hit.id };
      if (e.shift || e.ctrl) this.app.selection.toggle(it);
      else this.app.selection.set([it]);
      this.showQuickRelations(e);
      return true;
    }
    // Fall through to model picking (faces/edges for convert entities).
    return false;
  }

  dblClick(e: VPEvent): boolean {
    const raw = this.toSketch(e);
    if (!raw) return true;
    if (this.tool) {
      const s = this.tool.picks ? { p: raw, raw, kind: 'none' as const } : this.snap(raw, e);
      this.tool.dbl?.(s, e);
      return true;
    }
    return true;
  }

  hover(e: VPEvent) {
    if (this.tool) return;
    const raw = this.toSketch(e);
    if (raw) this.hoverAt(raw);
  }

  leave() {
    this.tipEl.hidden = true;
    if (this.hovered) { this.hovered = null; this.queueRender(); }
  }

  private hoverAt(raw: Vec2) {
    const hit = this.pickAt(raw);
    const same = (!hit && !this.hovered) || (hit && this.hovered && hit.id === this.hovered.id);
    if (!same) {
      this.hovered = hit;
      this.queueRender();
    }
    if (!hit) {
      // Allow model faces/edges to pre-highlight (for Convert Entities).
      this.app.selection.setHover(this.app.viewport.pickItem(this.app.viewport.mouse?.x ?? 0, this.app.viewport.mouse?.y ?? 0, { edge: true }));
    } else this.app.selection.setHover(null);
  }

  /** Context toolbar with the relations that fit the selection. */
  private showQuickRelations(e: VPEvent) {
    if (e.pointerType === 'touch') return;
    const ids = this.selectedIds();
    if (!ids.length) { this.app.hideContextToolbar(); return; }
    const types = availableRelations(this.sketch, ids).filter((t) => t !== 'fix' || ids.length === 1);
    const buttons = types.map((t) => ({
      icon: 'relation', label: `Make ${RELATION_LABELS[t]}`, glyph: relationGlyph(t, 16),
      run: () => this.edit(`Add ${RELATION_LABELS[t].toLowerCase()} relation`, (sk, newId) => { sk.constraints.push(...makeRelations(sk, t, ids, newId)); }, { select: ids }),
    }));
    if (ids.some((id) => this.sketch.entities.find((x) => x.id === id && x.t !== 'point'))) {
      buttons.push({ icon: 'construction', label: 'Construction Geometry', glyph: icon('construction', 18), run: () => this.toggleConstruction() });
    }
    this.app.showFloatingToolbar(buttons, e.x + 14, e.y - 48, 'Sketch relations', 5000);
  }

  // ---------- box selection ----------

  private drawBox(a: { x: number; y: number }, b: { x: number; y: number }) {
    if (!this.boxEl) {
      this.boxEl = h('div', { class: 'box-select' });
      this.app.viewport.root.append(this.boxEl);
    }
    const crossing = b.x < a.x;
    this.boxEl.classList.toggle('crossing', crossing);
    Object.assign(this.boxEl.style, {
      left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`,
      width: `${Math.abs(b.x - a.x)}px`, height: `${Math.abs(b.y - a.y)}px`,
    });
  }

  private boxSelect(a: { x: number; y: number }, b: { x: number; y: number }, additive: boolean) {
    const crossing = b.x < a.x;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const inside = (p: Vec2) => {
      const s = this.toScreen(p);
      return s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1;
    };
    const sk = this.sketch;
    const ix = new SketchIndex(sk.entities);
    const picked: Id[] = [];
    const used = usedPoints(sk.entities);
    for (const e of sk.entities) {
      if (e.t === 'point') {
        if (!used.has(e.id) && inside([e.x, e.y])) picked.push(e.id);
        continue;
      }
      const poly = tessellate(ix, e, this.px * 2);
      const hits = poly.map(inside);
      if (crossing ? hits.some(Boolean) : hits.every(Boolean)) picked.push(e.id);
    }
    const items = picked.map((id) => ({ kind: 'sk' as const, id }));
    if (additive) items.forEach((it) => this.app.selection.add(it));
    else this.app.selection.set(items);
  }

  // ---------- deletion and construction ----------

  deleteSelection(): boolean {
    const ids = this.selectedIds(['sk', 'skdim', 'skrel']).filter((id) => id !== ORIGIN_ID);
    if (!ids.length) return false;
    this.edit('Delete', (sk) => deleteItems(sk, ids));
    this.app.selection.clear();
    return true;
  }

  toggleConstruction() {
    const ids = this.selectedIds();
    if (!ids.length) return;
    this.edit('Construction geometry', (sk) => {
      const ents = sk.entities.filter((e) => ids.includes(e.id) && e.t !== 'point');
      const on = !ents.every((e) => e.construction);
      ents.forEach((e) => { e.construction = on; });
    });
  }

  // ---------- dimensions ----------

  /** Adds a driving dimension; falls back to driven if it would over-define. */
  addDimension(spec: { type: SkDimension['type']; refs: Id[]; value: number; sector?: number }, at: Vec2, openModify = true): Id | null {
    let newDimId: Id | null = null;
    this.edit('Add dimension', (sk, newId) => {
      const id = newId('d');
      newDimId = id;
      sk.constraints.push({ id, type: spec.type, refs: spec.refs, value: round(spec.value), at, name: nextDimName(sk), sector: spec.sector });
    });
    if (!newDimId) return null;
    const res = this.solve;
    if (res && (res.badConstraints.has(newDimId) || res.status === 'over')) {
      this.edit('Make dimension driven', (sk) => {
        const d = sk.constraints.find((c) => c.id === newDimId) as SkDimension;
        d.driven = true;
      });
      toast({ kind: 'warning', title: 'Driven dimension', message: 'This dimension would over-define the sketch, so it was added as a driven (reference) dimension.' });
      return newDimId;
    }
    if (openModify) this.openModify(newDimId);
    return newDimId;
  }

  /** Floating box to edit a dimension value (accepts expressions and units). */
  openModify(dimId: Id) {
    this.closeModify();
    const sk = this.sketch;
    const d = sk.constraints.find((c) => c.id === dimId) as SkDimension | undefined;
    if (!d) return;
    if (d.driven) {
      toast({ message: 'This is a driven (reference) dimension. Make it driving from its context menu to edit its value.' });
      return;
    }
    const units = this.app.store.doc.units;
    const scale = d.type === 'angle' ? 1 : UNIT_SYSTEMS[units].scale;
    const initial = typeof d.value === 'string' ? d.value : String(Number((Number(d.value) / scale).toFixed(8)));
    const input = h('input', { class: 'input', value: initial, 'aria-label': `Value of ${d.name}`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    const err = h('div', { class: 'err', role: 'alert' });
    const original = d.value;
    const evalText = (t: string): { ok: true; v: Param } | { ok: false; e: string } => {
      const s = t.trim();
      try {
        const num = evaluate(s.replace(/^=/, ''), {
          kind: d.type === 'angle' ? 'angle' : 'length',
          bareScale: scale,
          lookup: (n) => this.app.variables().get(n),
        });
        if (!(num > 0) && d.type !== 'angle') return { ok: false, e: 'Value must be greater than zero' };
        return { ok: true, v: s.startsWith('=') ? s : num };
      } catch (e) {
        return { ok: false, e: (e as Error).message };
      }
    };
    const apply = (live: boolean) => {
      const r = evalText(input.value);
      if (!r.ok) { err.textContent = r.e; input.classList.add('invalid'); return false; }
      err.textContent = '';
      input.classList.remove('invalid');
      if (live) {
        // Live preview without an undo step.
        const dd = this.sketch.constraints.find((c) => c.id === dimId) as SkDimension;
        dd.value = r.v;
        this.resolve();
      } else {
        const dd = this.sketch.constraints.find((c) => c.id === dimId) as SkDimension;
        dd.value = original;
        this.edit('Change dimension', (s2) => { (s2.constraints.find((c) => c.id === dimId) as SkDimension).value = r.v; });
      }
      return true;
    };
    const cancel = () => {
      const dd = this.sketch.constraints.find((c) => c.id === dimId) as SkDimension | undefined;
      if (dd) dd.value = original;
      this.resolve();
      this.closeModify();
    };
    const ok = () => { if (apply(false)) this.closeModify(); };
    input.addEventListener('input', () => apply(true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    const box = h('div', { class: 'modify-box', role: 'dialog', 'aria-label': `Modify ${d.name}` },
      h('div', { class: 'mb-head' },
        h('button', { class: 'icon-btn', 'aria-label': 'Apply value', style: { color: 'var(--success)' }, onclick: ok }, icon('check', 16)),
        h('button', { class: 'icon-btn', 'aria-label': 'Cancel', style: { color: 'var(--danger)' }, onclick: cancel }, icon('close', 16)),
        h('span', { class: 'grow' }, `${d.name}@${this.sketch.name}`)),
      input, err);
    this.app.viewport.root.append(box);
    this.modify = box;
    const [sx, sy] = this.toScreen(d.at);
    const rootW = this.app.viewport.root.clientWidth;
    box.style.left = `${Math.max(4, Math.min(rootW - 200, sx + 14))}px`;
    box.style.top = `${Math.max(4, sy - 70)}px`;
    requestAnimationFrame(() => { input.focus(); input.select(); });
    const outside = (ev: PointerEvent) => {
      if (!box.contains(ev.target as Node)) { document.removeEventListener('pointerdown', outside, true); if (this.modify === box) ok(); }
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }

  closeModify() {
    this.modify?.remove();
    this.modify = null;
  }

  get modifyOpen(): boolean {
    return !!this.modify;
  }

  // ---------- rendering ----------

  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = requestAnimationFrame(() => {
      this.renderQueued = 0;
      this.render();
    });
  }

  private colorFor(e: SkEntity, selected: boolean, hovered: boolean): number[] {
    const css = this.app.colors;
    if (selected) return css.sketchSelected;
    if (hovered) return css.hover;
    const bad = this.solve && [...this.solve.conflicting].some((cid) => this.sketch.constraints.find((c) => c.id === cid)?.refs.includes(e.id));
    if (bad) return css.sketchOver;
    if (e.construction) return css.sketchConstruction;
    const free = !this.solve || this.solve.freeEntities.has(e.id);
    return free ? css.sketchUnder : css.sketchFull;
  }

  render() {
    const sk = this.sketch;
    if (!sk) return;
    const r = this.app.renderer;
    const fr = this.frame;
    const ix = new SketchIndex(sk.entities);
    const selected = new Set(this.selectedIds(['sk']));
    const hoverId = this.hovered?.id;
    const tol = Math.max(this.px * 0.4, 1e-5);
    const pos: number[] = [], col: number[] = [];
    const dpos: number[] = [], dcol: number[] = [];
    const push = (arr: number[], carr: number[], a: Vec3, b: Vec3, c: number[], alpha = 255) => {
      arr.push(...a, ...b);
      carr.push(c[0] * 255, c[1] * 255, c[2] * 255, alpha);
    };
    for (const e of sk.entities) {
      if (e.t === 'point') continue;
      const c = this.colorFor(e, selected.has(e.id), hoverId === e.id);
      const poly = tessellate(ix, e, tol);
      const target = e.construction ? dpos : pos;
      const ctarget = e.construction ? dcol : col;
      for (let i = 0; i + 1 < poly.length; i++) push(target, ctarget, toWorld(fr, poly[i]), toWorld(fr, poly[i + 1]), c);
    }
    const width = selected.size || hoverId ? 2 : 1.6;
    r.setLines('sk-active', pos.length ? { positions: new Float32Array(pos), colors: new Uint8Array(col), width, depth: 'always', order: 10 } : null);
    r.setLines('sk-construction', dpos.length ? { positions: new Float32Array(dpos), colors: new Uint8Array(dcol), width: 1.3, depth: 'always', dash: 6, order: 10 } : null);

    // Points: end points small squares, sketch points discs, origin ring.
    const used = usedPoints(sk.entities);
    const centers = new Set<Id>();
    for (const e of sk.entities) if (e.t === 'circle' || e.t === 'arc') centers.add(e.c);
    const ppos: number[] = [], pcol: number[] = [], psz: number[] = [];
    for (const e of sk.entities) {
      if (e.t !== 'point') continue;
      const isSel = selected.has(e.id), isHov = hoverId === e.id;
      const c = this.colorFor(e, isSel, isHov);
      ppos.push(...toWorld(fr, [e.x, e.y]));
      pcol.push(c[0] * 255, c[1] * 255, c[2] * 255, 255);
      const standalone = !used.has(e.id);
      psz.push(standalone ? 8 : centers.has(e.id) ? 6 : isSel || isHov ? 7 : 5, standalone ? 1 : centers.has(e.id) ? 2 : 0);
    }
    const oSel = this.app.selection.has({ kind: 'sk', id: ORIGIN_ID }) || hoverId === ORIGIN_ID;
    ppos.push(...toWorld(fr, [0, 0]));
    pcol.push(...(oSel ? [240, 130, 30, 255] : [200, 50, 40, 255]));
    psz.push(9, 2);
    r.setPoints('sk-points', { positions: new Float32Array(ppos), colors: new Uint8Array(pcol), sizeStyle: new Float32Array(psz), depth: 'always', order: 12 });

    // Tool preview and inference guides.
    const prev: number[] = [], pc: number[] = [];
    const pv = this.app.colors.sketchUnder;
    for (const l of this.preview.lines) for (let i = 0; i + 1 < l.length; i++) push(prev, pc, toWorld(fr, l[i]), toWorld(fr, l[i + 1]), pv);
    r.setLines('sk-preview', prev.length ? { positions: new Float32Array(prev), colors: new Uint8Array(pc), width: 1.6, depth: 'always', order: 13 } : null);
    const gpos: number[] = [], gcol: number[] = [];
    for (const l of [...this.preview.dashed, ...this.preview.guides]) for (let i = 0; i + 1 < l.length; i++) push(gpos, gcol, toWorld(fr, l[i]), toWorld(fr, l[i + 1]), this.app.colors.sketchConstruction, 220);
    r.setLines('sk-guides', gpos.length ? { positions: new Float32Array(gpos), colors: new Uint8Array(gcol), width: 1, depth: 'always', dash: 3, order: 13 } : null);
    r.setPoints('sk-preview-pts', this.preview.points.length ? {
      positions: new Float32Array(this.preview.points.flatMap((p) => toWorld(fr, p))),
      colors: new Uint8Array(this.preview.points.length * 4).map((_, i) => [pv[0] * 255, pv[1] * 255, pv[2] * 255, 255][i % 4]),
      sizeStyle: new Float32Array(this.preview.points.length * 2).map((_, i) => (i % 2 ? 0 : 6)), depth: 'always', order: 14,
    } : null);

    this.renderDimensions();
    this.renderRelations();
    this.app.updateSketchStatus();
  }

  private renderDimensions() {
    const sk = this.sketch;
    const r = this.app.renderer;
    const dims = sk.constraints.filter(isDimension);
    const keep = new Set<Id>();
    const pos: number[] = [], col: number[] = [];
    const sel = new Set(this.selectedIds(['skdim']));
    const units = this.app.store.doc.units;
    const decimals = this.app.store.doc.decimals;
    const bad = this.solve?.badConstraints ?? new Set<Id>();
    if (this.showDimensions) {
      for (const d of dims) {
        const g = dimGraphics(sk, d, this.px);
        if (!g) continue;
        keep.add(d.id);
        const c = sel.has(d.id) ? this.app.colors.sketchSelected : d.driven ? this.app.colors.dimensionDriven : bad.has(d.id) ? this.app.colors.sketchOver : this.app.colors.dimension;
        for (const l of g.lines) for (let i = 0; i + 1 < l.length; i++) {
          pos.push(...toWorld(this.frame, l[i]), ...toWorld(this.frame, l[i + 1]));
          col.push(c[0] * 255, c[1] * 255, c[2] * 255, 255);
        }
        let el = this.labels.get(d.id);
        if (!el) {
          el = this.makeLabel(d.id);
          this.labels.set(d.id, el);
          this.app.viewport.overlay.append(el);
        }
        const v = measureDimension(sk, d);
        const text = d.type === 'angle' ? `${formatNumber(v, Math.max(0, decimals - 1))}°` : `${d.type === 'diameter' ? '⌀' : d.type === 'radius' ? 'R' : ''}${formatNumber(v / UNIT_SYSTEMS[units].scale, decimals)}`;
        el.textContent = d.driven ? `(${text})` : text;
        el.className = `dim-label${d.driven ? ' driven' : ''}${bad.has(d.id) ? ' bad' : ''}${typeof d.value === 'string' ? ' expr' : ''}${sel.has(d.id) ? ' selected' : ''}`;
        el.title = `${d.name}${typeof d.value === 'string' ? ` = ${d.value.replace(/^=/, '')}` : ''}`;
        el.setAttribute('aria-label', `Dimension ${d.name}: ${text}`);
        const [x, y] = this.toScreen(g.label);
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      }
    }
    for (const [id, el] of this.labels) if (!keep.has(id)) { el.remove(); this.labels.delete(id); }
    r.setLines('sk-dims', pos.length ? { positions: new Float32Array(pos), colors: new Uint8Array(col), width: 1, depth: 'always', order: 11 } : null);
  }

  private makeLabel(id: Id): HTMLElement {
    const el = h('div', { class: 'dim-label', role: 'button', tabindex: '-1' });
    let start: { x: number; y: number; at: Vec2 } | null = null;
    let moved = false;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const d = this.sketch.constraints.find((c) => c.id === id) as SkDimension;
      start = { x: e.clientX, y: e.clientY, at: [...d.at] as Vec2 };
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) return;
      if (!moved) this.app.store.beginBatch('Move dimension');
      moved = true;
      const rect = this.app.viewport.canvas.getBoundingClientRect();
      const p = this.toSketch({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (!p) return;
      this.app.store.change('Move dimension', (doc) => {
        const sk = doc.features.find((f) => f.id === this.sketchId) as SketchFeature;
        const d = sk.constraints.find((c) => c.id === id) as SkDimension;
        d.at = p;
      }, 'sketch');
      this.queueRender();
    });
    el.addEventListener('pointerup', (e) => {
      if (!start) return;
      start = null;
      if (moved) { this.app.store.endBatch(); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) this.app.selection.toggle({ kind: 'skdim', id });
      else this.app.selection.set([{ kind: 'skdim', id }]);
    });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); this.openModify(id); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.app.selection.set([{ kind: 'skdim', id }]);
      this.app.openDimensionMenu(id, e.clientX, e.clientY);
    });
    return el;
  }

  private renderRelations() {
    const sk = this.sketch;
    const keep = new Set<Id>();
    const ix = new SketchIndex(sk.entities);
    const sel = new Set(this.selectedIds(['skrel']));
    const bad = this.solve?.badConstraints ?? new Set<Id>();
    const slots = new Map<string, number>();
    if (this.showRelations) {
      for (const c of sk.constraints) {
        if (isDimension(c)) continue;
        keep.add(c.id);
        const anchors = this.relationAnchors(c, ix);
        let els = this.badges.get(c.id);
        if (!els || els.length !== anchors.length) {
          els?.forEach((x) => x.remove());
          els = anchors.map(() => this.makeBadge(c.id, c.type));
          this.badges.set(c.id, els);
          els.forEach((x) => this.app.viewport.overlay.append(x));
        }
        anchors.forEach((p, i) => {
          const [x, y] = this.toScreen(p);
          const key = `${Math.round(x / 12)},${Math.round(y / 12)}`;
          const n = slots.get(key) ?? 0;
          slots.set(key, n + 1);
          const el = els![i];
          el.style.left = `${x + 14 + n * 20}px`;
          el.style.top = `${y - 14}px`;
          el.classList.toggle('bad', bad.has(c.id));
          el.classList.toggle('selected', sel.has(c.id));
        });
      }
    }
    for (const [id, els] of this.badges) if (!keep.has(id)) { els.forEach((x) => x.remove()); this.badges.delete(id); }
  }

  private relationAnchors(c: SkConstraint, ix: SketchIndex): Vec2[] {
    const at = (id: Id): Vec2 | null => {
      if (id === ORIGIN_ID) return [0, 0];
      const e = ix.get(id);
      if (!e) return null;
      if (e.t === 'point') return [e.x, e.y];
      if (e.t === 'line') { const a = ix.pt(e.a), b = ix.pt(e.b); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
      if (e.t === 'circle') { const p = ix.pt(e.c); return [p[0] + e.r * 0.7071, p[1] + e.r * 0.7071]; }
      if (e.t === 'arc') { const p = tessellate(ix, e, 0.05); return p[Math.floor(p.length / 2)]; }
      if (e.t === 'spline') return ix.pt(e.pts[Math.floor(e.pts.length / 2)]);
      return null;
    };
    if (c.type === 'coincident' || c.type === 'midpoint') {
      const p = at(c.refs.find((r) => r === ORIGIN_ID || ix.get(r)?.t === 'point') ?? c.refs[0]);
      return p ? [p] : [];
    }
    if (c.type === 'symmetric') return c.refs.slice(0, 2).map(at).filter((p): p is Vec2 => !!p);
    return c.refs.map(at).filter((p): p is Vec2 => !!p);
  }

  private makeBadge(id: Id, type: string): HTMLElement {
    const el = h('div', { class: 'rel-badge', role: 'button', tabindex: '-1', title: type[0].toUpperCase() + type.slice(1), 'aria-label': `${type} relation` }, relationGlyph(type, 12));
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.shiftKey || e.ctrlKey || e.metaKey) this.app.selection.toggle({ kind: 'skrel', id });
      else this.app.selection.set([{ kind: 'skrel', id }]);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.app.selection.set([{ kind: 'skrel', id }]);
      this.app.openRelationMenu(id, e.clientX, e.clientY);
    });
    return el;
  }

  /** Re-positions DOM overlays after the camera moved. */
  onCamera() {
    this.render();
  }

  private updateGuides(s: Snap) {
    const guides: Vec2[][] = [];
    if (s.guide) guides.push([s.guide, s.p]);
    const from = this.tool?.from?.();
    if (from && (s.kind === 'h' || s.kind === 'v')) guides.push([from, s.p]);
    this.preview.guides = guides;
    this.queueRender();
  }

  private showTip(e: VPEvent, s: Snap | null) {
    const tip = this.tipEl;
    if (!s || e.pointerType === 'touch') { tip.hidden = true; return; }
    const units = this.app.store.doc.units;
    const sc = UNIT_SYSTEMS[units].scale;
    const dec = this.app.store.doc.decimals;
    tip.textContent = '';
    const glyph = SNAP_GLYPH[s.kind];
    if (glyph) tip.append(relationGlyph(glyph, 12));
    const from = this.tool?.from?.();
    let text = `${formatNumber(s.p[0] / sc, dec)}, ${formatNumber(s.p[1] / sc, dec)}`;
    if (from) {
      const len = dist2(from, s.p) / sc;
      const ang = (Math.atan2(s.p[1] - from[1], s.p[0] - from[0]) * 180) / Math.PI;
      text = `L ${formatNumber(len, dec)}  A ${formatNumber(ang, 1)}°`;
    }
    tip.append(text);
    tip.hidden = false;
    tip.style.left = `${e.x + 16}px`;
    tip.style.top = `${e.y + 18}px`;
  }

  bounds(): { center: Vec3; radius: number } | null {
    const b = sketchBounds(new SketchIndex(this.sketch?.entities ?? []));
    if (!b) return null;
    const c: Vec2 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
    return { center: toWorld(this.frame, c), radius: Math.max(dist2(b.min, b.max) / 2, 1) };
  }

  statusText(): string {
    if (!this.solve) return '';
    return STATUS_TEXT[this.solve.status];
  }

  /** Converts a 3D point to sketch coordinates. */
  local(p: Vec3): Vec2 {
    return toLocal(this.frame, p);
  }

  dispose() {
    this.tool?.cancel();
    this.closeModify();
    this.tipEl.remove();
    this.boxEl?.remove();
    for (const el of this.labels.values()) el.remove();
    for (const els of this.badges.values()) els.forEach((x) => x.remove());
    const r = this.app.renderer;
    for (const k of ['sk-active', 'sk-construction', 'sk-preview', 'sk-guides', 'sk-dims']) r.setLines(k, null);
    for (const k of ['sk-points', 'sk-preview-pts']) r.setPoints(k, null);
    this.app.viewport.canvas.style.cursor = 'default';
  }

  /** The last snapped cursor (for tools that commit on keyboard input). */
  get snapped(): Snap | null {
    return this.lastSnap;
  }
}

const round = (v: number) => Number(v.toFixed(6));
