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
import { cellName, colName, parseKey } from '../core/cell.js';
import { loadPref, savePref } from '../lib/user-prefs.js';
import { thesaurusPrompt, parseThesaurus, replaceInText, lookupWord, posLabel } from '../core/thesaurus.js';
import { t, compareText } from '../i18n/index.js';
import { minOf } from '../core/numeric.js';

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

/** Each language's name as the interface shows it (the list's own names are what the model is asked in). */
const LANGUAGE_LABELS = {
  Arabic: 'languagePane.lang.arabic',
  Bengali: 'languagePane.lang.bengali',
  Bulgarian: 'languagePane.lang.bulgarian',
  Catalan: 'languagePane.lang.catalan',
  'Chinese (Simplified)': 'languagePane.lang.chineseSimplified',
  'Chinese (Traditional)': 'languagePane.lang.chineseTraditional',
  Croatian: 'languagePane.lang.croatian',
  Czech: 'languagePane.lang.czech',
  Danish: 'languagePane.lang.danish',
  Dutch: 'languagePane.lang.dutch',
  English: 'languagePane.lang.english',
  Estonian: 'languagePane.lang.estonian',
  Filipino: 'languagePane.lang.filipino',
  Finnish: 'languagePane.lang.finnish',
  French: 'languagePane.lang.french',
  German: 'languagePane.lang.german',
  Greek: 'languagePane.lang.greek',
  Hebrew: 'languagePane.lang.hebrew',
  Hindi: 'languagePane.lang.hindi',
  Hungarian: 'languagePane.lang.hungarian',
  Icelandic: 'languagePane.lang.icelandic',
  Indonesian: 'languagePane.lang.indonesian',
  Irish: 'languagePane.lang.irish',
  Italian: 'languagePane.lang.italian',
  Japanese: 'languagePane.lang.japanese',
  Korean: 'languagePane.lang.korean',
  Latvian: 'languagePane.lang.latvian',
  Lithuanian: 'languagePane.lang.lithuanian',
  Malay: 'languagePane.lang.malay',
  Norwegian: 'languagePane.lang.norwegian',
  Persian: 'languagePane.lang.persian',
  Polish: 'languagePane.lang.polish',
  Portuguese: 'languagePane.lang.portuguese',
  Romanian: 'languagePane.lang.romanian',
  Russian: 'languagePane.lang.russian',
  Serbian: 'languagePane.lang.serbian',
  Slovak: 'languagePane.lang.slovak',
  Slovenian: 'languagePane.lang.slovenian',
  Spanish: 'languagePane.lang.spanish',
  Swahili: 'languagePane.lang.swahili',
  Swedish: 'languagePane.lang.swedish',
  Tamil: 'languagePane.lang.tamil',
  Thai: 'languagePane.lang.thai',
  Turkish: 'languagePane.lang.turkish',
  Ukrainian: 'languagePane.lang.ukrainian',
  Urdu: 'languagePane.lang.urdu',
  Vietnamese: 'languagePane.lang.vietnamese',
  Welsh: 'languagePane.lang.welsh',
};
const languageLabel = (name) => (Object.hasOwn(LANGUAGE_LABELS, name) ? t(LANGUAGE_LABELS[name]) : name);

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
  const thTab = tab('thesaurus', t('languagePane.thesaurus'), ids.th);
  const trTab = tab('translate', t('languagePane.translator'), ids.tr);
  const tablist = el('div.lang-tabs', { role: 'tablist', 'aria-label': t('languagePane.languageTools') }, thTab, trTab);
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    api.show(mode === 'thesaurus' ? 'translate' : 'thesaurus');
    (mode === 'thesaurus' ? thTab : trTab).focus();
  });
  const close = el('button.icon-btn', { type: 'button', 'aria-label': t('languagePane.closeTools'), title: t('common.close'), html: icon('x', 16), onclick: () => api.hide() });

  /* ---------- Thesaurus ---------- */
  const history = [];
  let current = '';
  const cache = new Map();
  const search = el('input.input', { type: 'search', 'aria-label': t('languagePane.lookUp'), placeholder: t('languagePane.lookUpPlaceholder'), autocomplete: 'off', spellcheck: false });
  const back = el('button.icon-btn', { type: 'button', 'aria-label': t('common.back'), title: t('common.back'), html: icon('back', 16), disabled: true, onclick: () => { history.pop(); const prev = history.pop(); if (prev) lookup(prev); } });
  const thStatus = el('p.small.muted.lang-status', { role: 'status' });
  const results = el('div.thesaurus-results');
  const thForm = el('form.lang-search', { onsubmit: (e) => { e.preventDefault(); lookup(search.value); } },
    back, search, el('button.btn.btn-sm', { type: 'submit' }, t('languagePane.lookUp')));
  const thPanel = el('div.lang-panel', { id: ids.th, role: 'tabpanel', 'aria-labelledby': `${ids.th}-tab` }, thForm, thStatus, results,
    el('p.small.muted.lang-foot', {}, t('languagePane.thesaurusFoot')));

  async function lookup(raw) {
    const word = String(raw || '').trim();
    if (!word) return;
    search.value = word;
    current = word;
    if (history.at(-1) !== word) history.push(word);
    back.disabled = history.length < 2;
    if (!ctx.ai) { thStatus.textContent = t('languagePane.thesaurusNoAi'); results.replaceChildren(); return; }
    let senses = cache.get(word.toLowerCase());
    if (!senses) {
      thStatus.textContent = t('languagePane.lookingUp', { word });
      results.replaceChildren();
      try { senses = parseThesaurus(await ctx.ai(thesaurusPrompt(word))); } catch (e) { if (current === word) thStatus.textContent = e?.message ? t('languagePane.thesaurusFailed', { error: e.message }) : t('languagePane.thesaurusFailedRetry'); return; }
      cache.set(word.toLowerCase(), senses);
    }
    if (current !== word) return; // another lookup started meanwhile
    thStatus.textContent = senses.length ? t('languagePane.meanings', { count: senses.length, word }) : t('languagePane.noSynonyms', { word });
    results.replaceChildren(...senses.map((sense) => el('section.thesaurus-sense', {},
      el('h4', {}, sense.pos ? el('span.thesaurus-pos', {}, posLabel(sense.pos)) : null, sense.meaning || word),
      wordList(sense.synonyms, t('languagePane.synonyms')),
      sense.antonyms.length ? el('div.thesaurus-antonyms', {}, el('span.small.muted', {}, t('languagePane.antonyms')), wordList(sense.antonyms, t('languagePane.antonyms'))) : null)));
  }

  const wordList = (words, label) => el('ul.thesaurus-words', { 'aria-label': label }, ...words.map((w) => el('li', {},
    el('button.thesaurus-word', { type: 'button', title: t('languagePane.lookUpWord', { word: w }), onclick: () => lookup(w) }, w),
    el('button.btn.btn-ghost.btn-xs.thesaurus-insert', { type: 'button', 'aria-label': t('languagePane.insertWord', { word: w }), title: t('languagePane.insertWordTitle', { word: w }), onclick: () => insertWord(w) }, t('common.insert')))));

  function insertWord(word) {
    const sheetId = ctx.sheetId();
    const { r, c } = ctx.active();
    if (wb.lockedAt(sheetId, r, c)) { toast(t('languagePane.cellProtected', { cell: cellName(r, c) }), { icon: 'lock', duration: 2500 }); return; }
    const cell = wb.getCell(sheetId, r, c);
    if (cell?.f != null) { toast(t('languagePane.activeHoldsFormula'), { icon: 'info', duration: 2800 }); return; }
    const text = typeof cell?.v === 'string' ? cell.v : cell?.v == null ? '' : wb.getDisplay(sheetId, r, c);
    const looked = history.find((w) => replaceInText(text, w, word) != null);
    const next = text.trim() ? (looked ? replaceInText(text, looked, word) : null) : word;
    if (next == null) { toast(t('languagePane.doesNotContain', { cell: cellName(r, c), word: current }), { icon: 'info', duration: 2800 }); return; }
    wb.setInput(sheetId, r, c, next, { literal: true, label: t('languagePane.thesaurus'), preserveRichText: true });
    ctx.announce?.(t('languagePane.nowReads', { cell: cellName(r, c), text: next }));
  }

  /* ---------- Translator ---------- */
  const saved = loadPref('translate-languages', null) || {};
  const langOptions = (selected, detect) => [...(detect ? [el('option', { value: '', selected: !selected }, t('languagePane.autoDetect'))] : []),
    ...[...TRANSLATE_LANGUAGES].sort((a, b) => compareText(languageLabel(a), languageLabel(b))).map((l) => el('option', { value: l, selected: l === selected }, languageLabel(l)))];
  const from = el('select.select', { 'aria-label': t('languagePane.from') }, ...langOptions(saved.from || '', true));
  const to = el('select.select', { 'aria-label': t('languagePane.to') }, ...langOptions(saved.to || browserLanguage(), false));
  const swap = el('button.icon-btn', { type: 'button', 'aria-label': t('languagePane.swap'), title: t('languagePane.swap'), html: icon('swap', 16), onclick: () => {
    if (!from.value) return;
    const f = from.value; from.value = to.value; to.value = f; remember();
  } });
  const remember = () => savePref('translate-languages', { from: from.value, to: to.value });
  from.addEventListener('change', remember);
  to.addEventListener('change', remember);
  const source = el('textarea.input.lang-source', { rows: 5, 'aria-label': t('languagePane.textToTranslate'), placeholder: t('languagePane.sourcePlaceholder') });
  const fromCells = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => useSelection() }, t('languagePane.useSelection'));
  const go = el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => translateNow() }, t('languagePane.translate'));
  const trStatus = el('p.small.muted.lang-status', { role: 'status' });
  const output = el('div.lang-output', { role: 'region', 'aria-label': t('languagePane.translation'), tabindex: 0 });
  const insertBtn = el('button.btn.btn-sm', { type: 'button', disabled: true, onclick: () => insertTranslation() }, t('common.insert'));
  const copyBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', disabled: true, onclick: () => copyTranslation() }, t('common.copy'));
  source.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translateNow(); } });
  source.addEventListener('input', () => { picked = null; });
  const trPanel = el('div.lang-panel', { id: ids.tr, role: 'tabpanel', 'aria-labelledby': `${ids.tr}-tab`, hidden: true },
    el('div.lang-pair', {}, el('label.field', {}, el('span.field-label', {}, t('languagePane.from')), from), swap, el('label.field', {}, el('span.field-label', {}, t('languagePane.to')), to)),
    source,
    el('div.row.lang-row', {}, fromCells, el('span.spacer'), go),
    trStatus, output,
    el('div.row.lang-row', {}, copyBtn, el('span.spacer'), insertBtn));

  let picked = null; // { sheetId, cells: [{ r, c, text }] } when the text came from the selection
  let result = null; // { texts: [...], cells: picked } the last translation

  function useSelection() {
    const sheetId = ctx.sheetId();
    const cells = [];
    // Only the cells that hold something are read: a whole column or the whole sheet is cut down to the data.
    const used = wb.usedRange(sheetId);
    const held = wb.sheet(sheetId)?.cells;
    for (const rg of used ? ctx.ranges() : []) {
      const r2 = Math.min(rg.r2, used.r2), c2 = Math.min(rg.c2, used.c2);
      // A range of more addresses than the sheet holds cells (one value far out makes the used range the whole
      // sheet) is read from those cells, in reading order.
      if (held && (r2 - rg.r1 + 1) * (c2 - rg.c1 + 1) > held.size) {
        const inside = [];
        for (const [key, cell] of held) {
          const { r, c } = parseKey(key);
          if (r < rg.r1 || r > r2 || c < rg.c1 || c > c2 || cell?.f != null || typeof cell?.v !== 'string' || !cell.v.trim()) continue;
          inside.push({ r, c, text: cell.v });
        }
        inside.sort((a, b) => a.r - b.r || a.c - b.c);
        cells.push(...inside.slice(0, Math.max(0, MAX_CELLS - cells.length)));
        continue;
      }
      for (let r = rg.r1; r <= r2 && cells.length < MAX_CELLS; r++) {
        for (let c = rg.c1; c <= c2 && cells.length < MAX_CELLS; c++) {
          const cell = wb.getCell(sheetId, r, c);
          if (cell?.f != null || typeof cell?.v !== 'string' || !cell.v.trim()) continue;
          cells.push({ r, c, text: cell.v });
        }
      }
    }
    picked = cells.length ? { sheetId, cells } : null;
    source.value = cells.map((x) => x.text).join('\n');
    trStatus.textContent = cells.length ? t('languagePane.cellsOfText', { count: cells.length, from: rangeLabel(cells) }) : t('languagePane.selectionNoText');
  }
  const rangeLabel = (cells) => (cells.length === 1 ? cellName(cells[0].r, cells[0].c) : `${colName(minOf(cells.map((x) => x.c)))}${minOf(cells.map((x) => x.r)) + 1}…`);

  async function translateNow() {
    // One at a time, as the disabled button says; Ctrl/Cmd+Enter in the box asks too.
    if (go.disabled) return;
    const text = source.value;
    if (!text.trim()) { trStatus.textContent = t('languagePane.typeSomeText'); return; }
    if (!ctx.translate) { trStatus.textContent = t('languagePane.translateNoAi'); return; }
    const pieces = picked ? picked.cells.map((x) => x.text) : [text];
    go.disabled = true;
    trStatus.textContent = t('languagePane.translating');
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
      output.replaceChildren(...result.texts.map((text) => el('p', { dir: 'auto' }, text)));
      trStatus.textContent = picked ? t('languagePane.translatedCells', { language: languageLabel(to.value), count: picked.cells.length }) : t('languagePane.translatedTo', { language: languageLabel(to.value) });
    } catch (e) {
      result = null;
      trStatus.textContent = e?.message ? t('languagePane.translateFailed', { error: e.message }) : t('languagePane.translateFailedRetry');
    } finally {
      go.disabled = false;
      insertBtn.disabled = copyBtn.disabled = !result;
      insertBtn.textContent = result?.cells ? t('languagePane.replaceCells') : t('common.insert');
      insertBtn.title = result?.cells ? t('languagePane.replaceCellsTitle') : t('languagePane.insertTitle');
    }
  }

  function insertTranslation() {
    if (!result) return;
    if (result.cells) {
      const { sheetId, cells } = result.cells;
      const locked = cells.filter(({ r, c }) => wb.lockedAt(sheetId, r, c));
      if (locked.length) { toast(t('languagePane.protectedNothingReplaced', { cell: cellName(locked[0].r, locked[0].c) }), { icon: 'lock', duration: 3000 }); return; }
      // The cells are known by where their text was read: one that no longer holds it (typed over, or moved by rows
      // or columns inserted or deleted since) would lose what it holds now to another cell's translation.
      const moved = cells.find(({ r, c, text }) => { const cell = wb.getCell(sheetId, r, c); return cell?.f != null || cell?.v !== text; });
      if (moved) { toast(t('languagePane.changedSinceTranslated', { cell: cellName(moved.r, moved.c) }), { icon: 'info', duration: 3600 }); return; }
      wb.transaction(t('languagePane.translate'), () => cells.forEach(({ r, c }, i) => wb.setInput(sheetId, r, c, result.texts[i], { literal: true, label: t('languagePane.translate') })));
      ctx.announce?.(t('languagePane.replacedCells', { count: cells.length }));
      return;
    }
    const sheetId = ctx.sheetId();
    const { r, c } = ctx.active();
    if (wb.lockedAt(sheetId, r, c)) { toast(t('languagePane.cellProtected', { cell: cellName(r, c) }), { icon: 'lock', duration: 2500 }); return; }
    wb.setInput(sheetId, r, c, result.texts.join('\n'), { literal: true, label: t('languagePane.translate') });
    ctx.announce?.(t('languagePane.putInto', { cell: cellName(r, c) }));
  }

  async function copyTranslation() {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.texts.join('\n')); toast(t('languagePane.copied'), { icon: 'copy', duration: 1600 }); } catch { toast(t('languagePane.copyFailed'), { icon: 'info', duration: 2500 }); }
  }

  const root = el('section.lang-pane', { role: 'region', 'aria-label': t('languagePane.languageTools'), hidden: true },
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
