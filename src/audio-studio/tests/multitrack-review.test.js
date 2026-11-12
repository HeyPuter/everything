// Regression tests for multitrack fixes from the second adversarial review.
import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { ChunkStore, renderBlock, createScratch, CHUNK } from '../src/engine/mixcore.js';

// Offline renders run through mixcore on the main thread (no worker in jsdom).
function renderNow(graph, sources, { start = 0, end }) {
  const store = new ChunkStore();
  for (const [key, chans] of sources) {
    const n = chans[0].length;
    for (let i = 0; i * CHUNK < n; i++)
      store.put(
        key,
        i,
        chans.map((c) => c.toArray(i * CHUNK, Math.min(n, (i + 1) * CHUNK))),
      );
  }
  const nch = graph.surround ? 6 : 2;
  const out = Array.from({ length: nch }, () => new Float32Array(end - start));
  const scratch = createScratch(128);
  const block = Array.from({ length: nch }, () => new Float32Array(128));
  for (let at = start; at < end; at += 128) {
    const n = Math.min(128, end - at);
    renderBlock(graph, store, at, n, block, scratch);
    for (let c = 0; c < nch; c++) out[c].set(block[c].subarray(0, n), at - start);
  }
  return out;
}

vi.mock('../src/engine/offline.js', () => ({
  renderGraph: async (graph, sources, o) => renderNow(graph, sources, o),
}));

const RATE = 48000;

async function appWithSession({ tracks = 3 } = {}) {
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
  const doc = new Session({ name: 'Test.asesx', sampleRate: RATE, tracks });
  app.addDocument(doc);
  return { app, doc };
}

/** Renders a track of a session state as heard (through the track, before the master). */
function renderState(state, pool, panLaw, end) {
  const { graph, sources } = buildSessionGraph(state, pool, { panLaw });
  return renderNow(graph, sources, { start: 0, end });
}

describe('merging clips', () => {
  it('sounds the same after the merge with track EQ, polarity and an equal-power pan law', async () => {
    const { app, doc } = await appWithSession();
    app.prefs.set('panLaw', 'equalPower');
    app.prefs.set('panLawDb', -3);
    const ramp = new Float32Array(RATE).map((_, i) => 0.5 * Math.sin(i / 7));
    const src = doc.addSource({
      name: 'tone.wav',
      channels: [Channel.fromSamples(ramp), Channel.fromSamples(ramp)],
    });
    const t = doc.state.tracks[0];
    const a = S.createClip({ trackId: t.id, sourceId: src, start: 0, length: 4000, gain: -2 });
    const b = S.createClip({
      trackId: t.id,
      sourceId: src,
      start: 4000,
      offset: 4000,
      length: 4000,
      fadeOut: { length: 1000, curve: 0 },
    });
    let st = S.addClips(doc.state, [a, b]);
    st = S.updateTrack(st, t.id, { invert: true, pan: 30, eq: { on: true, values: {} } });
    doc.apply('Setup', st);
    const law = { mode: 'equalPower', centerDb: -3 };
    const before = renderState(doc.state, doc.pool, law, 8000);
    doc.selectClips([a.id, b.id]);
    await app.commands.run('clip.merge');
    expect(doc.state.clips.length).toBe(1);
    // The merged clip carries the clips' own sound, not the track's EQ (which still runs on the track).
    const merged = doc.state.clips[0];
    const after = renderState(doc.state, doc.pool, law, 8000);
    for (const i of [100, 2500, 4100, 7500]) {
      expect(after[0][i]).toBeCloseTo(before[0][i], 5);
      expect(after[1][i]).toBeCloseTo(before[1][i], 5);
    }
    expect(merged.length).toBe(8000);
  });
});

