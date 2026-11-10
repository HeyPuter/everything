// Schematic editor: draws one sheet, owns its selection and tools, and
// implements editing operations (move with rubber-banding wires, rotate,
// mirror, delete, clipboard, net highlighting).

import { CanvasView } from './view.js';
import { SelectTool } from './select-tool.js';
import { PlacePartTool, WireTool, LabelTool, PowerTool, PortTool, MarkerTool, TextTool, ShapeTool } from './sch-tools.js';
import { Batch } from '../render/batch.js';
import { pack, toVec4 } from '../render/color.js';
import { SCH_PALETTES } from '../render/palette.js';
import { buildSchematic, drawSchObject } from '../render/sch-scene.js';
import { resolvedTheme } from '../app/theme.js';
import { sheetExtents } from '../model/project.js';
import { schHitDistance, schBounds, SCH_PICK_ORDER, translateSch, rotateSch, mirrorSch, connectionPoints, JUNCTION_R, WIRE_W } from '../model/sch.js';
import { placeSymbol } from '../model/place.js';
import { bboxContains, bboxIntersects, bboxUnion, bboxEmpty, distPointSeg, simplifyPolyline } from '../core/geom.js';
import { mil, SCH_GRID, snap } from '../core/units.js';
import { uid } from '../core/emitter.js';
import { designatorAllocator } from '../model/annotate.js';
import { contextMenu } from '../ui/menu.js';
import { installVertexEditing, dropFoldBacks } from './vertex.js';

export class SchEditor extends CanvasView {
  constructor(app, project, doc) {
    super(app, { label: `Schematic ${doc.name}` });
    this.kind = 'sch';
    this.project = project;
    this.doc = doc;
    this.selection = new Set();
    this.highlight = null; // { net, ids:Set, pins:[...] }
    this.sheetBatch = new Batch();
    this.main = new Batch();
    this.selBatch = new Batch();
    this.hlBatch = new Batch();
    this.hidden = new Set();
    this._dirtyMain = true;
    this.lastLabel = 'NET1';
    this.hud.hidden = true;
    this.select = new SelectTool(this);
    this.setTool(this.select);
    this._unsub = [
      doc.store.on('change', (e) => this._onChange(e)),
      project.on('library', () => { this._dirtyMain = true; this.requestRender(true); }),
    ];
    this._onTheme = () => { this._dirtyMain = true; this.requestRender(true); };
    window.addEventListener('themechange', this._onTheme);
  }

  get lib() { return this.project.library; }
  get palette() { return SCH_PALETTES[resolvedTheme()]; }
  get grid() { return this.app.settings.get('schGrid') || SCH_GRID; }

  _onChange(e) {
    // An edit from elsewhere in the middle of a drag (undo, Delete): the drag
    // holds the objects as they were, and committing it would write them back.
    if (this.select.move || this.select.vertex) this.select.cancelDrag();
    // Drop deleted objects from the selection.
    for (const id of e.removed.keys()) this.selection.delete(id);
    this._dirtyMain = true;
    if (this.highlight) this._recomputeHighlight();
    this.requestRender(true);
    this.emit('selection', this.selection);
  }

  // ---- Drawing ----

  _rebuildMain() {
    const nl = this.project.netlist();
    const sheets = this.project.sheets;
    const idx = sheets.indexOf(this.doc);
    buildSchematic(this.main, this.doc, this.lib, this.palette, {
      sheetBatch: this.sheetBatch,
      hidden: this.hidden,
      junctions: nl.sheets.get(this.doc.id)?.junctions,
      info: { projectName: this.project.name, date: new Date(this.project.modified).toISOString().slice(0, 10), fileName: this.doc.name, sheetOf: `${idx + 1} of ${sheets.length}` },
    });
    this._rebuildSelection();
    this._rebuildHighlight();
  }

