// Board editor: layered WebGL drawing, interactive tools, connectivity and
// ratsnest, copper pours and online design rule checks through the kernel
// worker, net highlighting, and the 3D view.

import { CanvasView } from './view.js';
import { SelectTool } from './select-tool.js';
import { RouteTool, PlacePcbTool, PolygonTool, LineTool, TURN_KEYS } from './pcb-tools.js';
import { Batch } from '../render/batch.js';
import { pack, toVec4 } from '../render/color.js';
import { PCB_PALETTES, layerColor } from '../render/palette.js';
import { buildPcbLayers, buildBoardShape, layerDrawOrder, emitPcbObject, drawPadShape, placedOf } from '../render/pcb-scene.js';
import { resolvedTheme } from '../app/theme.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { contextMenu } from '../ui/menu.js';
import { promptDialog } from '../ui/dialog.js';
import { installVertexEditing } from './vertex.js';
import { LAYERS, boardLayers, copperLayers, isCopper } from '../model/layers.js';
import { pcbBounds, pcbHitDistance, PCB_PICK_ORDER, objectLayers, translatePcb, rotatePcb, flipComp, padDistance, pcbPickable } from '../model/pcb.js';
import { analyseBoard, itemDistance } from '../model/connectivity.js';
import { bboxOfFlat, bboxUnion, bboxEmpty, bboxContains, bboxIntersects } from '../core/geom.js';
import { mm, formatLength, snap } from '../core/units.js';
import { uid } from '../core/emitter.js';
import RBush from 'rbush';

const DEFAULT_HIDDEN = new Set(['topPaste', 'bottomPaste', 'topSolder', 'bottomSolder', 'drill', 'courtyard', 'mech2']);

export class PcbEditor extends CanvasView {
  constructor(app, project, doc) {
    super(app, { label: `Board ${doc.name}` });
    this.kind = 'pcb';
    this.project = project;
    this.doc = doc;
    this.selection = new Set();
    this.activeLayer = 'top';
    this.hiddenLayers = new Set(DEFAULT_HIDDEN);
    this.singleLayer = 'off'; // 'off' | 'gray' | 'hide'
    this.highlight = null;
    this.routeNet = null;
    this.hidden = new Set();
    this.pourFills = new Map();
    this.violations = [];
    this.layerBatches = new Map();
    this.boardBatch = new Batch();
    this.ratsBatch = new Batch();
    this.selBatch = new Batch();
    this.hlBatch = new Batch();
    this.drcBatch = new Batch();
    this.labelBatch = new Batch();
    this._dirtyLayers = new Set(['*']);
    this._dirtyBoard = true;
    this._analysis = null;
    this._analysisRev = -1;
    this._lastClick = null;
    this.select = new SelectTool(this);
    this.setTool(this.select);
    this._buildChrome();
    this._unsub = [
      doc.store.on('change', (e) => this._onChange(e)),
      // A replaced footprint moves pads without a new store revision: drop the cached connectivity.
      project.on('library', () => { this._analysis = null; this._dirtyLayers.add('*'); this._schedulePours(); this.requestRender(true); }),
      app.settings.on('change', ({ key }) => {
        if (key === 'layerColors' || key === 'pcbGridStyle') { this._dirtyLayers.add('*'); this.requestRender(true); }
        if (key === 'padLabels') this._scheduleLabels();
      }),
    ];
    this._onTheme = () => { this._dirtyLayers.add('*'); this._dirtyBoard = true; this._rebuildRats(); this.requestRender(true); };
    window.addEventListener('themechange', this._onTheme);
    this.on('view', () => this._scheduleLabels());
    this.on('cursor', () => this._updateHud());
    this._updateHud();
    this._schedulePours(0);
  }

  get lib() { return this.project.library; }
  get palette() { return PCB_PALETTES[resolvedTheme()]; }
  get grid() { return this.app.settings.get('pcbGrid') || mm(0.25); }
  get units() { return this.app.settings.get('units'); }
  get copperCount() { return this.doc.board?.copper || 2; }
  isCopper(l) { return isCopper(l); }

  layerColor(l) { return layerColor(l, this.app.settings.get('layerColors')); }

  layerColorsWithAlpha(alpha) {
    const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
    const out = {};
    for (const l of Object.keys(LAYERS)) out[l] = this.layerColor(l).slice(0, 7) + a;
    return out;
  }

  sceneContext() {
    return {
      lib: this.lib, count: this.copperCount, pal: this.palette, colors: this.app.settings.get('layerColors'),
      rules: this.doc.rules, pourFills: this.pourFills, formatLength: (v) => formatLength(v, this.units),
    };
  }

  /**
   * Context for previews of objects being moved, pasted or reshaped: pour
   * fills belong to the committed outline, so previews draw outlines only.
   */
  previewContext() {
    return { ...this.sceneContext(), pourFills: null };
  }

  netClassOf(net) {
    if (!net) return null;
    const rules = this.doc.rules;
    const named = this.doc.nets?.[net]?.class;
    if (named && rules.netClasses?.[named]) return rules.netClasses[named];
    for (const cls of Object.values(rules.netClasses || {})) if (cls.nets?.includes(net)) return cls;
    return null;
  }

  // ---- Chrome: layer tabs and 3D host ----

  _buildChrome() {
    this.layerBar = h('div.layer-tabs', { role: 'tablist', 'aria-label': 'Board layers' });
    this.el.append(this.layerBar);
    this._renderLayerTabs();
  }

