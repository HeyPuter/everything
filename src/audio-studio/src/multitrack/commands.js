// Multitrack commands: File > New Session, the Multitrack and Clip menus,
// ripple edits, mixdowns and bounces, plus overrides of shared commands
// (cut, copy, paste, delete, select, zoom, markers, save) for sessions.

import { h, announce } from '../lib/dom.js';
import { openDialog, promptDialog, confirmDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { Session } from '../model/session.js';
import * as S from '../model/session-edits.js';
import { markersInRange } from '../model/edits.js';
import { AudioFile } from '../model/audio-file.js';
import { Channel } from '../audio/channel.js';
import { createMarker, sortMarkers, MARKER_TYPES } from '../model/markers.js';
import { pickLocalFiles, saveDocument, downloadBlob } from '../storage/files.js';
import { AUDIO_ACCEPT, VIDEO_EXTENSIONS, baseName } from '../audio/decode.js';
import { videoClip } from '../model/session-video.js';
import * as puter from '../storage/puter.js';
import { insertDocs, insertFiles, linkSource, newTrack, channelsAtRate, placementOptions, freeTrackShift, shownAudioTracks } from './insert.js';
import { renderSession, renderedDoc, clipsRange } from './render.js';
import { saveSession, exportSession, sessionZip } from './storage.js';
import { prepareVideoBytes } from '../video/session-media.js';
import { openTrackEffects } from './fx-editor.js';
import { sessionBaseName } from '../model/session-io.js';
import { METRONOME_SOUNDS, DEFAULT_METRONOME_SOUND } from './metronome-sounds.js';
import { TYPE_IDS as ASSISTANT_TYPE_IDS, TYPES as ASSISTANT_TYPES } from '../sound-assistant/model.js';
import { STRETCH_MODES, MIN_RATIO, MAX_RATIO, stretchOf, originalRange } from '../model/clip-stretch.js';
import { stretcherFor, stretchIdle, firstStretch, stretchedClips } from './stretch.js';
import { remixIdle } from './remix.js';
import { remixCommands } from './remix-commands.js';
import { withProgress } from '../effects/progress.js';
import { panGains } from '../engine/mixcore.js';

// Speech alignment precisions (the alignment code itself loads on first use).
const ALIGN_PRECISIONS = [
  { id: 'low', label: 'Low (fast)' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High (slow)' },
];
import { templateFromState, stateFromTemplate, userTemplates, saveTemplate, deleteTemplate } from './templates.js';

const session = (app) => (app.active?.kind === 'session' ? app.active : null);
const hasSession = (app) => Boolean(session(app));
const selected = (app) => session(app)?.clipSelection || [];
const hasClips = (app) => selected(app).length > 0;
const hasTimeSel = (app) => Boolean(session(app)?.hasSelection);
const selTrack = (app, args) => {
  const doc = session(app);
  if (!doc) return null;
  return S.findTrack(doc.state, args?.id || doc.selectedTrack);
};
const view = (app) => app.currentView?.();
const audioDoc = (app) => (app.active?.kind === 'audio' ? app.active : null);

const COLOR_NAMES = ['Green', 'Blue', 'Amber', 'Red', 'Violet', 'Cyan', 'Pink', 'Lime', 'Orange', 'Indigo', 'Olive', 'Slate'];

export const TEMPLATES = [
  { id: 'none', label: 'None', tracks: null },
  {
    id: 'podcast',
    label: 'Podcast',
    tracks: [
      { name: 'Host', channels: 1, output: 'Voices' },
      { name: 'Guest', channels: 1, output: 'Voices' },
      { name: 'Music', channels: 2 },
      { name: 'Sound Effects', channels: 2 },
      { name: 'Voices', type: 'bus' },
    ],
  },
  { id: 'voiceover', label: 'Voice Over', tracks: [{ name: 'Voice', channels: 1 }, { name: 'Music', channels: 2 }, { name: 'Effects', channels: 2 }] },
  { id: 'music', label: 'Music (8 Tracks)', tracks: Array.from({ length: 8 }, (_, i) => ({ name: `Track ${i + 1}`, channels: 2 })) },
];

// ------------------------------------------------------------------ dialogs

async function newSessionDialog(app) {
  const name = h('input.input', { type: 'text', value: app.uniqueName('Untitled Session', '.asesx').replace(/\.asesx$/, ''), 'aria-label': 'Session name', style: { width: '100%' } });
  const template = h('select.select', { 'aria-label': 'Template' });
  const fillTemplates = () => {
    const user = userTemplates(app.prefs);
    template.replaceChildren(
      ...TEMPLATES.map((t) => h('option', { value: t.id }, t.label)),
      ...(user.length ? [h('optgroup', { label: 'My Templates' }, user.map((t) => h('option', { value: t.id }, t.label)))] : []),
    );
    delTemplate.disabled = true;
  };
  // Saved templates can be deleted from here; built-in ones cannot.
  const delTemplate = h('button.icon-btn', { type: 'button', 'aria-label': 'Delete template', title: 'Delete Template', disabled: true }, icon('trash-2', 14));
  delTemplate.addEventListener('click', async () => {
    const t = userTemplates(app.prefs).find((x) => x.id === template.value);
    if (!t || !(await confirmDialog({ title: 'Delete Template', message: `Delete the session template "${t.label}"?`, confirm: 'Delete', danger: true }))) return;
    deleteTemplate(app.prefs, t.id);
    fillTemplates();
  });
  template.addEventListener('change', () => (delTemplate.disabled = !userTemplates(app.prefs).some((t) => t.id === template.value)));
  fillTemplates();
  const rate = h('select.select', { 'aria-label': 'Sample rate' }, [22050, 32000, 44100, 48000, 88200, 96000, 192000].map((r) => h('option', { value: r, selected: r === (app.prefs.get('defaultRate') || 48000) }, `${r} Hz`)));
  const bits = h('select.select', { 'aria-label': 'Bit depth' }, [16, 24, 32].map((b) => h('option', { value: b, selected: b === 32 }, b === 32 ? '32 (float)' : String(b))));
  const master = h('select.select', { 'aria-label': 'Mix' }, h('option', { value: '2' }, 'Stereo'), h('option', { value: '1' }, 'Mono'), h('option', { value: '6' }, '5.1'));
  master.value = String([1, 6].includes(app.prefs.get('newSessionMix')) ? app.prefs.get('newSessionMix') : 2);
  const r = await openDialog({
    title: 'New Multitrack Session',
    body: h('div.form-grid', h('label', 'Session Name:'), name, h('label', 'Template:'), h('div.row', template, delTemplate), h('label', 'Sample Rate:'), rate, h('label', 'Bit Depth:'), bits, h('label', 'Mix:'), master),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  const chosen = TEMPLATES.find((t) => t.id === template.value) || userTemplates(app.prefs).find((t) => t.id === template.value);
  app.prefs.set('newSessionMix', Number(master.value));
  return { name: `${name.value.trim() || 'Untitled Session'}.asesx`, template: chosen, sampleRate: Number(rate.value), bitDepth: Number(bits.value), masterChannels: Number(master.value) };
}

async function addTracksDialog(app) {
  const count = h('input.input.num', { type: 'number', min: 1, max: 64, value: 1, 'aria-label': 'Number of tracks' });
  const type = h('select.select', { 'aria-label': 'Track type' }, h('option', { value: 'stereo' }, 'Stereo Audio Track'), h('option', { value: 'mono' }, 'Mono Audio Track'), h('option', { value: 'bus' }, 'Stereo Bus Track'), h('option', { value: 'monoBus' }, 'Mono Bus Track'), h('option', { value: 'surround' }, '5.1 Audio Track'), h('option', { value: 'surroundBus' }, '5.1 Bus Track'));
  const r = await openDialog({
    title: 'Add Tracks',
    body: h('div.form-grid', h('label', 'Add:'), count, h('label', 'Type:'), type),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  return { count: Math.max(1, Math.min(64, Math.round(Number(count.value) || 1))), type: type.value };
}

async function sessionPropertiesDialog(app, doc) {
  const s = doc.state;
  const tempo = h('input.input.num', { type: 'number', min: 20, max: 400, step: 0.1, value: s.tempo, 'aria-label': 'Tempo' });
  const beats = h('input.input.num', { type: 'number', min: 1, max: 16, value: s.beatsPerBar, 'aria-label': 'Beats per bar' });
  const xf = h('input', { type: 'checkbox', checked: s.autoCrossfade });
  const r = await openDialog({
    title: 'Session Properties',
    body: h(
      'div.form-grid',
      h('label', 'Sample Rate:'),
      h('span', `${s.sampleRate} Hz`),
      h('label', 'Bit Depth:'),
      h('span', s.bitDepth === 32 ? '32 (float)' : String(s.bitDepth)),
      h('label', 'Duration:'),
      h('span', app.formatTime(doc.length, doc.sampleRate)),
      h('label', 'Tempo:'),
      h('div.row', tempo, h('span.muted', 'beats per minute')),
      h('label', 'Time Signature:'),
      h('div.row', beats, h('span.muted', 'beats per bar')),
      h('label', 'Crossfades:'),
      h('label.check', xf, 'Create crossfades when clips overlap'),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const next = { ...doc.state, tempo: Math.max(20, Math.min(400, Number(tempo.value) || 120)), beatsPerBar: Math.max(1, Math.min(16, Math.round(Number(beats.value) || 4))), autoCrossfade: xf.checked };
  doc.apply('Session Properties', next);
  app.prefs.set('tempo', next.tempo);
  app.prefs.set('beatsPerBar', next.beatsPerBar);
}

async function clipGainDialog(app, doc, clips) {
  const input = h('input.input.num', { type: 'number', step: 0.1, min: -48, max: 24, value: clips[0].gain, 'aria-label': 'Clip gain in dB' });
  const r = await openDialog({
    title: 'Clip Gain',
    body: h('div.form-grid', h('label', 'Gain (dB):'), input),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const g = Math.max(-48, Math.min(24, Number(input.value) || 0));
  doc.apply('Clip Gain', S.updateClips(doc.state, clips.map((c) => c.id), { gain: g }));
}

/** RMS level (dBFS) of a clip's audio, from its source. */
function clipRms(doc, c) {
  const src = doc.pool.get(c.sourceId);
  if (!src?.channels?.length) return -Infinity;
  let sum = 0;
  let n = 0;
  for (const ch of src.channels) {
    ch.forEachRun(c.offset, c.offset + c.length, (run) => {
      for (let i = 0; i < run.length; i += 4) {
        sum += run[i] * run[i];
        n++;
      }
    });
  }
  return n ? 10 * Math.log10(sum / n || 1e-12) + c.gain : -Infinity;
}

async function matchLoudnessDialog(app, doc, clips) {
  const levels = clips.map((c) => clipRms(doc, c));
  const target = h('input.input.num', { type: 'number', step: 0.5, value: Math.round(Math.max(...levels.filter(Number.isFinite), -20)), 'aria-label': 'Target level in dB RMS' });
  const r = await openDialog({
    title: 'Match Clip Loudness',
    body: h('div', h('p.muted', { style: { margin: '0 0 10px', maxWidth: '360px' } }, 'Sets each selected clip’s gain so their average (RMS) levels match the target.'), h('div.form-grid', h('label', 'Target (dB RMS):'), target)),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Match', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const t = Number(target.value);
  const gains = new Map();
  clips.forEach((c, i) => {
    if (Number.isFinite(levels[i])) gains.set(c.id, Math.max(-48, Math.min(24, Math.round((c.gain + t - levels[i]) * 10) / 10)));
  });
  doc.apply('Match Clip Loudness', S.updateClips(doc.state, [...gains.keys()], (c) => ({ gain: gains.get(c.id) })));
}

/** The metronome sound a session uses: its own choice, else the last one picked. */
export function metronomeSoundOf(app, doc) {
  const id = doc?.state.metronomeSound || app.prefs.get('metronomeSound');
  return METRONOME_SOUNDS.some((x) => x.id === id) ? id : DEFAULT_METRONOME_SOUND;
}

/** Picks a metronome sound for a session (a view setting: no undo step) and remembers it for new sessions. */
function setMetronomeSound(app, doc, id) {
  if (doc.state.metronomeSound !== id) doc.amendView((st) => ({ ...st, metronomeSound: id }));
  app.prefs.set('metronomeSound', id);
  app.syncGraph();
}

async function metronomeDialog(app, doc) {
  const tempo = h('input.input.num', { type: 'number', min: 20, max: 400, step: 0.1, value: doc.state.tempo, 'aria-label': 'Tempo' });
  const beats = h('input.input.num', { type: 'number', min: 1, max: 16, value: doc.state.beatsPerBar, 'aria-label': 'Beats per bar' });
  const current = metronomeSoundOf(app, doc);
  const sound = h('select.select', { 'aria-label': 'Metronome sound' }, METRONOME_SOUNDS.map((x) => h('option', { value: x.id, selected: x.id === current }, x.label)));
  const r = await openDialog({
    title: 'Metronome Pattern',
    body: h('div.form-grid', h('label', 'Tempo (BPM):'), tempo, h('label', 'Beats per Bar:'), beats, h('label', 'Sound:'), h('div.row', sound, h('span.muted', 'accented first beat'))),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  setMetronomeSound(app, doc, sound.value);
  doc.apply('Metronome Pattern', { ...doc.state, tempo: Math.max(20, Math.min(400, Number(tempo.value) || 120)), beatsPerBar: Math.max(1, Math.min(16, Math.round(Number(beats.value) || 4))) });
  app.prefs.set('tempo', doc.state.tempo);
  app.prefs.set('beatsPerBar', doc.state.beatsPerBar);
}

async function stretchDialog(app, doc, clips) {
  const s = firstStretch(clips);
  const rate = doc.sampleRate;
  const single = clips.length === 1;
  // Original duration of the first clip (in seconds), for the linked Duration field.
  const origSeconds = originalRange(clips[0]).length / rate;
  const mode = h('select.select', { 'aria-label': 'Stretch mode' }, STRETCH_MODES.map((m) => h('option', { value: m.id, selected: m.id === s.mode }, m.label)));
  const pct = h('input.input.num', { type: 'number', min: MIN_RATIO * 100, max: MAX_RATIO * 100, step: 0.1, value: Math.round(s.ratio * 1000) / 10, 'aria-label': 'Stretch percentage' });
  const dur = h('input.input.num', { type: 'number', min: 0.001, step: 0.001, value: (origSeconds * s.ratio).toFixed(3), disabled: !single, 'aria-label': 'Duration in seconds' });
  const semis = h('input.input.num', { type: 'number', min: -24, max: 24, step: 1, value: s.semitones, 'aria-label': 'Pitch shift in semitones' });
  const formants = h('input', { type: 'checkbox', checked: s.formants });
  const toOn = () => {
    if (mode.value === 'off') mode.value = app.prefs.get('clipStretchMode') === 'rendered' ? 'rendered' : 'realtime';
  };
  pct.addEventListener('input', () => {
    dur.value = ((origSeconds * (Number(pct.value) || 100)) / 100).toFixed(3);
    toOn();
  });
  dur.addEventListener('input', () => {
    pct.value = String(Math.round(((Number(dur.value) || origSeconds) / origSeconds) * 1000) / 10);
    toOn();
  });
  semis.addEventListener('input', toOn);
  const r = await openDialog({
    title: 'Stretch Properties',
    body: h(
      'div',
      h('p.muted', { style: { margin: '0 0 10px', maxWidth: '380px' } }, 'Realtime renders quickly in the background and previews at once; Rendered uses the highest quality. Off plays the clip unstretched.'),
      h(
        'div.form-grid',
        h('label', 'Mode:'),
        mode,
        h('label', 'Stretch (%):'),
        pct,
        h('label', 'Duration (s):'),
        h('div.row', dur, h('span.muted', `original ${origSeconds.toFixed(3)} s`)),
        h('label', 'Pitch Shift:'),
        h('div.row', semis, h('span.muted', 'semitones')),
        h('label', 'Formants:'),
        h('label.check', formants, 'Preserve formants when the pitch shifts'),
      ),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, (Number(pct.value) || 100) / 100));
  const semitones = Math.max(-24, Math.min(24, Math.round(Number(semis.value) || 0)));
  stretcherFor(app, doc).apply('Stretch Properties', clips.map((c) => c.id), { mode: mode.value, ratio, semitones, formants: formants.checked });
}

/** The audio a clip plays (its source range, without clip gain or fades) as Float32Arrays. */
function clipAudio(doc, c) {
  const src = doc.pool.get(c.sourceId);
  if (!src?.channels?.length) return null;
  const len = src.channels[0].length;
  const a = Math.min(len, c.offset);
  const b = Math.min(len, c.offset + c.length);
  return b > a ? src.channels.map((ch) => ch.toArray(a, b)) : null;
}

async function speechAlignDialog(app, doc, clips) {
  const tracks = new Map(doc.state.tracks.map((t) => [t.id, t.name]));
  const name = (c) => `${c.name} (${tracks.get(c.trackId) || 'Track'})`;
  const ref = h('select.select', { 'aria-label': 'Reference clip' }, clips.map((c, i) => h('option', { value: String(i) }, name(c))));
  const other = h('span');
  const sync = () => (other.textContent = name(clips[1 - Number(ref.value)]));
  ref.addEventListener('change', sync);
  sync();
  const precision = h('select.select', { 'aria-label': 'Alignment precision' }, ALIGN_PRECISIONS.map((p) => h('option', { value: p.id, selected: p.id === 'medium' }, p.label)));
  const mute = h('input', { type: 'checkbox', checked: true });
  const r = await openDialog({
    title: 'Automatic Speech Alignment',
    body: h(
      'div',
      h('p.muted', { style: { margin: '0 0 10px', maxWidth: '400px' } }, 'Matches the timing of the unaligned clip to the reference clip and puts the result on a new track. Both clips should start and end on the same words.'),
      h('div.form-grid', h('label', 'Reference Clip:'), ref, h('label', 'Unaligned Clip:'), other, h('label', 'Precision:'), precision, h('label', 'Original:'), h('label.check', mute, 'Mute the unaligned clip')),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Align', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return null;
  const i = Number(ref.value);
  return { reference: clips[i], unaligned: clips[1 - i], precision: precision.value, mute: mute.checked };
}

async function speechAlign(app, doc) {
  const o = await speechAlignDialog(app, doc, doc.clipSelection);
  if (!o) return;
  await stretchIdle(doc);
  await remixIdle(doc);
  const refAudio = clipAudio(doc, o.reference);
  const takeAudio = clipAudio(doc, o.unaligned);
  if (!refAudio || !takeAudio) {
    app.notify('Both clips need their media online to be aligned.', { error: true });
    return;
  }
  let result;
  try {
    const { alignSpeech } = await import('./align.js');
    result = await withProgress(app, 'Aligning Speech', (signal, onProgress) => alignSpeech(refAudio, takeAudio, doc.sampleRate, { precision: o.precision, signal, onProgress }));
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
  const file = new AudioFile({ name: app.uniqueName(`${o.unaligned.name} Aligned`, '.wav'), sampleRate: doc.sampleRate, channels: result.channels.map((d) => Channel.fromSamples(d)) });
  app.addDocument(file, { activate: false });
  app.activate(doc);
  const sourceId = await linkSource(doc, file);
  const fromTrack = S.findTrack(doc.state, o.unaligned.trackId);
  const made = newTrack(doc.state, { name: `${fromTrack?.name || 'Track'} Aligned`, channels: fromTrack?.channels || Math.min(2, result.channels.length), afterId: fromTrack?.id });
  const clip = S.createClip({ trackId: made.track.id, sourceId, name: baseName(file.name), start: o.reference.start, length: result.channels[0].length, color: o.unaligned.color });
  let state = S.addClips(made.state, [clip]);
  if (o.mute) state = S.updateClips(state, [o.unaligned.id], { mute: true });
  doc.apply('Automatic Speech Alignment', state, { clips: [clip.id] });
  doc.selectTrack(made.track.id);
  view(app)?.revealTrack?.(made.track.id);
  announce(`Aligned clip added on ${made.track.name}`);
}

function colorMenu(app, current, apply, { withDefault } = {}) {
  const el = app.currentView?.()?.surface;
  const r = el ? el.getBoundingClientRect() : { left: 200, top: 200 };
  const items = S.TRACK_COLORS.map((c, i) => ({ type: 'cmd', label: COLOR_NAMES[i], enabled: true, checked: current === c, run: () => apply(c) }));
  if (withDefault) items.unshift({ type: 'cmd', label: 'Track Color', enabled: true, checked: !current, run: () => apply(null) }, { type: 'sep' });
  app.openMenu(items, { x: r.left + 40, y: r.top + 40, label: 'Color' });
}

// ------------------------------------------------------------------ helpers

function newSession(app, o) {
  const tracks = o.template?.tracks || null;
  const autoCrossfade = app.prefs.get('autoCrossfade') !== false;
  const name = app.uniqueName(sessionBaseName(o.name), '.asesx');
  // Saved templates also carry master settings, tempo and meter.
  let state = o.template?.master ? stateFromTemplate(o.template, { sampleRate: o.sampleRate, bitDepth: o.bitDepth, autoCrossfade }) : undefined;
  if (state && o.masterChannels) state = { ...state, master: { ...state.master, channels: o.masterChannels === 1 ? 1 : o.masterChannels === 6 ? 6 : 2 } };
  const doc = new Session({ name, sampleRate: o.sampleRate, bitDepth: o.bitDepth, state, template: state ? undefined : tracks || undefined, tracks: tracks ? undefined : 6, autoCrossfade, masterChannels: o.masterChannels });
  app.addDocument(doc);
  return doc;
}

/** The session to insert into from the Waveform editor: the most recent, or a new one. */
async function targetSession(app, rate) {
  const existing = [...app.documents].reverse().find((d) => d.kind === 'session');
  if (existing) return existing;
  const doc = new Session({ name: app.uniqueName('Untitled Session', '.asesx'), sampleRate: rate || 48000, tracks: 6, autoCrossfade: app.prefs.get('autoCrossfade') !== false });
  app.addDocument(doc, { activate: false });
  return doc;
}

/** Clips cut/copied from a session: { type: 'clips', sampleRate, clips (relative), pool } */
function clipboardFrom(doc, clips, range) {
  const t0 = range ? range[0] : Math.min(...clips.map((c) => c.start));
  // Track offsets count shown tracks, as pasting does (clips never land on hidden tracks).
  const audio = shownAudioTracks(doc.state);
  const idx = new Map(audio.map((t, i) => [t.id, i]));
  let parts = clips;
  if (range) {
    const s = S.trimClipsToRange({ ...doc.state, clips: clips.map((c) => ({ ...c, locked: false })) }, clips.map((c) => c.id), range[0], range[1], (id) => doc.sourceLength(id));
    parts = s.clips.filter((c) => c.start < range[1] && S.clipEnd(c) > range[0]);
  }
  // Track offsets count from the top track of what is copied (selected clips outside the range are not).
  const firstTrack = Math.min(...parts.map((c) => idx.get(c.trackId) ?? 0));
  const pool = new Map();
  for (const c of parts) {
    pool.set(c.sourceId, doc.pool.get(c.sourceId));
    // Keep a stretched clip's original audio so its stretch can be undone where it is pasted.
    const orig = c.soundAssistant?.duration?.orig?.sourceId;
    if (orig && doc.pool.has(orig)) pool.set(orig, doc.pool.get(orig));
    const unstretched = c.stretch?.sourceId;
    if (unstretched && doc.pool.has(unstretched)) pool.set(unstretched, doc.pool.get(unstretched));
    // Likewise a remixed clip's original audio, so it can be remixed again or reverted.
    const unremixed = c.remix?.sourceId;
    if (unremixed && doc.pool.has(unremixed)) pool.set(unremixed, doc.pool.get(unremixed));
  }
  return {
    type: 'clips',
    sampleRate: doc.sampleRate,
    clips: parts.map((c) => ({ ...c, start: c.start - t0, trackOffset: (idx.get(c.trackId) ?? 0) - firstTrack, groupId: null })),
    pool,
  };
}

async function pasteClips(app, doc, clip) {
  const at = doc.cursor;
  let state = doc.state;
  const audio = () => shownAudioTracks(state);
  let base = audio().findIndex((t) => t.id === doc.selectedTrack);
  if (base < 0) base = 0;
  const ids = [];
  // Preferences > Multitrack: move pasted clips down to tracks where they do not overlap others.
  if (placementOptions.avoidOverlap) {
    const spans = clip.type === 'audio' ? [{ trackOffset: 0, start: at, end: at + Math.round(((clip.channels[0]?.length ?? 0) * doc.sampleRate) / clip.sampleRate) }] : clip.clips.map((c) => ({ trackOffset: c.trackOffset, start: at + c.start, end: at + c.start + c.length }));
    base += freeTrackShift(state, base, spans);
  }
  if (clip.type === 'audio') {
    // Waveform audio becomes a new file in the Files panel and a clip.
    const channels = clip.sampleRate === doc.sampleRate ? clip.channels : await channelsAtRate(clip.channels, clip.sampleRate, doc.sampleRate);
    const file = new AudioFile({ name: app.uniqueName('Pasted Audio', '.wav'), sampleRate: doc.sampleRate, channels });
    app.addDocument(file, { activate: false });
    app.activate(doc);
    const sourceId = await linkSource(doc, file);
    let track = audio()[base];
    while (!track) {
      const made = newTrack(state, { channels: Math.min(2, channels.length) });
      state = made.state;
      track = audio()[base];
    }
    const c = S.createClip({ trackId: track.id, sourceId, name: baseName(file.name), start: at, length: channels[0].length });
    state = S.addClipsOnTop(state, [c]);
    ids.push(c.id);
  } else {
    for (const [id, src] of clip.pool) if (src && !doc.pool.has(id)) doc.pool.set(id, src);
    if (clip.sampleRate !== doc.sampleRate) {
      app.notify('Clips copied from a session at another sample rate cannot be pasted here.', { error: true });
      return;
    }
    const pasted = [];
    for (const c of clip.clips) {
      while (!audio()[base + c.trackOffset]) {
        const made = newTrack(state, {});
        state = made.state;
      }
      const n = S.createClip({ ...c, id: undefined, trackId: audio()[base + c.trackOffset].id, start: at + c.start });
      pasted.push(n);
      ids.push(n.id);
    }
    // Pasted clips come to the front, like clips placed by a move.
    state = S.addClipsOnTop(state, pasted);
  }
  doc.apply('Paste', state, { clips: ids });
}

function markerCmds(app) {
  const markersOf = (args) => {
    const doc = session(app);
    const ids = args?.ids?.length ? args.ids : app.selectedMarkerIds?.() || [];
    return doc ? doc.state.markers.filter((m) => ids.includes(m.id)) : [];
  };
  return {
    'marker.add': { enabled: hasSession, run: () => view(app)?.addMarker?.({ range: false }) },
    'marker.addRange': { enabled: hasTimeSel, run: () => view(app)?.addMarker?.({ range: true }) },
    'marker.rename': {
      enabled: (a, args) => Boolean(args?.id || markersOf(args).length),
      run: async (a, args) => {
        const doc = session(app);
        const m = doc.state.markers.find((x) => x.id === (args?.id || markersOf(args)[0]?.id));
        if (!m) return;
        const typeSel = h('select.select', { 'aria-label': 'Marker type' }, MARKER_TYPES.map((t) => h('option', { value: t.id, selected: t.id === m.type }, t.label)));
        const name = h('input.input', { type: 'text', value: m.name, 'aria-label': 'Marker name', style: { width: '100%' } });
        const desc = h('textarea.input', { rows: 2, 'aria-label': 'Description', style: { width: '100%' } }, m.description || '');
        const r = await openDialog({
          title: 'Marker',
          body: h('div.form-grid', h('label', 'Name:'), name, h('label', 'Type:'), typeSel, h('label', 'Description:'), desc),
          buttons: [
            { label: 'Cancel', value: null },
            { label: 'OK', value: 'ok', primary: true },
          ],
        });
        if (r !== 'ok') return;
        doc.apply('Rename Marker', { ...doc.state, markers: doc.state.markers.map((x) => (x.id === m.id ? { ...x, name: name.value, type: typeSel.value, description: desc.value } : x)) });
      },
    },
    'marker.deleteSelected': {
      enabled: (a, args) => markersOf(args).length > 0,
      run: (a, args) => {
        const doc = session(app);
        const ids = new Set(markersOf(args).map((m) => m.id));
        doc.apply(ids.size > 1 ? 'Delete Markers' : 'Delete Marker', { ...doc.state, markers: doc.state.markers.filter((m) => !ids.has(m.id)) });
      },
    },
    'marker.deleteAll': { enabled: (a) => Boolean(session(a)?.state.markers.length), run: () => session(app).apply('Delete All Markers', { ...session(app).state, markers: [] }) },
    'marker.merge': {
      enabled: (a, args) => markersOf(args).length > 1,
      run: (a, args) => {
        const doc = session(app);
        const ms = markersOf(args);
        const start = Math.min(...ms.map((m) => m.start));
        const end = Math.max(...ms.map((m) => m.start + m.duration));
        const ids = new Set(ms.map((m) => m.id));
        const merged = createMarker({ start, duration: end - start, name: ms[0].name, type: ms[0].type });
        doc.apply('Merge Markers', { ...doc.state, markers: sortMarkers([...doc.state.markers.filter((m) => !ids.has(m.id)), merged]) });
      },
    },
    'marker.convertRange': {
      enabled: (a, args) => markersOf(args).length === 1 && markersOf(args)[0].duration === 0 && hasTimeSel(a),
      run: (a, args) => {
        const doc = session(app);
        const m = markersOf(args)[0];
        doc.apply('Convert Marker', { ...doc.state, markers: doc.state.markers.map((x) => (x.id === m.id ? { ...x, start: doc.selection.start, duration: doc.selection.end - doc.selection.start } : x)) });
      },
    },
    'marker.previous': {
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const at = app.playhead - 1;
        const prev = doc.state.markers.flatMap((m) => [m.start, m.start + m.duration]).filter((f) => f < at).sort((x, y) => y - x)[0] ?? 0;
        view(app)?.seek(prev);
      },
    },
    'marker.next': {
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const at = app.playhead + 1;
        const next = doc.state.markers.flatMap((m) => [m.start, m.start + m.duration]).filter((f) => f > at).sort((x, y) => x - y)[0] ?? doc.length;
        view(app)?.seek(next);
      },
    },
  };
}

// --------------------------------------------------------------- register

export function installMultitrackCommands(app) {
  const C = app.commands;
  const run = (fn) => (a, args) => fn(session(app), args);
  const clipsArg = (doc, args) => (args?.id ? [S.findClip(doc.state, args.id)].filter(Boolean) : doc.clipSelection);
  const updateSelected = (label, patch) => (a, args) => {
    const doc = session(app);
    const ids = clipsArg(doc, args).map((c) => c.id);
    doc.apply(label, S.updateClips(doc.state, ids, patch));
  };
  const allSelected = (key) => (a) => {
    const clips = selected(a);
    return clips.length > 0 && clips.every((c) => c[key]);
  };
  const toggleSelected = (key, on, off) => (a, args) => {
    const doc = session(app);
    const clips = clipsArg(doc, args);
    const v = !clips.every((c) => c[key]);
    doc.apply(v ? on : off, S.updateClips(doc.state, clips.map((c) => c.id), { [key]: v }));
  };
  // Fade In / Fade Out submenus: the kind of fade (none, a plain fade or a
  // crossfade with the overlapping clip) and its curve. Checks follow the
  // first selected clip as it is heard.
  const fadeCmd = (dir, kind) => ({
    id: `clip.fade${dir === 'in' ? 'In' : 'Out'}${kind}`,
    label: kind === 'Log' ? 'Logarithmic' : kind,
    enabled: hasClips,
    checked: (a) => {
      const c = selected(a)[0];
      if (!c) return false;
      const f = dir === 'in' ? c.fadeIn : c.fadeOut;
      if (S.fadeMode(session(a).state, c, dir) === 'none') return false;
      return kind === 'Cosine' ? f.curve === 2 : kind === 'Linear' ? f.curve === 0 : kind === 'Log' ? f.curve > 0 && f.curve !== 2 : false;
    },
    run: () => {
      const doc = session(app);
      const key = dir === 'in' ? 'fadeIn' : 'fadeOut';
      const crossfading = new Set(S.activeCrossfades(doc.state).map((x) => (dir === 'in' ? x.in : x.out)));
      const state = S.updateClips(doc.state, [...doc.selectedClips], (c) => {
        const f = c[key];
        // A crossfading end keeps its overlap length; the curve shapes the crossfade.
        const length = f.length || (crossfading.has(c.id) ? 0 : S.defaultFadeLength(c, doc.sampleRate));
        return { [key]: { ...f, curve: S.FADE_CURVES[kind.toLowerCase()], length: Math.max(0, Math.min(c.length, Math.round(length))) } };
      });
      doc.apply(dir === 'in' ? 'Fade In' : 'Fade Out', state);
    },
  });
  const fadeModeCmd = (dir, mode) => {
    const In = dir === 'in' ? 'In' : 'Out';
    const overlapping = (a) => {
      const doc = session(a);
      if (!doc) return false;
      const ids = new Set(selected(a).map((c) => c.id));
      return S.crossfades(doc.state).some((x) => ids.has(dir === 'in' ? x.in : x.out));
    };
    return {
      id: `clip.fade${In}${mode === 'none' ? 'None' : mode === 'fade' ? 'On' : 'Crossfade'}`,
      label: mode === 'none' ? 'No Fade' : mode === 'fade' ? `Fade ${In}` : 'Crossfade',
      enabled: mode === 'crossfade' ? overlapping : hasClips,
      checked: (a) => {
        const c = selected(a)[0];
        return Boolean(c) && S.fadeMode(session(a).state, c, dir) === mode;
      },
      run: () => {
        const doc = session(app);
        const label = mode === 'crossfade' ? 'Crossfade' : mode === 'none' ? `No Fade ${In}` : `Fade ${In}`;
        doc.apply(label, S.setFadeMode(doc.state, [...doc.selectedClips], dir, mode));
      },
    };
  };
  const nudge = (dt, dTrack) => () => {
    const doc = session(app);
    const v = view(app);
    const step = Math.max(1, Math.round((v?.fpp || doc.sampleRate / 1000) * 5));
    doc.apply('Nudge', S.moveClips(doc.state, [...doc.selectedClips], dt * step, dTrack));
  };
  const rendered = async (label, o) => {
    const doc = session(app);
    const data = await renderSession(app, doc, { ...o, label });
    return { doc, data };
  };
  const mixdown = async (scope) => {
    const doc = session(app);
    let o;
    if (scope === 'time') o = { start: doc.selection.start, end: doc.selection.end };
    else if (scope === 'clips') {
      const clips = doc.clipSelection;
      const [a, b] = clipsRange(clips);
      o = { start: a, end: b, clipIds: new Set(clips.map((c) => c.id)) };
    } else o = { start: 0, end: doc.length };
    const { data } = await rendered('Mixing down', o);
    // Preferences > Markers & Metadata: session markers in the range go into the mixdown.
    const markers = app.prefs.get('markersInMixdowns') ? markersInRange(doc.state.markers, o.start, o.end).map((m) => createMarker(m)) : [];
    // A mono master mixes down to a mono file.
    return renderedDoc(app, doc, doc.state.master.channels === 1 ? data.slice(0, 1) : data, `${sessionBaseName(doc.name)}_mixdown`, markers);
  };
  const bounce = async (scope) => {
    const doc = session(app);
    let o;
    let name;
    let after = doc.selectedTrack;
    if (scope === 'track') {
      const t = selTrack(app);
      const ranges = doc.state.clips.filter((c) => c.trackId === t.id);
      o = { start: 0, end: Math.max(doc.length, ...ranges.map(S.clipEnd)), trackId: t.id };
      name = `${t.name} Bounce`;
      after = t.id;
    } else if (scope === 'time') {
      o = { start: doc.selection.start, end: doc.selection.end };
      name = 'Time Selection Bounce';
    } else if (scope === 'clipsTime') {
      // Only the selected clips, and only where they fall inside the time selection.
      const clips = doc.clipSelection.filter((c) => c.start < doc.selection.end && S.clipEnd(c) > doc.selection.start);
      o = { start: doc.selection.start, end: doc.selection.end, clipIds: new Set(clips.map((c) => c.id)) };
      name = 'Clip Bounce';
      after = clips[clips.length - 1]?.trackId || after;
    } else {
      const clips = doc.clipSelection;
      const [a, b] = clipsRange(clips);
      o = { start: a, end: b, clipIds: new Set(clips.map((c) => c.id)) };
      name = 'Clip Bounce';
      after = clips[clips.length - 1]?.trackId || after;
    }
    // The new track plays through the master, so the bounce leaves the master out.
    const { data } = await rendered('Bouncing', { ...o, master: false });
    const file = renderedDoc(app, doc, data, name);
    app.addDocument(file, { activate: false });
    const sourceId = await linkSource(doc, file);
    const afterTrack = S.findTrack(doc.state, after);
    // A 5.1 render goes on a 5.1 track, which plays all six channels.
    const made = newTrack(doc.state, { name: baseName(file.name), channels: data.length === 6 ? 6 : 2, afterId: afterTrack?.type === 'audio' ? after : undefined });
    const clip = S.createClip({ trackId: made.track.id, sourceId, name: baseName(file.name), start: o.start, length: data[0].length });
    doc.apply('Bounce to New Track', S.addClips(made.state, [clip]), { clips: [clip.id] });
    doc.selectTrack(made.track.id);
  };
  const addTrack = (type, channels) => () => {
    const doc = session(app);
    const after = S.findTrack(doc.state, doc.selectedTrack);
    const made = newTrack(doc.state, { type, channels, afterId: after && after.type !== 'master' ? after.id : undefined });
    doc.apply(type === 'bus' ? 'Add Bus Track' : 'Add Track', made.state);
    doc.selectTrack(made.track.id);
    view(app)?.revealTrack?.(made.track.id);
    announce(`${made.track.name} added`);
  };

  C.register([
    // ----------------------------------------------------------- File
    {
      id: 'file.newSession',
      label: 'Multitrack Session...',
      shortcut: 'Mod+N',
      run: async () => {
        const o = await newSessionDialog(app);
        if (o) newSession(app, o);
      },
    },
    { id: 'file.exportSession', label: 'Session...', enabled: hasSession, run: () => exportSession(app, session(app)) },
    {
      id: 'file.exportTemplate',
      label: 'Session as Template...',
      enabled: hasSession,
      run: async () => {
        const doc = session(app);
        const label = await promptDialog({ title: 'Save Session as Template', label: 'Template name:', value: sessionBaseName(doc.name), confirm: 'Save', validate: (v) => (v.trim() ? '' : 'Enter a name.') });
        if (!label) return;
        saveTemplate(app.prefs, templateFromState(doc.state, label.trim()));
        app.setStatus(`Saved template "${label.trim()}". Choose it in File > New > Multitrack Session.`);
      },
    },
    { id: 'export.mixdownSession', label: 'Entire Session...', enabled: (a) => Boolean(session(a)?.length), run: async () => saveDocument(app, await mixdown('all'), { copy: true }) },
    { id: 'export.mixdownTime', label: 'Time Selection...', enabled: hasTimeSel, run: async () => saveDocument(app, await mixdown('time'), { copy: true }) },
    { id: 'export.mixdownClips', label: 'Selected Clips...', enabled: hasClips, run: async () => saveDocument(app, await mixdown('clips'), { copy: true }) },

    // ------------------------------------------------------ Multitrack
    { id: 'mt.addMono', label: 'Add Mono Audio Track', enabled: hasSession, run: addTrack('audio', 1) },
    { id: 'mt.addStereo', label: 'Add Stereo Audio Track', shortcut: 'Alt+A', enabled: hasSession, run: addTrack('audio', 2) },
    { id: 'mt.addMonoBus', label: 'Add Mono Bus Track', enabled: hasSession, run: addTrack('bus', 1) },
    { id: 'mt.addBus', label: 'Add Stereo Bus Track', shortcut: 'Alt+B', enabled: hasSession, run: addTrack('bus', 2) },
    { id: 'mt.add51', label: 'Add 5.1 Audio Track', enabled: hasSession, run: addTrack('audio', 6) },
    { id: 'mt.add51Bus', label: 'Add 5.1 Bus Track', enabled: hasSession, run: addTrack('bus', 6) },
    {
      // A session has one video track: picking a video fills it (and puts the video's audio on a track).
      id: 'mt.addVideoTrack',
      label: 'Add Video Track...',
      enabled: (a) => hasSession(a) && !videoClip(session(a).state),
      run: async () => {
        const doc = session(app);
        const accept = `${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(',')},video/*`;
        const items = puter.sdk() && puter.isSignedIn() ? await puter.pickFiles({ multiple: false, accept }) : await pickLocalFiles({ accept });
        if (items?.length) await insertFiles(app, doc, items.slice(0, 1), { at: doc.cursor });
      },
    },
    {
      id: 'mt.addTracks',
      label: 'Add Tracks...',
      enabled: hasSession,
      run: async () => {
        const doc = session(app);
        const o = await addTracksDialog(app);
        if (!o) return;
        let state = doc.state;
        let after = S.findTrack(state, doc.selectedTrack)?.type === 'master' ? undefined : doc.selectedTrack;
        for (let i = 0; i < o.count; i++) {
          const made = newTrack(state, { type: /bus/i.test(o.type) ? 'bus' : 'audio', channels: o.type === 'mono' || o.type === 'monoBus' ? 1 : /surround/.test(o.type) ? 6 : 2, afterId: after });
          state = made.state;
          after = made.track.id;
        }
        doc.apply(o.count > 1 ? 'Add Tracks' : 'Add Track', state);
      },
    },
    { id: 'mt.duplicateTrack', label: 'Duplicate Selected Track', enabled: (a) => selTrack(a)?.type === 'audio' || selTrack(a)?.type === 'bus', run: () => session(app).apply('Duplicate Track', S.duplicateTrack(session(app).state, selTrack(app).id)) },
    {
      id: 'mt.deleteTrack',
      label: 'Delete Selected Track',
      enabled: (a, args) => Boolean(selTrack(a, args) && selTrack(a, args).type !== 'master'),
      run: (a, args) => {
        const doc = session(app);
        const t = selTrack(app, args);
        const i = doc.state.tracks.findIndex((x) => x.id === t.id);
        doc.apply('Delete Track', S.removeTracks(doc.state, [t.id]));
        const next = doc.state.tracks[Math.min(i, doc.state.tracks.length - 1)];
        if (next) doc.selectTrack(next.id);
        announce(`${t.name} deleted`);
      },
    },
    { id: 'mt.deleteEmpty', label: 'Delete Empty Tracks', enabled: (a) => Boolean(session(a)?.state.tracks.some((t) => t.type === 'audio' && !session(a).state.clips.some((c) => c.trackId === t.id))), run: () => session(app).apply('Delete Empty Tracks', S.removeEmptyTracks(session(app).state)) },
    { id: 'mt.moveTrackUp', label: 'Move Track Up', enabled: (a) => (session(a)?.state.tracks.findIndex((t) => t.id === session(a).selectedTrack) ?? -1) > 0, run: () => session(app).apply('Move Track', S.moveTrack(session(app).state, session(app).selectedTrack, -1)) },
    {
      id: 'mt.moveTrackDown',
      label: 'Move Track Down',
      enabled: (a) => {
        const doc = session(a);
        if (!doc) return false;
        const i = doc.state.tracks.findIndex((t) => t.id === doc.selectedTrack);
        return i >= 0 && i < doc.state.tracks.length - 1;
      },
      run: () => session(app).apply('Move Track', S.moveTrack(session(app).state, session(app).selectedTrack, 1)),
    },
    {
      id: 'mt.trackColor',
      label: 'Track Color...',
      enabled: (a, args) => Boolean(selTrack(a, args)),
      run: (a, args) => {
        const doc = session(app);
        const t = selTrack(app, args);
        const apply = (color) => doc.apply('Track Color', S.updateTrack(doc.state, t.id, { color }));
        if (args?.color) apply(args.color);
        else colorMenu(app, t.color, apply);
      },
    },
    {
      id: 'mt.renameTrack',
      label: 'Rename Track...',
      enabled: (a, args) => Boolean(selTrack(a, args)),
      run: async (a, args) => {
        const doc = session(app);
        const t = selTrack(app, args);
        const name = args?.name ?? (await promptDialog({ title: 'Rename Track', label: 'Track name:', value: t.name }));
        if (name && name.trim() && name.trim() !== t.name) doc.apply('Rename Track', S.updateTrack(doc.state, t.id, { name: name.trim() }));
      },
    },
    { id: 'mt.setTrackInput', label: 'Track Input', enabled: hasSession, run: (a, args) => session(app).apply('Track Input', S.updateTrack(session(app).state, args.id, { input: args.input })) },
    {
      id: 'mt.setTrackOutput',
      label: 'Track Output',
      enabled: hasSession,
      run: (a, args) => {
        const doc = session(app);
        if (args.output !== 'master' && S.wouldCycle(doc.state, args.id, args.output)) {
          app.notify('That routing would feed the bus back into itself.', { error: true });
          return;
        }
        doc.apply('Track Output', S.updateTrack(doc.state, args.id, { output: args.output }));
      },
    },
    { id: 'mt.trackEffects', label: 'Track Effects...', enabled: (a, args) => Boolean(selTrack(a, args)), run: (a, args) => openTrackEffects(app, session(app), selTrack(app, args).id) },
    { id: 'mt.toggleAutomationLane', label: 'Show Automation Lane', enabled: (a, args) => Boolean(selTrack(a, args)), checked: (a) => Boolean(selTrack(a)?.showAutomation), run: (a, args) => {
      const doc = session(app);
      const t = selTrack(app, args);
      const show = !t.showAutomation;
      doc.amendView((st) => S.updateTrack(st, t.id, { showAutomation: show }));
    } },
    { id: 'mt.setAutomationMode', label: 'Automation Mode', enabled: hasSession, run: (a, args) => session(app).apply(`Automation ${args.mode[0].toUpperCase()}${args.mode.slice(1)}`, S.updateTrack(session(app).state, args.id, { mode: args.mode })) },
    { id: 'mt.setAutomationParam', label: 'Automation Parameter', enabled: hasSession, run: (a, args) => session(app).amendView((st) => S.updateTrack(st, args.id, { autoParam: args.param, showAutomation: true })) },
    {
      id: 'mt.insertFiles',
      label: 'Insert Files...',
      enabled: (a, args) => hasSession(a) || Boolean(audioDoc(a)) || Boolean(args?.docs?.length),
      run: async (a, args) => {
        // Documents handed over by the Media Browser (args.docs, already opened).
        if (args?.docs?.length) {
          const target = session(app) || (await targetSession(app, args.docs[0].sampleRate));
          app.activate(target);
          return insertDocs(app, target, args.docs, { at: target.cursor });
        }
        const doc = session(app);
        if (!doc) {
          // From the Files panel or the Waveform editor: the active file goes into a session.
          const file = audioDoc(app);
          const target = await targetSession(app, file.sampleRate);
          app.activate(target);
          return insertDocs(app, target, [file], { at: target.cursor });
        }
        let items;
        if (puter.sdk() && puter.isSignedIn()) items = await puter.pickFiles({ multiple: true, accept: AUDIO_ACCEPT });
        else items = await pickLocalFiles({ accept: AUDIO_ACCEPT });
        if (items?.length) await insertFiles(app, doc, items, { at: doc.cursor });
      },
    },
    { id: 'mt.bounceTrack', label: 'Selected Track', enabled: (a) => Boolean(selTrack(a) && selTrack(a).type !== 'master' && session(a).length), run: () => bounce('track') },
    { id: 'mt.bounceTime', label: 'Time Selection', enabled: hasTimeSel, run: () => bounce('time') },
    {
      id: 'mt.bounceClipsInTime',
      label: 'Selected Clips in Time Selection',
      enabled: (a) => hasTimeSel(a) && selected(a).some((c) => c.start < session(a).selection.end && S.clipEnd(c) > session(a).selection.start),
      run: () => bounce('clipsTime'),
    },
    { id: 'mt.bounceClips', label: 'Selected Clips Only', enabled: hasClips, run: () => bounce('clips') },
    {
      id: 'mt.mixdownAll',
      label: 'Entire Session',
      enabled: (a) => Boolean(session(a)?.length),
      run: async () => app.addDocument(await mixdown('all')),
    },
    { id: 'mt.mixdownTime', label: 'Time Selection', enabled: hasTimeSel, run: async () => app.addDocument(await mixdown('time')) },
    { id: 'mt.mixdownClips', label: 'Selected Clips Only', enabled: hasClips, run: async () => app.addDocument(await mixdown('clips')) },
    {
      id: 'mt.metronome',
      label: 'Enable Metronome',
      shortcut: 'Shift+C',
      enabled: hasSession,
      checked: (a) => Boolean(session(a)?.state.metronome),
      run: () => {
        const doc = session(app);
        const on = !doc.state.metronome;
        doc.amendView((st) => ({ ...st, metronome: on }));
        app.syncGraph();
        announce(doc.state.metronome ? 'Metronome on' : 'Metronome off');
      },
    },
    { id: 'mt.metronomePattern', label: 'Edit Pattern...', enabled: hasSession, run: () => metronomeDialog(app, session(app)) },
    ...METRONOME_SOUNDS.map((x) => ({
      id: `mt.metronomeSound${x.id[0].toUpperCase()}${x.id.slice(1)}`,
      label: x.label,
      enabled: hasSession,
      checked: (a) => hasSession(a) && metronomeSoundOf(a, session(a)) === x.id,
      run: () => {
        setMetronomeSound(app, session(app), x.id);
        announce(`Metronome sound ${x.label}`);
      },
    })),
    { id: 'mt.clipKeyframes', label: 'Enable Clip Keyframe Editing', checked: (a) => a.prefs.get('clipVolumeEnvelopes') !== false, run: () => app.prefs.set('clipVolumeEnvelopes', app.prefs.get('clipVolumeEnvelopes') === false) },
    {
      id: 'mt.showAll',
      label: 'Show All Tracks',
      enabled: (a) => Boolean(session(a)?.state.tracks.some((t) => t.hidden)),
      run: () => {
        const doc = session(app);
        doc.amendView((st) => ({ ...st, tracks: st.tracks.map((t) => (t.hidden ? { ...t, hidden: false } : t)) }));
      },
    },
    {
      id: 'mt.showWithClips',
      label: 'Show Only Tracks with Clips',
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const used = new Set(doc.state.clips.map((c) => c.trackId));
        const hide = new Set(doc.state.tracks.filter((t) => t.type === 'audio' && !used.has(t.id)).map((t) => t.id));
        doc.amendView((st) => ({ ...st, tracks: st.tracks.map((t) => (Boolean(t.hidden) === hide.has(t.id) ? t : { ...t, hidden: hide.has(t.id) })) }));
      },
    },
    {
      id: 'mt.minimizeTrack',
      label: 'Minimize Selected Track',
      enabled: (a) => Boolean(selTrack(a)),
      checked: (a) => Boolean(selTrack(a)?.minimized),
      run: () => {
        const doc = session(app);
        const t = selTrack(app);
        const minimized = !t.minimized;
        doc.amendView((st) => S.updateTrack(st, t.id, { minimized }));
      },
    },
    { id: 'mt.hideTrack', label: 'Hide Selected Track', enabled: (a) => selTrack(a)?.type === 'audio' || selTrack(a)?.type === 'bus', run: () => {
        const id = session(app).selectedTrack;
        session(app).amendView((st) => S.updateTrack(st, id, { hidden: true }));
      },
    },
    { id: 'mt.sessionProperties', label: 'Session Properties...', enabled: hasSession, run: () => sessionPropertiesDialog(app, session(app)) },
    {
      id: 'mt.selectNextTrack',
      label: 'Select Next Track',
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const all = S.allTracks(doc.state).filter((t) => !t.hidden);
        const i = all.findIndex((t) => t.id === doc.selectedTrack);
        doc.selectTrack(all[Math.min(all.length - 1, i + 1)].id);
      },
    },
    {
      id: 'mt.selectPreviousTrack',
      label: 'Select Previous Track',
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const all = S.allTracks(doc.state).filter((t) => !t.hidden);
        const i = all.findIndex((t) => t.id === doc.selectedTrack);
        doc.selectTrack(all[Math.max(0, i - 1)].id);
      },
    },

    // ------------------------------------------------------------ Clip
    {
      id: 'clip.editSource',
      label: 'Edit Source File',
      shortcut: 'Mod+E',
      enabled: (a, args) => Boolean(session(a) && (args?.id || selected(a).length)),
      run: async (a, args) => {
        const doc = session(app);
        const c = args?.id ? S.findClip(doc.state, args.id) : doc.clipSelection[0];
        // A stretched clip opens its original audio, with the part it plays selected; a remixed
        // clip its original from where the remix starts to the end.
        const range = c && (c.remix ? { sourceId: c.remix.sourceId, offset: c.remix.offset, length: doc.sourceLength(c.remix.sourceId) - c.remix.offset } : originalRange(c));
        const src = c && doc.pool.get(range.sourceId);
        if (!src?.channels?.length) {
          app.notify('This clip’s media is offline.', { error: true });
          return;
        }
        let file = app.documents.find((d) => d.id === src.docId);
        if (!file) {
          file = new AudioFile({ name: src.name || `${c.name}.wav`, sampleRate: doc.sampleRate, channels: src.channels.slice() });
          app.addDocument(file, { activate: false });
          doc.pool.set(src.id, { ...src, docId: file.id, stateRef: file.state, sampleRate: doc.sampleRate });
        }
        app.activate(file);
        const ratio = file.sampleRate / doc.sampleRate;
        const a0 = Math.round(range.offset * ratio);
        file.setSelection(a0, Math.min(file.length, Math.round((range.offset + range.length) * ratio)));
        file.setCursor(a0);
      },
    },
    {
      id: 'clip.rename',
      label: 'Rename...',
      enabled: (a) => selected(a).length === 1,
      run: async () => {
        const doc = session(app);
        const c = doc.clipSelection[0];
        const name = await promptDialog({ title: 'Rename Clip', label: 'Clip name:', value: c.name });
        if (name && name.trim()) doc.apply('Rename Clip', S.updateClips(doc.state, [c.id], { name: name.trim() }));
      },
    },
    {
      id: 'clip.split',
      label: 'Split',
      shortcut: 'Mod+K',
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const at = Math.round(app.playhead);
        let ids = [...doc.selectedClips];
        if (!ids.length) ids = doc.state.clips.filter((c) => c.trackId === doc.selectedTrack).map((c) => c.id);
        const next = S.splitClips(doc.state, ids, at);
        if (next === doc.state) return app.setStatus('No clip under the playhead to split');
        doc.apply('Split', next);
        announce('Clip split');
      },
    },
    {
      id: 'clip.splitAll',
      label: 'Split All Clips Under Playhead',
      shortcut: 'Mod+Shift+K',
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        const next = S.splitClips(doc.state, null, Math.round(app.playhead));
        if (next !== doc.state) doc.apply('Split All', next);
      },
    },
    {
      id: 'clip.merge',
      label: 'Merge Clips',
      enabled: (a) => {
        const clips = selected(a);
        return clips.length > 1 && clips.every((c) => c.trackId === clips[0].trackId);
      },
      run: async () => {
        const doc = session(app);
        const clips = doc.clipSelection;
        const [a, b] = clipsRange(clips);
        const trackId = clips[0].trackId;
        const graphClips = new Set(clips.map((c) => c.id));
        // Render only these clips through clip gain, fades and envelopes (not the track): the
        // merged clip still plays through the track's EQ, polarity and pan, so they stay out. The
        // track's centre pan would apply the pan law's centre level once more, so it is undone.
        const law = app.prefs.get('panLaw') === 'equalPower' ? { mode: 'equalPower', centerDb: app.prefs.get('panLawDb') } : null;
        const volume = -20 * Math.log10(panGains(0, law)[0] || 1);
        const dry = { volume, pan: 0, fx: [], mode: 'off', mute: false, solo: false, output: 'master', invert: false, eq: { on: false, values: {} }, sends: [] };
        const tmp = { ...doc.state, tracks: doc.state.tracks.map((t) => (t.id === trackId ? { ...t, ...dry } : t)) };
        const data = await renderSession(app, doc, { state: tmp, start: a, end: b, clipIds: graphClips, trackId, label: 'Merging clips' });
        const file = renderedDoc(app, doc, data, `${clips[0].name} Merged`);
        app.addDocument(file, { activate: false });
        app.activate(doc);
        const sourceId = await linkSource(doc, file);
        const merged = S.createClip({ trackId, sourceId, name: baseName(file.name), start: a, length: data[0].length });
        doc.apply('Merge Clips', S.addClips(S.removeClips(doc.state, [...graphClips]), [merged]), { clips: [merged.id] });
      },
    },
    {
      id: 'clip.speechAlign',
      label: 'Automatic Speech Alignment...',
      enabled: (a) => selected(a).length === 2 && selected(a).every((c) => session(a).pool.get(c.sourceId)?.channels?.length),
      run: () => speechAlign(app, session(app)),
    },
    {
      id: 'clip.uniqueCopy',
      label: 'Convert to Unique Copy',
      enabled: (a) => selected(a).some((c) => session(a).pool.get(c.sourceId)?.channels?.length),
      run: async () => {
        const doc = session(app);
        await stretchIdle(doc);
        await remixIdle(doc);
        let state = doc.state;
        const made = [];
        for (const c of doc.clipSelection) {
          const src = doc.pool.get(c.sourceId);
          if (!src?.channels?.length) continue;
          // Channels are immutable and share their sample blocks, so the copy costs no memory
          // until either file is edited. A stretched or remixed clip keeps the audio it plays as the copy.
          const file = new AudioFile({ name: app.uniqueName(`${baseName(src.name || c.name)} Copy`, '.wav'), sampleRate: doc.sampleRate, channels: src.channels.slice() });
          app.addDocument(file, { activate: false });
          const sourceId = await linkSource(doc, file);
          state = S.updateClips(state, [c.id], { sourceId, stretch: null, remix: null });
          made.push(file.name);
        }
        app.activate(doc);
        doc.apply(made.length > 1 ? 'Convert to Unique Copies' : 'Convert to Unique Copy', state);
        announce(`${made.length} unique cop${made.length > 1 ? 'ies' : 'y'} made`);
      },
    },
    {
      id: 'clip.silenceTime',
      label: 'Silence Time Selection in Selected Clips',
      enabled: (a) => hasTimeSel(a) && selected(a).some((c) => c.start < session(a).selection.end && S.clipEnd(c) > session(a).selection.start),
      run: () => {
        const doc = session(app);
        // Done with each clip's volume envelope (no split), ramped over 3 ms at the edges.
        doc.apply('Silence Time in Clips', S.silenceClipsRange(doc.state, [...doc.selectedClips], doc.selection.start, doc.selection.end, doc.sampleRate * 0.003));
        if (app.prefs.get('clipVolumeEnvelopes') === false) app.prefs.set('clipVolumeEnvelopes', true);
      },
    },
    {
      id: 'clip.revealInFiles',
      label: 'Reveal Clips in Files Panel',
      enabled: (a) => selected(a).some((c) => session(a).pool.get(c.sourceId)?.channels?.length),
      run: () => {
        const doc = session(app);
        const ids = new Set();
        for (const c of doc.clipSelection) {
          const src = doc.pool.get(c.sourceId);
          if (!src?.channels?.length) continue;
          let file = app.documents.find((d) => d.id === src.docId);
          if (!file) {
            // Media without an open file (rendered or from a closed file): open it so it can be shown.
            file = new AudioFile({ name: app.uniqueName(baseName(src.name || c.name), '.wav'), sampleRate: doc.sampleRate, channels: src.channels.slice() });
            app.addDocument(file, { activate: false });
            doc.pool.set(src.id, { ...src, docId: file.id, stateRef: file.state });
          }
          ids.add(file.id);
        }
        app.dock?.openPanel('files', { focus: false });
        app.emit('reveal-files', [...ids]);
      },
    },
    { id: 'clip.trimToSelection', label: 'Trim to Time Selection', enabled: (a) => hasClips(a) && hasTimeSel(a), run: () => C.run('edit.trimToSelection') },
    {
      id: 'clip.trimInToPlayhead',
      label: 'Trim Start to Playhead',
      enabled: hasClips,
      run: () => {
        const doc = session(app);
        const at = app.playhead;
        const under = doc.clipSelection.filter((c) => at > c.start && at < S.clipEnd(c)).map((c) => c.id);
        doc.apply('Trim Start', S.trimClipsAt(doc.state, under, 'in', at, (id) => doc.sourceLength(id)));
      },
    },
    {
      id: 'clip.trimOutToPlayhead',
      label: 'Trim End to Playhead',
      enabled: hasClips,
      run: () => {
        const doc = session(app);
        const at = app.playhead;
        const under = doc.clipSelection.filter((c) => at > c.start && at < S.clipEnd(c)).map((c) => c.id);
        doc.apply('Trim End', S.trimClipsAt(doc.state, under, 'out', at, (id) => doc.sourceLength(id)));
      },
    },
    { id: 'clip.lock', label: 'Lock in Time', enabled: hasClips, checked: allSelected('locked'), run: toggleSelected('locked', 'Lock Clip', 'Unlock Clip') },
    {
      id: 'clip.loop',
      label: 'Loop',
      enabled: hasClips,
      checked: allSelected('loop'),
      run: (a, args) => {
        const doc = session(app);
        const clips = clipsArg(doc, args);
        const v = !clips.every((c) => c.loop);
        doc.apply(v ? 'Loop Clip' : 'Unloop Clip', S.setClipsLoop(doc.state, clips.map((c) => c.id), v, (id) => doc.sourceLength(id)));
      },
    },
    { id: 'clip.mute', label: 'Mute', enabled: hasClips, checked: allSelected('mute'), run: toggleSelected('mute', 'Mute Clip', 'Unmute Clip') },
    { id: 'clip.gain', label: 'Clip Gain...', enabled: hasClips, run: () => clipGainDialog(app, session(app), selected(app)) },
    { id: 'clip.matchLoudness', label: 'Match Clip Loudness...', enabled: hasClips, run: () => matchLoudnessDialog(app, session(app), selected(app)) },
    ...['none', 'fade', 'crossfade'].flatMap((m) => [fadeModeCmd('in', m), fadeModeCmd('out', m)]),
    ...['Linear', 'Log', 'Cosine'].flatMap((k) => [fadeCmd('in', k), fadeCmd('out', k)]),
    { id: 'clip.crossfadeSymmetric', label: 'Symmetrical', enabled: hasClips, checked: (a) => hasClips(a) && selected(a).every((c) => c.crossfade !== 'asymmetric'), run: updateSelected('Symmetrical Crossfade', { crossfade: 'symmetric' }) },
    { id: 'clip.crossfadeAsymmetric', label: 'Asymmetrical', enabled: hasClips, checked: (a) => hasClips(a) && selected(a).every((c) => c.crossfade === 'asymmetric'), run: updateSelected('Asymmetrical Crossfade', { crossfade: 'asymmetric' }) },
    {
      id: 'clip.autoCrossfade',
      label: 'Automatic Crossfades Enabled',
      enabled: hasSession,
      checked: (a) => session(a)?.state.autoCrossfade !== false,
      run: () => session(app).apply('Automatic Crossfades', { ...session(app).state, autoCrossfade: !session(app).state.autoCrossfade }),
    },
    { id: 'clip.group', label: 'Group Clips', shortcut: 'Mod+G', enabled: (a) => selected(a).length > 1, run: () => session(app).apply('Group Clips', S.groupClips(session(app).state, [...session(app).selectedClips])) },
    { id: 'clip.ungroup', label: 'Ungroup Selected Clips', shortcut: 'Mod+Shift+G', enabled: (a) => selected(a).some((c) => c.groupId), run: () => session(app).apply('Ungroup Clips', S.ungroupClips(session(app).state, [...session(app).selectedClips])) },
    {
      id: 'clip.globalStretch',
      label: 'Enable Global Clip Stretching',
      checked: (a) => Boolean(a.prefs.get('clipStretching')),
      run: () => {
        app.prefs.toggle('clipStretching');
        announce(app.prefs.get('clipStretching') ? 'Clip stretching on: drag a clip’s top corner with the Move tool' : 'Clip stretching off');
      },
    },
    {
      id: 'clip.realtimeAll',
      label: 'Realtime All Stretched Clips',
      enabled: (a) => hasSession(a) && stretchedClips(session(a).state, 'rendered').length > 0,
      run: () => {
        const doc = session(app);
        stretcherFor(app, doc).apply('Realtime All Stretched Clips', stretchedClips(doc.state, 'rendered').map((c) => c.id), { mode: 'realtime' });
      },
    },
    {
      id: 'clip.renderAll',
      label: 'Render All Stretched Clips',
      enabled: (a) => hasSession(a) && stretchedClips(session(a).state, 'realtime').length > 0,
      run: () => {
        const doc = session(app);
        stretcherFor(app, doc).apply('Render All Stretched Clips', stretchedClips(doc.state, 'realtime').map((c) => c.id), { mode: 'rendered' });
      },
    },
    ...STRETCH_MODES.map((m) => ({
      id: `clip.stretchMode${m.id[0].toUpperCase()}${m.id.slice(1)}`,
      label: m.label,
      enabled: hasClips,
      checked: (a) => hasClips(a) && stretchOf(selected(a)[0]).mode === m.id,
      run: () => {
        const doc = session(app);
        stretcherFor(app, doc).apply(`Stretch Mode ${m.label}`, [...doc.selectedClips], { mode: m.id });
      },
    })),
    { id: 'clip.stretch', label: 'Stretch Properties...', enabled: hasClips, run: () => stretchDialog(app, session(app), selected(app)) },
    ...remixCommands(app),
    {
      id: 'clip.suspendGroups',
      label: 'Suspend Groups',
      enabled: hasSession,
      checked: (a) => Boolean(session(a)?.groupsSuspended),
      run: () => {
        const doc = session(app);
        doc.groupsSuspended = !doc.groupsSuspended;
        // The selection follows: suspending keeps only the focus clip, resuming selects whole groups again.
        doc.selectClips(doc.groupsSuspended ? [doc.focusClipId].filter((id) => doc.selectedClips.has(id)) : [...doc.selectedClips]);
        announce(doc.groupsSuspended ? 'Groups suspended' : 'Groups resumed');
      },
    },
    {
      id: 'clip.removeFromGroup',
      label: 'Remove Focus Clip from Group',
      enabled: (a) => {
        const doc = session(a);
        const c = doc && S.findClip(doc.state, doc.focusClipId);
        return Boolean(c?.groupId && doc.selectedClips.has(c.id));
      },
      run: () => {
        const doc = session(app);
        const id = doc.focusClipId;
        doc.apply('Remove Clip from Group', S.removeFromGroup(doc.state, id), { clips: [id] });
      },
    },
    { id: 'clip.bringToFront', label: 'Bring to Front', enabled: hasClips, run: () => session(app).apply('Bring to Front', S.bringToFront(session(app).state, [...session(app).selectedClips])) },
    { id: 'clip.sendToBack', label: 'Send to Back', enabled: hasClips, run: () => session(app).apply('Send to Back', S.sendToBack(session(app).state, [...session(app).selectedClips])) },
    {
      id: 'clip.color',
      label: 'Clip Color...',
      enabled: hasClips,
      run: () => {
        const doc = session(app);
        colorMenu(app, doc.clipSelection[0].color, (color) => doc.apply('Clip Color', S.updateClips(doc.state, [...doc.selectedClips], { color })), { withDefault: true });
      },
    },
    { id: 'clip.nudgeLeft', label: 'Nudge Left', shortcut: 'Alt+,', enabled: hasClips, run: nudge(-1, 0) },
    { id: 'clip.nudgeRight', label: 'Nudge Right', shortcut: 'Alt+.', enabled: hasClips, run: nudge(1, 0) },
    { id: 'clip.nudgeLeft5', label: 'Nudge Left 5 Steps', enabled: hasClips, run: nudge(-5, 0) },
    { id: 'clip.nudgeRight5', label: 'Nudge Right 5 Steps', enabled: hasClips, run: nudge(5, 0) },
    { id: 'clip.nudgeUp', label: 'Nudge Up', shortcut: 'Alt+ArrowUp', enabled: hasClips, run: nudge(0, -1) },
    { id: 'clip.nudgeDown', label: 'Nudge Down', shortcut: 'Alt+ArrowDown', enabled: hasClips, run: nudge(0, 1) },

    // ------------------------------------------------------------ Edit
    { id: 'edit.rippleClips', label: 'Selected Clips', shortcut: 'Shift+Delete', enabled: hasClips, run: () => session(app).apply('Ripple Delete', S.rippleDeleteClips(session(app).state, [...session(app).selectedClips])) },
    {
      id: 'edit.rippleTimeClips',
      label: 'Time Selection in Selected Clips',
      enabled: (a) => hasClips(a) && hasTimeSel(a),
      run: () => {
        const doc = session(app);
        doc.apply('Ripple Delete', S.rippleDeleteTime(doc.state, doc.selection.start, doc.selection.end, { ids: [...doc.selectedClips] }), { selection: { start: doc.selection.start, end: doc.selection.start } });
      },
    },
    {
      id: 'edit.rippleTimeTrack',
      label: 'Time Selection in Selected Track',
      enabled: (a) => hasTimeSel(a) && selTrack(a)?.type === 'audio',
      run: () => {
        const doc = session(app);
        doc.apply('Ripple Delete', S.rippleDeleteTime(doc.state, doc.selection.start, doc.selection.end, { trackIds: [doc.selectedTrack] }), { selection: { start: doc.selection.start, end: doc.selection.start } });
      },
    },
    {
      id: 'edit.rippleTimeAll',
      label: 'Time Selection in All Tracks',
      shortcut: 'Mod+Shift+Delete',
      enabled: hasTimeSel,
      run: () => {
        const doc = session(app);
        doc.apply('Ripple Delete', S.rippleDeleteTime(doc.state, doc.selection.start, doc.selection.end), { selection: { start: doc.selection.start, end: doc.selection.start } });
      },
    },
    {
      id: 'edit.rippleGap',
      label: 'Gap in Selected Track',
      enabled: (a) => Boolean(session(a) && S.gapAt(session(a).state, session(a).selectedTrack, Math.round(a.playhead))),
      run: () => session(app).apply('Ripple Delete Gap', S.rippleDeleteGap(session(app).state, session(app).selectedTrack, Math.round(app.playhead))),
    },
    {
      id: 'edit.trimToSelection',
      label: 'Trim to Time Selection',
      enabled: (a) => hasClips(a) && hasTimeSel(a),
      run: () => {
        const doc = session(app);
        doc.apply('Trim to Selection', S.trimClipsToRange(doc.state, [...doc.selectedClips], doc.selection.start, doc.selection.end, (id) => doc.sourceLength(id)));
      },
    },
    {
      id: 'edit.insertIntoSession',
      label: 'Into Multitrack Session',
      enabled: (a) => Boolean(audioDoc(a)?.length),
      run: async () => {
        const file = audioDoc(app);
        const target = await targetSession(app, file.sampleRate);
        const range = file.hasSelection ? [file.selection.start, file.selection.end] : null;
        app.activate(target);
        await insertDocs(app, target, [file], { at: target.cursor, range });
      },
    },
    { id: 'edit.selectAllClipsTrack', label: 'All Clips in Selected Track', enabled: (a) => selTrack(a)?.type === 'audio', run: () => session(app).selectClips(session(app).state.clips.filter((c) => c.trackId === session(app).selectedTrack).map((c) => c.id)) },
    {
      id: 'edit.selectNextClip',
      label: 'Next Clip in Selected Track',
      enabled: (a) => selTrack(a)?.type === 'audio',
      run: () => {
        const doc = session(app);
        const clips = S.clipsOnTrack(doc.state, doc.selectedTrack);
        if (!clips.length) return;
        const cur = clips.findIndex((c) => doc.selectedClips.has(c.id));
        const next = clips[(cur + 1) % clips.length];
        doc.selectClips([next.id]);
        app.currentView?.()?.seek?.(next.start);
      },
    },
    {
      id: 'edit.selectClipsToTrackEnd',
      label: 'Clips to End of Selected Track',
      enabled: (a) => selTrack(a)?.type === 'audio',
      run: () => {
        const doc = session(app);
        doc.selectClips(S.clipsFrom(doc.state, app.playhead, 'end', doc.selectedTrack).map((c) => c.id));
      },
    },
    { id: 'edit.selectClipsToStart', label: 'Clips to Start of Session', enabled: (a) => Boolean(session(a)?.state.clips.length), run: () => session(app).selectClips(S.clipsFrom(session(app).state, app.playhead, 'start').map((c) => c.id)) },
    { id: 'edit.selectClipsToEnd', label: 'Clips to End of Session', enabled: (a) => Boolean(session(a)?.state.clips.length), run: () => session(app).selectClips(S.clipsFrom(session(app).state, app.playhead, 'end').map((c) => c.id)) },
    ...ASSISTANT_TYPE_IDS.map((type) => ({
      id: `edit.selectClipsOfType${type[0].toUpperCase()}${type.slice(1)}`,
      label: type === 'sfx' ? 'Sound Effects' : ASSISTANT_TYPES[type].label,
      enabled: (a) => Boolean(session(a)?.state.clips.some((c) => c.soundAssistant?.type === type)),
      run: () => session(app).selectClips(session(app).state.clips.filter((c) => c.soundAssistant?.type === type).map((c) => c.id)),
    })),
    {
      id: 'edit.selectAllTime',
      label: 'Select All Time',
      enabled: (a) => Boolean(a.active?.length),
      run: () => {
        const doc = app.active;
        if (doc.kind === 'session') doc.setSelection(0, doc.length, { tracks: S.allTracks(doc.state).map((t) => t.id) });
        else doc.setSelection(0, doc.length);
      },
    },
    {
      id: 'edit.selectTimeAroundClips',
      label: 'Select Time around Selected Clips',
      enabled: hasClips,
      run: () => {
        const doc = session(app);
        const clips = doc.clipSelection;
        const [a, b] = clipsRange(clips);
        doc.setSelection(a, b, { tracks: [...new Set(clips.map((c) => c.trackId))] });
      },
    },
    {
      id: 'edit.clearTimeSelection',
      label: 'Clear Time Selection',
      enabled: (a) => Boolean(a.active?.hasSelection),
      run: () => {
        const doc = app.active;
        const at = doc.cursor;
        doc.setSelection(at, at);
      },
    },
    { id: 'view.clipVolumeEnvelopes', label: 'Show Clip Volume Envelopes', checked: (a) => a.prefs.get('clipVolumeEnvelopes') !== false, run: () => app.prefs.set('clipVolumeEnvelopes', app.prefs.get('clipVolumeEnvelopes') === false) },
    { id: 'view.clipPanEnvelopes', label: 'Show Clip Pan Envelopes', checked: (a) => Boolean(a.prefs.get('clipPanEnvelopes')), run: () => app.prefs.toggle('clipPanEnvelopes') },
  ]);

  // Shared commands as they apply to sessions.
  const overrides = {
    'file.save': { enabled: hasSession, run: () => saveSession(app, session(app)) },
    'file.saveAs': { enabled: hasSession, run: () => saveSession(app, session(app), { saveAs: true }) },
    'file.saveCopy': { enabled: hasSession, run: () => saveSession(app, session(app), { copy: true, saveAs: true }) },
    'file.download': {
      label: 'Download Session (ZIP)',
      enabled: hasSession,
      run: async () => {
        const doc = session(app);
        await stretchIdle(doc);
        await remixIdle(doc);
        await prepareVideoBytes(doc);
        downloadBlob(sessionZip(doc), `${sessionBaseName(doc.name)}.zip`);
      },
    },
    'edit.cut': {
      enabled: hasClips,
      run: () => {
        const doc = session(app);
        const clips = doc.clipSelection;
        const range = doc.hasSelection ? [doc.selection.start, doc.selection.end] : null;
        app.clipboard = clipboardFrom(doc, clips, range);
        const next = range ? S.removeTimeFromClips(doc.state, range[0], range[1], { ids: clips.map((c) => c.id) }) : S.removeClips(doc.state, clips.map((c) => c.id));
        doc.apply('Cut', next);
      },
    },
    'edit.copy': {
      enabled: hasClips,
      run: () => {
        const doc = session(app);
        app.clipboard = clipboardFrom(doc, doc.clipSelection, doc.hasSelection ? [doc.selection.start, doc.selection.end] : null);
        app.setStatus(`Copied ${doc.clipSelection.length} clip${doc.clipSelection.length > 1 ? 's' : ''}`);
      },
    },
    'edit.paste': { enabled: (a) => hasSession(a) && (a.clipboard?.type === 'clips' || a.clipboard?.type === 'audio'), run: () => pasteClips(app, session(app), app.clipboard) },
    'edit.delete': {
      enabled: (a) => hasClips(a) || Boolean(session(a)?.selectedKeys),
      run: () => {
        const doc = session(app);
        if (doc.selectedKeys && view(app)?.deleteSelectedKeys?.()) return;
        const ids = [...doc.selectedClips];
        const sel = doc.selection;
        const inRange = sel.end > sel.start && doc.clipSelection.some((c) => c.start < sel.end && S.clipEnd(c) > sel.start);
        doc.apply(inRange ? 'Delete Time' : ids.length > 1 ? 'Delete Clips' : 'Delete Clip', inRange ? S.removeTimeFromClips(doc.state, sel.start, sel.end, { ids }) : S.removeClips(doc.state, ids));
      },
    },
    'edit.selectAll': {
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        doc.selectClips(doc.state.clips.map((c) => c.id));
      },
    },
    'edit.deselect': {
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        doc.selectClips([]);
        doc.setSelection(doc.cursor, doc.cursor);
      },
    },
    'edit.selectView': { enabled: hasSession, run: () => session(app).setSelection(session(app).view.start, session(app).view.end) },
    'view.zoomInAmp': { label: 'Zoom In (Track Height)', enabled: hasSession, run: () => session(app).setAmp((session(app).view.amp || 1) * 1.25) },
    'view.zoomOutAmp': { label: 'Zoom Out (Track Height)', enabled: hasSession, run: () => session(app).setAmp((session(app).view.amp || 1) / 1.25) },
    'view.zoomFull': {
      enabled: hasSession,
      run: () => {
        const doc = session(app);
        doc.setView(0, Math.max(doc.length * 1.05, doc.sampleRate * 30));
        doc.setAmp(1);
      },
    },
    'transport.record': { enabled: hasSession, run: () => app.multitrack.toggleRecording(session(app)) },
    ...markerCmds(app),
  };
  return overrides;
}
