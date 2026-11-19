// Sound Assistant: audio types, their task settings, built-in presets and the
// mapping from task settings to real effect chains from the registry. Pure:
// no DOM, no app. The panel (panel.js) edits these settings; sessions store
// them on clips (clip.soundAssistant, with the chain in clip.fx), the Waveform
// editor keeps them per file and renders the chain on Apply.
//
// Settings shape (every type has every task it lists in TYPES):
//   { type, preset,
//     loudness: { on, target, measured },          measured LUFS (null until Auto-Match)
//     repair:   { on, items: { noise, rumble, hum, ess, reverb } }
//     clarity:  { on, items: { dynamics, eq, enhance } }
//     creative: { on, items: { reverb, width? } }
//     duration: { on, seconds, method, orig }      method 'stretch' | 'remix' (clips); orig: { sourceId, offset, length } once stretched
//     ducking:  { on, against: [type], sensitivity, reduce, fade }
//     pan:      { on, value }
//     volume:   { level, mute } }
// An item is { on, amount (0..10), ...choice } (hum.freq, eq.preset,
// enhance.voice, reverb.preset; width uses `amount` as a percentage).

export const TYPE_IDS = ['dialogue', 'music', 'sfx', 'ambience'];

export const TYPES = {
  dialogue: { label: 'Dialogue', icon: 'sa-dialogue', tasks: ['loudness', 'repair', 'clarity', 'creative', 'volume'] },
  music: { label: 'Music', icon: 'sa-music', tasks: ['loudness', 'duration', 'ducking', 'volume'] },
  sfx: { label: 'SFX', icon: 'sa-sfx', tasks: ['loudness', 'creative', 'pan', 'volume'] },
  ambience: { label: 'Ambience', icon: 'sa-ambience', tasks: ['loudness', 'creative', 'ducking', 'volume'] },
};

export const LOUDNESS_TARGETS = [
  { value: -23, label: 'Broadcast (-23 LUFS)' },
  { value: -24, label: 'US Broadcast (-24 LKFS)' },
  { value: -16, label: 'Podcast (-16 LUFS)' },
  { value: -14, label: 'Streaming (-14 LUFS)' },
  { value: -18, label: 'Quiet Bed (-18 LUFS)' },
  { value: -26, label: 'Background (-26 LUFS)' },
];

/** EQ shapes for Clarity (original names). Gains scale with the amount; filters do not. */
export const EQ_PRESETS = [
  { id: 'podcast', label: 'Podcast Voice', values: { hpOn: true, hpFreq: 80, hpSlope: 3, band2On: true, band2Freq: 250, band2Gain: -3, band2Q: 1.2, band4On: true, band4Freq: 3200, band4Gain: 3, band4Q: 0.9, hsOn: true, hsFreq: 10000, hsGain: 2 } },
  { id: 'warm', label: 'Warm Narrator', values: { hpOn: true, hpFreq: 60, hpSlope: 3, lsOn: true, lsFreq: 160, lsGain: 3, band4On: true, band4Freq: 4000, band4Gain: 1.5, band4Q: 1, hsOn: true, hsFreq: 9000, hsGain: -2 } },
  { id: 'present', label: 'Bright and Present', values: { hpOn: true, hpFreq: 100, hpSlope: 3, band3On: true, band3Freq: 2500, band3Gain: 3, band3Q: 0.8, hsOn: true, hsFreq: 8000, hsGain: 4 } },
  { id: 'demud', label: 'Clear the Mud', values: { hpOn: true, hpFreq: 90, hpSlope: 3, band2On: true, band2Freq: 300, band2Gain: -6, band2Q: 1.4 } },
  { id: 'telephone', label: 'Telephone', values: { hpOn: true, hpFreq: 400, hpSlope: 4, lpOn: true, lpFreq: 3200, lpSlope: 4, band3On: true, band3Freq: 1500, band3Gain: 4, band3Q: 1.2 } },
  { id: 'radio', label: 'Old Radio', values: { hpOn: true, hpFreq: 250, hpSlope: 3, lpOn: true, lpFreq: 5000, lpSlope: 3, band3On: true, band3Freq: 1800, band3Gain: 5, band3Q: 0.7 } },
];