describe('pasting and inserting with hidden tracks', () => {
  const dc = (doc) =>
    doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.25))],
    });

  it('pastes clips copied from two tracks onto shown tracks only', async () => {
    const { app, doc } = await appWithSession({ tracks: 4 });
    const [t0, t1, t2, t3] = doc.state.tracks.map((t) => t.id);
    const src = dc(doc);
    const a = S.createClip({ trackId: t0, sourceId: src, start: 0, length: 1000 });
    const b = S.createClip({ trackId: t2, sourceId: src, start: 0, length: 1000 });
    doc.apply('Add', S.addClips(doc.state, [a, b]));
    // Track 2 (between the two copied clips) is hidden: they sit on adjacent shown rows.
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    doc.selectClips([a.id, b.id]);
    await app.commands.run('edit.copy');
    doc.selectClips([]);
    doc.selectTrack(t2);
    doc.setCursor(RATE / 2);
    await app.commands.run('edit.paste');
    const pasted = doc.clipSelection;
    expect(pasted.length).toBe(2);
    // The top clip lands on the selected track, the other on the next shown track (not a hidden one).
    expect(pasted.map((c) => c.trackId).sort()).toEqual([t2, t3].sort());
  });

  it('pastes onto the next shown track when the one below is hidden', async () => {
    const { app, doc } = await appWithSession({ tracks: 3 });
    const [t0, t1, t2] = doc.state.tracks.map((t) => t.id);
    const src = dc(doc);
    const a = S.createClip({ trackId: t0, sourceId: src, start: 0, length: 1000 });
    const b = S.createClip({ trackId: t1, sourceId: src, start: 0, length: 1000 });
    doc.apply('Add', S.addClips(doc.state, [a, b]));
    doc.selectClips([a.id, b.id]);
    await app.commands.run('edit.copy');
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    doc.selectClips([]);
    doc.selectTrack(t0);
    doc.setCursor(RATE);
    await app.commands.run('edit.paste');
    const pasted = doc.clipSelection;
    expect(pasted.map((c) => c.trackId).sort()).toEqual([t0, t2].sort());
    expect(pasted.every((c) => !S.findTrack(doc.state, c.trackId).hidden)).toBe(true);
  });

  it('inserts several files onto shown tracks only', async () => {
    const { app, doc } = await appWithSession({ tracks: 3 });
    const [t0, t1, t2] = doc.state.tracks.map((t) => t.id);
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    doc.selectTrack(t0);
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { insertDocs } = await import('../src/multitrack/insert.js');
    const file = (name) =>
      new AudioFile({
        name,
        sampleRate: RATE,
        channels: [Channel.fromSamples(new Float32Array(1000).fill(0.1))],
      });
    const ids = await insertDocs(app, doc, [file('a.wav'), file('b.wav')], { at: 0 });
    const tracks = ids.map((id) => S.findClip(doc.state, id).trackId);
    expect(tracks).toEqual([t0, t2]);
  });
});

describe('saving a session to Puter', () => {
  function fakePuter() {
    const writes = [];
    let release;
    const gate = { open: Promise.resolve() };
    window.puter = {
      env: 'web',
      auth: { isSignedIn: () => true },
      fs: {
        write: async (path, data) => {
          writes.push(path);
          await gate.open;
          return { path };
        },
      },
    };
    return {
      writes,
      hold: () => (gate.open = new Promise((r) => (release = r))),
      release: () => release(),
    };
  }

  it('keeps edits made while the media uploads unsaved, and writes changed media at the next save', async () => {
    const { app, doc } = await appWithSession();
    const p = fakePuter();
    try {
      const t = doc.state.tracks[0];
      const src = doc.addSource({
        name: 'a.wav',
        channels: [Channel.fromSamples(new Float32Array(100).fill(0.1))],
      });
      doc.apply(
        'Add',
        S.addClips(doc.state, [S.createClip({ trackId: t.id, sourceId: src, length: 100 })]),
      );
      doc.source = { type: 'puter', path: '/u/AudioStudio/Test.asesx' };
      p.hold();
      const saving = app.commands.run('file.save');
      await new Promise((r) => setTimeout(r, 0));
      // While the media file uploads: a clip edit and an edit of the source audio.
      doc.apply('Rename Track', S.updateTrack(doc.state, t.id, { name: 'Edited' }));
      doc.updateSource(src, { channels: [Channel.fromSamples(new Float32Array(100).fill(0.2))] });
      p.release();
      await saving;
      expect(doc.dirty).toBe(true);
      // The next save writes the changed media again.
      p.writes.length = 0;
      await app.commands.run('file.save');
      expect(p.writes.some((w) => w.endsWith('.wav'))).toBe(true);
      expect(doc.dirty).toBe(false);
    } finally {
      delete window.puter;
    }
  });
});

