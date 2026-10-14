import { describe, it, expect, vi } from 'vitest';
import { keyForCode, octaveRange, clampOctave, LOWER_ROW, UPPER_ROW, BASE_KEY } from '../src/input/keymap.js';
import { TypingKeyboard } from '../src/input/typing.js';
import { LiveInput } from '../src/input/live.js';
import { parseMidi, MidiInput } from '../src/input/midi.js';
import { msToTicks, patternTick, recordedNote, clipAt, Recorder } from '../src/input/recorder.js';
import { Store } from '../src/model/store.js';
import { Emitter } from '../src/lib/emitter.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { shared } from '../src/pianoroll/state.js';
import { PPQ, STEP } from '../src/model/time.js';

function fakeApp() {
  const store = new Store(demoProject());
  const engine = new Emitter();
  Object.assign(engine, {
    ready: true,
    playing: false,
    recording: false,
    mode: 'pattern',
    position: 0,
    on: engine.on.bind(engine),
    start: vi.fn(async () => true),
    noteOn: vi.fn(),
    noteOff: vi.fn(),
  });
  const prefValues = {};
  const prefs = new Emitter();
  prefs.get = (k) => prefValues[k];
  prefs.set = (k, v) => {
    prefValues[k] = v;
    prefs.emit('change', k, v);
  };
  const app = new Emitter();
  Object.assign(app, { store, engine, prefs, notify: vi.fn(), reportError: vi.fn() });
  return app;
}

const key = (code, extra = {}) => ({ code, key: code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: document.body, ...extra });

describe('typing keyboard map', () => {
  it('maps two rows to two octaves like piano keys', () => {
    expect(keyForCode('KeyZ')).toBe(BASE_KEY);
    expect(keyForCode('KeyS')).toBe(BASE_KEY + 1);
    expect(keyForCode('Comma')).toBe(BASE_KEY + 12);
    expect(keyForCode('KeyQ')).toBe(60);
    expect(keyForCode('Digit2')).toBe(61);
    expect(keyForCode('KeyP')).toBe(76);
    expect(keyForCode('KeyA')).toBe(null);
    expect(keyForCode('KeyQ', 1)).toBe(72);
    expect(keyForCode('KeyZ', -4)).toBe(0);
    expect(LOWER_ROW).toHaveLength(13);
    expect(UPPER_ROW).toHaveLength(17);
    expect(octaveRange(0)).toEqual([48, 76]);
    expect(clampOctave(9)).toBe(4);
  });

  it('plays notes on the selected channel, ignores repeats and shifts octaves', () => {
    const app = fakeApp();
    const live = new LiveInput(app, null);
    const tk = new TypingKeyboard(app, live);
    const ch = app.store.view.channel;
    expect(tk.handle(key('KeyQ'), true)).toBe(true);
    expect(app.engine.noteOn).toHaveBeenCalledWith(ch, 60, 0.8);
    expect(tk.handle(key('KeyQ', { repeat: true }), true)).toBe(true);
    expect(app.engine.noteOn).toHaveBeenCalledTimes(1);
    expect(tk.handle(key('KeyQ'), false)).toBe(true);
    expect(app.engine.noteOff).toHaveBeenCalledWith(ch, 60);
    expect(tk.handle(key('KeyA'), true)).toBe(false);
    expect(tk.handle(key('Equal'), true)).toBe(true);
    tk.handle(key('KeyQ'), true);
    expect(app.engine.noteOn).toHaveBeenLastCalledWith(ch, 72, 0.8);
    // Text fields keep their keys.
    const input = document.createElement('input');
    expect(tk.handle(key('KeyW', { target: input }), true)).toBe(false);
  });

  it('sends note off to the channel that started the note', () => {
    const app = fakeApp();
    const live = new LiveInput(app, null);
    const [a, b] = app.store.project.channels;
    app.store.setChannel(a.id);
    live.noteOn(64, 0.5, 'typing');
    app.store.setChannel(b.id);
    live.noteOff(64, 'typing');
    expect(app.engine.noteOff).toHaveBeenCalledWith(a.id, 64);
  });
});

describe('MIDI input', () => {
  it('parses note and controller messages', () => {
    expect(parseMidi([0x90, 60, 127])).toMatchObject({ type: 'on', key: 60, vel: 1 });
    expect(parseMidi([0x91, 60, 0])).toMatchObject({ type: 'off', key: 60, channel: 1 });
    expect(parseMidi([0x80, 62, 30])).toMatchObject({ type: 'off', key: 62 });
    expect(parseMidi([0xb0, 64, 127])).toMatchObject({ type: 'cc', cc: 64, value: 127 });
    expect(parseMidi([0xe0, 0, 64]).type).toBe('other');
  });

  it('holds released notes while the sustain pedal is down', () => {
    const app = fakeApp();
    const live = new LiveInput(app, null);
    const midi = new MidiInput(app, live);
    midi.handle([0x90, 60, 100]);
    midi.handle([0xb0, 64, 127]);
    midi.handle([0x80, 60, 0]);
    expect(app.engine.noteOff).not.toHaveBeenCalled();
    midi.handle([0xb0, 64, 0]);
    expect(app.engine.noteOff).toHaveBeenCalledTimes(1);
  });

  it('turns itself off gracefully without Web MIDI', async () => {
    const app = fakeApp();
    const midi = new MidiInput(app, new LiveInput(app, null));
    expect(await midi.enable()).toBe(false);
    expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/not supported/), { error: true });
  });
});

