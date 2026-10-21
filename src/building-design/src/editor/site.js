/**
 * Structure and site tools: isolated and wall foundations, beam systems,
 * toposurfaces, and model by face (walls, floors and roofs from a mass).
 */
import { Tool } from './tool.js';
import { previewGraphics } from './draw.js';
import { strokeModel, drawTag } from '../views/overlay.js';
import { rectPolygon, dist, signedArea } from '../core/geom.js';
import { clipLine } from '../core/plan.js';
import { delaunay, topoHeightAt } from '../core/topo.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { MM_PER_FOOT } from '../core/units.js';
import { massLevels } from '../core/massing.js';

function lengthInput(tool, label, value, onChange) {
  const input = h('input.input.sm.num', { type: 'text', value: tool.fmt(value), 'aria-label': label });
  input.addEventListener('change', () => {
    const v = tool.parseLen(input.value);
    if (Number.isFinite(v)) onChange(v);
    input.value = tool.fmt(Number.isFinite(v) ? v : value);
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div.ob-group', h('label', label), input);
}

// Foundations ----------------------------------------------------------------------------------

export class FootingTool extends Tool {
  get placingKind() {
    return 'footing';
  }

  get title() {
    return 'Isolated Foundation';
  }

  get prompt() {
    return 'Click to place a footing (it snaps to columns). Space rotates it. Or place footings under every column.';
  }

  options() {
    return [h('button.btn.sm', { type: 'button', onClick: () => this.atColumns() }, icon('columnStructural', 14), 'At columns')];
  }

  make(p) {
    return { kind: 'footing', typeId: this.app.currentType('footing')?.id, levelId: this.app.activeLevelId(), at: p, rotation: this.rot || 0, offset: 0 };
  }

  down(ev) {
    const p = this.snap(ev);
    if (p) this.app.commit('Footing', () => this.doc.add(this.make(p)));
  }

  /** A footing under every column (selected ones, or all on this level) that has none. */
  atColumns() {
    const levelId = this.app.activeLevelId();
    const sel = [...this.app.selection].map((id) => this.doc.get(id)).filter((e) => e?.kind === 'column');
    const cols = sel.length ? sel : this.doc.all('column').filter((c) => c.levelId === levelId);
    const taken = this.doc.all('footing').map((f) => f.at);
    let n = 0;
    this.app.commit('Footings at columns', () => {
      for (const c of cols) {
        if (taken.some((p) => dist(p, c.at) < 10)) continue;
        this.doc.add({ ...this.make(c.at), levelId: c.levelId, rotation: c.rotation || 0 });
        n++;
      }
    });
    this.app.toast(n ? `Placed ${n} footing${n === 1 ? '' : 's'}.` : 'Every column already has a footing.');
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      this.rot = ((this.rot || 0) + 90) % 360;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) previewGraphics(this.app, vc, { id: 'preview', ...this.make(this.cursor) }, ctx, vp.theme.preview, 0.12);
    this.drawSnap(ctx, vc, vp);
  }
}

export class WallFootingTool extends Tool {
  get placingKind() {
    return 'wallFooting';
  }

  get title() {
    return 'Wall Foundation';
  }

  get prompt() {
    return 'Click walls to put a foundation under them';
  }

  wall(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y, 8)) {
      const el = this.doc.get(id);
      if (el?.kind === 'wall') return el;
    }
    return null;
  }

  move(ev) {
    this.app.setHover(this.wall(ev)?.id ?? null);
  }

  down(ev) {
    const w = this.wall(ev);
    if (!w) return;
    if (this.doc.all('wallFooting').some((f) => f.wallId === w.id)) return this.app.toast('That wall already has a foundation.', { kind: 'error' });
    this.app.commit('Wall foundation', () => this.doc.add({ kind: 'wallFooting', typeId: this.app.currentType('wallFooting')?.id, wallId: w.id }));
  }
}

// Beam systems -----------------------------------------------------------------------------------

export class BeamSystemTool extends Tool {
  get placingKind() {
    return 'beam';
  }

  get title() {
    return 'Beam System';
  }

  get o() {
    const imp = this.doc.units.system === 'imperial';
    return this.app.toolOptions('beamSystem', { spacing: imp ? 4 * MM_PER_FOOT : 1200, along: 'x', mode: 'rect' });
  }

  get prompt() {
    if (this.o.mode === 'floor') return 'Click a floor to fill it with beams';
    return this.start ? 'Click the opposite corner of the area' : 'Click a corner of the area to fill with beams';
  }

