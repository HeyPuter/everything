/**
 * File ▸ Options… (Ctrl/Cmd+,): the app's options and the person's customizations, one page per section,
 * with a search field over the list of sections that finds an option by any word of its name.
 *
 * Options apply as they are changed and are kept for the person (lib/app-options.js); the calculation
 * settings of the open workbook are the workbook's own and say so. The last three pages arrange the
 * Quick Access Toolbar, the ribbon and the keyboard shortcuts (lib/customize.js).
 */
import { el, IS_MAC, fieldId, isComposing } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { appOptions, setAppOptions, resetAppOptions, OPTION_CHOICES, OPTION_DEFAULTS } from '../lib/app-options.js';
import { expandTwoDigitYear, FONTS as FONT_LIST } from '../core/format.js';
import { ERROR_RULES, errorCheckingOptions } from '../core/error-checking.js';
import { saveErrorChecking } from './error-smarttag.js';
import { commandCatalog, searchCatalog, builtinShortcuts } from './command-catalog.js';
import { quickAccessStore, ribbonLayoutStore, keymapStore, DEFAULT_QUICK_ACCESS } from '../lib/customize.js';
import * as RL from '../core/ribbon-layout.js';
import { chordFromEvent, formatChord, chordProblem, chordConflicts, chordsFor } from '../core/keymap.js';
import { currentTheme } from './theme.js';
import { session } from '../lib/session.js';
import { t, tSource, hasMessage, language, languagePreference, setLanguagePreference, resolveLanguage, LANGUAGES, PSEUDO_LANGUAGE } from '../i18n/index.js';
import { relaunch } from '../lib/relaunch.js';

/** The sections, in order. `title` and `about` are message keys, put into words where the dialog draws them. */
export const OPTION_SECTIONS = [
  { id: 'general', title: 'optionsDialog.sections.general', icon: 'sliders', about: 'optionsDialog.sections.generalAbout' },
  { id: 'formulas', title: 'optionsDialog.sections.formulas', icon: 'calculator', about: 'optionsDialog.sections.formulasAbout' },
  { id: 'edit', title: 'optionsDialog.sections.edit', icon: 'pencil', about: 'optionsDialog.sections.editAbout' },
  { id: 'view', title: 'optionsDialog.sections.view', icon: 'eye', about: 'optionsDialog.sections.viewAbout' },
  { id: 'proofing', title: 'optionsDialog.sections.proofing', icon: 'spell', about: 'optionsDialog.sections.proofingAbout', keywords: 'autocorrect spelling dictionary typo correct' },
  { id: 'save', title: 'optionsDialog.sections.save', icon: 'save', about: 'optionsDialog.sections.saveAbout', keywords: 'autosave autorecover draft recovery' },
  { id: 'accessibility', title: 'optionsDialog.sections.accessibility', icon: 'accessibility', about: 'optionsDialog.sections.accessibilityAbout', keywords: 'contrast motion animation selection' },
  { id: 'privacy', title: 'optionsDialog.sections.privacy', icon: 'lock', about: 'optionsDialog.sections.privacyAbout', keywords: 'ai artificial intelligence assistant' },
  { id: 'ribbon', title: 'optionsDialog.sections.ribbon', icon: 'customizeRibbon', about: 'optionsDialog.sections.ribbonAbout', keywords: 'ribbon tab group custom commands' },
  { id: 'quickAccess', title: 'optionsDialog.sections.quickAccess', icon: 'customizeQuickAccess', about: 'optionsDialog.sections.quickAccessAbout', keywords: 'quick access toolbar qat commands' },
  { id: 'keyboard', title: 'optionsDialog.sections.keyboard', icon: 'customizeKeyboard', about: 'optionsDialog.sections.keyboardAbout', keywords: 'keyboard shortcut keys hotkey chord' },
];

/** The fonts the font box offers, for the new-workbook font's suggestions. */
const FONTS = FONT_LIST.filter(([key]) => key !== 'default').map(([, name]) => name);

/**
 * Open the dialog on `section`. `ctx` is the editor's: wb, run, flags, ribbon, setAutoSave, accountName.
 * Returns the modal ({ close }) with `show(section)` and `body` for tests.
 */
