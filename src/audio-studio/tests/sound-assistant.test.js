// Sound Assistant: settings, presets, chain mapping, ducking keyframes and
// the session / file operations.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { getEffect } from '../src/effects/registry.js';
import { normalizeValues } from '../src/effects/params.js';
import { isRealtime } from '../src/effects/apply.js';
import { Channel } from '../src/audio/channel.js';
import { Session } from '../src/model/session.js';
import { createClip, addClips, findClip } from '../src/model/session-edits.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import {
  TYPES,
  TYPE_IDS,
  defaultSettings,
  normalizeSettings,
  assistantChain,
  chainSlots,
  setPath,
  presetsFor,
  BUILT_IN_PRESETS,
  applyPreset,
  saveUserPreset,
  deleteUserPreset,
  loudnessGain,
  durationStretch,
  duckingKeyframes,
  duckTriggers,
  mergeSettings,
} from '../src/sound-assistant/model.js';
import * as ops from '../src/sound-assistant/ops.js';

const RATE = 48000;
const on = (type, patch) => normalizeSettings(mergeSettings(defaultSettings(type), patch));

describe('settings and presets', () => {
  it('has the tasks of each audio type', () => {
    expect(TYPE_IDS).toEqual(['dialogue', 'music', 'sfx', 'ambience']);
    expect(Object.keys(defaultSettings('dialogue'))).toEqual(expect.arrayContaining(['loudness', 'repair', 'clarity', 'creative', 'volume']));
    expect(defaultSettings('music')).toHaveProperty('ducking');
    expect(defaultSettings('music')).toHaveProperty('duration');
    expect(defaultSettings('music')).not.toHaveProperty('repair');
    expect(defaultSettings('sfx')).toHaveProperty('pan');
    expect(defaultSettings('ambience').creative.items).toHaveProperty('width');
    expect(() => defaultSettings('speech')).toThrow();
  });

  it('normalizes partial or stale settings', () => {
    const s = normalizeSettings({ type: 'sfx', loudness: { on: true }, repair: { on: true } });
    expect(s.loudness).toMatchObject({ on: true, target: -21 });
    expect(s).not.toHaveProperty('repair');
    expect(normalizeSettings({ type: 'nope' })).toBe(null);
    expect(normalizeSettings(null)).toBe(null);
  });

  it('ships valid presets for every type', () => {
    for (const type of TYPE_IDS) expect(presetsFor(type).length).toBeGreaterThanOrEqual(3);
    for (const p of BUILT_IN_PRESETS) {
      expect(normalizeSettings(p.settings).type).toBe(p.type);
      expect(() => assistantChain(p.settings)).not.toThrow();
    }
  });

  it('applies presets keeping per-clip measurements', () => {
    const cur = setPath(defaultSettings('dialogue'), ['loudness', 'measured'], -30);
    const p = presetsFor('dialogue').find((x) => x.name === 'Podcast Host');
    const next = applyPreset(cur, p);
    expect(next.preset).toBe('Podcast Host');
    expect(next.loudness).toMatchObject({ on: true, target: -16, measured: -30 });
    expect(loudnessGain(next)).toBe(14);
    // A different type starts unmeasured.
    expect(applyPreset(defaultSettings('music'), p).loudness.measured).toBe(null);
  });

  it('saves and deletes user presets without per-clip data', () => {
    const s = setPath(on('music', { ducking: { on: true } }), ['loudness', 'measured'], -20);
    let map = saveUserPreset({}, ' My Bed ', s);
    expect(map.music[0].name).toBe('My Bed');
    expect(map.music[0].settings.loudness.measured).toBe(null);
    expect(presetsFor('music', map).at(-1)).toMatchObject({ name: 'My Bed', user: true });
    expect(() => saveUserPreset(map, 'Hard Ducking', s)).toThrow(/built-in/);
    expect(() => saveUserPreset(map, '  ', s)).toThrow();
    map = deleteUserPreset(map, 'music', 'My Bed');
    expect(map.music).toBeUndefined();
  });
});