  _rebuildSelection() {
    const b = this.selBatch;
    b.clear();
    const col = pack(this.palette.selection);
    const fill = pack(this.palette.selection, 0.1);
    for (const id of this.selection) {
      const o = this.doc.store.get(id);
      if (!o || this.hidden.has(id)) continue;
      drawSchObject(b, o, this.lib, this.palette, col);
      const bb = schBounds(o, this.lib);
      const pad = mil(20);
      if (o.t !== 'wire' && o.t !== 'bus' && o.t !== 'gline') {
        b.rect((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, bb.maxX - bb.minX + pad * 2, bb.maxY - bb.minY + pad * 2, 0, 0, fill);
        b.rectOutline(bb.minX - pad, bb.minY - pad, bb.maxX + pad, bb.maxY + pad, 0, pack(this.palette.selection, 0.7));
      } else {
        for (let i = 0; i < o.pts.length; i += 2) b.rect(o.pts[i], o.pts[i + 1], mil(30), mil(30), 0, 0, col);
      }
    }
    b.touch();
  }

  _rebuildHighlight() {
    const b = this.hlBatch;
    b.clear();
    if (this.highlight) {
      const col = pack(this.palette.highlight);
      for (const id of this.highlight.ids) {
        const o = this.doc.store.get(id);
        if (o) drawSchObject(b, o, this.lib, this.palette, col);
      }
      for (const p of this.highlight.pins) {
        b.line(p.x, p.y, p.bx, p.by, mil(14), col);
        b.circle(p.x, p.y, mil(18), col);
      }
      for (const [x, y] of this.highlight.junctions) b.circle(x, y, JUNCTION_R, col);
    }
    b.touch();
  }

  draw() {
    const r = this.renderer;
    if (!r) return;
    if (this._dirtyMain) { this._dirtyMain = false; this._rebuildMain(); }
    const pal = this.palette;
    const ext = sheetExtents(this.doc.sheet);
    const dim = this.highlight ? [...toVec4(pal.paper).slice(0, 3), 0.7] : null;
    r.draw({
      background: toVec4(pal.background),
      passes: [
        { batch: this.sheetBatch },
        { grid: { step: this.grid, major: this.grid >= SCH_GRID ? 10 : Math.round(SCH_GRID / this.grid) * 10, minor: toVec4(pal.gridMinor), majorColor: toVec4(pal.gridMajor), clip: ext } },
        { batch: this.main, mix: dim },
        { batch: this.hlBatch },
        { batch: this.selBatch },
        { batch: this.overlay },
      ],
    });
  }

  drawCursor(b) {
    if (this.app.settings.get('schCrosshair')) this.drawFullCrosshair(b, pack(this.palette.crosshair, 0.55));
  }

  // ---- Selection ----

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
    const box = { minX: x - tol, minY: y - tol, maxX: x + tol, maxY: y + tol };
    const out = [];
    for (const o of this.doc.store.query(box)) {
      const d = schHitDistance(o, x, y, this.lib);
      if (d <= tol) out.push({ o, d });
    }
    out.sort((a, b) => (SCH_PICK_ORDER[a.o.t] ?? 9) - (SCH_PICK_ORDER[b.o.t] ?? 9) || a.d - b.d);
    return out.map((e) => e.o);
  }

  boxSelect(box, crossing) {
    const ids = [];
    for (const o of this.doc.store.query(box)) {
      const b = schBounds(o, this.lib);
      if (crossing ? this._touches(o, box) : bboxContains(box, b)) ids.push(o.id);
    }
    return ids;
  }

  _touches(o, box) {
    if (o.t === 'wire' || o.t === 'bus' || o.t === 'gline') {
      for (let i = 2; i < o.pts.length; i += 2) {
        const seg = { minX: Math.min(o.pts[i - 2], o.pts[i]), minY: Math.min(o.pts[i - 1], o.pts[i + 1]), maxX: Math.max(o.pts[i - 2], o.pts[i]), maxY: Math.max(o.pts[i - 1], o.pts[i + 1]) };
        if (bboxIntersects(seg, box)) return true;
      }
      return false;
    }
    return bboxIntersects(schBounds(o, this.lib), box);
  }

  anchorOf(o) {
    if (o.t === 'wire' || o.t === 'bus' || o.t === 'gline') return { x: o.pts[0], y: o.pts[1] };
    if (o.t === 'grect') return { x: o.x1, y: o.y1 };
    if (o.t === 'gcircle') return { x: o.cx, y: o.cy };
    return { x: o.x, y: o.y };
  }

