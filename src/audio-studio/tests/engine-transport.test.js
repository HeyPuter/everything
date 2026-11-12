import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';

/** An engine wired to a fake worklet port that records what it is sent. */
function fakeEngine() {
  const e = new Engine();
  const sent = [];
  e.ctx = { currentTime: 1, outputLatency: 0, baseLatency: 0, state: 'running', sampleRate: 48000 };
  e.requestedRate = 48000;
  e.node = { port: { postMessage: vi.fn((m) => sent.push(m)) } };
  return { e, sent };
}

describe('engine transport', () => {
  it('seeks and plays on whole frames, so the mixer never reads NaN samples', async () => {
    const { e, sent } = fakeEngine();
    e.state = 'playing';
    e.lastPos = { frame: 1000, time: 0.99 };
    // The interpolated position is fractional (the loudness meter reset seeks to it).
    expect(Number.isInteger(e.position)).toBe(false);
    e.seek(e.position);
    const seek = sent.find((m) => m.type === 'seek');
    expect(Number.isInteger(seek.frame)).toBe(true);
    await e.play({ from: 10.6, to: 99.2, loop: { start: 0.4, end: 50.5 } });
    const play = sent.find((m) => m.type === 'play');
    expect(play).toMatchObject({ from: 11, to: 99, loop: { start: 0, end: 51 } });
    // What the mixer renders from that seek is real audio.
    const store = new ChunkStore();
    store.put('a', 0, [new Float32Array(32768).fill(0.5)]);
    const graph = {
      rate: 48000,
      master: { gain: 1 },
      tracks: [
        {
          id: 1,
          gain: 1,
          pan: 0,
          clips: [
            { id: 'c', source: 'a', channels: 1, start: 0, offset: 0, length: 32768, gain: 1 },
          ],
        },
      ],
    };
    const out = [new Float32Array(128), new Float32Array(128)];
    renderBlock(graph, store, seek.frame, 128, out, createScratch());
    expect(out[0][0]).toBe(0.5);
    e.stop();
  });

  it('loop playback follows the selection, and loops the whole file once it is cleared', async () => {
    HTMLCanvasElement.prototype.getContext = () => null;
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { engine } = await import('../src/engine/engine.js');
    const app = new App();
    app.syncGraph = () => {};
    const doc = AudioFile.blank({ name: 'Loop.wav', sampleRate: 48000, channels: 1, seconds: 2 });
    app.addDocument(doc);
    app.prefs.set('loop', true);
    const sent = [];
    Object.assign(engine, {
      ctx: { currentTime: 1, state: 'running', sampleRate: 48000 },
      requestedRate: 48000,
      node: { port: { postMessage: (m) => sent.push(m) } },
    });
    engine.graph = { rate: 48000, tracks: [], master: { gain: 1 } };
    doc.setSelection(1000, 5000);
    await app.play();
    expect(sent.find((m) => m.type === 'play').loop).toEqual({ start: 1000, end: 5000 });
    doc.setSelection(2000, 8000);
    expect(sent.filter((m) => m.type === 'loop').pop().loop).toEqual({ start: 2000, end: 8000 });
    // Cleared: the loop covers the whole file, as when loop playback starts without a selection.
    doc.setSelection(0, 0);
    expect(sent.filter((m) => m.type === 'loop').pop().loop).toEqual(app.loopRange(doc));
    expect(app.loopRange(doc)).toEqual({ start: 0, end: doc.length });
    // A loop that ends before the playhead: the playhead reads from the loop start.
    engine.lastPos = { frame: 9500, time: 1 };
    doc.setSelection(1000, 5000);
    expect(engine.position).toBe(1000);
    engine.stop();
    Object.assign(engine, { ctx: null, node: null });
    app.prefs.set('loop', false);
  });

  it('offline renders keep the chunks every playing clip of a shared source still reads', async () => {
    const { dropBehind } = await import('../src/engine/offline-worker.js');
    const { CHUNK } = await import('../src/engine/mixcore.js');
    const store = new ChunkStore();
    for (let i = 0; i < 6; i++) store.put('loop', i, [new Float32Array(CHUNK)]);
    store.put('gone', 0, [new Float32Array(CHUNK)]);
    const clip = (id, source, start, offset, length) => ({
      id,
      source,
      channels: 1,
      start,
      offset,
      length,
      gain: 1,
    });
    // Two clips of one source: the first ended long ago, the second plays from its start.
    const graph = {
      tracks: [
        {
          id: 't',
          clips: [
            clip('a', 'loop', 0, 0, CHUNK * 6),
            clip('b', 'loop', CHUNK * 10, 0, CHUNK * 6),
            clip('c', 'gone', 0, 0, CHUNK),
          ],
        },
      ],
    };
    dropBehind({ store }, graph, CHUNK * 10 + 100);
    expect([...store.sources.get('loop').keys()]).toEqual([0, 1]);
    expect(store.sources.get('gone').size).toBe(0);
  });

  it('applies a latency mode chosen during playback once playback stops', async () => {
    const { e } = fakeEngine();
    const made = [];
    vi.stubGlobal('AudioContext', function (opts) {
      made.push(opts.latencyHint);
      return { ...e.ctx, audioWorklet: { addModule: async () => {} }, destination: {}, resume: async () => {} };
    });
    vi.stubGlobal('AudioWorkletNode', function () {
      return { port: { postMessage() {} }, connect() {}, disconnect() {} };
    });
    e.ctx.close = async () => {};
    e.state = 'playing';
    e.setLatencyHint('playback');
    await e.ensure(48000);
    expect(made).toEqual([]); // not while playing
    e.stop();
    await e.ensure(48000);
    expect(made).toEqual(['playback']);
    await e.ensure(48000);
    expect(made).toEqual(['playback']);
    vi.unstubAllGlobals();
  });

  it('refuses to play when the audio context could not run at the audio rate', async () => {
    const { e, sent } = fakeEngine();
    // The browser fell back to its device rate (48 kHz) for 384 kHz audio.
    Object.assign(e.ctx, { sampleRate: 48000 });
    e.graph = { rate: 384000, tracks: [], master: { gain: 1 } };
    e.requestedRate = 384000;
    await expect(e.play({ from: 0 })).rejects.toThrow(
      "This browser can't play 384000 Hz audio. Convert its sample rate (Edit > Convert Sample Type) to play it.",
    );
    expect(sent.some((m) => m.type === 'play')).toBe(false);
    expect(e.playing).toBe(false);
    // At its own rate it plays.
    e.ctx.sampleRate = 48000;
    e.graph = { rate: 48000, tracks: [], master: { gain: 1 } };
    e.requestedRate = 48000;
    await e.play({ from: 0 });
    expect(e.playing).toBe(true);
    e.stop();
  });
});

