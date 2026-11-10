// Board tools. Every placement is one undo step.
//
// Interactive routing: click a pad, track or via to start (the trace takes
// its net), move to draw, click to fix segments. Shift+Space cycles corner
// styles, '*' switches to the next copper layer and drops a via, '3' cycles
// track widths, Backspace removes the last segment, Tab edits the width,
// Esc or right click ends the trace (press again to leave the tool). In
// "stop at first obstacle" mode the trace stops short of copper on other nets.

import { uid } from '../core/emitter.js';
import { pack } from '../render/color.js';
import { cornerPoint, polyArea, simplifyPolyline } from '../core/geom.js';
import { mm, formatLength, parseLength } from '../core/units.js';
import { copperLayers, isCopper, LAYERS } from '../model/layers.js';
import { emitPcbObject } from '../render/pcb-scene.js';
import { itemDistance } from '../model/connectivity.js';
import { promptDialog } from '../ui/dialog.js';
import { rotatePcb, flipComp } from '../model/pcb.js';

const CORNERS = ['45start', '45end', '90start', '90end', 'any'];
const CORNER_LABEL = { '45start': '45 degrees start', '45end': '45 degrees end', '90start': '90 degrees start', '90end': '90 degrees end', any: 'any angle' };

function crosshair(b, ed, x, y, color) {
  const s = 14 * ed.nmPerPx;
  const c = pack(color || ed.palette.crosshair, 0.85);
  b.line(x - s, y, x + s, y, 0, c);
  b.line(x, y - s, x, y + s, 0, c);
}

/** Draws objects as previews into the overlay. */
function preview(b, ed, objs, alpha = 0.75) {
  const sink = (l) => (l === 'holes' || ed.isLayerVisible(l) || isCopper(l) ? b : null);
  const ctx = { ...ed.previewContext(), colors: ed.layerColorsWithAlpha?.(alpha) };
  for (const o of objs) emitPcbObject(o, sink, ctx);
}

export class RouteTool {
  constructor(editor) {
    this.editor = editor;
    this.name = 'route';
    this.cursor = 'crosshair';
    this.trace = null; // { net, layer, width, pts:[x,y,...], segments:[...committed objects], vias:[] }
    this.corner = editor.app.settings.get('cornerStyle') || '45start';
    this.snapExclude = null;
    this.width = 0; // width chosen with Tab before routing (0: net class or rules)
  }

  get mode() { return this.editor.app.settings.get('routingMode'); }

  hint() {
    if (!this.trace) return 'Click a pad, track or via to start routing. Esc leaves the tool';
    const w = formatLength(this.trace.width, this.editor.units);
    return `${this.trace.net || 'No net'} on ${LAYERS[this.trace.layer].name}, ${w}. Shift+Space: ${CORNER_LABEL[this.corner]}. * changes layer, 3 cycles width, Backspace undoes`;
  }

  widths(net) {
    const rules = this.editor.doc.rules;
    const cls = this.editor.netClassOf(net);
    const set = new Set([cls?.width || rules.trackWidth, rules.trackWidth, mm(0.15), mm(0.2), mm(0.25), mm(0.3), mm(0.4), mm(0.5), mm(0.8), mm(1)]);
    return [...set].filter((w) => w >= rules.minTrackWidth).sort((a, b) => a - b);
  }

