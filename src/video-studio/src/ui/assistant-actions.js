/**
 * Performs the edit assistant's tool calls (media/edit-assistant.js) with
 * the editor's own timeline operations and actions. Every call is checked
 * against the project as it is at that moment, and all the edits of one
 * request become a single undo step.
 */
import { makeClip, RATIOS } from '../model/project.js';
import { EFFECTS, FILTERS, TRANSITIONS, ANIMATIONS } from '../model/catalog.js';
import { addClipEffect } from '../model/clip-effects.js';
import { isBodyEffect } from '../model/body-effects.js';
import * as T from '../model/timeline.js';
import { assistState, validateCall, summarize, secs, plural } from '../media/edit-assistant.js';
import { clipsForScope, errorMessage } from '../media/transcribe.js';
import { ready } from '../media/segmenter.js';
import { defaultLength } from './preferences-dialog.js';
import { reframeSize, findSilences } from './smart-actions.js';
import { generateCaptions } from './panels/captions.js';
import { removeRanges } from './panels/transcript.js';

/** Short names for the tools, used when one is skipped. */
export const TOOL_TITLES = {
  split: 'Split', delete_clips: 'Delete', remove_time_range: 'Cut out time', trim_clip: 'Trim', move_clip: 'Move', duplicate_clips: 'Duplicate',
  set_speed: 'Speed', add_text: 'Add text', edit_text: 'Edit text', set_filter: 'Filter', add_effect: 'Effect', set_transition: 'Transition',
  set_animation: 'Animation', set_audio: 'Sound', adjust_color: 'Color', set_transform: 'Position and size', add_captions: 'Captions',
  remove_silences: 'Remove silences', add_marker: 'Marker', select_clips: 'Select', set_aspect_ratio: 'Aspect ratio', move_playhead: 'Playhead',
};

const done = (text, ids) => ({ ok: true, text, ...(ids?.length ? { ids } : {}) });
const fail = (name, why) => ({ ok: false, text: `${TOOL_TITLES[name] || name}: ${why}` });
const labelOf = (list, id) => list.find((x) => x.id === id)?.label || id;

/** Text style fields onto a text clip (sizeScale multiplies the current size). */
export function applyTextStyle(c, style) {
  const { sizeScale, ...rest } = style || {};
  Object.assign(c.style, rest);
  if (sizeScale) c.style.size = Math.max(4, Math.min(600, Math.round(c.style.size * sizeScale)));
}

/** A few words for a text style change: "bigger, color #e5322d, bold". */
export function styleWords(style) {
  const out = [];
  if (style.sizeScale) out.push(style.sizeScale >= 1 ? 'bigger' : 'smaller');
  if (style.size) out.push(`size ${style.size}`);
  if (style.color) out.push(`color ${style.color}`);
  if (style.font) out.push(`font ${style.font}`);
  for (const k of ['bold', 'italic', 'underline']) if (style[k] !== undefined) out.push(style[k] ? k : `not ${k}`);
  if (style.strokeColor || style.strokeWidth !== undefined) out.push('outline');
  if (style.bgColor || style.bgOpacity !== undefined) out.push('background');
  if (style.shadowOpacity !== undefined) out.push(style.shadowOpacity ? 'shadow' : 'no shadow');
  if (style.align) out.push(`aligned ${style.align}`);
  if (style.case) out.push(`${style.case} case`);
  return out.join(', ');
}

/** A keyed property is set as a constant: its keyframes go. */
function setConstant(c, prop, set) {
  if (c.keyframes?.[prop]) delete c.keyframes[prop];
  set();
}

/**
 * createAssistantRunner(ctx, deps) -> { run(calls, { label, signal, onProgress }), undo(entry) }
 * deps replace the slow analysis steps in tests: generateCaptions, findSilences.
 */
