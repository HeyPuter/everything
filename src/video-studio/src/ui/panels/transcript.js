/**
 * Transcript panel: the project's speech as words. Click a word to jump
 * there, select words and delete them to cut that part of the video (the
 * gap closes on every unlocked track), remove filler words and long pauses
 * in one go, or turn the transcript into captions.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US, timecode } from '../../lib/time.js';
import { emptyState } from './common.js';
import { selectField, segmented } from '../controls.js';
import { toast, confirmDialog } from '../dialog.js';
import { showMenu } from '../menu.js';
import { LANGUAGES, STT_RATE, mixdown, transcribeMix, clipsForScope, errorMessage, groupWords } from '../../media/transcribe.js';
import { findFillers, findPauses, rangesForWords, removalOrder, wordAt, transcriptText, anchorWords, transcriptWords } from '../../media/transcript.js';
import { aiAvailable } from '../../media/tts.js';
import * as T from '../../model/timeline.js';

const PAUSES = [
  { value: 0.8, label: 'Longer than 0.8 s' },
  { value: 1.2, label: 'Longer than 1.2 s' },
  { value: 2, label: 'Longer than 2 s' },
  { value: 3, label: 'Longer than 3 s' },
];

/** Cut time ranges out of the timeline as one undo step. */
export function removeRanges(store, ranges, label) {
  const list = removalOrder(ranges);
  if (!list.length) return false;
  return store.update(label, (p) => {
    let n = 0;
    for (const r of list) n += T.removeRange(p, r.start, r.end);
    return n > 0 || list.length > 0;
  });
}

