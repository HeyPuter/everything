/**
 * Speed tab with Constant, Curve and Ramps sub-tabs (state.speedSub
 * remembers the choice; a clip with a speed curve opens on Curve, or on
 * Ramps when the curve came from a velocity ramp). Constant: 0.1x to
 * 100x on a log scale, presets and the resulting duration; changes go
 * through actions.setSpeed, which coalesces a drag into one undo step and
 * replaces a speed curve. Curve: see speed-curve.js. Ramps: see
 * speed-ramps.js. The smooth slow
 * motion and pitch options below apply to both.
 */
import { h, announce } from '../../lib/dom.js';
import { propSection, uidFor, secs, tabSet, note } from './common.js';
import { switchField, segmented } from '../controls.js';
import { hasCurve } from '../../model/speed-curve.js';
import { SMOOTH_SLOW_MODES, normalizeSmoothSlow, slowsDown } from '../../model/slow-motion.js';
import { speedCurvePanel } from './speed-curve.js';
import { speedRampsPanel } from './speed-ramps.js';

export const SPEED_MIN = 0.1;
export const SPEED_MAX = 100;
const STEPS = 300;
const RATIO = Math.log(SPEED_MAX / SPEED_MIN);

export const speedToPos = (s) => Math.round((Math.log(Math.min(SPEED_MAX, Math.max(SPEED_MIN, s)) / SPEED_MIN) / RATIO) * STEPS);
export const posToSpeed = (p) => {
  const s = SPEED_MIN * Math.exp((p / STEPS) * RATIO);
  // Snap to tidy values so the number box reads 2.0x, not 1.98x.
  return s < 10 ? Math.round(s * 10) / 10 : Math.round(s);
};
const fmt = (s) => (s < 10 ? s.toFixed(1) : String(Math.round(s)));

const PRESETS = [0.5, 1, 1.5, 2, 5, 10];

const SUBS = [
  { id: 'constant', label: 'Constant' },
  { id: 'curve', label: 'Curve' },
  { id: 'ramps', label: 'Ramps' },
];

/** Sub-tab to open on: a curved clip opens on Curve, or on Ramps when it has a ramp and Constant was last. */
function startSub(clip, last) {
  if (!hasCurve(clip)) return last || 'constant';
  if (last === 'curve' || last === 'ramps') return last;
  return clip.speedRamp ? 'ramps' : 'curve';
}

export function speedTab(view, state = {}) {
  const subs = tabSet({
    label: 'Speed mode',
    className: 'subtabs',
    items: SUBS,
    value: startSub(view.clip, state.speedSub),
    onChange: (id) => {
      state.speedSub = id;
      show(id);
    },
  });
  const smooth = smoothSlowField(view);
  const pitch = pitchToggle(view);
  const onTweak = () => {
    state.speedSub = 'curve';
    subs.select('curve');
    show('curve');
    subs.panel.querySelector('.speed-curve-canvas')?.focus();
  };
  const show = (id) => {
    view.resetScope();
    subs.panel.replaceChildren(id === 'curve' ? speedCurvePanel(view) : id === 'ramps' ? speedRampsPanel(view, { onTweak }) : constantPanel(view));
    if (smooth) view.bind(smooth.update);
    if (pitch) view.bind(pitch.update);
  };
  show(subs.current);
  return h('div.speed-tab', subs.list, subs.panel, smooth?.el || null, pitch?.el || null);
}

/**
 * "Smooth slow motion" for video clips: Off, Frame blending or Optical
 * flow. Offered while the clip plays slower than 1x somewhere (constant
 * speed or a curve that dips below 1x); the choice is kept otherwise.
 */
function smoothSlowField(view) {
  if (view.clip.type !== 'video' || view.clip.freeze) return null;
  const current = () => normalizeSmoothSlow(view.clip?.smoothSlow) || 'off';
  const seg = segmented({
    label: 'Smooth slow motion',
    options: SMOOTH_SLOW_MODES.map((m) => ({ value: m.id, label: m.label })),
    value: current(),
    onChange: (v) => {
      const label = SMOOTH_SLOW_MODES.find((m) => m.id === v).label;
      view.edit(v === 'off' ? 'Smooth slow motion off' : `Smooth slow motion: ${label}`, (x) => {
        if (v === 'off') delete x.smoothSlow;
        else x.smoothSlow = v;
      });
      announce(v === 'off' ? 'Smooth slow motion off' : `Smooth slow motion: ${label}`);
    },
  });
  const hint = h('span.field-hint', { id: uidFor('smooth-hint') });
  seg.el.setAttribute('aria-describedby', hint.id);
  const buttons = [...seg.el.querySelectorAll('button')];
  const el = h('div.speed-smooth.field', h('span.field-label', 'Smooth slow motion', hint), seg.el);
  const update = () => {
    const clip = view.clip;
    if (!clip) return;
    const on = slowsDown(clip);
    seg.set(current());
    buttons.forEach((b) => (b.disabled = !on));
    el.classList.toggle('is-off', !on);
    hint.textContent = on
      ? 'Makes new frames between the source frames where the clip plays slower than 1x. Optical flow follows the motion; blending cross-fades.'
      : 'Available when the clip plays slower than 1x.';
  };
  update();
  return { el, update };
}

