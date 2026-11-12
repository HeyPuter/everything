import { describe, it, expect } from 'vitest';
import { ChunkStore, renderBlock, createScratch, envelopeAt, envelopeFill, fadeShape, CHUNK } from '../src/engine/mixcore.js';

function setup(extraTrack = {}, clip = {}) {
  const store = new ChunkStore();
  store.put('k', 0, [new Float32Array(CHUNK).fill(0.5), new Float32Array(CHUNK).fill(0.25)]);
  const graph = { tracks: [{ id: 't', gain: 1, pan: 0, clips: [{ id: 'c', source: 'k', channels: 2, start: 10, offset: 0, length: 1000, gain: 1, fadeIn: 0, fadeOut: 0, ...clip }], fx: [], ...extraTrack }], master: { gain: 1 } };
  const master = [new Float32Array(128), new Float32Array(128)];
  return { store, graph, master };
}

describe('mixcore', () => {
  it('places a clip at its timeline start', () => {
    const { store, graph, master } = setup();
    renderBlock(graph, store, 0, 128, master, createScratch(128));
    expect(master[0][9]).toBe(0);
    expect(master[0][10]).toBe(0.5);
    expect(master[1][10]).toBe(0.25);
  });
  it('applies balance pan and track gain', () => {
    const { store, graph, master } = setup({ pan: 0.5, gain: 2 });
    renderBlock(graph, store, 0, 128, master, createScratch(128));
    expect(master[0][20]).toBeCloseTo(0.5);
    expect(master[1][20]).toBeCloseTo(0.5);
  });
  it('honours mute and solo, reporting meters for muted tracks', () => {
    const { store, graph, master } = setup({ mute: true });
    const meters = new Map();
    renderBlock(graph, store, 0, 128, master, createScratch(128), { meters });
    expect(master[0][20]).toBe(0);
    expect(meters.get('t')[0]).toBeCloseTo(0.5);
  });
  it('reports missing chunks and renders silence for them', () => {
    const { store, graph, master } = setup({}, { offset: CHUNK * 3 });
    const missing = [];
    renderBlock(graph, store, 0, 128, master, createScratch(128), { missing: (k, f) => missing.push([k, f]) });
    expect(missing[0][0]).toBe('k');
    expect(master[0][50]).toBe(0);
  });
  it('fades and evaluates envelopes', () => {
    expect(fadeShape(0.5, 0)).toBe(0.5);
    expect(fadeShape(0.5, 2)).toBeCloseTo(0.5);
    expect(envelopeAt([{ t: 0, v: 0 }, { t: 10, v: 1 }], 5)).toBe(0.5);
    const { store, graph, master } = setup({}, { start: 0, fadeIn: 100 });
    renderBlock(graph, store, 0, 128, master, createScratch(128));
    expect(master[0][50]).toBeCloseTo(0.25);
  });
});

describe('mixcore routing', () => {
  const clip = (o = {}) => ({ id: 'c', source: 'k', channels: 2, start: 0, offset: 0, length: 1000, gain: 1, fadeIn: 0, fadeOut: 0, ...o });
  const store = () => {
    const s = new ChunkStore();
    s.put('k', 0, [new Float32Array(CHUNK).fill(0.5), new Float32Array(CHUNK).fill(0.5)]);
    return s;
  };
  const render = (graph, opts) => {
    const master = [new Float32Array(128), new Float32Array(128)];
    renderBlock(graph, store(), 0, 128, master, createScratch(128), opts);
    return master;
  };

  it('mixes tracks into buses, which render after their inputs with their own gain', () => {
    const graph = {
      tracks: [
        { id: 'bus', bus: true, gain: 0.5, pan: 0, clips: [] },
        { id: 'a', gain: 1, pan: 0, output: 'bus', clips: [clip()] },
        { id: 'b', gain: 1, pan: 0, output: 'bus', clips: [clip()] },
      ],
      master: { gain: 1 },
    };
    const meters = new Map();
    const m = render(graph, { meters });
    expect(m[0][10]).toBeCloseTo(0.5); // (0.5 + 0.5) * 0.5
    expect(meters.get('bus')[0]).toBeCloseTo(0.5);
  });

  it('chains buses and ignores routes to unknown ids', () => {
    const graph = {
      tracks: [
        { id: 'b2', bus: true, gain: 2, pan: 0, clips: [] },
        { id: 'b1', bus: true, gain: 1, pan: 0, output: 'b2', clips: [] },
        { id: 'a', gain: 1, pan: 0, output: 'b1', clips: [clip()] },
        { id: 'x', gain: 1, pan: 0, output: 'missing', clips: [clip()] },
      ],
      master: { gain: 1 },
    };
    expect(render(graph)[0][10]).toBeCloseTo(1.5); // a: 0.5 * 2, x: 0.5
  });

  it('keeps inputs of a soloed bus and buses fed by a soloed track audible', () => {
    const tracks = (soloBus, soloA) => [
      { id: 'bus', bus: true, gain: 1, pan: 0, solo: soloBus, clips: [] },
      { id: 'a', gain: 1, pan: 0, output: 'bus', solo: soloA, clips: [clip()] },
      { id: 'b', gain: 1, pan: 0, clips: [clip()] },
      { id: 'click', gain: 1, pan: 0, soloSafe: true, clips: [clip({ gain: 0.2 })] },
    ];
    expect(render({ tracks: tracks(true, false), master: { gain: 1 } })[0][10]).toBeCloseTo(0.6);
    expect(render({ tracks: tracks(false, true), master: { gain: 1 } })[0][10]).toBeCloseTo(0.6);
    const muted = tracks(false, true);
    muted[0].mute = true;
    expect(render({ tracks: muted, master: { gain: 1 } })[0][10]).toBeCloseTo(0.1);
  });

  it('pans clips with a pan envelope and offsets fades for segments', () => {
    const graph = { tracks: [{ id: 'a', gain: 1, pan: 0, clips: [clip({ panEnv: [{ t: 0, v: 1 }] })] }], master: { gain: 1 } };
    const m = render(graph);
    expect(m[0][10]).toBe(0);
    expect(m[1][10]).toBeCloseTo(0.5);
    // A segment starting 100 frames into a 200-frame clip with a 150-frame fade out.
    const seg = { tracks: [{ id: 'a', gain: 1, pan: 0, clips: [clip({ length: 100, base: 100, full: 200, fadeOut: 150 })] }], master: { gain: 1 } };
    expect(render(seg)[0][0]).toBeCloseTo(0.5 * (100 / 150));
  });
});

