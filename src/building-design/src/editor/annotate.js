/**
 * Annotation tools: angular and radial dimensions, spot elevations,
 * coordinates and slopes, insulation, detail items, detail arcs and
 * circles, symbols and colour fill legends. They draw into the active view
 * (plans, elevations, sections, and drafting views where it makes sense).
 */
import { Tool, isNumericStart } from './tool.js';
import { sub, norm, dist, angleOf, lineIntersect, circleFrom3 } from '../core/geom.js';
import { DETAIL_FAMILIES, radialTarget } from '../core/annotate.js';
import { previewGraphics, ANNOTATION_VIEWS } from './draw.js';
import { strokeModel, drawTag } from '../views/overlay.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { formatAngle } from '../core/units.js';
import { PLAN_VIEW_KINDS } from '../core/doc.js';
import { LINE_STYLES } from '../core/props.js';

function select(label, options, value, onChange) {
  const s = h('select.input.sm', { 'aria-label': label }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return h('div.ob-group', h('label', label), s);
}

function seg(items, current, onPick, label) {
  return h(
    'div.seg',
    { role: 'radiogroup', 'aria-label': label },
    ...items.map((it) => h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(it.value === current), 'data-tip': it.label, onClick: () => onPick(it.value) }, it.icon ? icon(it.icon, 15) : null, h('span', it.label))),
  );
}

/** Base for annotation tools: preview a candidate element under the cursor. */
class AnnotationTool extends Tool {
  get viewKinds() {
    return ANNOTATION_VIEWS;
  }

  preview(ctx, vc, vp, el) {
    if (el) previewGraphics(this.app, vc, { id: 'preview', viewId: vc.view.id, ...el }, ctx, vp.theme.preview, 0.1);
  }

  place(label, el) {
    let added = null;
    this.app.commit(label, () => (added = this.doc.add({ viewId: this.vc.view.id, ...el })));
    return added;
  }
}

// Angular dimensions ------------------------------------------------------------------------

export class AngularDimTool extends AnnotationTool {
  get title() {
    return 'Angular Dimension';
  }

  get prompt() {
    if (!this.first) return 'Click the first line (a wall, line, grid or edge)';
    if (!this.second) return 'Click the second line';
    return 'Click to place the arc';
  }

  pickLine(ev) {
    this.snap(ev, null, { allowFree: false });
    const r = this.snapRes;
    return r?.ref?.line || r?.line || null;
  }

  /** Sector between the two lines that contains the cursor. */
  geometry(cursor) {
    const A = this.first;
    const B = this.second;
    const hit = lineIntersect(A.a, sub(A.b, A.a), B.a, sub(B.b, B.a));
    if (!hit) return null;
    const c = hit.point;
    const r = Math.max(10, dist(c, cursor));
    const ac = angleOf(sub(cursor, c));
    const da = angleOf(sub(A.b, A.a));
    const db = angleOf(sub(B.b, B.a));
    let best = null;
    for (const a0 of [da, da + Math.PI])
      for (const a1 of [db, db + Math.PI]) {
        // Order the pair counterclockwise with a sweep under 180 degrees.
        let s = norm2pi(a1 - a0);
        let start = a0;
        let end = a1;
        if (s > Math.PI) {
          start = a1;
          end = a0;
          s = norm2pi(end - start);
        }
        if (norm2pi(ac - start) <= s + 1e-9) best = { c, r, a0: start, a1: start + s };
      }
    return best;
  }

  down(ev) {
    if (!this.first || !this.second) {
      const line = this.pickLine(ev);
      if (!line) return this.app.setPrompt('Click on a line or edge');
      if (!this.first) this.first = line;
      else {
        const d1 = norm(sub(this.first.b, this.first.a));
        const d2 = norm(sub(line.b, line.a));
        if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) < 1e-3) return this.app.toast('The lines are parallel. Pick a line at an angle to the first.', { kind: 'error' });
        this.second = line;
      }
      this.app.setPrompt(this.prompt);
      return;
    }
    const g = ev.p && this.geometry(ev.p);
    if (!g) return;
    this.place('Angular dimension', { kind: 'angularDim', ...g });
    this.first = this.second = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = ev.p;
    if (!this.second) this.pickLine(ev);
    this.app.requestRender();
  }

  cancel() {
    if (this.first) {
      this.first = this.second = null;
      this.app.setPrompt(this.prompt);
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    for (const l of [this.first, this.second]) if (l) strokeModel(ctx, [l.a, l.b], S, vp.theme.preview, 2.5);
    if (this.second && this.cursor) this.preview(ctx, vc, vp, (() => { const g = this.geometry(this.cursor); return g && { kind: 'angularDim', ...g }; })());
    else {
      const line = this.snapRes?.ref?.line || this.snapRes?.line;
      if (line) strokeModel(ctx, [line.a, line.b], S, vp.theme.preview, 2, [5, 3]);
    }
  }
}

