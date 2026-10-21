/**
 * Placing model text: type the words in the options bar, click to place.
 * Space turns it 90 degrees.
 */
import { Tool } from './tool.js';
import { h } from '../ui/dom.js';
import { strokeModel } from '../views/overlay.js';
import { textStrokes } from '../core/modeltext.js';
import { formatLength, parseLength } from '../core/units.js';
import { PLAN_VIEW_KINDS } from '../core/doc.js';

export class ModelTextTool extends Tool {
  get title() {
    return 'Model Text';
  }

  get placingKind() {
    return null;
  }

  get viewKinds() {
    return PLAN_VIEW_KINDS;
  }

  get o() {
    const imp = this.doc.units.system === 'imperial';
    return this.app.toolOptions('modelText', { text: 'ENTRANCE', size: imp ? 12 * 25.4 : 300, depth: imp ? 2 * 25.4 : 50, plane: 'vertical', offset: imp ? 96 * 25.4 : 2400, rotation: 0 });
  }

  get prompt() {
    return 'Click to place the text (its start). Space turns it 90 degrees.';
  }

  move(ev) {
    this.cursor = this.snap(ev);
    this.app.requestRender();
  }

  key(e) {
    if (e.key === ' ') {
      this.o.rotation = ((this.o.rotation || 0) + 90) % 360;
      this.app.requestRender();
      return true;
    }
    return false;
  }

  down(ev) {
    const p = this.snap(ev);
    if (!p) return;
    const o = this.o;
    if (!String(o.text).trim()) return this.app.toast('Type the text in the options bar first.');
    let el;
    this.app.commit('Model text', () => (el = this.doc.add({ kind: 'modelText', levelId: this.app.activeLevelId(), at: p, rotation: o.rotation, text: o.text, size: o.size, depth: o.depth, plane: o.plane, offset: o.plane === 'horizontal' ? 0 : o.offset, materialId: 'mat-steel' })));
    this.app.select([el.id]);
  }

  options() {
    const o = this.o;
    const units = this.doc.units;
    const text = h('input.input.sm', { type: 'text', value: o.text, 'aria-label': 'Text', style: { width: '160px' } });
    text.addEventListener('input', () => (o.text = text.value));
    text.addEventListener('keydown', (e) => e.stopPropagation());
    const len = (label, key) => {
      const inp = h('input.input.sm', { type: 'text', value: formatLength(o[key], units), 'aria-label': label, style: { width: '80px' } });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => {
        const v = parseLength(inp.value, units);
        if (Number.isFinite(v) && v >= 0) o[key] = v;
        inp.value = formatLength(o[key], units);
      });
      return h('div.ob-group', h('label', label), inp);
    };
    const plane = h('select.input.sm', { 'aria-label': 'Orientation' }, h('option', { value: 'vertical' }, 'Standing'), h('option', { value: 'horizontal' }, 'Flat on the floor'));
    plane.value = o.plane;
    plane.addEventListener('change', () => (o.plane = plane.value));
    return [h('div.ob-group', h('label', 'Text'), text), len('Height', 'size'), len('Depth', 'depth'), h('div.ob-group', h('label', 'Orientation'), plane), len('Base above level', 'offset')];
  }

  drawOverlay(ctx, vc, vp) {
    this.drawSnap?.(ctx, vc, vp);
    if (!this.cursor) return;
    const o = this.o;
    const { width } = textStrokes(o.text);
    const k = (+o.size || 300) / 6;
    const r = ((o.rotation || 0) * Math.PI) / 180;
    const d = [Math.cos(r), Math.sin(r)];
    const n = [-d[1], d[0]];
    const c = this.cursor;
    const deep = o.plane === 'horizontal' ? 6 * k : Math.max(1, +o.depth || 50);
    const P = (u, v) => [c[0] + d[0] * u + n[0] * v, c[1] + d[1] * u + n[1] * v];
    strokeModel(ctx, [P(0, 0), P(width * k, 0), P(width * k, deep), P(0, deep)], (q) => vc.modelToScreen(q), vp.theme.preview, 1.5, [6, 4], true);
  }
}
