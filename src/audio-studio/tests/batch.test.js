// Batch Process: queue, output names, export options, the runner and the
// per-item pipeline (with fake load, encode and write).
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/index.js';
import { registerEffect } from '../src/effects/registry.js';
import { Channel } from '../src/audio/channel.js';
import { addSources, removeItems, resetItems, sourceIdentity, outputName, plannedNames, uniqueName, exportOptionsFor, batchSettings, describeBatch, runQueue } from '../src/batch/queue.js';
import { processItem, applyFavoriteToState, batchFavoriteProblem, BATCH_COMMANDS } from '../src/batch/process.js';

const doc = (id, name) => ({ id, name, kind: 'audio' });
const file = (name, size = 10) => ({ name, size, lastModified: 1 });

describe('batch queue', () => {
  it('adds sources once each', () => {
    const d = doc('f1', 'a.wav');
    let r = addSources([], [{ type: 'doc', doc: d }, { type: 'local', file: file('b.mp3') }, { type: 'puter', path: '/u/c.flac' }]);
    expect(r.added).toBe(3);
    expect(r.items.map((i) => i.name)).toEqual(['a.wav', 'b.mp3', 'c.flac']);
    expect(r.items.every((i) => i.status === 'ready')).toBe(true);
    r = addSources(r.items, [{ type: 'doc', doc: d }, { type: 'local', file: file('b.mp3') }, { type: 'local', file: file('b.mp3', 11) }]);
    expect(r.added).toBe(1);
    expect(sourceIdentity({ type: 'puter', path: '/x' })).toBe('puter:/x');
    const items = removeItems(r.items, [r.items[0].id]);
    expect(items).toHaveLength(3);
    const done = items.map((i) => ({ ...i, status: 'done', progress: 1, message: 'x' }));
    expect(resetItems(done).every((i) => i.status === 'ready' && i.progress === 0 && !i.message)).toBe(true);
  });

  it('names outputs with prefix, suffix and the format extension, unique per batch', () => {
    const s = batchSettings({ format: 'mp3', prefix: 'Clean ', suffix: '_v2' });
    expect(outputName('Interview.wav', s)).toBe('Clean Interview_v2.mp3');
    expect(outputName('a/b:c.wav', batchSettings({ format: 'flac' }))).toBe('a_b_c.flac');
    expect(outputName('Take 2.1', batchSettings({ format: 'flac' }))).toBe('Take 2.1.flac');
    const items = [{ name: 'take.wav' }, { name: 'take.aif' }, { name: 'Take.mp3' }, { name: 'other.wav' }];
    expect(plannedNames(items, batchSettings({ format: 'wav' }))).toEqual(['take.wav', 'take 2.wav', 'Take 3.wav', 'other.wav']);
    const taken = new Set(['x.wav']);
    expect(uniqueName('x.wav', taken)).toBe('x 2.wav');
  });

  it('builds export options per source', () => {
    const src = { sampleRate: 44100, channels: 2 };
    expect(exportOptionsFor(batchSettings({ format: 'wav', bitDepth: 16 }), src)).toMatchObject({ format: 'wav', sampleRate: 44100, channels: 2, bitDepth: 16 });
    expect(exportOptionsFor(batchSettings({ format: 'wav', sampleRate: 48000, channels: 1, bitDepth: 24 }), src)).toMatchObject({ sampleRate: 48000, channels: 1, bitDepth: 24 });
    const mp3 = exportOptionsFor(batchSettings({ format: 'mp3', settings: { bitrate: 128 } }), src);
    expect(mp3).toMatchObject({ format: 'mp3', settings: { bitrate: 128 } });
    expect(mp3.bitDepth).toBeUndefined();
    expect(exportOptionsFor(batchSettings({ format: 'opus' }), src).sampleRate).toBe(48000);
    expect(describeBatch(batchSettings({ format: 'flac', bitDepth: 16 }))).toMatch(/FLAC, 16-bit, compression level 5, source rate/);
  });

  it('runs items in order with progress, failures and outputs', async () => {
    const { items } = addSources([], [1, 2, 3].map((i) => ({ type: 'local', file: file(`f${i}.wav`) })));
    const updates = [];
    const r = await runQueue(items, {
      names: ['o1.wav', 'o2.wav', 'o3.wav'],
      onUpdate: (list) => updates.push(list.map((i) => i.status).join(',')),
      process: async (item, { onProgress }) => {
        onProgress(0.5);
        if (item.name === 'f2.wav') throw new Error('Broken file');
        return { output: `${item.output}!` };
      },
    });
    expect(r).toMatchObject({ done: 2, failed: 1, cancelled: 0 });
    expect(r.items.map((i) => i.status)).toEqual(['done', 'error', 'done']);
    expect(r.items[1].message).toBe('Broken file');
    expect(r.items[2].output).toBe('o3.wav!');
    expect(updates[0]).toBe('waiting,waiting,waiting');
    expect(updates).toContain('running,waiting,waiting');
  });

  it('stops on cancel and marks the rest cancelled', async () => {
    const { items } = addSources([], [1, 2, 3].map((i) => ({ type: 'local', file: file(`f${i}.wav`) })));
    const ctrl = new AbortController();
    const r = await runQueue(items, {
      signal: ctrl.signal,
      process: async (item) => {
        if (item.name === 'f2.wav') {
          ctrl.abort();
          const e = new Error('Cancelled');
          e.name = 'AbortError';
          throw e;
        }
        return {};
      },
    });
    expect(r.items.map((i) => i.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(r.cancelled).toBe(2);
  });
});

describe('batch processing', () => {
  const state = () => ({ sampleRate: 1000, channels: [Channel.fromSamples(Float32Array.from({ length: 100 }, (_, i) => (i % 2 ? 0.25 : -0.25)))], markers: [], meta: {} });

  it('applies command and effect favorites to a whole state', async () => {
    const norm = await applyFavoriteToState({ name: 'N', action: { type: 'command', command: 'fx.normalizePeak', args: { peak: 0 } } }, state());
    expect(Math.max(...norm.channels[0].toArray())).toBeCloseTo(1, 5);
    const stereo = await applyFavoriteToState({ name: 'S', action: { type: 'command', command: 'fx.toStereo' } }, state());
    expect(stereo.channels).toHaveLength(2);
    registerEffect({ id: 'batchHalf', name: 'Half', group: 'Special', kind: null, params: [], process: async ({ channels }) => channels.map((c) => c.map((v) => v / 2)) });
    const half = await applyFavoriteToState({ name: 'H', action: { type: 'effect', effect: 'batchHalf', values: {} } }, state());
    expect(half.channels[0].toArray(0, 1)[0]).toBeCloseTo(-0.125);
    const same = state();
    expect(await applyFavoriteToState(null, same)).toBe(same);
  });

  it('explains favorites it cannot run', async () => {
    expect(batchFavoriteProblem(null)).toBe('');
    expect(batchFavoriteProblem({ action: { type: 'command', command: 'edit.cut' } })).toMatch(/cannot run/);
    expect(batchFavoriteProblem({ action: { type: 'effect', effect: 'nope' } })).toMatch(/not available/);
    expect(Object.keys(BATCH_COMMANDS)).toEqual(expect.arrayContaining(['fx.normalizePeak', 'fx.fadeIn', 'fx.fadeOut', 'fx.toMono', 'fx.toStereo']));
    await expect(applyFavoriteToState({ name: 'X', action: { type: 'command', command: 'edit.cut' } }, state())).rejects.toThrow(/cannot run/);
  });

  it('loads, applies, encodes and writes one item', async () => {
    const written = [];
    const progress = [];
    const r = await processItem(
      { name: 'in.wav', output: 'out.mp3', source: { type: 'local' } },
      {
        favorite: { name: 'Mono', action: { type: 'command', command: 'fx.toMono' } },
        settings: batchSettings({ format: 'mp3', sampleRate: 44100 }),
        load: async () => ({ state: { ...state(), channels: [state().channels[0], state().channels[0]] } }),
        encode: async (src, options) => {
          expect(src.channels).toHaveLength(1);
          expect(options).toMatchObject({ format: 'mp3', sampleRate: 44100, channels: 1 });
          return new Blob(['x']);
        },
        write: async (name, blob) => {
          written.push([name, blob.size]);
          return `${name} (1)`;
        },
        onProgress: (f) => progress.push(f),
      },
    );
    expect(written).toEqual([['out.mp3', 1]]);
    expect(r.output).toBe('out.mp3 (1)');
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
  });

  it('never changes an open document', async () => {
    const s = state();
    const d = { id: 'f9', name: 'open.wav', state: s };
    await processItem({ name: 'open.wav', output: 'o.wav', source: { type: 'doc', doc: d } }, {
      favorite: { name: 'N', action: { type: 'command', command: 'fx.normalizePeak', args: { peak: 0 } } },
      settings: batchSettings({}),
      encode: async () => new Blob([]),
      write: async () => 'o.wav',
    });
    expect(d.state).toBe(s);
    expect(s.channels[0].toArray(0, 1)[0]).toBeCloseTo(-0.25);
  });
});
