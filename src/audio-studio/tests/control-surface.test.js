import { describe, it, expect } from 'vitest';
import { decodeMidi, mcuAction, mcuFeedback, mappingKey, learnAction } from '../src/control-surface/protocol.js';

describe('control surface protocol', () => {
  it('decodes notes, CCs and 14-bit pitch bend', () => {
    expect(decodeMidi([0x90, 94, 127])).toEqual({ type: 'noteon', channel: 0, number: 94, value: 1 });
    expect(decodeMidi([0x90, 94, 0]).type).toBe('noteoff');
    expect(decodeMidi([0xb2, 16, 64])).toMatchObject({ type: 'cc', channel: 2, number: 16, raw: 64 });
    expect(decodeMidi([0xe3, 0x7f, 0x7f])).toMatchObject({ type: 'pitchbend', channel: 3, value: 1 });
    expect(decodeMidi([0xf8])).toBe(null);
  });

  it('maps strips, encoders, buttons, transport and banks', () => {
    expect(mcuAction(decodeMidi([0xe2, 0, 0x40]))).toEqual({ kind: 'fader', strip: 2, value: 8192 / 16383 });
    expect(mcuAction(decodeMidi([0xe8, 0, 0]))).toEqual({ kind: 'master', value: 0 });
    expect(mcuAction(decodeMidi([0xb0, 17, 0x03]))).toEqual({ kind: 'pan', strip: 1, delta: 6 });
    expect(mcuAction(decodeMidi([0xb0, 17, 0x41]))).toEqual({ kind: 'pan', strip: 1, delta: -2 });
    expect(mcuAction(decodeMidi([0x90, 18, 127]))).toEqual({ kind: 'toggle', strip: 2, key: 'mute' });
    expect(mcuAction(decodeMidi([0x90, 9, 127]))).toEqual({ kind: 'toggle', strip: 1, key: 'solo' });
    expect(mcuAction(decodeMidi([0x90, 27, 127]))).toEqual({ kind: 'select', strip: 3 });
    expect(mcuAction(decodeMidi([0x90, 94, 127]))).toEqual({ kind: 'command', id: 'transport.play' });
    expect(mcuAction(decodeMidi([0x90, 47, 127]))).toEqual({ kind: 'bank', delta: 8 });
    expect(mcuAction(decodeMidi([0x80, 94, 0]))).toBe(null);
  });

  it('sends lights and fader positions for the bank', () => {
    const tracks = Array.from({ length: 10 }, (_, i) => ({ volume: 0, mute: i === 8, solo: false, arm: false }));
    const out = mcuFeedback({ tracks, master: { volume: 0 }, offset: 8, playing: true, recording: false, loop: false, faderPos: () => 0.5 });
    expect(out).toContainEqual([0x90, 16, 127]); // strip 1 shows track 9 muted
    expect(out).toContainEqual([0x90, 17, 0]);
    expect(out).toContainEqual([0xe0, 0, 64]); // half travel: 8192
    expect(out).toContainEqual([0xe2, 0, 0]); // empty strip parks its fader
    expect(out).toContainEqual([0x90, 94, 127]);
  });

  it('runs learned mappings', () => {
    const map = { 'cc:0:7': 'track.volume', 'note:0:60': 'cmd:transport.toggle', 'cc:0:20': 'cmd:marker.add' };
    expect(mappingKey(decodeMidi([0xb0, 7, 10]))).toBe('cc:0:7');
    expect(learnAction(decodeMidi([0xb0, 7, 127]), map)).toEqual({ kind: 'selectedVolume', value: 1 });
    expect(learnAction(decodeMidi([0x90, 60, 100]), map)).toEqual({ kind: 'command', id: 'transport.toggle' });
    expect(learnAction(decodeMidi([0xb0, 20, 0]), map)).toBe(null);
    expect(learnAction(decodeMidi([0xb0, 20, 127]), map)).toEqual({ kind: 'command', id: 'marker.add' });
    // A knob turned through the top half fires once, again only after coming back down.
    const last = new Map();
    const fired = [40, 70, 90, 127, 100, 30, 80].map((v) => learnAction(decodeMidi([0xb0, 20, v]), map, last)).filter(Boolean);
    expect(fired).toHaveLength(2);
    expect(learnAction(decodeMidi([0xb0, 99, 127]), map)).toBe(null);
  });
});

