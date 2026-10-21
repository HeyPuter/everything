/**
 * The default tool: highlight on hover, pick, window (left to right) and
 * crossing (right to left) selection, Tab to cycle overlapping elements,
 * drag to move, grips, and double-click to edit or open.
 */
import { Tool } from './tool.js';
import { gripsFor } from './grips.js';
import { drawGrip, drawFlipArrows } from '../views/overlay.js';
import { sub, eq, add } from '../core/geom.js';
import { transformPatch, translation, expandGroups } from '../core/ops.js';
import { wallAxis } from '../core/model.js';
import { dot } from '../core/geom.js';

const DRAG_PX = 5;

export class SelectTool extends Tool {
  get title() {
    return 'Modify';
  }

  get prompt() {
    const n = this.app.selection.size;
    if (this.drag?.kind === 'box') return this.drag.crossing ? 'Crossing selection: everything the box touches' : 'Window selection: everything fully inside the box';
    if (n) return 'Drag to move. Use grips to edit. Press Delete to remove, Esc to clear the selection.';
    return 'Click to select, drag a box to select several. Tab cycles overlapping elements.';
  }

  get viewKinds() {
    return null;
  }

  start() {
    this.drag = null;
    this.cands = [];
    this.candIdx = 0;
  }

  grips() {
    const vc = this.vc;
    if (!vc) return [];
    const out = sectionBoxGrips(this.app, vc);
    if (this.app.selection.size !== 1) return out;
    const id = [...this.app.selection][0];
    const el = this.doc.get(id);
    if (!el || el.pinned) return out;
    return out.concat(gripsFor(this.app, el, vc).filter((g) => g.at));
  }

  gripAt(x, y) {
    const vc = this.vc;
    for (const g of this.grips()) {
      const s = vc.modelToScreen(g.at);
      if (Math.hypot(s.x - x, s.y - y) <= (g.shape === 'flip' ? 14 : 9)) return g;
    }
    return null;
  }

  down(ev) {
    const vc = this.vc;
    if (!vc) return;
    const td = this.app.tempDimAt(ev.x, ev.y);
    if (td) {
      this.app.editTempDim(td, ev);
      return;
    }
    const grip = this.gripAt(ev.x, ev.y);
    if (grip) {
      if (grip.click) {
        grip.click();
        return;
      }
      this.drag = { kind: 'grip', grip, x: ev.x, y: ev.y, started: false };
      return;
    }
    const hits = this.app.pickTargets(vc.hitTest(ev.x, ev.y));
    const hit = hits.length ? (this.cands.length && this.cands[this.candIdx] && hits.includes(this.cands[this.candIdx]) ? this.cands[this.candIdx] : hits[0]) : null;
    if (hit) {
      const sel = this.app.selection;
      if (ev.ctrl) this.app.select([hit], sel.has(hit) ? 'remove' : 'add');
      else if (ev.shift) this.app.select([hit], 'remove');
      else if (!sel.has(hit)) this.app.select([hit]);
      this.drag = { kind: 'move', x: ev.x, y: ev.y, p: ev.p, started: false, hit };
      return;
    }
    this.drag = { kind: 'box', x: ev.x, y: ev.y, x2: ev.x, y2: ev.y, p: ev.p, started: false, additive: ev.ctrl, subtract: ev.shift };
  }

  move(ev) {
    const vc = this.vc;
    if (!vc) return;
    const d = this.drag;
    if (!d) {
      this.hover(ev);
      return;
    }
    if (!d.started && Math.hypot(ev.x - d.x, ev.y - d.y) < DRAG_PX) return;
    if (!d.started) {
      d.started = true;
      if (d.kind === 'move') this.beginMove(d);
      if (d.kind === 'grip') {
        this.doc.begin('Edit');
      }
    }
    if (d.kind === 'box') {
      d.x2 = ev.x;
      d.y2 = ev.y;
      d.crossing = ev.x < d.x;
      this.app.setPrompt(this.prompt);
      this.app.requestRender();
    } else if (d.kind === 'move') this.updateMove(ev);
    else if (d.kind === 'grip' && d.grip.drag3d) {
      d.grip.drag3d(ev, d);
      this.doc.flush();
      this.app.requestRender();
    } else if (d.kind === 'grip') {
      const p = d.grip.noSnap || !vc.is2D ? ev.p : this.snap(ev, null, { exclude: new Set(d.grip.exclude || []) });
      if (!p) return;
      try {
        d.grip.drag(p, ev);
        this.doc.flush();
      } catch (err) {
        console.warn(err);
      }
      this.app.requestRender();
    }
  }