describe('mixcore polarity and rack mix', () => {
  it('inverts a track and the master', () => {
    const { store, graph, master } = setup({ invert: true });
    renderBlock(graph, store, 0, 128, master, createScratch(128));
    expect(master[0][20]).toBeCloseTo(-0.5);
    graph.master.invert = true;
    renderBlock(graph, store, 0, 128, master, createScratch(128));
    expect(master[0][20]).toBeCloseTo(0.5);
  });
  it('blends the wet part of a track chain with the dry signal before the rest', () => {
    // Chain: [wet x4] then [post +1]; mix 25% wet, dry scaled by 2 (rack input gain).
    const wet = { name: 'wet' };
    const post = { name: 'post' };
    const runFx = (chain, buf, frames) => {
      for (const slot of chain) for (const ch of buf) for (let i = 0; i < frames; i++) ch[i] = slot === wet ? ch[i] * 4 : ch[i] + 1;
    };
    const { store, graph, master } = setup({ fx: [wet, post], fxWet: 1, fxMix: 0.25, fxDry: 2 });
    renderBlock(graph, store, 0, 128, master, createScratch(128), { runFx });
    // 0.5 * 4 * 0.25 + 0.5 * 2 * 0.75 + 1
    expect(master[0][20]).toBeCloseTo(0.5 + 0.75 + 1);
    // Fully wet runs the whole chain in one go.
    const full = setup({ fx: [wet, post], fxWet: 1, fxMix: 1 });
    renderBlock(full.graph, full.store, 0, 128, full.master, createScratch(128), { runFx });
    expect(full.master[0][20]).toBeCloseTo(3);
  });
});

describe('mixcore automation', () => {
  // Renders `total` frames in blocks of `block` (128 like playback, 8192 like a mixdown).
  const renderIn = (graph, block, total) => {
    const store = new ChunkStore();
    store.put('k', 0, [new Float32Array(CHUNK).fill(0.5), new Float32Array(CHUNK).fill(0.5)]);
    const scratch = createScratch(block);
    const out = [new Float32Array(total), new Float32Array(total)];
    for (let at = 0; at < total; at += block) {
      const n = Math.min(block, total - at);
      const m = [new Float32Array(n), new Float32Array(n)];
      renderBlock(graph, store, at, n, m, scratch);
      out[0].set(m[0], at);
      out[1].set(m[1], at);
    }
    return out;
  };
  const graphOf = (track = {}, master = { gain: 1 }) => ({
    master,
    tracks: [{ id: 't', gain: 1, pan: 0, clips: [{ id: 'c', source: 'k', channels: 2, start: 0, offset: 0, length: CHUNK, gain: 1, fadeIn: 0, fadeOut: 0 }], ...track }],
  });

  it('envelopeFill matches envelopeAt frame by frame', () => {
    const pts = [{ t: 10.5, v: 0 }, { t: 20, v: 1 }, { t: 20, v: 0.25 }, { t: 40, v: 0.75 }];
    const out = envelopeFill(pts, 0, 60, new Float32Array(60));
    for (let i = 0; i < 60; i++) if (i !== 20) expect(out[i]).toBeCloseTo(envelopeAt(pts, i), 6);
    expect(envelopeFill(null, 0, 4, new Float32Array(4), 0.5)[3]).toBe(0.5);
  });

  it('follows track volume and pan automation inside a mixdown-sized block like playback does', () => {
    // A dip to silence at frame 4096, in the middle of the first 8192-frame block.
    const dip = [{ t: 0, v: 1 }, { t: 3000, v: 1 }, { t: 4096, v: 0 }, { t: 5000, v: 1 }];
    for (const track of [{ volumeEnv: dip }, { panEnv: dip.map((p) => ({ t: p.t, v: 1 - p.v })) }]) {
      const live = renderIn(graphOf(track), 128, 16384);
      const mixdown = renderIn(graphOf(track), 8192, 16384);
      expect(live[0][4096]).toBe(0);
      expect(mixdown[0][4096]).toBe(0);
      for (let i = 0; i < 16384; i += 7) expect(mixdown[0][i]).toBeCloseTo(live[0][i], 5);
    }
  });

  it('ramps master volume automation smoothly instead of in block-sized steps', () => {
    const fade = { gain: 1, volumeEnv: [{ t: 0, v: 1 }, { t: 16384, v: 0 }] };
    const [L] = renderIn(graphOf({}, fade), 8192, 16384);
    expect(L[4096]).toBeCloseTo(0.5 * 0.75, 5);
    // No jump at the block boundary: neighbouring frames differ by one frame's step.
    expect(Math.abs(L[8192] - L[8191])).toBeLessThan(1e-4);
  });
});