describe('sends picked out of order', () => {
  it('fills the sends before a picked one, so the session saves and opens again', async () => {
    const { serializeSession, parseSession } = await import('../src/model/session-io.js');
    const doc = new Session({
      name: 'R.asesx',
      tracks: 0,
      template: [{ name: 'A' }, { name: 'B', type: 'bus' }, { name: 'C', type: 'bus' }],
    });
    const [a, b, c] = doc.state.tracks;
    // The send selector shows S1..S8: editing S4 of a track without sends.
    let st = S.setSend(doc.state, a.id, 3, { target: b.id, level: -6 });
    const sends = st.tracks[0].sends;
    expect(sends.length).toBe(4);
    expect([0, 1, 2].every((i) => i in sends && sends[i].target === null)).toBe(true);
    expect(sends[3]).toMatchObject({ target: b.id, level: -6 });
    expect(S.wouldCycle(st, c.id, a.id)).toBe(false);
    doc.apply('Send', st);
    const back = parseSession(serializeSession(doc).text).state;
    expect(back.tracks[0].sends[3]).toMatchObject({ target: b.id, level: -6 });
    // Sessions saved with gaps (null entries) open too.
    const text = serializeSession(doc).text.replace(/"sends": \[/, '"sends": [null, ');
    const gaps = parseSession(text).state.tracks[0].sends;
    expect(gaps.length).toBe(5);
    expect(gaps[0].target).toBe(null);
    expect(gaps[4].target).toBe(b.id);
  });
});

describe('bouncing to a new track', () => {
  it('leaves the master out of the bounce, since the new track plays through it again', async () => {
    const { app, doc } = await appWithSession();
    const t = doc.state.tracks[0];
    const src = doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.5))],
    });
    const c = S.createClip({ trackId: t.id, sourceId: src, start: 0, length: 2000 });
    let st = S.addClips(doc.state, [c]);
    st = S.updateTrack(st, t.id, { volume: -6.0206 });
    st = S.updateTrack(st, st.master.id, { volume: -6.0206, invert: true });
    doc.apply('Setup', st);
    const heard = renderState(doc.state, doc.pool, null, 2000)[0][1000];
    for (const cmd of ['mt.bounceClips', 'mt.bounceTime']) {
      doc.selectClips([c.id]);
      doc.setSelection(0, 2000);
      await app.commands.run(cmd);
      const bounced = doc.clipSelection[0];
      expect(bounced.id).not.toBe(c.id);
      // The track's volume is in the bounce; the master's volume and polarity are not.
      expect(doc.pool.get(bounced.sourceId).channels[0].toArray(1000, 1001)[0]).toBeCloseTo(
        0.25,
        4,
      );
      // Played back with the original muted, the bounce sounds like the clip did.
      const only = S.updateClips(doc.state, [c.id], { mute: true });
      expect(renderState(only, doc.pool, null, 2000)[0][1000]).toBeCloseTo(heard, 4);
      doc.history.undo();
    }
  });
});

describe('master track header', () => {
  it('has no Solo button (soloing the master does nothing)', async () => {
    const { app, doc } = await appWithSession();
    const view = app.documentKinds.get('session').view(app, doc);
    const master = view.headers.get(doc.state.master.id);
    expect(master.el.querySelector('.mt-tb-mute')).not.toBe(null);
    expect(master.el.querySelector('.mt-tb-solo')).toBe(null);
    expect(view.headers.get(doc.state.tracks[0].id).el.querySelector('.mt-tb-solo')).not.toBe(null);
  });
});

describe('master mute', () => {
  it('silences the mix', () => {
    const doc = new Session({ name: 'M.asesx', sampleRate: RATE, tracks: 1 });
    const src = doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(1000).fill(0.5))],
    });
    let st = S.addClips(doc.state, [
      S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, length: 1000 }),
    ]);
    expect(renderState(st, doc.pool, null, 500)[0][100]).toBeCloseTo(0.5);
    st = S.updateTrack(st, st.master.id, { mute: true });
    expect(renderState(st, doc.pool, null, 500)[0][100]).toBe(0);
    // With master volume automation too.
    st = S.updateTrack(st, st.master.id, { automation: { volume: [{ t: 0, v: 0 }], pan: [] } });
    expect(renderState(st, doc.pool, null, 500)[0][100]).toBe(0);
  });
});

