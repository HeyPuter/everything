// Properties panel sections for sessions: the selected clip (name, color,
// gain, fades, crossfade shape, loop, lock, mute, stretch, remix), the selected
// track (name, color, volume, pan, output, automation) and the session.

import { h } from '../lib/dom.js';
import * as S from '../model/session-edits.js';
import { parseTime } from '../lib/time.js';
import { formatGain } from './levels.js';
import { METRONOME_SOUNDS, DEFAULT_METRONOME_SOUND } from './metronome-sounds.js';
import { TIME_FORMATS } from '../lib/time.js';
import { stretchOf, stretchActive } from '../model/clip-stretch.js';

const COLOR_NAMES = ['Green', 'Blue', 'Amber', 'Red', 'Violet', 'Cyan', 'Pink', 'Lime', 'Orange', 'Indigo', 'Olive', 'Slate'];
const CURVES = [
  { value: '0', label: 'Linear' },
  { value: '0.5', label: 'Logarithmic' },
  { value: '2', label: 'Cosine' },
];

function curveValue(c) {
  if (c === 2) return '2';
  if (c === 0) return '0';
  return c > 0 ? '0.5' : 'custom';
}

/** A clip's stretch as shown in the Properties panel: "Realtime, 125% +2 st" or "Off". */
function stretchText(c) {
  const st = stretchOf(c);
  if (!stretchActive(st)) return 'Off';
  const pitch = st.semitones ? ` ${st.semitones > 0 ? '+' : ''}${st.semitones} st` : '';
  return `${st.mode === 'rendered' ? 'Rendered' : 'Realtime'}, ${Math.round(st.ratio * 1000) / 10}%${pitch}`;
}

