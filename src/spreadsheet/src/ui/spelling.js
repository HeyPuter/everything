/**
 * Review ▸ Spelling (F7): the text cells of the selection, or of the whole sheet from the active cell round
 * to it again, checked word by word. Each word not in the dictionary is shown in its sentence with the
 * nearest words the dictionary has; it can be changed (here, or everywhere it comes), left (once, or for the
 * rest of the session), added to the person's own dictionary, or added to AutoCorrect with its fix.
 * Every change is an undo step of its own (Change All one for all its cells).
 */
import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import * as S from '../core/selection.js';
import { loadPref, savePref } from '../lib/user-prefs.js';
import { LANGUAGES, DEFAULT_SPELLING_OPTIONS, loadWordList, createSpeller, wordsIn, textCellsInOrder, replaceWord } from '../core/spelling.js';
import { autoCorrectSettings, saveAutoCorrectSettings } from './autocorrect.js';

/** The person's own dictionary: words added with Add to Dictionary. */
export const customWords = () => { const v = loadPref('dictionary', []); return Array.isArray(v) ? v.filter((w) => typeof w === 'string') : []; };
export const saveCustomWords = (words) => savePref('dictionary', [...new Set(words.map((w) => String(w).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, 5000));
const spellingLanguage = () => { const v = loadPref('spelling-language', null); return LANGUAGES.some((l) => l.code === v) ? v : (/^en-(GB|IE|AU|NZ|ZA|IN)\b/i.test(globalThis.navigator?.language || '') ? 'en-GB' : 'en-US'); };
const spellingOptions = () => ({ ...DEFAULT_SPELLING_OPTIONS, ...(loadPref('spelling-options', null) || {}) });

/** Words left alone with Ignore All, for the rest of this session (across sheets and runs of the check). */
const ignoredAll = new Set();

export async function openSpellingDialog(ctx, { language = spellingLanguage() } = {}) {
  const wb = ctx.wb;
  const sheetId = ctx.sheetId();
  const ranges = ctx.ranges();
  const several = ranges.length > 1 || ranges.some((rg) => rg.r1 !== rg.r2 || rg.c1 !== rg.c2);
  const scope = several ? ranges : null;
  const start = ctx.active();
  let options = spellingOptions();
  let list = await loadWordList(language);
  let speller = createSpeller(list, { custom: customWords() });
  const cells = textCellsInOrder(wb, sheetId, { ranges: scope, from: several ? null : start });
  const state = { index: 0, offset: 0, current: null };
  const ignoredOnce = new Set(); // "r,c,start,word" of the words passed over once

  /** The next word not in the dictionary from where the check stands, or null at the end. */
  function next() {
    for (; state.index < cells.length; state.index++, state.offset = 0) {
      const [r, c] = cells[state.index];
      const cell = wb.getCell(sheetId, r, c);
      if (cell?.f != null || typeof cell?.v !== 'string') continue;
      for (const w of wordsIn(cell.v, options)) {
        if (w.start < state.offset) continue;
        if (ignoredAll.has(w.word.toLowerCase()) || ignoredOnce.has(`${r},${c},${w.start},${w.word}`)) continue;
        if (speller.check(w.word)) continue;
        return { r, c, text: cell.v, ...w };
      }
    }
    return null;
  }

  // The dialog.
  const sentence = el('div.spell-sentence', { role: 'textbox', 'aria-readonly': 'true', 'aria-label': 'Not in dictionary', tabindex: 0 });
  const where = el('span.small.muted.spell-where');
  const changeTo = el('input.input', { type: 'text', 'aria-label': 'Change to', autocomplete: 'off', spellcheck: false });
  const listId = fieldId('spell-suggestions');
  const suggestions = el('div.spell-suggestions', { id: listId, role: 'listbox', 'aria-label': 'Suggestions', tabindex: 0 });
  const langSelect = el('select.select', { 'aria-label': 'Dictionary language' }, ...LANGUAGES.map((l) => el('option', { value: l.code, selected: l.code === language }, l.label)));
  const button = (label, onclick, extra = {}) => el('button.btn.btn-sm', { type: 'button', onclick, ...extra }, label);
  const ignoreOnceBtn = button('Ignore Once', () => { const w = state.current; if (!w) return; ignoredOnce.add(`${w.r},${w.c},${w.start},${w.word}`); advance(); });
  const ignoreAllBtn = button('Ignore All', () => { const w = state.current; if (!w) return; ignoredAll.add(w.word.toLowerCase()); advance(); });
  const addBtn = button('Add to Dictionary', () => {
    const w = state.current; if (!w) return;
    saveCustomWords([...customWords(), w.word]);
    speller = createSpeller(list, { custom: customWords() });
    advance();
  });
  const changeBtn = button('Change', () => change(false), { className: 'btn btn-sm btn-primary' });
  const changeAllBtn = button('Change All', () => change(true));
  const autoCorrectBtn = button('AutoCorrect', () => {
    const w = state.current; const to = changeTo.value.trim(); if (!w || !to || to === w.word || /\s/.test(w.word)) return;
    const settings = autoCorrectSettings();
    saveAutoCorrectSettings({ ...settings, replacements: [...settings.replacements.filter((e) => e.from !== w.word), { from: w.word, to }] });
    ctx.announce?.(`AutoCorrect will change ${w.word} to ${to} from now on`);
    change(false);
  }, { title: 'Change the word and add the pair to AutoCorrect, so it is fixed as you type from now on' });
  const status = el('p.small.spell-status', { role: 'status' });
  const optionBoxes = {
    ignoreUppercase: el('input', { type: 'checkbox', checked: options.ignoreUppercase }),
    ignoreNumbers: el('input', { type: 'checkbox', checked: options.ignoreNumbers }),
    ignoreAddresses: el('input', { type: 'checkbox', checked: options.ignoreAddresses }),
  };
  for (const [key, box] of Object.entries(optionBoxes)) {
    box.addEventListener('change', () => { options = { ...options, [key]: box.checked }; savePref('spelling-options', options); state.offset = Math.min(state.offset, state.current?.start ?? state.offset); show(next()); });
  }
  const dictionaryBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => openCustomDictionary(() => { speller = createSpeller(list, { custom: customWords() }); show(next()); }) }, 'Custom dictionary…');
  langSelect.addEventListener('change', async () => {
    language = langSelect.value;
    savePref('spelling-language', language);
    list = await loadWordList(language);
    speller = createSpeller(list, { custom: customWords() });
    if (state.current) state.offset = state.current.start;
    show(next());
  });
  changeTo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); change(false); } });
  changeTo.addEventListener('input', () => refreshButtons());

  const actions = el('div.spell-actions', {},
    el('div.spell-action-pair', {}, ignoreOnceBtn, ignoreAllBtn), addBtn,
    el('div.spell-action-pair', {}, changeBtn, changeAllBtn), autoCorrectBtn);
  const content = el('div.spell-dialog', {},
    el('div.spell-head', {}, el('span.field-label', {}, 'Not in dictionary'), where),
    sentence,
    el('div.spell-main', {},
      el('div.spell-left', {},
        el('label.field', {}, el('span.field-label', {}, 'Change to'), changeTo),
        el('span.field-label', { id: `${listId}-label` }, 'Suggestions'), suggestions),
      actions),
    el('div.spell-foot', {},
      el('label.field.spell-lang', {}, el('span.field-label', {}, 'Dictionary language'), langSelect),
      el('details.spell-options', {}, el('summary', {}, 'Options'),
        el('label.check', {}, optionBoxes.ignoreUppercase, el('span', {}, 'Ignore words in UPPERCASE')),
        el('label.check', {}, optionBoxes.ignoreNumbers, el('span', {}, 'Ignore words with numbers')),
        el('label.check', {}, optionBoxes.ignoreAddresses, el('span', {}, 'Ignore web, email and file addresses')),
        dictionaryBtn)),
    status,
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Close')));
  suggestions.setAttribute('aria-labelledby', `${listId}-label`);
  suggestions.addEventListener('keydown', (e) => {
    const rows = [...suggestions.children].filter((n) => n.getAttribute('role') === 'option');
    if (!rows.length) return;
    let at = rows.findIndex((n) => n.getAttribute('aria-selected') === 'true');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))); pick(rows[at].dataset.word); }
    else if (e.key === 'Enter') { e.preventDefault(); change(false); }
  });

  function pick(word) {
    changeTo.value = word;
    for (const n of suggestions.children) n.setAttribute('aria-selected', String(n.dataset.word === word));
    suggestions.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    refreshButtons();
  }

  function refreshButtons() {
    const w = state.current;
    for (const b of [ignoreOnceBtn, ignoreAllBtn, addBtn]) b.disabled = !w;
    const to = changeTo.value;
    changeBtn.disabled = changeAllBtn.disabled = !w || !to.trim() || to === w.word;
    autoCorrectBtn.disabled = changeBtn.disabled || /\s/.test(w?.word || ' ');
  }

  function show(w) {
    state.current = w;
    if (!w) {
      sentence.replaceChildren(el('span.muted', {}, 'Nothing left to check.'));
      where.textContent = '';
      suggestions.replaceChildren();
      changeTo.value = '';
      changeTo.disabled = true;
      status.textContent = `The spelling check is complete for ${scope ? 'the selection' : 'the sheet'}.`;
      refreshButtons();
      modal?.panel?.querySelector('.row-end .btn')?.focus();
      return;
    }
    changeTo.disabled = false;
    state.offset = w.start;
    sentence.replaceChildren(w.text.slice(0, w.start), el('mark.spell-word', {}, w.word), w.text.slice(w.end));
    where.textContent = `${wb.sheet(sheetId)?.name}!${cellName(w.r, w.c)}`;
    const found = speller.suggest(w.word);
    suggestions.replaceChildren(...(found.length ? found.map((word) => el('div.spell-suggestion', {
      role: 'option', 'aria-selected': 'false', dataset: { word }, onclick: () => pick(word), ondblclick: () => { pick(word); change(false); },
    }, word)) : [el('div.spell-none.muted', {}, '(No suggestions)')]));
    changeTo.value = found[0] || w.word;
    if (found[0]) pick(found[0]);
    status.textContent = '';
    refreshButtons();
    ctx.grid?.setSelection?.(S.single(w.r, w.c), { scroll: true });
  }

  function advance() {
    const w = state.current;
    if (w) state.offset = w.end;
    show(next());
  }

  function change(all) {
    const w = state.current;
    const to = changeTo.value;
    if (!w || !to.trim() || to === w.word) return;
    if (wb.lockedAt(sheetId, w.r, w.c)) { status.textContent = `${cellName(w.r, w.c)} is protected; its text was left as it is.`; advance(); return; }
    if (!all) {
      wb.setInput(sheetId, w.r, w.c, replaceWord(w.text, w.start, w.end, to), { literal: true, label: 'Spelling', preserveRichText: true });
      state.offset = w.start + to.length;
    } else {
      // Every cell in the check holding the word, in one step.
      wb.transaction('Spelling', () => {
        for (const [r, c] of cells) {
          const cell = wb.getCell(sheetId, r, c);
          if (cell?.f != null || typeof cell?.v !== 'string' || wb.lockedAt(sheetId, r, c)) continue;
          let text = cell.v;
          for (const hit of wordsIn(text, options).filter((x) => x.word === w.word).reverse()) text = replaceWord(text, hit.start, hit.end, to);
          if (text !== cell.v) wb.setInput(sheetId, r, c, text, { literal: true, label: 'Spelling', preserveRichText: true });
        }
      });
      ignoredAll.add(w.word.toLowerCase()); // what is left of it (in a protected cell) is not asked about again
      state.offset = w.start + to.length;
    }
    show(next());
  }

  const modal = openModal({ title: 'Spelling', content, wide: true, initialFocus: changeTo, onClose: () => ctx.grid?.focus?.() });
  show(next());
  if (!cells.length) status.textContent = `There is no text to check in ${scope ? 'the selection' : 'this sheet'}.`;
  return modal;
}

/** The words added to the person's dictionary, one per line, to look over or remove. */
export function openCustomDictionary(onSaved = null) {
  const area = el('textarea.input.spell-custom', { rows: 12, 'aria-label': 'Custom dictionary words', spellcheck: false, value: customWords().join('\n') });
  const content = el('form', { onsubmit: (e) => { e.preventDefault(); saveCustomWords(area.value.split('\n')); modal.close(); onSaved?.(); toast('Custom dictionary saved', { icon: 'spell', duration: 1800 }); } },
    el('p.small.muted.modal-text', {}, 'Words here are never marked as misspelled. One word per line.'),
    area,
    el('div.row.row-end', { style: { marginTop: '12px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  const modal = openModal({ title: 'Custom dictionary', content, initialFocus: area });
  return modal;
}
