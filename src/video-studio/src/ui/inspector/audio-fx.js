/**
 * Sound sections of the audio Basic tab: loudness normalization, noise
 * reduction, voice enhancement, pan, channels, beat detection and auto
 * ducking. Settings live in clip.audioFx (see model/audio.js); every change
 * goes through view.edit so it is one undo step (slider drags coalesce).
 * Analysis (loudness, noise profile, beats, ducking) decodes the clip's
 * source range first and then writes its result in a single edit.
 */
import '../../styles/audio-fx.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US } from '../../lib/time.js';
import { valueAt } from '../../model/keyframes.js';
import { segmented } from '../controls.js';
import { toast } from '../dialog.js';
import { slider, propSection, uidFor, restoreFocus } from './common.js';
import { CHANNEL_MODES, LOUDNESS_TARGETS, NORMALIZE_LIMIT_DB, defaultAudioFx, ensureAudioFx, loudnessGain } from '../../model/audio.js';

const fmtDb = (db) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;
const fmtLufs = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} LUFS`;

/** Lazy analysis helpers (decoder and DSP load only when used). */
async function analysisKit(view) {
  const [{ mediabunnyOpener, renderAudio }, an] = await Promise.all([import('../../engine/audio-mix.js'), import('../../media/audio-analysis.js')]);
  return { open: mediabunnyOpener(view.ctx.library), renderAudio, ...an };
}

/** Decode the selected clip's source range. */
async function clipSound(view) {
  const c = view.clip;
  const asset = c && view.project.assets[c.assetId];
  if (!asset) throw new Error('This clip has no media.');
  const kit = await analysisKit(view);
  const snd = await kit.decodeClipSound(kit.open, asset, c);
  if (!snd || !snd.channels[0]?.length) throw new Error('No sound found in this clip.');
  return { kit, snd };
}

/**
 * Busy state for an async action button: disables it, shows a spinner and
 * a status line, and reports failures as a toast.
 */
function runBusy(btn, status, label, fn) {
  return async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    status.textContent = label;
    status.hidden = false;
    try {
      await fn();
    } catch (err) {
      if (err?.name !== 'AbortError') toast(err?.message || 'Audio analysis failed.', { kind: 'error' });
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      status.textContent = '';
      status.hidden = true;
      restoreFocus(btn);
    }
  };
}

/**
 * A section with an on/off switch in its header (the setting's "on" flag)
 * and a reset button. onEnable(): optional async step before turning on
 * (analysis); it returns a patch merged in the same edit.
 */
function fxSection(view, { key, title, children, description, onEnable, open = true, resetLabel }) {
  const id = uidFor('fx');
  const sw = h('button.switch.small', { type: 'button', role: 'switch', id, 'aria-checked': 'false', 'aria-label': `${title}` });
  const status = h('p.fx-status', { role: 'status', hidden: true });
  const isOn = () => Boolean(view.clip?.audioFx?.[key]?.on);
  sw.addEventListener('click', async () => {
    const on = !isOn();
    if (on && onEnable) {
      if (sw.disabled) return;
      sw.disabled = true;
      status.hidden = false;
      status.textContent = 'Analyzing…';
      let patch;
      try {
        patch = await onEnable();
      } catch (err) {
        toast(err?.message || 'Audio analysis failed.', { kind: 'error' });
        return;
      } finally {
        sw.disabled = false;
        status.hidden = true;
        restoreFocus(sw);
      }
      view.edit(title, (c) => {
        Object.assign(ensureAudioFx(c)[key], patch || {}, { on: true });
      });
    } else {
      view.edit(on ? title : `${title} off`, (c) => {
        ensureAudioFx(c)[key].on = on;
      });
    }
    announce(`${title} ${on ? 'on' : 'off'}`);
  });
  const body = h('div.fx-body', description ? h('p.fx-desc', description) : null, status, children);
  const sync = () => {
    const on = isOn();
    sw.setAttribute('aria-checked', String(on));
    body.classList.toggle('fx-off', !on);
  };
  sync();
  view.bind(sync);
  const sec = propSection(title, [body], {
    open,
    actions: sw,
    onReset: () => {
      view.edit(resetLabel || `Reset ${title.toLowerCase()}`, (c) => {
        if (c.audioFx) c.audioFx[key] = defaultAudioFx()[key];
      });
      announce(`${title} reset`);
    },
  });
  sec.classList.add('fx-section');
  return { el: sec, status };
}

/** Edit one audioFx value; adjusting a setting turns its section on. */
function fxEdit(view, key, label, fn, opts) {
  return view.edit(label, (c) => {
    const fx = ensureAudioFx(c);
    fn(fx[key], c);
    fx[key].on = true;
  }, opts);
}

/* ---- Loudness ------------------------------------------------------------------- */

export function normalizeSection(view) {
  const sel = h('select.select', { 'aria-label': 'Target loudness' }, LOUDNESS_TARGETS.map((t) => h('option', { value: String(t.value) }, t.label)));
  const readout = h('p.fx-readout');
  const measureLabel = h('span', 'Measure');
  const measure = h('button.btn.small', { type: 'button' }, icon('audioLines', 14), measureLabel);
  const measureLoudness = async () => {
    const { kit, snd } = await clipSound(view);
    const lufs = kit.clipLoudness(snd.channels, snd.sampleRate);
    if (lufs === null) throw new Error('This clip is silent, so there is nothing to normalize.');
    return Math.round(lufs * 10) / 10;
  };
  const sec = fxSection(view, {
    key: 'normalize',
    title: 'Normalize loudness',
    description: 'Measure how loud the clip sounds and bring it to a target level.',
    onEnable: async () => {
      const n = view.clip?.audioFx?.normalize;
      return Number.isFinite(n?.loudness) ? {} : { loudness: await measureLoudness() };
    },
    children: [h('div.field.insp-row', h('label.field-label', 'Target'), h('div.insp-row-control', sel)), readout, measure],
  });
  sel.addEventListener('change', () => {
    fxEdit(view, 'normalize', 'Loudness target', (n) => {
      n.target = Number(sel.value);
    });
  });
  measure.addEventListener('click', runBusy(measure, sec.status, 'Measuring loudness…', async () => {
    const loudness = await measureLoudness();
    fxEdit(view, 'normalize', 'Measure loudness', (n) => {
      n.loudness = loudness;
    });
    announce(`Measured ${fmtLufs(loudness)}`);
  }));
  const render = () => {
    const c = view.clip;
    if (!c) return;
    const n = c.audioFx?.normalize || defaultAudioFx().normalize;
    if (document.activeElement !== sel) sel.value = String(LOUDNESS_TARGETS.some((t) => t.value === n.target) ? n.target : -14);
    if (Number.isFinite(n.loudness)) {
      const db = 20 * Math.log10(loudnessGain({ audioFx: { normalize: { ...n, on: true } } }));
      const capped = Math.abs(n.target - n.loudness) > NORMALIZE_LIMIT_DB;
      readout.textContent = `Measured ${fmtLufs(n.loudness)} · gain ${fmtDb(db)}${capped ? ' (limited)' : ''}`;
    } else readout.textContent = 'Not measured yet.';
    measureLabel.textContent = Number.isFinite(n.loudness) ? 'Measure again' : 'Measure';
  };
  render();
  view.bind(render);
  return sec.el;
}

/* ---- Noise, enhance ------------------------------------------------------------- */

export function denoiseSection(view) {
  const amount = slider(view, {
    label: 'Strength',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => c.audioFx?.denoise?.amount ?? 60,
    set: (v, final) => fxEdit(view, 'denoise', 'Noise reduction', (d) => {
      d.amount = v;
    }, { key: 'denoise-amount', final }),
  });
  const relearn = h('button.btn.small', { type: 'button' }, icon('audioLines', 14), 'Learn noise again');
  const learn = async () => {
    const { kit, snd } = await clipSound(view);
    // A couple of minutes is plenty to find the quiet stretches.
    const max = snd.sampleRate * 180;
    const chans = snd.channels.map((ch) => ch.subarray(0, Math.min(ch.length, max)));
    return kit.noiseProfile(chans, snd.sampleRate);
  };
  const sec = fxSection(view, {
    key: 'denoise',
    title: 'Reduce noise',
    description: 'Learns the background hiss and hum from the quietest moments of the clip and removes it.',
    onEnable: async () => (view.clip?.audioFx?.denoise?.profile ? {} : { profile: await learn() }),
    children: [amount.el, relearn],
  });
  relearn.addEventListener('click', runBusy(relearn, sec.status, 'Listening for noise…', async () => {
    const profile = await learn();
    fxEdit(view, 'denoise', 'Learn noise', (d) => {
      d.profile = profile;
    });
    announce('Noise profile updated');
  }));
  return sec.el;
}

export function enhanceSection(view) {
  const amount = slider(view, {
    label: 'Amount',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => c.audioFx?.enhance?.amount ?? 50,
    set: (v, final) => fxEdit(view, 'enhance', 'Enhance voice', (d) => {
      d.amount = v;
    }, { key: 'enhance-amount', final }),
  });
  return fxSection(view, {
    key: 'enhance',
    title: 'Enhance voice',
    description: 'Clearer speech: trims rumble and mud, adds presence, evens out the level and softens harsh “s” sounds.',
    children: [amount.el],
  }).el;
}

/* ---- Voice and music ---------------------------------------------------------------- */

export function separateSection(view) {
  const mode = segmented({
    label: 'Keep',
    options: [{ value: 'voice', label: 'Voice' }, { value: 'music', label: 'Music' }],
    value: view.clip?.audioFx?.separate?.mode || 'voice',
    onChange: (v) => fxEdit(view, 'separate', v === 'voice' ? 'Keep voice' : 'Keep music', (d) => {
      d.mode = v;
    }),
  });
  const amount = slider(view, {
    label: 'Strength',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => c.audioFx?.separate?.amount ?? 80,
    set: (v, final) => fxEdit(view, 'separate', 'Separate voice', (d) => {
      d.amount = v;
    }, { key: 'separate-amount', final }),
  });
  const sec = fxSection(view, {
    key: 'separate',
    title: 'Separate voice and music',
    description: 'Keeps the voice or the music of a song or mix: a voice is usually in the middle of the stereo picture, so parts that sound the same in both ears and sit in the voice range are treated as voice. Works best on stereo music.',
    children: [h('div.field.insp-row', h('span.field-label', 'Keep'), mode.el), amount.el],
  });
  view.bind(() => mode.set(view.clip?.audioFx?.separate?.mode || 'voice'));
  return sec.el;
}

/* ---- Pan and channels -------------------------------------------------------------- */

export function panSection(view) {
  const pan = slider(view, {
    label: 'Pan',
    min: -100,
    max: 100,
    unit: '',
    get: (c) => c.audioFx?.pan?.value ?? 0,
    set: (v, final) => fxEdit(view, 'pan', 'Pan', (p) => {
      p.value = v;
    }, { key: 'pan', final }),
  });
  const hint = h('div.fx-pan-scale', { 'aria-hidden': 'true' }, h('span', 'L'), h('span', 'C'), h('span', 'R'));
  pan.input.setAttribute('aria-valuetext', '');
  const describe = () => {
    const v = view.clip?.audioFx?.pan?.value ?? 0;
    pan.input.setAttribute('aria-valuetext', v === 0 ? 'center' : `${Math.abs(v)} ${v < 0 ? 'left' : 'right'}`);
  };
  describe();
  view.bind(describe);
  return fxSection(view, { key: 'pan', title: 'Pan', children: [pan.el, hint], open: false }).el;
}

export function channelSection(view) {
  const seg = segmented({
    label: 'Channels',
    options: CHANNEL_MODES.map((m) => ({ value: m.id, label: m.label })),
    value: view.clip.audioFx?.channel?.mode || 'stereo',
    className: 'fx-channels',
    onChange: (mode) => fxEdit(view, 'channel', 'Channels', (ch) => {
      ch.mode = mode;
    }),
  });
  view.bind(() => {
    const c = view.clip;
    if (c) seg.set(c.audioFx?.channel?.mode || 'stereo');
  });
  return fxSection(view, {
    key: 'channel',
    title: 'Channels',
    description: 'Use one side of a stereo recording on both speakers (for a mic recorded on one channel), swap the sides or fold to mono.',
    children: [seg.el],
    open: false,
  }).el;
}

/* ---- Beats ------------------------------------------------------------------------------- */

export function beatsSection(view) {
  const status = h('p.fx-status', { role: 'status', hidden: true });
  const info = h('p.fx-readout');
  const detect = h('button.btn.small', { type: 'button' }, icon('waveform', 14), 'Detect beats');
  const clearBtn = h('button.btn.small', { type: 'button' }, 'Clear');
  detect.addEventListener('click', runBusy(detect, status, 'Finding beats…', async () => {
    const { kit, snd } = await clipSound(view);
    // Beat tracking needs no more than ~22 kHz: decimate by an integer for speed.
    const mono = kit.downmix(snd.channels);
    const k = Math.max(1, Math.floor(snd.sampleRate / 22050));
    const dec = k > 1 ? mono.filter((_, i) => i % k === 0) : mono;
    const r = kit.detectBeats(dec, snd.sampleRate / k);
    if (!r) throw new Error('No steady beat found in this clip.');
    const c = view.clip;
    const beats = r.beats.map((t) => Math.round(c.in + t * US));
    view.edit('Detect beats', (x) => {
      x.beats = beats;
    });
    announce(`${beats.length} beats found, about ${Math.round(r.bpm)} per minute`);
  }));
  clearBtn.addEventListener('click', () => {
    view.edit('Clear beats', (x) => {
      delete x.beats;
    });
    announce('Beats cleared');
  });
  const render = () => {
    const c = view.clip;
    if (!c) return;
    const b = c.beats || [];
    clearBtn.disabled = !b.length;
    if (b.length < 2) {
      info.textContent = 'Find the beat to snap clips to it. Beats show as ticks on the clip.';
      return;
    }
    const gaps = b.slice(1).map((t, i) => t - b[i]).sort((x, y) => x - y);
    const bpm = 60 / (gaps[gaps.length >> 1] / US);
    info.textContent = `${b.length} beats · about ${Math.round(bpm)} BPM`;
  };
  render();
  view.bind(render);
  return propSection('Beats', [h('div.fx-body', info, status, h('div.fx-buttons', detect, clearBtn))], { open: false });
}

/* ---- Auto ducking ------------------------------------------------------------------- */

/**
 * Volume keys that lower clip where the rest of the project is loud.
 * Exported for tests: levels come from the other clips' mix.
 */
export function duckKeys(clip, curve) {
  const tol = 1000;
  const times = new Set(curve.map((p) => Math.round(p.t * US)));
  for (const k of clip.keyframes?.volume || []) times.add(k.t);
  const sorted = [...times].filter((t) => t >= 0 && t <= clip.duration).sort((a, b) => a - b);
  const out = [];
  for (const t of sorted) {
    if (out.length && t - out[out.length - 1].t < tol) continue;
    const base = valueAt(clip.keyframes, 'volume', t, clip.volume);
    out.push({ t, v: base * curveGain(curve, t / US), ease: 'linear' });
  }
  return out;
}

function curveGain(pts, t) {
  if (t <= pts[0].t) return pts[0].g;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      return b.t > a.t ? a.g + ((b.g - a.g) * (t - a.t)) / (b.t - a.t) : b.g;
    }
  }
  return pts[pts.length - 1].g;
}

export function duckSection(view, state = {}) {
  state.duckDb ??= 12;
  const status = h('p.fx-status', { role: 'status', hidden: true });
  const depth = slider(view, {
    label: 'Lower by',
    min: 3,
    max: 30,
    unit: 'dB',
    get: () => state.duckDb,
    set: (v) => {
      state.duckDb = v;
    },
  });
  const run = h('button.btn.small', { type: 'button' }, icon('speech', 14), 'Lower under speech');
  run.addEventListener('click', runBusy(run, status, 'Listening to the other clips…', async () => {
    const c = view.clip;
    if (!c) return;
    const kit = await analysisKit(view);
    // Everything that plays except this clip, over this clip's time span.
    const project = view.project;
    const others = { ...project, tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.filter((x) => x.id !== c.id) })) };
    const sr = 8000;
    const { channels } = await kit.renderAudio(others, view.ctx.library, { start: c.start, end: c.start + c.duration, sampleRate: sr, channels: 1 });
    const hop = 0.05;
    const regions = kit.activeRegions(kit.levelEnvelope(channels[0], sr, hop), hop);
    if (!regions.length) throw new Error('No speech or other sound plays under this clip.');
    const curve = kit.duckCurve(regions, c.duration / US, 10 ** (-state.duckDb / 20));
    const ok = view.edit('Lower under speech', (x) => {
      x.keyframes ||= {};
      x.keyframes.volume = duckKeys(x, curve);
    });
    if (ok !== false) announce(`Lowered in ${regions.length} ${regions.length === 1 ? 'place' : 'places'}`);
  }));
  return propSection('Auto ducking', [h('div.fx-body', h('p.fx-desc', 'Turn this clip down wherever other clips have speech or sound, with smooth fades. Adds volume keyframes you can adjust.'), depth.el, status, run)], { open: false });
}

/** All Basic-tab sound sections after Volume/Fades. */
export function soundSections(view, state) {
  const c = view.clip;
  const out = [normalizeSection(view), denoiseSection(view), enhanceSection(view), separateSection(view), panSection(view), channelSection(view)];
  if (c.type === 'audio') out.push(beatsSection(view), duckSection(view, state));
  return out;
}
