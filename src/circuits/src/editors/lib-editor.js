// Component editor: edits a component's schematic symbol and footprint on
// the same canvas machinery as the sheet and board editors. Each mode has
// its own undoable store; saving writes the definition back to the project
// library (updating every placed copy) and to My library.

import { CanvasView } from './view.js';
import { SelectTool } from './select-tool.js';
import { PinTool, PadTool, ShapeTool } from './lib-tools.js';
import {
  defToObjects, objectsToDef, libBounds, libHitDistance, LIB_PICK_ORDER, LIB_META_TYPES, FP_LAYERS, GRAPHIC_TYPES,
  translateLib, rotateLib, mirrorLib, boundsOfAll, pinEnd, nextLabel, padArray, courtyardFor, validateComponent,
} from './lib-model.js';
import { ObjectStore } from '../core/store.js';
import { Emitter, uid } from '../core/emitter.js';
import { Batch } from '../render/batch.js';
import { pack, toVec4 } from '../render/color.js';
import { SCH_PALETTES, PCB_PALETTES, layerColor } from '../render/palette.js';
import { drawGraphic } from '../render/sch-scene.js';
import { drawPadShape } from '../render/pcb-scene.js';
import { resolvedTheme } from '../app/theme.js';
import { h, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { contextMenu } from '../ui/menu.js';
import { openDialog, buildForm } from '../ui/dialog.js';
import { MIXED } from '../ui/panels/properties.js';
import { mil, mm, SCH_GRID, snap, formatLength, parseLength } from '../core/units.js';
import { bboxContains, bboxIntersects, bboxValid, bboxUnion, bboxEmpty, simplifyPolyline } from '../core/geom.js';
import { LAYERS } from '../model/layers.js';
import { PIN_TYPES, PIN_TYPE_LABELS } from '../model/schema.js';
import { CATEGORIES, findComponent } from '../model/library/builtin.js';
import { overlappingPads } from '../model/library/footprints.js';
import { PIN_TEXT, SCH_TEXT, LINE_W } from '../model/sch.js';

const PIN_NUM_TEXT = mil(50);
const SIDE_OPTIONS = [['0', 'Left (points right)'], ['180', 'Right (points left)'], ['270', 'Top (points down)'], ['90', 'Bottom (points up)']];

/** A component being edited: two stores plus the component's identity. */
export class LibDoc extends Emitter {
  constructor({ def, isNew = false }) {
    super();
    this.compId = def.id;
    this.id = `lib:${def.id}`;
    this.kind = 'lib';
    this.mode = 'symbol';
    this.isNew = isNew;
    const objs = defToObjects(def);
    const bounds = (o) => libBounds(o);
    this.symStore = new ObjectStore({ bounds });
    this.fpStore = new ObjectStore({ bounds });
    const withIds = (list) => list.map((o) => (o.id ? o : { ...o, id: uid() }));
    this.symStore.load(withIds(objs.symbol));
    this.fpStore.load(withIds(objs.footprint));
    for (const s of [this.symStore, this.fpStore]) s.on('change', (e) => this.emit('change', e));
  }

  get store() { return this.mode === 'symbol' ? this.symStore : this.fpStore; }
  get meta() { return this.symStore.get('libmeta') || {}; }
  get fpMeta() { return this.fpStore.get('fpmeta') || {}; }
  get name() { return this.meta.name || 'Component'; }
  get dirty() { return this.isNew || this.symStore.dirty || this.fpStore.dirty; }

  *items() { for (const o of this.store.all()) if (!LIB_META_TYPES.has(o.t)) yield o; }

  toDef() {
    const def = objectsToDef([...this.symStore.all()], [...this.fpStore.all()]);
    def.id = this.compId;
    return def;
  }

  markSaved() {
    this.isNew = false;
    this.symStore.markSaved();
    this.fpStore.markSaved();
    this.emit('saved');
  }
}

export class LibEditor extends CanvasView {
  constructor(app, project, libDoc) {
    super(app, { label: `Component ${libDoc.name}` });
    this.kind = 'lib';
    this.project = project;
    this.doc = libDoc;
    this.selection = new Set();
    this.hidden = new Set();
    this.main = new Batch();
    this.selBatch = new Batch();
    this._dirtyMain = true;
    this.activeLayer = 'topOverlay';
    this.padTemplate = { num: '1', shape: 'roundrect', w: mm(1.2), h: mm(1.4), rot: 0, side: 'top', drill: 0, plated: true, radius: 0.25 };
    this.hud.hidden = true;
    this.select = new SelectTool(this);
    this.setTool(this.select);
    this._buildChrome();
    this._unsub = [libDoc.on('change', (e) => this._onChange(e))];
    this._onTheme = () => { this._dirtyMain = true; this.requestRender(true); };
    window.addEventListener('themechange', this._onTheme);
  }

  get mode() { return this.doc.mode; }
  get lib() { return this.project?.library || {}; }
  get palette() { return this.mode === 'symbol' ? SCH_PALETTES[resolvedTheme()] : { ...PCB_PALETTES[resolvedTheme()], preview: '#ffffff' }; }
  get grid() { return this.mode === 'symbol' ? this.app.settings.get('schGrid') || SCH_GRID : this.app.settings.get('pcbGrid') || mm(0.25); }
  get units() { return this.mode === 'symbol' ? 'mil' : this.app.settings.get('units'); }

  _onChange(e) {
    for (const id of e.removed.keys()) this.selection.delete(id);
    this._dirtyMain = true;
    this.requestRender(true);
    this.emit('selection', this.selection);
    this.app.renderTabs?.();
    this.app.updateTitle?.();
  }

  // ---- Chrome: mode tabs and footprint layers ----

  _buildChrome() {
    this.modeBar = h('div.lib-modes', { role: 'tablist', 'aria-label': 'Component views' });
    this.layerBar = h('div.layer-tabs', { role: 'tablist', 'aria-label': 'Footprint layers' });
    this.statusLine = h('div.lib-status', { 'aria-live': 'polite' });
    this.el.prepend(this.modeBar);
    this.el.append(this.layerBar, this.statusLine);
    this._renderChrome();
  }

  _renderChrome() {
    clear(this.modeBar);
    for (const [m, label, ico] of [['symbol', 'Symbol', 'symbol'], ['footprint', 'Footprint', 'footprint']]) {
      const sel = this.mode === m;
      this.modeBar.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(sel), tabindex: sel ? 0 : -1, onClick: () => this.setMode(m) }, icon(ico, 14), label));
    }
    this.modeBar.append(h('span', { style: { flex: '1' } }),
      h('button.btn.sm', { type: 'button', onClick: () => this.app.commands.run('libed.validate') }, icon('list-checks', 13), 'Check'),
      h('button.btn.sm.primary', { type: 'button', onClick: () => this.save() }, icon('save', 13), 'Save to project'));
    this.layerBar.hidden = this.mode !== 'footprint';
    clear(this.layerBar);
    for (const l of FP_LAYERS) {
      const sel = l === this.activeLayer;
      this.layerBar.append(h('button.layer-tab', { type: 'button', role: 'tab', 'aria-selected': String(sel), tabindex: sel ? 0 : -1, onClick: () => this.setActiveLayer(l) },
        h('span.swatch', { style: { background: layerColor(l, this.app.settings.get('layerColors')) } }), LAYERS[l].name));
    }
    this._renderStatus();
  }

  _renderStatus() {
    const issues = validateComponent(this.doc.toDef()).filter((m) => m.severity !== 'info');
    clear(this.statusLine);
    if (!issues.length) { this.statusLine.append(icon('ok', 13), 'No problems found'); return; }
    this.statusLine.append(icon(issues.some((m) => m.severity === 'error') ? 'error' : 'warning', 13), issues.map((m) => m.message).join(' '));
  }

  setMode(m) {
    if (this.mode === m) return;
    this.setTool(this.select);
    this.selection.clear();
    this.doc.mode = m;
    this._dirtyMain = true;
    this._renderChrome();
    this.buildActiveBar();
    this.fitAll(false);
    this.requestRender(true);
    this.emit('selection', this.selection);
    this.app.updateStatus?.();
    this.app.refreshMenus?.();
    this.announce(`${m === 'symbol' ? 'Symbol' : 'Footprint'} view`);
  }

  setActiveLayer(l) {
    this.activeLayer = l;
    this._renderChrome();
    this.updateHint();
  }

  buildActiveBar() {
    this.activeBar?.remove();
    const sym = this.mode === 'symbol';
    const tools = sym ? [
      ['select', 'pointer', 'Select', () => this.endTool()],
      ['|'],
      ['pin', 'pin', 'Pin', () => this.startTool('pin')],
      ['line', 'line-tool', 'Line', () => this.startTool('line')],
      ['rect', 'square', 'Rectangle', () => this.startTool('rect')],
      ['circle', 'circle', 'Circle', () => this.startTool('circle')],
      ['arc', 'arc-tool', 'Arc', () => this.startTool('arc')],
      ['poly', 'region', 'Polygon', () => this.startTool('poly')],
      ['text', 'text', 'Text', () => this.startTool('text')],
      ['|'],
      ['pins', 'table', 'Pin table', () => this.pinTableDialog()],
    ] : [
      ['select', 'pointer', 'Select', () => this.endTool()],
      ['|'],
      ['pad', 'pad', 'Pad', () => this.startTool('pad')],
      ['array', 'layout-grid', 'Pad array', () => this.padArrayDialog()],
      ['line', 'line-tool', 'Line', () => this.startTool('line')],
      ['rect', 'square', 'Rectangle', () => this.startTool('rect')],
      ['circle', 'circle', 'Circle', () => this.startTool('circle')],
      ['arc', 'arc-tool', 'Arc', () => this.startTool('arc')],
      ['poly', 'region', 'Polygon', () => this.startTool('poly')],
      ['text', 'text', 'Text', () => this.startTool('text')],
      ['|'],
      ['courtyard', 'select-rect', 'Fit courtyard', () => this.fitCourtyard()],
    ];
    const bar = h('div.activebar', { role: 'toolbar', 'aria-label': sym ? 'Symbol tools' : 'Footprint tools' });
    this.toolButtons = new Map();
    for (const [id, ico, label, run] of tools) {
      if (id === '|') { bar.append(h('span.ab-sep', { role: 'separator' })); continue; }
      const btn = h('button.ab-btn', { type: 'button', 'aria-label': label, 'data-tip': label, 'aria-pressed': 'false', onClick: () => { run(); this.app.updateActiveBar?.(); } }, icon(ico, 18));
      this.toolButtons.set(id, btn);
      bar.append(btn);
    }
    this.wrap.append(bar);
    this.activeBar = bar;
    this.app.updateActiveBar?.();
  }

  // ---- Drawing ----

  drawObject(b, o, override) {
    if (this.mode === 'symbol') this._drawSym(b, o, override);
    else this._drawFp(b, o, override);
  }

  _drawSym(b, o, override) {
    const pal = SCH_PALETTES[resolvedTheme()];
    const meta = this.doc.meta;
    if (o.t === 'pin') {
      const alpha = o.hidden ? 0.45 : 1;
      const c = override ?? pack(pal.pin, alpha);
      const [bx, by] = pinEnd(o);
      b.line(o.x, o.y, bx, by, LINE_W, c);
      b.ring(o.x, o.y, mil(10), 0, override ?? pack(pal.pinNum, 0.8));
      const dx = Math.sign(bx - o.x), dy = Math.sign(by - o.y);
      if (o.shape === 'dot' || o.shape === 'dotclock') b.ring(bx - dx * mil(25), by - dy * mil(25), mil(25), LINE_W, c);
      if (o.shape === 'clock' || o.shape === 'dotclock') {
        const s = mil(40), nx = -dy, ny = dx;
        b.polyline([bx + nx * s, by + ny * s, bx + dx * s * 1.4, by + dy * s * 1.4, bx - nx * s, by - ny * s], LINE_W, c);
      }
      const vertical = o.rot === 90 || o.rot === 270;
      const forward = o.rot === 0 || o.rot === 90;
      if (o.name && !o.hideName && meta.showPinNames !== false) {
        b.text(o.name, bx + dx * mil(50), by + dy * mil(50), PIN_TEXT, override ?? pack(pal.pinName, alpha), { rot: vertical ? 90 : 0, align: { h: forward ? 'left' : 'right', v: 'middle' } });
      }
      if (!o.hideNum && meta.showPinNumbers !== false) {
        const mx = (o.x + bx) / 2, my = (o.y + by) / 2;
        if (vertical) b.text(o.num, mx - mil(15), my, PIN_NUM_TEXT, override ?? pack(pal.pinNum, alpha), { rot: 90, align: { h: 'center', v: 'bottom' } });
        else b.text(o.num, mx, my + mil(15), PIN_NUM_TEXT, override ?? pack(pal.pinNum, alpha), { align: { h: 'center', v: 'bottom' } });
      }
      return;
    }
    if (o.t === 'anchor') {
      const c = override ?? pack(o.which === 'designator' ? pal.designator : pal.value);
      const s = mil(20);
      b.line(o.x - s, o.y, o.x + s, o.y, 0, c);
      b.line(o.x, o.y - s, o.x, o.y + s, 0, c);
      b.text(o.which === 'designator' ? `${meta.prefix || 'U'}?` : meta.value || 'Value', o.x, o.y, SCH_TEXT, c);
      return;
    }
    if (GRAPHIC_TYPES.has(o.t)) {
      if (override) drawGraphic(b, { ...o, fill: o.fill ? 'solid' : undefined }, override, pal);
      else drawGraphic(b, o, pack(pal.body), pal);
    }
  }

  _drawFp(b, o, override) {
    const pal = PCB_PALETTES[resolvedTheme()];
    const colors = this.app.settings.get('layerColors');
    if (o.t === 'pad') {
      const c = override ?? pack(o.side === 'thru' ? pal.multi : layerColor(o.side, colors));
      drawPadShape(b, o, c);
      if (o.side === 'thru' && o.drill) b.circle(o.x, o.y, o.drill / 2, pack(pal.hole));
      if (o.num) {
        const minSide = Math.min(o.w, o.shape === 'round' ? o.w : o.h);
        const size = Math.min(minSide * 0.45, (o.w * 0.8) / Math.max(1, o.num.length * 0.8));
        b.text(o.num, o.x, o.y, size, pack(pal.padText, 0.9), { align: { h: 'center', v: 'middle' }, w: size * 0.14 });
      }
      return;
    }
    if (!GRAPHIC_TYPES.has(o.t)) return;
    const layer = o.layer || 'topOverlay';
    const c = override ?? pack(layerColor(layer, colors));
    const w = o.w || mm(0.1);
    switch (o.t) {
      case 'line': b.line(o.x1, o.y1, o.x2, o.y2, w, c); break;
      case 'polyline': b.polyline(o.pts, w, c); break;
      case 'poly': if (o.fill) b.poly([o.pts], c); else b.polyline(o.pts, w, c, true); break;
      case 'rect':
        if (o.fill) b.rect((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1), 0, 0, c);
        else b.rectOutline(o.x1, o.y1, o.x2, o.y2, w, c);
        break;
      // A filled circle's outline adds half its width all round, as on the board and in Gerber.
      case 'circle': if (o.fill) b.circle(o.cx, o.cy, o.r + (o.w || 0) / 2, c); else b.ring(o.cx, o.cy, o.r, w, c); break;
      case 'arc': b.arc(o.cx, o.cy, o.r, o.a0, o.sweep, w, c); break;
      case 'text': b.text(o.text, o.x, o.y, o.size || mm(1), c, { rot: o.rot || 0, align: o.align, mirror: !!o.mirror, upright: true }); break;
      default:
    }
  }

  _rebuildMain() {
    const b = this.main;
    b.clear();
    const items = [...this.doc.items()].filter((o) => !this.hidden.has(o.id));
    const sym = this.mode === 'symbol';
    const origin = pack(sym ? SCH_PALETTES[resolvedTheme()].border : PCB_PALETTES[resolvedTheme()].boardEdge, 0.7);
    const s = sym ? mil(150) : mm(1);
    b.line(-s, 0, s, 0, 0, origin);
    b.line(0, -s, 0, s, 0, origin);
    b.ring(0, 0, s / 4, 0, origin);
    if (sym) {
      // Body fills first so outlines and pins draw over them.
      const order = (o) => (o.fill === 'body' ? 0 : o.t === 'pin' ? 2 : o.t === 'anchor' ? 3 : 1);
      items.sort((a, c) => order(a) - order(c));
    } else {
      const cy = this.doc.fpMeta.courtyard;
      if (cy && !items.some((o) => o.layer === 'courtyard')) b.rectOutline(cy.x1, cy.y1, cy.x2, cy.y2, 0, pack(layerColor('courtyard'), 0.7));
      const rank = (o) => (o.t === 'pad' ? 2 : o.layer === this.activeLayer ? 3 : o.layer === 'top' ? 1 : 0);
      items.sort((a, c) => rank(a) - rank(c));
    }
    for (const o of items) this.drawObject(b, o);
    b.touch();
    this._rebuildSelection();
  }

  _rebuildSelection() {
    const b = this.selBatch;
    b.clear();
    const col = pack(this.palette.selection, this.mode === 'symbol' ? 1 : 0.65);
    for (const id of this.selection) {
      const o = this.doc.store.get(id);
      if (!o || this.hidden.has(id)) continue;
      this.drawObject(b, o, col);
      const bb = libBounds(o);
      if (bboxValid(bb) && (o.t === 'pin' || o.t === 'pad' || o.t === 'text' || o.t === 'anchor')) b.rectOutline(bb.minX, bb.minY, bb.maxX, bb.maxY, 0, pack(this.palette.selection, 0.6));
    }
    b.touch();
  }

  draw() {
    const r = this.renderer;
    if (!r) return;
    if (this._dirtyMain) { this._dirtyMain = false; this._rebuildMain(); this._renderStatus(); }
    const sym = this.mode === 'symbol';
    const pal = this.palette;
    r.draw({
      // Footprints draw on the board color, as they appear on a board.
      background: toVec4(sym ? pal.paper : pal.boardFill),
      passes: [
        { grid: { step: this.grid, major: sym ? 10 : 4, minor: toVec4(pal.gridMinor), majorColor: toVec4(pal.gridMajor), style: sym ? 'lines' : this.app.settings.get('pcbGridStyle') } },
        { batch: this.main },
        { batch: this.selBatch },
        { batch: this.overlay },
      ],
    });
  }

  // ---- Selection and picking ----

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

  pickAll(x, y) {
    const tol = 5 * this.nmPerPx;
    const out = [];
    for (const o of this.doc.store.query({ minX: x - tol, minY: y - tol, maxX: x + tol, maxY: y + tol })) {
      if (LIB_META_TYPES.has(o.t)) continue;
      const d = libHitDistance(o, x, y);
      if (d <= tol) out.push({ o, d });
    }
    out.sort((a, b) => (LIB_PICK_ORDER[a.o.t] ?? 9) - (LIB_PICK_ORDER[b.o.t] ?? 9) || a.d - b.d);
    return out.map((e) => e.o);
  }

  boxSelect(box, crossing) {
    return this.doc.store.query(box).filter((o) => !LIB_META_TYPES.has(o.t)).filter((o) => {
      const b = libBounds(o);
      return crossing ? bboxIntersects(b, box) : bboxContains(box, b);
    }).map((o) => o.id);
  }

  anchorOf(o) {
    if (o.t === 'line' || o.t === 'rect') return { x: o.x1, y: o.y1 };
    if (o.t === 'circle' || o.t === 'arc') return { x: o.cx, y: o.cy };
    if (o.t === 'poly' || o.t === 'polyline') return { x: o.pts[0], y: o.pts[1] };
    return { x: o.x, y: o.y };
  }

  beginMove(ids, anchor) {
    const ed = this;
    const store = this.doc.store;
    const base = ids.map((id) => store.get(id)).filter(Boolean);
    let ops = [];
    let dx = 0, dy = 0;
    const transformed = () => base.map((o) => {
      let r = o;
      for (const op of ops) r = op === 'rot' ? rotateLib(r, anchor.x, anchor.y, 90) : mirrorLib(r, anchor.x, anchor.y, op);
      return translateLib(r, dx, dy);
    });
    for (const id of ids) this.hidden.add(id);
    this._dirtyMain = true;
    this.requestRender(true);
    return {
      ids, anchor,
      update(ndx, ndy) { dx = ndx; dy = ndy; ed.requestRender(true); },
      rotate() { ops.push('rot'); ed.requestRender(true); },
      mirror(axis) { ops.push(axis); ed.requestRender(true); },
      draw(b) { for (const o of transformed()) ed.drawObject(b, o, pack(ed.palette.selection)); },
      commit() {
        ed._endMove();
        if (!dx && !dy && !ops.length) return;
        const objs = transformed();
        store.transact(ids.length === 1 ? 'Move' : `Move ${ids.length} objects`, (s) => { for (const o of objs) s.update(o.id, o); });
      },
      cancel() { ops = []; dx = dy = 0; ed._endMove(); },
    };
  }

  _endMove() {
    this.hidden.clear();
    this._dirtyMain = true;
    this.requestRender(true);
  }

  nudge(dx, dy) {
    const ids = [...this.selection];
    this.doc.store.transact('Nudge', (s) => { for (const id of ids) { const o = s.get(id); if (o) s.update(id, translateLib(o, dx, dy)); } }, { mergeKey: `nudge:${ids.join(',')}` });
  }

  _selectionCenter() {
    const objs = this.selectedObjects();
    if (!objs.length) return null;
    if (objs.length === 1) return this.anchorOf(objs[0]);
    const b = boundsOfAll(objs);
    return { x: snap((b.minX + b.maxX) / 2, this.grid), y: snap((b.minY + b.maxY) / 2, this.grid) };
  }

  rotateSelection(deg = 90) {
    const c = this._selectionCenter();
    if (!c) return;
    this.doc.store.transact('Rotate', (s) => { for (const o of this.selectedObjects()) s.update(o.id, rotateLib(o, c.x, c.y, deg)); });
  }

  mirrorSelection(axis) {
    const c = this._selectionCenter();
    if (!c) return;
    this.doc.store.transact('Mirror', (s) => { for (const o of this.selectedObjects()) s.update(o.id, mirrorLib(o, c.x, c.y, axis)); });
  }

  deleteSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.doc.store.transact(ids.length === 1 ? 'Delete' : `Delete ${ids.length} objects`, (s) => { for (const id of ids) s.remove(id); });
    this.setSelection([]);
  }

  selectAll() { this.setSelection([...this.doc.items()].map((o) => o.id)); }

  copySelection() {
    const objs = this.selectedObjects().filter((o) => o.t !== 'anchor');
    if (!objs.length) return null;
    const b = boundsOfAll(objs);
    const ref = { x: snap(b.minX, this.grid), y: snap(b.minY, this.grid) };
    return { kind: `lib-${this.mode}`, objects: objs.map((o) => translateLib(o, -ref.x, -ref.y)), library: {} };
  }

  pasteClip(clip) {
    if (!clip || clip.kind !== `lib-${this.mode}`) return false;
    const ed = this;
    this.setTool({
      name: 'paste', cursor: 'crosshair',
      hint: () => 'Click to paste. Esc cancels',
      click(ev) {
        const ids = [];
        ed.doc.store.transact('Paste', (s) => { for (const o of clip.objects) { const n = { ...translateLib(o, ev.x, ev.y), id: uid() }; s.add(n); ids.push(n.id); } });
        ed.endTool();
        ed.setSelection(ids);
      },
      key(e, combo) { if (combo === 'Escape') { ed.endTool(); return true; } return false; },
      rightClick() { ed.endTool(); return true; },
      drawOverlay(b) {
        const c = ed.cursor;
        if (c.inside) for (const o of clip.objects) ed.drawObject(b, translateLib(o, c.x, c.y), pack(ed.palette.selection, 0.8));
      },
    });
    return true;
  }

  // ---- Corner editing for lines, rectangles and polygons ----

  vertexHandles() {
    if (this.selection.size !== 1 || this.tool !== this.select || this.select.move) return [];
    const [id] = this.selection;
    const o = this.doc.store.get(id);
    if (!o) return [];
    if (o.t === 'line') return [{ id, index: 0, x: o.x1, y: o.y1 }, { id, index: 1, x: o.x2, y: o.y2 }];
    if (o.t === 'rect') return [[o.x1, o.y1], [o.x2, o.y1], [o.x2, o.y2], [o.x1, o.y2]].map(([x, y], index) => ({ id, index, x, y }));
    if (o.t === 'poly' || o.t === 'polyline') { const out = []; for (let i = 0; i < o.pts.length; i += 2) out.push({ id, index: i / 2, x: o.pts[i], y: o.pts[i + 1] }); return out; }
    return [];
  }

  vertexAt(x, y) {
    const reach = 6 * this.nmPerPx;
    let best = null, bd = reach;
    for (const hd of this.vertexHandles()) { const d = Math.hypot(hd.x - x, hd.y - y); if (d <= bd) { bd = d; best = hd; } }
    return best;
  }

  _moveVertex(o, index, x, y) {
    if (o.t === 'line') return index === 0 ? { ...o, x1: x, y1: y } : { ...o, x2: x, y2: y };
    if (o.t === 'rect') {
      const r = { ...o };
      if (index === 0 || index === 3) r.x1 = x; else r.x2 = x;
      if (index === 0 || index === 1) r.y1 = y; else r.y2 = y;
      return { ...r, x1: Math.min(r.x1, r.x2), x2: Math.max(r.x1, r.x2), y1: Math.min(r.y1, r.y2), y2: Math.max(r.y1, r.y2) };
    }
    const pts = [...o.pts];
    pts[index * 2] = x;
    pts[index * 2 + 1] = y;
    return { ...o, pts: o.t === 'polyline' ? simplifyPolyline(pts) : pts };
  }

  beginVertexDrag(hd) { this.hidden.add(hd.id); this._dirtyMain = true; this.requestRender(true); }
  drawVertexDrag(b, v) { const o = this.doc.store.get(v.id); if (o) this.drawObject(b, this._moveVertex(o, v.index, v.x, v.y), pack(this.palette.selection)); }
  endVertexDrag(v, commit) {
    this.hidden.delete(v.id);
    this._dirtyMain = true;
    const o = this.doc.store.get(v.id);
    if (commit && o) this.doc.store.transact('Move corner', (s) => s.update(v.id, this._moveVertex(o, v.index, v.x, v.y)));
    this.requestRender(true);
  }

  // ---- Tools ----

  endTool() { this.setTool(this.select); this.canvas.focus(); }

  startTool(name) {
    if (name === 'pin' && this.mode !== 'symbol') this.setMode('symbol');
    if (name === 'pad' && this.mode !== 'footprint') this.setMode('footprint');
    const make = {
      pin: () => new PinTool(this),
      pad: () => { this.padTemplate = { ...this.padTemplate, num: this.nextPadNumber() }; return new PadTool(this); },
      line: () => new ShapeTool(this, 'line'), rect: () => new ShapeTool(this, 'rect'), circle: () => new ShapeTool(this, 'circle'),
      arc: () => new ShapeTool(this, 'arc'), poly: () => new ShapeTool(this, 'poly'), text: () => new ShapeTool(this, 'text'),
    }[name];
    if (!make) return;
    this.setTool(make());
    this.canvas.focus();
  }

  /** Stroke, fill and layer for new drawing objects in the current mode. */
  graphicStyle(kind) {
    if (this.mode === 'symbol') return kind === 'rect' ? { w: 0, fill: 'body' } : { w: 0 };
    const l = this.activeLayer;
    const w = l === 'courtyard' ? mm(0.05) : l === 'mech1' ? mm(0.1) : l === 'top' ? mm(0.25) : mm(0.15);
    return { w, layer: l };
  }

  nextPinTemplate() {
    const pins = [...this.doc.symStore.all()].filter((o) => o.t === 'pin');
    const nums = pins.map((p) => Number(p.num)).filter(Number.isFinite);
    const last = pins[pins.length - 1];
    const n = String(nums.length ? Math.max(...nums) + 1 : pins.length + 1);
    return { t: 'pin', num: n, name: `P${n}`, length: last?.length || mil(200), rot: last?.rot ?? 0, type: last?.type || 'passive' };
  }

  nextPadNumber() {
    const nums = [...this.doc.fpStore.all()].filter((o) => o.t === 'pad').map((p) => Number(p.num)).filter(Number.isFinite);
    return String(nums.length ? Math.max(...nums) + 1 : 1);
  }

  // ---- Commands ----

  async padArrayDialog() {
    if (this.mode !== 'footprint') this.setMode('footprint');
    const t = this.padTemplate;
    const len = (key, label, v) => ({
      key, label: `${label} (mm)`, type: 'text', value: formatLength(v, 'mm', { suffix: false }),
      parse: (s) => { const n = parseLength(s, 'mm'); return n > 0 ? n : null; }, error: 'enter a length greater than zero',
    });
    const count = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
    const form = buildForm([
      { key: 'rows', label: 'Rows', type: 'number', value: 4, min: 1, max: 100, parse: count, error: 'enter a whole number from 1 to 100' },
      { key: 'cols', label: 'Columns', type: 'number', value: 2, min: 1, max: 100, parse: count, error: 'enter a whole number from 1 to 100' },
      len('pitchX', 'Column spacing', mm(7.62)),
      len('pitchY', 'Row spacing', mm(2.54)),
      { key: 'start', label: 'First number', type: 'number', value: Number(this.nextPadNumber()), min: 0, parse: count, error: 'enter a whole number' },
      { key: 'order', label: 'Numbering', type: 'select', value: 'around', options: [['around', 'Around (down the left, up the right)'], ['rows', 'Row by row'], ['columns', 'Column by column']] },
      { key: 'side', label: 'Pads', type: 'select', value: t.side === 'thru' ? 'thru' : 'top', options: [['thru', 'Through hole'], ['top', 'Surface mount']] },
      len('w', 'Pad width', t.side === 'thru' ? t.w : mm(1.6)),
      len('h', 'Pad height', t.side === 'thru' ? t.h : mm(1.6)),
      len('drill', 'Hole (through hole)', t.drill || mm(0.8)),
    ]);
    const err = h('div.small.sev-error', { role: 'alert' });
    await openDialog({
      title: 'Pad array',
      body: [h('p.muted', 'Adds a grid of pads centred on the origin. The first pad of a through-hole array is square.'), form.el, err],
      actions: [{ label: 'Cancel' }, {
        label: 'Add pads', primary: true,
        run: () => {
          const msg = form.validate();
          if (msg) { err.textContent = msg; return false; }
          const v = form.values();
          const thru = v.side === 'thru';
          if (thru && v.drill >= Math.min(v.w, v.h)) { err.textContent = 'The hole must be smaller than the pad.'; return false; }
          const pads = padArray({
            rows: v.rows, cols: v.cols, pitchX: v.pitchX, pitchY: v.pitchY, start: v.start, order: v.order,
            template: { shape: thru ? 'round' : 'roundrect', w: v.w, h: v.h, side: v.side, drill: thru ? v.drill : 0, plated: true, rot: 0, radius: 0.25, firstSquare: thru },
          });
          const clash = overlappingPads(pads);
          if (clash) { err.textContent = `Pads ${clash[0]} and ${clash[1]} would overlap. Increase the spacing or make the pads smaller.`; return false; }
          const ids = [];
          this.doc.store.transact('Add pad array', (s) => { for (const p of pads) { const n = s.add({ ...p, id: uid() }); ids.push(n.id); } });
          this.setSelection(ids);
          this.fitAll();
          return true;
        },
      }],
    }).result;
  }

  fitCourtyard() {
    if (this.mode !== 'footprint') this.setMode('footprint');
    const objs = [...this.doc.fpStore.all()];
    const c = courtyardFor(objs);
    if (!c) { this.app.toast('Add pads first: the courtyard is fitted around them.', { kind: 'info' }); return; }
    this.doc.fpStore.transact('Fit courtyard', (s) => {
      for (const o of objs) if (o.layer === 'courtyard' && o.t === 'rect') s.remove(o.id);
      s.update('fpmeta', { courtyard: c, enabled: true });
      s.add({ t: 'rect', ...c, w: mm(0.05), layer: 'courtyard', id: uid() });
    });
    this.app.toast('Courtyard fitted around the pads with a 0.25 mm margin.', { timeout: 2500 });
  }

  pinTableDialog() {
    if (this.mode !== 'symbol') this.setMode('symbol');
    const store = this.doc.symStore;
    const rows = [...store.all()].filter((o) => o.t === 'pin').map((p) => ({ ...p }));
    const tbody = h('tbody');
    const render = () => {
      clear(tbody);
      rows.forEach((p, i) => {
        const inp = (key, w, label) => {
          const el = h('input', { type: 'text', value: key === 'length' ? formatLength(p.length, 'mil', { suffix: false }) : p[key] ?? '', 'aria-label': `${label} of pin ${i + 1}`, style: { width: w } });
          // On input, not change: Enter applies the table without the field losing focus.
          el.addEventListener('input', () => { if (key === 'length') { const v = parseLength(el.value, 'mil'); if (v > 0) p.length = v; } else p[key] = el.value.trim(); });
          return el;
        };
        const type = h('select', { 'aria-label': `Type of pin ${i + 1}` }, PIN_TYPES.map((t) => h('option', { value: t, selected: t === p.type }, PIN_TYPE_LABELS[t])));
        type.addEventListener('change', () => { p.type = type.value; });
        const side = h('select', { 'aria-label': `Side of pin ${i + 1}` }, SIDE_OPTIONS.map(([v, l]) => h('option', { value: v, selected: Number(v) === p.rot }, l)));
        side.addEventListener('change', () => { p.rot = Number(side.value); });
        const hid = h('input', { type: 'checkbox', checked: !!p.hidden, 'aria-label': `Hide pin ${i + 1}` });
        hid.addEventListener('change', () => { p.hidden = hid.checked; });
        tbody.append(h('tr', h('td', inp('num', '60px', 'Number')), h('td', inp('name', '140px', 'Name')), h('td', type), h('td', side), h('td', inp('length', '60px', 'Length')), h('td', hid),
          h('td', h('button.icon-btn.sm', { type: 'button', 'aria-label': `Remove pin ${p.num}`, onClick: () => { rows.splice(i, 1); render(); } }, icon('trash', 13)))));
      });
    };
    render();
    const add = () => {
      const last = rows[rows.length - 1];
      // Count up from the last row to a number no row uses: the last row is
      // often not the highest (a ground pin listed at the end, say).
      const used = new Set(rows.map((r) => r.num));
      let num = last ? nextLabel(last.num) : '';
      while (used.has(num) && nextLabel(num) !== num) num = nextLabel(num);
      const next = last ? { ...last, id: undefined, num, name: nextLabel(last.name), y: last.rot === 0 || last.rot === 180 ? last.y - mil(100) : last.y, x: last.rot === 90 || last.rot === 270 ? last.x + mil(100) : last.x } : { ...this.nextPinTemplate(), x: -mil(500), y: 0 };
      rows.push(next);
      render();
    };
    openDialog({
      title: 'Pin table', size: 'wide',
      body: [h('p.muted', 'Edit every pin at once. Changing a side moves the pin direction; positions are kept, so tidy the layout on the canvas afterwards.'),
        h('div.table-wrap', h('table.grid', h('thead', h('tr', h('th', 'Number'), h('th', 'Name'), h('th', 'Type'), h('th', 'Side'), h('th', 'Length (mil)'), h('th', 'Hidden'), h('th', h('span.sr-only', 'Actions')))), tbody))],
      actions: [
        { label: 'Add pin', left: true, run: () => { add(); return false; } },
        { label: 'Cancel' },
        {
          label: 'Apply', primary: true,
          run: () => {
            store.transact('Edit pins', (s) => {
              const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
              for (const o of [...s.all()]) if (o.t === 'pin' && !keep.has(o.id)) s.remove(o.id);
              for (const r of rows) {
                const pin = { ...r, t: 'pin' };
                if (r.id && s.get(r.id)) s.update(r.id, pin); else { delete pin.id; s.add(pin); }
              }
            });
            return true;
          },
        },
      ],
    });
  }

  /** Validation results for the Messages panel. */
  validate() {
    return validateComponent(this.doc.toDef());
  }

  /**
   * Writes the component to the project library and My library. A project's
   * edited copy of a built-in component keeps the built-in id, so it stays in
   * the project: in My library it would replace the built-in everywhere.
   */
  async save() {
    const def = this.doc.toDef();
    if (def.footprint && !def.footprint.courtyard && def.footprint.pads.length) def.footprint.courtyard = courtyardFor([...this.doc.fpStore.all()]);
    const issues = validateComponent(def);
    const errors = issues.filter((m) => m.severity === 'error');
    if (this.project) this.project.putComponent(def);
    if (!findComponent(def.id)) await this.app.userLibrary?.put(def);
    this.doc.markSaved();
    this.app.renderTabs?.();
    this.app.updateTitle?.();
    this.app.toast(errors.length ? `${def.name} saved with ${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors[0].message}` : `${def.name} saved to the project library.`, { kind: errors.length ? 'warning' : 'success', timeout: 4000 });
    return true;
  }

  // ---- View ----

  fitAll(animate = true) {
    let b = boundsOfAll([...this.doc.items()]);
    const pad = this.mode === 'symbol' ? mil(500) : mm(2);
    b = bboxValid(b) ? bboxUnion(b, { minX: -pad, minY: -pad, maxX: pad, maxY: pad }) : { minX: -pad * 2, minY: -pad * 2, maxX: pad * 2, maxY: pad * 2 };
    // Leave room around the part for the action bar and labels.
    const mx = (b.maxX - b.minX) * 0.15, my = (b.maxY - b.minY) * 0.2;
    this.fitBox({ minX: b.minX - mx, minY: b.minY - my, maxX: b.maxX + mx, maxY: b.maxY + my }, animate);
  }

  fitContent() { this.fitAll(); }

  fitSelection() {
    const objs = this.selectedObjects();
    if (!objs.length) return this.fitAll();
    this.fitBox(objs.reduce((acc, o) => bboxUnion(acc, libBounds(o)), bboxEmpty()));
  }

  focusObject(id) { if (this.doc.store.get(id)) { this.setSelection([id]); this.fitSelection(); } }

  onContextMenu(ev, e) {
    if (this.tool !== this.select) { this.endTool(); return; }
    const hit = this.pickAll(ev.rawX, ev.rawY)[0];
    if (hit && !this.selection.has(hit.id)) this.setSelection([hit.id]);
    const sym = this.mode === 'symbol';
    const items = hit ? [
      { command: 'edit.properties' }, { separator: true },
      { command: 'edit.cut' }, { command: 'edit.copy' }, { command: 'edit.paste' }, { command: 'edit.duplicate' }, { command: 'edit.delete' },
      { separator: true }, { command: 'libed.rotate' }, { command: 'libed.mirrorX' }, { command: 'libed.mirrorY' },
    ] : [
      { command: 'edit.paste' }, { separator: true },
      sym ? { command: 'libed.place.pin' } : { command: 'libed.place.pad' },
      sym ? { command: 'libed.pinTable' } : { command: 'libed.padArray' },
      sym ? null : { command: 'libed.courtyard' },
      { separator: true }, { command: sym ? 'libed.mode.footprint' : 'libed.mode.symbol' }, { command: 'view.fit' }, { command: 'libed.save' },
    ].filter(Boolean);
    contextMenu(e, items, 'Component');
  }

  // ---- Properties ----

  propertySpec() {
    const objs = this.selectedObjects();
    if (!objs.length) return this._componentSpec();
    return this._objectSpec(objs);
  }

  _field(objs, { label, type = 'text', get, set, options }) {
    const v0 = get(objs[0]);
    const value = objs.every((o) => get(o) === v0) ? v0 : MIXED;
    return {
      label, type, options, value,
      onChange: (v) => this.doc.store.transact(`Change ${label.toLowerCase()}`, (s) => {
        for (const o of objs) { const cur = s.get(o.id); if (cur) s.update(o.id, set(cur, v)); }
      }, { mergeKey: `${label}:${objs.map((o) => o.id).join(',')}` }),
    };
  }

  _componentSpec() {
    const meta = this.doc.meta, fm = this.doc.fpMeta;
    const setMeta = (patch, label) => this.doc.symStore.transact(label, (s) => s.update('libmeta', patch), { mergeKey: `meta:${label}` });
    const setFp = (patch, label) => this.doc.fpStore.transact(label, (s) => s.update('fpmeta', patch), { mergeKey: `fp:${label}` });
    const body = fm.body || null;
    const setBody = (patch) => setFp({ body: { w: mm(2), h: mm(2), height: mm(1), color: '#222222', shape: 'box', ...(fm.body || {}), ...patch } }, '3D body');
    const params = Object.entries(meta.params || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    const def = this.doc.toDef();
    const cy = def.footprint?.courtyard;
    const issues = validateComponent(def);
    return {
      title: 'Component',
      sections: [
        {
          title: 'General',
          fields: [
            { label: 'Name', type: 'text', value: meta.name || '', onChange: (v) => setMeta({ name: v }, 'Name') },
            { label: 'Designator prefix', type: 'text', value: meta.prefix || '', onChange: (v) => setMeta({ prefix: v.replace(/[^A-Za-z_]/g, '') }, 'Prefix') },
            { label: 'Default value', type: 'text', value: meta.value || '', onChange: (v) => setMeta({ value: v }, 'Value') },
            { label: 'Description', type: 'text', value: meta.description || '', onChange: (v) => setMeta({ description: v }, 'Description') },
            { label: 'Category', type: 'select', value: meta.category || 'Miscellaneous', options: CATEGORIES.map((c) => [c, c]), onChange: (v) => setMeta({ category: v }, 'Category') },
            { label: 'Keywords', type: 'text', value: (meta.keywords || []).join(', '), onChange: (v) => setMeta({ keywords: v.split(/[,\s]+/).filter(Boolean) }, 'Keywords') },
            { label: 'Parameters', type: 'textarea', value: params, onChange: (v) => setMeta({ params: Object.fromEntries(v.split('\n').map((l) => l.split('=')).filter((p) => p[0]?.trim()).map(([k, ...r]) => [k.trim(), r.join('=').trim()])) }, 'Parameters') },
            { label: 'Show pin names', type: 'bool', value: meta.showPinNames !== false, onChange: (v) => setMeta({ showPinNames: v ? undefined : false }, 'Pin names') },
            { label: 'Show pin numbers', type: 'bool', value: meta.showPinNumbers !== false, onChange: (v) => setMeta({ showPinNumbers: v ? undefined : false }, 'Pin numbers') },
            { label: 'Save', type: 'button', text: 'Save to project', onClick: () => this.save() },
          ],
        },
        {
          title: 'Footprint',
          fields: [
            { label: 'Has a footprint', type: 'bool', value: !!def.footprint, onChange: (v) => setFp({ enabled: v }, 'Footprint') },
            { label: 'Footprint name', type: 'text', value: fm.name || '', onChange: (v) => setFp({ name: v }, 'Footprint name') },
            { label: 'Description', type: 'text', value: fm.description || '', onChange: (v) => setFp({ description: v }, 'Footprint description') },
            { label: 'Courtyard', type: 'readonly', value: cy ? `${formatLength(cy.x2 - cy.x1, 'mm')} x ${formatLength(cy.y2 - cy.y1, 'mm')}` : 'None' },
            { label: 'Fit', type: 'button', text: 'Fit courtyard to pads', onClick: () => this.fitCourtyard() },
          ],
        },
        {
          title: '3D body',
          fields: [
            { label: 'Shape', type: 'select', value: body ? body.shape || 'box' : 'none', options: [['none', 'None'], ['box', 'Box'], ['cylinder', 'Cylinder']], onChange: (v) => (v === 'none' ? setFp({ body: undefined }, '3D body') : setBody({ shape: v })) },
            body ? { label: 'Width', type: 'length', value: body.w, onChange: (v) => setBody({ w: Math.max(10_000, v) }) } : null,
            body ? { label: 'Length', type: 'length', value: body.h, onChange: (v) => setBody({ h: Math.max(10_000, v) }) } : null,
            body ? { label: 'Height', type: 'length', value: body.height, onChange: (v) => setBody({ height: Math.max(10_000, v) }) } : null,
            body ? { label: 'Color', type: 'color', value: body.color || '#222222', onChange: (v) => setBody({ color: v }) } : null,
          ].filter(Boolean),
        },
        {
          title: 'Checks',
          fields: issues.length ? issues.map((m) => ({ label: m.severity === 'error' ? 'Error' : m.severity === 'warning' ? 'Warning' : 'Note', type: 'readonly', value: m.message })) : [{ label: 'Status', type: 'readonly', value: 'No problems found' }],
        },
      ],
    };
  }

  _objectSpec(objs) {
    const types = new Set(objs.map((o) => o.t));
    const t = types.size === 1 ? objs[0].t : null;
    const F = (o) => this._field(objs, o);
    const L = (label, key, min = 0) => F({ label, type: 'length', get: (o) => o[key], set: (o, v) => ({ [key]: Math.max(min, v) }) });
    const pos = [F({ label: 'X', type: 'length', get: (o) => o.x, set: (o, v) => ({ x: v }) }), F({ label: 'Y', type: 'length', get: (o) => o.y, set: (o, v) => ({ y: v }) })];
    const names = { pin: 'Pin', pad: 'Pad', anchor: 'Label anchor', line: 'Line', rect: 'Rectangle', circle: 'Circle', arc: 'Arc', poly: 'Polygon', polyline: 'Polyline', text: 'Text' };
    const title = t ? `${objs.length > 1 ? `${objs.length} ` : ''}${names[t]}${objs.length > 1 ? 's' : ''}` : `${objs.length} objects`;
    const sections = [];
    if (t === 'pin') {
      sections.push({ title: 'General', fields: [
        objs.length === 1 ? F({ label: 'Number', get: (o) => o.num, set: (o, v) => ({ num: v.trim() }) }) : null,
        F({ label: 'Name', get: (o) => o.name || '', set: (o, v) => ({ name: v }) }),
        F({ label: 'Electrical type', type: 'select', options: PIN_TYPES.map((p) => [p, PIN_TYPE_LABELS[p]]), get: (o) => o.type, set: (o, v) => ({ type: v }) }),
        F({ label: 'Side', type: 'select', options: SIDE_OPTIONS, get: (o) => String(o.rot), set: (o, v) => ({ rot: Number(v) }) }),
        L('Length', 'length', mil(10)),
        F({ label: 'Shape', type: 'select', options: [['none', 'Line'], ['dot', 'Inverted (dot)'], ['clock', 'Clock'], ['dotclock', 'Inverted clock']], get: (o) => o.shape || 'none', set: (o, v) => ({ shape: v === 'none' ? undefined : v }) }),
        F({ label: 'Hide name', type: 'bool', get: (o) => !!o.hideName, set: (o, v) => ({ hideName: v || undefined }) }),
        F({ label: 'Hide number', type: 'bool', get: (o) => !!o.hideNum, set: (o, v) => ({ hideNum: v || undefined }) }),
        F({ label: 'Hidden power pin', type: 'bool', get: (o) => !!o.hidden, set: (o, v) => ({ hidden: v || undefined }) }),
      ].filter(Boolean) });
      sections.push({ title: 'Location', fields: pos });
    } else if (t === 'pad') {
      sections.push({ title: 'General', fields: [
        objs.length === 1 ? F({ label: 'Number', get: (o) => o.num || '', set: (o, v) => ({ num: v.trim() }) }) : null,
        F({ label: 'Shape', type: 'select', options: [['round', 'Round'], ['rect', 'Rectangle'], ['roundrect', 'Rounded rectangle'], ['oval', 'Oval']], get: (o) => o.shape, set: (o, v) => ({ shape: v, h: o.h || o.w }) }),
        L('Width', 'w', 10_000), L('Height', 'h', 10_000),
        F({ label: 'Rotation', type: 'angle', get: (o) => o.rot || 0, set: (o, v) => ({ rot: ((v % 360) + 360) % 360 }) }),
        F({ label: 'Side', type: 'select', options: [['top', 'Top'], ['thru', 'Through hole'], ['bottom', 'Bottom']], get: (o) => o.side, set: (o, v) => ({ side: v, drill: v === 'thru' ? o.drill || Math.round(Math.min(o.w, o.h || o.w) * 0.5) : 0 }) }),
        L('Hole', 'drill', 0),
        F({ label: 'Plated', type: 'bool', get: (o) => o.plated !== false, set: (o, v) => ({ plated: v }) }),
        F({ label: 'Corner radius (ratio)', type: 'number', get: (o) => o.radius ?? 0.25, set: (o, v) => ({ radius: Math.max(0, Math.min(0.5, v)) }) }),
        F({ label: 'No paste', type: 'bool', get: (o) => !!o.noPaste, set: (o, v) => ({ noPaste: v || undefined }) }),
      ].filter(Boolean) });
      sections.push({ title: 'Location', fields: pos });
    } else if (t === 'anchor') {
      sections.push({ title: 'Location', fields: pos });
    } else if (t && GRAPHIC_TYPES.has(t)) {
      const fp = this.mode === 'footprint';
      sections.push({ title: 'General', fields: [
        fp ? F({ label: 'Layer', type: 'select', options: FP_LAYERS.map((l) => [l, LAYERS[l].name]), get: (o) => o.layer || 'topOverlay', set: (o, v) => ({ layer: v }) }) : null,
        t !== 'text' ? L('Line width', 'w', 0) : null,
        ['rect', 'circle', 'poly'].includes(t) ? F({ label: 'Fill', type: 'select', options: fp ? [['', 'None'], ['solid', 'Solid']] : [['', 'None'], ['body', 'Body color'], ['solid', 'Line color']], get: (o) => (o.fill === true ? 'solid' : o.fill || ''), set: (o, v) => ({ fill: v || undefined }) }) : null,
        t === 'circle' || t === 'arc' ? L('Radius', 'r', 1000) : null,
        t === 'arc' ? F({ label: 'Start angle', type: 'angle', get: (o) => o.a0, set: (o, v) => ({ a0: v }) }) : null,
        t === 'arc' ? F({ label: 'Sweep', type: 'angle', get: (o) => o.sweep, set: (o, v) => ({ sweep: Math.max(1, Math.min(360, v)) }) }) : null,
        t === 'text' ? F({ label: 'Text', type: 'textarea', get: (o) => o.text, set: (o, v) => ({ text: v }) }) : null,
        t === 'text' ? L('Size', 'size', 100_000) : null,
        t === 'text' ? F({ label: 'Rotation', type: 'angle', get: (o) => o.rot || 0, set: (o, v) => ({ rot: v }) }) : null,
      ].filter(Boolean) });
      if (t === 'text') sections.push({ title: 'Location', fields: pos });
    } else sections.push({ title: 'General', fields: [{ label: 'Selected', type: 'readonly', value: [...types].map((x) => names[x] || x).join(', ') }] });
    return { title, sections };
  }

  dispose() {
    for (const u of this._unsub) u();
    window.removeEventListener('themechange', this._onTheme);
    for (const b of [this.main, this.selBatch, this.overlay]) this.renderer?.release(b);
    super.dispose();
  }
}