  options() {
    const o = this.o;
    const seg = (items, cur, pick, label) =>
      h('div.seg', { role: 'radiogroup', 'aria-label': label }, ...items.map((it) => h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(it.value === cur), onClick: () => (pick(it.value), this.app.renderOptions(), this.app.setPrompt(this.prompt)) }, h('span', it.label))));
    return [
      seg(
        [
          { value: 'rect', label: 'Rectangle' },
          { value: 'floor', label: 'Pick floor' },
        ],
        o.mode,
        (v) => ((o.mode = v), (this.start = null)),
        'Area',
      ),
      lengthInput(this, 'Spacing', o.spacing, (v) => (o.spacing = Math.max(100, v))),
      seg(
        [
          { value: 'x', label: 'Span east-west' },
          { value: 'y', label: 'Span north-south' },
        ],
        o.along,
        (v) => (o.along = v),
        'Direction',
      ),
    ];
  }

  /** Beam lines inside an outline at the spacing, spanning along x or y. */
  lines(poly) {
    const o = this.o;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of poly) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
    const out = [];
    const s = o.spacing;
    if (o.along === 'x') for (let y = y0 + s / 2; y < y1; y += s) out.push(...clipLine([x0 - 1, y], [x1 + 1, y], poly));
    else for (let x = x0 + s / 2; x < x1; x += s) out.push(...clipLine([x, y0 - 1], [x, y1 + 1], poly));
    return out.filter(([a, b]) => dist(a, b) > 100);
  }

  fill(poly) {
    const lines = this.lines(poly);
    const type = this.app.currentType('beam');
    const levelId = this.app.activeLevelId();
    this.app.commit('Beam system', () => lines.forEach(([a, b]) => this.doc.add({ kind: 'beam', typeId: type?.id, levelId, a, b, offset: 0 })));
    this.app.toast(`Placed ${lines.length} beam${lines.length === 1 ? '' : 's'}.`);
  }

  down(ev) {
    if (this.o.mode === 'floor') {
      const f = this.vc.hitTest(ev.x, ev.y, 8).map((id) => this.doc.get(id)).find((e) => e?.kind === 'floor');
      if (!f) return this.app.setPrompt('Click inside or on the edge of a floor');
      return this.fill(f.boundary);
    }
    const p = this.snap(ev, this.start);
    if (!p) return;
    if (!this.start) {
      this.start = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    const r = rectPolygon(this.start, p);
    this.start = null;
    if (Math.abs(signedArea(r)) < 1e5) return;
    this.fill(r);
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
    const S = (p) => vc.modelToScreen(p);
    if (this.start && this.cursor) {
      const r = rectPolygon(this.start, this.cursor);
      strokeModel(ctx, r, S, vp.theme.preview, 1.5, [6, 4], true);
      for (const [a, b] of this.lines(r)) strokeModel(ctx, [a, b], S, vp.theme.preview, 1.2);
    }
    this.drawSnap(ctx, vc, vp);
  }
}

// Topography -----------------------------------------------------------------------------------

export class TopoTool extends Tool {
  get title() {
    return 'Toposurface';
  }

  get prompt() {
    return this.pts.length < 3 ? 'Click to place points at the elevation in the options bar (at least three)' : 'Keep placing points, then click Finish';
  }

  get o() {
    return this.app.toolOptions('topo', { z: 0 });
  }

  start() {
    this.pts = [];
  }

  options() {
    const o = this.o;
    return [
      lengthInput(this, 'Elevation', o.z, (v) => (o.z = v)),
      h('span.ob-label', `${this.pts?.length || 0} points`),
      h(
        'div.ob-actions',
        h('button.btn.sm.primary', { type: 'button', onClick: () => this.finish() }, icon('finish', 14), 'Finish'),
        h('button.btn.sm', { type: 'button', onClick: () => this.app.cancelTool() }, icon('cancel', 14), 'Cancel'),
      ),
    ];
  }

