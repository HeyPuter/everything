// Automation lanes: several lanes per track, mute automation and hold keyframes.
import { describe, it, expect } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { buildSessionGraph, muteEnvelope, multiplyEnvelopes } from '../src/model/session-graph.js';
import { TrackControls } from '../src/multitrack/track-controls.js';
import { Channel } from '../src/audio/channel.js';

const RATE = 48000;

async function appWithSession() {
  HTMLCanvasElement.prototype.getContext = () => null;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Lanes.asesx', sampleRate: RATE, tracks: 2 });
  app.addDocument(doc);
  return { app, doc };
}

describe('envelope holds', () => {
  it('keeps a hold point value until the next point', () => {
    const pts = [{ t: 0, v: 0, hold: true }, { t: 100, v: -12 }, { t: 200, v: 6 }];
    expect(S.envelopeValue(pts, 50)).toBe(0);
    expect(S.envelopeValue(pts, 99)).toBe(0);
    expect(S.envelopeValue(pts, 150)).toBe(-3);
  });

  it('expands holds into steps for linear consumers', () => {
    const pts = [{ t: 0, v: 1, hold: true }, { t: 100, v: 5 }];
    expect(S.expandHolds(pts)).toEqual([{ t: 0, v: 1 }, { t: 99, v: 1 }, { t: 100, v: 5 }]);
    const plain = [{ t: 0, v: 1 }];
    expect(S.expandHolds(plain)).toBe(plain);
  });

  it('keeps holds when a clip envelope is split or normalized', () => {
    const pts = [{ t: 0, v: -6, hold: true }, { t: 1000, v: 0 }];
    const [left, right] = S.splitEnvelope(pts, 400, 0);
    expect(left[0].hold).toBe(true);
    expect(right[0]).toEqual({ t: 0, v: -6, hold: true });
    expect(S.normalizeEnvelope(pts, 2000)[0].hold).toBe(true);
  });

  it('turns every mute point into a hold', () => {
    expect(S.muteSteps([{ t: 0, v: 1 }, { t: 5, v: 0 }]).every((p) => p.hold)).toBe(true);
  });
});

describe('track lanes', () => {
  it('defaults to one volume lane and drops unknown or duplicate parameters', () => {
    expect(S.createTrack({}).lanes).toEqual(['volume']);
    expect(S.createTrack({ lanes: ['pan', 'pan', 'bogus', 'mute'] }).lanes).toEqual(['pan', 'mute']);
    // The master has no pan lane.
    expect(S.createTrack({ type: 'master', lanes: ['pan'] }).lanes).toEqual(['volume']);
    expect(S.createTrack({ autoParam: 'pan' }).lanes).toEqual(['pan']);
  });

  it('shows lanes only while they are open', () => {
    const t = S.createTrack({ lanes: ['volume', 'mute'] });
    expect(S.trackLanes(t)).toEqual([]);
    expect(S.trackLanes({ ...t, showAutomation: true })).toEqual(['volume', 'mute']);
  });

  it('adds, swaps and closes lanes through commands', async () => {
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    await app.commands.run('mt.toggleAutomationLane', { id });
    await app.commands.run('mt.addAutomationLane', { id });
    await app.commands.run('mt.addAutomationLane', { id });
    expect(S.trackLanes(S.findTrack(doc.state, id))).toEqual(['volume', 'mute', 'pan']);
    expect(app.commands.isEnabled('mt.addAutomationLane', { id })).toBe(false);
    // Picking a parameter shown in another lane swaps the two.
    await app.commands.run('mt.setAutomationParam', { id, param: 'pan', lane: 0 });
    expect(S.trackLanes(S.findTrack(doc.state, id))).toEqual(['pan', 'mute', 'volume']);
    await app.commands.run('mt.removeAutomationLane', { id, lane: 1 });
    expect(S.trackLanes(S.findTrack(doc.state, id))).toEqual(['pan', 'volume']);
    await app.commands.run('mt.removeAutomationLane', { id, lane: 0 });
    await app.commands.run('mt.removeAutomationLane', { id, lane: 0 });
    const t = S.findTrack(doc.state, id);
    expect(t.showAutomation).toBe(false);
    expect(t.lanes).toEqual(['volume']);
    // Lanes are view settings: no undo steps.
    expect(doc.history.index).toBe(0);
  });

  it('adds and removes a keyframe at the playhead and clears a lane', async () => {
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    doc.setCursor(RATE);
    await app.commands.run('mt.toggleKeyframe', { id, param: 'mute' });
    expect(S.findTrack(doc.state, id).automation.mute).toEqual([{ t: RATE, v: 0, hold: true }]);
    await app.commands.run('mt.toggleKeyframe', { id, param: 'mute' });
    expect(S.findTrack(doc.state, id).automation.mute).toEqual([]);
    await app.commands.run('mt.toggleKeyframe', { id, param: 'volume' });
    doc.setCursor(RATE * 2);
    await app.commands.run('mt.toggleKeyframe', { id, param: 'volume' });
    expect(S.findTrack(doc.state, id).automation.volume.length).toBe(2);
    await app.commands.run('mt.clearAutomation', { id, param: 'volume' });
    expect(S.findTrack(doc.state, id).automation.volume).toEqual([]);
    expect(doc.history.undoLabel).toBe('Clear Automation');
  });
});

