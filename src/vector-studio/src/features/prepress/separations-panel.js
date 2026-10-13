/**
 * Window > Separations Preview: show the document as printing plates.
 *
 * Turning the preview on replaces the artwork on the artboards by the
 * visible plates printed in their ink colors (the process plates of the
 * document's press model and every spot ink). Each plate has an eye toggle
 * (Alt/Option+click shows that plate alone; clicking the composite row
 * shows all process plates); "Show single plates in black" draws a plate
 * shown alone as black ink, the way a film or plate looks. Ink coverage
 * under the pointer is listed per plate with the total ink.
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { cmykProfile, documentCmykProfile, PROCESS_INKS } from './color-management.js';
import { separationState, setSeparationState, listedPlates, inkAt } from './separations.js';

export class SeparationsPanel extends Panel {
  static id = 'separations';
  static title = 'Separations Preview';
  static icon = 'panel-separations';
  static placement = 'strip';

  build() {
    this.empty = emptyState('Open a document to preview its separations.');
    this.onBox = h('input', { type: 'checkbox', id: 'sep-on' });
    this.onBox.addEventListener('change', () => this.set({ on: this.onBox.checked }));
    this.overBox = h('input', { type: 'checkbox', id: 'sep-over' });
    this.overBox.addEventListener('change', () => {
      const ed = this.editor;
      if (ed && Boolean(ed.viewOptions.overprint) !== this.overBox.checked) this.app.commands.run('view.overprint');
    });
    this.list = h('ul.sep-list', { role: 'list', 'aria-label': 'Plates' });
    this.usedBox = h('input', { type: 'checkbox', id: 'sep-used' });
    this.usedBox.addEventListener('change', () => this.set({ usedOnly: this.usedBox.checked }));
    this.singleBox = h('input', { type: 'checkbox', id: 'sep-single' });
    this.singleBox.addEventListener('change', () => this.set({ single: this.singleBox.checked }));
    this.profile = h('p.sep-profile');
    this.total = h('span.sep-total-value');
    this.body = h(
      'div.sep-body',
      h('label.check-row', { for: 'sep-on' }, this.onBox, 'Preview separations'),
      h('label.check-row', { for: 'sep-over' }, this.overBox, 'Overprint preview'),
      this.list,
      h('div.sep-total', h('span', 'Total ink'), this.total),
      h('label.check-row', { for: 'sep-used' }, this.usedBox, 'Show used spot colors only'),
      h('label.check-row', { for: 'sep-single' }, this.singleBox, 'Show single plates in black'),
      this.profile,
    );
    this.el.append(this.empty, this.body);
    this.readout = null;
    const prev = this.app.setPointerStatus;
    this.app.setPointerStatus = (ev) => {
      prev?.(ev);
      this.pointer = ev && Number.isFinite(ev.x) ? { x: ev.x, y: ev.y } : null;
      if (this.visible && separationState(this.editor).on) this.scheduleReadout();
    };
  }

  set(patch) {
    const ed = this.editor;
    if (!ed) return;
    setSeparationState(ed, patch);
    this.update();
  }

  scheduleReadout() {
    if (this.readoutFrame) return;
    this.readoutFrame = requestAnimationFrame(() => {
      this.readoutFrame = 0;
      const ed = this.editor;
      this.readout = ed && this.pointer ? inkAt(this.app, ed, this.pointer.x, this.pointer.y) : null;
      this.update();
    });
  }

  /** Toggle a plate; `solo` shows it alone (or everything again when it already is). */
  togglePlate(id, solo = false) {
    const ed = this.editor;
    if (!ed) return;
    const st = separationState(ed);
    const all = listedPlates(this.app, ed).map((p) => p.id);
    let hidden = new Set(st.hidden);
    if (solo) {
      const alone = all.every((p) => (p === id ? !hidden.has(p) : hidden.has(p)));
      hidden = alone ? new Set() : new Set(all.filter((p) => p !== id));
    } else if (id === 'cmyk') {
      const anyHidden = PROCESS_INKS.some((k) => hidden.has(k));
      for (const k of PROCESS_INKS) anyHidden ? hidden.delete(k) : hidden.add(k);
    } else if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    this.set({ hidden: [...hidden], on: true });
  }

  menu() {
    const ed = () => this.app.editor;
    const st = () => separationState(ed());
    const has = () => Boolean(ed());
    return [
      { label: 'Preview Separations', enabled: has, checked: () => has() && st().on, run: () => this.set({ on: !st().on }) },
      'view.overprint',
      '-',
      { label: 'Show All Plates', enabled: has, run: () => this.set({ hidden: [], on: true }) },
      { label: 'Show Used Spot Colors Only', enabled: has, checked: () => has() && st().usedOnly, run: () => this.set({ usedOnly: !st().usedOnly }) },
      { label: 'Show Single Plates in Black', enabled: has, checked: () => has() && st().single, run: () => this.set({ single: !st().single }) },
    ];
  }

  update() {
    if (!this.built) return;
    const ed = this.editor;
    this.empty.hidden = Boolean(ed);
    this.body.hidden = !ed;
    if (!ed) return;
    const st = separationState(ed);
    this.onBox.checked = st.on;
    this.overBox.checked = Boolean(ed.viewOptions.overprint);
    this.usedBox.checked = st.usedOnly;
    this.singleBox.checked = st.single;
    const hidden = new Set(st.hidden);
    const plates = listedPlates(this.app, ed);
    const r = st.on ? this.readout : null;
    const value = (id) => {
      if (!r) return '';
      if (PROCESS_INKS.includes(id)) return `${Math.round(r[id])}%`;
      const s = r.spots.find((x) => x.id === id);
      return s ? `${Math.round(s.value)}%` : '';
    };
    const row = (p, { composite = false } = {}) => {
      const shown = composite ? PROCESS_INKS.every((k) => !hidden.has(k)) : !hidden.has(p.id);
      const eye = h('button.icon-btn.sep-eye', {
        type: 'button',
        'aria-pressed': String(shown),
        'aria-label': `${shown ? 'Hide' : 'Show'} ${p.name}${composite ? '' : ' plate'}`,
        'data-tip': composite ? 'Show or hide the process plates' : 'Show or hide (Alt+click: show only this plate)',
        onclick: (e) => this.togglePlate(composite ? 'cmyk' : p.id, !composite && e.altKey),
      }, icon(shown ? 'eye' : 'eye-off', 14));
      const chip = composite ? h('span.sep-chip.sep-chip-cmyk', { 'aria-hidden': 'true' }) : h('span.sep-chip', { style: { background: p.color }, 'aria-hidden': 'true' });
      return h(`li.sep-row${composite ? '.sep-composite' : ''}${p.spot ? '.sep-spot' : ''}`, { dataset: { plate: composite ? 'cmyk' : p.id } }, eye, chip, h('span.sep-name', p.name), h('span.sep-value', composite ? '' : value(p.id)));
    };
    this.list.replaceChildren(row({ name: 'CMYK', id: 'cmyk' }, { composite: true }), ...plates.map((p) => row(p)));
    this.list.classList.toggle('off', !st.on);
    if (r) {
      const sum = r.c + r.m + r.y + r.k + r.spots.reduce((s, x) => s + x.value, 0);
      this.total.textContent = `${Math.round(sum)}%`;
    } else this.total.textContent = '';
    const prof = cmykProfile(documentCmykProfile(this.app, ed.doc));
    this.profile.textContent = `Press: ${prof.label}. Ink limit ${prof.til}%.`;
  }
}
