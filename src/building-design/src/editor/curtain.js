/**
 * Curtain grid tool: add or remove grid lines on a curtain wall. In plans it
 * places vertical lines where you click along the wall; in elevations and
 * sections it places vertical or horizontal lines on the wall face.
 */
import { Tool } from './tool.js';
import { add, sub, scale, dot } from '../core/geom.js';
import { wallAxis, verticalExtent } from '../core/model.js';
import { curtainGrid } from '../core/build3d.js';
import { viewFrame } from '../core/elevation.js';
import { strokeModel, drawTag } from '../views/overlay.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { PLAN_VIEW_KINDS } from '../core/doc.js';

export class CurtainGridTool extends Tool {
  get title() {
    return 'Curtain Grid';
  }

  get viewKinds() {
    return [...PLAN_VIEW_KINDS, 'elevation', 'section'];
  }

  get o() {
    return this.app.toolOptions('curtainGrid', { dir: 'vertical', remove: false });
  }

  get prompt() {
    if (this.o.remove) return 'Click a grid line of a curtain wall to remove it';
    return this.vc?.is2D || this.o.dir === 'vertical' ? 'Click on a curtain wall to add a vertical grid line' : 'Click on a curtain wall to add a horizontal grid line';
  }

  options() {
    const o = this.o;
    const seg = (value, label, ic) =>
      h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(o.dir === value && !o.remove), 'data-tip': label, onClick: () => ((o.dir = value), (o.remove = false), this.refresh()) }, icon(ic, 15), h('span', label));
    return [
      h(
        'div.seg',
        { role: 'radiogroup', 'aria-label': 'Grid line' },
        seg('vertical', 'Vertical', 'curtainGrid'),
        this.vc?.is2D ? null : seg('horizontal', 'Horizontal', 'curtainWall'),
        h('button.seg-btn', { type: 'button', role: 'radio', 'aria-checked': String(!!o.remove), onClick: () => ((o.remove = true), this.refresh()) }, icon('minus', 15), h('span', 'Remove')),
      ),
      h('button.btn.sm', { type: 'button', onClick: () => this.reset() }, icon('refresh', 14), 'Reset to type'),
    ];
  }

  refresh() {
    this.app.renderOptions();
    this.app.setPrompt(this.prompt);
  }

  /** The curtain wall under the pointer and the pointer's position on it (u along, z up from base). */
  locate(ev) {
    if (!ev.p) return null;
    const vc = this.vc;
    for (const id of vc.hitTest(ev.x, ev.y, 10)) {
      const w = this.doc.get(id);
      const type = w?.kind === 'wall' ? this.doc.get(w.typeId) : null;
      if (!type?.curtain) continue;
      const ax = wallAxis(this.doc, w);
      const { base, top } = verticalExtent(this.doc, w);
      let u;
      let z = null;
      if (vc.is2D) u = dot(sub(ev.p, ax.a), ax.dir);
      else {
        const f = viewFrame(vc.view);
        const k = dot(ax.dir, f.right);
        if (Math.abs(k) < 0.2) continue;
        u = (ev.p[0] - dot(sub(ax.a, f.origin), f.right)) / k;
        z = ev.p[1] - base;
      }
      u = Math.max(0, Math.min(ax.length, u));
      return { w, type, ax, base, top, u, z, H: top - base, grid: curtainGrid(ax.length, top - base, type, w) };
    }
    return null;
  }

  /** The grid line nearest to the pointer, within a few pixels. */
  nearestLine(loc) {
    const tol = 10 * this.vc.mmPerPx();
    let best = null;
    const consider = (dir, i, d) => {
      if (d < tol && (!best || d < best.d)) best = { dir, i, d };
    };
    loc.grid.us.forEach((u, i) => i > 0 && i < loc.grid.us.length - 1 && consider('vertical', i, Math.abs(u - loc.u)));
    if (loc.z != null) loc.grid.vs.forEach((v, i) => i > 0 && i < loc.grid.vs.length - 1 && consider('horizontal', i, Math.abs(v - loc.z)));
    return best;
  }

  move(ev) {
    this.cur = this.locate(ev);
    this.app.setHover(this.cur?.w.id ?? null);
    this.app.requestRender();
  }

  down(ev) {
    const loc = this.locate(ev);
    if (!loc) return this.app.setPrompt('Click on a curtain wall');
    const { w, grid } = loc;
    const inner = (list) => list.slice(1, -1);
    if (this.o.remove) {
      const line = this.nearestLine(loc);
      if (!line) return this.app.setPrompt('No grid line there. Click closer to a line.');
      const key = line.dir === 'vertical' ? 'curtainU' : 'curtainV';
      const list = inner(line.dir === 'vertical' ? grid.us : grid.vs).filter((_, i) => i !== line.i - 1);
      // An empty list would fall back to the type layout: keep a single panel instead.
      this.app.commit('Remove grid line', () => this.doc.update(w.id, { [key]: list.length ? list : [-1] }));
      return;
    }
    const horizontal = this.o.dir === 'horizontal' && loc.z != null;
    const at = Math.round(horizontal ? loc.z : loc.u);
    const span = horizontal ? loc.H : loc.ax.length;
    if (at < 50 || at > span - 50) return;
    const key = horizontal ? 'curtainV' : 'curtainU';
    const list = inner(horizontal ? grid.vs : grid.us);
    if (list.some((x) => Math.abs(x - at) < 20)) return;
    this.app.commit('Add grid line', () => this.doc.update(w.id, { [key]: [...list, at].sort((a, b) => a - b) }));
  }

  reset() {
    const ids = [...this.app.selection].filter((id) => this.doc.get(id)?.kind === 'wall');
    const target = ids.length ? ids : this.cur ? [this.cur.w.id] : [];
    if (!target.length) return this.app.toast('Select or point at a curtain wall to reset its grid.', { kind: 'error' });
    this.app.commit('Reset curtain grid', () => target.forEach((id) => this.doc.update(id, { curtainU: null, curtainV: null })));
  }

  drawOverlay(ctx, vc, vp) {
    const loc = this.cur;
    if (!loc) return;
    const color = this.o.remove ? '#d33' : vp.theme.preview;
    const S = (p) => vc.modelToScreen(p);
    const { ax } = loc;
    if (vc.is2D) {
      const line = this.o.remove ? this.nearestLine(loc) : null;
      const u = line ? loc.grid.us[line.i] : loc.u;
      const c = add(ax.a, scale(ax.dir, u));
      strokeModel(ctx, [add(c, scale(ax.n, -ax.half - 200)), add(c, scale(ax.n, ax.half + 200))], S, color, 2);
      const s = S(c);
      drawTag(ctx, s.x + 16, s.y - 18, this.fmt(u), { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: color });
      return;
    }
    const f = viewFrame(vc.view);
    const toView = (u) => dot(sub(add(ax.a, scale(ax.dir, u)), f.origin), f.right);
    const line = this.o.remove ? this.nearestLine(loc) : null;
    if ((line?.dir ?? this.o.dir) === 'vertical' || loc.z == null) {
      const uu = toView(line ? loc.grid.us[line.i] : loc.u);
      strokeModel(ctx, [[uu, loc.base], [uu, loc.top]], S, color, 2);
    } else {
      const z = loc.base + (line ? loc.grid.vs[line.i] : loc.z);
      strokeModel(ctx, [[toView(0), z], [toView(ax.length), z]], S, color, 2);
    }
  }
}
