// Regression tests for multitrack fixes found in QA.
import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../src/lib/emitter.js';
import { Session } from '../src/model/session.js';
import { SessionRecorder } from '../src/multitrack/recorder.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';

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
  const doc = new Session({ name: 'Test.asesx', sampleRate: RATE, tracks: 3 });
  const src = doc.addSource({ name: 'dc.wav', channels: [Channel.fromSamples(new Float32Array(RATE * 4).fill(0.25))] });
  const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, name: 'dc', start: RATE, length: RATE * 2 });
  doc.apply('Insert File', S.addClips(doc.state, [clip]));
  app.addDocument(doc);
  return { app, doc, clip };
}

const RATE = 48000;

class FakeEngine extends Emitter {
  constructor() {
    super();
    this.rate = RATE;
    this.playing = false;
    this.input = null;
    this.outputLatencyFrames = 0;
  }
  async openInput() {
    this.input = { channels: 1 };
  }
  setRecording(on) {
    this.capturing = on;
  }
  async play() {
    this.playing = true;
  }
  stop() {
    this.playing = false;
    return 0;
  }
  closeInput() {
    this.input = null;
  }
}

function fakeApp() {
  const app = new Emitter();
  app.engine = new FakeEngine();
  app.documents = [];
  app.notify = vi.fn();
  app.uniqueName = (base, ext) => base + ext;
  app.addDocument = (d) => app.documents.push(d);
  app.activate = (d) => (app.active = d);
  // Like App.stop(): stops the engine and announces it.
  app.stop = () => {
    app.engine.stop();
    app.emit('transport', 'stopped');
  };
  return app;
}

describe('session recording', () => {
  it('keeps the take when the transport is stopped another way (Space)', async () => {
    const app = fakeApp();
    const rec = new SessionRecorder(app);
    const doc = new Session({ name: 'Rec.asesx', sampleRate: RATE, tracks: 2 });
    app.active = doc;
    const track = doc.state.tracks[0];
    doc.apply('Arm', S.updateTrack(doc.state, track.id, { arm: true }));
    await rec.start(doc);
    expect(app.recording).toBe(true);
    app.engine.emit('record-data', [new Float32Array(4096).fill(0.5)]);
    app.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(rec.active).toBe(false);
    expect(app.recording).toBe(false);
    expect(app.engine.capturing).toBe(false);
    expect(app.engine.input).toBe(null);
    const clips = doc.state.clips;
    expect(clips.length).toBe(1);
    expect(clips[0].trackId).toBe(track.id);
    expect(clips[0].length).toBe(4096);
    expect(doc.history.undoLabel).toBe('Record');
  });

  it('undoes the start when playback is refused: no capture, no open microphone, ready to record again', async () => {
    const app = fakeApp();
    const rec = new SessionRecorder(app);
    const doc = new Session({ name: 'Rec.asesx', sampleRate: RATE, tracks: 1 });
    app.active = doc;
    const track = doc.state.tracks[0];
    doc.apply('Arm', S.updateTrack(doc.state, track.id, { arm: true, monitor: true }));
    const disconnect = vi.fn();
    app.engine.ctx = { destination: {} };
    app.engine.openInput = async function () {
      this.input = { channels: 1, src: { connect: vi.fn(), disconnect } };
    };
    const offs = [];
    const on = app.engine.on.bind(app.engine);
    app.engine.on = (type, fn) => {
      const off = vi.fn(on(type, fn));
      offs.push(off);
      return off;
    };
    const refuse = new Error("This browser can't play 384000 Hz audio.");
    app.engine.play = async () => Promise.reject(refuse);
    await expect(rec.start(doc)).rejects.toBe(refuse);
    expect(rec.active).toBe(false);
    expect(app.recording).toBeFalsy();
    expect(app.engine.capturing).toBe(false);
    expect(app.engine.input).toBe(null);
    expect(app.playStart).toBe(null);
    expect(offs[0]).toHaveBeenCalled();
    // Input metering keeps its own input open, without the monitoring route.
    app.inputMetering = true;
    await expect(rec.start(doc)).rejects.toBe(refuse);
    expect(app.engine.input).not.toBe(null);
    expect(disconnect).toHaveBeenCalledWith(app.engine.ctx.destination);
    // Once playback works, recording starts normally.
    app.inputMetering = false;
    app.engine.play = async () => {};
    await rec.start(doc);
    expect(rec.active).toBe(true);
    expect(app.engine.capturing).toBe(true);
  });
});