describe('typed track levels', () => {
  it('ignores empty text instead of jumping to 0 dB or centre', async () => {
    const { parseGain, parsePan } = await import('../src/multitrack/levels.js');
    expect(parseGain('')).toBeNaN();
    expect(parseGain('  dB ')).toBeNaN();
    expect(parsePan(' ')).toBeNaN();
    expect(parseGain('-6 dB')).toBe(-6);
    expect(parseGain('-∞')).toBe(S.SILENT_DB);
    expect(parsePan('L30')).toBe(-30);
    expect(parsePan('C')).toBe(0);
  });

  it('keeps the volume when the track header readout is cleared', async () => {
    const { app, doc } = await appWithSession();
    const t = doc.state.tracks[0];
    doc.apply('Volume', S.updateTrack(doc.state, t.id, { volume: -18 }));
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    const num = view.headers.get(t.id).volNum;
    num.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = view.headers.get(t.id).el.querySelector('input.hot-edit');
    input.value = '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(S.findTrack(doc.state, t.id).volume).toBe(-18);
  });
});

describe('ripple deletes and track automation', () => {
  const lane = [
    { t: 0, v: 0 },
    { t: 100, v: -10 },
    { t: 300, v: -20 },
    { t: 400, v: 5 },
  ];
  const check = (before, after, a, b) => {
    for (let t = 0; t < 600; t += 7) {
      const want = S.envelopeValue(before, t < a ? t : t + (b - a));
      expect(S.envelopeValue(after, t)).toBeCloseTo(want, 6);
    }
  };

  it('removes the time from the lanes of the tracks that ripple', () => {
    let s = S.createSessionState({ tracks: 2 });
    const [t0, t1] = s.tracks.map((t) => t.id);
    for (const id of [t0, t1, s.master.id]) s = S.setAutomation(s, id, 'volume', lane);
    s = S.setAutomation(s, t0, 'pan', [{ t: 150, v: 50 }]);
    const all = S.rippleDeleteTime(s, 50, 200);
    for (const t of [...all.tracks, all.master]) check(lane, t.automation.volume, 50, 200);
    check([{ t: 150, v: 50 }], all.tracks[0].automation.pan, 50, 200);
    // One track: only its lane moves.
    const one = S.rippleDeleteTime(s, 50, 200, { trackIds: [t0] });
    check(lane, one.tracks[0].automation.volume, 50, 200);
    expect(one.tracks[1].automation.volume).toBe(s.tracks[1].automation.volume);
    expect(one.master.automation.volume).toBe(s.master.automation.volume);
    // From the session start, and past the last point.
    check(lane, S.rippleDeleteTime(s, 0, 120).tracks[0].automation.volume, 0, 120);
    expect(S.rippleDeleteTime(s, 500, 600).tracks[0].automation.volume).toBe(
      s.tracks[0].automation.volume,
    );
  });

  it('leaves the lanes alone when only selected clips ripple, and follows a gap ripple', () => {
    let s = S.createSessionState({ tracks: 1 });
    const t0 = s.tracks[0].id;
    s = S.setAutomation(s, t0, 'volume', lane);
    const a = S.createClip({ trackId: t0, sourceId: 'x', start: 0, length: 50 });
    const b = S.createClip({ trackId: t0, sourceId: 'x', start: 200, length: 100 });
    s = S.addClips(s, [a, b]);
    expect(S.rippleDeleteTime(s, 20, 40, { ids: [a.id] }).tracks[0].automation).toBe(
      s.tracks[0].automation,
    );
    const gap = S.rippleDeleteGap(s, t0, 100);
    expect(gap.clips.find((c) => c.id === b.id).start).toBe(50);
    check(lane, gap.tracks[0].automation.volume, 50, 200);
  });
});

describe('turning looping off', () => {
  it('keeps playing the loop where it was, ending with the source', async () => {
    const { app, doc } = await appWithSession();
    const ramp = new Float32Array(1000).map((_, i) => i / 1000);
    const src = doc.addSource({ name: 'r.wav', channels: [Channel.fromSamples(ramp)] });
    const loop = S.createClip({
      trackId: doc.state.tracks[0].id,
      sourceId: src,
      length: 5000,
      loop: true,
      fadeOut: { length: 800, curve: 0 },
    });
    doc.apply('Add', S.splitClips(S.addClips(doc.state, [loop]), null, 2500));
    const right = doc.state.clips.find((c) => c.start === 2500);
    expect(right.offset).toBe(2500);
    doc.selectClips([right.id]);
    await app.commands.run('clip.loop');
    const c = S.findClip(doc.state, right.id);
    expect(c.loop).toBe(false);
    // The loop was half way through the source at 2500: that is where the unlooped clip starts.
    expect(c.offset).toBe(500);
    expect(c.length).toBe(500);
    expect(c.fadeOut.length).toBe(500);
    const out = renderState(doc.state, doc.pool, null, 3000);
    expect(out[0][2600]).toBeGreaterThan(0.3);
    // Undo brings the loop back; looping again keeps the clip as it is.
    doc.history.undo();
    expect(S.findClip(doc.state, right.id)).toEqual(right);
  });
});