  // ---- Snapping and connections ----

  _connectionPoints(box, exclude) {
    const pts = [];
    for (const o of this.doc.store.query(box)) {
      if (exclude?.includes?.(o.id)) continue;
      if (o.t === 'gline' || o.t === 'text' || o.t === 'grect' || o.t === 'gcircle') continue;
      for (const p of connectionPoints(o, this.lib)) pts.push({ x: p[0], y: p[1], o });
    }
    return pts;
  }

  snapTargets(x, y, reach, exclude) {
    if (!this.tool?.snapPins) return null;
    let best = null, bd = reach;
    for (const p of this._connectionPoints({ minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach }, exclude)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bd) { bd = d; best = p; }
    }
    // Snap onto the nearest point of a wire when no hotspot is close.
    if (!best) {
      for (const o of this.doc.store.query({ minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach })) {
        if (o.t !== 'wire' || exclude?.includes?.(o.id)) continue;
        for (let i = 2; i < o.pts.length; i += 2) {
          const ax = o.pts[i - 2], ay = o.pts[i - 1], bx = o.pts[i], by = o.pts[i + 1];
          if (distPointSeg(x, y, ax, ay, bx, by) > reach) continue;
          const g = this.grid;
          const sx = ax === bx ? ax : snap(x, g), sy = ay === by ? ay : snap(y, g);
          if (distPointSeg(sx, sy, ax, ay, bx, by) < 1) return { x: sx, y: sy, o };
        }
      }
    }
    return best;
  }

  /** True where a wire (or bus, by kind) being drawn would connect to something. */
  isConnectionPoint(x, y, kind = 'wire') {
    const r = 1;
    const box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
    for (const p of this._connectionPoints(box)) if (p.x === x && p.y === y && p.o.t !== 'wire') return true;
    // A point on an existing wire (end or middle) is also a connection.
    for (const o of this.doc.store.query(box)) {
      if (o.t !== kind) continue;
      for (let i = 2; i < o.pts.length; i += 2) if (distPointSeg(x, y, o.pts[i - 2], o.pts[i - 1], o.pts[i], o.pts[i + 1]) < 1) return true;
    }
    return false;
  }

  // ---- Moving ----

  beginMove(ids, anchor) {
    const ed = this;
    const store = this.doc.store;
    const base = ids.map((id) => store.get(id)).filter(Boolean);
    const moving = new Set(ids);
    // Wire ends attached to moving connection points follow (rubber banding).
    const attachPts = new Map();
    for (const o of base) {
      if (o.t === 'wire' || o.t === 'bus' || o.t === 'gline' || o.t === 'text' || o.t === 'grect' || o.t === 'gcircle') continue;
      for (const [x, y] of connectionPoints(o, this.lib)) attachPts.set(`${x},${y}`, [x, y]);
    }
    for (const o of base) if (o.t === 'wire') {
      // Ends of moving wires drag non-moving wires attached to them as well.
      const n = o.pts.length;
      for (const k of [0, n - 2]) attachPts.set(`${o.pts[k]},${o.pts[k + 1]}`, [o.pts[k], o.pts[k + 1]]);
    }
    const dragged = [];
    if (attachPts.size) {
      const bb = base.reduce((acc, o) => bboxUnion(acc, schBounds(o, this.lib)), bboxEmpty());
      for (const w of store.query({ minX: bb.minX - 1, minY: bb.minY - 1, maxX: bb.maxX + 1, maxY: bb.maxY + 1 })) {
        if (w.t !== 'wire' || moving.has(w.id)) continue;
        const n = w.pts.length;
        const ends = [];
        if (attachPts.has(`${w.pts[0]},${w.pts[1]}`)) ends.push(0);
        if (attachPts.has(`${w.pts[n - 2]},${w.pts[n - 1]}`)) ends.push(n - 2);
        if (ends.length) dragged.push({ w, ends });
      }
    }
    let ops = []; // rotate / mirror steps applied about the anchor
    let dx = 0, dy = 0;
    const transformPoint = (x, y) => {
      let p = { t: 'junction', x, y };
      for (const op of ops) p = op === 'rot' ? rotateSch(p, anchor.x, anchor.y, 90) : mirrorSch(p, anchor.x, anchor.y, op);
      return [p.x + dx, p.y + dy];
    };
    const transformed = () => base.map((o) => {
      let r = o;
      for (const op of ops) r = op === 'rot' ? rotateSch(r, anchor.x, anchor.y, 90) : mirrorSch(r, anchor.x, anchor.y, op);
      return translateSch(r, dx, dy);
    });
    const draggedWires = () => dragged.map(({ w, ends }) => {
      const pts = [...w.pts];
      for (const k of ends) {
        const [nx, ny] = transformPoint(w.pts[k], w.pts[k + 1]);
        const nbr = k === 0 ? 2 : k - 2;
        if (pts.length > 4) {
          // Keep the attached segment horizontal or vertical by sliding its neighbor.
          const horizontal = w.pts[nbr + 1] === w.pts[k + 1], vertical = w.pts[nbr] === w.pts[k];
          if (horizontal) pts[nbr + 1] = ny;
          else if (vertical) pts[nbr] = nx;
        }
        pts[k] = nx; pts[k + 1] = ny;
      }
      if (pts.length === 4 && pts[0] !== pts[2] && pts[1] !== pts[3]) {
        // A straight wire pulled off axis gains a corner.
        const fixedFirst = !ends.includes(0);
        const corner = fixedFirst ? [pts[2], pts[1]] : [pts[0], pts[3]];
        return { ...w, pts: [pts[0], pts[1], ...corner, pts[2], pts[3]] };
      }
      // An end pushed onto or past its neighbor leaves a repeated point or a
      // stub doubling back, which would count as extra wire ends there (a
      // junction dot on a plain corner or pin).
      const flat = simplifyPolyline(pts);
      const cut = dropFoldBacks(flat);
      return { ...w, pts: cut.length === flat.length || stubInUse(w, flat, cut) ? flat : cut };
    });
    // True when something else connects on the part of a wire that dropping
    // its doubled-back stub would remove.
    const stubInUse = (w, flat, cut) => {
      for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i], y = flat[i + 1];
        let kept = false;
        for (let j = 2; j < cut.length && !kept; j += 2) kept = distPointSeg(x, y, cut[j - 2], cut[j - 1], cut[j], cut[j + 1]) === 0;
        if (kept) continue;
        for (const p of ed._connectionPoints({ minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 }, [w.id, ...ids])) if (p.x === x && p.y === y) return true;
      }
      return false;
    };
    for (const id of ids) this.hidden.add(id);
    for (const d of dragged) this.hidden.add(d.w.id);
    this._dirtyMain = true;
    this.requestRender(true);
    const session = {
      ids, anchor,
      update(ndx, ndy) { dx = ndx; dy = ndy; ed.requestRender(true); },
      rotate() { ops.push('rot'); ed.requestRender(true); },
      mirror(axis) { ops.push(axis); ed.requestRender(true); },
      draw(b) {
        const col = pack(ed.palette.selection);
        for (const o of transformed()) drawSchObject(b, o, ed.lib, ed.palette, col);
        for (const w of draggedWires()) if (w.pts.length >= 4) b.polyline(w.pts, WIRE_W, pack(ed.palette.wire));
      },
      commit({ label = ids.length === 1 ? 'Move' : `Move ${ids.length} objects`, mergeKey } = {}) {
        ed._endMove();
        if (!dx && !dy && !ops.length) return;
        const objs = transformed();
        const wires = draggedWires();
        store.transact(label, (s) => {
          for (const o of objs) s.update(o.id, o);
          // A wire shrunk to nothing (its pin now sits on its other end) goes.
          for (const w of wires) if (w.pts.length >= 4) s.update(w.id, w); else s.remove(w.id);
        }, { mergeKey });
      },
      cancel() { ops = []; dx = dy = 0; ed._endMove(); },
    };
    return session;
  }

  _endMove() {
    this.hidden.clear();
    this._dirtyMain = true;
    this.requestRender(true);
  }

  nudge(dx, dy) {
    const ids = [...this.selection].filter((id) => { const o = this.doc.store.get(id); return o && !o.locked; });
    if (!ids.length) return;
    // Like a drag, so wires attached to the moved pins follow instead of
    // being left disconnected.
    const move = this.beginMove(ids, { x: 0, y: 0 });
    move.update(dx, dy);
    move.commit({ label: 'Nudge', mergeKey: `nudge:${ids.join(',')}` });
  }

  _selectionCenter() {
    const objs = this.selectedObjects();
    if (!objs.length) return null;
    if (objs.length === 1) return this.anchorOf(objs[0]);
    const b = objs.reduce((acc, o) => bboxUnion(acc, schBounds(o, this.lib)), bboxEmpty());
    return { x: snap((b.minX + b.maxX) / 2, this.grid), y: snap((b.minY + b.maxY) / 2, this.grid) };
  }

  rotateSelection(deg = 90) {
    const c = this._selectionCenter();
    if (!c) return;
    this.doc.store.transact('Rotate', (s) => { for (const o of this.selectedObjects()) if (!o.locked) s.update(o.id, rotateSch(o, c.x, c.y, deg)); });
  }

  mirrorSelection(axis) {
    const c = this._selectionCenter();
    if (!c) return;
    this.doc.store.transact('Mirror', (s) => { for (const o of this.selectedObjects()) if (!o.locked) s.update(o.id, mirrorSch(o, c.x, c.y, axis)); });
  }

  deleteSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    this.doc.store.transact(ids.length === 1 ? 'Delete' : `Delete ${ids.length} objects`, (s) => { for (const id of ids) s.remove(id); });
    this.setSelection([]);
  }

  selectAll() { this.setSelection([...this.doc.items()].map((o) => o.id)); }

  // ---- Clipboard ----

  copySelection() {
    const objs = this.selectedObjects();
    if (!objs.length) return null;
    const lib = {};
    for (const o of objs) if (o.comp && this.lib[o.comp]) lib[o.comp] = this.lib[o.comp];
    const b = objs.reduce((acc, o) => bboxUnion(acc, schBounds(o, this.lib)), bboxEmpty());
    const ref = { x: snap(b.minX, this.grid), y: snap(b.minY, this.grid) };
    return { kind: 'sch', objects: objs.map((o) => translateSch(o, -ref.x, -ref.y)), library: lib };
  }

  /** Starts placing clipboard contents at the cursor. */
  pasteClip(clip) {
    if (!clip || clip.kind !== 'sch') return false;
    for (const def of Object.values(clip.library || {})) this.project.ensureComponent(def);
    this.setTool(new PasteTool(this, clip));
    return true;
  }

  // ---- Net highlighting ----

  netAt(x, y) {
    const nl = this.project.netlist();
    const si = nl.sheets.get(this.doc.id);
    for (const o of this.pickAll(x, y)) {
      if (o.t === 'wire') return si?.wireNet.get(o.id) || null;
      if (o.t === 'label') return o.text;
      if (o.t === 'power') return o.net;
      if (o.t === 'port') return o.name;
      if (o.t === 'part') {
        const tol = 6 * this.nmPerPx;
        for (const p of placeSymbol(this.lib[o.comp], o).pins) {
          if (distPointSeg(x, y, p.x, p.y, p.bx, p.by) <= tol) return nl.byPin.get(`${o.id}:${p.num}`) || null;
        }
      }
    }
    return null;
  }

  highlightNetAt(x, y) {
    const net = this.netAt(x, y);
    if (!net) { this.clearHighlight(); return; }
    this.highlightNet(net);
  }

  highlightNet(net) {
    this.highlight = { net };
    this._recomputeHighlight();
    this.requestRender();
    this.emit('highlight', net);
    this.app.crossProbeNet?.(net, this);
    this.announce(`Net ${net} highlighted`);
  }

  _recomputeHighlight() {
    const net = this.highlight.net;
    const nl = this.project.netlist();
    const si = nl.sheets.get(this.doc.id);
    const ids = new Set();
    const pins = [];
    for (const o of this.doc.items()) {
      if (o.t === 'wire' && si?.wireNet.get(o.id) === net) ids.add(o.id);
      else if ((o.t === 'label' && o.text === net) || (o.t === 'power' && o.net === net) || (o.t === 'port' && o.name === net)) ids.add(o.id);
      else if (o.t === 'part') {
        for (const p of placeSymbol(this.lib[o.comp], o).pins) if (nl.byPin.get(`${o.id}:${p.num}`) === net) pins.push(p);
      }
    }
    const junctions = (si?.junctions || []).filter(([x, y]) => si.pointNet(x, y) === net);
    this.highlight = { net, ids, pins, junctions };
    this._rebuildHighlight();
  }

  clearHighlight() {
    if (!this.highlight) return false;
    this.highlight = null;
    this._rebuildHighlight();
    this.requestRender();
    this.emit('highlight', null);
    return true;
  }

  // ---- Tools ----

  endTool() {
    this.setTool(this.select);
    this.canvas.focus();
  }

  placePart(def, opts) {
    this.project.ensureComponent(def);
    this.setTool(new PlacePartTool(this, this.lib[def.id], opts));
    this.canvas.focus();
  }

  startTool(name) {
    const tools = {
      wire: () => new WireTool(this, 'wire'),
      bus: () => new WireTool(this, 'bus'),
      line: () => new WireTool(this, 'gline'),
      label: () => new LabelTool(this),
      power: () => new PowerTool(this, { net: 'VCC', style: 'bar' }),
      ground: () => new PowerTool(this, { net: 'GND', style: 'gnd' }),
      port: () => new PortTool(this),
      junction: () => new MarkerTool(this, 'junction'),
      noerc: () => new MarkerTool(this, 'noerc'),
      text: () => new TextTool(this),
      rect: () => new ShapeTool(this, 'grect'),
      circle: () => new ShapeTool(this, 'gcircle'),
    };
    const make = tools[name];
    if (!make) return;
    this.setTool(make());
    this.canvas.focus();
  }

  // ---- View ----

  contentBox() {
    let b = bboxEmpty();
    for (const o of this.doc.items()) b = bboxUnion(b, schBounds(o, this.lib));
    return b;
  }

  fitAll(animate = true) {
    this.fitBox(sheetExtents(this.doc.sheet), animate);
  }

  fitContent() {
    const b = this.contentBox();
    if (b.minX <= b.maxX) this.fitBox(b); else this.fitAll();
  }

  fitSelection() {
    const objs = this.selectedObjects();
    if (!objs.length) return this.fitContent();
    this.fitBox(objs.reduce((acc, o) => bboxUnion(acc, schBounds(o, this.lib)), bboxEmpty()));
  }

  /** Zooms to and selects an object (from the messages or navigator panels). */
  focusObject(id, x, y) {
    const o = this.doc.store.get(id);
    if (o) { this.setSelection([id]); const b = schBounds(o, this.lib); this.fitBox({ minX: Math.min(b.minX, x ?? b.minX) - mil(600), minY: Math.min(b.minY, y ?? b.minY) - mil(600), maxX: Math.max(b.maxX, x ?? b.maxX) + mil(600), maxY: Math.max(b.maxY, y ?? b.maxY) + mil(600) }); }
    else if (x !== undefined) this.zoomTo(x, y, mil(2000));
  }

  onContextMenu(ev, e) {
    if (this.tool !== this.select) { this.endTool(); return; }
    const hit = this.pickAll(ev.rawX, ev.rawY)[0];
    if (hit && !this.selection.has(hit.id)) this.setSelection([hit.id]);
    const c = 'sch.';
    const items = hit ? [
      { command: 'edit.properties' },
      { separator: true },
      { command: 'edit.cut' }, { command: 'edit.copy' }, { command: 'edit.paste' }, { command: 'edit.duplicate' }, { command: 'edit.delete' },
      { separator: true },
      { command: `${c}rotate` }, { command: `${c}mirrorX` }, { command: `${c}mirrorY` },
      { separator: true },
      { label: 'Highlight net', icon: 'highlight-net', run: () => this.highlightNetAt(ev.rawX, ev.rawY) },
      hit.t === 'part' ? { label: 'Edit component in library', icon: 'library', run: () => this.app.openComponentEditor?.(hit.comp) } : null,
      hit.t === 'part' ? { label: 'Find on board', icon: 'cross-probe', run: () => this.app.crossProbePart?.(hit) } : null,
    ].filter(Boolean) : [
      { command: 'edit.paste' },
      { separator: true },
      { label: '&Place', items: [{ command: 'sch.place.part' }, { command: 'sch.place.wire' }, { command: 'sch.place.label' }, { command: 'sch.place.power' }, { command: 'sch.place.ground' }, { command: 'sch.place.port' }, { command: 'sch.place.text' }] },
      { separator: true },
      { command: 'view.fit' }, { command: 'view.fitContent' },
      { command: 'sch.sheetOptions' },
    ];
    contextMenu(e, items, 'Schematic');
  }

  dispose() {
    for (const u of this._unsub) u();
    window.removeEventListener('themechange', this._onTheme);
    for (const b of [this.sheetBatch, this.main, this.selBatch, this.hlBatch, this.overlay]) this.renderer?.release(b);
    super.dispose();
  }
}