export function createAssistantRunner(ctx, deps = {}) {
  const { store, actions } = ctx;
  const d = { generateCaptions, findSilences, ...deps };
  const name = (id) => {
    const f = T.findClip(store.project, id);
    return f ? JSON.stringify(T.clipLabel(store.project, f.clip)) : 'the clip';
  };
  const clipsLabel = (ids) => (ids.length === 1 ? name(ids[0]) : plural(ids.length, 'clip'));

  /** Edit each clip of ids with fn(clip) in one store step; returns how many changed. */
  function editEach(label, ids, fn, opts = {}) {
    let n = 0;
    store.update(label, (p) => {
      for (const id of ids) {
        const f = T.findClip(p, id);
        if (!f || f.track.locked) continue;
        if (fn(f.clip, p) !== false) n++;
      }
      return n > 0;
    }, { structural: false, ...opts });
    return n;
  }

  const APPLY = {
    split({ time, ids }) {
      let made = [];
      store.update('Split', (p) => {
        made = T.splitAt(p, time, ids.length ? ids : undefined);
        return made.length > 0;
      });
      return made.length ? done(`Split ${plural(made.length, 'clip')} at ${secs(time)}`, made.map((c) => c.id)) : fail('split', `no clip crosses ${secs(time)}`);
    },

    delete_clips({ ids }) {
      const label = clipsLabel(ids);
      let n = 0;
      store.update(ids.length === 1 ? 'Delete clip' : 'Delete clips', (p) => (n = T.deleteClips(p, ids, store.opts)) > 0);
      return n ? done(`Deleted ${n === 1 ? label : plural(n, 'clip')}`) : fail('delete_clips', 'nothing was deleted');
    },

    remove_time_range({ start, end }) {
      const ok = store.update('Cut out time', (p) => T.removeRange(p, start, end) > 0);
      return ok ? done(`Cut out ${secs(start)} to ${secs(end)}`) : fail('remove_time_range', 'there was nothing in that range');
    },

    trim_clip({ id, trimStart, trimEnd }) {
      const label = name(id);
      const ok = store.update('Trim', (p) => {
        let any = false;
        // The end first: trimming the start of a base-track clip moves it when the ripple is on.
        if (trimEnd) {
          const c = T.findClip(p, id)?.clip;
          if (c) any = T.trimClip(p, id, 'end', c.start + c.duration - trimEnd, store.opts) || any;
        }
        if (trimStart) {
          const c = T.findClip(p, id)?.clip;
          if (c) any = T.trimClip(p, id, 'start', c.start + trimStart, store.opts) || any;
        }
        return any;
      });
      const c = T.findClip(store.project, id)?.clip;
      return ok && c ? done(`Trimmed ${label} to ${secs(c.duration)}`, [id]) : fail('trim_clip', `${label} could not be trimmed`);
    },

    move_clip({ id, start }) {
      const label = name(id);
      const ok = store.update('Move clip', (p) => T.moveClip(p, id, { start }, store.opts));
      const c = T.findClip(store.project, id)?.clip;
      return ok && c ? done(`Moved ${label} to ${secs(c.start)}`, [id]) : fail('move_clip', `${label} has no room there`);
    },

    duplicate_clips({ ids }) {
      const made = [];
      store.update('Duplicate', (p) => {
        for (const id of ids) {
          const c = T.duplicateClip(p, id, store.opts);
          if (c) made.push(c.id);
        }
        return made.length > 0;
      });
      return made.length ? done(`Duplicated ${plural(made.length, 'clip')}`, made) : fail('duplicate_clips', 'nothing was duplicated');
    },

    set_speed({ ids, speed }) {
      let n = 0;
      store.update('Change speed', (p) => {
        for (const id of ids) if (T.setSpeed(p, id, speed, store.opts)) n++;
        return n > 0;
      });
      return n ? done(`Set ${n === 1 ? name(ids[0]) : plural(n, 'clip')} to ${speed}x speed`, ids) : fail('set_speed', 'no clip changed');
    },

    add_text({ text, start, duration, preset, y, style }, env) {
      const clip = actions.addText(preset, { text, start, duration, y });
      if (!clip) return fail('add_text', 'there was no room for it');
      if (Object.keys(style).length) actions.editClip(clip.id, 'Text style', (c) => applyTextStyle(c, style));
      env.created.push(clip.id);
      return done(`Added text ${JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text)} at ${secs(start)}`, [clip.id]);
    },

    edit_text({ ids, text, style, y }) {
      const n = editEach('Edit text', ids, (c) => {
        if (text !== undefined) {
          c.text = text;
          // Highlighted words point into the old words.
          delete c.marks;
        }
        applyTextStyle(c, style);
        if (y !== undefined) setConstant(c, 'y', () => (c.transform.y = y));
      });
      const what = [text !== undefined ? `text to ${JSON.stringify(text.length > 30 ? `${text.slice(0, 29)}…` : text)}` : '', styleWords(style), y !== undefined ? 'moved' : ''].filter(Boolean).join(', ');
      return n ? done(`Changed ${n === 1 ? name(ids[0]) : plural(n, 'text clip')}: ${what}`, ids) : fail('edit_text', 'no text clip changed');
    },

    set_filter({ ids, filter, intensity }) {
      const label = labelOf(FILTERS, filter);
      const n = editEach(filter ? `Apply ${label}` : 'Remove filter', ids, (c) => {
        c.filter = filter ? { id: filter, intensity } : null;
      });
      if (!n) return fail('set_filter', 'no clip changed');
      return done(filter ? `Applied the ${label} filter to ${n === 1 ? name(ids[0]) : plural(n, 'clip')}` : `Removed the filter from ${plural(n, 'clip')}`, ids);
    },

    add_effect({ effect, ids, start, duration }, env) {
      const label = labelOf(EFFECTS, effect);
      if (ids) {
        const n = editEach(`Add ${label} to clip`, ids, (c) => addClipEffect(c, effect) >= 0);
        if (n && isBodyEffect(effect)) ready();
        return n ? done(`Added ${label} to ${n === 1 ? name(ids[0]) : plural(n, 'clip')}`, ids) : fail('add_effect', 'no clip took the effect');
      }
      const clip = makeClip('effect', { start, duration, effect, name: label });
      const ok = store.update(`Add ${label}`, (p) => {
        T.addClip(p, clip, store.opts);
      });
      if (!ok) return fail('add_effect', 'there was no room for it');
      env.created.push(clip.id);
      return done(`Added the ${label} effect from ${secs(start)} to ${secs(start + duration)}`, [clip.id]);
    },

    set_transition({ transition, all, id, duration }) {
      const label = labelOf(TRANSITIONS, transition);
      const p0 = store.project;
      let targets = [];
      if (all) targets = T.mainTrack(p0).clips.filter((c) => T.nextAdjacent(p0, c.id)).map((c) => c.id);
      else if (id) targets = [id];
      else {
        // The cut nearest the playhead on the base track.
        let best = null;
        for (const c of T.mainTrack(p0).clips) {
          if (!T.nextAdjacent(p0, c.id)) continue;
          if (!best || Math.abs(T.clipEnd(c) - store.time) < Math.abs(T.clipEnd(best) - store.time)) best = c;
        }
        if (best) targets = [best.id];
      }
      if (!targets.length) return fail('set_transition', 'transitions need two clips that touch on the base track');
      let n = 0;
      store.update(transition ? `Add ${label}` : 'Remove transition', (p) => {
        for (const t of targets) if (T.setTransition(p, t, transition, duration)) n++;
        return n > 0;
      });
      if (!n) return fail('set_transition', 'those clips are too short for a transition');
      return done(transition ? `Added ${label} at ${plural(n, 'cut')}` : `Removed transitions at ${plural(n, 'cut')}`, targets);
    },

    set_animation({ ids, kind, animation, duration }) {
      const key = kind === 'in' ? 'animIn' : kind === 'out' ? 'animOut' : 'animLoop';
      const def = kind === 'loop' ? 2_000_000 : defaultLength.animation();
      const n = editEach(animation ? 'Add animation' : 'Remove animation', ids, (c) => {
        if (!animation) {
          c[key] = null;
          return;
        }
        c[key] = { id: animation, duration: Math.min(duration ?? c[key]?.duration ?? def, c.duration) };
        // Loop animations replace in/out ones, and the other way round.
        if (kind === 'loop') {
          c.animIn = null;
          c.animOut = null;
        } else c.animLoop = null;
      });
      const label = labelOf(ANIMATIONS[kind], animation);
      if (!n) return fail('set_animation', 'no clip changed');
      const role = { in: 'entrance', out: 'exit', loop: 'loop' }[kind];
      return done(animation ? `Gave ${n === 1 ? name(ids[0]) : plural(n, 'clip')} the ${label} ${role} animation` : `Removed the ${role} animation from ${plural(n, 'clip')}`, ids);
    },

    set_audio({ ids, volume, fadeIn, fadeOut, muted }) {
      const n = editEach('Sound', ids, (c) => {
        if (volume !== undefined) setConstant(c, 'volume', () => (c.volume = volume));
        if (fadeIn !== undefined) c.fadeIn = Math.max(0, Math.min(fadeIn, c.duration - (c.fadeOut || 0)));
        if (fadeOut !== undefined) c.fadeOut = Math.max(0, Math.min(fadeOut, c.duration - (c.fadeIn || 0)));
        if (muted !== undefined) c.muted = muted;
      });
      const what = [
        volume !== undefined ? `volume ${Math.round(volume * 100)}%` : '',
        fadeIn !== undefined ? `fade in ${secs(fadeIn)}` : '',
        fadeOut !== undefined ? `fade out ${secs(fadeOut)}` : '',
        muted !== undefined ? (muted ? 'muted' : 'unmuted') : '',
      ].filter(Boolean).join(', ');
      return n ? done(`Set ${what} on ${n === 1 ? name(ids[0]) : plural(n, 'clip')}`, ids) : fail('set_audio', 'no clip changed');
    },

    adjust_color({ ids, adjust }) {
      const n = editEach('Adjust color', ids, (c) => {
        if (!c.adjust) return false;
        for (const [k, v] of Object.entries(adjust)) setConstant(c, `adjust.${k}`, () => (c.adjust[k] = v));
      });
      const what = Object.entries(adjust).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ');
      return n ? done(`Set ${what} on ${n === 1 ? name(ids[0]) : plural(n, 'clip')}`, ids) : fail('adjust_color', 'no clip changed');
    },

    set_transform({ ids, patch }) {
      const n = editEach('Transform', ids, (c) => {
        for (const [prop, v] of Object.entries(patch)) setConstant(c, prop, () => (prop === 'opacity' ? (c.opacity = v) : (c.transform[prop] = v)));
      });
      const what = Object.entries(patch).map(([k, v]) => `${k} ${Math.round(v * 100) / 100}`).join(', ');
      return n ? done(`Set ${what} on ${n === 1 ? name(ids[0]) : plural(n, 'clip')}`, ids) : fail('set_transform', 'no clip changed');
    },

    async add_captions(a, env) {
      if (!clipsForScope(store.project, a.scope).length) return fail('add_captions', a.scope === 'main' ? 'the base track has no sound' : 'there is no sound to caption');
      env.progress('Listening for speech...');
      const n = await d.generateCaptions(ctx, { language: a.language, scope: a.scope, preset: a.preset, position: a.position, maxWords: a.maxWords, captionStyle: a.captionStyle }, {
        mode: a.replace ? 'replace' : 'keep',
        signal: env.signal,
        onStep: (i) => env.progress(['Listening for speech...', 'Turning speech into words...', 'Adding captions...'][i]),
      });
      return n ? done(`Added ${plural(n, 'caption')}`) : fail('add_captions', 'no speech was found');
    },

    async remove_silences(o, env) {
      if (!clipsForScope(store.project, o.scope).length) return fail('remove_silences', o.scope === 'main' ? 'the base track has no sound' : 'there is no sound in this project');
      env.progress('Listening for silences...');
      const ranges = await d.findSilences(ctx, o, { signal: env.signal });
      if (!ranges.length) return fail('remove_silences', 'no silences that long were found');
      const total = ranges.reduce((s, r) => s + r.end - r.start, 0);
      removeRanges(store, ranges, 'Remove silences');
      return done(`Removed ${plural(ranges.length, 'silent part')} (${secs(total)} in all)`);
    },

    add_marker({ time, label, color }) {
      const m = actions.addMarkerAt(time);
      if (!m) return fail('add_marker', `there is already a marker at ${secs(time)}`);
      if (label || color !== m.color) store.update('Edit marker', (p) => T.updateMarker(p, m.id, { label, color }), { structural: false });
      return done(`Added a marker${label ? ` ${JSON.stringify(label)}` : ''} at ${secs(time)}`);
    },

    select_clips({ ids }, env) {
      env.select = ids;
      return done(ids.length ? `Selected ${plural(ids.length, 'clip')}` : 'Cleared the selection', ids);
    },

    set_aspect_ratio({ ratio }) {
      const r = RATIOS.find((x) => x.id === ratio);
      if (store.project.settings.ratio === ratio) return done(`The frame is already ${r?.label || 'the original shape'}`);
      actions.setProjectSettings(r ? reframeSize(store.project.settings, r) : { ratio }, 'Change aspect ratio');
      return done(`Changed the frame to ${r ? `${r.label} (${r.hint})` : 'the original shape'}`);
    },

    move_playhead({ time }) {
      store.seek(time);
      return done(`Moved the playhead to ${secs(time)}`);
    },
  };

  /**
   * Check and perform calls in order as one undo step labeled label.
   * Returns { results, summary, entry } (entry is the undo step, or null
   * when nothing changed). Cancelling stops before the next call; what was
   * done stays (and undoes as one step).
   */
  async function run(calls, { label = 'Assistant edit', signal, onProgress } = {}) {
    const env = { created: [], select: null, signal, progress: (text) => onProgress?.(text) };
    const results = [];
    const mark = store.beginBatch();
    let entry = null;
    try {
      for (const call of calls) {
        if (signal?.aborted) break;
        const v = validateCall(call, assistState(store));
        if (!v.ok) {
          results.push(fail(v.name, v.error));
          continue;
        }
        try {
          results.push(await APPLY[v.name](v.args, env));
        } catch (err) {
          if (err?.name === 'AbortError') {
            results.push(fail(v.name, 'stopped'));
            break;
          }
          console.error(err);
          results.push(fail(v.name, errorMessage(err, 'something went wrong')));
        }
      }
    } finally {
      entry = store.endBatch(mark, label);
    }
    if (env.select) store.select(env.select);
    else if (env.created.length) store.select(env.created.filter((id) => T.findClip(store.project, id)));
    return { results, summary: summarize(results), entry };
  }

  /** Undo a request's step, when it is still the latest one. */
  function undo(entry) {
    if (!entry || store.history.undoStack.at(-1) !== entry) return false;
    store.undo();
    return true;
  }

  return { run, undo, canUndo: (entry) => Boolean(entry) && store.history.undoStack.at(-1) === entry };
}
