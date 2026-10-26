/**
 * Read Aloud: speaks the document from the caret with the browser's own speech synthesis,
 * selecting each word as it is read (Review → Read Aloud).
 * A small player floats over the pages with previous/next paragraph, play/pause and stop.
 */
import { el, isComposing, MOD_KEY } from '../ui/dom.js';
import { commandIconEl } from '../ui/ribbon.js';

/** Paragraph ranges [{ start, end, text }] of a model, skipping empty ones. */
export function speakableParagraphs(text) {
  const out = []; let at = 0;
  for (const line of text.split('\n')) {
    const clean = line.replace(/￼/g, ' ');
    if (clean.trim()) out.push({ start: at, end: at + line.length, text: clean });
    at += line.length + 1;
  }
  return out;
}

export function createReadAloud({ editor, onState = () => {} }) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let active = false, paused = false, index = 0, paragraphs = [], utterance = null;
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

  function speak() {
    const engine = editor();
    if (!active || !engine || !synth) return;
    if (index >= paragraphs.length) { stop(); return; }
    const p = paragraphs[index];
    const offset = p.speakFrom ?? 0;
    utterance = new SpeechSynthesisUtterance(p.text.slice(offset));
    utterance.lang = document.documentElement.lang || navigator.language || 'en-US';
    utterance.onboundary = e => {
      if (e.name && e.name !== 'word') return;
      const at = p.start + offset + e.charIndex;
      const word = /^[^\s]+/u.exec(p.text.slice(offset + e.charIndex))?.[0] || '';
      if (!word) return;
      engine.model.select(at, Math.min(p.end, at + word.length));
      // Typing while it reads replaces the word shown selected, not where the caret was before.
      engine.syncInput?.(); engine.paint(); engine.revealCaret?.();
    };
    utterance.onend = () => { if (utterance?.cancelled) return; index++; if (paragraphs[index]) delete paragraphs[index].speakFrom; speak(); };
    synth.speak(utterance);
  }

  function start() {
    const engine = editor();
    if (!engine || !synth) return false;
    stop();
    engine.finishComposition();
    paragraphs = speakableParagraphs(engine.model.text);
    const [a] = engine.model.range;
    index = paragraphs.findIndex(p => p.end >= a);
    if (index < 0) index = 0;
    if (paragraphs[index] && a > paragraphs[index].start) paragraphs[index].speakFrom = a - paragraphs[index].start;
    active = true; paused = false; bar.hidden = false; setPlayIcon(); onState(true);
    speak();
    return true;
  }
  function cancelCurrent() { if (utterance) utterance.cancelled = true; synth?.cancel(); }
  function stop() {
    if (!active) return;
    active = false; paused = false; cancelCurrent(); utterance = null; bar.hidden = true; onState(false);
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
    index = Math.max(0, Math.min(paragraphs.length - 1, index + direction));
    if (paragraphs[index]) delete paragraphs[index].speakFrom;
    paused = false; setPlayIcon();
    speak();
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
