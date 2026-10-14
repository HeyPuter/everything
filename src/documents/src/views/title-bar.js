import { el, isComposing, MOD_KEY, IS_MAC } from '../ui/dom.js';
import { openMenu, closeMenu } from '../ui/menu.js';
import { openPopover } from '../ui/popover.js';
import { createMenubar } from '../ui/menubar.js';
import { command, small, commandIconEl } from '../ui/ribbon.js';
import { searchEntries } from '../ui/command-index.js';
import { localStore } from '../lib/storage.js';

const QUICK_STORE = 'documents:quick-access';
const RECENT_STORE = 'documents:recent-commands';
export const DEFAULT_QUICK = ['home', 'save', 'undo', 'redo', 'print'];
export const EDITING_MODES = [
  ['editing', 'Editing', 'pencil', 'Edit the document directly.'],
  ['reviewing', 'Reviewing', 'trackChanges', 'Edits become tracked changes.'],
  ['viewing', 'Viewing', 'readMode', 'Read and comment without changing the text.'],
];

function readList(key, fallback) {
  try { const value = JSON.parse(localStore()?.getItem(key) || 'null'); return Array.isArray(value) ? value.filter(v => typeof v === 'string') : fallback; } catch { return fallback; }
}
function writeList(key, list) { try { localStore()?.setItem(key, JSON.stringify(list)); } catch { /* storage unavailable */ } }

/**
 * The title bar: AutoSave, the quick access toolbar (customizable), the classic menu bar, the document's
 * name with its details, and on the right the command search box, the Editing / Reviewing / Viewing
 * switch, Comments, Share and the account button.
 */