function norm2pi(a) {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

// Radial and diameter dimensions ---------------------------------------------------------------

export class RadialDimTool extends AnnotationTool {
  get title() {
    return this.opts.diameter ? 'Diameter Dimension' : 'Radial Dimension';
  }

  get prompt() {
    return this.target ? 'Click to place the dimension' : 'Click a circle, an arc or a round column';
  }

  findTarget(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y, 8)) {
      const el = this.doc.get(id);
      if (el?.kind === 'detailArc' && el.viewId === this.vc.view.id) return el;
      if (el?.kind === 'column' && this.doc.get(el.typeId)?.shape === 'round') return el;
    }
    return null;
  }

  make(p) {
    const t = this.target;
    const { c, r } = radialTarget(this.doc, { targetId: t.id });
    return { kind: 'radialDim', targetId: t.id, c, r, angle: angleOf(sub(p, c)), diameter: !!this.opts.diameter };
  }

  down(ev) {
    if (!ev.p) return;
    if (!this.target) {
      this.target = this.findTarget(ev);
      if (!this.target) return this.app.setPrompt('That is not a circle, arc or round column');
      this.app.setPrompt(this.prompt);
      return;
    }
    this.place(this.title, this.make(ev.p));
    this.target = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = ev.p;
    if (!this.target) this.app.setHover(this.findTarget(ev)?.id ?? null);
    this.app.requestRender();
  }

  cancel() {
    if (this.target) {
      this.target = null;
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.target && this.cursor) this.preview(ctx, vc, vp, this.make(this.cursor));
  }
}

// Spot dimensions -------------------------------------------------------------------------------

export class SpotTool extends AnnotationTool {
  get title() {
    return { elevation: 'Spot Elevation', coordinate: 'Spot Coordinate', slope: 'Spot Slope' }[this.opts.mode];
  }

  get viewKinds() {
    if (this.opts.mode === 'coordinate' || this.opts.mode === 'slope') return PLAN_VIEW_KINDS;
    return ANNOTATION_VIEWS;
  }

  get prompt() {
    if (this.opts.mode === 'slope') return 'Click a roof to show its slope';
    return this.at ? 'Click where the label goes' : 'Click the point to measure';
  }

  down(ev) {
    const p = this.snap(ev, this.at);
    if (!p) return;
    if (this.opts.mode === 'slope') {
      this.place('Spot slope', { kind: 'spot', mode: 'slope', at: p });
      return;
    }
    if (!this.at) {
      this.at = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    this.place(this.title, { kind: 'spot', mode: this.opts.mode, at: this.at, leader: p });
    this.at = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.at);
    this.app.requestRender();
  }

