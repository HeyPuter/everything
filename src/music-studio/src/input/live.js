// Live notes from the typing keyboard and MIDI devices. Every note on goes
// to the channel the piano roll edits (store.view.channel) through the
// engine, to the recorder (recording and step edit), and out as a 'note'
// event so the piano roll keyboard can light the key. Note off always goes to
// the channel that started the note, even if the selection changed since.
//
//   app.liveInput.noteOn(key, vel, source)   source: 'typing' | 'midi' | 'ui'
//   app.liveInput.noteOff(key, source)
//   app.liveInput.on('note', (key, on, vel) => ...)

import { Emitter } from '../lib/emitter.js';

export class LiveInput extends Emitter {
  constructor(app, recorder) {
    super();
    this.app = app;
    this.recorder = recorder;
    this.held = new Map(); // key -> { channel, sources: Set }
  }

  noteOn(key, vel = 0.8, source = 'ui') {
    const channel = this.app.store.view.channel;
    const prev = this.held.get(key);
    if (prev) {
      prev.sources.add(source);
      return;
    }
    this.held.set(key, { channel, sources: new Set([source]) });
    const engine = this.app.engine;
    if (channel) {
      if (engine.ready) engine.noteOn(channel, key, vel);
      else
        engine
          .start()
          .then(() => {
            if (this.held.get(key)?.channel === channel) engine.noteOn(channel, key, vel);
          })
          .catch((err) => this.app.reportError?.(err));
    }
    this.recorder?.noteOn(key, vel, channel);
    this.emit('note', key, true, vel);
  }

  noteOff(key, source = 'ui') {
    const h = this.held.get(key);
    if (!h) return;
    h.sources.delete(source);
    if (!h.sources.size) this.#release(key, h);
  }

  /** Releases every held note (from one source, or all). */
  releaseAll(source = null) {
    for (const [key, h] of [...this.held]) {
      if (source && !h.sources.has(source)) continue;
      if (source) h.sources.delete(source);
      else h.sources.clear();
      if (!h.sources.size) this.#release(key, h);
    }
  }

  #release(key, h) {
    this.held.delete(key);
    if (h.channel) this.app.engine.noteOff(h.channel, key);
    this.recorder?.noteOff(key);
    this.emit('note', key, false, 0);
  }

  isHeld(key) {
    return this.held.has(key);
  }
}