  hover(ev) {
    const vc = this.vc;
    const grip = this.gripAt(ev.x, ev.y);
    this.app.shell.canvasWrap.style.cursor = grip ? (grip.click ? 'pointer' : 'move') : '';
    const hits = this.app.pickTargets(vc.hitTest(ev.x, ev.y));
    if (hits.join() !== this.cands.join()) {
      this.cands = hits;
      this.candIdx = 0;
    }
    this.app.setHover(this.cands[this.candIdx] ?? null);
    this.lastPos = { x: ev.x, y: ev.y };
  }

  beginMove(d) {
    const sel = [...expandGroups(this.doc, this.app.selection)].map((id) => this.doc.get(id)).filter((el) => el && !el.pinned && el.kind !== 'level' && el.id !== 'project');
    // Elevations and sections can move their own annotations, not the model.
    if (!sel.length || (!this.vc.is2D && !sel.every((el) => el.viewId))) {
      d.kind = 'none';
      return;
    }
    const ids = new Set(sel.map((e) => e.id));
    // Hosted elements of moving walls ride along; move them only alone.
    const originals = sel.filter((el) => !(el.hostId && ids.has(el.hostId)));
    // Other walls whose ends touch a moving wall's ends stretch with it.
    const stretch = [];
    for (const w of originals) {
      if (w.kind !== 'wall') continue;
      for (const o of this.doc.all('wall')) {
        if (ids.has(o.id)) continue;
        for (const end of ['a', 'b']) if (eq(o[end], w.a, 1) || eq(o[end], w.b, 1)) stretch.push({ id: o.id, end, from: o[end] });
      }
    }
    d.originals = originals;
    d.stretch = stretch;
    d.exclude = new Set([...ids, ...stretch.map((s) => s.id)]);
    d.base = this.snap({ ...d, p: d.p, shift: false, alt: false }, null, { exclude: d.exclude }) || d.p;
    this.doc.begin('Move');
  }

  updateMove(ev) {
    const d = this.drag;
    if (!d.originals) return;
    const p = this.snap(ev, d.base, { exclude: d.exclude });
    if (!p) return;
    const delta = sub(p, d.base);
    const xf = translation(delta);
    for (const el of d.originals) {
      if (el.hostId) {
        // Slide along the host, or jump to another wall under the cursor.
        const host = this.doc.get(el.hostId);
        if (!host) continue;
        const ax = wallAxis(this.doc, host);
        const c = add(ax.a, [ax.dir[0] * el.t, ax.dir[1] * el.t]);
        const q = add(c, delta);
        const t = Math.max(0, Math.min(ax.length, dot(sub(q, ax.a), ax.dir)));
        const other = d.originals.length === 1 ? this.wallUnder(ev, host.id) : null;
        if (other) {
          const ax2 = wallAxis(this.doc, other);
          const t2 = Math.max(0, Math.min(ax2.length, dot(sub(ev.p, ax2.a), ax2.dir)));
          this.doc.update(el.id, { hostId: other.id, t: t2 });
        } else this.doc.update(el.id, { hostId: el.hostId, t });
        continue;
      }
      this.doc.update(el.id, transformPatch(el, xf));
    }
    for (const s of d.stretch) this.doc.update(s.id, { [s.end]: add(s.from, delta) });
    this.doc.flush();
    d.delta = delta;
    this.app.requestRender();
  }

  wallUnder(ev, except) {
    const hits = this.vc.hitTest(ev.x, ev.y, 4);
    for (const id of hits) {
      const el = this.doc.get(id);
      if (el?.kind === 'wall' && id !== except) return el;
    }
    return null;
  }