describe('chain mapping', () => {
  it('maps nothing when every task is off', () => {
    for (const type of TYPE_IDS) expect(assistantChain(defaultSettings(type))).toEqual([]);
  });

  it('maps dialogue repair and clarity to registry effects in processing order', () => {
    const s = on('dialogue', {
      repair: { on: true, items: { noise: { on: true, amount: 5 }, rumble: { on: true, amount: 10 }, hum: { on: true, amount: 5, freq: 50 }, ess: { on: true, amount: 5 }, reverb: { on: true, amount: 5 } } },
      clarity: { on: true, items: { dynamics: { on: true, amount: 5 }, eq: { on: true, preset: 'telephone', amount: 10 }, enhance: { on: true, voice: 'female' } } },
      creative: { on: true, items: { reverb: { on: true, preset: 'hall', amount: 5 } } },
    });
    const chain = assistantChain(s);
    expect(chain.map((e) => e.effect)).toEqual(['parametricEq', 'dehummer', 'denoise', 'dereverb', 'deesser', 'dynamics', 'parametricEq', 'vocalEnhancer', 'studioReverb']);
    const by = Object.fromEntries(chain.map((e) => [e.id, e.values]));
    expect(by.rumble).toMatchObject({ hpOn: true, hpFreq: 150, band1On: false });
    expect(by.hum.frequency).toBe(50);
    expect(by.noise.amount).toBe(50);
    expect(by.eq).toMatchObject({ hpOn: true, hpFreq: 400, lpOn: true, lpFreq: 3200, band3Gain: 6 });
    expect(by.enhance.mode).toBe(1);
    expect(by.reverb).toMatchObject({ dry: 100, wet: 35, decay: 2600 });
    // Every value is inside its parameter's range, and every effect plays in realtime.
    for (const e of chain) {
      const def = getEffect(e.effect);
      expect(isRealtime(def)).toBe(true);
      const full = normalizeValues(def, e.values);
      for (const [k, v] of Object.entries(e.values)) expect(full[k]).toEqual(v);
    }
  });

  it('skips items that are off, at zero, or in a disabled task', () => {
    const s = on('dialogue', { repair: { on: true, items: { noise: { on: true, amount: 0 }, rumble: { on: false } } }, clarity: { on: false, items: { dynamics: { on: true, amount: 8 } } } });
    expect(assistantChain(s)).toEqual([]);
  });

  it('scales the amount', () => {
    const lo = assistantChain(on('dialogue', { clarity: { on: true, items: { dynamics: { amount: 2 } } } }))[0].values;
    const hi = assistantChain(on('dialogue', { clarity: { on: true, items: { dynamics: { amount: 9 } } } }))[0].values;
    expect(hi.threshold).toBeLessThan(lo.threshold);
    expect(hi.ratio).toBeGreaterThan(lo.ratio);
  });

  it('adds pan, width, loudness and (for files) volume gain stages', () => {
    const sfx = setPath(on('sfx', { pan: { on: true, value: -40 }, loudness: { on: true, target: -20 } }), ['loudness', 'measured'], -26);
    const chain = assistantChain(setPath(sfx, ['volume', 'level'], -3), { volume: true });
    expect(chain.map((e) => e.id)).toEqual(['pan', 'loudness', 'volume']);
    expect(chain[0].values.centerPan).toBe(-40);
    expect(chain[1].values).toMatchObject({ left: 6, right: 6 });
    expect(chain[2].values).toMatchObject({ left: -3 });
    expect(assistantChain(sfx, { loudness: false }).map((e) => e.id)).toEqual(['pan']);
    const amb = on('ambience', { creative: { on: true, items: { reverb: { on: false }, width: { on: true, amount: 180 } } } });
    expect(assistantChain(amb)).toEqual([{ id: 'width', effect: 'stereoExpander', values: { centerPan: 0, width: 180, gain: 0 } }]);
  });

  it('gives slots stable ids so playback keeps effect state while sliders move', () => {
    const a = chainSlots(on('dialogue', { repair: { on: true, items: { noise: { amount: 3 } } } }));
    const b = chainSlots(on('dialogue', { repair: { on: true, items: { noise: { amount: 7 } } } }));
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(a[0]).toMatchObject({ effect: 'parametricEq', enabled: true });
  });

  it('computes the loudness gain and the duration stretch', () => {
    const s = setPath(on('music', { loudness: { on: true, target: -16 } }), ['loudness', 'measured'], -24.04);
    expect(loudnessGain(s)).toBe(8);
    expect(loudnessGain(setPath(s, ['loudness', 'on'], false))).toBe(0);
    expect(loudnessGain(setPath(s, ['loudness', 'measured'], null))).toBe(0);
    const d = on('music', { duration: { on: true, seconds: 30 } });
    expect(durationStretch(d, 20 * RATE, RATE)).toBe(150);
    expect(durationStretch(on('music', { duration: { on: true, seconds: 20 } }), 20 * RATE, RATE)).toBe(null);
    expect(durationStretch(defaultSettings('music'), 20 * RATE, RATE)).toBe(null);
  });
});

