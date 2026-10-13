/**
 * Dub dialog: speak the timeline's captions in another language with
 * Puter AI (translation and text to speech), on a new audio track, with
 * the original sound lowered, muted or kept, and the captions optionally
 * translated too.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { makeClip } from '../model/project.js';
import * as T from '../model/timeline.js';
import { LANGUAGES, captionCues } from '../media/transcribe.js';
import { translateLines } from '../media/transcript.js';
import { TTS_VOICES, aiAvailable, synthesize, speechFile } from '../media/tts.js';
import { makeDub, placeSpeech } from '../media/dub.js';
import { errorMessage } from '../media/transcribe.js';
import { openDialog, toast } from './dialog.js';
import { selectField, segmented, switchField } from './controls.js';
import { prefs, setPref } from './prefs.js';
import '../styles/dub.css';

const DUB_PREFIX = 'Dub - ';
const isDubTrack = (t) => t.kind === 'audio' && t.name?.startsWith(DUB_PREFIX);

/** How loud the original sound stays under the dub. */
export const ORIGINAL_LEVELS = { lower: 0.15, mute: 0, keep: 1 };

/**
 * Put the dub on the timeline (inside store.update): a new audio track
 * named after the language, the original sound turned down, and the
 * captions translated when asked. placed: [{ assetId, name, start, speed, duration }].
 */
export function applyDub(project, { placed, language, original = 'lower', lines = null, captionIds = [] }) {
  const level = ORIGINAL_LEVELS[original] ?? ORIGINAL_LEVELS.lower;
  if (level < 1) {
    for (const t of project.tracks) {
      // Earlier dubs keep their level.
      if (t.locked || isDubTrack(t)) continue;
      for (const c of t.clips) if (c.type === 'video' || c.type === 'audio' || c.type === 'compound') c.volume = Math.min(c.volume ?? 1, level);
    }
  }
  const track = T.addTrack(project, 'audio', project.tracks.length);
  track.name = `${DUB_PREFIX}${language}`;
  for (const p of placed) {
    const clip = makeClip('audio', { assetId: p.assetId, name: p.name, start: p.start, duration: Math.max(T.MIN_CLIP, Math.round(p.duration / p.speed)) });
    clip.speed = p.speed;
    // Lines that still overlap after fitting go on another track.
    if (T.trackFree(track, clip.start, T.clipEnd(clip))) {
      track.clips.push(clip);
      T.sortTrack(track);
    } else T.addClip(project, clip, { ripple: false, linkOverlays: false });
  }
  if (lines) {
    const byId = new Map(captionIds.map((id, i) => [id, lines[i]]));
    for (const t of project.tracks) {
      if (t.locked) continue;
      for (const c of t.clips) {
        const next = byId.get(c.id);
        if (next && next.trim()) {
          c.text = next.trim();
          delete c.marks;
        }
      }
    }
  }
  return track;
}

