/**
 * Color > HSL: hue, saturation and luminance per hue range. A row of
 * swatches picks the range (a dot marks ranges that are changed); the
 * eyedropper picks the range of a color clicked on the preview.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { HSL_RANGES, hsvToRgb, nearestHslRange } from '../../model/color.js';
import { slider, keepFocus } from './common.js';
import { gradeSection, editGrade } from './color-common.js';
import { pickFromPlayer } from '../color-tools.js';

const FIELDS = [
  { key: 'h', label: 'Hue' },
  { key: 's', label: 'Saturation' },
  { key: 'l', label: 'Luminance' },
];

const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`;

/** Slider track gradients that show what each slider does to the range. */
function tracks(range) {
  const hue = (dh) => css(hsvToRgb((range.hue + dh + 360) % 360, 0.85, 0.95));
  return {
    h: `linear-gradient(to right, ${hue(-30)}, ${hue(0)}, ${hue(30)})`,
    s: `linear-gradient(to right, ${css(hsvToRgb(range.hue, 0, 0.75))}, ${css(hsvToRgb(range.hue, 1, 0.9))})`,
    l: `linear-gradient(to right, ${css(hsvToRgb(range.hue, 0.9, 0.12))}, ${css(hsvToRgb(range.hue, 0.85, 0.85))}, ${css(hsvToRgb(range.hue, 0.25, 1))})`,
  };
}

const changed = (clip, id) => {
  const e = clip?.grade?.hsl?.[id];
  return Boolean(e && (e.h || e.s || e.l));
};

export function hslTab(view, state = {}) {
  let current = HSL_RANGES.some((r) => r.id === state.hslRange) ? state.hslRange : 'red';
  const range = () => HSL_RANGES.find((r) => r.id === current);

  const swatches = HSL_RANGES.map((r) => {
    const b = h('button.hsl-swatch', { type: 'button', role: 'radio', 'aria-label': r.label, 'data-tip': r.label, style: { '--swatch': r.swatch }, dataset: { id: r.id } });
    b.addEventListener('click', () => select(r.id));
    return b;
  });
  const group = h('div.hsl-swatches', { role: 'radiogroup', 'aria-label': 'Hue range', 'data-own-arrows': '' }, swatches);
  group.addEventListener('keydown', (e) => {
    const i = HSL_RANGES.findIndex((r) => r.id === current);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % HSL_RANGES.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + HSL_RANGES.length) % HSL_RANGES.length;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    select(HSL_RANGES[j].id);
    swatches[j].focus();
  });

  const picker = h('button.icon-btn.hsl-picker', { type: 'button', 'aria-label': 'Pick a color from the preview', 'data-tip': 'Pick a color from the preview', 'aria-pressed': 'false' }, icon('pipette', 16));
  let cancelPick = null;
  picker.addEventListener('click', () => {
    if (cancelPick) {
      cancelPick();
      return;
    }
    picker.setAttribute('aria-pressed', 'true');
    const done = () => {
      cancelPick = null;
      picker.setAttribute('aria-pressed', 'false');
    };
    cancelPick = pickFromPlayer(view.ctx, view.id, {
      onPick: (rgb) => {
        done();
        select(nearestHslRange(...rgb));
        announce(`${range().label} selected`);
      },
      onCancel: done,
    });
  });

  const fields = FIELDS.map((f) => slider(view, {
    label: f.label,
    min: -100,
    max: 100,
    className: `centered hsl-${f.key}`,
    get: (c) => Math.round(c.grade?.hsl?.[current]?.[f.key] ?? 0),
    set: (v, final) => editGrade(view, `${range().label} ${f.label.toLowerCase()}`, (g) => {
      const e = (g.hsl[current] ||= { h: 0, s: 0, l: 0 });
      e[f.key] = v;
    }, { key: `hsl-${current}-${f.key}`, final }),
  }));
  const resetRange = h('button.btn.small.ghost', { type: 'button' }, icon('rotateLeft', 14), h('span.hsl-reset-label'));
  // The button turns off once the range is reset; focus goes to the range.
  resetRange.addEventListener('click', () => keepFocus(() => editGrade(view, `Reset ${range().label.toLowerCase()}`, (g) => {
    if (!g.hsl[current]) return false;
    delete g.hsl[current];
  }), () => swatches.find((b) => b.dataset.id === current)));

  function paint() {
    const r = range();
    const t = tracks(r);
    fields.forEach((f, i) => f.el.style.setProperty('--track', t[FIELDS[i].key]));
    swatches.forEach((b) => {
      const on = b.dataset.id === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('changed', changed(view.clip, b.dataset.id));
    });
    resetRange.querySelector('.hsl-reset-label').textContent = `Reset ${r.label.toLowerCase()}`;
    resetRange.disabled = !changed(view.clip, current);
  }

  function select(id) {
    current = id;
    state.hslRange = id;
    paint();
    view.scope.update();
  }

  paint();
  view.bind(paint);
  return h('div.hsl-tab', gradeSection(view, {
    id: 'hsl',
    title: 'HSL',
    children: [
      h('div.hsl-head', picker, group),
      fields.map((f) => f.el),
      h('div.hsl-foot', resetRange),
    ],
    onReset: () => editGrade(view, 'Reset HSL', (g) => {
      g.hsl = {};
    }),
  }));
}