  _start(ev) {
    const ed = this.editor;
    // Tracks are copper: from a silkscreen or mechanical layer, route on that side's copper.
    if (!isCopper(ed.activeLayer)) ed.setActiveLayer(LAYERS[ed.activeLayer].side === 'bottom' ? 'bottom' : 'top');
    let hit = ed.copperAt(ev.rawX, ev.rawY, ed.activeLayer);
    if (!hit) {
      // Nothing on the current layer: a pad on another visible layer starts the trace there.
      const other = ed.copperAt(ev.rawX, ev.rawY, null);
      if (other?.isPad && ed.isLayerVisible(other.layers[0])) hit = other;
    }
    let x = ev.x, y = ev.y, net = '';
    if (hit) {
      net = hit.net || '';
      if (hit.anchor) [x, y] = hit.anchor;
      // Starting on a single-layer pad switches to its layer.
      if (hit.layers?.length === 1 && isCopper(hit.layers[0]) && hit.layers[0] !== ed.activeLayer) ed.setActiveLayer(hit.layers[0]);
    }
    const cls = ed.netClassOf(net);
    this.trace = { net, layer: ed.activeLayer, width: this.width || cls?.width || ed.doc.rules.trackWidth, pts: [x, y], start: hit, placed: [] };
    ed.setRouteNet?.(net);
    ed.updateHint();
  }

  _path(x, y) {
    const t = this.trace;
    const n = t.pts.length;
    const ax = t.pts[n - 2], ay = t.pts[n - 1];
    const c = cornerPoint(ax, ay, x, y, this.corner);
    const pts = c ? [ax, ay, c[0], c[1], x, y] : [ax, ay, x, y];
    // A trace without a net has no other nets to keep clear of yet: it joins
    // the copper it touches and takes the net of the copper it lands on.
    if (this.mode !== 'stop' || !t.net) return pts;
    return this._clip(pts);
  }