/** Reverb spaces for Creative (original names), as Studio Reverb settings. */
export const REVERB_PRESETS = [
  { id: 'room', label: 'Small Room', values: { roomSize: 20, decay: 500, early: 65, width: 80, hfCut: 9000, lfCut: 120, damping: 55, diffusion: 70 } },
  { id: 'studio', label: 'Bright Studio', values: { roomSize: 30, decay: 800, early: 55, width: 100, hfCut: 14000, lfCut: 100, damping: 25, diffusion: 80 } },
  { id: 'hall', label: 'Concert Hall', values: { roomSize: 80, decay: 2600, early: 40, width: 100, hfCut: 7000, lfCut: 60, damping: 60, diffusion: 90 } },
  { id: 'church', label: 'Stone Church', values: { roomSize: 100, decay: 5000, early: 30, width: 100, hfCut: 6000, lfCut: 50, damping: 45, diffusion: 100 } },
  { id: 'outdoor', label: 'Open Air', values: { roomSize: 60, decay: 300, early: 85, width: 100, hfCut: 6000, lfCut: 150, damping: 80, diffusion: 30 } },
];

export const VOICES = [
  { value: 'male', label: 'Male Voice' },
  { value: 'female', label: 'Female Voice' },
];

export const HUM_FREQS = [
  { value: 50, label: '50 Hz' },
  { value: 60, label: '60 Hz' },
];

/**
 * Task schema for the panel. Items render as a checkbox with an amount
 * slider (and an optional choice); fields render as plain controls.
 */
export const TASKS = {
  loudness: { label: 'Loudness', toggle: true },
  repair: {
    label: 'Repair Sound',
    toggle: true,
    items: [
      { id: 'noise', label: 'Reduce Noise' },
      { id: 'rumble', label: 'Reduce Rumble' },
      { id: 'hum', label: 'DeHum', choice: { id: 'freq', label: 'Hum frequency', options: HUM_FREQS } },
      { id: 'ess', label: 'DeEss' },
      { id: 'reverb', label: 'Reduce Reverb' },
    ],
  },
  clarity: {
    label: 'Clarity',
    toggle: true,
    items: [
      { id: 'dynamics', label: 'Dynamics' },
      { id: 'eq', label: 'EQ', choice: { id: 'preset', label: 'EQ shape', options: EQ_PRESETS.map((p) => ({ value: p.id, label: p.label })) } },
      { id: 'enhance', label: 'Enhance Speech', choice: { id: 'voice', label: 'Voice', options: VOICES }, noAmount: true },
    ],
  },
  creative: {
    label: 'Creative',
    toggle: true,
    items: [{ id: 'reverb', label: 'Reverb', choice: { id: 'preset', label: 'Reverb space', options: REVERB_PRESETS.map((p) => ({ value: p.id, label: p.label })) } }],
  },
  duration: { label: 'Duration', toggle: true },
  ducking: { label: 'Ducking', toggle: true },
  pan: { label: 'Pan', toggle: true },
  volume: { label: 'Clip Volume', toggle: false },
};

/** Ambience adds a stereo width control to Creative. */
export const WIDTH_ITEM = { id: 'width', label: 'Stereo Width', min: 0, max: 300, step: 1, unit: '%' };

/** Task items for a type (Creative differs for Ambience). */
export function taskItems(type, task) {
  const items = TASKS[task]?.items || [];
  if (task === 'creative' && type === 'ambience') return [...items, WIDTH_ITEM];
  return items;
}

const item = (on, amount, extra = {}) => ({ on, amount, ...extra });

