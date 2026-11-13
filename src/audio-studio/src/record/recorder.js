// Recording from an input device into the Waveform editor (insert at the
// playhead, or punch in over a selection) or for another feature through
// app.recorder (the multitrack editor records armed tracks with it).
//
// app.recorder API:
//   app.recorder.active                      true while recording
//   await app.recorder.start(opts)           opens the input and starts capturing
//     opts.doc        AudioFile to record into (Waveform mode); omit for external
//     opts.at         frame to insert at (default doc.cursor)
//     opts.replace    [start, end] to punch in over (recording stops at end)
//     opts.channels   take channel count (default doc channels, else 2)
//     opts.sampleRate rate of the take (default doc rate, else the engine's)
//     opts.deviceId   input device (default: Preferences > Audio Hardware)
//     opts.compensate drop input + output latency frames from the start, for
//                     takes recorded while playing back (overdubs)
//     opts.onData(take)  called (throttled) as audio arrives; take.length,
//                        take.peak, take.toChannels()
//   await app.recorder.stop()                -> { channels: Channel[], sampleRate,
//                                                 frames, latencyFrames, doc } | null
// While recording app.recording is true and 'transport' is emitted.

import { Take, placeTake } from './take.js';
import { Channel } from '../audio/channel.js';
import { dsp } from '../audio/dsp.js';
import { UserError } from '../lib/errors.js';
import { announce } from '../lib/dom.js';

const UPDATE_MS = 120;

/** User-facing message for getUserMedia failures. */
export function inputErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow access to the microphone for this site in your browser settings, then try again.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone or audio input was found. Connect an input device and try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The audio input is in use by another application or could not be started.';
  if (name === 'OverconstrainedError') return 'The selected input device is no longer available. Choose another in Preferences > Audio Hardware.';
  if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia) return 'Recording needs a secure (https) connection and a browser with microphone support.';
  return err?.message || 'The audio input could not be opened.';
}

