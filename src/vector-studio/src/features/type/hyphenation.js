/**
 * Hyphenation languages: loading pattern files when text needs them,
 * Preferences > Hyphenation (the language of new type and the exception
 * words of each language), and the exception editor the Custom Dictionary
 * opens.
 *
 * Exceptions live in the preferences as `hyphenationExceptions`
 * ({ 'en-US': ['ty-po-graph-ic', 'Puter'] }): an entry's hyphens are the
 * word's only breaks, an entry without hyphens is never hyphenated.
 */
import { h } from '../../lib/dom.js';
import { setListItems } from '../../ui/panels/panel.js';
import { invalidateTextLayout } from '../../model/text-layout.js';
import { clearGeometryCache } from '../../model/geometry.js';
import { styledRuns, paraAt, paragraphRanges } from '../../model/text-runs.js';
import { setHyphenationLoader, loadHyphenation, setHyphenationExceptions, hyphenateWord, hyphenationLoaded, canHyphenate } from '../../model/hyphenate.js';
import { parseException } from '../../model/liang.js';
import { LANGUAGES, DEFAULT_LANGUAGE, languageLabel } from '../../model/languages.js';
import { extraPrefSections, PREF_DEFAULTS, preferencesDialog } from '../files/preferences.js';
import { typeDefaults } from './type-ops.js';

const LANGS = LANGUAGES.filter((l) => l.code !== 'none');

/** Exception lists from the preferences: { code: [entries] }. */
export function exceptionsOf(prefs) {
  const v = prefs?.get('hyphenationExceptions');
  return v && typeof v === 'object' ? v : {};
}

/** Clean an exception entry: one word, letters and hyphens only ('' when invalid). */
export function cleanEntry(s) {
  const t = String(s ?? '')
    .trim()
    .replace(/[­‐~=]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return /^[\p{L}\p{M}'’]+(?:-[\p{L}\p{M}'’]+)*$/u.test(t) ? t : '';
}

/** Add an entry to a language's list (replacing an entry for the same word). Pure. */
export function withException(all, code, entry) {
  const e = cleanEntry(entry);
  if (!e) return all;
  const word = parseException(e).word;
  const list = (all[code] || []).filter((x) => parseException(x).word !== word);
  return { ...all, [code]: [...list, e].sort((a, b) => a.localeCompare(b)) };
}

export function withoutException(all, code, entry) {
  const list = (all[code] || []).filter((x) => x !== entry);
  const out = { ...all };
  if (list.length) out[code] = list;
  else delete out[code];
  return out;
}

function relayout(app) {
  invalidateTextLayout();
  clearGeometryCache();
  for (const v of app.views?.values?.() || []) v.invalidate();
  app.editor?.emit('overlay');
}

/** Load the patterns of every language a document's hyphenated paragraphs use. */
export async function hyphenationReadyFor(doc) {
  if (!doc) return;
  const langs = new Set();
  for (const n of doc.leaves()) {
    if (n.type !== 'text') continue;
    const text = String(n.text ?? '');
    const ranges = paragraphRanges(text);
    if (!ranges.some((_, pi) => paraAt(n, pi).hyphenate)) continue;
    for (const r of styledRuns(n)) langs.add(r.style.language || DEFAULT_LANGUAGE);
  }
  const fresh = [...langs].filter((l) => canHyphenate(l) && !hyphenationLoaded(l));
  if (!fresh.length) return;
  await Promise.all(fresh.map((l) => loadHyphenation(l).catch(() => false)));
  invalidateTextLayout();
  clearGeometryCache();
}

/**
 * Exception editor: a language, its words and a new-entry field that
 * previews how the current rules break the word. Returns { el, value() }.
 */
