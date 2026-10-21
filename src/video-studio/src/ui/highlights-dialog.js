/**
 * Find highlights dialog: transcribe a long video clip (or reuse the
 * project transcript), let Puter AI pick its most engaging moments, preview
 * them in the player, and turn the chosen ones into short projects (with
 * optional auto reframe to a vertical frame) or compound clips at the end
 * of this project.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US, clock } from '../lib/time.js';
import { RATIOS, normalizeProject } from '../model/project.js';
import * as T from '../model/timeline.js';
import { openDialog, toast } from './dialog.js';
import { prefs, setPref } from './prefs.js';
import { LANGUAGES, STT_RATE, mixdown, transcribeMix, errorMessage } from '../media/transcribe.js';
import { HIGHLIGHT_COUNTS, HIGHLIGHT_LENGTHS, findHighlights, highlightProject, highlightCompound, wordsInClip } from '../media/highlights.js';
import { transcriptWords } from '../media/transcript.js';
import { SCRIPT_CAPTION_STYLES } from '../media/script-video.js';
import { reframeSize, reframePlan, applyReframePlan } from './smart-actions.js';
import { aiReady, needAiDialog } from './script-video.js';
import '../styles/ai-create.css';

/** The clip to search: the selected video clip, else the longest video with sound. */
export function highlightSource(project, selectedIds = []) {
  const usable = (c) => c?.type === 'video' && !c.freeze && project.assets[c.assetId]?.hasAudio;
  for (const id of selectedIds) {
    const c = T.findClip(project, id)?.clip;
    if (usable(c)) return c;
  }
  return T.allClips(project).filter(usable).sort((a, b) => b.duration - a.duration)[0] || null;
}

/** Clip-local timed words (µs) for a clip: from the project transcript when it covers the clip, else transcribed. */
async function clipWords(ctx, clip, { language, signal, onStatus }) {
  const reuse = wordsInClip(transcriptWords(ctx.store.project), clip);
  if (reuse.length >= 20) return { words: reuse, reused: true };
  // Only this clip, from 0, at full volume, so the words line up with the clip.
  const project = ctx.store.project;
  const solo = { ...structuredClone(clip), start: 0, muted: false, audioDetached: false, volume: 1, fadeIn: 0, fadeOut: 0, disabled: false };
  if (solo.keyframes) delete solo.keyframes.volume;
  const mini = { ...project, tracks: [{ id: 'solo', kind: 'video', main: true, locked: false, hidden: false, muted: false, clips: [solo] }] };
  onStatus('Preparing audio...', 0);
  const mix = await mixdown(mini, ctx.library, { scope: 'all', signal, onProgress: (f) => onStatus(`Preparing audio... ${Math.round(f * 100)}%`, f * 0.3) });
  onStatus('Listening to the speech...', 0.3);
  const fake = import.meta.env.DEV ? globalThis.__vsFakeTranscript : null;
  const words = fake ? await fake(mix, STT_RATE) : await transcribeMix(mix, STT_RATE, { language, signal, onProgress: (f) => onStatus(`Listening to the speech... ${Math.round(f * 100)}%`, 0.3 + f * 0.5) });
  return { words: words.map((w) => ({ text: w.text, start: Math.round(w.start * US), end: Math.round(w.end * US) })), reused: false };
}

const DEFAULTS = { count: 5, length: 'short', language: 'auto', target: 'projects', shape: '9:16', captions: 'yellow-caption' };

/**
 * Open the dialog for a clip.
 *  chat  injectable chat function (tests and browser checks)
 */
