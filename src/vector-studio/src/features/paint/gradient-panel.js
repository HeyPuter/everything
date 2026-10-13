/**
 * Gradient panel (Cmd+F9): gradient presets (the document's gradient
 * swatches), gradient type (linear / radial / freeform), the gradient
 * slider with stops and midpoints, stop color / opacity / location, angle,
 * aspect ratio for radial gradients, reverse, and how a gradient applies
 * to a stroke (within the stroke). Freeform gradients show the selected
 * color point's color, opacity and spread instead of the slider (points are
 * added and moved with the Gradient tool). Edits apply to the focused fill
 * or stroke of the selection; when that paint is not a gradient yet, the
 * panel shows the last gradient used and clicking the thumbnail (or
 * editing anything) applies it. The panel menu shows or hides the options,
 * switches the type, reverses the gradient and adds it to Swatches.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, numberField, paintSwatch, updatePaintSwatch, segmented } from '../../ui/widgets.js';
import { openPopover } from '../../ui/popover.js';
import { createColorPicker } from '../../ui/color-picker.js';
import { applyStyle } from '../../ops/paint-ops.js';
import { createGradientSlider } from './gradient-slider.js';
import { DEFAULT_LINEAR, setStop, removeStop, reverseGradient, setGradientType, gradientAngle, setGradientAngle, normalizeGradient, resetGradientVector } from './gradient-model.js';
import { isGradient } from '../../model/gradients.js';
import { miniFillStroke, focusedPaint, gestureKey, paintState } from './ui-common.js';
import { isFreeform, setPoint, removePoint } from './freeform.js';
import { swatchesOf } from './swatch-model.js';
import { createSwatchFromFocused } from './swatches-panel.js';

/** Popover to edit one color: swatches plus the color picker. */
export function openColorPopover(app, anchor, { color, title = 'Color', onInput }) {
  const swatches = (app.editor?.doc.root.swatches || []).filter((s) => s.paint?.type === 'solid');
  const grid = h('div.swatch-grid', { role: 'listbox', 'aria-label': `${title} swatches` });
  const picker = createColorPicker({ value: color, label: title, onInput: (hex) => onInput(hex, { swatchId: null }) });
  for (const s of swatches) {
    grid.append(
      h('button.swatch-cell', {
        type: 'button',
        role: 'option',
        'aria-label': s.name,
        'data-tip': s.name,
        onclick: () => {
          picker.set(s.paint.color);
          onInput(s.paint.color, { swatchId: s.global ? s.id : null });
        },
      }, paintSwatch(s.paint)),
    );
  }
  openPopover(anchor, h('div.paint-popover', h('h3.popover-title', title), grid, picker.el), { label: title });
}

export class GradientPanel extends Panel {
  static id = 'gradient';
  static title = 'Gradient';
  static icon = 'paint-gradient';
  static placement = 'strip';
  static shortcut = 'Mod+F9';