  down(ev) {
    const p = this.snap(ev);
    if (!p) return;
    this.pts.push([p[0], p[1], this.o.z]);
    this.app.renderOptions();
    this.app.setPrompt(this.prompt);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.finish();
      return true;
    }
    if (e.key === 'Backspace' && this.pts.length) {
      e.preventDefault();
      this.pts.pop();
      this.app.renderOptions();
      this.app.requestRender();
      return true;
    }
    return false;
  }

  finish() {
    if (this.pts.length < 3 || !delaunay(this.pts).length) return this.app.toast('Place at least three points that are not in a line.', { kind: 'error' });
    const imp = this.doc.units.system === 'imperial';
    this.app.commit('Toposurface', () => this.doc.add({ kind: 'topo', points: this.pts, thickness: imp ? 3 * MM_PER_FOOT : 1000, contour: imp ? MM_PER_FOOT : 500, materialId: 'mat-earth' }));
    this.app.cancelTool();
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  drawOverlay(ctx, vc, vp) {
    const S = (p) => vc.modelToScreen(p);
    const tris = this.pts.length >= 3 ? delaunay(this.pts) : [];
    for (const [i, j, k] of tris) strokeModel(ctx, [this.pts[i], this.pts[j], this.pts[k]], S, vp.theme.preview, 1, [4, 3], true);
    for (const p of this.pts) {
      const s = S(p);
      ctx.fillStyle = vp.theme.preview;
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
      drawTag(ctx, s.x, s.y - 16, this.fmt(p[2]), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview });
    }
    this.drawSnap(ctx, vc, vp);
  }
}

/** Ground elevation of the project's toposurfaces at a point (or null). */
export function groundAt(doc, p) {
  for (const t of doc.all('topo')) {
    const z = topoHeightAt(t, p);
    if (z != null) return z;
  }
  return null;
}

// Model by face --------------------------------------------------------------------------------

function massUnder(app, ev) {
  for (const id of app.vc.hitTest(ev.x, ev.y, 8)) {
    const el = app.doc.get(id);
    if (el?.kind === 'mass') return el;
  }
  return null;
}

/** Walls, floors, curtain walls or a roof from the faces of a mass. */
export function byFace(app, mass, what) {
  const doc = app.doc;
  const levels = massLevels(doc, mass);
  const base = (doc.get(mass.levelId)?.elevation ?? 0) + (+mass.baseOffset || 0);
  const top = base + (+mass.height || 10000);
  const loop = signedArea(mass.boundary) < 0 ? mass.boundary.slice().reverse() : mass.boundary.slice();
  let n = 0;
  app.commit(`${what === 'roof' ? 'Roof' : what === 'floor' ? 'Floors' : 'Walls'} by face`, () => {
    if (what === 'floor') {
      for (const l of levels) {
        doc.add({ kind: 'floor', typeId: app.currentType('floor')?.id, levelId: l.id, boundary: loop, holes: [], offset: 0, massId: mass.id });
        n++;
      }
      return;
    }
    if (what === 'roof') {
      const lv = doc.levels().filter((l) => l.elevation <= top + 1).at(-1) || doc.levels()[0];
      doc.add({ kind: 'roof', typeId: app.currentType('roof')?.id, levelId: lv.id, boundary: loop, slopes: loop.map(() => null), baseOffset: top - lv.elevation, massId: mass.id });
      n = 1;
      return;
    }
    // Walls: one per edge per level, running up to the next level or the top of the mass.
    const curtain = what === 'curtain' ? doc.all('wallType').find((t) => t.curtain) : null;
    const typeId = curtain?.id || app.currentType('wall')?.id;
    levels.forEach((l, i) => {
      const next = levels[i + 1];
      for (let k = 0; k < loop.length; k++) {
        // Clockwise walls put their exterior face outside the mass.
        const a = loop[(k + 1) % loop.length];
        const b = loop[k];
        doc.add({ kind: 'wall', typeId, levelId: l.id, a, b, baseOffset: 0, topLevelId: next?.id ?? null, topOffset: 0, height: next ? next.elevation - l.elevation : top - l.elevation, locationLine: 'exterior', flipped: false, roomBounding: true, joinA: true, joinB: true, mark: '', comments: '', massId: mass.id });
        n++;
      }
    });
  });
  app.toast(n ? `Created ${n} element${n === 1 ? '' : 's'} from the mass.` : 'No levels cross the mass. Add levels within its height first.', { kind: n ? 'success' : 'error' });
}

export class ByFaceTool extends Tool {
  get title() {
    return { wall: 'Wall by Face', floor: 'Floor by Face', roof: 'Roof by Face', curtain: 'Curtain System by Face' }[this.opts.what];
  }

  get prompt() {
    return 'Click a mass';
  }

  move(ev) {
    this.app.setHover(massUnder(this.app, ev)?.id ?? null);
  }

  down(ev) {
    const m = massUnder(this.app, ev);
    if (!m) return this.app.setPrompt('Click on a mass (create one with In-Place Mass)');
    byFace(this.app, m, this.opts.what);
    this.app.cancelTool();
  }
}