describe('bouncing in a 5.1 session', () => {
  it('puts six-channel bounces on a 5.1 track', async () => {
    const { app, doc } = await appWithSession();
    const st0 = { ...doc.state, master: { ...doc.state.master, channels: 6 } };
    const t = S.createTrack({ name: 'Surround', channels: 6 });
    const six = Array.from({ length: 6 }, (_, i) =>
      Channel.fromSamples(new Float32Array(2000).fill(0.1 * (i + 1))),
    );
    const src = doc.addSource({ name: 'six.wav', channels: six });
    const c = S.createClip({ trackId: t.id, sourceId: src, length: 2000 });
    doc.apply('Setup', S.addClips(S.addTrack(st0, t, 0), [c]));
    const heard = renderState(doc.state, doc.pool, null, 2000).map((ch) => ch[1000]);
    for (const cmd of ['mt.bounceTrack', 'mt.bounceClips']) {
      doc.selectTrack(t.id);
      doc.selectClips([c.id]);
      await app.commands.run(cmd);
      const bounced = doc.clipSelection[0];
      expect(doc.pool.get(bounced.sourceId).channels.length).toBe(6);
      expect(S.findTrack(doc.state, bounced.trackId).channels).toBe(6);
      // With the original muted, the bounce plays the same six channels.
      const only = S.updateClips(doc.state, [c.id], { mute: true });
      const out = renderState(only, doc.pool, null, 2000).map((ch) => ch[1000]);
      for (let i = 0; i < 6; i++) expect(out[i]).toBeCloseTo(heard[i], 4);
      doc.history.undo();
    }
  });
});

describe('inserting 5.1 audio', () => {
  it('makes a 5.1 track for it in a 5.1 session, a stereo one otherwise', async () => {
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { insertDocs } = await import('../src/multitrack/insert.js');
    const six = () =>
      new AudioFile({
        name: 's.wav',
        sampleRate: RATE,
        channels: Array.from({ length: 6 }, () =>
          Channel.fromSamples(new Float32Array(100).fill(0.1)),
        ),
      });
    for (const [master, want] of [
      [6, 6],
      [2, 2],
    ]) {
      const { app, doc } = await appWithSession();
      doc.apply('Mix', { ...doc.state, master: { ...doc.state.master, channels: master } });
      const [id] = await insertDocs(app, doc, [six()], { trackId: null, at: 0 });
      expect(S.findTrack(doc.state, S.findClip(doc.state, id).trackId).channels).toBe(want);
    }
  });
});

