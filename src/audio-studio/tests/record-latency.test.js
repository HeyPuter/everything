// Overdubs in the Multitrack editor land where they were played: the take
// loses the output latency (the player heard the session late) and the input
// latency (their performance reached the capture late).
import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../src/lib/emitter.js';
import { Engine } from '../src/engine/engine.js';
import { Session } from '../src/model/session.js';
import { SessionRecorder } from '../src/multitrack/recorder.js';
import * as S from '../src/model/session-edits.js';

const RATE = 48000;

describe('recording latency compensation', () => {
  it('reads the input latency the open device reports', () => {
    const e = new Engine();
    expect(e.inputLatencyFrames).toBe(0);
    e.input = { stream: { getAudioTracks: () => [{ getSettings: () => ({ latency: 0.01 }) }] } };
    expect(e.inputLatencyFrames).toBe(480);
  });

  it('trims both the output and the input latency from a multitrack take', async () => {
    const engine = new Emitter();
    Object.assign(engine, {
      rate: RATE,
      playing: false,
      input: null,
      outputLatencyFrames: 256,
      inputLatencyFrames: 100,
      openInput: async () => (engine.input = { channels: 1 }),
      setRecording: (on) => (engine.capturing = on),
      play: async () => (engine.playing = true),
      stop: () => ((engine.playing = false), 0),
      closeInput: () => (engine.input = null),
    });
    const app = new Emitter();
    Object.assign(app, { engine, documents: [], notify: vi.fn(), uniqueName: (b, x) => b + x, addDocument: (d) => app.documents.push(d) });
    app.stop = () => {
      engine.stop();
      app.emit('transport', 'stopped');
    };
    const rec = new SessionRecorder(app);
    const doc = new Session({ name: 'Rec.asesx', sampleRate: RATE, tracks: 1 });
    app.active = doc;
    const track = doc.state.tracks[0];
    doc.apply('Arm', S.updateTrack(doc.state, track.id, { arm: true }));
    doc.setCursor(RATE);
    await rec.start(doc);
    // A clap played in time with the playhead's start arrives 356 frames into the capture.
    const data = new Float32Array(4096);
    data[356] = 0.9;
    engine.emit('record-data', [data]);
    app.stop();
    await new Promise((r) => setTimeout(r, 300));
    const [clip] = doc.state.clips;
    expect(clip.start).toBe(RATE);
    const file = app.documents.find((d) => d.kind !== 'session');
    expect(file.state.channels[0].toArray(0, 2)[0]).toBeCloseTo(0.9, 5);
    expect(clip.length).toBe(4096 - 356);
  });
});
