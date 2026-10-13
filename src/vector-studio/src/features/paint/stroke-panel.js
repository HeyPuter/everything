/**
 * Stroke panel (Cmd+F10): weight, cap, corner, miter limit, align stroke,
 * dashed line (three dash/gap pairs, preserve exact lengths or align to
 * corners) and arrowheads (start/end shape, swap, scale, tip alignment).
 * Changes apply to the selection and the current style. The panel menu
 * hides everything but the weight (Hide Options).
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { numberField, segmented, iconButton } from '../../ui/widgets.js';
import { openPopover, closePopover } from '../../ui/popover.js';
import { applyStyle, commonStyle } from '../../ops/paint-ops.js';
import { formatLength, parseLength } from '../../lib/units.js';
import { ARROWHEADS, ARROWHEAD_IDS } from './stroke-geometry.js';
import { gestureKey } from './ui-common.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Small SVG preview of a line ending in an arrowhead (pointing right, or left for the start). */
export function arrowPreview(id, which = 'end') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 60 16');
  svg.setAttribute('width', '60');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('arrow-preview');
  const g = document.createElementNS(SVG, 'g');
  if (which === 'start') g.setAttribute('transform', 'translate(60 0) scale(-1 1)');
  svg.append(g);
  const def = ARROWHEADS[id];
  const w = 1.6;
  const tipX = 54;
  const line = document.createElementNS(SVG, 'line');
  line.setAttribute('x1', '4');
  line.setAttribute('y1', '8');
  line.setAttribute('x2', String(def ? tipX + def.attach * w : tipX));
  line.setAttribute('y2', '8');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', String(w));
  g.append(line);
  if (def) {
    const path = document.createElementNS(SVG, 'path');
    let d = '';
    for (const c of def.contours) {
      if (c.pts) d += `M${c.pts.map(([x, y]) => `${tipX + x * w} ${8 + y * w}`).join('L')}Z`;
      else {
        const { cx, cy, r, reverse } = c.circle;
        const X = tipX + cx * w;
        const Y = 8 + cy * w;
        const R = r * w;
        d += `M${X + R} ${Y}A${R} ${R} 0 1 ${reverse ? 0 : 1} ${X - R} ${Y}A${R} ${R} 0 1 ${reverse ? 0 : 1} ${X + R} ${Y}Z`;
      }
    }
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    g.append(path);
  }
  return svg;
}

export class StrokePanel extends Panel {
  static id = 'stroke';
  static title = 'Stroke';
  static icon = 'stroke-panel';
  static placement = 'strip';
  static shortcut = 'Mod+F10';
  /** Rows from other feature modules: [{ id, build(app) => { el, refresh() } }] (e.g. width profiles). */
  static extraSections = [];

