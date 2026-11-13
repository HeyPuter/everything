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
    // Stopping the transport any other way (Space, switching documents)
    // ends the take instead of leaving the input capturing.
    app.on('transport', (state) => {
      if (state === 'stopped' && this.take) this.stop();
    });
  }

  get active() {
    return Boolean(this.take);
  }

  async toggle(doc) {
    if (this.take) return this.stop();
    return this.start(doc);
  }

  async start(doc) {
    const app = this.app;
    const armed = doc.state.tracks.filter((t) => t.type === 'audio' && t.arm);
    if (!armed.length) {
      app.notify('Arm a track for recording first (the R button in its header).');
      return;
    }
    const engine = app.engine;
    try {
      await engine.openInput();
    } catch {
      app.notify('The microphone could not be opened. Check the browser permission.', { error: true });
      return;
    }
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
    const take = { doc, from, punch, loop, chunks, off, armed: armed.map((t) => t.id), closed: false };
    // Closing the session stops the transport; the take must not reopen it.
    take.offClose = doc.on('close', () => (take.closed = true));
    this.take = take;
    engine.setRecording(true);
    app.playStart = from;
    try {
      await engine.play({ from, to: punch && !loop ? punch.end : null, loop: loop ? { start: punch.start, end: punch.end } : null });
    } catch (err) {
      // Playback refused (e.g. a rate this browser cannot play) or failed:
      // undo the start so the input is not left capturing, then report it.
      engine.setRecording(false);
      off();
      take.offClose();
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
      throw err;
    }
    app.recording = true;
    app.emit('transport', 'recording');
    announce('Recording');
  }

  async stop() {
    const app = this.app;
    const take = this.take;
    this.take = null;
    const engine = app.engine;
    engine.setRecording(false);
    // Let the capture worklet flush its last block.
    await new Promise((r) => setTimeout(r, 150));
    take.off();
    take.offClose();
    engine.stop();
    const rate = engine.rate;
    // What the player heard left the speakers output latency late, and their
    // performance reached the capture input latency late: both come off the take.
    const latency = engine.outputLatencyFrames + (engine.inputLatencyFrames || 0);
    engine.closeInput();
    app.recording = false;
    app.playStart = null;
    app.emit('transport', 'stopped');
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
        app.addDocument(new AudioFile({ name, sampleRate: doc.sampleRate, channels: channels.map((c) => c.slice(p.start, p.start + p.length)), info: { bitDepth: 32, format: 'wav' } }), { activate: false });
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
    if (app.active !== doc) app.activate(doc);
    doc.apply(pieces.length > 1 ? 'Record Takes' : 'Record', state, { clips: ids, cursor: pieces[0].at });
    announce(pieces.length > 1 ? `Recorded ${pieces.length} takes` : `Recorded ${ids.length} take${ids.length > 1 ? 's' : ''}`);
  }
}
