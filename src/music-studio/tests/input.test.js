import { describe, it, expect, vi } from 'vitest';
import { keyForCode, octaveRange, clampOctave, LOWER_ROW, UPPER_ROW, BASE_KEY } from '../src/input/keymap.js';
import { TypingKeyboard } from '../src/input/typing.js';
import { LiveInput } from '../src/input/live.js';
import { parseMidi, MidiInput } from '../src/input/midi.js';
import { install as installInput } from '../src/input/index.js';
import { msToTicks, patternTick, recordedNote, clipAt, Recorder } from '../src/input/recorder.js';
import { Store } from '../src/model/store.js';
import { Emitter } from '../src/lib/emitter.js';
import { demoProject } from '../src/model/demo.js';
import * as E from '../src/model/edits.js';
import { shared } from '../src/pianoroll/state.js';
import { PPQ, STEP } from '../src/model/time.js';
import { tempoMap } from '../src/engine/compile.js';
import { tempoToNorm } from '../src/engine/tempo.js';

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
  it('does not replay a released attack when the same key is pressed during audio startup', async () => {
    const app = fakeApp();
    app.engine.ready = false;
    let ready;
    const starting = new Promise((resolve) => { ready = resolve; });
    app.engine.start.mockReturnValue(starting);
    const live = new LiveInput(app, null);
    live.noteOn(60, 0.2, 'typing');
    live.noteOff(60, 'typing');
    live.noteOn(60, 0.9, 'typing');
    ready(true);
    await starting;
    expect(app.engine.noteOn).toHaveBeenCalledTimes(1);
    expect(app.engine.noteOn).toHaveBeenCalledWith(app.store.view.channel, 60, 0.9);
    live.noteOff(60, 'typing');
    expect(live.isHeld(60)).toBe(false);
  });

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
  it('keeps a newer toggle enabled when a canceled startup request completes', async () => {
    const app = fakeApp();
    app.prefs.set('midiInput', true);
    const commands = [];
    app.commands = { register: (...items) => commands.push(...items) };
    let finishStartup;
    const startup = new Promise((resolve) => { finishStartup = resolve; });
    const current = { inputs: new Map(), onstatechange: null };
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn().mockReturnValueOnce(startup).mockResolvedValueOnce(current) });
    try {
      const { midi } = installInput(app);
      const toggle = commands.find((c) => c.id === 'options.midiInput');
      await toggle.run(); // off while startup is pending
      await toggle.run(); // on with a new request
      finishStartup({ inputs: new Map(), onstatechange: null });
      await startup;
      await Promise.resolve();
      expect(app.prefs.get('midiInput')).toBe(true);
      expect(midi.access).toBe(current);
      midi.disable();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('releases only the disconnected device and clears its sustain state', () => {
    const app = fakeApp();
    const live = new LiveInput(app, null);
    const midi = new MidiInput(app, live);
    const port = { id: 'a', name: 'Keyboard A', type: 'input', state: 'disconnected', onmidimessage: midi.onMessage };
    midi.onMessage({ target: port, data: [0xb0, 64, 127] });
    midi.onMessage({ target: port, data: [0x90, 60, 100] });
    midi.onMessage({ target: port, data: [0x80, 60, 0] });
    midi.handle([0x90, 62, 100], 'b');
    live.noteOn(64, 0.8, 'typing');
    midi.onState({ port });
    expect(live.isHeld(60)).toBe(false);
    expect(port.onmidimessage).toBeNull();
    expect(live.isHeld(62)).toBe(true);
    expect(live.isHeld(64)).toBe(true);
    port.state = 'connected';
    midi.onState({ port });
    port.onmidimessage({ target: port, data: [0x90, 60, 100] });
    port.onmidimessage({ target: port, data: [0x80, 60, 0] });
    expect(live.isHeld(60)).toBe(false);
  });

  it.each([
    ['channels', 0x91, 'keyboard-a'],
    ['devices', 0x90, 'keyboard-b'],
  ])('keeps overlapping keys held independently across MIDI %s', (_label, status, port) => {
    const app = fakeApp();
    const live = new LiveInput(app, null);
    const midi = new MidiInput(app, live);
    midi.handle([0x90, 60, 100], 'keyboard-a');
    midi.handle([status, 60, 100], port);
    midi.handle([0x80, 60, 0], 'keyboard-a');
    expect(live.isHeld(60)).toBe(true);
    expect(app.engine.noteOff).not.toHaveBeenCalled();
    midi.handle([status - 0x10, 60, 0], port);
    expect(live.isHeld(60)).toBe(false);
    expect(app.engine.noteOff).toHaveBeenCalledTimes(1);
  });

  it('applies sustain and all-notes-off only to their device and MIDI channel', () => {
    const app = fakeApp();
    const live = new LiveInput(app, null);
    const midi = new MidiInput(app, live);
    midi.handle([0xb0, 64, 127], 'keyboard-a');
    midi.handle([0x91, 62, 100], 'keyboard-a');
    midi.handle([0x81, 62, 0], 'keyboard-a');
    expect(live.isHeld(62)).toBe(false);
    midi.handle([0x90, 60, 100], 'keyboard-a');
    midi.handle([0x80, 60, 0], 'keyboard-a');
    midi.handle([0x90, 64, 100], 'keyboard-b');
    midi.handle([0xb0, 120, 0], 'keyboard-b');
    expect(live.isHeld(64)).toBe(false);
    expect(live.isHeld(60)).toBe(true);
    midi.handle([0xb0, 64, 0], 'keyboard-a');
    expect(live.isHeld(60)).toBe(false);
  });

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
  it('auditions notes during count-in without recording notes released before playback starts', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const live = new LiveInput(app, rec);
    const before = app.store.project;
    Object.assign(app.engine, { recording: true, playing: true, countingIn: true });
    app.engine.emit('state');
    live.noteOn(67, 0.9, 'midi');
    live.noteOff(67, 'midi');
    expect(app.engine.noteOn).toHaveBeenCalledWith(app.store.view.channel, 67, 0.9);
    expect(app.engine.noteOff).toHaveBeenCalledWith(app.store.view.channel, 67);
    expect(app.store.project).toBe(before);
    app.engine.countingIn = false;
    app.engine.emit('state');
    app.engine.playing = false;
    app.engine.emit('state');
    expect(app.store.project).toBe(before);
    expect(app.store.gesture).toBeNull();
    expect(app.notify).not.toHaveBeenCalled();
  });

  it('records notes held across count-in from playback start on their original channel', () => {
    const app = fakeApp();
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 120 }));
    const rec = new Recorder(app, null);
    const live = new LiveInput(app, rec);
    const channel = app.store.view.channel;
    const pattern = app.store.view.pattern;
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      Object.assign(app.engine, { recording: true, playing: true, countingIn: true, position: 0 });
      app.engine.emit('state');
      live.noteOn(67, 0.9, 'midi');
      app.store.setChannel(app.store.project.channels[1].id);
      now.mockReturnValue(1500);
      app.engine.countingIn = false;
      app.engine.emit('state');
      now.mockReturnValue(1750);
      live.noteOff(67, 'midi');
      app.engine.playing = false;
      app.engine.emit('state');
      const note = E.getNotes(app.store.project, pattern, channel).find((n) => n.key === 67);
      expect(note).toMatchObject({ pos: 0, len: 48, vel: 0.9 });
      expect(app.notify).toHaveBeenCalledExactlyOnceWith('Recorded 1 note');
    } finally { now.mockRestore(); }
  });

  it('discards a canceled count-in without inserting its held notes into a later take', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const before = app.store.project;
    Object.assign(app.engine, { recording: true, playing: true, countingIn: true });
    rec.noteOn(67, 0.9, app.store.view.channel);
    Object.assign(app.engine, { playing: false, countingIn: false });
    app.engine.emit('state');
    app.engine.playing = true;
    app.engine.emit('state');
    rec.noteOff(67);
    expect(app.store.project).toBe(before);
    expect(app.store.gesture).toBeNull();
  });

  it('reports and resets the take count when stopping after all notes were committed by a loop', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    Object.assign(app.engine, { recording: true, playing: true });
    rec.noteOn(67, 0.9, app.store.view.channel);
    rec.noteOff(67);
    app.engine.emit('loop');
    app.engine.playing = false;
    app.engine.emit('state');
    expect(app.notify).toHaveBeenLastCalledWith('Recorded 1 note');
    app.notify.mockClear();
    app.engine.playing = true;
    rec.noteOn(69, 0.9, app.store.view.channel);
    rec.noteOff(69);
    app.engine.playing = false;
    app.engine.emit('state');
    expect(app.notify).toHaveBeenCalledExactlyOnceWith('Recorded 1 note');
  });

  it('does not count a transport seek as held note duration and finishes at stop before position resets', () => {
    const app = fakeApp();
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 120 }));
    const rec = new Recorder(app, null);
    Object.assign(app.engine, { recording: true, playing: true, position: 0 });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      rec.noteOn(67, 0.9, app.store.view.channel);
      now.mockReturnValue(1500);
      app.engine.position = 240;
      app.engine.emit('state'); // seek while recording
      now.mockReturnValue(2000);
      Object.assign(app.engine, { playing: false, position: 0 });
      app.engine.emit('state');
      const note = E.getNotes(app.store.project, app.store.view.pattern, app.store.view.channel).find((n) => n.key === 67);
      expect(note.len).toBe(192);
      expect(app.store.gesture).toBeNull();
    } finally { now.mockRestore(); }
  });

  it('measures a held note across a manual tempo change without retiming its earlier portion', () => {
    const app = fakeApp();
    app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 120 }));
    const rec = new Recorder(app, null);
    Object.assign(app.engine, { recording: true, playing: true, position: 0 });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      rec.noteOn(67, 0.9, app.store.view.channel);
      now.mockReturnValue(1500);
      app.engine.position = 96;
      app.store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 60 }));
      now.mockReturnValue(2000);
      rec.noteOff(67);
      const note = E.getNotes(app.store.project, app.store.view.pattern, app.store.view.channel).find((n) => n.key === 67);
      expect(note.len).toBe(144); // 96 ticks at 120 BPM, then 48 at 60 BPM
    } finally { now.mockRestore(); }
  });

  it('measures recorded note lengths through a song tempo ramp', () => {
    const app = fakeApp();
    app.store.apply('Tempo ramp', (p) => ({
      ...p, bpm: 120,
      automation: { tempo: { id: 'tempo', target: { kind: 'tempo' }, points: [{ t: 0, v: tempoToNorm(60) }, { t: 384, v: tempoToNorm(180) }] } },
      clips: [{ id: 'tempo-clip', kind: 'auto', ref: 'tempo', start: 0, len: 384, offset: 0, track: 0 }],
    }));
    const elapsed = tempoMap(app.store.project).seconds(192) * 1000;
    const rec = new Recorder(app, null);
    Object.assign(app.engine, { recording: true, playing: true, mode: 'song', position: 0 });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      rec.noteOn(67, 0.9, app.store.view.channel);
      now.mockReturnValue(1000 + elapsed);
      rec.noteOff(67);
      const note = E.getNotes(app.store.project, app.store.view.pattern, app.store.view.channel).find((n) => n.key === 67);
      expect(note.len).toBe(192);
    } finally { now.mockRestore(); }
  });

  it('keeps released notes when a loop ends during another editing gesture', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const pat = app.store.view.pattern;
    const ch = app.store.view.channel;
    const before = E.getNotes(app.store.project, pat, ch).length;
    app.store.begin('Drag');
    Object.assign(app.engine, { recording: true, playing: true });
    rec.noteOn(67, 0.9, ch);
    rec.noteOff(67);
    app.engine.emit('loop');
    app.store.commit();
    app.emit('frame');
    expect(E.getNotes(app.store.project, pat, ch)).toHaveLength(before + 1);
    expect(app.store.gesture === null).toBe(true);
    app.store.undo();
    expect(E.getNotes(app.store.project, pat, ch)).toHaveLength(before);
  });

  it('preserves separate stopped takes and their lengths while a drag blocks their writes', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const pat = app.store.view.pattern;
    const ch = app.store.view.channel;
    const before = E.getNotes(app.store.project, pat, ch).length;
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      app.store.begin('Drag');
      Object.assign(app.engine, { recording: true, playing: true });
      rec.noteOn(67, 0.9, ch);
      now.mockReturnValue(1250);
      app.engine.playing = false;
      app.engine.emit('state');
      app.engine.playing = true;
      rec.noteOn(69, 0.8, ch);
      now.mockReturnValue(1500);
      app.engine.playing = false;
      app.engine.emit('state');
      now.mockReturnValue(5000);
      app.store.commit();
      app.emit('frame');
      const notes = E.getNotes(app.store.project, pat, ch);
      expect(notes).toHaveLength(before + 2);
      expect(notes.filter((n) => n.key === 67 || n.key === 69).map((n) => n.len)).toEqual([50, 50]);
      app.store.undo();
      expect(E.getNotes(app.store.project, pat, ch)).toHaveLength(before + 1);
      app.store.undo();
      expect(E.getNotes(app.store.project, pat, ch)).toHaveLength(before);
    } finally {
      now.mockRestore();
    }
  });

  it.each(['commit', 'cancel'])('keeps a take stopped during another gesture after the gesture %s', (finish) => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const pat = app.store.view.pattern;
    const ch = app.store.view.channel;
    const before = E.getNotes(app.store.project, pat, ch).length;
    Object.assign(app.engine, { recording: true, playing: true });
    app.store.begin('Change tempo');
    app.store.preview((p) => E.setProjectProps(p, { bpm: 110 }));
    rec.noteOn(67, 0.9, ch);
    app.engine.playing = false;
    app.engine.emit('state');
    app.store[finish]();
    app.emit('frame');
    expect(E.getNotes(app.store.project, pat, ch)).toHaveLength(before + 1);
    expect(app.store.gesture).toBeNull();
    expect(app.store.undoLabel).toBe('Record notes');
    app.store.undo();
    expect(E.getNotes(app.store.project, pat, ch)).toHaveLength(before);
    expect(app.store.project.bpm).toBe(finish === 'commit' ? 110 : 124);
  });

  it('does not apply a deferred take to a replacement project with the same IDs', () => {
    const app = fakeApp();
    const rec = new Recorder(app, null);
    const original = app.store.project;
    Object.assign(app.engine, { recording: true, playing: true });
    app.store.begin('Change tempo');
    rec.noteOn(67, 0.9, app.store.view.channel);
    app.engine.playing = false;
    app.engine.emit('state');
    app.store.load(structuredClone(original));
    app.emit('frame');
    expect(app.store.project).toEqual(original);
    expect(app.store.gesture).toBeNull();
    expect(app.store.canUndo).toBe(false);
  });

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
