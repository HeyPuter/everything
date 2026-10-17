import { el } from '../ui/dom.js';

/** The browser's speech recognition constructor, or null where dictation is unavailable. */
export const speechRecognition = () => (typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null);

/** Spoken punctuation that becomes characters, as dictation software commonly offers. */
const SPOKEN = [[/\s*\b(new paragraph)\b\s*/gi, '\n'], [/\s*\b(new line)\b\s*/gi, '\v'], [/\s*\b(period|full stop)\b/gi, '.'], [/\s*\bcomma\b/gi, ','], [/\s*\bquestion mark\b/gi, '?'], [/\s*\bexclamation (mark|point)\b/gi, '!'], [/\s*\bcolon\b/gi, ':'], [/\s*\bsemicolon\b/gi, ';']];
export function spokenText(transcript) {
  let text = String(transcript);
  for (const [pattern, value] of SPOKEN) text = text.replace(pattern, value);
  // Only spaces are trimmed: a phrase that ends with (or is) a spoken break keeps it.
  return text.replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
}
/** Join dictated text to what precedes the caret: a space between words, a capital after a sentence. */
export function joinDictation(before, text) {
  if (!text) return '';
  const last = before.slice(-1);
  let out = text;
  if (!before.trim() || /[.!?\n\v]\s*$/.test(before)) out = out.charAt(0).toLocaleUpperCase() + out.slice(1);
  if (last && !/[\s\n\v(“"]/.test(last) && !/^[.,!?:;\n\v]/.test(out)) out = ' ' + out;
  return out;
}

/**
 * Dictate: speech recognition inserting text at the caret. While listening, a banner shows the words
 * still being recognized; final phrases go into the document as one undo step each. Escape or the button
 * stops. Hidden where the browser has no speech recognition.
 */
export function createDictation({ editor, readOnly, host, onState = () => {}, error = () => {} }) {
  const Recognition = speechRecognition();
  let recognition = null, active = false;
  const interim = el('span.dictate-interim');
  const stopButton = el('button.btn.btn-sm', { type: 'button', onclick: () => stop() }, 'Stop');
  const banner = el('div.dictate-banner', { role: 'status', 'aria-live': 'polite', hidden: true }, el('span.dictate-dot', { 'aria-hidden': 'true' }), el('strong', {}, 'Listening…'), interim, stopButton);
  function insert(transcript) {
    const engine = editor(); if (!engine || readOnly()) return;
    const text = spokenText(transcript);
    if (!text) return;
    engine.finishComposition();
    const [start] = engine.model.range;
    const joined = joinDictation(engine.model.text.slice(Math.max(0, start - 2), start), text);
    engine.execute(() => engine.model.replace(joined));
    engine.focus();
  }
  function start() {
    if (!Recognition || active || readOnly()) return false;
    recognition = new Recognition();
    recognition.continuous = true; recognition.interimResults = true;
    recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
    recognition.onresult = event => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) insert(result[0].transcript); else pending += result[0].transcript;
      }
      interim.textContent = pending;
    };
    recognition.onerror = event => { if (!['no-speech', 'aborted'].includes(event.error)) error(new Error(event.error === 'not-allowed' ? 'Microphone access was blocked. Allow the microphone to dictate.' : `Dictation stopped: ${event.error}.`)); };
    recognition.onend = () => { if (active) cleanup(); };
    try { recognition.start(); } catch (e) { error(e); return false; }
    active = true; banner.hidden = false; interim.textContent = '';
    (host() || document.body).append(banner);
    window.addEventListener('keydown', onKey, true);
    onState(true);
    return true;
  }
  function cleanup() {
    active = false; banner.hidden = true; interim.textContent = '';
    window.removeEventListener('keydown', onKey, true);
    recognition = null; onState(false);
  }
  function stop() {
    if (!active) return;
    const current = recognition;
    cleanup();
    try { current?.stop(); } catch { /* already stopped */ }
    editor()?.focus();
  }
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); } };
  return { supported: !!Recognition, get active() { return active; }, start, stop, toggle: () => (active ? stop() : start()), insert, banner, destroy: () => { stop(); banner.remove(); } };
}