/** Default settings for a type. */
export function defaultSettings(type) {
  if (!TYPES[type]) throw new Error(`Unknown audio type "${type}".`);
  const s = { type, preset: '' };
  const tasks = TYPES[type].tasks;
  if (tasks.includes('loudness')) s.loudness = { on: false, target: type === 'dialogue' ? -23 : type === 'music' ? -25 : type === 'sfx' ? -21 : -30, measured: null };
  if (tasks.includes('repair')) s.repair = { on: false, items: { noise: item(true, 4), rumble: item(true, 4), hum: item(false, 5, { freq: 60 }), ess: item(false, 4), reverb: item(false, 3) } };
  if (tasks.includes('clarity')) s.clarity = { on: false, items: { dynamics: item(true, 4), eq: item(false, 5, { preset: 'podcast' }), enhance: item(false, 10, { voice: 'male' }) } };
  if (tasks.includes('creative')) {
    s.creative = { on: false, items: { reverb: item(true, type === 'ambience' ? 3 : 4, { preset: type === 'dialogue' ? 'room' : 'hall' }) } };
    if (type === 'ambience') s.creative.items.width = item(false, 140);
  }
  if (tasks.includes('duration')) s.duration = { on: false, seconds: 30, method: 'stretch', orig: null };
  if (tasks.includes('ducking')) s.ducking = { on: false, against: ['dialogue'], sensitivity: 6, reduce: type === 'ambience' ? -12 : -18, fade: 800 };
  if (tasks.includes('pan')) s.pan = { on: false, value: 0 };
  s.volume = { level: 0, mute: false };
  return s;
}

/** Deep merge of `patch` into settings (objects merge, arrays and values replace). */
export function mergeSettings(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) || !base || typeof base !== 'object' ? {} : { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeSettings(out[k], v) : v;
  return out;
}

/** Settings completed with the type's defaults (stale or partial input is fine). */
export function normalizeSettings(s) {
  if (!s || !TYPES[s.type]) return null;
  const d = defaultSettings(s.type);
  const out = mergeSettings(d, s);
  // Drop tasks the type does not have.
  for (const key of Object.keys(out)) if (!(key in d)) delete out[key];
  return out;
}

/** Returns a copy with the value at `path` (['repair', 'items', 'noise', 'amount']) set. */
export function setPath(obj, path, value) {
  if (!path.length) return value;
  const [head, ...rest] = path;
  const base = obj && typeof obj === 'object' ? obj : {};
  return { ...base, [head]: setPath(base[head], rest, value) };
}