describe('control surface ports', () => {
  const fakeMidi = () => {
    const inputs = new Map();
    const access = { inputs, outputs: new Map(), onstatechange: null };
    const plug = (id, name) => {
      const port = { id, name, state: 'connected', onmidimessage: null };
      inputs.set(id, port);
      access.onstatechange?.({ port });
      return port;
    };
    const unplug = (id) => {
      const port = inputs.get(id);
      port.state = 'disconnected';
      inputs.delete(id);
      access.onstatechange?.({ port });
    };
    return { access, plug, unplug };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function setup(midi) {
    localStorage.clear();
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => midi.access, configurable: true });
    const { App } = await import('../src/app.js');
    const { installControlSurface } = await import('../src/control-surface/index.js');
    const app = new App();
    app.syncGraph = () => {};
    const ran = [];
    app.commands.register({ id: 'transport.play', label: 'Play', run: () => ran.push('play') });
    installControlSurface(app);
    return { app, ran };
  }

  it('connects a controller plugged in after the surface was turned on', async () => {
    const midi = fakeMidi();
    const { app, ran } = await setup(midi);
    app.prefs.set('controlSurface', { enabled: true, input: '', output: '', protocol: 'mcu', mappings: {} });
    await tick();
    expect(app.controlSurface.status.text).toBe('No MIDI input connected.');
    const port = midi.plug('a', 'Desk');
    await tick();
    expect(app.controlSurface.status.text).toBe('Listening to Desk');
    port.onmidimessage({ data: [0x90, 94, 127] });
    expect(ran).toEqual(['play']);
    // Unplugged, then back again.
    midi.unplug('a');
    await tick();
    expect(app.controlSurface.status.text).toBe('No MIDI input connected.');
    const again = midi.plug('a', 'Desk');
    await tick();
    expect(app.controlSurface.status.text).toBe('Listening to Desk');
    again.onmidimessage({ data: [0x90, 94, 127] });
    expect(ran).toEqual(['play', 'play']);
    delete navigator.requestMIDIAccess;
  });
});

describe('control surface learn', () => {
  it('stops waiting for a control once the Learn button is gone', async () => {
    localStorage.clear();
    const inputs = new Map([['a', { id: 'a', name: 'Desk', state: 'connected', onmidimessage: null }]]);
    Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => ({ inputs, outputs: new Map(), onstatechange: null }), configurable: true });
    const { App } = await import('../src/app.js');
    const { installControlSurface } = await import('../src/control-surface/index.js');
    const app = new App();
    app.syncGraph = () => {};
    const ran = [];
    app.commands.register({ id: 'transport.play', label: 'Play', run: () => ran.push('play') });
    installControlSurface(app);
    app.prefs.set('controlSurface', { enabled: true, input: '', output: '', protocol: 'mcu', mappings: {} });
    await new Promise((r) => setTimeout(r, 0));
    const port = inputs.get('a');
    // While the button is shown, the next control is learned instead of performed.
    const learned = app.controlSurface.learn(() => true);
    port.onmidimessage({ data: [0x90, 94, 127] });
    expect(await learned).toBe('note:0:94');
    expect(ran).toEqual([]);
    // Preferences closed while waiting: the control works as usual and nothing is learned.
    const stale = app.controlSurface.learn(() => false);
    port.onmidimessage({ data: [0x90, 94, 127] });
    expect(await stale).toBe(null);
    expect(ran).toEqual(['play']);
    delete navigator.requestMIDIAccess;
  });
});
