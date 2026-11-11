// Diagnostics: detection lists from the Rust and JS kernels, and the repair,
// delete and mark actions.
import { describe, it, expect, beforeAll } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { getEffect } from '../src/effects/registry.js';
import { normalizeValues } from '../src/effects/params.js';
import { Channel } from '../src/audio/channel.js';
import { setDiagnosticsWorker, scanProblems, mergeRuns, repairClicks, repairClips, deleteSilences, shiftProblems, markAudio, markProblems, silenceCut, holdDb } from '../src/diagnostics/scan.js';
import { clickSettings } from '../src/diagnostics/kernels.js';

const RATE = 48000;
const vals = (id, v = {}) => normalizeValues(getEffect(id), v);

function music(n) {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  return Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / RATE) + 0.15 * Math.sin((2 * Math.PI * 1210 * i) / RATE) + 0.02 * rnd());
}

function withClicks(x, at) {
  const y = x.slice();
  for (const i of at) {
    y[i] += 0.6;
    y[i + 1] -= 0.4;
    y[i + 2] += 0.3;
  }
  return y;
}

const stateOf = (chans) => ({ sampleRate: RATE, channels: chans.map((c) => Channel.fromSamples(c)), markers: [], meta: {} });

beforeAll(() => setDiagnosticsWorker(null));

describe('detection', () => {
  it('maps DeClicker settings like the effect does', () => {
    const s = clickSettings(vals('declicker', { sensitivity: 60, discrimination: 30, runSize: 32, bigPops: true, oversample: 50, passes: 2 }));
    expect(s.k).toBeCloseTo(8);
    expect(s.disc).toBeCloseTo(10.4);
    expect(s.maxRun).toBe(128);
    expect(s.oversample).toBe(0.5);
  });

  it('lists clicks with their channel and strength, merging channels', async () => {
    const n = RATE;
    const clean = music(n);
    const left = withClicks(clean, [6000, 20000, 33000]);
    const right = withClicks(clean, [20000]);
    const { problems } = await scanProblems({ effect: 'declicker', values: vals('declicker'), channels: stateOf([left, right]).channels, rate: RATE, start: 0, end: n });
    expect(problems.length).toBe(3);
    expect(problems.map((p) => p.channels)).toEqual([[0], [0, 1], [0]]);
    for (const [p, at] of problems.map((p, i) => [p, [6000, 20000, 33000][i]])) {
      expect(p.start).toBeLessThanOrEqual(at);
      expect(p.end).toBeGreaterThan(at);
      expect(p.kind).toBe('click');
      expect(p.level).toBeGreaterThan(1);
    }
    const none = await scanProblems({ effect: 'declicker', values: vals('declicker'), channels: stateOf([clean]).channels, rate: RATE, start: 0, end: n });
    expect(none.problems).toEqual([]);
  });

  it('skips channels disabled for editing', async () => {
    const n = RATE;
    const clean = music(n);
    const left = withClicks(clean, [6000, 20000]);
    const right = withClicks(clean, [20000, 40000]);
    const channels = stateOf([left, right]).channels;
    const { problems } = await scanProblems({ effect: 'declicker', values: vals('declicker'), channels, rate: RATE, start: 0, end: n, mask: [false, true] });
    expect(problems.map((p) => p.channels)).toEqual([[1], [1]]);
    // DeClipper: the clip level comes from the enabled channel, and its gain leaves the other alone.
    const loud = Float32Array.from({ length: 4800 }, (_, i) => Math.max(-1, Math.min(1, 1.3 * Math.sin((2 * Math.PI * 150 * i) / RATE))));
    const soft = loud.map((v) => Math.max(-0.5, Math.min(0.5, v)));
    const st = stateOf([loud, soft]);
    const values = vals('declipper', { gain: -6, tolerance: 0.1, minRun: 3 });
    const scan = await scanProblems({ effect: 'declipper', values, channels: st.channels, rate: RATE, start: 0, end: 4800, mask: [false, true] });
    expect(scan.info.level).toBeCloseTo(0.5 * 0.999, 3);
    expect(scan.problems.length).toBeGreaterThan(5);
    expect(scan.problems.every((p) => p.channels.join() === '1')).toBe(true);
    const next = await repairClips(st, scan.problems, values, scan.info.level, [0, 4800], { mask: [false, true] });
    expect(next.channels[0]).toBe(st.channels[0]);
    expect(next.channels[1]).not.toBe(st.channels[1]);
  });

  it('scans only the requested range and keeps file positions', async () => {
    const left = withClicks(music(RATE), [6000, 30000]);
    const { problems } = await scanProblems({ effect: 'declicker', values: vals('declicker'), channels: stateOf([left]).channels, rate: RATE, start: 20000, end: RATE });
    expect(problems).toHaveLength(1);
    expect(problems[0].start).toBeGreaterThan(29900);
  });

  it('lists clipped runs at the clip level', async () => {
    const x = Float32Array.from({ length: 9600 }, (_, i) => Math.max(-0.8, Math.min(0.8, 1.2 * Math.sin((2 * Math.PI * 100 * i) / RATE))));
    const { problems, info } = await scanProblems({ effect: 'declipper', values: vals('declipper', { minRun: 3, tolerance: 1 }), channels: stateOf([x]).channels, rate: RATE, start: 0, end: x.length });
    expect(info.level).toBeCloseTo(0.8 * 0.99, 3);
    expect(problems.length).toBe(40); // 20 cycles, a clipped top and bottom each
    expect(problems[0].level).toBeCloseTo(20 * Math.log10(info.level), 3);
    expect(problems.every((p) => p.end - p.start >= 3)).toBe(true);
  });

  it('lists silences and audio regions', async () => {
    const n = 4 * RATE;
    const x = new Float32Array(n);
    for (let i = RATE; i < 2 * RATE; i++) x[i] = 0.5 * Math.sin(i / 10);
    for (let i = 3 * RATE; i < 3.3 * RATE; i++) x[i] = 0.5 * Math.sin(i / 10);
    const chans = stateOf([x]).channels;
    const sil = await scanProblems({ effect: 'deleteSilence', values: vals('deleteSilence'), channels: chans, rate: RATE, start: 0, end: n });
    expect(sil.problems.map((p) => p.kind)).toEqual(['silence', 'silence', 'silence']);
    expect(Math.abs(sil.problems[0].start)).toBe(0);
    expect(Math.abs(sil.problems[0].end - RATE)).toBeLessThan(RATE * 0.02);
    expect(sil.problems.at(-1).end).toBe(n);
    expect(sil.problems[0].level).toBeLessThan(-90);
    // Digital silence reads as -Infinity, not the -200 dB detection floor.
    expect(sil.problems[0].level).toBe(-Infinity);
    const aud = await scanProblems({ effect: 'markAudio', values: vals('markAudio', { padding: 0 }), channels: chans, rate: RATE, start: 0, end: n });
    expect(aud.problems).toHaveLength(2);
    expect(Math.abs(aud.problems[1].start - 3 * RATE)).toBeLessThan(RATE * 0.02);
    expect(aud.problems[0].level).toBeGreaterThan(-7);
  });

  it('merges overlapping runs and holds levels', () => {
    const m = mergeRuns([{ start: 10, end: 20, channel: 1, level: 3 }, { start: 15, end: 25, channel: 0, level: 5 }, { start: 40, end: 41, channel: 0, level: 1 }], 'click');
    expect(m).toEqual([
      { id: 'click1', start: 10, end: 25, channels: [0, 1], level: 5, kind: 'click' },
      { id: 'click2', start: 40, end: 41, channels: [0], level: 1, kind: 'click' },
    ]);
    const db = holdDb(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0]));
    expect([...db].map((v) => Math.round(v))).toEqual([-200, 0, 0, 0, 0, 0, -200, -200]);
  });
});

