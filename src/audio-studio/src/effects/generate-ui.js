// Effects > Generate: Tones, Noise, Silence and Speech. Generated audio is
// inserted at the playhead or replaces the selection in the active file; with
// no audio file open, a new file is created. Tones and Noise dialogs reuse the
// effect parameter controls and preset storage (ids gen.tones / gen.noise).
// Each dialog can play what it would generate before it is inserted.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { Channel } from '../audio/channel.js';
import { AudioFile } from '../model/audio-file.js';
import * as E from '../model/edits.js';
import { paramControls, inlinePrompt } from './dialog.js';
import { normalizeValues } from './params.js';
import { allPresets, userPresets, savePreset, deletePreset, matchPreset, lastValues, rememberValues } from './presets.js';
import { generateTones, generateNoise, dbToGain, WAVEFORMS, NOISE_COLORS, NOISE_STYLES } from './generate.js';
import { tonesBody, noiseBody } from './generate-views.js';
import { controlsFor } from './layout.js';
import { runTimePitch } from './defs/time-pitch.js';
import { withProgress } from './progress.js';
import { isAbort } from './apply.js';
import * as puter from '../storage/puter.js';
import { decodeAudio } from '../audio/decode.js';
import { dsp } from '../audio/dsp.js';
import { UserError } from '../lib/errors.js';
import { encodeWav } from '../audio/wav.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);

const PLACEMENT = { id: 'placement', label: 'Placement', type: 'choice', options: [{ value: 'insert', label: 'Insert at Playhead' }, { value: 'replace', label: 'Replace Selection' }], default: 'replace' };

const COMPONENTS = [1, 2, 3, 4, 5];

export const TONES_DEF = {
  id: 'gen.tones',
  name: 'Generate Tones',
  dialogClass: 'gen-tones',
  body: (ctx) => tonesBody(ctx),
  params: [
    { id: 'sweep', label: 'Sweep Frequencies', type: 'bool', default: false },
    { id: 'base', label: 'Base Frequency', min: 1, max: 22000, step: 1, default: 440, unit: 'Hz', scale: 'log' },
    { id: 'modulateBy', label: 'Modulation Depth', min: 0, max: 20000, step: 1, default: 0, unit: 'Hz' },
    { id: 'modFreq', label: 'Modulation Rate', min: 0.1, max: 20000, step: 0.1, default: 1, unit: 'Hz', scale: 'log' },
    { id: 'endBase', label: 'Base Frequency', min: 1, max: 22000, step: 1, default: 880, unit: 'Hz', scale: 'log', section: 'Sweep End' },
    { id: 'endModulateBy', label: 'Modulation Depth', min: 0, max: 20000, step: 1, default: 0, unit: 'Hz', section: 'Sweep End' },
    { id: 'endModFreq', label: 'Modulation Rate', min: 0.1, max: 20000, step: 0.1, default: 1, unit: 'Hz', scale: 'log', section: 'Sweep End' },
    { id: 'sweepCurve', label: 'Sweep Curve', type: 'choice', options: [{ value: 'log', label: 'Logarithmic' }, { value: 'linear', label: 'Linear' }], default: 'log', section: 'Sweep End' },
    { id: 'waveform', label: 'Shape', type: 'choice', options: WAVEFORMS, default: 'sine', section: 'Waveform' },
    { id: 'symmetry', label: 'Symmetry', min: 1, max: 99, step: 1, default: 50, unit: '%', section: 'Waveform' },
    ...COMPONENTS.flatMap((k) => [
      { id: `on${k}`, label: `Component ${k}`, type: 'bool', default: k === 1, section: 'Frequency Components' },
      { id: `amp${k}`, label: `Component ${k} Amplitude`, min: -120, max: 0, step: 0.1, default: k === 1 ? 0 : Math.round(-20 * Math.log10(k) * 10) / 10, unit: 'dB', section: 'Frequency Components' },
      { id: `mul${k}`, label: `Component ${k} Multiplier`, min: 0.01, max: 64, step: 0.01, default: k, unit: '', section: 'Frequency Components' },
    ]),
    { id: 'volume', label: 'Volume', min: -120, max: 0, step: 0.1, default: -6, unit: 'dB', section: 'Output' },
    { id: 'duration', label: 'Duration', min: 0.01, max: 3600, step: 0.01, default: 5, unit: 's', scale: 'log', section: 'Output' },
    { id: 'startPhase', label: 'Start Phase', min: 0, max: 360, step: 1, default: 0, unit: 'deg', section: 'Advanced' },
    { id: 'phaseOffset', label: 'Right Channel Phase Offset', min: -180, max: 180, step: 1, default: 0, unit: 'deg', section: 'Advanced' },
  ],
  presets: [
    { name: 'Default', values: {} },
    { name: '1 kHz Reference at -18 dB', values: { base: 1000, volume: -18, duration: 10 } },
    { name: 'Rich Organ Tone', values: { base: 220, on2: true, on3: true, on4: true, on5: true, volume: -6, duration: 4 } },
    { name: 'Siren', values: { base: 800, modulateBy: 300, modFreq: 0.5, waveform: 'triangle', volume: -9, duration: 6 } },
    { name: 'Low Buzz', values: { base: 60, waveform: 'sawtooth', volume: -12, duration: 3 } },
    { name: 'Full Range Sweep', values: { sweep: true, base: 20, endBase: 20000, sweepCurve: 'log', volume: -12, duration: 20 } },
    { name: 'Narrow Pulse Train', values: { base: 100, waveform: 'square', symmetry: 10, volume: -12, duration: 3 } },
    { name: 'Stereo Phase Test (Quadrature)', values: { base: 1000, phaseOffset: 90, volume: -12, duration: 5 } },
    { name: 'Bell Partials', values: { base: 300, on2: true, amp2: -6, mul2: 2.76, on3: true, amp3: -10, mul3: 5.4, on4: true, amp4: -14, mul4: 8.93, volume: -9, duration: 3 } },
  ],
};

