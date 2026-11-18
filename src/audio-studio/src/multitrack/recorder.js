// Recording into armed tracks of a session: plays the session from the
// playhead while capturing the default input, then adds the take as a new
// file (Files panel) and a clip on each armed track. Input monitoring routes
// the input to the output while recording when an armed track has it on.
//
// With a time selection, recording punches in over it: playback starts the
// pre-roll (Preferences > Playback and Recording) before the selection and
// only the selected range is kept. With loop playback on as well, playback
// cycles over the selection and every complete pass becomes its own take;
// the takes stack on the track with only the newest one unmuted.

import { AudioFile } from '../model/audio-file.js';
import { Channel } from '../audio/channel.js';
import * as S from '../model/session-edits.js';
import { markersInRange } from '../model/edits.js';
import { createMarker } from '../model/markers.js';
import { channelsAtRate, linkSource } from './insert.js';
import { announce } from '../lib/dom.js';

/**
 * Takes to keep from a recording of `n` frames that started `lead` frames
 * before a punch range of `length` frames: one take (the range, or what was
 * recorded of it), or with `loop` one per complete pass (a final partial pass
 * only when no pass completed). Returns [{ start, length }] into the recording.
 */
export function punchTakes(n, lead, length, loop) {
  const avail = n - lead;
  if (avail <= 0 || length <= 0) return [];
  if (!loop) return [{ start: lead, length: Math.min(length, avail) }];
  const passes = Math.floor(avail / length);
  if (!passes) return [{ start: lead, length: avail }];
  return Array.from({ length: passes }, (_, i) => ({ start: lead + i * length, length }));
}

export class SessionRecorder {
  constructor(app) {
    this.app = app;
    this.take = null;
    this.starting = null;
    this.stopping = null;
    // Stopping the transport any other way (Space, switching documents)
    // ends the take instead of leaving the input capturing.
    app.on('transport', (state) => {
      if (state === 'stopped' && this.take) this.stop();
    });
  }

  get active() {
    return Boolean(this.starting || this.take || this.stopping);
  }

  async toggle(doc) {
    if (this.active) return this.stop();
    return this.start(doc);
  }

  async start(doc) {
    if (this.active) return;
    const app = this.app;
    const armed = doc.state.tracks.filter((t) => t.type === 'audio' && t.arm);
    if (!armed.length) {
      app.notify('Arm a track for recording first (the R button in its header).');
      return;
    }
    const engine = app.engine;
    const pending = this.starting = {};
    const offClose = doc.on('close', () => this.stop());
    const offActive = app.on('active', (active) => { if (active !== doc) this.stop(); });
    pending.off = () => { offClose(); offActive(); };
    app.setStatus?.('Opening audio input...');
    app.emit('transport', 'recording-pending');
    try {
      await engine.openInput();
    } catch (err) {
      if (this.starting !== pending) return;
      this.starting = null;
      pending.off();
      app.setStatus?.('');
      app.emit('transport', engine.state || 'stopped');
      if (err.name !== 'AbortError') app.notify('The microphone could not be opened. Check the browser permission.', { error: true });
      return;
    }
    if (this.starting !== pending) return;
    this.starting = null;
    pending.off();
    const chunks = [];
    const off = engine.on('record-data', (channels) => chunks.push(channels));
    let monitoring = false;
    if (armed.some((t) => t.monitor)) {
      try {
        engine.input.src.connect(engine.ctx.destination);
        monitoring = true;
      } catch {
        // Monitoring is best effort.
      }
    }
    // Punch in over a time selection, after the pre-roll; loop playback records takes.
    const punch = doc.hasSelection ? { start: doc.selection.start, end: doc.selection.end } : null;
    const preroll = punch ? Math.round((Number(app.prefs?.get('prerollSeconds')) || 0) * doc.sampleRate) : 0;
    const loop = Boolean(punch && app.loop);
    const from = punch ? Math.max(0, punch.start - preroll) : doc.cursor;
    const take = { doc, from, punch, loop, chunks, off, armed: armed.map((t) => t.id), closed: false, controller: new AbortController() };
    // Closing the session stops the transport; the take must not reopen it.
    take.offClose = doc.on('close', () => { take.closed = true; this.stop(); });
    take.offActive = app.on('active', (active) => { if (active !== doc) this.stop(); });
    this.take = take;
    app.playStart = from;
    try {
      await engine.play({ from, to: punch && !loop ? punch.end : null, loop: loop ? { start: punch.start, end: punch.end } : null, signal: take.controller.signal });
    } catch (err) {
      if (this.take !== take) return; // Stop already owns this take's cleanup.
      // Playback refused (e.g. a rate this browser cannot play) or failed:
      // undo the start so the input is not left capturing, then report it.
      engine.setRecording(false);
      off();
      take.offClose();
      take.offActive();
      if (this.take?.chunks === chunks) this.take = null;
      app.playStart = null;
      if (monitoring) {
        try {
          engine.input?.src.disconnect(engine.ctx.destination);
        } catch {
          // Already disconnected.
        }
      }
      // The input stays open only for Meter Input Signal, which opened it for itself.
      if (!app.inputMetering) engine.closeInput();
      app.setStatus?.('');
      app.emit('transport', engine.state || 'stopped');
      throw err;
    }
    if (this.take !== take) return;
    // Context/DSP preparation may wait on I/O. Capturing during that wait
    // would prepend unrelated input before playback actually starts.
    engine.setRecording(true);
    app.setStatus?.('Recording...');
    app.recording = true;
    app.emit('transport', 'recording');
    announce('Recording');
  }