  _renderLayerTabs() {
    const bar = this.layerBar;
    bar.replaceChildren();
    const cur = h('span.layer-current', { style: { background: this.layerColor(this.activeLayer) }, title: `Current layer: ${LAYERS[this.activeLayer].name}` });
    bar.append(cur);
    for (const l of boardLayers(this.copperCount)) {
      const sel = l === this.activeLayer;
      const tab = h('button.layer-tab', {
        type: 'button', role: 'tab', 'aria-selected': String(sel), tabindex: sel ? 0 : -1,
        class: { 'hidden-layer': this.hiddenLayers.has(l) },
        title: `${LAYERS[l].name}${this.hiddenLayers.has(l) ? ' (hidden)' : ''}. Right click to show or hide`,
        onClick: () => { this.setActiveLayer(l); this.canvas.focus(); },
        onContextmenu: (e) => {
          e.preventDefault();
          contextMenu(e, [
            { label: this.hiddenLayers.has(l) ? 'Show layer' : 'Hide layer', run: () => this.toggleLayer(l) },
            { label: 'Show only this layer', run: () => { this.hiddenLayers = new Set(boardLayers(this.copperCount).filter((x) => x !== l)); this.setActiveLayer(l); this._layersChanged(); } },
            { label: 'Show all layers', run: () => { this.hiddenLayers.clear(); this._layersChanged(); } },
            { label: 'Default layer set', run: () => { this.hiddenLayers = new Set(DEFAULT_HIDDEN); this._layersChanged(); } },
          ], 'Layer');
        },
      }, h('span.swatch', { style: { background: this.layerColor(l) } }), LAYERS[l].name);
      bar.append(tab);
    }
    bar.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      this.stepLayer(e.key === 'ArrowRight' ? 1 : -1, false);
      bar.querySelector('[aria-selected="true"]')?.focus();
    };
  }

  setActiveLayer(l) {
    if (!LAYERS[l] || l === this.activeLayer) return;
    this.activeLayer = l;
    this.hiddenLayers.delete(l);
    this._renderLayerTabs();
    this.updateHint();
    this._updateHud();
    this.requestRender(true);
    this.emit('layer', l);
    this.announce(`Current layer ${LAYERS[l].name}`);
  }

  /** Next or previous visible layer (copperOnly for routing layer changes). */
  stepLayer(dir, copperOnly = false) {
    const list = (copperOnly ? copperLayers(this.copperCount) : boardLayers(this.copperCount)).filter((l) => !this.hiddenLayers.has(l) || l === this.activeLayer);
    const i = list.indexOf(this.activeLayer);
    this.setActiveLayer(list[(i + dir + list.length) % list.length]);
  }

  toggleLayer(l) {
    if (this.hiddenLayers.has(l)) this.hiddenLayers.delete(l); else if (l !== this.activeLayer) this.hiddenLayers.add(l);
    this._layersChanged();
  }

  setLayerVisible(l, on) {
    if (on) this.hiddenLayers.delete(l); else if (l !== this.activeLayer) this.hiddenLayers.add(l);
    this._layersChanged();
  }

  _layersChanged() {
    this._renderLayerTabs();
    this._scheduleLabels();
    this.requestRender(true);
    this.emit('layers');
  }

  isLayerVisible(l) {
    if (this.singleLayer === 'hide' && l !== this.activeLayer && l !== 'holes' && l !== 'multi') return false;
    return !this.hiddenLayers.has(l);
  }

  cycleSingleLayer() {
    this.singleLayer = { off: 'gray', gray: 'hide', hide: 'off' }[this.singleLayer];
    this.app.toast({ off: 'Showing all layers', gray: 'Single layer mode: other layers grayed', hide: 'Single layer mode: other layers hidden' }[this.singleLayer], { timeout: 1800 });
    this._scheduleLabels();
    this.requestRender(true);
    this.emit('layers');
  }

  // ---- Changes and derived data ----

  _onChange(e) {
    // An edit from elsewhere in the middle of a drag (undo, Delete): the drag
    // holds the objects as they were, and committing it would write them back.
    if (this.select.move || this.select.vertex) this.select.cancelDrag();
    const touched = new Set();
    let boardChanged = false;
    const count = this.copperCount;
    const mark = (o) => {
      if (!o) return;
      if (o.t === 'board') { boardChanged = true; return; }
      if (o.t === 'rules') { for (const l of ['topSolder', 'bottomSolder', 'topPaste', 'bottomPaste']) touched.add(l); return; }
      if (o.t === 'nets') return;
      for (const l of objectLayers(o, this.lib, count)) touched.add(l);
      if (o.t === 'via' || o.t === 'comp' || o.t === 'pad') touched.add('holes');
    };
    for (const id of e.added) mark(this.doc.store.get(id));
    for (const [, before] of e.removed) mark(before);
    for (const [, { before, after }] of e.updated) { mark(before); mark(after); }
    for (const id of e.removed.keys()) this.selection.delete(id);
    // A shelved pour has no copper: its fill goes at once, whether or not a repour follows.
    for (const [id, { after }] of e.updated) {
      if (after.t !== 'pour' || !after.shelved || !this.pourFills.has(id)) continue;
      this.pourFills = new Map(this.pourFills);
      this.pourFills.delete(id);
    }
    // Undo and redo take back what an active tool placed (a route in progress).
    if (e.source === 'undo' || e.source === 'redo') this.tool?.historyChanged?.(e);
    if (boardChanged) {
      this._dirtyBoard = true;
      this._dirtyLayers.add('*');
      // Fewer copper layers (an undo, a layer stack edit): leave a removed layer.
      if (!boardLayers(count).includes(this.activeLayer)) this.setActiveLayer('top');
      this._renderLayerTabs();
    }
    for (const l of touched) this._dirtyLayers.add(l);
    // Connectivity is recomputed once edits pause (tools that need it call analysis() directly).
    clearTimeout(this._ratsTimer);
    this._ratsTimer = setTimeout(() => { this._rebuildRats(); if (this.highlight) this._rebuildHighlight(); this.requestRender(); }, 40);
    if (this.highlight) this._rebuildHighlight();
    this._rebuildSelection();
    this._schedulePours();
    this._scheduleLabels();
    this.requestRender(true);
    this.emit('selection', this.selection);
  }

  /** Connectivity analysis, recomputed when the board has changed. */
  analysis() {
    if (this._analysis && this._analysisRev === this.doc.store.revision && this._analysisFills === this.pourFills) return this._analysis;
    this._analysis = analyseBoard(this.doc, [...this.doc.items()], this.lib, { pourFills: this.pourFills });
    this._analysisRev = this.doc.store.revision;
    this._analysisFills = this.pourFills;
    const tree = new RBush(16);
    tree.load(this._analysis.items.map((it) => ({ ...it.box, it })));
    this._copperTree = tree;
    return this._analysis;
  }

  _rebuildRats() {
    const b = this.ratsBatch;
    b.clear();
    const a = this.analysis();
    const col = pack(this.palette.ratsnest, 0.85);
    for (const l of a.ratsnest) {
      if (this.highlight && l.net !== this.highlight.net) continue;
      if (this._ratsSkip?.has(l.net)) continue;
      b.line(l.x1, l.y1, l.x2, l.y2, 0, col);
    }
    b.touch();
    this.emit('connectivity', a);
  }

  _schedulePours(delay = 250) {
    // Without automatic repour the rule check still follows edits (a repour ends with one).
    if (!this.app.settings.get('autoRepour') && delay > 0) { this._scheduleDrc(); return; }
    this._poursDue = true;
    clearTimeout(this._pourTimer);
    // The repour ends with a rule check; one still waiting would check stale fills.
    clearTimeout(this._drcTimer);
    this._pourTimer = setTimeout(() => this.repour(), delay);
  }

  /**
   * Pour fills for the board as it is now, for exports. The fills lag behind
   * an edit, and are empty just after the board opens, until the repour that
   * is due has run: this runs it. Null when they could not be brought up to date.
   */
  async currentFills() {
    if (this._poursDue) await this.repour();
    return this._poursDue ? null : this.pourFills;
  }

  /** Recomputes every pour's fill in the kernel worker. */
  async repour() {
    const pours = [...this.doc.items()].filter((o) => o.t === 'pour');
    const rev = this.doc.store.revision;
    // Newer than any fill still being computed, which is then dropped.
    this._pourRev = rev;
    if (!pours.length) {
      if (this.pourFills.size) { this.pourFills = new Map(); this._dirtyLayers.add('*'); this.requestRender(); }
      this._poursDue = false;
      this._scheduleDrc();
      return;
    }
    try {
      const fills = await this.app.kernel.pours(this.doc.snapshot(), this.lib);
      if (this.disposed || this._pourRev !== rev) return;
      this.pourFills = fills;
      if (rev === this.doc.store.revision) this._poursDue = false;
      for (const p of pours) this._dirtyLayers.add(p.layer);
      this._rebuildRats();
      this.requestRender(true);
      this.emit('pours', fills);
    } catch (err) {
      if (err?.name !== 'AbortError') console.error('Pour failed', err);
      // Stopping the autorouter stops the shared worker and this fill with it.
      else if (!this.disposed && this._pourRev === rev) this._schedulePours();
    }
    this._scheduleDrc();
  }

  _scheduleDrc() {
    if (!this.app.settings.get('onlineDrc')) { if (this.violations.length) { this.violations = []; this._rebuildDrc(); } return; }
    clearTimeout(this._drcTimer);
    this._drcTimer = setTimeout(() => this.runDrc({ online: true }), 500);
  }

  /** Runs the design rule check; online runs update markers quietly. */
  async runDrc({ online = false } = {}) {
    // A check that was asked for waits for the repour that is due, or it
    // would report the new copper against the pour from before the edit.
    if (!online) await this.currentFills();
    const rev = this.doc.store.revision;
    try {
      const list = await this.app.kernel.drc(this.doc.snapshot(), this.lib, { pourFills: this.pourFills });
      if (this.disposed || (online && rev !== this.doc.store.revision)) return null;
      const a = this.analysis();
      for (const s of a.shorts) {
        if (list.some((v) => v.rule === 'short' && v.ids?.includes(s.a) && v.ids?.includes(s.b))) continue;
        list.push({ rule: 'short', severity: 'error', message: `Short circuit between ${s.netA} and ${s.netB}`, x: s.x, y: s.y, ids: [s.a, s.b] });
      }
      if (!online) {
        for (const [net, n] of a.unrouted) {
          const line = a.ratsnest.find((l) => l.net === net);
          list.push({ rule: 'unrouted', severity: 'error', message: `Net ${net} has ${n} unrouted connection${n === 1 ? '' : 's'}`, x: line?.x1, y: line?.y1, ids: [], net });
        }
      }
      this.violations = list;
      this._rebuildDrc();
      this.emit('drc', list);
      return list;
    } catch (err) {
      if (err?.name !== 'AbortError') console.error('DRC failed', err);
      else if (online && !this.disposed) this._scheduleDrc();
      return null;
    }
  }

  _rebuildDrc() {
    const b = this.drcBatch;
    b.clear();
    const col = pack(this.palette.drcError, 0.9);
    const r = mm(0.4);
    for (const v of this.violations) {
      if (v.x === undefined || v.rule === 'unrouted') continue;
      b.ring(v.x, v.y, r, mm(0.08), col);
      b.line(v.x - r * 0.6, v.y - r * 0.6, v.x + r * 0.6, v.y + r * 0.6, mm(0.06), col);
      b.line(v.x - r * 0.6, v.y + r * 0.6, v.x + r * 0.6, v.y - r * 0.6, mm(0.06), col);
    }
    b.touch();
    this.requestRender();
  }

  _scheduleLabels() {
    clearTimeout(this._labelTimer);
    this._labelTimer = setTimeout(() => { this._rebuildLabels(); this.requestRender(); }, 60);
  }

  /** Net names on pads, drawn only where pads are large enough on screen. */
  _rebuildLabels() {
    const b = this.labelBatch;
    b.clear();
    if (!this.renderer || !this.app.settings.get('padLabels')) { b.touch(); return; }
    const px = this.nmPerPx;
    const box = this.renderer.visibleBox();
    const col = pack(this.palette.padText, 0.92);
    let count = 0;
    for (const o of this.doc.store.query(box)) {
      if (o.t !== 'comp' || this.hidden.has(o.id)) continue;
      for (const p of placedOf(o, this.lib, this.copperCount).pads) {
        const side = p.side === 'thru' ? 'multi' : p.side;
        if (!this.isLayerVisible(side)) continue;
        const minSide = Math.min(p.w, p.shape === 'round' ? p.w : p.h);
        if (minSide / px < 16) continue;
        const text = p.net || p.num;
        if (!text) continue;
        const long = Math.max(p.w, p.shape === 'round' ? p.w : p.h);
        const rot = p.shape !== 'round' && p.h > p.w * 1.2 ? (p.rot || 0) + 90 : p.rot || 0;
        const size = Math.min(minSide * 0.32, (long * 0.85) / Math.max(1, text.length * 0.75));
        if (size / px < 6) continue;
        b.text(text, p.x, p.y, size, col, { rot, align: { h: 'center', v: 'middle' }, upright: true, w: size * 0.12 });
        if (++count > 4000) break;
      }
    }
    b.touch();
  }

  // ---- Drawing ----

  _rebuildLayers() {
    const all = this._dirtyLayers.has('*');
    const layers = boardLayers(this.copperCount).concat(['holes']);
    for (const l of layers) if (!this.layerBatches.has(l)) this.layerBatches.set(l, new Batch());
    const want = all ? layers : [...this._dirtyLayers].filter((l) => this.layerBatches.has(l));
    this._dirtyLayers.clear();
    if (want.length) buildPcbLayers(this.layerBatches, want, this.doc.items(), this.sceneContext(), this.hidden);
  }

  _rebuildSelection() {
    const b = this.selBatch;
    b.clear();
    const sel = this.palette.selection;
    const colors = Object.fromEntries(Object.keys(LAYERS).map((l) => [l, `${sel}99`]));
    const ctx = { ...this.sceneContext(), colors, pal: { ...this.palette, multi: `${sel}99`, via: `${sel}99`, hole: `${sel}00`, cutout: `${sel}00` } };
    const sink = (l) => (l === 'holes' ? null : this.isLayerVisible(l) || isCopper(l) ? b : null);
    for (const id of this.selection) {
      const o = this.doc.store.get(id);
      if (!o || this.hidden.has(id)) continue;
      if (o.t === 'pour' || o.t === 'region') {
        // Large areas get a light tint and a bold outline instead of a wash.
        b.poly([o.pts], pack(sel, 0.12));
        b.polyline(o.pts, 2 * this.nmPerPx, pack(sel, 0.95), true);
      } else if (o.t === 'fill') {
        b.rect((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1), 0, 0, pack(sel, 0.25));
      } else emitPcbObject(o, sink, ctx);
      if (o.t === 'comp' || o.t === 'pour' || o.t === 'region' || o.t === 'fill' || o.t === 'text') {
        const bb = pcbBounds(o, this.lib);
        b.rectOutline(bb.minX, bb.minY, bb.maxX, bb.maxY, 0, pack(sel, 0.8));
      }
      if (o.t === 'pour' || o.t === 'region') for (let i = 0; i < o.pts.length; i += 2) b.rect(o.pts[i], o.pts[i + 1], 6 * this.nmPerPx, 6 * this.nmPerPx, 0, 0, pack(sel));
    }
    b.touch();
  }

  _rebuildHighlight() {
    const b = this.hlBatch;
    b.clear();
    if (this.highlight) {
      const net = this.highlight.net;
      const ctx = this.sceneContext();
      const sink = (l) => (this.isLayerVisible(l) ? b : null);
      for (const o of this.doc.items()) {
        if (this.hidden.has(o.id)) continue; // being moved: drawn by the move preview
        if (o.t === 'comp') {
          for (const p of placedOf(o, this.lib, this.copperCount).pads) {
            if (p.net !== net) continue;
            const l = p.side === 'thru' ? 'multi' : p.side;
            if (this.isLayerVisible(l)) drawPadShape(b, p, pack(p.side === 'thru' ? this.palette.multi : this.layerColor(p.side)));
          }
        } else if (o.net === net) emitPcbObject(o, sink, ctx);
      }
      if (!this._ratsSkip?.has(net)) for (const l of this.analysis().ratsnest) if (l.net === net) b.line(l.x1, l.y1, l.x2, l.y2, 0, pack(this.palette.highlight));
    }
    b.touch();
  }

  draw() {
    const r = this.renderer;
    if (!r) return;
    const pal = this.palette;
    if (this._dirtyBoard) { this._dirtyBoard = false; buildBoardShape(this.boardBatch, this.doc.board, pal); }
    if (this._dirtyLayers.size) { this._rebuildLayers(); this._rebuildSelection(); }
    const passes = [{ batch: this.boardBatch }];
    const gridStyle = this.app.settings.get('pcbGridStyle');
    passes.push({ grid: { step: this.grid, major: 10, style: gridStyle, minor: toVec4(pal.gridMinor), majorColor: toVec4(pal.gridMajor), originX: this.doc.board.origin?.x || 0, originY: this.doc.board.origin?.y || 0 } });
    const dimAll = this.highlight ? [0, 0, 0, 0.72] : null;
    const gray = [0.45, 0.45, 0.45, 0.85];
    for (const l of layerDrawOrder(this.copperCount, this.activeLayer, this.flipped)) {
      if (!this.isLayerVisible(l) && l !== 'holes') continue;
      if (l === 'holes' && !this.isLayerVisible('multi') && copperLayers(this.copperCount).every((c) => !this.isLayerVisible(c))) continue;
      const isActive = l === this.activeLayer || l === 'holes' || l === 'multi';
      const mix = dimAll || (this.singleLayer === 'gray' && !isActive ? gray : null);
      const alpha = this.singleLayer === 'gray' && !isActive ? 0.35 : 1;
      passes.push({ batch: this.layerBatches.get(l), mix, alpha });
    }
    passes.push({ batch: this.ratsBatch, alpha: this.highlight ? 0.35 : 1 });
    passes.push({ batch: this.labelBatch, alpha: this.highlight ? 0.4 : 1 });
    passes.push({ batch: this.hlBatch });
    passes.push({ batch: this.drcBatch });
    passes.push({ batch: this.selBatch });
    passes.push({ batch: this.overlay });
    r.draw({ background: toVec4(pal.background), passes });
  }

  drawCursor(b) {
    if (this.app.settings.get('pcbCrosshair')) this.drawFullCrosshair(b, pack(this.palette.crosshair, 0.45));
  }

  _updateHud() {
    if (!this.app.settings.get('showHud')) { this.hud.hidden = true; return; }
    this.hud.hidden = false;
    const o = this.doc.board.origin || { x: 0, y: 0 };
    const u = this.units;
    const f = (v) => formatLength(v, u, { suffix: false }).padStart(9);
    const c = this.cursor;
    const lc = this._lastClick || { x: o.x, y: o.y };
    const net = c.inside ? this.netUnder(c.x, c.y) : null;
    this.hud.replaceChildren(...[
      h('div', `x:${f(c.x - o.x)}  dx:${f(c.x - lc.x)} ${u}`),
      h('div', `y:${f(c.y - o.y)}  dy:${f(c.y - lc.y)} ${u}`),
      h('div.hud-layer', { style: { color: this.layerColor(this.activeLayer) } }, LAYERS[this.activeLayer].name),
      h('div', `Snap ${formatLength(this.grid, u)}${this.singleLayer !== 'off' ? '  Single layer' : ''}`),
      net ? h('div.hud-net', `Net ${net}`) : null,
    ].filter(Boolean));
  }

  // ---- Picking ----

  _pickLayers() {
    const s = new Set();
    for (const l of boardLayers(this.copperCount)) if (this.isLayerVisible(l)) s.add(l);
    return s;
  }

  pickAll(x, y) {
    const tol = 4 * this.nmPerPx;
    const box = { minX: x - tol, minY: y - tol, maxX: x + tol, maxY: y + tol };
    const layers = this._pickLayers();
    const out = [];
    for (const o of this.doc.store.query(box)) {
      const d = pcbHitDistance(o, x, y, this.lib, { layers, copperCount: this.copperCount });
      if (d <= tol) {
        // Prefer objects on the current layer.
        const onActive = o.layer === this.activeLayer || (o.t === 'comp' && (this.activeLayer.startsWith(o.side) || this.activeLayer === `${o.side}Overlay`)) ? 0 : 1;
        out.push({ o, d, onActive });
      }
    }
    out.sort((a, b) => a.onActive - b.onActive || (PCB_PICK_ORDER[a.o.t] ?? 9) - (PCB_PICK_ORDER[b.o.t] ?? 9) || a.d - b.d);
    return out.map((e) => e.o);
  }

  boxSelect(box, crossing) {
    const layers = this._pickLayers();
    const ids = [];
    for (const o of this.doc.store.query(box)) {
      if (!pcbPickable(o, this.lib, layers, this.copperCount)) continue;
      const b = pcbBounds(o, this.lib);
      if (crossing ? bboxIntersects(b, box) : bboxContains(box, b)) ids.push(o.id);
    }
    return ids;
  }

  anchorOf(o) {
    if (o.t === 'track' || o.t === 'fill' || o.t === 'dim') return { x: o.x1, y: o.y1 };
    if (o.t === 'arc') return { x: o.cx, y: o.cy };
    if (o.t === 'pour' || o.t === 'region') return { x: o.pts[0], y: o.pts[1] };
    return { x: o.x, y: o.y };
  }

  /** Copper under a point on a layer (null layer: any visible copper). */
  copperAt(x, y, layer, exact = false, exclude = null) {
    this.analysis();
    const tol = exact ? 1 : 4 * this.nmPerPx;
    const hits = this._copperTree.search({ minX: x - tol, minY: y - tol, maxX: x + tol, maxY: y + tol }).map((e) => e.it)
      .filter((it) => (!layer || it.layers.includes(layer) || (it.isPad && it.layers.length > 1)) && !exclude?.has(it.objId));
    let best = null, bd = Infinity;
    const probe = { kind: 'disc', x, y, r: tol, layers: layer ? [layer] : copperLayers(this.copperCount) };
    for (const it of hits) {
      if (it.pour) continue;
      const d = itemDistance(probe, it);
      const rank = it.isPad ? -1 : it.kind === 'disc' ? -0.5 : 0;
      if (d <= 0 && (rank < bd || best === null)) { bd = rank; best = it; }
    }
    if (!best) {
      // Pours count too (lowest priority).
      for (const it of hits) if (it.pour && itemDistance(probe, it) <= 0) { best = it; break; }
    }
    if (!best) return null;
    const anchor = best.isPad ? [best.pad.x, best.pad.y] : best.kind === 'disc' ? [best.x, best.y] : best.kind === 'seg' ? nearestEnd(best, x, y, tol * 3) : null;
    return { net: best.net, layers: best.layers, objId: best.objId, anchor, isPad: !!best.isPad };
  }

  netUnder(x, y) {
    const c = this.copperAt(x, y, null);
    return c?.net || null;
  }

  /**
   * Copper items of other nets near a path, for routing collision checks.
   * Pour fills are not obstacles: a pour is filled again around the new track.
   * Neither is loose copper without a net (a via, a track, a free pad), which
   * a trace may join; a component pad without a net stays an obstacle.
   */
  obstaclesNear(pts, layer, net, margin) {
    this.analysis();
    const b = bboxOfFlat(pts, margin);
    return this._copperTree.search(b).map((e) => e.it).filter((it) => it.layers.includes(layer) && (!net || it.net !== net) && !it.pour && (it.net || (net && it.pad?.compId)));
  }

  snapTargets(x, y, reach, exclude) {
    if (!(this.tool instanceof RouteTool) && !(this.tool?.name === 'via') && !(this.tool === this.select && this.select.move)) return null;
    this.analysis();
    let best = null, bd = reach;
    // Objects being moved are still in the board where they started: no snapping onto those.
    const skip = exclude?.length ? new Set(exclude) : null;
    for (const { it } of this._copperTree.search({ minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach })) {
      if (it.pour || skip?.has(it.objId)) continue;
      const pts = it.isPad ? [[it.pad.x, it.pad.y]] : it.anchors;
      for (const [px, py] of pts) {
        const d = Math.hypot(px - x, py - y);
        if (d < bd || (it.isPad && padDistance(it.pad, x, y) <= 0 && d < reach * 4)) { bd = Math.min(d, bd); best = { x: px, y: py, it }; }
      }
    }
    return best;
  }

  setRouteNet(net) {
    this.routeNet = net;
    if (net) this.highlightNet(net, { quiet: true }); else if (this.highlight?.quiet) this.clearHighlight();
  }

  // ---- Selection and editing ----

  setSelection(ids) {
    this.selection = new Set(ids);
    this._rebuildSelection();
    this.requestRender(true);
    this.emit('selection', this.selection);
    if (ids.length) this.announce(`${ids.length} object${ids.length === 1 ? '' : 's'} selected`);
  }

  toggleSelection(id) {
    if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    this.setSelection([...this.selection]);
  }

  selectedObjects() { return [...this.selection].map((id) => this.doc.store.get(id)).filter(Boolean); }

  beginMove(ids, anchor) {
    const ed = this;
    const store = this.doc.store;
    const base = ids.map((id) => store.get(id)).filter(Boolean);
    let ops = [];
    let dx = 0, dy = 0;
    const transformed = () => base.map((o) => {
      let r = o;
      for (const op of ops) {
        if (op === 'rot') r = rotatePcb(r, anchor.x, anchor.y, 90);
        else if (op === 'flip' && r.t === 'comp') { r = flipComp(r); r = { ...r, x: 2 * anchor.x - r.x }; }
      }
      return translatePcb(r, dx, dy);
    });
    // Tracks attached to moved track ends or vias stretch along (rubber banding).
    const moving = new Set(ids);
    const attach = new Map();
    for (const o of base) {
      if (o.t === 'track') { attach.set(`${o.x1},${o.y1},${o.layer}`, 1); attach.set(`${o.x2},${o.y2},${o.layer}`, 1); }
      if (o.t === 'via') attach.set(`${o.x},${o.y},*`, 1);
    }
    const dragged = [];
    if (attach.size) {
      const bb = base.reduce((acc, o) => bboxUnion(acc, pcbBounds(o, this.lib)), bboxEmpty());
      for (const t of store.query({ minX: bb.minX - 1, minY: bb.minY - 1, maxX: bb.maxX + 1, maxY: bb.maxY + 1 })) {
        if (t.t !== 'track' || moving.has(t.id)) continue;
        const hit = (x, y) => attach.has(`${x},${y},${t.layer}`) || attach.has(`${x},${y},*`);
        const ends = [hit(t.x1, t.y1) ? 0 : -1, hit(t.x2, t.y2) ? 1 : -1].filter((e) => e >= 0);
        if (ends.length) dragged.push({ t, ends });
      }
    }
    const movePoint = (x, y) => {
      let p = { t: 'via', x, y };
      for (const op of ops) if (op === 'rot') p = rotatePcb(p, anchor.x, anchor.y, 90);
      return [p.x + dx, p.y + dy];
    };
    const stretched = () => dragged.map(({ t, ends }) => {
      const n = { ...t };
      for (const e of ends) {
        const [x, y] = movePoint(e === 0 ? t.x1 : t.x2, e === 0 ? t.y1 : t.y2);
        if (e === 0) { n.x1 = x; n.y1 = y; } else { n.x2 = x; n.y2 = y; }
      }
      return n;
    });
    for (const id of ids) this.hidden.add(id);
    for (const d of dragged) this.hidden.add(d.t.id);
    this._dirtyLayers.add('*');
    this.requestRender(true);
    const movingComps = new Set(base.filter((o) => o.t === 'comp').map((o) => o.id));
    const nets = new Set();
    for (const o of base) if (o.t === 'comp') for (const n of Object.values(o.padNets || {})) if (n) nets.add(n);
    // The live ratsnest replaces these nets' lines, which still end at the old place.
    if (nets.size) { this._ratsSkip = nets; this._rebuildRats(); }
    if (this.highlight) this._rebuildHighlight();
    return {
      ids, anchor,
      update(ndx, ndy) { dx = ndx; dy = ndy; ed._lastClick = { x: anchor.x, y: anchor.y }; ed.requestRender(true); },
      rotate() { ops.push('rot'); ed.requestRender(true); },
      flip() { ops.push('flip'); ed.requestRender(true); },
      draw(b) {
        const objs = transformed();
        const sink = (l) => (l === 'holes' || ed.isLayerVisible(l) ? b : null);
        const ctx = ed.previewContext();
        for (const o of objs) emitPcbObject(o, sink, ctx);
        for (const t of stretched()) emitPcbObject(t, sink, ctx);
        if (nets.size) ed._drawLiveRats(b, objs, movingComps, nets);
      },
      commit() {
        ed._endMove();
        if (!dx && !dy && !ops.length) return;
        const objs = transformed();
        const tracks = stretched();
        store.transact(ids.length === 1 ? 'Move' : `Move ${ids.length} objects`, (s) => {
          for (const o of objs) s.update(o.id, o);
          for (const t of tracks) s.update(t.id, t);
        });
      },
      cancel() { ops = []; dx = dy = 0; ed._endMove(); },
    };
  }

  /** Approximate ratsnest for nets of components being dragged. */
  _drawLiveRats(b, moved, movingIds, nets) {
    const pts = new Map();
    const add = (net, x, y) => { let l = pts.get(net); if (!l) pts.set(net, (l = [])); l.push([x, y]); };
    for (const o of moved) if (o.t === 'comp') for (const p of placedOf(o, this.lib, this.copperCount).pads) if (nets.has(p.net)) add(p.net, p.x, p.y);
    for (const o of this.doc.items()) {
      if (o.t !== 'comp' || movingIds.has(o.id)) continue;
      for (const p of placedOf(o, this.lib, this.copperCount).pads) if (nets.has(p.net)) add(p.net, p.x, p.y);
    }
    const col = pack(this.palette.ratsnest, 0.9);
    for (const list of pts.values()) {
      if (list.length > 400) continue;
      const n = list.length, inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), from = new Int32Array(n);
      if (!n) continue;
      inTree[0] = 1;
      for (let j = 1; j < n; j++) { best[j] = (list[0][0] - list[j][0]) ** 2 + (list[0][1] - list[j][1]) ** 2; from[j] = 0; }
      for (let k = 1; k < n; k++) {
        let m = -1;
        for (let j = 0; j < n; j++) if (!inTree[j] && (m < 0 || best[j] < best[m])) m = j;
        inTree[m] = 1;
        b.line(list[from[m]][0], list[from[m]][1], list[m][0], list[m][1], 0, col);
        for (let j = 0; j < n; j++) {
          if (inTree[j]) continue;
          const d = (list[m][0] - list[j][0]) ** 2 + (list[m][1] - list[j][1]) ** 2;
          if (d < best[j]) { best[j] = d; from[j] = m; }
        }
      }
    }
  }

  _endMove() {
    if (this._ratsSkip) { this._ratsSkip = null; this._rebuildRats(); }
    this.hidden.clear();
    if (this.highlight) this._rebuildHighlight();
    this._dirtyLayers.add('*');
    this._scheduleLabels();
    this.requestRender(true);
  }

  nudge(dx, dy) {
    const ids = [...this.selection];
    this.doc.store.transact('Nudge', (s) => { for (const id of ids) { const o = s.get(id); if (o && !o.locked) s.update(id, translatePcb(o, dx, dy)); } }, { mergeKey: `nudge:${ids.join(',')}` });
  }

  _selectionCenter() {
    const objs = this.selectedObjects();
    if (!objs.length) return null;
    if (objs.length === 1) return this.anchorOf(objs[0]);
    const b = objs.reduce((acc, o) => bboxUnion(acc, pcbBounds(o, this.lib)), bboxEmpty());
    return { x: snap((b.minX + b.maxX) / 2, this.grid), y: snap((b.minY + b.maxY) / 2, this.grid) };
  }

  rotateSelection(deg = 90) {
    const c = this._selectionCenter();
    if (!c) return;
    this.doc.store.transact('Rotate', (s) => { for (const o of this.selectedObjects()) if (!o.locked) s.update(o.id, rotatePcb(o, c.x, c.y, deg)); });
  }

  flipSelection() {
    const comps = this.selectedObjects().filter((o) => o.t === 'comp' && !o.locked);
    if (!comps.length) return;
    this.doc.store.transact('Flip to other side', (s) => { for (const o of comps) s.update(o.id, flipComp(o)); });
  }

  deleteSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.doc.store.transact(ids.length === 1 ? 'Delete' : `Delete ${ids.length} objects`, (s) => { for (const id of ids) s.remove(id); });
    this.setSelection([]);
  }

  selectAll() { this.setSelection([...this.doc.items()].map((o) => o.id)); }

  copySelection() {
    const objs = this.selectedObjects();
    if (!objs.length) return null;
    const lib = {};
    for (const o of objs) if (o.comp && this.lib[o.comp]) lib[o.comp] = this.lib[o.comp];
    const b = objs.reduce((acc, o) => bboxUnion(acc, pcbBounds(o, this.lib)), bboxEmpty());
    const ref = { x: snap(b.minX, this.grid), y: snap(b.minY, this.grid) };
    return { kind: 'pcb', objects: objs.map((o) => translatePcb(o, -ref.x, -ref.y)), library: lib };
  }

  pasteClip(clip) {
    if (!clip || clip.kind !== 'pcb') return false;
    for (const def of Object.values(clip.library || {})) this.project.ensureComponent(def);
    const ed = this;
    const tool = {
      name: 'paste', cursor: 'crosshair', ops: 0,
      hint: () => 'Click to paste. Space rotates, Esc cancels',
      objs(x, y) { let objs = clip.objects; for (let i = 0; i < this.ops; i++) objs = objs.map((o) => rotatePcb(o, 0, 0, 90)); return objs.map((o) => translatePcb(o, x, y)); },
      click(ev) {
        const ids = [];
        // A component that was cut comes back as itself, still linked to its
        // schematic part by uid; a copy gets a uid of its own.
        const uids = new Set([...ed.doc.items()].filter((c) => c.t === 'comp').map((c) => c.uid));
        ed.doc.store.transact('Paste', (s) => {
          for (const o of this.objs(ev.x, ev.y)) {
            const n = { ...o, id: uid() };
            if (n.t === 'comp') { if (!n.uid || uids.has(n.uid)) n.uid = uid('u'); uids.add(n.uid); }
            s.add(n);
            ids.push(n.id);
          }
        });
        ed.endTool();
        ed.setSelection(ids);
      },
      key(e, combo) { if (combo === 'Space') { this.ops++; return true; } if (combo === 'Escape') { ed.endTool(); return true; } return TURN_KEYS.has(combo); },
      rightClick() { ed.endTool(); return true; },
      drawOverlay(b) {
        const c = ed.cursor;
        if (!c.inside) return;
        const sink = (l) => (l === 'holes' || ed.isLayerVisible(l) ? b : null);
        const ctx = ed.previewContext();
        for (const o of this.objs(c.x, c.y)) emitPcbObject(o, sink, ctx);
      },
    };
    this.setTool(tool);
    return true;
  }

  // ---- Net highlighting ----

  highlightNetAt(x, y) {
    const net = this.netUnder(x, y);
    if (!net) { this.clearHighlight(); return; }
    this.highlightNet(net);
  }

  highlightNet(net, { quiet = false } = {}) {
    this.highlight = { net, quiet };
    this._rebuildHighlight();
    this._rebuildRats();
    this.requestRender();
    if (!quiet) { this.emit('highlight', net); this.app.crossProbeNet?.(net, this); this.announce(`Net ${net} highlighted`); }
  }

  clearHighlight() {
    if (!this.highlight) return false;
    this.highlight = null;
    this._rebuildHighlight();
    this._rebuildRats();
    this.requestRender();
    this.emit('highlight', null);
    return true;
  }

  // ---- Tools ----

  endTool() {
    this.setTool(this.select);
    this.canvas.focus();
  }

  setTool(tool) {
    super.setTool(tool);
    if (tool && tool !== this.select) {
      const orig = tool.click?.bind(tool);
      if (orig && !tool._wrapped) { tool._wrapped = true; tool.click = (ev, d) => { this._lastClick = { x: ev.x, y: ev.y }; return orig(ev, d); }; }
    }
  }

  startTool(name) {
    const r = this.doc.rules;
    const make = {
      route: () => new RouteTool(this),
      via: () => new PlacePcbTool(this, { name: 'via', hint: 'Click to place a via (it takes the net of copper under it). Esc stops', template: { t: 'via', d: r.viaDiameter, drill: r.viaDrill, from: 'top', to: 'bottom' } }),
      pad: () => new PlacePcbTool(this, { name: 'pad', hint: 'Click to place a pad. Space rotates, Esc stops', template: { t: 'pad', shape: 'round', w: mm(1.6), h: mm(1.6), side: 'thru', drill: mm(0.8), plated: true, num: '' } }),
      text: () => this._textTool(),
      line: () => new LineTool(this, { kind: 'line' }),
      fill: () => new LineTool(this, { kind: 'fill' }),
      dim: () => new LineTool(this, { kind: 'dim' }),
      measure: () => new LineTool(this, { kind: 'measure' }),
      pour: () => new PolygonTool(this, { kind: 'pour', layer: isCopper(this.activeLayer) ? this.activeLayer : 'top', onDone: (pts, t) => this._addPour(pts, t.layer) }),
      region: () => new PolygonTool(this, { kind: 'region', layer: this.activeLayer, onDone: (pts, t) => this.doc.store.transact('Place region', (s) => s.add({ id: uid(), t: 'region', layer: t.layer, pts })) }),
      keepout: () => new PolygonTool(this, { kind: 'keepout', layer: 'keepout', onDone: (pts) => this.doc.store.transact('Place keep-out', (s) => s.add({ id: uid(), t: 'region', layer: 'keepout', pts })) }),
      board: () => new PolygonTool(this, { kind: 'board', layer: 'mech1', onDone: (pts) => { this.doc.store.transact('Redefine board shape', (s) => s.update('board', { outline: pts })); this.endTool(); } }),
      cutout: () => new PolygonTool(this, { kind: 'cutout', layer: 'mech1', onDone: (pts) => { const b = this.doc.board; this.doc.store.transact('Add board cutout', (s) => s.update('board', { cutouts: [...(b.cutouts || []), reversePts(pts)] })); } }),
    }[name];
    if (!make) return;
    this.setTool(make());
    this.canvas.focus();
  }

  _textTool() {
    const ed = this;
    return new PlacePcbTool(this, {
      name: 'text', hint: 'Click to place text. Tab edits it, Space rotates',
      template: { t: 'text', layer: isCopper(this.activeLayer) || this.activeLayer.endsWith('Overlay') || this.activeLayer.startsWith('mech') ? this.activeLayer : 'topOverlay', text: 'Text', h: mm(1.5), w: mm(0.2), rot: 0, mirror: this.activeLayer.startsWith('bottom') },
      edit: async (tool) => {
        const v = await promptDialog({ title: 'Text', label: 'Text', value: tool.template.text });
        if (v) tool.template = { ...tool.template, text: v };
        ed.canvas.focus();
      },
    });
  }

  _addPour(pts, layer) {
    const nets = Object.keys(this.doc.nets).sort();
    const guess = nets.find((n) => /^(gnd|vss|ground)$/i.test(n)) || nets.find((n) => /gnd/i.test(n)) || '';
    const pour = { id: uid(), t: 'pour', layer, pts, net: guess, clearance: this.doc.rules.pourClearance, removeIslands: true, thermals: true, priority: 0, name: guess ? `${guess} pour` : 'Pour' };
    this.doc.store.transact('Place polygon pour', (s) => s.add(pour));
    this.setSelection([pour.id]);
    this.app.toast(guess ? `Pour connected to ${guess}. Change its net in Properties.` : 'Pour placed without a net. Choose its net in Properties.', { timeout: 4000 });
  }

  placeComponent(def) {
    this.project.ensureComponent(def);
    const items = [...this.doc.items()];
    const prefix = def.prefix || 'U';
    const used = new Set(items.filter((o) => o.t === 'comp').map((o) => o.designator));
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    const tool = new PlacePcbTool(this, {
      name: def.name, hint: 'Click to place. Space rotates, L flips to the other side, Esc stops',
      template: { t: 'comp', comp: def.id, rot: 0, side: this.activeLayer.startsWith('bottom') ? 'bottom' : 'top', designator: `${prefix}${n}`, value: def.value || '', padNets: {} },
      onPlaced: (obj, t) => {
        used.add(obj.designator);
        let k = 1;
        while (used.has(`${prefix}${k}`)) k++;
        t.template = { ...t.template, designator: `${prefix}${k}` };
      },
    });
    const origClick = tool.click.bind(tool);
    tool.click = (ev) => { tool.template = { ...tool.template, uid: uid('u') }; origClick(ev); };
    this.setTool(tool);
    this.canvas.focus();
  }

  // ---- View ----

  boardBox() {
    const o = this.doc.board.outline;
    return o?.length >= 6 ? bboxOfFlat(o) : null;
  }

  fitAll(animate = true) {
    let b = this.boardBox() || bboxEmpty();
    for (const o of this.doc.items()) b = bboxUnion(b, pcbBounds(o, this.lib));
    if (b.minX <= b.maxX) this.fitBox(b, animate);
  }

  fitContent() { this.fitAll(); }

  fitBoard() { const b = this.boardBox(); if (b) this.fitBox(b); }

  fitSelection() {
    const objs = this.selectedObjects();
    if (!objs.length) return this.fitAll();
    this.fitBox(objs.reduce((acc, o) => bboxUnion(acc, pcbBounds(o, this.lib)), bboxEmpty()));
  }

  focusObject(id, x, y) {
    const o = id ? this.doc.store.get(id) : null;
    if (o) {
      this.setSelection([id]);
      const b = pcbBounds(o, this.lib);
      const pad = mm(4);
      this.fitBox({ minX: Math.min(b.minX, x ?? b.minX) - pad, minY: Math.min(b.minY, y ?? b.minY) - pad, maxX: Math.max(b.maxX, x ?? b.maxX) + pad, maxY: Math.max(b.maxY, y ?? b.maxY) + pad });
    } else if (x !== undefined) this.zoomTo(x, y, mm(8));
  }

  onContextMenu(ev, e) {
    if (this.tool !== this.select) { this.endTool(); return; }
    const hit = this.pickAll(ev.rawX, ev.rawY)[0];
    if (hit && !this.selection.has(hit.id)) this.setSelection([hit.id]);
    const net = this.netUnder(ev.rawX, ev.rawY);
    const items = hit ? [
      { command: 'edit.properties' },
      { separator: true },
      { command: 'edit.cut' }, { command: 'edit.copy' }, { command: 'edit.paste' }, { command: 'edit.duplicate' }, { command: 'edit.delete' },
      { separator: true },
      { command: 'pcb.rotate' },
      hit.t === 'comp' ? { command: 'pcb.flip' } : null,
      hit.t === 'comp' ? { label: hit.locked ? 'Unlock' : 'Lock position', icon: hit.locked ? 'unlock' : 'lock', run: () => this.doc.store.transact('Lock', (s) => s.update(hit.id, { locked: !hit.locked })) } : null,
      { separator: true },
      net ? { label: `Highlight net ${net}`, icon: 'highlight-net', run: () => this.highlightNet(net) } : null,
      net ? { label: `Select all copper on ${net}`, run: () => this.selectNet(net) } : null,
      net ? { label: `Unroute net ${net}`, run: () => this.unrouteNet(net) } : null,
      hit.t === 'comp' ? { label: 'Find in schematic', icon: 'cross-probe', run: () => this.app.crossProbePart?.(hit) } : null,
      hit.t === 'comp' ? { label: 'Edit component in library', icon: 'library', run: () => this.app.openComponentEditor?.(hit.comp) } : null,
      hit.t === 'pour' ? { command: 'pcb.repour' } : null,
    ].filter(Boolean) : [
      { command: 'edit.paste' },
      { separator: true },
      { label: '&Place', items: [{ command: 'pcb.place.component' }, { command: 'pcb.route' }, { command: 'pcb.place.via' }, { command: 'pcb.place.pour' }, { command: 'pcb.place.text' }, { command: 'pcb.place.line' }] },
      { separator: true },
      { command: 'view.fit' }, { command: 'pcb.fitBoard' }, { command: 'pcb.toggle3d' },
      { command: 'pcb.boardOptions' },
    ];
    contextMenu(e, items, 'Board');
  }

  selectNet(net) {
    const ids = [...this.doc.items()].filter((o) => o.net === net).map((o) => o.id);
    this.setSelection(ids);
  }

  unrouteNet(net) {
    // Lines and arcs on silkscreen and mechanical layers are drawings, not routing.
    const routed = (o) => o.t === 'via' || ((o.t === 'track' || o.t === 'arc') && isCopper(o.layer));
    const ids = [...this.doc.items()].filter((o) => routed(o) && (net === null || o.net === net)).map((o) => o.id);
    if (!ids.length) return 0;
    this.doc.store.transact(net ? `Unroute ${net}` : 'Unroute all', (s) => { for (const id of ids) s.remove(id); });
    return ids.length;
  }

  dispose() {
    clearTimeout(this._pourTimer);
    clearTimeout(this._drcTimer);
    clearTimeout(this._labelTimer);
    clearTimeout(this._ratsTimer);
    for (const u of this._unsub) u();
    window.removeEventListener('themechange', this._onTheme);
    this.viewer3d?.dispose();
    for (const b of [this.boardBatch, this.ratsBatch, this.selBatch, this.hlBatch, this.drcBatch, this.labelBatch, this.overlay, ...this.layerBatches.values()]) this.renderer?.release(b);
    super.dispose();
  }
}

function nearestEnd(seg, x, y, reach) {
  const d1 = Math.hypot(seg.x1 - x, seg.y1 - y), d2 = Math.hypot(seg.x2 - x, seg.y2 - y);
  if (Math.min(d1, d2) > reach) return null;
  return d1 <= d2 ? [seg.x1, seg.y1] : [seg.x2, seg.y2];
}

installVertexEditing(PcbEditor, (ed, b, o) => {
  const sink = (l) => (l === 'holes' || ed.isLayerVisible(l) ? b : null);
  emitPcbObject(o, sink, ed.previewContext());
  if (o.pts) b.polyline(o.pts, 0, pack(ed.palette.selection), o.t === 'pour' || o.t === 'region');
});

/** Reverses a flat point list (cutouts are stored clockwise). */
function reversePts(pts) {
  const out = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}
