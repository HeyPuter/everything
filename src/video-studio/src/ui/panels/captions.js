/**
 * Captions tab: captions generated from speech (Puter speech to text),
 * lyrics from a song, an editable list of the project's captions, and
 * .srt / .vtt import and .srt export. Captions are text clips marked
 * caption: true.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US } from '../../lib/time.js';
import { uid } from '../../lib/ids.js';
import { makeClip, DEFAULT_TEXT_STYLE } from '../../model/project.js';
import { TEXT_PRESETS } from '../../model/catalog.js';
import * as T from '../../model/timeline.js';
import { tabLayout, emptyState } from './common.js';
import { selectField, segmented, sliderField, switchField } from '../controls.js';
import { openDialog, toast } from '../dialog.js';
import { showMenu } from '../menu.js';
import { prefs, setPref } from '../prefs.js';
import {
  LANGUAGES, CAPTION_POSITIONS, STT_RATE, groupWords, buildCaptionClips, lineCharsFor, captionCues,
  parseSubtitles, toSrt, mixdown, transcribeMix, clipsForScope, errorMessage, wrapCaption,
} from '../../media/transcribe.js';
import { aiAvailable, synthesize, addSpeechToTimeline } from '../../media/tts.js';
import { lyricsFromClip, songClips, LYRIC_STYLE } from '../../media/lyrics.js';
import { transcriptPanel } from './transcript.js';
import { translateLines, emojiForLines, keywordsForLines } from '../../media/transcript.js';
import { CAPTION_STYLES, applyCaptionStyle } from '../../model/caption-styles.js';
import { pickKeywords } from '../../model/text-marks.js';
import { lookCanvas, hoverAnimateLook } from '../text-thumbs.js';
import { tileGrid, tile } from './common.js';
import '../../styles/audio.css';

const DEFAULT_OPTS = { language: 'auto', scope: 'main', preset: 'yellow-caption', maxWords: 5, position: 'bottom', lyricsStyle: LYRIC_STYLE, lyricsPosition: 'bottom', lyricsIsolate: true };

const isCaption = (c) => c.type === 'text' && c.caption;

/** "0:03.5": captions are often shorter than a second, so tenths matter. */
function shortTime(t) {
  const s = Math.max(0, Math.floor(t / 100_000) / 10);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

function captionClips(project) {
  const out = [];
  for (const t of project.tracks) for (const c of t.clips) if (isCaption(c)) out.push(c);
  return out.sort((a, b) => a.start - b.start);
}

/** Ask what to do with existing captions: 'replace', 'keep' or null (cancel). */
async function askReplace(store) {
  const n = captionClips(store.project).length;
  if (!n) return 'keep';
  const replace = h('button.btn.primary', { type: 'button' }, 'Replace');
  const keep = h('button.btn', { type: 'button' }, 'Keep both');
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const d = openDialog({
    title: 'Replace existing captions?',
    body: h('p.dialog-text', `This project already has ${n} caption${n === 1 ? '' : 's'}. Replace them with the new ones, or keep both on separate tracks?`),
    actions: [cancel, keep, replace],
    className: 'small',
    labelledBody: true,
  });
  replace.addEventListener('click', () => d.close('replace'));
  keep.addEventListener('click', () => d.close('keep'));
  cancel.addEventListener('click', () => d.close(null));
  replace.focus();
  const v = await d.result;
  return v === 'replace' || v === 'keep' ? v : null;
}

/** Put caption cues (seconds) on one new text track in a single undo step. */
function applyCaptions(ctx, cues, { mode, preset, position, wrap = true, label = 'Generate captions', captionStyle = null }) {
  const { store } = ctx;
  const p = TEXT_PRESETS.find((x) => x.id === preset);
  const clips = buildCaptionClips(cues, { presetId: preset, position, lineChars: wrap ? lineCharsFor(p, store.project.settings.width) : 0 });
  if (!clips.length) return 0;
  const look = CAPTION_STYLES.find((x) => x.id === captionStyle);
  if (look) for (const c of clips) applyCaptionStyle(c, look, DEFAULT_TEXT_STYLE, store.project.settings.width);
  store.update(label, (proj) => {
    if (mode === 'replace') for (const t of proj.tracks) t.clips = t.clips.filter((c) => !isCaption(c) || t.locked);
    const track = T.addTrack(proj, 'text');
    track.clips.push(...clips);
  });
  store.clearSelection();
  announce(`${clips.length} caption${clips.length === 1 ? '' : 's'} added`);
  return clips.length;
}

/**
 * Captions from the project's speech: mix the sound (opts.scope), turn it
 * into timed words with Puter speech to text, group them into lines and put
 * them on a new text track (mode 'replace' drops existing captions first).
 * onStep(index, fraction) follows the three stages. Returns how many
 * captions were added (0 when no speech was found).
 */
export async function generateCaptions(ctx, opts, steps = {}) {
  return (await prepareCaptions(ctx, opts, steps))();
}

/**
 * generateCaptions in two parts: does the slow listening and resolves to a
 * function that adds the captions (one store step, synchronous) and returns
 * how many it added.
 */
export async function prepareCaptions(ctx, opts, { mode = 'keep', signal, onStep } = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  onStep?.(0, 0);
  // Work on a copy so edits made meanwhile do not shift what is being mixed.
  const project = structuredClone(ctx.store.project);
  const mix = await mixdown(project, ctx.library, { scope: o.scope, signal, onProgress: (f) => onStep?.(0, f) });
  onStep?.(1, 0);
  const fake = import.meta.env.DEV ? globalThis.__vsFakeTranscript : null;
  const words = fake
    ? await fake(mix, STT_RATE)
    : await transcribeMix(mix, STT_RATE, { language: o.language, signal, testMode: Boolean(import.meta.env.DEV && globalThis.__vsSpeechTestMode), onProgress: (f) => onStep?.(1, f) });
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  onStep?.(2, 0);
  const preset = TEXT_PRESETS.find((p) => p.id === o.preset);
  const lineChars = lineCharsFor(preset, project.settings.width);
  const cues = groupWords(words, { maxWords: o.maxWords, maxChars: Math.min(lineChars * 2, 84), maxGap: 0.8 });
  return () => (cues.length ? applyCaptions(ctx, cues, { mode, preset: o.preset, position: o.position, captionStyle: o.captionStyle || null }) : 0);
}

function fieldRow(label, control, id) {
  return h('div.field', h('span.field-label', { id }, label), control);
}

/** Style and position controls bound to opts (shared by auto and import). */
function styleControls(opts, save) {
  const style = selectField({
    label: 'Style',
    options: TEXT_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    value: opts.preset,
    onChange: (v) => {
      opts.preset = v;
      save();
    },
  });
  const posId = `cap-pos-${Math.random().toString(36).slice(2, 7)}`;
  const pos = segmented({
    label: 'Position',
    options: Object.keys(CAPTION_POSITIONS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
    value: opts.position,
    onChange: (v) => {
      opts.position = v;
      save();
    },
  });
  return {
    els: [style.el, fieldRow('Position', pos.el, posId)],
    sync() {
      style.set(opts.preset);
      pos.set(opts.position);
    },
  };
}

/** Steps with a progress bar and Cancel, for long caption jobs. setStep(i, fraction). */
function stepProgress(steps, label) {
  const stepEls = steps.map((s) => h('li.cap-step', h('span.cap-step-icon', { 'aria-hidden': 'true' }), h('span', s)));
  const bar = h('div.cap-bar', { role: 'progressbar', 'aria-label': `${label} progress`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('div.cap-bar-fill'));
  const cancel = h('button.btn.small', { type: 'button' }, 'Cancel');
  const el = h('div.cap-progress', { hidden: true, role: 'group', 'aria-label': label }, h('ol.cap-steps', stepEls), bar, h('div.cap-progress-foot', cancel));
  const setStep = (i, frac = 0) => {
    stepEls.forEach((li, j) => {
      li.dataset.state = j < i ? 'done' : j === i ? 'active' : 'todo';
      li.querySelector('.cap-step-icon').replaceChildren(j < i ? icon('check', 12) : j === i ? h('span.spinner.small') : '');
    });
    const pct = Math.round(((i + Math.min(1, frac)) / steps.length) * 100);
    bar.setAttribute('aria-valuenow', String(pct));
    bar.firstChild.style.width = `${pct}%`;
  };
  return { el, cancel, setStep };
}

/** Sign-in prompt for the AI caption tools when signed out. */
function signInState(ctx, title, text) {
  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
  return { el: emptyState('user', title, text, btn), sync() {} };
}

function autoPanel(ctx, opts, save) {
  const { store } = ctx;
  if (!aiAvailable(ctx)) return signInState(ctx, 'Sign in to generate captions', 'Generated captions turn speech into text with Puter AI, so they need a Puter account. You can still import subtitle files or add captions by hand.');
  const lang = selectField({ label: 'Spoken language', options: LANGUAGES, value: opts.language, onChange: (v) => { opts.language = v; save(); } });
  const scope = segmented({
    label: 'Listen to',
    options: [{ value: 'main', label: 'Base track' }, { value: 'all', label: 'All audio' }],
    value: opts.scope,
    onChange: (v) => { opts.scope = v; save(); },
  });
  const words = sliderField({ label: 'Max words per caption', min: 1, max: 12, step: 1, value: opts.maxWords, onInput: (v) => { opts.maxWords = v; save(); } });
  const styles = styleControls(opts, save);
  const generate = h('button.btn.primary.block', { type: 'button' }, icon('magic', 16), 'Generate');
  generate.addEventListener('click', () => run());

  const { el: progress, cancel, setStep } = stepProgress(['Preparing audio', 'Transcribing', 'Creating captions'], 'Generating captions');
  let abort = null;
  cancel.addEventListener('click', () => abort?.abort());

  async function run() {
    if (abort) return;
    if (!clipsForScope(store.project, opts.scope).length) {
      toast(opts.scope === 'main' ? 'The base track has no sound. Choose All audio, or add clips with sound.' : 'There is no audio in this project to caption.', { kind: 'info' });
      return;
    }
    const mode = await askReplace(store);
    if (!mode) return;
    abort = new AbortController();
    const { signal } = abort;
    generate.disabled = true;
    progress.hidden = false;
    let said = -1;
    try {
      const n = await generateCaptions(ctx, opts, { mode, signal, onStep: (i, f) => {
        setStep(i, f);
        if (i !== said) announce(STEPS[(said = i)]);
      } });
      if (!n) toast('No speech was found in the audio.', { kind: 'info' });
      else toast(`Added ${n} caption${n === 1 ? '' : 's'}.`, { kind: 'success' });
    } catch (err) {
      if (err?.name === 'AbortError') announce('Captions cancelled');
      else {
        console.error(err);
        toast(errorMessage(err, "Couldn't create captions."), { kind: 'error' });
      }
    } finally {
      abort = null;
      generate.disabled = false;
      progress.hidden = true;
    }
  }

  const el = h('div.cap-form',
    h('p.asset-hint', 'Turn speech into captions on a new text track. You can edit them afterwards.'),
    lang.el,
    fieldRow('Listen to', scope.el, 'cap-scope'),
    styles.els,
    words.el,
    generate,
    progress,
  );
  scope.el.setAttribute('aria-labelledby', 'cap-scope');
  return {
    el,
    sync() {
      styles.sync();
    },
  };
}

/** Short clip description for the song picker ("Song.mp3, 0:04 to 3:12"). */
function songLabel(clip, asset) {
  const t = (us) => {
    const s = Math.round(us / US);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  return `${clip.name || asset.name}, ${t(clip.start)} to ${t(T.clipEnd(clip))}`;
}

/**
 * Lyrics from a song: pick a music clip, isolate the vocals, transcribe and
 * break the words into lines at the song's phrasing (media/lyrics.js), then
 * add them as captions in a lyric look. ctx.lyricsDeps can stand in for the
 * decoding, separation, speech to text and beat steps (tests).
 */
function lyricsPanel(ctx, opts, save) {
  const { store } = ctx;
  if (!aiAvailable(ctx)) return signInState(ctx, 'Sign in to create lyrics', 'Lyrics are heard with Puter AI speech to text, so they need a Puter account. You can still import a lyrics subtitle file or type lines in the Captions list.');
  const song = h('select.select', { id: `lyr-song-${uid('x')}` });
  song.addEventListener('change', () => syncButton());
  const songField = h('div.field', h('label.field-label', { for: song.id }, 'Song'), song);
  const lang = selectField({ label: 'Sung language', options: LANGUAGES, value: opts.language, onChange: (v) => { opts.language = v; save(); } });
  const isolate = switchField({
    label: 'Isolate vocals first',
    hint: 'Separates the singing from the music before listening. Works best on stereo songs.',
    checked: opts.lyricsIsolate !== false,
    onChange: (v) => { opts.lyricsIsolate = v; save(); },
  });
  const look = selectField({
    label: 'Lyric look',
    options: CAPTION_STYLES.map((x) => ({ value: x.id, label: x.label })),
    value: opts.lyricsStyle,
    onChange: (v) => { opts.lyricsStyle = v; save(); },
  });
  const pos = segmented({
    label: 'Position',
    options: Object.keys(CAPTION_POSITIONS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
    value: opts.lyricsPosition,
    onChange: (v) => { opts.lyricsPosition = v; save(); },
  });
  const create = h('button.btn.primary.block', { type: 'button' }, icon('music', 16), 'Create lyrics');
  create.addEventListener('click', () => run());
  const empty = h('p.asset-hint.lyr-empty', 'Add a song (an audio clip, or a video with sound) to the timeline first.');
  const { el: progress, cancel, setStep } = stepProgress(['Reading the song', 'Isolating vocals', 'Listening for words', 'Placing lines on the beat'], 'Creating lyrics');
  const STEP = { decode: 0, isolate: 1, transcribe: 2, phrase: 3 };
  let abort = null;
  cancel.addEventListener('click', () => abort?.abort());

  function syncButton() {
    create.disabled = Boolean(abort) || !song.value;
  }

  function sync() {
    const list = songClips(store.project);
    const prev = song.value;
    const sel = store.selected?.clip;
    song.replaceChildren(...list.map(({ clip, asset }) => h('option', { value: clip.id }, songLabel(clip, asset))));
    const pick = [sel?.id, prev].find((id) => id && list.some((x) => x.clip.id === id));
    if (pick) song.value = pick;
    empty.hidden = list.length > 0;
    songField.hidden = !list.length;
    look.set(opts.lyricsStyle);
    pos.set(opts.lyricsPosition);
    syncButton();
  }

  async function run() {
    if (abort || !song.value) return;
    const mode = await askReplace(store);
    if (!mode) return;
    abort = new AbortController();
    const { signal } = abort;
    syncButton();
    progress.hidden = false;
    setStep(0);
    announce('Reading the song');
    const project = structuredClone(store.project);
    try {
      const res = await lyricsFromClip(project, song.value, {
        library: ctx.library,
        language: opts.language,
        isolate: opts.lyricsIsolate !== false,
        signal,
        onStep: (step, f) => {
          setStep(STEP[step], f);
          if (!f) announce(progress.querySelectorAll('.cap-step')[STEP[step]].textContent);
        },
        ...(ctx.lyricsDeps || {}),
      });
      if (!res.cues.length) {
        toast('No singing was found in this clip.', { kind: 'info' });
        return;
      }
      const style = CAPTION_STYLES.find((x) => x.id === opts.lyricsStyle) || CAPTION_STYLES[0];
      const n = applyCaptions(ctx, res.cues, { mode, preset: style.preset, position: opts.lyricsPosition, label: 'Lyrics from music', captionStyle: style.id });
      toast(`Added ${n} lyric line${n === 1 ? '' : 's'}.`, { kind: 'success' });
    } catch (err) {
      if (err?.name === 'AbortError') announce('Lyrics cancelled');
      else {
        console.error(err);
        toast(errorMessage(err, "Couldn't create lyrics."), { kind: 'error' });
      }
    } finally {
      abort = null;
      progress.hidden = true;
      syncButton();
    }
  }

  const el = h('div.cap-form.lyr-form',
    h('p.asset-hint', 'Turn a song into lyric captions: the singing is separated from the music, heard, and split into lines where the singer breathes and the bars begin.'),
    empty,
    songField,
    lang.el,
    isolate.el,
    look.el,
    fieldRow('Position', pos.el, 'lyr-pos'),
    create,
    progress,
  );
  pos.el.setAttribute('aria-labelledby', 'lyr-pos');
  const refresh = () => {
    if (el.isConnected && !abort) sync();
  };
  const offs = [store.on('change', refresh), store.on('select', refresh)];
  sync();
  return { el, sync, dispose: () => offs.forEach((off) => off()) };
}

const fieldSizing = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');

/** Grow a caption textarea to its content (CSS field-sizing where supported). */
function fit(ta) {
  if (fieldSizing || !ta.isConnected) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

function listPanel(ctx, opts) {
  const { store, actions } = ctx;
  const addBtn = h('button.btn.primary.small', { type: 'button' }, icon('plus', 14), 'Add caption');
  addBtn.addEventListener('click', addCaption);
  const readBtn = aiAvailable(ctx) ? h('button.btn.small', { type: 'button', 'data-tip': 'Read the selected text aloud' }, icon('speech', 14), 'Text to speech') : null;
  readBtn?.addEventListener('click', readSelected);
  const list = h('div.cap-list', { role: 'list', 'aria-label': 'Captions' });
  const body = h('div.cap-list-body');
  const aiBtn = aiAvailable(ctx) ? h('button.btn.small', { type: 'button', 'aria-haspopup': 'menu' }, icon('magic', 14), 'AI', icon('chevronDown', 12)) : null;
  aiBtn?.addEventListener('click', () => showMenu(aiBtn, [
    { label: 'Translate captions...', icon: 'languages', onSelect: () => openTranslate(ctx) },
    { label: 'Add emojis', icon: 'effects', onSelect: () => addEmojis(ctx) },
    { label: 'Dub into another language...', icon: 'speech', onSelect: () => import('../dub-dialog.js').then((m) => m.openDubDialog(ctx)) },
  ], { label: 'AI caption tools' }));
  const markBtn = h('button.btn.small', { type: 'button', 'aria-haspopup': 'menu' }, icon('highlighter', 14), 'Highlight', icon('chevronDown', 12));
  markBtn.addEventListener('click', () => showMenu(markBtn, [
    { label: 'Highlight key words', icon: 'highlighter', onSelect: () => highlightKeywords(ctx) },
    aiAvailable(ctx) ? { label: 'Highlight key words with AI', icon: 'magic', onSelect: () => highlightKeywords(ctx, { ai: true }) } : null,
    { label: 'Clear highlights', icon: 'close', onSelect: () => clearHighlights(ctx) },
  ].filter(Boolean), { label: 'Highlight words' }));
  const findBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Find and replace', 'data-tip': 'Find and replace' }, icon('search', 14));
  findBtn.addEventListener('click', () => import('../find-replace.js').then((m) => m.openFindReplace(ctx)));
  const el = h('div.cap-list-panel', h('div.cap-list-tools', addBtn, markBtn, readBtn, aiBtn, findBtn), body);
  let sig = '';
  let rows = new Map(); // clip id -> { row, text, time }

  function addCaption() {
    const preset = TEXT_PRESETS.find((p) => p.id === opts.preset) || TEXT_PRESETS[0];
    const start = store.time;
    const clip = makeClip('text', { start, duration: 2 * US, text: 'Caption', style: { ...DEFAULT_TEXT_STYLE, ...preset.style }, preset: preset.id, caption: true });
    clip.transform.y = CAPTION_POSITIONS[opts.position] ?? CAPTION_POSITIONS.bottom;
    // Prefer the track that already holds captions.
    const host = store.project.tracks.find((t) => !t.locked && t.clips.some(isCaption) && T.trackFree(t, start, start + clip.duration));
    const ok = store.update('Add caption', (p) => {
      T.addClip(p, clip, { trackId: host?.id });
    });
    if (!ok) return;
    store.select(clip.id);
    announce('Caption added');
    render();
    const r = rows.get(clip.id);
    r?.text.focus();
    r?.text.select();
  }

  async function readSelected() {
    const clip = store.selected?.clip;
    if (!clip || clip.type !== 'text') {
      toast('Select a text clip or caption first.', { kind: 'info' });
      return;
    }
    readBtn.disabled = true;
    try {
      const blob = await synthesize(clip.text, prefs().ttsVoice);
      await addSpeechToTimeline(ctx, blob, clip.text, { start: clip.start });
    } catch (err) {
      toast(err?.message || "Couldn't create the speech.", { kind: 'error' });
    } finally {
      readBtn.disabled = false;
    }
  }

  function edit(id, value) {
    actions.editClip(id, 'Edit caption', (c) => {
      c.text = value;
    }, { coalesce: `caption-${id}` });
  }

  function remove(id) {
    store.update('Delete caption', (p) => {
      const f = T.findClip(p, id);
      if (!f || f.track.locked) return false;
      f.track.clips.splice(f.index, 1);
    });
    announce('Caption deleted');
  }

  function mergeNext(id) {
    const all = captionClips(store.project);
    const i = all.findIndex((c) => c.id === id);
    const next = all[i + 1];
    if (!next) return;
    const ok = store.update('Merge captions', (p) => {
      const a = T.findClip(p, id);
      const b = T.findClip(p, next.id);
      if (!a || !b || a.track.locked || b.track.locked) return false;
      // Join as one sentence, then wrap again for the caption's style.
      const joined = `${a.clip.text} ${b.clip.text}`.replace(/\s+/g, ' ').trim();
      a.clip.text = wrapCaption(joined, lineCharsFor({ style: a.clip.style }, p.settings.width));
      a.clip.duration = Math.max(T.clipEnd(a.clip), T.clipEnd(b.clip)) - a.clip.start;
      b.track.clips = b.track.clips.filter((c) => c.id !== b.clip.id);
    });
    if (ok) announce('Captions merged');
    else toast('Unlock the caption track to merge.', { kind: 'info' });
  }

  function makeRow(c, i, all) {
    const label = shortTime(c.start);
    const time = h('button.cap-time', { type: 'button', 'aria-label': `Go to caption at ${label}` }, label);
    const text = h('textarea.cap-text', { rows: 1, 'aria-label': `Caption at ${label}`, spellcheck: true });
    text.value = c.text;
    const merge = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Merge with next caption', 'data-tip': 'Merge with next', disabled: i === all.length - 1 }, icon('link', 14));
    const del = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Delete caption', 'data-tip': 'Delete' }, icon('trash', 14));
    const goTo = () => {
      store.seek(c.start);
      if (!store.selection.has(c.id) || store.selection.size !== 1) store.select(c.id);
    };
    time.addEventListener('click', goTo);
    text.addEventListener('focus', goTo);
    text.addEventListener('input', () => {
      fit(text);
      edit(c.id, text.value);
    });
    text.addEventListener('blur', () => store.seal());
    text.addEventListener('keydown', (e) => {
      // Enter moves to the next caption; Shift+Enter adds a line break.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const ids = [...rows.keys()];
        const nextId = ids[ids.indexOf(c.id) + 1];
        if (nextId) rows.get(nextId).text.focus();
        else text.blur();
      }
    });
    merge.addEventListener('click', () => mergeNext(c.id));
    del.addEventListener('click', () => {
      const ids = [...rows.keys()];
      const neighbor = ids[ids.indexOf(c.id) + 1] || ids[ids.indexOf(c.id) - 1];
      remove(c.id);
      rows.get(neighbor)?.text.focus({ preventScroll: true });
    });
    const row = h('div.cap-row', { role: 'listitem', 'data-id': c.id }, time, text, h('div.cap-row-actions', merge, del));
    return { row, text, time };
  }

  function render() {
    const all = captionClips(store.project);
    const nextSig = all.map((c) => `${c.id}:${c.start}:${c.duration}`).join('|');
    if (nextSig !== sig) {
      sig = nextSig;
      const focused = document.activeElement?.closest?.('.cap-row')?.dataset.id;
      const caret = document.activeElement?.selectionStart;
      rows = new Map();
      list.replaceChildren(...all.map((c, i) => {
        const r = makeRow(c, i, all);
        rows.set(c.id, r);
        return r.row;
      }));
      if (!all.length) {
        const cta = h('button.btn.primary', { type: 'button' }, icon('plus', 16), 'Add caption');
        cta.addEventListener('click', addCaption);
        body.replaceChildren(emptyState('captions', 'No captions yet', 'Generate captions from speech, import a subtitle file, or add captions one by one.', cta));
      } else if (list.parentNode !== body) body.replaceChildren(list);
      const r = focused && rows.get(focused);
      for (const x of rows.values()) fit(x.text);
      if (r) {
        r.text.focus({ preventScroll: true });
        if (caret !== undefined) r.text.setSelectionRange(caret, caret);
      }
    } else {
      for (const c of all) {
        const r = rows.get(c.id);
        if (r && document.activeElement !== r.text && r.text.value !== c.text) {
          r.text.value = c.text;
          fit(r.text);
        }
      }
    }
    marks();
  }

  let current = null;
  function marks() {
    const t = store.time;
    let now = null;
    for (const [id, r] of rows) {
      r.row.classList.toggle('selected', store.selection.has(id));
      const f = T.findClip(store.project, id);
      if (f && t >= f.clip.start && t < T.clipEnd(f.clip)) now = id;
    }
    if (now !== current) {
      rows.get(current)?.row.classList.remove('current');
      current = now;
      const r = rows.get(now);
      r?.row.classList.add('current');
      // Follow playback without stealing focus.
      if (r && ctx.player?.playing) r.row.scrollIntoView({ block: 'nearest' });
    }
  }

  function timeMark() {
    const t = store.time;
    const r = current && rows.get(current);
    const f = current && T.findClip(store.project, current);
    if (r && f && t >= f.clip.start && t < T.clipEnd(f.clip)) return;
    marks();
  }

  const updateRead = () => {
    if (readBtn) readBtn.disabled = !(store.selected?.clip?.type === 'text');
  };
  const offs = [
    store.on('change', render),
    store.on('select', () => {
      marks();
      updateRead();
    }),
    store.on('time', timeMark),
  ];
  render();
  updateRead();
  return { el, render, dispose: () => offs.forEach((off) => off()) };
}

function filesPanel(ctx, opts, save) {
  const { store } = ctx;
  const input = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt,application/x-subrip', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
  const importBtn = h('button.btn.primary.block', { type: 'button' }, icon('import', 16), 'Import .srt or .vtt');
  const exportBtn = h('button.btn.block', { type: 'button' }, icon('download', 16), 'Export captions (.srt)');
  const styles = styleControls(opts, save);
  importBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let cues;
    try {
      cues = parseSubtitles(await file.text());
    } catch {
      cues = [];
    }
    if (!cues.length) {
      toast(`No captions were found in ${file.name}.`, { kind: 'error' });
      return;
    }
    const mode = await askReplace(store);
    if (!mode) return;
    const n = applyCaptions(ctx, cues, { mode, preset: opts.preset, position: opts.position, wrap: false, label: 'Import captions', captionStyle: opts.captionStyle });
    toast(`Imported ${n} caption${n === 1 ? '' : 's'}.`, { kind: 'success' });
  });
  exportBtn.addEventListener('click', () => {
    const cues = captionCues(store.project);
    if (!cues.length) {
      toast('There are no captions to export yet.', { kind: 'info' });
      return;
    }
    const blob = new Blob([toSrt(cues)], { type: 'application/x-subrip' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${store.project.name || 'captions'}.srt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    announce('Captions exported');
  });
  const el = h('div.cap-form',
    h('p.asset-hint', 'Bring in captions from a subtitle file, or save this project\'s captions as an .srt file.'),
    styles.els,
    importBtn,
    input,
    h('hr.cap-sep'),
    exportBtn,
  );
  return { el, sync: () => styles.sync() };
}

/** Translate every caption, replacing it, adding it as a second line, or on a new track. */
function openTranslate(ctx) {
  const { store } = ctx;
  const clips = captionClips(store.project);
  if (!clips.length) {
    toast('There are no captions to translate yet.', { kind: 'info' });
    return;
  }
  const targets = LANGUAGES.filter((l) => l.value !== 'auto');
  let target = prefs().translateTo || 'es';
  let mode = prefs().translateMode || 'track';
  const lang = selectField({ label: 'Translate to', options: targets, value: target, onChange: (v) => (target = v) });
  const how = segmented({
    label: 'Put the translation',
    options: [{ value: 'track', label: 'On a new track' }, { value: 'below', label: 'Under the original' }, { value: 'replace', label: 'Instead' }],
    value: mode,
    onChange: (v) => (mode = v),
  });
  const status = h('p.asset-hint', { role: 'status' });
  const go = h('button.btn.primary', { type: 'button' }, icon('languages', 16), 'Translate');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const d = openDialog({ title: 'Translate captions', body: h('div.cap-form', h('p.dialog-text', `${clips.length} caption${clips.length === 1 ? '' : 's'} will be translated with Puter AI.`), lang.el, h('div.field', h('span.field-label', 'Put the translation'), how.el), status), actions: [cancel, go], className: 'small' });
  let abort = null;
  cancel.addEventListener('click', () => {
    abort?.abort();
    d.close();
  });
  go.addEventListener('click', async () => {
    if (abort) return;
    abort = new AbortController();
    go.disabled = true;
    setPref('translateTo', target);
    setPref('translateMode', mode);
    const label = targets.find((l) => l.value === target)?.label || target;
    try {
      const lines = await translateLines(clips.map((c) => c.text), label, { signal: abort.signal, onProgress: (f) => (status.textContent = `Translating... ${Math.round(f * 100)}%`) });
      const byId = new Map(clips.map((c, i) => [c.id, lines[i]]));
      store.update('Translate captions', (p) => {
        if (mode === 'track') {
          const track = T.addTrack(p, 'text');
          for (const c of clips) {
            const copy = structuredClone(c);
            copy.id = uid('c');
            copy.text = byId.get(c.id) || c.text;
            copy.transform.y = Math.max(-0.45, (c.transform.y || 0) - 0.12);
            delete copy.group;
            track.clips.push(copy);
          }
          return;
        }
        for (const t of p.tracks) for (const c of t.clips) {
          if (!byId.has(c.id) || t.locked) continue;
          const tr = byId.get(c.id);
          c.text = mode === 'replace' ? tr : `${c.text}\n${tr}`;
        }
      });
      toast(`Translated ${clips.length} caption${clips.length === 1 ? '' : 's'} to ${label}.`, { kind: 'success' });
      d.close();
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error(err);
        status.textContent = errorMessage(err, "Couldn't translate the captions.");
      }
    } finally {
      abort = null;
      go.disabled = false;
    }
  });
}

/** Let Puter AI pick an emoji for captions where one fits, appended to the line. */
async function addEmojis(ctx) {
  const { store } = ctx;
  const clips = captionClips(store.project);
  if (!clips.length) {
    toast('There are no captions yet.', { kind: 'info' });
    return;
  }
  toast('Choosing emojis...', { kind: 'info' });
  try {
    const picks = await emojiForLines(clips.map((c) => c.text));
    const byId = new Map(clips.map((c, i) => [c.id, picks[i]]));
    let n = 0;
    store.update('Add emojis', (p) => {
      for (const t of p.tracks) for (const c of t.clips) {
        const e = byId.get(c.id);
        if (!e || t.locked) continue;
        c.text = `${c.text} ${e}`;
        n++;
      }
      return n > 0;
    });
    toast(n ? `Added ${n} emoji${n === 1 ? '' : 's'}.` : 'No emoji fit these captions.', { kind: n ? 'success' : 'info' });
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, "Couldn't add emojis."), { kind: 'error' });
  }
}

/**
 * Mark the key words of every caption (drawn in the caption's highlight
 * color): picked on this device, or by Puter AI when ai is set.
 */
async function highlightKeywords(ctx, { ai = false } = {}) {
  const { store } = ctx;
  const clips = captionClips(store.project);
  if (!clips.length) {
    toast('There are no captions yet.', { kind: 'info' });
    return;
  }
  let picks;
  try {
    if (ai) toast('Choosing key words...', { kind: 'info' });
    picks = ai ? await keywordsForLines(clips.map((c) => c.text)) : clips.map((c) => pickKeywords(c.text));
  } catch (err) {
    console.error(err);
    toast(errorMessage(err, "Couldn't choose key words."), { kind: 'error' });
    return;
  }
  const byId = new Map(clips.map((c, i) => [c.id, picks[i]]));
  let n = 0;
  store.update('Highlight key words', (p) => {
    for (const t of p.tracks) for (const c of t.clips) {
      const m = byId.get(c.id);
      if (!m || t.locked) continue;
      if (m.length) c.marks = m;
      else delete c.marks;
      n += m.length;
    }
  }, { structural: false });
  announce(`${n} word${n === 1 ? '' : 's'} highlighted`);
  toast(n ? `Highlighted ${n} word${n === 1 ? '' : 's'}. Change the color with Highlight color in the Text tab.` : 'No key words stood out.', { kind: n ? 'success' : 'info' });
}

function clearHighlights(ctx) {
  const ok = ctx.store.update('Clear highlights', (p) => {
    let any = false;
    for (const t of p.tracks) for (const c of t.clips) {
      if (isCaption(c) && c.marks && !t.locked) {
        delete c.marks;
        any = true;
      }
    }
    return any;
  }, { structural: false });
  if (ok) announce('Highlights cleared');
}

/** Caption looks: click one to restyle every caption (and the ones made next). */
function stylesPanel(ctx, opts, save) {
  const { store } = ctx;
  const hint = h('p.asset-hint', { role: 'status' });
  const tiles = new Map();
  const apply = (look) => {
    opts.captionStyle = look.id;
    save();
    const n = captionClips(store.project).length;
    if (n) {
      store.update(`Caption style: ${look.label}`, (p) => {
        for (const t of p.tracks) for (const c of t.clips) if (isCaption(c) && !t.locked) applyCaptionStyle(c, look, DEFAULT_TEXT_STYLE, p.settings.width);
      }, { structural: false });
    }
    announce(n ? `${look.label} applied to ${n} caption${n === 1 ? '' : 's'}` : `${look.label} will be used for new captions`);
    sync();
  };
  const grid = tileGrid(CAPTION_STYLES.map((look) => {
    const sample = { text: look.sample, style: { ...(TEXT_PRESETS.find((p) => p.id === look.preset)?.style || {}), ...look.style }, marks: [0] };
    const canvas = lookCanvas(sample);
    const t = tile({ label: look.label, preview: canvas, onAdd: () => apply(look), addLabel: `Use the ${look.label} caption style` });
    const anim = look.loop || look.in;
    if (anim) hoverAnimateLook(t, canvas, sample, anim, look.loop ? 'loop' : 'in');
    tiles.set(look.id, t);
    return t;
  }), { label: 'Caption styles' });
  const el = h('div.cap-form', hint, grid);
  function sync() {
    const n = captionClips(store.project).length;
    hint.textContent = n
      ? `Click a style to restyle all ${n} caption${n === 1 ? '' : 's'}. Positions, timing and highlighted words stay.`
      : 'Pick a style for the captions you generate or import next.';
    for (const [id, t] of tiles) t.classList.toggle('selected', id === opts.captionStyle);
  }
  return { el, sync };
}

export function captionsTab(ctx) {
  const opts = { ...DEFAULT_OPTS, ...(prefs().captionOpts || {}) };
  const save = () => setPref('captionOpts', { ...opts });
  const panels = {};
  const make = {
    auto: () => autoPanel(ctx, opts, save),
    lyrics: () => lyricsPanel(ctx, opts, save),
    transcript: () => transcriptPanel(ctx, opts, save, {
      onCaptions: async (cues) => {
        const mode = await askReplace(ctx.store);
        if (!mode) return;
        const n = applyCaptions(ctx, cues, { mode, preset: opts.preset, position: opts.position, label: 'Captions from transcript', captionStyle: opts.captionStyle });
        toast(`Added ${n} caption${n === 1 ? '' : 's'}.`, { kind: 'success' });
      },
    }),
    list: () => listPanel(ctx, opts),
    styles: () => stylesPanel(ctx, opts, save),
    files: () => filesPanel(ctx, opts, save),
  };
  const layout = tabLayout({
    title: 'Captions',
    search: false,
    categories: [
      { id: 'auto', label: 'Generate' },
      { id: 'lyrics', label: 'Lyrics' },
      { id: 'transcript', label: 'Transcript' },
      { id: 'list', label: 'Captions' },
      { id: 'styles', label: 'Styles' },
      { id: 'files', label: 'Caption files' },
    ],
    render(cat) {
      const p = (panels[cat] ||= make[cat]());
      p.sync?.();
      return p.el;
    },
  });
  layout.el.classList.add('wrap-cats');
  return {
    el: layout.el,
    dispose() {
      for (const p of Object.values(panels)) p.dispose?.();
    },
  };
}