/** "Keep original pitch" for clips with sound (shared by both modes). */
function pitchToggle(view) {
  const c = view.clip;
  const sound = c.type === 'audio' || (c.type === 'video' && view.project.assets[c.assetId]?.hasAudio);
  if (!sound) return null;
  // Bound by speedTab after each sub-tab switch (the switch replaces the view's updaters).
  const field = switchField({
    label: 'Keep original pitch',
    hint: 'Off: faster sounds higher, slower sounds lower.',
    checked: c.keepPitch !== false,
    onChange: (v) => {
      view.edit(v ? 'Keep original pitch' : 'Pitch follows speed', (x) => {
        if (v) delete x.keepPitch;
        else x.keepPitch = false;
      });
      announce(v ? 'Pitch kept' : 'Pitch follows speed');
    },
  });
  return {
    el: h('div.speed-pitch', field.el),
    update: () => {
      const clip = view.clip;
      if (clip) field.set(clip.keepPitch !== false);
    },
  };
}

function constantPanel(view) {
  const { store, actions } = view;
  const id = uidFor('speed');
  const range = h('input', { type: 'range', id, min: 0, max: STEPS, step: 1, value: speedToPos(view.clip.speed) });
  const num = h('input.num-input', { type: 'text', inputMode: 'decimal', 'aria-label': 'Speed value', spellcheck: false, value: fmt(view.clip.speed) });
  const durNow = h('output.speed-dur', { for: id });
  const durSrc = h('span.speed-src');
  const presetBtns = PRESETS.map((p) => {
    const b = h('button.chip', { type: 'button', 'aria-pressed': 'false' }, `${p}x`);
    b.addEventListener('click', () => commit(p, true));
    return b;
  });

  // While dragging the thumb stays where the pointer put it.
  let dragging = false;
  const paint = (s) => {
    if (!dragging) {
      range.value = String(speedToPos(s));
      range.style.setProperty('--pct', `${(Number(range.value) / STEPS) * 100}%`);
      range.setAttribute('aria-valuetext', `${fmt(s)} times`);
    }
    if (document.activeElement !== num) num.value = fmt(s);
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Math.abs(PRESETS[i] - s) < 1e-6)));
  };
  const commit = (s, final) => {
    const c = view.clip;
    if (!c) return;
    const v = Math.min(SPEED_MAX, Math.max(SPEED_MIN, s));
    if (hasCurve(c) || Math.abs(v - c.speed) > 1e-9) actions.setSpeed(view.id, v);
    if (final) {
      store.seal();
      announce(`Speed ${fmt(v)} times, ${secs(view.clip?.duration || 0)}`);
    }
  };
  range.addEventListener('input', () => {
    dragging = true;
    const s = posToSpeed(Number(range.value));
    num.value = fmt(s);
    range.style.setProperty('--pct', `${(Number(range.value) / STEPS) * 100}%`);
    range.setAttribute('aria-valuetext', `${fmt(s)} times`);
    commit(s, false);
  });
  range.addEventListener('change', () => {
    dragging = false;
    commit(posToSpeed(Number(range.value)), true);
  });
  const commitNum = () => {
    const raw = parseFloat(num.value);
    if (!Number.isFinite(raw) || raw <= 0) {
      num.value = fmt(view.clip.speed);
      return;
    }
    commit(raw, true);
    paint(view.clip.speed);
  };
  num.addEventListener('change', commitNum);
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNum();
    }
  });

  const render = () => {
    const c = view.clip;
    if (!c) return;
    paint(c.speed);
    durNow.textContent = secs(c.duration);
    durSrc.textContent = secs(c.duration * c.speed);
  };
  render();
  view.bind(render);

  const field = h('div.field.slider-field.speed-field',
    h('label.field-label', { for: id }, 'Speed'),
    h('div.slider-row', range, num, h('span.num-unit', { 'aria-hidden': 'true' }, 'x')),
  );
  const presets = h('div.chip-row', { role: 'group', 'aria-label': 'Speed presets' }, presetBtns);
  const info = h('dl.insp-kv', h('dt', 'Duration'), h('dd', durNow), h('dt', 'At 1x'), h('dd', durSrc));
  // A curved clip shows its mean speed here; setting a speed replaces the curve.
  const curveNote = note('This clip follows a speed curve. Setting a constant speed replaces it.', 'speedCurve');
  const showNote = () => (curveNote.hidden = !hasCurve(view.clip));
  showNote();
  view.bind(showNote);
  return h('div', propSection('Constant speed', [curveNote, field, presets, info], {
    onReset: () => commit(1, true),
  }));
}
