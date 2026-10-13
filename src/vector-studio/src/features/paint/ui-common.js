/**
 * Shared UI pieces for the paint panels: the fill/stroke mini widget, color
 * channel sliders with ramps, gesture-scoped undo coalescing, and the
 * "focused paint" helpers that read and write the fill or stroke in front.
 */
import { h } from '../../lib/dom.js';
import { paintSwatch, updatePaintSwatch } from '../../ui/widgets.js';
import { applyStyle, commonStyle } from '../../ops/paint-ops.js';
import { MODES, rampCss, formatChannel, parseChannel } from './color-modes.js';
import { isGradient } from '../../model/gradients.js';
import { Emitter } from '../../lib/emitter.js';

/** Cross-panel paint UI state: the selected gradient stop and the last gradient used. */
export const paintState = new Emitter();
paintState.stop = 0;
paintState.lastGradient = null;
paintState.setStop = (i) => {
  if (paintState.stop === i) return;
  paintState.stop = i;
  paintState.emit('stop', i);
};

let gestureCounter = 0;
/** A fresh undo coalescing key; call when a drag or edit gesture starts. */
export function gestureKey(prefix) {
  gestureCounter++;
  return `${prefix}-${gestureCounter}`;
}

/** The focused paint key and its current value across the selection. */
export function focusedPaint(editor) {
  const key = editor.focusPaint || 'fill';
  return { key, paint: commonStyle(editor, key) };
}

/** Fallback color shown for None/mixed/gradient paints. */
export function displayColor(editor, key, paint) {
  if (paint && paint !== 'mixed') {
    if (paint.type === 'solid') return paint.color;
    if (isGradient(paint)) {
      const s = paint.stops[Math.min(paintState.stop, paint.stops.length - 1)] || paint.stops[0];
      return s?.color || '#000000';
    }
    // Freeform gradients: the selected color point.
    if (paint.type === 'freeform' && paint.points?.length) return paint.points[Math.min(paintState.stop, paint.points.length - 1)].color;
  }
  return editor.lastSolid?.[key] || (key === 'fill' ? '#ffffff' : '#000000');
}

/**
 * Set a color on the focused paint: a solid paint, or the selected stop of
 * a gradient. Live edits share one undo step through `coalesce`.
 */
export function setFocusedColor(editor, hex, coalesce = null, { forceSolid = false } = {}) {
  const { key, paint } = focusedPaint(editor);
  if (!forceSolid && paint && paint !== 'mixed' && paint.type === 'freeform' && paint.points?.length) {
    const i = Math.min(paintState.stop, paint.points.length - 1);
    const next = { ...paint, points: paint.points.map((p, j) => (j === i ? { ...p, color: hex } : p)) };
    delete next.swatchId;
    applyStyle(editor, { [key]: next }, key === 'fill' ? 'Fill Color' : 'Stroke Color', coalesce);
    return;
  }
  if (!forceSolid && paint && paint !== 'mixed' && isGradient(paint)) {
    const i = Math.min(paintState.stop, paint.stops.length - 1);
    const stops = paint.stops.map((s, j) => {
      if (j !== i) return s;
      const out = { ...s, color: hex };
      delete out.swatchId;
      return out;
    });
    const next = { ...paint, stops };
    delete next.swatchId;
    applyStyle(editor, { [key]: next }, key === 'fill' ? 'Fill Color' : 'Stroke Color', coalesce);
    return;
  }
  editor.lastSolid = { ...(editor.lastSolid || {}), [key]: hex };
  applyStyle(editor, { [key]: { type: 'solid', color: hex } }, key === 'fill' ? 'Fill Color' : 'Stroke Color', coalesce);
}

