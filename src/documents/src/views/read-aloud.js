/**
 * Read Aloud: speaks the document from the caret with the browser's own speech synthesis,
 * selecting each word as it is read (Review → Read Aloud).
 * A small player floats over the pages with previous/next paragraph, play/pause and stop.
 */
import { el, isComposing, MOD_KEY } from '../ui/dom.js';
import { commandIconEl } from '../ui/ribbon.js';
import { revisionView } from '../engine/revisions.js';

/**
 * What Read Aloud says of each paragraph that has words: [{ start, end, text, at }], where `start` and `end` are the
 * paragraph's document positions and `at[i]` is the position of `text[i]`. Text tracked as deleted is left out, as the
 * page strikes it out (in the Original view, the inserted text is, as the page hides it).
 */
export function speakableParagraphs(paragraphs, view = revisionView.mode) {
  const skip = view === 'original' ? 'ins' : 'del', out = [];
  let position = 0;
  for (const p of paragraphs) {
    const start = position, at = [];
    let text = '';
    for (const run of p.runs) {
      if (run.revision?.type !== skip && run.text) {
        text += run.text.replace(/\ufffc/g, ' ');
        for (let i = 0; i < run.text.length; i++) at.push(position + i);
      }
      position += run.text.length;
    }
    if (text.trim()) out.push({ start, end: position, text, at });
    position++;
  }
  return out;
}

export function createReadAloud({ editor, onState = () => {} }) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  // `current` is the paragraph being read and `from` where in its text the utterance began. `seen` is the
  // document's text its positions belong to: an edit while it reads moves them (follow).
  let active = false, paused = false, current = null, from = 0, seen = '', utterance = null;
  const play = el('button.icon-btn.read-aloud-play', { type: 'button', 'aria-label': 'Pause', title: 'Pause', onclick: () => toggle() });
  const bar = el('div.read-aloud-bar', { role: 'toolbar', 'aria-label': 'Read Aloud', hidden: true },
    el('button.icon-btn', { type: 'button', 'aria-label': 'Previous paragraph', title: 'Previous paragraph', onclick: () => jump(-1) }, commandIconEl('previousArrow', 16)),
    play,
    el('button.icon-btn', { type: 'button', 'aria-label': 'Next paragraph', title: 'Next paragraph', onclick: () => jump(1) }, commandIconEl('nextArrow', 16)),
    el('button.icon-btn', { type: 'button', 'aria-label': 'Stop reading', title: 'Stop reading', onclick: () => stop() }, '✕'));
  const setPlayIcon = () => {
    play.replaceChildren(el('span', { 'aria-hidden': 'true' }, paused ? '▶' : '❚❚'));
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause'); play.title = play.getAttribute('aria-label');
  };
  const body = () => editor()?.session?.body;

  /**
   * Move the paragraph being read through the edits made since `seen`: the texts differ in one span, before which
   * positions stay, after which they move by the change in length, and inside which the words are gone.
   */
  function follow() {
    const now = body()?.text ?? '';
    if (now === seen) return;
    const max = Math.min(now.length, seen.length);
    let a = 0, b = 0;
    while (a < max && now.charCodeAt(a) === seen.charCodeAt(a)) a++;
    while (b < max - a && now.charCodeAt(now.length - 1 - b) === seen.charCodeAt(seen.length - 1 - b)) b++;
    const oldEnd = seen.length - b, newEnd = now.length - b, delta = now.length - seen.length;
    const map = position => position < a ? position : position >= oldEnd ? position + delta : null;
    if (current) {
      current.at = current.at.map(position => position === null ? null : map(position));
      current.start = map(current.start) ?? a; current.end = map(current.end) ?? newEnd;
    }
    seen = now;
  }
  /** Read the paragraph `list[index]` from the character `offset` of its text. */
  function speakParagraph(list, index, offset = 0) {
    if (!active || !synth) return;
    const p = list[index];
    if (!p) { stop(); return; }
    current = p; from = offset; seen = body()?.text ?? '';
    const said = utterance = new SpeechSynthesisUtterance(p.text.slice(offset));
    said.lang = document.documentElement.lang || navigator.language || 'en-US';
    said.onboundary = e => {
      if (e.name && e.name !== 'word') return;
      const engine = editor(); if (utterance !== said || !engine) return;
      const i = from + e.charIndex, word = /^[^\s]+/u.exec(p.text.slice(i))?.[0] || '';
      if (!word) return;
      follow();
      // A word edited away is not shown; nor is one while a header, footer or note is being edited.
      const a = p.at[i], b = p.at[i + word.length - 1];
      if (a == null || b == null || engine.session.path !== null) return;
      engine.model.select(a, b + 1);
      // Typing while it reads replaces the word shown selected, not where the caret was before.
      engine.syncInput?.(); engine.paint(); engine.revealCaret?.();
    };
    said.onend = () => { if (said.cancelled || utterance !== said) return; next(); };
    synth.speak(said);
  }
  /** The paragraphs as they are now, and which of them `current` is (or the first after where it was). */
  function locate() {
    follow();
    const list = speakableParagraphs(body()?.paragraphs || []);
    const index = current ? list.findIndex(p => p.end >= current.start) : -1;
    return { list, index };
  }
  /** Read on from the paragraph after the one just read, as the document is now. */
  function next() {
    follow();
    const end = current?.end ?? 0, list = speakableParagraphs(body()?.paragraphs || []);
    speakParagraph(list, list.findIndex(p => p.start > end));
  }

  function start() {
    const engine = editor();
    if (!engine || !synth) return false;
    stop();
    engine.finishComposition();
    const list = speakableParagraphs(engine.session.body.paragraphs);
    const caret = engine.session.path === null ? engine.model.range[0] : 0;
    let index = list.findIndex(p => p.end >= caret);
    if (index < 0) index = 0;
    const p = list[index], offset = p && caret > p.start ? Math.max(0, p.at.findIndex(position => position >= caret)) : 0;
    active = true; paused = false; bar.hidden = false; setPlayIcon(); onState(true);
    speakParagraph(list, index, offset);
    return true;
  }
  function cancelCurrent() { if (utterance) utterance.cancelled = true; synth?.cancel(); }
  function stop() {
    if (!active) return;
    active = false; paused = false; cancelCurrent(); utterance = null; current = null; bar.hidden = true; onState(false);
    editor()?.focus();
  }
  function toggle() {
    if (!active) return;
    if (paused) { paused = false; synth.resume(); } else { paused = true; synth.pause(); }
    setPlayIcon();
  }
  function jump(direction) {
    if (!active) return;
    cancelCurrent();
    const { list, index } = locate();
    paused = false; setPlayIcon();
    // The paragraph being read was removed: "next" is the one now in its place.
    const here = index < 0 ? list.length : index, gone = !current || current.at.every(position => position === null);
    speakParagraph(list, Math.max(0, Math.min(list.length - 1, here + (gone && direction > 0 ? 0 : direction))));
  }

  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e)) return;
    // Option+Cmd+Space on a Mac, Ctrl+Alt+Space elsewhere.
    if (e.code === 'Space' && e.altKey && (MOD_KEY === 'Cmd' ? e.metaKey : e.ctrlKey) && !e.shiftKey) { e.preventDefault(); active ? stop() : start(); }
    else if (active && e.key === 'Escape' && !document.querySelector('.modal-root, .menu')) { e.preventDefault(); stop(); }
  }, { signal: keyAbort.signal });

  return { bar, start, stop, toggle, get active() { return active; }, supported: !!synth, destroy() { keyAbort.abort(); stop(); bar.remove(); } };
}