describe('engine playhead and output latency', () => {
  let Processor = null;
  // An Engine wired to a real mixer worklet processor through fake Web Audio
  // nodes; `advance` renders quanta and moves both clocks forward.
  async function liveEngine(latency) {
    globalThis.sampleRate = 48000;
    globalThis.currentTime = 1;
    globalThis.AudioWorkletProcessor = class {
      constructor() {
        this.port = { postMessage() {}, onmessage: null };
      }
    };
    globalThis.registerProcessor = (name, cls) => (Processor = cls);
    await import('../src/engine/mixer-worklet.js');
    let proc = null;
    const ctx = {
      sampleRate: 48000,
      currentTime: 1,
      outputLatency: latency,
      baseLatency: 0,
      state: 'running',
      destination: { channelCount: 2, maxChannelCount: 2 },
      audioWorklet: { addModule: async () => {} },
      resume: async () => {},
      close: async () => {},
    };
    vi.stubGlobal('AudioContext', function () {
      return ctx;
    });
    vi.stubGlobal('AudioWorkletNode', function () {
      proc = new Processor();
      const node = { port: { onmessage: null }, connect() {}, disconnect() {} };
      node.port.postMessage = (m) => proc.port.onmessage({ data: m });
      proc.port.postMessage = (m) => node.port.onmessage?.({ data: m });
      return node;
    });
    const e = new Engine();
    await e.ensure(48000);
    const out = [new Float32Array(128), new Float32Array(128)];
    const advance = (seconds) => {
      for (let i = 0; i < Math.round((seconds * 48000) / 128); i++) {
        proc.process([], [out]);
        globalThis.currentTime += 128 / 48000;
        ctx.currentTime = globalThis.currentTime;
      }
    };
    return { e, advance, proc };
  }

  it('holds the playhead at the start point until its audio is heard, then follows it', async () => {
    const { e, advance } = await liveEngine(0.1);
    await e.play({ from: 48000 });
    expect(e.position).toBe(48000);
    advance(0.05);
    // Half the output latency later the start is still not heard: no jump back before it.
    expect(e.position).toBe(48000);
    advance(0.15);
    expect(Math.abs(e.position - (48000 + 0.1 * 48000))).toBeLessThanOrEqual(128);
    // Stopping right after a seek leaves the playhead at the seek point, not before it.
    e.seek(96000);
    advance(0.02);
    expect(e.stop()).toBe(96000);
    vi.unstubAllGlobals();
  });

  it('shows a loop wrap when it is heard, never a frame outside the loop', async () => {
    const { e, advance } = await liveEngine(0.1);
    await e.play({ from: 51000, to: 52000, loop: { start: 48000, end: 52000 } });
    const seen = [];
    for (let i = 0; i < 60; i++) {
      advance(0.005);
      seen.push(e.position);
    }
    expect(seen.every((f) => f >= 48000 && f < 52000)).toBe(true);
    // The mixer wrapped after 1000 frames (about 21 ms); the wrap is heard 100 ms after that.
    expect(seen[21]).toBeGreaterThan(51500); // about 117 ms in: still the end of the loop
    expect(seen[30]).toBeLessThan(50500); // about 165 ms in: back near the loop start
    e.stop();
    vi.unstubAllGlobals();
  });

  it('ignores an end of playback reported for an earlier play', async () => {
    const { e, advance } = await liveEngine(0);
    await e.play({ from: 0, to: 256 });
    // The first snippet ends in the mixer, but a new play starts before the main thread hears of it.
    const ended = [];
    const port = e.node.port;
    const deliver = port.onmessage;
    port.onmessage = (m) => (m.data.type === 'ended' ? ended.push(m) : deliver(m));
    advance(0.01);
    port.onmessage = deliver;
    await e.play({ from: 1000 });
    for (const m of ended) deliver(m);
    expect(e.playing).toBe(true);
    e.stop();
    vi.unstubAllGlobals();
  });
});