  /** Shortens a proposed path at the first clearance conflict. */
  _clip(pts) {
    const ed = this.editor, t = this.trace;
    const clearance = Math.max(ed.doc.rules.clearance, ed.netClassOf(t.net)?.clearance || 0);
    const r = t.width / 2;
    const obstacles = ed.obstaclesNear(pts, t.layer, t.net, r + clearance);
    if (!obstacles.length) return pts;
    const blocked = (x1, y1, x2, y2) => {
      const seg = { kind: 'seg', x1, y1, x2, y2, r: r + clearance - 1, layers: [t.layer] };
      for (const o of obstacles) if (itemDistance(seg, o) < 0) return true;
      return false;
    };
    const out = [pts[0], pts[1]];
    for (let i = 2; i < pts.length; i += 2) {
      const ax = out[out.length - 2], ay = out[out.length - 1], bx = pts[i], by = pts[i + 1];
      if (!blocked(ax, ay, bx, by)) { out.push(bx, by); continue; }
      // Binary search the longest clear prefix of this segment.
      let lo = 0, hi = 1;
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) / 2;
        if (blocked(ax, ay, ax + (bx - ax) * mid, ay + (by - ay) * mid)) hi = mid; else lo = mid;
      }
      if (lo > 1e-3) out.push(Math.round(ax + (bx - ax) * lo), Math.round(ay + (by - ay) * lo));
      break;
    }
    return out;
  }

  click(ev) {
    if (!this.trace) { this._start(ev); return; }
    const t = this.trace;
    const path = this._path(ev.x, ev.y);
    if (path.length <= 2) return;
    this._commitPath(path);
    const ex = path[path.length - 2], ey = path[path.length - 1];
    // Finish when the trace lands on copper of the same net (or any net when unnetted).
    const hit = this.editor.copperAt(ex, ey, t.layer, true, new Set(t.placed));
    const samePad = hit?.anchor?.[0] === t.start?.anchor?.[0] && hit?.anchor?.[1] === t.start?.anchor?.[1];
    const onStart = hit && t.start && hit.objId === t.start.objId && (!hit.isPad || samePad);
    if (hit && !onStart && (!t.net || !hit.net || hit.net === t.net)) {
      if (!t.net && hit.net) this._assignNet(hit.net);
      this.finish();
    }
  }

  _commitPath(path) {
    const t = this.trace;
    const ed = this.editor;
    const segs = [];
    for (let i = 2; i < path.length; i += 2) {
      if (path[i - 2] === path[i] && path[i - 1] === path[i + 1]) continue;
      segs.push({ id: uid(), t: 'track', layer: t.layer, x1: path[i - 2], y1: path[i - 1], x2: path[i], y2: path[i + 1], w: t.width, net: t.net || undefined });
    }
    if (!segs.length) return;
    ed.doc.store.transact('Route', (s) => { for (const o of segs) s.add(o); }, { mergeKey: `route:${t.id || (t.id = uid())}` });
    t.placed.push(...segs.map((o) => o.id));
    t.pts = [path[path.length - 2], path[path.length - 1]];
  }

  _assignNet(net) {
    const t = this.trace;
    t.net = net;
    this.editor.doc.store.transact('Route', (s) => { for (const id of t.placed) if (s.get(id)) s.update(id, { net }); }, { mergeKey: `route:${t.id}` });
  }

  finish() {
    this.trace = null;
    this.editor.setRouteNet?.(null);
    this.editor.updateHint();
  }

  dblclick() { if (this.trace) this.finish(); }
  rightClick() { if (this.trace) this.finish(); else this.editor.endTool(); return true; }

  /** Undo removed the trace's segments: continuing would leave a gap, so end it. */
  historyChanged() { if (this.trace) this.finish(); }

  _switchLayer(dir = 1) {
    const ed = this.editor;
    const layers = copperLayers(ed.doc.board.copper);
    const t = this.trace;
    const cur = layers.indexOf(t ? t.layer : ed.activeLayer);
    const next = layers[(cur + dir + layers.length) % layers.length];
    if (t) {
      const [x, y] = t.pts.slice(-2);
      const cls = ed.netClassOf(t.net);
      const via = { id: uid(), t: 'via', x, y, d: cls?.viaDiameter || ed.doc.rules.viaDiameter, drill: cls?.viaDrill || ed.doc.rules.viaDrill, from: layers[0], to: layers[layers.length - 1], net: t.net || undefined };
      ed.doc.store.transact('Route', (s) => s.add(via), { mergeKey: `route:${t.id || (t.id = uid())}` });
      t.placed.push(via.id);
      (t.viaFrom ||= new Map()).set(via.id, t.layer);
      t.layer = next;
    }
    ed.setActiveLayer(next);
    ed.updateHint();
  }

  async _editWidth() {
    const t = this.trace;
    const ed = this.editor;
    const v = await promptDialog({ title: 'Track width', label: `Width (${ed.units})`, value: formatLength(t ? t.width : ed.doc.rules.trackWidth, ed.units, { suffix: false }), validate: (s) => { const n = parseLength(s, ed.units); return n && n > 0 ? null : 'Enter a positive width'; } });
    // Before a trace starts, the width applies to the traces drawn next.
    if (v) { if (t) t.width = parseLength(v, ed.units); else this.width = parseLength(v, ed.units); }
    ed.updateHint();
    ed.canvas.focus();
  }

  key(e, combo) {
    const ed = this.editor;
    if (combo === 'Shift+Space') {
      this.corner = CORNERS[(CORNERS.indexOf(this.corner) + 1) % CORNERS.length];
      ed.app.settings.set('cornerStyle', this.corner);
      ed.updateHint();
      return true;
    }
    if (combo === '*' || combo === 'Num*' || combo === 'Mod+Shift+ArrowUp') { this._switchLayer(1); return true; }
    if (combo === 'Mod+Shift+ArrowDown') { this._switchLayer(-1); return true; }
    if (combo === '3' && this.trace) {
      const list = this.widths(this.trace.net);
      const i = list.findIndex((w) => w > this.trace.width);
      this.trace.width = list[i < 0 ? 0 : i];
      ed.updateHint();
      return true;
    }
    if (combo === 'Tab') { this._editWidth(); return true; }
    if (combo === 'Backspace' && this.trace) {
      const t = this.trace;
      const last = t.placed.pop();
      if (last) {
        const o = ed.doc.store.get(last);
        ed.doc.store.transact('Route', (s) => s.remove(last), { mergeKey: `route:${t.id}` });
        if (o?.t === 'track') t.pts = [o.x1, o.y1];
        else if (o?.t === 'via') {
          // Removing the via returns the trace to the layer it came from.
          t.layer = t.viaFrom?.get(last) || t.layer;
          ed.setActiveLayer(t.layer);
        }
      } else this.finish();
      ed.updateHint();
      return true;
    }
    if (combo === 'Escape') { if (this.trace) this.finish(); else ed.endTool(); return true; }
    if (combo === 'Shift+R') {
      ed.app.settings.set('routingMode', this.mode === 'stop' ? 'ignore' : 'stop');
      ed.app.toast(this.mode === 'stop' ? 'Routing stops at the first obstacle' : 'Routing ignores obstacles', { timeout: 2000 });
      return true;
    }
    return false;
  }

  deactivate() { this.finish(); }

  drawOverlay(b) {
    const ed = this.editor;
    const c = ed.cursor;
    if (this.trace) {
      const t = this.trace;
      const path = this._path(c.x, c.y);
      const col = pack(ed.layerColor(t.layer));
      for (let i = 2; i < path.length; i += 2) b.line(path[i - 2], path[i - 1], path[i], path[i + 1], t.width, col);
      // Clearance outline around the active segment.
      const cl = Math.max(ed.doc.rules.clearance, ed.netClassOf(t.net)?.clearance || 0);
      const ghost = pack(ed.palette.preview, 0.25);
      for (let i = 2; i < path.length; i += 2) b.line(path[i - 2], path[i - 1], path[i], path[i + 1], t.width + cl * 2, ghost);
    }
    if (c.inside) crosshair(b, ed, c.x, c.y);
    if (c.inside && c.target) b.ring(c.x, c.y, 8 * ed.nmPerPx, 0, pack(ed.palette.highlight));
  }
}