export function createRecorder(app) {
  const engine = app.engine;
  let session = null;

  async function openInput(deviceId) {
    try {
      return await engine.openInput({ deviceId: deviceId || undefined });
    } catch (err) {
      // A remembered device that was unplugged: fall back to the default input.
      if (deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        app.notify('The selected input device was not found. Using the default input.');
        return engine.openInput({});
      }
      throw err;
    }
  }

  const recorder = {
    get active() {
      return Boolean(session);
    },

    get take() {
      return session?.take || null;
    },

    async start(opts = {}) {
      if (session) return;
      const doc = opts.doc || null;
      if (engine.playing && doc && !opts.keepPlaying) app.stop();
      const deviceId = opts.deviceId ?? app.prefs.get('inputDevice');
      try {
        await openInput(deviceId);
      } catch (err) {
        throw new UserError(inputErrorMessage(err));
      }
      const rate = engine.rate;
      const sampleRate = opts.sampleRate || doc?.sampleRate || rate;
      const channels = opts.channels || doc?.channelCount || Math.min(2, engine.input?.channels || 2);
      const inputLatency = engine.input?.stream?.getAudioTracks?.()[0]?.getSettings?.().latency || 0;
      const latencyFrames = opts.compensate ? engine.outputLatencyFrames + Math.round(inputLatency * rate) : 0;
      const replace = opts.replace && opts.replace[1] > opts.replace[0] ? opts.replace : null;
      const at = replace ? replace[0] : Math.max(0, Math.min(doc?.length ?? 0, Math.round(opts.at ?? doc?.cursor ?? 0)));
      // Punch-out limit in capture frames (the take is resampled later if rates differ).
      const limit = replace ? Math.round(((replace[1] - replace[0]) * rate) / sampleRate) : Infinity;
      const take = new Take(channels, { skip: latencyFrames, limit });
      session = { doc, take, at, replace, sampleRate, rate, latencyFrames, base: doc?.state ?? null, last: null, pushed: false, timer: 0, onData: opts.onData, stopping: null };
      const s = session;
      const offData = engine.on('record-data', (data) => {
        if (session !== s) return;
        take.append(data);
        if (!s.timer) s.timer = setTimeout(() => update(s), UPDATE_MS);
        if (take.full && !s.stopping) recorder.stop();
      });
      // An unplugged or revoked input ends its track, and the input then delivers only
      // silence: stop and keep what was recorded rather than record silence unnoticed.
      const track = engine.input?.stream?.getAudioTracks?.()[0];
      const onEnded = () => {
        if (session !== s || s.stopping) return;
        app.notify('The audio input was disconnected, so recording stopped.', { error: true });
        recorder.stop();
      };
      track?.addEventListener?.('ended', onEnded);
      s.off = () => {
        offData();
        track?.removeEventListener?.('ended', onEnded);
      };
      engine.setRecording(true);
      app.recording = true;
      app.meterInput?.(true);
      app.emit('transport', 'recording');
      app.setStatus(replace ? 'Recording (punch in)...' : 'Recording...');
      announce('Recording');
    },

    async stop() {
      const s = session;
      if (!s) return null;
      if (s.stopping) return s.stopping;
      s.stopping = (async () => {
        engine.setRecording(false);
        // The capture worklet posts its last partial block after the stop message.
        await new Promise((r) => setTimeout(r, 120));
        s.off();
        clearTimeout(s.timer);
        session = null;
        app.recording = false;
        if (!app.inputMetering) {
          engine.closeInput();
          app.meterInput?.(false);
        }
        let channels = s.take.toChannels();
        if (s.rate !== s.sampleRate && s.take.length) channels = await resampleChannels(channels, s.rate, s.sampleRate);
        const frames = channels[0]?.length ?? 0;
        if (s.doc) commit(s, channels);
        app.emit('transport', 'stopped');
        const secs = frames / s.sampleRate;
        app.setStatus(frames ? `Recorded ${secs.toFixed(1)} seconds` : 'Recording stopped');
        announce(frames ? `Recording stopped, ${secs.toFixed(1)} seconds` : 'Recording stopped');
        return { channels, sampleRate: s.sampleRate, frames, latencyFrames: s.latencyFrames, doc: s.doc };
      })();
      return s.stopping;
    },
  };

  /** Shows the growing take in the document as one "Record" history step. */
  function update(s) {
    s.timer = 0;
    if (session !== s) return;
    s.onData?.(s.take);
    if (!s.doc || !s.take.length) return;
    // Undo or another edit while recording: end the take rather than overwrite it.
    if (s.pushed && s.doc.history.state !== s.last) {
      recorder.stop();
      return;
    }
    const state = placeTake(s.base, s.take.toChannels(), { at: s.at, replace: s.replace });
    if (!s.pushed) {
      s.doc.apply('Record', state);
      s.pushed = true;
    } else s.doc.history.amend(state);
    s.last = state;
    const end = s.at + Math.round((s.take.length * s.sampleRate) / s.rate);
    s.doc.setCursor(end, { silent: true });
    followView(s.doc, end);
  }

  function commit(s, channels) {
    const doc = s.doc;
    if (!channels[0]?.length) {
      // Nothing captured: drop the empty step if one was made.
      if (s.pushed) doc.history.amend(s.base);
      return;
    }
    const state = placeTake(s.base, channels, { at: s.at, replace: s.replace });
    if (s.pushed && doc.history.state === s.last) doc.history.amend(state);
    else if (!s.pushed) doc.apply('Record', state);
    else {
      // The live step was undone or edited over: keep the take as a new step on top.
      doc.apply('Record', placeTake(doc.state, channels, { at: Math.min(s.at, doc.length), replace: null }));
    }
    const end = s.at + channels[0].length;
    doc.setCursor(Math.min(end, doc.length));
    followView(doc, end);
  }

  return recorder;
}

/** Keeps the end of the recording in view: whole file while short, then page by page. */
function followView(doc, frame) {
  const v = doc.view;
  if (frame <= v.end) return;
  const span = v.end - v.start;
  if (doc.length < doc.sampleRate * 60) doc.setView(0, Math.max(doc.length * 1.1, doc.sampleRate));
  else doc.setView(frame - span * 0.1, frame + span * 0.9);
}

async function resampleChannels(channels, from, to) {
  const d = await dsp();
  return channels.map((c) => Channel.fromSamples(d.resample(c.toArray(), from, to)));
}
