/**
 * Demolish (mark elements as demolished in the view's phase) and Renumber
 * (give doors, windows, rooms or other elements sequential marks by
 * clicking them in order).
 */
import { Tool } from './tool.js';
import { phased, phasesInOrder } from '../core/phases.js';
import { h } from '../ui/dom.js';
import { drawTag } from '../views/overlay.js';

export class DemolishTool extends Tool {
  get title() {
    return 'Demolish';
  }

  get viewKinds() {
    return null;
  }

  get prompt() {
    return 'Click elements to demolish them in this view’s phase. Click a demolished element again to restore it.';
  }

  target(ev) {
    for (const id of this.app.pickTargets(this.vc.hitTest(ev.x, ev.y))) {
      const el = this.doc.get(id);
      if (phased(el)) return el;
    }
    return null;
  }

  move(ev) {
    this.app.setHover(this.target(ev)?.id ?? null);
  }

  down(ev) {
    const el = this.target(ev);
    if (!el) return;
    const phases = phasesInOrder(this.doc);
    if (phases.length < 2) return this.app.toast('Add phases first (Manage > Phases).', { kind: 'error' });
    const viewPhase = this.vc.view?.phaseId || phases.at(-1).id;
    const created = phases.findIndex((p) => p.id === (el.phaseId || phases.at(-1).id));
    const now = phases.findIndex((p) => p.id === viewPhase);
    if (created > now) return this.app.toast('That element is created in a later phase.', { kind: 'error' });
    const hosted = this.doc.filter((x) => x.hostId === el.id);
    const restore = el.demolishedId === viewPhase;
    this.app.commit(restore ? 'Restore' : 'Demolish', () => [el, ...hosted].forEach((x) => this.doc.update(x.id, { demolishedId: restore ? null : viewPhase })));
  }
}

const RENUMBER_KINDS = [
  { value: 'door', label: 'Doors', key: 'mark' },
  { value: 'window', label: 'Windows', key: 'mark' },
  { value: 'room', label: 'Rooms', key: 'number' },
  { value: 'area', label: 'Areas', key: 'number' },
  { value: 'column', label: 'Columns', key: 'mark' },
  { value: 'component', label: 'Components', key: 'mark' },
];

export class RenumberTool extends Tool {
  get title() {
    return 'Renumber';
  }

  get o() {
    return this.app.toolOptions('renumber', { kind: 'door', prefix: '', start: 1, step: 1 });
  }

  get prompt() {
    const o = this.o;
    return `Click ${RENUMBER_KINDS.find((k) => k.value === o.kind)?.label.toLowerCase()} in order. Next number: ${o.prefix}${o.start}`;
  }

  options() {
    const o = this.o;
    const kind = h('select.input.sm', { 'aria-label': 'Category' }, RENUMBER_KINDS.map((k) => h('option', { value: k.value }, k.label)));
    kind.value = o.kind;
    kind.addEventListener('change', () => ((o.kind = kind.value), this.app.setPrompt(this.prompt)));
    const text = (key, label, cls = '') => {
      const inp = h(`input.input.sm${cls}`, { type: 'text', value: String(o[key]), 'aria-label': label });
      inp.addEventListener('change', () => {
        o[key] = key === 'prefix' ? inp.value : Math.round(+inp.value) || (key === 'step' ? 1 : 0);
        inp.value = String(o[key]);
        this.app.setPrompt(this.prompt);
      });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      return h('div.ob-group', h('label', label), inp);
    };
    return [h('div.ob-group', h('label', 'Renumber'), kind), text('prefix', 'Prefix'), text('start', 'Start at', '.num'), text('step', 'Step', '.num')];
  }

  target(ev) {
    for (const id of this.vc.hitTest(ev.x, ev.y)) {
      const el = this.doc.get(id);
      if (el?.kind === this.o.kind) return el;
    }
    return null;
  }

  move(ev) {
    this.app.setHover(this.target(ev)?.id ?? null);
    this.cursor = { x: ev.x, y: ev.y };
    this.app.requestRender();
  }

  down(ev) {
    const el = this.target(ev);
    if (!el) return;
    const o = this.o;
    const key = RENUMBER_KINDS.find((k) => k.value === o.kind).key;
    const value = `${o.prefix}${o.start}`;
    // Another element already using the number swaps to this one's old number.
    const clash = this.doc.all(o.kind).find((x) => x.id !== el.id && x[key] === value);
    this.app.commit('Renumber', () => {
      if (clash) this.doc.update(clash.id, { [key]: el[key] || '' });
      this.doc.update(el.id, { [key]: value });
    });
    o.start += o.step;
    this.app.renderOptions();
    this.app.setPrompt(this.prompt);
  }

  drawOverlay(ctx, vc, vp) {
    if (this.cursor) drawTag(ctx, this.cursor.x + 22, this.cursor.y + 22, `${this.o.prefix}${this.o.start}`, { bg: vp.theme.bgCss, fg: vp.theme.inkCss, border: vp.theme.preview, active: true });
  }
}
