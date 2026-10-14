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

export const OPTION_SECTIONS = [
  { id: 'general', title: 'General', icon: 'sliders', about: 'How the app starts, what a new workbook looks like, and your name on comments.' },
  { id: 'formulas', title: 'Formulas', icon: 'calculator', about: 'When formulas calculate, and which problems error checking points out.' },
  { id: 'edit', title: 'Editing', icon: 'pencil', about: 'Typing into cells, moving the selection, and working with the fill handle.' },
  { id: 'view', title: 'View', icon: 'eye', about: 'What the window shows around the sheet, and how comments and objects appear.' },
  { id: 'proofing', title: 'Proofing', icon: 'spell', about: 'AutoCorrect and spelling.', keywords: 'autocorrect spelling dictionary typo correct' },
  { id: 'save', title: 'Save', icon: 'save', about: 'Saving to Puter as you work, and the recovery copy kept in this browser.', keywords: 'autosave autorecover draft recovery' },
  { id: 'accessibility', title: 'Accessibility', icon: 'accessibility', about: 'Making the selection easier to see, and the screen calmer.', keywords: 'contrast motion animation selection' },
  { id: 'privacy', title: 'Privacy', icon: 'lock', about: 'Whether features that send your data to an AI service are offered.', keywords: 'ai artificial intelligence assistant' },
  { id: 'ribbon', title: 'Customize Ribbon', icon: 'customizeRibbon', about: 'Show, hide, rename and reorder tabs, and build tabs and groups of your own.', keywords: 'ribbon tab group custom commands' },
  { id: 'quickAccess', title: 'Quick Access Toolbar', icon: 'customizeQuickAccess', about: 'The commands beside the title, always one click away.', keywords: 'quick access toolbar qat commands' },
  { id: 'keyboard', title: 'Keyboard Shortcuts', icon: 'customizeKeyboard', about: 'Give any command keys of its own, or free keys for something else.', keywords: 'keyboard shortcut keys hotkey chord' },
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

  // Every row carries the words a search finds it by.
  const row = (words, ...kids) => el('div.opt-row', { dataset: { search: words.filter(Boolean).join(' ').toLowerCase() } }, ...kids);
  /** A row for one of the app's options, which Restore Defaults puts back. */
  const optionRow = (key, words, ...kids) => {
    const node = row([...words, key], ...kids);
    node.dataset.key = key;
    if (dependents.has(key)) node.classList.add('opt-dependent'); // it sits under the option it follows
    return node;
  };
  const group = (title, ...rows) => el('section.opt-group', { 'aria-label': title }, el('h4.opt-group-title', {}, title), ...rows.filter(Boolean));
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
    return optionRow(key, [label, hint], el('div.opt-check', {}, input,
      el('label.opt-check-text', { for: id }, el('span.opt-label', {}, label), hint && el('span.opt-hint', { id: `${id}-hint` }, hint))));
  }

  function choose(key, label, hint = null, { requires = null, choices = OPTION_CHOICES[key] } = {}) {
    const id = fieldId('opt');
    const select = el('select.select.opt-select', { id }, choices.map(([value, text]) => el('option', { value: String(value) }, text)));
    select.value = String(appOptions()[key]);
    select.addEventListener('change', () => set({ [key]: select.value }));
    syncs.push(() => { select.value = String(appOptions()[key]); });
    dependsOn(select, requires, key);
    return optionRow(key, [label, hint, ...choices.map(([, t]) => t)], el('div.opt-field', {},
      el('label.opt-label', { for: id }, label), select, hint && el('span.opt-hint', {}, hint)));
  }

  function number(key, label, hint = null, { requires = null, min, max, step = 1, suffix = null, describe = null } = {}) {
    const id = fieldId('opt');
    const input = el('input.input.opt-number', { type: 'number', id, min, max, step, inputmode: 'decimal' });
    const note = el('span.opt-hint', {}, hint || '');
    const show = () => { input.value = String(appOptions()[key]); if (describe) note.textContent = describe(appOptions()[key]); };
    input.addEventListener('change', () => {
      if (input.value.trim() === '') { show(); return; }
      set({ [key]: input.value });
    });
    syncs.push(show);
    show();
    dependsOn(input, requires, key);
    return optionRow(key, [label, hint], el('div.opt-field', {}, el('label.opt-label', { for: id }, label),
      el('span.opt-number-wrap', {}, input, suffix && el('span.opt-suffix', {}, suffix)), (hint || describe) && note));
  }

  function text(key, label, hint = null, { placeholder = '', list = null } = {}) {
    const id = fieldId('opt');
    const listId = list ? `${id}-list` : null;
    const input = el('input.input.opt-text', { type: 'text', id, placeholder, list: listId, autocomplete: 'off', spellcheck: false });
    input.value = appOptions()[key];
    input.addEventListener('change', () => set({ [key]: input.value }));
    syncs.push(() => { if (document.activeElement !== input) input.value = appOptions()[key]; });
    return optionRow(key, [label, hint], el('div.opt-field', {}, el('label.opt-label', { for: id }, label), input,
      list && el('datalist', { id: listId }, list.map((v) => el('option', { value: v }))), hint && el('span.opt-hint', {}, hint)));
  }

  function radios(key, label, { choices = OPTION_CHOICES[key], value = () => appOptions()[key], onPick = (v) => set({ [key]: v }) } = {}) {
    const name = fieldId('opt-radio');
    const inputs = choices.map(([v, t]) => {
      const input = el('input', { type: 'radio', name, value: String(v) });
      input.addEventListener('change', () => { if (input.checked) onPick(v); });
      return [input, el('label.opt-radio', {}, input, el('span', {}, t))];
    });
    syncs.push(() => { for (const [input] of inputs) input.checked = input.value === String(value()); });
    for (const [input] of inputs) input.checked = input.value === String(value());
    return optionRow(key, [label, ...choices.map(([, t]) => t)], el('fieldset.opt-fieldset', {}, el('legend.opt-label', {}, label), ...inputs.map(([, l]) => l)));
  }

  const button = (label, onclick, words = []) => row([label, ...words], el('div.opt-actions', {}, el('button.btn.btn-outline.btn-sm', { type: 'button', onclick }, label)));
  const note = (textContent) => el('p.opt-note', {}, textContent);

  /* ---------- Pages ---------- */

  const pages = {
    general() {
      const theme = currentTheme();
      const themeId = fieldId('opt');
      const themeSelect = el('select.select.opt-select', { id: themeId, onchange: () => session.setTheme(themeSelect.value) },
        [['system', 'Match the system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => el('option', { value: v, selected: v === theme }, t)));
      const account = ctx.accountName?.() || '';
      return [
        group('Appearance',
          row(['theme appearance dark light'], el('div.opt-field', {}, el('label.opt-label', { for: themeId }, 'Theme'), themeSelect)),
          ctx.openLocale && button('Regional format…', () => ctx.openLocale(), ['locale number date format region'])),
        group('Starting up',
          check('startScreen', 'Show the start screen when the app opens', 'Your spreadsheets and templates. Off: the app opens straight onto a new, blank workbook.')),
        group('New workbooks',
          text('fontName', 'Font', 'The Normal style of a new workbook, used by every cell not formatted otherwise.', { list: FONTS }),
          number('fontSize', 'Font size', null, { min: 1, max: 409, step: 0.5, suffix: 'pt' }),
          number('newSheets', 'Sheets in a new workbook', null, { min: 1, max: 255 }),
          choose('newView', 'Open new sheets in', 'Also used for sheets added to any workbook.')),
        group('Your name',
          text('userName', 'Name shown on your comments and changes', account ? `Leave blank to use your Puter account name, ${account}.` : 'Leave blank to use your Puter account name.', { placeholder: account })),
      ];
    },

    formulas() {
      const wb = ctx.wb;
      const iter = () => wb?.iteration || { iterate: false, iterateCount: 100, iterateDelta: 0.001 };
      const iterateId = fieldId('opt');
      const iterate = el('input', { type: 'checkbox', id: iterateId });
      const count = el('input.input.opt-number', { type: 'number', min: 1, max: 32767, step: 1, 'aria-label': 'Most iterations' });
      const delta = el('input.input.opt-number', { type: 'number', min: 0, step: 0.001, 'aria-label': 'Largest change' });
      const syncIter = () => {
        if (!wb) return;
        const it = iter();
        iterate.checked = !!wb.iteration;
        count.value = String(it.iterateCount); delta.value = String(it.iterateDelta);
        count.disabled = delta.disabled = !wb.iteration;
      };
      const commitIter = () => {
        wb.setIteration(iterate.checked ? { iterate: true, iterateCount: count.value, iterateDelta: delta.value } : null);
        syncIter();
        ctx.afterCalcChange?.();
      };
      iterate.addEventListener('change', commitIter);
      count.addEventListener('change', commitIter);
      delta.addEventListener('change', commitIter);
      syncs.push(syncIter);
      syncIter();
      const checks = { ...errorCheckingOptions() };
      const errBox = (key, label) => {
        const id = fieldId('opt');
        const input = el('input', { type: 'checkbox', id });
        input.checked = !!checks[key];
        input.addEventListener('change', () => { checks[key] = input.checked; saveErrorChecking({ [key]: input.checked }); ctx.afterErrorChecking?.(); syncAll(); });
        if (key !== 'enabled') syncs.push(() => { input.disabled = !errorCheckingOptions().enabled; });
        const node = row([label, 'error checking rule'], el('div.opt-check', {}, input, el('label.opt-check-text', { for: id }, el('span.opt-label', {}, label))));
        if (key !== 'enabled') node.classList.add('opt-dependent');
        return node;
      };
      const name = ctx.docName?.() || 'this workbook';
      // Away from a workbook (the start screen) only the choices for new workbooks and error checking are here.
      return [
        wb && group('Calculation in this workbook',
          note(`Saved with “${name}”, and the same for everyone who opens it.`),
          radios('calcMode', 'Calculate formulas', {
            choices: [['automatic', 'Automatically, after every change'], ['manual', 'Only when asked (F9)']],
            value: () => wb.calcMode || 'automatic', onPick: (v) => { ctx.run('calcMode', v); syncAll(); },
          }),
          button('Calculate now', () => ctx.run('recalc'), ['recalculate f9']),
          row(['iterative calculation circular references iterations change'], el('div.opt-check', {}, iterate,
            el('label.opt-check-text', { for: iterateId }, el('span.opt-label', {}, 'Allow circular references, calculated by iteration'),
              el('span.opt-hint', {}, 'Each round recalculates the circle until no value moves by more than the largest change.')))),
          row(['iterations most'], el('div.opt-field.opt-indent', {}, el('span.opt-label', {}, 'Most iterations'), count)),
          row(['largest change'], el('div.opt-field.opt-indent', {}, el('span.opt-label', {}, 'Largest change'), delta))),
        group('New workbooks',
          choose('newCalcMode', 'New workbooks calculate', 'Your choice for workbooks you create; a workbook you open keeps its own.')),
        group('Error checking',
          errBox('enabled', 'Check for errors in the background'),
          ...ERROR_RULES.map(([key, label]) => errBox(key, label))),
      ];
    },

    edit() {
      return [
        group('Entering data',
          check('enterMove', 'After pressing Enter, move the selection'),
          choose('enterDirection', 'Direction', null, { requires: 'enterMove' }),
          check('fixedDecimal', 'Put in a decimal point automatically', 'Whole numbers typed without a point get these places: 1234 becomes 12.34.'),
          number('fixedDecimalPlaces', 'Places', 'A negative number adds zeros instead: −2 makes 5 into 500.', { requires: 'fixedDecimal', min: -10, max: 15 }),
          check('editInCell', 'Edit directly in cells', 'Off: F2 and double-clicking edit in the formula bar.'),
          check('autoComplete', 'Suggest the rest of an entry from the column', 'AutoComplete fills in a match from the cells above as you type.'),
          check('autoFlashFill', 'Offer Flash Fill as you type', 'After a few examples that follow a pattern, offer to fill the rest of the column.'),
          check('extendLists', 'Carry a list’s formats and formulas onto new rows', 'Typing under a list formats the new cell like the rows above, and fills in formulas the list repeats.'),
          number('yearCutoff', 'Read two-digit years up to', null, { min: 2000, max: 2099, describe: (v) => `So 00 is ${expandTwoDigitYear(0, v)}, and 99 is ${expandTwoDigitYear(99, v)}.` })),
        group('Cells and the pointer',
          check('fillHandle', 'Use the fill handle, and drag cells to move or copy them'),
          check('overwriteAlert', 'Ask before a drag replaces cells that hold data', null, { requires: 'fillHandle' }),
          check('pasteOptionsButton', 'Show the Paste Options button after pasting'),
          check('fillOptionsButton', 'Show the Auto Fill Options button after filling')),
        group('Long operations',
          check('longOperationAlert', 'Ask before a command that changes very many cells'),
          number('longOperationCells', 'When it changes more than', null, { requires: 'longOperationAlert', min: 1, max: 100000, suffix: 'thousand cells' })),
      ];
    },

    view() {
      return [
        group('Show in the window',
          check('showFormulaBar', 'Formula bar'),
          check('showStatusBar', 'Status bar'),
          check('showSheetTabs', 'Sheet tabs'),
          check('showHScroll', 'Horizontal scroll bar'),
          check('showVScroll', 'Vertical scroll bar')),
        group('New sheets',
          check('showHeaders', 'Show row and column headers', 'Each sheet keeps its own setting (View ▸ Row and column headers).')),
        group('Comments and notes',
          radios('commentIndicators', 'For cells with comments or notes, show')),
        group('Objects',
          radios('showObjects', 'Charts, pictures, shapes and text boxes', { choices: [[true, 'Show all'], [false, 'Hide all']], value: () => appOptions().showObjects, onPick: (v) => set({ showObjects: v === true || v === 'true' }) })),
      ];
    },

    proofing() {
      const spell = ctx.flags?.()?.spell !== false;
      const spellId = fieldId('opt');
      const spellBox = el('input', { type: 'checkbox', id: spellId, checked: spell, onchange: () => ctx.run('toggleSpellcheck') });
      return [
        group('AutoCorrect',
          note('AutoCorrect fixes common typing slips and expands shorthand as you type.'),
          button('AutoCorrect Options…', () => ctx.run('autoCorrectOptions'), ['autocorrect replace typo capitalize'])),
        group('Spelling',
          row(['spelling check as you type underline'], el('div.opt-check', {}, spellBox, el('label.opt-check-text', { for: spellId }, el('span.opt-label', {}, 'Check spelling as you type')))),
          button('Check Spelling Now…', () => ctx.run('spelling'), ['spelling dictionary f7'])),
      ];
    },

    save() {
      return [
        group('Saving to Puter',
          check('autoSave', 'Turn AutoSave on by default', 'Saves your changes a moment after you make them. The switch beside the title turns it off for this device.', { onChange: (on) => ctx.setAutoSave?.(on) })),
        group('Recovery',
          choose('draftDelay', 'Keep a recovery copy of unsaved edits in this browser', 'If the tab closes or the connection drops before a save, the edits come back from this copy.')),
      ];
    },

    accessibility() {
      return [
        group('Seeing the sheet',
          check('highContrastSelection', 'Make the selection stand out more', 'A thicker, higher-contrast outline and fill around the selected cells.'),
          check('reduceMotion', 'Reduce motion', 'Turns off animations and smooth scrolling in the app.')),
        ctx.run && group('Checking a workbook',
          button('Check Accessibility', () => { modal.close(); ctx.run('accessibility'); }, ['accessibility checker alt text'])),
      ].filter(Boolean);
    },

    privacy() {
      return [
        group('AI features',
          check('aiFeatures', 'Offer AI features', 'The AI assistant, Write a formula with AI and the AI() function send the cells and words you give them to Puter’s AI service. Off: they are hidden and nothing is sent.')),
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
    const search = el('input.input.opt-search', { type: 'search', placeholder: 'Search commands', 'aria-label': `Search ${label.toLowerCase()}`, autocomplete: 'off' });
    const list = listbox(label, { onActivate: onPick });
    const fill = () => list.set(searchCatalog(catalog(), search.value).map((e) => ({ id: e.id, label: e.label, icon: e.icon, detail: e.where })), list.selected);
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (e) => { if (!isComposing(e) && e.key === 'ArrowDown') { e.preventDefault(); list.el.focus(); list.move(1); } });
    fill();
    return { el: el('div.opt-pane', {}, el('div.opt-pane-title', {}, label), search, list.el), list };
  }

  function quickAccessPage() {
    const from = chooser('Commands', (id) => add(id));
    const mine = listbox('Quick Access Toolbar commands', { onActivate: (id) => remove(id), reorder: (id, step) => move(id, step) });
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
          el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => add() }, 'Add ›'),
          el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => remove() }, '‹ Remove')),
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, 'On the Quick Access Toolbar'), mine.el,
          el('div.opt-pane-tools', {}, upDown((step) => move(mine.selected, step))))),
      el('div.opt-flags', {}, flag('below', 'Show the toolbar below the ribbon'), flag('labels', 'Show command names beside their icons')),
      note('Tip: right-click any ribbon button and choose Add to Quick Access Toolbar.'));
  }

  function ribbonPage() {
    const builtins = builtinTabs();
    const from = chooser('Commands', () => addCmd());
    const tree = listbox('Ribbon tabs and groups', { onToggle: (id) => toggle(id), reorder: (id, step) => move(id, step) });
    const nameId = fieldId('opt');
    const nameInput = el('input.input.opt-text', { type: 'text', id: nameId, autocomplete: 'off', spellcheck: false });
    const nameRow = el('div.opt-field.opt-rename', {}, el('label.opt-label', { for: nameId }, 'Name'), nameInput);
    const layout = () => ribbonLayoutStore.get();
    const save = (next, select) => { ribbonLayoutStore.set(next); render(select); };
    const items = () => {
      const out = [];
      for (const tab of RL.tabsIn(layout(), builtins.map((t) => t.id))) {
        out.push({ id: `tab:${tab.id}`, label: tab.name, kind: 'tab', checked: !tab.hidden, icon: null, detail: tab.builtin ? (tab.name !== tab.id ? `${tab.id} tab, renamed` : 'Tab') : 'Your tab' });
        const own = layout().groups[tab.id] || [];
        if (tab.builtin) for (const g of builtins.find((t) => t.id === tab.id)?.groups || []) out.push({ id: `fixed:${tab.id}:${g}`, label: g, kind: 'fixed', depth: 1, muted: true });
        for (const g of own) {
          out.push({ id: `group:${g.id}`, label: g.name, kind: 'group', depth: 1, detail: 'Your group' });
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
        const name = sel.kind === 'tab' ? RL.tabsIn(layout(), builtins.map((t) => t.id)).find((t) => t.id === sel.tab)?.name : RL.findGroup(layout(), sel.group)?.group.name;
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
      if (sel.kind === 'tab') save(RL.moveTab(layout(), builtins.map((t) => t.id), sel.tab, step), id);
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
        if (!target) { next = RL.addGroup(next, sel.tab); target = next.created.group; }
      }
      if (!target) return;
      save(RL.addCommand(next, target, cmd), `cmd:${target}:${cmd}`);
    }
    const newTabBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => {
      const sel = parse(tree.selected);
      const next = RL.addTab(layout(), builtins.map((t) => t.id), 'New Tab', tabOf(sel));
      save(next, `tab:${next.created.tab}`);
      nameInput.focus(); nameInput.select();
    } }, 'New Tab');
    const newGroupBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => {
      const tab = tabOf(parse(tree.selected));
      if (!tab) return;
      const next = RL.addGroup(layout(), tab);
      save(next, `group:${next.created.group}`);
      nameInput.focus(); nameInput.select();
    } }, 'New Group');
    const removeBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => {
      const sel = parse(tree.selected);
      if (sel.kind === 'cmd') save(RL.removeCommand(layout(), sel.group, sel.cmd), `group:${sel.group}`);
      else if (sel.kind === 'group') save(RL.removeItem(layout(), sel.group), sel.tab ? `tab:${sel.tab}` : null);
      else if (sel.kind === 'tab' && sel.tab.startsWith('custom-')) save(RL.removeItem(layout(), sel.tab), null);
    } }, 'Remove');
    const addBtn = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: addCmd }, 'Add ›');
    resetCurrent = () => { ribbonLayoutStore.set(RL.EMPTY_LAYOUT); render(null); };
    render(`tab:${builtins[0]?.id || 'Home'}`);
    return el('div.opt-customize', {},
      el('div.opt-two', {}, from.el,
        el('div.opt-transfer', {}, addBtn),
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, 'Tabs (tick to show)'), tree.el,
          el('div.opt-pane-tools', {}, newTabBtn, newGroupBtn, removeBtn, upDown((step) => move(tree.selected, step))),
          nameRow)),
      note('Built-in groups stay as they are; put any command in a group of your own, on any tab. Space shows or hides the selected tab.'));
  }

  /** The built-in tabs and their groups, read off the ribbon on screen. */
  function builtinTabs() {
    const root = ctx.ribbon?.el;
    if (!root) return [];
    return [...root.querySelectorAll('.ribbon-tab[data-builtin-name]')].filter((tab) => !tab.classList.contains('ribbon-context-tab')).map((tab) => {
      const panel = [...root.querySelectorAll('.ribbon-panel')].find((node) => node.id === tab.getAttribute('aria-controls'));
      const groups = panel ? [...panel.querySelectorAll('.ribbon-group:not([data-custom-group])')].map((g) => g.getAttribute('aria-label')).filter(Boolean) : [];
      return { id: tab.dataset.builtinName, groups };
    });
  }

  function keyboardPage() {
    const shortcuts = () => builtinShortcuts(catalog());
    const keymap = () => keymapStore.get();
    const keysOf = (id) => chordsFor(id, shortcuts().byId[id] || [], keymap());
    const search = el('input.input.opt-search', { type: 'search', placeholder: 'Search commands or keys', 'aria-label': 'Search commands', autocomplete: 'off' });
    const list = listbox('Commands and their shortcuts', {});
    const fill = (select = list.selected) => list.set(searchCatalog(catalog(), search.value)
      .map((e) => ({ id: e.id, label: e.label, icon: e.icon, detail: e.where, keys: keysOf(e.id).map((c) => formatChord(c, IS_MAC)) })), select);
    search.addEventListener('input', () => fill());
    search.addEventListener('keydown', (e) => { if (!isComposing(e) && e.key === 'ArrowDown') { e.preventDefault(); list.el.focus(); list.move(1); } });

    const title = el('div.opt-key-title');
    const where = el('div.opt-hint');
    const chips = el('div.opt-key-chips', { role: 'list', 'aria-label': 'Shortcuts for this command' });
    const captureId = fieldId('opt');
    const capture = el('input.input.opt-key-capture', { type: 'text', id: captureId, readonly: true, placeholder: 'Press the keys', 'aria-describedby': `${captureId}-msg` });
    const message = el('div.opt-key-message', { id: `${captureId}-msg`, 'aria-live': 'polite' });
    const assign = el('button.btn.btn-primary.btn-sm', { type: 'button', disabled: true }, 'Assign');
    let pending = null;
    const detail = el('div.opt-key-detail', {}, title, where, chips,
      el('div.opt-field', {}, el('label.opt-label', { for: captureId }, 'New shortcut'), el('div.opt-key-new', {}, capture, assign)), message,
      el('div.opt-actions', {}, el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => resetCommand() }, 'Reset this command')));
    const showDetail = () => {
      const id = list.selected;
      detail.hidden = !id;
      if (!id) return;
      const e = entryOf(id);
      title.textContent = e.label;
      where.textContent = e.where || '';
      const keys = keysOf(id);
      chips.replaceChildren(...(keys.length ? keys.map((chord) => el('span.opt-key-chip', { role: 'listitem' }, el('kbd', {}, formatChord(chord, IS_MAC)),
        el('button.icon-btn.opt-key-remove', { type: 'button', 'aria-label': `Remove ${formatChord(chord, IS_MAC)}`, title: 'Remove this shortcut', html: icon('x', 12, 2), onclick: () => removeChord(id, chord) })))
        : [el('span.opt-hint', { role: 'listitem' }, 'No shortcut')]));
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
      message.textContent = problem || (others.length ? `Now runs ${others.map((o) => entryOf(o).label).join(', ')}. Assigning takes it from ${others.length > 1 ? 'them' : 'it'}.`
        : keysOf(list.selected).includes(chord) ? 'Already a shortcut for this command.' : 'Free to use.');
      assign.disabled = !!problem || keysOf(list.selected).includes(chord);
    });
    const doAssign = () => {
      const id = list.selected;
      if (!id || !pending || chordProblem(pending)) return;
      keymapStore.set({ ...keymap(), [pending]: id });
      fill(id); showDetail();
      message.textContent = 'Assigned.'; message.className = 'opt-key-message good';
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
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, 'Commands'), search, list.el),
        el('div.opt-pane', {}, el('div.opt-pane-title', {}, 'Shortcuts'), detail)),
      note('Shortcuts you add work on the sheet and in the menus, and the menus show them. A shortcut must use Ctrl, ⌘, Alt or Option, or be a function key.'));
  }

  /* ---------- The frame ---------- */

  let resetCurrent = null;
  const search = el('input.input.opt-find', { type: 'search', placeholder: 'Find an option', 'aria-label': 'Find an option', autocomplete: 'off' });
  const navId = fieldId('opt-nav');
  const nav = el('div.opt-nav-list', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Sections', id: navId });
  const tabs = new Map();
  for (const s of sections) {
    const tab = el('button.opt-nav-item', { type: 'button', role: 'tab', id: `${navId}-${s.id}`, 'aria-controls': `${navId}-panel`, 'aria-selected': 'false', tabindex: -1,
      onclick: () => show(s.id) }, el('span.opt-nav-icon', { html: icon(s.icon, 18), 'aria-hidden': 'true' }), el('span', {}, s.title));
    tabs.set(s.id, tab);
    nav.append(tab);
  }
  nav.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    const list = [...tabs.values()].filter((t) => !t.hidden);
    const at = list.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? list[(at + 1) % list.length] : e.key === 'ArrowUp' ? list[(at - 1 + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list.at(-1) : null;
    if (next) { e.preventDefault(); next.focus(); next.click(); }
  });
  const heading = el('h3.opt-title');
  const about = el('p.opt-about');
  const empty = el('p.opt-empty', { hidden: true }, 'No option matches. Try another word.');
  const page = el('div.opt-page', { role: 'tabpanel', id: `${navId}-panel`, tabindex: -1 });
  const resetBtn = el('button.btn.btn-ghost', { type: 'button', onclick: () => {
    if (resetCurrent) { resetCurrent(); return; }
    const keys = [...page.querySelectorAll('.opt-row[data-key]')].map((r) => r.dataset.key).filter((k) => Object.hasOwn(OPTION_DEFAULTS, k));
    if (keys.length) resetAppOptions([...new Set(keys)]);
    syncAll();
  } }, 'Restore Defaults');

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
        const hit = !query || r.dataset.search.includes(query) || (g.getAttribute('aria-label') || '').toLowerCase().includes(query);
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
    if (`${s.title} ${s.about} ${s.keywords || ''}`.toLowerCase().includes(query)) return true;
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
    page.setAttribute('aria-labelledby', tabs.get(s.id).id);
    heading.textContent = s.title;
    about.textContent = s.about;
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
      el('div.opt-foot', {}, resetBtn, el('span.grow'), el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, 'Done'))));
  const modal = openModal({ title: 'Options', content, wide: true, className: 'options-modal', initialFocus: search, onClose: () => { for (const off of offs) off(); ctx.onOptionsClosed?.(); } });
  // Another window (or a sync from the account) changing the customizations shows here too.
  const offs = [quickAccessStore.subscribe(() => syncAll()), keymapStore.subscribe(() => syncAll())];
  show(current);
  return Object.assign(modal, { show, body: content });
}

/* ---------- A list to pick from ---------- */

/** Up and down buttons that move the selected entry. */
function upDown(move) {
  return el('span.opt-updown', {},
    el('button.icon-btn.opt-move', { type: 'button', 'aria-label': 'Move up', title: 'Move up', html: icon('chevU', 16), onclick: () => move(-1) }),
    el('button.icon-btn.opt-move', { type: 'button', 'aria-label': 'Move down', title: 'Move down', html: icon('chevD', 16), onclick: () => move(1) }));
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
