/**
 * Smart editing tools that run on this device: split a video at its shot
 * changes, cut silent parts out of the timeline, line up a separate
 * audio recording with a video by their sound, remove the background
 * behind people, even out flicker and save a clip's sound as a file.
 */
import { h, announce } from '../lib/dom.js';
import { abortable } from '../lib/abort.js';
import { icon } from '../lib/icons.js';
import { US, FRAME_SLACK } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { openDialog, toast } from './dialog.js';
import { frameDialogSignal, openFrameDialog } from './frame-dialog.js';
import { prefs, setPref } from './prefs.js';
import { detectScenes, silentRanges, syncEnvelope, bestLag } from '../media/smart-edit.js';
import { mixdown, clipsForScope } from '../media/transcribe.js';
import { levelEnvelope, decodeClipSound, downmix } from '../media/audio-analysis.js';
import { mediabunnyOpener } from '../engine/audio-mix.js';
import { removeRanges } from './panels/transcript.js';
import { sourceSpan, localAtSource } from '../model/speed-curve.js';
import { RATIOS } from '../model/project.js';
import { attentionPath, attentionCenter, smoothPath, coverScale, framingOffset, thinKeys, RF_W, RF_H } from '../media/reframe.js';
import { frameShift, cameraPath, smoothCamera, corrections } from '../media/stabilize.js';
import { grayFrames } from '../media/tracker.js';
import { CUTOUT_DEFAULT } from '../model/cutout.js';
import { ready } from '../media/segmenter.js';
import { frameLumas, fillGaps, flickerCorrections, flickerKeys, frameGrid, wobble, corrected } from '../media/flicker.js';
import { extractClipAudio } from '../media/extract-audio.js';
import { DEFAULT_ADJUST } from '../model/project.js';
import { adjustProp } from '../model/color.js';
import { pictureSizeFor } from '../model/picture-size.js';

/**
 * Timeline times (µs) to split a clip at for shot changes at source times
 * cuts (µs): the first frame of a timeline at fps that shows the new shot,
 * frames being looked up with FRAME_SLACK as the preview and export do (a
 * WebM stamps a frame up to half a millisecond after its time). Splits too
 * close to the clip's ends are left out.
 */
export function sceneSplitTimes(clip, cuts, fps) {
  const frame = US / fps;
  return cuts
    .map((src) => Math.round(Math.ceil((clip.start + localAtSource(clip, src - FRAME_SLACK * US - clip.in)) / frame - 1e-6) * frame))
    .filter((t) => t - clip.start >= T.MIN_CLIP && T.clipEnd(clip) - t >= T.MIN_CLIP);
}

