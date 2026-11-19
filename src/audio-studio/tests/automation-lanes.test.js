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

describe('track effect slots in place', () => {
  it('inserts, bypasses and removes an effect from a slot menu', async () => {
    const { trackSlotMenu } = await import('../src/multitrack/fx-slots.js');
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    const menu = trackSlotMenu(app, doc, id, 2);
    const first = menu.find((m) => m.type === 'sub').items[0];
    first.run();
    const fx = S.findTrack(doc.state, id).fx;
    expect(fx[2]?.effect).toBeTruthy();
    expect(doc.history.undoLabel).toBe('Add Effect');
    const again = trackSlotMenu(app, doc, id, 2);
    again.find((m) => m.label === 'Turn Off').run();
    expect(S.findTrack(doc.state, id).fx[2].enabled).toBe(false);
    trackSlotMenu(app, doc, id, 2).find((m) => m.label === 'Remove Effect').run();
    expect(S.findTrack(doc.state, id).fx.filter(Boolean)).toEqual([]);
  });
});

describe('metronome pattern and add tracks', () => {
  it('fits a stored accent pattern to the bar and silences or softens beats', async () => {
    const { metronomePattern, metronomeBar } = await import('../src/model/session-graph.js');
    expect(metronomePattern(null, 3)).toEqual(['down', 'up', 'up']);
    expect(metronomePattern(['up', 'none', 'bogus'], 4)).toEqual(['up', 'none', 'up', 'up']);
    const plain = metronomeBar(Channel, { sampleRate: RATE, tempo: 120, beatsPerBar: 4 })[0];
    const patterned = metronomeBar(Channel, { sampleRate: RATE, tempo: 120, beatsPerBar: 4, metronomePattern: ['down', 'none', 'sub', 'up'] })[0];
    const peak = (ch, beat) => {
      const data = ch.toArray();
      let m = 0;
      for (let i = beat * RATE / 2; i < (beat + 1) * RATE / 2; i++) m = Math.max(m, Math.abs(data[i]));
      return m;
    };
    expect(peak(patterned, 1)).toBe(0);
    expect(peak(patterned, 2)).toBeCloseTo(peak(plain, 2) * 0.45, 5);
    expect(peak(patterned, 3)).toBeCloseTo(peak(plain, 3), 5);
  });

  it('adds audio and bus tracks with their channel counts', async () => {
    const { app, doc } = await appWithSession();
    const before = new Set(doc.state.tracks.map((t) => t.id));
    await app.commands.run('mt.addTracks', { audio: { count: 2, channels: 1 }, bus: { count: 1, channels: 6 } });
    // They follow the selected track, in order.
    const added = doc.state.tracks.filter((t) => !before.has(t.id));
    expect(doc.state.tracks.indexOf(added[0])).toBe(1);
    expect(added.map((t) => [t.type, t.channels])).toEqual([['audio', 1], ['audio', 1], ['bus', 6]]);
    expect(doc.history.undoLabel).toBe('Add Tracks');
  });
});

describe('spline clip envelopes', () => {
  it('passes through the keyframes without overshooting them', () => {
    const pts = [{ t: 0, v: 0 }, { t: 1000, v: -12 }, { t: 2000, v: -12 }, { t: 3000, v: 6 }];
    const curve = S.splineEnvelope(pts);
    for (const p of pts) expect(curve.find((q) => q.t === p.t).v).toBe(p.v);
    expect(Math.min(...curve.map((p) => p.v))).toBeGreaterThanOrEqual(-12);
    expect(Math.max(...curve.map((p) => p.v))).toBeLessThanOrEqual(6);
    // Flat between equal keyframes, curved elsewhere.
    expect(curve.filter((p) => p.t > 1000 && p.t < 2000).every((p) => p.v === -12)).toBe(true);
    expect(curve.length).toBeGreaterThan(pts.length);
  });

  it('keeps a held segment flat and leaves short envelopes alone', () => {
    const pts = [{ t: 0, v: 0, hold: true }, { t: 1000, v: -6 }, { t: 2000, v: 0 }];
    expect(S.splineEnvelope(pts).filter((p) => p.t < 1000)).toEqual([pts[0]]);
    const two = [{ t: 0, v: 0 }, { t: 10, v: 1 }];
    expect(S.splineEnvelope(two)).toBe(two);
  });

  it('plays the curve when the clip asks for it', async () => {
    const { app, doc } = await appWithSession();
    const src = doc.addSource({ name: 'a.wav', channels: [Channel.fromSamples(new Float32Array(RATE * 4))] });
    const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, start: 0, length: RATE * 3, volumeEnv: [{ t: 0, v: 0 }, { t: RATE, v: -20 }, { t: RATE * 2, v: 0 }] });
    doc.apply('Insert File', S.addClips(doc.state, [clip]));
    doc.selectClips([clip.id]);
    await app.commands.run('clip.splineVolume');
    expect(S.findClip(doc.state, clip.id).volumeSpline).toBe(true);
    const gc = buildSessionGraph(doc.state, doc.pool).graph.tracks[0].clips[0];
    const linear = buildSessionGraph(S.updateClips(doc.state, [clip.id], { volumeSpline: false }), doc.pool).graph.tracks[0].clips[0];
    expect(gc.gainEnv.length).toBeGreaterThan(linear.gainEnv.length);
  });
});