/** Tone generator options from Generate Tones values. */
export function toneOptions(v, rate, frames) {
  return {
    rate,
    frames,
    base: v.base,
    components: COMPONENTS.map((k) => (v[`on${k}`] ? dbToGain(v[`amp${k}`]) : 0)),
    multipliers: COMPONENTS.map((k) => v[`mul${k}`]),
    waveform: v.waveform,
    symmetry: v.symmetry / 100,
    modulateBy: v.modulateBy,
    modFreq: v.modFreq,
    sweep: v.sweep ? { base: v.endBase, modulateBy: v.endModulateBy, modFreq: v.endModFreq, curve: v.sweepCurve } : null,
    volumeDb: v.volume,
    startPhase: v.startPhase,
  };
}

/** Generate Tones audio: one channel, or two when the right channel is phase shifted. */
export function renderTones(v, rate, channels) {
  const o = toneOptions(v, rate, Math.round(v.duration * rate));
  const left = generateTones(o);
  if (channels < 2 || !v.phaseOffset) return [left];
  return [left, generateTones({ ...o, startPhase: v.startPhase + v.phaseOffset })];
}

export const NOISE_DEF = {
  id: 'gen.noise',
  name: 'Generate Noise',
  dialogClass: 'gen-noise',
  body: (ctx) => noiseBody(ctx),
  params: [
    { id: 'color', label: 'Color', type: 'choice', options: NOISE_COLORS, default: 'white' },
    { id: 'style', label: 'Style', type: 'choice', options: NOISE_STYLES, default: 'independent' },
    { id: 'delay', label: 'Delay', min: 0, max: 5000, step: 1, default: 500, unit: '\u00b5s' },
    { id: 'intensity', label: 'Intensity', min: 0, max: 100, step: 1, default: 100, unit: '%' },
    { id: 'dcOffset', label: 'DC Offset', min: -100, max: 100, step: 1, default: 0, unit: '%' },
    { id: 'volume', label: 'Volume', min: -96, max: 0, step: 0.1, default: -12, unit: 'dB', section: 'Output' },
    { id: 'duration', label: 'Duration', min: 0.01, max: 3600, step: 0.01, default: 5, unit: 's', scale: 'log', section: 'Output' },
  ],
  presets: [
    { name: 'Default', values: {} },
    { name: 'Soft Pink Bed', values: { color: 'pink', volume: -30, duration: 30 } },
    { name: 'Brown Rumble', values: { color: 'brown', volume: -18, duration: 10 } },
    { name: 'Grey Masking Noise', values: { color: 'grey', volume: -24, duration: 30 } },
    { name: 'Wide Spatial Pink', values: { color: 'pink', style: 'spatial', delay: 700, volume: -18, duration: 10 } },
    { name: 'Mono Test Noise', values: { color: 'white', style: 'mono', volume: -20, duration: 10 } },
  ],
};

