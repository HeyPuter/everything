/**
 * Tools that create elements: walls, doors and windows, components and
 * columns, sketched elements (floors, ceilings, roofs, railings), stairs,
 * rooms, lines (grids, beams, detail lines, room separators), annotations,
 * views (sections, elevations) and levels.
 */
import { Tool, isNumericStart } from './tool.js';
import {
  add,
  sub,
  scale,
  dot,
  norm,
  perp,
  dist,
  len,
  angleOf,
  rectPolygon,
  signedArea,
  offsetPolygon,
  mid,
  rotate,
  cleanPolygon,
  closestOnSegment,
  area as polyArea,
} from '../core/geom.js';
import { typeThickness } from '../core/catalog.js';
import { wallAxis, openingSize, hostedBy, stairLayout, rampLayout } from '../core/model.js';
import { planGraphics, planContext, tagAnchor, sectionFrame } from '../core/plan.js';
import { nextMark, nextRoomNumber, nextGridName, uniqueName } from '../core/ops.js';
import { VIEW_DEFAULTS, planView } from '../core/template.js';
import { boundarySegments, arrangementFaces } from '../core/rooms.js';
import { columnOutline } from '../core/plan.js';
import { formatAngle } from '../core/units.js';
import { strokeModel, fillModel, drawTempDim, drawTag } from '../views/overlay.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { newId, isPlanView, PLAN_VIEW_KINDS } from '../core/doc.js';

/** Views that take 2D annotations. */
export const ANNOTATION_VIEWS = [...PLAN_VIEW_KINDS, 'elevation', 'section'];
import { STAIR_SHAPES } from '../core/stairs.js';
import { LINE_STYLES } from '../core/props.js';
import { MM_PER_FOOT } from '../core/units.js';

export const REGION_PATTERNS = [
  { value: 'diag', label: 'Diagonal' },
  { value: 'cross', label: 'Crosshatch' },
  { value: 'concrete', label: 'Concrete' },
  { value: 'insulation', label: 'Insulation' },
  { value: 'brick', label: 'Masonry' },
  { value: 'wood', label: 'Wood' },
  { value: 'earth', label: 'Earth' },
  { value: 'solid', label: 'Solid' },
  { value: 'none', label: 'Gray tone' },
];

/** Draw plan graphics of a temporary element on the overlay. */
export function previewGraphics(app, vc, el, ctx, color, alpha = 0.12) {
  const view = vc.view;
  const pc = planContext(app.doc, isPlanView(view) ? view : { ...view, levelId: app.activeLevelId() }, app.scene.walls, app.scene.rooms, app.scene.areas);
  if (!vc.is2D) {
    pc.scale = +view.scale || 100;
  }
  let g = null;
  try {
    g = planGraphics(pc, el);
  } catch {
    g = null;
  }
  if (!g) return;
  const S = (p) => vc.modelToScreen(p);
  for (const f of g.fills) if (!(f.color && f.color[0] === -2)) fillModel(ctx, f.poly, S, color, alpha);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (const l of g.lines) {
    const a = S(l.a);
    const b = S(l.b);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

function segmented(items, current, onPick, label) {
  const group = h('div.seg', { role: 'radiogroup', 'aria-label': label });
  for (const it of items) {
    group.append(
      h(
        'button.seg-btn',
        { type: 'button', role: 'radio', 'aria-checked': String(it.value === current), 'data-tip': it.tip || it.label, onClick: () => onPick(it.value) },
        it.icon ? icon(it.icon, 15) : null,
        it.text === false ? null : h('span', it.label),
      ),
    );
  }
  return group;
}

function lengthField(tool, label, value, onChange, width = 'num') {
  const input = h(`input.input.sm.${width}`, { type: 'text', value: tool.fmt(value), 'aria-label': label, spellcheck: 'false' });
  const apply = () => {
    const v = tool.parseLen(input.value);
    if (Number.isFinite(v)) onChange(v);
    input.value = tool.fmt(Number.isFinite(v) ? v : value);
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      apply();
      tool.app.viewport.overlay.focus();
    }
  });
  return h('div.ob-group', h('label', label), input);
}

function levelSelect(app, value, onChange, { none = null } = {}) {
  const sel = h('select.input.sm', { 'aria-label': 'Top constraint' });
  if (none) sel.append(h('option', { value: '' }, none));
  for (const l of app.doc.levels()) sel.append(h('option', { value: l.id, selected: l.id === value }, `Up to level: ${l.name}`));
  sel.value = value || '';
  sel.addEventListener('change', () => onChange(sel.value || null));
  return sel;
}

function finishCancel(tool) {
  return h(
    'div.ob-actions',
    h('button.btn.sm.primary', { type: 'button', onClick: () => tool.finish() }, icon('finish', 14), 'Finish'),
    h('button.btn.sm', { type: 'button', onClick: () => tool.app.cancelTool() }, icon('cancel', 14), 'Cancel'),
  );
}

// Walls ------------------------------------------------------------------------------------------

export class WallTool extends Tool {
  get placingKind() {
    return 'wall';
  }

  constructor(app, opts) {
    super(app, opts);
    const o = app.toolOptions('wall', {
      shape: 'line',
      chain: true,
      locationLine: 'center',
      height: app.doc.units.system === 'imperial' ? 10 * MM_PER_FOOT : 3000,
      baseOffset: 0,
    });
    this.o = o;
    this.structural = !!opts.structural;
    this.start = null;
    this.cursor = null;
    this.flip = false;
  }

  get title() {
    return 'Place Wall';
  }

  get prompt() {
    if (this.o.shape === 'rect') return this.start ? 'Click the opposite corner' : 'Click the first corner of the rectangle';
    if (this.o.shape === 'pick') return 'Click a line, grid or edge to place a wall along it';
    return this.start ? 'Click to end the wall, or type a length. Space flips the wall. Esc ends the chain.' : 'Click to start the wall';
  }

  get type() {
    return this.app.currentType('wall');
  }

  topLevelId() {
    if (this.o.topLevelId === undefined) {
      const above = this.app.doc.levelAbove(this.app.activeLevelId());
      return above?.id ?? null;
    }
    return this.o.topLevelId;
  }

  options() {
    const app = this.app;
    const o = this.o;
    const rerender = () => app.renderOptions();
    return [
      segmented(
        [
          { value: 'line', label: 'Line', icon: 'line', text: false, tip: 'Line' },
          { value: 'rect', label: 'Rectangle', icon: 'rect', text: false, tip: 'Rectangle' },
          { value: 'pick', label: 'Pick lines', icon: 'pickLines', text: false, tip: 'Pick lines' },
        ],
        o.shape,
        (v) => {
          o.shape = v;
          this.start = null;
          rerender();
          app.setPrompt(this.prompt);
        },
        'Draw shape',
      ),
      h('span.ob-sep'),
      h('div.ob-group', h('label', 'Top'), levelSelect(app, this.topLevelId(), (v) => ((o.topLevelId = v), rerender()), { none: 'Unconnected height' })),
      this.topLevelId() ? null : lengthField(this, 'Height', o.height, (v) => (o.height = Math.max(10, v))),
      h(
        'div.ob-group',
        h('label', 'Location line'),
        (() => {
          const s = h('select.input.sm', { 'aria-label': 'Location line' }, h('option', { value: 'center' }, 'Wall centerline'), h('option', { value: 'exterior' }, 'Exterior face'), h('option', { value: 'interior' }, 'Interior face'));
          s.value = o.locationLine;
          s.addEventListener('change', () => (o.locationLine = s.value));
          return s;
        })(),
      ),
      h(
        'label.ob-group',
        (() => {
          const c = h('input', { type: 'checkbox', checked: o.chain });
          c.addEventListener('change', () => (o.chain = c.checked));
          return c;
        })(),
        h('span.ob-label', 'Chain'),
      ),
    ];
  }

  newWall(a, b) {
    const top = this.topLevelId();
    return {
      kind: 'wall',
      typeId: this.type?.id,
      levelId: this.app.activeLevelId(),
      a,
      b,
      baseOffset: this.o.baseOffset || 0,
      topLevelId: top,
      topOffset: 0,
      height: this.o.height,
      locationLine: this.o.locationLine,
      flipped: this.flip,
      roomBounding: true,
      structural: this.structural,
      joinA: true,
      joinB: true,
      mark: '',
      comments: '',
    };
  }