  up(ev) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.app.requestRender();
    const vc = this.vc;
    if (d.kind === 'box') {
      if (!d.started) {
        if (!d.additive && !d.subtract) this.app.select([]);
        return;
      }
      let ids;
      const crossing = d.x2 < d.x;
      if (vc.is2D) {
        const a = vc.screenToModel(Math.min(d.x, d.x2), Math.max(d.y, d.y2));
        const b = vc.screenToModel(Math.max(d.x, d.x2), Math.min(d.y, d.y2));
        ids = vc.boxSelect({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] }, crossing);
      } else ids = vc.boxSelectScreen({ x0: Math.min(d.x, d.x2), y0: Math.min(d.y, d.y2), x1: Math.max(d.x, d.x2), y1: Math.max(d.y, d.y2) }, crossing);
      this.app.select(this.app.pickTargets(ids), d.subtract ? 'remove' : d.additive ? 'add' : 'replace');
      this.app.setPrompt(this.prompt);
      this.app.requestRender();
      return;
    }
    if (d.kind === 'move') {
      if (!d.started) {
        // A plain click on an element of a multi-selection keeps only it.
        if (!ev?.ctrl && !ev?.shift && this.app.selection.size > 1) this.app.select([d.hit]);
        return;
      }
      if (d.originals && this.doc.inTransaction) {
        if (!d.delta || (Math.abs(d.delta[0]) < 1e-6 && Math.abs(d.delta[1]) < 1e-6)) this.doc.rollback();
        else this.doc.commit();
      }
      this.snapRes = null;
      return;
    }
    if (d.kind === 'grip') {
      if (this.doc.inTransaction) this.doc.commit();
      this.snapRes = null;
      this.app.refreshSelection();
    }
  }

  cancelGesture() {
    if (this.doc.inTransaction) this.doc.rollback();
    this.drag = null;
  }

  dblclick(ev) {
    const vc = this.vc;
    const hits = this.app.pickTargets(vc.hitTest(ev.x, ev.y));
    const id = hits[0];
    if (!id) {
      if (!vc.is2D) vc.zoomExtents?.();
      return;
    }
    this.app.editElement(id, ev);
  }

  key(e) {
    if (e.key === 'Tab' && this.cands.length > 1) {
      e.preventDefault();
      this.candIdx = (this.candIdx + (e.shiftKey ? this.cands.length - 1 : 1)) % this.cands.length;
      this.app.setHover(this.cands[this.candIdx]);
      const el = this.doc.get(this.cands[this.candIdx]);
      this.app.setPrompt(`${this.app.describe(el)} (${this.candIdx + 1} of ${this.cands.length}). Click to select.`);
      return true;
    }
    if (e.key === 'Escape') {
      if (this.drag) {
        this.cancelGesture();
        return true;
      }
      if (this.app.selection.size) {
        this.app.select([]);
        return true;
      }
    }
    if (e.key.startsWith('Arrow') && this.app.selection.size && this.vc?.is2D && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * this.vc.mmPerPx() * 4;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      this.app.nudge(d);
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    const d = this.drag;
    if (d?.kind === 'box' && d.started) {
      ctx.save();
      const crossing = d.x2 < d.x;
      ctx.strokeStyle = vp.theme.selCss;
      ctx.fillStyle = vp.theme.selCss;
      ctx.globalAlpha = 0.08;
      ctx.fillRect(Math.min(d.x, d.x2), Math.min(d.y, d.y2), Math.abs(d.x2 - d.x), Math.abs(d.y2 - d.y));
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      if (crossing) ctx.setLineDash([5, 4]);
      ctx.strokeRect(Math.min(d.x, d.x2) + 0.5, Math.min(d.y, d.y2) + 0.5, Math.abs(d.x2 - d.x), Math.abs(d.y2 - d.y));
      ctx.restore();
    }
    if (!d || d.kind !== 'move') {
      for (const g of this.grips()) {
        const s = vc.modelToScreen(g.at);
        if (g.shape === 'flip') drawFlipArrows(ctx, s, -(g.angle || 0), vp.theme.selCss);
        else drawGrip(ctx, s, vp.theme.selCss, g.shape, d?.grip === g);
      }
    }
    this.drawSnap(ctx, vc, vp);
  }
}

/** Face handles of a 3D view's section box: drag along the face normal. */
function sectionBoxGrips(app, vc) {
  if (!vc.is3D) return [];
  const view = vc.view;
  const sb = view?.sectionBox;
  if (!sb) return [];
  const c = [(sb.min[0] + sb.max[0]) / 2, (sb.min[1] + sb.max[1]) / 2, (sb.min[2] + sb.max[2]) / 2];
  const out = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of ['min', 'max']) {
      const at = c.slice();
      at[axis] = sb[side][axis];
      out.push({
        at,
        shape: 'diamond',
        title: 'Drag to resize the section box',
        drag3d: (ev, d) => {
          if (!d.box) {
            d.box = structuredClone(sb);
            const s0 = vc.project3(at);
            const tip = at.slice();
            tip[axis] += 1000;
            const s1 = vc.project3(tip);
            const len = Math.hypot(s1.x - s0.x, s1.y - s0.y) || 1;
            d.axisDir = [(s1.x - s0.x) / len, (s1.y - s0.y) / len];
            d.pxPerMm = len / 1000;
          }
          const delta = ((ev.x - d.x) * d.axisDir[0] + (ev.y - d.y) * d.axisDir[1]) / d.pxPerMm;
          const box = structuredClone(d.box);
          box[side][axis] = d.box[side][axis] + delta;
          if (box.max[axis] - box.min[axis] < 100) return;
          app.doc.update(view.id, { sectionBox: box });
        },
      });
    }
  return out;
}