/** Fill/stroke mini widget (click to bring one to the front, like the Tools panel control). */
export function miniFillStroke(app, { onFocus } = {}) {
  const fillSw = paintSwatch(null, { className: 'fill' });
  const strokeSw = paintSwatch(null, { className: 'stroke' });
  const set = (which) => {
    const ed = app.editor;
    if (!ed) return;
    ed.focusPaint = which;
    ed.emit('style');
    onFocus?.(which);
  };
  const fillBtn = h('button.mfs-fill', { type: 'button', 'aria-label': 'Fill', 'data-tip': 'Fill', onclick: () => set('fill'), ondblclick: () => app.openColorPicker?.('fill') }, fillSw);
  const strokeBtn = h('button.mfs-stroke', { type: 'button', 'aria-label': 'Stroke', 'data-tip': 'Stroke', onclick: () => set('stroke'), ondblclick: () => app.openColorPicker?.('stroke') }, strokeSw, h('span.mfs-hole', { 'aria-hidden': 'true' }));
  const el = h('div.mini-fs', { role: 'group', 'aria-label': 'Fill and stroke' }, fillBtn, strokeBtn);
  const refresh = () => {
    const ed = app.editor;
    if (!ed) return;
    const fill = commonStyle(ed, 'fill');
    const stroke = commonStyle(ed, 'stroke');
    updatePaintSwatch(fillSw, fill === 'mixed' ? null : fill, fill === 'mixed');
    updatePaintSwatch(strokeSw, stroke === 'mixed' ? null : stroke, stroke === 'mixed');
    el.classList.toggle('stroke-front', ed.focusPaint === 'stroke');
    fillBtn.setAttribute('aria-pressed', String(ed.focusPaint !== 'stroke'));
    strokeBtn.setAttribute('aria-pressed', String(ed.focusPaint === 'stroke'));
  };
  return { el, refresh };
}

/**
 * Channel sliders for a color mode: each row has a label, a range input
 * whose track shows the channel's ramp, and a numeric field.
 *   onInput(hex, values)   while dragging (live)
 *   onCommit(hex, values)  on release / field commit
 *   onStart()              when a gesture starts (new undo step)
 */
export function colorSliders({ mode = 'rgb', label = 'Color', onInput, onCommit, onStart }) {
  const el = h('div.color-sliders');
  let values = [];
  let curMode = mode;
  let rows = [];

  const build = () => {
    const def = MODES[curMode];
    rows = def.channels.map((ch, i) => {
      const id = `cs-${Math.random().toString(36).slice(2, 8)}`;
      const range = h('input.cs-range', { type: 'range', id, min: ch.min, max: ch.max, step: ch.step === 51 ? 51 : ch.max > 100 ? 1 : 0.5, 'aria-label': `${label} ${ch.label}` });
      const field = h('input.cs-field', { type: 'text', inputmode: ch.hex ? 'text' : 'decimal', spellcheck: false, autocomplete: 'off', 'aria-label': `${label} ${ch.label} value` });
      const unit = h('span.cs-unit', { 'aria-hidden': 'true' }, ch.unit);
      range.addEventListener('pointerdown', () => onStart?.());
      range.addEventListener('keydown', (e) => {
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') onStart?.();
        e.stopPropagation();
      });
      range.addEventListener('input', () => {
        values[i] = Number(range.value);
        sync(i);
        onInput?.(def.to(values), values.slice());
      });
      range.addEventListener('change', () => onCommit?.(def.to(values), values.slice()));
      const commitField = () => {
        const v = parseChannel(ch, field.value);
        if (v == null) {
          field.value = formatChannel(ch, values[i]);
          return;
        }
        if (v === values[i]) return;
        onStart?.();
        values[i] = v;
        sync();
        const hex = def.to(values);
        onInput?.(hex, values.slice());
        onCommit?.(hex, values.slice());
      };
      field.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commitField();
          field.select();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (ch.step || 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          field.value = formatChannel(ch, Math.min(ch.max, Math.max(ch.min, values[i] + step)));
          commitField();
        }
      });
      field.addEventListener('blur', commitField);
      field.addEventListener('focus', () => field.select());
      return { ch, range, field, el: h('div.cs-row', h('label.cs-label', { for: id }, ch.label), range, field, unit) };
    });
    el.replaceChildren(...rows.map((r) => r.el));
  };

  const sync = (skip = -1) => {
    rows.forEach((r, i) => {
      if (i !== skip) r.range.value = String(values[i]);
      if (document.activeElement !== r.field) r.field.value = formatChannel(r.ch, values[i]);
      r.range.style.setProperty('--ramp', rampCss(curMode, values, i));
    });
  };

  build();
  return {
    el,
    get mode() {
      return curMode;
    },
    get values() {
      return values.slice();
    },
    setMode(m) {
      if (m === curMode) return;
      const hex = MODES[curMode].to(values);
      curMode = m;
      build();
      values = MODES[m].from(hex);
      sync();
    },
    /** Show a color; keeps the current channel values when they already produce it. */
    setColor(hex) {
      if (values.length && MODES[curMode].to(values).toLowerCase() === String(hex).toLowerCase()) {
        sync();
        return;
      }
      values = MODES[curMode].from(hex);
      sync();
    },
    setDisabled(on) {
      for (const r of rows) {
        r.range.disabled = on;
        r.field.disabled = on;
      }
    },
  };
}

/** Panel row helper. */
export function row(label, ...controls) {
  return h('div.pp-row', h('span.pp-label', label), ...controls);
}