describe('actions', () => {
  it('repairs only the chosen clicks, as one new state', async () => {
    const clean = music(RATE);
    const clicky = withClicks(clean, [6000, 20000]);
    const state = stateOf([clicky]);
    const values = vals('declicker');
    const { problems } = await scanProblems({ effect: 'declicker', values, channels: state.channels, rate: RATE, start: 0, end: RATE });
    const next = await repairClicks(state, [problems[0]], values);
    const y = next.channels[0].toArray();
    const err = (a, b) => {
      let e = 0;
      for (let i = a; i < b; i++) e += (y[i] - clean[i]) ** 2;
      return e;
    };
    const before = (a, b) => {
      let e = 0;
      for (let i = a; i < b; i++) e += (clicky[i] - clean[i]) ** 2;
      return e;
    };
    expect(err(5900, 6100)).toBeLessThan(before(5900, 6100) * 0.1);
    expect(err(19900, 20100)).toBeCloseTo(before(19900, 20100), 6); // not chosen, untouched
    expect(state.channels[0].toArray(6000, 6001)[0]).toBeCloseTo(clicky[6000]); // input unchanged
  });

  it('restores clipped peaks and applies the gain to the scanned range', async () => {
    const orig = Float32Array.from({ length: 4800 }, (_, i) => 1.3 * Math.sin((2 * Math.PI * 150 * i) / RATE));
    const clipped = orig.map((v) => Math.max(-1, Math.min(1, v)));
    const state = stateOf([clipped]);
    const values = vals('declipper', { gain: -6, tolerance: 0.1, minRun: 3 });
    const { problems, info } = await scanProblems({ effect: 'declipper', values, channels: state.channels, rate: RATE, start: 0, end: 4800 });
    expect(problems.length).toBeGreaterThan(5);
    const next = await repairClips(state, problems, values, info.level, [0, 4800]);
    const y = next.channels[0].toArray();
    const peak = Math.max(...y.map(Math.abs));
    expect(peak).toBeGreaterThan(1.1 * 10 ** (-6 / 20));
    expect(peak).toBeLessThan(1.35 * 10 ** (-6 / 20));
  });

  it('deletes silences down to the keep time and shifts the rest of the list', () => {
    const n = 10 * RATE;
    const state = { ...stateOf([new Float32Array(n)]), markers: [{ id: 'm', name: 'M', start: 8 * RATE, duration: 0, type: 'cue' }] };
    const problems = [
      { id: 's1', start: 0, end: RATE, channels: [0] },
      { id: 's2', start: 3 * RATE, end: 5 * RATE, channels: [0] },
      { id: 's3', start: 7 * RATE, end: 7.5 * RATE, channels: [0] },
    ];
    expect(silenceCut(problems[1], 0.2 * RATE, n)).toEqual([148800, 235200]);
    const { state: next, removed } = deleteSilences(state, problems.slice(0, 2), 200);
    expect(next.channels[0].length).toBe(n - 43200 - 86400);
    expect(removed).toEqual([[0, 43200], [148800, 235200]]); // the file start keeps half the keep time before the audio
    expect(next.markers[0].start).toBe(8 * RATE - 129600);
    expect(shiftProblems(problems, removed, ['s1', 's2'])).toEqual([{ id: 's3', start: 7 * RATE - 129600, end: 7.5 * RATE - 129600, channels: [0] }]);
  });

  it('marks audio regions as range markers', () => {
    const state = stateOf([new Float32Array(1000)]);
    const next = markAudio(state, [{ start: 100, end: 300 }, { start: 500, end: 900 }]);
    expect(next.markers.map((m) => [m.start, m.duration, m.name])).toEqual([[100, 200, 'Audio 01'], [500, 400, 'Audio 02']]);
  });
});

