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
import { shapeAnchors } from '../../model/shapes.js';
import { shear, decompose } from '../../lib/matrix.js';
import { applyTransform } from '../../commands/core.js';
import { nodeFrameAngle, normAngle } from '../../model/geometry.js';

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
    this.shapeBody = h('div.shape-props');
    this.shapeSection = h('section.panel-section', this.shapeTitle, this.shapeBody);
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
    const nodes = ed.selectedNodes();
    const n = nodes.length === 1 ? nodes[0] : null;
    const shape = n?.type === 'path' ? n.shape : null;
    this.shapeSection.hidden = !shape || shape.kind === 'line' || !this.showOptions;
    if (this.shapeSection.hidden) {
      this.shapeKey = null;
      return;
    }
    const unit = ed.doc.root.units || 'pt';
    const key = `${n.id}:${shape.kind}:${unit}`;
    const setShape = (patch, live) => {
      const cur = ed.doc.get(n.id);
      if (!cur?.shape) return;
      const next = { ...cur.shape, ...patch };
      const anchors = shapeAnchors(next);
      if (!anchors) return;
      // Turning the shape turns its bounding box with it.
      const turn = (next.angle || 0) - (cur.shape.angle || 0);
      const frame = turn ? { frameAngle: normAngle(nodeFrameAngle(cur) + turn) } : {};
      ed.doc.transact('Change Shape', () => ed.doc.update(n.id, { shape: next, anchors, ...frame }), { coalesce: live ? `tp-shape-${n.id}` : null });
    };
    const titles = { rect: 'Rectangle Properties', ellipse: 'Ellipse Properties', polygon: 'Polygon Properties', star: 'Star Properties' };
    this.shapeTitle.textContent = titles[shape.kind] || 'Shape Properties';
    if (this.shapeKey !== key) {
      this.shapeKey = key;
      const f = {};
      if (shape.kind === 'rect' || shape.kind === 'ellipse') {
        f.w = numberField({ label: 'W', value: shape.w, unit, min: 0.001, onCommit: (v, o) => setShape({ w: v }, o?.live) });
        f.h = numberField({ label: 'H', value: shape.h, unit, min: 0.001, onCommit: (v, o) => setShape({ h: v }, o?.live) });
      }
      if (shape.kind === 'polygon') {
        f.sides = numberField({ label: 'Sides', kind: 'number', value: shape.sides, min: 3, max: 1000, onCommit: (v, o) => setShape({ sides: Math.round(v) }, o?.live) });
        f.r = numberField({ label: 'Radius', value: shape.r, unit, min: 0, onCommit: (v, o) => setShape({ r: v }, o?.live) });
      }
      if (shape.kind === 'star') {
        f.points = numberField({ label: 'Points', kind: 'number', value: shape.points, min: 3, max: 1000, onCommit: (v, o) => setShape({ points: Math.round(v) }, o?.live) });
        f.r1 = numberField({ label: 'Radius 1', value: shape.r1, unit, min: 0, onCommit: (v, o) => setShape({ r1: v }, o?.live) });
        f.r2 = numberField({ label: 'Radius 2', value: shape.r2, unit, min: 0, onCommit: (v, o) => setShape({ r2: v }, o?.live) });
      }
      f.angle = numberField({ label: 'Shape angle', kind: 'angle', icon: 'rotate-ccw', value: shape.angle || 0, onCommit: (v, o) => setShape({ angle: v }, o?.live) });
      if (shape.kind === 'rect') {
        const radii = shape.radii || [0, 0, 0, 0];
        ['Top left', 'Top right', 'Bottom right', 'Bottom left'].forEach((label, i) => {
          f[`r${i}`] = numberField({
            label: `${label} corner radius`,
            icon: 'corner-radius',
            value: radii[i] || 0,
            unit,
            min: 0,
            onCommit: (v, o) => {
              const cur = ed.doc.get(n.id)?.shape?.radii || [0, 0, 0, 0];
              const next = cur.slice();
              next[i] = v;
              setShape({ radii: next }, o?.live);
            },
          });
        });
      }
      this.shapeFields = f;
      this.shapeBody.replaceChildren(h('div.tf-fields', ...Object.values(f).map((x) => x.el)), h('button.btn.small', { type: 'button', onclick: () => ed.doc.transact('Expand Shape', () => ed.doc.update(n.id, { shape: undefined })) }, 'Expand Shape'));
    } else {
      const f = this.shapeFields;
      for (const k of ['w', 'h', 'sides', 'r', 'points', 'r1', 'r2']) if (f[k]) f[k].set(shape[k]);
      f.angle.set(shape.angle || 0);
      if (shape.kind === 'rect') for (let i = 0; i < 4; i++) f[`r${i}`].set(shape.radii?.[i] || 0);
    }
  }
}