  build() {
    const app = this.app;
    this.coalesce = gestureKey('gradient');
    this.fs = miniFillStroke(app);
    this.thumbSw = paintSwatch(null);
    this.thumb = h('button.gp-thumb', { type: 'button', 'aria-label': 'Apply gradient', 'data-tip': 'Gradient: click to apply', onclick: () => this.commit(this.paint, 'Apply Gradient', null) }, this.thumbSw);
    this.type = segmented(
      'Gradient type',
      [
        { value: 'linear', label: 'Linear Gradient', icon: 'gradient-linear' },
        { value: 'radial', label: 'Radial Gradient', icon: 'gradient-radial' },
        { value: 'freeform', label: 'Freeform Gradient', icon: 'gradient-freeform' },
      ],
      'linear',
      (v) => this.setType(v),
    );
    this.presets = h('div.gp-presets', { role: 'listbox', 'aria-label': 'Gradient presets' });
    this.editBtn = h('button.btn.small', { type: 'button', onclick: () => app.setTool('gradient') }, 'Edit Gradient');
    this.strokeMode = segmented(
      'Stroke gradient',
      [
        { value: 'within', label: 'Apply gradient within stroke', icon: 'stroke-within' },
        { value: 'along', label: 'Apply gradient along stroke (not available)', icon: 'stroke-along' },
        { value: 'across', label: 'Apply gradient across stroke (not available)', icon: 'stroke-across' },
      ],
      'within',
      () => {},
    );
    this.strokeMode.el.querySelectorAll('button').forEach((b, i) => (b.disabled = i > 0));
    this.strokeRow = h('div.pp-row.gp-stroke', h('span.pp-label', 'Stroke'), this.strokeMode.el);
    this.angle = numberField({
      label: 'Angle',
      kind: 'angle',
      value: 0,
      min: -360,
      max: 360,
      width: '64px',
      onCommit: (v, o) => {
        if (!o?.live) this.coalesce = gestureKey('gradient');
        this.commit(setGradientAngle(this.paint, v), 'Gradient Angle', this.coalesce);
      },
    });
    this.aspect = numberField({
      label: 'Aspect ratio',
      kind: 'percent',
      value: 100,
      min: 0.5,
      max: 32767,
      width: '64px',
      onCommit: (v, o) => {
        if (!o?.live) this.coalesce = gestureKey('gradient');
        this.commit({ ...this.paint, aspect: v / 100 }, 'Gradient Aspect Ratio', this.coalesce);
      },
    });
    this.reverse = iconButton('arrow-left-right', 'Reverse Gradient', () => this.commit(reverseGradient(this.paint), 'Reverse Gradient', null), { className: 'small' });
    this.resetVec = iconButton('refresh-cw', 'Fit gradient to the object', () => this.commit(resetGradientVector(this.paint), 'Reset Gradient', null), { className: 'small' });
    this.slider = createGradientSlider({
      onGestureStart: () => (this.coalesce = gestureKey('gradient')),
      onSelect: (i) => {
        paintState.setStop(i);
        this.refreshStop();
      },
      onChange: (p) => this.commit(p, 'Edit Gradient', this.coalesce),
      onEditStop: (i, anchor) => this.editStopColor(i, anchor),
    });
    this.stopChip = paintSwatch(null);
    this.stopBtn = h('button.swatch-btn', { type: 'button', 'aria-label': 'Stop color', 'aria-haspopup': 'dialog', onclick: (e) => this.editStopColor(this.slider.selected, e.currentTarget) }, this.stopChip);
    this.opacity = numberField({
      label: 'Opacity',
      kind: 'percent',
      value: 100,
      min: 0,
      max: 100,
      width: '56px',
      onCommit: (v, o) => {
        if (!o?.live) this.coalesce = gestureKey('gradient');
        this.commit(setStop(this.paint, this.slider.selected, { opacity: v / 100 }), 'Stop Opacity', this.coalesce);
      },
    });
    this.location = numberField({
      label: 'Location',
      kind: 'percent',
      value: 0,
      min: 0,
      max: 100,
      width: '56px',
      onCommit: (v, o) => {
        if (!o?.live) this.coalesce = gestureKey('gradient');
        const p = normalizeGradient(setStop(this.paint, this.slider.selected, { offset: v / 100 }));
        this.commit(p, 'Stop Location', this.coalesce);
      },
    });
    this.delStop = iconButton('trash', 'Delete Stop', () => {
      if (this.paint.stops.length <= 2) return;
      const i = this.slider.selected;
      paintState.setStop(Math.max(0, i - 1));
      this.commit(removeStop(this.paint, i), 'Delete Stop', null);
    }, { className: 'small' });
    this.aspectRow = h('div.gp-field', this.aspect.el);

    // Freeform: the selected color point.
    this.pointChip = paintSwatch(null);
    this.pointBtn = h('button.swatch-btn', { type: 'button', 'aria-label': 'Point color', 'aria-haspopup': 'dialog', onclick: (e) => this.editPointColor(e.currentTarget) }, this.pointChip);
    this.pointOpacity = numberField({
      label: 'Opacity',
      kind: 'percent',
      value: 100,
      min: 0,
      max: 100,
      width: '56px',
      onCommit: (v, o) => {
        if (!o?.live) this.coalesce = gestureKey('gradient');
        this.commit(setPoint(this.paint, this.pointIndex(), { opacity: v / 100 }), 'Point Opacity', this.coalesce);
      },
    });
    this.spread = numberField({
      label: 'Spread',
      kind: 'percent',
      value: 0,
      min: 0,
      max: 100,
      width: '56px',
      onCommit: (v, o) => {
        if (!o?.live) this.coalesce = gestureKey('gradient');
        this.commit(setPoint(this.paint, this.pointIndex(), { spread: v / 100 }), 'Point Spread', this.coalesce);
      },
    });
    this.delPoint = iconButton('trash', 'Delete Color Point', () => {
      if (this.paint.points.length <= 1) return;
      const i = this.pointIndex();
      paintState.setStop(Math.max(0, i - 1));
      this.commit(removePoint(this.paint, i), 'Delete Color Point', null);
    }, { className: 'small' });
    this.pointNote = h('p.gp-note.muted');
    this.freeform = h(
      'div.gp-freeform',
      h('div.gp-stoprow', this.pointBtn, h('div.gp-field', this.pointOpacity.el), h('div.gp-field', this.spread.el), this.delPoint),
      this.pointNote,
    );
    this.linearOnly = h('div.gp-linear', h('div.gp-row', h('div.gp-field', this.angle.el), this.aspectRow), this.slider.el, h('div.gp-stoprow', this.stopBtn, h('div.gp-field', this.opacity.el), h('div.gp-field', this.location.el), this.delStop));
    this.options = h('div.gp-options', h('div.gp-row', this.editBtn, this.reverse, this.resetVec), this.strokeRow, this.linearOnly, this.freeform);
    this.el.append(
      this.presets,
      h('div.gp-top', this.thumb, h('div.gp-type', h('span.pp-label', 'Type'), this.type.el), this.fs.el),
      this.options,
    );
    this.setOptionsShown(app.prefs.get('gradientOptions') !== false);
  }