describe('mute automation', () => {
  it('builds a stepped gain envelope with short ramps', () => {
    const env = muteEnvelope([{ t: 0, v: 0 }, { t: 1000, v: 1 }, { t: 3000, v: 0 }], RATE);
    expect(env[0]).toEqual({ t: 0, v: 1 });
    expect(env.find((p) => p.t === 1000).v).toBe(0);
    expect(env.find((p) => p.t === 3000).v).toBe(1);
    expect(env.filter((p) => p.v === 0).length).toBe(2);
  });

  it('multiplies two envelopes at the union of their breakpoints', () => {
    const out = multiplyEnvelopes([{ t: 0, v: 1 }, { t: 100, v: 0.5 }], [{ t: 50, v: 0 }, { t: 60, v: 1 }]);
    expect(out.map((p) => p.t)).toEqual([0, 50, 60, 100]);
    expect(out[1].v).toBe(0);
    expect(out[3].v).toBeCloseTo(0.5);
  });

  it('replaces the mute switch in the playback graph', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    st = S.updateTrack(st, id, { mute: true, volume: -6 });
    st = S.setAutomation(st, id, 'mute', [{ t: RATE, v: 1, hold: true }, { t: RATE * 2, v: 0, hold: true }]);
    const { graph } = buildSessionGraph(st, new Map());
    const gt = graph.tracks[0];
    expect(gt.mute).toBe(false);
    expect(gt.gain).toBe(1);
    // Muted from 1 s to 2 s, at -6 dB otherwise.
    expect(S.envelopeValue(gt.volumeEnv, RATE * 1.5)).toBe(0);
    expect(S.envelopeValue(gt.volumeEnv, RATE * 3)).toBeCloseTo(Math.pow(10, -6 / 20));
    // Mode Off ignores the lane and the switch counts again.
    const off = buildSessionGraph(S.updateTrack(st, id, { mode: 'off' }), new Map()).graph.tracks[0];
    expect(off.mute).toBe(true);
  });

  it('steps a held clip volume keyframe in the graph', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const ch = Channel.fromSamples(new Float32Array(RATE * 2));
    const pool = new Map([['src', { channels: [ch] }]]);
    const clip = S.createClip({ trackId: st.tracks[0].id, sourceId: 'src', start: 0, length: RATE * 2, volumeEnv: [{ t: 0, v: -12, hold: true }, { t: RATE, v: 0 }] });
    st = S.addClips(st, [clip]);
    const gc = buildSessionGraph(st, pool).graph.tracks[0].clips[0];
    expect(S.envelopeValue(gc.gainEnv, RATE - 2)).toBeCloseTo(Math.pow(10, -12 / 20));
  });

  it('toggles mute as a keyframe once the track has mute automation', async () => {
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    const c = new TrackControls(app, doc);
    doc.setCursor(0);
    doc.apply('Mute Automation', S.setAutomation(doc.state, id, 'mute', [{ t: 0, v: 0, hold: true }]));
    expect(c.muted(S.findTrack(doc.state, id))).toBe(false);
    doc.setCursor(RATE);
    c.toggle(id, 'mute');
    const t = S.findTrack(doc.state, id);
    expect(t.mute).toBe(false);
    expect(t.automation.mute).toEqual([{ t: 0, v: 0, hold: true }, { t: RATE, v: 1, hold: true }]);
    expect(c.muted(t, RATE * 2)).toBe(true);
    expect(c.muted(t, RATE / 2)).toBe(false);
    // Without automation the switch is a switch.
    const other = doc.state.tracks[1].id;
    c.toggle(other, 'mute');
    expect(S.findTrack(doc.state, other).mute).toBe(true);
  });
});

describe('properties panel edits', () => {
  it('moves and trims a clip and sets tempo from the session properties', async () => {
    const { sessionPropertySection } = await import('../src/multitrack/properties.js');
    const { app, doc } = await appWithSession();
    const src = doc.addSource({ name: 'a.wav', channels: [Channel.fromSamples(new Float32Array(RATE * 4))] });
    const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, start: RATE, length: RATE * 2 });
    doc.apply('Insert File', S.addClips(doc.state, [clip]));
    doc.selectClips([clip.id]);
    const set = (label, value) => {
      const el = sessionPropertySection(app, doc).querySelector(`[aria-label="${label}"]`);
      el.value = value;
      el.dispatchEvent(new Event('change'));
    };
    set('Clip start', '0:02.000');
    expect(S.findClip(doc.state, clip.id).start).toBe(RATE * 2);
    set('Clip duration', '0:01.000');
    expect(S.findClip(doc.state, clip.id).length).toBe(RATE);
    set('Clip end', '0:04.000');
    expect(S.findClip(doc.state, clip.id).length).toBe(RATE * 2);
    set('Session tempo in beats per minute', '96');
    expect(doc.state.tempo).toBe(96);
    expect(doc.history.undoLabel).toBe('Session Tempo');
    set('Beats per bar', '3');
    expect(doc.state.beatsPerBar).toBe(3);
  });
});
