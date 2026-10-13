/**
 * Blend panel (Window > Blend): the options of the selected blends, live.
 *
 *  - Spacing (Smooth Color, Specified Steps, Specified Distance) with its
 *    value, Orientation (align steps to the page or to the spine) and
 *    Reverse Front to Back
 *  - Easing: how the steps are spaced (even, bunched at the start, the end
 *    or both), how strongly, and whether colors follow; a strip previews
 *    where the steps go
 *  - Appearance: colors blend straight or around the hue wheel; a strip
 *    previews the step colors
 *  - Spine: Reverse Spine and Replace Spine; quick Make, Release, Expand
 *
 * With no blend selected the controls set the options for new blends.
 * Every change is one undo step; dragging the easing slider is one too.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, numberField, selectField } from '../../ui/widgets.js';
import { registerIcons } from '../../ui/icons.js';
import { DEFAULT_BLEND, BLEND_EASINGS, BLEND_COLOR_MODES, easeT, lerpColor, blendKeys } from './blend-math.js';
import { selectedBlends, blendOptionsFor } from './blend.js';

const R = (x, y, w, hh, extra = {}) => ['rect', { x: String(x), y: String(y), width: String(w), height: String(hh), rx: '0.5', ...extra }];
const P = (d, extra = {}) => ['path', { d, ...extra }];

registerIcons({
  // Steps standing upright along a curve, and steps turning with it.
  'blend-orient-page': [P('M3 17c4-6 14-6 18 0', { 'stroke-dasharray': '2 2' }), R(4, 9, 3, 6), R(10.5, 6, 3, 6), R(17, 9, 3, 6)],
  'blend-orient-path': [P('M3 17c4-6 14-6 18 0', { 'stroke-dasharray': '2 2' }), R(4, 9, 3, 6, { transform: 'rotate(-30 5.5 12)' }), R(10.5, 6, 3, 6), R(17, 9, 3, 6, { transform: 'rotate(30 18.5 12)' })],
  'blend-reverse-stack': [R(4, 4, 9, 9), R(11, 11, 9, 9), P('M17 3.5h3.5V7M20.5 3.5 15.5 8.5M7 20.5H3.5V17M3.5 20.5l5-5')],
});

const ORIENTS = [
  { value: 'page', label: 'Align to Page', icon: 'blend-orient-page' },
  { value: 'path', label: 'Align to Path', icon: 'blend-orient-path' },
];

/** Solid fill colors of a blend's first and last key objects (for the color preview), or null. */
function endColors(doc, g) {
  const keys = blendKeys(doc, g);
  const fillOf = (n) => {
    while (n && (n.type === 'group' || n.type === 'compound') && !n.fill && n.children?.length) n = doc.get(n.children[0]);
    return n?.fill?.type === 'solid' ? n.fill.color : null;
  };
  const a = fillOf(keys[0]);
  const b = fillOf(keys[keys.length - 1]);
  return a && b ? [a, b] : null;
}

export class BlendPanel extends Panel {
  static id = 'blend';
  static title = 'Blend';
  static icon = 'tool-blend';
  static placement = 'strip';

  menu() {
    const blends = this.blends();
    return [
      'blend.options',
      '-',
      'blend.make',
      'blend.release',
      'blend.expand',
      '-',
      'blend.replaceSpine',
      'blend.reverseSpine',
      'blend.reverseFrontToBack',
      '-',
      { label: 'Use for New Blends', enabled: blends.length > 0, run: () => this.app.prefs.set('blendOptions', { ...this.current() }) },
      { label: 'Reset Options', run: () => this.apply({ ...DEFAULT_BLEND }) },
    ];
  }

  blends() {
    const ed = this.app.editor;
    return ed ? selectedBlends(ed) : [];
  }

  /** The options shown: the first selected blend's, else those for new blends. */
  current() {
    const ed = this.app.editor;
    const ids = this.blends();
    if (ids.length) return { ...DEFAULT_BLEND, ...ed.doc.get(ids[0]).blend };
    return blendOptionsFor(this.app);
  }