describe('multitrack commands', () => {
  it('does not offer bouncing the master track (it would render silence)', async () => {
    const { app, doc } = await appWithSession();
    doc.selectTrack(doc.state.tracks[0].id);
    expect(app.commands.isEnabled('mt.bounceTrack')).toBe(true);
    doc.selectTrack(doc.state.master.id);
    expect(app.commands.isEnabled('mt.bounceTrack')).toBe(false);
  });
});

describe('ducking follows clip edits', () => {
  it('regenerates a ducked clip when the dialogue it ducks under moves, in the same undo step', async () => {
    const { assignType, editClips } = await import('../src/sound-assistant/ops.js');
    const { app, doc, clip } = await appWithSession();
    const music = S.createClip({ trackId: doc.state.tracks[1].id, sourceId: clip.sourceId, name: 'music', start: 0, length: RATE * 4 });
    doc.apply('Insert', S.addClips(doc.state, [music]));
    let st = assignType(doc.state, [clip.id], 'dialogue');
    st = assignType(st, [music.id], 'music');
    doc.apply('Sound Assistant', editClips(st, [music.id], 'music', ['ducking', 'on'], true));
    const before = S.findClip(doc.state, music.id).volumeEnv;
    expect(before.some((p) => p.t === RATE && p.v < 0)).toBe(true);
    const steps = doc.history.entries.length;
    doc.apply('Move Clip', S.moveClips(doc.state, [clip.id], RATE / 2, 0));
    expect(doc.history.entries.length).toBe(steps + 1);
    const after = S.findClip(doc.state, music.id).volumeEnv;
    expect(after.some((p) => p.t === RATE * 1.5 && p.v < 0)).toBe(true);
    // Hand-edited keyframes survive an edit that does not touch the ducking inputs.
    const tweaked = after.map((p) => (p.v < 0 ? { ...p, v: -6 } : p));
    doc.apply('Volume Envelope', S.setClipEnvelope(doc.state, music.id, 'volume', tweaked));
    doc.apply('Rename Clip', S.updateClips(doc.state, [clip.id], { name: 'voice' }));
    expect(S.findClip(doc.state, music.id).volumeEnv).toEqual(S.normalizeEnvelope(tweaked, RATE * 4));
    doc.history.undo();
    doc.history.undo();
    doc.history.undo();
    expect(S.findClip(doc.state, music.id).volumeEnv).toEqual(before);
    expect(app.documents.includes(doc)).toBe(true);
  });
});

describe('punch-in over a clip', () => {
  it('plays the take over a clip that was moved before (the take comes to the front)', async () => {
    const { clipPlan } = await import('../src/model/session-graph.js');
    const app = fakeApp();
    const rec = new SessionRecorder(app);
    const doc = new Session({ name: 'Punch.asesx', sampleRate: RATE, tracks: 2 });
    app.active = doc;
    const track = doc.state.tracks[0];
    const src = doc.addSource({ name: 'bed.wav', channels: [Channel.fromSamples(new Float32Array(RATE * 2).fill(0.1))] });
    const bed = S.createClip({ trackId: track.id, sourceId: src, name: 'bed', start: 0, length: RATE * 2 });
    doc.apply('Insert', S.addClips(doc.state, [bed]));
    // Nudged once: moved clips come to the front (z 1).
    doc.apply('Nudge', S.moveClips(doc.state, [bed.id], 100));
    doc.apply('Arm', S.updateTrack(doc.state, track.id, { arm: true }));
    doc.setSelection(RATE / 2, RATE / 2 + 4096);
    await rec.start(doc);
    app.engine.emit('record-data', [new Float32Array(RATE / 2 + 8192).fill(0.5)]);
    app.stop();
    await new Promise((r) => setTimeout(r, 300));
    const take = doc.state.clips.find((c) => c.id !== bed.id);
    expect(take.start).toBe(RATE / 2);
    expect(take.length).toBe(4096);
    expect(clipPlan(doc.state).get(take.id).parts).toEqual([[RATE / 2, RATE / 2 + 4096]]);
  });
});