/** Generate Noise audio for `channels` channels. */
export function renderNoise(v, rate, channels, seed) {
  return generateNoise({ frames: Math.round(v.duration * rate), channels, rate, color: v.color, intensity: v.intensity / 100, volumeDb: v.volume, style: v.style, delayUs: v.delay, dcOffset: v.dcOffset / 100, seed });
}

export const SILENCE_DEF = {
  id: 'gen.silence',
  name: 'Generate Silence',
  params: [{ id: 'duration', label: 'Duration', min: 0.001, max: 3600, step: 0.001, default: 1, unit: 's', scale: 'log' }],
  presets: [],
};

/** Puts generated per-channel samples into the active file, or a new file when none is open. */
export function placeGenerated(app, outs, rate, { label, name, placement = 'replace' }) {
  const doc = audio(app);
  const n = outs[0]?.length || 0;
  if (!n) return null;
  if (!doc) {
    const count = app.prefs.get('defaultChannels') === 1 ? 1 : 2;
    const channels = Array.from({ length: count }, (_, i) => Channel.fromSamples(i < outs.length ? outs[i] : outs[0].slice()));
    const created = new AudioFile({ name: app.uniqueName(name), sampleRate: rate, channels });
    app.addDocument(created);
    created.setSelection(0, n);
    announce(`${label}: new file created`);
    return created;
  }
  const clip = { channels: E.conformChannels({ channels: outs.map((o) => Channel.fromSamples(o)) }, doc.channelCount) };
  const replace = placement === 'replace' && doc.hasSelection;
  const at = replace ? doc.selection.start : doc.cursor;
  const state = replace ? E.replaceRange(doc.state, doc.selection.start, doc.selection.end, clip, doc.channelMask) : E.insertClip(doc.state, at, clip, doc.channelMask);
  doc.apply(label, state, { selection: { start: at, end: at + n }, cursor: at });
  announce(`${label} inserted`);
  return doc;
}

/**
 * Values and change notification for a generator dialog, shaped like the
 * effect dialog ctx so the layout helpers (layout.js) work in both.
 */
export function generatorContext(def, initial) {
  let values = normalizeValues(def, initial);
  const subscribers = new Set();
  const ctx = {
    def,
    get values() {
      return values;
    },
    set(id, v) {
      const next = normalizeValues(def, { ...values, [id]: v });
      if (JSON.stringify(next) === JSON.stringify(values)) return;
      values = next;
      subscribers.forEach((fn) => fn(values));
    },
    setAll(next) {
      values = normalizeValues(def, next);
      subscribers.forEach((fn) => fn(values));
    },
    subscribe: (fn) => subscribers.add(fn),
  };
  return ctx;
}

/** Longest stretch a generator preview renders (s); longer durations preview their start. */
export const PREVIEW_SECONDS = 20;

/**
 * Play/stop and loop buttons that preview generated audio in a dialog.
 * render() returns (or resolves) { outs: Float32Array[], rate } or null.
 * While playing, refresh() renders again and carries on from the same spot,
 * so changes are heard as they are made. Returns { el, play, stop, refresh,
 * dispose, playing() }.
 */
