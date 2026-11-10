/**
 * AutoCorrect in the editor: the corrector the cell editor and the formula bar call as words are typed, the
 * settings kept for the person (see lib/user-prefs.js), and the Tools ▸ AutoCorrect Options dialog.
 *
 * A word corrected while the entry is open can be put back as typed with Ctrl/Cmd+Z straight away; a last
 * word corrected as the entry is committed is written as an undo step of its own after the entry, so the
 * first Ctrl/Cmd+Z after Enter brings back what was typed and the second takes the entry away.
 */
import { el, fieldId, MOD_KEY, isComposing } from './dom.js';
import { openModal } from './modal.js';
import { loadPref, savePref, syncPref } from '../lib/user-prefs.js';
import { t } from '../i18n/index.js';
import { normalizeAutoCorrect, correctBeforeCaret, correctWord, isWordEnd, isFormulaText, DEFAULT_AUTOCORRECT } from '../core/autocorrect.js';

const PREF = 'autocorrect';
let current = null;

/** The person's AutoCorrect settings. */
export function autoCorrectSettings() {
  current ??= normalizeAutoCorrect(loadPref(PREF, null));
  return current;
}

export function saveAutoCorrectSettings(next) {
  current = normalizeAutoCorrect(next);
  savePref(PREF, current);
  return current;
}

/** Bring in the copy kept with the account (another device may have changed it). */
export async function syncAutoCorrectSettings() {
  const value = await syncPref(PREF, null);
  if (value) current = normalizeAutoCorrect(value);
  return autoCorrectSettings();
}

/** Forget the settings read (the account changed, or a test wants a fresh start). */
export function resetAutoCorrectCache() { current = null; }

/**
 * The corrector for one editor view. `input(el, data)` runs after text was typed into `el` (the data typed):
 * a word just ended is corrected in place. `undo(el)` puts the last correction back when nothing was typed
 * since (true when it did). `tail(text)` is the entry's last word corrected, or the text as it was.
 */
export function createAutoCorrector({ settings = autoCorrectSettings, announce = null } = {}) {
  let last = null; // { el, before, beforeCaret, after, afterCaret, correction }
  let kept = []; // corrections put back in this entry: the commit leaves those words as typed
  return {
    input(input, data) {
      if (!isWordEnd(data)) { last = null; return false; }
      const caret = input.selectionStart;
      if (caret == null || caret !== input.selectionEnd) return false;
      const before = input.value;
      const res = correctBeforeCaret(before, caret, settings());
      if (!res || kept.some((k) => k.from === res.correction.from && k.start === res.correction.start)) { last = null; return false; }
      input.value = res.text;
      input.setSelectionRange(res.caret, res.caret);
      last = { el: input, before, beforeCaret: caret, after: res.text, afterCaret: res.caret, correction: res.correction };
      announce?.(t('autocorrect.corrected', { from: res.correction.from, to: res.correction.to, key: MOD_KEY }));
      return true;
    },
    undo(input) {
      if (!last || last.el !== input || input.value !== last.after || input.selectionStart !== last.afterCaret) return false;
      input.value = last.before;
      input.setSelectionRange(last.beforeCaret, last.beforeCaret);
      kept.push({ from: last.correction.from, start: last.correction.start });
      announce?.(t('autocorrect.kept', { word: last.correction.from }));
      last = null;
      return true;
    },
    tail(text) {
      const settingsNow = settings();
      const end = String(text).replace(/\s+$/, '').length;
      const correction = correctWord(text, end, settingsNow);
      const skip = !correction || kept.some((k) => k.from === correction.from && k.start === correction.start);
      return skip ? text : String(text).slice(0, correction.start) + correction.to + String(text).slice(correction.end);
    },
    /** A new entry: the corrections remembered for the last one no longer apply. */
    reset() { last = null; kept = []; },
    isFormulaText,
  };
}

