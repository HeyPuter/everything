// Edit dialogs for audio files: Mix Paste, Convert Sample Type and Interpret
// Sample Rate, with the pure state changes behind them (exported for tests).

import { h, announce } from '../lib/dom.js';
import { Channel } from '../audio/channel.js';
import * as E from '../model/edits.js';
import { openDialog, promptDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { dsp } from '../audio/dsp.js';
import { decodeAudio, AUDIO_ACCEPT } from '../audio/decode.js';
import { pickLocalFiles } from '../storage/files.js';
import { DITHER_MODES, Quantizer } from '../audio/quantize.js';
import { COMMON_RATES } from '../export/formats.js';

const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

/** A framed group with a title set into its top edge. */
const group = (title, ...kids) => h('fieldset.dlg-group', h('legend', title), ...kids);

// --------------------------------------------------------------- mix paste

export const PASTE_TYPES = [
  { id: 'insert', label: 'Insert' },
  { id: 'overlap', label: 'Overlap (Mix)' },
  { id: 'overwrite', label: 'Overwrite' },
  { id: 'modulate', label: 'Modulate' },
];

export const MIX_PASTE_DEFAULTS = { type: 'overlap', copied: 100, existing: 100, invert: false, crossfade: false, crossfadeMs: 50, loop: false, loops: 3 };

/** Source channels conformed to `count` channels (mono spreads, more channels average down). */
function conformTo(source, count) {
  if (source.length === count) return source;
  if (count === 1) {
    const out = new Float32Array(source[0].length);
    for (const c of source) for (let i = 0; i < out.length; i++) out[i] += c[i] / source.length;
    return [out];
  }
  return Array.from({ length: count }, (_, i) => source[Math.min(i, source.length - 1)]);
}

/**
 * Pastes `source` (Float32Array per channel, at the state's rate) at frame
 * `at`. o: { type: 'insert'|'overlap'|'overwrite'|'modulate', copied, existing
 * (linear gains), invert, fadeFrames (crossfade at both edges), loops, mask }.
 * Overlap mixes, Overwrite replaces, Modulate multiplies the existing audio by
 * the copied audio; with a crossfade each one blends in and out at the edges.
 * The file grows when the paste runs past its end.
 */
export function mixPasteState(state, at, source, o = {}) {
  const nch = state.channels.length;
  const src = conformTo(source, nch);
  const unit = src[0]?.length || 0;
  const loops = Math.max(1, Math.min(1000, Math.round(o.loops || 1)));
  const n = unit * loops;
  if (!n) return state;
  at = Math.max(0, Math.round(at));
  const gc = (o.copied ?? 1) * (o.invert ? -1 : 1);
  const ge = o.existing ?? 1;
  const fade = Math.max(0, Math.min(Math.floor(n / 2), Math.round(o.fadeFrames || 0)));
  const env = (k) => (fade ? Math.min(1, (k + 0.5) / fade, (n - k - 0.5) / fade) : 1);
  const pasted = src.map((c) => {
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = c[k % unit] * gc;
    return out;
  });
  const type = o.type || 'overlap';
  if (type === 'insert') {
    if (fade) for (const p of pasted) for (let k = 0; k < n; k++) p[k] *= env(k);
    return E.insertClip(state, at, { channels: pasted.map((p) => Channel.fromSamples(p)) }, o.mask);
  }
  const len = state.channels[0]?.length ?? 0;
  let s = state;
  if (at + n > len) s = E.insertSilence(s, len, at + n - len);
  if (at > len) at = len;
  return {
    ...s,
    channels: s.channels.map((c, i) => {
      if (o.mask && !o.mask[i]) return c;
      const ex = c.toArray(at, at + n);
      const p = pasted[i];
      for (let k = 0; k < n; k++) {
        const f = env(k);
        const keep = 1 + (ge - 1) * f; // existing gain blends in with the crossfade
        if (type === 'overwrite') ex[k] = ex[k] * (1 - f) + p[k] * f;
        else if (type === 'modulate') ex[k] = ex[k] * keep * (1 - f + f * p[k]);
        else ex[k] = ex[k] * keep + p[k] * f;
      }
      return c.write(at, ex);
    }),
  };
}

const fmtSeconds = (frames, rate) => `${(frames / rate).toFixed(3)} s`;

/** Mix Paste from one of the clipboards or from an audio file on this device. */
export async function mixPasteDialog(app, { doc, conformRate }) {
  const saved = { ...MIX_PASTE_DEFAULTS, ...(app.prefs.get('mixPasteSettings') || {}) };
  const slider = (label, value) => {
    const range = h('input.slider', { type: 'range', min: 0, max: 200, step: 1, value, 'aria-label': `${label} volume` });
    const num = h('input.input.num', { type: 'number', min: 0, max: 200, step: 1, value, 'aria-label': `${label} volume (percent)` });
    range.addEventListener('input', () => (num.value = range.value));
    num.addEventListener('change', () => (range.value = num.value = clampNum(num.value, 0, 200, 100)));
    return { range, num, row: [h('label', `${label}:`), h('div.row.mixpaste-slider', range, num, h('span.muted', '%'))] };
  };
  const copied = slider('Copied Audio', saved.copied);
  const existing = slider('Existing Audio', saved.existing);
  const invert = h('input', { type: 'checkbox', checked: saved.invert });
  const xf = h('input', { type: 'checkbox', checked: saved.crossfade });
  const xfMs = h('input.input.num', { type: 'number', min: 1, max: 5000, step: 1, value: saved.crossfadeMs, disabled: !saved.crossfade, 'aria-label': 'Crossfade length (milliseconds)' });
  xf.addEventListener('change', () => (xfMs.disabled = !xf.checked));
  const types = PASTE_TYPES.map((t) => h('input', { type: 'radio', name: 'mixpaste-type', value: t.id, checked: t.id === saved.type }));
  // Existing Audio has no effect on Insert.
  const syncType = () => {
    const insert = types.find((r) => r.checked)?.value === 'insert';
    existing.range.disabled = existing.num.disabled = insert;
  };
  types.forEach((r) => r.addEventListener('change', syncType));
  syncType();

  // Sources: non-empty audio clipboards, or a file.
  const boards = app.clipboards.map((c, i) => ({ c, i })).filter(({ c }) => c && c.type !== 'clips' && c.channels?.length);
  const fromClip = h('input', { type: 'radio', name: 'mixpaste-src', value: 'clipboard', checked: boards.length > 0, disabled: !boards.length });
  const fromFile = h('input', { type: 'radio', name: 'mixpaste-src', value: 'file', checked: !boards.length });
  const board = h(
    'select.select',
    { 'aria-label': 'Clipboard', disabled: !boards.length },
    boards.length ? boards.map(({ c, i }) => h('option', { value: i, selected: i === app.clipboardIndex }, `Clipboard ${i + 1}: ${fmtSeconds(c.channels[0].length, c.sampleRate)}, ${c.channels.length === 1 ? 'mono' : 'stereo'}`)) : h('option', 'All clipboards are empty'),
  );
  const fileName = h('input.input', { type: 'text', readOnly: true, placeholder: 'No file chosen', 'aria-label': 'File to paste' });
  let file = null;
  const browse = h('button.btn', { type: 'button' }, 'Browse...');
  browse.addEventListener('click', async () => {
    const [f] = await pickLocalFiles({ accept: AUDIO_ACCEPT, multiple: false });
    if (!f) return;
    file = f;
    fileName.value = f.name;
    fromFile.checked = true;
  });
  const loop = h('input', { type: 'checkbox', checked: saved.loop });
  const loops = h('input.input.num', { type: 'number', min: 2, max: 1000, step: 1, value: saved.loops, disabled: !saved.loop, 'aria-label': 'Times to paste' });
  loop.addEventListener('change', () => (loops.disabled = !loop.checked));
  const error = h('div.dlg-error', { role: 'alert' });

  const r = await openDialog({
    title: 'Mix Paste',
    wide: true,
    body: h(
      'div.mixpaste',
      group('Volume', h('div.form-grid', ...copied.row, ...existing.row), h('div.row.mixpaste-opts', h('label.check', invert, 'Invert Copied Audio'), h('div.spacer'), h('label.check', xf, 'Crossfade'), xfMs, h('span.muted', 'ms'))),
      h(
        'div.mixpaste-cols',
        group('Paste Type', h('div.dlg-radios', ...PASTE_TYPES.map((t, i) => h('label.check', types[i], t.label)))),
        group('Audio Source', h('div.form-grid', h('label.check', fromClip, 'From Clipboard'), board, h('label.check', fromFile, 'From File'), h('div.row', fileName, browse))),
      ),
      h('div.row', h('label.check', loop, 'Loop Paste'), loops, h('span.muted', 'times')),
      error,
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
    onSubmit: () => {
      if (fromFile.checked && !file) {
        error.textContent = 'Choose a file to paste, or paste from a clipboard.';
        return false;
      }
      return true;
    },
  });
  if (r !== 'ok') return null;
  const type = types.find((x) => x.checked)?.value || 'overlap';
  const settings = {
    type,
    copied: clampNum(copied.num.value, 0, 200, 100),
    existing: clampNum(existing.num.value, 0, 200, 100),
    invert: invert.checked,
    crossfade: xf.checked,
    crossfadeMs: clampNum(xfMs.value, 1, 5000, 50),
    loop: loop.checked,
    loops: Math.round(clampNum(loops.value, 2, 1000, 3)),
  };
  app.prefs.set('mixPasteSettings', settings);
  let clip;
  if (fromFile.checked) {
    try {
      const d = await decodeAudio(await file.arrayBuffer(), file.name);
      clip = { sampleRate: d.sampleRate, channels: d.channels.map((c) => Channel.fromSamples(c)) };
    } catch (err) {
      app.notify(err.message, { error: true });
      return null;
    }
  } else clip = app.clipboards[Number(board.value)];
  clip = await conformRate(clip, doc.sampleRate);
  if (!clip?.channels?.length) return null;
  const at = doc.hasSelection ? doc.selection.start : doc.cursor;
  const state = mixPasteState(doc.state, at, clip.channels.map((c) => c.toArray()), {
    type,
    copied: settings.copied / 100,
    existing: settings.existing / 100,
    invert: settings.invert,
    fadeFrames: settings.crossfade ? Math.round((settings.crossfadeMs / 1000) * doc.sampleRate) : 0,
    loops: settings.loop ? settings.loops : 1,
    mask: doc.channelMask,
  });
  const n = clip.channels[0].length * (settings.loop ? settings.loops : 1);
  doc.apply('Mix Paste', state, { selection: { start: at, end: at + n } });
  return settings;
}

// ------------------------------------------------------- convert sample type

/** Built-in conversion targets; null fields keep the source's value. */
export const CONVERT_PRESETS = [
  { name: '(Default)', rate: null, channels: null, bits: null },
  { name: 'CD: 44100 Hz Stereo 16-bit', rate: 44100, channels: 2, bits: 16 },
  { name: 'Video: 48000 Hz Stereo 24-bit', rate: 48000, channels: 2, bits: 24 },
  { name: 'Podcast: 44100 Hz Mono 16-bit', rate: 44100, channels: 1, bits: 16 },
  { name: 'Speech: 16000 Hz Mono 16-bit', rate: 16000, channels: 1, bits: 16 },
  { name: 'Telephone: 8000 Hz Mono 8-bit', rate: 8000, channels: 1, bits: 8 },
  { name: 'Studio: 96000 Hz Stereo 32-bit Float', rate: 96000, channels: 2, bits: 32 },
];

/** Channels after a channel conversion with mix levels (0..1 per source channel or per output side). */
export function convertChannelData(channels, count, { left = 0.5, right = 0.5 } = {}) {
  if (channels.length === count) return channels;
  const n = channels[0]?.length || 0;
  if (count === 2 && channels.length > 2) {
    // Surround down to stereo: 5.1 (L R C LFE Ls Rs) folds centre and surrounds in at -3 dB,
    // leaving out the LFE; other layouts keep their front pair.
    if (channels.length !== 6) return channels.slice(0, 2);
    const [L, R, C, , Ls, Rs] = channels;
    const out = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      out[0][i] = L[i] + Math.SQRT1_2 * (C[i] + Ls[i]);
      out[1][i] = R[i] + Math.SQRT1_2 * (C[i] + Rs[i]);
    }
    return out;
  }
  if (count === 1) {
    // Down to mono: left and right weighted by the mix levels.
    const out = new Float32Array(n);
    const w = channels.length === 2 ? [left, right] : channels.map(() => 1 / channels.length);
    channels.forEach((c, ci) => {
      for (let i = 0; i < n; i++) out[i] += c[i] * w[ci];
    });
    return [out];
  }
  // Mono up to stereo: the mono signal at a level on each side.
  const src = channels[0];
  return [left, right].map((g) => {
    if (g === 1) return src;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = src[i] * g;
    return out;
  });
}

/** Samples rounded to a bit depth with dither ('none' | 'triangular' | 'shaped'); 32 keeps floats. */
export function quantizeChannels(channels, bits, dither = 'triangular') {
  if (!(bits < 32)) return channels;
  const q = new Quantizer(bits, channels.length, dither);
  return channels.map((c, ci) => {
    const ints = new Int32Array(c.length);
    q.convert(ci, c, c.length, ints);
    const out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) out[i] = ints[i] / q.scale;
    return out;
  });
}

