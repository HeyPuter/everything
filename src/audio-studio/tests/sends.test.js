import { describe, it, expect } from 'vitest';
import { ChunkStore, renderBlock, createScratch, routingPlan, CHUNK } from '../src/engine/mixcore.js';
import { createSessionState, createTrack, setSend, removeSend, removeTracks, wouldCycle } from '../src/model/session-edits.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { bounceGraph } from '../src/multitrack/render.js';
import '../src/effects/catalog.js';

const clip = (o = {}) => ({ id: 'c', source: 'k', channels: 2, start: 0, offset: 0, length: 1000, gain: 1, fadeIn: 0, fadeOut: 0, ...o });
const render = (graph, opts) => {
  const store = new ChunkStore();
  store.put('k', 0, [new Float32Array(CHUNK).fill(0.5), new Float32Array(CHUNK).fill(0.5)]);
  const master = [new Float32Array(128), new Float32Array(128)];
  renderBlock(graph, store, 0, 128, master, createScratch(128), opts);
  return master;
};
const bus = (o = {}) => ({ id: 'b', bus: true, gain: 1, pan: 0, clips: [], ...o });

describe('sends', () => {
  it('adds a post-fader copy to the bus on top of the track output', () => {
    const graph = { tracks: [{ id: 't', gain: 0.5, pan: 0, clips: [clip()], sends: [{ target: 'b', gain: 1, pan: 0, pre: false }] }, bus()], master: { gain: 1 } };
    const m = render(graph);
    // Track: 0.5 * 0.5 direct, plus the same through the bus.
    expect(m[0][10]).toBeCloseTo(0.5);
  });

  it('taps pre-fader sends before volume and pan', () => {
    const graph = { tracks: [{ id: 't', gain: 0, pan: 0, clips: [clip()], sends: [{ target: 'b', gain: 0.5, pan: 1, pre: true }] }, bus()], master: { gain: 1 } };
    const m = render(graph);
    // Fader at silence: only the pre-fader send is heard, panned right by the send.
    expect(m[0][10]).toBeCloseTo(0);
    expect(m[1][10]).toBeCloseTo(0.25);
  });

  it('renders a bus after every track that sends to it and keeps it audible on solo', () => {
    const graph = {
      tracks: [bus({ id: 'b2' }), { id: 't', gain: 1, pan: 0, solo: true, clips: [clip()], sends: [{ target: 'b2', gain: 1, pan: 0, pre: false }] }, bus({ id: 'b1', sends: [{ target: 'b2', gain: 1, pan: 0 }] })],
      master: { gain: 1 },
    };
    const plan = routingPlan(graph);
    const order = plan.order.map((t) => t.id);
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('b2'));
    expect(plan.audible.has('b2')).toBe(true);
    expect(render(graph)[0][10]).toBeCloseTo(1);
  });
});

describe('bouncing a bus', () => {
  const tracks = (o = {}) => [
    { id: 't', gain: 1, pan: 0, clips: [clip()], sends: [{ target: 'b', gain: 0.5, pan: 0, pre: false }], ...o },
    { id: 'u', gain: 1, pan: 0, clips: [clip({ id: 'c2' })], output: 'b2' },
    bus(),
    bus({ id: 'b2' }),
  ];

  it('includes what other tracks send to it, but not their own output', () => {
    const graph = bounceGraph({ tracks: tracks(), master: { gain: 0.1 } }, 'b');
    // Only the send: 0.5 * 0.5; track t's direct output and track u (another bus) are left out.
    expect(render(graph)[0][10]).toBeCloseTo(0.25);
    expect(graph.tracks.some((t) => t.id === 'u')).toBe(false);
  });

  it('keeps tracks routed into it as before', () => {
    const graph = bounceGraph({ tracks: tracks(), master: { gain: 0.1 } }, 'b2');
    expect(render(graph)[0][10]).toBeCloseTo(0.5);
    // Bouncing an audio track leaves out the buses it sends to.
    const one = bounceGraph({ tracks: tracks(), master: { gain: 0.1 } }, 't');
    expect(one.tracks.map((t) => t.id)).toEqual(['t']);
    expect(render(one)[0][10]).toBeCloseTo(0.5);
  });
});

describe('send model', () => {
  it('adds, edits and removes sends; removing a bus clears sends to it', () => {
    let s = createSessionState({ tracks: 0, template: [{ name: 'A' }, { name: 'FX', type: 'bus' }] });
    const [a, fx] = s.tracks;
    s = setSend(s, a.id, 0, { target: fx.id, level: -6, pre: true });
    expect(s.tracks[0].sends[0]).toMatchObject({ target: fx.id, level: -6, pre: true, on: true, pan: 0 });
    s = setSend(s, a.id, 0, { pan: 40 });
    expect(s.tracks[0].sends[0]).toMatchObject({ level: -6, pan: 40 });
    expect(removeTracks(s, [fx.id]).tracks[0].sends[0].target).toBe(null);
    expect(removeSend(s, a.id, 0).tracks[0].sends).toEqual([]);
  });

  it('refuses routing that would loop through sends', () => {
    let s = createSessionState({ tracks: 0, template: [{ name: 'B1', type: 'bus' }, { name: 'B2', type: 'bus' }] });
    const [b1, b2] = s.tracks;
    s = setSend(s, b1.id, 0, { target: b2.id });
    expect(wouldCycle(s, b2.id, b1.id)).toBe(true);
    expect(wouldCycle(s, b1.id, b2.id)).toBe(false);
  });

  it('builds graph sends and track EQ', () => {
    let s = createSessionState({ tracks: 0, template: [{ name: 'A' }, { name: 'FX', type: 'bus' }] });
    s = setSend(s, s.tracks[0].id, 0, { target: s.tracks[1].id, level: -6 });
    s = { ...s, tracks: s.tracks.map((t, i) => (i === 0 ? createTrack({ ...t, eq: { on: true, values: {} } }) : t)) };
    const { graph } = buildSessionGraph(s, new Map());
    const g = graph.tracks.find((t) => t.id === s.tracks[0].id);
    expect(g.sends[0].target).toBe(s.tracks[1].id);
    expect(g.sends[0].gain).toBeCloseTo(0.501, 2);
    expect(g.fx.some((x) => String(x.key).startsWith('eq:'))).toBe(true);
  });
});

describe('clip pan envelopes and the pan law', () => {
  it('apply the equal-power centre attenuation once', () => {
    const law = { mode: 'equalPower', centerDb: -3 };
    const plain = render({ panLaw: law, tracks: [{ id: 't', gain: 1, pan: 0, clips: [clip()] }], master: { gain: 1 } });
    const env = render({ panLaw: law, tracks: [{ id: 't', gain: 1, pan: 0, clips: [clip({ panEnv: [{ t: 0, v: 0 }] })] }], master: { gain: 1 } });
    expect(env[0][10]).toBeCloseTo(plain[0][10], 5);
    const hard = render({ panLaw: law, tracks: [{ id: 't', gain: 1, pan: 0, clips: [clip({ panEnv: [{ t: 0, v: 1 }] })] }], master: { gain: 1 } });
    expect(hard[0][10]).toBeCloseTo(0, 5);
    expect(hard[1][10]).toBeCloseTo(0.5, 3);
  });
});
