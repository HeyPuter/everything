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
