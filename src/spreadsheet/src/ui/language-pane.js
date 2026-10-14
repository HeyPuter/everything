/**
 * Review ▸ Thesaurus (Shift+F7) and Review ▸ Translate: one pane beside the sheet with a tab for each, both
 * answered by Puter's AI.
 *
 * The thesaurus looks up the active cell's word (or one typed in), lists its senses with their synonyms and
 * antonyms, looks up any of those with a click, and puts one into the active cell in place of the word.
 * The translator takes text typed in or the selected cells, translates it as TRANSLATE() does, and puts the
 * result into the active cell, or back into the cells it came from, one undo step.
 */
import { el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { cellName, colName } from '../core/cell.js';
import { loadPref, savePref } from '../lib/user-prefs.js';
import { thesaurusPrompt, parseThesaurus, replaceInText, lookupWord } from '../core/thesaurus.js';

/** The languages the translator offers, by the names the model is asked in. */
export const TRANSLATE_LANGUAGES = ['Arabic', 'Bengali', 'Bulgarian', 'Catalan', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Croatian', 'Czech', 'Danish',
  'Dutch', 'English', 'Estonian', 'Filipino', 'Finnish', 'French', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Icelandic', 'Indonesian', 'Irish',
  'Italian', 'Japanese', 'Korean', 'Latvian', 'Lithuanian', 'Malay', 'Norwegian', 'Persian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Serbian',
  'Slovak', 'Slovenian', 'Spanish', 'Swahili', 'Swedish', 'Tamil', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese', 'Welsh'];

/** The language this browser is set to, as one of TRANSLATE_LANGUAGES (English when it is none of them). */
function browserLanguage() {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of((globalThis.navigator?.language || 'en').split('-')[0]);
    return TRANSLATE_LANGUAGES.find((l) => l === name) || 'English';
  } catch { return 'English'; }
}

const MAX_CELLS = 200;

/**
 * `ctx` is the editor's context plus `ai` (prompt → Promise<text>, or null without Puter's AI) and `translate`
 * ((text, from, to) → Promise<text>).
 */
export function createLanguagePane(ctx) {
  const wb = ctx.wb;
  let mode = 'thesaurus';
  const ids = { th: fieldId('lang-thesaurus'), tr: fieldId('lang-translate') };
  const tab = (key, label, panelId) => el('button.lang-tab', { type: 'button', role: 'tab', id: `${panelId}-tab`, 'aria-controls': panelId, onclick: () => api.show(key) }, label);
  const thTab = tab('thesaurus', 'Thesaurus', ids.th);
  const trTab = tab('translate', 'Translator', ids.tr);
  const tablist = el('div.lang-tabs', { role: 'tablist', 'aria-label': 'Language tools' }, thTab, trTab);
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    api.show(mode === 'thesaurus' ? 'translate' : 'thesaurus');
    (mode === 'thesaurus' ? thTab : trTab).focus();
  });
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close language tools', title: 'Close', html: icon('x', 16), onclick: () => api.hide() });

  /* ---------- Thesaurus ---------- */
  const history = [];
  let current = '';
  const cache = new Map();
  const search = el('input.input', { type: 'search', 'aria-label': 'Look up', placeholder: 'Word to look up', autocomplete: 'off', spellcheck: false });
  const back = el('button.icon-btn', { type: 'button', 'aria-label': 'Back', title: 'Back', html: icon('back', 16), disabled: true, onclick: () => { history.pop(); const prev = history.pop(); if (prev) lookup(prev); } });
  const thStatus = el('p.small.muted.lang-status', { role: 'status' });
  const results = el('div.thesaurus-results');
  const thForm = el('form.lang-search', { onsubmit: (e) => { e.preventDefault(); lookup(search.value); } },
    back, search, el('button.btn.btn-sm', { type: 'submit' }, 'Look up'));
  const thPanel = el('div.lang-panel', { id: ids.th, role: 'tabpanel', 'aria-labelledby': `${ids.th}-tab` }, thForm, thStatus, results,
    el('p.small.muted.lang-foot', {}, 'Click a word to look it up; Insert puts it into the active cell in place of the word.'));

  async function lookup(raw) {
    const word = String(raw || '').trim();
    if (!word) return;
    search.value = word;
    current = word;
    if (history.at(-1) !== word) history.push(word);
    back.disabled = history.length < 2;
    if (!ctx.ai) { thStatus.textContent = 'The thesaurus needs Puter’s AI, which is not available here.'; results.replaceChildren(); return; }
    let senses = cache.get(word.toLowerCase());
    if (!senses) {
      thStatus.textContent = `Looking up “${word}”…`;
      results.replaceChildren();
      try { senses = parseThesaurus(await ctx.ai(thesaurusPrompt(word))); } catch (e) { if (current === word) thStatus.textContent = `The thesaurus could not answer: ${e?.message || 'try again'}`; return; }
      cache.set(word.toLowerCase(), senses);
    }
    if (current !== word) return; // another lookup started meanwhile
    thStatus.textContent = senses.length ? `${senses.length} meaning${senses.length === 1 ? '' : 's'} of “${word}”` : `No synonyms found for “${word}”.`;
    results.replaceChildren(...senses.map((sense) => el('section.thesaurus-sense', {},
      el('h4', {}, sense.pos ? el('span.thesaurus-pos', {}, sense.pos) : null, sense.meaning || word),
      wordList(sense.synonyms, 'Synonyms'),
      sense.antonyms.length ? el('div.thesaurus-antonyms', {}, el('span.small.muted', {}, 'Antonyms'), wordList(sense.antonyms, 'Antonyms')) : null)));
  }

  const wordList = (words, label) => el('ul.thesaurus-words', { 'aria-label': label }, ...words.map((w) => el('li', {},
    el('button.thesaurus-word', { type: 'button', title: `Look up ${w}`, onclick: () => lookup(w) }, w),
    el('button.btn.btn-ghost.btn-xs.thesaurus-insert', { type: 'button', 'aria-label': `Insert ${w}`, title: `Put ${w} into the active cell`, onclick: () => insertWord(w) }, 'Insert'))));

  function insertWord(word) {
    const sheetId = ctx.sheetId();
    const { r, c } = ctx.active();
    if (wb.lockedAt(sheetId, r, c)) { toast(`${cellName(r, c)} is protected`, { icon: 'lock', duration: 2500 }); return; }
    const cell = wb.getCell(sheetId, r, c);
    if (cell?.f != null) { toast('The active cell holds a formula; pick a cell with text', { icon: 'info', duration: 2800 }); return; }
    const text = typeof cell?.v === 'string' ? cell.v : cell?.v == null ? '' : wb.getDisplay(sheetId, r, c);
    const looked = history.find((w) => replaceInText(text, w, word) != null);
    const next = text.trim() ? (looked ? replaceInText(text, looked, word) : null) : word;
    if (next == null) { toast(`${cellName(r, c)} does not contain “${current}”`, { icon: 'info', duration: 2800 }); return; }
    wb.setInput(sheetId, r, c, next, { literal: true, label: 'Thesaurus', preserveRichText: true });
    ctx.announce?.(`${cellName(r, c)} now reads ${next}`);
  }

  /* ---------- Translator ---------- */
  const saved = loadPref('translate-languages', null) || {};
  const langOptions = (selected, detect) => [...(detect ? [el('option', { value: '', selected: !selected }, 'Auto-detect')] : []),
    ...TRANSLATE_LANGUAGES.map((l) => el('option', { value: l, selected: l === selected }, l))];
  const from = el('select.select', { 'aria-label': 'From' }, ...langOptions(saved.from || '', true));
  const to = el('select.select', { 'aria-label': 'To' }, ...langOptions(saved.to || browserLanguage(), false));
  const swap = el('button.icon-btn', { type: 'button', 'aria-label': 'Swap languages', title: 'Swap languages', html: icon('swap', 16), onclick: () => {
    if (!from.value) return;
    const f = from.value; from.value = to.value; to.value = f; remember();
  } });
  const remember = () => savePref('translate-languages', { from: from.value, to: to.value });
  from.addEventListener('change', remember);
  to.addEventListener('change', remember);
  const source = el('textarea.input.lang-source', { rows: 5, 'aria-label': 'Text to translate', placeholder: 'Type text, or use the selected cells' });
  const fromCells = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => useSelection() }, 'Use selection');
  const go = el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => translateNow() }, 'Translate');
  const trStatus = el('p.small.muted.lang-status', { role: 'status' });
  const output = el('div.lang-output', { role: 'region', 'aria-label': 'Translation', tabindex: 0 });
  const insertBtn = el('button.btn.btn-sm', { type: 'button', disabled: true, onclick: () => insertTranslation() }, 'Insert');
  const copyBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: true, onclick: () => copyTranslation() }, 'Copy');
  source.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translateNow(); } });
  source.addEventListener('input', () => { picked = null; });
  const trPanel = el('div.lang-panel', { id: ids.tr, role: 'tabpanel', 'aria-labelledby': `${ids.tr}-tab`, hidden: true },
    el('div.lang-pair', {}, el('label.field', {}, el('span.field-label', {}, 'From'), from), swap, el('label.field', {}, el('span.field-label', {}, 'To'), to)),
    source,
    el('div.row.lang-row', {}, fromCells, el('span.spacer'), go),
    trStatus, output,
    el('div.row.lang-row', {}, copyBtn, el('span.spacer'), insertBtn));

  let picked = null; // { sheetId, cells: [{ r, c, text }] } when the text came from the selection
  let result = null; // { texts: [...], cells: picked } the last translation

  function useSelection() {
    const sheetId = ctx.sheetId();
    const cells = [];
    for (const rg of ctx.ranges()) {
      for (let r = rg.r1; r <= rg.r2 && cells.length < MAX_CELLS; r++) {
        for (let c = rg.c1; c <= rg.c2 && cells.length < MAX_CELLS; c++) {
          const cell = wb.getCell(sheetId, r, c);
          if (cell?.f != null || typeof cell?.v !== 'string' || !cell.v.trim()) continue;
          cells.push({ r, c, text: cell.v });
        }
      }
    }
    picked = cells.length ? { sheetId, cells } : null;
    source.value = cells.map((x) => x.text).join('\n');
    trStatus.textContent = cells.length ? `${cells.length} cell${cells.length === 1 ? '' : 's'} of text from ${rangeLabel(cells)}` : 'The selection holds no text to translate.';
  }
  const rangeLabel = (cells) => (cells.length === 1 ? cellName(cells[0].r, cells[0].c) : `${colName(Math.min(...cells.map((x) => x.c)))}${Math.min(...cells.map((x) => x.r)) + 1}…`);

  async function translateNow() {
    const text = source.value;
    if (!text.trim()) { trStatus.textContent = 'Type some text, or use the selected cells.'; return; }
    if (!ctx.translate) { trStatus.textContent = 'Translation needs Puter’s AI, which is not available here.'; return; }
    const pieces = picked ? picked.cells.map((x) => x.text) : [text];
    go.disabled = true;
    trStatus.textContent = 'Translating…';
    output.replaceChildren();
    try {
      // One request per distinct piece, a few at a time, as the TRANSLATE function asks.
      const distinct = [...new Set(pieces)];
      const answers = new Map();
      let at = 0;
      await Promise.all(Array.from({ length: Math.min(4, distinct.length) }, async () => {
        while (at < distinct.length) { const piece = distinct[at++]; answers.set(piece, await ctx.translate(piece, from.value, to.value)); }
      }));
      result = { texts: pieces.map((p) => answers.get(p)), cells: picked };
      output.replaceChildren(...result.texts.map((t) => el('p', { dir: 'auto' }, t)));
      trStatus.textContent = `Translated to ${to.value}${picked ? ` (${picked.cells.length} cell${picked.cells.length === 1 ? '' : 's'})` : ''}.`;
    } catch (e) {
      result = null;
      trStatus.textContent = `The translation failed: ${e?.message || 'try again'}`;
    } finally {
      go.disabled = false;
      insertBtn.disabled = copyBtn.disabled = !result;
      insertBtn.textContent = result?.cells ? 'Replace cells' : 'Insert';
      insertBtn.title = result?.cells ? 'Put each translation into the cell its text came from' : 'Put the translation into the active cell';
    }
  }

  function insertTranslation() {
    if (!result) return;
    if (result.cells) {
      const { sheetId, cells } = result.cells;
      const locked = cells.filter(({ r, c }) => wb.lockedAt(sheetId, r, c));
      if (locked.length) { toast(`${cellName(locked[0].r, locked[0].c)} is protected; nothing was replaced`, { icon: 'lock', duration: 3000 }); return; }
      wb.transaction('Translate', () => cells.forEach(({ r, c }, i) => wb.setInput(sheetId, r, c, result.texts[i], { literal: true, label: 'Translate' })));
      ctx.announce?.(`Replaced ${cells.length} cell${cells.length === 1 ? '' : 's'} with the translation`);
      return;
    }
    const sheetId = ctx.sheetId();
    const { r, c } = ctx.active();
    if (wb.lockedAt(sheetId, r, c)) { toast(`${cellName(r, c)} is protected`, { icon: 'lock', duration: 2500 }); return; }
    wb.setInput(sheetId, r, c, result.texts.join('\n'), { literal: true, label: 'Translate' });
    ctx.announce?.(`Put the translation into ${cellName(r, c)}`);
  }

  async function copyTranslation() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.texts.join('\n')); toast('Translation copied', { icon: 'copy', duration: 1600 }); } catch { toast('Copy did not work here; select the text instead', { icon: 'info', duration: 2500 }); }
  }

  const root = el('section.lang-pane', { role: 'region', 'aria-label': 'Language tools', hidden: true },
    el('div.lang-head', {}, tablist, close),
    el('div.lang-body', {}, thPanel, trPanel));

  const activeText = () => {
    const cell = ctx.activeCell?.();
    return cell?.f == null && typeof cell?.v === 'string' ? cell.v : '';
  };

  const api = {
    el: root,
    get open() { return !root.hidden; },
    get mode() { return mode; },
    /** Open on a tab: the thesaurus looks up the active cell's word, the translator takes the selection's text. */
    show(next = mode, { fromCell = false } = {}) {
      mode = next;
      root.hidden = false;
      thPanel.hidden = mode !== 'thesaurus';
      trPanel.hidden = mode !== 'translate';
      thTab.setAttribute('aria-selected', String(mode === 'thesaurus'));
      trTab.setAttribute('aria-selected', String(mode === 'translate'));
      thTab.tabIndex = mode === 'thesaurus' ? 0 : -1;
      trTab.tabIndex = mode === 'translate' ? 0 : -1;
      if (fromCell && mode === 'thesaurus') {
        const word = lookupWord(activeText());
        if (word) lookup(word); else search.focus();
      }
      if (fromCell && mode === 'translate') {
        useSelection();
        if (source.value.trim()) translateNow(); else source.focus();
      }
    },
    hide() { root.hidden = true; ctx.grid?.focus?.(); },
    lookup,
    translateNow,
    destroy() { root.remove(); },
  };
  return api;
}