describe('send level automation', () => {
  it('offers lanes for routed sends and plays their envelope', async () => {
    const { app, doc } = await appWithSession();
    let st = S.addTrack(doc.state, S.createTrack({ type: 'bus', name: 'Bus A' }));
    const bus = st.tracks[st.tracks.length - 1].id;
    const id = st.tracks[0].id;
    st = S.setSend(st, id, 0, { target: bus, level: -6 });
    doc.apply('Send', st);
    const t = S.findTrack(doc.state, id);
    expect(S.automationParams(t)).toContain('send1');
    expect(S.automationParams('audio')).not.toContain('send1');
    expect(S.staticValue(t, 'send1')).toBe(-6);
    await app.commands.run('mt.setAutomationParam', { id, param: 'send1' });
    expect(S.trackLanes(S.findTrack(doc.state, id))).toEqual(['send1']);
    doc.apply('Send Automation', S.setAutomation(doc.state, id, 'send1', [{ t: 0, v: 0 }, { t: RATE, v: -20 }]));
    const snd = buildSessionGraph(doc.state, new Map()).graph.tracks[0].sends[0];
    expect(snd.gain).toBe(1);
    expect(snd.gainEnv[0].v).toBe(1);
    expect(snd.gainEnv[snd.gainEnv.length - 1].v).toBeCloseTo(0.1);
    // The send knob sets a keyframe once the send is automated.
    const c = new TrackControls(app, doc);
    doc.setCursor(RATE / 2);
    c.set(id, 'send1', -3, 'change');
    expect(S.findTrack(doc.state, id).automation.send1.length).toBe(3);
    expect(S.findTrack(doc.state, id).sends[0].level).toBe(-6);
  });

  it('applies a send envelope in the mix core', async () => {
    const { renderBlock, ChunkStore, createScratch, CHUNK } = await import('../src/engine/mixcore.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    st = S.addTrack(st, S.createTrack({ type: 'bus', name: 'Bus' }));
    const [track, bus] = st.tracks;
    // The track itself is silent (its output muted); only the send reaches the mix.
    st = S.updateTrack(st, track.id, { volume: S.SILENT_DB });
    st = S.setSend(st, track.id, 0, { target: bus.id, pre: true, level: 0 });
    st = S.setAutomation(st, track.id, 'send1', [{ t: 0, v: S.SILENT_DB }, { t: 1000, v: 0 }]);
    const ch = Channel.fromSamples(new Float32Array(4000).fill(0.5));
    st = S.addClips(st, [S.createClip({ trackId: track.id, sourceId: 'src', start: 0, length: 4000 })]);
    const { graph, sources } = buildSessionGraph(st, new Map([['src', { channels: [ch, ch] }]]));
    const store = new ChunkStore();
    for (const [key, chs] of sources) store.put(key, 0, chs.map((c) => c.toArray(0, Math.min(CHUNK, c.length))));
    const render = (pos) => {
      const out = [new Float32Array(128), new Float32Array(128)];
      renderBlock(graph, store, pos, 128, out, createScratch(128));
      return Math.abs(out[0][64]);
    };
    // Rising from silence at 0 to full level at frame 1000.
    expect(render(0)).toBeLessThan(0.01);
    expect(render(2000)).toBeGreaterThan(0.2);
  });

  it('moves send lanes up when a send is removed', () => {
    let st = S.createSessionState({ tracks: 1 });
    const id = st.tracks[0].id;
    st = S.updateTrack(st, id, { sends: [S.createSend({ target: 'a' }), S.createSend({ target: 'b' })], lanes: ['send2', 'volume'], automation: { volume: [], pan: [], mute: [], send2: [{ t: 0, v: -3 }] } });
    st = S.removeSend(st, id, 0);
    const t = S.findTrack(st, id);
    expect(t.automation.send1).toEqual([{ t: 0, v: -3 }]);
    expect(t.automation.send2).toBeUndefined();
    expect(t.lanes).toEqual(['send1', 'volume']);
  });
});

describe('live take preview', () => {
  it('keeps one peak per block of captured input across chunks', async () => {
    const { livePeaks, PEAK_BLOCK } = await import('../src/multitrack/recorder.js');
    const live = { peaks: new Float32Array(1), count: 0, frames: 0, rate: RATE, acc: 0, accN: 0 };
    const a = new Float32Array(PEAK_BLOCK * 1.5).fill(0.1);
    a[3] = -0.9;
    const b = new Float32Array(PEAK_BLOCK * 1.5).fill(0.2);
    livePeaks(live, [a, new Float32Array(a.length)]);
    livePeaks(live, [b, b]);
    expect(live.frames).toBe(PEAK_BLOCK * 3);
    expect(live.count).toBe(3);
    expect([...live.peaks.subarray(0, 3)].map((v) => Math.round(v * 10) / 10)).toEqual([0.9, 0.2, 0.2]);
  });
});

describe('source channel routing', () => {
  it('plays the picked source channels and draws from the Properties panel', async () => {
    const { routedChannels } = await import('../src/model/session-graph.js');
    const { sessionPropertySection } = await import('../src/multitrack/properties.js');
    const L = Channel.fromSamples(new Float32Array(10).fill(0.5));
    const R = Channel.fromSamples(new Float32Array(10));
    expect(routedChannels({ channelMap: [0, 0] }, [L, R])).toEqual([L, L]);
    expect(routedChannels({ channelMap: [0, 1] }, [L, R])).toEqual([L, R]);
    expect(routedChannels({ channelMap: [0, 5] }, [L, R])).toEqual([L, R]);
    expect(routedChannels({ channelMap: null }, [L])).toEqual([L]);
    const { app, doc } = await appWithSession();
    const src = doc.addSource({ name: 'st.wav', channels: [L, R] });
    const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, start: 0, length: 10 });
    doc.apply('Insert File', S.addClips(doc.state, [clip]));
    doc.selectClips([clip.id]);
    const el = sessionPropertySection(app, doc).querySelector('[aria-label="Source channel the clip plays on the right"]');
    el.value = '0';
    el.dispatchEvent(new Event('change'));
    expect(S.findClip(doc.state, clip.id).channelMap).toEqual([0, 0]);
    const { graph, sources } = buildSessionGraph(doc.state, doc.pool);
    expect(sources.get(graph.tracks[0].clips[0].source)).toEqual([L, L]);
  });
});