describe('ducking keyframes', () => {
  const clip = { start: 0, length: 20 * RATE };
  const s = (x) => Math.round(x * RATE);

  it('lowers the clip under each trigger with ramps', () => {
    const k = duckingKeyframes({ clip, triggers: [[s(5), s(8)]], sensitivity: 1, reduce: -15, fade: 500, rate: RATE });
    expect(k).toEqual([
      { t: 0, v: 0 },
      { t: s(4.5), v: 0 },
      { t: s(5), v: -15 },
      { t: s(8), v: -15 },
      { t: s(8.5), v: 0 },
      { t: s(20), v: 0 },
    ]);
  });

  it('bridges short pauses based on sensitivity', () => {
    const triggers = [[s(2), s(4)], [s(5), s(7)]];
    const keep = duckingKeyframes({ clip, triggers, sensitivity: 8, reduce: -12, fade: 200, rate: RATE }); // bridges up to 2 s
    expect(keep.filter((p) => p.v === 0 && p.t > 0 && p.t < s(20))).toHaveLength(2);
    const split = duckingKeyframes({ clip, triggers, sensitivity: 1, reduce: -12, fade: 200, rate: RATE }); // bridges up to 0.4 s
    expect(split.filter((p) => p.v === -12)).toHaveLength(4);
  });

  it('clips keyframes to the clip and handles triggers at its edges', () => {
    const k = duckingKeyframes({ clip: { start: s(10), length: s(5) }, triggers: [[s(8), s(11)], [s(14), s(30)]], sensitivity: 1, reduce: -20, fade: 1000, rate: RATE });
    expect(k[0]).toEqual({ t: 0, v: -20 });
    expect(k.at(-1)).toEqual({ t: s(5), v: -20 });
    expect(k.every((p) => p.t >= 0 && p.t <= s(5))).toBe(true);
    expect(k.find((p) => p.t === s(2))).toEqual({ t: s(2), v: 0 });
  });

  it('returns no keyframes without overlapping triggers or reduction', () => {
    expect(duckingKeyframes({ clip, triggers: [[s(30), s(40)]], reduce: -10, fade: 100, rate: RATE })).toEqual([]);
    expect(duckingKeyframes({ clip, triggers: [[s(1), s(2)]], reduce: 0, fade: 100, rate: RATE })).toEqual([]);
  });

  it('collects triggers from clips of the chosen types', () => {
    const clips = [
      { id: 'a', start: 10, length: 5, soundAssistant: { type: 'dialogue' } },
      { id: 'b', start: 30, length: 5, soundAssistant: { type: 'sfx' } },
      { id: 'c', start: 50, length: 5, soundAssistant: { type: 'dialogue' }, mute: true },
      { id: 'd', start: 70, length: 5, soundAssistant: null },
    ];
    expect(duckTriggers(clips, ['dialogue'])).toEqual([[10, 15]]);
    expect(duckTriggers(clips, ['dialogue', 'sfx'], 'a')).toEqual([[30, 35]]);
  });
});

// ------------------------------------------------------------------ ops

function makeSession() {
  const session = new Session({ name: 'T.asesx', sampleRate: RATE, tracks: 2 });
  const [t1, t2] = session.state.tracks;
  const voice = Channel.fromSamples(new Float32Array(4 * RATE).fill(0.1));
  const music = Channel.fromSamples(new Float32Array(20 * RATE).fill(0.05));
  const vs = session.addSource({ name: 'voice', channels: [voice] });
  const ms = session.addSource({ name: 'music', channels: [music, music] });
  const v = createClip({ trackId: t1.id, sourceId: vs, start: 5 * RATE, length: 4 * RATE, name: 'voice' });
  const m = createClip({ trackId: t2.id, sourceId: ms, start: 0, length: 20 * RATE, name: 'music', gain: -2 });
  session.apply('Add', addClips(session.state, [v, m]));
  return { session, v: v.id, m: m.id };
}