export function createTitleBar({ w, c, a, local, title, status, account, menus, focusEditor, entries, openShortcuts, keymapShortcut = () => null }) {
  /* ---- Quick access ---- */
  small(c.undo, { icon: 'undo' }); small(c.redo, { icon: 'redo' });
  const homeButton = command('All Documents', 'home', () => a.goHome?.());
  const saveQuick = command(local ? 'Download .docx' : 'Save', 'save', () => (local ? c.exportButton : c.saveButton).click(), { shortcut: local ? null : `${MOD_KEY}+S` });
  const printQuick = command('Print', 'print', () => c.printButton.click(), { shortcut: `${MOD_KEY}+P` });
  // Undo's arrow lists what can be undone; choosing an entry undoes it and everything after it.
  const undoArrow = el('button.ribbon-split-arrow.ed-undo-arrow', { type: 'button', 'aria-label': 'Undo history', title: 'Undo history', 'aria-haspopup': 'menu',
    onclick: e => {
      const list = w.undoHistory?.() || [];
      openMenu({ anchor: undoArrow, label: 'Undo history', minWidth: 220, pointer: !!e.detail, onClose: e.detail ? focusEditor : null,
        items: list.length ? list.slice(0, 20).map((label, i) => ({ label: i === 0 ? `Undo ${label}` : `Undo ${i + 1} actions (to ${label})`, onSelect: () => { focusEditor(); w.undoSteps?.(i + 1); } }))
          : [{ note: 'Nothing to undo.' }] });
    } }, el('span.ribbon-caret', { 'aria-hidden': 'true' }));
  undoArrow.addEventListener('mousedown', e => e.preventDefault());
  const undoSplit = el('span.ribbon-split.is-small.ed-undo-split', {}, c.undo, undoArrow);
  const optional = {
    new: () => command('New Document', 'filePlus', () => a.newDocument?.()),
    open: () => command('Open', 'folderOpen', () => a.openDocument?.(), { shortcut: `${MOD_KEY}+O` }),
    find: () => command('Find', 'find', () => a.openSearch?.(), { shortcut: `${MOD_KEY}+F` }),
    spelling: () => w.spelling && command('Spelling', 'spelling', () => w.spelling(), { shortcut: 'F7' }),
    pdf: () => w.savePdf && command('Save as PDF', 'pdf', () => w.savePdf()),
    marks: () => w.toggleMarks && command('Show Formatting Marks', 'pilcrow', () => w.toggleMarks(), { shortcut: `${MOD_KEY}+8` }),
    comment: () => w.newComment && command('New Comment', 'newComment', () => w.newComment()),
    track: () => w.toggleTracking && command('Track Changes', 'trackChanges', () => w.toggleTracking(), { shortcut: `${MOD_KEY}+Shift+E` }),
    wordCount: () => w.wordCount && command('Word Count', 'wordCount', () => w.wordCount()),
    readAloud: () => w.readAloud && command('Read Aloud', 'readAloud', () => w.readAloud()),
    repeat: () => w.repeat && command('Repeat', 'redo', () => w.repeat(), { shortcut: 'F4' }),
  };
  const base = { home: homeButton, save: local ? null : saveQuick, undo: undoSplit, redo: c.redo, print: printQuick };
  const LABELS = { home: 'All Documents', save: 'Save', undo: 'Undo', redo: 'Redo', print: 'Print', new: 'New Document', open: 'Open', find: 'Find', spelling: 'Spelling',
    pdf: 'Save as PDF', marks: 'Show Formatting Marks', comment: 'New Comment', track: 'Track Changes', wordCount: 'Word Count', readAloud: 'Read Aloud', repeat: 'Repeat' };
  const built = new Map();
  const nodeFor = id => {
    if (Object.hasOwn(base, id)) return base[id];
    if (!built.has(id)) { const node = optional[id]?.() || null; if (node) node.addEventListener('mousedown', e => e.preventDefault()); built.set(id, node); }
    return built.get(id);
  };
  const available = () => Object.keys(LABELS).filter(id => nodeFor(id));
  let chosen = readList(QUICK_STORE, DEFAULT_QUICK).filter(id => LABELS[id]);
  const quick = el('div.ed-quick', { role: 'toolbar', 'aria-label': 'Quick access' });
  function renderQuick() {
    quick.replaceChildren(...chosen.map(nodeFor).filter(Boolean));
    refreshQuickStop();
  }
  for (const b of [homeButton, saveQuick, printQuick]) b.addEventListener('mousedown', e => e.preventDefault());
  const customize = el('button.ed-quick-customize', { type: 'button', 'aria-label': 'Customize Quick Access Toolbar', title: 'Customize Quick Access Toolbar', 'aria-haspopup': 'menu',
    onclick: e => openMenu({ anchor: customize, label: 'Customize Quick Access Toolbar', minWidth: 240, pointer: !!e.detail, onClose: e.detail ? focusEditor : null, items: [
      { header: 'Show in the title bar' },
      ...available().map(id => ({ label: LABELS[id], checked: chosen.includes(id), onSelect: () => toggleQuick(id) })),
      { separator: true },
      { label: 'Reset to Defaults', disabled: JSON.stringify(chosen) === JSON.stringify(DEFAULT_QUICK), onSelect: () => { chosen = [...DEFAULT_QUICK]; writeList(QUICK_STORE, chosen); renderQuick(); } },
    ] }) }, commandIconEl('more', 16));
  customize.addEventListener('mousedown', e => e.preventDefault());
  function toggleQuick(id) {
    const order = Object.keys(LABELS);
    chosen = chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id].sort((x, y) => order.indexOf(x) - order.indexOf(y));
    writeList(QUICK_STORE, chosen); renderQuick();
  }
  // A toolbar is one tab stop whose commands the arrow keys move between; disabled commands and those a
  // narrow window hides are passed over.
  let quickStop = null;
  const quickCommands = () => [...quick.querySelectorAll('button')].filter(b => !b.disabled && getComputedStyle(b).display !== 'none');
  function refreshQuickStop() {
    const list = quickCommands();
    if (!list.includes(quickStop)) quickStop = list[0] || null;
    for (const b of quick.querySelectorAll('button')) { const index = b === quickStop ? 0 : -1; if (b.tabIndex !== index) b.tabIndex = index; }
  }
  quick.addEventListener('focusin', e => { if (e.target.matches('button')) { quickStop = e.target; refreshQuickStop(); } });
  quick.addEventListener('keydown', e => {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey || !e.target.matches('button')) return;
    const list = quickCommands(), at = list.indexOf(e.target);
    const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (next === null || !list.length) return;
    e.preventDefault(); list[(next + list.length) % list.length].focus();
  });

  /* ---- AutoSave (documents saved to the cloud) ---- */
  const autosaveInput = el('input', { type: 'checkbox', role: 'switch', checked: w.autosaveEnabled?.() ?? true, 'aria-label': 'AutoSave',
    onchange: () => { w.setAutosave?.(autosaveInput.checked); focusEditor(); } });
  const autosave = !local && w.setAutosave ? el('label.ed-autosave', { title: 'Save every change automatically' }, el('span.ed-autosave-label', {}, 'AutoSave'), autosaveInput, el('span.ed-switch', { 'aria-hidden': 'true' })) : null;

  /* ---- Menu bar ---- */
  const menubar = createMenubar(menus.map(menu => ({ label: menu.label, open: (anchor, { pointer } = {}) => openMenu({ anchor, label: menu.label, minWidth: 240, items: menu.items(), pointer, onClose: pointer ? focusEditor : null, align: 'start' }) })), { label: 'Menu bar' });
  menubar.el.classList.add('ed-menubar');
  menubar.buttons.forEach((button, i) => { button.dataset.menu = menus[i].id; button.addEventListener('mousedown', e => { if (document.activeElement?.matches?.('.canvas-input')) e.preventDefault(); }); });
  // Narrow windows fold the menus into one button.
  const allMenus = el('button.ed-menus-button', { type: 'button', 'aria-label': 'Menus', title: 'Menus', 'aria-haspopup': 'menu',
    onclick: e => openMenu({ anchor: allMenus, label: 'Menus', minWidth: 200, pointer: !!e.detail, onClose: e.detail ? focusEditor : null,
      items: menus.map(menu => ({ label: menu.label, items: menu.items() })) }) }, commandIconEl('menus', 16));

  /* ---- Document name: rename in place, details in a popover ---- */
  const details = el('button.ed-title-details', { type: 'button', 'aria-label': 'Document details', title: 'Location and details', 'aria-haspopup': 'dialog',
    onclick: () => {
      const info = w.documentLocation?.() || { location: local ? 'This device' : 'Puter' };
      const name = el('input.input', { value: title.value, 'aria-label': 'File name', maxLength: 120 });
      const form = el('form.ed-title-popover', { onsubmit: e => { e.preventDefault(); popup.close(); if (name.value.trim() && name.value !== title.value) { title.value = name.value; title.dispatchEvent(new Event('change')); } focusEditor(); } },
        el('label.field', {}, el('span.field-label', {}, 'File name'), name),
        el('div.ed-title-location', {}, el('span.field-label', {}, 'Location'), el('span', {}, info.location || '')),
        el('div.ed-title-location', {}, el('span.field-label', {}, 'Status'), el('span', {}, status.getAttribute('aria-label') || status.textContent)),
        el('div.row.row-end', {},
          w.versionHistory ? el('button.btn.btn-ghost', { type: 'button', onclick: () => { popup.close(); w.versionHistory(); } }, 'Version History') : null,
          w.openBackstage ? el('button.btn.btn-ghost', { type: 'button', onclick: () => { popup.close(); w.openBackstage('info'); } }, 'Properties') : null,
          el('button.btn.btn-primary', { type: 'submit' }, 'Rename')));
      const popup = openPopover({ anchor: details, label: 'Document', content: form });
      queueMicrotask(() => { name.focus(); name.select(); });
    } }, el('span.ribbon-caret', { 'aria-hidden': 'true' }));

  /* ---- Command search ---- */
  const listId = 'ed-command-results';
  const searchInput = el('input.ed-search-input', { type: 'text', role: 'combobox', 'aria-label': 'Search for commands', placeholder: 'Search', autocomplete: 'off', spellcheck: false,
    'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-haspopup': 'listbox' });
  const results = el('div.ed-search-results', { id: listId, role: 'listbox', 'aria-label': 'Commands', hidden: true });
  const search = el('div.ed-search', { title: `Search for commands or text (${keymapShortcut('app.search') || ''})`.replace(' ()', '') }, commandIconEl('find', 16), searchInput, results);
  let options = [], active = -1;
  const recent = () => readList(RECENT_STORE, []);
  function render() {
    const query = searchInput.value.trim();
    const all = entries();
    let found;
    if (query) found = searchEntries(all, query, 8);
    else found = recent().map(id => all.find(e => e.id === id)).filter(Boolean).slice(0, 5);
    options = [
      ...found.map(entry => ({ entry, label: entry.label, detail: entry.path.filter(Boolean).join(' › '), shortcut: entry.shortcut, disabled: entry.disabled })),
      ...(query && a.hasDocument?.() ? [{ find: query, label: `Find “${query}” in the document`, detail: 'Search' }] : []),
      ...(!query ? [{ help: true, label: 'Keyboard shortcuts', detail: 'Help', shortcut: `${MOD_KEY}+/` }] : []),
    ];
    active = options.findIndex(o => !o.disabled);
    results.replaceChildren(
      el('div.ed-search-heading', { role: 'presentation' }, query ? 'Commands' : found.length ? 'Recently used' : 'Suggestions'),
      ...options.map((option, i) => el('div.ed-search-option', { role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === active), 'aria-disabled': option.disabled ? 'true' : null,
        onmousedown: e => e.preventDefault(), onclick: () => choose(i), onmousemove: () => setActive(i) },
      option.entry?.control?.dataset.icon || option.find ? commandIconEl(option.find ? 'find' : option.entry.control.dataset.icon, 16) : el('span.ed-search-dot', { 'aria-hidden': 'true' }),
      el('span.ed-search-label', {}, option.label), el('span.ed-search-detail', {}, option.detail || ''),
      option.shortcut ? el('span.ed-search-key', {}, option.shortcut) : null)));
    if (!options.length) results.append(el('div.ed-search-empty', {}, 'No commands match.'));
    setActive(active);
    open();
  }
  function setActive(i) {
    active = i;
    for (const [k, node] of [...results.querySelectorAll('.ed-search-option')].entries()) node.setAttribute('aria-selected', String(k === i));
    if (i >= 0) { searchInput.setAttribute('aria-activedescendant', `${listId}-${i}`); results.querySelector(`#${listId}-${i}`)?.scrollIntoView?.({ block: 'nearest' }); }
    else searchInput.removeAttribute('aria-activedescendant');
  }
  const open = () => { results.hidden = false; searchInput.setAttribute('aria-expanded', 'true'); search.classList.add('is-open'); };
  const close = () => { results.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); searchInput.removeAttribute('aria-activedescendant'); search.classList.remove('is-open'); };
  function choose(i) {
    const option = options[i]; if (!option || option.disabled) return;
    close(); searchInput.value = '';
    if (option.find) { focusEditor(); a.searchDocument ? a.searchDocument(option.find) : a.openSearch?.(); return; }
    if (option.help) { openShortcuts(); return; }
    writeList(RECENT_STORE, [option.entry.id, ...recent().filter(id => id !== option.entry.id)].slice(0, 8));
    focusEditor();
    queueMicrotask(() => option.entry.run());
  }
  searchInput.addEventListener('input', render);
  searchInput.addEventListener('focus', render);
  searchInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== searchInput) close(); }, 0));
  searchInput.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    const step = d => { if (!options.length) return; let i = active; for (let n = 0; n < options.length; n++) { i = (i + d + options.length) % options.length; if (!options[i].disabled) break; } setActive(i); };
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.hidden) render(); else step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!results.hidden && searchInput.value) { searchInput.value = ''; render(); } else { close(); searchInput.value = ''; focusEditor(); } }
  });

  /* ---- Editing mode, Comments, Share ---- */
  const modeLabel = el('span.ed-mode-label', {}, 'Editing');
  const modeIcon = el('span.ed-mode-icon', {}, commandIconEl('pencil', 16));
  const modeButton = el('button.ed-pill.ed-mode', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Editing mode: Editing', title: 'Editing mode',
    onclick: e => openMenu({ anchor: modeButton, label: 'Editing mode', minWidth: 260, align: 'end', pointer: !!e.detail, onClose: e.detail ? focusEditor : null, items: EDITING_MODES.map(([mode, label, icon, hint]) => ({
      label, icon, hint, radio: true, checked: (w.editingMode?.() || 'editing') === mode, disabled: !a.hasDocument?.() || (mode !== 'viewing' && !!w.documentReadOnly?.()) || (mode === 'reviewing' && !w.canTrack?.() && !w.isTracking?.()),
      onSelect: () => { w.setEditingMode?.(mode); focusEditor(); } })) }) }, modeIcon, modeLabel, el('span.ribbon-caret', { 'aria-hidden': 'true' }));
  modeButton.addEventListener('mousedown', e => e.preventDefault());
  const comments = w.toggleReviewingPane ? el('button.ed-pill.ed-comments-button', { type: 'button', 'aria-label': 'Comments', title: 'Comments and changes', 'aria-pressed': 'false',
    onclick: () => w.toggleReviewingPane() }, commandIconEl('comment', 16)) : null;
  comments?.addEventListener('mousedown', e => e.preventDefault());
  const shareItems = w.shareItems;
  const share = shareItems ? el('button.ed-pill.ed-share', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Share', title: 'Share',
    onclick: e => openMenu({ anchor: share, label: 'Share', minWidth: 240, align: 'end', pointer: !!e.detail, onClose: e.detail ? focusEditor : null, items: shareItems() }) },
  commandIconEl('share', 16), el('span.ed-pill-label', {}, 'Share'), el('span.ribbon-caret', { 'aria-hidden': 'true' })) : null;

  const left = el('div.ed-title-left', {}, autosave, quick, customize, menubar.el, allMenus);
  const middle = el('div.canvas-title-wrap', {}, title, details, status);
  const right = el('div.canvas-title-actions', {}, search, modeButton, comments, share, local ? c.exportButton : account);
  const node = el('div.ed-titlebar', {}, left, middle, right);
  renderQuick();

  function refresh() {
    const searchKey = keymapShortcut('app.search');
    const searchTitle = searchKey ? `Search for commands or text (${searchKey})` : 'Search for commands or text';
    if (search.title !== searchTitle) search.title = searchTitle;
    undoArrow.disabled = c.undo.disabled;
    refreshQuickStop();
    const mode = w.editingMode?.() || 'editing';
    const [, label, icon] = EDITING_MODES.find(([m]) => m === mode) || EDITING_MODES[0];
    if (modeLabel.textContent !== label) { modeLabel.textContent = label; modeIcon.replaceChildren(commandIconEl(icon, 16)); modeButton.setAttribute('aria-label', `Editing mode: ${label}`); }
    modeButton.disabled = !a.hasDocument?.();
    if (comments) { comments.setAttribute('aria-pressed', String(!!w.reviewingPaneShown?.())); comments.disabled = !a.hasDocument?.(); }
    if (share) share.disabled = !a.hasDocument?.();
    for (const node of built.values()) if (node) node.disabled = !a.hasDocument?.();
    if (autosave) autosaveInput.checked = w.autosaveEnabled?.() ?? true;
  }

  return {
    el: node, quick, menubar, search, searchInput, refresh, refreshQuickStop,
    focusSearch() { searchInput.focus(); searchInput.select(); },
    focusMenubar() { menubar.buttons.find(b => getComputedStyle(b).display !== 'none')?.focus() || allMenus.focus(); },
    openMenu(id) { const i = menus.findIndex(m => m.id === id); menubar.buttons[i]?.click(); },
    destroy() { menubar.destroy(); closeMenu(); },
  };
}

export const SEARCH_SHORTCUT = IS_MAC ? 'Mod+Alt+K' : 'Alt+Q';