export function openOptionsDialog(ctx, { section = 'general' } = {}) {
  // Away from a workbook there is no ribbon to arrange.
  const sections = OPTION_SECTIONS.filter((s) => s.id !== 'ribbon' || ctx.ribbon);
  let current = sections.some((s) => s.id === section) ? section : 'general';
  const syncs = []; // every control's refresh, run after any change so the rows that depend on another follow it
  const built = new Map(); // section id → its page
  const syncAll = () => { for (const fn of syncs) fn(); };
  const set = (patch) => { setAppOptions(patch); syncAll(); };

  /* ---------- Rows ---------- */

  // A label or hint is a message: a key, or [key, values]. It is shown in the interface language, and a search
  // finds it by its words in that language and in English, so an option is found by either.
  const spec = (m) => (Array.isArray(m) ? m : [m]);
  const say = (m) => (m ? t(...spec(m)) : null);
  const words = (m) => (m ? `${t(...spec(m))} ${tSource(...spec(m))}` : '');

  // Every row carries the words a search finds it by.
  const row = (terms, ...kids) => el('div.opt-row', { dataset: { search: terms.filter(Boolean).join(' ').toLowerCase() } }, ...kids);
  /** A row for one of the app's options, which Restore Defaults puts back. */
  const optionRow = (key, terms, ...kids) => {
    const node = row([...terms, key], ...kids);
    node.dataset.key = key;
    if (dependents.has(key)) node.classList.add('opt-dependent'); // it sits under the option it follows
    return node;
  };
  const group = (title, ...rows) => el('section.opt-group', { 'aria-label': say(title), dataset: { search: words(title).toLowerCase() } },
    el('h4.opt-group-title', {}, say(title)), ...rows.filter(Boolean));
  /** Options that only mean something while another is on: greyed while it is off. */
  const dependents = new Set();
  const dependsOn = (control, requires, key) => {
    if (!requires) return;
    dependents.add(key);
    syncs.push(() => {
      control.disabled = !appOptions()[requires];
      control.closest?.('.opt-row')?.classList.toggle('opt-off', !appOptions()[requires]);
    });
  };

  function check(key, label, hint = null, { requires = null, onChange = null } = {}) {
    const id = fieldId('opt');
    const input = el('input', { type: 'checkbox', id, 'aria-describedby': hint ? `${id}-hint` : null });
    input.checked = !!appOptions()[key];
    input.addEventListener('change', () => { set({ [key]: input.checked }); onChange?.(input.checked); });
    syncs.push(() => { input.checked = !!appOptions()[key]; });
    dependsOn(input, requires, key);
    return optionRow(key, [words(label), words(hint)], el('div.opt-check', {}, input,
      el('label.opt-check-text', { for: id }, el('span.opt-label', {}, say(label)), hint && el('span.opt-hint', { id: `${id}-hint` }, say(hint)))));
  }

  /** `choices` are [value, message key] (OPTION_CHOICES). */
  function choose(key, label, hint = null, { requires = null, choices = OPTION_CHOICES[key] } = {}) {
    const id = fieldId('opt');
    const select = el('select.select.opt-select', { id }, choices.map(([value, text]) => el('option', { value: String(value) }, say(text))));
    select.value = String(appOptions()[key]);
    select.addEventListener('change', () => set({ [key]: select.value }));
    syncs.push(() => { select.value = String(appOptions()[key]); });
    dependsOn(select, requires, key);
    return optionRow(key, [words(label), words(hint), ...choices.map(([, text]) => words(text))], el('div.opt-field', {},
      el('label.opt-label', { for: id }, say(label)), select, hint && el('span.opt-hint', {}, say(hint))));
  }

  function number(key, label, hint = null, { requires = null, min, max, step = 1, suffix = null, describe = null } = {}) {
    const id = fieldId('opt');
    const input = el('input.input.opt-number', { type: 'number', id, min, max, step, inputmode: 'decimal' });
    const note = el('span.opt-hint', {}, say(hint) || '');
    const show = () => { input.value = String(appOptions()[key]); if (describe) note.textContent = describe(appOptions()[key]); };
    input.addEventListener('change', () => {
      if (input.value.trim() === '') { show(); return; }
      set({ [key]: input.value });
    });
    syncs.push(show);
    show();
    dependsOn(input, requires, key);
    return optionRow(key, [words(label), words(hint)], el('div.opt-field', {}, el('label.opt-label', { for: id }, say(label)),
      el('span.opt-number-wrap', {}, input, suffix && el('span.opt-suffix', {}, say(suffix))), (hint || describe) && note));
  }

  function text(key, label, hint = null, { placeholder = '', list = null } = {}) {
    const id = fieldId('opt');
    const listId = list ? `${id}-list` : null;
    const input = el('input.input.opt-text', { type: 'text', id, placeholder, list: listId, autocomplete: 'off', spellcheck: false });
    input.value = appOptions()[key];
    input.addEventListener('change', () => set({ [key]: input.value }));
    syncs.push(() => { if (document.activeElement !== input) input.value = appOptions()[key]; });
    return optionRow(key, [words(label), words(hint)], el('div.opt-field', {}, el('label.opt-label', { for: id }, say(label)), input,
      list && el('datalist', { id: listId }, list.map((v) => el('option', { value: v }))), hint && el('span.opt-hint', {}, say(hint))));
  }

  /** `choices` are [value, message key] (OPTION_CHOICES). */
  function radios(key, label, { choices = OPTION_CHOICES[key], value = () => appOptions()[key], onPick = (v) => set({ [key]: v }) } = {}) {
    const name = fieldId('opt-radio');
    const inputs = choices.map(([v, text]) => {
      const input = el('input', { type: 'radio', name, value: String(v) });
      input.addEventListener('change', () => { if (input.checked) onPick(v); });
      return [input, el('label.opt-radio', {}, input, el('span', {}, say(text)))];
    });
    syncs.push(() => { for (const [input] of inputs) input.checked = input.value === String(value()); });
    for (const [input] of inputs) input.checked = input.value === String(value());
    return optionRow(key, [words(label), ...choices.map(([, text]) => words(text))], el('fieldset.opt-fieldset', {}, el('legend.opt-label', {}, say(label)), ...inputs.map(([, l]) => l)));
  }

  const button = (label, onclick, terms = []) => row([words(label), ...terms], el('div.opt-actions', {}, el('button.btn.btn-outline.btn-sm', { type: 'button', onclick }, say(label))));
  const note = (message) => el('p.opt-note', {}, say(message));

  /**
   * The display language: the browser's (the default), or one chosen here. It is read once as the app
   * opens, so a change reopens the app in place, saving or keeping the open spreadsheet first.
   */
  function languageGroup() {
    const id = fieldId('opt');
    const hintId = `${id}-hint`;
    const browser = resolveLanguage({ search: '', preference: 'auto' });
    const browserName = LANGUAGES.find((l) => l.id === browser)?.name || browser;
    const choices = [['auto', t('i18n.matchBrowser', { language: browserName })], ...LANGUAGES.map((l) => [l.id, l.name])];
    if (import.meta.env?.DEV || language() === PSEUDO_LANGUAGE) choices.push([PSEUDO_LANGUAGE, t('i18n.pseudo')]);
    const note = el('span.opt-hint', { role: 'status' });
    const select = el('select.select.opt-select', {
      id, 'aria-describedby': hintId,
      onchange: async () => {
        setLanguagePreference(select.value);
        if (resolveLanguage({ search: '' }) === language()) { note.textContent = ''; return; }
        if (!await relaunch()) note.textContent = t('i18n.nextTime');
      },
    }, choices.map(([v, label]) => el('option', { value: v, selected: v === languagePreference(), lang: v === 'auto' ? null : v }, label)));
    return group('i18n.group',
      row(['language display interface translate chinese english 语言 中文', ...choices.map(([, label]) => label)],
        el('div.opt-field', {}, el('label.opt-label', { for: id }, t('i18n.displayLanguage')), select,
          el('span.opt-hint', { id: hintId }, t('i18n.displayLanguageHint')), note)));
  }

  /* ---------- Pages ---------- */

  const pages = {
    general() {
      const theme = currentTheme();
      const themeId = fieldId('opt');
      const themes = [['system', 'optionsDialog.general.themeSystem'], ['light', 'optionsDialog.general.themeLight'], ['dark', 'optionsDialog.general.themeDark']];
      const themeSelect = el('select.select.opt-select', { id: themeId, onchange: () => session.setTheme(themeSelect.value) },
        themes.map(([v, label]) => el('option', { value: v, selected: v === theme }, t(label))));
      const account = ctx.accountName?.() || '';
      return [
        languageGroup(),
        group('optionsDialog.general.appearance',
          row(['theme appearance dark light', words('optionsDialog.general.theme'), ...themes.map(([, label]) => words(label))],
            el('div.opt-field', {}, el('label.opt-label', { for: themeId }, t('optionsDialog.general.theme')), themeSelect)),
          ctx.openLocale && button('optionsDialog.general.regionalFormat', () => ctx.openLocale(), ['locale number date format region'])),
        group('optionsDialog.general.startingUp',
          check('startScreen', 'optionsDialog.general.startScreen', 'optionsDialog.general.startScreenHint')),
        group('optionsDialog.groups.newWorkbooks',
          text('fontName', 'optionsDialog.general.font', 'optionsDialog.general.fontHint', { list: FONTS }),
          number('fontSize', 'optionsDialog.general.fontSize', null, { min: 1, max: 409, step: 0.5, suffix: 'optionsDialog.general.points' }),
          number('newSheets', 'optionsDialog.general.newSheets', null, { min: 1, max: 255 }),
          choose('newView', 'optionsDialog.general.newView', 'optionsDialog.general.newViewHint')),
        group('optionsDialog.general.yourName',
          text('userName', 'optionsDialog.general.userName', account ? ['optionsDialog.general.userNameHintAccount', { account }] : 'optionsDialog.general.userNameHint', { placeholder: account })),
      ];
    },

    formulas() {
      const wb = ctx.wb;
      const iter = () => wb?.iteration || { iterate: false, iterateCount: 100, iterateDelta: 0.001 };
      const iterateId = fieldId('opt');
      const iterate = el('input', { type: 'checkbox', id: iterateId });
      const count = el('input.input.opt-number', { type: 'number', min: 1, max: 32767, step: 1, 'aria-label': t('optionsDialog.formulas.mostIterations') });
      const delta = el('input.input.opt-number', { type: 'number', min: 0, step: 0.001, 'aria-label': t('optionsDialog.formulas.largestChange') });
      const syncIter = () => {
        if (!wb) return;
        const it = iter();
        iterate.checked = !!wb.iteration;
        count.value = String(it.iterateCount); delta.value = String(it.iterateDelta);
        count.disabled = delta.disabled = !wb.iteration;
      };
      // As the other number options take them: a box left empty keeps its value, and a number past the limits stops at
      // the nearest one (Excel's most is 32,767 rounds). The workbook takes anything else as no number, and 100 rounds.
      const within = (input, now, min, max, whole) => {
        const n = input.value.trim() ? Number(input.value) : NaN;
        return Number.isFinite(n) ? Math.min(max, Math.max(min, whole ? Math.round(n) : n)) : now;
      };
      const commitIter = () => {
        const it = iter();
        wb.setIteration(iterate.checked ? { iterate: true, iterateCount: within(count, it.iterateCount, 1, 32767, true), iterateDelta: within(delta, it.iterateDelta, 0, Infinity, false) } : null);
        syncIter();
        ctx.afterCalcChange?.();
      };
      iterate.addEventListener('change', commitIter);
      count.addEventListener('change', commitIter);
      delta.addEventListener('change', commitIter);
      syncs.push(syncIter);
      syncIter();
      // A rule's label is a message key, or (from code not yet translated) its English words.
      const errBox = (key, label) => {
        const id = fieldId('opt');
        const [shown, english] = hasMessage(label) ? [t(label), tSource(label)] : [label, label];
        const input = el('input', { type: 'checkbox', id });
        input.checked = !!errorCheckingOptions()[key];
        input.addEventListener('change', () => { saveErrorChecking({ [key]: input.checked }); ctx.afterErrorChecking?.(); syncAll(); });
        syncs.push(() => { input.checked = !!errorCheckingOptions()[key]; if (key !== 'enabled') input.disabled = !errorCheckingOptions().enabled; });
        const node = row([shown, english, 'error checking rule'], el('div.opt-check', {}, input, el('label.opt-check-text', { for: id }, el('span.opt-label', {}, shown))));
        node.dataset.errorRule = key; // Restore Defaults puts the rules back too
        if (key !== 'enabled') node.classList.add('opt-dependent');
        return node;
      };
      const name = ctx.docName?.() || '';
      // Away from a workbook (the start screen) only the choices for new workbooks and error checking are here.
      return [
        wb && group('optionsDialog.formulas.thisWorkbook',
          note(name ? ['optionsDialog.formulas.savedWith', { name }] : 'optionsDialog.formulas.savedWithThisWorkbook'),
          radios('calcMode', 'optionsDialog.formulas.calcMode', {
            choices: [['automatic', 'optionsDialog.formulas.calcAutomatic'], ['autoNoTable', 'optionsDialog.formulas.calcAutoNoTable'], ['manual', 'optionsDialog.formulas.calcManual']],
            value: () => wb.calcMode || 'automatic', onPick: (v) => { ctx.run('calcMode', v); syncAll(); },
          }),
          button('optionsDialog.formulas.calculateNow', () => ctx.run('recalc'), ['recalculate f9']),
          row(['iterative calculation circular references iterations change', words('optionsDialog.formulas.iterate'), words('optionsDialog.formulas.iterateHint')], el('div.opt-check', {}, iterate,
            el('label.opt-check-text', { for: iterateId }, el('span.opt-label', {}, t('optionsDialog.formulas.iterate')),
              el('span.opt-hint', {}, t('optionsDialog.formulas.iterateHint'))))),
          row(['iterations most', words('optionsDialog.formulas.mostIterations')], el('div.opt-field.opt-indent', {}, el('span.opt-label', {}, t('optionsDialog.formulas.mostIterations')), count)),
          row(['largest change', words('optionsDialog.formulas.largestChange')], el('div.opt-field.opt-indent', {}, el('span.opt-label', {}, t('optionsDialog.formulas.largestChange')), delta))),
        group('optionsDialog.groups.newWorkbooks',
          choose('newCalcMode', 'optionsDialog.formulas.newCalcMode', 'optionsDialog.formulas.newCalcModeHint')),
        group('optionsDialog.formulas.errorChecking',
          errBox('enabled', 'optionsDialog.formulas.errorCheckingEnabled'),
          ...ERROR_RULES.map(([key, label]) => errBox(key, label))),
      ];
    },

    edit() {
      return [
        group('optionsDialog.edit.enteringData',
          check('enterMove', 'optionsDialog.edit.enterMove'),
          choose('enterDirection', 'optionsDialog.edit.enterDirection', null, { requires: 'enterMove' }),
          check('fixedDecimal', 'optionsDialog.edit.fixedDecimal', 'optionsDialog.edit.fixedDecimalHint'),
          number('fixedDecimalPlaces', 'optionsDialog.edit.fixedDecimalPlaces', 'optionsDialog.edit.fixedDecimalPlacesHint', { requires: 'fixedDecimal', min: -10, max: 15 }),
          check('editInCell', 'optionsDialog.edit.editInCell', 'optionsDialog.edit.editInCellHint'),
          check('autoComplete', 'optionsDialog.edit.autoComplete', 'optionsDialog.edit.autoCompleteHint'),
          check('autoFlashFill', 'optionsDialog.edit.autoFlashFill', 'optionsDialog.edit.autoFlashFillHint'),
          check('extendLists', 'optionsDialog.edit.extendLists', 'optionsDialog.edit.extendListsHint'),
          number('yearCutoff', 'optionsDialog.edit.yearCutoff', null, { min: 2000, max: 2099, describe: (v) => t('optionsDialog.edit.yearCutoffExample', { first: expandTwoDigitYear(0, v), last: expandTwoDigitYear(99, v) }) })),
        group('optionsDialog.edit.cellsAndPointer',
          check('fillHandle', 'optionsDialog.edit.fillHandle'),
          check('overwriteAlert', 'optionsDialog.edit.overwriteAlert', null, { requires: 'fillHandle' }),
          check('pasteOptionsButton', 'optionsDialog.edit.pasteOptionsButton'),
          check('fillOptionsButton', 'optionsDialog.edit.fillOptionsButton')),
        group('optionsDialog.edit.longOperations',
          check('longOperationAlert', 'optionsDialog.edit.longOperationAlert'),
          number('longOperationCells', 'optionsDialog.edit.longOperationCells', null, { requires: 'longOperationAlert', min: 1, max: 100000, suffix: 'optionsDialog.edit.thousandCells' })),
      ];
    },

    view() {
      return [
        group('optionsDialog.view.showInWindow',
          check('showFormulaBar', 'optionsDialog.view.formulaBar'),
          check('showStatusBar', 'optionsDialog.view.statusBar'),
          check('showSheetTabs', 'optionsDialog.view.sheetTabs'),
          check('showHScroll', 'optionsDialog.view.hScroll'),
          check('showVScroll', 'optionsDialog.view.vScroll')),
        group('optionsDialog.view.newSheets',
          check('showHeaders', 'optionsDialog.view.showHeaders', 'optionsDialog.view.showHeadersHint')),
        group('optionsDialog.view.commentsAndNotes',
          radios('commentIndicators', 'optionsDialog.view.commentIndicators')),
        group('optionsDialog.view.objects',
          radios('showObjects', 'optionsDialog.view.showObjects', { choices: [[true, 'optionsDialog.view.showAll'], [false, 'optionsDialog.view.hideAll']], value: () => appOptions().showObjects, onPick: (v) => set({ showObjects: v === true || v === 'true' }) })),
      ];
    },

    proofing() {
      const spell = ctx.flags?.()?.spell !== false;
      const spellId = fieldId('opt');
      const spellBox = el('input', { type: 'checkbox', id: spellId, checked: spell, onchange: () => ctx.run('toggleSpellcheck') });
      return [
        group('optionsDialog.proofing.autoCorrect',
          note('optionsDialog.proofing.autoCorrectNote'),
          button('optionsDialog.proofing.autoCorrectOptions', () => ctx.run('autoCorrectOptions'), ['autocorrect replace typo capitalize'])),
        group('optionsDialog.proofing.spelling',
          row(['spelling check as you type underline', words('optionsDialog.proofing.spellAsYouType')], el('div.opt-check', {}, spellBox, el('label.opt-check-text', { for: spellId }, el('span.opt-label', {}, t('optionsDialog.proofing.spellAsYouType'))))),
          button('optionsDialog.proofing.checkSpellingNow', () => ctx.run('spelling'), ['spelling dictionary f7'])),
      ];
    },

    save() {
      return [
        group('optionsDialog.save.savingToPuter',
          check('autoSave', 'optionsDialog.save.autoSave', 'optionsDialog.save.autoSaveHint', { onChange: (on) => ctx.setAutoSave?.(on) })),
        group('optionsDialog.save.recovery',
          choose('draftDelay', 'optionsDialog.save.draftDelay', 'optionsDialog.save.draftDelayHint')),
      ];
    },

    accessibility() {
      return [
        group('optionsDialog.accessibility.seeingTheSheet',
          check('highContrastSelection', 'optionsDialog.accessibility.highContrastSelection', 'optionsDialog.accessibility.highContrastSelectionHint'),
          check('reduceMotion', 'optionsDialog.accessibility.reduceMotion', 'optionsDialog.accessibility.reduceMotionHint')),
        ctx.run && group('optionsDialog.accessibility.checkingWorkbook',
          button('optionsDialog.accessibility.checkAccessibility', () => { modal.close(); ctx.run('accessibility'); }, ['accessibility checker alt text'])),
      ].filter(Boolean);
    },

    privacy() {
      return [
        group('optionsDialog.privacy.aiFeatures',
          check('aiFeatures', 'optionsDialog.privacy.offerAiFeatures', 'optionsDialog.privacy.offerAiFeaturesHint')),
      ];
    },

    ribbon: () => [ribbonPage()],
    quickAccess: () => [quickAccessPage()],
    keyboard: () => [keyboardPage()],
  };

  /* ---------- Customization pages ---------- */

  let catalogCache = null;
  const catalog = () => (catalogCache ??= commandCatalog(ctx.flags?.() || {}, ctx.ribbon?.el || null));
  const entryOf = (id) => catalog().find((e) => e.id === id) || { id, label: id, icon: null, where: '' };

  function chooser(label, onPick) {
    const search = el('input.input.opt-search', { type: 'search', placeholder: t('optionsDialog.customize.searchCommands'), 'aria-label': t('optionsDialog.customize.searchCommands'), autocomplete: 'off' });
    const list = listbox(label, { onActivate: onPick });
    const fill = () => list.set(searchCatalog(catalog(), search.value).map((e) => ({ id: e.id, label: e.label, icon: e.icon, detail: e.where })), list.selected);
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (e) => { if (!isComposing(e) && e.key === 'ArrowDown') { e.preventDefault(); list.el.focus(); list.move(1); } });
    fill();
    return { el: el('div.opt-pane', {}, el('div.opt-pane-title', {}, label), search, list.el), list };
  }

  function quickAccessPage() {
    const from = chooser(t('optionsDialog.customize.commands'), (id) => add(id));
    const mine = listbox(t('optionsDialog.quickAccess.listLabel'), { onActivate: (id) => remove(id), reorder: (id, step) => move(id, step) });
    const qat = () => quickAccessStore.get();
    const render = (selected = mine.selected) => mine.set(qat().items.map((id) => { const e = entryOf(id); return { id, label: e.label, icon: e.icon, detail: e.where }; }), selected);
    const add = (id = from.list.selected) => { if (!id) return; const q = qat(); if (!q.items.includes(id)) quickAccessStore.set({ ...q, items: [...q.items, id] }); render(id); };
    const remove = (id = mine.selected) => { if (!id) return; const q = qat(); const at = q.items.indexOf(id); quickAccessStore.set({ ...q, items: q.items.filter((x) => x !== id) }); render(q.items[at + 1] || q.items[at - 1] || null); };
    const move = (id = mine.selected, step) => { const q = qat(); const at = q.items.indexOf(id); const to = at + step; if (at < 0 || to < 0 || to >= q.items.length) return; const items = [...q.items]; items.splice(at, 1); items.splice(to, 0, id); quickAccessStore.set({ ...q, items }); render(id); };
    const flag = (key, label) => {
      const id = fieldId('opt');
      const input = el('input', { type: 'checkbox', id, checked: !!qat()[key], onchange: () => quickAccessStore.set({ ...qat(), [key]: input.checked }) });
      syncs.push(() => { input.checked = !!qat()[key]; });
      return el('div.opt-check', {}, input, el('label.opt-check-text', { for: id }, el('span.opt-label', {}, label)));
    };
    render();
    resetCurrent = () => { quickAccessStore.set({ ...DEFAULT_QUICK_ACCESS }); render(); syncAll(); };
    return el('div.opt-customize', {},
      el('div.opt-two', {}, from.el,
        el('div.opt-transfer', {},
          el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => add() }, t('optionsDialog.customize.addArrow')),
          el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => remove() }, t('optionsDialog.customize.removeArrow'))),
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, t('optionsDialog.quickAccess.onToolbar')), mine.el,
          el('div.opt-pane-tools', {}, upDown((step) => move(mine.selected, step))))),
      el('div.opt-flags', {}, flag('below', t('optionsDialog.quickAccess.below')), flag('labels', t('optionsDialog.quickAccess.labels'))),
      note('optionsDialog.quickAccess.tip'));
  }

  function ribbonPage() {
    const builtins = builtinTabs();
    const from = chooser(t('optionsDialog.customize.commands'), () => addCmd());
    const tree = listbox(t('optionsDialog.ribbon.listLabel'), { onToggle: (id) => toggle(id), reorder: (id, step) => move(id, step) });
    const nameId = fieldId('opt');
    const nameInput = el('input.input.opt-text', { type: 'text', id: nameId, autocomplete: 'off', spellcheck: false });
    const nameRow = el('div.opt-field.opt-rename', {}, el('label.opt-label', { for: nameId }, t('common.name')), nameInput);
    const layout = () => ribbonLayoutStore.get();
    const save = (next, select) => { ribbonLayoutStore.set(next); render(select); };
    const items = () => {
      const out = [];
      for (const tab of RL.tabsIn(layout(), builtins.map((b) => b.id))) {
        // A built-in tab is known by its English name (its id) and shown by its name in the interface language.
        const builtin = tab.builtin ? builtins.find((b) => b.id === tab.id) : null;
        const renamed = tab.builtin && !!tab.renamed;
        const label = builtin && !renamed ? builtin.label : tab.name;
        out.push({ id: `tab:${tab.id}`, label, kind: 'tab', checked: !tab.hidden, icon: null, detail: tab.builtin ? (renamed ? t('optionsDialog.ribbon.renamedTab', { name: RL.builtinTabLabel(tab.id) }) : t('optionsDialog.ribbon.tab')) : t('optionsDialog.ribbon.yourTab') });
        const own = layout().groups[tab.id] || [];
        if (builtin) for (const g of builtin.groups) out.push({ id: `fixed:${tab.id}:${g.id}`, label: g.label, kind: 'fixed', depth: 1, muted: true });
        for (const g of own) {
          out.push({ id: `group:${g.id}`, label: g.name, kind: 'group', depth: 1, detail: t('optionsDialog.ribbon.yourGroup') });
          for (const c of g.commands) { const e = entryOf(c); out.push({ id: `cmd:${g.id}:${c}`, label: e.label, icon: e.icon, kind: 'cmd', depth: 2 }); }
        }
      }
      return out;
    };
    const parse = (id) => {
      if (!id) return {};
      const [kind, ...rest] = id.split(':');
      if (kind === 'tab') return { kind, tab: rest.join(':') };
      if (kind === 'group') return { kind, group: rest.join(':'), tab: RL.findGroup(layout(), rest.join(':'))?.tab };
      if (kind === 'cmd') { const [group, ...cmd] = rest; return { kind, group, cmd: cmd.join(':'), tab: RL.findGroup(layout(), group)?.tab }; }
      if (kind === 'fixed') return { kind, tab: rest[0] };
      return {};
    };
    const tabOf = (sel) => sel.tab || null;
    const groupOf = (sel) => sel.group || null;
    function render(select = tree.selected) {
      tree.set(items(), select);
      syncSelection();
    }
    function syncSelection() {
      const sel = parse(tree.selected);
      const renamable = sel.kind === 'tab' || sel.kind === 'group';
      nameRow.hidden = !renamable;
      if (renamable) {
        const name = sel.kind === 'tab' ? RL.tabsIn(layout(), builtins.map((b) => b.id)).find((b) => b.id === sel.tab)?.name : RL.findGroup(layout(), sel.group)?.group.name;
        if (document.activeElement !== nameInput) nameInput.value = name || '';
      }
      removeBtn.disabled = !(sel.kind === 'cmd' || sel.kind === 'group' || (sel.kind === 'tab' && sel.tab.startsWith('custom-')));
      newGroupBtn.disabled = !tabOf(sel);
      addBtn.disabled = !groupOf(sel) && !tabOf(sel);
    }
    tree.onSelect = syncSelection;
    nameInput.addEventListener('change', () => {
      const sel = parse(tree.selected);
      if (sel.kind === 'tab') save(RL.rename(layout(), sel.tab, nameInput.value), tree.selected);
      else if (sel.kind === 'group') save(RL.rename(layout(), sel.group, nameInput.value), tree.selected);
    });
    function toggle(id) {
      const sel = parse(id);
      if (sel.kind !== 'tab') return;
      const hidden = layout().hidden.includes(sel.tab);
      save(RL.setTabHidden(layout(), sel.tab, !hidden), id);
    }
    function move(id, step) {
      const sel = parse(id);
      if (sel.kind === 'tab') save(RL.moveTab(layout(), builtins.map((b) => b.id), sel.tab, step), id);
      else if (sel.kind === 'group') save(RL.moveGroup(layout(), sel.group, step), id);
      else if (sel.kind === 'cmd') save(RL.moveCommand(layout(), sel.group, sel.cmd, step), id);
    }
    function addCmd() {
      const cmd = from.list.selected;
      if (!cmd) return;
      const sel = parse(tree.selected);
      let next = layout();
      let target = groupOf(sel);
      // Commands go into a group of your own: on a tab with none, one is made for them.
      if (!target && tabOf(sel)) {
        target = (next.groups[sel.tab] || [])[0]?.id;
        if (!target) { next = RL.addGroup(next, sel.tab, t('optionsDialog.ribbon.newGroupName')); target = next.created.group; }
      }
      if (!target) return;
      save(RL.addCommand(next, target, cmd), `cmd:${target}:${cmd}`);
    }
    const newTabBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => {
      const sel = parse(tree.selected);
      // The names a new tab and its group start with are the person's own to change, in their language.
      const added = RL.addTab(layout(), builtins.map((b) => b.id), t('optionsDialog.ribbon.newTabName'), tabOf(sel));
      const next = RL.rename(added, added.created.group, t('optionsDialog.ribbon.newGroupName'));
      save(next, `tab:${next.created.tab}`);
      nameInput.focus(); nameInput.select();
    } }, t('optionsDialog.ribbon.newTab'));
    const newGroupBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => {
      const tab = tabOf(parse(tree.selected));
      if (!tab) return;
      const next = RL.addGroup(layout(), tab, t('optionsDialog.ribbon.newGroupName'));
      save(next, `group:${next.created.group}`);
      nameInput.focus(); nameInput.select();
    } }, t('optionsDialog.ribbon.newGroup'));
    const removeBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => {
      const sel = parse(tree.selected);
      if (sel.kind === 'cmd') save(RL.removeCommand(layout(), sel.group, sel.cmd), `group:${sel.group}`);
      else if (sel.kind === 'group') save(RL.removeItem(layout(), sel.group), sel.tab ? `tab:${sel.tab}` : null);
      else if (sel.kind === 'tab' && sel.tab.startsWith('custom-')) save(RL.removeItem(layout(), sel.tab), null);
    } }, t('common.remove'));
    const addBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: addCmd }, t('optionsDialog.customize.addArrow'));
    resetCurrent = () => { ribbonLayoutStore.set(RL.EMPTY_LAYOUT); render(null); };
    render(`tab:${builtins[0]?.id || 'Home'}`);
    return el('div.opt-customize', {},
      el('div.opt-two', {}, from.el,
        el('div.opt-transfer', {}, addBtn),
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, t('optionsDialog.ribbon.tabsPane')), tree.el,
          el('div.opt-pane-tools', {}, newTabBtn, newGroupBtn, removeBtn, upDown((step) => move(tree.selected, step))),
          nameRow)),
      note('optionsDialog.ribbon.note'));
  }

  /**
   * The built-in tabs and their groups, read off the ribbon on screen: each by its English name (its id, which the
   * customizations keep) and by the label the ribbon shows, in the interface language.
   */
  function builtinTabs() {
    const root = ctx.ribbon?.el;
    if (!root) return [];
    return [...root.querySelectorAll('.ribbon-tab[data-builtin-name]')].filter((tab) => !tab.classList.contains('ribbon-context-tab')).map((tab) => {
      const panel = [...root.querySelectorAll('.ribbon-panel')].find((node) => node.id === tab.getAttribute('aria-controls'));
      const groups = panel ? [...panel.querySelectorAll('.ribbon-group:not([data-custom-group])')]
        .map((g) => ({ id: g.dataset.groupName || g.getAttribute('aria-label'), label: g.getAttribute('aria-label') || g.dataset.groupName }))
        .filter((g) => g.id) : [];
      const id = tab.dataset.builtinName;
      // A tab renamed by the person shows their name; its own label is kept in data-builtin-label where the ribbon gives one.
      const label = tab.dataset.builtinLabel || RL.builtinTabLabel(id);
      return { id, label, groups };
    });
  }

  function keyboardPage() {
    const shortcuts = () => builtinShortcuts(catalog());
    const keymap = () => keymapStore.get();
    const keysOf = (id) => chordsFor(id, shortcuts().byId[id] || [], keymap());
    const search = el('input.input.opt-search', { type: 'search', placeholder: t('optionsDialog.keyboard.searchPlaceholder'), 'aria-label': t('optionsDialog.customize.searchCommands'), autocomplete: 'off' });
    const list = listbox(t('optionsDialog.keyboard.listLabel'), {});
    const fill = (select = list.selected) => list.set(searchCatalog(catalog(), search.value)
      .map((e) => ({ id: e.id, label: e.label, icon: e.icon, detail: e.where, keys: keysOf(e.id).map((c) => formatChord(c, IS_MAC)) })), select);
    search.addEventListener('input', () => fill());
    search.addEventListener('keydown', (e) => { if (!isComposing(e) && e.key === 'ArrowDown') { e.preventDefault(); list.el.focus(); list.move(1); } });

    const title = el('div.opt-key-title');
    const where = el('div.opt-hint');
    const chips = el('div.opt-key-chips', { role: 'list', 'aria-label': t('optionsDialog.keyboard.chipsLabel') });
    const captureId = fieldId('opt');
    const capture = el('input.input.opt-key-capture', { type: 'text', id: captureId, readonly: true, placeholder: t('optionsDialog.keyboard.pressKeys'), 'aria-describedby': `${captureId}-msg` });
    const message = el('div.opt-key-message', { id: `${captureId}-msg`, 'aria-live': 'polite' });
    const assign = el('button.btn.btn-primary.btn-sm', { type: 'button', disabled: true }, t('optionsDialog.keyboard.assign'));
    let pending = null;
    const detail = el('div.opt-key-detail', {}, title, where, chips,
      el('div.opt-field', {}, el('label.opt-label', { for: captureId }, t('optionsDialog.keyboard.newShortcut')), el('div.opt-key-new', {}, capture, assign)), message,
      el('div.opt-actions', {}, el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => resetCommand() }, t('optionsDialog.keyboard.resetCommand'))));
    const showDetail = () => {
      const id = list.selected;
      detail.hidden = !id;
      if (!id) return;
      const e = entryOf(id);
      title.textContent = e.label;
      where.textContent = e.where || '';
      const keys = keysOf(id);
      chips.replaceChildren(...(keys.length ? keys.map((chord) => el('span.opt-key-chip', { role: 'listitem' }, el('kbd', {}, formatChord(chord, IS_MAC)),
        el('button.icon-btn.opt-key-remove', { type: 'button', 'aria-label': t('optionsDialog.keyboard.removeKeys', { keys: formatChord(chord, IS_MAC) }), title: t('optionsDialog.keyboard.removeShortcut'), html: icon('x', 12, 2), onclick: () => removeChord(id, chord) })))
        : [el('span.opt-hint', { role: 'listitem' }, t('optionsDialog.keyboard.noShortcut'))]));
      pending = null; capture.value = ''; message.textContent = ''; message.className = 'opt-key-message'; assign.disabled = true;
    };
    list.onSelect = showDetail;
    capture.addEventListener('keydown', (e) => {
      if (isComposing(e)) return;
      if ((e.key === 'Tab' || e.key === 'Escape') && !e.ctrlKey && !e.metaKey && !e.altKey) return; // focus moves on; Escape closes
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Enter' && pending && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { doAssign(); return; }
      const chord = chordFromEvent(e, IS_MAC);
      if (!chord) return;
      pending = chord;
      capture.value = formatChord(chord, IS_MAC);
      const problem = chordProblem(chord);
      const others = problem ? [] : chordConflicts(chord, list.selected, keymap(), shortcuts().byChord);
      message.className = `opt-key-message${problem ? ' bad' : others.length ? ' warn' : ''}`;
      const commands = others.map((o) => entryOf(o).label).reduce((list, item) => (list === null ? item : t('optionsDialog.keyboard.listMore', { list, item })), null) ?? '';
      message.textContent = problem || (others.length ? t('optionsDialog.keyboard.takenFrom', { count: others.length, commands })
        : keysOf(list.selected).includes(chord) ? t('optionsDialog.keyboard.alreadyThis') : t('optionsDialog.keyboard.free'));
      assign.disabled = !!problem || keysOf(list.selected).includes(chord);
    });
    const doAssign = () => {
      const id = list.selected;
      if (!id || !pending || chordProblem(pending)) return;
      keymapStore.set({ ...keymap(), [pending]: id });
      fill(id); showDetail();
      message.textContent = t('optionsDialog.keyboard.assigned'); message.className = 'opt-key-message good';
    };
    assign.addEventListener('click', doAssign);
    const removeChord = (id, chord) => {
      const next = { ...keymap() };
      if (next[chord] === id) delete next[chord];
      if ((shortcuts().byChord[chord] || []).includes(id)) next[chord] = null; // a built-in shortcut is turned off
      keymapStore.set(next);
      fill(id); showDetail();
    };
    const resetCommand = () => {
      const id = list.selected;
      if (!id) return;
      const next = { ...keymap() };
      for (const [chord, to] of Object.entries(next)) if (to === id || (to === null && (shortcuts().byChord[chord] || []).includes(id))) delete next[chord];
      keymapStore.set(next);
      fill(id); showDetail();
    };
    resetCurrent = () => { keymapStore.set({}); fill(); showDetail(); };
    fill();
    showDetail();
    return el('div.opt-customize', {},
      el('div.opt-two.opt-keyboard', {},
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, t('optionsDialog.customize.commands')), search, list.el),
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, t('optionsDialog.keyboard.shortcuts')), detail)),
      note('optionsDialog.keyboard.note'));
  }

  /* ---------- The frame ---------- */

  let resetCurrent = null;
  const search = el('input.input.opt-find', { type: 'search', placeholder: t('optionsDialog.findOption'), 'aria-label': t('optionsDialog.findOption'), autocomplete: 'off' });
  const navId = fieldId('opt-nav');
  const nav = el('div.opt-nav-list', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('optionsDialog.sectionsLabel'), id: navId });
  const tabs = new Map();
  for (const s of sections) {
    const tab = el('button.opt-nav-item', { type: 'button', role: 'tab', id: `${navId}-${s.id}`, 'aria-controls': `${navId}-panel`, 'aria-selected': 'false', tabindex: -1,
      onclick: () => show(s.id) }, el('span.opt-nav-icon', { html: icon(s.icon, 18), 'aria-hidden': 'true' }), el('span', {}, t(s.title)));
    tabs.set(s.id, tab);
    nav.append(tab);
  }
  nav.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    const list = [...tabs.values()].filter((tab) => !tab.hidden);
    const at = list.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? list[(at + 1) % list.length] : e.key === 'ArrowUp' ? list[(at - 1 + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list.at(-1) : null;
    if (next) { e.preventDefault(); next.focus(); next.click(); }
  });
  const heading = el('h3.opt-title');
  const about = el('p.opt-about');
  const empty = el('p.opt-empty', { hidden: true }, t('optionsDialog.noMatch'));
  const page = el('div.opt-page', { role: 'tabpanel', id: `${navId}-panel`, tabindex: -1 });
  const resetBtn = el('button.btn.btn-ghost', { type: 'button', onclick: () => {
    if (resetCurrent) { resetCurrent(); return; }
    const keys = [...page.querySelectorAll('.opt-row[data-key]')].map((r) => r.dataset.key).filter((k) => Object.hasOwn(OPTION_DEFAULTS, k));
    if (keys.length) resetAppOptions([...new Set(keys)]);
    // The error checking rules are kept apart from the other options, but are as much this page's to put back.
    if (page.querySelector('.opt-row[data-error-rule]')) {
      saveErrorChecking({ enabled: true, ...Object.fromEntries(ERROR_RULES.map(([key, , on]) => [key, on])) });
      ctx.afterErrorChecking?.();
    }
    syncAll();
  } }, t('optionsDialog.restoreDefaults'));

  function pageFor(id) {
    if (!built.has(id)) built.set(id, el('div.opt-page-body', { dataset: { section: id } }, ...pages[id]()));
    return built.get(id);
  }

  /** Hide the rows a search does not find, and the groups left empty; true when something shows. */
  function filterPage(body, query) {
    let any = false;
    for (const g of body.querySelectorAll('.opt-group')) {
      let shown = 0;
      for (const r of g.querySelectorAll('.opt-row')) {
        const hit = !query || r.dataset.search.includes(query) || (g.dataset.search || '').includes(query);
        r.hidden = !hit;
        if (hit) shown++;
      }
      g.hidden = !shown && !!query;
      if (shown) any = true;
    }
    return any;
  }

  function sectionMatches(s, query) {
    if (!query) return true;
    if (`${words(s.title)} ${words(s.about)} ${s.keywords || ''}`.toLowerCase().includes(query)) return true;
    if (['ribbon', 'quickAccess', 'keyboard'].includes(s.id)) return false;
    return [...pageFor(s.id).querySelectorAll('.opt-row')].some((r) => r.dataset.search.includes(query));
  }

  function show(id) {
    const s = sections.find((x) => x.id === id) || sections[0];
    // The customization pages hold their own lists, made afresh when shown, so they show what the ribbon is now.
    if (['ribbon', 'quickAccess', 'keyboard'].includes(s.id)) built.delete(s.id);
    resetCurrent = null;
    current = s.id;
    for (const [key, tab] of tabs) { tab.setAttribute('aria-selected', String(key === s.id)); tab.tabIndex = key === s.id ? 0 : -1; }
    // On a phone the sections are a row that scrolls sideways: the open one is brought into it, not left out of sight.
    tabs.get(s.id).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    page.setAttribute('aria-labelledby', tabs.get(s.id).id);
    heading.textContent = t(s.title);
    about.textContent = t(s.about);
    const body = pageFor(s.id);
    page.replaceChildren(body);
    const query = search.value.trim().toLowerCase();
    const shows = ['ribbon', 'quickAccess', 'keyboard'].includes(s.id) || filterPage(body, query);
    empty.hidden = shows;
    syncAll();
    page.scrollTop = 0;
  }

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    let first = null;
    for (const s of sections) {
      const hit = sectionMatches(s, query);
      tabs.get(s.id).hidden = !hit;
      if (hit && !first) first = s.id;
    }
    show(!tabs.get(current).hidden ? current : first || current);
  });

  const content = el('div.opt-dialog', {},
    el('aside.opt-nav', {}, el('div.opt-find-wrap', {}, el('span.opt-find-icon', { html: icon('search', 15), 'aria-hidden': 'true' }), search), nav),
    el('div.opt-main', {}, el('div.opt-head', {}, heading, about), empty, page,
      el('div.opt-foot', {}, resetBtn, el('span.grow'), el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, t('common.done')))));
  const modal = openModal({ title: t('common.options'), content, wide: true, className: 'options-modal', initialFocus: search, onClose: () => { for (const off of offs) off(); ctx.onOptionsClosed?.(); } });
  // Another window (or a sync from the account) changing the customizations shows here too.
  const offs = [quickAccessStore.subscribe(() => syncAll()), keymapStore.subscribe(() => syncAll())];
  show(current);
  return Object.assign(modal, { show, body: content });
}

