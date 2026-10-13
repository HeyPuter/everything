/**
 * AutoCorrect in the editor: the corrector the cell editor and the formula bar call as words are typed, the
 * settings kept for the person (see lib/user-prefs.js), and the Tools ▸ AutoCorrect Options dialog.
 *
 * A word corrected while the entry is open can be put back as typed with Ctrl/Cmd+Z straight away; a last
 * word corrected as the entry is committed is written as an undo step of its own after the entry, so the
 * first Ctrl/Cmd+Z after Enter brings back what was typed and the second takes the entry away.
 */
import { el, fieldId, MOD_KEY } from './dom.js';
import { openModal } from './modal.js';
import { loadPref, savePref, syncPref } from '../lib/user-prefs.js';
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
      announce?.(`Corrected ${res.correction.from} to ${res.correction.to}. ${MOD_KEY}+Z puts it back`);
      return true;
    },
    undo(input) {
      if (!last || last.el !== input || input.value !== last.after || input.selectionStart !== last.afterCaret) return false;
      input.value = last.before;
      input.setSelectionRange(last.beforeCaret, last.beforeCaret);
      kept.push({ from: last.correction.from, start: last.correction.start });
      announce?.(`Kept ${last.correction.from} as typed`);
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
    ['twoInitialCaps', 'Correct TWo INitial CApitals'],
    ['sentenceCaps', 'Capitalize the first letter of sentences'],
    ['dayNames', 'Capitalize names of days'],
    ['capsLock', 'Correct accidental use of cAPS LOCK'],
    ['replaceText', 'Replace text as you type'],
    ['mathSymbols', 'Turn \\names into math symbols (\\alpha → α, \\infty → ∞)'],
  ];
  const boxes = Object.fromEntries(options.map(([key]) => [key, el('input', { type: 'checkbox', checked: draft[key] })]));
  const checks = el('fieldset.check-group.vertical.autocorrect-options', {},
    el('legend.field-label', {}, 'While typing in cells (never in formulas)'),
    ...options.map(([key, label]) => el('label.check', {}, boxes[key], el('span', {}, label))));

  // The replacement list: the two fields pick an entry as they are typed, and Add (or Replace) and Delete act on it.
  const fromInput = el('input.input', { type: 'text', 'aria-label': 'Replace', autocomplete: 'off', spellcheck: false, maxlength: 64 });
  const toInput = el('input.input', { type: 'text', 'aria-label': 'With', autocomplete: 'off', spellcheck: false, maxlength: 255 });
  const addBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => addEntry() }, 'Add');
  const delBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => deleteEntry() }, 'Delete');
  const listId = fieldId('autocorrect-list');
  const list = el('div.autocorrect-list', { id: listId, role: 'listbox', 'aria-label': 'Replacements', tabindex: 0 });
  const count = el('span.small.muted', { role: 'status' });
  const exceptionsBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => openExceptions() }, 'Exceptions…');
  const resetBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { draft.replacements = DEFAULT_AUTOCORRECT.replacements.map((e) => ({ ...e })); render(); } }, 'Restore the starting list');

  const match = () => draft.replacements.findIndex((e) => e.from === fromInput.value.trim());
  function render() {
    const q = fromInput.value.trim().toLowerCase();
    const sorted = draft.replacements.map((e, i) => ({ ...e, i })).sort((a, b) => a.from.localeCompare(b.from));
    const shown = q ? sorted.filter((e) => e.from.toLowerCase().startsWith(q)).concat(sorted.filter((e) => !e.from.toLowerCase().startsWith(q))) : sorted;
    const exact = match();
    list.replaceChildren(...shown.map((e) => el('div.autocorrect-row', {
      role: 'option', 'aria-selected': String(e.i === exact), dataset: { index: e.i },
      onclick: () => { fromInput.value = e.from; toInput.value = e.to; render(); },
    }, el('span.autocorrect-from', { dir: 'auto' }, e.from), el('span.autocorrect-arrow', { 'aria-hidden': 'true' }, '→'), el('span.autocorrect-to', { dir: 'auto' }, e.to))));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    addBtn.textContent = exact >= 0 ? 'Replace' : 'Add';
    addBtn.disabled = !fromInput.value.trim() || /\s/.test(fromInput.value.trim()) || (exact >= 0 && draft.replacements[exact].to === toInput.value);
    delBtn.disabled = exact < 0;
    count.textContent = `${draft.replacements.length} replacement${draft.replacements.length === 1 ? '' : 's'}`;
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
    fromInput.value = ''; toInput.value = '';
    render();
    fromInput.focus();
  }
  fromInput.addEventListener('input', () => {
    const i = match();
    if (i >= 0) toInput.value = draft.replacements[i].to;
    render();
  });
  toInput.addEventListener('input', render);
  for (const input of [fromInput, toInput]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!addBtn.disabled) addEntry(); } });
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
    const lists = [['firstLetterExceptions', 'First letter', 'Words after which the next word does not start a sentence (abbreviations)'],
      ['initialCapsExceptions', 'Two initial capitals', 'Words to leave with two capitals at the start']];
    const areas = lists.map(([key, label, hint]) => {
      const area = el('textarea.input', { rows: 8, 'aria-label': `${label} exceptions`, spellcheck: false, value: draft[key].join('\n') });
      return { key, area, node: el('label.field', {}, el('span.field-label', {}, label), el('span.field-hint', {}, `${hint}, one per line`), area) };
    });
    const content = el('form.autocorrect-exceptions', { onsubmit: (e) => {
      e.preventDefault();
      for (const { key, area } of areas) draft[key] = area.value.split('\n').map((w) => w.trim()).filter(Boolean);
      sub.close();
    } }, ...areas.map((a) => a.node),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => sub.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
    const sub = openModal({ title: 'AutoCorrect exceptions', content, initialFocus: areas[0].area });
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
        el('label.field', {}, el('span.field-label', {}, 'Replace'), fromInput),
        el('label.field', {}, el('span.field-label', {}, 'With'), toInput)),
      list,
      el('div.row.autocorrect-actions', {}, count, el('span.spacer'), resetBtn, delBtn, addBtn)),
    el('p.small.muted', {}, `A correction made while typing can be put back with ${MOD_KEY}+Z straight away; one made as an entry is committed is an undo step of its own.`),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  render();
  const modal = openModal({ title: 'AutoCorrect', content, wide: true, initialFocus: fromInput, onClose });
  return modal;
}