describe('session operations', () => {
  it('assigns and clears audio types, keeping the clip volume', () => {
    const { session, v, m } = makeSession();
    let state = ops.assignType(session.state, [m], 'music');
    const c = findClip(state, m);
    expect(c.soundAssistant.type).toBe('music');
    expect(ops.clipSettings(c).volume).toEqual({ level: -2, mute: false });
    expect(c.fx).toEqual([]);
    state = ops.clearType(state, [m]);
    expect(findClip(state, m).soundAssistant).toBe(null);
    expect(findClip(state, v).soundAssistant).toBe(null);
  });

  it('edits clips of one type, stores the chain in clip.fx and renders it per clip', () => {
    const { session, v, m } = makeSession();
    let state = ops.assignType(session.state, [v, m], 'dialogue');
    state = ops.editClips(state, [v, m], 'dialogue', ['clarity', 'on'], true);
    for (const id of [v, m]) expect(findClip(state, id).fx.map((s) => s.effect)).toEqual(['dynamics']);
    expect(findClip(state, v).soundAssistant.preset).toBe('');
    state = ops.editClips(state, [v], 'dialogue', ['volume', 'level'], -6);
    expect(findClip(state, v).gain).toBe(-6);
    expect(findClip(state, m).gain).toBe(-2);
    // Settings of another type are left alone.
    expect(ops.editClips(state, [v], 'music', ['clarity', 'on'], false)).toBe(state);
    const { graph } = buildSessionGraph(state, session.pool);
    const gv = graph.tracks[0].clips[0];
    expect(gv.fx[0].key).toBe(`clip:${v}:sa-dynamics`);
  });

  it('compensates clip chain latency in the session graph', () => {
    const { session, v } = makeSession();
    let state = ops.assignType(session.state, [v], 'dialogue');
    state = ops.editClips(state, [v], 'dialogue', ['repair', 'on'], true); // rumble EQ + DeNoise (2048 latency)
    const { graph } = buildSessionGraph(state, session.pool);
    const gc = graph.tracks[0].clips[0];
    expect(gc.start).toBe(5 * RATE - 2048);
    expect(gc.offset).toBe(0);
    expect(gc.base).toBe(0);
    expect(gc.fxTail).toBeGreaterThanOrEqual(2048);
  });

  it('generates and clears ducking keyframes', () => {
    const { session, v, m } = makeSession();
    let state = ops.assignType(session.state, [v], 'dialogue');
    state = ops.assignType(state, [m], 'music');
    state = ops.editClips(state, [m], 'music', ['ducking', 'on'], true);
    const env = findClip(state, m).volumeEnv;
    expect(env.some((p) => p.v === -18)).toBe(true);
    expect(env.find((p) => p.v === -18).t).toBe(5 * RATE);
    expect(findClip(state, m).soundAssistant.ducking.generated).toBe(true);
    // Moving the voice and regenerating follows it.
    const moved = { ...state, clips: state.clips.map((c) => (c.id === v ? { ...c, start: 10 * RATE } : c)) };
    expect(ops.regenerateDucking(moved).clips.find((c) => c.id === m).volumeEnv.find((p) => p.v === -18).t).toBe(10 * RATE);
    state = ops.editClips(state, [m], 'music', ['ducking', 'on'], false);
    expect(findClip(state, m).volumeEnv).toEqual([]);
  });

  it('auto-matches loudness through the clip chain', async () => {
    const { session, v } = makeSession();
    session.apply('Type', ops.assignType(session.state, [v], 'dialogue'));
    session.apply('Loud', ops.editClips(session.state, [v], 'dialogue', ['loudness', 'target'], -16));
    const calls = [];
    const applyChain = async (channels, rate, specs, o) => {
      calls.push({ specs: specs.length, start: o.start, end: o.end });
      return channels.map((c) => c.toArray(o.start, o.end));
    };
    const measure = async ({ channels }) => ({ integrated: channels[0].length === 4 * RATE ? -30 : NaN });
    session.apply('Rep', ops.editClips(session.state, [v], 'dialogue', ['repair', 'on'], true));
    const r = await ops.autoMatchClips(session, [v], { applyChain, measure });
    expect(calls).toEqual([{ specs: 2, start: 0, end: 4 * RATE }]);
    const c = findClip(r.state, v);
    expect(c.soundAssistant.loudness).toMatchObject({ on: true, measured: -30 });
    expect(c.fx.at(-1)).toMatchObject({ effect: 'amplify', values: { left: 14, right: 14 } });
  });

  it('stretches a clip to its duration and restores it', async () => {
    const { session, m } = makeSession();
    session.apply('Type', ops.assignType(session.state, [m], 'music'));
    session.apply('Dur', ops.editClips(session.state, [m], 'music', ['duration'], { on: true, seconds: 10, orig: null }));
    const stretched = await ops.applyDurationClips(session, [m]);
    const c = findClip(stretched, m);
    expect(Math.abs(c.length - 10 * RATE)).toBeLessThan(RATE * 0.05);
    expect(c.sourceId).not.toBe(findClip(session.state, m).sourceId);
    expect(c.soundAssistant.duration.orig).toEqual({ sourceId: findClip(session.state, m).sourceId, offset: 0, length: 20 * RATE });
    session.apply('Stretch', stretched);
    session.apply('Off', ops.editClips(session.state, [m], 'music', ['duration', 'on'], false));
    const restored = findClip(await ops.applyDurationClips(session, [m]), m);
    expect(restored.length).toBe(20 * RATE);
    expect(restored.soundAssistant.duration.orig).toBe(null);
  }, 60000);
});

