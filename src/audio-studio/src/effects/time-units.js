// Delay Time Units: delay times shown and typed in milliseconds, beats (at
// the session or Time Display tempo) or samples (at the file's rate). The
// parameters stay in milliseconds; only the controls convert. The chosen
// unit is a preference shared by every delay dialog.

import { h } from '../lib/dom.js';
import { select, hotNumber } from '../ui/controls.js';
import { paramControls } from './dialog.js';
import { beatSeconds } from '../lib/time.js';

export const TIME_UNITS = [
  { value: 'ms', label: 'Milliseconds' },
  { value: 'beats', label: 'Beats' },
  { value: 'samples', label: 'Samples' },
];

const PREF = 'delayTimeUnits';

/** Milliseconds per beat and the sample rate the dialog converts with. */
export function timeScale(ctx) {
  const music = ctx.app?.timeOptions?.() || {};
  const tempo = ctx.doc?.state?.tempo || music.tempo || 120;
  return { beatMs: beatSeconds({ ...music, tempo }) * 1000, rate: ctx.doc?.sampleRate || ctx.app?.engine?.rate || 48000, tempo };
}

export function toUnits(msValue, unit, s) {
  if (unit === 'beats') return msValue / s.beatMs;
  if (unit === 'samples') return (msValue * s.rate) / 1000;
  return msValue;
}

export function fromUnits(v, unit, s) {
  if (unit === 'beats') return v * s.beatMs;
  if (unit === 'samples') return (v * 1000) / s.rate;
  return v;
}

/** A millisecond param restated in `unit`: range, step, default and unit label. */
export function paramInUnits(p, unit, s) {
  if (unit === 'ms') return p;
  const conv = (v) => toUnits(v, unit, s);
  const step = unit === 'samples' ? 1 : 0.001;
  const round = (v) => Number((Math.round(v / step) * step).toFixed(3));
  // Sample counts stay exact on a linear scale (a log slider's value snaps to its positions).
  return { ...p, min: round(conv(p.min)), max: round(conv(p.max)), default: round(conv(p.default)), step, unit: unit === 'beats' ? 'beats' : 'samples', scale: unit === 'samples' ? 'linear' : p.scale };
}

/**
 * Delay time units for a dialog: { unit(), select, rows(ids, { labels }) }.
 * `rows` are the generated slider rows of millisecond params in the chosen
 * unit, rebuilt when it changes; `select` is the units dropdown.
 */
export function timeUnits(ctx) {
  const listeners = new Set();
  let unit = ctx.app?.prefs?.get?.(PREF) || 'ms';
  if (!TIME_UNITS.some((u) => u.value === unit)) unit = 'ms';
  const sel = select({
    value: unit,
    options: TIME_UNITS,
    label: 'Delay Time Units',
    onChange: (v) => {
      unit = v;
      ctx.app?.prefs?.set?.(PREF, v);
      listeners.forEach((fn) => fn());
    },
  });
  const scale = () => timeScale(ctx);
  const tempoNote = h('span.faint.fx-tempo-note');
  const showTempo = () => {
    const s = scale();
    tempoNote.textContent = unit === 'beats' ? `at ${Number(s.tempo.toFixed(2))} BPM` : unit === 'samples' ? `at ${s.rate} Hz` : '';
  };
  listeners.add(showTempo);
  showTempo();
  const selectRow = h('div.fx-units-row', h('label.fx-label', 'Delay Time Units:'), sel, tempoNote);

  function rows(ids, { labels = {} } = {}) {
    const box = h('div.fx-time-rows');
    let controls = null;
    let from = null;
    const build = () => {
      const s = scale();
      const params = ids.map((id) => ctx.def.params.find((p) => p.id === id)).filter(Boolean).map((p) => ({ ...paramInUnits(p, unit, s), label: labels[p.id] ?? p.label, hidden: false, section: undefined }));
      const view = () => ({ ...ctx.values, ...Object.fromEntries(params.map((p) => [p.id, toUnits(ctx.values[p.id], unit, s)])) });
      controls = paramControls({ ...ctx.def, params, layout: {} }, view, (id, v) => {
        from = id;
        ctx.set(id, fromUnits(v, unit, s));
        from = null;
      });
      box.replaceChildren(controls.el);
    };
    build();
    listeners.add(build);
    ctx.subscribe((values) => controls.refresh({ ...values, ...Object.fromEntries(ids.map((id) => [id, toUnits(values[id], unit, scale())])) }, from));
    return box;
  }

  return { unit: () => unit, select: selectRow, rows };
}

/** Beats per cycle of a modulation rate (Hz) at the tempo, and back. */
export const beatsPerCycle = (hz, s) => 1000 / (Math.max(1e-6, hz) * s.beatMs);
export const rateForBeats = (beats, s) => 1000 / (Math.max(1e-6, beats) * s.beatMs);

/**
 * A modulation rate restated as beats per sweep at the tempo: a scrubbable
 * value that sets the rate in Hz (Flanger tempo sync).
 */
export function beatsField(ctx, id) {
  const p = ctx.def.params.find((q) => q.id === id);
  const scale = () => timeScale(ctx);
  const lim = (hz) => Number(beatsPerCycle(hz, scale()).toFixed(3));
  const hot = hotNumber({
    value: lim(ctx.values[id]),
    min: lim(p.max),
    max: lim(p.min),
    step: 0.001,
    label: `${p.label} in beats`,
    pixelsPerStep: 0.05,
    format: (v) => `${v.toFixed(3)} beats`,
    parts: (v) => [v.toFixed(3), 'beats'],
    editText: (v) => v.toFixed(3),
    parse: (t) => parseFloat(String(t).replace(',', '.')),
    onInput: (v) => ctx.set(id, rateForBeats(v, scale())),
    onChange: (v) => ctx.set(id, rateForBeats(v, scale())),
  });
  ctx.subscribe((values) => hot.setValue(lim(values[id])));
  const note = h('span.faint.fx-tempo-note', `per sweep at ${Number(scale().tempo.toFixed(2))} BPM`);
  return h('div.fx-row.fx-beats-row', h('span.fx-label', 'Tempo Sync:'), h('div.fx-beats', hot, note));
}
