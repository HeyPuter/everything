import { describe, it, expect, vi } from 'vitest';
import { Take, mapInput, placeTake, recordingName } from '../src/record/take.js';
import { createRecorder, inputErrorMessage } from '../src/record/recorder.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Emitter } from '../src/lib/emitter.js';
import { Prefs } from '../src/lib/prefs.js';

const ramp = (n, from = 0) => Float32Array.from({ length: n }, (_, i) => (from + i) / 100000);

describe('Take', () => {
  it('assembles blocks across sealed buffers without copying them', () => {
    const t = new Take(2, { blockSize: 1000 });
    let at = 0;
    for (const n of [300, 900, 1200, 7]) {
      t.append([ramp(n, at), ramp(n, at).map((v) => -v)]);
      at += n;
    }
    expect(t.length).toBe(2407);
    const [L, R] = t.toChannels();
    expect(L.length).toBe(2407);
    expect(L.pieces.length).toBe(3); // two sealed blocks plus the tail
    const all = L.toArray();
    for (let i = 0; i < 2407; i++) expect(all[i]).toBeCloseTo(i / 100000, 7);
    expect(R.toArray()[2406]).toBeCloseTo(-2406 / 100000, 7);
    // Views taken earlier stay valid while recording continues.
    const before = t.toChannels()[0].toArray();
    t.append([ramp(500, at), ramp(500, at)]);
    expect([...t.toChannels()[0].toArray(0, 2407)]).toEqual([...before]);
  });

  it('drops latency frames from the start and stops at the punch-out limit', () => {
    const t = new Take(1, { skip: 150, limit: 400, blockSize: 256 });
    t.append([ramp(100)]);
    expect(t.length).toBe(0);
    t.append([ramp(100, 100)]);
    expect(t.length).toBe(50);
    expect(t.toChannels()[0].toArray()[0]).toBeCloseTo(150 / 100000, 7);
    t.append([ramp(1000, 200)]);
    expect(t.length).toBe(400);
    expect(t.full).toBe(true);
    expect(t.append([ramp(10)])).toBe(0);
  });

  it('maps mono input to stereo and stereo input to mono', () => {
    const mono = Float32Array.of(0.5, 0.25);
    const st = mapInput([mono], 2);
    expect(st.length).toBe(2);
    expect(st[1][1]).toBe(0.25);
    const [m] = mapInput([Float32Array.of(1, 0), Float32Array.of(0, 1)], 1);
    expect([...m]).toEqual([0.5, 0.5]);
    const t = new Take(1);
    t.append([Float32Array.of(0.8), Float32Array.of(-0.4)]);
    expect(t.toChannels()[0].toArray()[0]).toBeCloseTo(0.2, 6);
    expect(t.peak).toBeCloseTo(0.2, 6);
  });
});

describe('placeTake', () => {
  const base = { sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(1000).fill(1)), Channel.fromSamples(new Float32Array(1000).fill(1))], markers: [{ id: 'a', start: 800, duration: 0, name: 'M', type: 'cue' }] };
  const rec = [Channel.fromSamples(new Float32Array(200).fill(0.5)), Channel.fromSamples(new Float32Array(200).fill(-0.5))];

  it('inserts at the playhead and moves later audio and markers', () => {
    const s = placeTake(base, rec, { at: 100 });
    expect(s.channels[0].length).toBe(1200);
    expect(s.channels[0].toArray(99, 101)[1]).toBe(0.5);
    expect(s.channels[1].toArray(299, 301)).toEqual(Float32Array.of(-0.5, 1));
    expect(s.markers[0].start).toBe(1000);
  });

  it('punches in over a selection without changing the length', () => {
    const s = placeTake(base, rec, { replace: [300, 400] });
    expect(s.channels[0].length).toBe(1000);
    const a = s.channels[0].toArray();
    expect(a[299]).toBe(1);
    expect(a[300]).toBe(0.5);
    expect(a[399]).toBe(0.5);
    expect(a[400]).toBe(1);
    expect(s.markers).toBe(base.markers);
  });

  it('names new recordings by date and time', () => {
    expect(recordingName(new Date(2026, 9, 10, 9, 5, 7))).toBe('Recording 2026-10-10 09.05.07');
  });
});

/** A stand-in for the realtime engine: tests push capture blocks by hand. */
class FakeEngine extends Emitter {
  constructor() {
    super();
    this.rate = 48000;
    this.playing = false;
    this.input = null;
    this.recording = false;
    this.outputLatencyFrames = 256;
  }
  async openInput() {
    this.input = { channels: 1, stream: { getAudioTracks: () => [{ getSettings: () => ({ latency: 0.01 }) }] } };
  }
  setRecording(on) {
    this.recording = on;
  }
  closeInput() {
    this.input = null;
  }
}