/** Problem with a conversion target, or ''. */
export function convertProblem({ rate }) {
  if (!Number.isFinite(rate) || rate < 1000 || rate > 384000) return 'Enter a sample rate between 1000 and 384000 Hz.';
  return '';
}

/**
 * The state converted to { rate, channels, bits, mix: { left, right }, dither, quality, filter }.
 * `resample(samples, from, to, { quality, filter })` does band-limited rate conversion.
 */
export function convertState(state, target, resample) {
  const from = state.sampleRate;
  const rate = Math.round(target.rate || from);
  let data = state.channels.map((c) => c.toArray());
  let markers = state.markers;
  if (rate !== from) {
    data = data.map((c) => resample(c, from, rate, { quality: target.quality, filter: target.filter }));
    const k = rate / from;
    markers = markers.map((m) => ({ ...m, start: Math.round(m.start * k), duration: Math.round(m.duration * k) }));
  }
  data = convertChannelData(data, target.channels || data.length, target.mix);
  const bits = target.bits || state.bitDepth || 32;
  if (bits < 32 && (bits < (state.bitDepth || 32) || rate !== from || data.length !== state.channels.length)) data = quantizeChannels(data, bits, target.dither);
  return { ...state, sampleRate: rate, channels: data.map((c) => Channel.fromSamples(c)), markers, bitDepth: bits };
}