/** A small modal with a progress bar and Cancel; returns { set, close, signal }. */
export function progressDialog(title, text, lifetime) {
  const ac = new AbortController();
  const bar = h('span');
  // What it is doing is read out as it changes, and the bar says how far along it is.
  const msg = h('p.dialog-text', { role: 'status' }, text);
  const track = h('div.progress', { role: 'progressbar', 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, bar);
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const options = { title, body: h('div', msg, track), actions: [cancel], className: 'small', closeOnBackdrop: false, onClose: () => ac.abort() };
  const d = lifetime ? openFrameDialog(options, lifetime) : openDialog(options);
  cancel.addEventListener('click', () => d.close());
  return {
    signal: ac.signal,
    set: (f, line) => {
      const pct = Math.round(Math.max(0, Math.min(1, f || 0)) * 100);
      bar.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', String(pct));
      if (line && msg.textContent !== line) msg.textContent = line;
    },
    close: () => d.close(),
  };
}

const curved = (c) => Boolean(c.speedCurve);

/** Frame size for shape r (a RATIOS entry) keeping the current frame's short side; null r keeps the frame. */
export function reframeSize(settings, r) {
  if (!r) return { width: settings.width, height: settings.height, ratio: settings.ratio };
  const k = Math.min(settings.width, settings.height) / Math.min(r.w, r.h);
  return { width: Math.max(16, Math.round((r.w * k) / 2) * 2), height: Math.max(16, Math.round((r.h * k) / 2) * 2), ratio: r.id };
}

/**
 * Auto reframe plan for one video or photo clip: the zoom that fills a
 * frame of shape dstAR and position keys that follow the subject.
 * Returns { id, scale, keys: [{ t, x, y }] }.
 */
export async function reframePlan(c, asset, blob, { dstAR, follow = 0.35, zoom = 1, signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const crop = c.crop || { l: 0, t: 0, r: 0, b: 0 };
  const cw = 1 - crop.l - crop.r;
  const ch = 1 - crop.t - crop.b;
  const size = pictureSizeFor(c, asset) || asset;
  const srcAR = (size.width * cw) / (size.height * ch);
  const scale = coverScale(srcAR, dstAR, zoom);
  const toCrop = (pt) => ({ ...pt, x: (pt.x - crop.l) / cw, y: (pt.y - crop.t) / ch });
  let path;
  if (c.type === 'image') {
    const bmp = await createImageBitmap(blob);
    try {
      signal?.throwIfAborted();
      const cv = new OffscreenCanvas(RF_W, RF_H);
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, RF_W, RF_H);
      const a = attentionCenter(g.getImageData(0, 0, RF_W, RF_H).data, RF_W, RF_H);
      path = [{ t: 0, x: a.x, y: a.y }];
    } finally {
      bmp.close?.();
    }
  } else if (c.freeze) {
    // A held frame still belongs to a video file. Decode that source instant
    // once, then keep its framing stationary for the whole freeze clip.
    path = (await attentionPath(blob, c.in, c.in + 1, { signal, onProgress })).map((pt) => ({ ...pt, t: 0 }));
  } else {
    const span = sourceSpan(c);
    const fps = Math.min(2, 240 / Math.max(1, span / US));
    const raw = await attentionPath(blob, c.in, c.in + span, { fps, signal, onProgress });
    path = smoothPath(raw, { follow }).map((pt) => ({ ...pt, t: Math.round(localAtSource(c, pt.t - c.in)) }));
  }
  const keys = path.map(toCrop).map((pt) => ({ t: Math.max(0, Math.min(c.duration, pt.t)), ...framingOffset(Math.min(1, Math.max(0, pt.x)), Math.min(1, Math.max(0, pt.y)), srcAR, dstAR, scale) }));
  return { id: c.id, scale, keys };
}

/** Put a reframe plan on a clip: its scale, and x/y keys in place of the old ones. */
export function applyReframePlan(c, plan) {
  c.keyframes ||= {};
  delete c.keyframes.scale;
  c.transform.scale = plan.scale;
  const xs = thinKeys(plan.keys.map((k) => ({ t: k.t, v: k.x, ease: 'easeInOut' })));
  const ys = thinKeys(plan.keys.map((k) => ({ t: k.t, v: k.y, ease: 'easeInOut' })));
  c.transform.x = xs[0]?.v ?? 0;
  c.transform.y = ys[0]?.v ?? 0;
  if (xs.length > 1) c.keyframes.x = xs;
  else delete c.keyframes.x;
  if (ys.length > 1) c.keyframes.y = ys;
  else delete c.keyframes.y;
}

/**
 * Silent stretches of the project's sound as timeline ranges (µs):
 * o = { scope: 'main' | 'all', thresholdDb, minSilence, pad } (seconds).
 */
export async function findSilences(ctx, o, { signal, onProgress } = {}) {
  const rate = 8000;
  const project = structuredClone(ctx.store.project);
  const mix = await mixdown(project, ctx.library, { scope: o.scope, sampleRate: rate, signal, onProgress });
  // The mix is peak-normalized, which is fine for a relative threshold.
  const hop = 0.02;
  const levels = levelEnvelope(mix, rate, hop);
  // Where no clip with sound plays (photos, titles, muted clips) the picture is
  // the point, not a pause in the sound: those stretches are never cut.
  const spans = clipsForScope(project, o.scope).map(({ clip }) => [clip.start / US, T.clipEnd(clip) / US]).sort((a, b) => a[0] - b[0]);
  for (let i = 0, k = 0, reach = -Infinity; i < levels.length; i++) {
    const t = (i + 0.5) * hop;
    while (k < spans.length && spans[k][0] <= t) reach = Math.max(reach, spans[k++][1]);
    if (t >= reach) levels[i] = Infinity;
  }
  return silentRanges(levels, hop, o).map((r) => ({ start: Math.round(r.start * US), end: Math.round(r.end * US) }));
}

export function createSmartActions(ctx) {
  const { store } = ctx;

  return {
    /** Split a video clip wherever the shot changes. */
    async splitScenes(clipId = store.selected?.clip.id) {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return;
      const f = clipId && T.findClip(store.project, clipId);
      if (!f || f.clip.type !== 'video' || f.clip.freeze) {
        toast('Select a video clip to split at its scene changes.', { kind: 'info' });
        return;
      }
      if (f.track.locked) return;
      const clip = f.clip;
      const assetId = clip.assetId;
      const isCurrentSource = () => T.findClip(store.project, clip.id)?.clip === clip
        && clip.assetId === assetId && clip.type === 'video' && !clip.freeze;
      const changedMessage = 'The clip changed. Run scene detection again to analyze its current video.';
      const requireSource = () => { if (!isCurrentSource()) throw new Error(changedMessage); };
      const asset = store.project.assets[assetId];
      const from = clip.in;
      const to = clip.in + sourceSpan(clip);
      const sensitivity = prefs().sceneSensitivity ?? 0.5;
      const p = progressDialog('Finding scene changes', `Looking through ${asset?.name || 'the clip'}...`, lifetime);
      try {
        const blob = await abortable(() => ctx.library.mediaBlob(asset), p.signal);
        requireSource();
        const fps = to - from > 600 * US ? 2 : 5;
        const cuts = await detectScenes(blob, from, to, { fps, sensitivity, signal: p.signal, onProgress: (x) => p.set(x) });
        p.signal.throwIfAborted();
        requireSource();
        const times = sceneSplitTimes(clip, cuts, store.fps || store.project.settings.fps || 30);
        if (!times.length) {
          toast('No scene changes were found in this clip.', { kind: 'info' });
          return;
        }
        let made = 0;
        const saved = store.update('Split scenes', (proj) => {
          if (!isCurrentSource()) return false;
          // Split from the end so earlier times still point into the same clip.
          for (const t of [...times].sort((a, b) => b - a)) if (T.splitClip(proj, clipId, t)) made++;
          return made > 0;
        });
        if (saved === false) throw new Error(isCurrentSource() ? 'Scene splits could not be saved. The clip may be locked or no longer available.' : changedMessage);
        toast(`Split into ${made + 1} scenes.`, { kind: 'success' });
        announce(`Split into ${made + 1} scenes`);
      } catch (err) {
        if (!p.signal.aborted && err?.name !== 'AbortError') {
          console.error(err);
          toast(isCurrentSource() ? err?.message || 'Could not analyze this clip.' : changedMessage, { kind: 'error' });
        }
      } finally {
        p.close();
      }
    },

    /** Find silent parts of the sound and cut them out of every unlocked track. */
    async removeSilences() {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return;
      const opts = { scope: 'main', thresholdDb: -38, minSilence: 0.6, pad: 0.12, ...(prefs().silenceOpts || {}) };
      const scope = h('select.select', h('option', { value: 'main' }, 'Base track'), h('option', { value: 'all' }, 'All audio'));
      scope.value = opts.scope;
      const thr = h('input.input', { type: 'number', min: -70, max: -10, step: 1, value: opts.thresholdDb });
      const min = h('input.input', { type: 'number', min: 0.2, max: 10, step: 0.1, value: opts.minSilence });
      const pad = h('input.input', { type: 'number', min: 0, max: 1, step: 0.02, value: opts.pad });
      const row = (label, el, unit) => h('label.pref-row', h('span.pref-label', label), h('span.pref-ctl', el, unit ? h('span.pref-unit', unit) : null));
      const status = h('p.asset-hint', { role: 'status' });
      const find = h('button.btn', { type: 'button' }, icon('search', 16), 'Find silences');
      const cut = h('button.btn.primary', { type: 'button', disabled: true }, icon('scissors', 16), 'Cut them');
      const cancel = h('button.btn', { type: 'button' }, 'Close');
      let found = [];
      let source = null;
      let ac = null;
      let closed = false;
      const d = openFrameDialog({
        title: 'Remove silences',
        body: h('div.prefs', h('p.dialog-text', 'Finds stretches where it is quiet and cuts them out of the video, closing the gaps.'),
          row('Listen to', scope), row('Quieter than', thr, 'dB'), row('For at least', min, 's'), row('Keep around speech', pad, 's'), status),
        actions: [cancel, h('span.spacer'), find, cut],
        className: 'prefs-dialog',
        // However it closes (Close, Escape, the X), stop listening.
        onClose: () => { closed = true; found = []; cut.disabled = true; ac?.abort(); },
      }, lifetime);
      cancel.addEventListener('click', () => d.close());
      const read = () => ({ scope: scope.value, thresholdDb: Number(thr.value), minSilence: Number(min.value), pad: Number(pad.value) });
      const AGAIN = 'Settings changed. Press Find silences to look again.';
      // Cuts affect every unlocked track, even when listening only to the base track.
      // Compare at action boundaries, not on every playback tick or project edit.
      const sourceStamp = (o) => {
        const p = store.project;
        const assets = [...new Set(clipsForScope(p, o.scope).map(({ clip }) => clip.assetId))].map((id) => {
          const a = p.assets[id];
          return [id, a.kind, a.hash, a.ext, a.mime, a.size, a.duration, a.hasAudio];
        });
        return JSON.stringify([p.id, p.timelineId, (store.nest || []).map((f) => f.id), p.tracks, assets]);
      };
      const currentSource = () => source?.project === store.project && source.stamp === sourceStamp(source.options);
      const sourceChanged = () => {
        found = [];
        cut.disabled = true;
        status.textContent = 'Timeline changed. Press Find silences to analyze it again.';
      };
      let searched = false;
      // What was found belongs to the settings it was found with.
      const changed = () => {
        found = [];
        cut.disabled = true;
        if (searched && !ac) status.textContent = AGAIN;
      };
      for (const el of [scope, thr, min, pad]) {
        el.addEventListener('input', changed);
        el.addEventListener('change', changed);
      }
      // An empty box reads as 0 dB (everything is "quieter than" that, so nearly the whole
      // timeline was found silent and cut) and a level typed without its minus is no better.
      const fields = [
        [thr, -70, -10, 'Quieter than takes a level from -70 to -10 dB.'],
        [min, 0.2, 10, 'For at least takes a time from 0.2 to 10 seconds.'],
        [pad, 0, 1, 'Keep around speech takes a time from 0 to 1 second.'],
      ];
      const invalid = () => {
        let first = null;
        for (const [el, lo, hi, message] of fields) {
          const v = Number(el.value);
          const bad = el.value.trim() === '' || !Number.isFinite(v) || v < lo || v > hi;
          el.setAttribute('aria-invalid', String(bad));
          if (bad) first ||= { el, message };
        }
        return first;
      };
      find.addEventListener('click', async () => {
        if (closed || ac) return;
        const wrong = invalid();
        if (wrong) {
          status.textContent = wrong.message;
          wrong.el.focus();
          return;
        }
        const o = read();
        setPref('silenceOpts', o);
        if (!clipsForScope(store.project, o.scope).length) {
          status.textContent = o.scope === 'main' ? 'The base track has no sound.' : 'There is no sound in this project.';
          return;
        }
        source = { project: store.project, options: o, stamp: sourceStamp(o) };
        found = [];
        ac = new AbortController();
        find.disabled = true;
        cut.disabled = true;
        status.textContent = 'Listening...';
        try {
          const ranges = await findSilences(ctx, o, { signal: ac.signal, onProgress: (x) => { if (!closed) status.textContent = `Listening... ${Math.round(x * 100)}%`; } });
          if (closed || ac.signal.aborted) return;
          if (!currentSource()) { sourceChanged(); return; }
          searched = true;
          if (JSON.stringify(read()) !== JSON.stringify(o)) {
            status.textContent = AGAIN;
            return;
          }
          found = ranges;
          const total = ranges.reduce((s, r) => s + r.end - r.start, 0);
          status.textContent = ranges.length ? `${ranges.length} silent part${ranges.length === 1 ? '' : 's'}, ${(total / US).toFixed(1)} s in all.` : 'No silences that long were found.';
          cut.disabled = !ranges.length;
        } catch (err) {
          if (!closed && err?.name !== 'AbortError') status.textContent = err?.message || 'Could not analyze the sound.';
        } finally {
          if (!closed) find.disabled = false;
          ac = null;
        }
      });
      cut.addEventListener('click', () => {
        if (closed || !found.length) return;
        if (!currentSource()) { sourceChanged(); return; }
        if (removeRanges(store, found, 'Remove silences') === false) {
          found = [];
          cut.disabled = true;
          status.textContent = 'No silence cuts were applied. Check track locks and find silences again.';
          return;
        }
        toast(`Removed ${found.length} silent part${found.length === 1 ? '' : 's'}.`, { kind: 'success' });
        d.close();
      });
    },

    /**
     * Stabilize a shaky video clip: follow the camera's shake and move each
     * frame back onto a smooth path, zooming in just enough to hide the edges.
     */
    /**
     * Turn automatic background removal on for the selected video and image
     * clips (or off when they all have it) and show its settings.
     */
    removeBackground(clipId = null) {
      const ids = clipId ? [clipId] : [...store.selection];
      const targets = ids.map((id) => T.findClip(store.project, id)).filter((f) => f && (f.clip.type === 'video' || f.clip.type === 'image'));
      const clips = targets.filter((f) => !f.track.locked).map((f) => f.clip);
      if (!clips.length) {
        toast(targets.length ? 'Unlock the track to change background removal.' : 'Select a video or image clip to remove its background.', { kind: 'info' });
        return false;
      }
      const off = clips.every((c) => c.cutout);
      const set = new Set(clips.map((c) => c.id));
      store.update(off ? 'Keep background' : 'Remove background', (p) => {
        for (const t of p.tracks) {
          for (const c of t.clips) {
            if (!set.has(c.id)) continue;
            if (off) delete c.cutout;
            else c.cutout ||= { ...CUTOUT_DEFAULT };
          }
        }
      }, { structural: false });
      if (!off) {
        ready();
        if (!store.selection.has(clips[0].id)) store.select(clips[0].id);
        ctx.inspector?.showVideoSub?.('cutout');
      }
      announce(off ? 'Background kept' : 'Removing background');
      return true;
    },

    async stabilize(clipId = store.selected?.clip.id) {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return;
      const f = clipId && T.findClip(store.project, clipId);
      if (!f || f.clip.type !== 'video' || f.clip.freeze) {
        toast('Select a video clip to stabilize.', { kind: 'info' });
        return;
      }
      if (f.track.locked) return;
      const clip = f.clip;
      const assetId = clip.assetId;
      const isCurrentSource = () => T.findClip(store.project, clip.id)?.clip === clip
        && clip.assetId === assetId && clip.type === 'video' && !clip.freeze;
      const changedMessage = 'The clip changed. Reopen Stabilize to analyze its current video.';
      const requireSource = () => { if (!isCurrentSource()) throw new Error(changedMessage); };
      const strength = h('select.select', h('option', { value: '6' }, 'Light'), h('option', { value: '15' }, 'Medium'), h('option', { value: '30' }, 'Strong'));
      strength.value = String(prefs().stabilizeStrength || '15');
      const go = h('button.btn.primary', { type: 'button' }, icon('focus', 16), 'Stabilize');
      const cancel = h('button.btn', { type: 'button' }, 'Cancel');
      const dlg = openFrameDialog({
        title: 'Stabilize',
        body: h('div.prefs', h('p.dialog-text', 'Smooths out camera shake by moving each frame back onto a steady path and zooming in slightly to hide the edges. Position and scale keyframes on this clip are replaced.'), h('label.pref-row', h('span.pref-label', 'Smoothing'), h('span.pref-ctl', strength))),
        actions: [cancel, go],
        className: 'prefs-dialog',
      }, lifetime);
      cancel.addEventListener('click', () => dlg.close());
      go.addEventListener('click', async () => {
        dlg.close();
        if (lifetime.aborted) return;
        setPref('stabilizeStrength', strength.value);
        if (!isCurrentSource()) {
          toast(changedMessage, { kind: 'error' });
          return;
        }
        if (T.findClip(store.project, clip.id)?.track.locked) {
          toast('Unlock the track to stabilize this clip.', { kind: 'info' });
          return;
        }
        const asset = store.project.assets[assetId];
        const W = 192;
        const H = Math.max(36, Math.round((W * (asset.height || 9)) / (asset.width || 16)));
        const fps = 15;
        const times = [];
        for (let t = 0; t < clip.duration; t += US / fps) times.push(Math.round(t));
        const p = progressDialog('Stabilizing', 'Following the camera movement...', lifetime);
        try {
          const blob = await abortable(() => ctx.library.mediaBlob(asset), p.signal);
          requireSource();
          const shifts = [];
          const sampleTimes = [];
          const sourceTimes = times.map((t) => T.sourceTimeAt(clip, clip.start + t));
          let prev = null;
          let i = 0;
          for await (const { t: sourceTime, frame } of grayFrames(blob, sourceTimes, { tw: W, th: H, signal: p.signal })) {
            // Unreadable frames are omitted by the sampler, not by the timeline.
            while (i < sourceTimes.length - 1 && sourceTimes[i] !== sourceTime) i++;
            sampleTimes.push(times[i]);
            if (prev) shifts.push(frameShift(prev, frame, W, H));
            prev = frame;
            p.set(++i / times.length);
          }
          p.signal.throwIfAborted();
          requireSource();
          if (sampleTimes.length < 2) throw new Error('Could not read enough frames to stabilize this clip. Try again or use another video.');
          const path = cameraPath(shifts);
          const smooth = smoothCamera(path, Number(strength.value));
          const { offsets, zoom } = corrections(path, smooth, W, H);
          // Offsets are in analysis pixels of the source; turn them into frame fractions.
          const scale0 = clip.transform.scale;
          const settings = store.project.settings;
          const srcAR = (asset.width || 16) / (asset.height || 9);
          const dstAR = settings.width / settings.height;
          const fitW = srcAR >= dstAR ? 1 : srcAR / dstAR;
          const fitH = srcAR >= dstAR ? dstAR / srcAR : 1;
          const sc = scale0 * zoom;
          const xs = offsets.map((o, k) => ({ t: Math.min(clip.duration, sampleTimes[k]), v: clip.transform.x + (o.x / W) * fitW * sc, ease: 'linear' }));
          const ys = offsets.map((o, k) => ({ t: Math.min(clip.duration, sampleTimes[k]), v: clip.transform.y + (o.y / H) * fitH * sc, ease: 'linear' }));
          const saved = ctx.actions.editClip(clip.id, 'Stabilize', (c) => {
            if (!isCurrentSource()) return false;
            c.keyframes ||= {};
            delete c.keyframes.scale;
            c.transform.scale = sc;
            c.keyframes.x = thinKeys(xs, 0.0008);
            c.keyframes.y = thinKeys(ys, 0.0008);
          });
          if (saved === false) throw new Error(isCurrentSource() ? 'Stabilization could not be saved. The clip may be locked or no longer available.' : changedMessage);
          toast(`Stabilized, zoomed in ${Math.round((zoom - 1) * 100)}%.`, { kind: 'success' });
        } catch (err) {
          if (!p.signal.aborted && err?.name !== 'AbortError') toast(isCurrentSource() ? err?.message || 'Could not stabilize this clip.' : changedMessage, { kind: 'error' });
        } finally {
          p.close();
        }
      });
    },

    /**
     * Remove flicker: measure the brightness of each frame, keep the slow
     * changes and write exposure keyframes that cancel the quick wobble.
     */
    async removeFlicker(clipId = store.selected?.clip.id) {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return;
      const f = clipId && T.findClip(store.project, clipId);
      if (!f || f.clip.type !== 'video' || f.clip.freeze) {
        toast('Select a video clip to remove its flicker.', { kind: 'info' });
        return;
      }
      if (f.track.locked) return;
      const clip = f.clip;
      const assetId = clip.assetId;
      const isCurrentSource = () => T.findClip(store.project, clip.id)?.clip === clip
        && clip.assetId === assetId && clip.type === 'video' && !clip.freeze;
      const changedMessage = 'The clip changed. Reopen Remove flicker to analyze its current video.';
      const requireSource = () => { if (!isCurrentSource()) throw new Error(changedMessage); };
      const span = h('select.select', h('option', { value: '0.15' }, 'Quick flicker only'), h('option', { value: '0.4' }, 'Balanced'), h('option', { value: '1' }, 'Slow pulsing too'));
      span.value = String(prefs().flickerSpan || '0.4');
      const go = h('button.btn.primary', { type: 'button' }, icon('brightness', 16), 'Remove flicker');
      const cancel = h('button.btn', { type: 'button' }, 'Cancel');
      const dlg = openFrameDialog({
        title: 'Remove flicker',
        body: h('div.prefs', h('p.dialog-text', 'Evens out quick changes in brightness, such as flickering lights or a pulsing timelapse, while keeping real changes like a cut or a sunset. Exposure keyframes on this clip are replaced.'), h('label.pref-row', h('span.pref-label', 'Even out'), h('span.pref-ctl', span))),
        actions: [cancel, go],
        className: 'prefs-dialog',
      }, lifetime);
      cancel.addEventListener('click', () => dlg.close());
      go.addEventListener('click', async () => {
        dlg.close();
        if (lifetime.aborted) return;
        setPref('flickerSpan', span.value);
        if (!isCurrentSource()) {
          toast(changedMessage, { kind: 'error' });
          return;
        }
        if (T.findClip(store.project, clip.id)?.track.locked) {
          toast('Unlock the track to remove flicker from this clip.', { kind: 'info' });
          return;
        }
        const asset = store.project.assets[assetId];
        // Every source frame (an even grid for fast, long or curved clips).
        const { local, source } = frameGrid(clip, asset?.fps || store.project.settings.fps || 30);
        const fps = local.length / Math.max(1e-3, clip.duration / US);
        const p = progressDialog('Removing flicker', 'Measuring the brightness of each frame...', lifetime);
        try {
          const blob = await abortable(() => ctx.library.mediaBlob(asset), p.signal);
          requireSource();
          const lumas = fillGaps(await frameLumas(blob, source, { signal: p.signal, onProgress: (x) => p.set(x) }));
          p.signal.throwIfAborted();
          requireSource();
          if (!lumas) throw new Error('Could not read the frames of this clip.');
          const units = flickerCorrections(lumas, { radius: Math.max(1, Math.round(Number(span.value) * fps)) });
          if (units.every((u) => Math.abs(u) < 1)) {
            toast('No flicker was found in this clip.', { kind: 'info' });
            return;
          }
          const before = wobble(lumas);
          const after = wobble(corrected(lumas, units));
          const saved = ctx.actions.editClip(clip.id, 'Remove flicker', (c) => {
            if (!isCurrentSource()) return false;
            c.adjust ||= { ...DEFAULT_ADJUST };
            c.keyframes ||= {};
            const keys = flickerKeys(local, units, c.adjust.exposure || 0);
            if (keys.length > 1) c.keyframes[adjustProp('exposure')] = keys;
            else delete c.keyframes[adjustProp('exposure')];
            if (c.grade?.off) delete c.grade.off.light;
          });
          if (saved === false) throw new Error(isCurrentSource() ? 'Flicker removal could not be saved. The clip may be locked or no longer available.' : changedMessage);
          const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
          toast(`Flicker reduced by ${pct}%.`, { kind: 'success' });
          announce('Flicker removed');
        } catch (err) {
          if (!p.signal.aborted && err?.name !== 'AbortError') toast(isCurrentSource() ? err?.message || 'Could not remove the flicker.' : changedMessage, { kind: 'error' });
        } finally {
          p.close();
        }
      });
    },

    /** Save a video clip's sound as a WAV file in the media library (the timeline does not change). */
    async extractAudio(clipId = store.selected?.clip.id) {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return null;
      const f = clipId && T.findClip(store.project, clipId);
      const asset = f && store.project.assets[f.clip.assetId];
      if (!f || f.clip.type !== 'video' || !asset?.hasAudio) {
        toast('Select a video clip with sound to extract its audio.', { kind: 'info' });
        return null;
      }
      const name = T.clipLabel(store.project, f.clip);
      const p = progressDialog('Extracting audio', `Reading the sound of ${name}...`, lifetime);
      try {
        const out = await extractClipAudio(mediabunnyOpener(ctx.library, { signal: p.signal }), asset, f.clip, { name, signal: p.signal, onProgress: (x) => p.set(x) });
        p.signal.throwIfAborted();
        p.close();
        if (!out) {
          toast('This clip has no sound to extract.', { kind: 'info' });
          return null;
        }
        // The progress dialog is closed now; the import still belongs to this editor.
        const [made] = await ctx.actions.importFiles([out.file], { folder: asset.folder || null, origin: 'extract', signal: lifetime });
        lifetime.throwIfAborted();
        if (made) toast(`Added ${made.name} to your media.`, { kind: 'success' });
        return made || null;
      } catch (err) {
        p.close();
        if (!lifetime.aborted && err?.name !== 'AbortError') {
          console.error(err);
          toast(err?.message || 'Could not extract the audio.', { kind: 'error' });
        }
        return null;
      }
    },

    /**
     * Auto reframe: optionally change the frame's shape, then zoom each
     * video and photo clip to fill it and pan to follow its subject.
     */
    async autoReframe() {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return;
      const st = store.project.settings;
      const sel = store.selectedIds.map((id) => T.findClip(store.project, id)?.clip).filter((c) => c && (c.type === 'video' || c.type === 'image'));
      const ratio = h('select.select', h('option', { value: 'keep' }, `Keep ${st.width} x ${st.height}`), RATIOS.map((r) => h('option', { value: r.id }, `${r.label}  ${r.hint}`)));
      ratio.value = prefs().reframeRatio && prefs().reframeRatio !== st.ratio ? prefs().reframeRatio : '9:16';
      const which = h('select.select', h('option', { value: 'selected', disabled: !sel.length }, `Selected clips (${sel.length})`), h('option', { value: 'all' }, 'All video and photo clips'));
      which.value = sel.length ? 'selected' : 'all';
      const follow = h('select.select', h('option', { value: '0.2' }, 'Smooth'), h('option', { value: '0.35' }, 'Balanced'), h('option', { value: '0.6' }, 'Quick'));
      follow.value = String(prefs().reframeFollow || '0.35');
      const zoom = h('select.select', h('option', { value: '1' }, 'Just fill the frame'), h('option', { value: '1.1' }, 'A little closer'), h('option', { value: '1.25' }, 'Closer'));
      const row = (label, el) => h('label.pref-row', h('span.pref-label', label), h('span.pref-ctl', el));
      const go = h('button.btn.primary', { type: 'button' }, icon('focus', 16), 'Reframe');
      const cancel = h('button.btn', { type: 'button' }, 'Cancel');
      let closed = false;
      const d = openFrameDialog({
        title: 'Auto reframe',
        body: h('div.prefs', h('p.dialog-text', 'Changes the frame shape and keeps the subject in view: each clip zooms to fill the new frame and pans to follow what matters. Existing position keyframes on these clips are replaced.'),
          row('Frame shape', ratio), row('Clips', which), row('Follow movement', follow), row('Zoom', zoom)),
        actions: [cancel, go],
        className: 'prefs-dialog',
        onClose: () => { closed = true; },
      }, lifetime);
      cancel.addEventListener('click', () => d.close());
      go.addEventListener('click', async () => {
        if (closed || lifetime.aborted) return;
        d.close();
        if (lifetime.aborted) return;
        setPref('reframeRatio', ratio.value);
        setPref('reframeFollow', follow.value);
        const project = store.project;
        const r = RATIOS.find((x) => x.id === ratio.value);
        const { width: W, height: H, ratio: ratioId } = reframeSize(st, r);
        const dstAR = W / H;
        const targets = which.value === 'selected' ? sel : T.allClips(project).filter((c) => c.type === 'video' || c.type === 'image');
        const p = progressDialog('Auto reframe', 'Finding the subject in each clip...', lifetime);
        const plans = [];
        try {
          for (let i = 0; i < targets.length; i++) {
            p.signal.throwIfAborted();
            const c = targets[i];
            const f = T.findClip(store.project, c.id);
            if (!f || f.track.locked) continue;
            const asset = store.project.assets[c.assetId];
            if (!asset?.width || !asset?.height) continue;
            const blob = await ctx.library.mediaBlob(asset);
            p.signal.throwIfAborted();
            plans.push(await reframePlan(c, asset, blob, { dstAR, follow: Number(follow.value), zoom: Number(zoom.value), signal: p.signal, onProgress: (x) => p.set((i + x) / targets.length) }));
            p.signal.throwIfAborted();
            p.set((i + 1) / targets.length);
          }
          p.close();
        } catch (err) {
          const canceled = p.signal.aborted;
          p.close();
          if (!canceled && err?.name !== 'AbortError') toast(err?.message || 'Could not reframe these clips.', { kind: 'error' });
          return;
        }
        if (lifetime.aborted) return;
        store.update('Auto reframe', (proj) => {
          if (r) Object.assign(proj.settings, { width: W, height: H, ratio: ratioId });
          for (const plan of plans) {
            const f = T.findClip(proj, plan.id);
            if (f) applyReframePlan(f.clip, plan);
          }
        });
        if (!lifetime.aborted) toast(`Reframed ${plans.length} clip${plans.length === 1 ? '' : 's'}${r ? ` for ${r.label}` : ''}.`, { kind: 'success' });
      });
    },

    /**
     * Line up two selected clips by their sound: the one on an audio track
     * (or the later-selected one) moves to match the other.
     */
    async syncBySound() {
      const lifetime = frameDialogSignal(ctx);
      if (lifetime.aborted) return;
      const ids = store.selectedIds;
      const clips = ids.map((id) => T.findClip(store.project, id)).filter((f) => f && (f.clip.type === 'audio' || (f.clip.type === 'video' && store.project.assets[f.clip.assetId]?.hasAudio)));
      if (clips.length !== 2) {
        toast('Select two clips with sound, for example a video and its separately recorded audio.', { kind: 'info' });
        return;
      }
      let [ref, mov] = clips;
      if (ref.track.kind === 'audio' && mov.track.kind !== 'audio') [ref, mov] = [mov, ref];
      if (mov.track.locked) {
        toast('The clip to move is on a locked track.', { kind: 'info' });
        return;
      }
      if ((ref.clip.speed || 1) !== 1 || (mov.clip.speed || 1) !== 1 || curved(ref.clip) || curved(mov.clip)) {
        toast('Syncing works on clips at normal speed.', { kind: 'info' });
        return;
      }
      const project = store.project;
      const inputs = [ref, mov];
      const sourceStamp = () => JSON.stringify([
        store.project.id, store.project.timelineId, (store.nest || []).map((f) => f.id),
        inputs.map(({ clip }, i) => {
          const f = T.findClip(store.project, clip.id);
          if (!f) return null;
          const c = f.clip, a = store.project.assets[c.assetId];
          return [f.track.id, i === 1 && f.track.locked, c.type, c.assetId, c.start, c.in, c.duration,
            c.speed, c.speedCurve, c.reverse, c.freeze, a?.kind, a?.hash, a?.ext, a?.mime, a?.size, a?.duration, a?.hasAudio];
        }),
      ]);
      const stamp = sourceStamp();
      const isCurrentSource = () => project === store.project
        && inputs.every(({ clip }) => T.findClip(store.project, clip.id)?.clip === clip)
        && stamp === sourceStamp();
      const changedMessage = () => T.findClip(store.project, mov.clip.id)?.track.locked
        ? 'The clip to move is locked. Unlock it and run sync again.'
        : 'The clips or their sound changed. Run sync again to compare their current audio.';
      const requireSource = () => { if (!isCurrentSource()) throw new Error(changedMessage()); };
      const p = progressDialog('Syncing by sound', 'Comparing the two recordings...', lifetime);
      try {
        const open = mediabunnyOpener(ctx.library, { signal: p.signal });
        const a = await decodeClipSound(open, store.project.assets[ref.clip.assetId], ref.clip, { maxSeconds: 600, signal: p.signal });
        p.signal.throwIfAborted();
        requireSource();
        p.set(0.4);
        const b = await decodeClipSound(open, store.project.assets[mov.clip.assetId], mov.clip, { maxSeconds: 600, signal: p.signal });
        p.signal.throwIfAborted();
        requireSource();
        p.set(0.7);
        if (!a || !b) throw new Error('Could not read the sound of both clips.');
        const hop = 0.01;
        const ea = syncEnvelope(downmix(a.channels), a.sampleRate, hop);
        const eb = syncEnvelope(downmix(b.channels), b.sampleRate, hop);
        const maxLag = Math.min(Math.max(ea.length, eb.length), Math.round(60 / hop));
        const { lag, score } = bestLag(ea, eb, maxLag);
        if (score < 0.2) {
          toast('These clips do not seem to share the same sound.', { kind: 'info' });
          return;
        }
        // mov's source start lines up with ref's source at lag steps in.
        const target = Math.max(0, Math.round(ref.clip.start + lag * hop * US));
        const delta = target - mov.clip.start;
        const name = T.clipLabel(store.project, mov.clip);
        const ok = store.update('Sync by sound', (proj) => isCurrentSource()
          ? T.moveClip(proj, mov.clip.id, { start: target, trackId: mov.track.id }, { ...store.opts, with: [] }) : false);
        if (ok === false) throw new Error(isCurrentSource() ? 'The alignment could not be saved. Check track locks and try again.' : changedMessage());
        if (ok) toast(`Moved ${name} by ${(delta / US).toFixed(2)} s to match.`, { kind: 'success' });
      } catch (err) {
        if (!lifetime.aborted && err?.name !== 'AbortError') {
          console.error(err);
          toast(isCurrentSource() ? err?.message || 'Could not sync these clips.' : changedMessage(), { kind: 'error' });
        }
      } finally {
        p.close();
      }
    },
  };
}
