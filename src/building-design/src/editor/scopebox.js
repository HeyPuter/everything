/**
 * Drawing a scope box: two opposite corners in a plan. It spans from the
 * plan's level to the level above (or the top of the model).
 */
import { Tool } from './tool.js';
import { strokeModel } from '../views/overlay.js';
import { PLAN_VIEW_KINDS } from '../core/doc.js';
import { uniqueName } from '../core/ops.js';

export class ScopeBoxTool extends Tool {
  get title() {
    return 'Scope Box';
  }

  get viewKinds() {
    return PLAN_VIEW_KINDS;
  }

  get prompt() {
    return this.first ? 'Click the opposite corner' : 'Click the first corner of the scope box';
  }

  down(ev) {
    const p = this.snap(ev);
    if (!p) return;
    if (!this.first) {
      this.first = p;
      this.app.setPrompt(this.prompt);
      return;
    }
    const a = this.first;
    this.first = null;
    if (Math.abs(p[0] - a[0]) < 100 || Math.abs(p[1] - a[1]) < 100) return this.app.toast('Draw a larger box.');
    const doc = this.doc;
    const levels = doc.levels();
    const lv = doc.get(this.vc.view.levelId);
    const top = levels.at(-1)?.elevation ?? 0;
    let box;
    this.app.commit('Scope box', () => {
      box = doc.add({ kind: 'scopeBox', name: uniqueName(doc.all('scopeBox').map((s) => s.name), 'Scope Box 1'), x0: Math.min(a[0], p[0]), y0: Math.min(a[1], p[1]), x1: Math.max(a[0], p[0]), y1: Math.max(a[1], p[1]), z0: (levels[0]?.elevation ?? 0) - 1000, z1: Math.max(top + 4000, (lv?.elevation ?? 0) + 4000) });
    });
    this.app.select([box.id]);
    this.app.setPrompt('Scope box created. Choose it as a view\'s Scope Box in Properties to crop the view to it.');
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  cancel() {
    if (this.first) {
      this.first = null;
      return true;
    }
    return false;
  }

  drawOverlay(ctx, vc, vp) {
    this.drawSnap?.(ctx, vc, vp);
    if (!this.first || !this.cursor) return;
    const a = this.first;
    const b = this.cursor;
    strokeModel(ctx, [a, [b[0], a[1]], b, [a[0], b[1]]], (q) => vc.modelToScreen(q), vp.theme.preview, 1.5, [8, 4], true);
  }
}