  async stop() {
    if (this.starting) {
      const pending = this.starting;
      this.starting = null;
      pending.off();
      if (!this.app.inputMetering) this.app.engine.closeInput();
      this.app.setStatus?.('Recording cancelled');
      this.app.emit('transport', this.app.engine.state || 'stopped');
      return;
    }
    if (this.stopping) return this.stopping;
    const take = this.take;
    if (!take) return;
    this.take = null;
    // Flushing and committing still own the input. A second Record click
    // must not open another capture that this stop would then close.
    this.stopping = this.#finish(take);
    try {
      return await this.stopping;
    } finally {
      this.stopping = null;
      this.app.emit('transport', this.app.engine.state || 'stopped');
    }
  }

  async #finish(take) {
    const app = this.app;
    const engine = app.engine;
    // A new playback may change the context while the last capture block is
    // being delivered. These settings belong to the take that just stopped.
    const rate = engine.rate;
    // Both the playback delay and the input delay come off the recorded take.
    const latency = engine.outputLatencyFrames + (engine.inputLatencyFrames || 0);
    const inputRequest = engine.inputRequest;
    take.controller.abort();
    engine.setRecording(false);
    engine.stop();
    app.recording = false;
    app.playStart = null;
    app.setStatus?.('Recording stopped');
    app.emit('transport', 'stopped');
    // Let the capture worklet flush its last block.
    await new Promise((r) => setTimeout(r, 150));
    take.off();
    take.offClose();
    take.offActive();
    // Context migration keeps this request id; an explicitly newer input
    // request owns its own cleanup and must not be closed by the old take.
    if (engine.inputRequest === inputRequest) engine.closeInput();
    const doc = take.doc;
    const n = take.chunks.reduce((s, c) => s + c[0].length, 0);
    if (n <= latency + 16) {
      app.notify('Nothing was recorded.');
      return;
    }
    const nch = Math.max(...take.chunks.map((c) => c.length));
    const data = Array.from({ length: nch }, () => new Float32Array(n));
    let at = 0;
    for (const c of take.chunks) {
      for (let ch = 0; ch < nch; ch++) data[ch].set(c[Math.min(ch, c.length - 1)], at);
      at += c[0].length;
    }
    // Compensate for the round trip: the take starts when the player heard the playhead.
    const trimmed = data.map((d) => d.subarray(Math.min(latency, d.length - 1)));
    let channels = trimmed.map((d) => Channel.fromSamples(d.slice()));
    channels = await channelsAtRate(channels, rate, doc.sampleRate);
    const total = channels[0].length;
    // The parts of the recording to keep, each placed at a timeline position.
    const pieces = take.punch
      ? punchTakes(total, take.punch.start - take.from, take.punch.end - take.punch.start, take.loop).map((p) => ({ ...p, at: take.punch.start }))
      : [{ start: 0, length: total, at: take.from }];
    if (!pieces.length) {
      app.notify('Recording stopped before the selection.');
      return;
    }
    let state = doc.state;
    // Every armed track was deleted while recording: the takes stay as files.
    if (!take.armed.some((id) => S.findTrack(state, id))) {
      pieces.forEach((p, i) => {
        const name = this.app.uniqueName(pieces.length > 1 ? `Recording_Take ${i + 1}` : 'Recording_Take', '.wav');
        const file = new AudioFile({ name, sampleRate: doc.sampleRate, channels: channels.map((c) => c.slice(p.start, p.start + p.length)), info: { bitDepth: 32, format: 'wav' } });
        file.savedState = null;
        app.addDocument(file, { activate: false });
      });
      app.notify(`The armed ${take.armed.length > 1 ? 'tracks were' : 'track was'} deleted while recording. The recording is in the Files panel.`);
      return;
    }
    const ids = [];
    for (const trackId of take.armed) {
      const track = S.findTrack(state, trackId);
      if (!track) continue;
      const all = track.channels === 1 ? [channels[0]] : [channels[0], channels[Math.min(1, channels.length - 1)]];
      const clips = [];
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        const own = all.map((c) => c.slice(p.start, p.start + p.length));
        // Preferences > Markers & Metadata: session markers during the take go into the take's file.
        const markers = app.prefs?.get('markersInMixdowns') ? markersInRange(doc.state.markers, p.at, p.at + p.length).map((m) => createMarker(m)) : [];
        const base = pieces.length > 1 ? `${track.name}_Take ${i + 1}` : `${track.name}_Take`;
        const file = new AudioFile({ name: this.app.uniqueName(base, '.wav'), sampleRate: doc.sampleRate, channels: own, markers, info: { bitDepth: 32, format: 'wav' } });
        file.savedState = null;
        app.addDocument(file, { activate: false });
        const sourceId = await linkSource(doc, file);
        // Only the newest of stacked takes plays; the others stay to pick from.
        clips.push(S.createClip({ trackId, sourceId, name: file.name.replace(/\.wav$/, ''), start: p.at, length: p.length, mute: i < pieces.length - 1 }));
      }
      // Takes play over the clips they were recorded over (a punch-in replaces what is there).
      state = S.addClipsOnTop(state, clips);
      ids.push(clips[clips.length - 1].id);
    }
    // The session was closed while recording: the takes stay as files, the session is not reopened.
    if (take.closed) {
      app.notify(`${doc.name} was closed while recording. The recording is in the Files panel.`);
      return;
    }
    doc.apply(pieces.length > 1 ? 'Record Takes' : 'Record', state, { clips: ids, cursor: pieces[0].at });
    announce(pieces.length > 1 ? `Recorded ${pieces.length} takes` : `Recorded ${ids.length} take${ids.length > 1 ? 's' : ''}`);
  }
}