  /** Change options: on the selected blends (one undo step; `live` drags coalesce), else for new blends. */
  apply(patch, { live = false } = {}) {
    const ed = this.app.editor;
    const ids = this.blends();
    if (!ids.length) {
      this.app.prefs.set('blendOptions', { ...blendOptionsFor(this.app), ...patch });
      this.update();
      return;
    }
    ed.doc.transact('Blend Options', () => ids.forEach((id) => ed.doc.update(id, { blend: { ...DEFAULT_BLEND, ...ed.doc.get(id).blend, ...patch } })), { coalesce: live ? `blend-panel-${ids.join(',')}` : null });
  }

  build() {
    const app = this.app;
    const unit = () => app.editor?.doc.root.units || 'pt';
    this.status = h('p.bp-status', { 'aria-live': 'polite' });
    this.spacing = selectField(
      'Spacing',
      [
        { value: 'smooth', label: 'Smooth Color' },
        { value: 'steps', label: 'Specified Steps' },
        { value: 'distance', label: 'Specified Distance' },
      ],
      'smooth',
      (v) => this.apply({ spacing: v }),
    );
    this.steps = numberField({ label: 'Steps', kind: 'number', value: 5, min: 1, max: 1000, width: '64px', onCommit: (v) => this.apply({ steps: Math.round(v) }) });
    this.distance = numberField({ label: 'Distance', value: 20, unit: unit(), min: 0.01, width: '72px', onCommit: (v) => this.apply({ distance: v }) });
    this.orient = ORIENTS.map((o) => {
      const b = iconButton(o.icon, o.label, () => this.apply({ orientation: o.value }), { pressed: false });
      b.dataset.value = o.value;
      return b;
    });
    this.reverseStack = iconButton('blend-reverse-stack', 'Reverse Front to Back', () => app.commands.run('blend.reverseFrontToBack'));

    this.easing = selectField('Easing', BLEND_EASINGS, 'linear', (v) => this.apply({ easing: v }));
    const amountId = `bp-amt-${Math.random().toString(36).slice(2, 7)}`;
    this.amount = h('input.bp-range', { type: 'range', id: amountId, min: 0, max: 100, step: 1 });
    this.amount.addEventListener('input', () => this.apply({ easeAmount: Number(this.amount.value) / 100 }, { live: true }));
    this.amountOut = h('output.bp-out', { for: amountId });
    const easeColorId = `bp-ec-${Math.random().toString(36).slice(2, 7)}`;
    this.easeColor = h('input', { type: 'checkbox', id: easeColorId, onchange: () => this.apply({ easeColor: this.easeColor.checked }) });
    this.easePreview = h('div.bp-ease-preview', { role: 'img' });

    this.colorMode = selectField('Colors', BLEND_COLOR_MODES, 'rgb', (v) => this.apply({ colorMode: v }));
    this.colorPreview = h('div.bp-color-preview', { role: 'img' });

    const btn = (label, cmd) => {
      const b = h('button.btn.small', { type: 'button', onclick: () => app.commands.run(cmd) }, label);
      b.dataset.cmd = cmd;
      return b;
    };
    this.cmdButtons = [btn('Reverse Spine', 'blend.reverseSpine'), btn('Replace Spine', 'blend.replaceSpine'), btn('Make', 'blend.make'), btn('Release', 'blend.release'), btn('Expand', 'blend.expand')];
    const [revSpine, repSpine, make, release, expand] = this.cmdButtons;

    const row = (label, ...kids) => h('div.bp-row', h('span.bp-label', label), h('div.bp-ctl', ...kids));
    this.el.append(
      this.status,
      h(
        'section.panel-section.bp-main',
        row('Spacing', this.spacing.el, this.steps.el, this.distance.el),
        row('Orientation', h('div.segmented', { role: 'group', 'aria-label': 'Orientation' }, ...this.orient)),
        row('Direction', this.reverseStack),
      ),
      h(
        'details.bp-section',
        { open: true },
        h('summary', 'Easing'),
        row('Spacing curve', this.easing.el),
        h('div.bp-row', h('label.bp-label', { for: amountId }, 'Strength'), h('div.bp-ctl', this.amount, this.amountOut)),
        h('div.check-row', this.easeColor, h('label', { for: easeColorId }, 'Ease colors too')),
        this.easePreview,
      ),
      h('details.bp-section', { open: true }, h('summary', 'Appearance'), row('Colors', this.colorMode.el), this.colorPreview),
      h('details.bp-section', { open: true }, h('summary', 'Spine Controls'), h('div.bp-buttons', revSpine, repSpine)),
      h('section.panel-section.bp-quick', h('h3.section-title', 'Quick Actions'), h('div.bp-buttons.bp-stack', expand, release, make)),
    );
  }