/** Places copies of one object (vias, pads, components, text). */
export class PlacePcbTool {
  constructor(editor, { name, hint, template, onPlaced, edit, repeat = true }) {
    this.editor = editor;
    this.name = name;
    this.cursor = 'crosshair';
    this._hint = hint;
    this.template = template;
    this.onPlaced = onPlaced;
    this.edit = edit;
    this.repeat = repeat;
  }
  hint() { return this._hint; }
  objAt(x, y) {
    const t = this.template;
    if (t.t === 'track' || t.t === 'dim') return { ...t, x1: t.x1 + x, y1: t.y1 + y, x2: t.x2 + x, y2: t.y2 + y };
    return { ...t, x, y };
  }
  click(ev) {
    const ed = this.editor;
    let obj = { ...this.objAt(ev.x, ev.y), id: uid() };
    if (obj.t === 'via' && !obj.net) {
      const hit = ed.copperAt(ev.x, ev.y, null, true);
      if (hit?.net) obj.net = hit.net;
    }
    ed.doc.store.transact(`Place ${this.name}`, (s) => s.add(obj));
    this.onPlaced?.(obj, this);
    if (!this.repeat) ed.endTool();
  }
  key(e, combo) {
    if (combo === 'Space') { this.template = rotatePcb(this.template, this.template.x || 0, this.template.y || 0, 90); return true; }
    if (combo === 'L' && this.template.t === 'comp') { this.template = flipComp(this.template); return true; }
    if (combo === 'Tab' && this.edit) { this.edit(this); return true; }
    if (combo === 'Escape') { this.editor.endTool(); return true; }
    return false;
  }
  rightClick() { this.editor.endTool(); return true; }
  drawOverlay(b) {
    const ed = this.editor, c = ed.cursor;
    if (!c.inside) return;
    preview(b, ed, [this.objAt(c.x, c.y)]);
    crosshair(b, ed, c.x, c.y);
  }
}

/**
 * Polygon tools: pours, regions, keep-outs and the board outline. Click to
 * add vertices (edges follow the corner style), double click, right click or
 * Enter closes the shape, Backspace removes the last vertex.
 */