  down(ev) {
    if (this.o.shape === 'pick') return this.pick(ev);
    const p = this.snap(ev, this.start);
    if (!p) return;
    if (!this.start) {
      this.start = p;
      this.cursor = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (dist(p, this.start) < 10) return;
    if (this.o.shape === 'rect') {
      const r = rectPolygon(this.start, p);
      // Clockwise so exteriors face out.
      const cw = [r[0], r[3], r[2], r[1]];
      this.app.commit('Walls', () => {
        for (let i = 0; i < 4; i++) this.doc.add(this.newWall(cw[i], cw[(i + 1) % 4]));
      });
      this.start = null;
    } else {
      this.app.commit('Wall', () => this.doc.add(this.newWall(this.start, p)));
      this.start = this.o.chain ? p : null;
    }
    this.app.setPrompt(this.prompt);
  }

  pick(ev) {
    this.snap(ev);
    const ref = this.snapRes?.ref;
    const line = ref?.line || this.snapRes?.line;
    if (!line) {
      this.app.setPrompt('Pick a line, grid, wall face or floor edge');
      return;
    }
    this.app.commit('Wall', () => this.doc.add(this.newWall(line.a, line.b)));
  }

  move(ev) {
    this.cursor = this.snap(ev, this.start);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.flip = !this.flip;
      this.app.requestRender();
      return true;
    }
    if (this.start && this.o.shape === 'line' && isNumericStart(e)) {
      e.preventDefault();
      const s = this.vc.modelToScreen(this.cursor || this.start);
      const input = this.openInput(s.x, s.y, {
        label: 'Wall length',
        onSubmit: (v) => {
          const L = this.parseLen(v);
          if (!Number.isFinite(L) || L <= 0) return false;
          const d = norm(sub(this.cursor || add(this.start, [1, 0]), this.start));
          const dir = len(d) ? d : [1, 0];
          const b = add(this.start, scale(dir, L));
          this.app.commit('Wall', () => this.doc.add(this.newWall(this.start, b)));
          this.start = this.o.chain ? b : null;
          this.cursor = b;
          this.app.requestRender();
          return true;
        },
      });
      input.value = e.key;
      return true;
    }
    return false;
  }