export function exceptionsEditor(initial = {}, startLanguage = DEFAULT_LANGUAGE) {
  let all = { ...initial };
  let lang = LANGS.some((l) => l.code === startLanguage) ? startLanguage : DEFAULT_LANGUAGE;
  let selected = null;
  const uid = Math.random().toString(36).slice(2, 7);
  const langSel = h('select.select', { id: `hx-lang-${uid}` }, LANGS.map((l) => h('option', { value: l.code, selected: l.code === lang }, l.label)));
  const list = h('div.cd-list.hx-list', { role: 'listbox', 'aria-label': 'Exception words', tabindex: '0' });
  const entry = h('input', { type: 'text', id: `hx-entry-${uid}`, autocomplete: 'off', spellcheck: false, placeholder: 'ty-po-graph-ic' });
  const preview = h('p.form-help.hx-preview', { role: 'status', 'aria-live': 'polite' });
  const bAdd = h('button.btn', { type: 'button' }, 'Add');
  const bDelete = h('button.btn', { type: 'button' }, 'Delete');
  const render = () => {
    const words = all[lang] || [];
    setListItems(list, words.map((w) => h('div.cd-item', { role: 'option', 'aria-selected': String(w === selected), 'data-word': w }, w)), h('p.panel-empty', `No exceptions for ${languageLabel(lang)}.`));
    bDelete.disabled = !selected;
    const e = cleanEntry(entry.value);
    bAdd.disabled = !e || words.includes(e);
    const word = entry.value.trim().replace(/-/g, '');
    if (!entry.value.trim()) preview.textContent = 'Type a word with hyphens where it may break, or without hyphens to keep it whole.';
    else if (!e) preview.textContent = 'Enter one word: letters, with hyphens between syllables.';
    else if (!canHyphenate(lang)) preview.textContent = `${languageLabel(lang)} text is not hyphenated automatically; exceptions still apply.`;
    else if (!/^\p{L}+$/u.test(word)) preview.textContent = '';
    else preview.textContent = `Hyphenated now as: ${hyphenateWord(word, { minWord: 2, minBefore: 1, minAfter: 1, capitalized: true }, lang)}`;
  };
  const ensure = () => {
    if (canHyphenate(lang) && !hyphenationLoaded(lang)) loadHyphenation(lang).then(render, () => {});
  };
  langSel.addEventListener('change', () => {
    lang = langSel.value;
    selected = null;
    ensure();
    render();
  });
  entry.addEventListener('input', render);
  entry.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!bAdd.disabled) bAdd.click();
  });
  bAdd.addEventListener('click', () => {
    const e = cleanEntry(entry.value);
    if (!e) return;
    all = withException(all, lang, e);
    selected = e;
    entry.value = '';
    render();
    entry.focus();
  });
  bDelete.addEventListener('click', () => {
    if (!selected) return;
    all = withoutException(all, lang, selected);
    selected = null;
    render();
  });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('[data-word]');
    if (!el) return;
    selected = el.dataset.word;
    entry.value = selected;
    render();
  });
  list.addEventListener('keydown', (e) => {
    const words = all[lang] || [];
    if (!words.length) return;
    const i = words.indexOf(selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selected = words[Math.max(0, Math.min(words.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      render();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      bDelete.click();
    }
  });
  const el = h(
    'div.hx-editor',
    h('div.form-row', h('label', { for: langSel.id }, 'Exceptions for'), langSel),
    h('div.sp-main', list, h('div.sp-actions', bAdd, bDelete)),
    h('div.form-row', h('label', { for: entry.id }, 'New Entry'), entry),
    preview,
  );
  ensure();
  render();
  return { el, value: () => all };
}

/** Exceptions in a dialog of their own (from the Custom Dictionary). */
export async function editHyphenationExceptions(app) {
  const ed = exceptionsEditor(exceptionsOf(app.prefs), typeDefaults(app).char.language || DEFAULT_LANGUAGE);
  const ok = await app.dialogs.open({
    title: 'Hyphenation Exceptions',
    body: h('div.form.custom-dictionary', ed.el),
    className: 'spell-dialog',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: true },
    ],
  });
  if (ok) app.prefs.set('hyphenationExceptions', ed.value());
  return Boolean(ok);
}

/** Preferences > Hyphenation. */
function hyphenationSection(app) {
  return {
    id: 'hyphenation',
    label: 'Hyphenation',
    after: 'slices',
    fields: [
      { key: 'defaultLanguage', label: 'Default Language', type: 'select', options: LANGS.map((l) => ({ value: l.code, label: l.label })), help: 'The language new type is set in: hyphenation and spell checking follow it.' },
      { type: 'heading', label: 'Exceptions' },
      { key: 'hyphenationExceptions', type: 'custom', label: 'Exceptions', build: (v) => exceptionsEditor(v && typeof v === 'object' ? v : {}, app.prefs.get('defaultLanguage') || DEFAULT_LANGUAGE) },
    ],
  };
}

export function installHyphenation(app) {
  PREF_DEFAULTS.defaultLanguage = DEFAULT_LANGUAGE;
  if (!extraPrefSections.includes(hyphenationSection)) extraPrefSections.push(hyphenationSection);
  if (!app.commands.get('edit.preferences.hyphenation')) {
    app.commands.register({ id: 'edit.preferences.hyphenation', label: 'Hyphenation...', run: (a) => preferencesDialog(a, { section: 'hyphenation' }) });
  }
  app.commands.register({ id: 'type.hyphenationExceptions', label: 'Hyphenation Exceptions...', run: editHyphenationExceptions });

  const applyDefaultLanguage = () => {
    const l = app.prefs.get('defaultLanguage');
    if (l && LANGS.some((x) => x.code === l)) typeDefaults(app).char.language = l;
  };
  applyDefaultLanguage();
  setHyphenationExceptions(exceptionsOf(app.prefs));
  app.prefs.on?.('change', ({ key }) => {
    if (key === 'hyphenationExceptions') {
      setHyphenationExceptions(exceptionsOf(app.prefs));
      relayout(app);
    } else if (key === 'defaultLanguage') applyDefaultLanguage();
  });

  // Text that asks for a language's patterns gets them, then lays out again.
  setHyphenationLoader((code) => {
    loadHyphenation(code).then(
      (ok) => ok && relayout(app),
      () => {},
    );
  });
  // Exports wait for the patterns their text uses, like they wait for fonts.
  const fontsReady = app.textFontsReady;
  app.textFontsReady = async (doc = app.editor?.doc) => {
    await Promise.all([fontsReady?.(doc), hyphenationReadyFor(doc)]);
  };
}
