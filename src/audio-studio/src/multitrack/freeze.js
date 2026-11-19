// Frozen (pre-rendered) tracks: a frozen track's clips and effects are
// rendered offline once and played back as one stream, so its effects cost
// nothing during playback. Volume, pan, mute and sends stay live. The render
// is kept on the session (doc.frozen, not in the undo history) with the key it
// was made for; editing the track's clips, effects or effect automation makes
// it stale, and it is rendered again in the background a moment later.

import { freezeKey } from '../model/session-graph.js';
import * as S from '../model/session-edits.js';
import { renderSession } from './render.js';
import { Channel } from '../audio/channel.js';

/** Seconds rendered past the track's last clip, for effect tails. */
const TAIL_SECONDS = 4;
const DELAY_MS = 600;

/**
 * The state a freeze renders: only the track and its clips, at unity gain and centre, without
 * volume, pan, mute automation, sends or routing (those stay live).
 */
export function freezeState(state, trackId) {
  const t = S.findTrack(state, trackId);
  const automation = Object.fromEntries(Object.entries(t.automation).filter(([k]) => S.fxParamRef(k)));
  // Post-fader effects run after the volume and pan, so those go into the render too.
  const fader = t.fxPost ? { volume: t.volume, pan: t.pan } : { volume: 0, pan: 0 };
  const lanes = t.fxPost ? { volume: t.automation.volume, pan: t.automation.pan } : { volume: [], pan: [] };
  const track = { ...t, ...fader, mute: false, solo: false, sends: [], output: 'master', freeze: false, automation: { ...lanes, mute: [], ...automation } };
  return {
    ...state,
    metronome: false,
    tracks: [track],
    master: S.createTrack({ type: 'master', name: 'Mix', channels: 2 }),
    clips: state.clips.filter((c) => c.trackId === trackId),
  };
}

/**
 * Whether a track can be frozen: an audio track in a stereo session. With post-fader effects its
 * volume and pan are rendered too, so pre-fader sends (which need the dry signal) rule it out.
 */
export function canFreeze(state, t) {
  if (!t || t.type !== 'audio' || state.master.channels === 6) return false;
  return !(t.fxPost && (t.sends || []).some((x) => x.pre && x.on && x.target));
}

/** Keeps the frozen tracks of every open session rendered. */
export class FreezeController {
  constructor(app) {
    this.app = app;
    this.timers = new Map();
    app.on('doc-change', (doc, e) => {
      if (doc.kind !== 'session' || !['edit', 'history', 'graph'].includes(e.kind)) return;
      this.schedule(doc);
    });
  }

  schedule(doc) {
    clearTimeout(this.timers.get(doc));
    this.timers.set(doc, setTimeout(() => this.update(doc), DELAY_MS));
  }

  /** Renders every frozen track whose render is missing or stale (one at a time). */
  async update(doc) {
    if (!this.app.documents.includes(doc)) return;
    doc.frozen ||= new Map();
    doc.freezing ||= new Map();
    const state = doc.state;
    for (const t of state.tracks) {
      if (!t.freeze || !canFreeze(state, t)) {
        if (doc.frozen.delete(t.id)) doc.emit('change', { kind: 'freeze' });
        continue;
      }
      const key = freezeKey(state, t, doc.pool);
      if (doc.frozen.get(t.id)?.key === key || doc.freezing.get(t.id)?.key === key) continue;
      doc.freezing.get(t.id)?.controller.abort();
      const job = { key, controller: new AbortController() };
      doc.freezing.set(t.id, job);
      doc.emit('change', { kind: 'freeze' });
      try {
        const clips = state.clips.filter((c) => c.trackId === t.id);
        const end = clips.length ? Math.max(...clips.map(S.clipEnd)) + Math.round(TAIL_SECONDS * state.sampleRate) : 0;
        if (end > 0) {
          const data = await renderSession(this.app, doc, { state: freezeState(state, t.id), start: 0, end, master: false, label: `Freezing ${t.name}`, signal: job.controller.signal });
          if (doc.freezing.get(t.id) !== job) continue;
          doc.frozen.set(t.id, { key, channels: data.map((d) => Channel.fromSamples(d)), length: end });
        }
      } catch (err) {
        if (job.controller.signal.aborted) continue;
        this.app.notify?.(`${t.name} could not be frozen: ${err?.message || err}`, { error: true });
      } finally {
        if (doc.freezing.get(t.id) === job) doc.freezing.delete(t.id);
      }
      // The new render plays from the next graph update.
      doc.emit('change', { kind: 'graph' });
    }
  }
}
