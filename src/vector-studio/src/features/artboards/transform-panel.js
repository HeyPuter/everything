/**
 * Transform panel (Shift+F8): the shared transform section (reference
 * point, X, Y, W, H, rotation, flips) plus shear angle, Scale Corners and
 * Scale Strokes & Effects, and the live shape properties of a single
 * rectangle, ellipse, polygon or star.
 */
import { h } from '../../lib/dom.js';
import { Panel, emptyState } from '../../ui/panels/panel.js';
import { createTransformSection, transformState } from '../../ui/panels/transform-section.js';
import { numberField } from '../../ui/widgets.js';
import { createShapeSection } from '../../ui/panels/shape-section.js';
import { shear, decompose } from '../../lib/matrix.js';
import { applyTransform } from '../../commands/core.js';

const REF = [
  [0, 0], [0.5, 0], [1, 0],
  [0, 0.5], [0.5, 0.5], [1, 0.5],
  [0, 1], [0.5, 1], [1, 1],
];

/** Current shear of a single text or image (degrees), else 0. */
export function selectionShear(editor) {
  const nodes = editor.selectedNodes();
  if (nodes.length !== 1 || !nodes[0].transform) return 0;
  return -decompose(nodes[0].transform).skew;
}

export class TransformPanel extends Panel {
  static id = 'transform';
  static title = 'Transform';
  static icon = 'scaling';
  static placement = 'strip';
  static shortcut = 'Shift+F8';

  menu() {
    const app = this.app;
    const p = app.prefs;
    const mode = p.get('transformMode') || 'both';
    const toggle = (key, label) => ({ label, checked: Boolean(p.get(key)), run: () => (p.set(key, !p.get(key)), this.update()) });
    const modeItem = (value, label) => ({ label, checked: mode === value, run: () => (p.set('transformMode', value), this.update()) });
    return [
      { label: this.showOptions ? 'Hide Options' : 'Show Options', run: () => (p.set('transformShowOptions', !this.showOptions), this.update()) },
      '-',
      'object.flipH',
      'object.flipV',
      '-',
      toggle('scaleStrokes', 'Scale Strokes & Effects'),
      toggle('scaleCorners', 'Scale Corners'),
      toggle('previewBounds', 'Use Preview Bounds'),
      '-',
      modeItem('object', 'Transform Object Only'),
      modeItem('pattern', 'Transform Pattern Only'),
      modeItem('both', 'Transform Both'),
    ];
  }

  get showOptions() {
    return this.app.prefs.get('transformShowOptions') !== false;
  }

  build() {
    const app = this.app;
    this.section = createTransformSection(app);
    this.shear = numberField({
      label: 'Shear',
      kind: 'angle',
      value: 0,
      icon: 'shear-angle',
      onCommit: (v) => {
        const ed = app.editor;
        const b = ed?.selectionBounds();
        if (!b) return;
        const [fx, fy] = REF[transformState.ref];
        const delta = v - selectionShear(ed);
        if (Math.abs(delta) < 1e-9 || Math.abs(v) >= 89.99) return;
        applyTransform(ed, 'Shear', shear(-delta, 0, b.x + b.w * fx, b.y + b.h * fy));
      },
    });
    const check = (key, label) => {
      const id = `tp-${key}-${Math.random().toString(36).slice(2, 7)}`;
      const input = h('input', { type: 'checkbox', id, onchange: () => app.prefs.set(key, input.checked) });
      input.dataset.pref = key;
      return h('div.check-row', input, h('label', { for: id }, label));
    };
    this.checks = h('div.tp-checks', check('scaleCorners', 'Scale Corners'), check('scaleStrokes', 'Scale Strokes & Effects'));
    this.shapeTitle = h('h3.section-title');
    this.shapes = createShapeSection(app, { kinds: ['rect', 'ellipse', 'polygon', 'star'] });
    this.shapeSection = h('section.panel-section', this.shapeTitle, this.shapes.el);
    this.empty = emptyState('Open or create a document to transform objects.');
    this.modeNote = h('p.tp-mode', { 'aria-live': 'polite' });
    this.checksSection = h('section.panel-section', this.checks, this.modeNote);
    this.el.append(this.empty, h('section.panel-section', this.section.el, h('div.tf-row', this.shear.el)), this.checksSection, this.shapeSection);
  }

  update() {
    const ed = this.app.editor;
    this.empty.hidden = Boolean(ed);
    for (const c of this.el.children) if (c !== this.empty) c.hidden = !ed;
    if (!ed) return;
    this.section.refresh();
    const has = ed.selection.size > 0;
    this.shear.input.disabled = !has;
    this.shear.set(has ? selectionShear(ed) : null);
    for (const input of this.checks.querySelectorAll('input')) input.checked = Boolean(this.app.prefs.get(input.dataset.pref));
    // Hide Options hides the checkboxes and the shape properties.
    this.checksSection.hidden = !this.showOptions;
    const mode = this.app.prefs.get('transformMode') || 'both';
    this.modeNote.textContent = mode === 'object' ? 'Transforms objects only (patterns stay put).' : mode === 'pattern' ? 'Transforms patterns only.' : '';
    this.modeNote.hidden = mode === 'both';
    this.updateShape(ed);
  }

  updateShape(ed) {
    // The same live shape properties as the Properties panel (lines have no box to transform here).
    const shown = this.showOptions && this.shapes.update(ed);
    this.shapeSection.hidden = !shown;
    if (shown) this.shapeTitle.textContent = this.shapes.title;
  }
}