describe('selected keyframes', () => {
  it('are forgotten when an undo or another edit changes their envelope', async () => {
    const { app, doc } = await appWithSession();
    const src = doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE * 4).fill(0.25))],
    });
    const env = [
      { t: 0, v: 0 },
      { t: RATE, v: 0 },
      { t: RATE * 2, v: 0 },
    ];
    const clip = S.createClip({
      trackId: doc.state.tracks[0].id,
      sourceId: src,
      start: RATE,
      length: RATE * 2,
      volumeEnv: env,
    });
    doc.apply('Add', S.addClips(doc.state, [clip]));
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 1000;
    view.height = 600;
    view.computeRows();
    doc.setView(0, RATE * 10);
    app.currentView = () => view;
    app.activate(doc);
    app.prefs.set('snapping', false);
    view.surface.setPointerCapture = () => {};
    const pointer = (type, x, y) =>
      view.surface.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true }), {
          clientX: x,
          clientY: y,
          button: 0,
          pointerId: 1,
          pointerType: 'mouse',
        }),
      );
    const r = view.clipRects().find((q) => q.clip.id === clip.id);
    // A click on the envelope line adds a keyframe (selected).
    const x = view.xOf(RATE * 1.5);
    const y = r.wy + 2 + 0.5 * (r.wh - 4);
    expect(view.hitTest(x, y).part).toBe('line');
    pointer('pointerdown', x, y);
    pointer('pointerup', x, y);
    expect(S.findClip(doc.state, clip.id).volumeEnv).toHaveLength(4);
    expect(doc.selectedKeys).toBeTruthy();
    // Undo removes it: Delete then deletes the selected clip, not another keyframe.
    await app.commands.run('edit.undo');
    expect(doc.selectedKeys).toBe(null);
    await app.commands.run('edit.delete');
    expect(doc.state.clips).toHaveLength(0);
    await app.commands.run('edit.undo');
    expect(S.findClip(doc.state, clip.id).volumeEnv).toEqual(env);
    // A keyframe dragged stays selected after the drag.
    const kx = view.xOf(RATE * 2);
    pointer('pointerdown', kx, y);
    pointer('pointermove', kx + 10, y - 10);
    pointer('pointerup', kx + 10, y - 10);
    expect(doc.selectedKeys?.indices.has(1)).toBe(true);
    await app.commands.run('edit.delete');
    expect(S.findClip(doc.state, clip.id).volumeEnv).toHaveLength(2);
  });
});

describe('touch in the multitrack editor', () => {
  it('grabs clip edges and keyframes from further away with a finger than with a mouse', async () => {
    const { app, doc } = await appWithSession();
    const src = doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE * 4).fill(0.25))],
    });
    const clip = S.createClip({
      trackId: doc.state.tracks[0].id,
      sourceId: src,
      start: RATE,
      length: RATE * 2,
    });
    doc.apply('Add', S.addClips(doc.state, [clip]));
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 1000;
    view.height = 600;
    view.computeRows();
    doc.setView(0, RATE * 10);
    const r = view.clipRects()[0];
    const y = r.wy + r.wh * 0.8;
    // 10 px inside the right edge: the body for a mouse, the edge for a finger.
    expect(view.hitTest(r.x1 - 10, y).part).toBe('body');
    expect(view.hitTest(r.x1 - 10, y, { touch: true }).part).toBe('edgeOut');
    expect(view.hitTest(r.x0 - 10, r.y + 4, { touch: true }).part).toBe('edgeIn');
    expect(view.hitTest((r.x0 + r.x1) / 2, y, { touch: true }).part).toBe('body');
    // A narrow clip keeps most of its body for moving.
    doc.setView(0, RATE * 100);
    const n = view.clipRects()[0];
    expect(n.x1 - n.x0).toBeLessThan(40);
    expect(view.hitTest((n.x0 + n.x1) / 2, n.wy + n.wh * 0.8, { touch: true }).part).toBe('body');
    // A finger drag from inside the edge trims the clip.
    doc.setView(0, RATE * 10);
    app.prefs.set('snapping', false);
    view.surface.setPointerCapture = () => {};
    const pointer = (type, x) =>
      view.surface.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true }), {
          clientX: x,
          clientY: y,
          button: 0,
          pointerId: 3,
          pointerType: 'touch',
        }),
      );
    pointer('pointerdown', r.x1 - 10);
    pointer('pointermove', r.x1 - 30);
    pointer('pointermove', r.x1 - 60);
    pointer('pointerup', r.x1 - 60);
    const c = S.findClip(doc.state, clip.id);
    expect(c.start).toBe(clip.start);
    expect(c.length).toBeLessThan(clip.length);
  });
});

describe('bouncing with an equal-power pan law', () => {
  it('sounds the same on the new track as before', async () => {
    const { app, doc } = await appWithSession();
    app.prefs.set('panLaw', 'equalPower');
    app.prefs.set('panLawDb', -3);
    const law = { mode: 'equalPower', centerDb: -3 };
    const t = doc.state.tracks[0];
    const src = doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.5))],
    });
    const c = S.createClip({ trackId: t.id, sourceId: src, start: 0, length: 2000 });
    doc.apply('Setup', S.updateTrack(S.addClips(doc.state, [c]), t.id, { pan: -40 }));
    const heard = renderState(doc.state, doc.pool, law, 2000).map((ch) => ch[1000]);
    for (const cmd of ['mt.bounceTrack', 'mt.bounceClips', 'mt.bounceTime']) {
      doc.selectTrack(t.id);
      doc.selectClips([c.id]);
      doc.setSelection(0, 2000);
      await app.commands.run(cmd);
      const only = S.updateClips(doc.state, [c.id], { mute: true });
      const out = renderState(only, doc.pool, law, 2000).map((ch) => ch[1000]);
      expect(out[0]).toBeCloseTo(heard[0], 4);
      expect(out[1]).toBeCloseTo(heard[1], 4);
      doc.history.undo();
    }
  });
});