describe('clip audio type', () => {
  it('announces a clip’s Sound Assistant type when Tab selects it', async () => {
    const { assignType } = await import('../src/sound-assistant/ops.js');
    const { app, doc, clip } = await appWithSession();
    doc.apply('Type', assignType(doc.state, [clip.id], 'dialogue'));
    const view = app.documentKinds.get('session').view(app, doc);
    const region = document.createElement('div');
    region.id = 'live-region';
    document.body.replaceChildren(view.el, region);
    view.surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    expect([...doc.selectedClips]).toEqual([clip.id]);
    expect(region.textContent).toMatch(/^Clip dc \(Dialogue\) on Track 1/);
  });
});

describe('accessibility', () => {
  it('uses valid roles for track headers and mixer strips, and names every effect slot', async () => {
    const { mixerPanel } = await import('../src/panels/mixer.js');
    const { app, doc } = await appWithSession();
    const view = app.documentKinds.get('session').view(app, doc);
    const mixer = mixerPanel(app);
    document.body.replaceChildren(view.el, mixer.el);
    mixer.show();
    // A list may only own list items; headers and strips are labelled groups.
    for (const list of document.querySelectorAll('[role=list]')) {
      for (const item of list.querySelectorAll('[role]')) if (item.closest('[role=list]') === list && item.parentElement.closest('[role]') === list) expect(item.getAttribute('role')).toBe('listitem');
    }
    expect(document.querySelectorAll('.mx-fx-slot[role]').length).toBe(0);
    const slots = [...document.querySelectorAll('.mx-fx-slot')];
    expect(slots.length).toBeGreaterThan(0);
    for (const b of slots) expect(b.getAttribute('aria-label') || b.textContent).toBeTruthy();
  });
});

describe('view settings and undo', () => {
  it('keeps an opened automation lane, hidden track and metronome through undo and redo', async () => {
    const { app, doc, clip } = await appWithSession();
    const [t1, t2] = doc.state.tracks;
    doc.apply('Move Clip', S.moveClips(doc.state, [clip.id], RATE, 0));
    await app.commands.run('mt.toggleAutomationLane', { id: t1.id });
    doc.selectTrack(t2.id);
    await app.commands.run('mt.hideTrack');
    await app.commands.run('mt.metronome');
    expect(doc.history.undoLabel).toBe('Move Clip');
    doc.history.undo();
    expect(S.findClip(doc.state, clip.id).start).toBe(RATE);
    const check = () => {
      expect(S.findTrack(doc.state, t1.id).showAutomation).toBe(true);
      expect(S.findTrack(doc.state, t2.id).hidden).toBe(true);
      expect(doc.state.metronome).toBe(true);
    };
    check();
    doc.history.redo();
    expect(S.findClip(doc.state, clip.id).start).toBe(RATE * 2);
    check();
    expect(doc.dirty).toBe(true);
  });
});

describe('level readouts follow the control being moved', () => {
  it('updates the mixer dB readout and pan text when the fader or pan knob moves', async () => {
    const { mixerPanel } = await import('../src/panels/mixer.js');
    const { app, doc } = await appWithSession();
    const panel = mixerPanel(app);
    document.body.replaceChildren(panel.el);
    panel.show();
    const strip = panel.el.querySelector('.mx-strip');
    strip.querySelector('.mx-fader').dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(doc.state.tracks[0].volume).toBe(-3);
    expect(strip.querySelector('.mx-db').textContent).toContain('-3');
    strip.querySelector('.mx-panrow [role=slider]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(doc.state.tracks[0].pan).toBe(-1);
    expect(strip.querySelector('.mx-pan-text').textContent).toBe('L1');
  });

  it('updates the track header readout when the volume knob moves', async () => {
    const { app, doc } = await appWithSession();
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    const head = view.headers.get(doc.state.tracks[0].id);
    head.volKnob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(doc.state.tracks[0].volume).toBe(-0.1);
    expect(head.volNum.getValue()).toBe(-0.1);
  });
});

describe('session files', () => {
  it('saves the original audio of a clip stretched by Sound Assistant Duration', async () => {
    const { serializeSession, parseSession } = await import('../src/model/session-io.js');
    const doc = new Session({ name: 'Dur.asesx', sampleRate: RATE, tracks: 1 });
    const orig = doc.addSource({ name: 'orig.wav', channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.1))] });
    const stretched = doc.addSource({ name: 'orig.wav (2 s)', channels: [Channel.fromSamples(new Float32Array(RATE * 2).fill(0.1))] });
    const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: stretched, name: 'm', start: 0, length: RATE * 2, soundAssistant: { type: 'music', duration: { on: true, seconds: 2, orig: { sourceId: orig, offset: 0, length: RATE } } } });
    doc.apply('Insert', S.addClips(doc.state, [clip]));
    const { text, media } = serializeSession(doc);
    expect(media.map((m) => m.id).sort()).toEqual([orig, stretched].sort());
    const parsed = parseSession(text);
    expect(parsed.sources.map((x) => x.id).sort()).toEqual([orig, stretched].sort());
    expect(parsed.state.clips[0].soundAssistant.duration.orig.sourceId).toBe(orig);
  });
});

