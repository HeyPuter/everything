import { MAX_DOCUMENT_CHARACTERS } from '../engine/text-limits.js';
import { describeFormat } from '../engine/advanced-search.js';
import { el, isComposing } from '../ui/dom.js';
import { iconEl } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';

/** The special characters the Special menu inserts, as [code, label, findOnly]. */
export const SPECIAL_CHARACTERS = [
  ['^p', 'Paragraph mark'], ['^t', 'Tab character'], ['^l', 'Manual line break'], ['^m', 'Manual page break'], ['^n', 'Column break'],
  ['^s', 'Nonbreaking space'], ['^~', 'Nonbreaking hyphen'], ['^-', 'Optional hyphen'], ['^+', 'Em dash'], ['^=', 'En dash'], ['^^', 'Caret character'],
  ['^?', 'Any character', 'find'], ['^#', 'Any digit', 'find'], ['^$', 'Any letter', 'find'], ['^w', 'White space', 'find'], ['^g', 'Picture', 'find'],
  ['^&', 'Find what text', 'replace'],
];
export const WILDCARD_HELP = '? one character · * any characters · [abc] one of · [!a] not · {n,m} repeats · @ one or more · < word start · > word end · ( ) group for \\1';
const ADVANCED_FLAGS = [['wildcards', 'Use wildcards'], ['matchPrefix', 'Match prefix'], ['matchSuffix', 'Match suffix'], ['ignorePunctuation', 'Ignore punctuation'], ['ignoreWhitespace', 'Ignore white space']];

/**
 * The Find and Replace panel. Basic use is literal (Match case, Whole words); More options adds
 * wildcards, prefix/suffix, punctuation/white-space-insensitive matching, special characters, a search
 * scope (selection, headers and footers) and formatting to find and to replace with.
 *
 * api: matches(query, options), range(), select(match), highlight(matches), replace(query, text, options, all),
 * readOnly(), close(); optional: chooseFont(seed, done), chooseParagraph(seed, done), styles(), scopes().
 */