/** Tools ▸ AutoCorrect Options. `onSaved(settings)` runs after OK. */
export function openAutoCorrectDialog({ onSaved = null, onClose = null } = {}) {
  const draft = structuredClone(autoCorrectSettings());
  const options = [
    ['twoInitialCaps', t('autocorrect.option.twoInitialCaps')],
    ['sentenceCaps', t('autocorrect.option.sentenceCaps')],
    ['dayNames', t('autocorrect.option.dayNames')],
    ['capsLock', t('autocorrect.option.capsLock')],
    ['replaceText', t('autocorrect.option.replaceText')],
    ['mathSymbols', t('autocorrect.option.mathSymbols')],
  ];
  const boxes = Object.fromEntries(options.map(([key]) => [key, el('input', { type: 'checkbox', checked: draft[key] })]));
  const checks = el('fieldset.check-group.vertical.autocorrect-options', {},
    el('legend.field-label', {}, t('autocorrect.whileTyping')),
    ...options.map(([key, label]) => el('label.check', {}, boxes[key], el('span', {}, label))));

  // The replacement list: the two fields pick an entry as they are typed, and Add (or Replace) and Delete act on it.
  const fromInput = el('input.input', { type: 'text', 'aria-label': t('common.replace'), autocomplete: 'off', spellcheck: false, maxlength: 64 });
  const toInput = el('input.input', { type: 'text', 'aria-label': t('autocorrect.with'), autocomplete: 'off', spellcheck: false, maxlength: 255 });
  const addBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => addEntry() }, t('common.add'));
  const delBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => deleteEntry() }, t('common.delete'));
  const listId = fieldId('autocorrect-list');
  const list = el('div.autocorrect-list', { id: listId, role: 'listbox', 'aria-label': t('autocorrect.replacements'), tabindex: 0 });
  const count = el('span.small.muted', { role: 'status' });
  const exceptionsBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => openExceptions() }, t('autocorrect.exceptionsButton'));
  const resetBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { draft.replacements = DEFAULT_AUTOCORRECT.replacements.map((e) => ({ ...e })); render(); } }, t('autocorrect.restore'));

  const match = () => draft.replacements.findIndex((e) => e.from === fromInput.value.trim());
  // The entries beginning with what was typed in Replace come first. Only typing sets it: an entry picked from
  // the list (with the arrows, say) jumped to the top, and the next Down went back to the one before it.
  let typed = '';
  function render() {
    const q = typed;
    const sorted = draft.replacements.map((e, i) => ({ ...e, i })).sort((a, b) => a.from.localeCompare(b.from));
    const shown = q ? sorted.filter((e) => e.from.toLowerCase().startsWith(q)).concat(sorted.filter((e) => !e.from.toLowerCase().startsWith(q))) : sorted;
    const exact = match();
    list.replaceChildren(...shown.map((e) => el('div.autocorrect-row', {
      role: 'option', 'aria-selected': String(e.i === exact), dataset: { index: e.i },
      onclick: () => { fromInput.value = e.from; toInput.value = e.to; render(); },
    }, el('span.autocorrect-from', { dir: 'auto' }, e.from), el('span.autocorrect-arrow', { 'aria-hidden': 'true' }, '→'), el('span.autocorrect-to', { dir: 'auto' }, e.to))));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    addBtn.textContent = exact >= 0 ? t('common.replace') : t('common.add');
    addBtn.disabled = !fromInput.value.trim() || /\s/.test(fromInput.value.trim()) || (exact >= 0 && draft.replacements[exact].to === toInput.value);
    delBtn.disabled = exact < 0;
    count.textContent = t('autocorrect.count', { count: draft.replacements.length });
  }
  function addEntry() {
    const from = fromInput.value.trim();
    if (!from || /\s/.test(from)) return;
    const i = match();
    if (i >= 0) draft.replacements[i] = { from, to: toInput.value }; else draft.replacements.push({ from, to: toInput.value });
    render();
    fromInput.focus();
  }
  function deleteEntry() {
    const i = match();
    if (i < 0) return;
    draft.replacements.splice(i, 1);
    fromInput.value = ''; toInput.value = ''; typed = '';
    render();
    fromInput.focus();
  }
  fromInput.addEventListener('input', () => {
    typed = fromInput.value.trim().toLowerCase();
    const i = match();
    if (i >= 0) toInput.value = draft.replacements[i].to;
    render();
  });
  toInput.addEventListener('input', render);
  // An Enter that confirms a word composed with an input method only ends the composition.
  for (const input of [fromInput, toInput]) input.addEventListener('keydown', (e) => { if (isComposing(e)) return; if (e.key === 'Enter') { e.preventDefault(); if (!addBtn.disabled) addEntry(); } });
  list.addEventListener('keydown', (e) => {
    const rows = [...list.children];
    if (!rows.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    let at = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
    at = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[at].click();
    list.focus();
  });

  function openExceptions() {
    const lists = [['firstLetterExceptions', t('autocorrect.exceptions.firstLetter'), t('autocorrect.exceptions.firstLetterAria'), t('autocorrect.exceptions.firstLetterHint')],
      ['initialCapsExceptions', t('autocorrect.exceptions.initialCaps'), t('autocorrect.exceptions.initialCapsAria'), t('autocorrect.exceptions.initialCapsHint')]];
    const areas = lists.map(([key, label, name, hint]) => {
      const area = el('textarea.input', { rows: 8, 'aria-label': name, spellcheck: false, value: draft[key].join('\n') });
      return { key, area, node: el('label.field', {}, el('span.field-label', {}, label), el('span.field-hint', {}, hint), area) };
    });
    const content = el('form.autocorrect-exceptions', { onsubmit: (e) => {
      e.preventDefault();
      for (const { key, area } of areas) draft[key] = area.value.split('\n').map((w) => w.trim()).filter(Boolean);
      sub.close();
    } }, ...areas.map((a) => a.node),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => sub.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
    const sub = openModal({ title: t('autocorrect.exceptions.title'), content, initialFocus: areas[0].area });
  }

  const submit = (e) => {
    e.preventDefault();
    for (const [key] of options) draft[key] = boxes[key].checked;
    const saved = saveAutoCorrectSettings(draft);
    modal.close();
    onSaved?.(saved);
  };
  const content = el('form.autocorrect-dialog', { onsubmit: submit },
    el('div.autocorrect-top', {}, checks, el('div.autocorrect-side', {}, exceptionsBtn)),
    el('div.autocorrect-replace', {},
      el('div.autocorrect-fields', {},
        el('label.field', {}, el('span.field-label', {}, t('common.replace')), fromInput),
        el('label.field', {}, el('span.field-label', {}, t('autocorrect.with')), toInput)),
      list,
      el('div.row.autocorrect-actions', {}, count, el('span.spacer'), resetBtn, delBtn, addBtn)),
    el('p.small.muted', {}, t('autocorrect.undoHint', { key: MOD_KEY })),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  render();
  const modal = openModal({ title: t('autocorrect.title'), content, wide: true, initialFocus: fromInput, onClose });
  return modal;
}