installVertexEditing(SchEditor, (ed, b, o) => drawSchObject(b, o, ed.lib, ed.palette, pack(ed.palette.selection)));

/** Places clipboard contents; parts get fresh ids and designators. */
class PasteTool {
  constructor(editor, clip) {
    this.editor = editor;
    this.clip = clip;
    this.name = 'paste';
    this.cursor = 'crosshair';
    this.ops = [];
  }
  hint() { return 'Click to paste. Space rotates, X / Y mirror, Esc cancels'; }
  _objs(x, y) {
    let objs = this.clip.objects;
    for (const op of this.ops) objs = objs.map((o) => (op === 'rot' ? rotateSch(o, 0, 0, 90) : mirrorSch(o, 0, 0, op)));
    return objs.map((o) => translateSch(o, x, y));
  }
  click(ev) {
    const ed = this.editor;
    const sheets = ed.project.sheetObjects();
    // One pass over the project for all pasted parts; a pass per part froze
    // the app for seconds when pasting a large selection.
    const nextDes = designatorAllocator(sheets);
    const uids = new Set();
    const designators = new Set();
    for (const sh of sheets) for (const p of sh.objects) {
      if (p.t === 'part') { uids.add(p.uid); designators.add(p.designator); }
    }
    const ids = [];
    ed.doc.store.transact('Paste', (s) => {
      for (const o of this._objs(ev.x, ev.y)) {
        const n = { ...o, id: uid() };
        if (n.t === 'part') {
          // A part that was cut comes back as itself: its uid links it to the
          // component placed and routed on the board, which an update would
          // otherwise remove and add again. A copy gets its own identity.
          if (!o.uid || uids.has(o.uid)) n.uid = uid('u');
          if (n.uid !== o.uid || !o.designator || designators.has(o.designator)) {
            // The leading letters: R12 -> R, R? -> R, and U1A (unit A) -> U, not U1A.
            const prefix = /^[A-Za-z_]+/.exec(o.designator || '')?.[0] || ed.lib[o.comp]?.prefix || 'U';
            n.designator = nextDes(prefix);
          } else nextDes.reserve(n.designator);
          uids.add(n.uid);
          designators.add(n.designator);
        }
        s.add(n);
        ids.push(n.id);
      }
    });
    ed.endTool();
    ed.setSelection(ids);
  }
  key(e, combo) {
    if (combo === 'Space') { this.ops.push('rot'); return true; }
    if (combo === 'X') { this.ops.push('x'); return true; }
    if (combo === 'Y') { this.ops.push('y'); return true; }
    if (combo === 'Escape') { this.editor.endTool(); return true; }
    return false;
  }
  rightClick() { this.editor.endTool(); return true; }
  drawOverlay(b) {
    const c = this.editor.cursor;
    if (!c.inside) return;
    for (const o of this._objs(c.x, c.y)) drawSchObject(b, o, this.editor.lib, this.editor.palette, pack(this.editor.palette.preview, 0.85));
  }
}
