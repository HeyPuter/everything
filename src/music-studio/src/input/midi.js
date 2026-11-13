// Web MIDI input (Options > MIDI keyboard input). Opt-in: access is requested
// only when the option is turned on. Every connected input is heard; note on
// and off go to the live input with their velocity, the sustain pedal (CC 64)
// holds released notes until it lifts, and All Notes Off / All Sound Off
// (CC 123 / 120) release everything. Unsupported browsers and refused
// permission turn the option back off with a message.

export const SUSTAIN_CC = 64;

/** Decodes a MIDI message into { type: 'on'|'off'|'cc'|'other', channel, key, vel, cc, value }. */
export function parseMidi(data) {
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  if (status === 0x90 && data[2] > 0) return { type: 'on', channel, key: data[1], vel: data[2] / 127 };
  if (status === 0x80 || (status === 0x90 && data[2] === 0)) return { type: 'off', channel, key: data[1], vel: 0 };
  if (status === 0xb0) return { type: 'cc', channel, cc: data[1], value: data[2] };
  return { type: 'other', channel };
}

export class MidiInput {
  constructor(app, live) {
    this.app = app;
    this.live = live;
    this.access = null;
    this.sources = new Map(); // device/channel -> held keys and pedal state
    this.onMessage = (e) => this.handle(e.data, e.target?.id);
    this.onState = (e) => {
      const port = e.port;
      if (port?.type !== 'input') return;
      if (port.state === 'connected') {
        port.onmidimessage = this.onMessage;
        if (e.port.connection !== 'open') this.app.notify?.(`MIDI input connected: ${port.name || 'device'}`);
      } else if (port.state === 'disconnected') {
        this.app.notify?.(`MIDI input disconnected: ${port.name || 'device'}`);
      }
    };
  }

  get supported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  /** Requests access and listens to every input. Resolves true on success. */
  async enable({ quiet = false } = {}) {
    if (this.access) return true;
    if (!this.supported) {
      if (!quiet) this.app.notify?.('MIDI input is not supported in this browser. Try a Chromium-based browser or Firefox.', { error: true });
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      if (!quiet) this.app.notify?.('MIDI access was not allowed. Allow MIDI devices for this site in the browser settings to use a MIDI keyboard.', { error: true });
      return false;
    }
    const inputs = [...this.access.inputs.values()];
    for (const input of inputs) input.onmidimessage = this.onMessage;
    this.access.onstatechange = this.onState;
    if (!quiet) this.app.notify?.(inputs.length ? `MIDI input on: ${inputs.map((i) => i.name || 'device').join(', ')}` : 'MIDI input on. Connect a MIDI keyboard to play.');
    return true;
  }

  disable() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    this.access.onstatechange = null;
    this.access = null;
    this.releaseAll();
  }

  handle(data, port = 'default') {
    if (!data || data.length < 2) return;
    const m = parseMidi(data);
    if (m.type === 'other') return;
    const source = `midi:${JSON.stringify([port, m.channel])}`;
    let state = this.sources.get(source);
    if (!state) {
      state = { port, sustain: false, physical: new Set(), sustained: new Set() };
      this.sources.set(source, state);
    }
    if (m.type === 'on') {
      state.physical.add(m.key);
      if (state.sustained.has(m.key)) {
        state.sustained.delete(m.key);
        this.live.noteOff(m.key, source); // retrigger a sustained key
      }
      this.live.noteOn(m.key, Math.max(0.02, m.vel), source);
    } else if (m.type === 'off') {
      state.physical.delete(m.key);
      if (state.sustain) state.sustained.add(m.key);
      else this.live.noteOff(m.key, source);
    } else if (m.type === 'cc') {
      if (m.cc === SUSTAIN_CC) {
        const on = m.value >= 64;
        if (on === state.sustain) return;
        state.sustain = on;
        if (!on) {
          for (const k of state.sustained) if (!state.physical.has(k)) this.live.noteOff(k, source);
          state.sustained.clear();
        }
      } else if (m.cc === 123 || m.cc === 120) {
        this.live.releaseAll(source);
        this.sources.delete(source);
      }
    }
  }

  releaseAll() {
    for (const source of this.sources.keys()) this.live.releaseAll(source);
    this.sources.clear();
  }
}