describe('beat note', () => {
  it('shortens the metronome beat for eighth-note beats', async () => {
    const { metronomeBar } = await import('../src/model/session-graph.js');
    const q = metronomeBar(Channel, { sampleRate: RATE, tempo: 120, beatsPerBar: 4 })[0];
    const e = metronomeBar(Channel, { sampleRate: RATE, tempo: 120, beatsPerBar: 4, beatNote: 8 })[0];
    expect(q.length).toBe(RATE * 2);
    expect(e.length).toBe(RATE);
  });
});

describe('saving the new session settings', () => {
  it('keeps lanes, mute and send automation, holds, splines, routing and the accent pattern', async () => {
    const { serializeSession, parseSession } = await import('../src/model/session-io.js');
    const doc = new Session({ name: 'Keep.asesx', sampleRate: RATE, tracks: 1 });
    const src = doc.addSource({ name: 'a.wav', channels: [Channel.fromSamples(new Float32Array(100)), Channel.fromSamples(new Float32Array(100))] });
    let st = S.addTrack(doc.state, S.createTrack({ type: 'bus', name: 'Bus' }));
    const id = st.tracks[0].id;
    st = S.setSend(st, id, 0, { target: st.tracks[1].id });
    st = S.updateTrack(st, id, { showAutomation: true, lanes: ['mute', 'send1'], laneHeight: 60 });
    st = S.setAutomation(st, id, 'mute', [{ t: 0, v: 1, hold: true }]);
    st = S.setAutomation(st, id, 'send1', [{ t: 5, v: -3 }]);
    st = S.addClips(st, [S.createClip({ trackId: id, sourceId: src, length: 100, volumeEnv: [{ t: 0, v: -6, hold: true }, { t: 50, v: 0 }], volumeSpline: true, channelMap: [1, 1] })]);
    st = { ...st, metronomePattern: ['down', 'none', 'sub', 'up'] };
    doc.apply('Set', st);
    const { state } = parseSession(serializeSession(doc).text);
    const t = state.tracks[0];
    expect(t.lanes).toEqual(['mute', 'send1']);
    expect(t.laneHeight).toBe(60);
    expect(t.automation.mute).toEqual([{ t: 0, v: 1, hold: true }]);
    expect(t.automation.send1).toEqual([{ t: 5, v: -3 }]);
    const c = state.clips[0];
    expect(c.volumeEnv[0].hold).toBe(true);
    expect(c.volumeSpline).toBe(true);
    expect(c.channelMap).toEqual([1, 1]);
    expect(state.metronomePattern).toEqual(['down', 'none', 'sub', 'up']);
  });
});