const layoutName = (ch) => (ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : ch === 6 ? '5.1' : `${ch} Channels`);
const describe = (rate, ch, bits) => `${rate} Hz, ${layoutName(ch)}, ${bits === 32 ? '32-bit Float' : `${bits}-bit`}`;

export async function convertSampleTypeDialog(app, doc) {
  const userPresets = () => (Array.isArray(app.prefs.get('convertPresets')) ? app.prefs.get('convertPresets') : []);
  const srcBits = doc.info.bitDepth || 32;
  const presetSel = h('select.select.dlg-preset', { 'aria-label': 'Preset' });
  const save = h('button.icon-btn', { type: 'button', title: 'Save as Preset', 'aria-label': 'Save as Preset' }, icon('save', 16));
  const del = h('button.icon-btn', { type: 'button', title: 'Delete Preset', 'aria-label': 'Delete Preset' }, icon('trash-2', 16));
  const listId = `rates-${Math.random().toString(36).slice(2)}`;
  const rate = h('input.input.num.dlg-rate', { type: 'number', min: 1000, max: 384000, step: 1, value: doc.sampleRate, list: listId, 'aria-label': 'Sample rate (Hz)' });
  const rates = h('datalist', { id: listId }, COMMON_RATES.map((r) => h('option', { value: r })));
  // A surround file keeps its channels unless the conversion asks for mono or stereo.
  const channels = h('select.select', { 'aria-label': 'Channels' }, h('option', { value: '1' }, 'Mono'), h('option', { value: '2' }, 'Stereo'), doc.channelCount > 2 ? h('option', { value: String(doc.channelCount) }, layoutName(doc.channelCount)) : null);
  channels.value = String(doc.channelCount);
  const left = h('input.input.num', { type: 'number', min: 0, max: 200, step: 1, 'aria-label': 'Left mix (percent)' });
  const right = h('input.input.num', { type: 'number', min: 0, max: 200, step: 1, 'aria-label': 'Right mix (percent)' });
  const mixNote = h('p.dlg-note');
  const bits = h('select.select', { 'aria-label': 'Bit depth' }, [8, 16, 24, 32].map((b) => h('option', { value: b }, b === 32 ? '32 (float)' : String(b))));
  bits.value = String(srcBits);
  const dither = h('select.select', { 'aria-label': 'Dither' }, DITHER_MODES.map((d) => h('option', { value: d.id }, d.label)));
  dither.value = app.prefs.get('convertDither') || 'triangular';
  const result = h('p.dlg-note', { role: 'status' });
  const error = h('div.dlg-error', { role: 'alert' });
  const srcSaved = app.prefs.get('convertSrc') || {};
  const quality = h('input.slider', { type: 'range', min: 0, max: 100, step: 1, value: srcSaved.quality ?? app.prefs.get('srcQuality') ?? 50, 'aria-label': 'Conversion quality' });
  const qualityNum = h('input.input.num', { type: 'number', min: 0, max: 100, step: 1, value: quality.value, 'aria-label': 'Conversion quality (percent)' });
  const filter = h('input', { type: 'checkbox', checked: srcSaved.filter ?? app.prefs.get('srcFilter') !== false });
  quality.addEventListener('input', () => (qualityNum.value = quality.value));
  qualityNum.addEventListener('change', () => (quality.value = qualityNum.value = clampNum(qualityNum.value, 0, 100, 50)));
  const rateAdv = h(
    'details.dlg-adv',
    h('summary', 'Advanced'),
    h('div.form-grid', h('label', 'Quality:'), h('div.row.mixpaste-slider', quality, qualityNum, h('span.muted', '%')), h('span'), h('label.check', filter, 'Pre/Post Filter')),
    h('p.dlg-note', 'Higher quality uses a longer filter and takes longer. The pre/post filter keeps the top of the band from folding back as aliasing.'),
  );
  const mixAdv = h('details.dlg-adv', h('summary', 'Advanced'), h('div.form-grid', h('label', 'Left Mix:'), h('div.row', left, h('span.muted', '%')), h('label', 'Right Mix:'), h('div.row', right, h('span.muted', '%'))), mixNote);
  const bitAdv = h('details.dlg-adv', h('summary', 'Advanced'), h('div.form-grid', h('label', 'Dither:'), dither), h('p.dlg-note', 'Dither replaces the distortion of rounding to fewer bits with low, even noise; noise shaping moves that noise toward high frequencies where it is harder to hear.'));

  const syncMix = () => {
    const toMono = Number(channels.value) === 1 && doc.channelCount === 2;
    const toStereo = Number(channels.value) === 2 && doc.channelCount === 1;
    mixAdv.hidden = !toMono && !toStereo;
    if (toMono && (left.dataset.mode !== 'mono')) [left.value, right.value, left.dataset.mode] = [50, 50, 'mono'];
    if (toStereo && (left.dataset.mode !== 'stereo')) [left.value, right.value, left.dataset.mode] = [100, 100, 'stereo'];
    mixNote.textContent = toMono ? 'How much of each side goes into the mono channel.' : 'The level of the mono channel on each side.';
  };
  const syncBits = () => {
    const b = Number(bits.value);
    bitAdv.hidden = b >= 32;
  };

  const syncResult = () => {
    const r = Math.round(Number(rate.value));
    result.textContent = `${describe(doc.sampleRate, doc.channelCount, srcBits)}  →  ${Number.isFinite(r) ? describe(r, Number(channels.value), Number(bits.value)) : '?'}`;
  };
  const all = () => [...CONVERT_PRESETS.map((p) => ({ ...p, builtIn: true })), ...userPresets()];
  const current = () => ({ rate: Math.round(Number(rate.value)), channels: Number(channels.value), bits: Number(bits.value) });
  const matches = (p) => {
    const c = current();
    return (p.rate ?? doc.sampleRate) === c.rate && (p.channels ?? doc.channelCount) === c.channels && (p.bits ?? srcBits) === c.bits;
  };
  const syncPresets = () => {
    const list = all();
    const at = list.findIndex(matches);
    presetSel.replaceChildren(...list.map((p, i) => h('option', { value: i, selected: i === at }, p.builtIn ? p.name : `${p.name} (yours)`)));
    if (at < 0) presetSel.append(h('option', { value: '', selected: true }, 'Custom'));
    del.disabled = at < 0 || list[at].builtIn;
    save.disabled = at >= 0;
  };
  const sync = () => {
    syncMix();
    syncBits();
    syncResult();
    syncPresets();
  };
  presetSel.addEventListener('change', () => {
    const p = all()[Number(presetSel.value)];
    if (!p) return;
    rate.value = p.rate ?? doc.sampleRate;
    channels.value = String(p.channels ?? doc.channelCount);
    bits.value = String(p.bits ?? srcBits);
    if (p.dither) dither.value = p.dither;
    if (p.quality != null) quality.value = qualityNum.value = p.quality;
    if (p.filter != null) filter.checked = p.filter;
    sync();
  });
  save.addEventListener('click', async () => {
    const name = await promptDialog({ title: 'Save Preset', label: 'Preset name:', value: describe(current().rate, current().channels, current().bits), validate: (v) => (!v.trim() ? 'Enter a name.' : CONVERT_PRESETS.some((p) => p.name.toLowerCase() === v.trim().toLowerCase()) ? 'A built-in preset has that name.' : '') });
    if (!name) return;
    const p = { name: name.trim(), ...current(), dither: dither.value, quality: Number(quality.value), filter: filter.checked };
    app.prefs.set('convertPresets', [...userPresets().filter((x) => x.name !== p.name), p]);
    sync();
    announce(`Saved preset ${p.name}`);
  });
  del.addEventListener('click', () => {
    const p = all()[Number(presetSel.value)];
    if (!p || p.builtIn) return;
    app.prefs.set('convertPresets', userPresets().filter((x) => x.name !== p.name));
    sync();
  });
  for (const el of [rate, channels, bits]) el.addEventListener('input', sync);
  for (const el of [rate, channels, bits]) el.addEventListener('change', sync);
  sync();

  const r = await openDialog({
    title: 'Convert Sample Type',
    className: 'convert-dialog',
    body: h(
      'div.dlg-stack',
      h('div.row.dlg-presets', h('label', 'Presets:'), presetSel, save, del),
      group('Sample Rate Conversion', h('div.form-grid', h('label', 'Sample Rate:'), h('div.row', rate, rates, h('span.muted', 'Hz'))), rateAdv),
      group('Channels', h('div.form-grid', h('label', 'Channels:'), channels), mixAdv),
      group('Bit Depth', h('div.form-grid', h('label', 'Bit Depth:'), h('div.row', bits, h('span.muted', 'bits'))), bitAdv),
      result,
      error,
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
    onSubmit: () => {
      const msg = convertProblem(current());
      error.textContent = msg;
      return !msg;
    },
  });
  if (r !== 'ok') return null;
  app.prefs.set('convertDither', dither.value);
  app.prefs.set('convertSrc', { quality: Number(quality.value), filter: filter.checked });
  const toMono = Number(channels.value) === 1;
  const target = {
    ...current(),
    mix: { left: clampNum(left.value, 0, 200, toMono ? 50 : 100) / 100, right: clampNum(right.value, 0, 200, toMono ? 50 : 100) / 100 },
    dither: dither.value,
    quality: Number(quality.value),
    filter: filter.checked,
  };
  const d = target.rate !== doc.sampleRate ? await dsp() : null;
  const state = convertState({ ...doc.state, bitDepth: srcBits }, target, (x, from, to, o) => d.resample(x, from, to, undefined, o));
  return state;
}

// ---------------------------------------------------- interpret sample rate

export async function interpretRateDialog(app, doc) {
  const listId = `irates-${Math.random().toString(36).slice(2)}`;
  const rate = h('input.input.num.dlg-rate', { type: 'number', min: 1000, max: 384000, step: 1, value: doc.sampleRate, list: listId, 'aria-label': 'Interpret sample rate as (Hz)' });
  const rates = h('datalist', { id: listId }, COMMON_RATES.map((r) => h('option', { value: r })));
  const duration = h('span.tabular');
  const error = h('div.dlg-error', { role: 'alert' });
  const sync = () => {
    const r = Number(rate.value);
    duration.textContent = r >= 1000 ? app.formatTime(doc.length, r) : '—';
  };
  rate.addEventListener('input', sync);
  sync();
  const r = await openDialog({
    title: 'Interpret Sample Rate',
    body: h(
      'div.dlg-stack',
      h('div.form-grid', h('label', 'Current sample rate:'), h('span.tabular', `${doc.sampleRate} Hz`), h('label', 'Interpret sample rate as:'), h('div.row', rate, rates, h('span.muted', 'Hz')), h('label', 'File duration:'), duration),
      h('p.dlg-note', 'The samples stay as they are and play faster or slower, which changes pitch and length together.'),
      error,
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: 'ok', primary: true },
    ],
    onSubmit: () => {
      const msg = convertProblem({ rate: Number(rate.value) });
      error.textContent = msg;
      return !msg;
    },
  });
  if (r !== 'ok') return null;
  return Math.round(Number(rate.value));
}