  setOptionsShown(on) {
    this.optionsShown = on;
    this.app.prefs.set('gradientOptions', on);
    this.options.hidden = !on;
  }

  setType(v) {
    if (v === 'freeform' || this.paint?.type === 'freeform') paintState.setStop(0);
    this.commit(setGradientType(this.paint, v), 'Gradient Type', null);
    // Freeform points are placed and moved on the canvas.
    if (v === 'freeform' && this.app.toolId !== 'gradient') this.app.notify('Use the Gradient tool to add, move and delete color points.', { polite: true });
  }

  menu() {
    const ed = this.app.editor;
    const type = this.paint?.type;
    const ff = type === 'freeform';
    return [
      { label: this.optionsShown ? 'Hide Options' : 'Show Options', run: () => this.setOptionsShown(!this.optionsShown) },
      '-',
      { label: 'Linear Gradient', checked: type === 'linear', enabled: Boolean(ed), run: () => this.setType('linear') },
      { label: 'Radial Gradient', checked: type === 'radial', enabled: Boolean(ed), run: () => this.setType('radial') },
      { label: 'Freeform Gradient', checked: ff, enabled: Boolean(ed), run: () => this.setType('freeform') },
      '-',
      { label: 'Reverse Gradient', enabled: Boolean(ed) && !ff, run: () => this.commit(reverseGradient(this.paint), 'Reverse Gradient', null) },
      { label: 'Fit Gradient to Object', enabled: Boolean(ed) && !ff && this.paint?.x1 !== undefined, run: () => this.commit(resetGradientVector(this.paint), 'Reset Gradient', null) },
      { label: 'Edit Gradient', enabled: Boolean(ed), run: () => this.app.setTool('gradient') },
      '-',
      { label: 'Add to Swatches', enabled: Boolean(ed), run: () => this.addToSwatches() },
    ];
  }

  /** Add the current gradient to Swatches (applying it first if it is only shown). */
  addToSwatches() {
    const ed = this.app.editor;
    if (!ed) return;
    if (!this.applied) this.commit(this.paint, 'Apply Gradient', null);
    return createSwatchFromFocused(this.app, { direct: true }).then((id) => id && this.app.notify('Added the gradient to Swatches.', { polite: true }));
  }

  pointIndex() {
    return Math.min(paintState.stop, (this.paint?.points?.length || 1) - 1);
  }

  editPointColor(anchor) {
    const i = this.pointIndex();
    const pt = this.paint?.points?.[i];
    if (!pt) return;
    const coalesce = gestureKey('gradient-point');
    openColorPopover(this.app, anchor, { color: pt.color, title: `Point ${i + 1} Color`, onInput: (hex) => this.commit(setPoint(this.paint, i, { color: hex }), 'Point Color', coalesce) });
  }