export class PolygonTool {
  constructor(editor, { kind, layer, net = '', onDone }) {
    this.editor = editor;
    this.kind = kind; // 'pour' | 'region' | 'keepout' | 'board' | 'cutout'
    this.layer = layer;
    this.net = net;
    this.name = { pour: 'polygon pour', region: 'region', keepout: 'keep-out', board: 'board shape', cutout: 'board cutout' }[kind];
    this.cursor = 'crosshair';
    this.pts = [];
    this.corner = '90start';
    this.onDone = onDone;
  }
  hint() {
    return this.pts.length
      ? `Click to add corners, double click or Enter to close. Shift+Space: ${CORNER_LABEL[this.corner]}. Backspace undoes`
      : `Click to start the ${this.name} outline`;
  }
  _path(x, y) {
    if (!this.pts.length) return [];
    const n = this.pts.length;
    const c = cornerPoint(this.pts[n - 2], this.pts[n - 1], x, y, this.corner);
    return c ? [...this.pts, c[0], c[1], x, y] : [...this.pts, x, y];
  }
  click(ev) {
    if (this.pts.length >= 6 && Math.hypot(ev.x - this.pts[0], ev.y - this.pts[1]) < 6 * this.editor.nmPerPx) { this.close(); return; }
    this.pts = this.pts.length ? this._path(ev.x, ev.y) : [ev.x, ev.y];
    this.editor.updateHint();
  }
  dblclick() { this.close(); }
  rightClick() { if (this.pts.length >= 6) this.close(); else if (this.pts.length) { this.pts = []; this.editor.updateHint(); } else this.editor.endTool(); return true; }
  close() {
    let pts = simplifyPolyline(this.pts);
    // Drop a closing vertex equal to the first.
    if (pts.length >= 4 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts = pts.slice(0, -2);
    this.pts = [];
    this.editor.updateHint();
    if (pts.length < 6 || Math.abs(polyArea(pts)) < 1) return;
    if (polyArea(pts) < 0) {
      // Store counter-clockwise.
      const r = [];
      for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]);
      pts = r;
    }
    this.onDone(pts, this);
  }
  key(e, combo) {
    if (combo === 'Shift+Space') { this.corner = CORNERS[(CORNERS.indexOf(this.corner) + 1) % CORNERS.length]; this.editor.updateHint(); return true; }
    if (combo === 'Backspace') { this.pts = this.pts.slice(0, -2); this.editor.updateHint(); return true; }
    if (combo === 'Enter') { this.close(); return true; }
    if (combo === 'Escape') { if (this.pts.length) { this.pts = []; this.editor.updateHint(); } else this.editor.endTool(); return true; }
    return false;
  }
  drawOverlay(b) {
    const ed = this.editor, c = ed.cursor;
    const col = pack(this.kind === 'board' || this.kind === 'cutout' ? ed.palette.boardEdge : ed.layerColor(this.layer));
    if (this.pts.length) {
      const path = this._path(c.x, c.y);
      if (path.length >= 6) b.poly([path], pack(this.kind === 'board' ? ed.palette.boardEdge : ed.layerColor(this.layer), 0.18));
      b.polyline(path, 0, col);
      b.line(path[path.length - 2], path[path.length - 1], path[0], path[1], 0, pack(ed.palette.preview, 0.5));
      for (let i = 0; i < this.pts.length; i += 2) b.rect(this.pts[i], this.pts[i + 1], 6 * ed.nmPerPx, 6 * ed.nmPerPx, 0, 0, col);
    }
    if (c.inside) crosshair(b, ed, c.x, c.y);
  }
}

