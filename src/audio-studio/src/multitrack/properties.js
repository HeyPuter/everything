// Properties panel sections for sessions: the selected clip (name, color,
// gain, fades, crossfade shape, loop, lock, mute, stretch, remix), the selected
// track (name, color, volume, pan, output, automation) and the session.

import { h } from '../lib/dom.js';
import * as S from '../model/session-edits.js';
import { parseTime } from '../lib/time.js';
import { formatGain, parseGain, parsePan } from './levels.js';
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
    const [color, colorId] = select([{ value: '', label: 'Track Color' }, ...S.TRACK_COLORS.map((x, i) => ({ value: x, label: COLOR_NAMES[i] })), ...(c.color && !S.TRACK_COLORS.includes(c.color) ? [{ value: c.color, label: 'Custom' }] : [])], c.color || '', (v) => set('Clip Color', { color: v || null }));
    const [gain, gainId] = input(String(c.gain), (v) => {
      // An emptied field is not a value (Number('') would read as 0 dB).
      const g = parseGain(v);
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
    // Start moves the clip; End and Duration trim its out point (a looped clip may run past its source).
    const srcLen = () => doc.sourceLength(c.sourceId) || Infinity;
    const [start, startId] = input(fmt(c.start), (v) => {
      const f = parse(v);
      if (Number.isFinite(f)) doc.apply('Move Clip', S.moveClips(doc.state, [c.id], Math.max(0, Math.round(f)) - c.start, 0));
    }, { 'aria-label': 'Clip start', disabled: c.locked, title: c.locked ? 'The clip is locked in time' : '' });
    const trimTo = (end) => {
      if (!Number.isFinite(end) || end <= c.start) return;
      doc.apply('Trim Clip', S.trimClip(doc.state, c.id, 'out', Math.round(end), srcLen()));
    };
    const [end, endId] = input(fmt(S.clipEnd(c)), (v) => trimTo(parse(v)), { 'aria-label': 'Clip end', disabled: c.locked });
    const [dur, durId] = input(fmt(c.length), (v) => trimTo(c.start + parse(v)), { 'aria-label': 'Clip duration', disabled: c.locked });
    const srcChannels = src?.channels?.length || src?.channelCount || 0;
    const channelText = srcChannels === 1 ? 'Mono' : srcChannels === 2 ? 'Stereo' : srcChannels ? `${srcChannels} channels` : '';
    const srcInfo = src && !src.offline ? [channelText, src.sampleRate ? `${src.sampleRate} Hz` : ''].filter(Boolean).join(', ') : '';
    sections.push(
      h(
        'section.prop-section',
        h('h3.prop-heading', 'Clip'),
        row('Name', name, nameId),
        row('Color', color, colorId),
        text('Source', src ? `${src.name}${src.offline ? ' (offline)' : ''}` : 'Missing'),
        srcInfo ? text('Source Format', srcInfo) : null,
        src?.path ? h('div.prop-row', h('span.prop-label', 'Source Path'), h('span.prop-value', { title: src.path }, src.path)) : null,
        row('Start', start, startId),
        row('End', end, endId),
        row('Duration', dur, durId),
      ),
      h(
        'section.prop-section',
        h('h3.prop-heading', 'Clip Settings'),
        row('Gain (dB)', gain, gainId),
        row('Fade In', fin, finId),
        row('Fade In Shape', finCurve, finCurveId),
        row('Fade Out', fout, foutId),
        row('Fade Out Shape', foutCurve, foutCurveId),
        row('Crossfade', xf, xfId),
        text('Stretch', stretchText(c)),
        text('Remix', c.remix?.segments?.length ? `${c.remix.segments.length} segment${c.remix.segments.length === 1 ? '' : 's'}, target ${fmt(c.remix.target)}` : 'Off'),
        h('div.prop-checks', check('Loop', c.loop, (v) => doc.apply(v ? 'Loop Clip' : 'Unloop Clip', S.setClipsLoop(doc.state, [c.id], v, (id) => doc.sourceLength(id)))), check('Lock in Time', c.locked, (v) => set(v ? 'Lock Clip' : 'Unlock Clip', { locked: v })), check('Mute', c.mute, (v) => set(v ? 'Mute Clip' : 'Unmute Clip', { mute: v }))),
      ),
    );
    // Source channel routing: which source channel each side of the clip plays.
    if (srcChannels >= 2) {
      const map = Array.isArray(c.channelMap) ? c.channelMap : [0, 1];
      const names = Array.from({ length: srcChannels }, (_, i) => ({ value: String(i), label: srcChannels === 2 ? (i ? 'Right' : 'Left') : `Channel ${i + 1}` }));
      const route = (side) => (v) => {
        const next = map.slice();
        next[side] = Number(v);
        set('Source Channel Routing', { channelMap: next[0] === 0 && next[1] === 1 ? null : next });
      };
      const [left, leftId] = select(names, map[0], route(0));
      const [right, rightId] = select(names, map[1], route(1));
      left.setAttribute('aria-label', 'Source channel the clip plays on the left');
      right.setAttribute('aria-label', 'Source channel the clip plays on the right');
      sections.push(
        h(
          'section.prop-section',
          h('h3.prop-heading', 'Source Channel Routing'),
          row('Left Plays', left, leftId),
          row('Right Plays', right, rightId),
          h('div.prop-row', h('span.prop-label', ''), h('button.btn.sm', { type: 'button', disabled: !c.channelMap, onclick: () => set('Source Channel Routing', { channelMap: null }) }, 'As Recorded')),
        ),
      );
    }
  } else if (clips.length > 1) {
    sections.push(h('section.prop-section', h('h3.prop-heading', 'Clips'), text('Selected', `${clips.length} clips`), text('Range', `${fmt(Math.min(...clips.map((c) => c.start)))} to ${fmt(Math.max(...clips.map(S.clipEnd)))}`)));
  }
  const t = S.findTrack(state, doc.selectedTrack);
  if (t) {
    const set = (label, patch) => doc.apply(label, S.updateTrack(doc.state, t.id, patch));
    const [name, nameId] = input(t.name, (v) => v.trim() && set('Rename Track', { name: v.trim() }), { 'aria-label': 'Track name' });
    const [color, colorId] = select([...S.TRACK_COLORS.map((x, i) => ({ value: x, label: COLOR_NAMES[i] })), ...(S.TRACK_COLORS.includes(t.color) ? [] : [{ value: t.color, label: 'Custom' }])], t.color, (v) => set('Track Color', { color: v }));
    const [mode, modeId] = select(S.AUTOMATION_MODES.map((m) => ({ value: m.id, label: m.label })), t.mode, (v) => set('Automation Mode', { mode: v }));
    const outs = [{ value: 'master', label: t.type === 'master' ? 'Default Output' : 'Mix' }, ...state.tracks.filter((b) => b.type === 'bus' && b.id !== t.id && !S.wouldCycle(state, t.id, b.id)).map((b) => ({ value: b.id, label: b.name }))];
    const [out, outId] = select(outs, t.output || 'master', (v) => app.commands.run('mt.setTrackOutput', { id: t.id, output: v }));
    if (t.type === 'master') out.disabled = true;
    // Volume and pan go through the track controls, so automation behaves as in the header.
    const controls = doc.controls;
    const level = (param) => (controls ? controls.value(t, param) : t[param]);
    const setLevel = (param, v) => {
      if (controls) controls.set(t.id, param, v, 'change');
      else set(param === 'pan' ? 'Track Pan' : 'Track Volume', { [param]: v });
    };
    const [vol, volId] = input(formatGain(level('volume')), (v) => {
      const g = parseGain(v);
      if (Number.isFinite(g)) setLevel('volume', Math.max(S.SILENT_DB, Math.min(S.MAX_DB, g)));
    }, { 'aria-label': 'Track volume in dB', inputmode: 'decimal' });
    const [pan, panId] = t.type === 'master' ? [null, null] : input(String(Math.round(level('pan'))), (v) => {
      const n = parsePan(v);
      if (Number.isFinite(n)) setLevel('pan', Math.max(-100, Math.min(100, Math.round(n))));
    }, { 'aria-label': 'Track pan, -100 left to 100 right', inputmode: 'decimal' });
    const toggle = (key, label) => check(label, key === 'mute' && controls ? controls.muted(t) : Boolean(t[key]), (v) => (controls ? controls.toggle(t.id, key, v) : set(label, { [key]: v })));
    sections.push(
      h(
        'section.prop-section',
        h('h3.prop-heading', t.type === 'master' ? 'Master Track' : t.type === 'bus' ? 'Bus Track' : 'Track'),
        row('Name', name, nameId),
        row('Color', color, colorId),
        text('Channels', t.channels === 1 ? 'Mono' : t.channels === 6 ? '5.1' : 'Stereo'),
        row('Volume (dB)', vol, volId),
        pan ? row('Pan', pan, panId) : null,
        h('div.prop-checks', toggle('mute', 'Mute'), t.type !== 'master' ? toggle('solo', 'Solo') : null, t.type === 'audio' ? toggle('arm', 'Arm for Record') : null),
        row('Output', out, outId),
        row('Automation', mode, modeId),
        text('Effects', t.fx.some(Boolean) ? `${t.fx.filter(Boolean).length}${t.fxPower ? '' : ' (bypassed)'}` : 'None'),
      ),
    );
  }
  // Tempo and meter: one undo step each; bars-and-beats displays follow them.
  const setMusic = (label, patch) => {
    doc.apply(label, { ...doc.state, ...patch });
    for (const [k, v] of Object.entries(patch)) app.prefs.set(k, v);
  };
  const [tempo, tempoId] = input(String(state.tempo), (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) setMusic('Session Tempo', { tempo: Math.round(Math.max(20, Math.min(400, n)) * 100) / 100 });
  }, { 'aria-label': 'Session tempo in beats per minute', inputmode: 'decimal' });
  const [beats, beatsId] = input(String(state.beatsPerBar), (v) => {
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n > 0) setMusic('Time Signature', { beatsPerBar: Math.max(1, Math.min(16, n)) });
  }, { 'aria-label': 'Beats per bar', inputmode: 'numeric' });
  // The beat note (the time signature's lower number) is shared with the time display settings.
  const [note, noteId] = select([2, 4, 8, 16].map((n) => ({ value: String(n), label: n === 2 ? 'Half note (2)' : n === 4 ? 'Quarter note (4)' : n === 8 ? 'Eighth note (8)' : 'Sixteenth note (16)' })), String(app.prefs.get('beatNote') || 4), (v) => app.prefs.set('beatNote', Number(v)));
  note.setAttribute('aria-label', 'Beat note');
  sections.push(
    h(
      'section.prop-section',
      h('h3.prop-heading', 'Session'),
      text('Name', doc.name),
      text('Location', doc.source?.path || 'Not saved'),
      text('Duration', fmt(doc.length)),
      text('Sample Rate', `${doc.sampleRate} Hz`),
      text('Bit Depth', state.bitDepth === 32 ? '32 (float)' : String(state.bitDepth)),
      row('Tempo (BPM)', tempo, tempoId),
      row('Beats per Bar', beats, beatsId),
      row('Beat Note', note, noteId),
      h('div.prop-checks', check('Crossfade overlapping clips', state.autoCrossfade !== false, (v) => doc.apply(v ? 'Automatic Crossfades On' : 'Automatic Crossfades Off', { ...doc.state, autoCrossfade: v })), check('Save open audio files with the session', Boolean(app.prefs.get('sessionIncludeOpenFiles')), (v) => app.prefs.set('sessionIncludeOpenFiles', v))),
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