export function sessionPropertySection(app, doc) {
  if (doc.kind !== 'session') return null;
  const state = doc.state;
  const stop = (el) => {
    el.addEventListener('keydown', (e) => e.stopPropagation());
    return el;
  };
  const row = (label, control, id) => h('div.prop-row', h('label.prop-label', { for: id }, label), control);
  const text = (label, value) => h('div.prop-row', h('span.prop-label', label), h('span.prop-value', value));
  const fmt = (f) => app.formatTime(f, doc.sampleRate);
  const parse = (v) => parseTime(v, doc.sampleRate, app.prefs.get('timeFormat'), app.timeOptions());
  let n = 0;
  const uid = () => `mtp-${doc.id}-${++n}`;
  const input = (value, onChange, attrs = {}) => {
    const id = uid();
    const el = stop(h('input.input', { type: 'text', value, id, ...attrs }));
    el.addEventListener('change', () => onChange(el.value));
    return [el, id];
  };
  const select = (options, value, onChange) => {
    const id = uid();
    const el = h('select.select', { id }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
    el.addEventListener('change', () => onChange(el.value));
    return [el, id];
  };
  const check = (label, value, onChange) => {
    const el = h('input', { type: 'checkbox', checked: value });
    el.addEventListener('change', () => onChange(el.checked));
    return h('label.check', el, label);
  };
  const sections = [];
  const clips = doc.clipSelection;
  if (clips.length === 1) {
    const c = clips[0];
    const set = (label, patch) => doc.apply(label, S.updateClips(doc.state, [c.id], patch));
    const fade = (dir, label, patch) => doc.apply(label, S.setFade(doc.state, [c.id], dir, patch));
    const [name, nameId] = input(c.name, (v) => v.trim() && set('Rename Clip', { name: v.trim() }), { 'aria-label': 'Clip name' });
    const [color, colorId] = select([{ value: '', label: 'Track Color' }, ...S.TRACK_COLORS.map((x, i) => ({ value: x, label: COLOR_NAMES[i] }))], c.color || '', (v) => set('Clip Color', { color: v || null }));
    const [gain, gainId] = input(String(c.gain), (v) => {
      const g = Number(String(v).replace(/db/i, ''));
      if (Number.isFinite(g)) set('Clip Gain', { gain: Math.max(-48, Math.min(24, g)) });
    }, { 'aria-label': 'Clip gain in dB', inputmode: 'decimal' });
    const [fin, finId] = input(fmt(c.fadeIn.length), (v) => {
      const f = parse(v);
      if (Number.isFinite(f)) fade('in', 'Fade In', { length: f });
    }, { 'aria-label': 'Fade in duration' });
    const [finCurve, finCurveId] = select([...CURVES, ...(curveValue(c.fadeIn.curve) === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])], curveValue(c.fadeIn.curve), (v) => v !== 'custom' && fade('in', 'Fade In', { curve: Number(v), length: c.fadeIn.length || S.defaultFadeLength(c, doc.sampleRate) }));
    const [fout, foutId] = input(fmt(c.fadeOut.length), (v) => {
      const f = parse(v);
      if (Number.isFinite(f)) fade('out', 'Fade Out', { length: f });
    }, { 'aria-label': 'Fade out duration' });
    const [foutCurve, foutCurveId] = select([...CURVES, ...(curveValue(c.fadeOut.curve) === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])], curveValue(c.fadeOut.curve), (v) => v !== 'custom' && fade('out', 'Fade Out', { curve: Number(v), length: c.fadeOut.length || S.defaultFadeLength(c, doc.sampleRate) }));
    const [xf, xfId] = select([{ value: 'symmetric', label: 'Symmetrical' }, { value: 'asymmetric', label: 'Asymmetrical' }], c.crossfade, (v) => set('Crossfade Shape', { crossfade: v }));
    const src = doc.pool.get(c.sourceId);
    sections.push(
      h(
        'section.prop-section',
        h('h3.prop-heading', 'Clip'),
        row('Name', name, nameId),
        row('Color', color, colorId),
        text('Source', src ? `${src.name}${src.offline ? ' (offline)' : ''}` : 'Missing'),
        text('Start', fmt(c.start)),
        text('Duration', fmt(c.length)),
        row('Gain (dB)', gain, gainId),
        row('Fade In', fin, finId),
        row('Fade In Shape', finCurve, finCurveId),
        row('Fade Out', fout, foutId),
        row('Fade Out Shape', foutCurve, foutCurveId),
        row('Crossfade', xf, xfId),
        text('Stretch', stretchText(c)),
        text('Remix', c.remix?.segments?.length ? `${c.remix.segments.length} segment${c.remix.segments.length === 1 ? '' : 's'}, target ${fmt(c.remix.target)}` : 'Off'),
        h('div.prop-checks', check('Loop', c.loop, (v) => set(v ? 'Loop Clip' : 'Unloop Clip', { loop: v })), check('Lock in Time', c.locked, (v) => set(v ? 'Lock Clip' : 'Unlock Clip', { locked: v })), check('Mute', c.mute, (v) => set(v ? 'Mute Clip' : 'Unmute Clip', { mute: v }))),
      ),
    );
  } else if (clips.length > 1) {
    sections.push(h('section.prop-section', h('h3.prop-heading', 'Clips'), text('Selected', `${clips.length} clips`), text('Range', `${fmt(Math.min(...clips.map((c) => c.start)))} to ${fmt(Math.max(...clips.map(S.clipEnd)))}`)));
  }
  const t = S.findTrack(state, doc.selectedTrack);
  if (t) {
    const set = (label, patch) => doc.apply(label, S.updateTrack(doc.state, t.id, patch));
    const [name, nameId] = input(t.name, (v) => v.trim() && set('Rename Track', { name: v.trim() }), { 'aria-label': 'Track name' });
    const [color, colorId] = select(S.TRACK_COLORS.map((x, i) => ({ value: x, label: COLOR_NAMES[i] })), t.color, (v) => set('Track Color', { color: v }));
    const [mode, modeId] = select(S.AUTOMATION_MODES.map((m) => ({ value: m.id, label: m.label })), t.mode, (v) => set('Automation Mode', { mode: v }));
    const outs = [{ value: 'master', label: t.type === 'master' ? 'Default Output' : 'Mix' }, ...state.tracks.filter((b) => b.type === 'bus' && b.id !== t.id && !S.wouldCycle(state, t.id, b.id)).map((b) => ({ value: b.id, label: b.name }))];
    const [out, outId] = select(outs, t.output || 'master', (v) => app.commands.run('mt.setTrackOutput', { id: t.id, output: v }));
    if (t.type === 'master') out.disabled = true;
    sections.push(
      h(
        'section.prop-section',
        h('h3.prop-heading', t.type === 'master' ? 'Master Track' : t.type === 'bus' ? 'Bus Track' : 'Track'),
        row('Name', name, nameId),
        row('Color', color, colorId),
        text('Channels', t.channels === 1 ? 'Mono' : 'Stereo'),
        text('Volume', formatGain(doc.controls ? doc.controls.value(t, 'volume') : t.volume)),
        t.type !== 'master' ? text('Pan', String(Math.round(doc.controls ? doc.controls.value(t, 'pan') : t.pan))) : null,
        row('Output', out, outId),
        row('Automation', mode, modeId),
        text('Effects', t.fx.some(Boolean) ? `${t.fx.filter(Boolean).length}${t.fxPower ? '' : ' (bypassed)'}` : 'None'),
      ),
    );
  }
  sections.push(
    h(
      'section.prop-section',
      h('h3.prop-heading', 'Session'),
      text('Name', doc.name),
      text('Location', doc.source?.path || 'Not saved'),
      text('Duration', fmt(doc.length)),
      text('Sample Rate', `${doc.sampleRate} Hz`),
      text('Bit Depth', state.bitDepth === 32 ? '32 (float)' : String(state.bitDepth)),
      text('Tempo', `${state.tempo} BPM, ${state.beatsPerBar}/4`),
      text('Tracks', String(state.tracks.length)),
      text('Clips', String(state.clips.length)),
    ),
  );
  // Metronome: on/off and its sound, through the same commands as the Multitrack menu.
  const soundId = state.metronomeSound || app.prefs.get('metronomeSound') || DEFAULT_METRONOME_SOUND;
  const [sound, soundSel] = select(METRONOME_SOUNDS.map((x) => ({ value: x.id, label: x.label })), soundId, (v) => app.commands.run(`mt.metronomeSound${v[0].toUpperCase()}${v.slice(1)}`));
  sections.push(
    h(
      'section.prop-section',
      h('h3.prop-heading', 'Metronome'),
      h('div.prop-row', h('span.prop-label', 'Click'), check('Play the metronome', Boolean(state.metronome), () => app.commands.run('mt.metronome'))),
      row('Sound', sound, soundSel),
      h('div.prop-row', h('span.prop-label', ''), h('button.btn.sm', { type: 'button', onclick: () => app.commands.run('mt.metronomePattern') }, 'Edit Pattern...')),
    ),
  );
  // Time display: the format used everywhere, and the session's tempo for bars and beats.
  const [format, formatSel] = select(TIME_FORMATS.map((f) => ({ value: f.id, label: f.label })), app.prefs.get('timeFormat'), (v) => app.prefs.set('timeFormat', v));
  sections.push(
    h(
      'section.prop-section',
      h('h3.prop-heading', 'Time Display'),
      row('Format', format, formatSel),
      h('div.prop-row', h('span.prop-label', ''), h('button.btn.sm', { type: 'button', onclick: () => app.commands.run('mt.sessionProperties') }, 'Edit Tempo...')),
    ),
  );
  return h('div.mt-props', sections);
}