  build() {
    const app = this.app;
    const unit = () => app.editor?.doc.root.units || 'pt';
    const set = (patch, label, live) => {
      if (!app.editor) return;
      applyStyle(app.editor, patch, label, live ? this.live : null);
    };
    this.live = gestureKey('stroke');
    this.weight = numberField({
      label: 'Weight',
      value: 1,
      min: 0,
      max: 1000,
      width: '80px',
      onCommit: (v, o) => {
        if (!o?.live) this.live = gestureKey('stroke');
        set({ strokeWidth: v }, 'Stroke Weight', true);
      },
    });
    this.weight.el.querySelector('label').textContent = '';
    this.cap = segmented(
      'Cap',
      [
        { value: 'butt', label: 'Butt Cap', icon: 'stroke-cap-butt' },
        { value: 'round', label: 'Round Cap', icon: 'stroke-cap-round' },
        { value: 'square', label: 'Projecting Cap', icon: 'stroke-cap-square' },
      ],
      'butt',
      (v) => set({ strokeCap: v }, 'Stroke Cap'),
    );
    this.join = segmented(
      'Corner',
      [
        { value: 'miter', label: 'Miter Join', icon: 'stroke-join-miter' },
        { value: 'round', label: 'Round Join', icon: 'stroke-join-round' },
        { value: 'bevel', label: 'Bevel Join', icon: 'stroke-join-bevel' },
      ],
      'miter',
      (v) => set({ strokeJoin: v }, 'Stroke Corner'),
    );
    this.limit = numberField({ label: 'Limit', kind: 'number', value: 10, min: 1, max: 500, width: '52px', onCommit: (v) => set({ miterLimit: v }, 'Miter Limit') });
    this.align = segmented(
      'Align Stroke',
      [
        { value: 'center', label: 'Align Stroke to Center', icon: 'stroke-align-center' },
        { value: 'inside', label: 'Align Stroke to Inside', icon: 'stroke-align-inside' },
        { value: 'outside', label: 'Align Stroke to Outside', icon: 'stroke-align-outside' },
      ],
      'center',
      (v) => set({ strokeAlign: v }, 'Align Stroke'),
    );

    // ---- Dashes ----
    this.dashed = h('input', { type: 'checkbox', id: 'sp-dashed', onchange: () => {
      if (this.dashed.checked) set({ dash: [12], dashAlign: 'corners' }, 'Dashed Line');
      else set({ dash: [] }, 'Dashed Line');
    } });
    this.dashMode = segmented(
      'Dash alignment',
      [
        { value: 'exact', label: 'Preserves exact dash and gap lengths', icon: 'dash-exact' },
        { value: 'corners', label: 'Aligns dashes to corners and path ends, adjusting lengths to fit', icon: 'dash-corners' },
      ],
      'exact',
      (v) => set({ dashAlign: v }, 'Dash Alignment'),
    );
    this.dashInputs = [];
    const dashGrid = h('div.sp-dashes');
    ['dash', 'gap', 'dash', 'gap', 'dash', 'gap'].forEach((label, i) => {
      const id = `sp-dash-${i}`;
      const input = h('input.sp-dash', { type: 'text', id, inputmode: 'decimal', autocomplete: 'off', spellcheck: false, 'aria-label': `${label} ${Math.floor(i / 2) + 1}` });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commitDash();
        }
      });
      input.addEventListener('change', () => this.commitDash());
      this.dashInputs.push(input);
      dashGrid.append(h('div.sp-dash-cell', input, h('label', { for: id }, label)));
    });
    this.unit = unit;

    // ---- Arrowheads ----
    this.startBtn = h('button.sp-arrow', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': 'Start arrowhead', onclick: (e) => this.pickArrow('start', e.currentTarget) });
    this.endBtn = h('button.sp-arrow', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': 'End arrowhead', onclick: (e) => this.pickArrow('end', e.currentTarget) });
    const swap = iconButton('arrow-left-right', 'Swap start and end arrowheads', () => {
      const ed = app.editor;
      if (!ed) return;
      const s = commonStyle(ed, 'arrowStart');
      const en = commonStyle(ed, 'arrowEnd');
      set({ arrowStart: en === 'mixed' ? null : en, arrowEnd: s === 'mixed' ? null : s }, 'Swap Arrowheads');
    }, { className: 'small' });
    this.linked = true;
    const scaleSet = (which) => (v) => {
      const patch = {};
      for (const w of this.linked ? ['start', 'end'] : [which]) {
        const key = w === 'start' ? 'arrowStart' : 'arrowEnd';
        const cur = commonStyle(app.editor, key);
        if (cur && cur !== 'mixed') patch[key] = { ...cur, scale: v };
      }
      if (Object.keys(patch).length) set(patch, 'Arrowhead Scale');
    };
    this.scaleStart = numberField({ label: 'Start scale', kind: 'percent', value: 100, min: 1, max: 1000, width: '60px', onCommit: scaleSet('start') });
    this.scaleEnd = numberField({ label: 'End scale', kind: 'percent', value: 100, min: 1, max: 1000, width: '60px', onCommit: scaleSet('end') });
    this.scaleStart.el.querySelector('label').textContent = '';
    this.scaleEnd.el.querySelector('label').textContent = '';
    this.linkBtn = iconButton('link', 'Link start and end arrowhead scales', () => {
      this.linked = !this.linked;
      this.linkBtn.setAttribute('aria-pressed', String(this.linked));
    }, { className: 'small', pressed: true });
    this.arrowAlign = segmented(
      'Arrowhead alignment',
      [
        { value: 'beyond', label: 'Extend arrow tip beyond end of path', icon: 'arrow-beyond' },
        { value: 'end', label: 'Place arrow tip at end of path', icon: 'arrow-at-end' },
      ],
      'beyond',
      (v) => {
        const patch = {};
        for (const key of ['arrowStart', 'arrowEnd']) {
          const cur = commonStyle(app.editor, key);
          if (cur && cur !== 'mixed') patch[key] = { ...cur, align: v };
        }
        this.arrowAlignValue = v;
        if (Object.keys(patch).length) set(patch, 'Arrowhead Alignment');
      },
    );
    this.arrowAlignValue = 'beyond';

    const row = (label, ...c) => h('div.pp-row', h('span.pp-label', label), ...c);
    // Everything but the weight hides with Hide Options.
    this.options = h(
      'div.sp-options',
      row('Cap', this.cap.el),
      row('Corner', this.join.el, this.limit.el),
      row('Align Stroke', this.align.el),
      h('div.pp-row.sp-dashrow', h('div.check-row', this.dashed, h('label', { for: 'sp-dashed' }, 'Dashed Line')), this.dashMode.el),
      dashGrid,
      row('Arrowheads', this.startBtn, this.endBtn, swap),
      row('Scale', this.scaleStart.el, this.scaleEnd.el, this.linkBtn),
      row('Align', this.arrowAlign.el),
    );
    this.el.append(row('Weight', this.weight.el), this.options);
    this.dashGrid = dashGrid;
    this.extras = StrokePanel.extraSections.map((def) => def.build(app));
    for (const x of this.extras) this.options.append(x.el);
    this.setOptionsShown(app.prefs.get('strokeOptions') !== false);
  }

  setOptionsShown(on) {
    this.optionsShown = on;
    this.app.prefs.set('strokeOptions', on);
    this.options.hidden = !on;
  }

  menu() {
    return [{ label: this.optionsShown ? 'Hide Options' : 'Show Options', run: () => this.setOptionsShown(!this.optionsShown) }];
  }

  commitDash() {
    const ed = this.app.editor;
    if (!ed) return;
    const unit = this.unit();
    const vals = [];
    for (const input of this.dashInputs) {
      const s = input.value.trim();
      if (!s) break;
      const v = parseLength(s, unit);
      if (!Number.isFinite(v) || v < 0) break;
      vals.push(v);
    }
    if (!vals.length || vals.every((v) => v === 0)) return;
    applyStyle(ed, { dash: vals }, 'Dash Pattern');
  }

  pickArrow(which, anchor) {
    const key = which === 'start' ? 'arrowStart' : 'arrowEnd';
    const ed = this.app.editor;
    if (!ed) return;
    const cur = commonStyle(ed, key);
    const curId = cur && cur !== 'mixed' ? cur.shape : null;
    const choose = (id) => {
      closePopover();
      const other = commonStyle(ed, which === 'start' ? 'arrowEnd' : 'arrowStart');
      const scale = cur && cur !== 'mixed' ? cur.scale : other && other !== 'mixed' ? other.scale : 100;
      const align = cur && cur !== 'mixed' ? cur.align : this.arrowAlignValue;
      applyStyle(ed, { [key]: id ? { shape: id, scale: scale ?? 100, align: align || 'beyond' } : null }, which === 'start' ? 'Start Arrowhead' : 'End Arrowhead');
      anchor.focus();
    };
    const opts = [null, ...ARROWHEAD_IDS].map((id) =>
      h(
        'button.sp-arrow-opt',
        {
          type: 'button',
          role: 'option',
          'aria-selected': String(id === curId),
          'aria-label': id ? ARROWHEADS[id].label : 'None',
          onclick: () => choose(id),
          onkeydown: (e) => {
            const items = [...e.currentTarget.parentElement.children];
            const i = items.indexOf(e.currentTarget);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
            }
          },
        },
        arrowPreview(id, which),
        h('span', id ? ARROWHEADS[id].label : 'None'),
      ),
    );
    const list = h('div.sp-arrow-list', { role: 'listbox', 'aria-label': which === 'start' ? 'Start arrowhead' : 'End arrowhead' }, opts);
    openPopover(anchor, list, { label: which === 'start' ? 'Start arrowhead' : 'End arrowhead' });
    (list.querySelector('[aria-selected="true"]') || list.firstChild).focus();
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    if (!ed) return;
    const v = (k) => {
      const x = commonStyle(ed, k);
      return x === 'mixed' ? 'mixed' : x;
    };
    // Stroke weights show in the Stroke units preference (points by default), not the document units.
    this.weight.setUnit(this.app.prefs.get('strokeUnits') || 'pt');
    const w = v('strokeWidth');
    this.weight.set(w === 'mixed' ? 'mixed' : w ?? 0);
    this.cap.set(v('strokeCap') || 'butt');
    this.join.set(v('strokeJoin') || 'miter');
    const ml = v('miterLimit');
    this.limit.set(ml === 'mixed' ? 'mixed' : ml ?? 10);
    this.align.set(v('strokeAlign') || 'center');
    const dash = v('dash');
    const on = Array.isArray(dash) && dash.length > 0;
    this.dashed.checked = on;
    this.dashed.indeterminate = dash === 'mixed';
    this.dashGrid.classList.toggle('off', !on);
    const unit = ed.doc.root.units || 'pt';
    this.dashInputs.forEach((input, i) => {
      input.disabled = !on;
      if (document.activeElement !== input) input.value = on && dash[i] != null ? formatLength(dash[i], unit) : '';
    });
    const da = v('dashAlign');
    this.dashMode.set(da === 'corners' ? 'corners' : 'exact');
    this.dashMode.el.querySelectorAll('button').forEach((b) => (b.disabled = !on));
    const as = v('arrowStart');
    const ae = v('arrowEnd');
    this.startBtn.replaceChildren(arrowPreview(as && as !== 'mixed' ? as.shape : null, 'start'));
    this.endBtn.replaceChildren(arrowPreview(ae && ae !== 'mixed' ? ae.shape : null, 'end'));
    this.startBtn.setAttribute('data-tip', `Start: ${as && as !== 'mixed' ? ARROWHEADS[as.shape]?.label : 'None'}`);
    this.endBtn.setAttribute('data-tip', `End: ${ae && ae !== 'mixed' ? ARROWHEADS[ae.shape]?.label : 'None'}`);
    this.scaleStart.set(as && as !== 'mixed' ? as.scale ?? 100 : 100);
    this.scaleEnd.set(ae && ae !== 'mixed' ? ae.scale ?? 100 : 100);
    const align = (as && as !== 'mixed' && as.align) || (ae && ae !== 'mixed' && ae.align) || this.arrowAlignValue;
    this.arrowAlign.set(align);
    this.arrowAlignValue = align;
    for (const x of this.extras) x.refresh();
  }
}