describe('file operations', () => {
  it('keeps per-file settings and builds preview specs', () => {
    const doc = {};
    expect(ops.getFileSettings(doc)).toBe(null);
    ops.setFileSettings(doc, on('sfx', { pan: { on: true, value: 30 } }));
    expect(ops.getFileSettings(doc).pan.value).toBe(30);
    const specs = ops.filePreviewSpecs(ops.getFileSettings(doc), RATE);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ key: 'assistant:pan', kind: getEffect('stereoExpander').kind });
    ops.setFileSettings(doc, null);
    expect(ops.getFileSettings(doc)).toBe(null);
  });

  it('renders chain, loudness and volume as one new state', async () => {
    const n = RATE;
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(n).fill(0.1))], markers: [] };
    const settings = setPath(on('dialogue', { loudness: { on: true, target: -20 }, clarity: { on: true } }), ['volume', 'level'], -6);
    const applyChain = async (channels, rate, specs, o) => {
      expect(specs.map((s) => s.kind)).toEqual([getEffect('dynamics').kind]);
      return channels.map((c) => {
        const x = c.toArray(o.start, o.end);
        for (let i = 0; i < x.length; i++) x[i] *= 2;
        return x;
      });
    };
    const measure = async () => ({ integrated: -26 });
    const r = await ops.renderFile({ settings, state, start: 0, end: n, applyChain, measure });
    // x2 from the chain, then +6 dB loudness and -6 dB volume cancel.
    expect(r.length).toBe(n);
    expect(r.state.channels[0].toArray(10, 11)[0]).toBeCloseTo(0.2, 4);
    expect(state.channels[0].toArray(10, 11)[0]).toBeCloseTo(0.1, 6);
  });

  it('applies the loudness and volume gain to an effect tail past the selection too', async () => {
    const n = RATE;
    // A selection over the first second; silence after it.
    const x = new Float32Array(2 * n);
    x.fill(0.1, 0, n);
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(x)], markers: [] };
    const settings = setPath(on('dialogue', { loudness: { on: true, target: -20 }, creative: { on: true } }), ['volume', 'level'], -2);
    let tail = 0;
    const applyChain = async (channels, rate, specs, o) => {
      tail = o.tail;
      // The body passes through; the tail is a steady 0.05 decay stand-in.
      return channels.map((c) => {
        const out = new Float32Array(o.end - o.start + o.tail).fill(0.05);
        out.set(c.toArray(o.start, o.end));
        return out;
      });
    };
    const measure = async () => ({ integrated: -26 });
    const r = await ops.renderFile({ settings, state, start: 0, end: n, applyChain, measure });
    expect(tail).toBeGreaterThan(10);
    const g = Math.pow(10, 4 / 20);
    const y = r.state.channels[0];
    expect(y.toArray(10, 11)[0]).toBeCloseTo(0.1 * g, 4);
    // The tail continues at the same gain as the processed selection.
    expect(y.toArray(n + 5, n + 6)[0]).toBeCloseTo(0.05 * g, 4);
    expect(y.toArray(n + tail + 5, n + tail + 6)[0]).toBe(0);
  });
});
