// Smart input monitoring for armed tracks: a track armed for recording with
// Monitor Input on lets you hear the input while the transport is stopped (to
// set levels and rehearse), goes quiet during playback so the recorded
// material plays instead, and is heard again while recording (the recorder
// routes it then). The input must be open: arming opens it for metering
// (Preferences > Multitrack), or Meter Input Signal does.

export class SmartMonitor {
  constructor(app) {
    this.app = app;
    this.node = null;
    this.bound = null;
    const sync = () => this.sync();
    app.on('doc-change', (doc, e) => doc.kind === 'session' && (e.kind === 'edit' || e.kind === 'history') && sync());
    app.on('active', sync);
    app.on('transport', sync);
    // The input opens a moment after arming; its first meter readings bind the monitor.
    app.engine.on?.('input-meter', () => {
      if (this.bound !== app.engine.input) sync();
    });
  }

  /** True when the active session has a track armed with Monitor Input on. */
  wanted() {
    const doc = this.app.active;
    return doc?.kind === 'session' && doc.state.tracks.some((t) => t.type === 'audio' && t.arm && t.monitor);
  }

  sync() {
    const engine = this.app.engine;
    const input = engine.input;
    // Stopped: monitor. Playing back: quiet. Recording: the recorder monitors.
    const on = Boolean(input && this.wanted() && !engine.playing && !this.app.recording);
    if (this.bound && (this.bound !== input || !on)) this.#release();
    if (on && !this.bound) {
      try {
        this.node = engine.ctx.createGain();
        input.src.connect(this.node);
        this.node.connect(engine.ctx.destination);
        this.bound = input;
      } catch {
        // Monitoring is best effort (the input may be closing).
        this.#release();
      }
    }
  }

  #release() {
    try {
      this.bound?.src.disconnect(this.node);
      this.node?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.node = null;
    this.bound = null;
  }

  /** True while the input is heard through the monitor. */
  get active() {
    return Boolean(this.bound);
  }
}