describe('recording timing', () => {
  it('converts held time to ticks', () => {
    expect(msToTicks(500, 120)).toBe(PPQ);
    expect(msToTicks(1000, 60)).toBe(PPQ);
  });

  it('maps engine positions into the pattern', () => {
    expect(patternTick(PPQ * 5, { mode: 'pattern', patLen: PPQ * 4 })).toBe(PPQ);
    const clips = [{ kind: 'pattern', ref: 'p1', start: PPQ * 8, len: PPQ * 8, offset: PPQ, mute: false }];
    expect(patternTick(PPQ * 9, { mode: 'song', patternId: 'p1', patLen: PPQ * 4, clips })).toBe(PPQ * 2);
    expect(patternTick(PPQ * 14, { mode: 'song', patternId: 'p1', patLen: PPQ * 4, clips })).toBe(PPQ * 3);
    // No clip of this pattern under the playhead: wrap into the pattern.
    expect(patternTick(PPQ * 21, { mode: 'song', patternId: 'p1', patLen: PPQ * 4, clips })).toBe(PPQ);
    expect(clipAt(PPQ * 9, 'p1', clips)).toBe(clips[0]);
    expect(clipAt(PPQ * 9, 'p2', clips)).toBe(null);
  });

  it('quantizes and clamps recorded notes to the pattern', () => {
    expect(recordedNote(30, 40, { patLen: 384 })).toEqual({ pos: 30, len: 40 });
    expect(recordedNote(30, 40, { patLen: 384, grid: 24, quantize: true })).toEqual({ pos: 24, len: 48 });
    expect(recordedNote(380, 10, { patLen: 384, grid: 24, quantize: true })).toEqual({ pos: 0, len: 24 });
    expect(recordedNote(360, 100, { patLen: 384 })).toEqual({ pos: 360, len: 24 });
    expect(recordedNote(0, 1, { patLen: 384 }).len).toBe(6);
  });
});

describe('recorder', () => {
  it('records a take as one undo step while recording and playing', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const live = new LiveInput(app, rec);
    const pat = app.store.view.pattern;
    const ch = app.store.view.channel;
    const before = E.getNotes(app.store.project, pat, ch).length;
    Object.assign(app.engine, { recording: true, playing: true, position: PPQ * 4 + PPQ }); // wraps to beat 2 in a 1 bar pattern
    const t0 = 1000;
    const now = vi.spyOn(performance, 'now').mockReturnValue(t0);
    live.noteOn(67, 0.9, 'midi');
    now.mockReturnValue(t0 + 250); // 250 ms at 124 bpm is 49.6 ticks
    live.noteOff(67, 'midi');
    live.noteOn(69, 0.7, 'midi');
    now.mockReturnValue(t0 + 500);
    live.noteOff(69, 'midi');
    app.engine.playing = false;
    app.engine.emit('state');
    now.mockRestore();
    const notes = E.getNotes(app.store.project, pat, ch);
    expect(notes.length).toBe(before + 2);
    const added = notes.filter((n) => n.key === 67 || n.key === 69);
    expect(added.some((n) => n.key === 67 && n.pos === PPQ && n.len === 50)).toBe(true);
    expect(app.store.undoLabel).toBe('Record notes');
    app.store.undo();
    expect(E.getNotes(app.store.project, pat, ch).length).toBe(before);
  });

  it('step-edits at the cursor and advances once every key is released', () => {
    const app = fakeApp();
    app.prefs.set('stepEditing', true);
    const rec = new Recorder(app, null);
    const live = new LiveInput(app, rec);
    shared.cursor.tick = STEP * 2;
    shared.grid = STEP;
    const pat = app.store.view.pattern;
    const ch = app.store.view.channel;
    live.noteOn(60, 0.8, 'typing');
    live.noteOn(64, 0.8, 'typing');
    live.noteOff(60, 'typing');
    expect(shared.cursor.tick).toBe(STEP * 2);
    live.noteOff(64, 'typing');
    expect(shared.cursor.tick).toBe(STEP * 3);
    const notes = E.getNotes(app.store.project, pat, ch).filter((n) => n.pos === STEP * 2 && (n.key === 60 || n.key === 64));
    expect(notes).toHaveLength(2);
    expect(notes[0].len).toBe(STEP);
  });
});