export function getPath(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------------------------------------------------------------- presets

const P = (name, type, patch) => ({ name, type, settings: mergeSettings(defaultSettings(type), patch) });

/** Built-in presets per type (original names). */
export const BUILT_IN_PRESETS = [
  P('Balanced Dialogue', 'dialogue', { loudness: { on: true, target: -23 }, clarity: { on: true } }),
  P('Podcast Host', 'dialogue', { loudness: { on: true, target: -16 }, repair: { on: true, items: { noise: { amount: 3 }, rumble: { amount: 5 } } }, clarity: { on: true, items: { dynamics: { amount: 6 }, eq: { on: true, preset: 'podcast', amount: 6 } } } }),
  P('Noisy Location Interview', 'dialogue', { loudness: { on: true, target: -23 }, repair: { on: true, items: { noise: { amount: 7 }, rumble: { amount: 6 }, ess: { on: true, amount: 3 }, reverb: { on: true, amount: 4 } } }, clarity: { on: true, items: { dynamics: { amount: 5 } } } }),
  P('Phone Call', 'dialogue', { clarity: { on: true, items: { dynamics: { amount: 7 }, eq: { on: true, preset: 'telephone', amount: 8 } } } }),
  P('Vintage Radio Announcer', 'dialogue', { clarity: { on: true, items: { dynamics: { amount: 8 }, eq: { on: true, preset: 'radio', amount: 8 } } } }),
  P('Voice in a Hall', 'dialogue', { creative: { on: true, items: { reverb: { preset: 'hall', amount: 5 } } } }),
  P('Mains Hum Cleanup (50 Hz)', 'dialogue', { repair: { on: true, items: { noise: { on: false }, rumble: { amount: 3 }, hum: { on: true, freq: 50, amount: 6 } } } }),
  P('Mains Hum Cleanup (60 Hz)', 'dialogue', { repair: { on: true, items: { noise: { on: false }, rumble: { amount: 3 }, hum: { on: true, freq: 60, amount: 6 } } } }),
  P('Music Bed Under Voice', 'music', { loudness: { on: true, target: -26 }, ducking: { on: true, reduce: -15, fade: 800 } }),
  P('Music Feature', 'music', { loudness: { on: true, target: -16 } }),
  P('Gentle Ducking', 'music', { ducking: { on: true, sensitivity: 4, reduce: -9, fade: 1500 } }),
  P('Hard Ducking', 'music', { ducking: { on: true, sensitivity: 8, reduce: -24, fade: 300 } }),
  P('Balanced Effect', 'sfx', { loudness: { on: true, target: -21 } }),
  P('Distant Effect', 'sfx', { loudness: { on: true, target: -26 }, creative: { on: true, items: { reverb: { preset: 'hall', amount: 6 } } } }),
  P('Effect From the Left', 'sfx', { pan: { on: true, value: -60 } }),
  P('Effect From the Right', 'sfx', { pan: { on: true, value: 60 } }),
  P('Room Tone', 'ambience', { loudness: { on: true, target: -32 } }),
  P('Wide Outdoor Bed', 'ambience', { loudness: { on: true, target: -28 }, creative: { on: true, items: { reverb: { on: false }, width: { on: true, amount: 180 } } } }),
  P('Ambience Under Voice', 'ambience', { loudness: { on: true, target: -30 }, ducking: { on: true, reduce: -10, fade: 1200 } }),
];

/** Built-in and user presets for a type: [{ name, type, settings, user }]. */
export function presetsFor(type, user = {}) {
  const builtIn = BUILT_IN_PRESETS.filter((p) => p.type === type).map((p) => ({ ...p, user: false }));
  const names = new Set(builtIn.map((p) => p.name));
  const mine = (Array.isArray(user?.[type]) ? user[type] : []).filter((p) => p && p.name && !names.has(p.name)).map((p) => ({ name: p.name, type, settings: p.settings, user: true }));
  return [...builtIn, ...mine];
}

/** Fields that belong to one clip (measured loudness, stretch origin), not to a preset. */
export function stripPerClip(s) {
  let out = s;
  if (out.loudness) out = setPath(out, ['loudness', 'measured'], null);
  if (out.duration) out = setPath(out, ['duration', 'orig'], null);
  return out;
}

/** Applies a preset's settings while keeping per-clip fields of `current`. */
export function applyPreset(current, preset) {
  let next = normalizeSettings({ ...structuredClone(preset.settings), type: preset.type, preset: preset.name });
  if (current?.type === preset.type) {
    if (next.loudness) next = setPath(next, ['loudness', 'measured'], current.loudness?.measured ?? null);
    if (next.duration) next = setPath(next, ['duration', 'orig'], current.duration?.orig ?? null);
  }
  return next;
}

/** A user presets map with `name` saved (or replaced) for the settings' type. Built-in names are refused. */
export function saveUserPreset(user, name, settings) {
  name = String(name || '').trim();
  if (!name) throw new Error('Enter a preset name.');
  if (BUILT_IN_PRESETS.some((p) => p.type === settings.type && p.name === name)) throw new Error(`"${name}" is a built-in preset. Choose another name.`);
  const map = { ...(user || {}) };
  const list = (map[settings.type] || []).filter((p) => p.name !== name);
  list.push({ name, settings: stripPerClip({ ...settings, preset: name }) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  map[settings.type] = list;
  return map;
}

export function deleteUserPreset(user, type, name) {
  const map = { ...(user || {}) };
  map[type] = (map[type] || []).filter((p) => p.name !== name);
  if (!map[type].length) delete map[type];
  return map;
}

// ------------------------------------------------------------ chain mapping

const f10 = (a) => Math.max(0, Math.min(10, Number(a) || 0)) / 10;
const r1 = (v) => Math.round(v * 10) / 10;
const BANDS_OFF = { band1On: false, band2On: false, band3On: false, band4On: false, band5On: false };

/** Loudness gain in dB for the settings (0 until measured). */
export function loudnessGain(s) {
  const l = s?.loudness;
  if (!l?.on || !Number.isFinite(l.measured)) return 0;
  return Math.max(-40, Math.min(30, r1(l.target - l.measured)));
}

/**
 * The effect chain for settings, in processing order, as
 * [{ id, effect, values }] where `id` is stable per task item (so playback
 * keeps effect state while sliders move) and `effect` is a registry id.
 * Options:
 *   loudness  include the loudness match gain (default true)
 *   volume    include the clip volume as a gain stage (Waveform editor; default false)
 */
export function assistantChain(s, { loudness = true, volume = false } = {}) {
  s = normalizeSettings(s);
  if (!s) return [];
  const out = [];
  const add = (id, effect, values) => out.push({ id, effect, values });
  const on = (task, key) => s[task]?.on && s[task].items?.[key]?.on;
  const amt = (task, key) => f10(s[task].items[key].amount);

  if (s.repair?.on) {
    if (on('repair', 'rumble') && amt('repair', 'rumble') > 0) {
      const f = amt('repair', 'rumble');
      add('rumble', 'parametricEq', { ...BANDS_OFF, hpOn: true, hpFreq: Math.round(40 + f * 110), hpSlope: f > 0.6 ? 6 : 4 });
    }
    if (on('repair', 'hum') && amt('repair', 'hum') > 0) {
      const f = amt('repair', 'hum');
      add('hum', 'dehummer', { frequency: s.repair.items.hum.freq === 50 ? 50 : 60, q: 30, gain: -Math.round(12 + f * 48), harmonics: Math.round(2 + f * 10), slope: 75, humOnly: false });
    }
    if (on('repair', 'noise') && amt('repair', 'noise') > 0) {
      const f = amt('repair', 'noise');
      add('noise', 'denoise', { amount: Math.round(10 + f * 80), focus: 0, gain: 0 });
    }
    if (on('repair', 'reverb') && amt('repair', 'reverb') > 0) {
      const f = amt('repair', 'reverb');
      add('dereverb', 'dereverb', { amount: Math.round(10 + f * 80), focus: 0, gain: r1(f * 2), decay: 800 });
    }
    if (on('repair', 'ess') && amt('repair', 'ess') > 0) {
      const f = amt('repair', 'ess');
      add('ess', 'deesser', { mode: 1, frequency: 6500, bandwidth: 3000, threshold: -Math.round(18 + f * 24), reduction: Math.round(4 + f * 16), sibilanceOnly: false });
    }
  }
  if (s.clarity?.on) {
    if (on('clarity', 'dynamics') && amt('clarity', 'dynamics') > 0) {
      const f = amt('clarity', 'dynamics');
      add('dynamics', 'dynamics', {
        gateOn: false,
        compOn: true,
        threshold: -Math.round(10 + f * 22),
        ratio: r1(1.5 + f * 4.5),
        knee: 8,
        expOn: f > 0.5,
        expThreshold: -55,
        expRatio: 1.5,
        limOn: true,
        limThreshold: -1,
        attack: 5,
        release: 150,
        detection: 1,
        link: true,
        makeup: r1(f * 7),
      });
    }
    if (on('clarity', 'eq') && amt('clarity', 'eq') > 0) {
      const f = amt('clarity', 'eq');
      const shape = EQ_PRESETS.find((p) => p.id === s.clarity.items.eq.preset) || EQ_PRESETS[0];
      const values = { ...BANDS_OFF };
      for (const [k, v] of Object.entries(shape.values)) values[k] = /Gain$/.test(k) && typeof v === 'number' ? r1(v * f * 1.5) : v;
      add('eq', 'parametricEq', values);
    }
    if (on('clarity', 'enhance')) add('enhance', 'vocalEnhancer', { mode: s.clarity.items.enhance.voice === 'female' ? 1 : 0, amount: 100 });
  }
  if (s.creative?.on) {
    if (on('creative', 'reverb') && amt('creative', 'reverb') > 0) {
      const f = amt('creative', 'reverb');
      const space = REVERB_PRESETS.find((p) => p.id === s.creative.items.reverb.preset) || REVERB_PRESETS[0];
      add('reverb', 'studioReverb', { ...space.values, dry: 100, wet: Math.round(f * 70) });
    }
    if (on('creative', 'width')) add('width', 'stereoExpander', { centerPan: 0, width: Math.max(0, Math.min(300, Math.round(s.creative.items.width.amount))), gain: 0 });
  }
  if (s.pan?.on && s.pan.value) add('pan', 'stereoExpander', { centerPan: Math.max(-100, Math.min(100, Math.round(s.pan.value))), width: 100, gain: 0 });
  if (loudness) {
    const g = loudnessGain(s);
    if (g) add('loudness', 'amplify', { left: g, right: g, linked: true });
  }
  if (volume && s.volume?.level) {
    const v = Math.max(-60, Math.min(30, s.volume.level));
    add('volume', 'amplify', { left: v, right: v, linked: true });
  }
  return out;
}

/** Rack-style slots ({ id, effect, values, enabled }) for clip.fx. */
export function chainSlots(s, o) {
  return assistantChain(s, o).map((e) => ({ id: `sa-${e.id}`, effect: e.effect, values: e.values, enabled: true }));
}

/** Stretch percentage that turns `frames` into the target duration (null when off or invalid). */
export function durationStretch(s, frames, rate) {
  const d = s?.duration;
  if (!d?.on || !(d.seconds > 0) || !(frames > 0)) return null;
  const pct = ((d.seconds * rate) / frames) * 100;
  if (Math.abs(pct - 100) < 0.05) return null;
  return Math.max(10, Math.min(1000, Math.round(pct * 10) / 10));
}

// ---------------------------------------------------------------- ducking

/**
 * Volume envelope keyframes (dB, clip-relative frames) that lower a clip
 * under trigger ranges.
 *   clip      { start, length } in timeline frames
 *   triggers  [[start, end)] timeline ranges of the audio to duck under
 *   sensitivity 1..10: pauses shorter than sensitivity * 0.25 s keep the clip down
 *   reduce    dB to lower by (negative)
 *   fade      ramp time in ms on each side of a ducked region
 * Returns [] when nothing overlaps (the clip plays at its normal level).
 */
export function duckingKeyframes({ clip, triggers, sensitivity = 6, reduce = -18, fade = 800, rate }) {
  const cs = clip.start;
  const ce = clip.start + clip.length;
  const ramp = Math.max(0, Math.round((fade * rate) / 1000));
  const bridge = Math.max(2 * ramp, Math.round(Math.max(0, Math.min(10, sensitivity)) * 0.25 * rate));
  const depth = Math.min(0, reduce);
  if (!depth) return [];
  const list = triggers
    .map(([a, b]) => [Math.round(a), Math.round(b)])
    .filter(([a, b]) => b > a && b + ramp > cs && a - ramp < ce)
    .sort((x, y) => x[0] - y[0]);
  const regions = [];
  for (const [a, b] of list) {
    const last = regions[regions.length - 1];
    if (last && a - last[1] <= bridge) last[1] = Math.max(last[1], b);
    else regions.push([a, b]);
  }
  if (!regions.length) return [];
  // Timeline breakpoints of the full envelope (0 dB outside the ramps).
  const pts = [];
  for (const [a, b] of regions) pts.push({ t: a - ramp, v: 0 }, { t: a, v: depth }, { t: b, v: depth }, { t: b + ramp, v: 0 });
  const at = (t) => {
    if (t <= pts[0].t || t >= pts[pts.length - 1].t) return 0;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const p = pts[i - 1];
        const q = pts[i];
        return q.t === p.t ? q.v : p.v + ((q.v - p.v) * (t - p.t)) / (q.t - p.t);
      }
    }
    return 0;
  };
  const out = [{ t: 0, v: r1(at(cs)) }];
  for (const p of pts) if (p.t > cs && p.t < ce) out.push({ t: p.t - cs, v: p.v });
  out.push({ t: clip.length, v: r1(at(ce)) });
  // Drop exact duplicates in time (keep the later value) and flat interior runs.
  const dedup = [];
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1].t === p.t) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup.filter((p, i, a) => i === 0 || i === a.length - 1 || !(a[i - 1].v === p.v && a[i + 1].v === p.v));
}

/** Timeline ranges of clips whose audio type is in `against`, other than `except`. */
export function duckTriggers(clips, against, except = null) {
  const set = new Set(against || []);
  return clips.filter((c) => c.id !== except && !c.mute && c.soundAssistant && set.has(c.soundAssistant.type)).map((c) => [c.start, c.start + c.length]);
}