  cancel() {
    if (this.start) {
      this.start = null;
      this.app.setPrompt(this.prompt);
      this.app.requestRender();
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    const color = vp.theme.preview;
    const S = (p) => vc.modelToScreen(p);
    if (this.start && this.cursor && dist(this.start, this.cursor) > 1) {
      const segs = this.o.shape === 'rect' ? (() => {
        const r = rectPolygon(this.start, this.cursor);
        const cw = [r[0], r[3], r[2], r[1]];
        return cw.map((p, i) => [p, cw[(i + 1) % 4]]);
      })() : [[this.start, this.cursor]];
      const T = typeThickness(this.type) || 200;
      for (const [a, b] of segs) {
        const w = this.newWall(a, b);
        const ax = wallAxis(this.doc, { ...w, typeId: this.type?.id });
        const hw = T / 2;
        const quad = [add(ax.a, scale(ax.n, -hw)), add(ax.b, scale(ax.n, -hw)), add(ax.b, scale(ax.n, hw)), add(ax.a, scale(ax.n, hw))];
        fillModel(ctx, quad, S, color, 0.14);
        strokeModel(ctx, quad, S, color, 1.4, null, true);
        // Exterior side marker.
        const ext = this.flip ? -1 : 1;
        const m = mid(ax.a, ax.b);
        strokeModel(ctx, [m, add(m, scale(ax.n, ext * (hw + 10 * vc.mmPerPx())))], S, color, 1.4);
      }
      if (this.o.shape === 'line') {
        const a = S(this.start);
        const b = S(this.cursor);
        drawTempDim(ctx, a, b, this.fmt(dist(this.start, this.cursor)), color, vp.theme, -22);
        const ang = angleOf(sub(this.cursor, this.start));
        drawTag(ctx, b.x + 34, b.y + 26, formatAngle(ang < 0 ? ang + Math.PI * 2 : ang, 1), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: color });
      } else {
        const r = rectPolygon(this.start, this.cursor);
        drawTempDim(ctx, S(r[0]), S(r[1]), this.fmt(r[1][0] - r[0][0]), color, vp.theme, 22);
        drawTempDim(ctx, S(r[1]), S(r[2]), this.fmt(r[2][1] - r[1][1]), color, vp.theme, 22);
      }
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Doors, windows, openings -------------------------------------------------------------------------

export class HostedTool extends Tool {
  get placingKind() {
    return this.kind;
  }

  constructor(app, opts) {
    super(app, opts);
    this.kind = opts.kind;
    this.flip = false;
    this.cur = null;
  }

  get title() {
    return `Place ${this.kind === 'door' ? 'Door' : this.kind === 'window' ? 'Window' : 'Opening'}`;
  }

  get prompt() {
    return this.cur ? (this.cur.ok ? 'Click to place. Space flips the facing.' : this.cur.msg) : `Move over a wall to place the ${this.kind}`;
  }

  get type() {
    return this.kind === 'opening' ? null : this.app.currentType(this.kind);
  }

  options() {
    if (this.kind !== 'opening') {
      if (this.kind === 'window') {
        const o = this.app.toolOptions('window', {});
        return [lengthField(this, 'Sill height', o.sill ?? this.type?.sill ?? 900, (v) => (o.sill = v))];
      }
      return [h('span.ob-label', 'Doors swing toward the side of the wall where the cursor is.')];
    }
    const o = this.app.toolOptions('opening', { width: 1000, height: 2100, sill: 0 });
    return [lengthField(this, 'Width', o.width, (v) => (o.width = v)), lengthField(this, 'Height', o.height, (v) => (o.height = v)), lengthField(this, 'Sill', o.sill, (v) => (o.sill = v))];
  }

  findWall(ev) {
    const vc = this.vc;
    for (const id of vc.hitTest(ev.x, ev.y, 10)) {
      const el = this.doc.get(id);
      if (el?.kind === 'wall' && !this.doc.get(el.typeId)?.curtain) return el;
      if ((el?.kind === 'door' || el?.kind === 'window') && el.hostId) return this.doc.get(el.hostId);
    }
    return null;
  }

  candidate(ev) {
    const wall = this.findWall(ev);
    if (!wall || !ev.p) return null;
    const ax = wallAxis(this.doc, wall);
    const o = this.app.toolOptions(this.kind, {});
    const el = { kind: this.kind, hostId: wall.id, typeId: this.type?.id, t: 0, flipFacing: false, flipHand: false };
    if (this.kind === 'opening') Object.assign(el, { width: o.width, height: o.height, sill: o.sill });
    if (this.kind === 'window' && o.sill != null) el.sill = o.sill;
    const { width } = openingSize(this.doc, el);
    let t = dot(sub(ev.p, ax.a), ax.dir);
    const tol = 10 * this.vc.mmPerPx();
    if (Math.abs(t - ax.length / 2) < tol) t = ax.length / 2;
    else {
      const inc = this.doc.units.system === 'imperial' ? 25.4 : 10;
      t = Math.round(t / inc) * inc;
    }
    t = Math.max(width / 2, Math.min(ax.length - width / 2, t));
    el.t = t;
    const side = dot(sub(ev.p, ax.a), ax.n);
    el.flipFacing = this.kind === 'door' ? (side < 0) !== this.flip : this.flip;
    if (this.kind === 'window') el.flipFacing = this.flip;
    // Overlaps with other openings in the same wall.
    let ok = width <= ax.length;
    let msg = ok ? '' : 'The wall is too short for this opening';
    for (const other of hostedBy(this.doc, wall.id)) {
      const ow = openingSize(this.doc, other).width;
      if (Math.abs(other.t - t) < (ow + width) / 2 - 1) {
        ok = false;
        msg = 'Openings in a wall cannot overlap';
      }
    }
    return { el, wall, ax, ok, msg, width };
  }

  move(ev) {
    this.cur = this.candidate(ev);
    this.app.setPrompt(this.prompt);
    this.app.requestRender();
  }

  down(ev) {
    const c = this.candidate(ev);
    if (!c) return;
    if (!c.ok) {
      this.app.toast(c.msg, { kind: 'error' });
      return;
    }
    const mark = this.kind === 'opening' ? undefined : nextMark(this.doc, this.kind);
    this.app.commit(this.title.replace('Place ', 'Place '), () => this.doc.add({ ...c.el, mark, comments: '' }));
  }

  key(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.flip = !this.flip;
      if (this.cur) {
        this.cur.el.flipFacing = !this.cur.el.flipFacing;
        this.app.requestRender();
      }
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    const c = this.cur;
    if (c) {
      const color = c.ok ? vp.theme.preview : '#d33';
      previewGraphics(this.app, vc, c.el, ctx, color, 0.1);
      const S = (p) => vc.modelToScreen(p);
      const { ax, el, width } = c;
      const p0 = add(ax.a, scale(ax.dir, el.t - width / 2));
      const p1 = add(ax.a, scale(ax.dir, el.t + width / 2));
      const side = scale(ax.n, ax.half + 6 * vc.mmPerPx());
      drawTempDim(ctx, S(add(ax.a, side)), S(add(p0, side)), this.fmt(el.t - width / 2), color, vp.theme, 14);
      drawTempDim(ctx, S(add(p1, side)), S(add(ax.b, side)), this.fmt(ax.length - el.t - width / 2), color, vp.theme, 14);
    }
  }
}

// Components and columns ------------------------------------------------------------------------------

const WALL_HUGGERS = new Set(['bed', 'sofa', 'cabinet', 'shelf', 'desk', 'counter', 'upperCabinet', 'fridge', 'range', 'washer', 'toilet', 'vanity', 'kitchenSink', 'bathtub', 'armchair']);

export class ComponentTool extends Tool {
  get placingKind() {
    return this.kind;
  }

  constructor(app, opts) {
    super(app, opts);
    this.kind = opts.kind || 'component';
    this.rot = 0;
    this.cur = null;
  }

  get title() {
    if (this.kind === 'column') return this.opts.structural ? 'Place Structural Column' : 'Place Column';
    return 'Place Component';
  }

  get prompt() {
    return 'Click to place. Space rotates by 90 degrees. Near a wall, furniture turns its back to the wall.';
  }

  get type() {
    return this.app.currentType(this.kind);
  }

  options() {
    const o = this.app.toolOptions(this.kind, { offset: 0 });
    const out = [lengthField(this, 'Offset from level', o.offset || 0, (v) => (o.offset = v))];
    if (this.kind === 'column') out.push(h('div.ob-group', h('label', 'Top'), levelSelect(this.app, o.topLevelId === undefined ? this.app.doc.levelAbove(this.app.activeLevelId())?.id : o.topLevelId, (v) => (o.topLevelId = v), { none: 'Unconnected height' })));
    return out;
  }

  candidate(ev) {
    const type = this.type;
    if (!type || !ev.p) return null;
    let p = this.snap(ev);
    let rot = this.rot;
    if (this.kind === 'component' && WALL_HUGGERS.has(type.family) && !(this.snapRes?.kind && this.snapRes.kind !== 'nearest')) {
      // Back against the nearest wall face.
      const d = +type.depth || 600;
      const feats = this.vc.snapFeaturesNear(ev.p, d + 400 * 1);
      let best = null;
      for (const f of feats)
        for (const l of f.lines) {
          if (l.ref !== 'left' && l.ref !== 'right') continue;
          const c = closestOnSegment(ev.p, l.a, l.b);
          const dd = dist(c.point, ev.p);
          if (dd < d + 300 && (!best || dd < best.dd)) best = { dd, c, l };
        }
      if (best) {
        const dir = norm(sub(best.l.b, best.l.a));
        let n = perp(dir);
        if (dot(sub(ev.p, best.c.point), n) < 0) n = scale(n, -1);
        p = add(best.c.point, scale(n, d / 2));
        rot = ((Math.atan2(-n[1], -n[0]) - Math.PI / 2) * 180) / Math.PI + this.rot;
      }
    }
    const o = this.app.toolOptions(this.kind, { offset: 0 });
    const el = { kind: this.kind, typeId: type.id, levelId: this.app.activeLevelId(), at: p, rotation: Math.round(rot * 1000) / 1000, offset: o.offset || 0 };
    if (this.kind === 'column') {
      const top = o.topLevelId === undefined ? this.doc.levelAbove(el.levelId)?.id ?? null : o.topLevelId;
      Object.assign(el, { baseOffset: o.offset || 0, topLevelId: top, topOffset: 0, height: 3000, structural: !!this.opts.structural });
    }
    return el;
  }

  move(ev) {
    this.cur = this.candidate(ev);
    this.app.requestRender();
  }

  down(ev) {
    const el = this.candidate(ev);
    if (!el) return;
    this.app.commit(this.title, () => this.doc.add({ ...el, mark: '', comments: '' }));
  }

  key(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.rot = (this.rot + 90) % 360;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cur) previewGraphics(this.app, vc, this.cur, ctx, vp.theme.preview, 0.12);
    this.drawSnap(ctx, vc, vp);
  }
}

// Lines: grids, beams, detail lines, room separators ---------------------------------------------------

export class LineTool extends Tool {
  get placingKind() {
    return this.kind === 'beam' ? 'beam' : null;
  }

  constructor(app, opts) {
    super(app, opts);
    this.kind = opts.kind;
    this.start = null;
    this.cursor = null;
  }

  get title() {
    return { grid: 'Place Grid', beam: 'Place Beam', detailLine: 'Detail Lines', roomSeparator: 'Room Separation Lines', refPlane: 'Reference Plane', modelLine: 'Model Lines', areaBoundary: 'Area Boundary' }[this.kind];
  }

  get prompt() {
    if (this.pickMode) return 'Click a wall face, line, grid or edge to draw along it';
    return this.start ? 'Click the end point (type a length to enter it)' : 'Click the start point';
  }

  get viewKinds() {
    if (this.kind === 'areaBoundary') return ['areaPlan'];
    return this.kind === 'detailLine' ? ANNOTATION_VIEWS : PLAN_VIEW_KINDS;
  }

  get chain() {
    return ['detailLine', 'roomSeparator', 'beam', 'modelLine', 'areaBoundary'].includes(this.kind);
  }

  /** Line kinds that can be drawn by picking existing lines. */
  get canPick() {
    return ['refPlane', 'modelLine', 'areaBoundary', 'detailLine', 'roomSeparator'].includes(this.kind);
  }

  get pickMode() {
    return this.canPick && this.app.toolOptions(`line-${this.kind}`, { mode: 'draw' }).mode === 'pick';
  }

  options() {
    const out = [];
    if (this.canPick) {
      const o = this.app.toolOptions(`line-${this.kind}`, { mode: 'draw' });
      out.push(
        segmented(
          [
            { value: 'draw', label: 'Line', icon: 'line', text: false, tip: 'Draw' },
            { value: 'pick', label: 'Pick lines', icon: 'pickLines', text: false, tip: 'Pick lines' },
          ],
          o.mode,
          (v) => {
            o.mode = v;
            this.start = null;
            this.app.renderOptions();
            this.app.setPrompt(this.prompt);
          },
          'Draw mode',
        ),
        h('span.ob-sep'),
      );
    }
    if (this.kind === 'detailLine' || this.kind === 'modelLine') {
      const o = this.app.toolOptions(this.kind, { style: this.kind === 'modelLine' ? 'thin' : 'medium' });
      const s = h('select.input.sm', { 'aria-label': 'Line style' }, ...LINE_STYLES.map((v) => h('option', { value: v.value }, v.label)));
      s.value = o.style;
      s.addEventListener('change', () => (o.style = s.value));
      out.push(h('div.ob-group', h('label', 'Style'), s));
    }
    if (this.kind === 'beam' || this.kind === 'modelLine') {
      const o = this.app.toolOptions(this.kind, { offset: 0 });
      out.push(lengthField(this, 'Offset from level', o.offset || 0, (v) => (o.offset = v)));
    }
    if (this.kind === 'refPlane') {
      const o = this.app.toolOptions('refPlane', { name: '' });
      const inp = h('input.input.sm', { type: 'text', value: o.name, 'aria-label': 'Name', placeholder: 'Optional' });
      inp.addEventListener('input', () => (o.name = inp.value));
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      out.push(h('div.ob-group', h('label', 'Name'), inp));
    }
    return out.length ? out : null;
  }

  make(a, b) {
    const view = this.vc.view;
    switch (this.kind) {
      case 'grid':
        return { kind: 'grid', name: nextGridName(this.doc, this.lastGrid() ?? undefined), a, b, bubbles: 'both' };
      case 'beam':
        return { kind: 'beam', typeId: this.app.currentType('beam')?.id, levelId: this.app.activeLevelId(), a, b, offset: this.app.toolOptions('beam', { offset: 0 }).offset };
      case 'detailLine':
        return { kind: 'detailLine', viewId: view.id, a, b, style: this.app.toolOptions('detailLine', { style: 'medium' }).style };
      case 'roomSeparator':
        return { kind: 'roomSeparator', levelId: this.app.activeLevelId(), a, b };
      case 'refPlane':
        return { kind: 'refPlane', a, b, name: this.app.toolOptions('refPlane', { name: '' }).name || '' };
      case 'modelLine': {
        const o = this.app.toolOptions('modelLine', { style: 'thin', offset: 0 });
        return { kind: 'modelLine', levelId: this.app.activeLevelId(), a, b, offset: o.offset || 0, style: o.style };
      }
      case 'areaBoundary':
        return { kind: 'areaBoundary', levelId: view.levelId, scheme: view.scheme || 'gross', a, b };
      default:
        return null;
    }
  }

  pick(ev) {
    this.snap(ev);
    const ref = this.snapRes?.ref;
    const line = ref?.line || this.snapRes?.line;
    if (!line) return this.app.setPrompt('Nothing to pick here. Click a wall face, line, grid or edge.');
    this.app.commit(this.title, () => this.doc.add(this.make(line.a, line.b)));
  }

  lastGrid() {
    const g = this.doc.all('grid');
    return g.length ? g.at(-1).name : null;
  }

  down(ev) {
    if (this.pickMode) return this.pick(ev);
    const p = this.snap(ev, this.start);
    if (!p) return;
    if (!this.start) {
      this.start = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (dist(this.start, p) < 1) return;
    this.app.commit(this.title, () => this.doc.add(this.make(this.start, p)));
    this.start = this.chain ? p : null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.start);
    this.app.requestRender();
  }

  key(e) {
    if (this.start && isNumericStart(e)) {
      e.preventDefault();
      const s = this.vc.modelToScreen(this.cursor || this.start);
      const input = this.openInput(s.x, s.y, {
        label: 'Length',
        onSubmit: (v) => {
          const L = this.parseLen(v);
          if (!Number.isFinite(L) || L <= 0) return false;
          const d = norm(sub(this.cursor || add(this.start, [1, 0]), this.start));
          const b = add(this.start, scale(len(d) ? d : [1, 0], L));
          this.app.commit(this.title, () => this.doc.add(this.make(this.start, b)));
          this.start = this.chain ? b : null;
          return true;
        },
      });
      input.value = e.key;
      return true;
    }
    return false;
  }

  cancel() {
    if (this.start) {
      this.start = null;
      this.app.requestRender();
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.pickMode) {
      const line = this.snapRes?.ref?.line || this.snapRes?.line;
      if (line) strokeModel(ctx, [line.a, line.b], (p) => vc.modelToScreen(p), vp.theme.preview, 3);
      return;
    }
    if (this.start && this.cursor && dist(this.start, this.cursor) > 1) {
      const S = (p) => vc.modelToScreen(p);
      if (['detailLine', 'roomSeparator', 'modelLine', 'refPlane', 'areaBoundary'].includes(this.kind)) strokeModel(ctx, [this.start, this.cursor], S, vp.theme.preview, 1.6);
      else previewGraphics(this.app, vc, { id: 'preview', ...this.make(this.start, this.cursor) }, ctx, vp.theme.preview, 0.1);
      drawTempDim(ctx, S(this.start), S(this.cursor), this.fmt(dist(this.start, this.cursor)), vp.theme.preview, vp.theme, -20);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Sketched elements: floors, ceilings, roofs, railings ----------------------------------------------------

export class SketchTool extends Tool {
  get placingKind() {
    return this.kind === 'shaft' || this.kind === 'region' || this.kind === 'vopening' ? null : this.kind;
  }

  get viewKinds() {
    return this.kind === 'region' ? [...ANNOTATION_VIEWS, 'sheet'] : PLAN_VIEW_KINDS;
  }

  constructor(app, opts) {
    super(app, opts);
    this.kind = opts.kind;
    this.editId = opts.editId || null;
    const el = this.editId ? app.doc.get(this.editId) : null;
    this.pts = el ? (el.boundary || el.path || []).slice() : [];
    this.closed = !!el && this.kind !== 'railing';
    this.cursor = null;
    const defaults = { mode: this.kind === 'railing' || this.kind === 'region' ? 'polygon' : this.kind === 'shaft' || this.kind === 'vopening' ? 'rect' : this.kind === 'roof' ? 'pickWalls' : this.kind === 'ceiling' ? 'pickRoom' : 'pickWalls', slope: 30, overhang: app.doc.units.system === 'imperial' ? 24 * 25.4 : 600, offset: this.kind === 'ceiling' ? (app.doc.units.system === 'imperial' ? 8 * MM_PER_FOOT : 2700) : 0 };
    this.o = app.toolOptions(`sketch-${this.kind}`, defaults);
    if (this.editId) this.o.mode = 'polygon';
    this.hostId = opts.hostId || null;
  }

  get title() {
    if (this.kind === 'shaft') return 'Shaft Opening';
    if (this.kind === 'vopening') return 'Opening in Floor, Roof or Ceiling';
    if (this.kind === 'region') return 'Filled Region';
    const n = { floor: 'Floor', ceiling: 'Ceiling', roof: 'Roof', railing: 'Railing' }[this.kind];
    return this.editId ? `Edit ${n} Boundary` : `Create ${n} ${this.kind === 'railing' ? 'Path' : 'Boundary'}`;
  }

  get prompt() {
    const m = this.o.mode;
    if (this.kind === 'vopening' && !this.hostId) return 'Click the floor, roof or ceiling to cut';
    if (m === 'pickRoom') return 'Click inside an enclosed area to use its outline. Then click Finish.';
    if (m === 'pickWalls') return 'Click a wall of the building to use the building outline. Then click Finish.';
    if (m === 'rect') return 'Click two opposite corners. Then click Finish.';
    if (this.kind === 'railing') return 'Click the points of the railing path. Double-click or press Enter to finish.';
    return this.closed ? 'The boundary is closed. Click Finish, or Backspace to remove the last point.' : 'Click the boundary points. Click the first point to close it. Enter finishes.';
  }

  options() {
    const app = this.app;
    const o = this.o;
    const modes = [{ value: 'polygon', label: 'Lines', icon: 'polygon' }];
    if (this.kind !== 'railing') modes.push({ value: 'rect', label: 'Rectangle', icon: 'rect' });
    if (this.kind === 'floor' || this.kind === 'ceiling' || this.kind === 'region') modes.push({ value: 'pickRoom', label: 'Pick room', icon: 'room' });
    if (this.kind === 'floor' || this.kind === 'roof') modes.push({ value: 'pickWalls', label: 'Pick walls', icon: 'pickWalls' });
    const out = [
      segmented(
        modes,
        o.mode,
        (v) => {
          o.mode = v;
          this.pts = [];
          this.closed = false;
          app.renderOptions();
          app.setPrompt(this.prompt);
          app.requestRender();
        },
        'Sketch mode',
      ),
      h('span.ob-sep'),
    ];
    if (this.kind === 'roof') {
      const inp = h('input.input.sm.num', { type: 'number', value: o.slope, min: 0, max: 80, step: 1, 'aria-label': 'Slope in degrees' });
      inp.addEventListener('change', () => (o.slope = Math.max(0, Math.min(80, +inp.value || 0))));
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      out.push(h('div.ob-group', h('label', 'Slope (degrees)'), inp));
      out.push(lengthField(this, 'Overhang', o.overhang, (v) => (o.overhang = v)));
    }
    if (this.kind === 'ceiling') out.push(lengthField(this, 'Height offset', o.offset, (v) => (o.offset = v)));
    if (this.kind === 'region') {
      const s = h('select.input.sm', { 'aria-label': 'Fill pattern' }, ...REGION_PATTERNS.map((p) => h('option', { value: p.value }, p.label)));
      s.value = o.pattern || 'diag';
      s.addEventListener('change', () => (o.pattern = s.value));
      out.push(h('div.ob-group', h('label', 'Pattern'), s));
    }
    out.push(finishCancel(this));
    return out;
  }

  down(ev) {
    const m = this.o.mode;
    if (this.kind === 'vopening' && !this.hostId) {
      const host = this.vc.hitTest(ev.x, ev.y, 8).map((id) => this.doc.get(id)).find((el) => ['floor', 'roof', 'ceiling'].includes(el?.kind));
      if (!host) return this.app.toast('Click the edge or inside of a floor, roof or ceiling.', { kind: 'error' });
      this.hostId = host.id;
      this.app.select([host.id]);
      this.app.setPrompt(`Sketch the opening in the ${host.kind}. Then click Finish.`);
      return;
    }
    if (m === 'pickRoom') {
      const r = this.app.scene.rooms.regionAt(this.app.activeLevelId(), ev.p);
      if (!r) return this.app.toast('That point is not inside an enclosed area.', { kind: 'error' });
      this.pts = r.outer.slice();
      this.holes = r.holes;
      this.closed = true;
      this.app.setPrompt('Outline picked. Click Finish to create it.');
      this.app.requestRender();
      return;
    }
    if (m === 'pickWalls') {
      const outline = this.buildingOutline(ev);
      if (!outline) return this.app.toast('Click on a wall that is part of a closed outline.', { kind: 'error' });
      this.pts = this.kind === 'roof' && this.o.overhang ? offsetPolygon(outline, this.o.overhang) : outline;
      this.closed = true;
      this.app.setPrompt('Outline picked. Click Finish to create it.');
      this.app.requestRender();
      return;
    }
    const p = this.snap(ev, this.pts.at(-1) || null);
    if (!p) return;
    if (m === 'rect') {
      if (!this.rectStart || this.closed) {
        this.rectStart = p;
        this.pts = [];
        this.closed = false;
      } else {
        this.pts = rectPolygon(this.rectStart, p);
        this.closed = true;
        this.rectStart = null;
      }
      this.app.setPrompt(this.prompt);
      return;
    }
    if (this.closed) return;
    if (this.pts.length >= 3 && dist(p, this.pts[0]) < 8 * this.vc.mmPerPx() && this.kind !== 'railing') {
      this.closed = true;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (this.pts.length && dist(p, this.pts.at(-1)) < 1) return;
    this.pts.push(p);
    this.app.setPrompt(this.prompt);
  }

  dblclick() {
    if (this.kind === 'railing' && this.pts.length >= 2) this.finish();
  }

  /** Exterior outline of the walls connected to the wall under the cursor. */
  buildingOutline(ev) {
    const hits = this.vc.hitTest(ev.x, ev.y, 8);
    const wall = hits.map((id) => this.doc.get(id)).find((e) => e?.kind === 'wall');
    if (!wall) return null;
    const solved = this.app.scene.walls.level(wall.levelId);
    const faces = arrangementFaces(boundarySegments(this.doc, solved, wall.levelId, (c) => columnOutline(this.doc, c)));
    const g = solved.walls.get(wall.id);
    if (!g) return null;
    const probe = g.L0;
    let best = null;
    for (const f of faces) {
      if (f.area >= 0) continue;
      if (!f.loop.some((p) => dist(p, probe) < 1) && !f.loop.some((p) => dist(p, g.R0) < 1)) continue;
      if (!best || -f.area > -best.area) best = f;
    }
    if (!best) return null;
    return cleanPolygon(best.loop.slice().reverse(), 0.5);
  }

  move(ev) {
    if (this.o.mode === 'pickRoom') {
      this.hoverRegion = ev.p ? this.app.scene.rooms.regionAt(this.app.activeLevelId(), ev.p) : null;
    } else this.cursor = this.snap(ev, this.pts.at(-1) || this.rectStart || null);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === 'Backspace' && this.pts.length) {
      e.preventDefault();
      if (this.closed) this.closed = false;
      else this.pts.pop();
      this.app.requestRender();
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.finish();
      return true;
    }
    return false;
  }

  cancel() {
    return true;
  }

  finish() {
    const pts = cleanPolygon(this.pts, 0.5);
    if (this.kind === 'railing') {
      if (this.pts.length < 2) return this.app.toast('Draw at least two points.', { kind: 'error' });
      const type = this.app.currentType('railing');
      this.app.commit(this.title, () => {
        if (this.editId) this.doc.update(this.editId, { path: this.pts });
        else this.doc.add({ kind: 'railing', typeId: type?.id, levelId: this.app.activeLevelId(), path: this.pts, offset: 0 });
      });
      return this.app.cancelTool();
    }
    if (pts.length < 3 || Math.abs(signedArea(pts)) < 1000) return this.app.toast('The boundary needs at least three points enclosing an area.', { kind: 'error' });
    if (this.kind === 'shaft') return this.finishShaft(pts);
    if (this.kind === 'vopening') {
      const host = this.doc.get(this.hostId);
      if (!host) return this.app.toast('Pick the floor, roof or ceiling to cut first.', { kind: 'error' });
      this.app.commit('Opening', () => this.doc.update(host.id, { holes: [...(host.holes || []), pts] }));
      this.app.select([host.id]);
      return this.app.cancelTool();
    }
    if (this.kind === 'region') {
      const view = this.vc.view;
      this.app.commit('Filled region', () => this.doc.add({ kind: 'region', viewId: view.id, boundary: pts, holes: [], pattern: this.o.pattern || 'diag', outline: true }));
      return this.app.cancelTool();
    }
    const type = this.app.currentType(this.kind);
    let levelId = this.app.activeLevelId();
    let baseOffset = 0;
    this.app.commit(this.title, () => {
      if (this.editId) {
        const el = this.doc.get(this.editId);
        const patch = { boundary: pts };
        if (el.kind === 'roof' && el.slopes?.length !== pts.length) patch.slopes = pts.map(() => this.o.slope || null);
        this.doc.update(this.editId, patch);
        return;
      }
      if (this.kind === 'roof') {
        // Roofs go on top of the walls: the level above when walls reach it.
        const above = this.doc.levelAbove(levelId);
        if (above && this.doc.all('wall').some((w) => w.levelId === levelId && w.topLevelId === above.id)) levelId = above.id;
        this.doc.add({ kind: 'roof', typeId: type?.id, levelId, boundary: pts, slopes: pts.map(() => (this.o.slope > 0 ? this.o.slope : null)), baseOffset });
      } else if (this.kind === 'ceiling') {
        this.doc.add({ kind: 'ceiling', typeId: type?.id, levelId, boundary: pts, holes: this.holes || [], offset: this.o.offset });
      } else this.doc.add({ kind: 'floor', typeId: type?.id, levelId, boundary: pts, holes: this.holes || [], offset: 0 });
    });
    this.app.cancelTool();
  }

  /** Cut the outline out of the floors of the level above and the ceilings of this level. */
  finishShaft(pts) {
    const doc = this.doc;
    const levelId = this.app.activeLevelId();
    const above = doc.levelAbove(levelId);
    const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
    const inside = (b) => {
      let r = false;
      for (let i = 0, j = b.length - 1; i < b.length; j = i++) {
        const a = b[i];
        const q = b[j];
        if (a[1] > c[1] !== q[1] > c[1] && c[0] < ((q[0] - a[0]) * (c[1] - a[1])) / (q[1] - a[1]) + a[0]) r = !r;
      }
      return r;
    };
    let n = 0;
    this.app.commit('Shaft opening', () => {
      for (const el of doc.all('floor', 'ceiling')) {
        const hit = (el.kind === 'floor' && el.levelId === above?.id) || (el.kind === 'ceiling' && el.levelId === levelId);
        if (!hit || !inside(el.boundary)) continue;
        doc.update(el.id, { holes: [...(el.holes || []), pts] });
        n++;
      }
    });
    this.app.toast(n ? `Cut the opening in ${n} floor${n === 1 ? '' : 's'} and ceiling${n === 1 ? '' : 's'}.` : 'No floor on the level above (or ceiling on this level) covers this outline.', { kind: n ? 'success' : 'error' });
    this.app.cancelTool();
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    const color = vp.theme.preview;
    if (this.hoverRegion && this.o.mode === 'pickRoom') fillModel(ctx, this.hoverRegion.outer, S, color, 0.12);
    const pts = this.pts.slice();
    if (this.o.mode === 'rect' && this.rectStart && this.cursor) {
      const r = rectPolygon(this.rectStart, this.cursor);
      strokeModel(ctx, r, S, color, 2, null, true);
    }
    if (pts.length) {
      if (this.closed) fillModel(ctx, pts, S, color, 0.1);
      strokeModel(ctx, pts, S, color, 2, null, this.closed);
      if (!this.closed && this.cursor && this.o.mode === 'polygon') {
        strokeModel(ctx, [pts.at(-1), this.cursor], S, color, 1.5, [6, 4]);
        drawTempDim(ctx, S(pts.at(-1)), S(this.cursor), this.fmt(dist(pts.at(-1), this.cursor)), color, vp.theme, -20);
      }
      for (const p of pts) {
        const s = S(p);
        ctx.fillStyle = color;
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
      }
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Stairs ---------------------------------------------------------------------------------------------

export class StairTool extends Tool {
  get placingKind() {
    return 'stair';
  }

  constructor(app, opts) {
    super(app, opts);
    this.start = null;
    this.cursor = null;
  }

  get title() {
    return 'Place Stair';
  }

  get prompt() {
    return this.start ? 'Click to set the direction of the run' : 'Click the start of the run (the bottom step)';
  }

  options() {
    const o = this.app.toolOptions('stair', { shape: 'straight', turn: 'left' });
    const type = this.app.currentType('stair');
    const rerender = () => (this.app.renderOptions(), this.app.requestRender());
    return [
      segmented(
        STAIR_SHAPES.map((s) => ({ ...s })),
        o.shape,
        (v) => {
          o.shape = v;
          rerender();
        },
        'Stair shape',
      ),
      o.shape !== 'straight'
        ? segmented(
            [
              { value: 'left', label: 'Turn left' },
              { value: 'right', label: 'Turn right' },
            ],
            o.turn,
            (v) => {
              o.turn = v;
              rerender();
            },
            'Turn direction',
          )
        : null,
      h('span.ob-sep'),
      lengthField(this, 'Width', o.width ?? type?.width ?? 1100, (v) => (o.width = v)),
      h('div.ob-group', h('label', 'Top'), levelSelect(this.app, o.topLevelId ?? this.doc.levelAbove(this.app.activeLevelId())?.id ?? '', (v) => (o.topLevelId = v), { none: 'Unconnected (3000)' })),
    ];
  }

  make(a, b) {
    const o = this.app.toolOptions('stair', { shape: 'straight', turn: 'left' });
    const levelId = this.app.activeLevelId();
    const type = this.app.currentType('stair');
    const el = { kind: 'stair', typeId: type?.id, levelId, topLevelId: o.topLevelId ?? this.doc.levelAbove(levelId)?.id ?? null, baseOffset: 0, topOffset: 0, height: 3000, a, b, width: o.width ?? type?.width ?? 1100, railings: true, shape: o.shape, turn: o.turn };
    const lay = stairLayout(this.doc, el);
    const d = norm(sub(b, a));
    el.b = add(a, scale(len(d) ? d : [1, 0], lay.runLength));
    return { el, lay };
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
    const { el } = this.make(this.start, p);
    this.app.commit('Stair', () => this.doc.add(el));
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
      this.app.requestRender();
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.start && this.cursor && dist(this.start, this.cursor) > 10) {
      const { el, lay } = this.make(this.start, this.cursor);
      previewGraphics(this.app, vc, el, ctx, vp.theme.preview, 0.1);
      const s = vc.modelToScreen(this.cursor);
      drawTag(ctx, s.x + 40, s.y + 24, `${lay.risers} risers, ${this.fmt(lay.riserHeight)} each`, { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Ramps -----------------------------------------------------------------------------------------------

export class RampTool extends Tool {
  get placingKind() {
    return 'ramp';
  }

  get title() {
    return 'Place Ramp';
  }

  get prompt() {
    return this.start ? 'Click to set the direction of the run' : 'Click the bottom of the ramp';
  }

  options() {
    const o = this.app.toolOptions('ramp', {});
    const type = this.app.currentType('ramp');
    return [
      lengthField(this, 'Width', o.width ?? type?.width ?? 1200, (v) => (o.width = v)),
      h('div.ob-group', h('label', 'Top'), levelSelect(this.app, o.topLevelId ?? this.doc.levelAbove(this.app.activeLevelId())?.id ?? '', (v) => (o.topLevelId = v), { none: 'Unconnected (600)' })),
      h(
        'label.ob-group',
        (() => {
          const c = h('input', { type: 'checkbox', checked: o.railings !== false });
          c.addEventListener('change', () => (o.railings = c.checked));
          return c;
        })(),
        h('span.ob-label', 'Handrails'),
      ),
    ];
  }

  make(a, b) {
    const o = this.app.toolOptions('ramp', {});
    const levelId = this.app.activeLevelId();
    const type = this.app.currentType('ramp');
    const topLevelId = o.topLevelId === undefined ? this.doc.levelAbove(levelId)?.id ?? null : o.topLevelId || null;
    const el = { kind: 'ramp', typeId: type?.id, levelId, topLevelId, baseOffset: 0, topOffset: 0, height: 600, a, b, width: o.width ?? type?.width ?? 1200, railings: o.railings !== false };
    const g = rampLayout(this.doc, el);
    el.b = g.end;
    return { el, g };
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
    const { el, g } = this.make(this.start, p);
    if (g.run > 60000) return this.app.toast(`That ramp would be ${this.fmt(g.run)} long. Choose a closer top level or an unconnected height.`, { kind: 'error' });
    this.app.commit('Ramp', () => this.doc.add({ ...el, mark: '', comments: '' }));
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
      this.app.requestRender();
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.start && this.cursor && dist(this.start, this.cursor) > 10) {
      const { el, g } = this.make(this.start, this.cursor);
      previewGraphics(this.app, vc, el, ctx, vp.theme.preview, 0.1);
      const s = vc.modelToScreen(this.cursor);
      drawTag(ctx, s.x + 40, s.y + 24, `Run ${this.fmt(g.run)}, rise ${this.fmt(g.rise)} (1:${Math.round(g.ratio)})`, { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Areas -----------------------------------------------------------------------------------------------

export class AreaTool extends Tool {
  get title() {
    return 'Place Area';
  }

  get viewKinds() {
    return ['areaPlan'];
  }

  get prompt() {
    return this.region ? 'Click to place an area here' : 'Move into a region enclosed by area boundary lines';
  }

  move(ev) {
    const view = this.vc.view;
    this.at = ev.p;
    this.region = ev.p ? this.app.scene.areas.regionAt(view.levelId, view.scheme || 'gross', ev.p) : null;
    this.app.setPrompt(this.prompt);
    this.app.requestRender();
  }

  down(ev) {
    if (!ev.p) return;
    const view = this.vc.view;
    const scheme = view.scheme || 'gross';
    const region = this.app.scene.areas.regionAt(view.levelId, scheme, ev.p);
    if (region) {
      const existing = this.doc.all('area').find((a) => a.levelId === view.levelId && (a.scheme || 'gross') === scheme && this.app.scene.areas.area(a)?.outer === region.outer);
      if (existing) return this.app.toast(`This region already has an area (${existing.name}).`, { kind: 'error' });
    }
    const o = this.app.toolOptions('area', { name: 'Area' });
    this.app.commit('Area', () => this.doc.add({ kind: 'area', levelId: view.levelId, scheme, at: ev.p, name: o.name || 'Area', number: String(this.doc.all('area').length + 1), areaType: 'floor' }));
  }

  options() {
    const o = this.app.toolOptions('area', { name: 'Area' });
    const inp = h('input.input.sm', { type: 'text', value: o.name, 'aria-label': 'Area name' });
    inp.addEventListener('input', () => (o.name = inp.value));
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return [h('div.ob-group', h('label', 'Name'), inp)];
  }

  drawOverlay(ctx, vc, vp) {
    if (!this.region) return;
    const S = (p) => vc.modelToScreen(p);
    fillModel(ctx, this.region.outer, S, vp.theme.preview, 0.12);
    strokeModel(ctx, this.region.outer, S, vp.theme.preview, 1.5, [6, 4], true);
    const s = S(this.at);
    drawTag(ctx, s.x, s.y - 24, this.app.formatArea(this.region.area), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
  }
}

/**
 * Area boundary lines along the outside faces of the building on a level,
 * for a new gross area plan. Returns the number of lines added.
 */
export function boundaryFromExterior(app, levelId, scheme) {
  const doc = app.doc;
  const solved = app.scene.walls.level(levelId);
  const faces = arrangementFaces(boundarySegments(doc, solved, levelId, (c) => columnOutline(doc, c)));
  let n = 0;
  for (const f of faces) {
    // Outer cycles of connected wall groups wind clockwise.
    if (f.area >= 0 || -f.area < 1e6) continue;
    const loop = cleanPolygon(f.loop, 0.5);
    for (let i = 0; i < loop.length; i++) {
      doc.add({ kind: 'areaBoundary', levelId, scheme, a: loop[i], b: loop[(i + 1) % loop.length] });
      n++;
    }
  }
  return n;
}

/** Move the label of a room or area to a clicked point. */
export class LabelTool extends Tool {
  get title() {
    return 'Tag Room';
  }

  get viewKinds() {
    return PLAN_VIEW_KINDS;
  }

  get prompt() {
    return this.target ? 'Click where the label goes' : 'Click a room (or area) to place its label';
  }

  down(ev) {
    if (!ev.p) return;
    if (this.target) {
      const id = this.target.id;
      this.app.commit('Place label', () => this.doc.update(id, { tagAt: ev.p }));
      this.target = null;
      this.app.setHover(null);
      this.app.setPrompt(this.prompt);
      return;
    }
    const hit = this.vc.hitTest(ev.x, ev.y).map((id) => this.doc.get(id)).find((el) => el?.kind === 'room' || el?.kind === 'area');
    if (!hit) return;
    this.target = hit;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = ev.p;
    if (!this.target) {
      const hit = this.vc.hitTest(ev.x, ev.y).map((id) => this.doc.get(id)).find((el) => el?.kind === 'room' || el?.kind === 'area');
      this.app.setHover(hit?.id ?? null);
    }
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
    if (this.target && this.cursor) previewGraphics(this.app, vc, { ...this.target, tagAt: this.cursor }, ctx, vp.theme.preview, 0);
  }
}

// Rooms -------------------------------------------------------------------------------------------------

export class RoomTool extends Tool {
  get title() {
    return 'Place Room';
  }

  get prompt() {
    return this.region ? 'Click to place a room here' : 'Move into an area enclosed by walls or room separation lines';
  }

  move(ev) {
    this.at = ev.p;
    this.region = ev.p ? this.app.scene.rooms.regionAt(this.app.activeLevelId(), ev.p) : null;
    this.app.setPrompt(this.prompt);
    this.app.requestRender();
  }

  down(ev) {
    if (!ev.p) return;
    const levelId = this.app.activeLevelId();
    const region = this.app.scene.rooms.regionAt(levelId, ev.p);
    if (region) {
      const existing = this.doc.all('room').find((r) => r.levelId === levelId && this.app.scene.rooms.room(r)?.outer === region.outer);
      if (existing) return this.app.toast(`This area already has a room (${existing.name}).`, { kind: 'error' });
    }
    const o = this.app.toolOptions('room', { name: 'Room' });
    this.app.commit('Room', () => this.doc.add({ kind: 'room', levelId, at: ev.p, name: o.name || 'Room', number: nextRoomNumber(this.doc, levelId), upperOffset: this.doc.units.system === 'imperial' ? 8 * MM_PER_FOOT : 2700 }));
  }

  options() {
    const o = this.app.toolOptions('room', { name: 'Room' });
    const inp = h('input.input.sm', { type: 'text', value: o.name, 'aria-label': 'Room name' });
    inp.addEventListener('input', () => (o.name = inp.value));
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return [h('div.ob-group', h('label', 'Name'), inp), h('button.btn.sm', { type: 'button', onClick: () => this.app.run('rooms-auto') }, icon('room', 14), 'Place rooms automatically')];
  }

  drawOverlay(ctx, vc, vp) {
    if (this.region) {
      const S = (p) => vc.modelToScreen(p);
      fillModel(ctx, this.region.outer, S, vp.theme.preview, 0.12);
      strokeModel(ctx, this.region.outer, S, vp.theme.preview, 1.5, [6, 4], true);
      const s = S(this.at);
      drawTag(ctx, s.x, s.y - 24, this.app.formatArea(this.region.area), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
  }
}

/** Place a room in every enclosed area of the level that has none. */
export function placeRoomsAutomatically(app) {
  const doc = app.doc;
  const levelId = app.activeLevelId();
  const { faces } = app.scene.rooms.faces(levelId);
  const taken = doc.all('room').filter((r) => r.levelId === levelId).map((r) => app.scene.rooms.room(r)?.outer).filter(Boolean);
  // Wall interiors are faces too: only keep faces that are not inside a wall outline.
  const solved = app.scene.walls.level(levelId);
  const wallPolys = [...solved.walls.values()].map((g) => [g.R0, g.R1, g.L1, g.L0]);
  const minArea = 250000;
  let n = 0;
  app.commit('Place rooms', () => {
    for (const f of faces) {
      if (f.area < minArea) continue;
      if (taken.includes(f.loop)) continue;
      const c = interiorPoint(f.loop);
      if (!c) continue;
      if (wallPolys.some((w) => Math.abs(polyArea(w) - f.area) < 1 && polyArea(w) > 0 && w.every((p) => f.loop.some((q) => dist(p, q) < 1)))) continue;
      const region = app.scene.rooms.regionAt(levelId, c);
      if (!region || region.outer !== f.loop) continue;
      doc.add({ kind: 'room', levelId, at: c, name: 'Room', number: nextRoomNumber(doc, levelId), upperOffset: 2700 });
      n++;
    }
  });
  app.toast(n ? `Placed ${n} room${n === 1 ? '' : 's'}.` : 'Every enclosed area already has a room.');
}

export function interiorPoint(loop) {
  // Try the centroid, then midpoints between vertices.
  const pip = (p) => {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i];
      const b = loop[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
  let cx = 0;
  let cy = 0;
  for (const p of loop) {
    cx += p[0];
    cy += p[1];
  }
  const c = [cx / loop.length, cy / loop.length];
  if (pip(c)) return c;
  for (let i = 0; i < loop.length; i++)
    for (let j = i + 2; j < loop.length; j++) {
      const m = mid(loop[i], loop[j]);
      if (pip(m)) return m;
    }
  return null;
}

// Annotations -------------------------------------------------------------------------------------------

export class DimensionTool extends Tool {
  constructor(app, opts) {
    super(app, opts);
    this.refs = [];
    this.dir = null;
  }

  get title() {
    return 'Aligned Dimension';
  }

  get viewKinds() {
    return ANNOTATION_VIEWS;
  }

  get prompt() {
    if (!this.refs.length) return 'Click a wall face, centerline, grid or point to start the dimension';
    if (this.refs.length === 1) return 'Click the next reference';
    return 'Click more references, or click an empty spot to place the dimension line';
  }

  refFromSnap(ev) {
    const p = this.snap(ev, null, { allowFree: false });
    const r = this.snapRes;
    if (!r || !r.kind || r.kind === 'tracking' || r.kind === 'alignment') return null;
    const ref = { at: p };
    if (r.ref?.id) {
      const el = this.doc.get(r.ref.id);
      if (el && (r.kind === 'nearest' || r.kind === 'perpendicular') && r.ref.ref && ['left', 'right', 'center'].includes(r.ref.ref)) {
        ref.id = el.id;
        ref.ref = r.ref.ref;
        ref.line = r.ref.line || r.line;
      } else if (el && r.kind === 'endpoint' && (el.kind === 'wall' || el.kind === 'grid' || el.kind === 'detailLine')) {
        if (dist(el.a, p) < 1) Object.assign(ref, { id: el.id, ref: 'a' });
        else if (dist(el.b, p) < 1) Object.assign(ref, { id: el.id, ref: 'b' });
      }
    }
    return ref;
  }

  down(ev) {
    const ref = this.refFromSnap(ev);
    if (!ref) {
      if (this.refs.length >= 2 && ev.p) return this.place(ev.p);
      return;
    }
    if (!this.refs.length) {
      this.refs.push(ref);
      if (ref.line) this.dir = norm(perp(sub(ref.line.b, ref.line.a)));
    } else {
      if (this.refs.some((r) => dist(r.at, ref.at) < 1 && r.id === ref.id && r.ref === ref.ref)) {
        if (this.refs.length >= 2) return this.place(ev.p);
        return;
      }
      if (!this.dir) {
        const d = sub(ref.at, this.refs[0].at);
        if (len(d) < 1) return;
        this.dir = ref.line ? norm(perp(sub(ref.line.b, ref.line.a))) : norm(d);
        if (dot(this.dir, d) < 0) this.dir = scale(this.dir, -1);
      }
      this.refs.push(ref);
    }
    this.app.setPrompt(this.prompt);
  }

  place(p) {
    const refs = this.refs.map(({ at, id, ref }) => (id ? { at, id, ref } : { at }));
    const dir = this.dir;
    this.app.commit('Dimension', () => this.doc.add({ kind: 'dimension', viewId: this.vc.view.id, refs, dir, line: p }));
    this.refs = [];
    this.dir = null;
    this.app.setPrompt(this.prompt);
  }

  move(ev) {
    this.cursor = ev.p;
    this.snap(ev, null, { allowFree: false });
    this.app.requestRender();
  }

  key(e) {
    if (e.key === 'Enter' && this.refs.length >= 2 && this.cursor) {
      this.place(this.cursor);
      return true;
    }
    return false;
  }

  cancel() {
    if (this.refs.length) {
      this.refs = [];
      this.dir = null;
      this.app.setPrompt(this.prompt);
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.refs.length >= 1 && this.cursor) {
      const refs = this.refs.map(({ at, id, ref }) => (id ? { at, id, ref } : { at }));
      let dir = this.dir;
      if (!dir && this.snapRes?.point) {
        const d = sub(this.snapRes.point, refs[0].at);
        if (len(d) > 1) dir = norm(d);
      }
      if (dir && refs.length >= 2) previewGraphics(this.app, vc, { id: 'preview', kind: 'dimension', viewId: vc.view.id, refs, dir, line: this.cursor }, ctx, vp.theme.preview, 0);
      for (const r of this.refs) {
        const s = vc.modelToScreen(r.at);
        ctx.fillStyle = vp.theme.preview;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        if (r.line) strokeModel(ctx, [r.line.a, r.line.b], (p) => vc.modelToScreen(p), vp.theme.preview, 2.5);
      }
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class TextTool extends Tool {
  get title() {
    return 'Text';
  }

  get viewKinds() {
    return ANNOTATION_VIEWS;
  }

  get prompt() {
    return 'Click to place text';
  }

  down(ev) {
    if (!ev.p) return;
    const at = ev.p;
    const viewId = this.vc.view.id;
    this.openInput(ev.x, ev.y, {
      label: 'Text',
      multiline: true,
      onSubmit: (v) => {
        const text = v.trim();
        if (!text) return true;
        const o = this.app.toolOptions('text', { size: 2.5 });
        this.app.commit('Text', () => this.doc.add({ kind: 'text', viewId, at, text, size: o.size, rotation: 0, align: 'left' }));
        return true;
      },
    });
  }

  options() {
    const o = this.app.toolOptions('text', { size: 2.5 });
    const s = h('select.input.sm', { 'aria-label': 'Text size' }, ...[1.8, 2.5, 3.5, 5, 7].map((v) => h('option', { value: v }, `${v} mm`)));
    s.value = String(o.size);
    s.addEventListener('change', () => (o.size = +s.value));
    return [h('div.ob-group', h('label', 'Size on paper'), s)];
  }
}

export class TagTool extends Tool {
  get title() {
    return 'Tag by Category';
  }

  get prompt() {
    return 'Click a door, window, wall or room to tag it';
  }

  target(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y)) {
      const el = this.doc.get(id);
      if (el && ['door', 'window', 'wall', 'room', 'component', 'column'].includes(el.kind)) return el;
    }
    return null;
  }

  move(ev) {
    const t = this.target(ev);
    this.app.setHover(t?.id ?? null);
  }

  down(ev) {
    const t = this.target(ev);
    if (!t) return;
    if (t.kind === 'room') {
      this.app.toast('Rooms show their name, number and area automatically. Drag the room tag to move it.');
      return;
    }
    this.app.commit('Tag', () => addTag(this.app, t, this.vc.view));
  }
}

/** Add a tag for an element in a view, offset from its anchor. */
export function addTag(app, el, view) {
  const doc = app.doc;
  let at = tagAnchor(doc, el);
  if (!at) return null;
  if (el.kind === 'door' || el.kind === 'window') {
    const host = doc.get(el.hostId);
    const ax = wallAxis(doc, host);
    const ext = (host.flipped ? -1 : 1) * (el.flipFacing ? -1 : 1);
    const off = (el.kind === 'door' ? -1 : 1) * ext * (ax.half + 4.5 * (+view.scale || 100));
    at = add(at, scale(ax.n, off));
  } else if (el.kind === 'wall') {
    const ax = wallAxis(doc, el);
    at = add(at, scale(ax.n, ax.half + 5 * (+view.scale || 100)));
  }
  if (el.kind === 'door' || el.kind === 'window') {
    if (!el.mark) doc.update(el.id, { mark: nextMark(doc, el.kind) });
  }
  return doc.add({ kind: 'tag', viewId: view.id, targetId: el.id, at, leader: false });
}

/** Tag every untagged door and window visible in the view. */
export function tagAll(app, kinds = ['door', 'window']) {
  const view = app.vc?.view;
  if (!isPlanView(view)) return app.toast('Open a floor plan to tag elements.', { kind: 'error' });
  const doc = app.doc;
  const tagged = new Set(doc.all('tag').filter((t) => t.viewId === view.id).map((t) => t.targetId));
  const pc = planContext(doc, view, app.scene.walls, app.scene.rooms);
  let n = 0;
  app.commit('Tag all', () => {
    for (const k of kinds)
      for (const el of doc.all(k)) {
        if (tagged.has(el.id)) continue;
        const host = doc.get(el.hostId);
        if (!host) continue;
        if (host.levelId !== view.levelId && !(pc.cutZ >= 0)) continue;
        if (host.levelId !== view.levelId) continue;
        if (addTag(app, el, view)) n++;
      }
  });
  app.toast(n ? `Tagged ${n} element${n === 1 ? '' : 's'}.` : 'Everything is already tagged.');
}

// Views ---------------------------------------------------------------------------------------------------

export class SectionTool extends Tool {
  constructor(app, opts) {
    super(app, opts);
    this.start = null;
  }

  get title() {
    return 'Section';
  }

  get prompt() {
    return this.start ? 'Click the end of the section line' : 'Click the start of the section line';
  }

  down(ev) {
    const p = this.snap(ev, this.start);
    if (!p) return;
    if (!this.start) {
      this.start = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    if (dist(p, this.start) < 100) return;
    const names = this.doc.all('section').map((s) => s.name);
    const name = uniqueName(names, `Section ${names.length + 1}`);
    const view = { id: newId('v'), kind: 'section', name, a: this.start, b: p, flip: false, scale: +this.vc.view.scale || 100, ...VIEW_DEFAULTS.section, depth: 8000 };
    this.app.commit('Section', () => this.doc.add(view));
    this.app.select([view.id]);
    this.start = null;
    this.app.toast(`${name} created. Double-click its marker, or use the Project Browser, to open it.`);
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
    if (this.start && this.cursor && dist(this.start, this.cursor) > 1) {
      const S = (p) => vc.modelToScreen(p);
      strokeModel(ctx, [this.start, this.cursor], S, vp.theme.preview, 2, [10, 4, 2, 4]);
      const { look } = sectionFrame({ a: this.start, b: this.cursor, flip: false });
      const m = mid(this.start, this.cursor);
      strokeModel(ctx, [m, add(m, scale(look, 30 * vc.mmPerPx()))], S, vp.theme.preview, 2);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class ElevationTool extends Tool {
  get title() {
    return 'Elevation';
  }

  get prompt() {
    return this.origin ? 'Click toward what the elevation looks at' : 'Click to place the elevation marker';
  }

  down(ev) {
    const p = this.snap(ev, this.origin);
    if (!p) return;
    if (!this.origin) {
      this.origin = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    const d = sub(p, this.origin);
    if (len(d) < 10) return;
    // Snap the look direction to multiples of 45 degrees.
    const a = Math.round(angleOf(d) / (Math.PI / 4)) * (Math.PI / 4);
    const names = this.doc.all('elevation').map((s) => s.name);
    const name = uniqueName(names, `Elevation ${names.length + 1}`);
    const view = { id: newId('v'), kind: 'elevation', name, origin: this.origin, look: a, scale: +this.vc.view.scale || 100, width: 40000, ...VIEW_DEFAULTS.elevation };
    this.app.commit('Elevation', () => this.doc.add(view));
    this.origin = null;
    this.app.toast(`${name} created.`);
  }

  move(ev) {
    this.cursor = this.snap(ev, this.origin);
    this.app.requestRender();
  }

  cancel() {
    if (this.origin) {
      this.origin = null;
      return false;
    }
    return true;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.origin && this.cursor) {
      const S = (p) => vc.modelToScreen(p);
      const a = Math.round(angleOf(sub(this.cursor, this.origin)) / (Math.PI / 4)) * (Math.PI / 4);
      strokeModel(ctx, [this.origin, add(this.origin, rotate([30 * vc.mmPerPx(), 0], a))], S, vp.theme.preview, 2);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

export class LevelTool extends Tool {
  get title() {
    return 'Level';
  }

  get viewKinds() {
    return ['elevation', 'section'];
  }

  get prompt() {
    return 'Click at the height of the new level';
  }

  move(ev) {
    this.cursor = ev.p;
    this.app.requestRender();
  }

  down(ev) {
    if (!ev.p) return;
    const inc = this.doc.units.system === 'imperial' ? 25.4 * 6 : 50;
    const z = Math.round(ev.p[1] / inc) * inc;
    createLevel(this.app, z);
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) {
      const y = vc.modelToScreen(this.cursor).y;
      ctx.save();
      ctx.strokeStyle = vp.theme.preview;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(ctx.canvas.width, y);
      ctx.stroke();
      ctx.restore();
      drawTag(ctx, vc.modelToScreen(this.cursor).x, y - 16, this.fmt(this.cursor[1]), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
  }
}

/** Create a level with its floor and ceiling plans. */
export function createLevel(app, elevation, name) {
  const doc = app.doc;
  const names = doc.levels().map((l) => l.name);
  const lvName = name || uniqueName(names, `Level ${names.length + 1}`);
  let level;
  app.commit('Level', () => {
    level = doc.add({ kind: 'level', name: lvName, elevation });
    doc.add(planView(doc, level));
    doc.add(planView(doc, level, 'ceilingPlan'));
  });
  app.toast(`${lvName} added with its floor and ceiling plans.`);
  return level;
}