export function previewPlayer(app, render, { label = 'Preview' } = {}) {
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  let url = null;
  let on = false;
  let token = 0;
  let timer = 0;
  const status = h('span.gen-preview-status.faint', { 'aria-live': 'polite' });
  const playBtn = h('button.icon-btn.fx-play', { type: 'button', 'aria-label': label, title: 'Play what will be generated', onclick: () => (on ? stop() : play()) }, icon('transport-play', 15));
  const loopOn = () => app.prefs?.get?.('genPreviewLoop') === true;
  const loopBtn = h('button.icon-btn.fx-loop', { type: 'button', 'aria-pressed': String(loopOn()), 'aria-label': 'Loop preview', title: 'Loop the preview', onclick: () => {
    const next = loopBtn.getAttribute('aria-pressed') !== 'true';
    loopBtn.setAttribute('aria-pressed', String(next));
    app.prefs?.set?.('genPreviewLoop', next);
    if (audio) audio.loop = next;
  } }, icon('transport-loop', 15));
  const show = (playing) => {
    on = playing;
    playBtn.replaceChildren(icon(playing ? 'transport-stop' : 'transport-play', 15));
    playBtn.setAttribute('aria-label', playing ? 'Stop preview' : label);
    playBtn.classList.toggle('on', playing);
  };
  audio?.addEventListener('ended', () => {
    if (!audio.loop) show(false);
  });
  async function play(at = 0) {
    if (!audio) return;
    const mine = ++token;
    show(true);
    status.textContent = '';
    let r;
    try {
      r = await render();
    } catch (err) {
      if (mine === token) {
        show(false);
        status.textContent = err?.message || 'The preview could not be made.';
      }
      return;
    }
    if (mine !== token || !on) return;
    if (!r?.outs?.length || !r.outs[0].length) {
      show(false);
      return;
    }
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(encodeWav({ sampleRate: r.rate, channels: r.outs.slice(0, 2), bitDepth: 32 }));
    audio.src = url;
    audio.loop = loopOn();
    try {
      audio.currentTime = Math.min(at, r.outs[0].length / r.rate);
    } catch {
      // Not seekable yet: start from the top.
    }
    try {
      await audio.play();
    } catch (err) {
      if (mine === token && err?.name !== 'AbortError') {
        show(false);
        status.textContent = 'Playback was blocked by the browser.';
      }
    }
  }
  function stop() {
    token++;
    clearTimeout(timer);
    audio?.pause();
    show(false);
  }
  function refresh() {
    if (!on) return;
    clearTimeout(timer);
    timer = setTimeout(() => play(audio?.currentTime || 0), 150);
  }
  function dispose() {
    stop();
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  const el = h('div.fx-footer-tools.gen-preview', playBtn, loopBtn, status);
  return { el, play, stop, refresh, dispose, playing: () => on, audio };
}

/** Dialog for a generator pseudo-definition with presets; resolves values or null. */
async function generatorDialog(app, def, { withPlacement, preview = null }) {
  const fullDef = withPlacement ? { ...def, params: [...def.params, { ...PLACEMENT, section: 'Output' }] } : def;
  const ctx = generatorContext(fullDef, lastValues(app.prefs, fullDef));
  ctx.app = app;
  ctx.rate = rateFor(app);
  ctx.channels = channelsFor(app);
  ctx.withPlacement = withPlacement;
  const presetSel = h('select.select.fx-preset-select', { 'aria-label': 'Presets' });
  const syncPresets = () => {
    const list = allPresets(app.prefs, def);
    const cur = matchPreset(app.prefs, def, ctx.values);
    presetSel.replaceChildren(...(cur ? [] : [h('option', { value: '' }, '(Custom)')]), ...list.map((p) => h('option', { value: p.name }, p.name)));
    presetSel.value = cur;
    delBtn.disabled = !list.find((p) => p.name === cur)?.user;
  };
  presetSel.addEventListener('change', () => {
    const p = allPresets(app.prefs, def).find((x) => x.name === presetSel.value);
    if (p) ctx.setAll({ ...normalizeValues(def, p.values), placement: ctx.values.placement });
  });
  let content;
  if (def.body) content = def.body(ctx);
  else {
    const controls = paramControls(fullDef, () => ctx.values, (id, v) => ctx.set(id, v));
    ctx.subscribe((v) => controls.refresh(v));
    content = controls.el;
  }
  ctx.subscribe(syncPresets);
  const nameRow = h('div.fx-namebar', { hidden: true });
  let dismiss = null;
  const saveBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Save settings as a preset', title: 'Save settings as a preset', onclick: () => {
    dismiss = inlinePrompt(nameRow, { label: 'Preset name:', value: 'My Preset', returnFocus: saveBtn, onSave: (n) => {
      const saved = savePreset(app.prefs, def, n, ctx.values);
      syncPresets();
      announce(`Preset ${saved} saved`);
    }, exists: (n) => userPresets(app.prefs, def.id).some((p) => p.name === n) });
  } }, icon('save', 15));
  // Your own presets can be deleted (built-in ones cannot).
  const delBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Delete preset', title: 'Delete preset', onclick: () => {
    const name = presetSel.value;
    if (!allPresets(app.prefs, def).find((p) => p.name === name)?.user) return;
    deletePreset(app.prefs, def.id, name);
    syncPresets();
    announce(`Preset ${name} deleted`);
  } }, icon('trash-2', 15));
  syncPresets();
  const player = preview ? previewPlayer(app, () => preview(ctx.values)) : null;
  if (player) ctx.subscribe(() => player.refresh());
  const r = await openDialog({
    title: def.name,
    className: `fx-dialog${def.dialogClass ? `.${def.dialogClass}` : ''}`,
    body: h('div.fx-dialog-body', def.presets.length ? h('div.fx-presetbar', h('label.fx-label', 'Presets:'), presetSel, saveBtn, delBtn) : null, nameRow, content),
    footerStart: player?.el,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
    initialFocus: '.fx-params .hot, .fx-params select, .fx-params input',
  });
  player?.dispose();
  dismiss?.();
  if (r !== 'ok') return null;
  rememberValues(app.prefs, fullDef, ctx.values);
  return ctx.values;
}