export function openDubDialog(ctx, { translate = translateLines, speak = synthesize } = {}) {
  const { store } = ctx;
  if (!aiAvailable(ctx) && translate === translateLines) {
    toast('Dubbing uses Puter AI for translation and voices. Sign in to Puter to use it.', { kind: 'info' });
    return null;
  }
  const captionClips = [];
  for (const t of store.project.tracks) for (const c of t.clips) if (c.type === 'text' && c.caption) captionClips.push(c);
  captionClips.sort((a, b) => a.start - b.start);
  const cues = captionCues(store.project);
  if (!cues.length) {
    toast('Dubbing follows the captions. Generate captions first (Captions tab), then dub.', { kind: 'info', duration: 6000 });
    return null;
  }
  const saved = prefs().dub || {};
  const opts = {
    to: saved.to || 'es',
    voice: TTS_VOICES.some((v) => v.id === saved.voice) ? saved.voice : 'openai-nova',
    original: saved.original in ORIGINAL_LEVELS ? saved.original : 'lower',
    captions: Boolean(saved.captions),
  };
  const targets = LANGUAGES.filter((l) => l.value !== 'auto');
  const lang = selectField({ label: 'Language', options: targets, value: opts.to, onChange: (v) => (opts.to = v) });
  const voice = selectField({ label: 'Voice', options: TTS_VOICES.map((v) => ({ value: v.id, label: `${v.label} (${v.hint})` })), value: opts.voice, onChange: (v) => (opts.voice = v) });
  const orig = segmented({
    label: 'Original sound',
    options: [{ value: 'lower', label: 'Lower' }, { value: 'mute', label: 'Mute' }, { value: 'keep', label: 'Keep' }],
    value: opts.original,
    onChange: (v) => (opts.original = v),
  });
  const caps = switchField({ label: 'Translate the captions too', checked: opts.captions, onChange: (v) => (opts.captions = v) });
  const status = h('p.asset-hint', { role: 'status', 'aria-live': 'polite' });
  const bar = h('div.dub-progress', { hidden: true }, h('div.dub-progress-fill'));
  const go = h('button.btn.primary', { type: 'button' }, icon('languages', 16), 'Dub');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const segs = cues.length;
  const body = h('div.cap-form.dub-form',
    h('p.dialog-text', `Speaks your ${segs} caption${segs === 1 ? '' : 's'} in another language, timed to the original speech, on a new audio track. Check the captions first: the dub follows their words and timing.`),
    lang.el, voice.el,
    h('div.field', h('span.field-label', 'Original sound'), orig.el),
    caps.el, bar, status);
  const d = openDialog({ title: 'Dub into another language', body, actions: [cancel, go], className: 'small' });
  let abort = null;
  cancel.addEventListener('click', () => {
    abort?.abort();
    d.close();
  });
  const progress = (f) => {
    bar.hidden = false;
    bar.style.setProperty('--pct', `${Math.round(f * 100)}%`);
    status.textContent = f < 0.2 ? 'Translating...' : `Making the voice... ${Math.round(f * 100)}%`;
  };

  go.addEventListener('click', async () => {
    if (abort) return;
    abort = new AbortController();
    go.disabled = true;
    setPref('dub', { ...opts });
    const language = targets.find((l) => l.value === opts.to)?.label || opts.to;
    try {
      progress(0);
      const dub = await makeDub(cues, {
        translate: (lines) => translate(lines, language, { signal: abort.signal }),
        speak: (text) => speak(text, opts.voice),
        signal: abort.signal,
        onProgress: progress,
      });
      status.textContent = 'Adding to the timeline...';
      const made = dub.speech.map((s, i) => (s.blob ? { i, file: speechFile(s.blob, s.text) } : null)).filter(Boolean);
      const assets = await ctx.actions.importFiles(made.map((m) => m.file));
      if (assets.length !== made.length) throw new Error("Couldn't add all of the speech.");
      const durations = dub.segments.map(() => 0);
      made.forEach((m, k) => (durations[m.i] = (assets[k].duration || 0) / 1e6));
      const where = placeSpeech(dub.segments, durations, store.duration / 1e6);
      const placed = made.map((m, k) => ({ assetId: assets[k].id, name: assets[k].name, start: where[m.i].start, speed: where[m.i].speed, duration: assets[k].duration || 1e6 }));
      store.update(`Dub into ${language}`, (p) => {
        applyDub(p, { placed, language, original: opts.original, lines: opts.captions ? dub.lines : null, captionIds: captionClips.map((c) => c.id) });
      });
      const sped = placed.filter((x) => x.speed > 1).length;
      d.close();
      toast(`Dubbed ${placed.length} line${placed.length === 1 ? '' : 's'} into ${language}.${sped ? ` ${sped} sped up a little to fit.` : ''}`, { kind: 'success' });
      announce(`Dubbed into ${language}`);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      status.textContent = errorMessage(err, "Couldn't make the dub.");
      go.disabled = false;
      abort = null;
    }
  });
  return d;
}

