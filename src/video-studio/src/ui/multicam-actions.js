/**
 * Multi-camera clips: make one from clips of the same moment (lined up by
 * their sound), switch the angle at the playhead (also while playing, to
 * cut live), choose where the sound comes from, and flatten it back into
 * ordinary clips.
 */
import { announce } from '../lib/dom.js';
import { US, timecode } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { isMulticam, angleTracks, angleName, angleAt, switchAngle, removeCut, setAudioSource, MIN_ANGLES, MAX_ANGLES } from '../model/multicam.js';
import { createMulticam, flattenMulticam } from '../model/multicam-edit.js';
import { syncEnvelope, bestLag } from '../media/smart-edit.js';
import { decodeClipSound, downmix } from '../media/audio-analysis.js';
import { mediabunnyOpener } from '../engine/audio-mix.js';
import { progressDialog } from './smart-actions.js';
import { toast } from './dialog.js';

const HOP = 0.01;
// Below this normalized correlation two recordings are not taken to share their sound.
const MIN_SCORE = 0.2;

/** Seconds of sound compared per clip, and the largest offset searched (seconds). */
const MAX_SECONDS = 300;
const MAX_OFFSET = 60;

export function createMulticamActions(ctx) {
  const { store } = ctx;

  /** The selected (or given) multi-camera clip, with its track. */
  const target = (id = store.selected?.clip.id) => {
    const f = id && T.findClip(store.project, id);
    return f && isMulticam(f.clip) ? f : null;
  };

  /** Timeline time of the playhead, on a frame. */
  const frameTime = () => {
    const fps = store.fps;
    return Math.round(Math.round((store.time * fps) / US) * (US / fps));
  };

  /** Edit the multicam data of a clip; fn(mc, clip) returns the new data. */
  const editCuts = (id, label, fn) =>
    store.update(label, (p) => {
      const f = T.findClip(p, id);
      const c = f?.clip;
      if (!c || !isMulticam(c) || f.track.locked) return false;
      const next = fn(c.multicam, c);
      if (!next || JSON.stringify(next) === JSON.stringify(c.multicam)) return false;
      c.multicam = next;
    }, { structural: false });

  /**
   * Timeline starts that line the clips up by sound, measured against the
   * longest clip that has sound. Returns { starts, unmatched } where
   * unmatched lists the clips that keep their place.
   */
  async function lineUp(found, p) {
    const project = store.project;
    const usable = (c) => project.assets[c.assetId]?.hasAudio && !c.audioDetached && !c.freeze && (c.speed || 1) === 1 && !c.speedCurve;
    const withSound = found.filter((f) => usable(f.clip));
    const starts = {};
    const unmatched = found.filter((f) => !usable(f.clip));
    if (withSound.length < 2) return { starts, unmatched: found.filter((f) => f !== withSound[0]) };
    const ref = withSound.reduce((a, b) => (b.clip.duration > a.clip.duration ? b : a));
    const open = mediabunnyOpener(ctx.library);
    const envelope = async (clip) => {
      const snd = await decodeClipSound(open, project.assets[clip.assetId], clip, { maxSeconds: MAX_SECONDS, signal: p.signal });
      return snd && snd.channels.length ? syncEnvelope(downmix(snd.channels), snd.sampleRate, HOP) : null;
    };
    const steps = withSound.length;
    p.set(0.05, `Listening to ${T.clipLabel(project, ref.clip)}...`);
    const ea = await envelope(ref.clip);
    if (!ea) return { starts, unmatched: found.filter((f) => f !== ref) };
    let done = 1;
    for (const f of withSound) {
      if (f === ref) continue;
      p.set(done / steps, `Matching ${T.clipLabel(project, f.clip)}...`);
      const eb = await envelope(f.clip);
      done++;
      if (!eb) {
        unmatched.push(f);
        continue;
      }
      const maxLag = Math.min(Math.max(ea.length, eb.length), Math.round(MAX_OFFSET / HOP));
      const { lag, score } = bestLag(ea, eb, maxLag);
      if (score < MIN_SCORE) unmatched.push(f);
      else starts[f.clip.id] = Math.round(ref.clip.start + lag * HOP * US);
      // Let the dialog repaint between long comparisons.
      await new Promise((r) => setTimeout(r, 0));
    }
    return { starts, unmatched };
  }

  return {
    /** Nest 2 to 9 selected video clips as the angles of a multi-camera clip, synced by sound. */
    async createMulticam(ids = store.selectedIds) {
      const all = T.expandGroups(store.project, ids);
      const found = all.map((id) => T.findClip(store.project, id)).filter((f) => f && f.clip.type === 'video' && !f.track.locked);
      if (found.length < MIN_ANGLES || found.length > MAX_ANGLES) {
        toast(`Select ${MIN_ANGLES} to ${MAX_ANGLES} video clips, one per camera, to make a multi-camera clip.`, { kind: 'info' });
        return null;
      }
      const revision = store.revision;
      const p = progressDialog('Multi-camera clip', 'Lining up the angles by their sound...');
      let sync;
      try {
        sync = await lineUp(found, p);
      } catch (err) {
        if (err?.name === 'AbortError') {
          p.close();
          return null;
        }
        console.error(err);
        sync = { starts: {}, unmatched: found };
      }
      p.close();
      if (store.revision !== revision) {
        toast('The timeline changed while the sound was compared. Try again.', { kind: 'info' });
        return null;
      }
      let made = null;
      store.update('Create multi-camera clip', (proj) => {
        made = createMulticam(proj, found.map((f) => f.clip.id), { starts: sync.starts, ...store.opts });
        return Boolean(made);
      });
      if (!made) return null;
      store.select(made.id);
      const n = found.length;
      const names = sync.unmatched.map((f) => T.clipLabel(store.project, f.clip));
      if (!names.length) toast(`${made.name}: ${n} angles lined up by their sound. Press 1 to ${n} to switch.`, { kind: 'success' });
      else if (names.length >= n - 1) toast(`${made.name}: the angles do not share enough sound to line up, so they keep their timeline positions.`, { kind: 'info' });
      else toast(`${made.name}: ${names.join(', ')} could not be matched by sound and kept ${names.length === 1 ? 'its' : 'their'} timeline position.`, { kind: 'info' });
      announce(`${made.name} created`);
      return made;
    },

    /** Show an angle (0-based) from the playhead on, until the next cut. */
    switchAngle(angle, id) {
      const f = target(id);
      if (!f) return false;
      const c = f.clip;
      const n = angleTracks(c).length;
      if (angle < 0 || angle >= n) {
        toast(`This clip has ${n} angles.`, { kind: 'info' });
        return false;
      }
      if (store.time < c.start || store.time >= T.clipEnd(c)) {
        toast('Move the playhead over the multi-camera clip to switch angles.', { kind: 'info' });
        return false;
      }
      const t = Math.min(T.clipEnd(c) - 1, Math.max(c.start, frameTime()));
      const inner = t - c.start + c.in;
      if (angleAt(c.multicam, inner) === angle) return false;
      const name = angleName(c, angle);
      const ok = editCuts(c.id, `Switch to ${name}`, (mc, cc) => switchAngle(mc, inner, angle, n, T.sequenceLength(cc.sequence)));
      if (ok) announce(`${name} from ${timecode(t, store.fps)}`);
      return ok;
    },

    /** Remove the cut at inner time t (the angle before it carries on). */
    removeMulticamCut(t, id) {
      const f = target(id);
      if (!f) return false;
      return editCuts(f.clip.id, 'Remove angle cut', (mc, cc) => removeCut(mc, t, angleTracks(cc).length, T.sequenceLength(cc.sequence)));
    },

    /** Sound from one angle (index) or from the angle showing ('follow'). */
    setMulticamAudio(audio, id) {
      const f = target(id);
      if (!f) return false;
      return editCuts(f.clip.id, 'Multi-camera sound', (mc, cc) => setAudioSource(mc, audio, angleTracks(cc).length));
    },

    /** Replace a multi-camera clip by the clips it shows (and its sound). */
    flattenMulticam(id) {
      const f = target(id);
      if (!f) {
        toast('Select a multi-camera clip to flatten.', { kind: 'info' });
        return [];
      }
      ctx.player?.pause?.();
      let made = [];
      store.update('Flatten multi-camera clip', (p) => {
        made = flattenMulticam(p, f.clip.id);
        return made.length > 0;
      });
      if (made.length) {
        store.select(made.map((c) => c.id));
        announce('Multi-camera clip flattened');
      }
      return made;
    },
  };
}