async function runGenerator(app, label, name, make, placement) {
  try {
    const { outs, rate } = await withProgress(app, label, async (signal) => {
      await new Promise((res) => setTimeout(res, 0));
      if (signal.aborted) return { outs: [], rate: 0 };
      return make();
    });
    return placeGenerated(app, outs, rate, { label, name, placement });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

const rateFor = (app) => audio(app)?.sampleRate || app.prefs.get('defaultRate') || 48000;
const channelsFor = (app) => audio(app)?.channelCount || (app.prefs.get('defaultChannels') === 1 ? 1 : 2);

/** The start of the generated audio (at most PREVIEW_SECONDS), for the dialog preview. */
const previewOf = (v) => ({ ...v, duration: Math.min(v.duration, PREVIEW_SECONDS) });

export async function generateTonesCommand(app) {
  const rate0 = rateFor(app);
  const v = await generatorDialog(app, TONES_DEF, { withPlacement: Boolean(audio(app)?.hasSelection), preview: (vals) => ({ outs: renderTones(previewOf(vals), rate0, channelsFor(app)), rate: rate0 }) });
  if (!v) return null;
  const rate = rateFor(app);
  return runGenerator(app, 'Generate Tones', 'Tones', () => {
    return { outs: renderTones(v, rate, channelsFor(app)), rate };
  }, v.placement);
}

export async function generateNoiseCommand(app) {
  const seed = (Date.now() & 0x7fffffff) | 1;
  const rate0 = rateFor(app);
  const v = await generatorDialog(app, NOISE_DEF, { withPlacement: Boolean(audio(app)?.hasSelection), preview: (vals) => ({ outs: renderNoise(previewOf(vals), rate0, channelsFor(app), seed), rate: rate0 }) });
  if (!v) return null;
  const rate = rateFor(app);
  return runGenerator(app, 'Generate Noise', 'Noise', () => ({ outs: renderNoise(v, rate, channelsFor(app), seed), rate }), v.placement);
}

export async function generateSilenceCommand(app) {
  const v = await generatorDialog(app, SILENCE_DEF, { withPlacement: false });
  if (!v) return null;
  const rate = rateFor(app);
  return placeGenerated(app, [new Float32Array(Math.round(v.duration * rate))], rate, { label: 'Generate Silence', name: 'Silence', placement: 'insert' });
}

// ------------------------------------------------------------- speech

export const SPEECH_LANGUAGES = [
  { code: 'en-US', label: 'English (US)', voices: ['Joanna', 'Matthew', 'Ivy', 'Justin', 'Kendra', 'Kimberly', 'Salli', 'Joey'] },
  { code: 'en-GB', label: 'English (UK)', voices: ['Amy', 'Brian', 'Emma'] },
  { code: 'en-AU', label: 'English (Australia)', voices: ['Nicole', 'Russell'] },
  { code: 'es-ES', label: 'Spanish (Spain)', voices: ['Lucia', 'Enrique', 'Conchita'] },
  { code: 'es-US', label: 'Spanish (US)', voices: ['Lupe', 'Miguel', 'Penelope'] },
  { code: 'fr-FR', label: 'French', voices: ['Lea', 'Mathieu', 'Celine'] },
  { code: 'de-DE', label: 'German', voices: ['Vicki', 'Hans', 'Marlene'] },
  { code: 'it-IT', label: 'Italian', voices: ['Bianca', 'Giorgio', 'Carla'] },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', voices: ['Camila', 'Vitoria', 'Ricardo'] },
  { code: 'nl-NL', label: 'Dutch', voices: ['Lotte', 'Ruben'] },
  { code: 'ja-JP', label: 'Japanese', voices: ['Mizuki', 'Takumi'] },
  { code: 'ko-KR', label: 'Korean', voices: ['Seoyeon'] },
  { code: 'cmn-CN', label: 'Chinese (Mandarin)', voices: ['Zhiyu'] },
  { code: 'hi-IN', label: 'Hindi', voices: ['Aditi'] },
];

export const NATURAL_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

const MAX_SPEECH_CHARS = 3000;

/** txt2speech options for a voice choice "polly:Joanna" or "openai:nova". */
export function speechOptions(voiceChoice, language, neural) {
  const [provider, voice] = String(voiceChoice).split(':');
  if (provider === 'openai') return { provider: 'openai', model: 'gpt-4o-mini-tts', voice, response_format: 'wav' };
  return { provider: 'aws-polly', voice, language, engine: neural ? 'neural' : 'standard' };
}

/** Readable message from a Puter error (objects, strings or Errors). */
export function puterErrorMessage(err) {
  if (!err) return 'Unknown error.';
  if (typeof err === 'string') return err;
  return err.message || err.error?.message || err.error || (err.code ? `Error ${err.code}` : 'Unknown error.');
}

/** Delivery settings applied to the synthesized speech: tempo (time stretch, pitch kept) and level. */
export const SPEECH_DEF = {
  id: 'gen.speech',
  name: 'Generate Speech',
  params: [
    { id: 'speed', label: 'Speaking Rate', min: 50, max: 200, step: 1, default: 100, unit: '%' },
    { id: 'volume', label: 'Volume', min: 0, max: 100, step: 1, default: 100, unit: '%' },
  ],
  presets: [],
};

/**
 * Applies speaking rate and volume to decoded speech. A rate above 100 %
 * speaks faster (shorter), below 100 % slower; the pitch is kept.
 */
export async function shapeSpeech(d, channels, rate, { speed = 100, volume = 100 } = {}, { signal } = {}) {
  let out = channels;
  if (Math.abs(speed - 100) > 0.5) out = await runTimePitch(d, channels, rate, { mode: 1, stretch: 100 / speed, pitch: 1, flags: 1 }, { signal });
  const g = Math.max(0, volume) / 100;
  if (g !== 1) out = out.map((c) => c.map((v) => v * g));
  return out;
}

async function speechDialog(app, sdk, targetRate) {
  const saved = app.prefs.get('speechSettings') || {};
  const delivery = generatorContext(SPEECH_DEF, { speed: saved.speed, volume: saved.volume });
  const text = h('textarea.input.speech-text', { rows: 5, 'aria-label': 'Text to speak', placeholder: 'Type the words to speak', maxLength: MAX_SPEECH_CHARS }, saved.text || '');
  const count = h('span.faint.tabular', { 'aria-live': 'off' });
  const updateCount = () => (count.textContent = `${text.value.length} / ${MAX_SPEECH_CHARS}`);
  text.addEventListener('input', updateCount);
  updateCount();
  const lang = h('select.select', { 'aria-label': 'Language' }, SPEECH_LANGUAGES.map((l) => h('option', { value: l.code, selected: l.code === (saved.language || 'en-US') }, l.label)));
  const voice = h('select.select', { 'aria-label': 'Voice' });
  const neural = h('input', { type: 'checkbox', checked: Boolean(saved.neural) });
  const neuralRow = h('label.check', neural, 'Neural quality (not every voice supports it)');
  const fillVoices = (keep) => {
    const l = SPEECH_LANGUAGES.find((x) => x.code === lang.value) || SPEECH_LANGUAGES[0];
    voice.replaceChildren(
      h('optgroup', { label: `${l.label} voices` }, l.voices.map((v) => h('option', { value: `polly:${v}` }, v))),
      h('optgroup', { label: 'Natural voices (any language)' }, NATURAL_VOICES.map((v) => h('option', { value: `openai:${v}` }, v[0].toUpperCase() + v.slice(1)))),
    );
    if (keep && [...voice.options].some((o) => o.value === keep)) voice.value = keep;
    neuralRow.hidden = voice.value.startsWith('openai:');
  };
  lang.addEventListener('change', () => fillVoices());
  voice.addEventListener('change', () => (neuralRow.hidden = voice.value.startsWith('openai:')));
  fillVoices(saved.voice);
  const doc = audio(app);
  const placement = doc?.hasSelection ? h('select.select', { 'aria-label': 'Placement' }, h('option', { value: 'replace' }, 'Replace Selection'), h('option', { value: 'insert' }, 'Insert at Playhead')) : null;
  const error = h('div.fx-name-error', { role: 'alert' });
  const current = () => ({ text: text.value, language: lang.value, voice: voice.value, neural: neural.checked, speed: delivery.values.speed, volume: delivery.values.volume });
  // Preview speaks the text now; OK then inserts the same take without asking the service again.
  const player = previewPlayer(app, async () => {
    const t = text.value.trim();
    if (!t) throw new UserError('Type some text to speak.');
    if (t.length > MAX_SPEECH_CHARS) throw new UserError(`Text must be under ${MAX_SPEECH_CHARS} characters.`);
    player.el.querySelector('.gen-preview-status').textContent = 'Generating...';
    const r = await synthesizeSpeech(sdk, current(), targetRate);
    player.el.querySelector('.gen-preview-status').textContent = '';
    return r;
  }, { label: 'Preview speech' });
  // Delivery changes reshape the cached take; other changes need a new one.
  delivery.subscribe(() => player.refresh());
  const r = await openDialog({
    title: 'Generate Speech',
    className: 'fx-dialog',
    body: h(
      'div.fx-dialog-body.speech-body',
      text,
      h('div.row', count, h('div.spacer'), h('span.faint', 'Uses Puter AI; requires a Puter account.')),
      h('div.form-grid', h('label', 'Language:'), lang, h('label', 'Voice:'), voice, h('span'), neuralRow, placement ? h('label', 'Placement:') : null, placement),
      controlsFor(delivery, ['speed', 'volume']),
      error,
    ),
    footerStart: player.el,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Generate', value: 'ok', primary: true },
    ],
    initialFocus: 'textarea',
    onSubmit: () => {
      const t = text.value.trim();
      if (!t) {
        error.textContent = 'Type some text to speak.';
        return false;
      }
      if (t.length > MAX_SPEECH_CHARS) {
        error.textContent = `Text must be under ${MAX_SPEECH_CHARS} characters.`;
        return false;
      }
      return true;
    },
  });
  player.dispose();
  if (r !== 'ok') return null;
  const settings = current();
  app.prefs.set('speechSettings', settings);
  return { ...settings, placement: placement?.value || 'insert' };
}

let speechTake = null; // the last synthesized speech: { key, outs, rate }

/**
 * Speech for the settings at `targetRate`: synthesized by Puter AI, decoded,
 * resampled and shaped (speaking rate, volume). The last take is kept, so a
 * preview followed by Generate asks the service once.
 */
export async function synthesizeSpeech(sdk, s, targetRate, signal) {
  const voiceKey = JSON.stringify([s.text.trim(), s.voice, s.language, s.neural, targetRate]);
  const key = JSON.stringify([voiceKey, s.speed, s.volume]);
  if (speechTake?.key === key) return speechTake;
  let raw = speechTake?.voiceKey === voiceKey ? speechTake.raw : null;
  const d = await dsp();
  if (!raw) {
    let el;
    try {
      el = await sdk.ai.txt2speech(s.text.trim(), speechOptions(s.voice, s.language, s.neural));
    } catch (err) {
      throw new UserError(`Speech could not be generated: ${puterErrorMessage(err)}`);
    }
    const decoded = await decodeSpeech(el, signal);
    raw = decoded.channels;
    if (decoded.sampleRate !== targetRate) raw = raw.map((c) => d.resample(c, decoded.sampleRate, targetRate));
  }
  const outs = await shapeSpeech(d, raw, targetRate, s, { signal });
  speechTake = { key, voiceKey, raw, outs, rate: targetRate };
  return speechTake;
}

/** Forgets the kept speech take (tests). */
export function clearSpeechTake() {
  speechTake = null;
}

/** Fetches the audio behind an <audio> element returned by txt2speech and decodes it. */
async function decodeSpeech(el, signal) {
  const src = el?.src || el?.currentSrc || (typeof el === 'string' ? el : null);
  if (!src) throw new UserError('The speech service returned no audio.');
  let buffer;
  try {
    const res = await fetch(src, { signal });
    if (!res.ok) throw new Error(String(res.status));
    buffer = await res.arrayBuffer();
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new UserError('The generated speech could not be downloaded. Check your connection and try again.');
  }
  return decodeAudio(buffer, 'speech.mp3');
}

export async function generateSpeechCommand(app) {
  const sdk = puter.sdk();
  if (!sdk?.ai?.txt2speech) {
    app.notify('Speech generation needs Puter, which is not available. Check your connection and reload.', { error: true });
    return null;
  }
  if (!puter.isSignedIn()) {
    const ok = await confirmDialog({ title: 'Sign In to Generate Speech', message: 'Generating speech uses Puter AI and needs a free Puter account. Sign in now?', confirm: 'Sign In' });
    if (!ok) return null;
    try {
      if (!(await puter.signIn())) return null;
    } catch (err) {
      app.notify(`Sign-in did not complete: ${puterErrorMessage(err)}`, { error: true });
      return null;
    }
  }
  const targetRate = rateFor(app);
  const s = await speechDialog(app, sdk, targetRate);
  if (!s) return null;
  try {
    const { outs, rate } = await withProgress(
      app,
      'Generating Speech',
      (signal) => synthesizeSpeech(sdk, s, targetRate, signal),
      { indeterminate: true, delay: 0 },
    );
    return placeGenerated(app, outs, rate, { label: 'Generate Speech', name: 'Speech', placement: s.placement });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export function installGenerators(app) {
  app.commands.register([
    { id: 'gen.tones', label: 'Tones...', run: () => generateTonesCommand(app) },
    { id: 'gen.noise', label: 'Noise...', run: () => generateNoiseCommand(app) },
    { id: 'gen.silence', label: 'Silence...', run: () => generateSilenceCommand(app) },
    { id: 'gen.speech', label: 'Speech...', run: () => generateSpeechCommand(app) },
  ]);
}