  renderPresets() {
    const ed = this.app.editor;
    const list = ed ? swatchesOf(ed.doc).filter((s) => s.paint && (isGradient(s.paint) || isFreeform(s.paint))) : [];
    if (list === this.presetList || (this.presetList && list.length === this.presetList.length && list.every((s, i) => s === this.presetList[i]))) return;
    this.presetList = list;
    this.presets.replaceChildren(
      ...list.map((s) =>
        h('button.gp-preset', { type: 'button', role: 'option', 'aria-label': `Apply ${s.name}`, 'data-tip': s.name, onclick: () => this.commit(structuredClone(s.paint), 'Apply Gradient', null) }, paintSwatch(s.paint)),
      ),
    );
    this.presets.hidden = !list.length;
  }

  /** Current gradient (from the focused paint, or the last / default one). */
  current() {
    const ed = this.app.editor;
    const { paint } = ed ? focusedPaint(ed) : { paint: null };
    if (paint && paint !== 'mixed' && (isGradient(paint) || isFreeform(paint))) return { paint, applied: true };
    return { paint: paintState.lastGradient || ed?.lastGradient || DEFAULT_LINEAR, applied: false };
  }

  commit(paint, label, coalesce) {
    const ed = this.app.editor;
    if (!ed) return;
    const next = { ...paint };
    delete next.swatchId;
    this.paint = next;
    paintState.lastGradient = next;
    ed.lastGradient = resetGradientVector(next);
    applyStyle(ed, { [ed.focusPaint]: next }, label, coalesce);
  }

  editStopColor(i, anchor) {
    const s = this.paint.stops[i];
    if (!s) return;
    paintState.setStop(i);
    const coalesce = gestureKey('gradient-stop');
    openColorPopover(this.app, anchor, {
      color: s.color,
      title: `Stop ${i + 1} Color`,
      onInput: (hex, { swatchId }) => {
        const stop = { color: hex };
        const p = setStop(this.paint, i, stop);
        const out = { ...p, stops: p.stops.map((x, j) => {
          if (j !== i) return x;
          const y = { ...x };
          if (swatchId) y.swatchId = swatchId;
          else delete y.swatchId;
          return y;
        }) };
        this.commit(out, 'Stop Color', coalesce);
      },
    });
  }

  refreshStop() {
    const p = this.paint;
    if (!p || !p.stops) return;
    const s = p.stops[this.slider.selected] || p.stops[0];
    updatePaintSwatch(this.stopChip, { type: 'solid', color: s.color });
    this.opacity.set((s.opacity ?? 1) * 100);
    this.location.set(s.offset * 100);
    this.delStop.disabled = p.stops.length <= 2;
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    if (!ed) return;
    this.fs.refresh();
    this.renderPresets();
    const { paint, applied } = this.current();
    this.paint = paint;
    this.applied = applied;
    this.el.classList.toggle('not-applied', !applied);
    updatePaintSwatch(this.thumbSw, paint);
    this.type.set(paint.type);
    const ff = paint.type === 'freeform';
    this.linearOnly.hidden = ff;
    this.freeform.hidden = !ff;
    this.reverse.disabled = ff;
    if (ff) {
      const i = this.pointIndex();
      const pt = paint.points[i];
      this.strokeRow.hidden = ed.focusPaint !== 'stroke';
      this.resetVec.disabled = true;
      if (pt) {
        updatePaintSwatch(this.pointChip, { type: 'solid', color: pt.color });
        this.pointOpacity.set((pt.opacity ?? 1) * 100);
        this.spread.set((pt.spread ?? 0) * 100);
      }
      this.delPoint.disabled = paint.points.length <= 1;
      this.pointNote.textContent = `Point ${i + 1} of ${paint.points.length}. With the Gradient tool, click the object to add a point, drag points to move them, Delete removes the selected one.`;
      return;
    }
    this.angle.set(gradientAngle(paint));
    this.aspect.set((paint.aspect ?? 1) * 100);
    this.aspectRow.hidden = paint.type !== 'radial';
    this.strokeRow.hidden = ed.focusPaint !== 'stroke';
    this.resetVec.disabled = paint.x1 === undefined;
    const sel = Math.min(paintState.stop, paint.stops.length - 1);
    this.slider.set(paint, sel);
    this.refreshStop();
  }

  shown() {
    super.shown();
    if (!this.offStop) this.offStop = paintState.on('stop', () => this.visible && this.update());
  }
}