/* ---------- A list to pick from ---------- */

/** Up and down buttons that move the selected entry. */
function upDown(move) {
  return el('span.opt-updown', {},
    el('button.icon-btn.opt-move', { type: 'button', 'aria-label': t('optionsDialog.moveUp'), title: t('optionsDialog.moveUp'), html: icon('chevU', 16), onclick: () => move(-1) }),
    el('button.icon-btn.opt-move', { type: 'button', 'aria-label': t('optionsDialog.moveDown'), title: t('optionsDialog.moveDown'), html: icon('chevD', 16), onclick: () => move(1) }));
}

/**
 * A single-select list box: arrows move, Enter (or a double-click) activates, Space toggles an entry that has a
 * check, Alt+Up and Alt+Down reorder. Entries: { id, label, icon, detail, keys, kind, depth, checked, muted }.
 */
export function listbox(label, { onActivate = null, onToggle = null, reorder = null } = {}) {
  const box = el('div.opt-list', { role: 'listbox', tabindex: 0, 'aria-label': label });
  const base = fieldId('opt-list');
  let entries = [];
  let selected = null;
  const api = {
    el: box,
    onSelect: null,
    get selected() { return selected; },
    set(next, keep = selected) {
      entries = next;
      selected = entries.some((e) => e.id === keep) ? keep : null;
      box.replaceChildren(...entries.map((e, i) => {
        const node = el('div.opt-option', {
          role: 'option', id: `${base}-${i}`, 'aria-selected': String(e.id === selected), dataset: { id: e.id, kind: e.kind || '' },
          onclick: (ev) => { if (ev.target.closest('.opt-option-check') && onToggle) { onToggle(e.id); return; } select(e.id); },
          ondblclick: () => onActivate?.(e.id),
        },
        e.checked !== undefined && el('span.opt-option-check', { 'aria-hidden': 'true', html: e.checked ? icon('check', 13, 2.4) : '' }),
        el('span.opt-option-icon', { 'aria-hidden': 'true', html: e.icon ? icon(e.icon, 16) : '' }),
        el('span.opt-option-text', {}, el('span.opt-option-label', {}, e.label), e.detail && el('span.opt-option-detail', {}, e.detail)),
        e.keys?.length ? el('span.opt-option-keys', {}, e.keys.map((k) => el('kbd', {}, k))) : null);
        if (e.depth) node.style.paddingInlineStart = `${8 + e.depth * 18}px`;
        if (e.muted) node.classList.add('muted');
        if (e.checked !== undefined) node.setAttribute('aria-checked', String(!!e.checked));
        return node;
      }));
      mark();
    },
    move(step) {
      if (!entries.length) return;
      const at = entries.findIndex((e) => e.id === selected);
      const to = at < 0 ? (step > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, at + step));
      select(entries[to].id);
    },
    select,
  };
  function mark() {
    let active = null;
    for (const node of box.children) {
      const on = node.dataset.id === selected;
      node.setAttribute('aria-selected', String(on));
      if (on) active = node;
    }
    if (active) { box.setAttribute('aria-activedescendant', active.id); active.scrollIntoView?.({ block: 'nearest' }); } else box.removeAttribute('aria-activedescendant');
  }
  function select(id) {
    selected = id;
    mark();
    api.onSelect?.(id);
  }
  box.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && reorder && selected) { e.preventDefault(); reorder(selected, e.key === 'ArrowUp' ? -1 : 1); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); api.move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); if (entries.length) select(entries[e.key === 'Home' ? 0 : entries.length - 1].id); }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); api.move(e.key === 'PageDown' ? 10 : -10); }
    else if (e.key === 'Enter' && selected) { e.preventDefault(); onActivate?.(selected); }
    else if (e.key === ' ' && selected && onToggle) { e.preventDefault(); onToggle(selected); }
  });
  return api;
}
