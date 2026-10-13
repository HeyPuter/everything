/**
 * Magic Wand panel: the Magic Wand tool's matching options, applied as you
 * change them. Each attribute has a checkbox and a tolerance (a field plus a
 * slider); Blending Mode matches exactly. "Select Similar" runs the wand on
 * the current selection without clicking the canvas. Double-clicking the
 * tool opens this panel.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { DEFAULT_WAND, wandOptions, magicWandSelect } from '../artboards/magic-wand.js';

const ROWS = [
  { key: 'fill', label: 'Fill Color', max: 255, unit: '' },
  { key: 'stroke', label: 'Stroke Color', max: 255, unit: '' },
  { key: 'strokeWeight', label: 'Stroke Weight', max: 100, unit: 'pt', step: 0.5 },
  { key: 'opacity', label: 'Opacity', max: 100, unit: '%' },
];

export function setWandOption(app, key, patch) {
  const o = wandOptions(app);
  o[key] = { ...o[key], ...patch };
  app.prefs.set('magicWand', o);
  return o;
}

/** Run the wand from the selected object (Select Similar). */
export function wandFromSelection(app) {
  const ed = app.editor;
  if (!ed) return 0;
  let ref = ed.selectedNodes().find((n) => n.type === 'path' || n.type === 'compound' || n.type === 'text');
  if (ref?.type === 'path' && ed.doc.get(ref.parent)?.type === 'compound') ref = ed.doc.get(ref.parent);
  if (!ref) {
    app.notify('Select an object to match.');
    return 0;
  }
  const ids = magicWandSelect(ed.doc, ref, wandOptions(app));
  ed.select(ids);
  return ids.length;
}

export class MagicWandPanel extends Panel {
  static id = 'magicWand';
  static title = 'Magic Wand';
  static icon = 'panel-magic-wand';
  static placement = 'strip';

  menu() {
    const p = this.app.prefs;
    const o = wandOptions(this.app);
    const show = (key, on, off) => ({ label: p.get(key) === false ? on : off, run: () => (p.set(key, p.get(key) === false), this.update()) });
    return [
      show('magicWandStrokeOptions', 'Show Stroke Options', 'Hide Stroke Options'),
      show('magicWandTransparencyOptions', 'Show Transparency Options', 'Hide Transparency Options'),
      '-',
      { label: 'Reset', run: () => this.reset() },
      '-',
      { label: 'Use All Layers', checked: o.allLayers.on, run: () => this.set('allLayers', { on: !o.allLayers.on }) },
    ];
  }

  build() {
    const app = this.app;
    this.rows = new Map();
    const rowEl = (r) => {
      const cid = `mwp-${r.key}`;
      const tid = `mwp-${r.key}-tol`;
      const chk = h('input', { type: 'checkbox', id: cid, onchange: () => this.set(r.key, { on: chk.checked }) });
      const num = h('input.mwp-num', { type: 'number', id: tid, min: 0, max: r.max, step: r.step || 1, inputmode: 'decimal' });
      const range = h('input.mwp-range', { type: 'range', min: 0, max: r.max, step: r.step || 1, 'aria-label': `${r.label} tolerance slider` });
      const commit = (v) => {
        const n = Math.max(0, Math.min(r.max, Number(v)));
        if (Number.isFinite(n)) this.set(r.key, { tol: n });
      };
      num.addEventListener('change', () => commit(num.value));
      num.addEventListener('keydown', (e) => e.stopPropagation());
      range.addEventListener('input', () => {
        num.value = range.value;
      });
      range.addEventListener('change', () => commit(range.value));
      const el = h(
        'div.mwp-row',
        h('div.check-row', chk, h('label', { for: cid }, r.label)),
        h('div.mwp-tol', h('label', { for: tid }, 'Tolerance'), num, r.unit ? h('span.mwp-unit', r.unit) : null),
        range,
      );
      this.rows.set(r.key, { chk, num, range, el });
      return el;
    };
    const bid = 'mwp-blend';
    this.blend = h('input', { type: 'checkbox', id: bid, onchange: () => this.set('blendMode', { on: this.blend.checked }) });
    // Show/Hide Stroke Options and Transparency Options hide these groups.
    this.strokeGroup = h('div.mwp-group', h('hr.mwp-sep'), rowEl(ROWS[1]), rowEl(ROWS[2]));
    this.transparencyGroup = h('div.mwp-group', h('hr.mwp-sep'), rowEl(ROWS[3]), h('div.check-row.mwp-blend', this.blend, h('label', { for: bid }, 'Blending Mode')));
    this.el.append(
      h('div.mwp', rowEl(ROWS[0]), this.strokeGroup, this.transparencyGroup),
      h(
        'div.mwp-footer',
        h('button.btn.small', { type: 'button', onclick: () => this.reset() }, 'Reset'),
        h('button.btn.small', { type: 'button', onclick: () => app.setTool('magic-wand') }, 'Use Tool'),
        h('button.btn.small.primary', { type: 'button', onclick: () => wandFromSelection(app) }, 'Select Similar'),
      ),
    );
  }

  set(key, patch) {
    setWandOption(this.app, key, patch);
    this.update();
  }

  reset() {
    this.app.prefs.set('magicWand', structuredClone(DEFAULT_WAND));
    this.update();
  }

  update() {
    const o = wandOptions(this.app);
    const unit = this.app.editor?.doc.root.units === 'px' ? 'px' : 'pt';
    for (const [key, r] of this.rows) {
      r.chk.checked = o[key].on;
      if (document.activeElement !== r.num) r.num.value = String(o[key].tol);
      r.range.value = String(o[key].tol);
      r.num.disabled = r.range.disabled = !o[key].on;
      if (key === 'strokeWeight') {
        const u = r.el.querySelector('.mwp-unit');
        if (u) u.textContent = unit;
      }
    }
    this.blend.checked = o.blendMode.on;
    this.strokeGroup.hidden = this.app.prefs.get('magicWandStrokeOptions') === false;
    this.transparencyGroup.hidden = this.app.prefs.get('magicWandTransparencyOptions') === false;
  }
}