  update() {
    const app = this.app;
    const ed = app.editor;
    const ids = this.blends();
    const o = this.current();
    const n = ed ? ed.topSelection().length : 0;
    this.status.textContent = !ed ? 'No document open.' : ids.length ? `${ids.length === 1 ? 'Blend' : `${ids.length} blends`} selected: changes apply right away.` : n >= 2 ? 'Choose Make to blend the selected objects. These options apply to new blends.' : 'Select a blend, or two or more objects to blend. These options apply to new blends.';
    this.spacing.set(o.spacing);
    this.steps.set(o.steps);
    this.steps.el.hidden = o.spacing !== 'steps';
    this.distance.setUnit?.(ed?.doc.root.units || 'pt');
    this.distance.set(o.distance);
    this.distance.el.hidden = o.spacing !== 'distance';
    for (const b of this.orient) b.setAttribute('aria-pressed', String(b.dataset.value === o.orientation));
    this.reverseStack.disabled = !ids.length;
    this.easing.set(o.easing);
    if (document.activeElement !== this.amount) this.amount.value = String(Math.round(o.easeAmount * 100));
    this.amountOut.textContent = `${Math.round(o.easeAmount * 100)}%`;
    this.amount.disabled = o.easing === 'linear';
    this.easeColor.checked = o.easeColor !== false;
    this.colorMode.set(o.colorMode);
    for (const b of this.cmdButtons) b.disabled = !app.commands.isEnabled(b.dataset.cmd);
    this.renderPreviews(o, ids.length ? ed.doc.get(ids[0]) : null);
  }

  /** Step positions on a line, and the step colors between the end keys (or a sample pair). */
  renderPreviews(o, blend) {
    const count = o.spacing === 'steps' ? Math.max(1, Math.min(14, o.steps)) : 9;
    const ts = Array.from({ length: count }, (_, i) => easeT((i + 1) / (count + 1), o.easing, o.easeAmount));
    this.easePreview.setAttribute('aria-label', `Step spacing preview: ${o.easing === 'linear' ? 'even' : BLEND_EASINGS.find((e) => e.value === o.easing)?.label}`);
    this.easePreview.replaceChildren(
      h('span.bp-key', { style: { left: '0%' } }),
      ...ts.map((t) => h('span.bp-dot', { style: { left: `${(t * 100).toFixed(2)}%` } })),
      h('span.bp-key', { style: { left: '100%' } }),
    );
    const ends = (blend && endColors(this.app.editor.doc, blend)) || ['#e5484d', '#3e7bfa'];
    const cs = [0, ...ts.map((t, i) => (o.easeColor === false ? (i + 1) / (count + 1) : t)), 1].map((t) => lerpColor(ends[0], ends[1], t, o.colorMode));
    this.colorPreview.setAttribute('aria-label', `Step colors from ${ends[0]} to ${ends[1]}`);
    this.colorPreview.replaceChildren(...cs.map((c) => h('span.bp-swatch', { style: { background: c } })));
  }
}