describe('effect setting automation', () => {
  it('lists numeric effect settings as lanes and plays them through the effect host', async () => {
    const { fxAutomationParams, laneInfo, laneParams } = await import('../src/multitrack/fx-automation.js');
    const { FxHost } = await import('../src/engine/fxhost.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    st = S.updateTrack(st, id, { fx: [{ id: 'sA', effect: 'amplify', values: { left: 0, right: 0, linked: true }, enabled: true }] });
    const t = S.findTrack(st, id);
    const params = fxAutomationParams(t);
    expect(params.map((p) => p.id)).toEqual(['fx.sA.left', 'fx.sA.right', 'fx.sA.linked']);
    expect(laneParams(t)).toContain('fx.sA.left');
    const info = laneInfo(t, 'fx.sA.left');
    expect(info.label).toBe('Amplify: Left');
    expect(info.toPos(-96)).toBe(0);
    expect(info.fromPos(1)).toBe(48);
    expect(info.value).toBe(0);
    st = S.setAutomation(st, id, 'fx.sA.left', [{ t: 0, v: -12 }, { t: 1000, v: 6 }]);
    const spec = buildSessionGraph(st, new Map()).graph.tracks[0].fx[0];
    expect(spec.paramEnv).toEqual([{ index: 0, points: [{ t: 0, v: -12 }, { t: 1000, v: 6 }] }]);
    // Mode Off leaves the settings alone.
    expect(buildSessionGraph(S.updateTrack(st, id, { mode: 'off' }), new Map()).graph.tracks[0].fx[0].paramEnv).toBeUndefined();
    // The host sets the parameter from the block position.
    const calls = [];
    const host = Object.create(FxHost.prototype);
    host.x = { fx_set: (h, i, v) => calls.push([h, i, v]) };
    const inst = { handle: 7, params: [0, 0, 1] };
    host.automate({ paramEnv: spec.paramEnv, inst }, 500);
    expect(calls).toEqual([[7, 0, -3]]);
    host.automate({ paramEnv: spec.paramEnv, inst }, 500);
    expect(calls.length).toBe(1);
  });

  it('keeps effect lanes with their slot and drops them with it', () => {
    const t = S.createTrack({ showAutomation: true, lanes: ['fx.sA.left', 'volume'], fx: [{ id: 'sA', effect: 'amplify', values: {} }], automation: { 'fx.sA.left': [{ t: 0, v: 1 }] } });
    expect(t.automation['fx.sA.left']).toEqual([{ t: 0, v: 1 }]);
    expect(S.trackLanes(t)).toEqual(['fx.sA.left', 'volume']);
    expect(S.trackLanes({ ...t, fx: [] })).toEqual(['volume']);
  });
});

describe('track EQ automation', () => {
  it('offers the EQ settings while the EQ is on and automates its slot', async () => {
    const { fxAutomationParams } = await import('../src/multitrack/fx-automation.js');
    const { getEffect } = await import('../src/effects/registry.js');
    await import('../src/effects/defs/filter.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    expect(fxAutomationParams(S.findTrack(st, id)).some((p) => p.id.startsWith('fx.eq.'))).toBe(false);
    st = S.updateTrack(st, id, { eq: { on: true, values: {} } });
    const eqParams = fxAutomationParams(S.findTrack(st, id)).filter((p) => p.id.startsWith('fx.eq.'));
    expect(eqParams.length).toBeGreaterThan(0);
    const { laneInfo } = await import('../src/multitrack/fx-automation.js');
    const freq = eqParams.find((p) => p.id === 'fx.eq.band1Freq');
    expect(freq.label).toBe('Band 1 Frequency');
    const info = laneInfo(S.findTrack(st, id), freq.id);
    expect(info.toPos(10)).toBe(0);
    expect(info.toPos(20000)).toBe(1);
    expect(info.fromPos(0.5)).toBeCloseTo(Math.sqrt(10 * 20000), -1);
    const first = eqParams[0];
    st = S.setAutomation(st, id, first.id, [{ t: 0, v: first.min }, { t: 100, v: first.max }]);
    const specs = buildSessionGraph(st, new Map()).graph.tracks[0].fx;
    const eq = specs.find((sp) => sp.key === `eq:${id}:eq`);
    const index = getEffect('parametricEq').params.findIndex((p) => `fx.eq.${p.id}` === first.id);
    expect(eq.paramEnv).toEqual([{ index, points: [{ t: 0, v: first.min }, { t: 100, v: first.max }] }]);
  });
});

describe('post-fader effects', () => {
  it('runs the chain after the track volume', async () => {
    const { renderBlock, ChunkStore, createScratch, CHUNK } = await import('../src/engine/mixcore.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    st = S.updateTrack(st, id, { volume: -6, fx: [{ id: 'sA', effect: 'amplify', values: {}, enabled: true }] });
    const ch = Channel.fromSamples(new Float32Array(2000).fill(0.5));
    st = S.addClips(st, [S.createClip({ trackId: id, sourceId: 'src', start: 0, length: 2000 })]);
    const order = [];
    const run = (post) => {
      const { graph, sources } = buildSessionGraph(S.updateTrack(st, id, { fxPost: post }), new Map([['src', { channels: [ch, ch] }]]));
      expect(Boolean(graph.tracks[0].fxPost)).toBe(post);
      const store = new ChunkStore();
      for (const [key, chs] of sources) store.put(key, 0, chs.map((c) => c.toArray(0, Math.min(CHUNK, c.length))));
      const out = [new Float32Array(128), new Float32Array(128)];
      // A stand-in effect that records the level it sees.
      renderBlock(graph, store, 0, 128, out, createScratch(128), { runFx: (chain, buf) => order.push(buf[0][10]) });
      return order.pop();
    };
    // Pre-fader the effect gets the clip as it is; post-fader, after -6 dB.
    expect(run(false)).toBeCloseTo(0.5, 3);
    expect(run(true)).toBeLessThan(0.3);
  });
});

describe('thinning recorded automation', () => {
  it('drops points on a straight line and keeps corners, ends and holds', () => {
    const ramp = Array.from({ length: 11 }, (_, i) => ({ t: i * 10, v: i }));
    expect(S.thinEnvelope(ramp, 0.1)).toEqual([ramp[0], ramp[10]]);
    const corner = [{ t: 0, v: 0 }, { t: 10, v: 0 }, { t: 20, v: 0 }, { t: 30, v: 10 }, { t: 40, v: 10 }];
    expect(S.thinEnvelope(corner, 0.1).map((p) => p.t)).toEqual([0, 20, 30, 40]);
    const held = [{ t: 0, v: 0 }, { t: 5, v: 0, hold: true }, { t: 10, v: 0 }];
    expect(S.thinEnvelope(held, 1)).toEqual(held);
  });
});

describe('effect dialog edits on automated settings', () => {
  it('write a keyframe at the playhead instead of changing the setting', async () => {
    const { automatedChanges } = await import('../src/multitrack/fx-slots.js');
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    doc.apply('Fx', S.updateTrack(doc.state, id, { fx: [{ id: 'sA', effect: 'amplify', values: { left: 0, right: 0, linked: true }, enabled: true }] }));
    doc.apply('Auto', S.setAutomation(doc.state, id, 'fx.sA.left', [{ t: 0, v: -6 }]));
    doc.controls = new TrackControls(app, doc);
    doc.setCursor(RATE);
    const sent = automatedChanges(doc, id, 'sA', { left: 0, right: 0, linked: true }, { left: 3, right: 2, linked: true });
    expect([...sent]).toEqual(['left']);
    expect(S.findTrack(doc.state, id).automation['fx.sA.left']).toEqual([{ t: 0, v: -6 }, { t: RATE, v: 3 }]);
  });
});

describe('switch and choice lanes', () => {
  it('offers switches and choices as stepped lanes and plays them as steps', async () => {
    const { fxAutomationParams, laneInfo } = await import('../src/multitrack/fx-automation.js');
    await import('../src/effects/defs/filter.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    st = S.updateTrack(st, id, { eq: { on: true, values: {} } });
    const t = S.findTrack(st, id);
    const params = fxAutomationParams(t);
    const hpOn = params.find((p) => p.id === 'fx.eq.hpOn');
    const slope = params.find((p) => p.id === 'fx.eq.hpSlope');
    expect(hpOn.kind).toBe('bool');
    expect(slope.kind).toBe('choice');
    const on = laneInfo(t, 'fx.eq.hpOn');
    expect(on.stepped).toBe(true);
    expect(on.fromPos(0.8)).toBe(1);
    expect(on.format(1)).toBe('High Pass On');
    expect(on.format(0)).toBe('High Pass Off');
    const ch = laneInfo(t, 'fx.eq.hpSlope');
    expect(ch.fromPos(1)).toBe(slope.options[slope.options.length - 1].value);
    st = S.setAutomation(st, id, 'fx.eq.hpOn', [{ t: 0, v: 0 }, { t: 1000, v: 1 }]);
    const eq = buildSessionGraph(st, new Map()).graph.tracks[0].fx.find((sp) => sp.key === `eq:${id}:eq`);
    const env = eq.paramEnv[0].points;
    // Off until frame 1000, then on: a step, not a ramp.
    expect(S.envelopeValue(env, 500)).toBe(0);
    expect(S.envelopeValue(env, 1000)).toBe(1);
  });
});

describe('clip effect envelopes', () => {
  it('split, trim and play with the clip', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    const ch = Channel.fromSamples(new Float32Array(4000));
    const clip = S.createClip({ trackId: id, sourceId: 'src', start: 1000, length: 2000, fx: [{ id: 'cA', effect: 'amplify', values: {}, enabled: true }], fxEnv: { 'fx.cA.left': [{ t: 0, v: -12 }, { t: 2000, v: 0 }], bogus: [{ t: 0, v: 1 }] } });
    expect(Object.keys(clip.fxEnv)).toEqual(['fx.cA.left']);
    st = S.addClips(st, [clip]);
    const spec = buildSessionGraph(st, new Map([['src', { channels: [ch] }]])).graph.tracks[0].clips[0].fx[0];
    // On the timeline: shifted by the clip start.
    expect(spec.paramEnv).toEqual([{ index: 0, points: [{ t: 1000, v: -12 }, { t: 3000, v: 0 }] }]);
    const [a, b] = S.splitClip(S.findClip(st, clip.id), 2000);
    expect(a.fxEnv['fx.cA.left'].at(-1)).toEqual({ t: 1000, v: -6 });
    expect(b.fxEnv['fx.cA.left'][0]).toEqual({ t: 0, v: -6 });
    const trimmed = S.trimmedClip(S.findClip(st, clip.id), 'in', 1500);
    expect(trimmed.fxEnv['fx.cA.left'][0].v).toBe(-9);
    st = S.setClipEnvelope(st, clip.id, 'fx.cA.left', []);
    expect(S.findClip(st, clip.id).fxEnv).toEqual({});
  });
});

describe('frozen tracks', () => {
  it('play their pre-render while it matches the track, and render only the track', async () => {
    const { freezeKey } = await import('../src/model/session-graph.js');
    const { freezeState, canFreeze } = await import('../src/multitrack/freeze.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 2 });
    const [a, b] = st.tracks;
    const ch = Channel.fromSamples(new Float32Array(1000).fill(0.1));
    const pool = new Map([['src', { channels: [ch, ch] }]]);
    st = S.addClips(st, [S.createClip({ trackId: a.id, sourceId: 'src', length: 1000 }), S.createClip({ trackId: b.id, sourceId: 'src', length: 1000 })]);
    st = S.updateTrack(st, a.id, { freeze: true, volume: -6, pan: 30, fx: [{ id: 'sA', effect: 'amplify', values: {}, enabled: true }], automation: { volume: [{ t: 0, v: -3 }], pan: [], mute: [], 'fx.sA.left': [{ t: 0, v: 2 }] } });
    expect(canFreeze(st, S.findTrack(st, a.id))).toBe(true);
    // 5.1 sessions keep their tracks live.
    expect(canFreeze({ ...st, master: { ...st.master, channels: 6 } }, S.findTrack(st, a.id))).toBe(false);
    const render = Channel.fromSamples(new Float32Array(5000));
    const frozen = new Map([[a.id, { key: freezeKey(st, S.findTrack(st, a.id), pool), channels: [render, render], length: 5000 }]]);
    const gt = buildSessionGraph(st, pool, { frozen }).graph.tracks[0];
    expect(gt.fx).toEqual([]);
    expect(gt.clips).toHaveLength(1);
    expect(gt.clips[0].length).toBe(5000);
    // Volume automation stays live.
    expect(gt.volumeEnv).toBeTruthy();
    // A clip edit makes the render stale: the track plays live again.
    const moved = S.moveClips(st, [st.clips[0].id], 100, 0);
    expect(buildSessionGraph(moved, pool, { frozen }).graph.tracks[0].fx.length).toBe(1);
    // Volume changes do not.
    expect(buildSessionGraph(S.updateTrack(st, a.id, { volume: 3 }), pool, { frozen }).graph.tracks[0].fx).toEqual([]);
    const fs = freezeState(st, a.id);
    expect(fs.tracks.map((t) => t.id)).toEqual([a.id]);
    expect(fs.clips.every((c) => c.trackId === a.id)).toBe(true);
    expect(fs.tracks[0].volume).toBe(0);
    expect(fs.tracks[0].automation.volume).toEqual([]);
    expect(fs.tracks[0].automation['fx.sA.left']).toEqual([{ t: 0, v: 2 }]);
  });
});

describe('smart input monitoring', () => {
  it('monitors an armed track while stopped, not during playback', async () => {
    const { SmartMonitor } = await import('../src/multitrack/monitor.js');
    const { Emitter } = await import('../src/lib/emitter.js');
    const links = [];
    const node = { connect: (d) => links.push(['node', d]), disconnect: () => links.push(['node-off']) };
    const engine = Object.assign(new Emitter(), { playing: false, ctx: { createGain: () => node, destination: 'out' }, input: { src: { connect: (n) => links.push(['src', n]), disconnect: () => links.push(['src-off']) } } });
    const app = Object.assign(new Emitter(), { engine, recording: false, active: null });
    const doc = new Session({ name: 'M.asesx', sampleRate: RATE, tracks: 1 });
    app.active = doc;
    const mon = new SmartMonitor(app);
    mon.sync();
    expect(mon.active).toBe(false);
    doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[0].id, { arm: true, monitor: true }));
    mon.sync();
    expect(mon.active).toBe(true);
    expect(links).toContainEqual(['node', 'out']);
    engine.playing = true;
    mon.sync();
    expect(mon.active).toBe(false);
    engine.playing = false;
    app.recording = false;
    mon.sync();
    expect(mon.active).toBe(true);
  });
});

describe('ripple edits and automation', () => {
  it('closes the gap of rippled clips in their track automation', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 2 });
    const [a, b] = st.tracks;
    const c1 = S.createClip({ trackId: a.id, sourceId: 's', start: 1000, length: 1000 });
    const c2 = S.createClip({ trackId: a.id, sourceId: 's', start: 3000, length: 1000 });
    st = S.addClips(st, [c1, c2]);
    st = S.setAutomation(st, a.id, 'volume', [{ t: 0, v: 0 }, { t: 3500, v: -12 }]);
    st = S.setAutomation(st, b.id, 'volume', [{ t: 3500, v: -6 }]);
    const r = S.rippleDeleteClips(st, [c1.id]);
    expect(S.findClip(r, c2.id).start).toBe(2000);
    // The keyframe under the moved clip moves with it; another track's lane stays.
    expect(S.findTrack(r, a.id).automation.volume.at(-1)).toEqual({ t: 2500, v: -12 });
    expect(S.findTrack(r, b.id).automation.volume).toEqual([{ t: 3500, v: -6 }]);
  });
});