function fakeApp() {
  const app = new Emitter();
  app.engine = new FakeEngine();
  app.prefs = new Prefs(null);
  app.notify = vi.fn();
  app.setStatus = vi.fn();
  app.meterInput = vi.fn();
  app.stop = vi.fn();
  return app;
}

describe('recorder', () => {
  it('records into a document as a single undo step and leaves the playhead at the end', async () => {
    const app = fakeApp();
    const rec = createRecorder(app);
    const doc = AudioFile.blank({ name: 'Rec', sampleRate: 48000, channels: 2, seconds: 1 });
    doc.setCursor(24000);
    await rec.start({ doc });
    expect(app.recording).toBe(true);
    expect(app.engine.recording).toBe(true);
    for (let i = 0; i < 10; i++) app.engine.emit('record-data', [new Float32Array(2048).fill(0.25)]);
    await new Promise((r) => setTimeout(r, 200)); // live update
    expect(doc.length).toBe(48000 + 20480);
    expect(doc.history.entries.map((e) => e.label)).toEqual(['Open', 'Record']);
    app.engine.emit('record-data', [new Float32Array(1000).fill(0.25)]);
    const result = await rec.stop();
    expect(app.recording).toBe(false);
    expect(app.engine.input).toBe(null);
    expect(result.frames).toBe(21480);
    expect(doc.length).toBe(48000 + 21480);
    expect(doc.history.entries.map((e) => e.label)).toEqual(['Open', 'Record']);
    expect(doc.cursor).toBe(24000 + 21480);
    expect(doc.state.channels[1].toArray(24000, 24001)[0]).toBe(0.25);
    doc.history.undo();
    expect(doc.length).toBe(48000);
  });

  it('stops by itself at the end of a punch-in selection', async () => {
    const app = fakeApp();
    const rec = createRecorder(app);
    const doc = AudioFile.blank({ name: 'Rec', sampleRate: 48000, channels: 1, seconds: 1 });
    await rec.start({ doc, replace: [1000, 4000] });
    app.engine.emit('record-data', [new Float32Array(2048).fill(0.5)]);
    app.engine.emit('record-data', [new Float32Array(2048).fill(0.5)]);
    await new Promise((r) => setTimeout(r, 250));
    expect(rec.active).toBe(false);
    expect(doc.length).toBe(48000);
    const a = doc.state.channels[0].toArray(999, 4001);
    expect([a[0], a[1], a[3000], a[3001]]).toEqual([0, 0.5, 0.5, 0]);
  });

  it('returns latency-compensated takes for external recording', async () => {
    const app = fakeApp();
    const rec = createRecorder(app);
    const onData = vi.fn();
    await rec.start({ channels: 2, compensate: true, onData });
    app.engine.emit('record-data', [new Float32Array(2048).fill(0.1)]);
    const r = await rec.stop();
    expect(r.latencyFrames).toBe(256 + 480);
    expect(r.frames).toBe(2048 - 736);
    expect(r.channels.length).toBe(2);
    expect(r.doc).toBe(null);
  });

  it('stops and keeps the take when the input device is disconnected', async () => {
    const app = fakeApp();
    const track = new EventTarget();
    track.getSettings = () => ({});
    app.engine.openInput = async function () {
      this.input = { channels: 1, stream: { getAudioTracks: () => [track] } };
    };
    const rec = createRecorder(app);
    const doc = AudioFile.blank({ name: 'Rec', sampleRate: 48000, channels: 1, seconds: 0 });
    await rec.start({ doc });
    app.engine.emit('record-data', [new Float32Array(2048).fill(0.5)]);
    track.dispatchEvent(new Event('ended'));
    await new Promise((r) => setTimeout(r, 200));
    expect(rec.active).toBe(false);
    expect(app.recording).toBe(false);
    expect(doc.length).toBe(2048);
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/disconnected/), { error: true });
  });

  it('explains blocked and missing microphones', async () => {
    expect(inputErrorMessage({ name: 'NotAllowedError' })).toMatch(/blocked/);
    expect(inputErrorMessage({ name: 'NotFoundError' })).toMatch(/No microphone/);
    const app = fakeApp();
    app.engine.openInput = async () => {
      const e = new Error('denied');
      e.name = 'NotAllowedError';
      throw e;
    };
    const rec = createRecorder(app);
    await expect(rec.start({ doc: AudioFile.blank({}) })).rejects.toThrow(/Allow access/);
    expect(rec.active).toBe(false);
    expect(app.recording).toBeFalsy();
  });
});