export function openHighlightsDialog(ctx, { clipId, chat } = {}) {
  const { store, library } = ctx;
  const clip = clipId ? T.findClip(store.project, clipId)?.clip : highlightSource(store.project, store.selectedIds);
  if (!clip) {
    toast('Add or select a video with speech to find its highlights.', { kind: 'info' });
    return null;
  }
  const asset = store.project.assets[clip.assetId];
  const opts = { ...DEFAULTS, ...(prefs().highlights || {}) };
  const save = () => setPref('highlights', { ...opts });
  let words = [];
  let found = [];
  let abort = null;
  let stopPreview = null;

  const select = (label, options, key) => {
    const el = h('select.select', { 'aria-label': label }, options.map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(opts[key]) }, o.label)));
    el.addEventListener('change', () => {
      opts[key] = typeof DEFAULTS[key] === 'number' ? Number(el.value) : el.value;
      save();
      sync();
    });
    return el;
  };
  const field = (label, control) => h('label.aic-field', h('span.aic-label', label), control);

  // ---- Options -------------------------------------------------------------------
  const reuse = wordsInClip(transcriptWords(store.project), clip).length >= 20;
  const optionsEl = h('div.aic-step',
    h('p.dialog-text', `Finds the moments in ${asset?.name || 'this clip'} (${clock(clip.duration)}) that work best on their own, so you can turn them into short clips.`),
    h('div.aic-grid',
      field('How many', select('How many', HIGHLIGHT_COUNTS.map((n) => ({ value: n, label: `Up to ${n}` })), 'count')),
      field('Length of each', select('Length of each', HIGHLIGHT_LENGTHS.map((l) => ({ value: l.id, label: l.label })), 'length')),
      reuse ? h('p.aic-hint', 'Uses the project transcript, so the speech is not sent again.') : field('Spoken language', select('Spoken language', LANGUAGES, 'language'))),
  );

  // ---- Progress ------------------------------------------------------------------
  const bar = h('span');
  const status = h('p.dialog-text', { role: 'status' }, 'Starting...');
  const progressEl = h('div.aic-step', status, h('div.progress', bar));
  const onStatus = (text, f) => {
    status.textContent = text;
    bar.style.width = `${Math.round(Math.min(1, f) * 100)}%`;
  };

  // ---- Results -------------------------------------------------------------------
  const list = h('ul.aic-cands', { 'aria-label': 'Highlights' });
  const resultNote = h('p.aic-hint', { role: 'status' });
  const target = select('Make', [{ value: 'projects', label: 'A new project for each' }, { value: 'here', label: 'Compound clips at the end of this project' }], 'target');
  const shape = select('Frame shape', [
    { value: '9:16', label: 'Vertical 9:16, follow the subject' },
    { value: '1:1', label: 'Square 1:1, follow the subject' },
    { value: '4:5', label: 'Portrait 4:5, follow the subject' },
    { value: 'keep', label: 'Keep the current shape' },
  ], 'shape');
  const shapeField = field('Frame shape', shape);
  const captions = select('Captions', SCRIPT_CAPTION_STYLES.map((c) => ({ value: c.id, label: c.label })), 'captions');
  const resultsEl = h('div.aic-step', list, resultNote, h('div.aic-grid', field('Make', target), shapeField, field('Captions', captions)));

  function sync() {
    shapeField.hidden = opts.target !== 'projects';
    const n = found.filter((x) => x.keep).length;
    makeBtn.disabled = !n;
    makeBtn.lastChild.textContent = n === 1 ? 'Make 1 clip' : `Make ${n} clips`;
  }

  function preview(item, btn) {
    stopPreview?.();
    const from = clip.start + item.start;
    const to = clip.start + Math.min(item.end, clip.duration);
    store.seek(from);
    ctx.player?.play?.();
    btn.replaceChildren(icon('stop', 14), 'Stop');
    btn.setAttribute('aria-pressed', 'true');
    const off = store.on('time', ({ time }) => {
      if (time >= to || time < from - 50_000) stop();
    });
    const offPlay = ctx.player?.on?.('play', ({ playing }) => {
      if (!playing) stop();
    });
    function stop() {
      off();
      offPlay?.();
      if (ctx.player?.playing) ctx.player.pause();
      btn.replaceChildren(icon('play', 14), 'Preview');
      btn.setAttribute('aria-pressed', 'false');
      if (stopPreview === stop) stopPreview = null;
    }
    stopPreview = stop;
  }

  function renderResults() {
    list.replaceChildren(...found.map((item, i) => {
      const keep = h('input', { type: 'checkbox', checked: item.keep, 'aria-label': `Use highlight ${i + 1}` });
      keep.addEventListener('change', () => {
        item.keep = keep.checked;
        sync();
      });
      const title = h('input.input.aic-title', { type: 'text', value: item.title, maxLength: 80, 'aria-label': `Title of highlight ${i + 1}` });
      title.addEventListener('input', () => (item.title = title.value.trim() || `Highlight ${i + 1}`));
      const play = h('button.btn.small', { type: 'button', 'aria-pressed': 'false' }, icon('play', 14), 'Preview');
      play.addEventListener('click', () => (play.getAttribute('aria-pressed') === 'true' ? stopPreview?.() : preview(item, play)));
      return h('li.aic-cand',
        h('div.aic-cand-head', keep, title, play),
        h('div.aic-cand-meta', `${clock(item.start)} to ${clock(item.end)}`, h('span', '·'), `${Math.round(item.duration / US)} s`),
        h('p.aic-excerpt', `“${item.excerpt}”`));
    }));
    sync();
  }

  // ---- Dialog -----------------------------------------------------------------------
  const body = h('div.aic-body', optionsEl);
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const findBtn = h('button.btn.primary', { type: 'button' }, icon('search', 16), 'Find highlights');
  const againBtn = h('button.btn', { type: 'button', hidden: true }, icon('refresh', 16), 'Search again');
  const makeBtn = h('button.btn.primary', { type: 'button', hidden: true }, icon('scissors', 16), h('span', 'Make clips'));
  const d = openDialog({
    title: 'Find highlights',
    body,
    actions: [cancel, h('span.spacer'), againBtn, findBtn, makeBtn],
    className: 'aic-dialog',
    wide: true,
    closeOnBackdrop: false,
    onClose: () => {
      abort?.abort();
      stopPreview?.();
    },
  });
  const show = (step) => {
    d.el.dataset.step = step;
    body.replaceChildren(step === 'options' ? optionsEl : step === 'progress' ? progressEl : resultsEl);
    findBtn.hidden = step !== 'options';
    againBtn.hidden = step !== 'results';
    makeBtn.hidden = step !== 'results';
    cancel.textContent = step === 'progress' ? 'Stop' : step === 'results' ? 'Close' : 'Cancel';
  };
  show('options');
  cancel.addEventListener('click', () => (abort ? abort.abort() : d.close()));
  againBtn.addEventListener('click', () => {
    stopPreview?.();
    show('options');
  });

  async function search() {
    if (abort) return;
    abort = new AbortController();
    const { signal } = abort;
    show('progress');
    try {
      if (!words.length) {
        const res = await clipWords(ctx, clip, { language: opts.language, signal, onStatus });
        words = res.words;
      }
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      onStatus('Choosing the best moments...', 0.85);
      found = (await findHighlights(words, { count: opts.count, length: opts.length, ...(chat ? { chat } : {}) })).map((x) => ({ ...x, keep: true }));
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      onStatus('Done', 1);
      resultNote.textContent = `${found.length} moment${found.length === 1 ? '' : 's'} found. Untick any you do not want, and edit the titles if you like.`;
      renderResults();
      show('results');
      announce(`${found.length} highlights found`);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error(err);
        toast(errorMessage(err, "Couldn't find highlights."), { kind: 'error' });
      }
      if (d.el.isConnected) show('options');
    } finally {
      abort = null;
    }
  }
  findBtn.addEventListener('click', search);

  async function make() {
    if (abort) return;
    stopPreview?.();
    const chosen = found.filter((x) => x.keep);
    if (!chosen.length) return;
    if (opts.target === 'here') {
      const added = [];
      store.update(chosen.length === 1 ? 'Add highlight' : `Add ${chosen.length} highlights`, (p) => {
        const main = T.mainTrack(p);
        const track = main && !main.locked ? main : T.addTrack(p, 'video');
        let at = track.clips.reduce((m, c) => Math.max(m, T.clipEnd(c)), 0);
        for (const item of chosen) {
          const comp = highlightCompound(p, clip, words, item, { captions: opts.captions, start: at });
          if (!comp) continue;
          track.clips.push(comp);
          added.push(comp);
          at += comp.duration;
        }
        return added.length > 0;
      });
      d.close('done');
      if (added.length) {
        store.select(added.map((c) => c.id));
        store.seek(added[0].start);
        toast(`Added ${added.length} highlight${added.length === 1 ? '' : 's'} at the end of the timeline.`, { kind: 'success' });
      }
      return;
    }
    abort = new AbortController();
    const { signal } = abort;
    show('progress');
    const ids = [];
    try {
      const ratio = RATIOS.find((r) => r.id === opts.shape) || null;
      const blob = ratio && asset ? await library.mediaBlob(asset) : null;
      for (let i = 0; i < chosen.length; i++) {
        const item = chosen[i];
        const base = (i / chosen.length);
        onStatus(`Making "${item.title}" (${i + 1} of ${chosen.length})...`, base);
        const short = highlightProject(store.project, clip, words, item, { ratio: ratio ? ratio.id : 'keep', captions: opts.captions });
        if (ratio && blob) {
          // Same shape rule as Auto reframe: keep the source frame's short side.
          const size = reframeSize(store.project.settings, ratio);
          Object.assign(short.settings, size);
          const v = T.mainTrack(short).clips[0];
          if (v) applyReframePlan(v, await reframePlan(v, asset, blob, { dstAR: size.width / size.height, signal, onProgress: (f) => onStatus(`Following the subject in "${item.title}"... ${Math.round(f * 100)}%`, base + f / chosen.length) }));
        }
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const saved = normalizeProject(short);
        await library.saveProject(saved);
        ids.push(saved.id);
      }
      d.close('done');
      toast(`Made ${ids.length} short project${ids.length === 1 ? '' : 's'}. Find ${ids.length === 1 ? 'it' : 'them'} on the home screen.`, {
        kind: 'success',
        duration: 9000,
        action: ctx.openProject ? { label: 'Open', onClick: () => ctx.openProject(ids[0]) } : undefined,
      });
      announce(`${ids.length} short projects made`);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error(err);
        toast(errorMessage(err, "Couldn't make the clips."), { kind: 'error' });
      } else if (ids.length) toast(`Stopped after ${ids.length} project${ids.length === 1 ? '' : 's'}.`, { kind: 'info' });
      if (d.el.isConnected) show('results');
    } finally {
      abort = null;
    }
  }
  makeBtn.addEventListener('click', make);

  return { ...d, search, make, get found() { return found; }, get words() { return words; } };
}

/** Open the dialog from the editor, or explain that it needs a Puter account. */
export function openHighlights(ctx, extra = {}) {
  if (!aiReady(ctx) && !extra.chat) return needAiDialog(ctx.account, 'Find highlights');
  return openHighlightsDialog(ctx, extra);
}
