// Dialog views for Time and Pitch: Stretch and Pitch (durations you can
// type, resample lock), Pitch Shifter (ratio and precision), Pitch Bender
// (a pitch graph scaled to its range, in semitones or as a tempo change)
// and Automatic Pitch Correction (a live correction meter).

import { h } from '../../lib/dom.js';
import { cssVar } from '../../ui/theme.js';
import { hotNumber } from '../../ui/controls.js';
import { envelopeControl, registerEditor } from '../editors.js';
import { controlsFor, groupBox, radioChoice, checkbox, readout, enableWhen, showWhen, disclosure, numberField, glyph } from '../layout.js';
import { pitchRatio, bendRange, pitchFftSize } from '../defs/time-pitch.js';

/** m:ss.mmm (h:mm:ss.mmm past an hour). */
export function clockText(seconds) {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return hrs ? `${hrs}:${String(min).padStart(2, '0')}:${sec}` : `${min}:${sec}`;
}

/** Reads "1:02.5", "62.5", "1:00:00", "90s" or "2,5" as seconds (NaN when unreadable). */
export function parseClock(text) {
  const t = String(text).trim().replace(/s$/i, '').replace(',', '.');
  if (!t) return NaN;
  const parts = t.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ------------------------------------------------------- Stretch and Pitch

function stretchView(ctx) {
  const rate = ctx.doc?.sampleRate || 48000;
  const frames = ctx.range ? ctx.range[1] - ctx.range[0] : 0;
  const current = frames / rate;
  const p = ctx.def.params.find((q) => q.id === 'stretch');
  const newDuration = hotNumber({
    value: (current * ctx.values.stretch) / 100,
    min: (current * p.min) / 100,
    max: (current * p.max) / 100,
    step: 0.001,
    label: 'New duration',
    format: clockText,
    parse: parseClock,
    pixelsPerStep: 0.02,
    onInput: (s) => current && ctx.set('stretch', (s / current) * 100),
    onChange: (s) => current && ctx.set('stretch', (s / current) * 100),
  });
  newDuration.disabled = !current;
  ctx.subscribe((v) => newDuration.setValue((current * v.stretch) / 100));
  let lastAlgorithm = ctx.values.algorithm === 2 ? 0 : ctx.values.algorithm;
  const resample = h('input', {
    type: 'checkbox',
    checked: ctx.values.algorithm === 2,
    onchange: () => ctx.set('algorithm', resample.checked ? 2 : lastAlgorithm),
  });
  ctx.subscribe((v) => {
    resample.checked = v.algorithm === 2;
    if (v.algorithm !== 2) lastAlgorithm = v.algorithm;
  });
  const pitch = enableWhen(ctx, controlsFor(ctx, ['semitones', 'cents'], { labels: { semitones: 'Pitch Shift' } }), (v) => v.algorithm !== 2);
  const follows = showWhen(ctx, readout(ctx, (v) => `The pitch follows the speed: ${(12 * Math.log2(100 / v.stretch)).toFixed(2)} semitones`, 'faint'), (v) => v.algorithm === 2);
  return h(
    'div.fx-stack',
    controlsFor(ctx, ['algorithm', 'precision']),
    groupBox('Duration', h('div.sp-durations', h('span.fx-label', 'Current Duration:'), h('span.fx-readout', current ? clockText(current) : 'No audio selected'), h('span.fx-label', 'New Duration:'), newDuration)),
    groupBox('Stretch and Pitch', h('label.check.fx-check', resample, 'Lock Stretch and Pitch (Resample)'), controlsFor(ctx, ['stretch']), pitch, follows),
    disclosure('Advanced', controlsFor(ctx, ['lockChannels', 'formants']), { prefs: ctx.app?.prefs, key: 'stretchPitch' }),
  );
}
stretchView.hides = true;

// ------------------------------------------------------------ Pitch Shifter

/**
 * The frequency ratio as an editable value: typing or dragging it sets the
 * nearest semitones and cents (a ratio of 1.5 is +7 st +2 ct).
 */
export function ratioField(ctx) {
  const set = (r) => {
    const cents = Math.round(1200 * Math.log2(Math.min(4, Math.max(0.25, r)) || 1));
    const st = Math.min(24, Math.max(-24, Math.round(cents / 100)));
    ctx.set('semitones', st);
    ctx.set('cents', Math.min(100, Math.max(-100, cents - st * 100)));
  };
  const hot = hotNumber({
    value: pitchRatio(ctx.values.semitones, ctx.values.cents),
    min: 0.25,
    max: 4,
    step: 0.0001,
    label: 'Ratio',
    pixelsPerStep: 0.02,
    format: (r) => r.toFixed(4),
    // A decimal comma ("1,5") reads as a point.
    parse: (s) => Number(String(s).replace(',', '.').replace(/[^\d.]/g, '')),
    onInput: set,
    onChange: set,
    defaultValue: 1,
  });
  ctx.subscribe((v) => hot.setValue(pitchRatio(v.semitones, v.cents)));
  return hot;
}

function shifterView(ctx) {
  const rate = ctx.doc?.sampleRate || 48000;
  // With automatic settings the shifter works on spectral frames; say what they amount to.
  const auto = showWhen(ctx, readout(ctx, (v) => {
    const n = pitchFftSize(1024, v.precision, rate);
    return `Spectral frames of ${n} samples (${(rate / n).toFixed(1)} per second), 75 % overlap`;
  }, 'faint'), (v) => v.autoSplice);
  return h(
    'div.fx-stack',
    groupBox('Pitch Transpose', controlsFor(ctx, ['semitones', 'cents']), h('div.sp-ratio', h('span.fx-label', 'Ratio:'), ratioField(ctx))),
    h(
      'div.fx-split.ps-split',
      groupBox('Precision', enableWhen(ctx, radioChoice(ctx, 'precision', { label: null, className: 'fx-radios-v' }), (v) => v.autoSplice)),
      groupBox(
        'Pitch Settings',
        enableWhen(ctx, controlsFor(ctx, ['splice', 'overlap']), (v) => !v.autoSplice),
        h('div', checkbox(ctx, 'autoSplice')),
        h('div.ps-auto', auto),
        enableWhen(ctx, h('div', checkbox(ctx, 'formants')), (v) => v.autoSplice),
      ),
    ),
  );
}
shifterView.hides = true;

// ------------------------------------------------------------- Pitch Bender

function benderView(ctx) {
  const wrap = h('div.pb-graph');
  let env = null;
  let key = '';
  let shown = '';
  let own = false;
  const build = () => {
    const lim = Math.max(0.1, bendRange(ctx.values));
    const p = ctx.def.params.find((q) => q.id === 'envelope');
    env = envelopeControl({
      param: { ...p, min: -lim, max: lim, step: 0.01 },
      value: ctx.values.envelope,
      smooth: () => Boolean(ctx.values.spline),
      doc: ctx.doc,
      range: ctx.range,
      yTicks: [-lim / 2, 0, lim / 2],
      onChange: (pts) => {
        shown = JSON.stringify(pts);
        own = true;
        ctx.set('envelope', pts);
        own = false;
      },
    });
    shown = JSON.stringify(ctx.values.envelope);
    wrap.replaceChildren(env);
  };
  ctx.subscribe((v) => {
    const k = bendRange(v).toFixed(4);
    if (k !== key) {
      key = k;
      build();
      return;
    }
    if (own) return;
    const now = JSON.stringify(v.envelope);
    if (now !== shown) {
      shown = now;
      env.setPoints(v.envelope);
    } else env.redraw();
  });
  key = bendRange(ctx.values).toFixed(4);
  build();
  const reset = h('button.icon-btn', { type: 'button', 'aria-label': 'Reset the pitch envelope', title: 'Reset the pitch envelope', onclick: () => ctx.set('envelope', [{ t: 0, v: 0 }, { t: 1, v: 0 }]) }, glyph(['M4 12a8 8 0 1 0 2.3-5.7', 'M4 4v4h4']));
  const semis = showWhen(ctx, h('div.pb-range', numberField(ctx, 'range'), h('span.faint', 'up and down')), (v) => v.rangeMode === 0);
  const tempo = showWhen(ctx, h('div.pb-range', numberField(ctx, 'bpmRange'), h('span.faint', 'faster or slower, at a tempo of'), numberField(ctx, 'tempo'), readout(ctx, (v) => `(${bendRange(v).toFixed(2)} semitones)`, 'faint')), (v) => v.rangeMode === 1);
  return h(
    'div.fx-stack',
    wrap,
    h('div.nr-bar', checkbox(ctx, 'spline'), h('div.spacer'), reset),
    controlsFor(ctx, ['quality']),
    radioChoice(ctx, 'rangeMode', { label: 'Range' }),
    semis,
    tempo,
  );
}
benderView.hides = true;
benderView.dialogClass = 'fx-wide';

// ------------------------------------------- Automatic Pitch Correction

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi) => `${NOTE_NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;

function correctionView(ctx) {
  let cents = 0;
  let detail = '';
  let timer = 0;
  const bar = h('div.apc-meter', { role: 'meter', 'aria-label': 'Pitch correction', 'aria-valuemin': '-100', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('div.apc-zero'), h('div.apc-fill'));
  const text = h('div.apc-text', { 'aria-live': 'off' });
  const show = () => {
    const c = Math.max(-100, Math.min(100, cents));
    const fill = bar.querySelector('.apc-fill');
    fill.style.top = `${50 - Math.max(0, c) / 2}%`;
    fill.style.height = `${Math.abs(c) / 2}%`;
    fill.style.background = cssVar(Math.abs(c) > 50 ? '--hot' : '--wave');
    bar.setAttribute('aria-valuenow', String(Math.round(c)));
    text.textContent = `Correction: ${c.toFixed(1)} cents${detail}`;
  };
  ctx.onReadout?.((v) => {
    if (!(v.length >= 3)) return;
    cents = v[0];
    detail = v[1] > 0 ? `, ${noteName(v[2])} (${v[1].toFixed(1)} Hz in)` : ', unvoiced';
    show();
    clearTimeout(timer);
    timer = setTimeout(() => {
      cents = 0;
      detail = '';
      show();
    }, 800);
  });
  ctx.onClose?.(() => clearTimeout(timer));
  show();
  const left = controlsFor(ctx, ['scale', 'key', 'attack', 'sensitivity', 'reference', 'fftSize', 'calibration']);
  return h('div.fx-split.apc-split', left, h('div.apc-side', text, h('div.apc-scale', h('span', '+100'), h('span', '0'), h('span', '-100')), bar));
}
correctionView.hides = true;

registerEditor('stretchPitch', stretchView);
registerEditor('pitchShifter', shifterView);
registerEditor('pitchBender', benderView);
registerEditor('automaticPitchCorrection', correctionView);