describe('marking any diagnostic', () => {
  it('names markers after what was found', () => {
    const state = stateOf([new Float32Array(1000)]);
    const next = markProblems(state, [{ start: 10, end: 10 }, { start: 500, end: 520 }], 'Click');
    expect(next.markers.map((m) => [m.start, m.duration, m.name])).toEqual([[10, 1, 'Click 01'], [500, 20, 'Click 02']]);
  });

  it('marks DeClicker results from the panel without repairing them', async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { diagnosticsPanel } = await import('../src/diagnostics/panel.js');
    localStorage.clear();
    const app = new App();
    installCore(app);
    const x = withClicks(music(RATE), [10000, 30000]);
    const doc = new AudioFile({ name: 'c.wav', sampleRate: RATE, channels: [Channel.fromSamples(x)] });
    app.addDocument(doc);
    const p = diagnosticsPanel(app);
    p.select('declicker');
    const button = (re) => [...p.el.querySelectorAll('button')].find((b) => re.test(b.textContent));
    button(/^Scan File$/).click();
    await expect.poll(() => button(/^Mark All$/)?.disabled, { timeout: 5000 }).toBe(false);
    const before = doc.state.channels[0];
    button(/^Mark All$/).click();
    expect(doc.state.markers.length).toBeGreaterThanOrEqual(2);
    expect(doc.state.markers[0].name).toMatch(/^Click 01$/);
    expect(doc.state.channels[0]).toBe(before);
  });

  it('repairs only enabled channels from the panel', async () => {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { diagnosticsPanel } = await import('../src/diagnostics/panel.js');
    localStorage.clear();
    const app = new App();
    installCore(app);
    const x = withClicks(music(RATE), [10000, 30000]);
    const doc = new AudioFile({ name: 'c.wav', sampleRate: RATE, channels: [Channel.fromSamples(x), Channel.fromSamples(x.slice())] });
    app.addDocument(doc);
    doc.setSelection(0, 0, { channels: [true, false] });
    const p = diagnosticsPanel(app);
    p.select('declicker');
    const button = (re) => [...p.el.querySelectorAll('button')].find((b) => re.test(b.textContent));
    button(/^Scan File$/).click();
    await expect.poll(() => button(/^Repair All$/)?.disabled, { timeout: 5000 }).toBe(false);
    const right = doc.state.channels[1];
    button(/^Repair All$/).click();
    await expect.poll(() => p.el.querySelector('.diag-caption').textContent, { timeout: 5000 }).toMatch(/done/);
    expect(doc.state.channels[1]).toBe(right);
    expect(doc.state.channels[0].toArray(10000, 10001)[0]).not.toBeCloseTo(x[10000], 3);
  });
});