describe('clipboard', () => {
  it('pastes a stretched clip into another session together with its original audio', async () => {
    const { app, doc } = await appWithSession();
    const orig = doc.addSource({ name: 'orig.wav', channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.1))] });
    const stretched = doc.addSource({ name: 'orig.wav (2 s)', channels: [Channel.fromSamples(new Float32Array(RATE * 2).fill(0.1))] });
    const clip = S.createClip({ trackId: doc.state.tracks[1].id, sourceId: stretched, name: 'm', start: 0, length: RATE * 2, soundAssistant: { type: 'music', duration: { on: true, seconds: 2, orig: { sourceId: orig, offset: 0, length: RATE } } } });
    doc.apply('Insert', S.addClips(doc.state, [clip]));
    doc.selectClips([clip.id]);
    await app.commands.run('edit.copy');
    const other = new Session({ name: 'Other.asesx', sampleRate: RATE, tracks: 2 });
    app.addDocument(other);
    await app.commands.run('edit.paste');
    expect(other.state.clips.length).toBe(1);
    expect(other.pool.has(stretched)).toBe(true);
    expect(other.pool.has(orig)).toBe(true);
  });
});

describe('automation while recording', () => {
  it('writes automation in Write mode during a recording pass', async () => {
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    doc.apply('Mode', S.updateTrack(doc.state, id, { mode: 'write' }));
    let pos = RATE;
    Object.defineProperty(app.engine, 'playing', { get: () => true, configurable: true });
    Object.defineProperty(app, 'playhead', { get: () => pos, configurable: true });
    app.emit('transport', 'recording');
    pos = RATE * 2;
    doc.controls.set(id, 'volume', -6, 'input');
    Object.defineProperty(app.engine, 'playing', { get: () => false, configurable: true });
    app.engine.lastPos = { frame: RATE * 3, time: 0 };
    app.emit('transport', 'stopped');
    delete app.engine.playing;
    const lane = S.findTrack(doc.state, id).automation.volume;
    expect(doc.history.undoLabel).toBe('Write Automation');
    expect(lane[0]).toEqual({ t: RATE, v: 0 });
    expect(lane[lane.length - 1]).toEqual({ t: RATE * 3, v: -6 });
  });
});

describe('properties panel', () => {
  it('shows the automated pan value of the selected track at the playhead', async () => {
    const { sessionPropertySection } = await import('../src/multitrack/properties.js');
    const { app, doc } = await appWithSession();
    const id = doc.state.tracks[0].id;
    doc.apply('Pan', S.setAutomation(doc.state, id, 'pan', [{ t: 0, v: -40 }]));
    doc.selectTrack(id);
    const el = sessionPropertySection(app, doc);
    const row = [...el.querySelectorAll('.prop-row')].find((r) => r.textContent.startsWith('Pan'));
    expect(row.querySelector('.prop-value').textContent).toBe('-40');
  });
});

describe('view performance', () => {
  it('does not relayout track headers on horizontal zoom, only on track height zoom', async () => {
    const { app, doc } = await appWithSession();
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 1000;
    view.height = 600;
    let syncs = 0;
    const orig = view.syncHeaders.bind(view);
    view.syncHeaders = () => {
      syncs++;
      orig();
    };
    doc.setView(0, RATE * 5);
    doc.setView(RATE, RATE * 3);
    expect(syncs).toBe(0);
    const h0 = view.rowOf(doc.state.tracks[0].id).height;
    doc.setAmp(2);
    expect(syncs).toBe(1);
    expect(view.rowOf(doc.state.tracks[0].id).height).toBe(h0 * 2);
  });
});