/** Lines on any layer (silkscreen, mechanical, unnetted copper) and fills. */
export class LineTool {
  constructor(editor, { kind = 'line' } = {}) {
    this.editor = editor;
    this.kind = kind; // 'line' | 'fill' | 'dim' | 'measure'
    this.name = { line: 'line', fill: 'fill', dim: 'dimension', measure: 'measure' }[kind];
    this.cursor = 'crosshair';
    this.start = null;
    this.noSnap = false;
  }
  hint() {
    if (this.kind === 'measure') return this.start ? 'Click the second point. Esc clears' : 'Click the first point to measure from';
    return this.start ? 'Click to finish' : `Click to start the ${this.name} on ${LAYERS[this.layer()].name}`;
  }
  layer() {
    const ed = this.editor;
    if (this.kind === 'dim') return ed.isCopper(ed.activeLayer) ? 'mech1' : ed.activeLayer;
    return ed.activeLayer;
  }
  _obj(x, y) {
    const s = this.start, ed = this.editor, layer = this.layer();
    if (this.kind === 'fill') return { t: 'fill', layer, x1: Math.min(s.x, x), y1: Math.min(s.y, y), x2: Math.max(s.x, x), y2: Math.max(s.y, y) };
    if (this.kind === 'dim') return { t: 'dim', layer, x1: s.x, y1: s.y, x2: x, y2: y, offset: mm(2), h: mm(1.2) };
    const w = isCopper(layer) ? ed.doc.rules.trackWidth : layer.endsWith('Overlay') ? ed.doc.rules.silkWidth : mm(0.1);
    return { t: 'track', layer, x1: s.x, y1: s.y, x2: x, y2: y, w };
  }
  click(ev) {
    if (!this.start) { this.start = { x: ev.x, y: ev.y }; this.editor.updateHint(); return; }
    if (this.kind === 'measure') {
      const d = Math.hypot(ev.x - this.start.x, ev.y - this.start.y);
      const ed = this.editor;
      ed.app.toast(`Distance ${formatLength(d, ed.units)} (dx ${formatLength(Math.abs(ev.x - this.start.x), ed.units)}, dy ${formatLength(Math.abs(ev.y - this.start.y), ed.units)})`, { title: 'Measure', timeout: 6000 });
      this.start = null;
      return;
    }
    const o = this._obj(ev.x, ev.y);
    if ((o.t === 'track' || o.t === 'dim') && o.x1 === o.x2 && o.y1 === o.y2) return;
    if (o.t === 'fill' && (o.x1 === o.x2 || o.y1 === o.y2)) return;
    this.editor.doc.store.transact(`Place ${this.name}`, (s) => s.add({ ...o, id: uid() }));
    // Lines chain: the next one starts where this one ended.
    this.start = this.kind === 'line' ? { x: ev.x, y: ev.y } : null;
    this.editor.updateHint();
  }
  dblclick() { this.start = null; this.editor.updateHint(); }
  rightClick() { if (this.start) { this.start = null; this.editor.updateHint(); } else this.editor.endTool(); return true; }
  key(e, combo) {
    if (combo === 'Escape') { if (this.start) { this.start = null; this.editor.updateHint(); } else this.editor.endTool(); return true; }
    return false;
  }
  drawOverlay(b) {
    const ed = this.editor, c = ed.cursor;
    if (this.start) {
      if (this.kind === 'measure') {
        const col = pack(ed.palette.highlight);
        b.line(this.start.x, this.start.y, c.x, c.y, 0, col);
        b.ring(this.start.x, this.start.y, 4 * ed.nmPerPx, 0, col);
        const d = Math.hypot(c.x - this.start.x, c.y - this.start.y);
        b.text(formatLength(d, ed.units), (this.start.x + c.x) / 2, (this.start.y + c.y) / 2 + 6 * ed.nmPerPx, 12 * ed.nmPerPx, col, { align: { h: 'center', v: 'bottom' } });
      } else preview(b, ed, [this._obj(c.x, c.y)]);
    }
    if (c.inside) crosshair(b, ed, c.x, c.y);
  }
}

export { crosshair, preview };