export function findReplacePanel(api) {
  const query = el('input.input', { 'aria-label': 'Find text', type: 'text', spellcheck: false, maxLength: MAX_DOCUMENT_CHARACTERS });
  const replacement = el('input.input', { 'aria-label': 'Replace with', type: 'text', spellcheck: false, maxLength: MAX_DOCUMENT_CHARACTERS });
  const matchCase = el('input', { type: 'checkbox' }), wholeWord = el('input', { type: 'checkbox' });
  const flags = Object.fromEntries(ADVANCED_FLAGS.map(([key]) => [key, el('input', { type: 'checkbox' })]));
  const count = el('span.canvas-find-count', { role: 'status', 'aria-live': 'polite' });
  const notice = el('p.canvas-find-notice', { role: 'status', 'aria-live': 'polite' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  let findFormat = {}, replaceFormat = {}, within = null, lastField = query;
  const scope = el('select.input', { 'aria-label': 'Search in', onchange: () => {
    within = scope.value === 'selection' ? [...api.range()] : null;
    notice.textContent = ''; navigate();
  } }, el('option', { value: 'document' }, 'Main document'), el('option', { value: 'selection' }, 'Current selection'));
  for (const [value, label] of api.scopes?.() || []) scope.append(el('option', { value }, label));
  const advancedUsed = () => ADVANCED_FLAGS.some(([key]) => flags[key].checked) || Object.keys(findFormat).length || Object.keys(replaceFormat).length || /\^/.test(query.value) || /\^|\\[1-9]/.test(replacement.value) || scope.value !== 'document';
  const options = () => {
    const base = { matchCase: matchCase.checked, wholeWord: wholeWord.checked };
    if (!advancedUsed()) return base;
    return { ...base, advanced: true, ...Object.fromEntries(ADVANCED_FLAGS.map(([key]) => [key, flags[key].checked])), format: findFormat, replaceFormat, ...(within ? { within } : {}), scope: scope.value };
  };
  const action = (label, icon, run) => el('button.icon-btn', { type: 'button', 'aria-label': label, title: label, onclick: run }, iconEl(icon, 18));
  const previous = action('Previous match', 'arrowUp', () => navigate(-1)), next = action('Next match', 'arrowDown', () => navigate(1));
  const replace = el('button.btn', { type: 'button', onclick: () => change(false) }, 'Replace');
  const all = el('button.btn', { type: 'button', onclick: () => change(true) }, 'Replace all');
  const close = () => { if (node.hidden) return; node.hidden = true; api.highlight?.([]); api.close(); };

  /* ---- More options ---- */
  const findFormatLabel = el('span.canvas-find-format'), replaceFormatLabel = el('span.canvas-find-format');
  const paintFormats = () => {
    findFormatLabel.textContent = Object.keys(findFormat).length ? `Find formatting: ${describeFormat(findFormat)}` : '';
    replaceFormatLabel.textContent = Object.keys(replaceFormat).length ? `Replace formatting: ${describeFormat(replaceFormat)}` : '';
    findFormatLabel.hidden = !findFormatLabel.textContent; replaceFormatLabel.hidden = !replaceFormatLabel.textContent;
    noFormatting.disabled = !Object.keys(findFormat).length && !Object.keys(replaceFormat).length;
  };
  const formatTarget = () => lastField === replacement ? 'replace' : 'find';
  const setFormat = patch => {
    if (formatTarget() === 'replace') replaceFormat = { ...replaceFormat, ...patch }; else findFormat = { ...findFormat, ...patch };
    paintFormats(); notice.textContent = ''; navigate();
  };
  const formatButton = el('button.btn.btn-outline.btn-sm', { type: 'button', 'aria-haspopup': 'menu', onclick: () => {
    const target = formatTarget(), current = target === 'replace' ? replaceFormat : findFormat;
    const styles = api.styles?.() || [];
    openMenu({ anchor: formatButton, label: target === 'replace' ? 'Replace formatting' : 'Find formatting', items: [
      { header: target === 'replace' ? 'Replace with formatting' : 'Find formatting' },
      { label: 'Font…', disabled: !api.chooseFont, onSelect: () => api.chooseFont(current, patch => setFormat(fontCondition(patch))) },
      { label: 'Paragraph…', disabled: !api.chooseParagraph, onSelect: () => api.chooseParagraph(current, patch => setFormat(patch)) },
      { label: 'Style', disabled: !styles.length, items: styles.map(style => ({ label: style.name, radio: true, checked: style.type === 'character' ? current.characterStyle === style.id : current.paragraphStyle === style.id,
        onSelect: () => setFormat(style.type === 'character' ? { characterStyle: style.id } : { paragraphStyle: style.id }) })) },
      { label: 'Highlight', checked: target === 'replace' ? current.highlight === 'yellow' : current.highlight === 'any', onSelect: () => setFormat({ highlight: target === 'replace' ? 'yellow' : 'any' }) },
      { label: 'Not Highlighted', onSelect: () => setFormat({ highlight: 'none' }) },
    ] });
  } }, 'Format');
  const noFormatting = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => {
    if (formatTarget() === 'replace') replaceFormat = {}; else findFormat = {};
    paintFormats(); navigate();
  } }, 'No Formatting');
  const specialButton = el('button.btn.btn-outline.btn-sm', { type: 'button', 'aria-haspopup': 'menu', onclick: () => {
    const target = lastField, kind = target === replacement ? 'replace' : 'find';
    openMenu({ anchor: specialButton, label: 'Special characters', items: SPECIAL_CHARACTERS.filter(([, , only]) => !only || only === kind).map(([code, label]) => ({ label, hint: code, onSelect: () => {
      const at = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? at;
      target.value = target.value.slice(0, at) + code + target.value.slice(end);
      target.focus(); target.setSelectionRange(at + code.length, at + code.length);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    } })) });
  } }, 'Special');
  const wildcardHint = el('p.field-hint.canvas-find-wildcards', { hidden: true }, WILDCARD_HELP);
  flags.wildcards.addEventListener('change', () => {
    wildcardHint.hidden = !flags.wildcards.checked;
    // Wildcard searches are case-sensitive and whole-word matching uses < and > instead.
    for (const box of [matchCase, wholeWord, flags.matchPrefix, flags.matchSuffix, flags.ignorePunctuation, flags.ignoreWhitespace]) box.disabled = flags.wildcards.checked;
  });
  const more = el('div.canvas-find-more', { hidden: true },
    el('div.canvas-find-options', {}, ...ADVANCED_FLAGS.map(([key, label]) => el('label', {}, flags[key], label))),
    wildcardHint,
    el('label.canvas-find-field', {}, el('span', {}, 'Search in'), scope),
    el('div.canvas-find-row', {}, formatButton, specialButton, noFormatting),
    findFormatLabel, replaceFormatLabel);
  const moreButton = el('button.btn.btn-ghost.btn-sm.canvas-find-more-toggle', { type: 'button', 'aria-expanded': 'false', onclick: () => setMore(more.hidden) }, 'More options');
  function setMore(open) {
    more.hidden = !open; moreButton.setAttribute('aria-expanded', String(open)); moreButton.textContent = open ? 'Fewer options' : 'More options';
  }
  paintFormats();

  const node = el('section.canvas-find', { role: 'search', 'aria-label': 'Find and replace', hidden: true, onkeydown: e => {
    if (e.key === 'Escape' && !isComposing(e)) { e.preventDefault(); e.stopPropagation(); close(); }
  } }, el('div.canvas-find-heading', {}, el('strong', {}, 'Find and replace'), action('Close find and replace', 'x', close)),
  el('label.canvas-find-field', {}, el('span', {}, 'Find'), query),
  el('div.canvas-find-row', {}, el('label', {}, matchCase, 'Match case'), el('label', {}, wholeWord, 'Whole words')),
  el('div.canvas-find-row', {}, count, previous, next),
  el('label.canvas-find-field', {}, el('span', {}, 'Replace with'), replacement),
  el('div.canvas-find-row.canvas-find-actions', {}, el('span.field-hint', {}, 'Enter: next · Shift+Enter: previous'), replace, all),
  moreButton, more, notice, error);
  function refresh() {
    if (node.hidden) { api.highlight?.([]); return { matches: [], current: -1 }; }
    let matches = [];
    const searching = !!query.value || Object.keys(findFormat).length > 0;
    try { matches = searching ? api.matches(query.value, options()) : []; error.hidden = true; }
    catch (e) { error.textContent = e.message; error.hidden = false; }
    api.highlight?.(matches);
    const [start, end] = api.range(), current = matches.findIndex(m => m.start === start && m.end === end && (!m.story || api.isCurrentStory?.(m.story)));
    count.textContent = !searching ? 'Enter text to find' : !matches.length ? 'No matches' : current < 0 ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}` : `${current + 1} of ${matches.length}`;
    previous.disabled = next.disabled = !matches.length;
    replacement.disabled = !!api.readOnly?.();
    all.disabled = replacement.disabled || !matches.length;
    replace.disabled = replacement.disabled || current < 0;
    return { matches, current };
  }
  function navigate(direction = 0) {
    const { matches, current } = refresh(); if (!matches.length) return;
    const [start] = api.range(); let index;
    if (direction && current >= 0) index = (current + direction + matches.length) % matches.length;
    else if (direction < 0) { index = matches.findLastIndex(m => m.start < start); if (index < 0) index = matches.length - 1; }
    else { index = matches.findIndex(m => m.start >= start); if (index < 0) index = 0; }
    api.select(matches[index]); refresh();
  }
  function change(every) {
    try {
      const total = api.replace(query.value, replacement.value, options(), every);
      // A replacement inside the searched selection moves its end.
      if (within) { within = null; scope.value = 'document'; }
      if (!every) navigate(1); else refresh();
      notice.textContent = `Replaced ${total} ${total === 1 ? 'match' : 'matches'}.`; error.hidden = true;
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  }
  for (const input of [query, matchCase, wholeWord, ...Object.values(flags)]) input.addEventListener('input', e => { if (!e.isComposing) { notice.textContent = ''; navigate(); } });
  for (const box of Object.values(flags)) box.addEventListener('change', () => { notice.textContent = ''; navigate(); });
  for (const input of [query, replacement]) input.addEventListener('focus', () => { lastField = input; });
  query.addEventListener('compositionend', () => { notice.textContent = ''; navigate(); });
  query.addEventListener('keydown', e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); navigate(e.shiftKey ? -1 : 1); } });
  replacement.addEventListener('keydown', e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); if (!replace.disabled) change(false); } });
  return { node, refresh, close, open(selected = '', { advanced = false } = {}) {
    if (node.hidden && selected && !/[\u0000-\u001f￼]/u.test(selected)) query.value = selected;
    if (advanced) setMore(true);
    node.hidden = false; notice.textContent = ''; navigate(); query.focus(); query.select();
  },
  /** Seed formatting conditions (Select → similar formatting, tests). */
  setFindFormat(format) { findFormat = { ...format }; paintFormats(); setMore(true); navigate(); } };
}

/** A Font dialog patch as find conditions: one value per property, without the complex-script twins. */
export function fontCondition(patch) {
  const result = { ...patch };
  for (const key of ['fontHAnsi', 'fontSizeCs', 'boldCs', 'italicCs', 'underlineColor']) delete result[key];
  if ('underlineStyle' in result) { result.underline = result.underlineStyle !== 'none'; delete result.underlineStyle; }
  return result;
}