describe('recording automation', () => {
  it('leaves the lane before and after a Write, Latch or Touch pass as it was', async () => {
    const { Emitter } = await import('../src/lib/emitter.js');
    const { TrackControls } = await import('../src/multitrack/track-controls.js');
    for (const lane0 of [
      [],
      [
        { t: 0, v: -3 },
        { t: 10000, v: -3 },
      ],
    ]) {
      for (const mode of ['write', 'latch', 'touch']) {
        const doc = new Session({ name: 'A.asesx', tracks: 1, sampleRate: 1000 });
        const t = doc.state.tracks[0];
        doc.apply(
          'Setup',
          S.setAutomation(
            S.updateTrack(doc.state, t.id, { mode, volume: -1 }),
            t.id,
            'volume',
            lane0,
          ),
        );
        const app = new Emitter();
        app.engine = { playing: true };
        app.active = doc;
        app.playhead = 0;
        app.syncGraph = () => {};
        const tc = new TrackControls(app, doc);
        tc.begin();
        app.playhead = 1000;
        tc.set(t.id, 'volume', -6, 'input');
        app.playhead = 2000;
        tc.set(t.id, 'volume', -10, 'input');
        app.playhead = 2500;
        tc.set(t.id, 'volume', -10, 'change');
        tc.commit(5000);
        const lane = S.findTrack(doc.state, t.id).automation.volume;
        const old = lane0.length ? -3 : -1;
        const at = (f) => S.envelopeValue(lane, f, -1);
        // Before the first move (Latch, Touch) the lane plays what it did.
        expect(at(500)).toBeCloseTo(old, 6);
        expect(at(1500)).toBeCloseTo(-6, 6);
        expect(at(2200)).toBeCloseTo(-10, 6);
        // Touch returns to the lane on release; Write and Latch hold until playback stops.
        expect(at(3000)).toBeCloseTo(mode === 'touch' ? old : -10, 6);
        expect(at(7000)).toBeCloseTo(old, 6);
      }
    }
  });
});

describe('closing a session while it records', () => {
  it('keeps the take as a file without reopening the closed session', async () => {
    const { Emitter } = await import('../src/lib/emitter.js');
    const { SessionRecorder } = await import('../src/multitrack/recorder.js');
    const engine = new Emitter();
    Object.assign(engine, {
      rate: RATE,
      playing: false,
      outputLatencyFrames: 0,
      openInput: async () => (engine.input = { channels: 1 }),
      setRecording: (on) => (engine.capturing = on),
      play: async () => (engine.playing = true),
      stop: () => (engine.playing = false),
      closeInput: () => (engine.input = null),
    });
    const app = new Emitter();
    Object.assign(app, { engine, documents: [], notify: vi.fn(), uniqueName: (b, e) => b + e });
    app.addDocument = (d) => app.documents.push(d);
    app.activate = (d) => (app.active = d);
    const rec = new SessionRecorder(app);
    const doc = new Session({ name: 'Rec.asesx', sampleRate: RATE, tracks: 1 });
    const other = new Session({ name: 'Other.asesx', sampleRate: RATE, tracks: 1 });
    app.documents.push(doc, other);
    app.active = doc;
    doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[0].id, { arm: true }));
    await rec.start(doc);
    engine.emit('record-data', [new Float32Array(4096).fill(0.5)]);
    // Close the session (as App.closeDocument does): it leaves the list, playback stops.
    app.documents.splice(app.documents.indexOf(doc), 1);
    doc.emit('close');
    app.active = other;
    engine.stop();
    app.emit('transport', 'stopped');
    await new Promise((r) => setTimeout(r, 300));
    expect(app.active).toBe(other);
    expect(app.documents).not.toContain(doc);
    // The recorded audio is kept as a file.
    expect(app.documents.some((d) => d.kind === 'audio' && d.length === 4096)).toBe(true);
  });
});
