import { el, isComposing, listboxKeys } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { engineApi } from '../lib/engine-api.js';
import { wordsToCheck, proofingText, loadSpeller } from '../lib/spelling.js';
import { proofingFingerprint, wordsInSavedRanges } from '../lib/proofing-cache.js';

const ENABLED_KEY = 'documents:spellcheck';
const LIMIT = 3000; // Past this many, a word processor stops marking and says so.
export const spellingEnabled = () => { try { return localStorage.getItem(ENABLED_KEY) !== 'off'; } catch { return true; } };

/**
 * Spelling as you type and the Spelling pane, for the document body. Words are checked shortly after
 * each edit and marked with a red wavy line on screen only; right-click offers suggestions, Ignore All
 * and Add to Dictionary. Corrections are ordinary edits, one undo step each.
 */
export function createProofing({ editor, pkg, error, onState = () => {} }) {
  let enabled = spellingEnabled();
  const ignored = new Set(), ignoredOnce = new Set();
  const known = new Map();
  let results = { revision: -1, text: '', misspelled: [], overflow: false };
  let timer = null, speller = null, failure = null, typedAt = -1;
  let overlayEngine = null;
  let rechecked = false, savedEligibility = null;

  function savedResult(body) {
    const saved = pkg()?.savedSpelling;
    if (rechecked || !saved) return null;
    if (savedEligibility?.saved !== saved || savedEligibility.body !== body || savedEligibility.revision !== body.revision) {
      savedEligibility = { saved, body, revision: body.revision, usable: body.text === saved.text && proofingFingerprint(body.paragraphs) === saved.fingerprint };
    }
    return savedEligibility.usable ? saved : null;
  }

  const engineReady = () => { const engine = editor(); return engine && !engine.destroyed ? engine : null; };
  const editable = () => !!engineReady() && !pkg()?.readOnly;

  function schedule(delay = 350) {
    clearTimeout(timer);
    if (!enabled) return;
    timer = setTimeout(() => { check().catch(e => { failure = e; onState(); }); }, delay);
  }

  async function check() {
    const engine = engineReady();
    if (!engine || !enabled) return;
    const savedBefore = savedResult(engine.session.body);
    if (!savedBefore || savedBefore.ranges.length) speller ??= await loadSpeller();
    if (engine !== engineReady()) return;
    const body = engine.session.body, revision = body.revision, text = body.text;
    const saved = savedResult(body);
    if (!saved && !speller) return check();
    const caret = engine.session.path === null && engine.model.range[0] === engine.model.range[1] ? engine.model.range[0] : -1;
    const misspelled = [];
    let overflow = false, skipped = null;
    const words = saved && !saved.ranges.length ? [] : wordsToCheck(proofingText(text, body.paragraphs));
    for (const word of saved ? wordsInSavedRanges(words, saved.ranges) : words) {
      if (ignored.has(word.word) || ignoredOnce.has(`${word.start}:${word.word}`)) continue;
      // The word being typed is judged once the typing moves past it.
      if (word.end === caret && typedAt === revision) { skipped = caret; continue; }
      let ok = known.get(word.word);
      if (ok === undefined) { ok = speller.correct(word.word); known.set(word.word, ok); }
      if (!ok) { if (misspelled.length >= LIMIT) { overflow = true; break; } misspelled.push(word); }
    }
    results = { revision, text, misspelled, overflow, skipped };
    failure = null;
    engine.paint(); onState();
  }

  function overlay(ctx, index) {
    const engine = engineReady();
    // This document setting hides automatic marks, not manual spelling review.
    if (!engine || !enabled || pkg()?.hideSpellingErrors) return;
    const body = engine.session.body;
    if (results.revision !== body.revision || !results.misspelled.length) return;
    const layout = engine.layout;
    if (results.layout !== layout) { results.layout = layout; results.rects = null; }
    results.rects ??= results.misspelled.flatMap(m => engineApi().selectionRects(layout, m.start, m.end).map(rect => ({ ...rect })));
    ctx.save();
    ctx.strokeStyle = '#E0221B'; ctx.lineWidth = 1;
    for (const r of results.rects) {
      if (r.page !== index || r.width < 2) continue;
      // A wavy line along the bottom of the word's line box, as word processors draw it.
      const y = r.y + r.height - 2.5, step = 2;
      ctx.beginPath(); ctx.moveTo(r.x, y);
      for (let x = r.x, up = true; x < r.x + r.width; x += step, up = !up) ctx.lineTo(Math.min(x + step, r.x + r.width), y + (up ? -1.5 : 0));
      ctx.stroke();
    }
    ctx.restore();
  }
  overlay.spelling = true;

  function attach(engine) {
    if (overlayEngine === engine) return;
    overlayEngine = engine;
    if (!engine.overlays.includes(overlay)) engine.overlays.push(overlay);
    results = { revision: -1, text: '', misspelled: [], overflow: false };
    rechecked = false; savedEligibility = null;
    schedule(0);
  }

  const misspellingAt = position => results.revision === engineReady()?.session.body.revision ? results.misspelled.find(m => m.start <= position && position <= m.end) : null;

  /**
   * The body's occurrences of a misspelled word as the text stands now. A misspelling was found by an
   * earlier check, and the panes stay open while the document is edited, so its offsets can be stale.
   */
  function occurrences(word) {
    const body = engineReady()?.session.body; if (!body) return [];
    return wordsToCheck(proofingText(body.text, body.paragraphs)).filter(w => w.word === word);
  }
  /** Where misspelling `m` is now: itself while the text is unchanged, else the nearest occurrence of its word, or null. */
  function locate(m) {
    const body = engineReady()?.session.body; if (!body) return null;
    if (body.text.slice(m.start, m.end) === m.word) return m;
    return occurrences(m.word).reduce((best, w) => !best || Math.abs(w.start - m.start) < Math.abs(best.start - m.start) ? w : best, null);
  }
  /** Replace a misspelling; returns where it was replaced, or false. */
  function replaceWord(m, text) {
    const engine = engineReady(); if (!engine || !editable()) return false;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const at = locate(m);
    if (!at) { schedule(0); return false; }
    const ok = engine.execute(() => { engine.model.select(at.wordStart ?? at.start, at.wordEnd ?? at.end); engine.model.replace(text); });
    engine.focus(); engine.onSelection?.();
    schedule(0);
    return ok ? at : false;
  }
  /** Replace every occurrence of a misspelled word except those ignored once, as one undo step. */
  function replaceAll(word, text) {
    const engine = engineReady(); if (!engine || !editable()) return false;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const targets = occurrences(word).filter(m => !ignoredOnce.has(`${m.start}:${m.word}`)).reverse();
    if (!targets.length) return false;
    const ok = engine.execute(() => { for (const m of targets) { engine.model.select(m.wordStart ?? m.start, m.wordEnd ?? m.end); engine.model.replace(text); } });
    schedule(0);
    return ok;
  }
  function ignoreAll(word) { ignored.add(word); schedule(0); }
  function addToDictionary(word) { speller?.add(word); known.set(word, true); schedule(0); }

  /* ---- Spelling pane ---- */
  let current = null;
  const heading = el('h2', {}, 'Spelling');
  const status = el('p.ed-proof-status', { role: 'status' });
  const context = el('p.ed-proof-context');
  const suggestions = el('div.ed-proof-suggestions', { role: 'listbox', 'aria-label': 'Suggestions' });
  const chooseSuggestion = item => { for (const other of suggestions.children) other.setAttribute('aria-selected', String(other === item)); };
  // One Tab stop, on the chosen suggestion; the arrows move through the suggestions and choose as they go.
  const settleSuggestions = listboxKeys(suggestions, chooseSuggestion);
  const button = (label, onclick, primary = false) => el(primary ? 'button.btn.btn-primary' : 'button.btn.btn-outline', { type: 'button', onclick }, label);
  const change = button('Change', () => {
    const choice = selectedSuggestion(); if (!current || !choice) return;
    const at = replaceWord(current, choice);
    next(at ? at.start + choice.length : current.start);
  }, true);
  const changeAll = button('Change All', () => {
    const choice = selectedSuggestion(); if (!current || !choice) return;
    const at = locate(current);
    replaceAll(current.word, choice);
    queueMicrotask(() => next(at ? at.start : current.start));
  });
  const ignoreOnce = button('Ignore Once', () => { if (!current) return; ignoredOnce.add(`${current.start}:${current.word}`); next(current.end); });
  const ignoreAllButton = button('Ignore All', () => { if (!current) return; ignoreAll(current.word); next(current.end); });
  const add = button('Add to Dictionary', () => { if (!current) return; addToDictionary(current.word); next(current.end); });
  const actions = el('div.ed-proof-actions', {}, change, changeAll, ignoreOnce, ignoreAllButton, add);
  const detail = el('div.ed-proof-detail', {}, el('h3', {}, 'Not in Dictionary'), context, el('h3', {}, 'Suggestions'), suggestions, actions);
  const pane = el('aside.canvas-outline-panel.ed-proof-pane', { 'aria-label': 'Spelling', hidden: true },
    el('div.canvas-panel-heading', {}, heading, el('button.icon-btn', { type: 'button', 'aria-label': 'Close Spelling pane', onclick: () => closePane() }, iconEl('x', 18))),
    el('div.canvas-panel-scroll', {}, status, detail));
  pane.addEventListener('keydown', e => { if (e.key === 'Escape' && !isComposing(e)) { e.preventDefault(); closePane(); } });
  function selectedSuggestion() { return suggestions.querySelector('[aria-selected="true"]')?.dataset.value || null; }
  function closePane() { pane.hidden = true; current = null; onState(); engineReady()?.focus(); }

  async function next(from) {
    const engine = engineReady(); if (!engine) return;
    try { await check(); } catch (e) { error(e); return; }
    const list = results.misspelled;
    const found = list.find(m => m.start >= from && !ignoredOnce.has(`${m.start}:${m.word}`)) || list.find(m => !ignoredOnce.has(`${m.start}:${m.word}`));
    current = found || null;
    detail.hidden = !current;
    if (!current) {
      status.textContent = failure ? failure.message : 'The spelling check is complete. No spelling errors found.';
      engine.focus(); onState(); return;
    }
    status.textContent = '';
    if (engine.session.path !== null) engine.editStory(null);
    engine.model.select(current.start, current.end); engine.syncInput?.(); engine.paint(); engine.revealCaret(); engine.onSelection?.();
    const text = results.text, lineStart = Math.max(text.lastIndexOf('\n', current.start) + 1, current.start - 60), lineEnd = Math.min(...[text.indexOf('\n', current.end), current.end + 60].filter(n => n >= 0));
    context.replaceChildren((lineStart > 0 && text[lineStart - 1] !== '\n' ? '…' : '') + text.slice(lineStart, current.start), el('mark', {}, text.slice(current.start, current.end)), text.slice(current.end, lineEnd));
    const options = speller.suggest(current.word);
    suggestions.replaceChildren(...(options.length ? options : ['(no suggestions)']).map((option, i) => {
      const item = el('button.ed-proof-suggestion', { type: 'button', role: 'option', 'aria-selected': String(!i && !!options.length), dataset: { value: options.length ? option : '' }, disabled: !options.length,
        onclick: () => chooseSuggestion(item),
        ondblclick: () => change.click() }, option);
      return item;
    }));
    settleSuggestions();
    for (const control of [change, changeAll]) control.disabled = !options.length || !editable();
    for (const control of [ignoreOnce, ignoreAllButton, add]) control.disabled = false;
    onState();
    (suggestions.querySelector('[aria-selected="true"]') || ignoreOnce).focus();
  }

  return {
    pane, overlay,
    attach,
    changed(typed = false) { savedEligibility = null; const engine = engineReady(); if (typed && engine) typedAt = engine.session.body.revision; schedule(); },
    /** A word skipped while it was being typed is checked once the caret leaves it. */
    selectionChanged() {
      const engine = engineReady();
      if (engine && results.skipped !== null && results.skipped !== undefined && engine.model.range[0] !== results.skipped) { results.skipped = null; typedAt = -1; schedule(0); }
    },
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = !!value;
      try { localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off'); } catch { /* private mode */ }
      if (enabled) schedule(0); else { clearTimeout(timer); results = { revision: -1, text: '', misspelled: [], overflow: false }; engineReady()?.paint(); }
      onState();
    },
    recheck() { rechecked = true; ignored.clear(); ignoredOnce.clear(); known.clear(); schedule(0); },
    /** Review → Spelling (F7): open the pane at the first misspelling after the caret. */
    async openPane() {
      const engine = engineReady(); if (!engine) return;
      rechecked = true;
      if (!enabled) this.setEnabled(true);
      pane.hidden = false; status.textContent = 'Checking…'; detail.hidden = true; onState();
      try { speller ??= await loadSpeller(); } catch (e) { status.textContent = e.message; return; }
      next(engine.session.path === null ? engine.model.range[0] : 0);
    },
    get paneOpen() { return !pane.hidden; },
    closePane,
    /** Status for the status bar: null while unknown. */
    get summary() {
      const engine = engineReady();
      if (!enabled || !engine || results.revision !== engine.session.body.revision) return null;
      return { errors: results.misspelled.length, overflow: results.overflow };
    },
    /** Right-click items for a misspelled word at a document position, or none. */
    menuItems(position) {
      const m = enabled && !pkg()?.hideSpellingErrors && engineReady()?.session.path === null ? misspellingAt(position) : null;
      if (!m || !speller) return [];
      const options = speller.suggest(m.word).slice(0, 5);
      return [
        ...(options.length ? options.map(option => ({ label: option, labelStyle: { fontWeight: '600' }, disabled: !editable(), onSelect: () => replaceWord(m, option) })) : [{ label: '(no spelling suggestions)', disabled: true }]),
        { separator: true },
        { label: 'Ignore All', onSelect: () => ignoreAll(m.word) },
        { label: 'Add to Dictionary', onSelect: () => addToDictionary(m.word) },
        { separator: true },
      ];
    },
    /* ---- For the Editor pane ---- */
    /** Misspellings found by the latest check of the current text: [{ start, end, word }]. */
    async issues() {
      const engine = engineReady(); if (!engine) return [];
      rechecked = true;
      speller ??= await loadSpeller();
      await check();
      return results.misspelled.filter(m => !ignoredOnce.has(`${m.start}:${m.word}`));
    },
    suggest(word) { return speller?.suggest(word) || []; },
    change(m, text) { return replaceWord(m, text); },
    changeAll(word, text) { return replaceAll(word, text); },
    ignoreOnce(m) { ignoredOnce.add(`${m.start}:${m.word}`); schedule(0); },
    ignoreAll, addToDictionary,
    /** Forget Ignore and Ignore All choices for this session (Reset Ignored Words). */
    resetIgnored() { ignored.clear(); ignoredOnce.clear(); known.clear(); rechecked = true; schedule(0); onState(); },
    get ignoredCount() { return ignored.size + ignoredOnce.size; },
    destroy() {
      clearTimeout(timer);
      const at = overlayEngine?.overlays.indexOf(overlay) ?? -1;
      if (at >= 0) overlayEngine.overlays.splice(at, 1);
      overlayEngine = null;
    },
  };
}