  cancel() {
    if (this.at) {
      this.at = null;
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) {
      if (this.opts.mode === 'slope') this.preview(ctx, vc, vp, { kind: 'spot', mode: 'slope', at: this.cursor });
      else if (this.at) this.preview(ctx, vc, vp, { kind: 'spot', mode: this.opts.mode, at: this.at, leader: this.cursor });
      else this.preview(ctx, vc, vp, { kind: 'spot', mode: this.opts.mode, at: this.cursor });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Insulation -------------------------------------------------------------------------------------

export class InsulationTool extends AnnotationTool {
  get title() {
    return 'Insulation';
  }

  get prompt() {
    return this.start ? 'Click the end of the insulation' : 'Click the start of the insulation (its centre line)';
  }

  get o() {
    return this.app.toolOptions('insulation', { width: this.doc.units.system === 'imperial' ? 152.4 : 150 });
  }

  options() {
    const o = this.o;
    const input = h('input.input.sm.num', { type: 'text', value: this.fmt(o.width), 'aria-label': 'Width' });
    input.addEventListener('change', () => {
      const v = this.parseLen(input.value);
      if (Number.isFinite(v) && v > 0) o.width = v;
      input.value = this.fmt(o.width);
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    return [h('div.ob-group', h('label', 'Width'), input)];
  }

  down(ev) {
    const p = this.snap(ev, this.start);
    if (!p) return;
    if (!this.start) {
      this.start = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (dist(p, this.start) < 10) return;
    this.place('Insulation', { kind: 'insulation', a: this.start, b: p, width: this.o.width });
    this.start = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.start);
    this.app.requestRender();
  }

  cancel() {
    if (this.start) {
      this.start = null;
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.start && this.cursor && dist(this.start, this.cursor) > 10) this.preview(ctx, vc, vp, { kind: 'insulation', a: this.start, b: this.cursor, width: this.o.width });
    this.drawSnap(ctx, vc, vp);
  }
}

// Detail items -----------------------------------------------------------------------------------

export class DetailItemTool extends AnnotationTool {
  get title() {
    return 'Detail Component';
  }

  get prompt() {
    return 'Click to place. Space rotates by 90 degrees.';
  }

  get o() {
    return this.app.toolOptions('detailItem', { family: 'blocking', rotation: 0 });
  }

  options() {
    const o = this.o;
    return [select('Component', DETAIL_FAMILIES, o.family, (v) => ((o.family = v), this.app.requestRender()))];
  }

  make(p) {
    const f = DETAIL_FAMILIES.find((x) => x.value === this.o.family) || DETAIL_FAMILIES[0];
    const imp = this.doc.units.system === 'imperial';
    // Nominal sizes are metric; imperial projects round them to the nearest eighth of an inch.
    const k = (v) => (imp ? Math.round(v / 3.175) * 3.175 : v);
    return { kind: 'detailItem', family: f.value, at: p, rotation: this.o.rotation, w: k(f.w), h: k(f.h) };
  }

  down(ev) {
    const p = this.snap(ev);
    if (p) this.place(this.title, this.make(p));
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.o.rotation = (this.o.rotation + 90) % 360;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) this.preview(ctx, vc, vp, this.make(this.cursor));
    this.drawSnap(ctx, vc, vp);
  }
}

// Detail arcs and circles ------------------------------------------------------------------------

export class ArcTool extends AnnotationTool {
  get title() {
    return 'Detail Arcs';
  }

  get o() {
    return this.app.toolOptions('detailArc', { mode: 'circle', style: 'medium' });
  }

  get prompt() {
    const n = this.pts.length;
    if (this.o.mode === 'circle') return n ? 'Click to set the radius (or type it)' : 'Click the centre of the circle';
    if (this.o.mode === 'center') return ['Click the centre of the arc', 'Click the start of the arc', 'Click the end of the arc'][n];
    return ['Click the start of the arc', 'Click the end of the arc', 'Click a point on the arc'][n];
  }

  start() {
    this.pts = [];
  }

  options() {
    const o = this.o;
    return [
      seg(
        [
          { value: 'circle', label: 'Circle', icon: 'circle' },
          { value: 'center', label: 'Centre-ends arc', icon: 'arc' },
          { value: 'three', label: 'Three-point arc', icon: 'arc' },
        ],
        o.mode,
        (v) => {
          o.mode = v;
          this.pts = [];
          this.app.renderOptions();
          this.app.setPrompt(this.prompt);
        },
        'Arc type',
      ),
      select('Style', LINE_STYLES, o.style, (v) => (o.style = v)),
    ];
  }

  /** The arc defined by the clicked points plus the cursor. */
  make(cursor) {
    const pts = [...this.pts, cursor].filter(Boolean);
    const style = this.o.style;
    if (this.o.mode === 'circle') {
      if (pts.length < 2) return null;
      return { kind: 'detailArc', c: pts[0], r: Math.max(1, dist(pts[0], pts[1])), a0: 0, a1: Math.PI * 2, style };
    }
    if (this.o.mode === 'center') {
      if (pts.length < 3) return null;
      const [c, s, e] = pts;
      const r = dist(c, s);
      const a0 = angleOf(sub(s, c));
      let a1 = angleOf(sub(e, c));
      while (a1 <= a0) a1 += Math.PI * 2;
      return { kind: 'detailArc', c, r, a0, a1, style };
    }
    if (pts.length < 3) return null;
    const [s, e, m] = pts;
    const circ = circleFrom3(s, m, e);
    if (!circ) return null;
    let a0 = angleOf(sub(s, circ.c));
    let a1 = angleOf(sub(e, circ.c));
    const am = angleOf(sub(m, circ.c));
    // Choose the direction that passes through the middle point.
    const ccw = norm2pi(am - a0) < norm2pi(a1 - a0);
    if (!ccw) [a0, a1] = [a1, a0];
    while (a1 <= a0) a1 += Math.PI * 2;
    return { kind: 'detailArc', c: circ.c, r: circ.r, a0, a1, style };
  }

  get needed() {
    return this.o.mode === 'circle' ? 2 : 3;
  }

  down(ev) {
    const p = this.snap(ev, this.pts[0] || null);
    if (!p) return;
    this.pts.push(p);
    if (this.pts.length >= this.needed) {
      const el = this.make(null);
      if (el) this.place(this.title, el);
      this.pts = [];
    }
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.pts[0] || null);
    this.app.requestRender();
  }

  key(e) {
    if (this.o.mode === 'circle' && this.pts.length === 1 && isNumericStart(e)) {
      e.preventDefault();
      const s = this.vc.modelToScreen(this.pts[0]);
      const input = this.openInput(s.x, s.y, {
        label: 'Radius',
        onSubmit: (v) => {
          const r = this.parseLen(v);
          if (!Number.isFinite(r) || r <= 0) return false;
          this.place(this.title, { kind: 'detailArc', c: this.pts[0], r, a0: 0, a1: Math.PI * 2, style: this.o.style });
          this.pts = [];
          return true;
        },
      });
      input.value = e.key;
      return true;
    }
    return false;
  }

  cancel() {
    if (this.pts.length) {
      this.pts = [];
      this.app.setPrompt(this.prompt);
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    const el = this.cursor ? this.make(this.cursor) : null;
    if (el) this.preview(ctx, vc, vp, el);
    else if (this.pts.length && this.cursor) strokeModel(ctx, [this.pts.at(-1), this.cursor], S, vp.theme.preview, 1.2, [5, 4]);
    if (el && this.o.mode === 'circle') {
      const s = S(this.cursor);
      drawTag(ctx, s.x + 30, s.y + 18, `R ${this.fmt(el.r)}`, { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Symbols ----------------------------------------------------------------------------------------

export const SYMBOL_FAMILIES = [
  { value: 'north', label: 'North Arrow' },
  { value: 'scale', label: 'Graphic Scale' },
  { value: 'span', label: 'Span Direction' },
];

export class SymbolTool extends AnnotationTool {
  get title() {
    return SYMBOL_FAMILIES.find((f) => f.value === this.family)?.label || 'Symbol';
  }

  get family() {
    return this.opts.family || this.app.toolOptions('symbol', { family: 'north' }).family;
  }

  get viewKinds() {
    return this.family === 'span' ? PLAN_VIEW_KINDS : ANNOTATION_VIEWS;
  }

  get prompt() {
    if (this.family === 'scale') return 'Click to place the graphic scale';
    return this.at ? 'Click to set the direction' : 'Click to place the symbol';
  }

  options() {
    if (this.opts.family) return null;
    const o = this.app.toolOptions('symbol', { family: 'north' });
    return [select('Symbol', SYMBOL_FAMILIES, o.family, (v) => ((o.family = v), (this.at = null), this.app.setPrompt(this.prompt)))];
  }

  rotationTo(p) {
    const a = angleOf(sub(p, this.at));
    // North arrows point along their own +y; span arrows along +x.
    const deg = ((this.family === 'north' ? a - Math.PI / 2 : a) * 180) / Math.PI;
    return Math.round(deg / 5) * 5;
  }

  down(ev) {
    const p = this.snap(ev, this.at);
    if (!p) return;
    if (this.family === 'scale') {
      this.place(this.title, { kind: 'symbol', family: 'scale', at: p, rotation: 0 });
      return;
    }
    if (!this.at) {
      this.at = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (dist(p, this.at) < 1) return;
    this.place(this.title, { kind: 'symbol', family: this.family, at: this.at, rotation: this.rotationTo(p) });
    this.at = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.at);
    this.app.requestRender();
  }

  cancel() {
    if (this.at) {
      this.at = null;
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) {
      if (this.at && dist(this.cursor, this.at) > 1) {
        this.preview(ctx, vc, vp, { kind: 'symbol', family: this.family, at: this.at, rotation: this.rotationTo(this.cursor) });
        const s = vc.modelToScreen(this.cursor);
        const a = angleOf(sub(this.cursor, this.at));
        drawTag(ctx, s.x + 26, s.y + 18, formatAngle(a < 0 ? a + Math.PI * 2 : a, 0), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
      } else if (!this.at) this.preview(ctx, vc, vp, { kind: 'symbol', family: this.family, at: this.cursor, rotation: 0 });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Colour fill legend -------------------------------------------------------------------------

export class LegendTool extends AnnotationTool {
  get title() {
    return 'Color Fill Legend';
  }

  get viewKinds() {
    return ['plan'];
  }

  get prompt() {
    return 'Click to place the legend. It lists the room colors of this plan.';
  }

  options() {
    const view = this.vc?.view;
    if (!view) return null;
    return [
      select('Color rooms by', ROOM_FILL_BY, view.roomFillBy || 'name', (v) => this.app.commit('Color scheme', () => this.doc.update(view.id, { roomFillBy: v, roomFill: true }))),
    ];
  }

  down(ev) {
    if (!ev.p) return;
    const view = this.vc.view;
    this.app.commit('Color fill legend', () => {
      if (!view.roomFill) this.doc.update(view.id, { roomFill: true });
      this.doc.add({ kind: 'colorLegend', viewId: view.id, at: ev.p });
    });
    this.app.cancelTool();
  }

  move(ev) {
    this.cursor = ev.p;
    this.app.requestRender();
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) this.preview(ctx, vc, vp, { kind: 'colorLegend', at: this.cursor });
  }
}

// Legend components ----------------------------------------------------------------------------

const LEGEND_TYPE_KINDS = [
  ['wallType', 'Walls'],
  ['floorType', 'Floors'],
  ['roofType', 'Roofs'],
  ['ceilingType', 'Ceilings'],
  ['doorType', 'Doors'],
  ['windowType', 'Windows'],
  ['columnType', 'Columns'],
  ['componentType', 'Components'],
];

export class LegendComponentTool extends AnnotationTool {
  get title() {
    return 'Legend Component';
  }

  get viewKinds() {
    return ['legend'];
  }

  get prompt() {
    return 'Click to place the type. Pick another type in the options bar.';
  }

  get o() {
    const o = this.app.toolOptions('legendComponent', { typeId: null });
    if (!this.doc.get(o.typeId)) o.typeId = this.doc.all('wallType')[0]?.id ?? null;
    return o;
  }

  options() {
    const o = this.o;
    const s = h('select.input.sm', { 'aria-label': 'Type' });
    for (const [kind, label] of LEGEND_TYPE_KINDS) {
      const types = this.doc.all(kind);
      if (!types.length) continue;
      s.append(h('optgroup', { label }, ...types.map((t) => h('option', { value: t.id }, t.familyName && kind !== 'wallType' ? `${t.familyName}: ${t.name}` : t.name))));
    }
    s.value = o.typeId || '';
    s.addEventListener('change', () => ((o.typeId = s.value), this.app.requestRender()));
    return [h('div.ob-group', h('label', 'Type'), s)];
  }

  down(ev) {
    const p = this.snap(ev);
    if (p && this.o.typeId) this.place('Legend component', { kind: 'legendComponent', typeId: this.o.typeId, at: p });
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor && this.o.typeId) this.preview(ctx, vc, vp, { kind: 'legendComponent', typeId: this.o.typeId, at: this.cursor });
    this.drawSnap(ctx, vc, vp);
  }
}

export const ROOM_FILL_BY = [
  { value: 'name', label: 'Name' },
  { value: 'department', label: 'Department' },
  { value: 'occupant', label: 'Occupant' },
  { value: 'floorFinish', label: 'Floor Finish' },
  { value: 'number', label: 'Number' },
];