export function transcriptPanel(ctx, opts, save, { onCaptions } = {}) {
  const { store, player } = ctx;
  let anchor = -1; // selection anchor word index
  let focus = -1; // selection focus (the keyboard cursor)
  let showFillers = true;
  let showPauses = false;
  let pauseMin = opts.pauseMin || 1.2;
  let soft = Boolean(opts.softFillers);
  let abort = null;
  let wordEls = [];
  let current = -1;

  // Placed once per edit: follow() asks on every frame while playing.
  let placed = { rev: -1, project: null, words: [] };
  const words = () => {
    if (placed.rev !== store.revision || placed.project !== store.project) placed = { rev: store.revision, project: store.project, words: transcriptWords(store.project) };
    return placed.words;
  };
  const selRange = () => (anchor < 0 || focus < 0 ? null : [Math.min(anchor, focus), Math.max(anchor, focus)]);

  // ---- Empty state: transcribe ----------------------------------------------
  const lang = selectField({ label: 'Spoken language', options: LANGUAGES, value: opts.language, onChange: (v) => { opts.language = v; save(); } });
  const scope = segmented({
    label: 'Listen to',
    options: [{ value: 'main', label: 'Base track' }, { value: 'all', label: 'All audio' }],
    value: opts.scope,
    onChange: (v) => { opts.scope = v; save(); },
  });
  const goBtn = h('button.btn.primary.block', { type: 'button' }, icon('subtitles', 16), 'Transcribe');
  const status = h('p.asset-hint', { role: 'status' });
  const cancelBtn = h('button.btn.small', { type: 'button', hidden: true }, 'Cancel');
  cancelBtn.addEventListener('click', () => abort?.abort());
  goBtn.addEventListener('click', () => transcribe());

  async function transcribe() {
    if (abort) return;
    if (!clipsForScope(store.project, opts.scope).length) {
      toast('There is no speech to transcribe. Add clips with sound first.', { kind: 'info' });
      return;
    }
    abort = new AbortController();
    const { signal } = abort;
    goBtn.disabled = true;
    cancelBtn.hidden = false;
    status.textContent = 'Preparing audio...';
    const snap = structuredClone(store.project);
    try {
      const mix = await mixdown(snap, ctx.library, { scope: opts.scope, signal, onProgress: (f) => (status.textContent = `Preparing audio... ${Math.round(f * 100)}%`) });
      status.textContent = 'Transcribing...';
      const fake = import.meta.env.DEV ? globalThis.__vsFakeTranscript : null;
      const w = fake ? await fake(mix, STT_RATE) : await transcribeMix(mix, STT_RATE, { language: opts.language, signal, onProgress: (f) => (status.textContent = `Transcribing... ${Math.round(f * 100)}%`) });
      if (!w.length) {
        toast('No speech was found.', { kind: 'info' });
        return;
      }
      store.update('Transcribe', (p) => {
        const timed = w.map((x) => ({ text: x.text, start: Math.round(x.start * US), end: Math.round(x.end * US) }));
        // Anchored to the media heard, so later edits move the words with it.
        p.transcript = { language: opts.language, words: anchorWords(snap, timed) };
      }, { structural: false });
      announce(`Transcript ready, ${w.length} words`);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error(err);
        toast(errorMessage(err, "Couldn't transcribe the audio."), { kind: 'error' });
      }
    } finally {
      abort = null;
      goBtn.disabled = false;
      cancelBtn.hidden = true;
      status.textContent = '';
    }
  }

  const signIn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
  const emptyEl = h('div.cap-form',
    h('p.asset-hint', 'Get the speech as text, then edit the video by editing the words: delete words to cut them, and remove filler words and long pauses in one click.'),
    lang.el,
    h('div.field', h('span.field-label', 'Listen to'), scope.el),
    goBtn,
    h('div.cap-progress-foot', status, cancelBtn),
  );
  const needAi = () => emptyState('user', 'Sign in to transcribe', 'Transcripts use Puter AI speech to text, so they need a Puter account.', signIn);

  // ---- Transcript view --------------------------------------------------------
  const search = h('input.input.small', { type: 'search', placeholder: 'Find words', 'aria-label': 'Find words in the transcript' });
  const fillerBtn = h('button.btn.small', { type: 'button' });
  const pauseBtn = h('button.btn.small', { type: 'button' });
  const moreBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'More transcript options', 'data-tip': 'More' }, icon('more', 16));
  const deleteBtn = h('button.btn.small.danger', { type: 'button', disabled: true }, icon('scissors', 14), 'Delete selection');
  const selInfo = h('span.tr-sel-info', { role: 'status' });
  const body = h('div.tr-words', { tabindex: '0', role: 'textbox', 'aria-readonly': 'true', 'aria-multiline': 'true', 'aria-label': 'Transcript. Arrow keys move between words, Shift extends the selection, Enter plays from a word, Delete cuts the selected words.' });
  const viewEl = h('div.tr-view',
    h('div.tr-tools', search, fillerBtn, pauseBtn, moreBtn),
    body,
    h('div.tr-selbar', selInfo, deleteBtn),
  );

  fillerBtn.addEventListener('click', async () => {
    const idx = findFillers(words(), { language: store.project.transcript?.language, soft });
    if (!idx.length) {
      toast('No filler words found.', { kind: 'info' });
      return;
    }
    const ok = await confirmDialog({ title: 'Remove filler words?', message: `${idx.length} filler word${idx.length === 1 ? '' : 's'} will be cut from the video.`, confirm: 'Remove' });
    if (!ok) return;
    removeRanges(store, rangesForWords(words(), idx), 'Remove filler words');
    toast(`Removed ${idx.length} filler word${idx.length === 1 ? '' : 's'}.`, { kind: 'success' });
  });
  pauseBtn.addEventListener('click', async () => {
    const pauses = findPauses(words(), { minGap: pauseMin * US });
    if (!pauses.length) {
      toast('No long pauses found.', { kind: 'info' });
      return;
    }
    const total = pauses.reduce((s, r) => s + r.end - r.start, 0);
    const ok = await confirmDialog({ title: 'Shorten pauses?', message: `${pauses.length} pause${pauses.length === 1 ? '' : 's'} (${(total / US).toFixed(1)} s in all) will be cut from the video.`, confirm: 'Shorten' });
    if (!ok) return;
    removeRanges(store, pauses, 'Shorten pauses');
  });
  moreBtn.addEventListener('click', () => showMenu(moreBtn, [
    { label: 'Highlight filler words', checked: showFillers, onSelect: () => { showFillers = !showFillers; render(); } },
    { label: 'Count soft fillers ("like", "you know")', checked: soft, onSelect: () => { soft = !soft; opts.softFillers = soft; save(); render(); } },
    { label: 'Show long pauses', checked: showPauses, onSelect: () => { showPauses = !showPauses; render(); } },
    { label: 'Pause length', submenu: () => PAUSES.map((p) => ({ label: p.label, radio: true, checked: pauseMin === p.value, onSelect: () => { pauseMin = p.value; opts.pauseMin = p.value; save(); render(); } })) },
    'separator',
    { label: 'Make captions from transcript', icon: 'captions', onSelect: () => makeCaptions() },
    { label: 'Copy text', icon: 'copy', onSelect: () => navigator.clipboard?.writeText(transcriptText(words())).then(() => toast('Transcript copied.', { kind: 'success' })) },
    { label: 'Transcribe again', icon: 'reset', onSelect: () => { store.update('Clear transcript', (p) => void delete p.transcript, { structural: false }); transcribe(); } },
    { label: 'Clear transcript', icon: 'trash', danger: true, onSelect: () => store.update('Clear transcript', (p) => void delete p.transcript, { structural: false }) },
  ], { label: 'Transcript options' }));

  function makeCaptions() {
    const cues = groupWords(words().map((w) => ({ text: w.text, start: w.start / US, end: w.end / US })), { maxWords: opts.maxWords || 5, maxChars: 42, maxGap: 0.8 });
    if (!cues.length) return;
    onCaptions?.(cues);
  }

  deleteBtn.addEventListener('click', () => deleteSelection());
  function deleteSelection() {
    const r = selRange();
    if (!r) return;
    const idx = [];
    for (let i = r[0]; i <= r[1]; i++) idx.push(i);
    removeRanges(store, rangesForWords(words(), idx), idx.length === 1 ? 'Cut word' : `Cut ${idx.length} words`);
    focus = Math.min(r[0], words().length - 1);
    anchor = -1;
    announce(`${idx.length} word${idx.length === 1 ? '' : 's'} cut`);
  }

  // Word selection with the mouse: press, drag, Shift+click extends.
  let dragging = false;
  body.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-i]');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (e.shiftKey && anchor >= 0) focus = i;
    else anchor = focus = i;
    dragging = true;
    body.setPointerCapture(e.pointerId);
    paintSelection();
  });
  body.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.tr-words [data-i]');
    if (el && Number(el.dataset.i) !== focus) {
      focus = Number(el.dataset.i);
      paintSelection();
    }
  });
  body.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (anchor === focus) {
      const w = words()[focus];
      if (w) store.seek(w.start);
      if (!e.shiftKey) anchor = -1;
    }
    paintSelection();
  });
  body.addEventListener('keydown', (e) => {
    const n = words().length;
    if (!n) return;
    const move = (d) => {
      const next = Math.max(0, Math.min(n - 1, (focus < 0 ? 0 : focus) + d));
      if (e.shiftKey) {
        if (anchor < 0) anchor = focus < 0 ? next : focus;
      } else anchor = -1;
      focus = next;
      paintSelection();
      wordEls[focus]?.scrollIntoView({ block: 'nearest' });
      announce(words()[focus].text);
    };
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'Home') move(-n);
    else if (e.key === 'End') move(n);
    else if (e.key === 'Enter' && focus >= 0) store.seek(words()[focus].start);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selRange()) deleteSelection();
    else if (e.key === 'Escape') {
      anchor = -1;
      paintSelection();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });

  function paintSelection() {
    const r = anchor >= 0 ? selRange() : focus >= 0 ? [focus, focus] : null;
    wordEls.forEach((el, i) => {
      el.classList.toggle('sel', Boolean(r && anchor >= 0 && i >= r[0] && i <= r[1]));
      el.classList.toggle('cursor', i === focus);
    });
    const real = anchor >= 0 ? selRange() : null;
    deleteBtn.disabled = !real;
    if (real) {
      const w = words();
      const n = real[1] - real[0] + 1;
      selInfo.textContent = `${n} word${n === 1 ? '' : 's'}, ${((w[real[1]].end - w[real[0]].start) / US).toFixed(1)} s`;
    } else selInfo.textContent = '';
  }

  function render() {
    const w = words();
    const q = search.value.trim().toLowerCase();
    const fillers = new Set(showFillers ? findFillers(w, { language: store.project.transcript?.language, soft }) : []);
    const pauses = showPauses ? findPauses(w, { minGap: pauseMin * US }) : [];
    const pauseAfter = new Map();
    for (const p of pauses) {
      const i = w.findIndex((x) => x.end + 0.2 * US >= p.start - 1);
      if (i >= 0) pauseAfter.set(i, p);
    }
    const nodes = [];
    wordEls = w.map((x, i) => {
      const el = h('span.tr-word', { 'data-i': String(i), title: timecode(x.start, store.fps) }, x.text);
      if (fillers.has(i)) el.classList.add('filler');
      if (q && x.text.toLowerCase().includes(q)) el.classList.add('match');
      nodes.push(el, ' ');
      const p = pauseAfter.get(i);
      if (p) nodes.push(h('span.tr-pause', { title: 'Long pause' }, `${((p.end - p.start) / US + 0.4).toFixed(1)} s`), ' ');
      if (i + 1 < w.length && w[i + 1].start - x.end >= 2 * US) nodes.push(h('br'), h('br'));
      return el;
    });
    body.replaceChildren(...nodes);
    const nf = findFillers(w, { language: store.project.transcript?.language, soft }).length;
    fillerBtn.replaceChildren(icon('wand', 14), `Remove fillers (${nf})`);
    fillerBtn.disabled = !nf;
    const np = findPauses(w, { minGap: pauseMin * US }).length;
    pauseBtn.replaceChildren(icon('timer', 14), `Shorten pauses (${np})`);
    pauseBtn.disabled = !np;
    if (focus >= w.length) focus = w.length - 1;
    if (anchor >= w.length) anchor = -1;
    current = -1;
    paintSelection();
    follow();
  }
  search.addEventListener('input', render);

  function follow() {
    const i = wordAt(words(), player?.time ?? store.time);
    if (i === current) return;
    wordEls[current]?.classList.remove('now');
    current = i;
    if (i >= 0) {
      wordEls[i]?.classList.add('now');
      if (player?.playing) wordEls[i]?.scrollIntoView({ block: 'nearest' });
    }
  }

  const el = h('div.tr-panel');
  let shown = null;
  let shownLang = null;
  function sync() {
    const w = words();
    if (!w.length) {
      shown = null;
      el.replaceChildren(aiAvailable(ctx) || (import.meta.env.DEV && globalThis.__vsFakeTranscript) ? emptyEl : needAi());
      return;
    }
    if (el.firstChild !== viewEl) el.replaceChildren(viewEl);
    // words() keeps its array while the words stay where they are.
    if (w !== shown || store.project.transcript?.language !== shownLang) {
      shown = w;
      shownLang = store.project.transcript?.language;
      render();
    }
  }
  const offs = [
    store.on('change', () => sync()),
    store.on('time', () => follow()),
    player?.on?.('frame', () => follow()),
  ].filter(Boolean);
  sync();
  return {
    el,
    sync,
    dispose() {
      offs.forEach((f) => f?.());
      abort?.abort();
    },
  };
}
