/**
 * Placing wall sweeps and reveals: move over a wall (the side the cursor is
 * on is the face) and click; the profile runs the full length of the wall
 * at the height in the options bar.
 */
import { Tool } from './tool.js';
import { h } from '../ui/dom.js';
import { wallAxis } from '../core/model.js';
import { add, sub, scale, dot } from '../core/geom.js';
import { strokeModel } from '../views/overlay.js';
import { formatLength, parseLength } from '../core/units.js';

export class WallSweepTool extends Tool {
  get title() {
    return this.opts.reveal ? 'Wall Reveal' : 'Wall Sweep';
  }

  get placingKind() {
    return 'wallSweep';
  }

  get o() {
    const imp = this.doc.units.system === 'imperial';
    return this.app.toolOptions(this.opts.reveal ? 'wallReveal' : 'wallSweep', { z: this.opts.reveal ? (imp ? 36 * 25.4 : 900) : imp ? 108 * 25.4 : 2750 });
  }

  get type() {
    const cur = this.app.currentType('wallSweep');
    if (cur && !!cur.reveal === !!this.opts.reveal) return cur;
    return this.doc.all('wallSweepType').find((t) => !!t.reveal === !!this.opts.reveal) || null;
  }

  get prompt() {
    return `Click a wall face to add a ${this.opts.reveal ? 'reveal' : 'sweep'} along it. The side you point at is the face it goes on.`;
  }

  hit(ev) {
    if (!ev.p) return null;
    for (const id of this.vc.hitTest(ev.x, ev.y, 6)) {
      const w = this.doc.get(id);
      if (w?.kind !== 'wall') continue;
      const ax = wallAxis(this.doc, w);
      const side = dot(sub(ev.p, ax.a), ax.ext) >= 0 ? 'exterior' : 'interior';
      return { wall: w, ax, side };
    }
    return null;
  }

  move(ev) {
    this.cand = this.hit(ev);
    this.app.setHover(this.cand?.wall.id ?? null);
    this.app.requestRender();
  }

  down(ev) {
    const c = this.hit(ev);
    if (!c) return;
    const type = this.type;
    if (!type) return this.app.toast('This project has no sweep types.', { kind: 'error' });
    const dup = this.doc.all('wallSweep').some((s) => s.wallId === c.wall.id && s.side === c.side && s.typeId === type.id && Math.abs((+s.z || 0) - this.o.z) < 1);
    if (dup) return this.app.toast(`That face already has this ${this.opts.reveal ? 'reveal' : 'sweep'} at this height.`);
    this.app.commit(this.title, () => this.doc.add({ kind: 'wallSweep', wallId: c.wall.id, typeId: type.id, side: c.side, z: this.o.z }));
  }

  options() {
    const o = this.o;
    const units = this.doc.units;
    const inp = h('input.input.sm', { type: 'text', value: formatLength(o.z, units), 'aria-label': 'Height above the wall base', style: { width: '90px' } });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const v = parseLength(inp.value, units);
      if (Number.isFinite(v)) o.z = v;
      inp.value = formatLength(o.z, units);
    });
    return [h('div.ob-group', h('label', 'Height'), inp)];
  }

  drawOverlay(ctx, vc, vp) {
    const c = this.cand;
    if (!c) return;
    const n = c.side === 'exterior' ? c.ax.ext : scale(c.ax.ext, -1);
    const off = scale(n, c.ax.half + 30);
    const S = (p) => vc.modelToScreen(p);
    strokeModel(ctx, [add(c.ax.a, off), add(c.ax.b, off)], S, vp.theme.preview, 3, null, false);
  }
}
