/**
 * Paint: click elements to finish them in a material (their surfaces take
 * its colour in 3D, elevations and sections), or to take the paint off.
 */
import { Tool } from './tool.js';
import { h } from '../ui/dom.js';
import { categoryOf, CATEGORIES } from '../core/catalog.js';

const MODEL = new Set(CATEGORIES.filter((c) => c.model).map((c) => c.id));

export class PaintTool extends Tool {
  get title() {
    return this.opts.remove ? 'Remove Paint' : 'Paint';
  }

  get viewKinds() {
    return null;
  }

  get o() {
    return this.app.toolOptions('paint', { materialId: 'mat-paint-white' });
  }

  get prompt() {
    return this.opts.remove ? 'Click painted elements to take the paint off' : 'Click elements to paint them in the material chosen in the options bar';
  }

  target(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y, 6)) {
      const el = this.doc.get(id);
      if (el && !el.viewId && MODEL.has(categoryOf(el, this.doc))) return el;
    }
    return null;
  }

  move(ev) {
    this.app.setHover(this.target(ev)?.id ?? null);
  }

  down(ev) {
    const el = this.target(ev);
    if (!el) return;
    if (this.opts.remove) {
      if (!el.paintId) return this.app.setPrompt('That element is not painted');
      this.app.commit('Remove paint', () => this.doc.update(el.id, { paintId: null }));
      return;
    }
    const m = this.o.materialId;
    if (!this.doc.has(m)) return this.app.toast('Choose a material first.');
    this.app.commit('Paint', () => this.doc.update(el.id, { paintId: m }));
  }

  options() {
    if (this.opts.remove) return null;
    const o = this.o;
    const sel = h('select.input.sm', { 'aria-label': 'Material' }, this.doc.all('material').map((m) => h('option', { value: m.id }, m.name)));
    sel.value = this.doc.has(o.materialId) ? o.materialId : this.doc.all('material')[0]?.id;
    o.materialId = sel.value;
    sel.addEventListener('change', () => (o.materialId = sel.value));
    return [h('div.ob-group', h('label', 'Material'), sel)];
  }
}
