/**
 * The Thesaurus pane: synonyms and antonyms for the selected word from the bundled WordNet-derived
 * data (loaded on first use), with Insert, Copy and look-up-again. Insert replaces the word the pane
 * was opened on, matching its capitalization, as one undo step.
 */
import { el } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';
import { toast } from '../ui/toast.js';
import { loadThesaurus, lookupWord, matchCase } from '../lib/thesaurus.js';
import { sidePane, hint } from './review-ui.js';

const POS_LABEL = { noun: 'noun', verb: 'verb', adjective: 'adjective', adverb: 'adverb' };

/** The word at or around a document position (letters, digits, apostrophes and inner hyphens). */
export function wordAt(text, position) {
  const isWord = ch => /[\p{L}\p{M}\p{N}'’-]/u.test(ch || '');
  let start = position, end = position;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  while (start < end && /['’-]/.test(text[start])) start++;
  while (end > start && /['’-]/.test(text[end - 1])) end--;
  return start < end ? { start, end, word: text.slice(start, end) } : null;
}

export function createThesaurusPane({ editor, pkg, error }) {
  let target = null, history = [], data = null;
  const pane = sidePane({ title: 'Thesaurus', label: 'Thesaurus pane', className: 'rv-thesaurus-pane', onClose: () => editor()?.focus() });
  const input = el('input.input', { type: 'search', 'aria-label': 'Look up a word', placeholder: 'Look up a word', autofocus: true });
  const back = el('button.icon-btn.rv-back', { type: 'button', 'aria-label': 'Back', title: 'Back', disabled: true, onclick: () => { const previous = history.pop(); if (previous) show(previous, { remember: false }); } }, '‹');
  const form = el('form.rv-lookup', { onsubmit: e => { e.preventDefault(); show(input.value); } }, back, input, el('button.btn.btn-primary.btn-sm', { type: 'submit' }, 'Look up'));
  const results = el('div.rv-thesaurus', { 'aria-live': 'polite' });
  const footer = hint('Synonyms come from WordNet 3.1 (Princeton University), used under its license. Insert replaces the selected word.');
  pane.body.append(form, results, footer);

  /** Pick the word to work on from the selection or the caret. */
  function captureTarget() {
    const engine = editor(); if (!engine) return null;
    const [a, b] = engine.model.range, text = engine.model.text;
    const found = a !== b ? { start: a, end: b, word: text.slice(a, b).trim() } : wordAt(text, a);
    target = found && found.word && !/\s/.test(found.word) ? { ...found, path: engine.session.path } : null;
    return target;
  }

  async function show(word, { remember = true } = {}) {
    word = String(word || '').trim();
    input.value = word;
    if (!word) { results.replaceChildren(el('p.rv-empty', {}, 'Select a word or type one to look it up.')); return; }
    if (remember && results.dataset.word && results.dataset.word !== word) history.push(results.dataset.word);
    back.disabled = !history.length;
    results.dataset.word = word;
    results.replaceChildren(el('p.rv-status', {}, 'Looking up…'));
    try { data ??= await loadThesaurus(); } catch (e) { results.replaceChildren(el('p.rv-status', {}, e.message)); return; }
    if (results.dataset.word !== word) return;
    const found = lookupWord(data, word);
    if (!found) { results.replaceChildren(el('p.rv-empty', {}, `No results for “${word}”.`), hint('Check the spelling, or try a simpler form of the word.')); return; }
    results.replaceChildren(
      found.lemma.toLowerCase() !== word.toLowerCase() ? el('p.rv-status', {}, `Showing results for “${found.lemma}”.`) : null,
      ...found.senses.map(sense => el('section.rv-sense', {},
        el('h3.rv-sense-head', {}, el('span.rv-pos', {}, POS_LABEL[sense.pos] || sense.pos), sense.gloss ? el('span.rv-gloss', {}, sense.gloss) : null),
        sense.synonyms.length ? el('div.rv-words', { role: 'list', 'aria-label': 'Synonyms' }, ...sense.synonyms.map(w => chip(w))) : null,
        sense.antonyms.length ? el('div.rv-antonyms', {}, el('span.rv-label', {}, 'Antonyms'), el('div.rv-words', { role: 'list', 'aria-label': 'Antonyms' }, ...sense.antonyms.map(w => chip(w, true)))) : null)));
  }
  function chip(word, antonym = false) {
    const node = el(`button.rv-word${antonym ? '.is-antonym' : ''}`, { type: 'button', role: 'listitem', title: `Insert “${word}”, or open its menu for more`,
      onclick: e => openMenu({ anchor: node, label: word, pointer: !!e.detail, items: [
        { label: `Insert “${insertion(word)}”`, disabled: !canInsert(), onSelect: () => insert(word) },
        { label: 'Copy', onSelect: () => navigator.clipboard?.writeText(word).then(() => toast(`Copied “${word}”`)).catch(error) },
        { label: `Look Up “${word}”`, onSelect: () => show(word) },
      ] }),
      ondblclick: () => insert(word) }, word);
    return node;
  }
  const insertion = word => target ? matchCase(target.word, word) : word;
  const canInsert = () => !!target && !pkg()?.readOnly && !!editor();
  function insert(word) {
    const engine = editor(); if (!engine || !target) return;
    engine.finishComposition();
    if (engine.session.path !== target.path || engine.model.text.slice(target.start, target.end) !== target.word) { error(new Error('The selected word changed. Select it again and open the Thesaurus.')); return; }
    const text = insertion(word);
    if (engine.execute(() => { engine.model.select(target.start, target.end); engine.model.replace(text); })) {
      target = { ...target, end: target.start + text.length, word: text };
      engine.model.select(target.start, target.end); engine.focus();
    }
  }

  return {
    pane,
    open() { const found = captureTarget(); pane.open(); history = []; back.disabled = true; delete results.dataset.word; show(found?.word || ''); },
    /** Up to `limit` synonyms for the word at the caret, for the context menu. */
    async synonymsAt(limit = 6) {
      const found = captureTarget(); if (!found) return null;
      try { data ??= await loadThesaurus(); } catch { return null; }
      const result = lookupWord(data, found.word);
      if (!result) return { word: found.word, synonyms: [] };
      const synonyms = [...new Set(result.senses.flatMap(s => s.synonyms))].slice(0, limit);
      return { word: found.word, synonyms: synonyms.map(w => ({ word: w, text: matchCase(found.word, w) })) };
    },
    insert,
    get loaded() { return !!data; },
    preload() { loadThesaurus().then(d => { data = d; }).catch(() => {}); },
    destroy() { pane.destroy(); },
  };
}