describe('saving open files with a session', () => {
  it('keeps referenced files without clips in the saved session', async () => {
    const { serializeSession, parseSession } = await import('../src/model/session-io.js');
    const { referenceOpenFiles } = await import('../src/multitrack/storage.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { app, doc } = await appWithSession();
    const file = new AudioFile({ name: 'loose.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(480).fill(0.2))] });
    app.addDocument(file, { activate: false });
    expect(parseSession(serializeSession(doc).text).sources).toHaveLength(0);
    await referenceOpenFiles(app, doc);
    const saved = parseSession(serializeSession(doc).text);
    expect(saved.sources.map((x) => x.name)).toEqual(['loose.wav']);
  });
});

describe('exporting a session with converted media', () => {
  it('writes its media at the chosen sample type', async () => {
    const { prepareSessionZip } = await import('../src/multitrack/storage.js');
    const { unzipStore } = await import('../src/lib/zip.js');
    const doc = new Session({ name: 'Ex.asesx', sampleRate: RATE, tracks: 1 });
    const src = doc.addSource({ name: 'a.wav', channels: [Channel.fromSamples(new Float32Array(1000).fill(0.25)), Channel.fromSamples(new Float32Array(1000))] });
    doc.apply('Insert', S.addClips(doc.state, [S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, length: 1000 })]));
    const bits = async (bitDepth) => {
      const { blob } = await prepareSessionZip(doc, { bitDepth });
      const files = unzipStore(await blob.arrayBuffer());
      const wav = [...files.entries()].find(([k]) => k.endsWith('.wav'))[1];
      return new DataView(wav.buffer, wav.byteOffset).getUint16(34, true);
    };
    expect(await bits(32)).toBe(32);
    expect(await bits(16)).toBe(16);
    expect(await bits(24)).toBe(24);
  });
});

describe('inserting a file channel by channel', () => {
  it('puts each channel in its own clip on its own mono track', async () => {
    const { insertDocs, placementOptions } = await import('../src/multitrack/insert.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { app, doc } = await appWithSession();
    const file = new AudioFile({ name: 'interview.wav', sampleRate: RATE, channels: [Channel.fromSamples(new Float32Array(480).fill(0.5)), Channel.fromSamples(new Float32Array(480).fill(-0.5))] });
    app.addDocument(file, { activate: false });
    app.activate(doc);
    placementOptions.splitChannels = true;
    try {
      const ids = await insertDocs(app, doc, [file], { at: 0, trackId: null });
      const clips = ids.map((id) => S.findClip(doc.state, id));
      expect(clips.map((c) => [c.name, c.channelMap])).toEqual([['interview (L)', [0, 0]], ['interview (R)', [1, 1]]]);
      expect(new Set(clips.map((c) => c.trackId)).size).toBe(2);
      expect(clips.every((c) => S.findTrack(doc.state, c.trackId).channels === 1)).toBe(true);
      expect(clips[0].sourceId).toBe(clips[1].sourceId);
    } finally {
      placementOptions.splitChannels = false;
    }
  });
});

describe('stacked takes', () => {
  it('plays the chosen take and mutes the others', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    const takes = [0, 1, 2].map((i) => S.createClip({ trackId: id, sourceId: `s${i}`, start: 100, length: 50, mute: i < 2, takeGroup: 'tg' }));
    st = S.addClipsOnTop(st, takes);
    expect(S.takeClips(st, 'tg').map((c) => c.id)).toEqual(takes.map((c) => c.id));
    st = S.selectTake(st, takes[0].id);
    expect(S.takeClips(st, 'tg').map((c) => c.mute)).toEqual([false, true, true]);
    const order = S.frontOrder(st);
    expect(order.get(takes[0].id)).toBeGreaterThan(order.get(takes[2].id));
  });
});

describe('freezing post-fader tracks and clicking in lanes', () => {
  it('renders the fader into a post-fader freeze and keeps mute live', async () => {
    const { freezeKey } = await import('../src/model/session-graph.js');
    const { freezeState, canFreeze } = await import('../src/multitrack/freeze.js');
    let st = S.createSessionState({ sampleRate: RATE, tracks: 1 });
    const id = st.tracks[0].id;
    const ch = Channel.fromSamples(new Float32Array(1000));
    const pool = new Map([['src', { channels: [ch, ch] }]]);
    st = S.addClips(st, [S.createClip({ trackId: id, sourceId: 'src', length: 1000 })]);
    st = S.updateTrack(st, id, { freeze: true, fxPost: true, volume: -6, pan: 20, fx: [{ id: 'sA', effect: 'amplify', values: {}, enabled: true }] });
    st = S.setAutomation(st, id, 'mute', [{ t: 500, v: 1, hold: true }]);
    const t = S.findTrack(st, id);
    expect(canFreeze(st, t)).toBe(true);
    expect(freezeState(st, id).tracks[0].volume).toBe(-6);
    const render = Channel.fromSamples(new Float32Array(2000));
    const frozen = new Map([[id, { key: freezeKey(st, t, pool), channels: [render, render], length: 2000 }]]);
    const gt = buildSessionGraph(st, pool, { frozen }).graph.tracks[0];
    expect(gt.clips[0].id).toBe(`frozen:${id}`);
    expect([gt.gain, gt.pan]).toEqual([1, 0]);
    expect(S.envelopeValue(gt.volumeEnv, 900)).toBe(0);
    // A volume change makes a post-fader render stale.
    expect(buildSessionGraph(S.updateTrack(st, id, { volume: 0 }), pool, { frozen }).graph.tracks[0].fx.length).toBe(1);
    // A pre-fader send needs the dry signal.
    expect(canFreeze(st, { ...t, sends: [S.createSend({ target: 'b', pre: true })] })).toBe(false);
  });
});

describe('automation that follows clips', () => {
  it('moves the keyframes under a clip with it', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 2 });
    const id = st.tracks[0].id;
    const c = S.createClip({ trackId: id, sourceId: 's', start: 1000, length: 1000 });
    st = S.addClips(st, [c]);
    st = S.setAutomation(st, id, 'volume', [{ t: 0, v: 0 }, { t: 1500, v: -12 }, { t: 5000, v: 0 }]);
    const moved = S.moveClips(st, [c.id], 2000, 0);
    const out = S.carryAutomation(st, moved, [c.id]);
    const lane = S.findTrack(out, id).automation.volume;
    expect(lane.find((p) => p.v === -12).t).toBe(3500);
    expect(lane.some((p) => p.t === 1500)).toBe(false);
    // Moving to another track takes the keyframes to its matching lane.
    const across = S.moveClips(st, [c.id], 2000, 1);
    const over = S.carryAutomation(st, across, [c.id]);
    expect(over.tracks[1].automation.volume.find((p) => p.v === -12).t).toBe(3500);
    expect(over.tracks[0].automation.volume.some((p) => p.v === -12)).toBe(false);
    // A send lane the destination does not have stays put.
    let sends = S.setSend(st, id, 0, { target: 'bus1' });
    sends = S.setAutomation(sends, id, 'send1', [{ t: 1200, v: -3 }]);
    const kept = S.carryAutomation(sends, S.moveClips(sends, [c.id], 0, 1), [c.id]);
    expect(kept.tracks[0].automation.send1).toEqual([{ t: 1200, v: -3 }]);
  });
});

describe('exporting a session as FLAC or at another rate', () => {
  it('converts the media copies and names them for their format', async () => {
    const { prepareSessionZip } = await import('../src/multitrack/storage.js');
    const { unzipStore } = await import('../src/lib/zip.js');
    const { parseSession } = await import('../src/model/session-io.js');
    const { setDspBytes } = await import('../src/audio/dsp.js');
    const fs = await import('node:fs');
    setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
    const doc = new Session({ name: 'Fl.asesx', sampleRate: RATE, tracks: 1 });
    const tone = new Float32Array(4800).map((_, i) => Math.sin(i / 10) * 0.5);
    const src = doc.addSource({ name: 'a.wav', channels: [Channel.fromSamples(tone), Channel.fromSamples(tone)] });
    doc.apply('Insert', S.addClips(doc.state, [S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, length: 4800 })]));
    const pick = async (media) => {
      const files = unzipStore(await (await prepareSessionZip(doc, { media })).blob.arrayBuffer());
      const manifest = parseSession(new TextDecoder().decode(files.get([...files.keys()].find((k) => k.endsWith('.asesx')))));
      const [name, bytes] = [...files.entries()].find(([k]) => !k.endsWith('.asesx'));
      return { name, bytes, manifest };
    };
    const wav = await pick({ format: 'wav', bitDepth: 24, rate: 44100 });
    expect(wav.name.endsWith('.wav')).toBe(true);
    const dv = new DataView(wav.bytes.buffer, wav.bytes.byteOffset);
    expect(dv.getUint32(24, true)).toBe(44100);
    expect(dv.getUint16(34, true)).toBe(24);
    expect(wav.manifest.sources[0].sampleRate).toBe(44100);
    // The session keeps its own rate.
    expect(wav.manifest.state.sampleRate).toBe(RATE);
    const flac = await pick({ format: 'flac', bitDepth: 16, rate: RATE });
    expect(flac.name.endsWith('.flac')).toBe(true);
    expect(new TextDecoder().decode(flac.bytes.subarray(0, 4))).toBe('fLaC');
    expect(flac.manifest.sources[0].file.endsWith('.flac')).toBe(true);
  });
});
